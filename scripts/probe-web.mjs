// 端到端探针：把 index.html 装进 iframe，跑一遍关键玩法，再把结果打回来。
//
// 用法：npm run probe          （可选 --port 9231 --wait 7000）
//
// 流程：sync-web -> 生成 dist/_probe.html -> 起 serve-dist（它带 /__probe 回传口）
//       -> smoke.mjs 用隔离的无头 Edge 打开探针 -> 探针把 JSON POST 回来 -> 这里打报告
//
// 为什么需要它：拆文件是纯机械搬运，最容易犯的错只有两类 ——
//   1. 某个函数搬过去之后压根没人定义（或忘了加 <script src>）
//   2. 搬的时候手滑改了逻辑
// 所以探针做两件事：
//   * 把 assets/ 与主脚本里**所有**顶层声明的名字列出来，逐个 typeof 一遍
//   * 真的开局跑几百帧：走位、建塔、拓宽、敌人、快照、暂停、双人、重开
// 缺一个、错一个都会变红并让进程以非零码退出。
//
// 用真实时间的 rAF 主循环，不用 --dump-dom：dump 走虚拟时间，读到的是「pending」。
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function opt(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = Number(opt('--port', '9231'));
// 四个阶段加起来越来越长（80 + 1200 + 1000 + 700 的间隔，外加每步的工作量），
// 7 秒已经卡着线了 —— 出现「只跑到 phase1 就收尾」就是这里不够
const WAIT = Number(opt('--wait', '14000'));
const BASE = 'http://127.0.0.1:' + PORT;
const DIST = join(root, 'dist');

const WEB_FILES = [
    'assets/config.js', 'assets/state.js', 'assets/net.js',
    'assets/game.js', 'assets/render.js', 'assets/input.js', 'assets/net-session.js',
    'assets/level.js',
    'index.html',
];

// ------------------------------ 1. 收集所有顶层声明的名字 ------------------------------
// 需要粗略的大括号深度扫描：只有深度 0 的声明才算「顶层」，函数体里的局部量不算。
function topLevelNames(code) {
    const lines = code.split('\n');
    const names = [];
    let depth = 0, prevSig = '';
    for (const line of lines) {
        if (depth === 0) {
            const m = line.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
                line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
            if (m) names.push(m[1]);
        }
        for (let k = 0; k < line.length; k++) {
            const c = line[k], n = line[k + 1];
            if (c === '/' && n === '/') break;
            if (c === '/' && n === '*') {
                const e = line.indexOf('*/', k + 2);
                k = e < 0 ? line.length : e + 1;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') {
                let j = k + 1;
                while (j < line.length) {
                    if (line[j] === '\\') { j += 2; continue; }
                    if (line[j] === c) break;
                    j++;
                }
                k = j; prevSig = c; continue;
            }
            if (c === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(prevSig || '')) {
                let j = k + 1, cls = false;
                while (j < line.length) {
                    const d = line[j];
                    if (d === '\\') { j += 2; continue; }
                    if (d === '[') cls = true; else if (d === ']') cls = false;
                    else if (d === '/' && !cls) break;
                    j++;
                }
                k = j; prevSig = '/'; continue;
            }
            if (!/\s/.test(c)) prevSig = c;
            if (c === '{' || c === '(' || c === '[') depth++;
            else if (c === '}' || c === ')' || c === ']') depth--;
        }
    }
    return names;
}

function collectNames() {
    const set = new Set();
    for (const f of WEB_FILES) {
        const full = join(root, f);
        if (!existsSync(full)) { console.error('[probe] 缺文件 ' + f); process.exit(1); }
        let code = readFileSync(full, 'utf8');
        if (f.endsWith('.html')) {
            const i0 = code.indexOf('<script>');
            const i1 = code.indexOf('</script>', i0);
            code = code.slice(i0 + 8, i1);
        }
        for (const n of topLevelNames(code)) set.add(n);
    }
    return [...set].sort();
}

// ------------------------------ 2. 生成探针页 ------------------------------
const PROBE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>probe</title>
<style>body{margin:0;font:12px ui-monospace,monospace}#out{white-space:pre-wrap}</style></head>
<body>
<pre id="out">pending</pre>
<script>
const NAMES = __NAMES__;
const report = { globals: { expected: NAMES.length, missing: [] }, errs: [], steps: [], phases: {}, phase: 'load' };
function flush() {
    document.getElementById('out').textContent = 'PROBE_JSON:' + JSON.stringify(report);
    try { fetch('/__probe', { method: 'POST', body: JSON.stringify(report) }); }
    catch (e) { report.errs.push({ phase: report.phase, msg: 'post failed: ' + e.message, stack: null }); }
}
function step(name, fn) {
    report.phase = name;
    try { const r = fn(); report.steps.push({ n: name, ok: true, v: r === undefined ? null : r }); }
    catch (e) { report.steps.push({ n: name, ok: false, e: String((e && e.message) || e) }); }
}
const ifr = document.createElement('iframe');
ifr.style.cssText = 'width:900px;height:1150px;border:0';
ifr.src = './index.html';
document.body.appendChild(ifr);
ifr.addEventListener('load', function () {
    const w = ifr.contentWindow;
    w.addEventListener('error', function (e) {
        report.errs.push({
            phase: report.phase,
            msg: (e && e.message) || (e.target && e.target.src) || '?',
            stack: (e && e.error && e.error.stack) ? String(e.error.stack).split('\\n').slice(0, 4).join(' <- ') : null
        });
    }, true);
    setTimeout(function () { phase1(w); }, 80);
});
function ev(w, e) { return w.eval(e); }
function key(w, k) { w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }
function phase1(w) {
    step('globals', function () {
        for (const n of NAMES) {
            let t;
            try { t = w.eval('typeof ' + n); }
            catch (err) { report.globals.missing.push(n + '!throw'); continue; }
            if (t === 'undefined') report.globals.missing.push(n);
        }
        return report.globals.missing.length;
    });
    step('menu', function () { return ev(w, 'state'); });
    step('start1p', function () { ev(w, 'start(1)'); return ev(w, "state + '/' + players.length + '/' + COLS + 'x' + ROWS"); });
    step('moves-1p', function () {
        ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'w', 'a', 's', 'd'].forEach(function (k) { key(w, k); });
        return ev(w, "players.length + '/' + players[0].body.length");
    });
    step('build-keys-1p', function () { key(w, '/'); key(w, 'q'); return 'no-throw'; });
    step('pause-key', function () { key(w, 'p'); const a = ev(w, 'state'); key(w, 'p'); return a + '->' + ev(w, 'state'); });
    step('escape-menu', function () { key(w, 'Escape'); const a = ev(w, 'state'); ev(w, 'start(1)'); return a + '->' + ev(w, 'state'); });
    step('render', function () { ev(w, 'render()'); return 'ok'; });
    step('spawn-enemy', function () { ev(w, 'spawnEnemy(gameNow + 60000)'); return ev(w, 'enemies.length + "/" + enemies[0].kind + "/" + enemies[0].body.length'); });
    step('grow-and-turret', function () {
        // 注意：不能写 players[0].body.length = 14 —— 那会留下空洞，之后读 body[i].x 会炸
        ev(w, 'while (players[0].body.length < 14) { var t0 = players[0].body[players[0].body.length - 1]; players[0].body.push(cell(t0.x, t0.y)); players[0].hp.push(SEGMENT_HP); }');
        ev(w, 'players[0].coins = 5');
        const built = ev(w, 'buildTurret(players[0])');
        return built + '/' + ev(w, 'turrets.length') + '/' + ev(w, 'players[0].body.length');
    });
    step('update-turrets', function () { ev(w, 'updateTurrets(gameNow + 1000)'); ev(w, 'updateBullets(0.05, gameNow)'); return ev(w, 'bullets.length'); });
    step('widen', function () { ev(w, 'widenField(gameNow)'); return ev(w, 'COLS + "x" + ROWS'); });
    step('render-after-turret', function () { ev(w, 'render()'); return 'ok'; });
    step('snapshot-roundtrip', function () { ev(w, 'netApplySnapshot(netSnapshot())'); return 'ok'; });
    step('snapshot-shape', function () { return ev(w, 'Object.keys(netSnapshot()).length'); });
    step('net-simulate-p2', function () {
        ev(w, 'netRole = "host"; var m = netSnapshot(); netRole = "guest"; netApplySnapshot(m); netRole = null;');
        return ev(w, 'String(netRole)');
    });
    step('enemy-step', function () { ev(w, 'for (var i = 0; i < enemies.length; i++) stepEnemy(enemies[i], gameNow + 1200)'); return ev(w, 'enemies.length'); });
    step('damage-and-kill', function () {
        ev(w, 'if (enemies.length) { killEnemy(enemies[0], gameNow); }');
        return ev(w, 'corpses.length + "/" + drops.length');
    });
    step('kill-player', function () { ev(w, 'killPlayer(players[0], gameNow)'); return ev(w, 'state + "/" + corpses.length'); });
    step('coop-revive', function () {
        ev(w, "start(2, 'coop')");
        ev(w, 'killPlayer(players[0], gameNow)');
        ev(w, 'spawnReviveItem()');
        return ev(w, 'String(!!reviveItem) + "/" + players[0].alive');
    });
    step('vs-first-death', function () {
        ev(w, "start(2, 'vs')");
        ev(w, 'killPlayer(players[0], gameNow)');
        return ev(w, 'state');
    });
    step('net-kind-cycle', function () {
        ev(w, "setNetKind('wan')"); ev(w, "setNetKind('direct')"); ev(w, "setNetKind('code')"); ev(w, "setNetKind('lan')");
        ev(w, 'syncNetBar()');
        return ev(w, 'netKind');
    });
    step('back-to-running', function () { ev(w, 'start(1)'); return ev(w, 'state'); });
    flush();
    setTimeout(function () { phase2(w); }, 1200);
}
function phase2(w) {
    report.phase = 'loop-1p';
    report.phases.after1s = {
        state: ev(w, 'state'), apples: ev(w, 'apples.length'), enemies: ev(w, 'enemies.length'),
        turrets: ev(w, 'turrets.length'), bullets: ev(w, 'bullets.length'), drops: ev(w, 'drops.length'),
        corpses: ev(w, 'corpses.length'), len: ev(w, 'players[0].body.length'),
        hp: ev(w, 'players[0].hp.length'), score: ev(w, 'players[0].score'), best: ev(w, 'best'),
        gameNow: Math.round(ev(w, 'gameNow')), arena: ev(w, 'COLS + "x" + ROWS'), hudRows: ev(w, 'hudEntries.length')
    };
    step('start-2p-coop', function () { ev(w, "start(2, 'coop')"); return ev(w, 'players.length'); });
    flush();
    setTimeout(function () { phase3(w); }, 1000);
}
function phase3(w) {
    report.phase = 'loop-2p';
    report.phases.after2p = {
        state: ev(w, 'state'), teamMode: ev(w, 'teamMode'), players: ev(w, 'players.length'),
        len: ev(w, '[players[0].body.length, players[1].body.length]'),
        apples: ev(w, 'apples.length'), enemies: ev(w, 'enemies.length'),
        arena: ev(w, 'COLS + "x" + ROWS'), hudRows: ev(w, 'hudEntries.length'),
        coins: ev(w, '[players[0].coins, players[1].coins]'), dualLocal: ev(w, 'dualLocal()')
    };
    step('vs-mode', function () { ev(w, "start(2, 'vs')"); return ev(w, "teamMode + '/' + players.length"); });
    step('dual-local', function () { ev(w, 'dualLocal()'); return 'ok'; });
    step('widen-twice', function () { ev(w, 'widenField(gameNow)'); ev(w, 'widenField(gameNow)'); return ev(w, 'COLS + "x" + ROWS'); });
    step('reset', function () { ev(w, 'reset()'); return 'ok'; });
    step('showMenu', function () { ev(w, 'showMenu()'); return ev(w, 'state'); });
    report.phases.final = { state: ev(w, 'state'), version: ev(w, 'APP_VERSION'), maxPlayers: ev(w, 'MAX_PLAYERS'), arena: ev(w, 'COLS + "x" + ROWS') };
    flush();
    setTimeout(function () { phase4(w); }, 700);
}

