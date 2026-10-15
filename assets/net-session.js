// 联机会话层 · net-session
//
// 谁在这个文件里：握手与信令（连接码 / 局域网房间 / 直连 / EasyTier）、
// 快照的打包与还原、联机状态条、房间列表 UI、联机类型切换。
// 只依赖参数、不碰游戏状态的编解码与 ICE 工具在 net.js（更早加载）。
//
// 以经典脚本（非 module）加载：这里定义的函数和变量直接落在全局词法作用域，
// 其他脚本和 index.html 里的调用点不需要 import，也不改一行调用方式。
// 加载顺序见 index.html：config -> state -> net -> game -> render -> input -> net-session。

'use strict';

// ------------------------------ 联机 ------------------------------
// 主机权威：主机跑全部逻辑（P1 本地操作、P2 收客机按键），客机只发按键、收状态渲染。
// 信令走"手动交换连接码"：零服务器、零依赖，代价是开局要复制粘贴两段码。
function netSetStatus(main, hint) {
    if (main !== undefined) netStatusEl.textContent = main;
    if (hint !== undefined) netHintEl.textContent = hint;
}

function netSend(obj) {
    if (netDC && netOpen) {
        try { netDC.send(JSON.stringify(obj)); }
        catch (e) { /* 断了就算了，下一帧还会试 */ }
    }
}

function netLeave() {
    if (netDC) { try { netDC.close(); } catch (e) { } }
    if (netPC) { try { netPC.close(); } catch (e) { } }
    netDC = null;
    netPC = null;
    netOpen = false;
    netRole = null;
    netBusy = false;
}



// 一边收候选一边分类统计 —— 出码时和打洞失败时都要拿它说话
function netWatchIce(pc) {
    pc._c = { host: 0, mdns: 0, srflx: 0, relay: 0 };
    pc.addEventListener('icecandidate', function (ev) {
        const c = ev.candidate;
        if (!c) return;
        const s = c.candidate;
        if (s.indexOf(' typ host') !== -1) {
            pc._c.host++;
            if (s.indexOf('.local') !== -1) pc._c.mdns++;
        } else if (s.indexOf(' typ srflx') !== -1) {
            pc._c.srflx++;
        } else if (s.indexOf(' typ relay') !== -1) {
            pc._c.relay++;
        }
    });

    // 连不上时把状态也说一声，别只报超时
    pc.addEventListener('iceconnectionstatechange', function () {
        if (pc.iceConnectionState === 'failed' && !netOpen) {
            netSetStatus('直连失败', netDiag(pc) + '；跨网打不通的话需要在上面填一个 TURN 中继');
        }
    });
}


function netBindChannel(dc) {
    dc.addEventListener('open', function () {
        netOpen = true;
        if (netConnTimer) { clearTimeout(netConnTimer); netConnTimer = null; }
        netSetStatus('通道已建立，正在握手…', '');
        netSend({ t: 'hello', v: APP_VERSION });    // 先对程序版本，再开局
    });
    dc.addEventListener('close', function () {
        netOpen = false;
        if (state !== 'menu') netSetStatus('连接已断开', '按 Esc 回到模式选择');
    });
    dc.addEventListener('message', function (ev) { netOnMessage(ev.data); });
}

function netOnMessage(raw) {
    let m = null;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;

    // 握手：版本对不上就明确拒绝，不硬连
    if (m.t === 'hello') {
        if (m.v !== APP_VERSION) {
            netSetStatus('程序版本不一致：对方 v' + m.v + '，本机 v' + APP_VERSION,
                '两边打开同一版页面再连');
            try { netDC.close(); } catch (e) { }
            return;
        }
        hideStartUi();
        if (netRole === 'host') {
            netSetStatus('已连接 ✅', '对局开始');
            start(2, teamMode, netArena);   // 用房主开房时定的场地
        } else {
            netSetStatus('已连接 ✅', '对局进行中（画面由主机同步）');
            syncNetBar();
        }
        return;
    }

    if (netRole === 'guest') {
        if (m.t === 'state') netApplySnapshot(m);
        else if (m.t === 'askOk') {
            netBarNote(m.ok
                ? (m.what === 'restart' ? '主机同意重开' : '主机同意暂停 / 继续')
                : '主机忽略了你的请求');
        }
        return;
    }

    // 主机：把客机的操作喂给 P2
    if (!players) return;
    if (m.t === 'dir') {
        if (players[1]) turn(players[1], m.dir);
    } else if (m.t === 'build') {
        if (players[1]) players[1].buildRequested = true;
    } else if (m.t === 'ask') {
        // 客机想暂停 / 重开，得主机点头才算 —— 这里只挂个提示
        netAsk = (m.what === 'restart') ? 'restart' : 'pause';
        syncNetBar();
        netBarNote('客机发来请求');
    }
}


