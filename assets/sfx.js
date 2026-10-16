// ------------------------------ 音效 ------------------------------
// 不用任何音频文件：全部用 Web Audio 现场合成（振荡器 + 音量包络）。
// 好处：零资源、离线可用、想改音色就是改这里的几个数字。
//
// 浏览器的自动播放策略要求「先有用户交互才出声」，所以 AudioContext 推迟到
// 第一次按键 / 点击时才创建；在那之前所有播放请求都会被安全忽略。
//
// 全部 API 在没有 AudioContext 的环境（老浏览器、被策略禁掉的预览框）里都是空操作，
// 不会抛异常 —— 游戏本体不该因为没声音而跑不起来。
const SFX_KEY = 'snake-army-sfx';

let sfxCtx = null;
let sfxEnabled = true;
let sfxPlayed = 0;          // 播过多少次（探针用它验证「该响的时候响了」）
let sfxMaster = null;

function sfxSupported() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
}

function sfxIsEnabled() {
    return !!sfxEnabled;
}

function sfxSetEnabled(on) {
    sfxEnabled = !!on;
    try {
        localStorage.setItem(SFX_KEY, sfxEnabled ? '1' : '0');
    } catch (e) { /* 隐私模式存不了就算了 */ }
}

function sfxLoadPref() {
    try {
        const v = localStorage.getItem(SFX_KEY);
        if (v !== null) sfxEnabled = (v === '1');
    } catch (e) { }
}

// 第一次交互时建 context（在用户手势里创建/恢复才不会被挂起）
function sfxInit() {
    if (sfxCtx || !sfxSupported()) return sfxCtx;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        sfxCtx = new AC();
        sfxMaster = sfxCtx.createGain();
        sfxMaster.gain.value = 0.5;
        sfxMaster.connect(sfxCtx.destination);
    } catch (e) {
        sfxCtx = null;
    }
    return sfxCtx;
}

function sfxResume() {
    const c = sfxInit();
    if (c && c.state === 'suspended' && c.resume) {
        try { c.resume(); } catch (e) { }
    }
    return c;
}

// 一个音：type 波形、f0->f1 扫频、vol 音量、dur 时长（秒）、delay 延后多久再响
let sfxToneSeq = 0;        // 一共合成过多少个音（探针靠它比较「两种道具响法不同」）
let sfxLastTone = null;    // 最后一个音的参数

function sfxTone(f0, f1, dur, type, vol, delay) {
    sfxToneSeq++;
    sfxLastTone = { f0: f0, f1: f1, dur: dur, type: type };
    const c = sfxInit();
    if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);

    // 快起慢落：避免「咔」的爆音
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol || 0.2), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(sfxMaster);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
}

// 每个音效都长这样：没开/不支持就安静地返回，开了就计数 + 合成
function sfxPlay(fn) {
    if (!sfxEnabled) return;
    sfxPlayed++;
    try { fn(); } catch (e) { }
}

function sfxEat(score) {
    sfxPlay(function () {
        const p = 520 + Math.min(24, score || 0) * 22;
        sfxTone(p, p * 1.6, 0.07, 'square', 0.16, 0);
    });
}

// 道具：每种一个音 —— 加速是「电」、拓宽是「张」，认不出来的（以后新加的）走保底上滑
function sfxPowerUp(kind) {
    sfxPlay(function () {
        if (kind === 'speed') {
            // 加速：电流声（快上滑 + 一层更高的方波 + 一点沙）
            sfxTone(360, 1400, 0.16, 'sawtooth', 0.15, 0);
            sfxTone(720, 2100, 0.12, 'square', 0.07, 0.02);
            sfxNoise(0.12, 2600, 0.05, 1.2);
        } else if (kind === 'widen') {
            // 拓宽：一层层往外撑（两个三角 + 收尾上滑 + 一声低频「展开」）
            sfxTone(392, 392, 0.1, 'triangle', 0.16, 0);
            sfxTone(587, 587, 0.12, 'triangle', 0.15, 0.08);
            sfxTone(784, 990, 0.2, 'sine', 0.12, 0.16);
            sfxNoise(0.22, 700, 0.06, 0.8);
        } else {
            sfxTone(300, 980, 0.2, 'sine', 0.2, 0);
        }
    });
}

function sfxBuild() {
    sfxPlay(function () {
        sfxTone(200, 130, 0.12, 'triangle', 0.22, 0);
        sfxTone(90, 70, 0.16, 'sine', 0.16, 0);
    });
}

function sfxUpgrade() {
    sfxPlay(function () {
        sfxTone(660, 660, 0.09, 'square', 0.16, 0);
        sfxTone(990, 990, 0.12, 'square', 0.16, 0.09);
    });
}

// 被剪短：往下一划的「切断」声
function sfxCut() {
    sfxPlay(function () { sfxTone(520, 150, 0.14, 'sawtooth', 0.18, 0); });
}

