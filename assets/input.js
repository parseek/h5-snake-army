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
        netSend({ t: 'dir', dir: dirName });
        return;
    }
    if (players && players[0]) turn(players[0], dirName);
}

function localBuild() {
    if (state !== 'running') return;
    if (netRole === 'guest') {
        netSend({ t: 'build' });
        return;
    }
    if (players && players[0]) players[0].buildRequested = true;
}

function onKeyDown(ev) {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

    // 面板上：1 / 2 直接选模式
    if (state === 'menu') {
        if (!netPanelEl.hidden) return;   // 联机面板上别误触数字键
        if (key === '1') { ev.preventDefault(); start(1); }
        else if (key === '2') { ev.preventDefault(); start(2, 'coop'); }
        else if (key === '3') { ev.preventDefault(); start(2, 'vs'); }
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

Array.prototype.forEach.call(
    document.querySelectorAll('.operate .btn'),
    function (btn) {
        btn.addEventListener('click', function () {
            // 客机点屏幕方向键也要发给主机，不然本地是空操作
            localTurn(btn.getAttribute('data-dir'));
        });
    }
);

for (let i = 0; i < buildBtnEls.length; i++) {
    (function (idx) {
        buildBtnEls[idx].addEventListener('click', function () {
            if (dualLocal()) {
                if (players[idx]) players[idx].buildRequested = true;
            } else {
                // 单人 / 联机：屏幕上只剩自己那一个按钮，按了就建
                localBuild();
            }
        });
    })(i);
}

pauseBtnEl.addEventListener('click', function () {
    if (netRole === 'guest') netAskHost('pause');
    else togglePause();
});

startBtnSingleEl.addEventListener('click', function () { start(1); });
startBtnCoopEl.addEventListener('click', function () { start(2, 'coop'); });
startBtnVsEl.addEventListener('click', function () { start(2, 'vs'); });

// 手机上结束后点棋盘即可重开
canvas.addEventListener('click', function () {
    if (state === 'over') start();
});
