// 联机模块 · 传输层
//
// 这里只放「只依赖参数、不碰游戏状态」的部分：连接码编解码、ICE 工具、网络配置。
//
// 为什么联机层要分成两个文件：这里只放「给参数就出结果」的纯逻辑，要读写
// players / state / 渲染 / DOM 的部分全在 net-session.js。边界这样划：
//     net.js          —— 连接码编解码、ICE 工具、网络配置
//     net-session.js  —— 握手、快照打包与还原、状态条、房间与类型切换 UI
//
// 以经典脚本（非 module）加载，所以里面的函数和常量直接落在全局词法作用域，
// index.html 里的调用点一行都不用改。

// 程序版本：联机双方必须一致。快照格式 / 玩法一变就往上加，
// 它会被写进连接码、握手时再对一次，不一致直接拒掉而不是硬连。
const APP_VERSION = '0.1.0';
const NET_TAG = 'SNK';          // 连接码的 Magic
const NET_SEND_MS = 33;         // 主机发快照的间隔（约 30Hz）
const NET_CONNECT_MS = 25000;   // 打洞超时
const NET_GATHER_MS = 8000;     // 等 ICE 收集的上限

// STUN 多备几家、且分两组：同一组里任意一家通了就能拿到公网候选。
// 443 端口那家是为了穿一些只放行 443 的防火墙。
const NET_ICE_DEFAULT = [
    { urls: [
        'stun:stun.qq.com:3478',
        'stun:stun.miwifi.com:3478',
        'stun:stun.chat.bilibili.com:3478',
        'stun:stun.sipnet.net:3478'
    ] },
    { urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:stun.nextcloud.com:443'
    ] }
];

// 连接码 = SNK#程序版本#角色#base64(SDP)[#主机的局域网IP]。
// 用 # 分隔是因为版本号里本来就有点；前缀让「粘错码 / 版本不对」在本地就能认出来。
//
// 末尾那个 IP 是可选的：主机在局域网里出码时带上它，对方（尤其是手机）就能自动
// 把 mDNS 候选补成真地址 —— 浏览器把本地候选写成 xxxx.local，手机上经常解析不了。
function netEncode(sdp, role, ip) {
    const tail = (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ? '#' + ip : '';
    return NET_TAG + '#' + APP_VERSION + '#' + (role === 'offer' ? 'O' : 'A') + '#' + btoa(sdp) + tail;
}

// 'http://192.168.1.23:47812' -> '192.168.1.23'（拿不到就返回空串）
function ipOfUrl(u) {
    try {
        const h = new URL(String(u)).hostname;
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : '';
    } catch (e) {
        return '';
    }
}

function netDecode(code, wantRole) {
    const s = String(code || '').replace(/\s+/g, '');
    if (!s) throw new Error('EMPTY');

    const parts = s.split('#');
    if (parts.length < 4 || parts[0] !== NET_TAG) throw new Error('FORMAT');

    const role = (parts[2] === 'O') ? 'offer' : 'answer';
    if (wantRole && role !== wantRole) throw new Error('ROLE:' + role);

    // 角色先报错（更能指路），版本其次
    if (parts[1] !== APP_VERSION) throw new Error('VERSION:' + parts[1]);

    let sdp = '';
    try { sdp = atob(parts[3]); } catch (e) { throw new Error('BASE64'); }
    if (sdp.indexOf('v=0') !== 0) throw new Error('SDP');

    const ip = (parts[4] && /^\d{1,3}(\.\d{1,3}){3}$/.test(parts[4])) ? parts[4] : '';
    return { role: role, sdp: sdp, version: parts[1], ip: ip };
}

// 把上面那些错误码翻译成能看懂的话
function netExplain(e) {
    const k = (e && e.message) || String(e);
    if (k === 'EMPTY') return '框里还没有码 —— 先把对方发来的那段粘进来';
    if (k === 'NO_HOST') return '请先点「我是主机」生成连接码，再来粘对方的应答码';
    if (k === 'NO_GUEST') return '请先点「我是客机」，再来粘主机的连接码';
    if (k === 'FORMAT') return '这段不是本游戏的连接码（应该以 ' + NET_TAG + '# 开头）';
    if (k.indexOf('VERSION:') === 0) {
        return '程序版本不一致：对方 v' + k.slice(8) + '，本机 v' + APP_VERSION +
            ' —— 请两边都打开同一版的页面';
    }
    if (k === 'ROLE:offer') return '这是「主机码」，主机这边要粘的是对方发回来的「应答码」';
    if (k === 'ROLE:answer') return '这是「应答码」，客机这边要粘的是主机发过来的「主机码」';
    if (k === 'BASE64') return '这段码不完整（解不开），多半是复制时漏了尾巴，重新完整复制一次';
    if (k === 'SDP') return '这段码解出来不是会话描述，可能把别的文字混进去了';
    if (/Failed to set remote|Invalid SDP|Called in wrong state|m-line/i.test(k)) {
        return '这段码用不了：' + k;
    }
    return '出错了：' + k;
}

// 自填的 ICE 服务器优先，内置的兜底；一行一个，
// 写 turn:主机:端口|用户名|密码 就带账号
function netIceServers() {
    const list = [];
    const box = document.getElementById('netIce');
    const raw = String((box && box.value) || '').split(/[\n,]/);
    for (let i = 0; i < raw.length; i++) {
        const s = raw[i].trim();
        if (!s) continue;
        const p = s.split('|');
        if (p.length >= 3) {
            list.push({ urls: p[0].trim(), username: p[1].trim(), credential: p[2].trim() });
        } else {
            list.push({ urls: s });
        }
    }
    for (let i = 0; i < NET_ICE_DEFAULT.length; i++) list.push(NET_ICE_DEFAULT[i]);
    return list;
}

// 局域网兜底：Chrome 把本地候选写成 mDNS 名（xxx.local），对方经常解析不了。
// 这里让人手填一个 IP，直接把候选里的地址换掉补进去。
function netPatchIp(pc, ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return 0;
    const sdp = (pc.remoteDescription && pc.remoteDescription.sdp) || '';
    const re = /a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ host[^\r\n]*/g;

    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/;
    let m = null;
    let n = 0;
    while ((m = re.exec(sdp)) !== null) {
        // 本来就已经是真地址的（没被 mDNS 混淆）不用补，省得塞一堆重复候选
        if (isIp.test(m[5])) continue;
        const cand = 'candidate:' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] + ' ' +
            ip + ' ' + m[6] + ' typ host';
        try {
            const p = pc.addIceCandidate({ candidate: cand, sdpMid: '0', sdpMLineIndex: 0 });
            if (p && p.catch) p.catch(function () { });   // 被拒也别冒成未捕获错误
            n++;
        } catch (e) { /* 加不进去就算了，原来的候选还在 */ }
    }
    return n;
}

