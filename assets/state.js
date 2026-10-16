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
// 主机权威：主机跑全部逻辑，客人只发按键、收状态做渲染。
// 联机用「座位」模型：座位 0 永远是主机自己，1..netMaxPlayers-1 是客机，
// -1 是观战。每条 WebRTC 连接 = 一个座位，快照按座位分别发（带一个 you 字段）。
let netRole = null;       // null | 'host' | 'guest'
let netPeers = [];        // 每条连接：{ seat, pc, dc, open }
let netSeat = null;       // 我在主机那边的座位：0 主机自己 / 1..n 客机 / -1 观战
let netPrimary = null;    // 我自己那条连接（客机 = netPeers[0]；主机 = 刚建的那条）
let netMaxPlayers = MAX_PLAYERS;   // 本局人数上限（含主机），房主开房时定
let netOpen = false;      // 客机：通道通了；主机：至少一条通了
let netLastSend = 0;
let netBusy = false;
let netConnTimer = null;

// ------------------------------ 房间 / 对局配置 ------------------------------
// 主机说了算的一份配置，改完立即生效；客机只读（跟着快照同步）。
// 关卡配置：场地、玩法、蛇的属性、刷什么、炮塔消耗、房间信息，全都在这一个对象里。
// 默认值来自 config.js 的 levelDefaults()（取自那些常量），所以：
//   本地单人 / 双人 / 联机开房，改的都是它；
//   联机时整个对象跟着快照走，客机只读。
// maxPlayers 例外 —— 它决定开房那一刻发几张座位，进局后改不了。
let levelCfg = levelDefaults();

// ------------------------------ 聊天 ------------------------------
let chatLog = [];       // [{ me, name, text, at }]，只留最近 100 条
let chatUnread = 0;
let chatOpen = false;
let reviveItem;          // 合作模式的复活道具 { x, y }，没有则 null
let apples;         // 场上的苹果 [{ x, y }, ...]
let powerUps;       // { speed: [{x,y}...], widen: [...] } —— 每种可以同时有多个
let powerRespawnAt; // 各道具的重生时间点
let enemies;        // 敌人蛇数组 [{ body, dir, acc, stepMs, spawnAt, boostUntil }]
let enemyRespawns;  // 待补位的重生时间点
let runStartAt;     // 本局开始时间，用来爬难度
let drops;          // 敌人尸体掉落物 [{ x, y, kind, expireAt }]
let corpses;
// 开始页的设置（都不开局，只是记着「本地」按下去时用哪套）
let localPlayerCount = 1;      // 1 或 2
let localTeam = 'coop';        // 双人时：合作 / 竞争
let startPresetId = '';        // 当前选中的内置预设（'' = 自定义）
let cutFx;         // 剪短动画：被剪掉的头颈往回缩的残留效果 [{id, cells, hp, dir, at, bodyColor, headColor}]
let cutFxSeq = 0;  // 流水号：联机时主机靠它知道哪几条还没发给客机        // 正在播阵亡动画的蛇 [{ body, hp, dir, diedAt, loot, bodyColor, headColor }]
let nowRef;         // 本帧时间，画动画时用
let turrets;        // 炮塔 [{ x, y, cooldownUntil, owner }]
let bullets;        // 子弹 [{ x, y, vx, vy }]，坐标是浮点格
let best = readBest();
let state = 'menu'; // 'menu' | 'running' | 'paused' | 'over'
let gameNow = 0;    // 游戏时钟：暂停时停走，所有玩法计时都以它为准
let last = 0;       // 上一帧时间戳

