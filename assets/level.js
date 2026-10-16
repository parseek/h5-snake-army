// ------------------------------ 关卡修改器 ------------------------------
// 本地单人 / 本地双人 / 联机开房，改关卡都走这一个页面。
// 页面由下面这张表生成 —— 加一个可调参数只要在这里加一行：
//   key   : levelCfg 里的字段名
//   type  : num（数字）| bool（开关）| team（合作/竞争）| text（文本）
//   live  : 'now' 立刻生效（默认）| 'restart' 下一局才完全生效 | 'room' 开房那一刻生效
// 权限：主机（含本地单人/双人）可改；客机只读，值跟着快照走。
const LEVEL_FIELDS = [
    { sec: '场地与玩法' },
    { key: 'cols', label: '场地宽', type: 'num', min: ARENA_MIN_COLS, max: ARENA_MAX_COLS, hint: '调试用' },
    { key: 'rows', label: '场地高', type: 'num', min: ARENA_MIN_ROWS, max: ARENA_MAX_ROWS, hint: '调试用' },
    { key: 'team', label: '模式', type: 'team' },
    { key: 'maxPlayers', label: '人数上限', type: 'num', min: 2, max: 6, hint: '开房时定' },

    { sec: '蛇' },
    { key: 'len0', label: '初始身长', type: 'num', min: 2, max: 12, unit: '节', live: 'restart' },
    { key: 'hp0', label: '每节血量', type: 'num', min: 1, max: 9, unit: '点', live: 'restart' },
    { key: 'stepMs', label: '每步间隔', type: 'num', min: 50, max: 1200, step: 10, hint: '毫秒，越小越快' },

    { sec: '场上刷什么' },
    { key: 'appleBase', label: '开局苹果', type: 'num', min: 1, max: 200, hint: '个（之后随时间涨）' },
    { key: 'apples', label: '苹果上限', type: 'num', min: 0, max: 200, hint: '个（0 = 无上限）' },
    { key: 'enemies', label: '敌人', type: 'bool' },
    { key: 'enemyMax', label: '敌人上限', type: 'num', min: 1, max: 12, unit: '条' },
    { key: 'enemyGap', label: '敌人补位', type: 'num', min: 500, max: 60000, step: 500, hint: '毫秒' },
    { key: 'enemySpeed', label: '敌人速度', type: 'num', min: 50, max: 1000, step: 10, hint: '%，100 = 原速' },
    { key: 'powerups', label: '道具', type: 'bool' },
    { key: 'boostMs', label: '加速时长', type: 'num', min: 1000, max: 120000, step: 1000, hint: '毫秒' },
    { key: 'powerGap', label: '道具刷新', type: 'num', min: 10, max: 250, step: 5, hint: '%，越小越快' },
    { key: 'revive', label: '复活道具', type: 'bool' },
    { key: 'cutWall', label: '撞墙剪短', type: 'num', min: 0, max: 10, hint: '节（0 = 撞死）' },
    { key: 'cutSnake', label: '撞蛇剪短', type: 'num', min: 0, max: 10, hint: '节（0 = 撞死）' },
    { key: 'invMs', label: '剪短后无敌', type: 'num', min: 0, max: 10000, step: 500, hint: '毫秒（0 = 不给）' },

    { sec: '炮塔' },
    { key: 'turretCost', label: '建塔耗身长', type: 'num', min: 1, max: 10, unit: '节' },
    { key: 'turretCoins', label: '建塔耗币', type: 'num', min: 0, max: 10, unit: '币' },
    { key: 'turretMax', label: '塔上限', type: 'num', min: 1, max: 12, unit: '座' },

    { sec: '房间信息' },
    { key: 'name', label: '房间名', type: 'text', placeholder: '房间名（游戏里给对方看）' },
    { key: 'desc', label: '房间描述', type: 'text', placeholder: '房间描述（可留空）' }
];

// 每种道具单独三行（生成 / 刷新间隔 / 同屏上限）。加一种道具只要在下面加一行，
// 关卡表、输入框、短码打包都跟着走。
const ITEM_DEFS = [
    { kind: 'speed', label: '加速道具' },
    { kind: 'widen', label: '拓宽道具' }
];

LEVEL_FIELDS.push({ sec: '每种道具' });
for (let i = 0; i < ITEM_DEFS.length; i++) {
    const it = ITEM_DEFS[i];
    LEVEL_FIELDS.push({ key: 'i_' + it.kind + '_on', label: it.label + '生成', type: 'bool' });
    LEVEL_FIELDS.push({
        key: 'i_' + it.kind + '_gap', label: it.label + '间隔', type: 'num',
        min: 1000, max: 120000, step: 500, hint: '毫秒（再乘总倍率）'
    });
    LEVEL_FIELDS.push({
        key: 'i_' + it.kind + '_max', label: it.label + '同屏', type: 'num',
        min: 1, max: 6, hint: '个'
    });
}

const CFG_RESTART_ONLY = ['len0', 'hp0'];   // 改完要重开一局才完全生效的字段

let cfgOpen = false;
let cfgResume = false;
let cfgMsg = '';

function cfgId(key) {
    return 'cfg' + key.charAt(0).toUpperCase() + key.slice(1);
}

function makePatch(key, v) {
    const p = {};
    p[key] = v;
    return p;
}

// 按表生成页面（只在加载时做一次）。为了沿用以前的 id，
// 场地/模式/开关/名字这几个的 id 和旧版一致（cfgCols / cfgCoop / cfgEnemies ...）。
function buildLevelPage() {
    const body = document.getElementById('cfgBody');
    if (!body || body.childNodes.length) return;

    const out = [];
    let row = false;
    const closeRow = function () {
        if (row) {
            out.push('</div>');
            row = false;
        }
    };

    for (let i = 0; i < LEVEL_FIELDS.length; i++) {
        const f = LEVEL_FIELDS[i];
        if (f.sec) {
            closeRow();
            out.push('<div class="tip sec">' + f.sec + '</div>');
            continue;
        }
        if (f.type === 'team') {
            closeRow();
            out.push('<div class="row">' +
                '<button class="startBtn small" id="cfgCoop">合作</button>' +
                '<button class="startBtn small" id="cfgVs">竞争</button></div>');
            continue;
        }
        if (f.type === 'bool') {
            closeRow();
            out.push('<div class="row"><button class="startBtn small" id="' + cfgId(f.key) + '"></button></div>');
            continue;
        }
        if (f.type === 'text') {
            closeRow();
            out.push('<input id="' + cfgId(f.key) + '" class="netIce" spellcheck="false" placeholder="' +
                (f.placeholder || f.label) + '" />');
            continue;
        }
        if (!row) {
            out.push('<div class="row">');
            row = true;
        }
        out.push('<label class="field"><span>' + f.label +
            (f.hint ? ' <i>' + f.hint + '</i>' : '') + '</span>' +
            '<input id="' + cfgId(f.key) + '" class="netIce portInput" type="number" min="' + f.min +
            '" max="' + f.max + '" step="' + (f.step || 1) + '" /></label>');
    }
    closeRow();
    body.innerHTML = out.join('');
    wireLevelPage();
    buildPresetBar();
    buildStartPresets();
    buildCodeBar();
}

