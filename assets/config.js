// 基础配置 · 常量 / 配色 / 方向 / 键位 / 玩家定义 / 画布与元素引用
//
// 拆出来的第一层：这里只有「不依赖任何游戏状态、谁都能用」的东西。
// 以经典脚本（非 module）加载，所以这些 const / let / function 落在全局词法作用域，
// 谁都能直接用：主脚本拆完之后 index.html 只剩引导，assets/ 里的文件互相调用也不需要 import。
'use strict';

// ------------------------------ 配置 ------------------------------
const CELL = 20;        // 每格边长（px）
const STEP_MS = 500;    // 基础步长：每走一步的间隔

// 两种模式：单人沿用原来的 15 宽场地，本地双人宽度翻倍
const MODES = {
    1: { name: '单人',     cols: 15, rows: 15, maxCols: 25, maxRows: 25, count: 1 },
    2: { name: '本地双人', cols: 30, rows: 15, maxCols: 40, maxRows: 25, count: 2 }
};
let mode = 1;       // 当前模式：1 = 单人，2 = 本地双人

// 双人再分两种玩法
//   合作：一位出局后场上留一个复活道具，活着的那位吃到就能把队友救回来
//   竞争：不能复活，炮塔会连对方一起打，先出局的一方输
const TEAM_MODES = {
    coop: { name: '合作', revive: true,  friendlyFire: false },
    vs:   { name: '竞争', revive: false, friendlyFire: true }
};
const REVIVE_LEN = 3;   // 复活出来时的身长
const REVIVE_GAP = 3;   // 复活道具至少离敌人这么远（曼哈顿距离）

// 联机时房主会指定：{ cols, rows, count }。本地模式为 null，用 MODES 里的值。
let netArena = null;

let START_COLS = MODES[1].cols;   // 初始场地宽（格）
let START_ROWS = MODES[1].rows;   // 初始场地高（格）
let MAX_COLS = MODES[1].maxCols;  // 场地拓宽上限，避免无限变大
let MAX_ROWS = MODES[1].maxRows;

// 加速道具（玩家和敌人蛇都能吃）
const SPEED_FACTOR = 0.5;       // 拾取后步长乘以这个系数（0.5 = 快一倍）
const SPEED_MS = 30000;         // 加速持续时间（毫秒）

// 出生缩放动画 / 尸体掉落
const SPAWN_ANIM_MS = 260;      // 蛇出现时的缩放动画时长
const DROP_LIFE_MS = 12000;     // 敌人尸体掉落物的存在时间

// 蛇身生命：子弹打中的是「哪一节」，不再是整条秒杀
const SEGMENT_HP = 2;           // 每一节蛇身的生命值
const HP_REGEN_MS = 5000;       // 每节血量随时间线性回复：5 秒回 1 点
const DEATH_ANIM_MS = 320;      // 敌人阵亡后缩小淡出的时长
const MIN_BODY_LEN = 2;         // 蛇身最短长度，砍到比这还短就直接死亡

// 拓宽道具
const WIDEN_STEP = 1;           // 每次拓宽：上下左右各加这么多格
// 主机在配置面板里能设的场地范围（和信令服务端的夹取范围保持一致）
const ARENA_MIN_COLS = 10;
const ARENA_MAX_COLS = 200;    // 60 -> 200：有了摄像机，大地图只是「多滚动一点」
const ARENA_MIN_ROWS = 8;
const ARENA_MAX_ROWS = 150;    // 40 -> 150
const WIDEN_ANIM_MS = 400;      // 场地放大的动画时长，走的也是下面那条缓动曲线

// 敌人蛇：数量随着存活时间和得分越来越多
const ENEMY_STEP_MS = 520;      // 敌人每步间隔（比玩家的基础 500ms 略慢）
const ENEMY_RESPAWN_MS = 6000;  // 敌人阵亡后多久补位
const ENEMY_MAX = 5;            // 同时存在的上限

