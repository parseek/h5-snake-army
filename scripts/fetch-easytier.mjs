// 下载 EasyTier 的 Windows 版，放到 src-tauri/binaries/。
// 走 ghfast.top 镜像，因为不少机器把 github.com 整个 hosts 掉了。
//
//   node scripts/fetch-easytier.mjs            用默认版本
//   node scripts/fetch-easytier.mjs v2.6.5     指定版本
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const VERSION = process.argv[2] || 'v2.6.4';
const MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://github.com/'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'binaries');
const zipPath = join(outDir, 'easytier.zip');
const asset = 'easytier-windows-x86_64-' + VERSION + '.zip';

if (existsSync(join(outDir, 'easytier-core.exe'))) {
    console.log('[fetch-easytier] 已经有了：' + join(outDir, 'easytier-core.exe'));
    process.exit(0);
}

mkdirSync(outDir, { recursive: true });
let ok = false;
for (const m of MIRRORS) {
    const url = m + 'https://github.com/EasyTier/EasyTier/releases/download/' + VERSION + '/' + asset;
    process.stdout.write('[fetch-easytier] 尝试 ' + m + ' ... ');
    try {
        execFileSync('curl', ['-sL', '--max-time', '240', '-o', zipPath, url], { stdio: 'ignore' });
        const size = statSync(zipPath).size;
        if (size > 5 * 1024 * 1024) { console.log((size / 1048576).toFixed(1) + ' MB OK'); ok = true; break; }
        console.log('太小（' + size + ' 字节），换下一个');
    } catch (e) { console.log('失败'); }
}
if (!ok) { console.error('[fetch-easytier] 所有镜像都失败了'); process.exit(1); }

execFileSync('tar', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' });
rmSync(zipPath, { force: true });

// 把文件从子目录挪到 binaries/ 根下
for (const sub of readdirSync(outDir)) {
    const p = join(outDir, sub);
    if (statSync(p).isDirectory()) {
        for (const f of readdirSync(p)) renameSync(join(p, f), join(outDir, f));
        rmSync(p, { recursive: true, force: true });
    }
}
console.log('[fetch-easytier] 完成：' + outDir);
for (const f of readdirSync(outDir)) console.log('  ' + f);
