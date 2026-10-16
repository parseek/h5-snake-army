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

// ------------------------------ 联机：座位表 ------------------------------
// 座位 0 是主机自己，1..netMaxPlayers-1 是客机，负数（-1、-2…）是观战席。
// 每条连接 = 一个座位 = 一条 WebRTC 连接。主机把同一帧快照按座位分别发出去，
// 每份多带一个 you 字段，客机据此知道自己在驱动哪条蛇。
function netPeerSend(peer, obj) {
    if (peer && peer.dc && peer.open) {
        try { peer.dc.send(JSON.stringify(obj)); }
        catch (e) { /* 断了就算了，下一帧还会试 */ }
    }
}

// 客机 → 主机；主机 → 所有客人（广播）。主机要单独发给某人时用 netPeerSend。
function netSend(obj) {
    if (netRole === 'host') { netBroadcast(obj); return; }
    if (netPrimary) netPeerSend(netPrimary, obj);
}

function netBroadcast(obj) {
    for (let i = 0; i < netPeers.length; i++) netPeerSend(netPeers[i], obj);
}

// 快照一人一份：内容一样，只有 you 不同
function netBroadcastSnapshot(snap) {
    for (let i = 0; i < netPeers.length; i++) {
        const peer = netPeers[i];
        if (!peer.open) continue;
        netPeerSend(peer, Object.assign({}, snap, { you: peer.seat }));
    }
}

// 转发给「除某条连接之外」的所有客机（聊天转发用：谁说的不用再收一遍）
function netBroadcastOther(except, obj) {
    for (let i = 0; i < netPeers.length; i++) {
        if (netPeers[i] !== except) netPeerSend(netPeers[i], obj);
    }
}

function netPeerBySeat(seat) {
    for (let i = 0; i < netPeers.length; i++) {
        if (netPeers[i].seat === seat) return netPeers[i];
    }
    return null;
}

// 主机：给新连接挑座位。玩家席发完了就给观战席（-1、-2…）—— 人满了也还能进来看
function netTakeSeat() {
    const taken = {};
    for (let i = 0; i < netPeers.length; i++) taken[netPeers[i].seat] = true;
    for (let s = 1; s < netMaxPlayers; s++) {
        if (!taken[s]) return s;
    }
    let s = -1;
    while (taken[s]) s--;
    return s;
}

function netGuestCount() {
    let n = 0;
    for (let i = 0; i < netPeers.length; i++) {
        if (netPeers[i].seat > 0 && netPeers[i].open) n++;
    }
    return n;
}

function netSpectatorCount() {
    let n = 0;
    for (let i = 0; i < netPeers.length; i++) {
        if (netPeers[i].seat < 0 && netPeers[i].open) n++;
    }
    return n;
}

// 场上该有几条蛇：座位号最大的那位说了算。
// 座位号必须连续（players[i] 对应座位 i），所以断开中间一位时人数也跟着降。
function netWantedPlayers() {
    let hi = 0;
    for (let i = 0; i < netPeers.length; i++) {
        const s = netPeers[i].seat;
        if (netPeers[i].open && s > hi) hi = s;
    }
    return Math.max(1, Math.min(1 + hi, MAX_PLAYERS));
}

// 观战：只收快照，不发任何操作
function netSpectating() { return netRole === 'guest' && netSeat !== null && netSeat < 0; }

function netRosterText() {
    const s = netSpectatorCount();
    return '玩家 ' + netWantedPlayers() + '/' + netMaxPlayers + (s ? '　观战 ' + s : '');
}

// netOpen = 我这边好歹通了：客机看自己那条，主机看有没有客人通了
function netSyncOpen() {
    if (netRole !== 'host') {
        netOpen = !!(netPrimary && netPrimary.open);
        return;
    }
    netOpen = false;
    for (let i = 0; i < netPeers.length; i++) {
        if (netPeers[i].open) { netOpen = true; return; }
    }
}

function netDropPeer(peer) {
    const i = netPeers.indexOf(peer);
    if (i >= 0) netPeers.splice(i, 1);
    if (netPrimary === peer) netPrimary = null;
    peer.open = false;
    netSyncOpen();
    syncNetBar();
}

function netLeave() {
    for (let i = 0; i < netPeers.length; i++) {
        const peer = netPeers[i];
        if (peer.dc) { try { peer.dc.close(); } catch (e) { } }
        if (peer.pc) { try { peer.pc.close(); } catch (e) { } }
    }
    netPeers = [];
    netPrimary = null;
    netOpen = false;
    netSeat = null;
    netRole = null;
    netBusy = false;
    netHostStage = 'idle';
    if (netConnTimer) { clearTimeout(netConnTimer); netConnTimer = null; }
}

// ------------------------------ 联机：场地与人数 ------------------------------
// 房主开房时定的那份；连接码模式没有房间面板，就给一份默认的宽场地
// 房间/对局配置：房主开房时填进去，面板里能接着改（都在 state.js 的 levelCfg 那一个对象里）

function netArenaCfg() {
    return {
        cols: levelCfg.cols || 30,
        rows: levelCfg.rows || 15,
        maxPlayers: levelCfg.maxPlayers || MAX_PLAYERS
    };
}

// 交给 start() 的场地：人数按实际入座数算
function netArenaNow(want) {
    const c = netArenaCfg();
    return { cols: c.cols, rows: c.rows, maxPlayers: c.maxPlayers, count: want };
}

