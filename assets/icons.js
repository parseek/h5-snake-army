// ------------------------------ 图标（全部是手写 SVG，没有图片文件）------------------------------
// 单独一个文件，免得 level.js 越堆越大。
//   PRESET_ICONS  : 每个内置预设一张手写的图（96×58）
//   presetIconSvg : 自定义/导入的关卡按数值自动推导一张
//   FIELD_ICONS   : 关卡修改器里每个设置项的小图标（16×16，跟着文字颜色走）
//
// 约定：能跟着主题变色就用 currentColor；只有「特征色」（苹果红、闪电黄、心形粉）写死。

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

    // 房间迷宫：三间房 + 一扇门（Roguelike）
    rogue:
        '<svg class="presetIcon" data-icon="rogue" viewBox="0 0 96 58" aria-hidden="true">' +
        '<rect x="6" y="10" width="26" height="18" rx="3" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<rect x="6" y="32" width="26" height="16" rx="3" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<rect x="36" y="10" width="22" height="38" rx="3" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>' +
        '<rect x="62" y="16" width="28" height="26" rx="3" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.7"/>' +
        '<path d="M74 42v-8a4 4 0 0 1 8 0v8" fill="none" stroke="#ffd21f" stroke-width="2.2"/>' +
        '<circle cx="45" cy="29" r="3" fill="#008000"/>' +
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

// ------------------------------ 设置项的小图标 ------------------------------
// 每个 key 对应一组 SVG 子元素（16×16 视口）。没配的字段就不显示图标。
const FIELD_ICONS = {
    cols: '<path d="M3 4h10v8H3z"/><path d="M1 8h14M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2"/>',
    rows: '<path d="M4 3v10h8V3z"/><path d="M8 1v14M8 1l-2 2M8 1l2 2M8 15l-2-2M8 15l2-2"/>',
    team: '<circle cx="6" cy="6" r="2.4"/><circle cx="11" cy="8" r="2"/><path d="M2 14c0-2 2-3 4-3s4 1 4 3M9 14c0-1.6 1.4-2.4 3-2.4"/>',
    maxPlayers: '<circle cx="5.5" cy="6" r="2.2"/><circle cx="10.5" cy="6" r="2.2"/><path d="M1.5 14c0-2 2-3 4-3s4 1 4 3M7.5 14c0-1.8 1.6-2.6 3-2.6"/>',
    len0: '<path d="M2 8h8"/><circle cx="12" cy="8" r="1.6"/>',
    hp0: '<path d="M8 13.5S2.5 10 2.5 6.6A2.6 2.6 0 0 1 8 5.4a2.6 2.6 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/>',
    stepMs: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3.2l2 1.4M6 1.5h4"/>',
    appleBase: '<circle cx="8" cy="9.5" r="4"/><path d="M8 5.5V3M8 3c1.6 0 2.4-.8 2.4-1.6"/>',
    apples: '<circle cx="6" cy="9" r="3.2"/><circle cx="11.5" cy="10.5" r="2.4"/><path d="M6 5.8V3.6"/>',
    enemies: '<path d="M2 11.5 6 5.5l3 4 2.5-2.5 2.5 4.5"/><circle cx="12.6" cy="11.4" r=".8"/>',
    enemyMax: '<path d="M2 11.5 6 5.5l3 4 2.5-2.5"/>',
    enemyGap: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2v3.2h-3.2"/>',
    enemySpeed: '<path d="M2 12a6 6 0 0 1 12 0"/><path d="M8 12 11 8"/><circle cx="8" cy="12" r="1"/>',
    powerups: '<path d="M9 1 4 9h3.2L6 15l5.4-8H8l1-6Z"/>',
    boostMs: '<path d="M9 1 4 9h3.2L6 15l5.4-8H8l1-6Z"/><circle cx="13" cy="4" r="2.2"/>',
    powerGap: '<path d="M9 1 4 9h3.2L6 15l5.4-8H8l1-6Z"/><path d="M12.5 11.5h2.5M13.75 10.2v2.6"/>',
    revive: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v6M5 8h6"/>',
    cutWall: '<path d="M2 3h12v3H2zM2 6v3h4V6zM8 6v3h6V6zM2 9v3h7V9zM11 9v3h3V9z"/>',
    cutSnake: '<path d="M2 11c3 0 2-4 5-4s2 4 5 4"/><path d="M14 3l-3.5 3.5M11 3l3 3.5"/>',
    invMs: '<path d="M8 1.8 13 4v4.2c0 3-2.4 5-5 6.2-2.6-1.2-5-3.2-5-6.2V4z"/>',
    turretCost: '<rect x="4" y="6" width="8" height="7" rx="1.4"/><path d="M8 6V3.5M5.5 13v1.5M10.5 13v1.5"/>',
    turretCoins: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2v5.6M6.4 6.6h3.2M6.4 9.4h3.2"/>',
    turretMax: '<rect x="3.5" y="7" width="9" height="6" rx="1.4"/><path d="M8 7V4M4 13v1M12 13v1M8 4h3"/>',
    name: '<path d="M2 3.5h12v7H8l-3 2.5v-2.5H2z"/>',
    desc: '<path d="M3 3h10M3 6.5h10M3 10h6"/>'
};

// 每种道具各一种图标：加速 = 闪电，拓宽 = 四角外扩
const KIND_ICONS = {
    speed: FIELD_ICONS.powerups,
    widen: '<path d="M3 7V3h4M13 9v4H9M3 9v4h4M13 7V3H9"/>',
    team: '<path d="M8 1.6 9.7 5.3 13.8 5.8 10.8 8.6 11.6 12.6 8 10.6 4.4 12.6 5.2 8.6 2.2 5.8 6.3 5.3Z"/>'
};

// 「刷新间隔」用循环箭头，「同屏上限」用 #（数量）
const REFRESH_ICON = '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2v3.2h-3.2"/>';
const COUNT_ICON = '<path d="M6 3 5 13M11 3l-1 10M3.5 6h10M3 10h10"/>';

// 每种道具那一组：i_speed_on / i_widen_on / i_speed_gap / i_widen_max …
function itemIconBody(key) {
    const m = /^i_(speed|widen|team)_(on|gap|max)$/.exec(key || '');
    if (!m) return '';
    const kind = KIND_ICONS[m[1]] || FIELD_ICONS.powerups;
    if (m[2] === 'gap') return REFRESH_ICON;      // 刷新间隔
    if (m[2] === 'max') return COUNT_ICON;        // 同屏上限
    return kind;                                  // 生成开关
}

// 返回一段可以直接塞进 innerHTML 的图标；没配图标的字段返回 ''
function fieldIcon(key) {
    const body = FIELD_ICONS[key] || itemIconBody(key);
    if (!body) return '';
    return '<svg class="fieldIcon" viewBox="0 0 16 16" aria-hidden="true">' +
        body + '</svg>';
}

// 兼容旧名字（外面可能还有地方按这个名字调）
function itemIcon(key) {
    return fieldIcon(key);
}