// 敌人种类
//   purple 普通紫蛇
//   red    大红蛇：生来就长（len 就是出生长度）
//   blue   蓝蛇：会朝玩家开火
const ENEMY_KINDS = {
    purple: { body: '#a24bd4', head: '#6f2da8', len: 2, stepMs: 520, shoots: false },
    red:    { body: '#d43b2f', head: '#9e2418', len: 6, stepMs: 620, shoots: false },
    blue:   { body: '#3b7fd4', head: '#245a9e', len: 3, stepMs: 560, shoots: true }
};
const SPECIAL_RAMP_SEC = 35;    // 存活这么久之后红/蓝蛇才逐渐登场
const RED_RATE = 0.20;          // 后期红蛇占比
const BLUE_RATE = 0.30;         // 后期蓝蛇占比
const ENEMY_SHOOT_MS = 2200;    // 蓝蛇开火间隔
const ENEMY_SHOOT_RANGE = 9;    // 蓝蛇只在这个距离内开火（格）
const ENEMY_BULLET_SPEED = 6;   // 敌方子弹速度（格/秒）
const ENEMY_RAMP_SEC = 20;      // 每存活这么多秒 +1 条
const ENEMY_RAMP_SCORE = 3;     // 每吃这么多苹果 +1 条
const ENEMY_SPAWN_GAP = 5;      // 刷新时至少离玩家这么远（曼哈顿距离）
const ENEMY_TARGET = 'apple';   // 'apple' = 抢苹果 | 'player' = 堵玩家的路

// 苹果：开局 1 个，越到后期场上同时存在的越多
const APPLE_BASE = 1;
const APPLE_MAX = 4;
const APPLE_RAMP_SEC = 25;      // 每存活这么多秒 +1 个
const APPLE_RAMP_SCORE = 4;     // 每吃这么多苹果 +1 个


// 炮塔（消耗自身长度建造）
const TURRET_COST = 2;          // 建一座塔消耗的身长（节）
const TURRET_COIN_COST = 1;     // 建一座塔消耗的货币
const TURRET_MIN_LEN = 4;       // 蛇身至少这么长才能建（建完还剩 >= 2 节）
const TURRET_MAX = 4;           // 同时存在的上限
const TURRET_RANGE = 8;         // 射程（格）
const TURRET_COOLDOWN = 1500;   // 开火间隔（毫秒）
const BULLET_SPEED = 9;         // 子弹速度（格/秒）

// 道具表：respawnMs = 被吃掉后多久重新出现
const POWER_DEFS = {
    speed: { respawnMs: 10000 },
    widen: { respawnMs: 12000 }
};
const POWER_KINDS = ['speed', 'widen'];

// ------------------------------ 关卡配置 ------------------------------
// 关卡修改器里能改的一切。默认值全部取自上面这些常量 ——
// 不动它就是「加入这个功能之前」的行为，探针也按默认值跑。
function levelDefaults() {
    return {
        // 场地 / 玩法 / 房间信息
        cols: 0,              // 0 = 用当前模式的默认场地
        rows: 0,
        team: 'coop',         // 'coop' | 'vs'
        maxPlayers: 2,        // 人数上限：只在开房那一刻生效
        name: '',
        desc: '',

        // 蛇
        len0: 2,              // 初始身长（节）
        hp0: SEGMENT_HP,      // 每一节的血量（也是血条上限）
        stepMs: STEP_MS,      // 每走一步的间隔，越小越快

        // 场上刷什么
        apples: APPLE_MAX,    // 同屏苹果上限
        enemies: true,
        enemyMax: ENEMY_MAX,  // 同时存在的敌人上限
        enemySpeed: 100,      // 敌人速度（%，100 = 原速）—— 三类敌人各自按这个倍率缩放
        powerGap: 100,        // 道具刷新间隔总倍率（%，越小刷得越快）：每种自己的间隔再乘它
        enemyGap: ENEMY_RESPAWN_MS,   // 敌人阵亡后多久补位
        powerups: true,       // 道具总开关
        boostMs: SPEED_MS,    // 加速道具持续多久
        revive: true,         // 复活道具开关（不是计时刷的，队友出局才出现）

        // 每种道具单独设：要不要生成 / 隔多久刷一个 / 同屏最多几个
        // （默认 = 加这个功能之前的 POWER_DEFS.respawnMs 和「同屏 1 个」）
        i_speed_on: true, i_speed_gap: 10000, i_speed_max: 1,
        i_widen_on: true, i_widen_gap: 12000, i_widen_max: 1,

        // 炮塔
        turretCost: TURRET_COST,        // 建塔消耗的身长（节）
        turretCoins: TURRET_COIN_COST,  // 建塔消耗的币
        turretMax: TURRET_MAX
    };
}

