// 把编译好的 exe 拷一份到项目里的 src-tauri/target/release/，
// 这样不管机器上的 CARGO_TARGET_DIR 指到哪儿，双击运行的路径都是固定的。
//
// 注意：真正的编译产物仍然留在 CARGO_TARGET_DIR（这台机器上是 C:\rust-targets，
// 全机器共享的 85GB 缓存），这里只复制最终 exe，不复制中间产物。
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'src-tauri');
const outDir = join(crate, 'target', 'release');
const exeName = process.platform === 'win32' ? 'snake-army.exe' : 'snake-army';

// 问 cargo 真正的 target 目录在哪（会尊重 CARGO_TARGET_DIR 和 --target-dir 配置）
let targetDir = process.env.CARGO_TARGET_DIR;
if (!targetDir) {
    try {
        const meta = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'],
            { cwd: crate, encoding: 'utf8' });
        targetDir = JSON.parse(meta).target_directory;
    } catch (e) {
        targetDir = join(crate, 'target');
    }
}
if (!isAbsolute(targetDir)) targetDir = resolve(crate, targetDir);

const from = join(targetDir, 'release', exeName);
if (!existsSync(from)) {
    console.error('[pack-exe] 没找到 ' + from);
    console.error('[pack-exe] 先跑一次 npm run build:exe');
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const to = join(outDir, exeName);
copyFileSync(from, to);
console.log('[pack-exe] 来源 ' + from);
console.log('[pack-exe] 已复制 ' + (statSync(to).size / 1048576).toFixed(2) + ' MB -> ' + to);
