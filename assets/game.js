// 游戏规则层 · game
//
// 谁在这个文件里：一步怎么走、吃到什么、撞到谁、敌人怎么想、炮塔怎么开火、
// 开局与重开。这里只改游戏状态，不画任何东西，也不绑定 DOM 事件。
// 画的部分在 render.js，输入在 input.js，联机在 net-session.js。
//
// 以经典脚本（非 module）加载：这里定义的函数和变量直接落在全局词法作用域，
// 其他脚本和 index.html 里的调用点不需要 import，也不改一行调用方式。
// 加载顺序见 index.html：config -> state -> net -> game -> render -> input -> net-session。

'use strict';

// ------------------------------ 状态 ------------------------------
// 状态变量与存档读写搬到了 assets/state.js（全局 let，任何脚本都能读写）。

// ------------------------------ 工具 ------------------------------
// 新建一节蛇身
function cell(x, y) {
    return { x: x, y: y };
}

// 难度爬升看两人里更高的那个分
function topScore() {
    let s = 0;
    for (let i = 0; i < players.length; i++) s = Math.max(s, players[i].score);
    return s;
}

// 换步长时按比例缩放已累积的时间，避免动画进度跳一下
function setStepMs(p, next) {
    if (next === p.stepMs) return;
    p.acc = p.acc * (next / p.stepMs);
    p.stepMs = next;
}

function boosted(p) {
    return p.boostUntil > 0;
}

// 蛇身血量随时间线性回复：HP_REGEN_MS 毫秒回 1 点。
// 上限是关卡设定的「每节血量」，不是默认常量 —— 生存关卡每节 3 血，
// 写死 2 的话回了半天也回不满。
function regenHp(dtSec) {
    const regen = (dtSec * 1000) / HP_REGEN_MS;
    const hpMax = levelCfg.hp0;
    for (let i = 0; i < players.length; i++) {
        const hp = players[i].hp;
        for (let k = 0; k < hp.length; k++) {
            hp[k] = Math.min(hpMax, hp[k] + regen);
        }
    }
    for (let e = 0; e < enemies.length; e++) {
        const hp = enemies[e].hp;
        for (let i = 0; i < hp.length; i++) {
            hp[i] = Math.min(hpMax, hp[i] + regen);
        }
    }
}

// 加速到期：步长恢复成「这个关卡的基准」。
// 以前这里写死成默认的 500ms —— 关卡把基准调快之后（比如高铁大陆 100ms），
// 加速一结束蛇会突然掉到 500ms，看着就是「变龟速」。
function expirePlayerBoost(p, now) {
    if (!p.boostUntil || now < p.boostUntil) return false;
    p.boostUntil = 0;
    setStepMs(p, levelCfg.stepMs);
    return true;
}

// 敌人同理，恢复成它自己的基准（已经带着关卡倍率了）
function expireEnemyBoost(en, now) {
    if (!en.boostUntil || now < en.boostUntil) return false;
    en.boostUntil = 0;
    setEnemyStepMs(en, en.baseStepMs);
    return true;
}

function canWiden() {
    return COLS + WIDEN_STEP * 2 <= MAX_COLS && ROWS + WIDEN_STEP * 2 <= MAX_ROWS;
}

// 这一格有没有苹果（返回下标，没有则 -1）
function appleIndexAt(x, y) {
    for (let i = 0; i < apples.length; i++) {
        if (apples[i].x === x && apples[i].y === y) return i;
    }
    return -1;
}

function willEatApple(x, y) {
    return appleIndexAt(x, y) !== -1;
}

// 这一格上有「会让蛇变长」的东西吗：苹果，或者加身长的掉落物。
// 逻辑和渲染必须共用这一个判断，否则会出现「身体变长了、尾巴动画却在缩」的怪样子。
function willGrowAt(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    if (willEatApple(x, y)) return true;
    const d = dropIndexAt(x, y);
    return d !== -1 && drops[d].kind === 'len';
}

// 下一步走过去会不会变长
function willGrowNext(p) {
    return willGrowAt(p.body[0].x + p.dir.x, p.body[0].y + p.dir.y);
}

// ------------------------------ 玩法 ------------------------------
// 收集没有被蛇、苹果、道具占用的格子
function freeCells() {
    const taken = new Set();
    for (let i = 0; i < players.length; i++) {
        const b = players[i].body;
        for (let k = 0; k < b.length; k++) taken.add(b[k].y * COLS + b[k].x);
    }
    for (let e = 0; e < enemies.length; e++) {
        const body = enemies[e].body;
        for (let i = 0; i < body.length; i++) {
            taken.add(body[i].y * COLS + body[i].x);
        }
    }
    for (let i = 0; i < turrets.length; i++) {
        taken.add(turrets[i].y * COLS + turrets[i].x);
    }
    for (let i = 0; i < drops.length; i++) {
        taken.add(drops[i].y * COLS + drops[i].x);
    }
    for (let i = 0; i < apples.length; i++) {
        taken.add(apples[i].y * COLS + apples[i].x);
    }
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const list = powerList(POWER_KINDS[i]);
        for (let k = 0; k < list.length; k++) taken.add(list[k].y * COLS + list[k].x);
    }
    const out = [];
    for (let i = 0; i < COLS * ROWS; i++) {
        if (!taken.has(i)) out.push(i);
    }
    return out;
}

function pickCell(free) {
    if (free.length === 0) return null;   // 场地已满
    const i = free[Math.floor(Math.random() * free.length)];
    return { x: i % COLS, y: Math.floor(i / COLS) };
}

// 放一个苹果；放不下就返回 false
// 把苹果补到目标数量。每帧只补 maxPerTick 个 ——
// 关卡里把苹果设成上百个时，一帧全补上会明显卡一下（每个都要扫一遍全网格）。
function fillApples(now, maxPerTick) {
    const want = appleTargetCount(now);
    let budget = Math.max(1, maxPerTick || 1);
    while (apples.length < want && budget-- > 0) {
        if (!spawnApple()) break;
    }
}

function spawnApple() {
    // 先收集所有空格再随机取一个：场地被填满时也不会像递归那样死循环
    const spot = pickCell(freeCells());
    if (!spot) return false;
    spot.at = gameNow;          // 出生时刻：渲染时做「放大回弹」动画
    apples.push(spot);
    return true;
}

// 当前应该同时存在几个苹果：存活时间 / 得分取较大者，越后期越多
function appleTargetCount(now) {
    const base = Math.max(0, Math.round(levelCfg.appleBase));
    const byTime = base + Math.floor(Math.max(0, now - runStartAt) / (APPLE_RAMP_SEC * 1000));
    const byScore = base + Math.floor(topScore() / APPLE_RAMP_SCORE);
    const want = Math.max(byTime, byScore);
    const cap = Math.round(levelCfg.apples);
    return cap > 0 ? Math.min(want, cap) : want;      // 上限 0 = 无上限（随时间一直涨）
}

// 离某点最近的苹果（敌人 AI 用）
function nearestApple(p) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < apples.length; i++) {
        const d = Math.abs(apples[i].x - p.x) + Math.abs(apples[i].y - p.y);
        if (d < bestD) {
            bestD = d;
            best = apples[i];
        }
    }
    return best;
}

// 每种道具可以同时有多个，powerUps[kind] 是数组
function powerList(kind) {
    if (!powerUps[kind]) powerUps[kind] = [];
    return powerUps[kind];
}

// 总开关 && 这种道具自己的开关
function powerOn(kind) {
    if (levelCfg.powerups === false) return false;
    return levelCfg['i_' + kind + '_on'] !== false;
}

function powerMax(kind) {
    return Math.max(1, Math.min(9, Math.round(levelCfg['i_' + kind + '_max'] || 1)));
}