// 缓动曲线（蛇身移动、场地放大都用它）：
//   'easeInOutCubic' 缓入缓出（默认，起步慢、中间快、收尾再慢下来）
//   'easeInOutQuad'  缓入缓出（幅度更柔和）
//   'easeInOutSine'  缓入缓出（最平滑，接近匀速但两端仍有加减速）
//   'linear'         匀速
const EASING = 'easeInOutCubic';

const EASE_FNS = {
    linear: function (t) { return t; },
    easeInOutQuad: function (t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    },
    easeInOutCubic: function (t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    easeInOutSine: function (t) {
        return -(Math.cos(Math.PI * t) - 1) / 2;
    }
};

const ease = EASE_FNS[EASING] || EASE_FNS.linear;

// 缓入（起步慢、越来越快），给阵亡消散用
function easeInCubic(t) {
    return t * t * t;
}

const COLOR = {
    board: 'saddlebrown',   // 棋盘底色
    body: '#008000',        // 蛇身
    head: '#146b14',        // 蛇头，稍深一点便于分辨
    apple: 'crimson',       // 苹果
    speed: '#00bfff',       // 加速道具
    widen: '#ffd21f',       // 拓宽道具
    turretBase: '#59606e',  // 炮塔底座
    turretBarrel: '#e2e8f0',// 炮管
    turretCore: '#2b3340',  // 炮塔中心
    bullet: '#ffd166',      // 子弹（玩家的炮塔）
    enemyBullet: '#ff4d6d', // 敌方子弹，换个颜色好躲
    revive: '#ff4fa3',      // 合作模式的复活道具
    dropLen: '#14e0a0',     // 掉落：加身长
    dropCoin: '#ffb703',    // 掉落：加货币
    grid: 'rgba(0, 0, 0, 0.07)',
    mask: 'rgba(0, 0, 0, 0.62)',
    text: '#ffffff'
};

const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
};

// P1 用方向键（右手区），P2 用 WASD（左手区），互不打架
const KEYMAP_P1 = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
};
const KEYMAP_P2 = { w: 'up', s: 'down', a: 'left', d: 'right' };

// 玩家配色。联机最多这么多人，本地模式只用前两个。
// 刻意避开敌人蛇的紫 / 红 / 蓝，免得打起来看混。
const PLAYER_DEFS = [
    { name: 'P1', body: '#008000', head: '#146b14', dir: 'right', buildKey: '/' },
    { name: 'P2', body: '#e8720c', head: '#a94f06', dir: 'left', buildKey: 'Q' },
    { name: 'P3', body: '#0d8b8b', head: '#0a6363', dir: 'right', buildKey: '/' },
    { name: 'P4', body: '#b03a8f', head: '#7d2864', dir: 'left', buildKey: 'Q' },
    { name: 'P5', body: '#6b8e23', head: '#4a6318', dir: 'right', buildKey: '/' },
    { name: 'P6', body: '#546e7a', head: '#37474f', dir: 'left', buildKey: 'Q' }
];
const MAX_PLAYERS = PLAYER_DEFS.length;

const BEST_KEY = 'snake.canvas.best';
const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

// ------------------------------ 场地 ------------------------------
// 场地尺寸会随着拓宽道具变大，所以必须是可变的
let COLS = START_COLS;
let ROWS = START_ROWS;
let W = COLS * CELL;
let H = ROWS * CELL;

// ------------------------------ 视口与摄像机 ------------------------------
// 世界 = 整个场地（W×H 像素）。视口 = 画布能显示多大一块。
// 小场地时视口就等于世界（行为和以前一模一样）；场地比屏幕大时视口小于世界，
// 靠摄像机 camX/camY（世界像素里的左上角）在里面移动。
// 格子大小始终是 CELL（20px），所以大地图上是「滚动」，不是「缩小到看不清」。
let VIEW_W = 0;
let VIEW_H = 0;
let camX = 0;
let camY = 0;

