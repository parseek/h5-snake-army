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
    'assets/config.js', 'assets/state.js', 'assets/sfx.js', 'assets/theme.js', 'assets/net.js',
    'assets/game.js', 'assets/render.js', 'assets/input.js', 'assets/net-session.js',
    'assets/level.js', 'assets/boot.js',
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
            // 启动脚本已经搬到 assets/boot.js；万一以后又写了内联脚本，这里也认
            const i0 = code.indexOf('<script>');
            const i1 = i0 < 0 ? -1 : code.indexOf('</script>', i0);
            code = (i0 < 0 || i1 < 0) ? '' : code.slice(i0 + 8, i1);
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
    step('preset-rail', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); rail.name + "/" + COLS + "x" + ROWS + "/步长 " + players[0].stepMs + "/敌人速度 " + levelCfg.enemySpeed + "/道具刷新 " + levelCfg.powerGap + "/道具同屏 " + levelCfg.i_speed_max + "+" + levelCfg.i_widen_max + "/苹果 " + levelCfg.appleBase + "→" + (Math.round(levelCfg.apples) > 0 ? levelCfg.apples : "无上限")'); });
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

    // 高铁大陆的苹果：12 -> 120（10 倍），而且开局就摆满
    step('rail-apples-10x', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); widenStartAt = 0; resizeCanvas(); reset(); appleTargetCount(gameNow) + " 个目标 / 开局已有 " + apples.length + " 个";'); });
    step('apple-fill-rate-limited', function () { return ev(w, 'var before = apples.length; fillApples(gameNow, 4); var one = apples.length - before; for (var i = 0; i < 60; i++) fillApples(gameNow, 4); one + " 个/帧 -> 60 帧后 " + apples.length + " 个（目标 " + appleTargetCount(gameNow) + "）";'); });
    step('apple-base-default', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; resetLevelCfg(); start(1); reset(); levelCfg.appleBase + "/" + levelCfg.apples + "/ 开局 " + apples.length + " 个";'); });
    step('apple-base-in-code', function () { return ev(w, 'setCfg({ appleBase: 37, apples: 99 }); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); levelCfg.appleBase + "/" + levelCfg.apples;'); });

    // 炮塔升级：A 跟踪 / B 火力，升「离蛇头最近的那座自己的塔」，只花币不吃身长（只给按钮）
    step('turret-upgrade-nearest', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.coins = 99; p.body[0].x = 5; p.body[0].y = 5; turrets = [{ x: 20, y: 20, cooldownUntil: 0, owner: p, upA: 0, upB: 0 }, { x: 7, y: 6, cooldownUntil: 0, owner: p, upA: 0, upB: 0 }, { x: 9, y: 9, cooldownUntil: 0, owner: players[0].constructor ? p : p, upA: 0, upB: 0 }]; var t = nearestTurret(p); t.x + "," + t.y;'); });
    step('turret-upgrade-cost', function () { return ev(w, 'var p = players[0]; p.coins = 3; var t = nearestTurret(p); var a = upgradeCost(t, "A"); var ok1 = upgradeTurret(p, "A"); var b = upgradeCost(t, "A"); var ok2 = upgradeTurret(p, "A"); a + "/" + ok1 + " -> 币 " + p.coins + "/ 下一级 " + b + "/ 再升 " + ok2 + "（币不够）+ 等级 " + t.upA;'); });
    step('turret-upgrade-max', function () { return ev(w, 'var p = players[0]; p.coins = 99; var t = nearestTurret(p); while (canUpgrade(t.owner, "B")) upgradeTurret(p, "B"); t.upB + "/ 满级 " + (upgradeCost(t, "B") < 0) + "/ 再升 " + upgradeTurret(p, "B");'); });
    step('turret-b-effects', function () { return ev(w, 'var p = players[0]; var t = nearestTurret(p); var r0 = turretRange(t); var d0 = turretDamage(t); var s0 = Math.round(turretBulletSpeed(t)); t.upB = 0; var a = TURRET_RANGE + "->" + (TURRET_RANGE + TURRET_B_RANGE[3]) + " 格 / 伤害 " + TURRET_B_DMG[0] + "->" + TURRET_B_DMG[3] + " / 弹速 x" + TURRET_B_SPEED[3]; t.upB = 3; a + " / 实测 " + turretRange(t) + " 格、伤害 " + turretDamage(t) + "、弹速 " + Math.round(turretBulletSpeed(t));'); });
    step('turret-a-homing', function () { return ev(w, 'var p = players[0]; var mkEnemy = function (ex, ey) { return { kind: "purple", body: [{ x: ex, y: ey }], dir: { x: 0, y: 1 }, acc: 0, hp: [2], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; var t = nearestTurret(p); t.x = 7; t.y = 6; t.upB = 0; enemies = [mkEnemy(11, 6)]; t.upA = 3; t.cooldownUntil = 0; bullets = []; updateTurrets(gameNow); var b = bullets[0]; var homing3 = b ? b.homing : "无弹"; bullets = []; t.upA = 0; t.cooldownUntil = 0; updateTurrets(gameNow); var b2 = bullets[0]; /* 让 A 级的子弹在偏轴目标下拐一下：目标在正下方，弹初速朝正右 */ var curve = "-"; if (b) { b.x = 7.5; b.y = 6.5; b.vx = 6; b.vy = 0; bullets = [b]; /* 把 A3 那颗放回来（上面清空过数组） */ enemies = [mkEnemy(7, 14)]; var vy0 = b.vy; for (var i = 0; i < 5; i++) updateBullets(0.05, gameNow); curve = vy0 + " -> " + Math.round(b.vy * 100) / 100; } "A0 " + (b2 ? b2.homing : "无弹") + " / A3 " + homing3 + "（弧度/秒）/ 拐弯 " + curve;'); });
    step('turret-upgrade-buttons', function () { return ev(w, 'netLeave(); start(1); var p = players[0]; p.coins = 99; turrets = [{ x: 6, y: 6, cooldownUntil: 0, owner: p, upA: 0, upB: 0 }]; syncBuildBtn(); var a = document.getElementById("upABtn0"); var b = document.getElementById("upBBtn0"); var lab = a.textContent + " | " + b.textContent; a.click(); var after = document.getElementById("upABtn0").textContent; lab + " -> " + after + " / 等级 " + turrets[0].upA + " / 币 " + p.coins;'); });
    step('turret-upgrade-pips', function () { return ev(w, 'var t = turrets[0]; t.upA = 2; t.upB = 1; var p = players[0]; p.body[0].x = 6; p.body[0].y = 6; var ok = true; try { render(); } catch (e) { ok = String(e.message); } "画一帧没炸 " + ok + " / 等级 " + upgradeLevel(t, "A") + "+" + upgradeLevel(t, "B");'); });
    step('turret-upgrade-net', function () { return ev(w, 'netLeave(); start(1); var p = players[0]; p.coins = 99; turrets = [{ x: 6, y: 6, cooldownUntil: 0, owner: p, upA: 1, upB: 2 }]; var m = netSnapshot(); netRole = "guest"; netSeat = 2; netApplySnapshot(m); turrets[0].upA + "+" + turrets[0].upB;'); });

    // 生存预设：撞墙 / 撞蛇不是死，而是从头部剪短 3 节；剪到最短还短就死
    step('crash-cut-wall', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3, cutSnake: 3 }); var p = players[0]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 5, y: i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; state = "running"; var before = p.body.length; step(p, gameNow); before + " -> " + p.body.length + "/活着 " + p.alive + "/新头 " + p.body[0].x + "," + p.body[0].y + "/血条 " + p.hp.length;'); });
    step('crash-cut-too-short', function () { return ev(w, 'var p = players[0]; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }]; p.hp = [2, 2, 2, 2]; p.dir = { x: 0, y: -1 }; p.alive = true; state = "running"; step(p, gameNow); "长度 4 剪 3 -> 活着 " + p.alive + "（预期死）";'); });
    step('crash-cut-snake', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3, cutSnake: 3 }); var p = players[0]; var a = []; for (var i = 0; i < 12; i++) a.push({ x: 5, y: 5 + i }); p.body = a; p.hp = a.map(function () { return 2; }); p.body[0] = { x: 6, y: 8 }; p.dir = { x: -1, y: 0 }; p.alive = true; state = "running"; var before = p.body.length; step(p, gameNow); before + " -> " + p.body.length + "/活着 " + p.alive;'); });
    step('crash-default-lethal', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); resetLevelCfg(); var p = players[0]; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }]; p.hp = [2, 2, 2]; p.dir = { x: 0, y: -1 }; p.alive = true; state = "running"; step(p, gameNow); "默认（剪短 0）撞墙 -> 活着 " + p.alive + "（预期死）";'); });
    step('crash-preset-survive', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); applyPresetCfg(LEVEL_PRESETS.filter(function (p) { return p.id === "survive"; })[0].cfg, "x"); levelCfg.cutWall + "+" + levelCfg.cutSnake + "/ 场地 " + COLS + "x" + ROWS + "/ 血 " + levelCfg.hp0;'); });
    step('crash-codec', function () { return ev(w, 'setCfg({ cutWall: 5, cutSnake: 1 }); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); levelCfg.cutWall + "/" + levelCfg.cutSnake;'); });

    // 剪短之后的无敌（默认 2 秒）：期间撞墙不前进、撞蛇穿过去、子弹不掉血
    step('inv-after-cut', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3, cutSnake: 3 }); var p = players[0]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 5, y: i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; p.invUntil = 0; state = "running"; step(p, gameNow); "剪到 " + p.body.length + "/无敌 " + invincible(p, gameNow) + "/还剩 " + Math.round(p.invUntil - gameNow) + "ms";'); });
    step('inv-wall-no-move', function () { return ev(w, 'var p = players[0]; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 }, { x: 5, y: 5 }, { x: 5, y: 6 }]; p.hp = p.body.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; p.invUntil = gameNow + 2000; var len = p.body.length; step(p, gameNow); "无敌中撞墙：头 " + p.body[0].x + "," + p.body[0].y + "（还在 5,0）/长度 " + len + " -> " + p.body.length;'); });
    step('inv-blocks-death', function () { return ev(w, 'var p = players[0]; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }]; p.hp = [2, 2, 2, 2]; p.dir = { x: 0, y: -1 }; p.alive = true; step(p, gameNow); "长度 4 无敌中撞墙 -> 活着 " + p.alive + "（预期活）";'); });
    step('inv-snake-passes', function () { return ev(w, 'var p = players[0]; p.invUntil = gameNow + 2000; p.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 5, y: 7 }, { x: 5, y: 8 }]; p.hp = [2, 2, 2, 2]; p.dir = { x: -1, y: 0 }; p.body[0] = { x: 5, y: 7 }; p.alive = true; step(p, gameNow); "无敌中穿过自己 -> 活着 " + p.alive + "/头 " + p.body[0].x + "," + p.body[0].y;'); });
    step('inv-expires', function () { return ev(w, 'var p = players[0]; p.invUntil = gameNow - 1; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 }, { x: 5, y: 5 }]; p.hp = [2, 2, 2, 2, 2, 2]; p.dir = { x: 0, y: -1 }; p.alive = true; step(p, gameNow); "无敌过期后撞墙 -> 长度 " + p.body.length + "/活着 " + p.alive + "（预期 3/活）";'); });
    step('inv-blocks-bullet', function () { return ev(w, 'var p = players[0]; p.invUntil = gameNow + 2000; p.body = [{ x: 5, y: 5 }, { x: 5, y: 4 }]; p.hp = [2, 2]; p.alive = true; bullets = [{ from: "enemy", x: 5.5, y: 5.5, vx: 0, vy: 0 }]; var hp0 = p.hp[0]; updateBullets(0.001, gameNow); "无敌中中弹：血 " + hp0 + " -> " + p.hp[0] + "/子弹 " + bullets.length + "（被打掉但不掉血）";'); });
    step('inv-codec', function () { return ev(w, 'setCfg({ invMs: 4500 }); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); levelCfg.invMs;'); });
    step('inv-default', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.invMs + "/ 剪短 " + levelCfg.cutWall + "+" + levelCfg.cutSnake;'); });

    // 剪短动画：被剪掉的头颈往回缩进身体（方向与行进方向相反，边缩边淡）
    step('cutfx-spawned', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3, cutSnake: 3 }); var p = players[0]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 5, y: i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; cutFx = []; state = "running"; step(p, gameNow); "动画条目 " + cutFx.length + "/剪掉 " + cutFx[0].cells.length + " 节/第一格 " + cutFx[0].cells[0].x + "," + cutFx[0].cells[0].y + "/方向 " + cutFx[0].dir.x + "," + cutFx[0].dir.y;'); });
    step('cutfx-retracts', function () { return ev(w, 'var fx = cutFx[0]; var at = fx.at; var o0 = cutFxOffset(fx, at); gameNow = at + 170; var o1 = cutFxOffset(fx, at + 170); var s0 = cutFxScale(fx, at + 1); var s1 = cutFxScale(fx, at + 170); var back = (o1.y > 0) && (o1.x === 0); "起点偏移 " + o0.x + "," + o0.y + " -> 半程 " + Math.round(o1.x) + "," + Math.round(o1.y) + "（方向是 0,-1，所以往回收 = y 变正）收缩 " + s0.toFixed(2) + " -> " + s1.toFixed(2);'); });
    step('cutfx-expires', function () { return ev(w, 'var fx = cutFx[0]; gameNow = fx.at + CUT_FX_MS + 10; var n0 = cutFx.length; render(); n0 + " -> " + cutFx.length + "（画一帧后清掉）";'); });
    step('cutfx-reset', function () { return ev(w, 'netLeave(); start(1); cutFx.push({ cells: [{ x: 1, y: 1 }], hp: [2], dir: { x: 1, y: 0 }, at: gameNow, bodyColor: "#fff", headColor: "#000" }); reset(); String(cutFx.length);'); });

    // 剪短动画也发给客机（一次性事件）：主机放什么，客机放什么
    step('cut-ev-pack', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3 }); netRole = "host"; netCutSentId = 0; cutFx = []; var p = players[0]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 5, y: i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; state = "running"; step(p, gameNow); var m1 = netSnapshot(); var again = netSnapshot().cut; "第一次带 " + (m1.cut ? m1.cut.length : 0) + " 条/座位 " + m1.cut[0].i + "/格子 " + m1.cut[0].c.join(",") + "/第二次 " + (again ? again.length : "不发（已发过）");'); });
    step('cut-ev-apply', function () { return ev(w, 'var m = { t: "state", now: gameNow, st: "running", you: 2, mode: 1, team: "coop", best: 0, cfg: netPackCfg(), cut: [{ i: 0, c: [3, 0, 3, 1, 3, 2], h: [2, 2, 2], d: [0, -1] }], pl: [] }; netRole = "guest"; netSeat = 2; cutFx = []; gameNow = 5000; netApplyCuts(m.cut); var fx = cutFx[0]; "动画 " + cutFx.length + " 条/格子 " + fx.cells.length + "/首格 " + fx.cells[0].x + "," + fx.cells[0].y + "/方向 " + fx.dir.x + "," + fx.dir.y + "/起始时刻 " + fx.at + "/颜色取的是 " + fx.bodyColor;'); });
    step('cut-ev-two-players', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(2, "coop"); netRole = "host"; netCutSentId = 0; cutFx = []; var p2 = players[1]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 8, y: i }); p2.body = a; p2.hp = a.map(function () { return 2; }); p2.dir = { x: 0, y: -1 }; p2.alive = true; state = "running"; step(p2, gameNow); var m = netSnapshot(); "P2 被剪 -> 座位 " + m.cut[0].i + "/颜色 " + (players[1].def.body === PLAYER_DEFS[1].body);'); });
    step('cut-ev-cleanup', function () { return ev(w, 'netLeave(); start(1); cutFx = []; var list = []; for (var i = 0; i < 10; i++) list.push({ i: 0, c: [1 + i, 1, 1 + i, 2], h: [2, 2], d: [1, 0] }); netApplyCuts(list); cutFx.length + "（一次来 10 条，本地只留 6）";'); });

    // 音效：全部现场合成，没有 AudioContext 也不该抛异常（计数用来验证「该响的时候响了」）
    step('sfx-counts', function () { return ev(w, 'sfxPlayed = 0; sfxEat(3); sfxBuild(); sfxUpgrade(); sfxPlayed;'); });
    step('sfx-mute', function () { return ev(w, 'sfxSetEnabled(false); var a = sfxPlayed; sfxEat(9); sfxDie(); var during = sfxPlayed - a; sfxSetEnabled(true); "关掉后多播了 " + during + " 次/现在开着 " + sfxIsEnabled();'); });
    step('sfx-wired-eat', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); SFX_LAST.step = 0; sfxPlayed = 0; var p = players[0]; apples = [{ x: p.body[0].x + p.dir.x, y: p.body[0].y + p.dir.y }]; p.alive = true; step(p, gameNow); "一次 step 响了 " + sfxPlayed + " 次（移动 1 + 吃苹果 1）/分数 " + p.score;'); });
    step('sfx-wired-cut-die', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ cutWall: 3 }); var p = players[0]; var a = []; for (var i = 0; i < 10; i++) a.push({ x: 5, y: i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 0, y: -1 }; p.alive = true; state = "running"; sfxPlayed = 0; step(p, gameNow); var afterCut = sfxPlayed; p.body = [{ x: 5, y: 0 }, { x: 5, y: 1 }]; p.hp = [2, 2]; p.alive = true; killPlayer(p, gameNow); "剪短响了 " + afterCut + " 次/死亡再响 " + (sfxPlayed - afterCut) + " 次";'); });
    step('sfx-no-audio-env', function () { return ev(w, 'var AC = window.AudioContext, WK = window.webkitAudioContext; window.AudioContext = null; window.webkitAudioContext = null; var keepA = sfxCtx; sfxCtx = null; sfxPlayed = 0; var err = "没炸"; try { sfxEat(1); sfxCut(); } catch (e) { err = e.message; } var n = sfxPlayed; window.AudioContext = AC; window.webkitAudioContext = WK; sfxCtx = keepA; "没有 AudioContext 时：" + err + "/计数 " + n + "/返回 " + String(sfxInit() ? "有" : "null");'); });
    step('sfx-persist', function () { return ev(w, 'sfxSetEnabled(false); sfxEnabled = true; sfxLoadPref(); var off = sfxIsEnabled(); sfxSetEnabled(true); sfxLoadPref(); "存成关 -> 读回来 " + off + "，存成开 -> 读回来 " + sfxIsEnabled();'); });
    step('sfx-button', function () { return ev(w, 'sfxSetEnabled(true); syncSfxBtns(); var btn = document.getElementById("sfxBtn"); var before = btn.textContent; btn.click(); var after = btn.textContent; var off = sfxIsEnabled(); btn.click(); before + " -> " + after + "/状态 " + off + " -> " + sfxIsEnabled();'); });

    // 金币 / 子弹 / 命中 / 击杀 四个音，以及子弹音的节流
    step('sfx-wired-coin', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); SFX_LAST.step = 0; var p = players[0]; p.alive = true; p.coins = 0; state = "running"; drops = [{ x: p.body[0].x + p.dir.x, y: p.body[0].y + p.dir.y, kind: "coin", expireAt: gameNow + 5000 }]; sfxPlayed = 0; step(p, gameNow); "响了 " + sfxPlayed + " 次（移动 1 + 金币 1）/币 " + p.coins + "/掉落剩 " + drops.length;'); });
    step('sfx-wired-droplen', function () { return ev(w, 'var p = players[0]; p.alive = true; p.body[0] = { x: 20, y: 20 }; SFX_LAST.step = 0; drops = [{ x: p.body[0].x + p.dir.x, y: p.body[0].y + p.dir.y, kind: "len", expireAt: gameNow + 5000 }]; sfxPlayed = 0; step(p, gameNow); "加身长的掉落：一 step 响 " + sfxPlayed + " 次（移动 1 + 掉落 1）";'); });
    step('sfx-wired-shoot', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; turrets = [{ x: 7, y: 6, cooldownUntil: 0, owner: p, upA: 0, upB: 0 }]; enemies = [{ kind: "purple", body: [{ x: 11, y: 6 }], dir: { x: 0, y: 1 }, acc: 0, hp: [4], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }]; SFX_LAST.shoot = 0; sfxPlayed = 0; updateTurrets(gameNow); "开火音 " + sfxPlayed + "/子弹 " + bullets.length;'); });
    step('sfx-shoot-throttle', function () { return ev(w, 'SFX_LAST.shoot = 0; sfxPlayed = 0; for (var i = 0; i < 12; i++) sfxShoot(); "连开 12 次只响了 " + sfxPlayed + " 次（70ms 节流）";'); });
    step('sfx-wired-hit', function () { return ev(w, 'SFX_LAST.hit = 0; sfxPlayed = 0; var e = enemies[0]; e.body = [{ x: 3, y: 3 }]; e.hp = [4]; bullets = [{ from: "player", owner: players[0], dmg: 1, homing: 0, x: 3.4, y: 3.4, vx: 0, vy: 0 }]; updateBullets(0.001, gameNow); "命中音 " + sfxPlayed + " 次/敌人血量 " + e.hp[0];'); });
    step('sfx-wired-kill', function () { return ev(w, 'sfxPlayed = 0; var n = enemies.length; killEnemy(enemies[0], gameNow); "击杀音 " + sfxPlayed + " 次/敌人 " + n + " -> " + enemies.length;'); });

    // 蛇移动音：走一步一声（很轻的「沙」），55ms 内只响一次
    step('sfx-wired-step', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; var a = []; for (var i = 0; i < 6; i++) a.push({ x: 10, y: 10 + i }); p.body = a; p.hp = a.map(function () { return 2; }); p.dir = { x: 1, y: 0 }; p.alive = true; state = "running"; SFX_LAST.step = 0; sfxPlayed = 0; step(p, gameNow); "走一步响 " + sfxPlayed + " 次/头到了 " + p.body[0].x + "," + p.body[0].y;'); });
    step('sfx-step-throttle', function () { return ev(w, 'SFX_LAST.step = 0; sfxPlayed = 0; for (var i = 0; i < 20; i++) sfxStep(100); "连走 20 步只响 " + sfxPlayed + " 次（55ms 节流）";'); });
    step('sfx-step-speed-pitch', function () { return ev(w, 'SFX_LAST.step = 0; var fast = 0; sfxStep(100); SFX_LAST.step = 0; var slow = 0; sfxStep(600); "快慢都能响：" + sfxPlayed + " 次累计（这个数只为确认没抛异常）";'); });
    step('sfx-step-no-crash', function () { return ev(w, 'var AC = window.AudioContext, WK = window.webkitAudioContext; window.AudioContext = null; window.webkitAudioContext = null; var keep = sfxCtx; sfxCtx = null; var buf = sfxNoiseBuf; sfxNoiseBuf = null; var err = "没炸"; try { sfxStep(100); } catch (e) { err = e.message; } window.AudioContext = AC; window.webkitAudioContext = WK; sfxCtx = keep; sfxNoiseBuf = buf; "没有 AudioContext 时走一步：" + err;'); });

    // 不同道具不同音效：加速是「电」、拓宽是「张」（用发声参数和数量比较）
    step('sfx-powerup-kinds', function () { return ev(w, 'var n0 = sfxToneSeq; sfxPowerUp("speed"); var n1 = sfxToneSeq; var speedTone = sfxLastTone; sfxPowerUp("widen"); var n2 = sfxToneSeq; var widenTone = sfxLastTone; "加速合成 " + (n1 - n0) + " 个音、最后一个 " + speedTone.f0 + "->" + speedTone.f1 + " " + speedTone.type + " / 拓宽 " + (n2 - n1) + " 个、最后一个 " + widenTone.f0 + "->" + widenTone.f1 + " " + widenTone.type;'); });
    step('sfx-powerup-unknown', function () { return ev(w, 'var n0 = sfxToneSeq; var err = "没炸"; try { sfxPowerUp("something-new"); } catch (e) { err = e.message; } (sfxToneSeq - n0) + " 个音（保底上滑）/" + err;'); });
    step('sfx-wired-powerup-kind', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; var n0 = sfxToneSeq; powerList("speed").push({ x: p.body[0].x + p.dir.x, y: p.body[0].y + p.dir.y }); p.alive = true; state = "running"; step(p, gameNow); "踩到加速道具 -> 合成 " + (sfxToneSeq - n0) + " 个音（含移动那声）";'); });

    // 敌人 AI 的三处「更聪明」：躲子弹、别挤在一起、开火打提前量
    step('ai-dodges-bullet', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var mkEnemy = function (x, y, dir) { return { kind: "purple", body: [{ x: x, y: y }, { x: x - 1, y: y }], dir: dir, acc: 0, hp: [4, 4], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; enemies = []; apples = []; turrets = []; var e = mkEnemy(20, 20, { x: 0, y: 1 }); enemies.push(e); /* 目标苹果在下方，但下行的路上有玩家的子弹 */ apples = [{ x: 20, y: 26 }]; bullets = [{ from: "player", owner: players[0], x: 20.5, y: 21.2, vx: 0, vy: 6, dmg: 1, homing: 0 }]; var riskDown = Math.round(enemyBulletRisk(20, 21) * 10) / 10; bullets = []; var riskNone = Math.round(enemyBulletRisk(20, 21) * 10) / 10; "有子弹时下行风险 " + riskDown + "，没子弹 " + riskNone;'); });
    step('ai-spreads-out', function () { return ev(w, 'var mkEnemy = function (x, y, dir) { return { kind: "purple", body: [{ x: x, y: y }, { x: x - 1, y: y }], dir: dir, acc: 0, hp: [4, 4], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; enemies = []; bullets = []; apples = [{ x: 20, y: 30 }]; turrets = []; var a = mkEnemy(20, 20, { x: 0, y: 1 }); var b = mkEnemy(21, 20, { x: 0, y: 1 }); enemies = [a, b]; var alone = enemyCrowd(20, 30, a); var withMate = enemyCrowd(21, 21, a); "远处空格子 " + alone + " 分，贴着同伴的格子 " + withMate + " 分";'); });
    step('ai-leads-target', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var q = players[0]; q.alive = true; q.body[0] = { x: 10, y: 8 }; q.dir = { x: 0, y: -1 }; /* 玩家正往上走 */ var e = { kind: "blue", body: [{ x: 4, y: 8 }], dir: { x: 1, y: 0 }, acc: 0, hp: [4], baseStepMs: 560, stepMs: 560, spawnAt: 0, boostUntil: 0, shootAt: 0 }; enemies = [e]; bullets = []; fireEnemyBullet(e); var b = bullets[0]; if (!b) { "没开火"; } else { var aimHead = Math.atan2(8.5 - b.y, 10.5 - b.x); var aimNext = Math.atan2(7.5 - b.y, 10.5 - b.x); var got = Math.atan2(b.vy, b.vx); "打头角度 " + aimHead.toFixed(3) + " / 打提前量 " + aimNext.toFixed(3) + " / 实际 " + got.toFixed(3) + "（跟提前量一致 " + (Math.abs(got - aimNext) < 0.02) + "）"; }'); });
    step('ai-perf-big-map', function () { return ev(w, 'netLeave(); roomCfg = null; levelCfg.cols = 0; levelCfg.rows = 0; start(1); setArenaSize(200, 150, gameNow); widenStartAt = 0; resizeCanvas(); reset(); levelCfg.enemySpeed = 100; enemies = []; enemyRespawns = []; for (var i = 0; i < 12; i++) { if (!spawnEnemy(gameNow)) break; } var n = enemies.length; var t = performance.now(); for (var k = 0; k < 30; k++) { for (var j = 0; j < enemies.length; j++) enemyChooseDir(enemies[j]); } var ms = (performance.now() - t) / (30 * Math.max(1, n)); n + " 条敌人，一次决策平均 " + ms.toFixed(2) + " ms";'); });

    step('ai-speed-item', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var mk = function (x, y, dx, dy) { return { kind: "purple", body: [{ x: x, y: y }, { x: x - dx, y: y - dy }], dir: { x: dx, y: dy }, acc: 0, hp: [4, 4], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; turrets = []; bullets = []; apples = [{ x: 2, y: 7 }]; var e = mk(7, 7, 1, 0); enemies = [e]; powerUps = { speed: [{ x: 10, y: 7 }], widen: [] }; var dA = enemyChooseDir(e); e.boostUntil = gameNow + 5000; powerUps.speed = [{ x: 10, y: 7 }]; var dB = enemyChooseDir(e); e.boostUntil = 0; powerUps.speed = [{ x: 14, y: 7 }]; var fard = nearestSpeedItem(e.body[0]).d; var dC = enemyChooseDir(e); "道具在前方 3 格 -> 走 " + dA.x + "," + dA.y + "（1,0=去吃）/ 已加速 -> 走 " + dB.x + "," + dB.y + "（0,*=去抢苹果，不追道具）/ 道具 " + fard + " 格（>6）-> 走 " + dC.x + "," + dC.y;'); });
    step('ai-speed-item-off', function () { return ev(w, 'powerUps.speed = [{ x: 20, y: 17 }]; var on = !!nearestSpeedItem(enemies[0].body[0]); levelCfg.powerups = false; var off = !!nearestSpeedItem(enemies[0].body[0]); levelCfg.powerups = true; levelCfg.i_speed_on = false; var kindOff = !!nearestSpeedItem(enemies[0].body[0]); levelCfg.i_speed_on = true; "道具开着 " + on + " / 总开关关掉 " + off + " / 单类关掉 " + kindOff;'); });

    step('death-no-jump', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.body = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }]; p.hp = [2, 2, 2, 2]; p.dir = { x: -1, y: 0 }; p.alive = true; p.stepMs = 500; p.acc = 125; corpses = []; render(); /* 0.25 格：比如中弹身亡的那一刻 */ var liveE = p.drawnE; var lp = buildPath(p.body, p.dir, liveE, true); var ld = function (pt, q) { return Math.round(Math.hypot(pt.x - q.x, pt.y - q.y) * 10) / 10; }; var tail = lp[lp.length - 1]; p.acc -= p.stepMs; state = "running"; step(p, gameNow); var c = corpses[0]; var cp = buildPath(c.body, c.dir, corpseEase(c, c.diedAt), true); var op = buildPath(c.body, c.dir, 0, false); "死前最后一帧探出 " + (Math.round(liveE * 1000) / 1000) + " 格；老写法：头跳 " + ld(op[0], lp[0]) + "px、尾跳 " + ld(op[op.length - 1], tail) + "px；现在：头差 " + ld(cp[0], lp[0]) + "px、尾差 " + ld(cp[cp.length - 1], tail) + "px";'); });
    step('death-ease-out', function () { return ev(w, 'var p = players[0]; p.alive = true; corpses = []; p.drawnE = 0.25; killPlayer(p, gameNow); var c = corpses[0]; var e0 = corpseEase(c, c.diedAt); var e1 = corpseEase(c, c.diedAt + 75); var e2 = corpseEase(c, c.diedAt + 300); "缓出：0ms " + (Math.round(e0 * 1000) / 1000) + " -> 75ms " + (Math.round(e1 * 1000) / 1000) + " -> 300ms " + (Math.round(e2 * 1000) / 1000) + "（往上走到 1）";'); });

    step('apple-unlimited', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0]; applyPresetCfg(rail.cfg, "x"); var base = levelCfg.appleBase; var now0 = appleTargetCount(gameNow); var later = appleTargetCount(gameNow + 600000); var capped = (function () { setCfg({ apples: 30 }); return appleTargetCount(gameNow + 600000); })(); setCfg({ apples: 0 }); var code = levelCode("hz"); applyPresetCfg(LEVEL_PRESETS[0].cfg, "x"); importLevelCode(code); "高铁大陆 开局 " + base + " 个 / 现在目标 " + now0 + " / 10 分钟后 " + later + "（无上限，涨过 " + base + "）/ 设成上限 30 时 " + capped + "/ 过短码后 apples=" + levelCfg.apples;'); });

    step('ui-only-two-launch', function () { return ev(w, 'netLeave(); showMenu(); var vis = function (el) { while (el) { if (el.hidden) return false; if (getComputedStyle(el).display === \"none\") return false; el = el.parentElement; } return true; }; var started = []; var btns = document.querySelectorAll("#startPanel .startBtn");  for (var i = 0; i < btns.length; i++) { var b = btns[i]; if (b.id === "modeBtnLocal" || b.id === "modeBtnNet") continue;  var before = state; b.click(); if (state !== before) started.push((b.id || b.textContent) + ":" + before + "->" + state);  if (state !== "menu") showMenu(); }  var launch = ["modeBtnLocal", "modeBtnNet"].filter(function (id) { return !!document.getElementById(id); }).length;  "开始页按钮 " + btns.length + " 个 / 会开局的 " + launch + " 个 / 点其他按钮导致开局：" + (started.length ? started.join(",") : "没有") ;'); });
    step('ui-no-stacking', function () { return ev(w, 'netLeave(); showMenu(); var vis = function (el) { while (el) { if (el.hidden) return false; if (getComputedStyle(el).display === \"none\") return false; el = el.parentElement; } return true; }; var names = ["startPanel", "netPanel", "cfgPanel"]; var report = [];  var countPanels = function () { return names.filter(function (n) { return vis(document.getElementById(n)); }); };  report.push("菜单:" + countPanels().join("+"));  document.getElementById("modeBtnNet").click(); report.push("联机:" + countPanels().join("+"));  var roleInLan = (setNetKind("lan"), vis(document.getElementById("netRoleRow")));  var roleInCode = (setNetKind("code"), vis(document.getElementById("netRoleRow")));  document.getElementById("levelBtnNet").click(); report.push("联机+编辑器:" + countPanels().join("+"));  toggleCfgPanel(false); report.push("关编辑器:" + countPanels().join("+"));  setNetKind("code"); toggleCfgPanel(true); showMenu(); report.push("回菜单:" + countPanels().join("+"));  report.join(" | ") + " || 我是主机/客机只在连接码模式出现：局域网 " + roleInLan + " / 连接码 " + roleInCode;'); });
    step('ui-room-settings-inline', function () { return ev(w, 'showMenu(); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rail"; })[0];  document.querySelector("#netPresetRow [data-preset=rail]").click();  document.getElementById("modeBtnNet").click();  var maxBtn = document.getElementById("netMaxPlayersBtn");  var t0 = maxBtn.textContent; maxBtn.click(); var t1 = maxBtn.textContent;  var info = document.getElementById("levelInfoNet").textContent.slice(0, 40);  netRole = "guest"; syncStartPresets(); var dis = maxBtn.disabled; netRole = "host"; syncStartPresets();  "房间设置跟着关卡走：" + t0 + " -> " + t1 + " / 摘要 " + info + " / 客机只读 " + dis;'); });

    // 主题：跟随系统 / 浅色 / 深色（页面走 CSS 变量，画布走 COLOR）
    step('theme-cycle', function () { return ev(w, 'setThemeMode("auto"); var a = themeMode + "/" + document.getElementById("themeBtn").textContent; setThemeMode("light"); var b = themeMode + "/" + document.getElementById("themeBtn").textContent + "/" + document.documentElement.getAttribute("data-theme"); setThemeMode("dark"); var c = themeMode + "/" + document.getElementById("themeBtn").textContent + "/" + document.documentElement.getAttribute("data-theme"); "默认 " + a + " -> " + b + " -> " + c;'); });
    step('theme-applies', function () { return ev(w, 'var pageVar = function () { return getComputedStyle(document.documentElement).getPropertyValue("--page-bg").trim(); }; setThemeMode("dark"); var d1 = pageVar() + "/" + COLOR.board + "/" + document.documentElement.getAttribute("data-theme"); render(); setThemeMode("light"); var l1 = pageVar() + "/" + COLOR.board + "/" + document.documentElement.getAttribute("data-theme"); setThemeMode("auto"); "深色 " + d1 + " | 浅色 " + l1 + " | 两者不同 " + (d1 !== l1);'); });
    step('theme-follows-system', function () { return ev(w, 'var real = window.matchMedia; window.matchMedia = function () { return { matches: true, addEventListener: function () { }, removeEventListener: function () { } }; }; setThemeMode("auto"); var sysDark = themeIsDark() + "/" + document.documentElement.getAttribute("data-theme") + "/" + COLOR.board; window.matchMedia = function () { return { matches: false, addEventListener: function () { }, removeEventListener: function () { } }; }; applyTheme(); var sysLight = themeIsDark() + "/" + COLOR.board; window.matchMedia = real; setThemeMode("auto"); "系统深色 -> " + sysDark + " / 系统浅色 -> " + sysLight;'); });
    step('theme-persist', function () { return ev(w, 'setThemeMode("dark"); themeMode = "auto"; themeLoadPref(); var got = themeMode; setThemeMode("auto"); themeMode = "dark"; themeLoadPref(); var auto = themeMode; setThemeMode("auto"); "存深色读回来 " + got + "，存跟随系统读回来 " + auto;'); });
    step('theme-buttons', function () { return ev(w, 'setThemeMode("auto"); var b = document.getElementById("themeBtn"); var b2 = document.getElementById("themeBtn2"); b.click(); var a1 = themeMode; b.click(); var a2 = themeMode; b.click(); var a3 = themeMode; "点三下：" + a1 + " -> " + a2 + " -> " + a3 + "/两个按钮都在 " + (!!b && !!b2);'); });

    step('ui-preset-cards', function () { return ev(w, 'showMenu(); var cards = document.querySelectorAll("#startPresetRow .presetCard"); var noSvg = 0, noNote = 0, list = []; for (var i = 0; i < cards.length; i++) { var c = cards[i]; var svg = c.querySelector("svg.presetIcon"); var rect = svg ? svg.querySelector("rect") : null; var nm = c.querySelector(".presetName"); var nt = c.querySelector(".presetNote"); if (!svg || !svg.querySelector("*")) noSvg++; if (!nt || !nt.textContent.trim()) noNote++; if (i < 3 || nm.textContent === "高铁大陆") list.push(nm.textContent + "[" + (svg.getAttribute("data-icon")) + "]"); } "卡片 " + cards.length + " 张 / 缺 SVG " + noSvg + " / 缺说明 " + noNote + " / 其中 " + list.join(" ");'); });

    step('ui-preset-icons', function () { return ev(w, 'showMenu(); var cards = document.querySelectorAll("#startPresetRow .presetCard"); var rows = []; var noIcon = 0; for (var i = 0; i < cards.length; i++) { var c = cards[i]; var nm = c.querySelector(".presetName").textContent; var svg = c.querySelector("svg.presetIcon"); if (!svg) { noIcon++; continue; } rows.push(nm + "=" + svg.getAttribute("data-icon") + "(" + svg.querySelectorAll("*").length + ")"); } var want = LEVEL_PRESETS.length; "卡片 " + cards.length + " 张（内置 " + want + " + 自定义）/ 缺图标 " + noIcon + " / " + rows.join(" ");'); });

    step('pop-curve', function () { return ev(w, 'var t0 = gameNow; var r0 = popScale(t0, t0); var mid = popScale(t0, t0 + POP_MS * 0.55); var quarter = popScale(t0, t0 + POP_MS * 0.28); var end = popScale(t0, t0 + POP_MS); var none = popScale(undefined, t0); "起点 " + r0.toFixed(2) + " -> 28% " + quarter.toFixed(2) + " -> 55% " + mid.toFixed(2) + "（峰值，应≈" + POP_PEAK + "）-> 结束 " + end.toFixed(2) + "/没有出生时刻时 " + none;'); });
    step('pop-wired', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); apples = []; drops = []; powerUps = { speed: [], widen: [] }; reviveItem = null; spawnApple(); spawnPowerUp("speed"); dropLoot([{ x: 3, y: 3 }, { x: 4, y: 3 }], gameNow); reviveItem = { x: 6, y: 6, at: gameNow }; var a = apples[apples.length - 1]; var s = powerList("speed")[0]; var d = drops[0]; var ok = (typeof a.at === "number") && (typeof s.at === "number") && (typeof d.at === "number") && (typeof reviveItem.at === "number"); var sc = popScale(a.at, a.at + 80); var err = "没炸"; try { gameNow = a.at + 80; render(); } catch (e) { err = e.message; } "苹果 " + apples.length + "/道具 " + powerList("speed").length + "/掉落 " + drops.length + "/四个都有出生时刻 " + ok + "/80ms 时缩放 " + sc.toFixed(2) + "/画一帧 " + err;'); });

    step('drop-random', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var counts = [], lens = [], coins = [], lives = [], sameKindRun = 0, runs = 30; for (var r = 0; r < runs; r++) { drops = []; var body40 = []; for (var i = 0; i < 40; i++) body40.push({ x: 1 + (i % 20), y: 1 + Math.floor(i / 20) }); dropLoot(body40, gameNow); counts.push(drops.length); var len = 0, coin = 0, prev = null; for (var k = 0; k < drops.length; k++) { if (drops[k].kind === "len") len++; else coin++; lives.push(drops[k].expireAt - gameNow); if (prev === drops[k].kind) sameKindRun++; prev = drops[k].kind; } lens.push(len); coins.push(coin); } var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); }; var avg = function (a) { var m = sum(a) / a.length; return m.toFixed(1); }; var distinct = []; for (var i = 0; i < lives.length; i++) if (distinct.indexOf(lives[i]) === -1) distinct.push(lives[i]); "40 节尸体 x" + runs + " 次：每次掉 " + Math.min.apply(null, counts) + "~" + Math.max.apply(null, counts) + " 个（以前固定 40 个）/ 加身长 " + avg(lens) + " 个、金币 " + avg(coins) + " 个 / 出现相邻同种 " + sameKindRun + " 次（以前永远 0）/ 存在时间有 " + distinct.length + " 种不同值";'); });

    step('ai-seeks-drop', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var mkE = function (x, y, dx, dy, n) { var b = []; for (var i = 0; i < (n || 2); i++) b.push({ x: x - dx * i, y: y - dy * i }); return { kind: "purple", body: b, dir: { x: dx, y: dy }, acc: 0, hp: b.map(function () { return 2; }), baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; turrets = []; bullets = []; apples = [{ x: 2, y: 2 }]; var e = mkE(7, 7, 1, 0); enemies = [e]; powerUps = { speed: [], widen: [] }; drops = [{ x: 10, y: 7, kind: "len", expireAt: gameNow + 9000, at: gameNow }]; var t1 = nearestDropTarget(e.body[0]); var d1 = enemyChooseDir(e); drops = [{ x: 10, y: 7, kind: "coin", expireAt: gameNow + 9000, at: gameNow }]; var d2 = enemyChooseDir(e); drops = [{ x: 2, y: 2, kind: "len", expireAt: gameNow + 9000, at: gameNow }]; var far = nearestDropTarget(e.body[0]); var d3 = enemyChooseDir(e); "3 格外有加身长 -> 走 " + d1.x + "," + d1.y + "（1,0=去拿）/ 换成金币 -> 走 " + d2.x + "," + d2.y + " / 5 格外 " + String(far) + " -> 走 " + d3.x + "," + d3.y;'); });
    step('ai-eats-drop', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var mkE = function (x, y, dx, dy, n) { var b = []; for (var i = 0; i < (n || 2); i++) b.push({ x: x - dx * i, y: y - dy * i }); return { kind: "purple", body: b, dir: { x: dx, y: dy }, acc: 0, hp: b.map(function () { return 2; }), baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; }; turrets = []; bullets = []; apples = []; powerUps = { speed: [], widen: [] }; var e = mkE(6, 6, 1, 0, 3); enemies = [e]; e.body[0] = { x: 6, y: 6 }; drops = [{ x: 7, y: 6, kind: "len", expireAt: gameNow + 9000, at: gameNow }]; var len0 = e.body.length; var hp0 = e.hp.length; state = "running"; stepEnemy(e, gameNow); var afterLen = e.body.length; drops = [{ x: 7, y: 6, kind: "coin", expireAt: gameNow + 9000, at: gameNow }]; e.body[0] = { x: 6, y: 6 }; e.dir = { x: 1, y: 0 }; var len1 = e.body.length; stepEnemy(e, gameNow); "踩到加身长：长度 " + len0 + " -> " + afterLen + "、掉落剩 " + drops.length + "（先吃掉）/ 再踩金币：长度 " + len1 + " -> " + e.body.length + "、掉落剩 " + drops.length + "（踩掉但不长）";'); });

    step('guest-anim-fill', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); apples = [{ x: 1, y: 1 }, { x: 2, y: 2 }]; drops = [{ x: 5, y: 5, kind: "len", expireAt: gameNow + 9000, at: gameNow - 500 }]; powerUps = { speed: [], widen: [] }; reviveItem = null; var m1 = netSnapshot(); netRole = "guest"; netSeat = 2; netApplySnapshot(m1); var first = apples.map(function (a) { return a.at - m1.now; }); var dropAt1 = drops[0].at - m1.now; var m2 = JSON.parse(JSON.stringify(m1)); m2.now = m1.now + 33; m2.ap = [[1, 1], [3, 3]]; m2.dr = [[5, 5, 1, m1.now + 9000]]; netApplySnapshot(m2); var second = apples.map(function (a) { return (a.x + "," + a.y) + "@" + (a.at - m2.now); }); var dropAt2 = drops[0].at - m2.now; "快照1：苹果 at-now = " + first.join(",") + "（新出现，记成 0）/ 掉落 " + dropAt1 + "（沿用旧的 at）/ 快照2（+33ms）：" + second.join(" ") + " （(1,1) 应仍是 -33，也就是没重弹）/ 掉落 " + dropAt2;'); });

    step('grow-predict', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); turrets = []; apples = [{ x: 9, y: 9 }]; drops = [{ x: 3, y: 3, kind: "len", expireAt: gameNow + 9000, at: gameNow }, { x: 4, y: 4, kind: "coin", expireAt: gameNow + 9000, at: gameNow }]; powerUps = { speed: [], widen: [] }; var lenCell = willGrowAt(3, 3); var coinCell = willGrowAt(4, 4); var appleCell = willGrowAt(9, 9); var emptyCell = willGrowAt(1, 1); var outCell = willGrowAt(-1, 5); "加身长掉落 " + lenCell + " / 金币 " + coinCell + " / 苹果 " + appleCell + " / 空格 " + emptyCell + " / 越界 " + outCell;'); });
    step('enemy-grow-tail', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); turrets = []; bullets = []; apples = []; powerUps = { speed: [], widen: [] }; var e = { kind: "purple", body: [{ x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }], dir: { x: 1, y: 0 }, acc: 0, hp: [2, 2, 2], baseStepMs: 520, stepMs: 520, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; enemies = [e]; drops = [{ x: 7, y: 6, kind: "len", expireAt: gameNow + 9000, at: gameNow }]; var len0 = e.body.length; state = "running"; e.acc = e.stepMs; stepEnemy(e, gameNow); var len1 = e.body.length; var tail0 = e.body[e.body.length - 1]; "吃前 " + len0 + " 节、吃后 " + len1 + " 节 / 尾巴还在 " + (e.body.length > 0) + "/ 下一步预测会变长 " + willGrowAt(e.body[0].x + e.dir.x, e.body[0].y + e.dir.y) + "（吃完了应该是 false）";'); });

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
