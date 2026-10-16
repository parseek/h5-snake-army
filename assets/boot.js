// ------------------------------ 启动兜底 ------------------------------
// index.html 里那条警告平时是隐形的（2 秒后才显形）；第一帧画出来就把它删掉。
// 所以：正常运行永远看不到它；脚本被 CSP 挡了、或某个 assets 没加载成，它就会留下来报错。
window.__bootStarted = true;

function bootWarnClear() {
    const w = document.getElementById('bootWarn');
    if (w && w.parentNode) w.parentNode.removeChild(w);
}

window.addEventListener('error', function (e) {
    const box = document.getElementById('bootErr');
    if (!box) return;
    const src = (e && e.target && e.target.src) ? ('　加载失败：' + String(e.target.src).split('/').pop()) : '';
    const msg = (e && e.message) ? e.message : '脚本执行出错';
    box.textContent = '　错误：' + msg + src;
}, true);

// ------------------------------ 启动层 ------------------------------
// 主脚本只剩引导：版本号、主循环（guestTick / frame）、启动这三件事。
// 其余按责任拆到 assets/：game.js 规则、render.js 渲染、input.js 输入、
// net-session.js 联机（config.js / state.js / net.js 更早就分出去了）。
// 都是经典脚本，加载即全局，互相调用不需要 import。
//
// 拆文件记录：这里原本套着一个 IIFE，函数全在它内部，外部脚本看不见
// （实测报过 drawTurrets / enemyDef is not defined）。所以先去掉 IIFE，让函数
// 落到全局，再按责任一块块搬走 —— 搬到哪一块，删掉哪一块。
'use strict';

// ------------------------------ 配置 ------------------------------
// 常量、配色、方向、键位、玩家定义、画布与元素引用都搬到了 assets/config.js。
// 以经典脚本加载，落在全局词法作用域，这里直接用，不需要 import。
document.getElementById('verLine').textContent = 'v' + APP_VERSION;

// ------------------------------ 主循环 ------------------------------
// 客机的心跳：不跑任何逻辑，只把主机时钟往前推一点然后重画
function guestTick(dtMs) {
if (state !== 'paused') gameNow += dtMs;
nowRef = gameNow;

// 两次快照之间本地补一点插值，画面才不会一格一格跳
if (state === 'running') {
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.alive) p.acc = Math.min(p.acc + dtMs, p.stepMs);
    }
    for (let i = 0; i < enemies.length; i++) {
        const en = enemies[i];
        en.acc = Math.min(en.acc + dtMs, en.stepMs);
    }
}

if (widenStartAt) {
    const t = Math.min(1, (gameNow - widenStartAt) / WIDEN_ANIM_MS);
    applyWidenFrame(ease(t));
    if (t >= 1) {
        widenStartAt = 0;
        resizeCanvas();
    }
}

syncBoostHud(gameNow);
syncEnemyHud(gameNow);
syncBuildBtn();
syncPauseBtn();
render();
requestAnimationFrame(frame);
}