// 放大动画期间「场地已经长到多大」。世界尺寸（W/H）在动画一开始就是最终值，
// 这块才是逐帧变大的那个 —— 视口、摄像机、裁剪都按它算。
let drawWorldW = COLS * CELL;
let drawWorldH = ROWS * CELL;

// 场地是不是正在长大（主机客机都靠它判断）
function boardGrowing() {
    return drawWorldW < W - 0.01 || drawWorldH < H - 0.01;
}

// 动画期间对外就表现成「场地现在这么大」：小场地时视口跟着一起长，
// 画布一点点变大 —— 和加摄像机之前的扩展动画一模一样；
// 场地比屏幕大时视口顶在屏幕尺寸上，改成场地在视口里长大。
function boardWorldW() { return boardGrowing() ? drawWorldW : W; }
function boardWorldH() { return boardGrowing() ? drawWorldH : H; }

// 放大动画期间的画面偏移（单位 px）：逻辑坐标不动，只挪绘制位置
let renderOffsetX = 0;
let renderOffsetY = 0;
let widenStartAt = 0;     // 放大动画的起始时间，0 表示没有动画
let widenFromCols = 0;    // 缩放前的尺寸，用来做插值
let widenFromRows = 0;
let widenShiftX = 0;      // 缩放时内容整体平移了多少格（拓宽道具是 +1，主机改尺寸是 0）
let widenShiftY = 0;

// ------------------------------ 画布 ------------------------------
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

// 按设备像素比放大画布，避免高分屏发虚
const dpr = Math.min(window.devicePixelRatio || 1, 3);

// 只管画布（视口）。世界的 W/H 由 COLS/ROWS 决定，别在这里改 ——
// 以前它顺手写 W/H，加了摄像机之后那样会把世界尺寸也一起改掉。
function setCanvasSize(viewW, viewH) {
    VIEW_W = viewW;
    VIEW_H = viewH;
    canvas.width = VIEW_W * dpr;
    canvas.height = VIEW_H * dpr;
    canvas.style.width = VIEW_W + 'px';
    // 高度交给 CSS（auto）：窄屏上 max-width:100% 才能等比缩，不会拉变形
    canvas.style.height = 'auto';
}

// 直接落到最终尺寸（开局 / 重开时用）
function resizeCanvas() {
    renderOffsetX = 0;
    renderOffsetY = 0;
    W = COLS * CELL;
    H = ROWS * CELL;
    drawWorldW = W;
    drawWorldH = H;
    updateView();
}

// 视口的可用面积：把 HUD / 操作区 / 联机状态条占的高度扣掉，
// 再按整格取整（格子大小固定，宁可少一格也不要露出半格）。
function updateView() {
    const bs = getComputedStyle(document.body);
    const padX = (parseFloat(bs.paddingLeft) || 0) + (parseFloat(bs.paddingRight) || 0);
    const availW = Math.max(5 * CELL, (window.innerWidth || 800) - padX);

    let usedY = 0;
    for (const el of [document.querySelector('.hud'), document.querySelector('.pads'), document.getElementById('netBar')]) {
        if (el && !el.hidden) usedY += el.offsetHeight + 8;
    }
    const availH = Math.max(5 * CELL, (window.innerHeight || 600) - usedY - 20);

    availViewW = Math.max(5 * CELL, Math.floor(availW / CELL) * CELL);
    availViewH = Math.max(5 * CELL, Math.floor(availH / CELL) * CELL);
    syncViewToBoard();
}

// 量到的可用面积（整格）。updateView 负责量，同步画布尺寸时不再读布局 ——
// 放大动画每帧都要同步，不能每帧都去 getComputedStyle + 读 offsetHeight。
let availViewW = 0;
let availViewH = 0;