// ------------------------------ 联机状态条 ------------------------------
// 连上以后联机面板就消失了，所以操作全部收拢到这条状态条：
//   * 主机和客机都能随时「退出连接」
//   * 客机不能自己暂停 / 重开，只能向主机发请求，由主机点「同意」才算数
let netAsk = null;         // 主机这边待处理的请求：'pause' | 'restart'
let netNoteTimer = null;

const netBarEl = document.getElementById('netBar');

function netBarNote(text, ms) {
    const el = document.getElementById('netBarNote');
    el.textContent = text || '';
    if (netNoteTimer) clearTimeout(netNoteTimer);
    if (text) netNoteTimer = setTimeout(function () { el.textContent = ''; }, ms || 4000);
}

function syncNetBar() {
    if (!netBarEl) return;
    netBarEl.hidden = !netOpen;
    if (!netOpen) return;

    const isGuest = netRole === 'guest';
    document.getElementById('netBarWho').textContent =
        isGuest ? '联机中 · 我是客机' : '联机中 · 我是主机';
    document.getElementById('netBarState').textContent =
        state === 'paused' ? '已暂停'
            : state === 'over' ? '本局结束'
                : state === 'running' ? '对局进行中' : '';

    // 客机：只有「请求」按钮
    const pauseBtn = document.getElementById('netBarPause');
    pauseBtn.hidden = !isGuest;
    pauseBtn.textContent = state === 'paused' ? '请求继续' : '请求暂停';
    document.getElementById('netBarRestart').hidden = !isGuest;

    // 主机：等客机的请求
    const showAsk = !isGuest && !!netAsk;
    document.getElementById('netAskText').hidden = !showAsk;
    document.getElementById('netAskOk').hidden = !showAsk;
    document.getElementById('netAskNo').hidden = !showAsk;
    if (showAsk) {
        document.getElementById('netAskText').textContent =
            netAsk === 'restart' ? '客机请求重开一局' : '客机请求暂停 / 继续';
    }
}

// 客机专用：向主机发请求
function netAskHost(what) {
    if (!netOpen || netRole !== 'guest') return;
    netSend({ t: 'ask', what: what });
    netBarNote('已请求，等主机回应…');
}

document.getElementById('netBarPause').addEventListener('click', function () { netAskHost('pause'); });
document.getElementById('netBarRestart').addEventListener('click', function () { netAskHost('restart'); });
document.getElementById('netBarLeave').addEventListener('click', function () { showMenu(); });

document.getElementById('netAskOk').addEventListener('click', function () {
    const what = netAsk;
    netAsk = null;
    if (what === 'restart') start(2, teamMode);
    else togglePause();
    netSend({ t: 'askOk', what: what, ok: true });
    netBarNote('已同意客机的请求');
    syncNetBar();
});

document.getElementById('netAskNo').addEventListener('click', function () {
    netSend({ t: 'askOk', what: netAsk, ok: false });
    netAsk = null;
    netBarNote('已忽略客机的请求');
    syncNetBar();
});

async function netHostCreate() {
    netLeave();
    netRole = 'host';
    netPC = new RTCPeerConnection({ iceServers: netIceServers() });
    netWatchIce(netPC);
    netDC = netPC.createDataChannel('snake', { ordered: true });
    netBindChannel(netDC);

    await netPC.setLocalDescription(await netPC.createOffer());
    const gatherOk = await netWaitIce(netPC);

    netCodeEl.value = netEncode(netPC.localDescription.sdp, 'offer');
    netSetStatus('① 把下面的连接码发给对方',
        netDiag(netPC) + netIceWarn(netPC, gatherOk) +
        '　v' + APP_VERSION + '；② 对方发回应答码后粘到框里点「接受应答码」');
    netUseBtnEl.disabled = false;
    netUseBtnEl.textContent = '接受应答码';
}

async function netHostAcceptAnswer() {
    if (!netPC || netRole !== 'host') throw new Error('NO_HOST');
    const d = netDecode(netCodeEl.value, 'answer');
    await netPC.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    const patched = netPatchIp(netPC, netPeerIpEl.value.trim());
    netSetStatus('已收到应答码，正在打洞…',
        '对方程序版本 v' + d.version + '，与本机一致 ✓' +
        (patched ? '；已按你填的 IP 补了 ' + patched + ' 条候选' : ''));
    netUseBtnEl.disabled = true;
    netStartConnectTimer();
}