function frame(rawNow) {
    if (!window.__bootOk) {          // 第一帧画出来了：启动成功，把兜底警告收掉
        window.__bootOk = true;
        bootWarnClear();
    }
// 单帧最多按 200ms 计：切后台回来子弹不会瞬移
const dtMs = Math.max(0, Math.min(rawNow - last, 200));
last = rawNow;

// 客机：所有逻辑都在主机那边跑，这边只画
if (netRole === 'guest') {
    guestTick(dtMs);
    return;
}

// 暂停时游戏时钟停走：道具重生、加速剩余、敌人开火冷却、
// 掉落消失、自愈……全都挂在这个时钟上，不会被暂停白白耗掉
if (state !== 'paused') gameNow += dtMs;

const now = gameNow;
const dtSec = dtMs / 1000;
nowRef = now;
if (runStartAt < 0) runStartAt = now;   // 本局计时起点
if (state === 'running') {
    // 两位玩家：出生计时 / 建塔请求 / 加速到期 / 各自按自己的节奏走
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.spawnAt < 0) p.spawnAt = now;
        if (!p.alive) continue;

        if (p.buildRequested) {
            p.buildRequested = false;
            buildTurret(p);
        }

        if (p.upgradeRequested) {
            upgradeTurret(p, p.upgradeRequested);
            p.upgradeRequested = false;
        }

        expirePlayerBoost(p, now);

        // 每帧最多累积一个步长：切到后台再回来不会瞬间追帧
        p.acc += Math.min(dtMs, p.stepMs);
        while (p.acc >= p.stepMs && state === 'running' && p.alive) {
            p.acc -= p.stepMs;
            step(p, now);
        }
    }

    // 道具重生
    for (let i = 0; i < POWER_KINDS.length; i++) {
        const kind = POWER_KINDS[i];
        // 同屏还没到上限、且这个道具的刷新时间到了，就再刷一个
        if (powerList(kind).length < powerMax(kind) && powerRespawnAt[kind] && now >= powerRespawnAt[kind]) {
            powerRespawnAt[kind] = 0;
            spawnPowerUp(kind);
        }
    }

    // 苹果按难度补足（每帧限量补，开局上百个也不会卡）
    fillApples(now, 4);

    // 敌人蛇：补位 / 难度爬升 / 各自按自己的节奏走
    updateEnemySpawns(now);
    const list = enemies.slice();
    for (let i = 0; i < list.length; i++) {
        const en = list[i];
        if (en.spawnAt < 0) en.spawnAt = now;

        // 加速到期
        expireEnemyBoost(en, now);

        // 蓝蛇：到点就开火
        if (enemyDef(en).shoots && now >= en.shootAt) {
            en.shootAt = now + ENEMY_SHOOT_MS;
            fireEnemyBullet(en);
        }

        en.acc += Math.min(dtMs, en.stepMs);
        while (en.acc >= en.stepMs && state === 'running' &&
               enemies.indexOf(en) !== -1) {
            en.acc -= en.stepMs;
            stepEnemy(en, now);
        }
    }

    // 炮塔开火 + 子弹飞行
    updateTurrets(now);
    updateBullets(dtSec, now);

    // 掉落物放久了会消失
    for (let i = drops.length - 1; i >= 0; i--) {
        if (now >= drops[i].expireAt) drops.splice(i, 1);
    }

    // 阵亡动画放完 -> 尸体爆成战利品
    for (let i = corpses.length - 1; i >= 0; i--) {
        const c = corpses[i];
        if (now < c.diedAt + DEATH_ANIM_MS) continue;
        if (c.loot) dropLoot(c.body, now);
        corpses.splice(i, 1);
    }

    regenHp(dtSec);
}

// 场地放大动画：画布尺寸和画面偏移一起缓入缓出
if (widenStartAt) {
    const t = Math.min(1, (now - widenStartAt) / WIDEN_ANIM_MS);
    applyWidenFrame(ease(t));
    if (t >= 1) {
        widenStartAt = 0;
        resizeCanvas();   // 收尾对齐到精确尺寸，避免取整误差累积
    }
}

// 主机：按约 30Hz 把状态推给所有客机 —— 同一帧快照，但每个人那份的 you 不同
if (netRole === 'host' && netOpen && gameNow - netLastSend >= NET_SEND_MS) {
    netLastSend = gameNow;
    netBroadcastSnapshot(netSnapshot());
}

syncBoostHud(now);
syncEnemyHud(now);
syncBuildBtn();
syncPauseBtn();
render();
requestAnimationFrame(frame);
}

// ------------------------------ 启动 ------------------------------
showMenu();   // 先让玩家选模式
requestAnimationFrame(function (now) {
last = now;   // 首帧不计时，避免刚开局就跳步
frame(now);
});
