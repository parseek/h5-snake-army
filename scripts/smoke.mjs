// 安全的无头浏览器验证工具
//
// 为什么要有这个文件：以前验证页面时，临时命令里写过
//
//     Get-Process -Name 'msedge','msedgewebview2' | Stop-Process -Force
//
// 这会把**用户自己的浏览器**连同 Web UI 一起杀掉 —— 表现就是「web ui 有时闪退」。
// 那个「有时」正好对应我跑一次验证。
//
// 这里的规矩：
//   * 每个实例用独立的 --user-data-dir，互不干扰
//   * 收尾只杀「命令行里带这个专属 profile 目录」的进程
//   * 永远不按进程名杀 msedge / msedgewebview2
//
// 用法：
//   node scripts/smoke.mjs _probe.html                启动、等 6 秒、收尾
//   node scripts/smoke.mjs _probe.html --wait 9000    多等一会儿
//   node scripts/smoke.mjs _probe.html --dom          顺带把 DOM 打出来（排错用）
//   node scripts/smoke.mjs _probe.html --shot a.png   截图
//
// 需要先有一个静态服务器把 dist/ 服务出来（默认 http://127.0.0.1:9211）。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const args = process.argv.slice(2);
const page = args[0];
if (!page) {
    console.error('用法: node scripts/smoke.mjs <页面相对路径> [--wait ms] [--dom] [--shot 文件] [--base url]');
    process.exit(1);
}
function opt(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const waitMs = parseInt(opt('--wait', '6000'), 10);
const base = opt('--base', 'http://127.0.0.1:9211');
const wantDom = args.includes('--dom');
const shot = opt('--shot', '');

// 专属 profile：清理时靠它精确识别「这是我起的」
const profile = join(tmpdir(), 'snake-smoke-' + process.pid + '-' + Date.now());
mkdirSync(profile, { recursive: true });

/** 只杀命令行里带这个 profile 目录的进程。绝不按进程名杀。 */
function cleanup() {
    try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.CommandLine -and $_.CommandLine.Contains("' + profile + '") } | ' +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        ], { stdio: 'ignore' });
    } catch (e) { /* 清理失败不致命 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { }
}

if (!existsSync(EDGE)) {
    console.error('找不到 Edge: ' + EDGE);
    process.exit(1);
}

const flags = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars',
    '--user-data-dir=' + profile,
    '--window-size=900,1150',
];
const child = spawn(EDGE, flags.concat([base + '/' + page]), { stdio: 'ignore', detached: false });
console.log('[smoke] 起了一个隔离的无头浏览器 (profile=' + profile + ')');
console.log('[smoke] 页面 ' + base + '/' + page + '，等 ' + waitMs + 'ms');

let exitCode = 0;
setTimeout(() => {
    if (wantDom) {
        try {
            const dom = execFileSync(EDGE, flags.concat([
                '--virtual-time-budget=3000', '--dump-dom', base + '/' + page,
            ]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            console.log('[smoke] ---- DOM ----');
            console.log(dom);
        } catch (e) { console.error('[smoke] --dom 失败: ' + e.message); }
    }
    if (shot) {
        try {
            execFileSync(EDGE, flags.concat([
                '--virtual-time-budget=3000', '--screenshot=' + shot, base + '/' + page,
            ]), { stdio: 'ignore' });
            console.log('[smoke] 截图: ' + shot);
        } catch (e) { console.error('[smoke] 截图失败: ' + e.message); }
    }
    try { child.kill(); } catch (e) { }
    cleanup();
    // 无头浏览器会拉一串子进程，有的起得比第一次清理还晚，所以再补一次
    setTimeout(() => {
        cleanup();
        console.log('[smoke] 已收尾（只清理了本次专属 profile 的进程，没碰你的浏览器）');
        process.exit(exitCode);
    }, 1500);
    return;
}, waitMs);

process.on('SIGINT', () => { cleanup(); process.exit(130); });
