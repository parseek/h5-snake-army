// ------------------------------ 房间式 Roguelike（M1）------------------------------
// 一局 = N 间房，一间一间往前推：
//   进房 -> 清场（战斗房杀光敌人 / 补给房吃够苹果）-> 门打开 -> 踩门进下一间
// 跨房间保留：身长 / 血量 / 币 / 分数 / 炮塔升级；位置重置到进门处。
// 房间布局由「种子 + 房间号」生成，所以同一颗种子永远得到同一串房间（存档/复现都靠这个）。
const ROGUE_KIND = { BATTLE: 'battle', SUPPLY: 'supply', SAFE: 'safe', CHEST: 'chest', BOSS: 'boss' };

let room = null;          // 当前房间的状态（null = 不在房间模式）
let roomRun = null;       // 这一轮的信息：{ total, seed, i }

function rogueOn() {
    return Math.round(levelCfg.rooms || 0) > 0;
}

// 一局要打几间（关卡旋钮 rooms，0 = 不玩房间模式）
function rogueTotal() {
    return Math.max(1, Math.min(12, Math.round(levelCfg.rooms || 0)));
}

// 房间尺寸：随「蛇现在多长」放大，免得长蛇在小房间里把自己挤死
function rogueSizeFor(rand, len) {
    const extra = Math.min(16, Math.floor(Math.max(0, len - 4) / 2));
    const cols = Math.max(16, Math.min(64, 18 + extra + Math.floor(rand() * 6)));
    const rows = Math.max(12, Math.min(48, 14 + extra + Math.floor(rand() * 5)));
    return { cols: cols, rows: rows };
}

// 生成第 i 间的蓝图（纯数据，确定性）
function rogueRoomPlan(seed, i, len) {
    const rand = rndMake((seed >>> 0) ^ Math.imul(i + 1, 2654435761));
    let size = rogueSizeFor(rand, len);
    // 第 3 间起：按关卡设置的概率出宝箱房 / 补给房，其余战斗房
    const chestP = Math.max(0, Math.min(100, Number(levelCfg.chestRate) || 0)) / 100;
    const supplyP = Math.max(0, Math.min(100, Number(levelCfg.supplyRate) || 0)) / 100;
    let kind = ROGUE_KIND.BATTLE;
    if (i >= 2 && rand() < chestP) kind = ROGUE_KIND.CHEST;
    else if (i > 0 && rand() < supplyP) kind = ROGUE_KIND.SUPPLY;

    const apples = (kind === ROGUE_KIND.CHEST) ? 2 : (5 + Math.round(rand() * 4) + i);
    const enemies = (kind === ROGUE_KIND.BATTLE) ? Math.min(10, 2 + i + Math.floor(rand() * 2)) : 0;
    const kinds = ['purple', 'purple', 'red', 'blue'];
    const list = [];
    for (let k = 0; k < enemies; k++) {
        list.push(kinds[Math.floor(rand() * (i >= 3 ? 4 : 2))]);
    }

    // 宝箱房：房间小一点（内容就 2 个增益 + 1 个拓宽，不用那么大）
    if (kind === ROGUE_KIND.CHEST) {
        size = {
            cols: Math.max(10, Math.round(size.cols * 0.72)),
            rows: Math.max(8, Math.round(size.rows * 0.72))
        };
    }

    return {
        i: i,
        kind: kind,
        cols: size.cols,
        rows: size.rows,
        appleCount: apples,
        enemies: list,
        goal: (kind === ROGUE_KIND.SUPPLY) ? (10 + i * 4) : 0,   // 补给房：吃够这么多苹果
        goalNow: 0
    };
}

// 开始一轮房间模式（由 start() 或读档调用）
roomFxLoadPref();
window.addEventListener('load', function () {
    for (const id of ['roomFxBtn', 'roomFxBtn2']) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', function () {
            if (typeof tapFeedback === 'function') tapFeedback();
            cycleRoomFx();
        });
    }
    syncRoomFxBtn();
});