async function netGuestAcceptOffer() {
    if (netRole !== 'guest') throw new Error('NO_GUEST');
    const d = netDecode(netCodeEl.value, 'offer');
    netLeave();
    netRole = 'guest';
    netPC = new RTCPeerConnection({ iceServers: netIceServers() });
    netWatchIce(netPC);
    netPC.addEventListener('datachannel', function (ev) {
        netDC = ev.channel;
        netBindChannel(netDC);
    });

    await netPC.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    const patched = netPatchIp(netPC, netPeerIpEl.value.trim());
    await netPC.setLocalDescription(await netPC.createAnswer());
    const gatherOk = await netWaitIce(netPC);

    netCodeEl.value = netEncode(netPC.localDescription.sdp, 'answer');
    netSetStatus('② 把下面的应答码发回给主机',
        netDiag(netPC) + netIceWarn(netPC, gatherOk) +
        (patched ? '　已按你填的 IP 补了 ' + patched + ' 条候选' : '') +
        '　v' + APP_VERSION + '，对方 v' + d.version + ' ✓');
    netUseBtnEl.disabled = true;
    netStartConnectTimer();
}

// 打洞迟迟不通就说清楚，别让人干等
function netStartConnectTimer() {
    if (netConnTimer) clearTimeout(netConnTimer);
    netConnTimer = setTimeout(function () {
        netConnTimer = null;
        if (netOpen) return;

        // 按候选情况分诊，别只丢一句"超时"
        const c = (netPC && netPC._c) || { host: 0, mdns: 0, srflx: 0, relay: 0 };
        let why;
        if (!c.srflx && !c.relay) {
            why = '本机压根没拿到公网候选（STUN 不通）：检查网络/防火墙，或在上面填一个能用的 STUN';
        } else if (!c.relay) {
            why = '双方都拿到了公网地址却打不通，多半是对称 NAT 或防火墙。同一局域网一般能直连；' +
                '跨网这条路需要在上面填一个 TURN 中继';
        } else {
            why = '已经有中继候选还是不通，检查 TURN 的地址和账号密码';
        }
        netSetStatus('打洞超时了', why + '　（' + netDiag(netPC) + '）');
    }, NET_CONNECT_MS);
}

function netSetTeam(tm) {
    teamMode = tm;
    netCoopBtnEl.classList.toggle('is-on', tm === 'coop');
    netVsBtnEl.classList.toggle('is-on', tm === 'vs');
}

// ------------------------------ 联机：状态打包 ------------------------------
function netPackBody(b) {
    const a = [];
    for (let i = 0; i < b.length; i++) a.push(b[i].x, b[i].y);
    return a;
}

function netUnpackBody(a) {
    const b = [];
    for (let i = 0; i < a.length; i += 2) b.push({ x: a[i], y: a[i + 1] });
    return b;
}

function netRound(v) { return Math.round(v * 100) / 100; }

// 主机 -> 客机：把渲染需要的一切打包（客机不跑逻辑，只照着重画）
function netSnapshot() {
    return {
        t: 'state',
        now: Math.round(gameNow),
        st: state,
        cols: COLS, rows: ROWS,
        w: W, h: H,
        ox: Math.round(renderOffsetX), oy: Math.round(renderOffsetY),
        wid: widenStartAt ? Math.round(widenStartAt) : 0,
        wfc: widenFromCols, wfr: widenFromRows,
        mode: mode, team: teamMode, best: best,
        pl: players.map(function (p, i) {
            return {
                i: i,
                b: netPackBody(p.body),
                hp: p.hp.map(netRound),
                d: p.dir, q: p.queue,
                acc: netRound(p.acc), sm: p.stepMs,
                bu: p.boostUntil ? Math.round(p.boostUntil) : 0,
                c: p.coins, s: p.score,
                sa: Math.round(p.spawnAt),
                al: p.alive
            };
        }),
        en: enemies.map(function (e) {
            return {
                k: e.kind, b: netPackBody(e.body),
                hp: e.hp.map(netRound),
                d: e.dir, acc: netRound(e.acc), sm: e.stepMs,
                bu: e.boostUntil ? Math.round(e.boostUntil) : 0,
                sa: Math.round(e.spawnAt)
            };
        }),
        ap: apples.map(function (a) { return [a.x, a.y]; }),
        pw: {
            speed: powerUps.speed ? [powerUps.speed.x, powerUps.speed.y] : null,
            widen: powerUps.widen ? [powerUps.widen.x, powerUps.widen.y] : null
        },
        pr: {
            speed: Math.round(powerRespawnAt.speed || 0),
            widen: Math.round(powerRespawnAt.widen || 0)
        },
        rv: reviveItem ? [reviveItem.x, reviveItem.y] : null,
        dr: drops.map(function (d) { return [d.x, d.y, d.kind === 'len' ? 1 : 0, Math.round(d.expireAt)]; }),
        tu: turrets.map(function (t) {
            return [t.x, t.y, players.indexOf(t.owner), Math.round(t.cooldownUntil)];
        }),
        bl: bullets.map(function (b) { return [netRound(b.x), netRound(b.y), b.from === 'enemy' ? 1 : 0]; }),
        co: corpses.map(function (c) {
            return [netPackBody(c.body), c.hp, c.dir, Math.round(c.diedAt),
                    c.loot ? 1 : 0, c.bodyColor, c.headColor];
        })
    };
}

