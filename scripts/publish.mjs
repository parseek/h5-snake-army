// 一键发布：跑一遍探针 -> 提交 -> 推两个远端 -> 构建 Tauri + 打便携包。
//
// 用法（根目录那个 publish.bat 就是包了这个）：
//   publish.bat -m "提交说明"              提交 + 推送 + 构建
//   publish.bat -m "..." --skip-probe      跳过探针（浏览器不可用时）
//   publish.bat -m "..." --no-build        只提交推送，不构建
//   publish.bat --dry-run                  只把要做的事打出来，什么都不改
//
// 设计取舍：
//   * 用 Node 写逻辑、用 .bat 包一层 —— 批处理文件在不同代码页下读中文会乱，
//     所以 .bat 里只有一行 ascii；中文提示都在这里（utf-8）。
//   * 探针放在最前面当闸门：不过就不提交（想强行发再加 --skip-probe）。
//   * 构建前先看有没有正在跑的 snake-army.exe —— 它会锁住编译产物，
//     直接编会报「拒绝访问 (os error 5)」。默认问一句要不要关掉它。
//   * 绝不按进程名杀别的程序：只碰 snake-army.exe（我们自己的桌面版），
//     而且要先问（或 --kill）。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function flag(name) { return args.includes(name); }
function opt(name) {
    const i = args.indexOf(name);
    if (i < 0) return '';
    return args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : '';
}

const DRY = flag('--dry-run');
const SKIP_PROBE = flag('--skip-probe');
const NO_BUILD = flag('--no-build');
const NO_PUSH = flag('--no-push');
const AUTO_KILL = flag('--kill');
const MESSAGE = opt('-m') || opt('--message');
const wf = (s) => process.stdout.write(s);

let failed = 0;
let warned = 0;

function banner(text) {
    console.log('');
    console.log('=== ' + text + ' ' + '='.repeat(Math.max(0, 52 - text.length)));
}

/** 跑一条命令，输出直接透传到控制台；返回退出码。 */
function run(cmd, cmdArgs, opts) {
    const r = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: false, ...(opts || {}) });
    return new Promise((resolve) => {
        r.on('close', (code) => resolve(code === null ? 1 : code));
        r.on('error', (e) => { console.error('  起不来: ' + cmd + ' :: ' + e.message); resolve(127); });
    });
}

// Windows 上 npm / npx / tauri 都是 .cmd 批处理。Node 从 18.20 起出于安全考虑
// 不允许直接 spawn 它们（会 ENOENT 或 EINVAL），所以统一包一层 cmd /c。
// 这里传的都是固定参数（脚本名），不会撞上「参数里有空格」的坑。
const isWin = process.platform === 'win32';

function npmRun(script) {
    return isWin
        ? ['cmd', ['/c', 'npm', 'run', script]]
        : ['npm', ['run', script]];
}

function capture(cmd, cmdArgs) {
    try {
        return execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        return '';
    }
}

function ask(question) {
    if (!process.stdin.isTTY) return Promise.resolve('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (a) => { rl.close(); resolve(String(a || '').trim()); });
    });
}

function human(bytes) {
    return (bytes / 1048576).toFixed(2) + ' MB';
}

