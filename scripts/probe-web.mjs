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
const WAIT = Number(opt('--wait', '7000'));
const BASE = 'http://127.0.0.1:' + PORT;
const DIST = join(root, 'dist');

const WEB_FILES = [
    'assets/config.js', 'assets/state.js', 'assets/net.js',
    'assets/game.js', 'assets/render.js', 'assets/input.js', 'assets/net-session.js',
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