// 刷新间隔 = 这种道具自己的间隔 × 总倍率（powerGap）
function powerGapMs(kind) {
    const base = Number(levelCfg['i_' + kind + '_gap']) || POWER_DEFS[kind].respawnMs;
    return Math.max(200, Math.round(base * (levelCfg.powerGap / 100)));
}

function spawnPowerUp(kind) {
    if (!powerOn(kind)) return;                              // 总开关 / 这种自己的开关
    if (powerList(kind).length >= powerMax(kind)) return;     // 已经到同屏上限
    if (kind === 'widen' && !canWiden()) return;             // 场地到上限就不再出现
    const spot = pickCell(freeCells());
    if (spot) {
        spot.at = gameNow;      // 同上
        powerList(kind).push(spot);
    }
}

// 把场上所有坐标平移 (dx, dy) 格。
// 拓宽道具（整块场地往左上长）和「主机改场地尺寸」都走这里。
function shiftWorld(dx, dy) {
    if (!dx && !dy) return;
    for (let i = 0; i < players.length; i++) {
        const b = players[i].body;
        for (let k = 0; k < b.length; k++) {
            b[k].x += dx;
            b[k].y += dy;
        }
    }
    for (let i = 0; i < apples.length; i++) {
        apples[i].x += dx;
        apples[i].y += dy;
    }
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const list = powerList(POWER_KINDS[i]);
        for (let k = 0; k < list.length; k++) {
            list[k].x += dx;
            list[k].y += dy;
        }
    }
    for (let e = 0; e < enemies.length; e++) {
        const body = enemies[e].body;
        for (let k = 0; k < body.length; k++) {
            body[k].x += dx;
            body[k].y += dy;
        }
    }
    for (let i = 0; i < turrets.length; i++) {
        turrets[i].x += dx;
        turrets[i].y += dy;
    }
    for (let i = 0; i < drops.length; i++) {
        drops[i].x += dx;
        drops[i].y += dy;
    }
    for (let i = 0; i < bullets.length; i++) {
        bullets[i].x += dx;
        bullets[i].y += dy;
    }
    if (reviveItem) {
        reviveItem.x += dx;
        reviveItem.y += dy;
    }
    for (let i = 0; i < corpses.length; i++) {
        const b = corpses[i].body;
        for (let k = 0; k < b.length; k++) {
            b[k].x += dx;
            b[k].y += dy;
        }
    }
}

// 把场地改成 cols x rows：内容按 (dx, dy) 平移，画面变化交给 applyWidenFrame 缓入缓出
function beginResize(cols, rows, dx, dy, now) {
    widenFromCols = COLS;
    widenFromRows = ROWS;
    widenShiftX = dx;
    widenShiftY = dy;
    COLS = cols;
    ROWS = rows;
    W = COLS * CELL;      // 世界尺寸当场就是新的；动画只影响「画出来多大」
    H = ROWS * CELL;
    shiftWorld(dx, dy);
    // 视口按「最终尺寸」先算好：动画期间只让画出来的场地矩形长大，
    // 画布尺寸不再逐帧变（逐帧改 canvas.width 会清空画布，还费性能）
    updateView();
    widenStartAt = now || gameNow || 1;   // 由主循环逐帧推进动画
    syncHud();
}

// 吃下拓宽道具：上下左右各加一格
function widenField(now) {
    if (!canWiden()) return;
    const add = WIDEN_STEP;
    beginResize(COLS + add * 2, ROWS + add * 2, add, add, now);
}

// 主机在配置面板里改场地尺寸：
//   变大 -> 当场扩（内容不动、往右下长，走同一套缓动）
//   变小 -> 只能按新尺寸重开一局（会把蛇压到界外，没有优雅的处理办法）
// 返回 'same' | 'grew' | 'restart'
function setArenaSize(cols, rows, now) {
    cols = Math.max(ARENA_MIN_COLS, Math.min(ARENA_MAX_COLS, Math.round(cols) || COLS));
    rows = Math.max(ARENA_MIN_ROWS, Math.min(ARENA_MAX_ROWS, Math.round(rows) || ROWS));
    if (cols === COLS && rows === ROWS) return 'same';

    levelCfg.cols = cols;
    levelCfg.rows = rows;
    START_COLS = cols;
    START_ROWS = rows;
    MAX_COLS = Math.max(cols + 10, MAX_COLS);
    MAX_ROWS = Math.max(rows + 10, MAX_ROWS);

    if (cols < COLS || rows < ROWS) {
        reset();              // 缩小：按新尺寸重开，免得把蛇留在界外
        return 'restart';
    }
    beginResize(cols, rows, 0, 0, now);
    return 'grew';
}

// 应用一份关卡配置：能当场生效的当场生效，场地缩小这种只能重开。
// 返回 setArenaSize 的结果（'same' | 'grew' | 'restart' | 'ok'），UI 拿它决定提示什么。
function applyLevelCfg(cfg, now) {
    if (!cfg) return 'same';

    if (TEAM_MODES[cfg.team]) teamMode = cfg.team;
    levelCfg.team = teamMode;

    // 每步间隔：场上所有人立刻换成新的（大小写就是「关卡速度」）
    if (typeof cfg.stepMs === 'number' && players) {
        for (let i = 0; i < players.length; i++) {
            if (players[i].alive) setStepMs(players[i], cfg.stepMs);
        }
        for (let i = 0; i < enemies.length; i++) setEnemyStepMs(enemies[i], enemies[i].baseStepMs);
    }

    // 复活道具关掉就把场上那个收走
    if (cfg.revive === false && reviveItem) reviveItem = null;

    // 敌人速度改了：场上这些立刻按新倍率重算（各自种类的快慢差异保留）
    if (typeof cfg.enemySpeed === 'number') {
        for (let i = 0; i < enemies.length; i++) {
            const en = enemies[i];
            const base = enemyBaseStep(enemyDef(en));
            en.baseStepMs = base;
            setEnemyStepMs(en, (en.boostUntil > now) ? base * SPEED_FACTOR : base);
        }
    }

    // 注意：调用方可能已经把值写进 levelCfg 了（面板就是先改再应用），
    // 所以这里不能拿「变了没有」当条件，一律按结果做，重复调用也无害。
    levelCfg.enemies = cfg.enemies !== false;
    if (!levelCfg.enemies) {
        enemies = [];            // 关掉就当场清场，别留着继续追人
        enemyRespawns = [];
    }

    levelCfg.powerups = cfg.powerups !== false;
    if (!levelCfg.powerups) {
        powerUps = { speed: [], widen: [] };
        powerRespawnAt = { speed: 0, widen: 0 };
    }
    // 每种道具：关掉就清掉它的，上限调小就削到上限
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const kind = POWER_KINDS[i];
        const list = powerList(kind);
        if (!powerOn(kind)) {
            powerUps[kind] = [];
            continue;
        }
        while (list.length > powerMax(kind)) list.pop();
    }

    if (cfg.revive !== undefined) levelCfg.revive = cfg.revive !== false;
    if (!levelCfg.revive) reviveItem = null;

    if (typeof cfg.cols === 'number' && typeof cfg.rows === 'number') {
        return setArenaSize(cfg.cols, cfg.rows, now);
    }
    return 'ok';
}