function wireLevelPage() {
    for (let i = 0; i < LEVEL_FIELDS.length; i++) {
        const f = LEVEL_FIELDS[i];
        if (!f.key || f.type === 'team') continue;
        const el = document.getElementById(cfgId(f.key));
        if (!el) continue;

        if (f.type === 'bool') {
            el.addEventListener('click', function () { setCfg(makePatch(f.key, !levelCfg[f.key])); });
        } else if (f.type === 'text') {
            el.addEventListener('input', function () {
                if (netRole === 'guest') return;   // 客机只读
                levelCfg[f.key] = el.value;
            });
        } else {
            el.addEventListener('change', function () {
                setCfg(makePatch(f.key, parseInt(el.value, 10)));
            });
        }
    }

    document.getElementById('cfgCoop').addEventListener('click', function () { setCfg({ team: 'coop' }); });
    document.getElementById('cfgVs').addEventListener('click', function () { setCfg({ team: 'vs' }); });
    document.getElementById('cfgCloseBtn').addEventListener('click', function () { toggleCfgPanel(false); });
    document.getElementById('cfgResetBtn').addEventListener('click', function () { resetLevelCfg(); });
    document.getElementById('cfgRestartBtn').addEventListener('click', function () { restartLevel(); });

    // 两个入口：开始界面（本地）和联机面板（开房前）。游戏里的 ⚙ 按钮在 input.js 里接的。
    const b1 = document.getElementById('levelBtnStart');
    if (b1) b1.addEventListener('click', function () { toggleCfgPanel(true); });
    const b2 = document.getElementById('levelBtnNet');
    if (b2) b2.addEventListener('click', function () { toggleCfgPanel(true); });
    const b3 = document.getElementById('netMaxPlayersBtn');
    if (b3) b3.addEventListener('click', function () { tapFeedback(); cycleMaxPlayers(); });
}

// 页面同步：值 / 禁用状态 / 按钮文字都刷一遍（syncHud 每次都调它）
function syncCfgPanel() {
    const panel = document.getElementById('cfgPanel');
    if (!panel) return;
    const isGuest = netRole === 'guest';
    syncRoomSettings();      // 联机面板里的房间摘要 / 人数上限也跟着刷

    for (let i = 0; i < LEVEL_FIELDS.length; i++) {
        const f = LEVEL_FIELDS[i];
        if (!f.key || f.type === 'team') continue;
        const el = document.getElementById(cfgId(f.key));
        if (!el) continue;
        el.disabled = isGuest;

        if (f.type === 'bool') {
            const on = !!levelCfg[f.key];
            el.classList.toggle('is-on', on);
            el.textContent = f.label + '：' + (on ? '开' : '关');
        } else if (document.activeElement !== el && el.value !== String(levelCfg[f.key])) {
            el.value = levelCfg[f.key];     // 正在输入的那个框别去动它
        }
    }

    const coop = document.getElementById('cfgCoop');
    const vs = document.getElementById('cfgVs');
    if (coop) { coop.classList.toggle('is-on', teamMode === 'coop'); coop.disabled = isGuest; }
    if (vs) { vs.classList.toggle('is-on', teamMode === 'vs'); vs.disabled = isGuest; }

    const who = document.getElementById('cfgWho');
    if (who) {
        who.textContent = isGuest
            ? '关卡由主机控制（这边只读）'
            : (netRole === 'host' ? '你在开房：改完立刻生效，客机跟着走' : '本地游戏：随便改，改完立刻生效');
    }
    // 预设：客机不能改关卡，但可以把自己看到的这套**下载**走
    for (const id of ['cfgPresetSel', 'cfgPresetName', 'cfgPresetSaveBtn', 'cfgPresetDelBtn', 'cfgLevelUpBtn', 'cfgCodeLoadBtn']) {
        const el = document.getElementById(id);
        if (el) el.disabled = isGuest;
    }

    document.getElementById('cfgNote').textContent = cfgMsg;
    syncLevelInfo();
}

// 改一项：合进 levelCfg 再应用（能立刻生效的立刻生效）
function setCfg(patch) {
    if (netRole === 'guest') return;             // 客机没有修改权
    let restart = false;
    startPresetId = '';          // 手动改过任何一项 -> 开始页的选中态回到「自定义」
    for (const k in patch) {
        const v = patch[k];
        if (v === undefined || (typeof v === 'number' && !isFinite(v))) continue;
        levelCfg[k] = v;
        if (CFG_RESTART_ONLY.indexOf(k) >= 0) restart = true;
    }

    const res = applyLevelCfg(levelCfg, gameNow);
    if (res === 'restart') cfgMsg = '场地变小了 —— 已按 ' + COLS + '×' + ROWS + ' 重开一局';
    else if (res === 'grew') cfgMsg = '场地扩到 ' + COLS + '×' + ROWS + '（当场生效）';
    else if (restart) cfgMsg = '初始身长 / 每节血量：下一局生效（点「按新关卡重开」）';
    else cfgMsg = '';

    syncCfgPanel();
    syncHud();
    syncNetBar();
}

function cfgNote(text) {     // 旧名字，留着给别处调用
    cfgMsg = text || '';
    syncCfgPanel();
}

function resetLevelCfg() {
    if (netRole === 'guest') return;
    const d = levelDefaults();
    for (const k in d) levelCfg[k] = d[k];
    teamMode = levelCfg.team;

    // 0 表示「跟随模式默认」，得真的把场地收回模式尺寸
    setArenaSize(MODES[mode].cols, MODES[mode].rows, gameNow);
    levelCfg.cols = 0;
    levelCfg.rows = 0;

    applyLevelCfg(levelCfg, gameNow);
    cfgMsg = '已恢复默认关卡';
    syncCfgPanel();
    syncHud();
    syncNetBar();
}

// 按当前关卡重开一局。客机不能自己开，只能请求主机（和暂停一样）。
function restartLevel() {
    if (netRole === 'guest') {
        netAskHost('restart');
        cfgMsg = '已请主机按新关卡重开';
        syncCfgPanel();
        return;
    }
    if (netRole === 'host') start(2, teamMode, netArenaNow(netWantedPlayers()));
    else start(mode, teamMode);
    cfgMsg = '已按当前关卡重开一局';
    syncCfgPanel();
}

// 打开 / 关闭。打开时把局停下（客机只是看，不停）
// 从联机面板进来的编辑器，关掉后要回到联机面板（而不是两层叠在一起）
let cfgBackToNet = false;

function toggleCfgPanel(open) {
    const panel = document.getElementById('cfgPanel');
    if (!panel) return;
    const want = (open === undefined) ? panel.hidden : !!open;
    if (want === cfgOpen) return;

    panel.hidden = !want;
    cfgOpen = want;
    if (want) {
        const netPanel = document.getElementById('netPanel');
        cfgBackToNet = !!(netPanel && !netPanel.hidden);
        if (cfgBackToNet) netPanel.hidden = true;      // 一次只留一层
        if (netRole !== 'guest' && state === 'running') {   // 改关卡时先把局停一下
            cfgResume = true;
            togglePause();
        }
        cfgMsg = '';
        syncCfgPanel();
    } else {
        if (cfgBackToNet) {                            // 关掉后回房间设置
            cfgBackToNet = false;
            const netPanel = document.getElementById('netPanel');
            if (netPanel) netPanel.hidden = false;
        }
        if (cfgResume) {
            cfgResume = false;
            if (state === 'paused') togglePause();
        }
    }
    // 「返回游戏」在「从房间设置进来」时其实是「返回房间设置」
    const close = document.getElementById('cfgCloseBtn');
    if (close) close.textContent = cfgBackToNet ? '← 返回房间设置' : '返回游戏';
}