// 客机：把快照铺回本地状态，之后照常 render()，画法完全复用
function netApplySnapshot(m) {
    gameNow = m.now;
    nowRef = gameNow;
    state = m.st;
    mode = m.mode;
    teamMode = m.team;
    best = m.best;

    if (COLS !== m.cols || ROWS !== m.rows || W !== m.w || H !== m.h) {
        COLS = m.cols;
        ROWS = m.rows;
        setCanvasSize(m.w, m.h);
    }
    renderOffsetX = m.ox;
    renderOffsetY = m.oy;
    widenStartAt = m.wid;
    widenFromCols = m.wfc;
    widenFromRows = m.wfr;

    players = m.pl.map(function (p) {
        return {
            def: PLAYER_DEFS[p.i],
            body: netUnpackBody(p.b), hp: p.hp, dir: p.d, queue: p.q,
            acc: p.acc, stepMs: p.sm, boostUntil: p.bu,
            coins: p.c, score: p.s, spawnAt: p.sa, alive: p.al,
            buildRequested: false
        };
    });

    enemies = m.en.map(function (e) {
        return {
            kind: e.k, body: netUnpackBody(e.b), hp: e.hp, dir: e.d,
            acc: e.acc, stepMs: e.sm, baseStepMs: e.sm, boostUntil: e.bu,
            spawnAt: e.sa, shootAt: 0
        };
    });

    apples = m.ap.map(function (a) { return { x: a[0], y: a[1] }; });
    powerUps = {
        speed: m.pw.speed ? { x: m.pw.speed[0], y: m.pw.speed[1] } : null,
        widen: m.pw.widen ? { x: m.pw.widen[0], y: m.pw.widen[1] } : null
    };
    powerRespawnAt = { speed: m.pr.speed, widen: m.pr.widen };
    reviveItem = m.rv ? { x: m.rv[0], y: m.rv[1] } : null;
    drops = m.dr.map(function (d) {
        return { x: d[0], y: d[1], kind: d[2] ? 'len' : 'coin', expireAt: d[3] };
    });
    turrets = m.tu.map(function (t) {
        return { x: t[0], y: t[1], cooldownUntil: t[3], owner: players[t[2]] || players[0] };
    });
    bullets = m.bl.map(function (b) {
        return { x: b[0], y: b[1], vx: 0, vy: 0, from: b[2] ? 'enemy' : 'player' };
    });
    corpses = m.co.map(function (c) {
        return {
            body: netUnpackBody(c[0]), hp: c[1], dir: c[2],
            diedAt: c[3], loot: !!c[4], bodyColor: c[5], headColor: c[6]
        };
    });

    syncHud();
    syncNetBar();     // 客机的状态条要跟着主机的状态走
    if (!netPanelEl.hidden || !startPanelEl.hidden) hideStartUi();
}

// ------------------------------ 局域网房间 ------------------------------
// 桌面版（Tauri 壳）里，Rust 侧内嵌了信令服务 + UDP 广播探测，所以「搜索房间」
// 是真能用的。纯浏览器里拿不到原生桥，这整块直接隐藏，联机走上面的手动连接码 ——
// 也就是说前端核心逻辑一行都不用为它改。
const NATIVE = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core)
    ? window.__TAURI__.core : null;

let lanBase = null;    // 本地信令服务地址
let lanRoom = null;    // 我开的房间 id
let lanPoll = null;    // 主机轮询应答码的定时器
let lanShare = '';     // 房主要发出去的地址 ip:port

function lanApi(base, path, body) {
    const opt = (body === undefined)
        ? { cache: 'no-store' }
        : { method: 'POST', body: JSON.stringify(body) };
    return fetch(base + path, opt).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
            return j;
        });
    });
}

async function lanOwnBase(port) {
    if (lanBase) return lanBase;
    // 端口由房主定；没填就交给后端用默认端口
    const info = await NATIVE.invoke('lan_start', { port: port || null });
    lanBase = info.url;
    lanShare = info.share || ('127.0.0.1:' + info.port);
    return lanBase;
}