// 造第 i 号玩家（0 = 主机 / P1）：左右两侧轮流，同一侧再按序号上下错开。
// reset() 和「联机中途有人入座」都要用，所以抽出来，别写两遍。
function makePlayer(i) {
    const def = PLAYER_DEFS[i];
    const fromLeft = (i % 2 === 0);
    const d = fromLeft ? DIRS.right : DIRS.left;
    const hx = fromLeft ? 4 : COLS - 5;
    const sideIdx = Math.floor(i / 2);
    const off = [0, -3, 3, -6, 6, -9][sideIdx] || 0;
    const hy = Math.max(1, Math.min(ROWS - 2, Math.floor(ROWS / 2) + off));
    const body = [];
    for (let k = 0; k < levelCfg.len0; k++) {
        body.push(cell(hx - d.x * k, hy - d.y * k));
    }
    return {
        def: def,
        body: body,
        hp: [levelCfg.hp0, levelCfg.hp0],
        dir: d,
        queue: [],
        acc: 0,
        stepMs: levelCfg.stepMs,
        boostUntil: 0,
        coins: 0,
        score: 0,
        spawnAt: -1,
        alive: true,
        buildRequested: false,
        upgradeRequested: false,
        invUntil: 0
    };
}

// 联机：对局进行中又有客机入座，把它的蛇补进场上。
// 座位号必须紧挨着（i === players.length），否则座位与索引就错位了。
function addPlayerAt(i) {
    if (!players || i !== players.length || i >= MAX_PLAYERS) return false;
    const p = makePlayer(i);
    p.spawnAt = gameNow;      // 播一次出生缩放，客机那边从快照里看到同样的动画
    players.push(p);
    syncHud();
    return true;
}

function reset() {
    COLS = START_COLS;
    ROWS = START_ROWS;
    widenStartAt = 0;
    resizeCanvas();

    // 按人数建玩家：左右两侧轮流，同一侧再按序号上下错开，
    // 免得三人以上全挤在右边同一行上。
    players = [];
    const want = (netArena && netArena.count) || MODES[mode].count;
    const playerCount = Math.max(1, Math.min(want, MAX_PLAYERS));
    for (let i = 0; i < playerCount; i++) {
        players.push(makePlayer(i));
    }

    powerUps = { speed: [], widen: [] };
    powerRespawnAt = { speed: 0, widen: 0 };
    apples = [];

    enemies = [];
    enemyRespawns = [];
    reviveItem = null;
    runStartAt = -1;
    drops = [];
    corpses = [];
    cutFx = [];
    turrets = [];
    bullets = [];

    spawnApple();
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const kind = POWER_KINDS[i];
        for (let n = 0; n < powerMax(kind); n++) spawnPowerUp(kind);   // 同屏上限几个就铺几个
    }
    spawnEnemy(0);
    syncHud();
}

// 选模式开局：1 = 单人（15 宽场地），2 = 本地双人（宽度翻倍）
// 手机上开局后要把长篇帮助收起来（CSS 里靠 body.playing 判断），
// 客机不会走 start()，所以 netApplySnapshot 也要调它一次
function syncPlayingClass() {
    document.body.classList.toggle('playing', state !== 'menu');
}

function start(m, tm, arena) {
    sfxStart();
    if (MODES[m]) mode = m;
    if (TEAM_MODES[tm]) teamMode = tm;
    levelCfg.team = teamMode;      // 面板上显示的、以及发给客机的，都是这一份

    // arena 由联机房主给出：{ cols, rows, count }；本地模式不传。
    // 主机在配置面板里改过尺寸（levelCfg.cols/rows）的话，本地开局也照那个来 ——
    // 否则「改完场地尺寸，重开一局又变回去了」。
    const def = MODES[mode];
    const useCols = (arena && arena.cols) || levelCfg.cols || def.cols;
    const useRows = (arena && arena.rows) || levelCfg.rows || def.rows;
    netArena = (arena || (levelCfg.cols && levelCfg.rows))
        ? {
            cols: useCols,
            rows: useRows,
            maxPlayers: (arena && arena.maxPlayers) || levelCfg.maxPlayers,
            count: (arena && arena.count) || def.count
        }
        : null;

    START_COLS = useCols;
    START_ROWS = useRows;
    MAX_COLS = (arena && arena.maxCols) || Math.max(def.maxCols, START_COLS + 10);
    MAX_ROWS = (arena && arena.maxRows) || Math.max(def.maxRows, START_ROWS + 10);

    hideStartUi();
    reset();
    state = 'running';
    syncPlayingClass();
    last = performance.now();
    netAsk = null;
    syncNetBar();
}

// 开局就把开始面板和联机面板一起收起来。
// 之前 start() 只藏了 startPanel，联机面板会一直盖在棋盘上 —— 客机更是
// 根本不会走 start()，得在握手和快照里也收一次。
function hideStartUi() {
    startPanelEl.hidden = true;
    netPanelEl.hidden = true;
}

// 回到开始面板（Esc 或开局时）
function showMenu() {
    if (typeof toggleCfgPanel === 'function') toggleCfgPanel(false);   // 编辑器别叠在菜单上
    if (typeof toggleChat === 'function') toggleChat(false);
    lanClearRoom();
    netLeave();
    reset();               // 用当前模式的场地当背景
    state = 'menu';
    syncPlayingClass();
    startPanelEl.hidden = false;
    netPanelEl.hidden = true;
    syncPauseBtn();
}

function turn(p, name) {
    if (state !== 'running' || !p.alive) return;

    const dir = DIRS[name];
    if (!dir) return;

    // 以最后一个待生效方向为准来判断，避免同一帧连按导致掉头
    const ref = p.queue.length ? p.queue[p.queue.length - 1] : p.dir;
    if (dir.x === ref.x && dir.y === ref.y) return;     // 同方向，忽略
    if (dir.x === -ref.x && dir.y === -ref.y) return;   // 禁止 180° 掉头
    if (p.queue.length >= 2) return;

    p.queue.push(dir);
}

// 拾取道具（哪一位吃到，加速就加在哪一位身上）
function pickPowerUp(p, kind, now) {
    // 把「脚下那一个」从列表里去掉（同屏可能有多个）
    const head = p.body[0];
    const list = powerList(kind);
    for (let i = 0; i < list.length; i++) {
        if (list[i].x === head.x && list[i].y === head.y) {
            list.splice(i, 1);
            break;
        }
    }
    // 这种道具自己的间隔 × 总倍率
    powerRespawnAt[kind] = now + powerGapMs(kind);

    sfxPowerUp(kind);

    if (kind === 'speed') {
        // 步长乘以 SPEED_FACTOR，并从现在起持续关卡设定的 boostMs
        setStepMs(p, levelCfg.stepMs * SPEED_FACTOR);
        p.boostUntil = now + levelCfg.boostMs;   // 重复拾取只刷新时间，不越叠越快
    } else if (kind === 'widen') {
        widenField(now);
    }
}

// 撞上了怎么办：关卡允许「剪短」就从头部剪掉若干节（蛇头退回上一节），
// 否则照旧死。剪完比最小长度还短 = 直接死 —— 「最短减到最小长度，再短就死亡」。
// 无敌期间：撞墙不前进、撞蛇直接穿过去、敌人的子弹也打不动。
// 剪短一次就挂一段无敌（levelCfg.invMs，默认 2 秒）—— 不然头还朝着墙就会被连着剪。
function invincible(p, now) {
    return !!p.invUntil && now < p.invUntil;
}

function crashPlayer(p, cut, now) {
    if (!cut || cut <= 0) return killPlayer(p, now);

    const keep = p.body.length - cut;
    if (keep < MIN_BODY_LEN) return killPlayer(p, now);

    // 被剪掉的头颈先留一份给动画：它们会往回缩进身体里
    const goneCells = p.body.slice(0, cut);
    const goneHp = p.hp.slice(0, cut);
    if (!cutFx) cutFx = [];
    cutFx.push({
        id: ++cutFxSeq,
        owner: p,
        cells: goneCells,
        hp: goneHp,
        dir: { x: p.dir.x, y: p.dir.y },
        at: now,
        bodyColor: p.def.body,
        headColor: p.def.head
    });
    while (cutFx.length > 6) cutFx.shift();      // 别堆太多

    p.body.splice(0, cut);     // 从头部剪
    p.hp.splice(0, cut);       // 血条跟着对齐
    const inv = Math.max(0, Math.round(levelCfg.invMs) || 0);
    if (inv > 0) p.invUntil = now + inv;
    sfxCut();                  // 「切断」声
    syncHud();
    return false;
}