// 第四个阶段：多客机 / 观战。这里不真开 WebRTC（无头浏览器里没法两端互连），
// 而是往座位表里塞「假通道」—— 它跟真通道走的是同一套 netPeerSend /
// netOnMessage / netBroadcastSnapshot，所以座位分配、按座位分发快照、按座位收按键、
// 观战只看不操作，这些逻辑都能在真实页面上验到。
const MK = "function mk(seat) { return { seat: seat, open: true, pc: null, dc: { send: function (s) { window.__sent.push(s); } } }; }";

function phase4(w) {
    report.phase = 'seats';
    // 一个阶段整体崩掉时，以前会静默丢掉后面所有步骤（只看到步数变少）。
    // 包一层，至少把「崩在哪」报出来。
    try {
        phase4run(w);
    } catch (e) {
        report.errs.push({
            phase: 'seats',
            msg: 'phase4 崩了：' + String((e && e.message) || e),
            stack: (e && e.stack) ? String(e.stack).split('\\n').slice(0, 4).join(' <- ') : null
        });
        flush();
    }
}

function phase4run(w) {

    step('seat-alloc', function () {
        return ev(w, [
            'netLeave();',
            'netRole = "host";',
            'netMaxPlayers = 4;',
            'netPeers = [];',
            'var a = netTakeSeat(); netPeers.push({ seat: a, open: true, pc: null, dc: null });',
            'var b = netTakeSeat(); netPeers.push({ seat: b, open: true, pc: null, dc: null });',
            'var c = netTakeSeat(); netPeers.push({ seat: c, open: true, pc: null, dc: null });',
            'var d = netTakeSeat();',
            'a + "/" + b + "/" + c + "/" + d;'
        ].join('\\n'));
    });

    step('one-snapshot-per-seat', function () {
        return ev(w, [
            MK,
            'window.__sent = [];',
            'netRole = "host";',
            'netMaxPlayers = 3;',
            'netPeers = [mk(1), mk(2), mk(-1)];',
            'netOpen = false;',
            'netBroadcastSnapshot({ t: "state", now: 1 });',
            'window.__sent.map(function (s) { var m = JSON.parse(s); return m.you + ":" + m.t; }).join(",");',
        ].join('\\n'));
    });

    step('mid-game-join', function () {
        return ev(w, [
            MK,
            'start(2, "coop");',
            'netRole = "host";',
            'netMaxPlayers = 4;',
            'netPeers = [mk(1), mk(2)];',
            'var before = players.length;',
            'netSyncPlayers();',
            'before + "->" + players.length + "/" + (players[2] && players[2].alive ? "alive" : "?") + "/" + (players[2] && players[2].spawnAt >= 0 ? "spawn-anim" : "no-anim") + "/" + netWantedPlayers();',
        ].join('\\n'));
    });

    step('input-routes-by-seat', function () {
        return ev(w, [
            MK,
            'netRole = "host";',
            'netPeers = [mk(1), mk(2), mk(-1)];',
            'var q1 = players[1].queue.length, q2 = players[2].queue.length;',
            'netOnMessage(JSON.stringify({ t: "dir", dir: "up" }), netPeers[0]);',
            'netOnMessage(JSON.stringify({ t: "dir", dir: "down" }), netPeers[1]);',
            'var after1 = players[1].queue.length, after2 = players[2].queue.length;',
            'netOnMessage(JSON.stringify({ t: "dir", dir: "up" }), netPeers[2]);',
            'netOnMessage(JSON.stringify({ t: "build" }), netPeers[0]);',
            'q1 + "/" + q2 + " -> " + after1 + "/" + after2 + " spec:" + players[2].queue.length + " build:" + String(!!players[1].buildRequested);',
        ].join('\\n'));
    });

    step('spectator-lockout', function () {
        return ev(w, [
            MK,
            'window.__sent = [];',
            'netRole = "guest";',
            'netSeat = -1;',
            'netOpen = true;',
            'netPeers = [mk(-1)];',
            'netPrimary = netPeers[0];',
            'var before = players[0] ? players[0].queue.length : -1;',
            'localTurn("up");',
            'localBuild();',
            'netAskHost("pause");',
            'syncNetBar();',
            'var who = document.getElementById("netBarWho").textContent;',
            '__sent.length + "|" + who + "|pause:" + document.getElementById("netBarPause").hidden + "|restart:" + document.getElementById("netBarRestart").hidden + "|" + document.getElementById("netBarState").textContent + "|queue:" + (players[0] ? players[0].queue.length : -1) + "(was " + before + ")";',
        ].join('\\n'));
    });

    step('guest-seat-from-snapshot', function () {
        return ev(w, [
            'var m = netSnapshot();',
            'm.you = 2;',
            'netApplySnapshot(m);',
            'netRole + "/" + netSeat + "/" + netSpectating();',
        ].join('\\n'));
    });

    step('restore-local', function () {
        return ev(w, [
            'netLeave();',
            'start(1, "coop");',
            'String(netRole) + "/" + String(netSeat) + "/" + netOpen + "/" + state + "/" + players.length;',
        ].join('\\n'));
    });

    // 手机连电脑打洞超时那件事的三条修复
    step('ip-of-url', function () { return ev(w, 'ipOfUrl("http://192.168.1.23:47812") + "|" + ipOfUrl("https://x:1") + "|" + ipOfUrl("垃圾") + "|" + ipOfUrl("http://127.0.0.1:9")'); });
    step('code-carries-ip', function () { return ev(w, 'var c1 = netEncode("v=0 x", "offer", "192.168.1.23"); var c2 = netEncode("v=0 x", "offer"); netDecode(c1, "offer").ip + "/" + netDecode(c2, "offer").ip + " 段数 " + c1.split("#").length + "/" + c2.split("#").length'); });
    step('patch-unmasks-mdns', function () { return ev(w, 'window.__added = []; var fake = { remoteDescription: { sdp: "a=candidate:1 1 udp 2113 abc.local 50000 typ host" + String.fromCharCode(13,10) + "a=candidate:2 1 udp 2113 10.0.0.9 50001 typ host" }, addIceCandidate: function (c) { window.__added.push(c.candidate); return Promise.resolve(); } }; netPatchIp(fake, "192.168.1.23") + " 条 => " + window.__added.join(" ; ")'); });

    // 房间配置（主机实时改）+ 聊天
    step('cfg-live-team-enemies', function () { return ev(w, 'start(1); setCfg({ team: "vs", enemies: false, powerups: false }); teamMode + "/" + levelCfg.enemies + "/" + enemies.length + "/ 道具 " + powerList("speed").length + "/" + spawnEnemy(gameNow)'); });
    step('cfg-live-grow', function () { return ev(w, 'start(1); var h0 = JSON.stringify(players[0].body[0]); setCfg({ cols: COLS + 4, rows: ROWS + 2 }); COLS + "x" + ROWS + "/" + (JSON.stringify(players[0].body[0]) === h0)'); });
    step('cfg-shrink-restarts', function () { return ev(w, 'setArenaSize(10, 8, gameNow) + "/" + COLS + "x" + ROWS'); });
    step('cfg-next-round-keeps-size', function () { return ev(w, 'setCfg({ enemies: true, powerups: true }); start(1); COLS + "x" + ROWS + "/" + levelCfg.cols'); });
    step('cfg-guest-readonly', function () { return ev(w, 'netRole = "guest"; syncCfgPanel(); document.getElementById("cfgCols").disabled + "/" + document.getElementById("cfgCols").value'); });
    step('chat-relay', function () { return ev(w, 'window.__sent = []; function mk(s) { return { seat: s, open: true, pc: null, name: "小王", dc: { send: function (x) { window.__sent.push(x); } } }; } netRole = "host"; netPeers = [mk(1), mk(2)]; netOnMessage(JSON.stringify({ t: "chat", text: "hi" }), netPeers[0]); window.__sent.length + "/" + JSON.parse(window.__sent[0]).name + "/" + chatLog[chatLog.length - 1].text'); });
    step('chat-input-guard', function () { return ev(w, 'netLeave(); start(1); var q0 = players[0].queue.length; document.getElementById("chatInput").dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true })); players[0].queue.length - q0'); });
    step('chat-html-safe', function () { return ev(w, 'chatLog.length = 0; toggleChat(true); chatPush("坏", "<img src=x onerror=1>", false); var row = document.getElementById("chatList").lastChild; row.querySelectorAll("img").length + "/" + (row.innerHTML.indexOf("&lt;img") >= 0)'); });

    // 建塔按钮：联机时要显示「我」那条蛇
    step('build-btn-mine', function () { return ev(w, 'netRole = "guest"; netSeat = 2; while (players.length < 3) addPlayerAt(players.length); syncBuildBtn(); document.getElementById("buildBtn0").textContent.slice(0, 8) + "/" + document.getElementById("buildBtn1").style.display'); });
    step('build-btn-spectator', function () { return ev(w, 'netSeat = -1; syncBuildBtn(); document.getElementById("buildBtn0").style.display + "/" + document.getElementById("buildBtn1").style.display'); });

    // 大地图摄像机
    step('cam-small-world-off', function () { return ev(w, 'start(1); VIEW_W + "x" + VIEW_H + "/" + COLS + "x" + ROWS + " cam " + camX + "," + camY'); });
    step('cam-big-world-clamp', function () { return ev(w, 'setArenaSize(60, 40, gameNow); widenStartAt = 0; resizeCanvas(); players[0].body[0].x = 0; players[0].body[0].y = 0; camReady = false; updateCamera(); var a = camX + "," + camY; players[0].body[0].x = 59; players[0].body[0].y = 39; camReady = false; updateCamera(); a + " -> " + camX + "," + camY + " (VIEW " + VIEW_W + "x" + VIEW_H + ")";'); });
    step('cam-center-on-focus', function () { return ev(w, 'players[0].body[0].x = 30; players[0].body[0].y = 20; camReady = false; updateCamera(); Math.abs(camX + VIEW_W / 2 - (players[0].body[0].x * CELL + CELL / 2)) + "/" + Math.abs(camY + VIEW_H / 2 - (players[0].body[0].y * CELL + CELL / 2))'); });
    step('cam-follows-seat', function () { return ev(w, 'netRole = "guest"; netSeat = 2; while (players.length < 3) addPlayerAt(players.length); (cameraFocus() === players[2]) + "/" + players[2].def.name'); });
    step('cam-draws-through-camera', function () { return ev(w, 'netLeave(); setArenaSize(60, 40, gameNow); resizeCanvas(); players[0].body[0].x = 30; players[0].body[0].y = 20; camReady = false; updateCamera(); render(); var px = ctx.getImageData(Math.round(cxOf(players[0].body[0])) - 5, Math.round(cyOf(players[0].body[0])), 1, 1).data; var onBoard = ctx.getImageData(2, 2, 1, 1).data; px[0] + "," + px[1] + "," + px[2] + " / 底色 " + onBoard[0] + "," + onBoard[1] + "," + onBoard[2];'); });

    step('widen-anim-math', function () { return ev(w, 'start(1); var w0 = drawWorldW; widenField(gameNow); applyWidenFrame(0); var a = Math.round(drawWorldW); applyWidenFrame(1); var b = Math.round(drawWorldW); applyWidenFrame(0); var off = Math.round(renderOffsetX); a + "/" + b + "/" + Math.round(drawWorldH) + "/ 偏移 " + off + "/ 世界 " + W + "x" + H + "/ 视口 " + VIEW_W + "x" + VIEW_H'); });

    // 场地扩展的几何：新那一圈必须等长到了才出现（之前是靠画布边缘裁的，加了摄像机后要显式裁）
    step('widen-canvas-grows', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); widenField(gameNow); var out = []; [0, 0.25, 0.5, 0.75, 1].forEach(function (e) { applyWidenFrame(e); out.push(VIEW_W); }); out.join("->");'); });
    step('widen-big-map-view-fixed', function () { return ev(w, 'netLeave(); start(1); setArenaSize(60, 40, gameNow); resizeCanvas(); applyWidenFrame(1); widenStartAt = 0; resizeCanvas(); var before = document.getElementById("board").width; var rects = []; widenField(gameNow); [0, 0.5, 1].forEach(function (e) { applyWidenFrame(e); rects.push(Math.round(boardRect().w)); }); (before === document.getElementById("board").width) + " / 画布 " + VIEW_W + " 场地 " + rects.join("->");'); });
    step('widen-guest-mirrors-canvas', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); widenField(gameNow); applyWidenFrame(0.5); var m = netSnapshot(); var hostW = document.getElementById("board").style.width; netRole = "guest"; netSeat = 2; netApplySnapshot(m); hostW + "/" + document.getElementById("board").style.width + "/bw " + m.bw;'); });
    step('widen-clip-reset', function () { return ev(w, 'applyWidenFrame(1); widenStartAt = 0; resizeCanvas(); levelCfg.cols = 0; levelCfg.rows = 0; Math.round(boardRect().w) + "x" + Math.round(boardRect().h) + "/" + W;'); });

    // 关卡修改器页面（本地和联机开房共用同一个页面）
    step('level-page-fields', function () { return ev(w, 'netLeave(); start(1); buildLevelPage(); var ids = ["cfgCols", "cfgRows", "cfgCoop", "cfgVs", "cfgEnemies", "cfgPowerups", "cfgName", "cfgDesc", "cfgLen0", "cfgHp0", "cfgStepMs", "cfgApples", "cfgEnemyMax", "cfgEnemyGap", "cfgBoostMs", "cfgRevive", "cfgTurretCost", "cfgTurretCoins", "cfgTurretMax", "cfgMaxPlayers"]; var miss = ids.filter(function (i) { return !document.getElementById(i); }); ids.length + " 项缺 " + miss.length + " / 分组 " + document.querySelectorAll("#cfgBody .tip.sec").length'); });
    step('level-live-speed', function () { return ev(w, 'setCfg({ stepMs: 250 }); players[0].stepMs + "/" + levelCfg.stepMs'); });
    step('level-restart-only', function () { return ev(w, 'setCfg({ len0: 5, hp0: 3 }); var note = document.getElementById("cfgNote").textContent; restartLevel(); players[0].body.length + "/" + players[0].hp[0] + "/ 提示有「重开」" + (note.indexOf("重开") >= 0)'); });
    step('level-snapshot-carries-all', function () { return ev(w, 'setCfg({ hp0: 4, apples: 2, turretCost: 3, enemyMax: 7, revive: false }); var m = netSnapshot(); netRole = "guest"; netSeat = 2; netApplySnapshot(m); levelCfg.hp0 + "/" + levelCfg.apples + "/" + levelCfg.turretCost + "/" + levelCfg.enemyMax + "/" + levelCfg.revive'); });
    step('level-guest-readonly-all', function () { return ev(w, 'netRole = "guest"; syncCfgPanel(); ["cfgCols", "cfgLen0", "cfgStepMs", "cfgName", "cfgEnemies", "cfgCoop"].filter(function (i) { return document.getElementById(i).disabled; }).length + "/6"'); });
    step('level-reset-defaults', function () { return ev(w, 'netLeave(); resetLevelCfg(); [levelCfg.len0, levelCfg.hp0, levelCfg.stepMs, levelCfg.apples, levelCfg.turretCost, levelCfg.turretMax].join("/") + " 场地 " + COLS + "x" + ROWS'); });

    // 关卡预设：内置 / 存 / 下载 / 加载
    step('preset-builtin-applies', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); applyPresetCfg(LEVEL_PRESETS[1].cfg, "x"); COLS + "x" + ROWS + "/" + levelCfg.enemyMax + "/" + levelCfg.stepMs + "/" + levelCfg.apples'); });
    step('preset-keeps-room-info', function () { return ev(w, 'levelCfg.name = "小王的车队"; levelCfg.desc = "随便玩"; levelCfg.maxPlayers = 5; applyPresetCfg(LEVEL_PRESETS[2].cfg, "x"); levelCfg.name + "/" + levelCfg.desc + "/" + levelCfg.maxPlayers + "/ 场地 " + COLS + "x" + ROWS'); });
    step('preset-save-and-apply', function () { return ev(w, 'try { localStorage.removeItem(PRESET_KEY); } catch (e) { } applyPresetCfg(LEVEL_PRESETS[4].cfg, "x"); var big = COLS + "x" + ROWS; saveCurrentAsPreset(); var list = loadSavedPresets(); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); var small = COLS + "x" + ROWS; applyPresetCfg(list[0].cfg, "x"); list.length + "/" + list[0].name + "/" + big + " -> " + small + " -> " + COLS + "x" + ROWS'); });
    step('preset-import-clamps', function () { return ev(w, 'importLevelText(JSON.stringify({ name: "坏文件", cfg: { cols: 99999, rows: -5, stepMs: 1, hp0: 999, apples: "x", enemies: "yes" } })); COLS + "x" + ROWS + "/步长 " + levelCfg.stepMs + "/血 " + levelCfg.hp0 + "/苹果 " + levelCfg.apples + "/敌人 " + levelCfg.enemies'); });
    step('preset-import-bad-json', function () { return ev(w, 'var before = COLS; importLevelText("{这不是 json", "坏文件"); (COLS === before) + "/" + document.getElementById("cfgNote").textContent'); });
    step('preset-guest-readonly', function () { return ev(w, 'netRole = "guest"; syncCfgPanel(); ["cfgPresetSel", "cfgPresetSaveBtn", "cfgLevelUpBtn", "cfgLevelDownBtn"].map(function (i) { return document.getElementById(i).disabled ? "禁" : "可"; }).join("/") + " / 下拉有 " + document.getElementById("cfgPresetSel").options.length + " 项";'); });

    // 关卡短码：人可读前缀 + 指纹 + 两种载荷（紧凑 / 汉字）
    step('code-compact-roundtrip', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); applyPresetCfg(LEVEL_PRESETS[3].cfg, "x"); levelCfg.name = "练习场"; var code = levelCode("compact"); var got = decodeLevelCode(code); var ok = (got.cfg.cols + "x" + got.cfg.rows === "30x20") && got.cfg.enemies === false && got.cfg.stepMs === 300 && got.cfg.name === "练习场"; ok + "/" + got.fpOk + "/ 长度 " + code.length + "/ 前缀 " + code.slice(0, 12);'); });
    step('code-hz-all-chinese', function () { return ev(w, 'applyPresetCfg(LEVEL_PRESETS[4].cfg, "x"); var code = levelCode("hz"); var payload = code.split("#")[4]; var got = decodeLevelCode(code); var allHz = /^[\u4e00-\u9fff]+$/.test(payload); allHz + "/" + got.fpOk + "/" + got.cfg.cols + "x" + got.cfg.rows + "/ 长度 " + payload.length + "/ 样子 " + payload.slice(0, 8) + "…";'); });
    step('code-hanzi-table-256', function () { return ev(w, 'var s = {}; var dup = 0; for (var i = 0; i < HZ_TABLE.length; i++) { var c = HZ_TABLE.charAt(i); if (s[c]) dup++; s[c] = 1; } HZ_TABLE.length + " 个，重复 " + dup'); });
    step('code-paste-whole-message', function () { return ev(w, 'var code = levelCode("compact"); var chat = "看这个关卡：" + code + " 挺好玩的"; var got = decodeLevelCode(chat); (got.cfg.cols > 0) + "/" + looksLikeLevelCode(chat) + "/" + looksLikeLevelCode("随便聊聊") + "/" + extractLevelCode(chat).slice(0, 11);'); });
    step('code-fingerprint-mismatch', function () { return ev(w, 'var code = levelCode("compact"); var bad = code.replace(/·[0-9A-Z]{4}#SNK#/, "·ZZZZ#SNK#"); decodeLevelCode(bad).fpOk + "/" + decodeLevelCode(code).fpOk'); });
    step('code-broken-input', function () { return ev(w, 'function tryIt(s) { try { decodeLevelCode(s); return "过了"; } catch (e) { return e.message; } } tryIt("随便一段话") + "/" + tryIt("SNK#L1#H#我") + "/" + tryIt("SNK#L1#A#@@@@")'); });
    step('code-import-applies', function () { return ev(w, 'applyPresetCfg(LEVEL_PRESETS[1].cfg, "x"); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); var small = COLS + "x" + ROWS; importLevelCode(code); small + " -> " + COLS + "x" + ROWS + "/" + levelCfg.enemyMax;'); });
    step('code-chat-button', function () { return ev(w, 'netLeave(); toggleChat(false); chatLog.length = 0; chatVersion++; chatPush("小王", "巨幕来了 " + levelCode("hz"), false); toggleChat(true); var btn = document.querySelector("#chatList .chatImport"); (btn ? "有按钮" : "没按钮") + "/ 点它：" + (btn ? (function () { btn.click(); return COLS + "x" + ROWS + "/" + levelCfg.enemyMax; })() : "-");'); });
    step('code-guest-cannot-load', function () { return ev(w, 'netRole = "guest"; syncCfgPanel(); ["cfgCodeLoadBtn", "cfgCodeMakeBtn", "cfgCodeCopyBtn", "cfgCodeChatBtn"].map(function (i) { return document.getElementById(i).disabled ? "禁" : "可"; }).join("/");'); });

    // 新旋钮：敌人速度倍率 / 道具刷新频率，以及「高铁大陆」预设
    step('preset-rail', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); rail.name + "/" + COLS + "x" + ROWS + "/步长 " + players[0].stepMs + "/敌人速度 " + levelCfg.enemySpeed + "/道具刷新 " + levelCfg.powerGap + "/苹果 " + levelCfg.apples + "/道具同屏 " + levelCfg.i_speed_max + "+" + levelCfg.i_widen_max'); });
    step('enemy-speed-scales', function () { return ev(w, 'setCfg({ enemySpeed: 500 }); var p1 = enemyBaseStep(ENEMY_KINDS.purple); var r1 = enemyBaseStep(ENEMY_KINDS.red); setCfg({ enemySpeed: 100 }); var p2 = enemyBaseStep(ENEMY_KINDS.purple); p1 + "/" + p2 + "/ 红的更慢 " + (r1 > p1);'); });
    step('enemy-speed-live', function () { return ev(w, 'netLeave(); start(1); setCfg({ enemySpeed: 100 }); enemies = []; enemyRespawns = []; spawnEnemy(gameNow); enemies[0].kind = "purple"; enemies[0].baseStepMs = enemyBaseStep(ENEMY_KINDS.purple); enemies[0].stepMs = enemies[0].baseStepMs; var before = enemies[0].stepMs; setCfg({ enemySpeed: 500 }); before + " -> " + enemies[0].stepMs;'); });
    step('power-gap-applies', function () { return ev(w, 'setCfg({ powerGap: 100 }); players[0].alive = true; pickPowerUp(players[0], "speed", gameNow); var a = Math.round(powerRespawnAt.speed - gameNow); setCfg({ powerGap: 25 }); pickPowerUp(players[0], "speed", gameNow); var b = Math.round(powerRespawnAt.speed - gameNow); a + " -> " + b;'); });
    step('code-carries-new-fields', function () { return ev(w, 'var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); levelCfg.enemySpeed + "/" + levelCfg.powerGap + "/" + levelCfg.stepMs + "/" + COLS + "x" + ROWS;'); });

    // 加速到期 / 回血上限：都别写死成默认常量（关卡调快了、血调厚了要跟着走）
    step('boost-restores-level-speed', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ stepMs: 100 }); var p = players[0]; p.alive = true; pickPowerUp(p, "speed", gameNow); var fast = p.stepMs; var done = expirePlayerBoost(p, gameNow + 999999); fast + " -> " + p.stepMs + "/ 关卡基准 " + levelCfg.stepMs + "/ 到期了 " + done;'); });
    step('regen-caps-at-level-hp', function () { return ev(w, 'netLeave(); start(1); setCfg({ hp0: 3 }); players[0].hp = [1, 1]; enemies = []; regenHp(60); players[0].hp.join(",") + "/ 上限 " + levelCfg.hp0;'); });
    step('regen-slow-enough', function () { return ev(w, 'netLeave(); start(1); setCfg({ hp0: 2 }); players[0].hp = [0, 0]; enemies = []; regenHp(1); players[0].hp.map(function (v) { return v.toFixed(2); }).join(",");'); });

    // 每种道具单独控制：生成与否 / 刷新间隔 / 同屏上限
    step('item-per-kind-on', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ i_widen_on: false }); powerUps.widen = []; for (var i = 0; i < 5; i++) spawnPowerUp("widen"); var w1 = powerList("widen").length; setCfg({ i_widen_on: true }); for (var k = 0; k < 5; k++) spawnPowerUp("widen"); "关掉后 " + w1 + " 个 / 打开后 " + powerList("widen").length + " 个";'); });
    step('item-max-count', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; setCfg({ i_speed_on: true, i_speed_max: 3 }); start(1); var filled = powerList("speed").length; spawnPowerUp("speed"); filled + " 个 -> 再刷还是 " + powerList("speed").length + " 个（上限 " + powerMax("speed") + "）";'); });
    step('item-gap-per-kind', function () { return ev(w, 'netLeave(); start(1); setCfg({ i_speed_gap: 2000, powerGap: 50 }); pickPowerUp(players[0], "speed", gameNow); var a = Math.round(powerRespawnAt.speed - gameNow); setCfg({ i_widen_gap: 8000, powerGap: 100 }); pickPowerUp(players[0], "widen", gameNow); a + "/" + Math.round(powerRespawnAt.widen - gameNow) + "（2 秒×50% 与 8 秒×100%）";'); });
    step('item-total-switch', function () { return ev(w, 'netLeave(); start(1); powerUps.speed = []; powerUps.widen = []; setCfg({ powerups: true, i_speed_on: true, i_widen_on: true }); spawnPowerUp("speed"); spawnPowerUp("widen"); var on = powerList("speed").length + "/" + powerList("widen").length; setCfg({ powerups: false }); spawnPowerUp("speed"); spawnPowerUp("widen"); on + " -> " + powerList("speed").length + "/" + powerList("widen").length;'); });
    step('item-snapshot-multi', function () { return ev(w, 'netLeave(); start(1); powerUps.speed = [{ x: 2, y: 2 }, { x: 5, y: 5 }]; powerUps.widen = [{ x: 7, y: 3 }]; var m = netSnapshot(); netRole = "guest"; netSeat = 2; netApplySnapshot(m); powerUps.speed.length + "/" + powerUps.speed[1].x + "/" + powerUps.widen.length + "/" + powerUps.widen[0].y;'); });
    step('item-codec-roundtrip', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ i_speed_on: false, i_speed_gap: 3000, i_speed_max: 4, i_widen_on: true, i_widen_gap: 9000, i_widen_max: 2 }); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); [levelCfg.i_speed_on, levelCfg.i_speed_gap, levelCfg.i_speed_max, levelCfg.i_widen_on, levelCfg.i_widen_gap, levelCfg.i_widen_max].join("/");'); });
    step('item-import-clamps', function () { return ev(w, 'importLevelText(JSON.stringify({ cfg: { i_speed_max: 99, i_widen_gap: -5, i_speed_on: "no" } })); levelCfg.i_speed_max + "/" + levelCfg.i_widen_gap + "/" + levelCfg.i_speed_on;'); });

    // 开始页上的关卡摘要
    step('level-info-default', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; resetLevelCfg(); syncCfgPanel(); var t = document.getElementById("levelInfo").textContent; (t.indexOf("场地 15×15") >= 0) + "/" + (t.indexOf("改过") < 0) + " / " + t.slice(0, 46);'); });
    step('level-info-updates', function () { return ev(w, 'applyPresetCfg(LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0].cfg, "x"); syncCfgPanel(); var t = document.getElementById("levelInfo").textContent; (t.indexOf("200×150") >= 0) + "/" + (t.indexOf("100ms") >= 0) + "/" + (t.indexOf("500% 速") >= 0) + "/" + (t.indexOf("改过") >= 0) + " / " + t;'); });
    step('level-info-both-places', function () { return ev(w, '(document.getElementById("levelInfoNet").textContent === document.getElementById("levelInfo").textContent) + "/ 长度 " + document.getElementById("levelInfo").textContent.length;'); });
    step('level-info-off-items', function () { return ev(w, 'setCfg({ enemies: false, powerups: false }); syncCfgPanel(); var t = document.getElementById("levelInfo").textContent; (t.indexOf("敌人 关") >= 0) + "/" + (t.indexOf("道具 关") >= 0) + " / " + t.slice(0, 40);'); });

    // 手机端镜头的缩放：装成粗指针调一次 updateView，验公式本身
    step('zoom-mobile-floor', function () { return ev(w, 'netLeave(); var mm = window.matchMedia; window.matchMedia = function (q) { return { matches: q.indexOf("coarse") >= 0 }; }; levelCfg.cols = 0; levelCfg.rows = 0; start(1); setArenaSize(200, 150, gameNow); widenStartAt = 0; resizeCanvas(); var big = zoom; setArenaSize(15, 15, gameNow); widenStartAt = 0; resizeCanvas(); var small = zoom; window.matchMedia = mm; "大地图 " + big + "/小地图 " + small + "/ 下限 " + MOBILE_ZOOM_MIN;'); });
    step('zoom-shows-2.5x', function () { return ev(w, 'netLeave(); var mm = window.matchMedia; window.matchMedia = function (q) { return { matches: q.indexOf("coarse") >= 0 }; }; start(1); setArenaSize(200, 150, gameNow); widenStartAt = 0; resizeCanvas(); var r = Math.round((viewWorldW() / VIEW_W) * 100) / 100; var cells = Math.round(viewWorldW() / CELL); var plain = Math.round(VIEW_W / CELL); window.matchMedia = mm; "放大倍数 " + r + " / 一屏 " + cells + " 格（1:1 时 " + plain + " 格）";'); });
    step('zoom-draw-matches', function () { return ev(w, 'netLeave(); start(1); setArenaSize(60, 40, gameNow); widenStartAt = 0; resizeCanvas(); players[0].body[0].x = 30; players[0].body[0].y = 20; camReady = false; updateCamera(); var z0 = zoom; zoom = 0.4; render(); var px = ctx.getImageData(Math.round((cxOf(players[0].body[0]) - 5) * zoom * dpr), Math.round(cyOf(players[0].body[0]) * zoom * dpr), 1, 1).data; zoom = z0; "缩放到 0.4 后蛇头位置取到 " + px[0] + "," + px[1] + "," + px[2];'); });
    step('zoom-restore', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); resizeCanvas(); Math.round(zoom * 100) / 100 + "/" + VIEW_W + "x" + VIEW_H;'); });

    // 高铁大陆的道具量：每种同屏 4 个（原来是 1 个）
    step('rail-items-4x', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); widenStartAt = 0; resizeCanvas(); reset(); var sp = powerList("speed").length; var wd = powerList("widen").length; sp + "+" + wd + " 个（以前 1+1）/ 间隔 " + powerGapMs("speed") + "ms、" + powerGapMs("widen") + "ms";'); });
    step('rail-items-cap', function () { return ev(w, 'for (var i = 0; i < 10; i++) { spawnPowerUp("speed"); spawnPowerUp("widen"); } powerList("speed").length + "+" + powerList("widen").length + " / 上限 " + powerMax("speed") + "+" + powerMax("widen");'); });
    step('rail-items-respawn', function () { return ev(w, 'var p = players[0]; p.alive = true; var target = powerList("speed")[0]; p.body[0].x = target.x; p.body[0].y = target.y; pickPowerUp(p, "speed", gameNow); powerList("speed").length + " 个（吃掉一个）/ 下次刷新 " + (powerRespawnAt.speed - gameNow) + "ms 后";'); });

    report.phases.seats = {
        maxPlayers: ev(w, 'MAX_PLAYERS'),
        wanted: ev(w, 'netWantedPlayers()'),
        roster: ev(w, 'netRosterText()'),
        spectating: ev(w, 'netSpectating()')
    };
    flush();
    document.title = 'PROBE_DONE';
}
</script>
</body></html>
`;

// ------------------------------ 3. 跑起来 ------------------------------
const names = collectNames();
console.log('[probe] 顶层声明 ' + names.length + ' 个，开始/跑一遍页面…');
execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { stdio: 'inherit' });

const probePath = join(DIST, '_probe.html');
writeFileSync(probePath, PROBE.replace('__NAMES__', JSON.stringify(names)), 'utf8');

// 先只查语法：探针本身写错了（比如括号手滑）不该等到浏览器里才发现
const i0 = PROBE.indexOf('<script>'), i1 = PROBE.indexOf('</script>', i0);
const probeJs = join(DIST, '_probe.js');
writeFileSync(probeJs, PROBE.slice(i0 + 8, i1), 'utf8');
try {
    execFileSync(process.execPath, ['--check', probeJs], { stdio: 'pipe' });
} catch (e) {
    console.error('[probe] 探针脚本语法错误：\n' + String(e.stderr || e.message));
    process.exit(1);
}

// 服务器就在本进程里（import 进来），不是子进程 —— 子进程那套收尾时
// 会在 Windows 上崩在 libuv 的断言里。close() 是正常的关监听，没有这个坑。
const http = startServer(PORT, DIST);
let done = false;
async function stopServer() {
    if (done) return;
    done = true;
    try { await http.close(); } catch (e) { }
}
process.on('SIGINT', function () { stopServer().then(function () { process.exit(130); }); });

async function main() {
    await http.listening;
    // 必须异步等它跑完：execFileSync 会把事件循环堵住，浏览器 POST 回传的结果
    // 就一直排在队列里没人接（浏览器一关，连接就断了 -> 「没收到探针结果」）。
    await new Promise(function (resolve, reject) {
        const smoke = spawn(process.execPath, [
            join(root, 'scripts', 'smoke.mjs'), '_probe.html',
            '--wait', String(WAIT), '--base', BASE,
        ], { stdio: 'inherit' });
        smoke.on('exit', resolve);
        smoke.on('error', reject);
    });

    let rep = null;
    try {
        const res = await fetch(BASE + '/__probe');
        if (res.status === 200) rep = JSON.parse(await res.text());
    } catch (e) { /* 下面统一报 */ }

    if (!rep) {
        console.error('[probe] 没收到探针结果（页面可能根本没跑起来）');
        await stopServer();
        process.exit(1);
    }
    const failed = rep.steps.filter(function (s) { return !s.ok; });
    console.log('');
    console.log('[probe] 全局符号 ' + (rep.globals.expected - rep.globals.missing.length) + '/' + rep.globals.expected +
        '，步骤 ' + (rep.steps.length - failed.length) + '/' + rep.steps.length +
        '，页面错误 ' + rep.errs.length);
    if (rep.globals.missing.length) console.log('[probe] 找不到的符号: ' + rep.globals.missing.join(', '));
    for (const s of rep.steps) console.log((s.ok ? '  ok   ' : '  FAIL ') + s.n + ': ' + (s.ok ? JSON.stringify(s.v) : 'ERR ' + s.e));
    for (const e of rep.errs) console.log('  ERR  [' + e.phase + '] ' + e.msg + (e.stack ? '\n       ' + e.stack : ''));
    console.log('[probe] 状态: ' + JSON.stringify(rep.phases));
    const bad = rep.globals.missing.length + failed.length + rep.errs.length;
    console.log(bad ? '[probe] 有 ' + bad + ' 处问题' : '[probe] 全部通过');
    await stopServer();
    process.exitCode = bad ? 1 : 0;
}

main().catch(async function (e) {
    console.error('[probe] ' + (e && e.message));
    await stopServer();
    process.exitCode = 1;
});