// ------------------------------ 联机类型 ------------------------------
// 三种类型：局域网（同一 Wi-Fi 自动搜房）/ 跨网（先用 EasyTier 组虚拟局域网）/
// 连接码（手动交换）。浏览器版只有连接码一种，选择器整个隐藏。
let netKind = 'lan';
let etTimer = null;
let etRunning = false;

const KIND_TIP = {
    lan: '局域网：同一个 Wi-Fi 下自动搜到房间',
    wan: '跨网：两边用同一个网络名和密码，EasyTier 会把你们接进同一张虚拟局域网',
    direct: '直连：知道对方 IP / 网址就直接搜他的房间，不依赖广播 —— 跨网、公司网里通常更靠谱',
    code: '连接码：手动把码发给对方（浏览器版只有这一种）'
};

const DEFAULT_PORT = 47812;

// 只在「连接码」类型下出现的元素
const CODE_ONLY = ['netRoleRow', 'netCode', 'netCopyRow', 'netHint', 'netMore', 'netIce', 'netPeerIp'];
const KIND_BTNS = { lan: 'kindLanBtn', wan: 'kindWanBtn', direct: 'kindDirectBtn', code: 'kindCodeBtn' };

function setNetKind(kind) {
    netKind = kind;
    const isLan = kind === 'lan';
    const isWan = kind === 'wan';
    const isDirect = kind === 'direct';
    const isCode = kind === 'code';

    document.getElementById('netKindTip').textContent = KIND_TIP[kind] || '';

    for (const id of CODE_ONLY) document.getElementById(id).hidden = !isCode;
    netManualTipEl.hidden = !isCode;
    // 浏览器版：只有「直连」的进房部分能用 ——
    // 它本质是对着对方地址发几个 fetch，不需要任何原生能力。
    // 局域网/跨网，以及自己开房，都要原生侧。
    for (const [id, needsNative] of [
        ['kindLanBtn', true],
        ['kindWanBtn', true],
        ['kindDirectBtn', false],
    ]) {
        const b = document.getElementById(id);
        b.disabled = needsNative && !NATIVE;
        b.title = b.disabled ? '需要桌面版' : '';
    }
    document.getElementById('netNativeWarn').hidden = !!NATIVE;

    // 开房表单：只有桌面版才给（浏览器开不了房）
    const canHost = NATIVE && (isLan || isWan || isDirect);
    lanBoxEl.hidden = !canHost;
    // 「搜索附近房间」靠 UDP 广播：直连模式不用，跨网模式等虚拟网起来再用
    document.getElementById('lanScanRow').hidden = !(isLan || (isWan && etRunning));
    document.getElementById('lanList').hidden = isDirect;
    document.getElementById('directBox').hidden = !isDirect;

    for (const k in KIND_BTNS) {
        document.getElementById(KIND_BTNS[k]).classList.toggle('is-on', k === kind);
    }
    if (isWan) etRefresh();
    // 四种模式都要写，漏掉一种的话状态行会留着上一个模式的文字
    // （连接码模式之前就一直显示着「直连：…」）
    document.getElementById('netStatus').textContent = isCode
        ? (NATIVE
            ? '连接码：主机点「我是主机」生成码，客机粘贴后点「用这段码」'
            : '连接码：主机点「我是主机」生成码，客机粘贴后点「用这段码」')
        : isDirect
            ? (NATIVE
                ? '直连：一边「开个房间」把地址发出来，另一边粘地址搜索'
                : '直连：把桌面版房主的地址粘进来就能进房（浏览器版开不了房）')
            : isLan
                ? '同一个 Wi-Fi：一方「开个房间」，另一方「搜索附近房间」'
                : '跨网：先启动虚拟局域网，之后和局域网一样搜';
}

// ------------------------------ EasyTier 跨网 ------------------------------
async function etRefresh() {
    if (!NATIVE) return null;
    let st = null;
    try { st = await NATIVE.invoke('et_status'); } catch (e) { return null; }
    etRunning = !!(st && st.running);
    const ip = (st && st.virtualIp) ? ('　虚拟 IP ' + st.virtualIp) : '';
    const msg = document.getElementById('etMsg');
    if (etRunning) {
        msg.textContent = 'EasyTier 运行中（PID ' + st.pid + '）' + ip;
    } else if (st && st.logs && st.logs.length) {
        msg.textContent = 'EasyTier 已退出 —— 多半是没拿到管理员权限（看下面日志）';
    } else {
        msg.textContent = 'EasyTier 未启动';
    }
    const log = document.getElementById('etLog');
    log.textContent = ((st && st.logs) || []).slice(-80).join('\n');
    log.scrollTop = log.scrollHeight;
    // 虚拟网一起来，就把「搜索房间」放出来
    if (netKind === 'wan') lanBoxEl.hidden = !etRunning;
    return st;
}