// ------------------------------ 关卡预设 ------------------------------
// 内置几个，外加玩家自己存的（localStorage）。预设只覆盖「关卡」那一半，
// 房间名 / 描述 / 人数上限保持不动 —— 那是这间屋子的事，不是关卡的事。
const LEVEL_PRESETS = [
    { id: 'classic', name: '经典', note: '默认那套：15×15 慢慢吃', cfg: {} },
    { id: 'brawl', name: '大乱斗', note: '80×40 快节奏，满场敌人和苹果',
      cfg: { cols: 80, rows: 40, stepMs: 380, apples: 8, enemyMax: 12, enemyGap: 3000, turretMax: 8 } },
    { id: 'survive', name: '生存', note: '40×30，血厚、苹果少、敌人不断补；撞墙 / 撞蛇各剪短 3 节',
      cfg: { cols: 40, rows: 30, stepMs: 450, hp0: 3, apples: 2, enemyMax: 8, enemyGap: 3000, turretMax: 2,
        // 撞了不是直接死，而是从头部剪掉 3 节（剪到最短 2 节还短就死）
        cutWall: 3, cutSnake: 3 } },
    { id: 'practice', name: '空场练习', note: '30×20，没有敌人，专心练手感',
      cfg: { cols: 30, rows: 20, enemies: false, apples: 6, stepMs: 300, turretMax: 6 } },
    { id: 'giant', name: '巨幕', note: '200×150 大地图，镜头跟着你走',
      cfg: { cols: 200, rows: 150, apples: 12, enemyMax: 12, stepMs: 420, turretMax: 12 } },
    { id: 'rail', name: '高铁大陆', note: '200×150 极速：玩家 100ms、敌人 5 倍速、道具各 4 个',
      cfg: { cols: 200, rows: 150, stepMs: 100, enemySpeed: 500, enemyGap: 3000, apples: 12, enemyMax: 12, turretMax: 12,
        // 道具量：总倍率 25%（默认的 4 倍频）+ 每种同屏 4 个（原来是各 1 个）
        powerGap: 25, i_speed_max: 4, i_widen_max: 4,
        // 苹果：开局就摆 120 个，而且不设上限（随时间一直涨，直到场地塞满）
        appleBase: 120, apples: 0 } },
    { id: 'blitz', name: '闪电战', note: '180ms 一步、1 血，撞一下就出局',
      cfg: { stepMs: 180, hp0: 1, apples: 4, enemyMax: 4, turretCost: 1 } }
];

const PRESET_KEY = 'snake-army-levels-v1';

function loadSavedPresets() {
    try {
        const raw = localStorage.getItem(PRESET_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(function (p) { return p && p.name && p.cfg; }) : [];
    } catch (e) {
        return [];                      // 隐私模式 / 存坏了都当没有，别让整页挂掉
    }
}

function writeSavedPresets(list) {
    try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(list));
    } catch (e) { /* 存不下就算了 */ }
}

// 只认关卡表里的字段；数字按范围夹一遍 ——
// 手改过的文件不该能把步长设成 1ms、把场地设成十万格
function sanitizeCfg(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (let i = 0; i < LEVEL_FIELDS.length; i++) {
        const f = LEVEL_FIELDS[i];
        if (!f.key) continue;
        const v = raw[f.key];
        if (v === undefined || v === null) continue;
        if (f.type === 'num') {
            const n = Number(v);
            if (isFinite(n)) out[f.key] = Math.max(f.min, Math.min(f.max, Math.round(n)));
        } else if (f.type === 'bool') {
            // 手改过的文件里 "false" / "no" / "0" / "off" 都当关
            const s = String(v).trim().toLowerCase();
            out[f.key] = !(v === false || v === 0 || s === 'false' || s === 'no' || s === '0' || s === 'off');
        } else if (f.type === 'text') {
            out[f.key] = String(v).slice(0, f.key === 'name' ? 24 : 80);
        } else if (f.type === 'team') {
            if (TEAM_MODES[v]) out.team = v;
        }
    }
    return out;
}

function savedPresetIndex(name) {
    const list = loadSavedPresets();
    for (let i = 0; i < list.length; i++) {
        if (list[i].name === name) return i;
    }
    return -1;
}

// ------------------------------ 开始页的关卡按钮 ------------------------------
// 点一下只是「选中这个关卡」（不会开局）；最后一个「🛠 自定义」打开编辑器。
const PRESET_ROWS = ['startPresetRow', 'netPresetRow'];

function buildStartPresets() {
    for (const rowId of PRESET_ROWS) buildPresetRowInto(rowId);
    syncStartPresets();
}