function step(p, now) {
    if (!p.alive) return;

    // dir 在上一步落子后就定好了，所以蛇头动画的终点就是这里的落点，
    // 转弯时不会出现「头已经伸到 A 格、逻辑却走到 B 格」的跳变
    const head = cell(p.body[0].x + p.dir.x, p.body[0].y + p.dir.y);

    // 撞墙：可以把蛇剪短（剪到最短就死）；无敌期间这一步不前进
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) {
        if (invincible(p, now)) return;
        return crashPlayer(p, Math.round(levelCfg.cutWall) || 0, now);
    }

    const eatIdx = appleIndexAt(head.x, head.y);
    const willEat = eatIdx !== -1;

    // 这一帧会吃到哪个道具（苹果和道具不会在同一格）
    let hitPower = null;
    for (let i = 0; i < POWER_KINDS.length && !hitPower; i++) {
        const list = powerList(POWER_KINDS[i]);
        for (let k = 0; k < list.length; k++) {
            if (list[k].x === head.x && list[k].y === head.y) {
                hitPower = POWER_KINDS[i];
                break;
            }
        }
    }

    // 脚下的掉落物：绿色加身长，金币加货币
    const dropIdx = dropIndexAt(head.x, head.y);
    const dropKind = (dropIdx === -1) ? null : drops[dropIdx].kind;
    const willGrow = willEat || dropKind === 'len';

    // 这一帧不会移动的那截尾巴不参与碰撞判定（尾巴正好让开）
    const inv = invincible(p, now);
    const snakeCut = Math.round(levelCfg.cutSnake) || 0;

    const body = willGrow ? p.body : p.body.slice(0, p.body.length - 1);
    for (let i = 0; i < body.length; i++) {
        if (body[i].x === head.x && body[i].y === head.y) {
            if (inv) break;                       // 无敌：从自己身上穿过去
            return crashPlayer(p, snakeCut, now);
        }
    }

    // 撞到敌人蛇、另一位玩家、或者任意炮塔
    if (enemyAt(head.x, head.y, null)) {
        if (!inv) return crashPlayer(p, snakeCut, now);
    } else if (playerAt(head.x, head.y, p)) {
        if (!inv) return crashPlayer(p, snakeCut, now);
    } else if (occupiedByTurret(head.x, head.y)) {
        if (!inv) return killPlayer(p, now);
    }

    p.body.unshift(head);
    sfxStep(p.stepMs);                 // 走一步一声（很轻，带节流）
    if (willGrow) {
        // 变长时给尾巴补一格血。血量按「从蛇头数第几节」对齐，
        // 所以蛇往前走时，受伤的那一节会跟着身体一起前进
        p.hp.push(levelCfg.hp0);
    } else {
        p.body.pop();   // 道具 / 金币不增加长度
    }

    if (willEat) {
        apples.splice(eatIdx, 1);
        p.score += 1;
        spawnApple();   // 吃掉一个补一个
        sfxEat(p.score); // 音高随分数往上走，连着吃不会腻
        syncHud();
    }

    if (dropIdx !== -1) {
        drops.splice(dropIdx, 1);
        sfxCoin(dropKind !== 'coin');      // 金币亮一点，加身长的掉落低一档
        if (dropKind === 'coin') {
            p.coins += 1;
            syncHud();
        }
    }

    if (hitPower) pickPowerUp(p, hitPower, now);

    // 脚下的复活道具：把出局的队友救回来
    if (reviveItem && reviveItem.x === head.x && reviveItem.y === head.y) {
        if (revivePartner(p, now)) reviveItem = null;
    }

    // 落子之后再取下一个方向，下一段动画才能提前知道该往哪拐
    if (p.queue.length) p.dir = p.queue.shift();
}

// 这一格被哪位玩家的身体占着（except 用来排除自己）
function playerAt(x, y, except) {
    for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (q === except || !q.alive) continue;
        for (let k = 0; k < q.body.length; k++) {
            if (q.body[k].x === x && q.body[k].y === y) return q;
        }
    }
    return null;
}

// 某位玩家出局：留一具同色的消散尸体；两位都出局才结算
// 上一帧实际画到的探出比例：没有就退回 1（整格，最接近「撞进去」的观感）
function lastDrawnE(o) {
    return (typeof o.drawnE === 'number' && isFinite(o.drawnE)) ? o.drawnE : 1;
}

function killPlayer(p, now) {
    if (!p.alive) return;
    // 死亡这一步之前，帧循环已经把 acc 归零了（acc -= stepMs 在 step() 之前），
    // 所以此刻的 progress() 其实是 0 —— 必须用「上一帧真正画到哪」(drawnE)，
    // 否则蛇头会从 0.9 格的位置一下跳回整格。
    const deathE = lastDrawnE(p);
    p.alive = false;
    sfxDie();
    p.acc = p.stepMs;      // 停在冲到终点的那一帧，避免蛇头弹回
    corpses.push({
        body: p.body, hp: p.hp, dir: p.dir,
        diedAt: now,
        e: deathE,
        loot: false,       // 玩家的尸体不掉战利品
        bodyColor: p.def.body,
        headColor: p.def.head
    });
    if (p.score > best) { best = p.score; saveBest(); }
    syncHud();

    // 合作：队友还活着，就在场上留一个复活道具给他捡
    if (TEAM_MODES[teamMode].revive && partnerAlive(p) && !reviveItem) {
        spawnReviveItem();
    }

    // 竞争：先出局的一方输，另一位立刻获胜
    if (teamMode === 'vs' && players.length > 1 && partnerAlive(p)) {
        gameOver();
        return;
    }

    for (let i = 0; i < players.length; i++) {
        if (players[i].alive) return;
    }
    gameOver();
}

function partnerAlive(p) {
    for (let i = 0; i < players.length; i++) {
        if (players[i] !== p && players[i].alive) return true;
    }
    return false;
}

// 在离敌人远一点的空地上放一个复活道具
function spawnReviveItem() {
    const free = freeCells();
    if (free.length === 0) return;

    let spot = null;
    for (let tries = 0; tries < 200 && !spot; tries++) {
        const i = free[Math.floor(Math.random() * free.length)];
        const x = i % COLS;
        const y = Math.floor(i / COLS);
        let ok = true;
        for (let e = 0; e < enemies.length; e++) {
            const h = enemies[e].body[0];
            if (Math.abs(h.x - x) + Math.abs(h.y - y) < REVIVE_GAP) { ok = false; break; }
        }
        if (ok) spot = { x: x, y: y };
    }
    reviveItem = spot || { x: free[0] % COLS, y: Math.floor(free[0] / COLS) };
    reviveItem.at = gameNow;
}

// 找一段连着的空格，让复活的玩家落脚（头 + 身后 len-1 节）
function findLineSpot(len) {
    const free = freeCells();
    if (free.length < len + 1) return null;

    for (let tries = 0; tries < 200; tries++) {
        const i = free[Math.floor(Math.random() * free.length)];
        const hx = i % COLS;
        const hy = Math.floor(i / COLS);

        for (let k = 0; k < STEP_DIRS.length; k++) {
            const d = STEP_DIRS[k];
            const cells = [];
            let ok = true;
            for (let q = 0; q < len; q++) {
                const x = hx - d.x * q;
                const y = hy - d.y * q;
                if (x < 0 || y < 0 || x >= COLS || y >= ROWS ||
                    free.indexOf(y * COLS + x) === -1) { ok = false; break; }
                cells.push(cell(x, y));
            }
            if (!ok) continue;

            const fx = hx + d.x;
            const fy = hy + d.y;
            if (fx < 0 || fy < 0 || fx >= COLS || fy >= ROWS) continue;
            if (free.indexOf(fy * COLS + fx) === -1) continue;
            return { body: cells, dir: d };
        }
    }
    return null;
}

