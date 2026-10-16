// 统一改版本号。
//
//   npm run bump 0.2.0      <- 把所有地方都改成 0.2.0
//   npm run bump            <- 不带参数：只检查各处是否一致（不一致退出码 1）
//
// 每个位置的锚点都写得很紧，避免误伤：
//   * package-lock.json 里只动「根包」和 packages[""] 那两条 —— 依赖的版本号不能碰
//   * Cargo.lock 里只动 name = "snake-army" 那条（其余是依赖，cargo 自己管）
//   * README 里只认「我们自己的版本号」出现的几种写法（下载包名 / tag / 发布命令）
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(root, p);

// 要同步的位置：文件 + 正则（第 1 组是版本号）+ 是否全部替换
const SPOTS = [
    {
        file: 'package.json',
        label: 'package.json',
        re: /"version"\s*:\s*"([^"]+)"/,
        all: false,
        make: (v) => '"version": "' + v + '"'
    },
    {
        file: 'package-lock.json',
        label: 'package-lock.json（根包）',
        re: /"version"\s*:\s*"([^"]+)"/,          // 文件里第一条就是根包的
        all: false,
        make: (v) => '"version": "' + v + '"'
    },
    {
        file: 'package-lock.json',
        label: 'package-lock.json（packages[""]）',
        re: /("":\s*\{\s*"name":\s*"[^"]*",\s*"version":\s*")([^"]+)(")/,
        group: 2,
        all: false,
        make: null
    },
    {
        file: 'src-tauri/tauri.conf.json',
        label: 'tauri.conf.json',
        re: /"version"\s*:\s*"([^"]+)"/,
        all: false,
        make: (v) => '"version": "' + v + '"'
    },
    {
        file: 'src-tauri/Cargo.toml',
        label: 'Cargo.toml',
        re: /(\[package\][\s\S]*?version\s*=\s*")([^"]+)(")/,
        group: 2,
        all: false,
        make: null
    },
    {
        file: 'src-tauri/Cargo.lock',
        label: 'Cargo.lock（本包）',
        re: /(name = "snake-army"\s*\nversion = ")([^"]+)(")/,
        group: 2,
        all: false,
        make: null
    },
    {
        file: 'assets/net.js',
        label: 'net.js（APP_VERSION）',
        re: /(APP_VERSION\s*=\s*')([^']+)(')/,
        group: 2,
        all: false,
        make: null
    }
];

// README 里「我们自己的版本号」只认这几种写法
const README_PATTERNS = [
    /snake-army-(\d+\.\d+\.\d+)-win-x64/g,
    /netlify-(\d+\.\d+\.\d+)\.zip/g,
    /releases\/tag\/v(\d+\.\d+\.\d+)/g,
    /贪吃蛇 v(\d+\.\d+\.\d+)/g,
    /tag_name=v(\d+\.\d+\.\d+)/g
];

function spotVersions(spot) {
    const text = readFileSync(rel(spot.file), 'utf8');
    const g = spot.group === undefined ? 1 : spot.group;

    // 「只改第一处」的位置就看第一处 —— 绝不能用非全局正则去 while(exec)：
    // 那会一直命中同一个位置，把内存吃光（这个坑我今天踩了两次）。
    if (!spot.all) {
        const m = new RegExp(spot.re.source).exec(text);
        return m ? [m[g]] : [];
    }

    const re = new RegExp(spot.re.source, 'g');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push(m[g]);
        if (m.index === re.lastIndex) re.lastIndex += 1;
    }
    return out;
}

function readmeVersions() {
    const text = readFileSync(rel('README.md'), 'utf8');
    const out = [];
    for (const p of README_PATTERNS) {
        const re = new RegExp(p.source, 'g');
        let m;
        while ((m = re.exec(text)) !== null) out.push(m[1]);
    }
    return out;
}

function currentVersion() {
    return JSON.parse(readFileSync(rel('package.json'), 'utf8')).version;
}

function check() {
    const want = currentVersion();
    let bad = 0;
    console.log('当前版本（以 package.json 为准）：' + want);
    for (const spot of SPOTS) {
        const found = spotVersions(spot);
        const ok = found.length > 0 && found.every((v) => v === want);
        if (!ok) bad += 1;
        console.log('  ' + (ok ? 'OK    ' : '不一致 ') + spot.label + '  ' + (found.join(', ') || '(没找到)'));
    }
    const rm = readmeVersions();
    const rmOk = rm.length > 0 && rm.every((v) => v === want);
    if (!rmOk) bad += 1;
    console.log('  ' + (rmOk ? 'OK    ' : '不一致 ') + 'README.md（' + rm.length + ' 处下载包名 / tag）  ' + [...new Set(rm)].join(', '));
    console.log('');
    if (bad) {
        console.log('有 ' + bad + ' 处不一致：跑 npm run bump <版本号> 统一改掉');
        process.exit(1);
    }
    console.log('各处版本号一致 ✓');
}

function bump(next) {
    const old = currentVersion();
    if (!/^\d+\.\d+\.\d+$/.test(next)) {
        console.error('版本号要写成 x.y.z（例如 0.2.0），收到的是：' + next);
        process.exit(1);
    }
    if (next === old) {
        console.log('已经是 ' + next + '，没改。');
        return;
    }

    const changed = [];
    for (const spot of SPOTS) {
        const text = readFileSync(rel(spot.file), 'utf8');
        let out;
        if (spot.make) {
            out = text.replace(new RegExp(spot.re.source, spot.all ? 'g' : ''), spot.make(next));
        } else {
            const re = new RegExp(spot.re.source, spot.all ? 'g' : '');
            out = text.replace(re, (whole, a, v, c) => a + next + c);
        }
        if (out !== text) {
            writeFileSync(rel(spot.file), out, 'utf8');
            const n = spotVersions(spot).length;
            changed.push(spot.label + '（' + n + ' 处）');
        }
    }

    // README：把旧版本号整词换成新的（只在这几种写法里）
    const rmText = readFileSync(rel('README.md'), 'utf8');
    let rmOut = rmText;
    for (const p of README_PATTERNS) {
        const re = new RegExp(p.source, 'g');
        rmOut = rmOut.replace(re, (whole) => whole.split(old).join(next));
    }
    if (rmOut !== rmText) {
        writeFileSync(rel('README.md'), rmOut, 'utf8');
        changed.push('README.md（' + readmeVersions().length + ' 处）');
    }

    console.log(old + ' -> ' + next);
    for (const c of changed) console.log('  改了 ' + c);
    console.log('');
    console.log('下一步：npm run probe 过一遍，再 npm run publish 出包');
}

const arg = (process.argv[2] || '').trim();
if (!arg) check();
else bump(arg);