async function etStart() {
    const btn = document.getElementById('etStartBtn');
    btn.disabled = true;
    try {
        const chk = await NATIVE.invoke('et_check');
        if (!chk.found) {
            document.getElementById('etMsg').textContent =
                '没找到 easytier-core.exe —— 在项目目录跑一次 npm run fetch:easytier';
            return;
        }
        if (!chk.admin) {
            // 不阻止启动：让用户看到 EasyTier 自己的日志，比一句"权限不够"更有用
            document.getElementById('etMsg').textContent =
                '⚠ 当前不是管理员：EasyTier 建虚拟网卡需要管理员权限';
        }
        await NATIVE.invoke('et_start', {
            network: document.getElementById('etNetwork').value.trim() || 'snake-army',
            secret: document.getElementById('etSecret').value.trim() || 'snake-army',
            peers: document.getElementById('etPeers').value.trim() || null,
            broadcastRelay: true
        });
        if (etTimer) clearInterval(etTimer);
        etTimer = setInterval(etRefresh, 1500);
        await etRefresh();
    } catch (e) {
        document.getElementById('etMsg').textContent = '启动失败：' + e.message;
    }
    btn.disabled = false;
}

async function etStop() {
    if (etTimer) { clearInterval(etTimer); etTimer = null; }
    await NATIVE.invoke('et_stop');
    etRunning = false;
    await etRefresh();
}

// 这几个在纯浏览器里也必须挂上：「直连」的进房只靠 fetch，
// 类型切换更是纯 UI。之前全塞在 if (NATIVE) 里，浏览器里点了没反应。
document.getElementById('kindLanBtn').addEventListener('click', function () { setNetKind('lan'); });
document.getElementById('kindWanBtn').addEventListener('click', function () { setNetKind('wan'); });
document.getElementById('kindDirectBtn').addEventListener('click', function () { setNetKind('direct'); });
document.getElementById('kindCodeBtn').addEventListener('click', function () { setNetKind('code'); });
document.getElementById('directSearchBtn').addEventListener('click', directSearch);
document.getElementById('directAddr').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); directSearch(); }
});

if (NATIVE) {
    document.getElementById('etStartBtn').addEventListener('click', etStart);
    document.getElementById('etStopBtn').addEventListener('click', etStop);
    // 给个默认网络名，省得两边商量
    document.getElementById('etNetwork').value = 'snake-' + Math.random().toString(36).slice(2, 7);
    // 端口默认随机一个，避免两边固定端口撞车
    document.getElementById('roomPort').value = String(47000 + Math.floor(Math.random() * 2000));
    document.getElementById('roomCols').value = '30';
    document.getElementById('roomRows').value = '15';
    document.getElementById('roomMax').value = '2';
    document.getElementById('myName').value = '玩家' + Math.floor(Math.random() * 90 + 10);
}

function lanStopPolling() {
    if (lanPoll) { clearInterval(lanPoll); lanPoll = null; }
}

function lanClearRoom() {
    lanStopPolling();
    if (lanRoom && lanBase) {
        lanApi(lanBase, '/api/close', { id: lanRoom }).catch(function () { });
    }
    lanRoom = null;
}

// 搜索：Rust 侧广播一发，再逐台问房间列表
async function lanScan() {
    if (!NATIVE) return;
    lanMsgEl.textContent = '正在搜索…';
    lanListEl.innerHTML = '';
    try {
        const peers = await NATIVE.invoke('lan_discover', { timeoutMs: 1500 });
        const rows = [];
        for (const p of peers) {
            let info = null;
            try { info = await lanApi(p.url, '/api/rooms'); } catch (e) { continue; }
            for (const r of (info.rooms || [])) {
                rows.push({ url: p.url, host: info.host || p.name, room: r });
            }
        }
        lanRenderRooms(rows, lanListEl, lanMsgEl);
    } catch (e) {
        lanMsgEl.textContent = '搜索失败：' + e.message;
    }
}