// ------------------------------ 本层布局 ------------------------------
// 5×3 的格子里随机游走出 6~8 间，起点在最左列中间；四邻有房间就开门。
const FLOOR_W = 5;
const FLOOR_H = 3;
const DIRS4 = [['e', 1, 0], ['w', -1, 0], ['n', 0, -1], ['s', 0, 1]];
const OPPOSITE = { e: 'w', w: 'e', n: 's', s: 'n' };

function rogueFloorLayout(seed) {
    const rand = rndMake((seed >>> 0) ^ 0x9e3779b9);
    const want = 6 + Math.floor(rand() * 3);
    const rooms = [];
    const map = {};

    const add = function (gx, gy) {
        const r = { gx: gx, gy: gy, doors: {}, depth: 0 };
        r.key = gx + ',' + gy;
        map[r.key] = r;
        rooms.push(r);
        return r;
    };

    add(0, 1);                     // 起点：最左列中间
    let cur = rooms[0];
    let guard = 0;
    while (rooms.length < want && guard++ < 300) {
        const pick = DIRS4[Math.floor(rand() * 4)];
        const nx = cur.gx + pick[1];
        const ny = cur.gy + pick[2];
        if (nx < 0 || ny < 0 || nx >= FLOOR_W || ny >= FLOOR_H) continue;
        const k = nx + ',' + ny;
        if (map[k]) { cur = map[k]; continue; }   // 走到已有房间，从那儿继续长
        cur = add(nx, ny);
    }

    // 四邻都连上（有邻居的门才开）
    for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        for (let d = 0; d < DIRS4.length; d++) {
            const o = DIRS4[d];
            const n = map[(r.gx + o[1]) + ',' + (r.gy + o[2])];
            if (n) r.doors[o[0]] = rooms.indexOf(n);
        }
    }

    // 深度（BFS）：难度按离起点多远来爬
    for (let i = 0; i < rooms.length; i++) rooms[i].depth = -1;
    rooms[0].depth = 0;
    const queue = [0];
    for (let qi = 0; qi < queue.length; qi++) {
        const r = rooms[queue[qi]];
        for (const dir in r.doors) {
            const ni = r.doors[dir];
            if (rooms[ni].depth === -1) {
                rooms[ni].depth = r.depth + 1;
                queue.push(ni);
            }
        }
    }
    // 最深的房间 = BOSS 房（优先选只有一个门的死路）
    let bossIdx = 0;
    let bestDepth = -1;
    for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        if (r.depth > bestDepth) { bestDepth = r.depth; bossIdx = i; }
        else if (r.depth === bestDepth && Object.keys(r.doors).length === 1) bossIdx = i;
    }
    if (bossIdx !== 0) rooms[bossIdx].boss = true;

    return { rooms: rooms, start: 0, boss: bossIdx };
}

// 下一层：换新布局，深度整体 +2（难度爬升），层数 +1
function rogueNextFloor() {
    if (!roomRun) return false;
    roomRun.floor = (roomRun.floor || 1) + 1;
    const layout = rogueFloorLayout(rndSeedFrom(rndState() ^ (roomRun.floor * 7919)));
    roomRun.rooms = layout.rooms;
    roomRun.total = layout.rooms.length;
    roomRun.start = layout.start;
    roomRun.boss = layout.boss;
    roomRun.done = {};
    roomRun.seen = {};
    roomRun.memo = {};
    roomRun.revives = (roomRun.revives || 0) + Math.max(0, Math.round(levelCfg.reviveStart));
    const done0 = {};
    done0[layout.start] = true;
    roomRun.done = done0;
    rogueEnter(layout.start, 'e');
    if (typeof addToast === 'function') addToast('第 ' + roomRun.floor + ' 层');
    return true;
}