// 候选统计挂在 pc._c 上（由 index.html 里的 netWatchIce 边收边填）
function netDiag(pc) {
    const c = (pc && pc._c) || { host: 0, mdns: 0, srflx: 0, relay: 0 };
    let n = 0;
    try { n = (pc.getConfiguration().iceServers || []).length; } catch (e) { n = -1; }
    return '候选：本地 ' + c.host + (c.mdns ? '（其中 mDNS ' + c.mdns + '）' : '') +
        ' / 公网 ' + c.srflx + ' / 中继 ' + c.relay + '；ICE 服务器 ' + n + ' 组';
}

// 一个公网/中继候选都没有的话，跨网基本没戏，出码时就先把话说明白
function netIceWarn(pc, gatherOk) {
    if (!gatherOk) {
        return '　⚠ 候选没收集完（网络慢或 STUN 不通），连不上就重新点一次「我是主机」';
    }
    const c = (pc && pc._c) || {};
    if (((c.srflx || 0) + (c.relay || 0)) === 0) {
        return '　⚠ 本机没拿到公网候选，跨网多半连不上（同一局域网仍可一试）';
    }
    return '';
}

// 等 ICE 收集完成再出码 —— 提前出码会让码里缺公网候选，跨网直接打不通。
// 返回是否真的收集完了（超时返回 false，界面上要提示重试）。
function netWaitIce(pc, maxMs) {
    return new Promise(function (resolve) {
        if (pc.iceGatheringState === 'complete') { resolve(true); return; }

        let done = false;
        function finish(ok) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(ok);
        }
        const timer = setTimeout(function () { finish(false); }, maxMs || NET_GATHER_MS);
        pc.addEventListener('icegatheringstatechange', function () {
            if (pc.iceGatheringState === 'complete') finish(true);
        });
    });
}