// 直连：不给广播留机会，直接问某个地址要房间列表
async function directSearch() {
    // 纯 fetch，不需要原生桥 —— 所以浏览器版也能进别人的房间
    const noteEl = document.getElementById('directMsg');
    const listEl = document.getElementById('directList');
    listEl.innerHTML = '';
    let raw = document.getElementById('directAddr').value.trim();
    if (!raw) { noteEl.textContent = '先填对方的 IP 或网址'; return; }
    // 接受 1.2.3.4:47821 / 1.2.3.4 / http://host:port / host:port
    raw = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (raw.indexOf(':') < 0) raw += ':' + DEFAULT_PORT;
    const url = 'http://' + raw;
    noteEl.textContent = '正在问 ' + url + ' …';
    try {
        const info = await lanApi(url, '/api/rooms');
        const rows = (info.rooms || []).map(function (r) {
            return { url: url, host: info.host, room: r };
        });
        lanRenderRooms(rows, listEl, noteEl);
    } catch (e) {
        noteEl.textContent = '连不上 ' + url + '：' + e.message +
            '　（对方没开房 / 防火墙挡着 / 地址写错，都有可能）';
    }
}

function lanRenderRooms(rows, listEl, noteEl) {
    listEl.innerHTML = '';
    if (!rows.length) {
        noteEl.textContent = '没搜到房间 —— 让对方先点「开个房间」';
        return;
    }
    noteEl.textContent = '搜到 ' + rows.length + ' 个房间，看清信息后点「进入」';
    for (const row of rows) {
        const r = row.room;
        const div = document.createElement('div');
        div.className = 'lanRoom';

        const info = document.createElement('div');
        info.className = 'info';
        const t1 = document.createElement('span');
        t1.textContent = r.name + '　·　' + (r.player || row.host || '?') +
            '　·　' + (r.players || 1) + '/' + (r.maxPlayers || 2) + ' 人' +
            '　·　' + (r.cols || '?') + '×' + (r.rows || '?') +
            (r.taken ? '（已满）' : '');
        info.appendChild(t1);
        if (r.desc) {
            const t2 = document.createElement('span');
            t2.className = 'sub2';
            t2.textContent = r.desc;
            info.appendChild(t2);
        }

        const btn = document.createElement('button');
        btn.className = 'startBtn small';
        btn.textContent = '进入';
        btn.disabled = !!r.taken;
        btn.addEventListener('click', function () { lanJoin(row.url, r.id); });
        div.appendChild(info);
        div.appendChild(btn);
        listEl.appendChild(div);
    }
}

// 开房：先照常造 offer，挂到本地信令服务上，然后轮询问答码
async function lanOpenRoom() {
    if (netBusy) return;
    netBusy = true;
    try {
        const portNum = parseInt(document.getElementById('roomPort').value, 10);
        const base = await lanOwnBase(isFinite(portNum) ? portNum : null);
        lanMsgEl.textContent = '正在开房间…';

        netLeave();
        netRole = 'host';
        netPC = new RTCPeerConnection({ iceServers: netIceServers() });
        netWatchIce(netPC);
        netDC = netPC.createDataChannel('snake', { ordered: true });
        netBindChannel(netDC);
        await netPC.setLocalDescription(await netPC.createOffer());
        // 同一个局域网用不着公网候选，等 2.5 秒就够，别让人干等
        await netWaitIce(netPC, 2500);

        // 场地由房主定；服务端会限制在合理范围内
        const clampNum = function (id, lo, hi, dflt) {
            const n = parseInt(document.getElementById(id).value, 10);
            return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
        };
        const arena = {
            cols: clampNum('roomCols', 10, 60, 30),
            rows: clampNum('roomRows', 8, 40, 15),
            // 人数上限先记下来、房间信息里也显示，等网络层接上多席位后才真正生效
            maxPlayers: clampNum('roomMax', 2, 6, 2),
            count: 2
        };
        netArena = arena;

        const made = await lanApi(base, '/api/room', {
            name: document.getElementById('roomName').value.trim(),
            desc: document.getElementById('roomDesc').value.trim(),
            player: document.getElementById('myName').value.trim(),
            cols: arena.cols,
            rows: arena.rows,
            maxPlayers: arena.maxPlayers,
            offer: netEncode(netPC.localDescription.sdp, 'offer')
        });
        lanRoom = made.id;
        netSetStatus('房间开好了',
            netKind === 'direct' ? '把地址发给对方，让他在「直连」里搜' : '等对方搜到并进入');
        lanMsgEl.textContent = '房间里已有 1 人（你）。把　' + lanShare +
            '　发给对方' + (netKind === 'direct' ? '，让他粘到上面的地址框里搜' : '，让他搜房间');

        lanStopPolling();
        lanPoll = setInterval(async function () {
            if (!lanRoom || netOpen) { lanStopPolling(); return; }
            try {
                // 顺带把「现在几个人」报上去，来客在列表里看到的就是实时的
                const r = await lanApi(base, '/api/answer?id=' + encodeURIComponent(lanRoom) +
                    '&players=' + players.length);
                if (!r.answer) return;
                lanStopPolling();
                const d = netDecode(r.answer, 'answer');
                await netPC.setRemoteDescription({ type: 'answer', sdp: d.sdp });
                netSetStatus('对方已加入，正在打洞…', '通道一开就自动开局');
                lanMsgEl.textContent = '对方已加入 ✅';
                netStartConnectTimer();
            } catch (e) { /* 房间还没人应答，继续轮询 */ }
        }, 700);
    } catch (e) {
        lanMsgEl.textContent = '开房失败：' + e.message;
    }
    netBusy = false;
}