// 预设缩略图：按这套关卡的场地比例现画一个小示意图。零资源，全部现画；
// 图上的信息是真的 —— 长条场地一眼看出是「高铁大陆 / 巨幕」，方场地是「经典 / 生存」。// 每个内置预设一张手写的 SVG（96×58）。用 currentColor 的部分跟着主题/选中态变色，
// 特征色固定。data-icon 只是给测试和调试用的标记。
const PRESET_ICONS = {
    // 经典：方场地 + 一条绿蛇 + 一个苹果
    classic:
        '<svg class="presetIcon" data-icon="classic" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="20" y="8" width="56" height="42" rx="4" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<circle cx="62" cy="20" r="3" fill="crimson"/>' +
        '<circle cx="30" cy="38" r="3.2" fill="#008000"/><circle cx="37" cy="38" r="3.2" fill="#008000"/>' +
        '<circle cx="44" cy="38" r="3.2" fill="#008000"/><circle cx="44" cy="31" r="3.2" fill="#146b14"/>' +
        '</svg>',

    // 大乱斗：宽场地 + 满场敌人和苹果（密到发糊就对了）
    brawl:
        '<svg class="presetIcon" data-icon="brawl" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="8" y="12" width="80" height="34" rx="4" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<circle cx="20" cy="21" r="2.6" fill="crimson"/><circle cx="34" cy="30" r="2.6" fill="#a24bd4"/>' +
        '<circle cx="46" cy="19" r="2.6" fill="#a24bd4"/><circle cx="58" cy="33" r="2.6" fill="crimson"/>' +
        '<circle cx="70" cy="22" r="2.6" fill="#a24bd4"/><circle cx="80" cy="35" r="2.6" fill="#a24bd4"/>' +
        '<circle cx="27" cy="38" r="2.6" fill="#008000"/><circle cx="63" cy="15" r="2.6" fill="crimson"/>' +
        '</svg>',

    // 生存：厚血（三颗心）+ 少苹果（场地里空空荡荡）
    survive:
        '<svg class="presetIcon" data-icon="survive" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="14" y="8" width="68" height="42" rx="4" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-dasharray="3 3"/>' +
        '<path d="M22 22c-4-4-9-2-9 2 0 4 6 7 9 9 3-2 9-5 9-9 0-4-5-6-9-2Z" fill="#ff4d6d"/>' +
        '<path d="M47 18c-3-3-7-1.5-7 1.5 0 3 4.5 5.2 7 6.8 2.5-1.6 7-3.8 7-6.8 0-3-4-4.5-7-1.5Z" fill="#ff4d6d"/>' +
        '<path d="M74 22c-3-3-7-1.5-7 1.5 0 3 4.5 5.2 7 6.8 2.5-1.6 7-3.8 7-6.8 0-3-4-4.5-7-1.5Z" fill="#ff4d6d"/>' +
        '</svg>',

    // 空场练习：一块干净的空场地，只有你自己那条蛇
    practice:
        '<svg class="presetIcon" data-icon="practice" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="20" y="8" width="56" height="42" rx="4" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="5 4"/>' +
        '<circle cx="38" cy="30" r="3.4" fill="#008000"/>' +
        '</svg>',

    // 巨幕：大屏幕 + 四角标记
    giant:
        '<svg class="presetIcon" data-icon="giant" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="10" y="10" width="76" height="38" rx="3" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<path d="M6 20V6h14M90 20V6H76M6 38v14h14M90 38v14H76" stroke="currentColor" stroke-opacity="0.5" fill="none"/>' +
        '<circle cx="30" cy="29" r="3" fill="#008000"/><circle cx="52" cy="24" r="2.6" fill="crimson"/><circle cx="64" cy="34" r="2.6" fill="#a24bd4"/>' +
        '</svg>',

    // 高铁大陆：又扁又长的场地 + 速度线 + 闪电
    rail:
        '<svg class="presetIcon" data-icon="rail" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="6" y="24" width="84" height="24" rx="4" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<path d="M10 18h30M18 11h22M30 4h14" stroke="currentColor" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M78 4L70 18h6l-3 12 12-16h-6l4-10Z" fill="#ffd21f"/>' +
        '<circle cx="20" cy="36" r="3" fill="#008000"/><circle cx="34" cy="36" r="2.6" fill="crimson"/>' +
        '<circle cx="50" cy="36" r="2.6" fill="crimson"/><circle cx="66" cy="36" r="2.6" fill="#a24bd4"/>' +
        '</svg>',

    // 闪电战：一颗大闪电 + 一颗空心心（只有 1 滴血，碰一下就没了）
    blitz:
        '<svg class="presetIcon" data-icon="blitz" viewBox="0 0 96 58" aria-hidden="true">' +
        '<path d="M56 2L34 30h12l-6 26 24-32H52l8-22Z" fill="#ffd21f"/>' +
        '<path d="M24 14c-4-4-10-2-10 3 0 5 7 9 10 11 3-2 10-6 10-11 0-5-6-7-10-3Z" fill="none" stroke="#ff4d6d" stroke-width="2"/>' +
        '</svg>'
};

// 图标上要画哪些「特征徽章」——全部从关卡数值推导，所以以后新加预设自动就有：
//   速度（步长越小闪电越多）/ 厚血（心）/ 没有敌人（禁）/ 道具很多（星）/ 自定义（虚线 + 加号）
function presetBadges(cfg, custom) {
    const step = Math.round(cfg.stepMs || 500);
    return {
        speed: step <= 140 ? 3 : (step <= 260 ? 2 : (step <= 420 ? 1 : 0)),
        hp: Math.round(cfg.hp0 || 1) >= 3,
        noEnemy: cfg.enemies === false,
        items: Math.round(cfg.i_speed_max || 0) + Math.round(cfg.i_widen_max || 0) >= 4,
        custom: !!custom
    };
}

// 一个小闪电（速度）
function boltSvg(x, y, s) {
    return '<path d="M' + x + ' ' + (y - s) + 'L' + (x - s * 0.7) + ' ' + (y + s * 0.15) +
        'H' + (x - s * 0.1) + 'L' + (x - s * 0.35) + ' ' + (y + s) +
        'L' + (x + s * 0.75) + ' ' + (y - s * 0.1) + 'H' + (x + s * 0.1) + 'Z" fill="#ffd21f"/>';
}

// 一个小心形（厚血）
function heartSvg(x, y, s) {
    return '<path d="M' + x + ' ' + (y + s * 0.55) +
        'C' + (x - s * 1.15) + ' ' + (y - s * 0.35) + ' ' + (x - s * 0.35) + ' ' + (y - s * 1.05) + ' ' + x + ' ' + (y - s * 0.4) +
        'C' + (x + s * 0.35) + ' ' + (y - s * 1.05) + ' ' + (x + s * 1.15) + ' ' + (y - s * 0.35) + ' ' + x + ' ' + (y + s * 0.55) +
        'Z" fill="#ff4d6d"/>';
}

