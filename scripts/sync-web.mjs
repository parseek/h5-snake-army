// 把「纯前端」的那几个文件拷进 dist/，Tauri 只打包 dist/。
// 根目录保持原样 —— 直接用浏览器打开 index.html 依然能玩，不依赖任何构建。
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const item of ['index.html', 'assets']) {
    const src = join(root, item);
    if (!existsSync(src)) {
        console.error('[sync-web] 缺少 ' + item);
        process.exit(1);
    }
    cpSync(src, join(dist, item), { recursive: true });
}

console.log('[sync-web] 已同步到 dist/：index.html + assets/');
