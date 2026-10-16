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

// 下一步走过去会不会变长：苹果或「加身长」掉落物都算
function willGrowNext(p) {
    const nx = p.body[0].x + p.dir.x;
    const ny = p.body[0].y + p.dir.y;
    if (willEatApple(nx, ny)) return true;
    const d = dropIndexAt(nx, ny);
    return d !== -1 && drops[d].kind === 'len';
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
        const p = powerUps[POWER_KINDS[i]];
        if (p) taken.add(p.y * COLS + p.x);
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
function spawnApple() {
    // 先收集所有空格再随机取一个：场地被填满时也不会像递归那样死循环
    const spot = pickCell(freeCells());
    if (!spot) return false;
    apples.push(spot);
    return true;
}

// 当前应该同时存在几个苹果：存活时间 / 得分取较大者，越后期越多
function appleTargetCount(now) {
    const byTime = APPLE_BASE + Math.floor(Math.max(0, now - runStartAt) / (APPLE_RAMP_SEC * 1000));
    const byScore = APPLE_BASE + Math.floor(topScore() / APPLE_RAMP_SCORE);
    return Math.min(Math.max(byTime, byScore), APPLE_MAX);
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

function spawnPowerUp(kind) {
    if (kind === 'widen' && !canWiden()) return;   // 到上限就不再出现
    powerUps[kind] = pickCell(freeCells());
}

// 吃下拓宽道具：上下左右各加一格。逻辑坐标一次性改好，
// 画面变化交给 applyWidenFrame 做缓入缓出
function widenField(now) {
    if (!canWiden()) return;

    const add = WIDEN_STEP;
    widenFromCols = COLS;
    widenFromRows = ROWS;

    COLS += add * 2;
    ROWS += add * 2;

    // 左边、上面各多了一格，所以已有坐标统一 +add
    for (let i = 0; i < players.length; i++) {
        const b = players[i].body;
        for (let k = 0; k < b.length; k++) {
            b[k].x += add;
            b[k].y += add;
        }
    }
    for (let i = 0; i < apples.length; i++) {
        apples[i].x += add;
        apples[i].y += add;
    }
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const p = powerUps[POWER_KINDS[i]];
        if (p) {
            p.x += add;
            p.y += add;
        }
    }
    for (let e = 0; e < enemies.length; e++) {
        const body = enemies[e].body;
        for (let i = 0; i < body.length; i++) {
            body[i].x += add;
            body[i].y += add;
        }
    }
    for (let i = 0; i < turrets.length; i++) {
        turrets[i].x += add;
        turrets[i].y += add;
    }
    for (let i = 0; i < drops.length; i++) {
        drops[i].x += add;
        drops[i].y += add;
    }
    for (let i = 0; i < bullets.length; i++) {
        bullets[i].x += add;
        bullets[i].y += add;
    }

    widenStartAt = now;   // 由主循环逐帧推进动画
    syncHud();
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
    for (let k = 0; k < 2; k++) {
        body.push(cell(hx - d.x * k, hy - d.y * k));
    }
    return {
        def: def,
        body: body,
        hp: [SEGMENT_HP, SEGMENT_HP],
        dir: d,
        queue: [],
        acc: 0,
        stepMs: STEP_MS,
        boostUntil: 0,
        coins: 0,
        score: 0,
        spawnAt: -1,
        alive: true,
        buildRequested: false
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

    powerUps = { speed: null, widen: null };
    powerRespawnAt = { speed: 0, widen: 0 };
    apples = [];

    enemies = [];
    enemyRespawns = [];
    reviveItem = null;
    runStartAt = -1;
    drops = [];
    corpses = [];
    turrets = [];
    bullets = [];

    spawnApple();
    for (let i = 0; i < POWER_KINDS.length; i++) {
        spawnPowerUp(POWER_KINDS[i]);
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
    if (MODES[m]) mode = m;
    if (TEAM_MODES[tm]) teamMode = tm;
    // arena 由联机房主给出：{ cols, rows, count }；本地模式不传
    netArena = arena || null;
    const def = MODES[mode];
    START_COLS = (arena && arena.cols) || def.cols;
    START_ROWS = (arena && arena.rows) || def.rows;
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
    powerUps[kind] = null;
    powerRespawnAt[kind] = now + POWER_DEFS[kind].respawnMs;

    if (kind === 'speed') {
        // 步长乘以 SPEED_FACTOR，并从现在起持续 SPEED_MS
        setStepMs(p, STEP_MS * SPEED_FACTOR);
        p.boostUntil = now + SPEED_MS;   // 重复拾取只刷新时间，不越叠越快
    } else if (kind === 'widen') {
        widenField(now);
    }
}

function step(p, now) {
    if (!p.alive) return;

    // dir 在上一步落子后就定好了，所以蛇头动画的终点就是这里的落点，
    // 转弯时不会出现「头已经伸到 A 格、逻辑却走到 B 格」的跳变
    const head = cell(p.body[0].x + p.dir.x, p.body[0].y + p.dir.y);

    // 撞墙
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) {
        return killPlayer(p, now);
    }

    const eatIdx = appleIndexAt(head.x, head.y);
    const willEat = eatIdx !== -1;

    // 这一帧会吃到哪个道具（苹果和道具不会在同一格）
    let hitPower = null;
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const pu = powerUps[POWER_KINDS[i]];
        if (pu && pu.x === head.x && pu.y === head.y) {
            hitPower = POWER_KINDS[i];
            break;
        }
    }

    // 脚下的掉落物：绿色加身长，金币加货币
    const dropIdx = dropIndexAt(head.x, head.y);
    const dropKind = (dropIdx === -1) ? null : drops[dropIdx].kind;
    const willGrow = willEat || dropKind === 'len';

    // 这一帧不会移动的那截尾巴不参与碰撞判定（尾巴正好让开）
    const body = willGrow ? p.body : p.body.slice(0, p.body.length - 1);
    for (let i = 0; i < body.length; i++) {
        if (body[i].x === head.x && body[i].y === head.y) return killPlayer(p, now);
    }

    // 撞到敌人蛇、另一位玩家、或者任意炮塔
    if (enemyAt(head.x, head.y, null)) return killPlayer(p, now);
    if (playerAt(head.x, head.y, p)) return killPlayer(p, now);
    if (occupiedByTurret(head.x, head.y)) return killPlayer(p, now);

    p.body.unshift(head);
    if (willGrow) {
        // 变长时给尾巴补一格血。血量按「从蛇头数第几节」对齐，
        // 所以蛇往前走时，受伤的那一节会跟着身体一起前进
        p.hp.push(SEGMENT_HP);
    } else {
        p.body.pop();   // 道具 / 金币不增加长度
    }

    if (willEat) {
        apples.splice(eatIdx, 1);
        p.score += 1;
        spawnApple();   // 吃掉一个补一个
        syncHud();
    }

    if (dropIdx !== -1) {
        drops.splice(dropIdx, 1);
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
function killPlayer(p, now) {
    if (!p.alive) return;
    p.alive = false;
    p.acc = p.stepMs;      // 停在冲到终点的那一帧，避免蛇头弹回
    corpses.push({
        body: p.body, hp: p.hp, dir: p.dir,
        diedAt: now,
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
        for (let k = 0; k < REVIVE_LEN; k++) q.hp.push(SEGMENT_HP);
        q.dir = spot.dir;
        q.queue = [];
        q.acc = 0;
        q.stepMs = STEP_MS;
        q.boostUntil = 0;
        q.spawnAt = now;
        q.alive = true;
        return true;
    }
    return false;
}

function gameOver() {
    state = 'over';
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
function damageBody(body, hp, index, now) {
    if (index < 0 || index >= body.length) return false;

    hp[index] -= 1;
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
function buildBlockMap(self) {
    const blocked = new Uint8Array(COLS * ROWS);

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
function enemyChooseDir(self) {
    const blocked = buildBlockMap(self);
    const free = function (x, y) {
        return x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked[y * COLS + x];
    };

    // 从某一格出发能走到的空地数量，用来判断会不会把自己憋死
    function freeSpace(sx, sy) {
        if (!free(sx, sy)) return 0;
        const seen = new Uint8Array(COLS * ROWS);
        const start = sy * COLS + sx;
        seen[start] = 1;
        const queue = [start];
        let count = 0;
        for (let qi = 0; qi < queue.length; qi++) {
            const cur = queue[qi];
            count += 1;
            const cx = cur % COLS;
            const cy = Math.floor(cur / COLS);
            for (let k = 0; k < STEP_DIRS.length; k++) {
                const nx = cx + STEP_DIRS[k].x;
                const ny = cy + STEP_DIRS[k].y;
                if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
                const ni = ny * COLS + nx;
                if (seen[ni] || !free(nx, ny)) continue;
                seen[ni] = 1;
                queue.push(ni);
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

    // 目标：默认抢苹果；也可以改成堵玩家下一步要走的格子
    const target = (ENEMY_TARGET === 'player')
        ? nearestPlayerNext(head)
        : nearestApple(head);

    if (target) {
        // 从目标点反推距离，每条蛇各搜一次
        const dist = new Array(COLS * ROWS).fill(-1);
        const start = target.y * COLS + target.x;
        dist[start] = 0;
        const queue = [start];
        for (let qi = 0; qi < queue.length; qi++) {
            const cur = queue[qi];
            const cx = cur % COLS;
            const cy = Math.floor(cur / COLS);
            for (let k = 0; k < STEP_DIRS.length; k++) {
                const nx = cx + STEP_DIRS[k].x;
                const ny = cy + STEP_DIRS[k].y;
                if (!free(nx, ny)) continue;
                const ni = ny * COLS + nx;
                if (dist[ni] !== -1) continue;
                dist[ni] = dist[cur] + 1;
                queue.push(ni);
            }
        }

        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < options.length; i++) {
            const d = dist[options[i].y * COLS + options[i].x];
            if (d === -1) continue;
            if (d < bestD) {
                bestD = d;
                best = options[i];
            }
        }
        // 走这一步之后还得有足够空地，不然就是自寻死路
        if (best && freeSpace(best.x, best.y) >= self.body.length) {
            return best.dir;
        }
    }

    // 够不到目标，就往空地最大的一边逃
    let fallback = options[0];
    let bestSpace = -1;
    for (let i = 0; i < options.length; i++) {
        const space = freeSpace(options[i].x, options[i].y);
        if (space > bestSpace) {
            bestSpace = space;
            fallback = options[i];
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
    return Math.min(Math.max(byTime, byScore), ENEMY_MAX);
}

function enemyDef(en) {
    return ENEMY_KINDS[en.kind] || ENEMY_KINDS.purple;
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
                hp: body.map(function () { return SEGMENT_HP; }),
                baseStepMs: def.stepMs, stepMs: def.stepMs,
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

    // 挑最近的活着的玩家打
    let target = null;
    let bestD = Infinity;
    for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (!q.alive) continue;
        const dd = Math.abs(q.body[0].x - from.x) + Math.abs(q.body[0].y - from.y);
        if (dd < bestD) { bestD = dd; target = q.body[0]; }
    }
    if (!target) return;

    const dx = target.x - from.x;
    const dy = target.y - from.y;
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
    enemyRespawns.push(now + ENEMY_RESPAWN_MS);

    // 不立刻消失：留一具会缩小淡出的尸体，动画放完才爆成战利品
    corpses.push({
        body: target.body,
        hp: target.hp,
        dir: target.dir,
        diedAt: now,
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

// 尸体各部分化作战利品：一半加身长，一半加货币
function dropLoot(body, now) {
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c.x < 0 || c.y < 0 || c.x >= COLS || c.y >= ROWS) continue;
        if (dropIndexAt(c.x, c.y) !== -1) continue;
        if (occupiedByPlayer(c.x, c.y) || occupiedByTurret(c.x, c.y)) continue;
        if (enemyAt(c.x, c.y, null)) continue;

        drops.push({
            x: c.x,
            y: c.y,
            kind: (i % 2 === 0) ? 'len' : 'coin',
            expireAt: now + DROP_LIFE_MS
        });
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
    const sp = powerUps.speed;

    self.body.unshift(head);
    if (willEat) {
        self.hp.push(SEGMENT_HP);   // 变长时尾巴补一格血
        apples.splice(eatIdx, 1);
        spawnApple();               // 苹果被它抢走了，补一个新的
    } else {
        self.body.pop();
    }

    // 敌人也会抢加速道具
    if (sp && head.x === sp.x && head.y === sp.y) {
        powerUps.speed = null;
        powerRespawnAt.speed = now + POWER_DEFS.speed.respawnMs;
        self.boostUntil = now + SPEED_MS;
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
        p.body.length >= TURRET_MIN_LEN &&
        turretCount(p) < TURRET_MAX &&
        p.coins >= TURRET_COIN_COST;
}

// 从自己尾巴截下 TURRET_COST 节，塔就建在被截掉的尾尖那一格
function buildTurret(p) {
    if (!canBuild(p)) return false;

    const spot = p.body[p.body.length - 1];
    p.body.length -= TURRET_COST;
    p.hp.length = p.body.length;
    p.coins -= TURRET_COIN_COST;
    syncHud();
    turrets.push({ x: spot.x, y: spot.y, cooldownUntil: 0, owner: p });
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
function turretTarget(t) {
    let best = null;
    let bestD = TURRET_RANGE + 1;

    for (let i = 0; i < enemies.length; i++) {
        const h = enemies[i].body[0];
        const d = Math.hypot(h.x - t.x, h.y - t.y);
        if (d <= TURRET_RANGE && d < bestD) {
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
                if (d <= TURRET_RANGE && d < bestD) {
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
        bullets.push({
            from: 'player',
            owner: t.owner,
            x: t.x + 0.5,
            y: t.y + 0.5,
            vx: ((target.x - t.x) / target.d) * BULLET_SPEED,
            vy: ((target.y - t.y) / target.d) * BULLET_SPEED
        });
    }
}

// 子弹只打敌人，不会误伤玩家
function updateBullets(dtSec, now) {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
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
                if (damageBody(hitEnemy.body, hitEnemy.hp, hitIdx, now)) killEnemy(hitEnemy, now);
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
                    if (damageBody(q.body, q.hp, pIdx, now)) killPlayer(q, now);
                    break;
                }
            }
        } else {
            // 敌方子弹只打玩家；打中谁就扣谁那一段的血
            for (let k = 0; k < players.length; k++) {
                const q = players[k];
                if (!q.alive) continue;
                const pIdx = bodyIndexAt(q.body, cx, cy);
                if (pIdx === -1) continue;
                bullets.splice(i, 1);
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