// 预设图标：用 SVG 现拼，缩略图就是「这套关卡的场地比例 + 道具密度 + 特征徽章」。
// 用 currentColor，所以跟着主题/选中态变色，任何缩放都清晰，也不需要任何图片文件。
function presetIconSvg(cfg, id, custom) {
    // 内置预设：用写好的那张
    if (!custom && PRESET_ICONS[id]) return PRESET_ICONS[id];

    const cols = Math.max(4, Math.round(cfg.cols || 15));
    const rows = Math.max(4, Math.round(cfg.rows || 15));
    const VW = 96;
    const VH = 58;

    // 场地矩形：按比例装进框里（长条关卡一眼就看出来）
    const k = Math.min((VW - 10) / cols, (VH - 10) / rows);
    const w = Math.max(12, cols * k);
    const h = Math.max(12, rows * k);
    const x = (VW - w) / 2;
    const y = (VH - h) / 2;

    // 用 id 当种子：同一套关卡每次画出来都一样
    let seed = 7;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) & 0xffff;
    const rnd = function () {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const dot = function (color, r) {
        return '<circle cx="' + (x + (0.08 + rnd() * 0.84) * w).toFixed(1) +
            '" cy="' + (y + (0.08 + rnd() * 0.84) * h).toFixed(1) +
            '" r="' + r + '" fill="' + color + '"/>';
    };

    let out = '<svg class="presetIcon" data-icon="' + (custom ? 'custom' : 'auto') + '" viewBox="0 0 ' + VW + ' ' + VH + '" aria-hidden="true">';
    // 场地
    out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="3" fill="currentColor" fill-opacity="0.10" ' +
        'stroke="currentColor" stroke-opacity="0.5"/>';

    // 网格：格子太小就不画（200×150 会糊成一片）
    if (k >= 3) {
        let d = '';
        for (let cx = 1; cx < cols; cx++) {
            const px = (x + cx * k).toFixed(1);
            d += 'M' + px + ' ' + y.toFixed(1) + 'V' + (y + h).toFixed(1);
        }
        for (let cy = 1; cy < rows; cy++) {
            const py = (y + cy * k).toFixed(1);
            d += 'M' + x.toFixed(1) + ' ' + py + 'H' + (x + w).toFixed(1);
        }
        out += '<path d="' + d + '" stroke="currentColor" stroke-opacity="0.13" fill="none"/>';
    }

    // 苹果 / 敌人 / 炮塔：数量也按关卡来，密度一眼可见
    const apples = Math.max(1, Math.min(16, Math.round(cfg.apples || 4)));
    for (let i = 0; i < apples; i++) out += dot('crimson', 1.5);
    const enemies = (cfg.enemies === false) ? 0 : Math.max(0, Math.min(9, Math.round((cfg.enemyMax || 3) / 2)));
    for (let i = 0; i < enemies; i++) out += dot('#a24bd4', 1.7);
    const turrets = Math.max(0, Math.min(6, Math.round((cfg.turretMax || 4) / 3)));
    for (let i = 0; i < turrets; i++) out += dot('#ffd166', 1.4);

    // 玩家那条蛇（不在种子随机里，位置固定）
    out += '<circle cx="' + (x + 0.3 * w).toFixed(1) + '" cy="' + (y + 0.55 * h).toFixed(1) + '" r="2.2" fill="#008000"/>';

    // ---------------- 特征徽章 ----------------
    const bd = presetBadges(cfg, custom);

    // 速度：右上角排闪电（越快越多）
    for (let i = 0; i < bd.speed; i++) out += boltSvg(VW - 10 - i * 9, 11, 6);

    // 厚血：左上角一颗心
    if (bd.hp) out += heartSvg(12, 10, 6);

    // 没敌人：右上角一个「禁」圈
    if (bd.noEnemy) {
        out += '<circle cx="' + (VW - 12) + '" cy="11" r="6" fill="none" stroke="#ff8fa3" stroke-width="1.6"/>' +
            '<path d="M' + (VW - 16.2) + ' 6.8L' + (VW - 7.8) + ' 15.2" stroke="#ff8fa3" stroke-width="1.6"/>';
    }

    // 道具很多：左下角一颗四角星
    if (bd.items) {
        const sx = 13;
        const sy = VH - 11;
        out += '<path d="M' + sx + ' ' + (sy - 7) + 'L' + (sx + 2) + ' ' + (sy - 2) + 'L' + (sx + 7) + ' ' + sy +
            'L' + (sx + 2) + ' ' + (sy + 2) + 'L' + sx + ' ' + (sy + 7) + 'L' + (sx - 2) + ' ' + (sy + 2) +
            'L' + (sx - 7) + ' ' + sy + 'L' + (sx - 2) + ' ' + (sy - 2) + 'Z" fill="#00bfff"/>';
    }

    // 自定义：虚线场地 + 右下角加号（表示「你自己画」）
    if (bd.custom) {
        out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) +
            '" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.8" stroke-dasharray="4 3"/>';
        const px = VW - 13;
        const py = VH - 12;
        out += '<path d="M' + (px - 6) + ' ' + py + 'H' + (px + 6) + 'M' + px + ' ' + (py - 6) + 'V' + (py + 6) +
            '" stroke="#7fd7ff" stroke-width="2.4" stroke-linecap="round"/>';
    }

    out += '</svg>';
    return out;
}

function presetCard(row, id, name, note, cfg) {
    const card = document.createElement('button');
    card.className = 'startBtn presetCard';
    if (id) card.setAttribute('data-preset', id);
    else card.setAttribute('data-custom', row.id);
    card.title = note;

    const ico = document.createElement('span');
    ico.className = 'presetIconBox';
    ico.innerHTML = presetIconSvg(cfg, id || 'custom', !id);
    card.appendChild(ico);

    const nm = document.createElement('span');
    nm.className = 'presetName';
    nm.textContent = name;
    card.appendChild(nm);

    const nt = document.createElement('span');
    nt.className = 'presetNote';
    nt.textContent = note || '';
    card.appendChild(nt);

    row.appendChild(card);
    return card;
}

function buildPresetRowInto(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    row.innerHTML = '';

    for (let i = 0; i < LEVEL_PRESETS.length; i++) {
        (function (p) {
            // 缩略图要画「这套关卡的实际样子」：预设没写的字段用关卡默认值补上
            const eff = Object.assign({}, levelDefaults(), p.cfg);
            if (!p.cfg.cols) {
                eff.cols = MODES[mode].cols;
                eff.rows = MODES[mode].rows;
            }
            const card = presetCard(row, p.id, p.name, p.note, eff);
            card.addEventListener('click', function () {
                tapFeedback();
                if (typeof netRole !== 'undefined' && netRole === 'guest') return;   // 客机只读
                applyPresetCfg(p.cfg, '已选「' + p.name + '」');
                startPresetId = p.id;      // applyPresetCfg 内部会清掉，所以放在它后面
                syncStartPresets();
            });
        })(LEVEL_PRESETS[i]);
    }

    // 「自定义」也做一张卡：+ 号 + 说明
    const custom = presetCard(row, '', '自定义', '改数值 / 存档 / 短码', { cols: 15, rows: 15, apples: 3, enemyMax: 4, turretMax: 3 });
    custom.className = 'startBtn presetCard customPreset';
    custom.title = '打开关卡编辑器：改数值 / 存预设 / 下载 / 短码';
    custom.addEventListener('click', function () {
        tapFeedback();
        startPresetId = '';
        syncStartPresets();
        toggleCfgPanel(true);
    });

    syncStartPresets();
}

// 开始页和联机面板共用一套「选中态 + 房间设置摘要」
function syncStartPresets() {
    for (const rowId of PRESET_ROWS) {
        const row = document.getElementById(rowId);
        if (!row) continue;
        const btns = row.querySelectorAll('[data-preset]');
        for (let i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('is-on', btns[i].getAttribute('data-preset') === startPresetId);
        }
        const custom = row.querySelector('[data-custom]');
        if (custom) custom.classList.toggle('is-on', !startPresetId);
        const guest = (typeof netRole !== 'undefined') && netRole === 'guest';
        const all = row.querySelectorAll('.startBtn');
        for (let k = 0; k < all.length; k++) all[k].disabled = guest;   // 客机只读
    }
    syncRoomSettings();
}

// 联机面板里的「人数上限」：初始值跟着关卡 / 模式走，主机可以直接点着改
function syncRoomSettings() {
    const btn = document.getElementById('netMaxPlayersBtn');
    if (!btn) return;
    const n = Math.round(levelCfg.maxPlayers) || 6;
    const label = '人数上限：' + n;
    if (btn.textContent !== label) btn.textContent = label;
    const isGuest = (typeof netRole !== 'undefined') && netRole === 'guest';
    btn.disabled = isGuest;
    btn.title = isGuest ? '客机不能改房间设置' : '点一下 +1，到 6 回到 2';
    const info = document.getElementById('levelInfoNet');
    if (info && typeof levelSummaryText === 'function') {
        const t = levelSummaryText();
        if (info.textContent !== t) info.textContent = t;
    }
}

function cycleMaxPlayers() {
    if (typeof netRole !== 'undefined' && netRole === 'guest') return;
    const cur = Math.round(levelCfg.maxPlayers) || 6;
    setCfg({ maxPlayers: (cur >= 6) ? 2 : (cur + 1) });
    syncRoomSettings();
}