// 主机：让场上人数与「已入座的客机数」一致。
// 还在菜单就开局；打到一半有人进来，就把那条蛇补上。
function netSyncPlayers() {
    if (netRole !== 'host') return;
    const want = netWantedPlayers();
    if (state === 'menu' || state === 'over' || !players) {
        start(want > 1 ? 2 : 1, teamMode, netArenaNow(want));
        return;
    }
    while (players.length < want) {
        if (!addPlayerAt(players.length)) break;
    }
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


// 把一条数据通道接到某个座位上：open / close / message 都记在它自己身上
function netBindChannel(dc, peer) {
    peer.dc = dc;
    dc.addEventListener('open', function () {
        peer.open = true;
        if (netConnTimer) { clearTimeout(netConnTimer); netConnTimer = null; }
        netSyncOpen();
        netSetStatus('通道已建立，正在握手…', '');
        netPeerSend(peer, { t: 'hello', v: APP_VERSION, name: chatMyName() });   // 先对版本，再开局
    });
    dc.addEventListener('close', function () {
        if (netRole === 'host') {
            netDropPeer(peer);       // 座位空出来，别人还能进
            if (state !== 'menu') netSetStatus('有人断开了', netRosterText());
        } else {
            peer.open = false;
            netSyncOpen();
            if (state !== 'menu') netSetStatus('连接已断开', '按 Esc 回到模式选择');
        }
        syncNetBar();
    });
    dc.addEventListener('message', function (ev) { netOnMessage(ev.data, peer); });
}

function netOnMessage(raw, peer) {
    let m = null;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;

    // 握手：版本对不上就明确拒绝，不硬连
    if (m.t === 'hello') {
        if (m.v !== APP_VERSION) {
            netSetStatus('程序版本不一致：对方 v' + m.v + '，本机 v' + APP_VERSION,
                '两边打开同一版页面再连');
            try { peer.dc.close(); } catch (e) { }
            return;
        }
        hideStartUi();
        if (netRole === 'host') {
            if (peer.seat === null || peer.seat === undefined) peer.seat = netTakeSeat();
            peer.name = String(m.name || '').slice(0, 16);   // 聊天时显示这个名字
            // 先告诉对方它坐哪儿，再动对局
            netPeerSend(peer, {
                t: 'welcome', seat: peer.seat, v: APP_VERSION,
                maxPlayers: netMaxPlayers, team: teamMode
            });
            netSyncPlayers();      // 座位 1 一到就开局；之后每多一位就补一条蛇
            netSetStatus('已连接 ✅', netRosterText());
        } else {
            netSetStatus('已连接 ✅', '对局进行中（画面由主机同步）');
        }
        syncNetBar();
        return;
    }

    // 客机：主机告诉我坐哪儿（座位 < 0 就是观战席）
    if (m.t === 'welcome') {
        netSeat = m.seat;
        if (m.maxPlayers) netMaxPlayers = m.maxPlayers;
        hideStartUi();
        netSetStatus('已连接 ✅', netSeat < 0
            ? '玩家席满了，你在观战席：只能看，不能操作'
            : '你是第 ' + (netSeat + 1) + ' 位玩家（座位 ' + netSeat + '）');
        syncNetBar();
        return;
    }

    if (netRole === 'guest') {
        if (m.t === 'state') netApplySnapshot(m);
        else if (m.t === 'chat') chatPush(m.name || '主机', m.text, false);
        else if (m.t === 'askOk') {
            netBarNote(m.ok
                ? (m.what === 'restart' ? '主机同意重开' : '主机同意暂停 / 继续')
                : '主机忽略了你的请求');
        }
        return;
    }

    // 主机：聊天要放在下面那道「座位 > 0」的闸之前 —— 观战席也该能说话
    if (m.t === 'chat') {
        const nm = peer.name || (peer.seat > 0 ? '座位 ' + peer.seat : '观战');
        chatPush(nm, m.text, false);
        netBroadcastOther(peer, { t: 'chat', seat: peer.seat, name: nm, text: m.text });
        return;
    }

    // 主机：把这位客人的操作喂给它自己那条蛇；观战席没有蛇，也就不用理
    if (!players || !(peer.seat > 0) || !players[peer.seat]) return;
    if (m.t === 'dir') {
        turn(players[peer.seat], m.dir);
    } else if (m.t === 'build') {
        players[peer.seat].buildRequested = true;
    } else if (m.t === 'upgrade') {
        // 客机点了升级按钮：记在它自己那条蛇上，帧循环里替它升
        players[peer.seat].upgradeRequested = (m.path === 'B') ? 'B' : 'A';
    } else if (m.t === 'ask') {
        // 客机想暂停 / 重开，得主机点头才算 —— 这里只挂个提示
        netAsk = { what: (m.what === 'restart') ? 'restart' : 'pause', peer: peer };
        syncNetBar();
        netBarNote('座位 ' + peer.seat + ' 发来请求');
    }
}


// ------------------------------ 联机状态条 ------------------------------
// 连上以后联机面板就消失了，所以操作全部收拢到这条状态条：
//   * 主机和客机都能随时「退出连接」
//   * 客机不能自己暂停 / 重开，只能向主机发请求，由主机点「同意」才算数
let netAsk = null;         // 主机这边待处理的请求：{ what: 'pause'|'restart', peer }
let netNoteTimer = null;
let netHostStage = 'idle'; // 连接码模式的主机：'idle' | 'offer'（等应答码）| 'done'（可以再加人）

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
    const spectating = netSpectating();
    document.getElementById('netBarWho').textContent = isGuest
        ? (spectating ? '联机中 · 观战'
            : netSeat === null ? '联机中 · 我是客机（等主机分配座位）'
                : '联机中 · 我是客机（座位 ' + netSeat + '）')
        : '联机中 · 我是主机（' + netRosterText() + '）';
    document.getElementById('netBarState').textContent =
        spectating ? '观战中 · 只能看，不能操作'
            : state === 'paused' ? '已暂停'
                : state === 'over' ? '本局结束'
                    : state === 'running' ? '对局进行中' : '';

    // 客机（不是观战）：只有「请求」按钮
    const pauseBtn = document.getElementById('netBarPause');
    pauseBtn.hidden = !isGuest || spectating;
    pauseBtn.textContent = state === 'paused' ? '请求继续' : '请求暂停';
    document.getElementById('netBarRestart').hidden = !isGuest || spectating;

    // 主机：等客人的请求
    const showAsk = !isGuest && !!netAsk;
    document.getElementById('netAskText').hidden = !showAsk;
    document.getElementById('netAskOk').hidden = !showAsk;
    document.getElementById('netAskNo').hidden = !showAsk;
    if (showAsk) {
        document.getElementById('netAskText').textContent =
            (netAsk.peer && netAsk.peer.seat > 0 ? '座位 ' + netAsk.peer.seat + ' ' : '客机') +
            (netAsk.what === 'restart' ? '请求重开一局' : '请求暂停 / 继续');
    }
}