async function main() {
    console.log('贪吃蛇 · 一键发布' + (DRY ? '（--dry-run：只说不做）' : ''));
    console.log('仓库: ' + root);

    // ---------- 0. 摸底 ----------
    banner('0/5 先看看现在什么状态');
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    const dirty = capture('git', ['status', '--porcelain']);
    const remotes = (capture('git', ['remote']) || '').split(/\s+/).filter(Boolean);
    const head = capture('git', ['rev-parse', '--short', 'HEAD']);
    console.log('  分支 ' + branch + '，当前提交 ' + (head || '(还没有提交)'));
    console.log('  未提交的改动: ' + (dirty ? dirty.split(/\r?\n/).length + ' 个文件' : '无'));
    console.log('  远端: ' + (remotes.join(', ') || '无'));

    // ---------- 1. 探针 ----------
    banner('1/5 页面探针（回归闸门）');
    if (SKIP_PROBE) {
        console.log('  跳过（--skip-probe）');
    } else if (DRY) {
        // dry-run 也真跑一遍：它只读不写，正好验证这条命令链通不通
        console.log('  跑一遍看看（dry-run 也跑：探针只读，不改任何东西）');
        const [pc0, pa0] = npmRun('probe');
        const c0 = await run(pc0, pa0);
        if (c0 !== 0) {
            warned++;
            console.error('  探针没过 —— 正式跑会在这里停下（想跳过就加 --skip-probe）');
        }
    } else {
        const [pc, pa] = npmRun('probe');
        const code = await run(pc, pa);
        if (code !== 0) {
            failed++;
            console.error('  探针没过 —— 先修好再发（想强行发就加 --skip-probe）');
            return finish();
        }
    }

    // ---------- 2. 提交 ----------
    banner('2/5 提交');
    if (!dirty) {
        console.log('  没有改动，跳过提交');
    } else {
        let msg = MESSAGE;
        if (!msg) {
            if (process.stdin.isTTY && !DRY) {
                msg = await ask('  提交说明（回车用「更新：<时间>」）: ');
            }
            if (!msg) {
                const d = new Date();
                const p = (n) => String(n).padStart(2, '0');
                msg = '更新：' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
            }
        }
        console.log('  说明: ' + msg);
        if (DRY) {
            console.log('  会执行: git add -A && git commit -m "' + msg + '"');
        } else {
            if (await run('git', ['add', '-A']) !== 0) { failed++; console.error('  git add 失败'); return finish(); }
            if (await run('git', ['commit', '-m', msg]) !== 0) { failed++; console.error('  提交失败'); return finish(); }
        }
    }

    // ---------- 3. 推送 ----------
    banner('3/5 推送');
    const targets = [];
    if (NO_PUSH) {
        console.log('  跳过（--no-push）');
    } else {
        if (remotes.includes('origin')) targets.push('origin');
        if (remotes.includes('github')) targets.push('github');
        if (!targets.length) {
            console.log('  没有可推的远端');
            warned++;
        }
        for (const remote of targets) {
            if (DRY) { console.log('  会推 ' + remote + ' ' + branch); continue; }
            console.log('  -> ' + remote);
            const code = await run('git', ['push', remote, branch]);
            if (code !== 0) {
                warned++;
                console.error('  ' + remote + ' 推失败（网络/凭据问题？）。其它步骤继续。');
            }
        }
    }

    // ---------- 4. 构建 ----------
    banner('4/5 构建 Tauri');
    if (NO_BUILD) {
        console.log('  跳过（--no-build）');
    } else {
        if (!existsSync(join(root, 'src-tauri', 'binaries', 'easytier-core.exe'))) {
            console.log('  binaries/ 里没有 easytier-core.exe，先拉一份');
            const [fc, fa] = npmRun('fetch:easytier');
            if (!DRY && await run(fc, fa) !== 0) {
                failed++;
                console.error('  EasyTier 没拉下来，构建中止');
                return finish();
            }
        }
        // 正在跑的桌面版会锁住编译产物
        const running = /snake-army\.exe/i.test(capture('tasklist', ['/FI', 'IMAGENAME eq snake-army.exe', '/NH']));
        if (running) {
            console.log('  检测到 snake-army.exe 正在运行 —— 它会锁住编译产物（os error 5）');
            let kill = AUTO_KILL;
            if (!kill && process.stdin.isTTY && !DRY) {
                kill = /^y/i.test(await ask('  关掉它继续？(y/N) '));
            }
            if (kill) {
                if (DRY) console.log('  会执行: taskkill /IM snake-army.exe /F');
                else {
                    await run('taskkill', ['/IM', 'snake-army.exe', '/F']);
                    console.log('  已关掉（只关我们自己的程序，没碰别的）');
                }
            } else {
                failed++;
                console.error('  没关掉就没法编译。关掉它，或加 --kill 重跑。');
                return finish();
            }
        }
        if (DRY) {
            console.log('  会执行: npm run build:exe && npm run pack:release');
        } else {
            const [bc, ba] = npmRun('build:exe');
            if (await run(bc, ba) !== 0) { failed++; console.error('  编译失败'); return finish(); }
            const [rc2, ra2] = npmRun('pack:release');
            if (await run(rc2, ra2) !== 0) { failed++; console.error('  打包失败'); return finish(); }
        }
    }

    // ---------- 5. 收尾 ----------
    banner('5/5 结果');
    console.log('  提交: ' + (capture('git', ['rev-parse', '--short', 'HEAD']) || '(没变)'));
    console.log('  远端: ' + (targets.length ? targets.join(' / ') : '(没推)') + (warned ? ' —— 有失败的，看上面' : ''));
    for (const f of ['src-tauri/target/release/snake-army.exe', 'release/snake-army-0.1.0-win-x64.zip']) {
        const p = join(root, f);
        if (existsSync(p)) console.log('  ' + f + '  ' + human(statSync(p).size));
    }
    if (!dirty) console.log('  （这次没有新改动）');
    finish();
}

function finish() {
    console.log('');
    if (failed) console.log('结束：有 ' + failed + ' 个步骤失败');
    else if (warned) console.log('结束：完成了，但有 ' + warned + ' 处警告（多半是推送）');
    else console.log('结束：全部完成' + (DRY ? '（这次是 dry-run，什么都没改）' : ''));
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error('出错了: ' + (e && e.message));
    process.exit(1);
});