function buildPresetBar() {
    const sel = document.getElementById('cfgPresetSel');
    if (!sel) return;

    const saved = loadSavedPresets();
    const parts = ['<option value="">— 选一个预设 —</option>'];
    parts.push('<optgroup label="内置">');
    for (let i = 0; i < LEVEL_PRESETS.length; i++) {
        const p = LEVEL_PRESETS[i];
        parts.push('<option value="b:' + p.id + '">' + p.name + ' · ' + p.note + '</option>');
    }
    parts.push('</optgroup>');
    if (saved.length) {
        parts.push('<optgroup label="我保存的">');
        for (let i = 0; i < saved.length; i++) {
            parts.push('<option value="s:' + i + '">' + saved[i].name + '</option>');
        }
        parts.push('</optgroup>');
    }
    sel.innerHTML = parts.join('');
    sel.value = '';

    sel.addEventListener('change', function () {
        const v = sel.value;
        sel.value = '';
        if (!v) return;
        if (v.indexOf('b:') === 0) {
            const id = v.slice(2);
            for (let i = 0; i < LEVEL_PRESETS.length; i++) {
                if (LEVEL_PRESETS[i].id === id) {
                    applyPresetCfg(LEVEL_PRESETS[i].cfg, '已套用「' + LEVEL_PRESETS[i].name + '」');
                    return;
                }
            }
        } else if (v.indexOf('s:') === 0) {
            const list = loadSavedPresets();
            const p = list[parseInt(v.slice(2), 10)];
            if (p) applyPresetCfg(p.cfg, '已套用「' + p.name + '」');
        }
    });

    document.getElementById('cfgPresetSaveBtn').addEventListener('click', saveCurrentAsPreset);
    document.getElementById('cfgPresetDelBtn').addEventListener('click', deleteSavedPreset);
    document.getElementById('cfgLevelDownBtn').addEventListener('click', downloadLevel);
    document.getElementById('cfgLevelUpBtn').addEventListener('click', function () {
        document.getElementById('cfgLevelFile').click();
    });
    document.getElementById('cfgLevelFile').addEventListener('change', function (ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = '';                     // 同一个文件能再选一次
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () { importLevelText(String(reader.result || ''), file.name); };
        reader.readAsText(file);
    });
}

// 套用：先回默认，再盖预设，再把房间身份放回去
function applyPresetCfg(patch, label) {
    if (netRole === 'guest') return;
    const clean = sanitizeCfg(patch);
    const keep = { name: levelCfg.name, desc: levelCfg.desc, maxPlayers: levelCfg.maxPlayers };

    const base = levelDefaults();
    for (const k in base) levelCfg[k] = base[k];
    for (const k in clean) levelCfg[k] = clean[k];
    for (const k in keep) levelCfg[k] = keep[k];
    teamMode = levelCfg.team;

    if (!clean.cols || !clean.rows) {
        // 预设没说场地就用模式的默认尺寸（不然会留在上一个预设的大场地上）
        levelCfg.cols = 0;
        levelCfg.rows = 0;
        setArenaSize(MODES[mode].cols, MODES[mode].rows, gameNow);
    }
    const res = applyLevelCfg(levelCfg, gameNow);
    cfgMsg = label + (res === 'restart' ? '（场地变小，已重开一局）' : '');
    syncCfgPanel();
    syncHud();
    syncNetBar();
}

// 把当前的关卡存成一个预设
function saveCurrentAsPreset() {
    if (netRole === 'guest') return;
    // 名字取自输入框，不用 window.prompt ——
    // 无头浏览器里 prompt 会直接把页面卡住，Tauri 的 webview 里也不保证有
    const box = document.getElementById('cfgPresetName');
    let name = String((box && box.value) || '').trim().slice(0, 24);

    const list = loadSavedPresets();
    if (!name) name = '我的关卡 ' + (list.length + 1);

    const cfg = {};
    for (const k in levelCfg) cfg[k] = levelCfg[k];
    const i = savedPresetIndex(name);
    if (i >= 0) list[i] = { name: name, cfg: cfg };    // 同名就覆盖
    else list.push({ name: name, cfg: cfg });
    writeSavedPresets(list);

    buildPresetBar();
    cfgMsg = '已存成预设「' + name + '」' + (i >= 0 ? '（覆盖了同名的）' : '');
    syncCfgPanel();
}

function deleteSavedPreset() {
    if (netRole === 'guest') return;
    const list = loadSavedPresets();
    if (!list.length) {
        cfgMsg = '还没有自己存的预设';
        syncCfgPanel();
        return;
    }
    const box = document.getElementById('cfgPresetName');
    const typed = String((box && box.value) || '').trim();
    const name = typed || list[list.length - 1].name;
    const i = savedPresetIndex(name);
    if (i < 0) {
        cfgMsg = '没找到叫「' + String(name).trim() + '」的预设';
    } else {
        list.splice(i, 1);
        writeSavedPresets(list);
        buildPresetBar();
        cfgMsg = '已删除预设「' + String(name).trim() + '」';
    }
    syncCfgPanel();
}

// 导出成一个 json 文件。桌面版（Tauri）里 <a download> 不一定弹保存框，
// 那就把 json 摊在文本框里让人自己复制。
function levelToJson() {
    const cfg = {};
    for (const k in levelCfg) cfg[k] = levelCfg[k];
    return JSON.stringify({
        app: 'snake-army',
        kind: 'level',
        v: 1,
        name: levelCfg.name || '关卡',
        cfg: cfg
    }, null, 2);
}

function downloadLevel() {
    const json = levelToJson();
    const name = (levelCfg.name || 'snake-level').replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);

    try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        cfgMsg = '已导出 ' + name + '.json';
    } catch (e) {
        showLevelText(json);
        cfgMsg = '这个环境不能直接下载，已把内容摊在下面，手动复制保存';
    }
    syncCfgPanel();
}

// 兜底：把 json 放进一个可全选的文本框
function showLevelText(json) {
    let box = document.getElementById('cfgLevelBox');
    if (!box) {
        box = document.createElement('textarea');
        box.id = 'cfgLevelBox';
        box.className = 'netIce';
        box.rows = 6;
        box.spellcheck = false;
        const panel = document.getElementById('cfgPanel');
        panel.insertBefore(box, document.getElementById('cfgNote'));
    }
    box.hidden = false;
    box.value = json;
    box.focus();
    box.select();
}

function importLevelText(text, fromName) {
    if (netRole === 'guest') return;
    let data = null;
    try {
        data = JSON.parse(String(text || ''));
    } catch (e) {
        cfgMsg = '这个文件不是合法的 json';
        syncCfgPanel();
        return;
    }
    const raw = (data && data.cfg) ? data.cfg : data;
    const clean = sanitizeCfg(raw);
    if (!Object.keys(clean).length) {
        cfgMsg = '文件里没有认得的关卡字段';
        syncCfgPanel();
        return;
    }
    const label = (data && data.name) ? data.name : (fromName || '文件');
    applyPresetCfg(clean, '已加载「' + label + '」');
}