// 客机专用：向主机发请求（观战席没有这个权限）
function netAskHost(what) {
    if (!netOpen || netRole !== 'guest' || netSpectating()) return;
    netSend({ t: 'ask', what: what });
    netBarNote('已请求，等主机回应…');
}

document.getElementById('netBarPause').addEventListener('click', function () { netAskHost('pause'); });
document.getElementById('netBarRestart').addEventListener('click', function () { netAskHost('restart'); });
document.getElementById('netBarLeave').addEventListener('click', function () { showMenu(); });

document.getElementById('netAskOk').addEventListener('click', function () {
    const ask = netAsk;
    netAsk = null;
    if (ask && ask.peer) netPeerSend(ask.peer, { t: 'askOk', what: ask.what, ok: true });
    if (ask && ask.what === 'restart') start(2, teamMode, netArenaNow(netWantedPlayers()));
    else togglePause();
    netBarNote('已同意客机的请求');
    syncNetBar();
});

document.getElementById('netAskNo').addEventListener('click', function () {
    if (netAsk && netAsk.peer) netPeerSend(netAsk.peer, { t: 'askOk', what: netAsk.what, ok: false });
    netAsk = null;
    netBarNote('已忽略客机的请求');
    syncNetBar();
});

// 主机：给下一个座位生成连接码。已经连上的客人不受影响，可以一位一位地加。
// 玩家席发完之后，再点就是观战码 —— 人满了还能进来看。
async function netHostCreate() {
    if (netRole !== 'host') netLeave();   // 第一次点「我是主机」：把旧的清干净
    netRole = 'host';

    const peer = { seat: netTakeSeat(), pc: null, dc: null, open: false };
    netPeers.push(peer);
    netPrimary = peer;

    peer.pc = new RTCPeerConnection({ iceServers: netIceServers() });
    netWatchIce(peer.pc);
    peer.dc = peer.pc.createDataChannel('snake', { ordered: true });
    netBindChannel(peer.dc, peer);

    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    const gatherOk = await netWaitIce(peer.pc);

    // 出码时顺带把自己的局域网地址带上（桌面版）：手机解析不了 mDNS 名字时，
    // 对方能直接拿这个地址补候选，不用手输 IP。
    // lanOwnBase 会把内嵌信令服务起起来，同时把 ip:port 报回来。
    let myIp = '';
    if (NATIVE) {
        try { await lanOwnBase(null); myIp = lanShareIp(); } catch (e) { myIp = ''; }
    }
    netCodeEl.value = netEncode(peer.pc.localDescription.sdp, 'offer', myIp);
    netHostStage = 'offer';
    netSetStatus(peer.seat < 0 ? '① 这是一张观战码（玩家席已经满了）'
        : '① 这是座位 ' + peer.seat + ' 的连接码',
        (peer.seat < 0 ? '发给只想看的人　' : '发给第 ' + (peer.seat + 1) + ' 位玩家　') +
        netDiag(peer.pc) + netIceWarn(peer.pc, gatherOk) +
        '　v' + APP_VERSION + '；② 对方发回应答码后粘到框里点「接受应答码」');
    netUseBtnEl.disabled = false;
    netUseBtnEl.textContent = '接受应答码';
}

async function netHostAcceptAnswer() {
    const peer = netPrimary;
    if (!peer || !peer.pc || netRole !== 'host') throw new Error('NO_HOST');
    const d = netDecode(netCodeEl.value, 'answer');
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    const patched = netPatchIp(peer.pc, netPeerIpEl.value.trim());
    netSetStatus('已收到应答码，正在打洞…',
        '对方程序版本 v' + d.version + '，与本机一致 ✓' +
        (patched ? '；已按你填的 IP 补了 ' + patched + ' 条候选' : ''));
    netHostStage = 'done';
    netUseBtnEl.disabled = false;
    netUseBtnEl.textContent = '再让一个人进来';
    netStartConnectTimer(peer.pc);
}

async function netGuestAcceptOffer() {
    if (netRole !== 'guest') throw new Error('NO_GUEST');
    const d = netDecode(netCodeEl.value, 'offer');
    netLeave();
    netRole = 'guest';

    const peer = { seat: null, pc: null, dc: null, open: false };
    netPeers = [peer];
    netPrimary = peer;

    peer.pc = new RTCPeerConnection({ iceServers: netIceServers() });
    netWatchIce(peer.pc);
    peer.pc.addEventListener('datachannel', function (ev) {
        netBindChannel(ev.channel, peer);
    });

    await peer.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    // 优先用主机写在码里的局域网地址；没有就看手填的那个框
    const useIp = d.ip || netPeerIpEl.value.trim();
    const patched = netPatchIp(peer.pc, useIp);
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    const gatherOk = await netWaitIce(peer.pc);

    netCodeEl.value = netEncode(peer.pc.localDescription.sdp, 'answer');
    netSetStatus('② 把下面的应答码发回给主机',
        netDiag(peer.pc) + netIceWarn(peer.pc, gatherOk) +
        (patched ? '　已按 ' + useIp + ' 补了 ' + patched +
            ' 条候选（' + (d.ip ? '来自主机码' : '你填的 IP') + '）' : '') +
        '　v' + APP_VERSION + '，对方 v' + d.version + ' ✓');
    netUseBtnEl.disabled = true;
    netStartConnectTimer(peer.pc);
}