// 把出局的队友救回来，并播一次出生缩放
function revivePartner(p, now) {
    for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (q === p || q.alive) continue;

        const spot = findLineSpot(REVIVE_LEN);
        if (!spot) return false;

        q.body = spot.body;
        q.hp = [];
        for (let k = 0; k < REVIVE_LEN; k++) q.hp.push(levelCfg.hp0);
        q.dir = spot.dir;
        q.queue = [];
        q.acc = 0;
        q.stepMs = levelCfg.stepMs;
        q.boostUntil = 0;
        q.spawnAt = now;
        q.alive = true;
        sfxRevive();
        return true;
    }
    return false;
}

function gameOver() {
    state = 'over';
    sfxOver();
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        p.acc = p.stepMs;   // 停在冲到终点的那一帧，避免蛇头弹回
        if (p.score > best) { best = p.score; saveBest(); }
    }
    syncHud();
}

// ------------------------------ 敌人蛇 ------------------------------
function occupiedByPlayer(x, y) {
    return playerAt(x, y, null) !== null;
}

// 某条蛇自己的身体；skipTail = 尾巴这一步会让开，不算障碍
function ownBodyAt(body, x, y, skipTail) {
    const n = body.length;
    for (let i = 0; i < n; i++) {
        if (skipTail && i === n - 1) continue;
        if (body[i].x === x && body[i].y === y) return true;
    }
    return false;
}

// 命中哪一节（没命中返回 -1）
function bodyIndexAt(body, x, y) {
    for (let i = 0; i < body.length; i++) {
        if (body[i].x === x && body[i].y === y) return i;
    }
    return -1;
}

// 给某一节扣血。返回 true 表示这一击把整条蛇打死了
function damageBody(body, hp, index, now, dmg) {
    if (index < 0 || index >= body.length) return false;

    hp[index] -= (dmg || 1);
    if (hp[index] > 0) return false;   // 只是受伤，还没断

    // 生命见底：连它自己带后面所有节一起拆掉。
    // 如果拆完会比最短长度还短，就直接判定死亡
    if (index < MIN_BODY_LEN) return true;

    const lost = body.splice(index);
    hp.length = index;
    dropLoot(lost, now);
    return false;
}

// 有没有别的敌人占着这一格（except 用来排除自己）
function enemyAt(x, y, except) {
    for (let e = 0; e < enemies.length; e++) {
        if (enemies[e] === except) continue;
        if (ownBodyAt(enemies[e].body, x, y, false)) return true;
    }
    return false;
}

const STEP_DIRS = [
    { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }
];

// 给某条敌人算一张障碍图：玩家、炮塔、其他敌人整条都算，
// 它自己只有尾巴不算（下一步尾巴会让开）
// BFS 用的缓冲区：每帧要跑十几次，绝不能每次都 new 一个 COLS×ROWS 的数组
let aiBlockBuf = null;
let aiDistBuf = null;
let aiStampBuf = null;
let aiQueueBuf = null;
let aiStamp = 0;

function aiBufs() {
    const n = COLS * ROWS;
    if (!aiBlockBuf || aiBlockBuf.length !== n) {
        aiBlockBuf = new Uint8Array(n);
        aiDistBuf = new Int32Array(n);
        aiStampBuf = new Int32Array(n);
        aiQueueBuf = new Int32Array(n);
        aiStamp = 0;
    }
}

function buildBlockMap(self) {
    aiBufs();
    const blocked = aiBlockBuf;
    blocked.fill(0);          // 复用一块，清空比新建快得多

    for (let i = 0; i < players.length; i++) {
        const b = players[i].body;
        for (let k = 0; k < b.length; k++) blocked[b[k].y * COLS + b[k].x] = 1;
    }
    for (let i = 0; i < turrets.length; i++) {
        blocked[turrets[i].y * COLS + turrets[i].x] = 1;
    }
    for (let e = 0; e < enemies.length; e++) {
        const other = enemies[e];
        const n = other.body.length;
        for (let i = 0; i < n; i++) {
            if (other === self && i === n - 1) continue;
            blocked[other.body[i].y * COLS + other.body[i].x] = 1;
        }
    }
    return blocked;
}

// 敌人的走法：能靠近目标就靠近，但绝不把自己关进死胡同
// 这个格子有多危险：玩家的子弹如果就在附近、而且正朝它飞，就扣分（敌人会躲子弹）。
// 只在 3.2 格内算，远了不算 —— 不然整张图都是「危险区」，反而不会动了。
function enemyBulletRisk(x, y) {
    let risk = 0;
    for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (b.from === 'enemy') continue;
        const dx = (x + 0.5) - b.x;
        const dy = (y + 0.5) - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 3.2) continue;
        if (b.vx * dx + b.vy * dy <= 0) continue;      // 已经飞过去了 / 背对着
        risk += (3.2 - d);
    }
    return risk;
}

// 附近的战利品：加身长的值得专程去（自己变长），金币的只顺手（主要是抢玩家的）
function nearestDropTarget(from) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const dist = Math.abs(d.x - from.x) + Math.abs(d.y - from.y);
        if (dist > 5) continue;                       // 太远不专程跑
        // 加身长的等价于近 1.5 格：同样距离时先拿能让自己变长的
        const score = dist - (d.kind === 'len' ? 1.5 : 0);
        if (score < bestScore) {
            bestScore = score;
            best = { x: d.x, y: d.y, d: dist, kind: d.kind };
        }
    }
    return best;
}

// 最近的加速道具：敌人会主动去吃（已经加速中就不值得绕路，先去抢苹果）
function nearestSpeedItem(from) {
    if (levelCfg.powerups === false || levelCfg.i_speed_on === false) return null;
    const list = powerList('speed');
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
        const d = Math.abs(list[i].x - from.x) + Math.abs(list[i].y - from.y);
        if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best ? { x: best.x, y: best.y, d: bestD } : null;
}

// 附近挤了几条同伴（除了自己）
function enemyCrowd(x, y, self) {
    let n = 0;
    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e === self || !e.body[0]) continue;
        if (Math.abs(e.body[0].x - x) + Math.abs(e.body[0].y - y) <= 2) n++;
    }
    return n;
}

