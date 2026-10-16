// ------------------------------ 主题（浅色 / 深色 / 跟随系统）------------------------------
// 页面颜色走 index.html 里的 CSS 变量；画布颜色走 config.js 的 COLOR，这里换掉其中
// 「底色 / 网格 / 文字」三项 —— 其余棋子颜色在两种底色上都看得清，不动。
//
// 三态：
//   auto （默认）跟着系统的 prefers-color-scheme 走，且系统切换时实时跟随
//   light / dark 手动锁定
const THEME_KEY = 'snake-army-theme';

// canvas 用的两套底色
const BOARD_PALETTE = {
    light: { board: 'saddlebrown', grid: 'rgba(0, 0, 0, 0.07)', mask: 'rgba(0, 0, 0, 0.62)' },
    dark: { board: '#1b2027', grid: 'rgba(255, 255, 255, 0.06)', mask: 'rgba(0, 0, 0, 0.66)' }
};

let themeMode = 'auto';          // 'auto' | 'light' | 'dark'
let themeDarkNow = false;        // 当前实际是不是深色（auto 时由系统决定）

function themeMedia() {
    return (typeof window !== 'undefined' && window.matchMedia)
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
}

function systemPrefersDark() {
    const m = themeMedia();
    return !!(m && m.matches);
}

function themeLoadPref() {
    try {
        const v = localStorage.getItem(THEME_KEY);
        if (v === 'auto' || v === 'light' || v === 'dark') themeMode = v;
    } catch (e) { }
}

function themeIsDark() {
    return themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark());
}

// 把当前主题落到 DOM 和 canvas 调色板上
function applyTheme() {
    themeDarkNow = themeIsDark();
    const root = document.documentElement;
    if (themeMode === 'auto') root.removeAttribute('data-theme');   // 交给 CSS 的媒体查询
    else root.setAttribute('data-theme', themeMode);

    const pal = BOARD_PALETTE[themeDarkNow ? 'dark' : 'light'];
    for (const k in pal) COLOR[k] = pal[k];
    if (typeof syncThemeBtn === 'function') syncThemeBtn();
}

function setThemeMode(mode) {
    themeMode = (mode === 'light' || mode === 'dark') ? mode : 'auto';
    try {
        localStorage.setItem(THEME_KEY, themeMode);
    } catch (e) { }
    applyTheme();
}

// 按钮上循环：跟随系统 -> 浅色 -> 深色 -> 跟随系统
function cycleTheme() {
    setThemeMode(themeMode === 'auto' ? 'light' : (themeMode === 'light' ? 'dark' : 'auto'));
    if (typeof sfxUpgrade === 'function') sfxUpgrade();     // 点一下有反馈音
}

const THEME_LABEL = { auto: '🖥 主题：跟随系统', light: '☀ 主题：浅色', dark: '🌙 主题：深色' };

function syncThemeBtn() {
    const label = THEME_LABEL[themeMode] || THEME_LABEL.auto;
    for (const id of ['themeBtn', 'themeBtn2']) {
        const el = document.getElementById(id);
        if (el && el.textContent !== label) el.textContent = label;
    }
}

function themeInit() {
    themeLoadPref();
    applyTheme();
    const m = themeMedia();
    if (m) {
        const onChange = function () { if (themeMode === 'auto') applyTheme(); };
        if (m.addEventListener) m.addEventListener('change', onChange);
        else if (m.addListener) m.addListener(onChange);      // 老 Safari
    }
    window.addEventListener('load', function () {
        const a = document.getElementById('themeBtn');
        const b = document.getElementById('themeBtn2');
        if (a) a.addEventListener('click', function () { cycleTheme(); });
        if (b) b.addEventListener('click', function () { cycleTheme(); });
        syncThemeBtn();
    });
}

themeInit();