function rogueStart(seed) {
    if (!rogueOn()) { room = null; roomRun = null; return false; }
    const s = rndSeedFrom(seed === undefined ? rngSeed : seed);
    const layout = rogueFloorLayout(s);
    const done0 = {};
    done0[layout.start] = true;   // 起始房（安全屋）从一开始就算「已完成」
    roomRun = {
        seed: s,
        i: layout.start,          // 当前在第几间（rooms 的下标）
        total: layout.rooms.length,
        rooms: layout.rooms,      // 本层布局：gx/gy/doors/depth
        start: layout.start,
        floor: 1,                 // 第几层
        boss: layout.boss,        // BOSS 房的下标
        revives: Math.max(0, Math.round(levelCfg.reviveStart || 0)),   // 这一轮还剩几次复活（捡道具加）
        done: done0,              // 哪些房间已经清过
        seen: {},                 // 哪些房间真正进过（苹果只在第一次进时生成）
        memo: {}                  // 每间房离开时的进度
    };
    rogueEnter(layout.start, 'e');
    return true;
}

// 把玩家们摆到房间左侧，保留长度/血量/币/分数
// fromDir：从哪边进来。+1 = 从左边的洞进来（往前走），-1 = 从右边的门进来（往回走）。
// 位置和朝向都跟着它走，所以回头的时候是从「你走进去的那扇门」里出来。
function placePlayersInRoom(fromDir) {
    // fromDir = 行进方向（'e' 从西边进来往东走 / 'w' / 'n' / 's'）
    const dir = (fromDir === 'w' || fromDir === 'n' || fromDir === 's') ? fromDir : 'e';
    const midY = Math.max(2, Math.floor(ROWS / 2));
    const midX = Math.max(2, Math.floor(COLS / 2));
    let hole = null;

    const horiz = (dir === 'e' || dir === 'w');
    const dx = (dir === 'e') ? 1 : (dir === 'w' ? -1 : 0);
    const dy = (dir === 's') ? 1 : (dir === 'n' ? -1 : 0);
    const clampX = function (x) { return Math.max(1, Math.min(COLS - 2, x)); };
    const clampY = function (y) { return Math.max(1, Math.min(ROWS - 2, y)); };

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const len = Math.max(2, p.body.length);        // 进来之前的长度
        // 两人沿墙方向错开，别叠在一起
        const off = (i === 0) ? 0 : (i % 2 ? -2 : 2);

        // 入口 = 「进来的那面墙」中间那一格（门就在那儿），玩家贴着墙往里站一格
        const entryX = horiz ? ((dx > 0) ? 0 : COLS - 1) : clampX(midX + off);
        const entryY = horiz ? clampY(midY + off) : ((dy > 0) ? 0 : ROWS - 1);
        const headX = clampX(entryX + dx);
        const headY = clampY(entryY + dy);

        // 尾巴就在门口的格子上：身体只往「行进方向」长出来
        p.body = [cell(headX, headY), cell(entryX, entryY)];
        p.hp = [levelCfg.hp0, levelCfg.hp0];
        p.emergeLeft = Math.max(0, len - 2);           // 还要从洞里拉出多少节
        p.dir = { x: dx, y: dy };
        p.queue = [];
        p.acc = 0;
        // 加速还没结束就保持加速的速度
        const stillBoosted = (p.boostUntil && p.boostUntil > gameNow);
        const baseMs = (typeof playerBaseMs === 'function') ? playerBaseMs(p) : levelCfg.stepMs;
        p.stepMs = stillBoosted ? (baseMs * SPEED_FACTOR) : baseMs;
        p.alive = true;
        p.spawnAt = -1;
        p.invUntil = gameNow + 900;                    // 刚出来时别被一进门的东西撞死

        // 出洞的洞口：就是进来的那面墙
        if (!hole) hole = { x: entryX, y: entryY, dir: OPPOSITE[dir] };
    }

    if (typeof room !== 'undefined' && room) room.hole = hole;
}