function sfxDie() {
    sfxPlay(function () {
        sfxTone(520, 110, 0.45, 'sine', 0.24, 0);
        sfxTone(260, 70, 0.5, 'triangle', 0.14, 0.05);
    });
}

function sfxRevive() {
    sfxPlay(function () {
        sfxTone(523, 523, 0.1, 'sine', 0.18, 0);
        sfxTone(659, 659, 0.1, 'sine', 0.18, 0.1);
        sfxTone(784, 784, 0.16, 'sine', 0.18, 0.2);
    });
}

function sfxOver() {
    sfxPlay(function () {
        sfxTone(220, 180, 0.85, 'triangle', 0.2, 0);
        sfxTone(262, 210, 0.85, 'triangle', 0.14, 0.02);
        sfxTone(330, 260, 0.9, 'triangle', 0.12, 0.04);
    });
}

// 蛇移动：每一步一声很轻的「沙」。用一小段噪声 + 低通，比纯音更像「摩擦」，
// 不会变成有旋律的嘀嘀声。它是底噪性质的音，所以音量压得很低，
// 而且 55ms 内只响一次 —— 高铁大陆 100ms 一步也不会糊成一片。
let sfxNoiseBuf = null;

function sfxNoise(dur, freq, vol, q) {
    const c = sfxInit();
    if (!c) return;
    if (!sfxNoiseBuf) {
        const n = Math.max(1, Math.floor(c.sampleRate * 0.05));
        sfxNoiseBuf = c.createBuffer(1, n, c.sampleRate);
        const d = sfxNoiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = sfxNoiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    f.Q.value = q || 0.7;
    const g = c.createGain();
    const t0 = c.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(sfxMaster);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
}

// 步长越短，摩擦声越「脆」（音调高一点），听感就跟着速度走
function sfxStep(stepMs) {
    if (!sfxThrottled('step', 55)) return;
    const f = (stepMs && stepMs < 400) ? 1500 : 900;
    sfxPlay(function () { sfxNoise(0.045, f, 0.05); });
}

// 金币：亮一点的两声（经典「叮」），加身长的掉落用低一档的同一个音
function sfxCoin(low) {
    sfxPlay(function () {
        const a = low ? 660 : 988;
        const b = low ? 880 : 1319;
        sfxTone(a, a, 0.06, 'square', 0.14, 0);
        sfxTone(b, b, 0.12, 'square', 0.13, 0.055);
    });
}

// 子弹：很短很轻的「啾」——炮塔一多会吵，所以按 key 节流
const SFX_LAST = {};

function sfxThrottled(key, ms) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (SFX_LAST[key] && now - SFX_LAST[key] < ms) return false;
    SFX_LAST[key] = now;
    return true;
}

function sfxShoot() {
    if (!sfxThrottled('shoot', 70)) return;      // 70ms 内只响一次：多座塔一起开火也不会变成嗡嗡声
    sfxPlay(function () { sfxTone(880, 320, 0.07, 'square', 0.07, 0); });
}

// 子弹打中（没打死也有反馈）
function sfxHit() {
    if (!sfxThrottled('hit', 45)) return;
    sfxPlay(function () { sfxTone(260, 120, 0.06, 'triangle', 0.13, 0); });
}

// 敌人蛇被打死：比命中更厚一点
function sfxKill() {
    sfxPlay(function () {
        sfxTone(420, 90, 0.22, 'sawtooth', 0.18, 0);
        sfxTone(160, 60, 0.26, 'triangle', 0.14, 0.02);
    });
}

// 开局：两下上行
function sfxStart() {
    sfxPlay(function () {
        sfxTone(440, 440, 0.1, 'square', 0.16, 0);
        sfxTone(660, 660, 0.14, 'square', 0.16, 0.1);
    });
}

// 音效开关：开始页一个、关卡修改器里一个，两边文案保持一致
function syncSfxBtns() {
    const label = sfxEnabled ? '🔊 音效：开' : '🔇 音效：关';
    for (const id of ['sfxBtn', 'sfxBtn2']) {
        const el = document.getElementById(id);
        if (el && el.textContent !== label) el.textContent = label;
    }
}

function sfxToggle() {
    sfxSetEnabled(!sfxEnabled);
    if (sfxEnabled) {                 // 打开时给个反馈音（同时也是在用户手势里恢复 context）
        sfxResume();
        sfxUpgrade();
    }
    syncSfxBtns();
}

sfxLoadPref();

window.addEventListener('load', function () {
    const a = document.getElementById('sfxBtn');
    const b = document.getElementById('sfxBtn2');
    if (a) a.addEventListener('click', sfxToggle);
    if (b) b.addEventListener('click', sfxToggle);
    syncSfxBtns();
});
