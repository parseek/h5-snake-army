// ------------------------------ 可复现的随机数 ------------------------------
// 为什么不用 Math.random：存档要能「读回来之后和存的时候一模一样」，
// 将来还要做「每日挑战 / 分享这一局 / 回放」—— 那都要求同一颗种子跑出同一串随机数。
//
// 实现是 mulberry32：只有一个 32 位状态，好处是「状态」本身就是存档要存的东西，
// 存下来再恢复，后续的随机序列完全接着走。
let rngSeed = 0;        // 这一局用的种子（显示 / 分享 用）
let rngState = 0;       // 当前流位置（存档要存这个）

function rndSeedFrom(n) {
    const v = (Math.floor(Math.abs(n)) || 1) >>> 0;
    return v === 0 ? 1 : v;
}

// 开一局：给个种子（不传就现取一个）
function rndReset(seed) {
    rngSeed = rndSeedFrom(seed === undefined ? (Date.now() % 2147483647) : seed);
    rngState = rngSeed;
}

// 直接从某个状态接着走（读档用）
function rndRestore(state, seed) {
    rngState = (state >>> 0) || 1;
    rngSeed = (seed >>> 0) || rngState;
}

function rndState() {
    return rngState >>> 0;
}

// 0 <= rnd() < 1
function rnd() {
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// 整数 [0, n)
function rndInt(n) {
    return Math.floor(rnd() * Math.max(1, n | 0));
}

// 一条独立的随机流（不消耗玩法的主流）。
// 房间布局用它：同一颗种子 + 同一个房间号 = 同一间房，跟主随机流走到哪无关。
function rndMake(seed) {
    let s = rndSeedFrom(seed);
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

rndReset();