// 每走一步从洞里拉出一节（由 step() 里调用）
// 在房间里死了：还有复活次数就原地复生（回到进来的那面墙、满血、短暂无敌）
function roomTryRevive(p, now) {
    if (!roomRun || !(roomRun.revives > 0)) return false;
    roomRun.revives -= 1;
    p.alive = true;
    p.boostUntil = 0;
    p.stepMs = (typeof playerBaseMs === 'function') ? playerBaseMs(p) : levelCfg.stepMs;
    p.hp = [levelCfg.hp0, levelCfg.hp0];
    // 放在进来的那面墙附近，给回初始长度（不然只有 1 节，动都动不了）
    const spot = (room && room.hole) ? room.hole : { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
    const len = Math.max(2, levelCfg.len0 || 3);
    const dir = { x: 1, y: 0 };
    p.body = [];
    for (let k = 0; k < len; k++) {
        p.body.push(cell(
            Math.max(0, Math.min(COLS - 1, spot.x + k)),
            Math.max(0, Math.min(ROWS - 1, spot.y))
        ));
    }
    p.hp = new Array(len).fill(levelCfg.hp0);
    p.dir = dir;
    p.queue = [];
    p.acc = 0;
    p.emergeLeft = 0;
    p.invUntil = now + 2200;
    syncHud();
    if (typeof addToast === 'function') addToast('复活！还剩 ' + roomRun.revives + ' 次');
    return true;
}

function roomPullOne(p) {
    if (!p || !p.emergeLeft) return false;
    p.emergeLeft -= 1;
    return true;
}

// 有人的身体还在洞里 -> 洞就还开着
function roomHoleOpen() {
    for (let i = 0; i < players.length; i++) {
        if (players[i].emergeLeft > 0) return true;
    }
    return false;
}

function spawnEnemyOfKind(kind, now) {
    return spawnEnemy(now, kind);
}

// 场地尺寸变了（拓宽道具 / 面板改尺寸）：门贴右边缘、洞贴左边缘，
// 纵向按内容的位移跟着走，再夹在场地里。
function roomOnResize(dx, dy) {
    if (!room) return;
    const sx = dx || 0;
    const sy = dy || 0;
    const clampX = function (x) { return Math.max(1, Math.min(COLS - 2, x)); };
    const clampY = function (y) { return Math.max(1, Math.min(ROWS - 2, y)); };

    // 每扇门按自己的方向重新贴回那面墙；纵向/横向的偏移跟着内容走
    const reanchor = function (p) {
        if (!p) return;
        p.x = Math.round(p.x) + sx;
        p.y = Math.round(p.y) + sy;
        if (p.dir === 'e') { p.x = COLS - 1; p.y = clampY(p.y); }
        else if (p.dir === 'w') { p.x = 0; p.y = clampY(p.y); }
        else if (p.dir === 'n') { p.x = clampX(p.x); p.y = 0; }
        else if (p.dir === 's') { p.x = clampX(p.x); p.y = ROWS - 1; }
    };

    if (room.portals) for (let i = 0; i < room.portals.length; i++) reanchor(room.portals[i]);
    if (room.entrance) reanchor(room.entrance);
    if (room.hole) reanchor(room.hole);
    room.door = (room.portals && room.portals.length) ? room.portals[0] : null;
    syncRoomTag();
}

// 画的时候用的坐标：尺寸刚变过就按进度从旧位置滑过去
const PORTAL_MOVE_MS = 420;

function portalDrawPos(p, now) {
    if (!p) return null;
    if (p.fromAt === undefined || p.fromX === undefined) return { x: p.x, y: p.y };
    const t = (now - p.fromAt) / PORTAL_MOVE_MS;
    if (t >= 1) {
        p.fromAt = undefined;         // 滑完就不再算
        return { x: p.x, y: p.y };
    }
    return { x: p.x, y: p.y };   // 位置就是格子；绘制时按场地边缘画（见 drawRoomPortal）
}

function rogueReset() {
    room = null;
    roomRun = null;
    syncRoomTag();
}

// 读档：直接把存档里的房间接回来（不重新生成，避免和存档时的布局不一致）
function rogueRestore(saved) {
    if (!saved) { rogueReset(); return false; }
    room = saved;
    if (room.door) room.door.open = !!room.door.open;
    syncRoomTag();
    return true;
}

// 进第 i 间
function rogueEnter(i, fromDir) {
    if (!roomRun) return false;
    // 方向可能是 'e'/'w'/'n'/'s'（四向门），也可能还传着老的 ±1
    const dir = (fromDir === 'e' || fromDir === 'w' || fromDir === 'n' || fromDir === 's')
        ? fromDir
        : (fromDir < 0 ? 'w' : 'e');
    const longest = players.reduce(function (m, p) { return Math.max(m, p.body.length); }, 2);
    // 离开当前房间前，把这一间的进度记下来（回来时接着打，不用从头开始）
    if (room && roomRun && roomRun.memo && typeof roomRun.i === 'number' && roomRun.i !== i) {
        roomRun.memo[roomRun.i] = {
            goalNow: room.goalNow || 0,
            enemiesAlive: enemies.length,
            cleared: !!room.cleared
        };
    }

    const cell = roomRun.rooms ? roomRun.rooms[i] : null;
    const depth = (cell ? Math.max(0, cell.depth) : i) + ((roomRun.floor || 1) - 1) * 2;
    const plan = rogueRoomPlan(roomRun.seed, depth, longest);
    plan.index = i;

    // 第一层的第一间：安全屋 —— 没有敌人、只有苹果、门全开
    const isStartRoom = (i === (roomRun.start || 0));
    if (isStartRoom) {
        plan.kind = ROGUE_KIND.SAFE;
        plan.enemies = [];
        plan.appleCount = Math.max(8, plan.appleCount || 0);
    }

    // BOSS 房：一只 BOSS（层数越高血越厚就不用变了 —— 它本来每节 3 血）
    if (cell && cell.boss) {
        plan.kind = ROGUE_KIND.BOSS;
        plan.enemies = ['boss'];
        plan.appleCount = 2;
    }
    if (cell) {
        plan.gx = cell.gx;
        plan.gy = cell.gy;
        plan.doors = cell.doors;
    }

    roomRun.i = i;
    room = plan;

    // 场地尺寸（走现有的 resize 逻辑，摄像机/放大动画都能复用）
    COLS = plan.cols;
    ROWS = plan.rows;
    levelCfg.cols = plan.cols;
    levelCfg.rows = plan.rows;
    // 注意签名：beginResize(cols, rows, dx, dy, now)。少传 dx/dy 会把 now 当成位移，
    // 场景和棋盘会被推到一个荒唐的偏移上（看起来就像「跳了几帧」）。
    if (typeof beginResize === 'function') beginResize(plan.cols, plan.rows, 0, 0, gameNow);
    else { widenStartAt = 0; resizeCanvas(); }
    widenStartAt = 0;      // 换房间直接切过去；增长动画是给「拓宽道具」用的
    // 把「画出来多大」直接结算成新房间的尺寸：不这么做的话视口还按上一个房间算
    drawWorldW = W;
    drawWorldH = H;
    renderOffsetX = 0;
    renderOffsetY = 0;
    syncViewToBoard();
    camX = clampCam(camX, boardWorldW(), viewWorldW());
    camY = clampCam(camY, boardWorldH(), viewWorldH());
    camReady = false;      // 下一帧摄像机直接就位，不从上一间滑过来

    // 清场
    apples = [];
    drops = [];
    bullets = [];
    corpses = [];
    if (typeof cutFx !== 'undefined') cutFx = [];
    enemies = [];
    enemyRespawns = [];
    turrets = [];
    powerUps = { speed: [], widen: [] };
    powerRespawnAt = { speed: 0, widen: 0 };
    reviveItem = null;

    // 玩家：保留属性，重置位置
    placePlayersInRoom(typeof dir === 'string' ? dir : (dir < 0 ? 'w' : 'e'));

    // 这一间之前清过（走回头路）：保持已清状态，门直接开着，不再刷敌人
    const wasDone = !!(roomRun.done && roomRun.done[i]);
    const memo = (roomRun.memo && roomRun.memo[i]) || null;

    // 房间内容：苹果只在这间「第一次真正进来」时生成一次；之后不管清没清都不再生成
    const firstVisit = !(roomRun.seen && roomRun.seen[i]);
    if (roomRun.seen) roomRun.seen[i] = true;
    if (firstVisit) {
        for (let k = 0; k < plan.appleCount; k++) spawnApple();
    }
    if (!wasDone) {
        // 回来时按「还剩几个」刷，别把已经打掉的敌人又变回来
        const alive = memo ? Math.max(0, Math.min(plan.enemies.length, memo.enemiesAlive)) : plan.enemies.length;
        for (let k = 0; k < alive; k++) spawnEnemyOfKind(plan.enemies[k], gameNow);
    }
    // 补给房的进度也接回来
    if (memo && plan.kind === ROGUE_KIND.SUPPLY) plan.goalNow = memo.goalNow || 0;
    if (levelCfg.powerups !== false) {
        for (let k = 0; k < POWER_KINDS.length; k++) {
            const kind = POWER_KINDS[k];
            if (!powerOn(kind)) continue;
            // 全场增益是「清房间的奖励」，进门时不刷
            if (kind === 'team') { powerRespawnAt[kind] = Infinity; continue; }
            // 按「同屏上限」铺满（和 reset() 一致）；加速道具设 2 就一次出现 2 个
            const n = Math.max(1, powerMax(kind));
            for (let m = 0; m < n; m++) spawnPowerUp(kind);
        }
    }

    // 门：按本层布局，四面都可能开；位置在对应墙的中间
    const midX = Math.max(1, Math.floor(COLS / 2));
    const midY = Math.max(1, Math.floor(ROWS / 2));
    room.portals = [];
    if (plan.doors) {
        for (const d in plan.doors) {
            const p = { dir: d, to: plan.doors[d], open: false };
            if (d === 'e') { p.x = COLS - 1; p.y = midY; }
            else if (d === 'w') { p.x = 0; p.y = midY; }
            else if (d === 'n') { p.x = midX; p.y = 0; }
            else { p.x = midX; p.y = ROWS - 1; }
            room.portals.push(p);
        }
    }
    // 兼容老字段：door = 第一个门；hole = 起点那间的入口（左边墙上的洞）
    room.door = room.portals.length ? room.portals[0] : null;
    room.entrance = (i === (roomRun.start || 0))
        ? { x: 0, y: midY, dir: 'w' }
        : null;
    // room.hole 由 placePlayersInRoom 设成「进来的那面墙」，这里不要覆盖

    const autoClear = (plan.kind === ROGUE_KIND.SAFE || plan.kind === ROGUE_KIND.CHEST);
    room.cleared = wasDone || autoClear;
    if (room.cleared && room.portals) for (let k = 0; k < room.portals.length; k++) room.portals[k].open = true;
    if (autoClear && roomRun.done) roomRun.done[i] = true;

    // 房间模式里也放复活道具（单人没有队友，捡了就攒一次自我复活）
    if (levelCfg.revive !== false && (i === (roomRun.start || 0) || rnd() < 0.45)) {
        if (typeof spawnReviveItem === 'function' && !reviveItem) spawnReviveItem();
    }

    // 每间房重新摆障碍物（避开玩家和传送门，门前留一格）
    if (typeof resetObstacles === 'function') resetObstacles(room.portals);

    // 已经清过的房 / 安全屋：道具吃完就没有，不再自动补
    if (room.cleared) {
        for (let k = 0; k < POWER_KINDS.length; k++) powerRespawnAt[POWER_KINDS[k]] = Infinity;
    }

    // 宝箱房：2 个全场增益 + 1 个拓宽
    if (plan.kind === ROGUE_KIND.CHEST) {
        for (let n = 0; n < 2; n++) if (powerOn('team')) spawnPowerUp('team');
        if (powerOn('widen')) spawnPowerUp('widen');
        powerRespawnAt.team = Infinity;
        powerRespawnAt.widen = Infinity;
        if (typeof addToast === 'function') addToast('宝箱房：奖励在这里');
    }
    roomRunAt = gameNow;
    roomFxAt = gameNow;        // 换房过渡起点
    roomFxDir = dir;           // 往哪边走，过渡就从哪边进来
    syncRoomTag();
    syncHud();
    sfxUpgrade();
    return true;
}

// 清场判定 + 踩门进下一间（帧循环里调）
function updateRooms(now) {
    if (!room || !roomRun) return;
    if (roomRunAt && now - roomRunAt < 250) return;   // 刚进门，先别判定门/洞

    // 身体全拉出来了：洞口合上，emergeAt 也清掉（之后就是正常画法）
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.emergeAt && emergeK(p, now) >= 1) p.emergeAt = 0;
    }

    // 清场条件
    if (!room.cleared) {
        const noEnemy = enemies.length === 0;
        const supplyDone = room.kind === ROGUE_KIND.SUPPLY && (room.goalNow || 0) >= room.goal;
        const battleDone = (room.kind === ROGUE_KIND.BATTLE || room.kind === ROGUE_KIND.BOSS) && noEnemy;
        if (battleDone || supplyDone) {
            const firstClear = !room.cleared;
            room.cleared = true;
            // 清完就定局：这间不再补道具
            for (let k = 0; k < POWER_KINDS.length; k++) powerRespawnAt[POWER_KINDS[k]] = Infinity;
            // BOSS 房清空 -> 出现通往下一层的楼梯
            if (firstClear && room.kind === ROGUE_KIND.BOSS && !room.stairs) {
                room.stairs = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
                if (typeof addToast === 'function') addToast('BOSS 倒下！楼梯出现了');
            }

            // 清场奖励：全场增益道具（每间只掉一次）
            if (firstClear && room.kind === ROGUE_KIND.BATTLE && levelCfg.powerups !== false && powerOn('team')) {
                spawnPowerUp('team');
                if (typeof addToast === 'function') addToast('房间清空：全场增益出现！');
            }
            if (roomRun.done) roomRun.done[roomRun.i] = true;
            if (room.portals) for (let k = 0; k < room.portals.length; k++) room.portals[k].open = true;
            sfxUpgrade();
            syncRoomTag();
        }
    }

    // 踩到楼梯 -> 下一层
    if (room.stairs) {
        for (let i = 0; i < players.length; i++) {
            const pl = players[i];
            if (!pl || !pl.alive || pl.body.length < 2) continue;
            const h = pl.body[0];
            if (h.x === room.stairs.x && h.y === room.stairs.y) {
                if (typeof rogueNextFloor === 'function') rogueNextFloor();
                return;
            }
        }
    }

    // 踩到任意一扇门 -> 进相邻那间（清场后所有门都开）
    if (room.cleared && room.portals && room.portals.length) {
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!p.alive) continue;
            const h = p.body[0];
            for (let k = 0; k < room.portals.length; k++) {
                const pt = room.portals[k];
                if (h.x !== pt.x || h.y !== pt.y) continue;
                if (pt.to === undefined || pt.to === null) continue;
                rogueEnter(pt.to, pt.dir);      // 从这扇门走出去，就朝这个方向
                return;
            }
        }
    }
}

