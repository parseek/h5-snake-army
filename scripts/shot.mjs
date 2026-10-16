// 用 CDP 驱动一个隔离的无头 Edge：量尺寸 / 跑一段 JS / 截图。
//
// 为什么不继续用 --dump-dom 和 --screenshot：这两个一次性开关在本机突然都不出声了
// （任何页面、任何 --headless 模式都返回空、也不落图，exit 0），
// 而它们都是"再起一个浏览器进程"的路子，出问题时连原因都看不到。
// 走 CDP 就一个进程，看得见状态，还能顺手做手机模拟。
//
// 用法：
//   node scripts/shot.mjs index.html --base http://127.0.0.1:9211 --shot out.png
//   node scripts/shot.mjs index.html --size 390,844 --mobile         手机尺寸 + 触摸模拟
//   node scripts/shot.mjs index.html --eval "document.title"          量点什么
//   node scripts/shot.mjs "_m.html?mode=play" --wait 1500 --shot a.png
//
// 收尾只按「命令行里带本次专属 profile」杀进程，绝不按进程名杀（见 README 验证页面一节）。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = process.argv.slice(2);
const page = args[0];
if (!page) {
    console.error('用法: node scripts/shot.mjs <页面> [--base url] [--size W,H] [--mobile] [--wait ms] [--eval js] [--shot 文件]');
    process.exit(1);
}
function opt(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const base = opt('--base', 'http://127.0.0.1:9211');
const [vw, vh] = opt('--size', '900,1150').split(',').map(Number);
const mobile = args.includes('--mobile');
const waitMs = parseInt(opt('--wait', '900'), 10);
const shot = opt('--shot', '');
const evalJs = opt('--eval', '');
const port = 9000 + Math.floor(Math.random() * 900);

const profile = join(tmpdir(), 'snake-shot-' + process.pid + '-' + Date.now());
mkdirSync(profile, { recursive: true });

function cleanup() {
    try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.CommandLine -and $_.CommandLine.Contains("' + profile + '") ' +
            '-and $_.Name -notin @("powershell.exe","pwsh.exe","conhost.exe") ' +
            '-and $_.ProcessId -ne $PID } | ' +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        ], { stdio: 'ignore' });
    } catch (e) { /* 清理失败不致命 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { }
}

if (!existsSync(EDGE)) { console.error('找不到 Edge: ' + EDGE); process.exit(1); }

const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--window-size=' + vw + ',' + vh,
    'about:blank',
], { stdio: 'ignore' });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
    // 等调试端口起来
    let ver = null;
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch('http://127.0.0.1:' + port + '/json/version');
            if (res.ok) { ver = await res.json(); break; }
        } catch (e) { /* 还没起来 */ }
        await sleep(250);
    }
    if (!ver) throw new Error('调试端口没起来（Edge 没启动？）');
    console.log('[shot] ' + (ver['Browser'] || 'Edge') + '　CDP 端口 ' + port);

    // 开一个 target
    let target = null;
    for (let i = 0; i < 10 && !target; i++) {
        try {
            const res = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' });
            if (res.ok) target = await res.json();
        } catch (e) { /* 再来 */ }
        if (!target) await sleep(250);
    }
    if (!target) throw new Error('开不出 target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')), { once: true });
    });

    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method) {
            events.push(msg.method);
        }
    });
    function call(method, params) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }

    await call('Page.enable');
    await call('Runtime.enable');
    // 精确到逻辑像素的视口；加 --mobile 就连触摸一起模拟（(pointer: coarse) 才会命中）
    await call('Emulation.setDeviceMetricsOverride', {
        width: vw, height: vh, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile,
    });
    if (mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    await call('Page.navigate', { url: base + '/' + page });
    // 等 load（最多 15 秒）
    for (let i = 0; i < 60; i++) {
        if (events.includes('Page.loadEventFired')) break;
        await sleep(250);
    }
    await sleep(waitMs);

    if (evalJs) {
        const r = await call('Runtime.evaluate', { expression: evalJs, returnByValue: true, awaitPromise: true });
        const val = r && r.result ? r.result.value : undefined;
        console.log('[shot] eval => ' + (typeof val === 'string' ? val : JSON.stringify(val)));
    }

    if (shot) {
        const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(shot, Buffer.from(r.data, 'base64'));
        console.log('[shot] 截图: ' + shot);
    }

    try { await call('Browser.close'); } catch (e) { }
    ws.close();
}

main().then(() => {
    try { child.kill(); } catch (e) { }
    cleanup();
    setTimeout(() => { cleanup(); process.exit(0); }, 800);
}).catch((e) => {
    console.error('[shot] ' + (e && e.message));
    try { child.kill(); } catch (e2) { }
    cleanup();
    process.exit(1);
});
