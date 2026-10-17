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
    'assets/rng.js', 'assets/rooms.js', 'assets/icons.js', 'assets/level.js', 'assets/save.js', 'assets/cmd.js', 'assets/boot.js',
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

    step('cfg-tabs', function () { return ev(w, 'showMenu(); if (typeof toggleCfgPanel === "function") toggleCfgPanel(true); var eff = function (id) { var e = document.getElementById(id); if (!e) return "缺"; var n = e; while (n && n.nodeType === 1) { if (n.hidden) return false; if (getComputedStyle(n).display === "none") return false; n = n.parentElement; } return true; }; var tabs = document.querySelectorAll("#cfgTabs .cfgTab"); var labels = Array.prototype.map.call(tabs, function (b) { return b.textContent; }).join("/"); var pick = function (name) { return Array.prototype.filter.call(tabs, function (b) { return b.textContent === name; })[0]; }; pick("炮塔").click(); var a1 = eff("cfgTurretCost"); var a2 = eff("cfgStepMs"); pick("短码").click(); var b1 = eff("cfgCodeBox"); var b2 = eff("cfgPresetSel"); pick("预设").click(); var c1 = eff("cfgPresetSel"); var c2 = eff("cfgCodeBox"); toggleCfgPanel(false); tabs.length + " 个标签（" + labels + "）/ 点炮塔：塔字段 " + a1 + "、步长字段 " + a2 + " / 点短码：短码框 " + b1 + "、预设框 " + b2 + " / 点预设：预设框 " + c1 + "、短码框 " + c2;'); });

    step('cfg-field-icons', function () { return ev(w, 'showMenu(); toggleCfgPanel(true); selectCfgTab("sec3"); var turretIcons = document.querySelectorAll("#cfgBody .cfgSec.is-on .fieldIcon").length; selectCfgTab("sec2"); var cropIcons = document.querySelectorAll("#cfgBody .cfgSec.is-on .fieldIcon").length; selectCfgTab("sec1"); var snakeIcons = document.querySelectorAll("#cfgBody .cfgSec.is-on .fieldIcon").length; var boolBtn = document.getElementById("cfgEnemies"); var boolHasIcon = boolBtn ? boolBtn.innerHTML.indexOf("<svg") === 0 : "无按钮"; var sample = document.querySelector("#cfgBody .cfgSec[data-tab=sec3] .fieldIcon"); var vb = sample ? sample.getAttribute("viewBox") : "无"; toggleCfgPanel(false); "炮塔页 " + turretIcons + " 个图标 / 场上刷什么 " + cropIcons + " / 蛇 " + snakeIcons + " / 布尔按钮带图标 " + boolHasIcon + " / 视口 " + vb;'); });

    step('cfg-item-icons', function () { return ev(w, 'showMenu(); toggleCfgPanel(true); var tab = Array.prototype.filter.call(document.querySelectorAll("#cfgTabs .cfgTab"), function (b) { return b.textContent === "每种道具"; })[0]; tab.click(); var sec = document.querySelector("#cfgBody .cfgSec.is-on"); var icons = sec.querySelectorAll(".fieldIcon"); var rows = sec.querySelectorAll("label.field"); var detail = []; for (var i = 0; i < rows.length; i++) { var lab = rows[i].querySelector("span").textContent.replace(/\s+/g, " ").trim().slice(0, 6); var svg = rows[i].querySelector(".fieldIcon"); detail.push(lab + "=" + (svg ? svg.innerHTML.slice(0, 14) : "无")); } toggleCfgPanel(false); "每种道具页 " + rows.length + " 行 / 图标 " + icons.length + " 个 / 前四个：" + detail.slice(0, 4).join(" | ");'); });

    step('save-roundtrip', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.score = 42; p.coins = 7; p.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }]; p.hp = [2, 2, 2, 2]; apples = [{ x: 9, y: 9 }, { x: 10, y: 9 }]; turrets = [{ x: 12, y: 12, cooldownUntil: 0, owner: p, upA: 1, upB: 2 }]; drops = [{ x: 6, y: 6, kind: "coin", expireAt: gameNow + 5000, at: gameNow }]; reviveItem = { x: 8, y: 8, at: gameNow }; state = "running"; var okSave = saveRun(); var info = runInfo(); var before = COLS + "x" + ROWS + "/" + p.body.length + "/" + p.score + "/" + p.coins + "/苹果" + apples.length + "/塔" + turrets.length; start(1); var wiped = players[0].body.length + "/" + players[0].score + "/苹果" + apples.length; var okLoad = loadRun(); var p2 = players[0]; var after = COLS + "x" + ROWS + "/" + p2.body.length + "/" + p2.score + "/" + p2.coins + "/苹果" + apples.length + "/塔" + turrets.length + "/塔升级" + (turrets[0] ? turrets[0].upA + "+" + turrets[0].upB : "-") + "/复活道具有" + !!reviveItem + "/状态" + state; "存 " + okSave + "（" + info + "）/ 存前 " + before + " / 重开后 " + wiped + " / 读 " + okLoad + " -> " + after;'); });
    step('save-guest-and-clear', function () { return ev(w, 'netLeave(); start(1); state = "running"; var saved = saveRun(); var has1 = hasRun(); var guestOk = (netRole = "guest", saveRun()); netRole = ""; var btn = document.getElementById("continueBtn"); syncSaveBtns(); var shown = !btn.hidden; clearRun(); syncSaveBtns(); var gone = btn.hidden; "存进了一局 " + saved + " / hasRun " + has1 + " / 客机存档 " + guestOk + " / 开始页显示继续 " + shown + " / 删档后隐藏 " + gone;'); });

    step('rng-deterministic', function () { return ev(w, 'rndReset(12345); var a = [rnd(), rnd(), rnd()].map(function (x) { return x.toFixed(6); }).join(","); rndReset(12345); var b = [rnd(), rnd(), rnd()].map(function (x) { return x.toFixed(6); }).join(","); var st = rndState(); rndRestore(st, rngSeed); var c = rnd().toFixed(6); rndRestore(st, rngSeed); var d = rnd().toFixed(6); "同种子两次：" + a + " vs " + b + "（一致 " + (a === b) + "）/ 半路存状态再恢复：" + c + " vs " + d + "（一致 " + (c === d) + "）";'); });
    step('save-slots', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); players[0].score = 11; state = "running"; saveRun(0); players[0].score = 22; saveRun(2); var list = listRuns(); var before = list.map(function (r) { return r.empty ? "空" : r.label.split(" · ")[3]; }).join("/"); var loaded = loadRun(0); var s0 = players[0].score; var ok1 = loadRun(2); var s2 = players[0].score; clearRun(2); var after = listRuns().map(function (r) { return r.empty ? "空" : "有"; }).join("/"); "三格：" + before + " / 读槽1 得 " + s0 + " 分（" + loaded + "）/ 读槽3 得 " + s2 + " 分（" + ok1 + "）/ 删槽3 后 " + after;'); });
    step('save-migrate', function () { return ev(w, 'var v1 = migrateRun({ v: 1, players: [{ score: 5 }], cols: 10, rows: 8 }); var v2 = migrateRun({ v: 2, players: [{}], cols: 10, rows: 8, rng: [7, 9] }); var future = migrateRun({ v: 99, players: [{}] }); var bad = migrateRun(null); "v1 -> v" + v1.v + "（补了随机数状态 " + v1.rng + "）/ v2 原样 rng " + v2.rng + " / 未来版本 " + String(future) + " / 垃圾数据 " + String(bad);'); });
    step('save-rng-stream', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); state = "running"; rndReset(999); var n1 = [rnd(), rnd()].map(function (x) { return x.toFixed(6); }).join(","); var savedState = rndState(); saveRun(1); rnd(); rnd(); /* 走乱随机流 */ var ok = loadRun(1); var restored = rndState(); var n2 = [rnd(), rnd()].map(function (x) { return x.toFixed(6); }).join(","); rndRestore(savedState, rngSeed); var n3 = [rnd(), rnd()].map(function (x) { return x.toFixed(6); }).join(","); clearRun(1); "存档前下一颗 " + n1 + " / 存档状态 " + savedState + " 读回来 " + restored + "（" + (savedState === restored) + "）/ 读档后接着走 " + n2 + " vs 存档那一刻接着走 " + n3 + "（" + (n2 === n3) + "）";'); });

    step('rogue-generate', function () { return ev(w, 'var a = [], b = [], c = []; for (var i = 0; i < 5; i++) { a.push(JSON.stringify(rogueRoomPlan(12345, i, 6))); } for (var i = 0; i < 5; i++) { b.push(JSON.stringify(rogueRoomPlan(12345, i, 6))); } for (var i = 0; i < 5; i++) { c.push(JSON.stringify(rogueRoomPlan(999, i, 6))); } var same = a.join("") === b.join(""); var diff = a.join("") !== c.join(""); var first = JSON.parse(a[0]); var sizes = a.map(function (s) { var r = JSON.parse(s); return r.cols + "x" + r.rows; }).join(","); var kinds = a.map(function (s) { return JSON.parse(s).kind; }).join(","); "同种子完全一致 " + same + " / 换种子不同 " + diff + " / 五间尺寸 " + sizes + " / 类型 " + kinds;'); });
    step('rogue-enter', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; var kept = p.body.length; var r1 = { i: roomRun.i, total: roomRun.total, cols: COLS, rows: ROWS, apples: apples.length, enemies: enemies.length, kind: room.kind, door: room.door.x + "," + room.door.y, cleared: room.cleared, hp: p.hp.length }; "第 " + (r1.i + 1) + "/" + r1.total + " 间 " + r1.kind + " " + r1.cols + "x" + r1.rows + " / 苹果 " + r1.apples + " 敌人 " + r1.enemies + " / 门 " + r1.door + " 关着 " + (!r1.cleared) + " / 蛇" + kept + "节 血" + r1.hp + " / HUD " + document.getElementById("roomTag").textContent;'); });
    step('rogue-clear-and-advance', function () { return ev(w, 'var lenBefore = players[0].body.length; var idxBefore = roomRun.i; enemies = []; updateRooms(gameNow); var opened = room.door.open; players[0].body[0] = { x: room.door.x, y: room.door.y }; players[0].alive = true; updateRooms(gameNow); "清场后开门 " + opened + " / 踩门前第 " + (idxBefore + 1) + " 间 -> 踩门后第 " + (roomRun.i + 1) + " 间（共 " + roomRun.total + "）/ 蛇长 " + lenBefore + "->" + players[0].body.length + " / 新门 " + room.door.x + "," + room.door.y;'); });

    step('rogue-supply-and-save', function () { return ev(w, 'var supply = null, battle = 0, supplyCount = 0; for (var s = 1; s < 40 && !supply; s++) { for (var i = 0; i < 5; i++) { var pl = rogueRoomPlan(s * 1000 + i, i, 6); if (pl.kind === "supply") { supply = pl; break; } if (pl.kind === "battle") battle++; } if (supply) supplyCount++; } var okGoal = supply ? (supply.enemies.length === 0 && supply.goal > 0) : false; netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var saved = saveRun(0); var hadRoom = !!room; var idx = roomRun ? roomRun.i : -1; var doorBefore = room && room.door ? room.door.open : null; enemies = []; room.cleared = true; room.door.open = true; var ok = loadRun(0); var afterIdx = roomRun ? roomRun.i : -1; var afterOpen = room && room.door ? room.door.open : null; var afterEnemies = enemies.length; clearRun(0); "找到补给房 " + !!supply + "（敌人 " + (supply ? supply.enemies.length : "-") + " 目标苹果 " + (supply ? supply.goal : "-") + "）/ 存档带房间 " + hadRoom + " 第 " + (idx + 1) + " 间、门开 " + doorBefore + " / 清场后读档 -> 第 " + (afterIdx + 1) + " 间、门开 " + afterOpen + "、敌人 " + afterEnemies;'); });

    step('rogue-no-refill', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5, enemyMax: 8 }); start(1); var n0 = enemies.length; enemies = []; updateEnemySpawns(gameNow); var refilled = enemies.length; updateRooms(gameNow); var opened = room.door.open; var drawn = "没画"; try { gameNow = gameNow + 100; render(); drawn = "画了一帧"; } catch (e) { drawn = e.message; } "开局敌人 " + n0 + " / 清空后 updateEnemySpawns 又补了 " + refilled + " 个（应为 0）/ 门开了 " + opened + " / 门渲染 " + drawn + " / HUD " + document.getElementById("roomTag").textContent;'); });

    step('rogue-emerge', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.body = []; for (var k = 0; k < 8; k++) p.body.push({ x: 12 - k, y: 8 }); p.hp = new Array(8).fill(2); p.alive = true; state = "running"; rogueEnter(0); enemies = []; apples = []; drops = []; powerUps = { speed: [], widen: [] }; turrets = []; bullets = []; p.invUntil = 0; var hole = room.hole.x + "," + room.hole.y; var out = ["洞 " + hole + "（最左列 " + (room.hole.x === 0) + "）", "起步 头 " + p.body[0].x + "," + p.body[0].y + " 尾 " + p.body[p.body.length - 1].x + "," + p.body[p.body.length - 1].y]; for (var s = 0; s < 5; s++) { p.acc = p.stepMs; p.alive = true; step(p, gameNow); var t = p.body[p.body.length - 1]; out.push("走" + (s + 1) + "步 头 " + p.body[0].x + " 长" + p.body.length + " 尾 " + t.x + "," + t.y); } out.join(" | ");'); });

    step('snake-tail-sync', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); apples = []; enemies = []; turrets = []; var p = players[0]; p.body = [{ x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 3, y: 6 }]; p.hp = [2, 2, 2, 2]; p.dir = { x: 1, y: 0 }; p.queue = []; p.alive = true; p.emergeLeft = 0; p.acc = p.stepMs * 0.5; state = "running"; var e = progress(p); var grow = emergeGrow(p); var emerging = (p.emergeLeft > 0 && p.body.length > 2); var retract = emerging ? false : (state === "running" && !willGrowNext(p)); var actual = buildPath(p.body, p.dir, e, retract, emerging ? grow : undefined); var noRetract = buildPath(p.body, p.dir, e, false); var moved = Math.round(Math.abs(actual[actual.length - 1].x - noRetract[noRetract.length - 1].x) * 10) / 10; var headLead = Math.round(Math.abs(actual[0].x - cxOf(p.body[0])) * 10) / 10; var maxGap = 0; for (var i = 1; i < actual.length; i++) { maxGap = Math.max(maxGap, Math.hypot(actual[i].x - actual[i - 1].x, actual[i].y - actual[i - 1].y) / CELL); } "正常移动（半格）：出洞中 " + emerging + " / 尾巴比「不收」多走 " + moved + "px（应≈10）/ 头探出 " + headLead + "px / 路径最大间距 " + (Math.round(maxGap * 100) / 100) + " 格";'); });

    step('room-switch-cost', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.emergeAt = 0; p.body = []; for (var k = 0; k < 10; k++) p.body.push({ x: 10 - k, y: 6 }); p.hp = new Array(10).fill(2); state = "running"; /* 正常一帧的基准 */ var t0 = performance.now(); for (var i = 0; i < 20; i++) render(); var normal = (performance.now() - t0) / 20; /* 切房间：进房 + 立刻画一帧 */ var times = []; for (var r = 0; r < 5; r++) { var t1 = performance.now(); rogueEnter(r); var enterMs = performance.now() - t1; var t2 = performance.now(); render(); var renderMs = performance.now() - t2; times.push("第" + (r + 1) + "间 进房 " + enterMs.toFixed(2) + "ms+画 " + renderMs.toFixed(2) + "ms"); } var t3 = performance.now(); for (var i = 0; i < 20; i++) { p.acc = p.stepMs; updateEnemySpawns(gameNow); updateRooms(gameNow); render(); } var after = (performance.now() - t3) / 20; "普通帧 " + normal.toFixed(2) + "ms / 切房间：" + times.join("，") + " / 切完之后每帧 " + after.toFixed(2) + "ms";'); });

    step('room-switch-no-shift', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); rogueEnter(2); var info = "换房后 位移(" + widenShiftX + "," + widenShiftY + ") 增长动画起点 " + widenStartAt + " 场地 " + COLS + "x" + ROWS; var err = "画一帧没炸"; try { render(); } catch (e) { err = "画一帧出错: " + e.message; } info + " / " + err;'); });

    step('room-view-sync', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; showMenu(); start(1); updateView(); var info = function (tag) { return tag + " 场地 " + COLS + "x" + ROWS + " 视口 " + VIEW_W + "x" + VIEW_H + " zoom " + zoom.toFixed(2); }; var out = [info("普通模式")]; setCfg({ rooms: 5 }); start(1); updateView(); out.push(info("房间第1间")); rogueEnter(2); updateView(); out.push(info("房间第3间")); showMenu(); resetLevelCfg(); updateView(); out.push(info("退回菜单")); out.join(" | ");'); });

    step('room-hole-size', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); rogueEnter(0); var err = "画一帧没炸"; try { gameNow = gameNow + 50; render(); } catch (e) { err = e.message; } var hole = room.hole ? room.hole.x + "," + room.hole.y : "无"; var door = room.door ? room.door.x + "," + room.door.y : "无"; "洞 " + hole + " / 门 " + door + " / 半径 " + (HOLE_R * CELL) + "px（格子 " + CELL + "px，正圆）/ " + err;'); });

    step('rogue-both-doors', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; enemies = []; updateRooms(gameNow); gameNow = gameNow + 400; /* 前进：从右门进第2间，应该出现在左边 */ var door0 = room.door.x + "," + room.door.y; p.body = [{ x: room.door.x, y: room.door.y }, { x: room.door.x - 1, y: room.door.y }]; p.hp = [2, 2]; updateRooms(gameNow); var forward = { i: roomRun.i, head: p.body[0].x + "," + p.body[0].y, dir: p.dir.x + "," + p.dir.y, hole: room.hole.x + "," + room.hole.y }; gameNow = gameNow + 400; /* 后退：踩左边的洞回第1间，应该出现在右边（门那一侧） */ var hole1 = { x: room.hole.x, y: room.hole.y }; p.body = [{ x: hole1.x, y: hole1.y }, { x: hole1.x + 1, y: hole1.y }]; p.hp = [2, 2]; updateRooms(gameNow); var back = { i: roomRun.i, head: p.body[0].x + "," + p.body[0].y, dir: p.dir.x + "," + p.dir.y, hole: room.hole.x + "," + room.hole.y, cols: COLS }; "前进 -> " + JSON.stringify(forward) + " / 后退 -> " + JSON.stringify(back) + " / 第1间的门原来在 " + door0;'); });

    step('rogue-room-memo', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); /* 找一个第2间是补给房的种子 */ var seed = 0; for (var s = 1; s < 800; s++) { var pl = rogueRoomPlan(s, 1, 6); if (pl.kind === "supply" && pl.goal > 0) { seed = s; break; } } rogueStart(seed); var p = players[0]; p.invUntil = 0; var go = function () { gameNow = gameNow + 400; }; var walk = function (x, y) { p.body = [{ x: x, y: y }, { x: x + (x > COLS / 2 ? 1 : -1), y: y }]; p.hp = [2, 2]; updateRooms(gameNow); }; /* 第1间：清掉 -> 去第2间 */ room.cleared = true; room.door.open = true; go(); walk(room.door.x, room.door.y); var i1 = roomRun.i; var kind1 = room.kind; var goal1 = room.goal; var enemies1 = enemies.length; /* 第2间（补给房）：吃 4 个 -> 回第1间 */ for (var k = 0; k < 4; k++) roomAppleEaten(); var eaten = room.goalNow; go(); walk(room.hole.x, room.hole.y); var i2 = roomRun.i; var mem = roomRun.memo[1] ? JSON.stringify(roomRun.memo[1]) : "没记"; /* 再往前走回第2间 */ room.cleared = true; room.door.open = true; go(); walk(room.door.x, room.door.y); var i3 = roomRun.i; "种子 " + seed + " / 第2间是 " + kind1 + "（目标 " + goal1 + "、" + enemies1 + " 个敌人）/ 吃 " + eaten + " 个 -> 回第1间(i=" + i2 + ")，记下 " + mem + " -> 再进第2间(i=" + i3 + ")：进度 " + room.goalNow + "/" + room.goal + "、敌人 " + enemies.length + " 个（原来 " + enemies1 + "）";'); });

    step('room-portal-resize', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var oldCols = COLS; var oldEdge = oldCols * CELL - CELL / 2; widenField(gameNow); var newCols = COLS; var newEdge = newCols * CELL - CELL / 2; var mid = (oldCols * CELL + newCols * CELL) / 2 - CELL / 2; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } var nowGrow = boardGrowing(); "场地 " + oldCols + " -> " + newCols + "（门在动画中跟着右墙）/ 旧边缘中心 " + oldEdge + " -> 新 " + newEdge + " / 正在长大 " + nowGrow + " / 画出来的宽度 " + Math.round(boardWorldW()) + " / " + err;'); });

    step('room-fade', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var out = []; for (var i = 0; i < ROOM_FX_LIST.length; i++) { setRoomFx(ROOM_FX_LIST[i]); rogueEnter(0, (i % 2) ? -1 : 1); var s0 = roomFxState(gameNow); var sMid = roomFxState(gameNow + 150); var sEnd = roomFxState(gameNow + 400); out.push(s0.type + " 起点 k=" + s0.k.toFixed(2) + " dx=" + Math.round(s0.dx) + " 缩放=" + s0.scale.toFixed(2) + " alpha=" + s0.alpha.toFixed(2) + " | 半程 dx=" + Math.round(sMid.dx) + " 缩放=" + sMid.scale.toFixed(2) + " alpha=" + sMid.alpha.toFixed(2) + " | 结束 k=" + sEnd.k); var err = "画一帧没炸"; try { gameNow = gameNow + 120; render(); } catch (e) { err = e.message; } out.push("  " + err); } setRoomFx("fade"); "按钮 " + (document.getElementById("roomFxBtn") ? "有" : "无") + " / " + out.join(" || ");'); });

    step('boost-state', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; /* 吃个加速 */ pickPowerUp(p, "speed", gameNow); var bst = { step: p.stepMs, left: Math.round(p.boostUntil - gameNow), normal: levelCfg.stepMs }; /* 换一间 */ rogueEnter(1); var inRoom = { step: p.stepMs, left: Math.round(p.boostUntil - gameNow) }; /* 存档 -> 读档 */ saveRun(0); var savedLeft = Math.round(p.boostUntil - gameNow); p.boostUntil = 0; p.stepMs = levelCfg.stepMs; var ok = loadRun(0); var loaded = { step: players[0].stepMs, left: Math.round(players[0].boostUntil - gameNow) }; /* 等它过期 */ gameNow = gameNow + 40000; updateRooms(gameNow); expirePlayerBoost(players[0], gameNow); var expired = { step: players[0].stepMs, until: players[0].boostUntil }; clearRun(0); "吃加速: 步长 " + bst.step + "（普通 " + bst.normal + "）剩 " + bst.left + "ms / 进房后 " + inRoom.step + " 剩 " + inRoom.left + "ms / 存档再读: " + loaded.step + " 剩 " + loaded.left + "ms（存前 " + savedLeft + "）/ 过期后 步长 " + expired.step + "、boostUntil " + expired.until;'); });

    step('floor-layout', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var R = roomRun.rooms; var doors = R.map(function (r) { return r.gx + "," + r.gy + ":" + Object.keys(r.doors).join(""); }).join(" "); var dirs = {}; for (var i = 0; i < R.length; i++) { var k = Object.keys(R[i].doors); for (var j = 0; j < k.length; j++) dirs[k[j]] = (dirs[k[j]] || 0) + 1; } var portals = (room.portals || []).map(function (pt) { return pt.dir + "@" + pt.x + "," + pt.y + "->" + pt.to; }).join(" "); var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "本层 " + R.length + " 间：" + doors + " / 方向统计 " + JSON.stringify(dirs) + " / 当前间 " + roomRun.i + " 的门：" + portals + " / 起点入口 " + (room.entrance ? room.entrance.x + "," + room.entrance.y : "无") + " / " + err;'); });
    step('floor-travel', function () { return ev(w, 'var target = room.portals[0]; var to = target.to; room.cleared = true; var p = players[0]; p.body = [{ x: target.x, y: target.y }, { x: target.x, y: target.y }]; p.hp = [2, 2]; p.alive = true; gameNow = gameNow + 400; updateRooms(gameNow); var entered = { i: roomRun.i, to: to, dir: room.dir ? room.dir.x + "," + room.dir.y : "?", head: p.body[0].x + "," + p.body[0].y, portals: (room.portals || []).length }; /* 再从那个房间走回去 */ var back = null; for (var i = 0; i < room.portals.length; i++) { if (room.portals[i].to === 0) back = room.portals[i]; } var okBack = false; if (back) { room.cleared = true; p.body = [{ x: back.x, y: back.y }, { x: back.x, y: back.y }]; gameNow = gameNow + 400; updateRooms(gameNow); okBack = (roomRun.i === 0); } "踩 " + target.dir + " 门 -> 第 " + (to + 1) + " 间（实际 " + (entered.i + 1) + "），朝向 " + entered.dir + "、头 " + entered.head + "、这间门数 " + entered.portals + " / 走回去 " + okBack;'); });

    step('floor-integrity', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var bad = []; for (var s = 1; s <= 40; s++) { rogueStart(s * 7919); var R = roomRun.rooms; /* 1) 每扇门对面也要有回来的门 */ for (var i = 0; i < R.length; i++) { for (var d in R[i].doors) { var j = R[i].doors[d]; var op = { e: "w", w: "e", n: "s", s: "n" }[d]; if (R[j].doors[op] !== i) bad.push("s" + s + ": " + i + d + " 无回门"); } } /* 2) 所有房间都能从起点走到 */ var seen = {}; var q = [0]; seen[0] = 1; for (var qi = 0; qi < q.length; qi++) { var dr = R[q[qi]].doors; for (var dd in dr) { var k = dr[dd]; if (!seen[k]) { seen[k] = 1; q.push(k); } } } if (q.length !== R.length) bad.push("s" + s + ": 只到 " + q.length + "/" + R.length); } /* 3) 扩大后四面门贴边 */ rogueStart(1234); var p = players[0]; p.invUntil = 0; widenField(gameNow); var okEdges = true; var desc = []; for (var i = 0; i < room.portals.length; i++) { var pt = room.portals[i]; var wantX = pt.dir === "e" ? COLS - 1 : (pt.dir === "w" ? 0 : pt.x); var wantY = pt.dir === "s" ? ROWS - 1 : (pt.dir === "n" ? 0 : pt.y); if (pt.x !== wantX || pt.y !== wantY) okEdges = false; desc.push(pt.dir + "@" + pt.x + "," + pt.y); } var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "40 个种子：连通/对称问题 " + (bad.length ? bad.slice(0, 3).join("; ") : "无") + " / 扩大后门位置 " + desc.join(" ") + "（都贴边 " + okEdges + "）/ 场地 " + COLS + "x" + ROWS + " / " + err;'); });

    step('rogue-items', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rail = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rail.cfg, "x"); start(1); var speedOn = powerOn("speed"); var widenOn = powerOn("widen"); var speedMax = powerMax("speed"); var widenMax = powerMax("widen"); var gap = Math.round(powerGapMs("speed")); var roomSpeed = powerList("speed").length; var roomWiden = powerList("widen").length; var boostSec = Math.round(levelCfg.boostMs / 1000); var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "房间迷宫：加速开 " + speedOn + "（同屏上限 " + speedMax + "、间隔 " + gap + "ms）/ 拓宽开 " + widenOn + "（上限 " + widenMax + "）/ 进房后场上加速 " + roomSpeed + " 个、拓宽 " + roomWiden + " 个 / 加速时长 " + boostSec + "s / " + err;'); });

    step('room-entry-side', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var res = []; var dirs = ["e", "w", "n", "s"]; for (var i = 0; i < dirs.length; i++) { rogueEnter(0, dirs[i]); res.push(dirs[i] + " -> 头 " + p.body[0].x + "," + p.body[0].y + " 尾 " + p.body[1].x + "," + p.body[1].y + " 朝向 " + p.dir.x + "," + p.dir.y + " 洞口 " + room.hole.x + "," + room.hole.y); } "场地 " + COLS + "x" + ROWS + "（中 " + Math.floor(COLS / 2) + "," + Math.floor(ROWS / 2) + "）/ " + res.join(" | ");'); });

    step('floor-map-dirs', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var bad = 0; for (var s = 1; s <= 30; s++) { rogueStart(s * 7919); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { for (var d in R[i].doors) { var n = R[R[i].doors[d]]; /* 北邻必须在上面（gy 更小）、东邻必须在右边（gx 更大） */ if (d === "n" && !(n.gy < R[i].gy)) bad++; if (d === "s" && !(n.gy > R[i].gy)) bad++; if (d === "e" && !(n.gx > R[i].gx)) bad++; if (d === "w" && !(n.gx < R[i].gx)) bad++; } } } /* 小地图的 y 公式：gy 小 -> 画得更靠上 */ var R0 = roomRun.rooms; var north = null; for (var i = 0; i < R0.length; i++) { if (R0[i].doors.n !== undefined) { north = R0[i]; break; } } var msg = "布局方向检查 30 个种子：错 " + bad + " 处"; if (north) { var n2 = R0[north.doors.n]; msg += " / 示例：房间(gy=" + north.gy + ") 的北邻 gy=" + n2.gy + "（北邻更靠上 " + (n2.gy < north.gy) + "）"; } var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } msg + " / " + err;'); });

    step('rogue-safe-room', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); updateRooms(gameNow); var p = players[0]; p.invUntil = 0; var st = { kind: room.kind, enemies: enemies.length, apples: apples.length, cleared: room.cleared, allOpen: (room.portals || []).every(function (x) { return x.open; }), doors: (room.portals || []).map(function (x) { return x.dir; }).join("") }; var tag = document.getElementById("roomTag") ? document.getElementById("roomTag").textContent : "?"; /* 走一间再回来 */ var target = room.portals[0]; p.body = [{ x: target.x, y: target.y }, { x: target.x, y: target.y }]; p.hp = [2, 2]; p.alive = true; gameNow = gameNow + 400; updateRooms(gameNow); var to = roomRun.i; var kindThere = room.kind; gameNow = gameNow + 400; var back = null; for (var i = 0; i < room.portals.length; i++) if (room.portals[i].to === 0) back = room.portals[i]; var okBack = false; if (back) { if (!room.cleared) { room.cleared = true; } p.body = [{ x: back.x, y: back.y }, { x: back.x, y: back.y }]; updateRooms(gameNow); okBack = roomRun.i === 0; } var again = { kind: room.kind, enemies: enemies.length, apples: apples.length, cleared: room.cleared, allOpen: (room.portals || []).every(function (x) { return x.open; }) }; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "起点房 " + JSON.stringify(st) + " 标签「" + tag + "」 / 第 2 间是 " + kindThere + "，回来 " + okBack + " -> " + JSON.stringify(again) + " / " + err;'); });

    step('rogue-cut', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); var p = players[0]; p.invUntil = 0; p.body = []; for (var k = 0; k < 9; k++) p.body.push({ x: 1 + k, y: 5 }); p.hp = new Array(9).fill(2); p.dir = { x: -1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.boostUntil = 0; p.stepMs = levelCfg.stepMs; var before = p.body.length; var seq = []; for (var s = 0; s < 3; s++) { p.acc = p.stepMs; try { step(p, gameNow); } catch (e) { seq.push("错:" + e.message); break; } seq.push("头 " + p.body[0].x + " 长 " + p.body.length + (p.alive ? "" : "（死了）")); } var after = { len: p.body.length, alive: p.alive, inv: Math.round(p.invUntil - gameNow), cutWall: levelCfg.cutWall }; "撞墙前 长 " + before + " / " + seq.join(" | ") + " / 现在 " + JSON.stringify(after);'); });

    step('team-buff-item', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; showMenu(); resetLevelCfg(); start(2); var a = players[0], b = players[1]; a.boostUntil = 0; b.boostUntil = 0; var normal = levelCfg.stepMs; var pick = function () { powerUps.team = [{ x: a.body[0].x, y: a.body[0].y, at: nowRef }]; pickPowerUp(a, "team", gameNow); }; var show = []; for (var n = 1; n <= 5; n++) { pick(); show.push(n + "次 ×" + a.permMul.toFixed(3) + " 步长 " + Math.round(a.stepMs) + "（b " + Math.round(b.stepMs) + "）"); } for (var n = 0; n < 200; n++) pick(); var lots = "叠 205 次 ×" + a.permMul.toFixed(2) + " 步长 " + Math.round(a.stepMs) + "（下限 " + MIN_STEP_MS + "）"; a.boostUntil = gameNow - 1; expirePlayerBoost(a, gameNow); var afterBoost = Math.round(a.stepMs); saveRun(0); a.permMul = 1; a.stepMs = normal; loadRun(0); var loaded = { mul: players[0].permMul.toFixed(2), step: Math.round(players[0].stepMs) }; clearRun(0); syncBoostHud(gameNow); var hud = document.getElementById("boostLeft").textContent; "普通 " + normal + " / " + show.join(" | ") + " / " + lots + " / 限时加速结束后 " + afterBoost + " / 存档读档 " + JSON.stringify(loaded) + " / HUD「" + hud + "」";'); });

    step('rogue-clear-reward', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); /* 找一间「战斗房」并进到它 */ var found = -1; for (var s = 1; s < 600 && found < 0; s++) { rogueStart(s); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { if (R[i].depth <= 0) continue; var pl = rogueRoomPlan(roomRun.seed, R[i].depth, 6); if (pl.kind === "battle") { rogueEnter(i, "e"); found = i; break; } } } var p = players[0]; p.invUntil = 0; var beforeClear = { idx: found, kind: room.kind, enemies: enemies.length, team: powerUps.team.length, respawnAt: String(powerRespawnAt.team) }; enemies = []; gameNow = gameNow + 500; updateRooms(gameNow); var afterClear = { cleared: room.cleared, team: powerUps.team.length, at: powerUps.team[0] ? powerUps.team[0].x + "," + powerUps.team[0].y : "无" }; gameNow = gameNow + 500; updateRooms(gameNow); var twice = powerUps.team.length; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "战斗房进门 " + JSON.stringify(beforeClear) + " / 清场后 " + JSON.stringify(afterClear) + " / 再清一次还是 " + twice + " 个 / " + err;'); });

    step('rogue-chest-room', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); var found = -1, seed = 0; for (var s = 1; s < 900 && found < 0; s++) { rogueStart(s); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { if (R[i].depth < 2) continue; var pl = rogueRoomPlan(roomRun.seed, R[i].depth, 6); if (pl.kind === "chest") { seed = s; rogueEnter(i, "e"); found = i; break; } } } var p = players[0]; p.invUntil = 0; updateRooms(gameNow); var st = { seed: seed, kind: room.kind, enemies: enemies.length, team: powerUps.team.length, widen: powerUps.widen.length, apples: apples.length, cleared: room.cleared, doorsOpen: (room.portals || []).every(function (x) { return x.open; }), teamMax: powerMax("team") }; var tag = document.getElementById("roomTag") ? document.getElementById("roomTag").textContent : "?"; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } JSON.stringify(st) + " 标签「" + tag + "」 / " + err;'); });

    step('safe-room-no-refill', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); updateRooms(gameNow); var p = players[0]; p.invUntil = 0; var st = { kind: room.kind, apples: apples.length, speed: powerUps.speed.length, team: powerUps.team.length }; /* 把苹果吃完、道具拿光，然后等很久 */ apples = []; powerUps.speed = []; powerUps.widen = []; powerUps.team = []; var respawn = {}; for (var k = 0; k < POWER_KINDS.length; k++) respawn[POWER_KINDS[k]] = String(powerRespawnAt[POWER_KINDS[k]]); for (var t = 0; t < 30; t++) { gameNow = gameNow + 1000; updateRooms(gameNow); fillApples(gameNow, 4); } var after = { apples: apples.length, speed: powerUps.speed.length, team: powerUps.team.length }; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "起点房 " + JSON.stringify(st) + " / 清空后等 30 秒：" + JSON.stringify(after) + " / 道具刷新点 " + JSON.stringify(respawn) + " / " + err;'); });

    step('room-tints', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var kinds = ["safe", "battle", "supply", "chest", "boss"]; var out = []; for (var i = 0; i < kinds.length; i++) { room.kind = kinds[i]; var tint = roomTint(); var err = "ok"; try { gameNow = gameNow + 20; render(); } catch (e) { err = e.message; } out.push(kinds[i] + "=" + (tint || "无") + " " + err); } showMenu(); var none = roomTint(); kinds.join(" "); "各房间配色：" + out.join(" | ") + " / 退出房间后 " + (none === null ? "无染色（标准底色）" : "还有染色");'); });

    step('cleared-room-no-refill', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); /* 找一间战斗房进去 */ var found = -1; for (var s = 1; s < 600 && found < 0; s++) { rogueStart(s); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { if (R[i].depth <= 0) continue; var pl = rogueRoomPlan(roomRun.seed, R[i].depth, 6); if (pl.kind === "battle") { rogueEnter(i, "e"); found = i; break; } } } var p = players[0]; p.invUntil = 0; var before = { cleared: room.cleared, apples: apples.length, speed: powerUps.speed.length }; /* 清场 */ enemies = []; gameNow = gameNow + 300; updateRooms(gameNow); var atClear = { cleared: room.cleared, apples: apples.length, speed: powerUps.speed.length, team: powerUps.team.length }; /* 等 30 秒 */ for (var t = 0; t < 30; t++) { gameNow = gameNow + 1000; updateRooms(gameNow); fillApples(gameNow, 4); } var after = { apples: apples.length, speed: powerUps.speed.length, team: powerUps.team.length }; var timers = {}; for (var k = 0; k < POWER_KINDS.length; k++) timers[POWER_KINDS[k]] = String(powerRespawnAt[POWER_KINDS[k]]); var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "战斗房清场前 " + JSON.stringify(before) + " / 清场时 " + JSON.stringify(atClear) + " / 30 秒后 " + JSON.stringify(after) + " / 刷新点 " + JSON.stringify(timers) + " / " + err;'); });

    step('start-room-auto-done', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); var st0 = { done0: !!roomRun.done[0], kind: room.kind, cleared: room.cleared, doorsOpen: (room.portals || []).every(function (x) { return x.open; }) }; /* 走去第 2 间再回来，起始房仍然是「已完成」 */ var p = players[0]; p.invUntil = 0; var pt = room.portals[0]; p.body = [{ x: pt.x, y: pt.y }, { x: pt.x, y: pt.y }]; p.hp = [2, 2]; p.alive = true; gameNow = gameNow + 400; updateRooms(gameNow); var left = roomRun.i; var back = null; for (var i = 0; i < room.portals.length; i++) if (room.portals[i].to === 0) back = room.portals[i]; var okBack = false; if (back) { if (!room.cleared) room.cleared = true; gameNow = gameNow + 400; p.body = [{ x: back.x, y: back.y }, { x: back.x, y: back.y }]; updateRooms(gameNow); okBack = roomRun.i === 0; } var st1 = { done0: !!roomRun.done[0], kind: room.kind, cleared: room.cleared, doorsOpen: (room.portals || []).every(function (x) { return x.open; }) }; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "开局 " + JSON.stringify(st0) + " / 去了第 " + (left + 1) + " 间再回来 " + okBack + " -> " + JSON.stringify(st1) + " / " + err;'); });

    step('apples-frozen', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); updateRooms(gameNow); var p = players[0]; p.invUntil = 0; /* 起点安全屋：吃一个苹果 */ var a0 = apples.length; var apple = apples[0]; p.body[0] = { x: apple.x, y: apple.y }; p.acc = p.stepMs; p.alive = true; try { step(p, gameNow); } catch (e) { } var afterEat = { before: a0, after: apples.length, frozen: applesFrozen(), cleared: room.cleared }; /* 再去一间清过的战斗房：吃一个 */ var found = -1; for (var s = 1; s < 600 && found < 0; s++) { rogueStart(s); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { if (R[i].depth <= 0) continue; var pl = rogueRoomPlan(roomRun.seed, R[i].depth, 6); if (pl.kind === "battle") { rogueEnter(i, "e"); found = i; break; } } } var p2 = players[0]; p2.invUntil = 0; enemies = []; gameNow = gameNow + 300; updateRooms(gameNow); var b0 = apples.length; if (apples.length) { var ap2 = apples[0]; p2.dir = { x: 1, y: 0 }; p2.body = [{ x: ap2.x - 1, y: ap2.y }, { x: ap2.x - 2, y: ap2.y }]; p2.hp = [2, 2]; p2.acc = p2.stepMs; p2.alive = true; try { step(p2, gameNow); } catch (e) { } } var afterClearEat = { before: b0, after: apples.length, frozen: applesFrozen(), cleared: room.cleared }; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "安全屋吃苹果 " + JSON.stringify(afterEat) + " / 清过的战斗房吃苹果 " + JSON.stringify(afterClearEat) + " / " + err;'); });

    step('chest-room-small', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); /* 进一间宝箱房 */ var at = -1; for (var s = 1; s < 900 && at < 0; s++) { rogueStart(s); var R = roomRun.rooms; for (var i = 0; i < R.length; i++) { if (R[i].depth < 2) continue; var pl = rogueRoomPlan(roomRun.seed, R[i].depth, 6); if (pl.kind === "chest") { rogueEnter(i, "e"); at = i; break; } } } var p = players[0]; p.invUntil = 0; var first = { apples: apples.length, cleared: room.cleared, frozen: applesFrozen() }; /* 吃一个 */ if (apples.length) { var ap = apples[0]; p.dir = { x: 1, y: 0 }; p.body = [{ x: ap.x - 1, y: ap.y }, { x: ap.x - 2, y: ap.y }]; p.hp = [2, 2]; p.acc = p.stepMs; p.alive = true; step(p, gameNow); } var afterEat = apples.length; /* 走一间再回来（清过的房） */ var pt = room.portals[0]; room.cleared = true; p.body = [{ x: pt.x, y: pt.y }, { x: pt.x, y: pt.y }]; p.hp = [2, 2]; p.alive = true; gameNow = gameNow + 400; updateRooms(gameNow); gameNow = gameNow + 400; var back = null; for (var i = 0; i < room.portals.length; i++) if (room.portals[i].to === at) back = room.portals[i]; var returned = "没回去"; if (back) { room.cleared = true; p.body = [{ x: back.x, y: back.y }, { x: back.x, y: back.y }]; updateRooms(gameNow); returned = "回去了 i=" + roomRun.i + " 苹果 " + apples.length + " 冻结 " + applesFrozen(); } var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "第一次进 " + JSON.stringify(first) + " / 吃一个后 " + afterEat + " 个 / 再回来：" + returned + " / " + err;'); });

    step('chat-feed', function () { return ev(w, 'netLeave(); chatLog.length = 0; var feed = document.getElementById("chatFeed"); var btn = document.getElementById("chatBtn"); var bar = document.getElementById("chatBar"); chatPush("阿猫", "第一条", false); chatPush("我", "第二条", true); renderChat(); var closed = { feedHidden: feed.hidden, barHidden: bar.hidden, rows: feed.children.length }; btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); var opened = { feedHidden: feed.hidden, barHidden: bar.hidden }; btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); var again = { feedHidden: feed.hidden, barHidden: bar.hidden }; "有消息+面板收起：小窗显示 " + (!closed.feedHidden) + " 面板藏 " + closed.barHidden + "（" + closed.rows + " 行）/ 打开面板：小窗隐藏 " + opened.feedHidden + " 面板显示 " + (!opened.barHidden) + " / 再收起：小窗显示 " + (!again.feedHidden) + " 面板藏 " + again.barHidden;'); });

    step('chat-commands', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; var log = []; var lastMsg = function () { return chatLog.length ? chatLog[chatLog.length - 1].text : "(空)"; }; /* 没开作弊就想用 -> 拒绝 */ chatSendText("/god"); log.push("未开作弊 /god -> " + lastMsg()); /* 开作弊 */ chatSendText("/cheats 1"); log.push("/cheats 1 -> " + lastMsg()); /* 别名 */ chatSendText("/sv_cheats 1"); var alias = lastMsg(); /* 无敌 */ chatSendText("/god"); var godOn = levelCfg.safeWall; var before = p.body.length; crashPlayer(p, 3, gameNow); var afterGod = { alive: p.alive, len: p.body.length }; /* 改长度/速度 */ chatSendText("/len 6"); log.push("/len 6 -> 长 " + p.body.length + "、回复 " + lastMsg()); chatSendText("/speed 120"); log.push("/speed 120 -> 步长 " + players[0].stepMs + "、回复 " + lastMsg()); /* 道具 */ chatSendText("/give team"); log.push("/give team -> 场上 " + powerUps.team.length + " 个、回复 " + lastMsg()); /* 普通消息里的 // 不当作指令 */ var before2 = chatLog.length; chatSendText("//不是指令"); log.push("// 消息 -> " + (chatLog[chatLog.length - 1].text) + "（是普通消息 " + (chatLog[before2].name !== "系统") + "）"); /* 关作弊后又被拒绝 */ chatSendText("/cheats 0"); chatSendText("/god"); var off = { god: levelCfg.safeWall || levelCfg.safeSnake || levelCfg.safeBullet, msg: lastMsg() }; log.push("/cheats 0 后 /god -> " + off.msg); "/cheats 1 = " + log[1] + " / 别名 = " + alias + " / 无敌 " + godOn + " 撞后 " + JSON.stringify(afterGod) + " / " + log.slice(2, 5).join(" / ") + " / " + log[5] + " / " + log[6] + " / /help 行数 " + (function () { chatSendText("/help"); return chatLog.filter(function (m) { return m.name === "系统"; }).length; })();'); });

    step('god-no-stuck', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; svCheats = true; levelCfg.safeWall = true; levelCfg.safeSnake = true; levelCfg.safeBullet = true; state = "running"; p.body = []; for (var k = 0; k < 6; k++) p.body.push({ x: 1 + k, y: 5 }); p.hp = new Array(6).fill(2); p.dir = { x: -1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = levelCfg.stepMs; p.blocked = false; /* 在半步进度里检查画面头的位置：应该原地不动 */ var samples = []; for (var f = 0; f < 5; f++) { p.acc = p.stepMs * (f / 4) * 0.9; var pts = buildPath(p.body, p.dir, progress(p), true); samples.push(((pts[0].x + camX - renderOffsetX) / CELL).toFixed(2)); } var headX = p.body[0].x; /* 撞墙后也一样 */ p.acc = p.stepMs; step(p, gameNow); var after = []; for (var f2 = 0; f2 < 5; f2++) { p.acc = p.stepMs * (f2 / 4) * 0.9; var pts2 = buildPath(p.body, p.dir, progress(p2 || p), true); after.push(((pts2[0].x + camX - renderOffsetX) / CELL).toFixed(2)); } "头和墙差 " + headX + " 格 / 撞墙前五帧画面头的位置：" + samples.join(" ") + " / 撞墙后：" + after.join(" ") + "（都应该是同一个数 = 0.50）";'); });

    step('god-pass-through', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; svCheats = true; levelCfg.safeWall = true; levelCfg.safeSnake = true; levelCfg.safeBullet = true; state = "running"; p.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]; p.hp = [2, 2]; p.dir = { x: 1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = levelCfg.stepMs; p.blocked = false; /* 正前方放一堵敌人身体 */ enemies = [{ kind: "purple", body: [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }], hp: [2, 2, 2], dir: { x: 1, y: 0 }, acc: 0, baseStepMs: 600, stepMs: 600, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }]; var seq = []; for (var s = 0; s < 4; s++) { p.acc = p.stepMs; step(p, gameNow); seq.push("头 " + p.body[0].x + " blocked=" + !!p.blocked + " progress=" + progress(p).toFixed(2)); } var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "穿过敌人身体 4 步：" + seq.join(" | ") + " / 还活着 " + p.alive + " / " + err;'); });

    step('turn-latency', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; state = "running"; p.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }]; p.hp = [2, 2, 2]; p.dir = { x: 1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = 300; p.blocked = false; enemies = []; apples = []; var shown = function () { var pts = buildPath(p.body, p.dir, progress(p), true); return ((pts[0].x + camX - renderOffsetX) / CELL).toFixed(2) + "/" + ((pts[0].y + camY - renderOffsetY) / CELL).toFixed(2); }; var log = []; var maxJump = 0, prev = null; for (var f = 0; f < 14; f++) { if (f === 5) turn(p, "up"); p.acc += 60; while (p.acc >= p.stepMs) { p.acc -= p.stepMs; step(p, gameNow); gameNow += p.stepMs; } var xy = shown(); var parts = xy.split("/"); if (prev) { var jump = Math.hypot(parts[0] - prev[0], parts[1] - prev[1]); if (Math.abs(jump - 0.5) > 0.55 && jump > 0.9) maxJump = Math.max(maxJump, jump); } prev = [Number(parts[0]), Number(parts[1])]; log.push(f + ":" + xy + " 向" + p.dir.x + "," + p.dir.y); } log.join(" | ") + " / 最大单帧跳变 " + (Math.round(maxJump * 100) / 100) + " 格（应 < 1）";'); });

    step('god-turn-near-enemy', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; levelCfg.safeWall = true; levelCfg.safeSnake = true; levelCfg.safeBullet = true; state = "running"; p.body = [{ x: 5, y: 8 }, { x: 4, y: 8 }, { x: 3, y: 8 }]; p.hp = [2, 2, 2]; p.dir = { x: 1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = 300; p.blocked = false; /* 正前方就是敌人身体（截图那种） */ enemies = [{ kind: "purple", body: [{ x: 6, y: 8 }, { x: 6, y: 7 }, { x: 6, y: 6 }], hp: [2, 2, 2], dir: { x: 0, y: -1 }, acc: 0, baseStepMs: 99999, stepMs: 99999, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }]; var log = []; var paused = 0; for (var f = 0; f < 14; f++) { if (f === 2) turn(p, "up"); p.acc += 60; while (p.acc >= p.stepMs) { p.acc -= p.stepMs; step(p, gameNow); gameNow += p.stepMs; } if (p.blocked) paused++; log.push(f + ":头" + p.body[0].x + "," + p.body[0].y + " 向" + p.dir.x + "," + p.dir.y + " 进度" + progress(p).toFixed(2) + (p.blocked ? "【挡】" : "")); } log.join(" | ") + " / 被挡帧数 " + paused + "（应为 0）";'); });

    step('no-crash-preset', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var dodge = LEVEL_PRESETS.filter(function (p) { return p.id === "dodge"; })[0]; applyPresetCfg(dodge.cfg, "弹幕场"); start(1); var p = players[0]; p.invUntil = 0; levelCfg.safeWall = false; levelCfg.safeSnake = false; levelCfg.safeBullet = false; state = "running"; var flag = levelCfg.noCrash; /* 1) 撞自己身体：穿过去 */ p.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 5, y: 5 }]; p.hp = new Array(5).fill(1); p.dir = { x: 0, y: 1 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = levelCfg.stepMs; p.blocked = false; enemies = []; apples = []; turrets = []; bullets = []; var self = []; for (var i = 0; i < 2; i++) { p.acc = p.stepMs; step(p, gameNow); self.push("头" + p.body[0].x + "," + p.body[0].y + (p.alive ? "" : "死")); } /* 2) 撞墙：被挡住但不死 */ p.body = [{ x: 0, y: 5 }, { x: 1, y: 5 }]; p.hp = [1, 1]; p.dir = { x: -1, y: 0 }; p.acc = p.stepMs; step(p, gameNow); var wall = { alive: p.alive, head: p.body[0].x + "," + p.body[0].y, blocked: !!p.blocked }; /* 3) 子弹：会死 */ p.body = [{ x: 10, y: 10 }, { x: 9, y: 10 }]; p.hp = [1, 1]; p.alive = true; p.invUntil = 0; bullets = [{ x: 10, y: 10, dx: 0, dy: 0, dmg: 1, from: "turret", life: 1 }]; var hit = "没测"; try { var bulletRes = updateBullets ? "有函数" : "无"; } catch (e) { } /* 直接打身体：damageBody */ var dmg = damageBody(p.body, p.hp, 0, gameNow, 1); if (dmg) killPlayer(p, gameNow); var shot = { alive: p.alive }; "碰撞不死开关 " + flag + " / 撞自己身体：" + self.join(" ") + " / 撞墙：" + JSON.stringify(wall) + " / 中弹：" + JSON.stringify(shot);'); });

    step('omni-turret', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var dodge = LEVEL_PRESETS.filter(function (p) { return p.id === "dodge"; })[0]; applyPresetCfg(dodge.cfg, "弹幕场"); start(1); var omni = turrets.filter(function (t) { return t.omni; }); var info = function () { return omni.map(function (t) { return "@" + t.x + "," + t.y + " dmg" + t.dmg; }).join(" "); }; bullets = []; var before = bullets.length; gameNow = gameNow + 2000; updateTurrets(gameNow); var after = bullets.length; var sample = bullets.slice(0, 8).map(function (b) { return Math.round(Math.atan2(b.vy, b.vx) * 180 / Math.PI); }); /* 再等一轮 */ var firstRound = after; gameNow = gameNow + 1000; updateTurrets(gameNow); var second = bullets.length; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "全向炮塔 " + omni.length + " 座：" + info() + " / 第一个 900ms 后子弹 " + before + " -> " + after + " 发（方向 " + sample.join(",") + "°）/ 再过一轮 -> " + second + " 发 / " + err;'); });

    step('omni-center-godsplit', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var dodge = LEVEL_PRESETS.filter(function (p) { return p.id === "dodge"; })[0]; applyPresetCfg(dodge.cfg, "弹幕场"); start(1); var p = players[0]; p.invUntil = 0; var omni = turrets.filter(function (t) { return t.omni; }); var center = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) }; var first = omni[0] ? { x: omni[0].x, y: omni[0].y } : null; var atCenter = first && first.x === center.x && first.y === center.y; /* 玩家站在炮塔子弹路径上：应该被打 */ p.body = [{ x: center.x + 3, y: center.y }, { x: center.x + 4, y: center.y }]; p.hp = [1, 1]; p.alive = true; p.invUntil = 0; bullets = [{ from: "player", owner: null, omni: true, dmg: 1, homing: 0, x: center.x + 3, y: center.y, vx: 0, vy: 0 }]; levelCfg.safeBullet = false; updateBullets(0.016, gameNow); var hurt = !p.alive; /* 开了 /god bullet 之后不该再被打 */ p.body = [{ x: center.x + 3, y: center.y }, { x: center.x + 4, y: center.y }]; p.hp = [1, 1]; p.alive = true; p.invUntil = 0; levelCfg.safeBullet = true; bullets = [{ from: "player", owner: null, omni: true, dmg: 1, homing: 0, x: center.x + 3, y: center.y, vx: 0, vy: 0 }]; updateBullets(0.016, gameNow); var saved = p.alive; levelCfg.safeBullet = false; /* /god 分开关 */ svCheats = true; chatSendText("/god"); var st0 = chatLog[chatLog.length - 1].text; chatSendText("/god wall"); var st1 = chatLog[chatLog.length - 1].text; chatSendText("/god bullet"); var st2 = chatLog[chatLog.length - 1].text; chatSendText("/god all"); var st3 = chatLog[chatLog.length - 1].text; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "场地 " + COLS + "x" + ROWS + "、中心 " + center.x + "," + center.y + " / 全向炮塔 " + omni.length + " 座、第一座在中心 " + atCenter + " / 无差别子弹打玩家 -> 掉血死 " + hurt + " / 开 /god 后 -> 活着 " + saved + " / 指令：" + st0 + " || " + st1 + " || " + st2 + " || " + st3 + " / " + err;'); });

    step('dodge-hp', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var dodge = LEVEL_PRESETS.filter(function (p) { return p.id === "dodge"; })[0]; applyPresetCfg(dodge.cfg, "弹幕场"); start(1); var p = players[0]; p.invUntil = 0; levelCfg.safeBullet = false; p.body = [{ x: 10, y: 10 }, { x: 9, y: 10 }]; p.hp = [levelCfg.hp0, levelCfg.hp0]; p.alive = true; var hits = function (n) { for (var i = 0; i < n; i++) { if (!p.alive) break; bullets = [{ from: "player", owner: null, omni: true, dmg: levelCfg.omniDmg, homing: 0, x: 10, y: 10, vx: 0, vy: 0 }]; updateBullets(0.016, gameNow); } return { alive: p.alive, hp: p.hp[0] }; }; var h1 = hits(1), h2 = hits(1), h3 = hits(1); "每节血量 " + levelCfg.hp0 + "、子弹伤害 " + levelCfg.omniDmg + " / 中 1 发 -> " + JSON.stringify(h1) + " / 中 2 发 -> " + JSON.stringify(h2) + " / 中 3 发 -> " + JSON.stringify(h3);'); });

    step('room-revive', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); var p = players[0]; p.invUntil = 0; /* 捡复活道具 */ roomRun.revives = 0; reviveItem = { x: p.body[0].x + 1, y: p.body[0].y, at: nowRef }; p.dir = { x: 1, y: 0 }; p.queue = []; p.acc = p.stepMs; step(p, gameNow); var picked = { revives: roomRun.revives, item: !!reviveItem }; /* 死一次：应该自动复活 */ p.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]; p.hp = [2, 2]; p.alive = true; p.invUntil = 0; killPlayer(p, gameNow); var rev1 = { alive: p.alive, revives: roomRun.revives, len: p.body.length, inv: Math.round(p.invUntil - gameNow) }; /* 再死一次：没次数了，真死 */ killPlayer(p, gameNow); var rev2 = { alive: p.alive, revives: roomRun.revives }; var tag = document.getElementById("roomTag") ? document.getElementById("roomTag").textContent : "?"; "捡道具后 " + JSON.stringify(picked) + " / 第一次死 -> " + JSON.stringify(rev1) + " / 第二次死 -> " + JSON.stringify(rev2) + " / HUD「" + tag + "」";'); });

    step('turn-180', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; state = "running"; p.body = [{ x: 0, y: 6 }, { x: 1, y: 6 }, { x: 2, y: 6 }]; p.hp = [2, 2, 2]; p.dir = { x: -1, y: 0 }; p.queue = []; p.acc = 0; p.alive = true; p.stepMs = 240; p.blocked = false; enemies = []; apples = []; var log = []; /* 顶墙一步 */ p.acc = p.stepMs; step(p, gameNow); log.push("顶墙后 blocked=" + !!p.blocked + " 头=" + p.body[0].x + " 队列=" + p.queue.length + " 向=" + p.dir.x + "," + p.dir.y); /* 按上 */ turn(p, "up"); log.push("按上后 队列=" + p.queue.length + "（应 1）"); p.acc = p.stepMs; step(p, gameNow); log.push("再走一步 头=" + p.body[0].x + "," + p.body[0].y + " 向=" + p.dir.x + "," + p.dir.y + "（应往上了）"); /* 再按左（反向，朝墙） */ turn(p, "left"); log.push("按左后 队列=" + p.queue.length + "（应 0）"); log.join(" | ");'); });

    step('emerge-smooth', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; state = "running"; /* 出洞 4 个阶段：量身体画出来的长度 */ var lens = []; for (var f = 0; f < 8; f++) { p.acc = p.stepMs * (f % 4) / 4; if (f % 4 === 0 && f > 0) step(p, gameNow); var pts = buildPath(p.body, p.dir, progress(p), true, emergeGrow(p)); lens.push("帧" + f + " 长" + p.body.length + " 点数" + pts.length); } var maxGap = 0; var ptsA = buildPath(p.body, p.dir, progress(p), true, emergeGrow(p)); for (var i = 1; i < ptsA.length; i++) { maxGap = Math.max(maxGap, Math.hypot(ptsA[i].x - ptsA[i - 1].x, ptsA[i].y - ptsA[i - 1].y) / CELL); } lens.join(" | ") + " / 路径最大间距 " + (Math.round(maxGap * 100) / 100) + " 格";'); });

    step('block-same-anim', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var p = players[0]; p.invUntil = 0; state = "running"; levelCfg.safeWall = true; /* 边界墙 */ p.body = [{ x: 0, y: 8 }, { x: 1, y: 8 }]; p.hp = [2, 2]; p.dir = { x: -1, y: 0 }; p.acc = p.stepMs * 0.6; p.blocked = false; var edge = { flag: blockedAhead(p), prog: progress(p) }; /* 石头 */ walls = [{ x: 6, y: 8 }]; p.body = [{ x: 5, y: 8 }, { x: 4, y: 8 }]; p.dir = { x: 1, y: 0 }; p.acc = p.stepMs * 0.6; var stone = { flag: blockedAhead(p), prog: progress(p) }; /* 撞石头实际走一步：应该被挡住、头不动 */ p.body = [{ x: 5, y: 8 }, { x: 4, y: 8 }]; p.hp = [2, 2]; p.queue = []; p.alive = true; p.emergeLeft = 0; p.acc = p.stepMs; step(p, gameNow); var hitStone = { head: p.body[0].x + "," + p.body[0].y, blocked: !!p.blocked, alive: p.alive }; /* 空旷 */ walls = []; p.body = [{ x: 5, y: 8 }, { x: 4, y: 8 }]; p.acc = p.stepMs * 0.5; var free = progress(p); "边界墙 " + JSON.stringify(edge) + " / 石头 " + JSON.stringify(stone) + " / 撞石头一步后 " + JSON.stringify(hitStone) + " / 空旷 " + free.toFixed(2);'); });

    step('dodge-map-size', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var dodge = LEVEL_PRESETS.filter(function (p) { return p.id === "dodge"; })[0]; applyPresetCfg(dodge.cfg, "弹幕场"); start(1); var omni = turrets.filter(function (t) { return t.omni; }); var center = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) }; var first = omni[0]; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "场地 " + COLS + "x" + ROWS + "（" + (COLS * ROWS) + " 格）/ 全向炮塔 " + omni.length + " 座：" + omni.map(function (t) { return "@" + t.x + "," + t.y; }).join(" ") + " / 其中一座在中心 " + (first && first.x === center.x && first.y === center.y) + " / " + err;'); });

    step('red-spawn-bend', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); enemies = []; var ok = 0, lens = [], bends = 0; for (var i = 0; i < 12; i++) { enemies = []; var made = spawnEnemy(gameNow, "red"); if (!made || !enemies.length) continue; var e = enemies[enemies.length - 1]; var b = e.body; lens.push(b.length); /* 判断有没有拐弯：相邻点方向变过一次就算弯 */ var prevD = null, turns = 0; for (var k = 1; k < b.length; k++) { var dx = b[k].x - b[k - 1].x, dy = b[k].y - b[k - 1].y; var d = dx + "," + dy; if (prevD !== null && d !== prevD) turns++; prevD = d; } if (turns > 0) bends++; ok++; } "红蛇出生 " + ok + " 次：长度 " + lens.join(",") + " / 带弯折的次数 " + bends + " / 定义长度 " + ENEMY_KINDS.red.len;'); });

    step('boss-volley', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); enemies = []; bullets = []; runStartAt = gameNow - 999999; var made = spawnEnemy(gameNow, "boss"); var e = enemies[enemies.length - 1]; var st = { kind: e ? e.kind : "无", len: e ? e.body.length : 0, wide: e ? enemyDef(e).wide : 0, gunEvery: e ? enemyDef(e).gunEvery : 0, gunDirs: e ? enemyDef(e).gunDirs : 0 }; /* 开一轮火 */ var n = e ? fireBossVolley(e, gameNow) : 0; var dirs = {}; for (var i = 0; i < bullets.length; i++) { var a = Math.round(Math.atan2(bullets[i].vy, bullets[i].vx) * 180 / Math.PI); dirs[a] = (dirs[a] || 0) + 1; } var err = "画一帧没炸"; try { render(); } catch (e2) { err = e2.message; } "BOSS " + JSON.stringify(st) + " / 一轮射出 " + n + " 发（" + (e ? Math.floor((e.body.length - 1) / 3) : 0) + " 个炮口 × " + st.gunDirs + " 方向）/ 方向种类 " + Object.keys(dirs).length + " / " + err;'); });

    step('rogue-boss-floor', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); setCfg({ rooms: 5 }); start(1); var p = players[0]; p.invUntil = 0; var bossIdx = roomRun.boss; var bossCell = roomRun.rooms[bossIdx]; /* 直接进 BOSS 房 */ rogueEnter(bossIdx, "e"); var st = { kind: room.kind, enemies: enemies.map(function (e) { return e.kind; }), cleared: room.cleared, floor: roomRun.floor }; /* 把 BOSS 打死 */ enemies = []; gameNow = gameNow + 400; updateRooms(gameNow); var after = { cleared: room.cleared, stairs: room.stairs ? room.stairs.x + "," + room.stairs.y : "无", doorsOpen: (room.portals || []).every(function (x) { return x.open; }) }; /* 踩楼梯 */ gameNow = gameNow + 400; p.body = [{ x: room.stairs.x, y: room.stairs.y }, { x: room.stairs.x - 1, y: room.stairs.y }]; p.hp = [2, 2]; p.alive = true; if (p.queue) p.queue = []; updateRooms(gameNow); var next = { floor: roomRun.floor, i: roomRun.i, total: roomRun.total, kind: room.kind, boss: roomRun.boss }; var err = "画一帧没炸"; try { render(); } catch (e) { err = e.message; } "BOSS 房（第 " + (bossIdx + 1) + " 间，depth " + bossCell.depth + "）-> " + JSON.stringify(st) + " / 清掉后 " + JSON.stringify(after) + " / 踩楼梯后 " + JSON.stringify(next) + " / " + err;'); });

    step('cmd-boss', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var rogue = LEVEL_PRESETS.filter(function (p) { return p.id === "rogue"; })[0]; applyPresetCfg(rogue.cfg, "x"); start(1); svCheats = true; var p = players[0]; p.invUntil = 0; chatSendText("/boss"); var at = { kind: room.kind, i: roomRun.i, boss: roomRun.boss, enemies: enemies.map(function (e) { return e.kind; }), msg: chatLog[chatLog.length - 1].text }; /* 真的关掉房间模式 */ setCfg({ rooms: 0 }); showMenu(); start(1); chatSendText("/boss"); var nonRoom = chatLog[chatLog.length - 1].text; var inRoom = !!room; /* 没开作弊 */ svCheats = false; applyPresetCfg(rogue.cfg, "x"); start(1); chatSendText("/boss"); var noCheat = chatLog[chatLog.length - 1].text; "传送到 " + JSON.stringify(at) + " / 普通模式（房间 " + inRoom + "）-> " + nonRoom + " / 没开作弊 -> " + noCheat;'); });

    step('editor-knobs', function () { return ev(w, 'netLeave(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var keys = ["reviveStart", "chestRate", "supplyRate", "bossRate", "omniMax", "omniDmg", "noCrash", "safeWall", "safeSnake", "safeBullet", "revive"]; var inFields = keys.map(function (k) { return k + ":" + (LEVEL_FIELDS.some(function (f) { return f.key === k; }) ? "有" : "缺"); }).join(" "); /* 概率开关生效 */ setCfg({ chestRate: 100, supplyRate: 0 }); start(1); var kinds = {}; for (var s = 1; s <= 40; s++) { var plan = rogueRoomPlan(rndSeedFrom(s), 3, 6); kinds[plan.kind] = (kinds[plan.kind] || 0) + 1; } setCfg({ chestRate: 0, supplyRate: 100 }); start(1); var kinds2 = {}; for (var s2 = 1; s2 <= 40; s2++) { var pl2 = rogueRoomPlan(rndSeedFrom(s2), 3, 6); kinds2[pl2.kind] = (kinds2[pl2.kind] || 0) + 1; } setCfg({ reviveStart: 3 }); start(1); var rev = roomRun.revives; "编辑器字段：" + inFields + " / 宝箱 100% 时出现的种类 " + JSON.stringify(kinds) + " / 补给 100% 时 " + JSON.stringify(kinds2) + " / reviveStart=3 开局复活 " + rev;'); });

    step('obstacles', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; levelCfg.obstacleRate = 0; start(1); var p = players[0]; p.invUntil = 0; levelCfg.cutWall = 0; levelCfg.safeWall = false; levelCfg.noCrash = false; levelCfg.safeSnake = false; levelCfg.safeBullet = false; walls = [{ x: 6, y: 5 }]; p.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]; p.hp = [2, 2]; p.dir = { x: 1, y: 0 }; p.queue = []; p.alive = true; p.emergeLeft = 0; p.acc = p.stepMs; step(p, gameNow); var dead = { alive: p.alive, state: state, blocked: !!p.blocked }; /* 安全开关 */ resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; levelCfg.obstacleRate = 10; levelCfg.safeWall = true; start(1); var w1 = walls.length; var q = players[0]; q.invUntil = 0; walls = [{ x: 6, y: 5 }]; q.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]; q.hp = [2, 2]; q.dir = { x: 1, y: 0 }; q.queue = []; q.alive = true; q.emergeLeft = 0; q.acc = q.stepMs; step(q, gameNow); var blocked = { alive: q.alive, head: q.body[0].x + "," + q.body[0].y, blocked: !!q.blocked }; resetLevelCfg(); "撞石头（cutWall=0）-> " + JSON.stringify(dead) + "（应 alive false / state over）/ 10% 生成 " + w1 + " 块 / 安全开关 -> " + JSON.stringify(blocked);'); });

    step('obstacles-on-widen', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; levelCfg.obstacleRate = 0; start(1); walls = [{ x: 6, y: 5 }, { x: 2, y: 3 }]; var before = walls.map(function (w) { return w.x + "," + w.y; }); var c0 = COLS, r0 = ROWS; beginResize(c0 + 2, r0 + 2, 1, 1, gameNow); var after = walls.map(function (w) { return w.x + "," + w.y; }); var shifted = before.every(function (s, i) { var p = s.split(",").map(Number); return after[i] === (p[0] + 1) + "," + (p[1] + 1); }); /* 开障碍物再试一次：旧石头全位移、新石头只在外圈 */ resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; levelCfg.obstacleRate = 10; start(1); var w0 = walls.map(function (w) { return w.x + "," + w.y; }); var n0 = walls.length, cc = COLS, rr = ROWS; beginResize(cc + 2, rr + 2, 1, 1, gameNow); var moved = walls.slice(0, n0).every(function (w, i) { var p = w0[i].split(",").map(Number); return w.x === p[0] + 1 && w.y === p[1] + 1; }); var fresh = walls.slice(n0).filter(function (w) { return w.x >= 1 && w.x < 1 + cc && w.y >= 1 && w.y < 1 + rr; }).length; "定点位移 " + before.join(" ") + " -> " + after.join(" ") + "（全 +1,+1 " + shifted + "）/ 开障碍物时旧石头随世界位移 " + moved + "、新增 " + (walls.length - n0) + " 块（落在旧区域 " + fresh + "，应 0）";'); });

    step('obstacles-ai-bullets', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var fly = function (hasStone) { walls = hasStone ? [{ x: 8, y: 5 }] : []; bullets = [{ from: "enemy", owner: null, dmg: 1, homing: 0, x: 5.5, y: 5.5, vx: 12, vy: 0 }]; var xs = []; for (var f = 0; f < 20; f++) { updateBullets(0.02, gameNow); xs.push(bullets.length ? Math.floor(bullets[0].x) : "没"); if (!bullets.length) break; } return { trace: xs.join(","), alive: bullets.length, endX: bullets.length ? bullets[0].x.toFixed(2) : "消失" }; }; var withStone = fly(true); var noStone = fly(false); walls = [{ x: 7, y: 5 }]; var enemy = { kind: "purple", body: [{ x: 6, y: 5 }, { x: 5, y: 5 }], hp: [2, 2], dir: { x: 1, y: 0 }, acc: 0, baseStepMs: 500, stepMs: 500, spawnAt: 0, boostUntil: 0, shootAt: 1e9 }; enemies = [enemy]; var chose = enemyChooseDir(enemy); "有石头：" + JSON.stringify(withStone) + " / 没石头：" + JSON.stringify(noStone) + " / 敌人朝向 " + chose.x + "," + chose.y;'); });

    step('nothing-on-walls', function () { return ev(w, 'netLeave(); resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; levelCfg.obstacleRate = 10; start(1); var p = players[0]; p.invUntil = 0; /* 把同一批石头固定下来，连续刷一堆东西 */ var n = 0, bad = 0; walls = []; for (var i = 0; i < 30; i++) walls.push({ x: (i * 7) % COLS, y: (i * 11) % ROWS }); var onWall = function (o) { return walls.some(function (w) { return w.x === o.x && w.y === o.y; }); }; /* 刷苹果 */ for (var a = 0; a < 40; a++) spawnApple(); apples.forEach(function (o) { n++; if (onWall(o)) bad++; }); /* 刷道具 */ for (var k = 0; k < POWER_KINDS.length; k++) { for (var t = 0; t < 6; t++) spawnPowerUp(POWER_KINDS[k]); } POWER_KINDS.forEach(function (kind) { powerList(kind).forEach(function (o) { n++; if (onWall(o)) bad++; }); }); /* 敌人 */ for (var e = 0; e < 10; e++) spawnEnemy(gameNow, "purple"); enemies.forEach(function (en) { en.body.forEach(function (o) { n++; if (onWall(o)) bad++; }); }); /* 全向炮塔 */ levelCfg.omniMax = 4; spawnOmniTurrets(); turrets.forEach(function (o) { n++; if (onWall(o)) bad++; }); var err = "画一帧没炸"; try { render(); } catch (e2) { err = e2.message; } "石头 " + walls.length + " 块 / 检查 " + n + " 个物体，落在石头上 " + bad + " 个（应 0）/ " + err;'); });

    step('hold-to-move', function () { return ev(w, 'netLeave(); heldDirs.up = heldDirs.down = heldDirs.left = heldDirs.right = false; resetLevelCfg(); levelCfg.cols = 0; levelCfg.rows = 0; start(1); var survive = LEVEL_PRESETS.filter(function (p) { return p.id === "survive"; })[0]; applyPresetCfg(survive.cfg, "生存"); start(1); var p = players[0]; p.invUntil = 0; state = "running"; var tick = function (dtMs) { if (levelCfg.holdToMove) { var held = heldDirs.up || heldDirs.down || heldDirs.left || heldDirs.right; if (held) { p.holding = false; } else if (p.holding) { } else if (p.acc > p.stepMs * 0.15) { p.holding = true; } else { if (p.wantDir && (p.wantDir.x !== p.dir.x || p.wantDir.y !== p.dir.y)) p.dir = p.wantDir; if (p.queue && p.queue.length) p.dir = p.queue.shift(); p.acc = 0; return; } } p.acc += Math.min(dtMs, p.stepMs); while (p.acc >= p.stepMs && state === "running" && p.alive) { p.acc -= p.stepMs; step(p, gameNow); gameNow += p.stepMs; if (p.holding) { p.holding = false; p.acc = 0; break; } if (levelCfg.holdToMove && p.wantDir && (p.wantDir.x !== p.dir.x || p.wantDir.y !== p.dir.y)) p.dir = p.wantDir; } }; /* 按住右走几步，然后切到「上」并一直按住 */ heldDirs.right = true; for (var i = 0; i < 8; i++) tick(60); var x0 = p.body[0].x, y0 = p.body[0].y; turn(p, "up"); heldDirs.up = true; heldDirs.right = false; var stepsRight = 0; var trace = []; for (var j = 0; j < 40; j++) { tick(60); if (p.body[0].y === y0 && p.body[0].x !== x0) { stepsRight++; x0 = p.body[0].x; } trace.push(p.body[0].x + "," + p.body[0].y); } "切换时的头 " + p.body[0].x + "," + p.body[0].y + " / 切换后仍向右走的格数 " + stepsRight + "（应 ≤1）/ 轨迹 " + trace.join(" -> ");'); });


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
