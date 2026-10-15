// 打一个「完整可运行」的便携包：exe + EasyTier 二进制 + 说明。
// 解压就能双击跑，不用安装，也不用另外去下 EasyTier。
//
//   npm run dist
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const base = 'snake-army-' + version + '-win-x64';

const exeName = process.platform === 'win32' ? 'snake-army.exe' : 'snake-army';
const exe = join(root, 'src-tauri', 'target', 'release', exeName);
const bins = join(root, 'src-tauri', 'binaries');

if (!existsSync(exe)) {
    console.error('[pack-release] 没找到 ' + exe);
    console.error('[pack-release] 先跑 npm run build:exe');
    process.exit(1);
}
if (!existsSync(join(bins, 'easytier-core.exe'))) {
    console.error('[pack-release] 没找到 easytier-core.exe');
    console.error('[pack-release] 先跑 npm run fetch:easytier');
    process.exit(1);
}

const outRoot = join(root, 'release');
const dir = join(outRoot, base);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'binaries'), { recursive: true });

copyFileSync(exe, join(dir, exeName));

// 跨网需要的这些，一个都不能少：
//   easytier-core.exe   主程序
//   easytier-cli.exe    排查用（以后也能拿它读对端状态）
//   wintun.dll          虚拟网卡驱动
//   Packet.dll          WinDivert 用户态 DLL —— 少了它 core 直接起不来
//                       （ExitCode 0xC0000135 STATUS_DLL_NOT_FOUND）
//   WinDivert64.sys     UDP 广播转发要的内核驱动
// 只有 web 控制台那两个 20MB+ 的用不上，不带。
for (const f of [
    'easytier-core.exe',
    'easytier-cli.exe',
    'wintun.dll',
    'Packet.dll',
    'WinDivert64.sys',
]) {
    const src = join(bins, f);
    if (existsSync(src)) copyFileSync(src, join(dir, 'binaries', f));
    else console.warn('[pack-release] 少了 ' + f);
}

if (existsSync(join(root, 'README.md'))) copyFileSync(join(root, 'README.md'), join(dir, 'README.md'));

// 压成 zip（Windows 自带 tar 支持 -a 建 zip）
const zip = join(outRoot, base + '.zip');
rmSync(zip, { force: true });
try {
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', outRoot, base], { stdio: 'inherit' });
} catch (e) {
    execFileSync('powershell', ['-NoProfile', '-Command',
        'Compress-Archive -Path "' + dir + '" -DestinationPath "' + zip + '" -Force'], { stdio: 'inherit' });
}
rmSync(dir, { recursive: true, force: true });

console.log('[pack-release] ' + zip + '  ' + (statSync(zip).size / 1048576).toFixed(1) + ' MB');
