// 输入层 · input
//
// 谁在这个文件里：键盘、屏幕按钮、画布点击的绑定，以及「本地操作入口」
// （单人 / 本地双人 / 联机客机的按键该发给谁）。
// 只把输入翻译成对 game.js / net-session.js 入口的调用，不含规则、不含绘制。
//
// 以经典脚本（非 module）加载：这里定义的函数和变量直接落在全局词法作用域，
// 其他脚本和 index.html 里的调用点不需要 import，也不改一行调用方式。
// 加载顺序见 index.html：config -> state -> net -> game -> render -> input -> net-session。

'use strict';

// ------------------------------ 输入 ------------------------------
// ------------------------------ 本地操作入口 ------------------------------
// 只有一条本地蛇时（单人、联机），方向键和 WASD 两套都该驱动它；
// 本地双人时两套各管一条。联机客机则由这里把操作发给主机。
// 以前是写死的：方向键永远打 P1、WASD 永远打 P2，于是
// 客机按方向键没反应、单人和联机主机的 WASD 是死的、单人按 W 还会炸。
function dualLocal() {
    return !netRole && players && players.length > 1;
}

function localTurn(dirName) {
    if (state !== 'running' || !dirName) return;
    if (netRole === 'guest') {
        if (!netSpectating()) netSend({ t: 'dir', dir: dirName });   // 观战只看不操作
        return;
    }
    if (players && players[0]) turn(players[0], dirName);
}

function localBuild() {
    if (netRole === 'guest' && typeof sfxBuild === 'function') sfxBuild();   // 本地先响一声
    if (state !== 'running') return;
    if (netRole === 'guest') {
        if (!netSpectating()) netSend({ t: 'build' });
        return;
    }
    if (players && players[0]) players[0].buildRequested = true;
}

// 触摸反馈：能震就轻轻震一下（iOS 的 Safari 不支持 vibrate，忽略即可）
function tapFeedback() {
    // 第一次交互时把 AudioContext 唤醒（浏览器要求在手势里才能出声）
    if (typeof sfxResume === 'function') sfxResume();
    try {
        if (navigator.vibrate) navigator.vibrate(8);
    } catch (e) { /* 不支持就算了 */ }
}

function onKeyDown(ev) {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (typeof sfxResume === 'function') sfxResume();   // 键盘也算用户交互

    // 焦点在输入框 / 文本域里时，游戏快捷键一律让路 ——
    // 否则在聊天框里打 w、a、s、d、p 会顺手把蛇拐弯、把局暂停
    const tgt = ev.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;

    // C：房间设置；T：聊天。单机 / 联机都能用，所以放在模式判断之前
    if (key === 'c') { ev.preventDefault(); toggleCfgPanel(); return; }
    if (key === 't') { ev.preventDefault(); toggleChat(); return; }

    // 面板上：1 / 2 直接选模式
    if (state === 'menu') {
        if (!netPanelEl.hidden) return;   // 联机面板上别误触数字键
        if (key === '1') { ev.preventDefault(); startLocalGame(); }
        // 2 = 开启房间：直接点那个按钮，行为和鼠标点它完全一样
        else if (key === '2') { ev.preventDefault(); startBtnNetEl.click(); }
        return;
    }

    // Esc：随时退回模式选择
    if (key === 'Escape') {
        ev.preventDefault();
        showMenu();
        return;
    }

    // P1 用方向键，P2 用 WASD。
    // 联机时：客机的 WASD 变成网络输入，主机本地的 WASD 不再抢 P2
    const k1 = KEYMAP_P1[key];
    const k2 = KEYMAP_P2[key];
    if (k1 || k2) {
        ev.preventDefault();
        if (heldDirs) heldDirs[k1 || k2] = true;   // 「按住才走」用
        if (dualLocal()) {
            // 本地双人：两套各管一条
            if (k1) turn(players[0], k1);
            else turn(players[1], k2);
        } else {
            // 单人 / 联机：两套都归自己那条蛇
            localTurn(k1 || k2);
        }
        return;
    }

    // P：暂停 / 继续
    if (key === 'p') {
        ev.preventDefault();
        // 客机不能自己暂停，只能向主机请求
        if (netRole === 'guest') netAskHost('pause');
        else togglePause();
        return;
    }

    // 建塔键：P1 用 /，P2 用 Q。单人 / 联机时两个键都算自己那条蛇。
    if (state === 'running' && key === '/') {
        ev.preventDefault();
        localBuild();
        return;
    }

    if (state === 'running' && key === 'q') {
        ev.preventDefault();
        if (dualLocal()) {
            if (players[1]) players[1].buildRequested = true;
        } else {
            localBuild();
        }
        return;
    }

    // 空格：只在结算画面重开。客机不能自己重开，只能请求主机
    if (key === ' ') {
        ev.preventDefault();
        if (state === 'over') {
            if (netRole === 'guest') netAskHost('restart');
            else start();
        }
        return;
    }

    if (key === 'Enter') {
        ev.preventDefault();
        if (state === 'over') {
            if (netRole === 'guest') netAskHost('restart');
            else start();
        }
    }
}

