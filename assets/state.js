// 全局状态 · 游戏状态变量 + 存档读写
//
// 这些变量（players / state / enemies / apples …）被游戏规则、渲染、输入、联机
// 四块共用，所以必须落在全局词法作用域：assets/ 下各文件和 index.html 的主循环都能直接读写，
// 不用层层传参，也不用设计接口。
//
// 注意：这里全是 let（可重新赋值）。readBest / saveBest 放在最前面，因为下面
// let best = readBest(); 在加载时就要用到它们。
'use strict';

// ------------------------------ 存档 ------------------------------
function readBest() {
    try {
        return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch (err) {
        return 0;   // 隐私模式等场景下 localStorage 不可用
    }
}

function saveBest() {
    try {
        localStorage.setItem(BEST_KEY, String(best));
    } catch (err) {
        /* 存不了就算了，不影响游戏 */
    }
}

// ------------------------------ 状态 ------------------------------
// 每位玩家一个对象：body/hp 是蛇身，dir 是下一步方向（与这段动画终点一致），
// queue 缓存最多 2 个待生效方向，stepMs 是当前步长，coins/score 各自独立
let players;
let teamMode = 'coop';   // 双人玩法：'coop' | 'vs'

// ------------------------------ 联机 ------------------------------
// 主机权威：主机跑全部逻辑，客机只发按键、收状态做渲染
let netRole = null;    // null | 'host' | 'guest'
let netPC = null;      // RTCPeerConnection
let netDC = null;      // RTCDataChannel
let netOpen = false;
let netLastSend = 0;
let netBusy = false;
let netConnTimer = null;
let reviveItem;          // 合作模式的复活道具 { x, y }，没有则 null
let apples;         // 场上的苹果 [{ x, y }, ...]
let powerUps;       // { speed: {x,y}|null, widen: {x,y}|null }
let powerRespawnAt; // 各道具的重生时间点
let enemies;        // 敌人蛇数组 [{ body, dir, acc, stepMs, spawnAt, boostUntil }]
let enemyRespawns;  // 待补位的重生时间点
let runStartAt;     // 本局开始时间，用来爬难度
let drops;          // 敌人尸体掉落物 [{ x, y, kind, expireAt }]
let corpses;        // 正在播阵亡动画的蛇 [{ body, hp, dir, diedAt, loot, bodyColor, headColor }]
let nowRef;         // 本帧时间，画动画时用
let turrets;        // 炮塔 [{ x, y, cooldownUntil, owner }]
let bullets;        // 子弹 [{ x, y, vx, vy }]，坐标是浮点格
let best = readBest();
let state = 'menu'; // 'menu' | 'running' | 'paused' | 'over'
let gameNow = 0;    // 游戏时钟：暂停时停走，所有玩法计时都以它为准
let last = 0;       // 上一帧时间戳