// 打洞迟迟不通就说清楚，别让人干等
function netStartConnectTimer(pc) {
    if (netConnTimer) clearTimeout(netConnTimer);
    netConnTimer = setTimeout(function () {
        netConnTimer = null;
        if (netOpen) return;

        // 按候选情况分诊，别只丢一句"超时"
        const c = (pc && pc._c) || { host: 0, mdns: 0, srflx: 0, relay: 0 };
        let why;
        if (!c.srflx && !c.relay) {
            why = '本机压根没拿到公网候选（STUN 不通）：检查网络/防火墙，或在上面填一个能用的 STUN';
        } else if (!c.relay) {
            why = '双方都拿到了公网地址却打不通，多半是对称 NAT 或防火墙。同一局域网一般能直连；' +
                '跨网这条路需要在上面填一个 TURN 中继';
        } else {
            why = '已经有中继候选还是不通，检查 TURN 的地址和账号密码';
        }
        netSetStatus('打洞超时了',
            why + '　（' + netDiag(pc) + '）' +
            '　同一局域网里（手机连电脑）最常见的是电脑防火墙拦了 UDP：' +
            'Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙，' +
            '把 snake-army.exe 和 msedgewebview2.exe（桌面版真正收发 UDP 的是 WebView2 ' +
            '那个进程，不是主程序）都勾上「专用」和「公用」；浏览器版则是浏览器自己。' +
            '再确认手机连的是同一个 Wi-Fi，走的不是流量。');
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
// 关卡配置整个打包带走 —— 以前是这里列一遍、客机那边再列一遍，
// 加一个字段最容易漏掉客机那一半。
function netPackCfg() {
    const out = {};
    for (const k in levelCfg) out[k] = levelCfg[k];
    out.cols = levelCfg.cols || COLS;      // 0 = 跟随模式默认，这里换成真实值
    out.rows = levelCfg.rows || ROWS;
    out.team = teamMode;
    return out;
}

// 客机：整个合并回来。客机不跑逻辑，这些值只用于显示和「照着画」
function netApplyCfg(cfg) {
    if (!cfg) return;
    for (const k in cfg) {
        if (k === 'team' && !TEAM_MODES[cfg[k]]) continue;
        if (typeof levelCfg[k] === 'number' && typeof cfg[k] !== 'number') continue;
        levelCfg[k] = cfg[k];
    }
    if (TEAM_MODES[cfg.team]) teamMode = cfg.team;
}

// 主机：把「还没发过的」剪短动画打包给客机（一次性事件，发过就不再发）
let netCutSentId = 0;

function netPackCuts() {
    if (!cutFx || !cutFx.length) return null;
    const out = [];
    for (let i = 0; i < cutFx.length; i++) {
        const fx = cutFx[i];
        if (fx.id <= netCutSentId) continue;
        const flat = [];
        for (let k = 0; k < fx.cells.length; k++) flat.push(fx.cells[k].x, fx.cells[k].y);
        out.push({ i: players.indexOf(fx.owner), c: flat, h: fx.hp, d: [fx.dir.x, fx.dir.y] });
        netCutSentId = Math.max(netCutSentId, fx.id);
    }
    return out.length ? out : null;
}

// 客机：照着主机说的，在本地放一遍同样的动画
function netApplyCuts(list) {
    if (!list || !list.length) return;
    if (!cutFx) cutFx = [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const p = players[c.i] || players[0];
        const cells = [];
        for (let k = 0; k < c.c.length; k += 2) cells.push({ x: c.c[k], y: c.c[k + 1] });
        if (!cells.length) continue;
        if (typeof sfxCut === 'function') sfxCut();     // 客机也听得到「切断」
        cutFx.push({
            id: ++cutFxSeq,
            cells: cells,
            hp: c.h || cells.map(function () { return levelCfg.hp0; }),
            dir: { x: c.d[0], y: c.d[1] },
            at: gameNow,
            bodyColor: p.def.body,
            headColor: p.def.head
        });
        while (cutFx.length > 6) cutFx.shift();
    }
}

function netSnapshot() {
    return {
        t: 'state',
        now: Math.round(gameNow),
        st: state,
        cols: COLS, rows: ROWS,
        w: W, h: H,
        ox: Math.round(renderOffsetX), oy: Math.round(renderOffsetY),
        // 放大动画进行到哪了：场地已经长到多大（客机不跑动画，照这个画）
        bw: Math.round(drawWorldW), bh: Math.round(drawWorldH),
        wid: widenStartAt ? Math.round(widenStartAt) : 0,
        wfc: widenFromCols, wfr: widenFromRows,
        mode: mode, team: teamMode, best: best,
        // 关卡配置整个带过去：客机只读，面板上照着显示
        cfg: netPackCfg(),
        cut: netPackCuts(),        // 刚被剪短的头颈（客机照着放缩回动画）
        pl: players.map(function (p, i) {
            return {
                i: i,
                b: netPackBody(p.body),
                hp: p.hp.map(netRound),
                d: p.dir, q: p.queue,
                acc: netRound(p.acc), sm: p.stepMs,
                bu: p.boostUntil ? Math.round(p.boostUntil) : 0,
        iv: p.invUntil ? Math.round(p.invUntil) : 0,
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
        pw: {   // 每种道具可能有好几个
            speed: powerList('speed').map(function (p) { return [p.x, p.y]; }),
            widen: powerList('widen').map(function (p) { return [p.x, p.y]; })
        },
        pr: {
            speed: Math.round(powerRespawnAt.speed || 0),
            widen: Math.round(powerRespawnAt.widen || 0)
        },
        rv: reviveItem ? [reviveItem.x, reviveItem.y] : null,
        dr: drops.map(function (d) { return [d.x, d.y, d.kind === 'len' ? 1 : 0, Math.round(d.expireAt)]; }),
        tu: turrets.map(function (t) {
            // 末尾两个是升级等级（A 跟踪 / B 火力），客机照着画小点
            return [t.x, t.y, players.indexOf(t.owner), Math.round(t.cooldownUntil), t.upA || 0, t.upB || 0];
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
    if (state !== 'over' && m.st === 'over' && typeof sfxOver === 'function') sfxOver();
    state = m.st;
    if (typeof m.you === 'number') netSeat = m.you;   // 主机告诉我坐哪儿（< 0 = 观战）
    mode = m.mode;
    teamMode = m.team;
    netApplyCfg(m.cfg);                // 关卡配置：客机只照着显示，逻辑仍在主机那边跑
    netApplyCuts(m.cut);               // 剪短动画：主机放什么，客机也放什么
    best = m.best;

    if (COLS !== m.cols || ROWS !== m.rows) {
        COLS = m.cols;
        ROWS = m.rows;
        // 视口按本机屏幕算，不再照抄主机的画布尺寸 ——
        // 大地图靠摄像机滚动，手机和主机的可视范围本来就不一样。
        resizeCanvas();
    }
    renderOffsetX = m.ox;
    renderOffsetY = m.oy;
    // 场地已经长到多大：放在 resizeCanvas 之后写，动画期间才不会被整块场地尺寸盖掉
    if (typeof m.bw === 'number') { drawWorldW = m.bw; drawWorldH = m.bh; syncViewToBoard(); }
    widenStartAt = m.wid;
    widenFromCols = m.wfc;
    widenFromRows = m.wfr;

    players = m.pl.map(function (p) {
        return {
            def: PLAYER_DEFS[p.i],
            body: netUnpackBody(p.b), hp: p.hp, dir: p.d, queue: p.q,
            acc: p.acc, stepMs: p.sm, boostUntil: p.bu, invUntil: p.iv || 0,
            coins: p.c, score: p.s, spawnAt: p.sa, alive: p.al,
            buildRequested: false, upgradeRequested: false, invUntil: p.iv || 0
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
        speed: (m.pw.speed || []).map(function (a) { return { x: a[0], y: a[1] }; }),
        widen: (m.pw.widen || []).map(function (a) { return { x: a[0], y: a[1] }; })
    };
    powerRespawnAt = { speed: m.pr.speed, widen: m.pr.widen };
    reviveItem = m.rv ? { x: m.rv[0], y: m.rv[1] } : null;
    drops = m.dr.map(function (d) {
        return { x: d[0], y: d[1], kind: d[2] ? 'len' : 'coin', expireAt: d[3] };
    });
    turrets = m.tu.map(function (t) {
        return { x: t[0], y: t[1], cooldownUntil: t[3], owner: players[t[2]] || players[0],
            upA: t[4] || 0, upB: t[5] || 0 };
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

    syncPlayingClass();
    syncHud();
    syncNetBar();     // 客机的状态条要跟着主机的状态走
    if (!netPanelEl.hidden || !startPanelEl.hidden) hideStartUi();
}

// ------------------------------ 房间配置面板 ------------------------------
// 主机说了算：地图初始大小、合作/竞争、敌人、道具、房间名与描述。
// 本地单人 / 本地双人一样能改（那时「主机」就是你自己）；客机只读。
// 改完立即生效：模式类当场换，场地变大当场扩，变小会按新尺寸重开一局。
let oldCfgOpen = false;
let oldCfgResume = false;     // 进面板前是不是在跑，关掉时恢复

function _oldCfgNote(text) {
    const el = document.getElementById('cfgNote');
    if (el) el.textContent = text || "";
}

// 面板同步：按角色决定可改还是只读，并把当前值刷上去
function _oldSyncCfgPanel() {
    const panel = document.getElementById('cfgPanel');
    if (!panel) return;
    const isGuest = netRole === 'guest';
    const cols = levelCfg.cols || COLS;
    const rows = levelCfg.rows || ROWS;
    const setVal = function (id, v) {
        const el = document.getElementById(id);
        if (el && document.activeElement !== el && el.value !== String(v)) el.value = v;
    };
    setVal('cfgCols', cols);
    setVal('cfgRows', rows);
    setVal('cfgName', levelCfg.name || '');
    setVal('cfgDesc', levelCfg.desc || '');
    for (const id of ['cfgCols', 'cfgRows', 'cfgName', 'cfgDesc']) {
        const el = document.getElementById(id);
        if (el) el.disabled = isGuest;
    }
    const pair = [
        ['cfgCoop', 'coop', teamMode === 'coop'],
        ['cfgVs', 'vs', teamMode === 'vs'],
        ['cfgEnemies', null, levelCfg.enemies],
        ['cfgPowerups', null, levelCfg.powerups]
    ];
    for (const [id, , on] of pair) {
        const b = document.getElementById(id);
        if (!b) continue;
        b.classList.toggle('is-on', !!on);
        b.disabled = isGuest;
    }
    const en = document.getElementById('cfgEnemies');
    if (en) en.textContent = levelCfg.enemies ? '敌人：开' : '敌人：关';
    const pw = document.getElementById('cfgPowerups');
    if (pw) pw.textContent = levelCfg.powerups ? '道具：开' : '道具：关';
    const who = document.getElementById('cfgWho');
    if (who) {
        who.textContent = isGuest ? '配置由主机控制（这边只读）'
            : '你是主机：改完立即生效（本地模式也一样）';
    }
}

// 面板上改一项：合到当前配置里再应用
function _oldSetCfg(patch) {
    if (netRole === 'guest') return;              // 客机没有修改权
    const next = {
        cols: levelCfg.cols || COLS,
        rows: levelCfg.rows || ROWS,
        team: levelCfg.team,
        enemies: levelCfg.enemies,
        powerups: levelCfg.powerups
    };
    for (const k in patch) next[k] = patch[k];
    const res = applyLevelCfg(next, gameNow);
    if (res === 'restart') cfgNote('场地变小了 —— 已按 ' + COLS + '×' + ROWS + ' 重开一局');
    else if (res === 'grew') cfgNote('场地已扩到 ' + COLS + '×' + ROWS);
    else cfgNote("");
    syncCfgPanel();
    syncHud();
    syncNetBar();
}

function _oldToggleCfgPanel(open) {
    const panel = document.getElementById('cfgPanel');
    if (!panel) return;
    const want = (open === undefined) ? panel.hidden : !!open;
    if (want === oldCfgOpen) return;
    panel.hidden = !want;
    oldCfgOpen = want;
    if (want) {
        if (netRole !== 'guest' && state === 'running') {   // 改配置时先把局停下来
            oldCfgResume = true;
            togglePause();
        }
        cfgNote("");
        syncCfgPanel();
    } else if (oldCfgResume) {
        oldCfgResume = false;
        if (state === 'paused') togglePause();
    }
}

// ------------------------------ 文字聊天 ------------------------------
// 主机转发：客机 -> 主机 -> 其他所有人；主机自己说的直接广播。
// 单机（没联机）时消息只留在自己屏幕上，输入框照样能用。
const CHAT_MAX = 200;      // 单条长度上限
const CHAT_KEEP = 100;     // 本地最多留多少条

// 列表重建的判据。以前比的是「条数变了没有」——
// 条数一样但内容变了（超出 CHAT_KEEP 把老消息挤掉、或者同一条消息里多了个按钮）就不重画了。
let chatVersion = 0;
let chatShown = -1;

function chatMyName() {
    const box = document.getElementById('myName');
    const n = box ? String(box.value || '').trim() : '';
    if (n) return n.slice(0, 16);
    if (netRole === null) return '本地';
    return netRole === 'host' ? '主机' : '客机';
}

function chatPush(name, text, me) {
    text = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    chatLog.push({ me: !!me, name: String(name || '?').slice(0, 16), text: text, at: Date.now() });
    while (chatLog.length > CHAT_KEEP) chatLog.shift();
    chatVersion++;
    if (!chatOpen) chatUnread++;
    renderChat();
}

function chatSend() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    if (!chatSendText(input.value)) return;
    input.value = '';
}

// 发一条消息（聊天框和「发到聊天」都走这里）。返回有没有发出去。
function chatSendText(text) {
    text = String(text || '').trim().slice(0, CHAT_MAX);
    if (!text) return false;
    const me = chatMyName();
    chatPush(me, text, true);
    if (!netOpen) return true;                  // 单机：只显示在自己屏幕上
    if (netRole === 'host') netBroadcast({ t: 'chat', seat: 0, name: me, text: text });
    else netSend({ t: 'chat', text: text });
    return true;
}

function toggleChat(open) {
    const bar = document.getElementById('chatBar');
    if (!bar) return;
    chatOpen = (open === undefined) ? bar.hidden : !!open;
    bar.hidden = !chatOpen;
    if (chatOpen) {
        chatUnread = 0;
        const input = document.getElementById('chatInput');
        if (input) setTimeout(function () { input.focus(); }, 0);
    }
    renderChat();
}

function renderChat() {
    const bar = document.getElementById('chatBar');
    const list = document.getElementById('chatList');
    const btn = document.getElementById('chatBtn');
    if (!bar || !list) return;
    bar.hidden = !chatOpen;
    if (btn) {
        btn.textContent = chatUnread ? '\uD83D\uDCAC ' + chatUnread : '\uD83D\uDCAC';
        btn.classList.toggle('has-new', chatUnread > 0);
    }
    if (!chatOpen) return;
    if (chatShown !== chatVersion) {
        chatShown = chatVersion;
        list.innerHTML = '';
        for (let i = 0; i < chatLog.length; i++) {
            const m = chatLog[i];
            const row = document.createElement('div');
            row.className = 'chatRow' + (m.me ? ' me' : '');
            const who = document.createElement('b');
            who.textContent = m.name + '：';
            const txt = document.createElement('span');
            txt.textContent = m.text;          // 永远走 textContent：消息不是 HTML
            row.appendChild(who);
            row.appendChild(txt);

            // 消息里带关卡短码的话，顺手给个一键导入（不用去复制粘贴）
            if (typeof looksLikeLevelCode === 'function' && looksLikeLevelCode(m.text)) {
                const btn = document.createElement('button');
                btn.className = 'miniBtn ok chatImport';
                btn.textContent = '导入这个关卡';
                btn.addEventListener('click', function () {
                    if (typeof importLevelCode === 'function') importLevelCode(extractLevelCode(m.text));
                });
                row.appendChild(btn);
            }
            list.appendChild(row);
        }
        list.scrollTop = list.scrollHeight;
    }
}

// 面板 / 聊天的按钮接线（本地和联机都要能用）
if (document.getElementById('cfgCoop')) {
    document.getElementById('cfgCoop').addEventListener('click', function () { setCfg({ team: 'coop' }); });
    document.getElementById('cfgVs').addEventListener('click', function () { setCfg({ team: 'vs' }); });
    document.getElementById('cfgEnemies').addEventListener('click', function () { setCfg({ enemies: !levelCfg.enemies }); });
    document.getElementById('cfgPowerups').addEventListener('click', function () { setCfg({ powerups: !levelCfg.powerups }); });
    document.getElementById('cfgCloseBtn').addEventListener('click', function () { toggleCfgPanel(false); });
    for (const id of ['cfgCols', 'cfgRows']) {
        document.getElementById(id).addEventListener('change', function () {
            setCfg({
                cols: parseInt(document.getElementById('cfgCols').value, 10),
                rows: parseInt(document.getElementById('cfgRows').value, 10)
            });
        });
    }
    document.getElementById('cfgName').addEventListener('input', function () {
        if (netRole !== 'guest') levelCfg.name = this.value.trim().slice(0, 24);
    });
    document.getElementById('cfgDesc').addEventListener('input', function () {
        if (netRole !== 'guest') levelCfg.desc = this.value.trim().slice(0, 80);
    });
}
if (document.getElementById('chatBtn')) {
    document.getElementById('chatBtn').addEventListener('click', function () { toggleChat(); });
    document.getElementById('chatCloseBtn').addEventListener('click', function () { toggleChat(false); });
    document.getElementById('chatSendBtn').addEventListener('click', chatSend);
    document.getElementById('chatInput').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); chatSend(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); toggleChat(false); }
    });
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

// 我自己在局域网里的地址：房主开房时 Rust/Python 侧会把 ip:port 报回来，
// 取其中的 ip。出连接码、造 offer 时带上它，对方（尤其手机）就能自动补候选。
function lanShareIp() {
    const h = String(lanShare || '').split(':')[0];
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : '';
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
    direct: '直连：知道对方 IP / 网址就直接搜他的房间，不依赖广播 —— 跨网、公司网里通常更靠谱；' +
        '但 https 页面进不了 http 房间（混合内容会被浏览器拦掉）',
    code: '连接码：手动把码发给对方。不用服务器、https 页面也能用 —— 浏览器版靠它联机'
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
    // 场地 / 人数默认值在 levelDefaults() 里，关卡修改器页面上改
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
        // 玩家席还有空位就能进；满了还能当观战进去
        const freeSeats = (typeof r.freeSeats === 'number') ? r.freeSeats : (r.taken ? 0 : 1);
        const freeSpec = r.freeSpectatorSeats || 0;
        // 第一行只放「谁家的房间、几个人」—— 这一行是 nowrap + 省略号，
        // 塞太多东西就会被截断
        const t1 = document.createElement('span');
        t1.textContent = r.name + '　·　' + (r.player || row.host || '?') +
            '　·　' + (r.players || 1) + '/' + (r.maxPlayers || 2) + ' 人';
        info.appendChild(t1);

        // 第二行放场地和座位情况（可以换行，不会被截）
        const t2 = document.createElement('span');
        t2.className = 'sub2';
        t2.textContent = (r.cols || '?') + '×' + (r.rows || '?') +
            (freeSeats ? '　空 ' + freeSeats + ' 个玩家席' : '　玩家席已满') +
            (freeSpec ? '　观战席空 ' + freeSpec + ' 个' : '') +
            (r.spectators ? '　已有 ' + r.spectators + ' 人观战' : '');
        info.appendChild(t2);

        if (r.desc) {
            const t3 = document.createElement('span');
            t3.className = 'sub2';
            t3.textContent = r.desc;
            info.appendChild(t3);
        }

        const btn = document.createElement('button');
        btn.className = 'startBtn small';
        btn.textContent = freeSeats ? '进入' : '观战';
        btn.disabled = !freeSeats && !freeSpec;
        btn.addEventListener('click', function () { lanJoin(row.url, r.id); });
        div.appendChild(info);
        div.appendChild(btn);
        listEl.appendChild(div);
    }
}

// 开房：先把房间挂到本地信令服务上，再给每个座位造一条连接 + offer 存进去。
// 玩家席 1..maxPlayers-1，再往后两个观战席；谁先点「进入」谁先坐。
async function lanOpenRoom() {
    if (netBusy) return;
    netBusy = true;
    try {
        const portNum = parseInt(document.getElementById('roomPort').value, 10);
        const base = await lanOwnBase(isFinite(portNum) ? portNum : null);
        lanMsgEl.textContent = '正在开房间…';

        netLeave();
        netRole = 'host';

        // 关卡 / 人数 / 房间信息全部来自「关卡修改器」页面（levelCfg），
        // 这里不再另设一套输入框 —— 两套输入最容易改了一边忘了另一边。服务端会再夹一次范围。
        levelCfg.cols = Math.max(ARENA_MIN_COLS, Math.min(ARENA_MAX_COLS, levelCfg.cols || 30));
        levelCfg.rows = Math.max(ARENA_MIN_ROWS, Math.min(ARENA_MAX_ROWS, levelCfg.rows || 15));
        levelCfg.maxPlayers = Math.max(2, Math.min(6, levelCfg.maxPlayers || 2));
        netMaxPlayers = levelCfg.maxPlayers;

        const made = await lanApi(base, '/api/room', {
            name: levelCfg.name,
            desc: levelCfg.desc,
            player: document.getElementById('myName').value.trim(),
            cols: levelCfg.cols,
            rows: levelCfg.rows,
            maxPlayers: levelCfg.maxPlayers
        });
        lanRoom = made.id;
        lanBase = base;

        const seats = [];
        for (let s = 1; s < netMaxPlayers; s++) seats.push(s);
        seats.push(-1, -2);      // 两个观战席
        await Promise.all(seats.map(function (s) { return lanMakeSeat(base, lanRoom, s); }));

        netSetStatus('房间开好了',
            netKind === 'direct' ? '把地址发给对方，让他在「直连」里搜' : '等对方搜到并进入');
        lanMsgEl.textContent = '房间里已有 1 人（你）：还空着 ' + (netMaxPlayers - 1) +
            ' 个玩家席 + 2 个观战席。把　' + lanShare + '　发出去' +
            (netKind === 'direct' ? '，让他粘到上面的地址框里搜' : '，让他搜房间');

        lanStopPolling();
        lanPoll = setInterval(function () { lanPollSeats(base); }, 700);
    } catch (e) {
        lanMsgEl.textContent = '开房失败：' + e.message;
    }
    netBusy = false;
}

// 造一条连接 + 一份 offer，挂到某个座位上
async function lanMakeSeat(base, id, seat) {
    const peer = { seat: seat, pc: null, dc: null, open: false };
    netPeers.push(peer);
    if (!netPrimary) netPrimary = peer;

    peer.pc = new RTCPeerConnection({ iceServers: netIceServers() });
    netWatchIce(peer.pc);
    peer.dc = peer.pc.createDataChannel('snake', { ordered: true });
    netBindChannel(peer.dc, peer);
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    // 同一个局域网用不着公网候选，等 2.5 秒就够，别让人干等
    await netWaitIce(peer.pc, 2500);
    await lanApi(base, '/api/offer', {
        id: id, seat: seat, offer: netEncode(peer.pc.localDescription.sdp, 'offer', lanShareIp())
    });
    return peer;
}

// 轮询：谁把应答递上来了，就把那个座位接上。
// 取回来的应答是幂等的（服务端不消费），所以「已经接过的连接跳过」就够安全。
async function lanPollSeats(base) {
    if (!lanRoom) { lanStopPolling(); return; }
    try {
        // 顺带把「现在几个人」报上去，来客在列表里看到的就是实时的
        const r = await lanApi(base, '/api/answers?id=' + encodeURIComponent(lanRoom) +
            '&players=' + netWantedPlayers());
        const list = r.answers || [];
        for (let i = 0; i < list.length; i++) {
            const peer = netPeerBySeat(list[i].seat);
            if (!peer || !peer.pc || peer.pc.currentRemoteDescription) continue;
            const d = netDecode(list[i].answer, 'answer');
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
            netStartConnectTimer(peer.pc);
            netSetStatus('有人进来了，正在打洞…', netRosterText());
        }
        lanMsgEl.textContent = netRosterText() + '　地址 ' + lanShare;
    } catch (e) { /* 房间还没人应答，继续轮询 */ }
}

// 加入：取一个空座位的 offer -> 造 answer -> 递回主机
async function lanJoin(base, id) {
    try {
        lanMsgEl.textContent = '正在取房间信息…';
        const info = await lanApi(base, '/api/offer?id=' + encodeURIComponent(id));
        const d = netDecode(info.offer, 'offer');

        netLeave();
        netRole = 'guest';
        const peer = { seat: info.seat, pc: null, dc: null, open: false };
        netPeers = [peer];
        netPrimary = peer;

        peer.pc = new RTCPeerConnection({ iceServers: netIceServers() });
        netWatchIce(peer.pc);
        peer.pc.addEventListener('datachannel', function (ev) {
            netBindChannel(ev.channel, peer);
        });
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });

        // 同一局域网最容易踩的坑：浏览器把本地候选写成 xxxx.local（mDNS），手机端经常
        // 解析不了；公网候选又得靠路由器的 NAT 回环（hairpin），家用路由器多半不支持 ——
        // 于是 ICE 没有任何能用的候选对，只能干等到超时。
        // 而我们本来就知道主机的局域网地址：offer 就是从 http://<主机IP>:<端口> 取的，
        // 连接码里也可能带着（d.ip）。直接拿它把 mDNS 候选补成真地址。
        const hostIp = d.ip || ipOfUrl(base);
        const patched = netPatchIp(peer.pc, hostIp);

        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await netWaitIce(peer.pc, 2500);
        await lanApi(base, '/api/answer', {
            id: id, seat: info.seat, answer: netEncode(peer.pc.localDescription.sdp, 'answer')
        });

        const seatNote = info.seat < 0 ? '观战席：通道一开就能看' : '通道一开就自动开局';
        const ipNote = patched ? '　已按主机的局域网地址 ' + hostIp + ' 补了 ' + patched + ' 条候选'
            : hostIp ? '　主机地址 ' + hostIp + '（候选里没有需要补的 mDNS 名）'
                : '　没拿到主机的局域网地址，必要时在下面手填一个 IP';
        netSetStatus('已把应答递回主机', seatNote + ipNote);
        lanMsgEl.textContent = (info.seat < 0 ? '已加入（观战）' : '已加入') +
            (patched ? '，已补主机地址 ' + hostIp : '') + '，等待连接…';
        netStartConnectTimer(peer.pc);
    } catch (e) {
        lanMsgEl.textContent = '加入失败：' + e.message;
    }
}

if (NATIVE) {
    document.getElementById('lanScanBtn').addEventListener('click', lanScan);
    document.getElementById('lanHostBtn').addEventListener('click', lanOpenRoom);
}
startBtnNetEl.addEventListener('click', function () {
    if (typeof toggleCfgPanel === 'function') toggleCfgPanel(false);   // 不叠层
    startPanelEl.hidden = true;
    netPanelEl.hidden = false;
    netCodeEl.value = '';
    netUseBtnEl.disabled = true;
    netUseBtnEl.textContent = '用这段码';
    netSetTeam(teamMode);
    if (typeof syncStartPresets === 'function') syncStartPresets();   // 房间设置：初始值 + 客机只读
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
        // 这一位已经接上了：再点这个按钮就是给下一位造连接码
        if (netHostStage === 'done') {
            netHostCreate().catch(function (e) { netSetStatus('出错了', netExplain(e)); });
            return;
        }
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