document.addEventListener('keydown', onKeyDown);

// 松开方向键：清掉「按住」状态
document.addEventListener('keyup', function (ev) {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const k1 = KEYMAP_P1[key];
    const k2 = KEYMAP_P2[key];
    if ((k1 || k2) && heldDirs) heldDirs[k1 || k2] = false;
});

// 失焦时全部松开（不然切走再回来蛇会一直走）
window.addEventListener('blur', function () {
    if (!heldDirs) return;
    heldDirs.up = heldDirs.down = heldDirs.left = heldDirs.right = false;
});

Array.prototype.forEach.call(
    document.querySelectorAll('.operate .btn[data-dir]'),
    function (btn) {
        const dir = btn.getAttribute('data-dir');
        // 「按住才走」：按下/抬起都记一下（同时保留 click 的转向行为）
        btn.addEventListener('pointerdown', function () { if (heldDirs) heldDirs[dir] = true; });
        btn.addEventListener('pointerup', function () { if (heldDirs) heldDirs[dir] = false; });
        btn.addEventListener('pointercancel', function () { if (heldDirs) heldDirs[dir] = false; });
        btn.addEventListener('pointerleave', function () { if (heldDirs) heldDirs[dir] = false; });
        btn.addEventListener('click', function () {
            tapFeedback();
            // 客机点屏幕方向键也要发给主机，不然本地是空操作
            localTurn(btn.getAttribute('data-dir'));
        });
    }
);

// 本地双人的第二个方向键盘（手机上两人各按各的）。
// 联机客机不走这里 —— 那边由 localTurn 把操作发给主机。
Array.prototype.forEach.call(
    document.querySelectorAll('.operate .btn[data-dir2]'),
    function (btn) {
        btn.addEventListener('click', function () {
            tapFeedback();
            if (!dualLocal() || !players || !players[1]) return;
            turn(players[1], btn.getAttribute('data-dir2'));
        });
    }
);

for (let i = 0; i < buildBtnEls.length; i++) {
    (function (idx) {
        buildBtnEls[idx].addEventListener('click', function () {
            tapFeedback();
            if (dualLocal()) {
                if (players[idx]) players[idx].buildRequested = true;
            } else {
                // 单人 / 联机：屏幕上只剩自己那一个按钮，按了就建
                localBuild();
            }
        });
    })(i);
}

// 炮塔升级（只给按钮，先不接键盘）：A = 跟踪，B = 火力
function localUpgrade(path) {
    if (netRole === 'guest') {                 // 客机：让主机替自己升
        netSend({ t: 'upgrade', path: path });
        if (typeof sfxUpgrade === 'function') sfxUpgrade();
        return;
    }
    if (state !== 'running' || !players || !players[0]) return;
    upgradeTurret(players[0], path);
}

for (let i = 0; i < upABtnEls.length; i++) {
    (function (idx) {
        const wire = function (btn, path) {
            if (!btn) return;
            btn.addEventListener('click', function () {
                tapFeedback();
                if (dualLocal()) {
                    if (players[idx]) players[idx].upgradeRequested = path;
                } else {
                    localUpgrade(path);
                }
            });
        };
        wire(upABtnEls[idx], 'A');
        wire(upBBtnEls[idx], 'B');
    })(i);
}

// 房间里也能点开设置 / 聊天（手机上主要靠这两个按钮）
document.getElementById('cfgBtn').addEventListener('click', function () { tapFeedback(); toggleCfgPanel(); });
document.getElementById('chatBtn').addEventListener('click', function () { tapFeedback(); toggleChat(); });

pauseBtnEl.addEventListener('click', function () {
    tapFeedback();
    if (netRole === 'guest') netAskHost('pause');
    else togglePause();
});

// 「本地」：按当前设置开局（人数 1/2，双人时合作或竞争）
function startLocalGame() {
    if (localPlayerCount === 2) start(2, localTeam === 'vs' ? 'vs' : 'coop');
    else start(1);
}

function syncStartSettings() {
    if (startPlayersBtnEl) startPlayersBtnEl.textContent = '人数：' + localPlayerCount;
    if (startTeamBtnEl) {
        startTeamBtnEl.hidden = (localPlayerCount !== 2);
        startTeamBtnEl.textContent = (localTeam === 'vs') ? '竞争' : '合作';
        startTeamBtnEl.classList.toggle('is-on', localTeam === 'vs');
    }
}

startBtnLocalEl.addEventListener('click', function () { tapFeedback(); startLocalGame(); });
if (startPlayersBtnEl) {
    startPlayersBtnEl.addEventListener('click', function () {
        tapFeedback();
        localPlayerCount = (localPlayerCount === 2) ? 1 : 2;
        syncStartSettings();
    });
}
if (startTeamBtnEl) {
    startTeamBtnEl.addEventListener('click', function () {
        tapFeedback();
        localTeam = (localTeam === 'vs') ? 'coop' : 'vs';
        syncStartSettings();
    });
}

syncStartSettings();

// 手机上结束后点棋盘即可重开
canvas.addEventListener('click', function () {
    if (state === 'over') start();
});
