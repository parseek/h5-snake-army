// 打一个「可以直接丢给 Netlify」的包：release/netlify/（目录）+ release/netlify-<版本>.zip。
//
// 用途：在线版是 GitHub 仓库 → Netlify 自动构建。如果只想手动更新线上那一份，
// 可以直接把 release/netlify/ 这个目录（或那个 zip）拖到 Netlify 的 Deploys 页面，
// 不用碰 GitHub。
//
// 只放纯前端要的东西：index.html + assets/。Tauri 的 src-tauri/、scripts/、
// lan-host.py 都不进去 —— 线上那份就是打开就能玩。
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'netlify');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// 先让 dist/ 是最新的（sync-web 会重写整个 dist/）
execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ['index.html', 'assets']) {
    cpSync(join(root, 'dist', item), join(out, item), { recursive: true });
}

const zip = join(root, 'release', `netlify-${version}.zip`);
rmSync(zip, { force: true });
// 用系统自带的 tar.exe 打 zip（Windows 10+ 都有）；比 Compress-Archive 稳，
// 而且不会把中文路径搞乱。
execFileSync('tar', ['-a', '-c', '-f', zip, '-C', out, '.'], { stdio: 'inherit' });

function walk(dir, base = dir) {
    let n = 0, bytes = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { const s = walk(p, base); n += s.n; bytes += s.bytes; }
        else { n++; bytes += statSync(p).size; }
    }
    return { n, bytes };
}
const s = walk(out);
console.log(`[pack-netlify] ${relative(root, out)}/ ：${s.n} 个文件，${(s.bytes / 1024).toFixed(1)} KB`);
console.log(`[pack-netlify] ${relative(root, zip)}（把它或那个目录拖到 Netlify 的 Deploys 页面即可）`);