function enemyChooseDir(self) {
    const blocked = buildBlockMap(self);
    const free = function (x, y) {
        return x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked[y * COLS + x];
    };

    // 从某一格出发能走到的空地数量，用来判断会不会把自己憋死
    // 从某一格出发能走到的空地数量（最多数到 cap 就收工 —— 调用方只需要比较大小）。
    // 复用缓冲 + 早退：原来每次都新建 30k 的数组并跑满整张图，大地图上很贵。
    function freeSpace(sx, sy, cap) {
        if (!free(sx, sy)) return 0;
        aiBufs();
        aiStamp++;
        const start = sy * COLS + sx;
        aiStampBuf[start] = aiStamp;
        aiQueueBuf[0] = start;
        let qHead = 0;
        let qTail = 1;
        let count = 0;
        while (qHead < qTail && count < cap) {
            const cur = aiQueueBuf[qHead++];
            count += 1;
            const cx = cur % COLS;
            const cy = (cur / COLS) | 0;
            for (let k = 0; k < STEP_DIRS.length; k++) {
                const nx = cx + STEP_DIRS[k].x;
                const ny = cy + STEP_DIRS[k].y;
                if (!free(nx, ny)) continue;
                const ni = ny * COLS + nx;
                if (aiStampBuf[ni] === aiStamp) continue;
                aiStampBuf[ni] = aiStamp;
                aiQueueBuf[qTail++] = ni;
            }
        }
        return count;
    }

    const head = self.body[0];
    const options = [];

    for (let k = 0; k < STEP_DIRS.length; k++) {
        const d = STEP_DIRS[k];
        if (d.x === -self.dir.x && d.y === -self.dir.y) continue;   // 不能掉头
        const nx = head.x + d.x;
        const ny = head.y + d.y;
        if (!free(nx, ny)) continue;
        options.push({ dir: d, x: nx, y: ny });
    }

    if (options.length === 0) return self.dir;   // 走投无路

    // 目标：默认抢苹果；也可以改成堵玩家下一步要走的格子。
    // 但如果附近正好有加速道具、自己又还没加速，就先去吃它 ——
    // 加速之后抢苹果、追人都快，绕几格很划算（以前是「顺路才捡」）。
    let target = (ENEMY_TARGET === 'player')
        ? nearestPlayerNext(head)
        : nearestApple(head);
    const item = nearestSpeedItem(head);
    if (item && !boosted(self) && (item.d <= 6 || !target)) {
        target = { x: item.x, y: item.y };
    }

    // 脚边的战利品：优先于苹果（加身长的能让自己更长，金币的能少给玩家一颗）
    const loot = nearestDropTarget(head);
    if (loot && (!target || loot.d <= 5)) {
        target = { x: loot.x, y: loot.y };
    }

    if (target) {
        // 从目标点反推距离，每条蛇各搜一次
        aiBufs();
        aiStamp++;
        const start = target.y * COLS + target.x;
        aiStampBuf[start] = aiStamp;
        aiDistBuf[start] = 0;
        aiQueueBuf[0] = start;
        let qHead = 0;
        let qTail = 1;
        while (qHead < qTail) {
            const cur = aiQueueBuf[qHead++];
            const cx = cur % COLS;
            const cy = (cur / COLS) | 0;
            const nd = aiDistBuf[cur] + 1;
            for (let k = 0; k < STEP_DIRS.length; k++) {
                const nx = cx + STEP_DIRS[k].x;
                const ny = cy + STEP_DIRS[k].y;
                if (!free(nx, ny)) continue;
                const ni = ny * COLS + nx;
                if (aiStampBuf[ni] === aiStamp) continue;
                aiStampBuf[ni] = aiStamp;
                aiDistBuf[ni] = nd;
                aiQueueBuf[qTail++] = ni;
            }
        }

        let best = null;
        let bestScore = Infinity;
        for (let i = 0; i < options.length; i++) {
            const o = options[i];
            const oi = o.y * COLS + o.x;
            if (aiStampBuf[oi] !== aiStamp) continue;      // 这次搜索没走到它
            const d = aiDistBuf[oi];
            // 在「离目标多远」之外再扣两项：
            //   子弹飞过的地方（会躲玩家的子弹）
            //   同伴扎堆的地方（几条蛇挤一起会互相撞死）
            const score = d + enemyBulletRisk(o.x, o.y) * 6 + enemyCrowd(o.x, o.y, self) * 2;
            if (score < bestScore) {
                bestScore = score;
                best = o;
            }
        }
        // 走这一步之后还得有足够空地，不然就是自寻死路
        if (best && freeSpace(best.x, best.y, self.body.length) >= self.body.length) {
            return best.dir;
        }
    }

    // 够不到目标，就往空地最大的一边逃
    let fallback = options[0];
    let bestScore = -Infinity;
    for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const score = freeSpace(o.x, o.y, 240) - enemyBulletRisk(o.x, o.y) * 8 - enemyCrowd(o.x, o.y, self) * 2;
        if (score > bestScore) {
            bestScore = score;
            fallback = o;
        }
    }
    return fallback.dir;
}

// 离某点最近的那位玩家下一步要进的格子
function nearestPlayerNext(from) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (!q.alive) continue;
        const d = Math.abs(q.body[0].x - from.x) + Math.abs(q.body[0].y - from.y);
        if (d < bestD) { bestD = d; best = q; }
    }
    return best
        ? { x: best.body[0].x + best.dir.x, y: best.body[0].y + best.dir.y }
        : null;
}

// 难度：存活越久 / 吃得越多，同时存在的敌人越多（看两人里更高的分）
function enemyTargetCount(now) {
    const byTime = 1 + Math.floor(Math.max(0, now - runStartAt) / (ENEMY_RAMP_SEC * 1000));
    const byScore = 1 + Math.floor(topScore() / ENEMY_RAMP_SCORE);
    return Math.min(Math.max(byTime, byScore), levelCfg.enemyMax);
}

function enemyDef(en) {
    return ENEMY_KINDS[en.kind] || ENEMY_KINDS.purple;
}

// 敌人每步间隔 = 种类自己的间隔 / 关卡倍率。
// 用倍率而不是绝对值：紫/红/蓝本来快慢不同，改了倍率这个差异还留着。
function enemyBaseStep(def) {
    const f = Math.max(0.05, (levelCfg.enemySpeed || 100) / 100);
    return Math.max(60, Math.round(def.stepMs / f));
}

// 越到后期，红蛇 / 蓝蛇出现得越多
function pickEnemyKind(now) {
    const ramp = Math.min(1, Math.max(0, (now - runStartAt) / (SPECIAL_RAMP_SEC * 1000)));
    const r = Math.random();
    if (r < RED_RATE * ramp) return 'red';
    if (r < (RED_RATE + BLUE_RATE) * ramp) return 'blue';
    return 'purple';
}

function spawnEnemy(now) {
    if (!levelCfg.enemies) return false;           // 主机关了敌人就不再刷
    const kind = pickEnemyKind(now);
    const def = ENEMY_KINDS[kind];

    const free = freeCells();
    if (free.length < def.len + 1) return false;

    for (let tries = 0; tries < 200; tries++) {
        const i = free[Math.floor(Math.random() * free.length)];
        const head = cell(i % COLS, Math.floor(i / COLS));

        // 别在任何一位玩家脸上刷出来
        let tooClose = false;
        for (let q = 0; q < players.length; q++) {
            if (!players[q].alive) continue;
            const h = players[q].body[0];
            if (Math.abs(head.x - h.x) + Math.abs(head.y - h.y) < ENEMY_SPAWN_GAP) {
                tooClose = true;
                break;
            }
        }
        if (tooClose) continue;

        for (let k = 0; k < STEP_DIRS.length; k++) {
            const d = STEP_DIRS[k];

            // 整条身体都得躺在空格里 —— 大红蛇生来就长，所以这一步要一次摆下 len 节
            const body = [head];
            let ok = true;
            for (let q = 1; q < def.len; q++) {
                const bx = head.x - d.x * q;
                const by = head.y - d.y * q;
                if (bx < 0 || by < 0 || bx >= COLS || by >= ROWS ||
                    free.indexOf(by * COLS + bx) === -1) { ok = false; break; }
                body.push(cell(bx, by));
            }
            if (!ok) continue;

            // 头朝的那一边也得迈得出去，否则它第一步就撞墙
            const fx = head.x + d.x;
            const fy = head.y + d.y;
            if (fx < 0 || fy < 0 || fx >= COLS || fy >= ROWS) continue;
            if (free.indexOf(fy * COLS + fx) === -1) continue;

            enemies.push({
                kind: kind,
                body: body, dir: d, acc: 0,
                hp: body.map(function () { return levelCfg.hp0; }),
                baseStepMs: enemyBaseStep(def), stepMs: enemyBaseStep(def),
                spawnAt: -1, boostUntil: 0,
                shootAt: now + ENEMY_SHOOT_MS
            });
            return true;
        }
    }
    return false;
}