// ------------------------------ 关卡短码 ------------------------------
// 一串能塞进聊天框的短码。开头那段是给人看的：
//     贪吃蛇·巨幕·200x150·K7QF#SNK#L1#H#天地玄黄…
//   · 名字 / 尺寸 / 指纹 —— 一眼能看出这是什么关卡；
//   · 指纹是内容的 CRC 取 4 位，抄漏一段 / 被聊天软件截断时能发现；
//   · 从 #SNK# 开始才是给程序看的，前面那段删掉也能用（老码没有前缀也认）。
// 两种载荷：A = 紧凑（base64url），H = 汉字（每个字节对应《千字文》里一个字，256 个互不相同）。
const HZ_TABLE = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方盖此身临四大五常恭惟鞠养岂敢毁伤女慕贞洁男效才良知过必改得能莫忘罔谈彼短靡恃己长信使可覆器欲难量墨悲丝染诗赞羔羊景行维贤克念作圣德建名立形端表正空谷传声虚堂习听祸因恶积福缘善庆尺璧非宝寸阴是竞资父事君曰严与敬孝当竭力忠则尽命';

// 指纹用的字母表：去掉 0 O 1 I 这些容易认错的
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

let hzLookup = null;
function hzIndex() {
    if (!hzLookup) {
        hzLookup = {};
        for (let i = 0; i < HZ_TABLE.length; i++) hzLookup[HZ_TABLE.charAt(i)] = i;
    }
    return hzLookup;
}

function utf8Bytes(text) {
    const arr = new TextEncoder().encode(String(text || ''));
    const out = [];
    for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    return out;
}

function utf8Text(bytes) {
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s) {
    const pad = (s.length % 4) ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = [];
    for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
}