// 按「场地现在多大」定画布尺寸：
//   小场地 -> 画布 = 场地（动画期间就是一点点长大，老效果）
//   大地图 -> 画布 = 屏幕可用面积（尺寸不变，一次 canvas 重分配都不会发生）
function syncViewToBoard() {
    const vw = Math.min(boardWorldW(), availViewW || boardWorldW());
    const vh = Math.min(boardWorldH(), availViewH || boardWorldH());
    if (vw === VIEW_W && vh === VIEW_H) return;

    setCanvasSize(vw, vh);
    camX = clampCam(camX, boardWorldW(), VIEW_W);
    camY = clampCam(camY, boardWorldH(), VIEW_H);
}

// 把摄像机夹在世界里；世界比视口还小的话就居中（等于不启用摄像机）
function clampCam(v, world, view) {
    if (world <= view) return (world - view) / 2;
    return Math.max(0, Math.min(world - view, v));
}

// 窗口大小变了、操作区高度变了（单人 / 双人 / 观战皮肤不同），都重算一次
window.addEventListener('resize', function () { updateView(); });

// 放大动画的中间帧：画布尺寸从旧尺寸长到新尺寸，
// 画面同时从「旧位置」滑到「新位置」，两者共用同一条缓动曲线
// 泛化成「从 widenFrom* 到当前 COLS/ROWS」的插值：
// 拓宽道具是「上下左右各加一格 + 内容整体平移一格」，
// 主机在配置面板里改尺寸是「内容不动、往右下长」（shift 为 0）—— 同一套动画。
function applyWidenFrame(e) {
    // 世界尺寸在 beginResize 里就已经改好了，这里是逐帧的「长到多大」
    drawWorldW = widenFromCols * CELL + (W - widenFromCols * CELL) * e;
    drawWorldH = widenFromRows * CELL + (H - widenFromRows * CELL) * e;
    renderOffsetX = -(1 - e) * widenShiftX * CELL;
    renderOffsetY = -(1 - e) * widenShiftY * CELL;
    syncViewToBoard();     // 场地长到多大画布就多大（大地图时这一步啥也不做）
}

resizeCanvas();

// hudPlayersEl 不在这里：它跟 syncHudPlayers / syncHud 一起在 render.js。
// 同名再声明一遍是致命的语法错误（Identifier 'hudPlayersEl' has already
// been declared），搬块的时候别搬重。
const bestEl = document.getElementById('best');
const sizeEl = document.getElementById('size');
const boostEl = document.getElementById('boost');
const boostLeftEl = document.getElementById('boostLeft');
const enemyTagEl = document.getElementById('enemyTag');
const enemyLeftEl = document.getElementById('enemyLeft');
const buildBtnEls = [document.getElementById('buildBtn0'), document.getElementById('buildBtn1')];
const pauseBtnEl = document.getElementById('pauseBtn');
const startPanelEl = document.getElementById('startPanel');
// 版本号那行留给 index.html 去写：APP_VERSION 属于联机模块（net.js），
// 这里（config.js）不该依赖它，否则两个脚本的加载顺序就互相锁死了。
const startBtnSingleEl = document.getElementById('modeBtn1');
const startBtnCoopEl = document.getElementById('modeBtnC');
const startBtnVsEl = document.getElementById('modeBtnV');
const startBtnNetEl = document.getElementById('modeBtnNet');
const netPanelEl = document.getElementById('netPanel');
const netStatusEl = document.getElementById('netStatus');
const netHintEl = document.getElementById('netHint');
const netVerEl = document.getElementById('netVer');
const netCodeEl = document.getElementById('netCode');
const netIceEl = document.getElementById('netIce');
const lanBoxEl = document.getElementById('lanBox');
const lanMsgEl = document.getElementById('lanMsg');
const lanListEl = document.getElementById('lanList');
const netManualTipEl = document.getElementById('netManualTip');
const netPeerIpEl = document.getElementById('netPeerIp');
const netHostBtnEl = document.getElementById('netHostBtn');
const netGuestBtnEl = document.getElementById('netGuestBtn');
const netCoopBtnEl = document.getElementById('netCoopBtn');
const netVsBtnEl = document.getElementById('netVsBtn');
const netCopyBtnEl = document.getElementById('netCopyBtn');
const netUseBtnEl = document.getElementById('netUseBtn');
const netBackEl = document.getElementById('netBack');