// 全清一轮
function rogueFinish() {
    roomRun = null;
    room = null;
    syncRoomTag();
    gameOver();          // 复用现有的结算（分数/最高分都会更新）
}

// 记一次「吃到苹果」（补给房的进度）
function roomAppleEaten() {
    if (room && room.kind === ROGUE_KIND.SUPPLY) {
        room.goalNow = (room.goalNow || 0) + 1;
        syncRoomTag();
    }
}

// HUD 上那一小行：第几间 / 还剩几个敌人 / 还差几个苹果
function syncRoomTag() {
    const el = document.getElementById('roomTag');
    if (!el) return;
    if (!room || !roomRun) {
        el.hidden = true;
        return;
    }
    let extra = '';
    if (room.kind === ROGUE_KIND.SAFE) {
        extra = ' · 安全屋';
    } else if (room.kind === ROGUE_KIND.CHEST) {
        extra = ' · 🎁 宝箱房';
    } else if (!room.cleared) {
        if (room.kind === ROGUE_KIND.BATTLE) extra = ' · 剩 ' + enemies.length + ' 敌';
        else extra = ' · 苹果 ' + Math.min(room.goal, room.goalNow || 0) + '/' + room.goal;
    } else {
        extra = ' · 门开了';
    }
    el.hidden = false;
    if (roomRun.revives > 0) extra += ' · ♥' + roomRun.revives;
    const label = '🏚 ' + (roomRun.floor > 1 ? 'F' + roomRun.floor + ' ' : '') + (roomRun.i + 1) + '/' + roomRun.total + extra;
    if (el.textContent !== label) el.textContent = label;
}