// CRC32 取低 20 位 -> 4 个不容易看错的字符
function codeFingerprint(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        c ^= bytes[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    c = (c ^ 0xFFFFFFFF) >>> 0;
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET.charAt((c >>> (i * 5)) & 31);
    return s;
}

function clampByte(v) {
    const n = Math.round(Number(v) || 0);
    return Math.max(0, Math.min(255, n));
}

// 关卡 -> 字节。范围小的地方都缩过：步长按 10ms、补位按 500ms、加速按 1s
function levelToBytes(cfg) {
    const c = sanitizeCfg(cfg);
    const d = levelDefaults();
    const val = function (k) { return c[k] !== undefined ? c[k] : d[k]; };
    const out = [];
    const u16 = function (v) { const n = Math.max(0, Math.min(65535, Math.round(Number(v) || 0))); out.push(n & 255, (n >> 8) & 255); };
    u16(val('cols'));
    u16(val('rows'));
    out.push(Math.max(2, Math.min(6, Math.round(val('maxPlayers')) || 2)));
    out.push(val('team') === 'vs' ? 1 : 0);
    out.push((val('enemies') ? 1 : 0) | (val('powerups') ? 2 : 0) | (val('revive') ? 4 : 0));
    out.push(clampByte(val('len0')));
    out.push(clampByte(val('hp0')));
    u16(val('stepMs') / 10);
    out.push(clampByte(val('appleBase')));
    out.push(clampByte(val('apples')));
    out.push(clampByte(val('enemyMax')));
    u16(val('enemySpeed'));
    u16(val('enemyGap') / 500);
    u16(val('boostMs') / 1000);
    out.push(clampByte(val('powerGap')));
    out.push(clampByte(val('cutWall')));
    out.push(clampByte(val('cutSnake')));
    u16(val('invMs') / 100);
    out.push((val('i_speed_on') ? 1 : 0) | (val('i_widen_on') ? 2 : 0));
    u16(val('i_speed_gap') / 100);
    out.push(Math.max(1, Math.min(9, Math.round(val('i_speed_max')))));
    u16(val('i_widen_gap') / 100);
    out.push(Math.max(1, Math.min(9, Math.round(val('i_widen_max')))));
    out.push(clampByte(val('turretCost')));
    out.push(clampByte(val('turretCoins')));
    out.push(clampByte(val('turretMax')));
    const nb = utf8Bytes(String(val('name') || '').slice(0, 24));
    out.push(Math.min(255, nb.length));
    for (let i = 0; i < nb.length && i < 255; i++) out.push(nb[i]);
    const db = utf8Bytes(String(val('desc') || '').slice(0, 80));
    out.push(Math.min(255, db.length));
    for (let i = 0; i < db.length && i < 255; i++) out.push(db[i]);
    return out;
}

function bytesToLevel(bytes) {
    let p = 0;
    const need = function (n) { if (p + n > bytes.length) throw new Error('短码不完整'); };
    const u8 = function () { need(1); return bytes[p++]; };
    const u16 = function () { need(2); const a = bytes[p++]; return a | (bytes[p++] << 8); };
    if (bytes.length < 36) throw new Error('短码太短');
    const cfg = {};
    cfg.cols = u16();
    cfg.rows = u16();
    cfg.maxPlayers = u8();
    cfg.team = (u8() === 1) ? 'vs' : 'coop';
    const fl = u8();
    cfg.enemies = !!(fl & 1);
    cfg.powerups = !!(fl & 2);
    cfg.revive = !!(fl & 4);
    cfg.len0 = u8();
    cfg.hp0 = u8();
    cfg.stepMs = u16() * 10;
    cfg.appleBase = u8();
    cfg.apples = u8();
    cfg.enemyMax = u8();
    cfg.enemySpeed = u16();
    cfg.enemyGap = u16() * 500;
    cfg.boostMs = u16() * 1000;
    cfg.powerGap = u8();
    cfg.cutWall = u8();
    cfg.cutSnake = u8();
    cfg.invMs = u16() * 100;
    const itemFlags = u8();
    cfg.i_speed_on = !!(itemFlags & 1);
    cfg.i_widen_on = !!(itemFlags & 2);
    cfg.i_speed_gap = u16() * 100;
    cfg.i_speed_max = u8();
    cfg.i_widen_gap = u16() * 100;
    cfg.i_widen_max = u8();
    cfg.turretCost = u8();
    cfg.turretCoins = u8();
    cfg.turretMax = u8();
    let n = u8();
    const nb = [];
    while (n-- > 0) nb.push(u8());
    cfg.name = utf8Text(nb);
    n = u8();
    const db = [];
    while (n-- > 0) db.push(u8());
    cfg.desc = utf8Text(db);
    return sanitizeCfg(cfg);
}

// 生成：人读的一段 + 机器的一段
function levelCode(style) {
    const bytes = levelToBytes(levelCfg);
    const fp = codeFingerprint(bytes);
    let payload;
    if (style === 'hz') {
        payload = '';
        for (let i = 0; i < bytes.length; i++) payload += HZ_TABLE.charAt(bytes[i]);
    } else {
        payload = bytesToBase64Url(bytes);
    }
    const head = '贪吃蛇·' + (levelCfg.name || '关卡').slice(0, 12) + '·' +
        (levelCfg.cols || COLS) + 'x' + (levelCfg.rows || ROWS) + '·' + fp;
    return head + '#SNK#L1#' + (style === 'hz' ? 'H' : 'A') + '#' + payload;
}

// 解析：从一段话里找短码（前面的中文随手删掉也能用）
function decodeLevelCode(text) {
    const m = String(text || '').match(/SNK#L1#([AH])#([^\s#]+)/);
    if (!m) throw new Error('这不是关卡短码');
    const style = m[1];
    const payload = m[2];
    let bytes;
    if (style === 'H') {
        const idx = hzIndex();
        bytes = [];
        for (let i = 0; i < payload.length; i++) {
            const b = idx[payload.charAt(i)];
            if (b === undefined) throw new Error('汉字表里没有「' + payload.charAt(i) + '」');
            bytes.push(b);
        }
    } else {
        bytes = base64UrlToBytes(payload);
    }
    const cfg = bytesToLevel(bytes);
    const fp = codeFingerprint(bytes);
    const shown = String(text).match(/·([0-9A-Z]{4})#SNK#/);
    return { cfg: cfg, fp: fp, fpOk: !shown || shown[1] === fp, style: style };
}

function looksLikeLevelCode(text) {
    return /SNK#L1#[AH]#/.test(String(text || ''));
}

function extractLevelCode(text) {
    const m = String(text || '').match(/SNK#L1#[AH]#[^\s#]+/);
    return m ? m[0] : '';
}

let codeStyle = 'compact';      // 'compact' | 'hz'

function buildCodeBar() {
    const box = document.getElementById('cfgCodeBox');
    const styleBtn = document.getElementById('cfgCodeStyleBtn');
    if (!box || !styleBtn) return;

    const makeCode = function () {
        const code = levelCode(codeStyle);
        box.value = code;
        return code;
    };

    styleBtn.addEventListener('click', function () {
        codeStyle = (codeStyle === 'hz') ? 'compact' : 'hz';
        styleBtn.textContent = '编码：' + (codeStyle === 'hz' ? '汉字' : '紧凑');
        if (box.value || document.getElementById('cfgCodeMakeBtn')) makeCode();
        cfgMsg = (codeStyle === 'hz') ? '汉字码：每个字节对应《千字文》里一个字' : '紧凑码：base64url，短一些';
        syncCfgPanel();
    });

    document.getElementById('cfgCodeMakeBtn').addEventListener('click', function () {
        makeCode();
        cfgMsg = '短码已生成，点「复制」或「发到聊天」';
        syncCfgPanel();
    });

    document.getElementById('cfgCodeLoadBtn').addEventListener('click', function () {
        loadLevelCode();
    });

    document.getElementById('cfgCodeCopyBtn').addEventListener('click', function () {
        const code = box.value || makeCode();
        const done = function () {
            cfgMsg = '短码已复制';
            syncCfgPanel();
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(done, function () { fallbackCopy(box, done); });
            } else {
                fallbackCopy(box, done);
            }
        } catch (e) { fallbackCopy(box, done); }
    });

    document.getElementById('cfgCodeChatBtn').addEventListener('click', function () {
        const code = box.value || makeCode();
        box.value = code;
        if (typeof chatSendText !== 'function') return;
        chatSendText(code);
        cfgMsg = '短码已发到聊天（单机时只显示在自己屏幕上）';
        syncCfgPanel();
    });
}

// 没有剪贴板权限（http 页面 / 老浏览器）时的退路：选中文本，手动 Ctrl+C
function fallbackCopy(box, done) {
    try {
        box.focus();
        box.select();
        if (document.execCommand) document.execCommand('copy');
        done();
    } catch (e) {
        cfgMsg = '这个环境不让自动复制，已经帮你选中了，按 Ctrl+C 即可';
        syncCfgPanel();
    }
}

function loadLevelCode() {
    if (netRole === 'guest') return;
    const box = document.getElementById('cfgCodeBox');
    let got = null;
    try {
        got = decodeLevelCode(box.value);
    } catch (e) {
        cfgMsg = '短码读不出来：' + e.message;
        syncCfgPanel();
        return;
    }
    const styleName = (got.style === 'H') ? '汉字码' : '紧凑码';
    const warn = got.fpOk ? '' : ' ⚠ 指纹对不上，可能抄漏了一段';
    const cols = got.cfg.cols || COLS;
    const rows = got.cfg.rows || ROWS;
    applyPresetCfg(got.cfg, '已从短码载入 ' + cols + '×' + rows + '（' + styleName + '）' + warn);
}

// 从聊天消息里点「导入这个关卡」：直接套用，顺手把修改器打开让人看见改了什么
function importLevelCode(code) {
    if (netRole === 'guest') {
        cfgMsg = '关卡由主机控制，导不了';
        syncCfgPanel();
        return;
    }
    let got = null;
    try {
        got = decodeLevelCode(code);
    } catch (e) {
        cfgMsg = '短码读不出来：' + e.message;
        syncCfgPanel();
        return;
    }
    const cols = got.cfg.cols || COLS;
    const rows = got.cfg.rows || ROWS;
    applyPresetCfg(got.cfg, '已从聊天里的短码载入 ' + cols + '×' + rows + (got.fpOk ? '' : ' ⚠ 指纹对不上'));
    toggleCfgPanel(true);
}

// ------------------------------ 开始页上的关卡摘要 ------------------------------
// 一行话把当前关卡说清楚，不用点进修改器也知道现在玩的是什么。
function levelSummaryText() {
    const d = levelDefaults();
    const parts = [];
    const cols = levelCfg.cols || MODES[mode].cols;
    const rows = levelCfg.rows || MODES[mode].rows;
    parts.push('场地 ' + cols + '×' + rows);
    parts.push(teamMode === 'vs' ? '竞争' : '合作');
    parts.push('每步 ' + levelCfg.stepMs + 'ms');
    parts.push('苹果 ' + (Math.round(levelCfg.apples) > 0 ? levelCfg.apples : '无上限'));

    if (levelCfg.enemies === false) {
        parts.push('敌人 关');
    } else {
        parts.push('敌人 ' + levelCfg.enemyMax + ' 条' +
            (levelCfg.enemySpeed === 100 ? '' : '（' + levelCfg.enemySpeed + '% 速）'));
    }

    if (levelCfg.powerups === false) {
        parts.push('道具 关');
    } else {
        const items = [];
        for (let i = 0; i < ITEM_DEFS.length; i++) {
            const it = ITEM_DEFS[i];
            if (levelCfg['i_' + it.kind + '_on'] === false) continue;
            const sec = Math.round(levelCfg['i_' + it.kind + '_gap'] / 100) / 10;
            items.push(it.label.replace('道具', '') + ' ' + sec + 's×' + levelCfg['i_' + it.kind + '_max']);
        }
        parts.push('道具 ' + (items.length ? items.join('、') : '关'));
    }

    if (levelCfg.revive === false) parts.push('复活 关');
    parts.push('人数上限 ' + levelCfg.maxPlayers);

    // 除了模式/房间信息，只要有关卡参数和默认不一样就标一下「改过」
    let custom = false;
    for (const k in d) {
        if (k === 'team' || k === 'name' || k === 'desc' || k === 'maxPlayers') continue;
        if (levelCfg[k] !== d[k]) {
            custom = true;
            break;
        }
    }
    return parts.join(' · ') + (custom ? ' ·（改过）' : '');
}

function syncLevelInfo() {
    const text = levelSummaryText();
    const ids = ['levelInfo', 'levelInfoNet'];
    for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el && el.textContent !== text) el.textContent = text;
    }
}

buildLevelPage();
syncLevelInfo();