// 加入：取 offer -> 造 answer -> 递回主机
async function lanJoin(base, id) {
    try {
        lanMsgEl.textContent = '正在取房间信息…';
        const info = await lanApi(base, '/api/offer?id=' + encodeURIComponent(id));
        const d = netDecode(info.offer, 'offer');

        netLeave();
        netRole = 'guest';
        netPC = new RTCPeerConnection({ iceServers: netIceServers() });
        netWatchIce(netPC);
        netPC.addEventListener('datachannel', function (ev) {
            netDC = ev.channel;
            netBindChannel(netDC);
        });
        await netPC.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        await netPC.setLocalDescription(await netPC.createAnswer());
        await netWaitIce(netPC, 2500);
        await lanApi(base, '/api/answer',
            { id: id, answer: netEncode(netPC.localDescription.sdp, 'answer') });

        netSetStatus('已把应答递回主机', '通道一开就自动开局');
        lanMsgEl.textContent = '已加入，等待连接…';
        netStartConnectTimer();
    } catch (e) {
        lanMsgEl.textContent = '加入失败：' + e.message;
    }
}

if (NATIVE) {
    document.getElementById('lanScanBtn').addEventListener('click', lanScan);
    document.getElementById('lanHostBtn').addEventListener('click', lanOpenRoom);
}
startBtnNetEl.addEventListener('click', function () {
    startPanelEl.hidden = true;
    netPanelEl.hidden = false;
    netCodeEl.value = '';
    netUseBtnEl.disabled = true;
    netUseBtnEl.textContent = '用这段码';
    netSetTeam(teamMode);
    // 桌面版有局域网/跨网两种；纯浏览器只有连接码 —— 但选择器仍然显示，
    // 只是把那两种置灰并说明原因（见 setNetKind）
    // 桌面版默认局域网；浏览器版默认直连（能进房），连接码仍可手动选
    setNetKind(NATIVE ? 'lan' : 'direct');
    lanListEl.innerHTML = '';
    lanMsgEl.textContent = '同一个 Wi-Fi 下可以直接互相搜到';
    netVerEl.textContent = '程序版本 v' + APP_VERSION + '（两边必须一致，否则直接拒绝连接）';
    netSetStatus('先选角色：主机负责开局，客机负责应答', '主机点「我是主机」生成连接码');
});

netBackEl.addEventListener('click', function (ev) {
    ev.preventDefault();
    showMenu();
});

netCoopBtnEl.addEventListener('click', function () { netSetTeam('coop'); });
netVsBtnEl.addEventListener('click', function () { netSetTeam('vs'); });

netHostBtnEl.addEventListener('click', function () {
    if (netBusy) return;
    netBusy = true;
    netSetStatus('正在生成连接码…', '要等 ICE 收集完，最多几秒');
    netHostCreate().catch(function (e) {
        netSetStatus('出错了', netExplain(e));
    }).then(function () { netBusy = false; });
});

netGuestBtnEl.addEventListener('click', function () {
    netLeave();
    netRole = 'guest';
    netCodeEl.value = '';
    netUseBtnEl.disabled = false;
    netUseBtnEl.textContent = '生成应答码';
    netSetStatus('把主机的连接码粘贴到下面', '然后点「生成应答码」');
});

netUseBtnEl.addEventListener('click', function () {
    if (netRole === 'host') {
        netUseBtnEl.disabled = true;
        netHostAcceptAnswer().catch(function (e) {
            netSetStatus('这段码不能用', netExplain(e));
            netUseBtnEl.disabled = false;
        });
    } else if (netRole === 'guest') {
        netUseBtnEl.disabled = true;
        netSetStatus('正在生成应答码…', '要等 ICE 收集完，最多几秒');
        netGuestAcceptOffer().catch(function (e) {
            netSetStatus('这段码不能用', netExplain(e));
            netUseBtnEl.disabled = false;
        });
    } else {
        netSetStatus('先选角色', '主机点「我是主机」，客机点「我是客机」');
    }
});

netCopyBtnEl.addEventListener('click', function () {
    netCodeEl.focus();
    netCodeEl.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(netCodeEl.value).catch(function () { });
        ok = true;
    }
    netHintEl.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动 Ctrl+C';
});