// 蓝蛇开火：朝玩家蛇头的方向射一发，打中扣对应部位的血
function fireEnemyBullet(en) {
    const from = en.body[0];

    // 挑最近的活着的玩家打，并且瞄他「下一步要进的格子」——
    // 子弹直接打当前位置的话，500ms 一步的玩家经常刚好走开
    let target = null;
    let bestD = Infinity;
    for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (!q.alive) continue;
        const dd = Math.abs(q.body[0].x - from.x) + Math.abs(q.body[0].y - from.y);
        if (dd < bestD) { bestD = dd; target = q; }
    }
    if (!target) return;

    const head = target.body[0];
    const nextX = head.x + target.dir.x;
    const nextY = head.y + target.dir.y;
    const aim = (nextX < 0 || nextY < 0 || nextX >= COLS || nextY >= ROWS)
        ? { x: head.x, y: head.y }
        : { x: nextX, y: nextY };

    const dx = aim.x - from.x;
    const dy = aim.y - from.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.0001 || d > ENEMY_SHOOT_RANGE) return;

    bullets.push({
        from: 'enemy',
        x: from.x + 0.5,
        y: from.y + 0.5,
        vx: (dx / d) * ENEMY_BULLET_SPEED,
        vy: (dy / d) * ENEMY_BULLET_SPEED
    });
}

function killEnemy(target, now) {
    const i = enemies.indexOf(target);
    if (i === -1) return;
    enemies.splice(i, 1);
    sfxKill();
    enemyRespawns.push(now + levelCfg.enemyGap);

    // 不立刻消失：留一具会缩小淡出的尸体，动画放完才爆成战利品。
    // e 同上：接着「上一帧画到哪」画，不然敌人蛇头也会跳一格。
    const deathE = lastDrawnE(target);
    corpses.push({
        body: target.body,
        hp: target.hp,
        dir: target.dir,
        diedAt: now,
        e: deathE,
        loot: true,
        bodyColor: enemyDef(target).body,
        headColor: enemyDef(target).head
    });
}

function dropIndexAt(x, y) {
    for (let i = 0; i < drops.length; i++) {
        if (drops[i].x === x && drops[i].y === y) return i;
    }
    return -1;
}

// 尸体化作战利品：不是每节都掉，掉什么、放多久也都是随机的。
// （以前是「每节必掉 + 奇偶交替」，看起来像一条规整的斑马线，一眼就知道下一步掉什么。）
function dropLoot(body, now) {
    let dropped = 0;

    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c.x < 0 || c.y < 0 || c.x >= COLS || c.y >= ROWS) continue;
        if (dropIndexAt(c.x, c.y) !== -1) continue;
        if (occupiedByPlayer(c.x, c.y) || occupiedByTurret(c.x, c.y)) continue;
        if (enemyAt(c.x, c.y, null)) continue;

        // 每一节按概率掉（第一节必掉，保证短蛇也有收获）
        if (i > 0 && dropped > 0 && Math.random() > DROP_CELL_CHANCE) continue;

        const life = DROP_LIFE_MS * (1 - DROP_LIFE_JITTER / 2 + Math.random() * DROP_LIFE_JITTER);
        drops.push({
            x: c.x,
            y: c.y,
            kind: (Math.random() < DROP_LEN_CHANCE) ? 'len' : 'coin',
            expireAt: now + Math.round(life),
            at: now
        });
        dropped++;
    }
}

// 敌人换步长：按比例缩放已累积的时间，动画进度不会跳
function setEnemyStepMs(en, next) {
    if (next === en.stepMs) return;
    en.acc = en.acc * (next / en.stepMs);
    en.stepMs = next;
}

// 到期的补位 + 难度上来了就补新蛇
function updateEnemySpawns(now) {
    if (!levelCfg.enemies) return;
    for (let i = enemyRespawns.length - 1; i >= 0; i--) {
        if (now < enemyRespawns[i]) continue;
        enemyRespawns.splice(i, 1);
        if (!spawnEnemy(now)) enemyRespawns.push(now + 1000);   // 没地方放，过会儿再试
    }

    const want = enemyTargetCount(now);
    while (enemies.length + enemyRespawns.length < want) {
        if (!spawnEnemy(now)) break;
    }
}

function stepEnemy(self, now) {
    // self.dir 在上一步落子后就定好了，所以蛇头动画的终点就是这里的落点，
    // 转弯时不会出现「头已经伸到 A 格、逻辑却走到 B 格」的瞬移
    const head = cell(self.body[0].x + self.dir.x, self.body[0].y + self.dir.y);

    // 撞墙 / 咬到自己 / 撞到玩家、炮塔或别的敌人，都算它阵亡
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS ||
        ownBodyAt(self.body, head.x, head.y, true) ||
        occupiedByPlayer(head.x, head.y) ||
        occupiedByTurret(head.x, head.y) ||
        enemyAt(head.x, head.y, self)) {
        killEnemy(self, now);
        return;
    }

    const eatIdx = appleIndexAt(head.x, head.y);
    const willEat = eatIdx !== -1;

    // 掉在地上的战利品：加身长的它自己吃掉（变长），金币的踩掉（省得玩家捡）
    const dropIdx = dropIndexAt(head.x, head.y);
    const dropKind = (dropIdx === -1) ? null : drops[dropIdx].kind;

    const spList = powerList('speed');
    let sp = null;
    for (let i = 0; i < spList.length; i++) {
        if (spList[i].x === head.x && spList[i].y === head.y) {
            sp = spList[i];
            break;
        }
    }

    self.body.unshift(head);
    if (willEat || dropKind === 'len') {
        self.hp.push(levelCfg.hp0);   // 变长时尾巴补一格血
        if (willEat) {
            apples.splice(eatIdx, 1);
            spawnApple();               // 苹果被它抢走了，补一个新的
        }
    } else {
        self.body.pop();
    }
    if (dropIdx !== -1) drops.splice(dropIdx, 1);   // 两种掉落物都收走

    // 敌人也会抢加速道具
    if (sp) {
        const k = spList.indexOf(sp);
        if (k >= 0) spList.splice(k, 1);
        powerRespawnAt.speed = now + powerGapMs('speed');
        self.boostUntil = now + levelCfg.boostMs;
        setEnemyStepMs(self, self.baseStepMs * SPEED_FACTOR);
    }

    // 落子之后再决定下一步往哪拐，下一段动画才能提前知道方向
    self.dir = enemyChooseDir(self);
}

// ------------------------------ 炮塔 ------------------------------
function occupiedByTurret(x, y) {
    for (let i = 0; i < turrets.length; i++) {
        if (turrets[i].x === x && turrets[i].y === y) return true;
    }
    return false;
}

// 某位玩家名下有几座塔（上限是每人各自算）
function turretCount(p) {
    let n = 0;
    for (let i = 0; i < turrets.length; i++) {
        if (turrets[i].owner === p) n++;
    }
    return n;
}

function canBuild(p) {
    return state === 'running' && p.alive &&
        p.body.length >= levelCfg.turretCost + 2 &&   // 建完至少还剩两节
        turretCount(p) < levelCfg.turretMax &&
        p.coins >= levelCfg.turretCoins;
}

// 从自己尾巴截下 turretCost 节，塔就建在被截掉的尾尖那一格
function buildTurret(p) {
    if (!canBuild(p)) return false;

    const spot = p.body[p.body.length - 1];
    p.body.length -= levelCfg.turretCost;
    p.hp.length = p.body.length;
    p.coins -= levelCfg.turretCoins;
    syncHud();
    turrets.push({ x: spot.x, y: spot.y, cooldownUntil: 0, owner: p, upA: 0, upB: 0 });
    sfxBuild();
    return true;
}