let roomRunAt = 0;

// 换房过渡：四种效果，个人设置（存 localStorage），和主题/音效一样。
//   fade   黑场淡入
//   slide  新房间从行进方向滑进来
//   zoom   飞入：从 0.55 倍放大到 1
//   mosaic 马赛克：方块一块块消失
const ROOM_FX_MS = 300;
const ROOM_FX_KEY = 'snake-army-roomfx';
const ROOM_FX_LIST = ['fade', 'slide', 'zoom', 'mosaic'];
const ROOM_FX_NAME = { fade: '黑场', slide: '移动', zoom: '飞入', mosaic: '马赛克' };

let roomFx = 'fade';
let roomFxAt = 0;
let roomFxDir = 1;

function roomFxLoadPref() {
    try {
        const v = localStorage.getItem(ROOM_FX_KEY);
        if (ROOM_FX_LIST.indexOf(v) >= 0) roomFx = v;
    } catch (e) { }
}

function setRoomFx(name) {
    if (ROOM_FX_LIST.indexOf(name) < 0) return;
    roomFx = name;
    try {
        localStorage.setItem(ROOM_FX_KEY, name);
    } catch (e) { }
    syncRoomFxBtn();
}

function cycleRoomFx() {
    const i = ROOM_FX_LIST.indexOf(roomFx);
    setRoomFx(ROOM_FX_LIST[(i + 1) % ROOM_FX_LIST.length]);
}

function syncRoomFxBtn() {
    const label = '🎬 过场：' + (ROOM_FX_NAME[roomFx] || roomFx);
    for (const id of ['roomFxBtn', 'roomFxBtn2']) {
        const el = document.getElementById(id);
        if (el && el.textContent !== label) el.textContent = label;
    }
}

// 当前过渡的进度和参数（0..1）
function roomFxState(now) {
    if (!roomFxAt) return { type: roomFx, k: 1, dx: 0, scale: 1, alpha: 0 };
    const t = (now - roomFxAt) / ROOM_FX_MS;
    const k = (t >= 1) ? 1 : Math.max(0, t);
    return {
        type: roomFx,
        k: k,
        dx: roomFxDir * viewWorldW() * (1 - easeOutCubic(k)),
        scale: 0.55 + 0.45 * easeOutCubic(k),
        alpha: 1 - easeOutCubic(k)
    };
}

// 兼容旧名字（黑场淡入的 alpha）
function roomFadeAlpha(now) {
    const s = roomFxState(now);
    return (s.type === 'fade') ? s.alpha : 0;
}
