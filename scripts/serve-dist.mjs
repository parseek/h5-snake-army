// 把 dist/ 用一个极小的静态服务器跑起来（验证页面用，不参与打包）。
//
// 用法：node scripts/serve-dist.mjs [端口] [--dir 目录]     （npm run serve）
//
// 它同时是探针工具 scripts/probe-web.mjs 的服务器实现 —— 探针直接 import
// startServer()，跑完 close()，不另外起子进程：
// 以前用 spawn 起子进程，收尾 kill 的时候 Windows 上会崩在 libuv 的断言里
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，明明测试全过却 exit 1）。
//
// 另外它带一个验证用的小回传口：探针页把结果 POST 到 /__probe，落到
// <dir>/_probe-result.json；GET /__probe 取回来。
// 为什么不用 --dump-dom：dump 走虚拟时间，和真实的 rAF 主循环对不上，
// 探针里等出来的结果读到的永远是「pending」。真实时间 + 回传最稳。
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** 起一个只服务 dir 的静态服务器，返回 { server, url, port, close }。 */
export function startServer(port, dir) {
    const RESULT = join(dir, '_probe-result.json');

    const server = createServer(async (req, res) => {
        try {
            const url = decodeURIComponent((req.url || '/').split('?')[0]);

            if (url === '/__probe') {
                if (req.method === 'POST') {
                    const body = await readBody(req);
                    await writeFile(RESULT, body, 'utf8');
                    console.log('[serve-dist] 收到探针结果 ' + body.length + ' 字节');
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('ok');
                } else {
                    try {
                        const body = await readFile(RESULT, 'utf8');
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                        res.end(body);
                    } catch (e) {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('no result yet');
                    }
                }
                return;
            }

            let file = normalize(join(dir, url));
            if (!file.startsWith(dir)) { res.writeHead(403); res.end('forbidden'); return; }
            try {
                const st = await stat(file);
                if (st.isDirectory()) file = join(file, 'index.html');
            } catch (e) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('not found: ' + url);
                return;
            }
            const body = await readFile(file);
            res.writeHead(200, {
                'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-store',
            });
            res.end(body);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('server error: ' + e.message);
        }
    });

    const url = 'http://127.0.0.1:' + port;
    const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log('[serve-dist] ' + url + '/ 根目录 ' + dir);

    return {
        server,
        url,
        listening,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

// 直接用 node 跑这个文件时才是 CLI；被 import 时什么都不做
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
    const args = process.argv.slice(2);
    const port = Number(args.find((a) => /^\d+$/.test(a))) || 9211;
    const dirIdx = args.indexOf('--dir');
    const dir = join(root, dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : 'dist');
    startServer(port, dir);
}