// 画炮管用：最近的敌人（不看射程）
function nearestEnemyHead(x, y) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.length; i++) {
        const h = enemies[i].body[0];
        const dx = h.x - x;
        const dy = h.y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = h;
        }
    }
    return best;
}

// 竞争模式下炮塔会把对方也算进目标
function friendlyFireOn() {
    return players.length > 1 && TEAM_MODES[teamMode].friendlyFire;
}

// 射程内最近的目标（敌人蛇头；竞争模式还包括对方的整条身体）
// ------------------------------ 炮塔升级 ------------------------------
// 升级对象：离蛇头最近的那座「自己的」炮塔
function nearestTurret(p) {
    if (!turrets || !p || !p.body || !p.body[0]) return null;
    const h = p.body[0];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < turrets.length; i++) {
        const t = turrets[i];
        if (t.owner !== p) continue;
        const d = Math.abs(t.x - h.x) + Math.abs(t.y - h.y);
        if (d < bestD) {
            bestD = d;
            best = t;
        }
    }
    return best;
}

function upgradeLevel(t, path) {
    return Math.min(TURRET_UP_MAX, (path === 'B' ? (t.upB || 0) : (t.upA || 0)));
}

// 下一级要多少币；-1 = 已满级
function upgradeCost(t, path) {
    const lv = upgradeLevel(t, path);
    return lv >= TURRET_UP_MAX ? -1 : TURRET_UP_COST[lv];
}

function canUpgrade(p, path) {
    if (state !== 'running' || !p || !p.alive) return false;
    const t = nearestTurret(p);
    if (!t) return false;
    const cost = upgradeCost(t, path);
    return cost >= 0 && p.coins >= cost;
}

function upgradeTurret(p, path) {
    if (!canUpgrade(p, path)) return false;
    const t = nearestTurret(p);
    p.coins -= upgradeCost(t, path);
    if (path === 'B') t.upB = (t.upB || 0) + 1;
    else t.upA = (t.upA || 0) + 1;
    sfxUpgrade();
    syncHud();
    return true;
}

// B 级：速度 / 力量 / 射程
function turretRange(t) { return TURRET_RANGE + TURRET_B_RANGE[upgradeLevel(t, 'B')]; }
function turretDamage(t) { return TURRET_B_DMG[upgradeLevel(t, 'B')]; }
function turretBulletSpeed(t) { return BULLET_SPEED * TURRET_B_SPEED[upgradeLevel(t, 'B')]; }
// A 级：每秒能转多少弧度（0 = 不跟踪）
function turretTurn(t) { return TURRET_A_TURN[upgradeLevel(t, 'A')]; }

function turretTarget(t) {
    let best = null;
    const range = turretRange(t);
    let bestD = range + 1;

    for (let i = 0; i < enemies.length; i++) {
        const h = enemies[i].body[0];
        const d = Math.hypot(h.x - t.x, h.y - t.y);
        if (d <= range && d < bestD) {
            bestD = d;
            best = h;
        }
    }

    if (friendlyFireOn()) {
        for (let i = 0; i < players.length; i++) {
            const q = players[i];
            if (q === t.owner || !q.alive) continue;
            for (let k = 0; k < q.body.length; k++) {
                const s = q.body[k];
                const d = Math.hypot(s.x - t.x, s.y - t.y);
                if (d <= range && d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
        }
    }

    return best ? { x: best.x, y: best.y, d: bestD } : null;
}

function updateTurrets(now) {
    if (enemies.length === 0 && !friendlyFireOn()) return;

    for (let i = 0; i < turrets.length; i++) {
        const t = turrets[i];
        if (now < t.cooldownUntil) continue;

        const target = turretTarget(t);
        if (!target || target.d < 0.0001) continue;

        t.cooldownUntil = now + TURRET_COOLDOWN;
        sfxShoot();
        const sp = turretBulletSpeed(t);
        bullets.push({
            from: 'player',
            owner: t.owner,
            dmg: turretDamage(t),
            homing: turretTurn(t),      // > 0 = 会拐弯追人
            x: t.x + 0.5,
            y: t.y + 0.5,
            vx: ((target.x - t.x) / target.d) * sp,
            vy: ((target.y - t.y) / target.d) * sp
        });
    }
}

// 离某点最近的敌人蛇头（跟踪子弹用）
function nearestEnemyHead(x, y) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.length; i++) {
        const h = enemies[i].body[0];
        if (!h) continue;
        const d = Math.hypot(h.x - x, h.y - y);
        if (d < bestD) {
            bestD = d;
            best = h;
        }
    }
    return best;
}

// 子弹只打敌人，不会误伤玩家
function updateBullets(dtSec, now) {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];

        // A 级跟踪：朝最近的敌人蛇头匀速转过去（每秒最多转 homing 弧度）
        if (b.homing > 0) {
            const tgt = nearestEnemyHead(b.x, b.y);
            if (tgt) {
                const want = Math.atan2(tgt.y - b.y, tgt.x - b.x);
                const cur = Math.atan2(b.vy, b.vx);
                let diff = want - cur;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                const maxTurn = b.homing * dtSec;
                const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
                const ang = cur + turn;
                const sp = Math.hypot(b.vx, b.vy);
                b.vx = Math.cos(ang) * sp;
                b.vy = Math.sin(ang) * sp;
            }
        }

        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;

        const cx = Math.floor(b.x);
        const cy = Math.floor(b.y);

        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) {
            bullets.splice(i, 1);
            continue;
        }
        // 玩家的炮塔只打敌人蛇；将来若有敌方子弹，会走 else 分支打玩家
        if (b.from !== 'enemy') {
            let hitEnemy = null;
            let hitIdx = -1;
            for (let e = 0; e < enemies.length; e++) {
                const idx = bodyIndexAt(enemies[e].body, cx, cy);
                if (idx !== -1) {
                    hitEnemy = enemies[e];
                    hitIdx = idx;
                    break;
                }
            }
            if (hitEnemy) {
                bullets.splice(i, 1);
                sfxHit();
                if (damageBody(hitEnemy.body, hitEnemy.hp, hitIdx, now, b.dmg || 1)) killEnemy(hitEnemy, now);
                continue;
            }

            // 竞争模式：炮塔的子弹也打对方（不会打自己的炮塔主）
            if (friendlyFireOn()) {
                for (let k = 0; k < players.length; k++) {
                    const q = players[k];
                    if (q === b.owner || !q.alive) continue;
                    const pIdx = bodyIndexAt(q.body, cx, cy);
                    if (pIdx === -1) continue;
                    bullets.splice(i, 1);
                    sfxHit();
                    if (damageBody(q.body, q.hp, pIdx, now, b.dmg || 1)) killPlayer(q, now);
                    break;
                }
            }
        } else {
            // 敌方子弹只打玩家；打中谁就扣谁那一段的血（无敌期间子弹照样被打掉，但不掉血）
            for (let k = 0; k < players.length; k++) {
                const q = players[k];
                if (!q.alive) continue;
                const pIdx = bodyIndexAt(q.body, cx, cy);
                if (pIdx === -1) continue;
                bullets.splice(i, 1);
                if (invincible(q, now)) break;
                if (damageBody(q.body, q.hp, pIdx, now)) killPlayer(q, now);
                break;
            }
        }
    }
}

function togglePause() {
    if (state === 'running') state = 'paused';
    else if (state === 'paused') state = 'running';
    else return;                      // 结算画面按 P 不做事
    syncPauseBtn();
    syncNetBar();
}
