// 渲染层 · render
//
// 谁在这个文件里：所有绘制（棋盘 / 蛇 / 敌人 / 道具 / 炮塔 / 弹药 / 遮罩）
// 以及 HUD 的文字与按钮状态刷新。只读游戏状态，不改规则。
// 规则在 game.js，输入在 input.js。
//
// 以经典脚本（非 module）加载：这里定义的函数和变量直接落在全局词法作用域，
// 其他脚本和 index.html 里的调用点不需要 import，也不改一行调用方式。
// 加载顺序见 index.html：config -> state -> net -> game -> render -> input -> net-session。

'use strict';

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// 逻辑坐标 -> 画布像素：减掉摄像机（大地图滚动），再加上放大动画的偏移。
// 全游戏只有这四个函数做坐标映射，所以摄像机只改这一处就够。
function pxOf(cx) { return cx * CELL - camX + renderOffsetX; }
function pyOf(cy) { return cy * CELL - camY + renderOffsetY; }
function cxOf(p) { return p.x * CELL - camX + renderOffsetX + CELL / 2; }
function cyOf(p) { return p.y * CELL - camY + renderOffsetY + CELL / 2; }

// HUD 里的玩家条目按人数动态生成 —— 联机可能不止两人
const hudPlayersEl = document.getElementById('hudPlayers');
let hudEntries = [];

function syncHudPlayers() {
    // 不够就补条目（只增不减，省得反复重建 DOM）
    while (hudEntries.length < players.length) {
        const def = PLAYER_DEFS[hudEntries.length] || PLAYER_DEFS[0];
        const wrap = document.createElement('span');
        const dot = document.createElement('b');
        dot.textContent = '●';
        dot.style.color = def.body;
        wrap.appendChild(dot);
        wrap.appendChild(document.createTextNode(' ' + def.name + ' '));
        const sc = document.createElement('b');
        wrap.appendChild(sc);
        wrap.appendChild(document.createTextNode(' 分 · '));
        const co = document.createElement('b');
        wrap.appendChild(co);
        wrap.appendChild(document.createTextNode(' 币'));
        hudPlayersEl.appendChild(wrap);
        hudEntries.push({ wrap: wrap, sc: sc, co: co });
    }
    for (let i = 0; i < hudEntries.length; i++) {
        const e = hudEntries[i];
        const has = i < players.length;
        e.wrap.hidden = !has;
        if (!has) continue;
        e.sc.textContent = String(players[i].score);
        e.co.textContent = String(players[i].coins);
    }
}

function syncHud() {
    bestEl.textContent = String(best);
    sizeEl.textContent = COLS + '×' + ROWS;
    syncHudPlayers();
    if (typeof syncCfgPanel === 'function') syncCfgPanel();   // 关卡修改器页面（level.js 提供）
}

// 加速剩余时间：整秒向上取整，拾取瞬间显示满 30s
function syncBoostHud(now) {
    // 暂停时也继续显示剩余时间（游戏时钟停着，所以读数是准的）；
    // 两个人都有加速时，显示剩得久的那个
    let left = 0;
    if (state !== 'over') {
        for (let i = 0; i < players.length; i++) {
            const b = players[i].boostUntil;
            if (b) left = Math.max(left, Math.ceil((b - now) / 1000));
        }
    }
    if (left > 0) {
        boostLeftEl.textContent = String(left);
        boostEl.hidden = false;
    } else {
        boostEl.hidden = true;
    }
}

// ------------------------------ 插值 ------------------------------
// 当前这一步的进度 0~1，再套上缓动曲线
function progress(p) {
    return ease(Math.max(0, Math.min(p.acc / p.stepMs, 1)));
}

// 出生缩放动画的进度 0~1
function spawnScale(at, now) {
    if (at === undefined || at === null || at < 0) return 1;
    return ease(Math.max(0, Math.min((now - at) / SPAWN_ANIM_MS, 1)));
}

// 把一条蛇抽象成折线：蛇头沿方向探出 e 格，蛇尾同步缩回 e 格
function buildPath(body, dir, e, retract) {
    const head = body[0];

    // 蛇头先探出去
    const pts = [{ x: cxOf(head) + dir.x * CELL * e, y: cyOf(head) + dir.y * CELL * e }];

    // 身体各节保持整格不动
    for (let i = 0; i < body.length; i++) {
        pts.push({ x: cxOf(body[i]), y: cyOf(body[i]) });
    }

    // 尾巴朝前一节缩回；这一步会变长（或游戏已结束）时尾巴原地不动
    const n = body.length;
    if (retract && n >= 2) {
        const tail = body[n - 1];
        const prev = body[n - 2];
        const tx = cxOf(tail);
        const ty = cyOf(tail);
        const px = cxOf(prev);
        const py = cyOf(prev);
        pts[pts.length - 1] = { x: tx + (px - tx) * e, y: ty + (py - ty) * e };
    }

    return pts;
}

// ------------------------------ 绘制 ------------------------------
// 场地矩形（画布坐标）。放大动画期间它表示「已经长到多大」：
// 左上角固定不动，只有宽高在长 —— 新冒出来的那一圈格子在矩形外面，被裁掉，
// 这样看起来才是「场地从中间往外长」，而不是「内容整体滑一下」。
// 动画结束后 drawWorldW/H 就等于 W/H，这个矩形就是整块场地。
function boardRect() {
    return { x: -camX, y: -camY, w: boardWorldW(), h: boardWorldH() };
}

function drawBoard() {
    // 视口先清空（要用「世界像素」里的尺寸，不然缩放后会剩一条没清掉）
    ctx.clearRect(0, 0, viewWorldW(), viewWorldH());

    const b = boardRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();

    ctx.fillStyle = COLOR.board;
    ctx.fillRect(b.x, b.y, b.w, b.h);

    // 网格线跟着画面一起滑动，放大过程中格子才不会和线错位
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let c = 0; c <= COLS; c++) {
        const x = pxOf(c);
        if (x <= b.x || x >= b.x + b.w) continue;
        const lx = Math.round(x) + 0.5;   // +0.5 让 1px 细线落在像素中心
        ctx.moveTo(lx, b.y);
        ctx.lineTo(lx, b.y + b.h);
    }
    for (let r = 0; r <= ROWS; r++) {
        const y = pyOf(r);
        if (y <= b.y || y >= b.y + b.h) continue;
        const ly = Math.round(y) + 0.5;
        ctx.moveTo(b.x, ly);
        ctx.lineTo(b.x + b.w, ly);
    }
    ctx.stroke();
    ctx.restore();
}

function drawApple() {
    const r = CELL * 0.32;

    for (let i = 0; i < apples.length; i++) {
        const cx = cxOf(apples[i]);
        const cy = cyOf(apples[i]);

        ctx.fillStyle = COLOR.apple;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.beginPath();
        ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
    }
}

// 加速道具：蓝色圆底 + 白色闪电
function drawSpeedItem() {
    const list = powerList('speed');
    for (let i = 0; i < list.length; i++) drawSpeedAt(list[i]);
}

// 画一个加速道具
function drawSpeedAt(p) {
    const cx = cxOf(p);
    const cy = cyOf(p);
    const r = CELL * 0.34;

    ctx.fillStyle = COLOR.speed;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.stroke();

    const bolt = [
        [0.12, -0.62], [-0.38, 0.05], [-0.05, 0.05],
        [-0.14, 0.62], [0.38, -0.05], [0.05, -0.05]
    ];

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < bolt.length; i++) {
        const bx = cx + bolt[i][0] * CELL * 0.5;
        const by = cy + bolt[i][1] * CELL * 0.5;
        if (i === 0) ctx.moveTo(bx, by);
        else ctx.lineTo(bx, by);
    }
    ctx.closePath();
    ctx.fill();
}

// 拓宽道具：金色圆底 + 四个向外的箭头（正好对应上下左右各拓宽一格）
function drawWidenItem() {
    const list = powerList('widen');
    for (let i = 0; i < list.length; i++) drawWidenAt(list[i]);
}

// 画一个拓宽道具
function drawWidenAt(p) {
    const cx = cxOf(p);
    const cy = cyOf(p);
    const r = CELL * 0.34;

    ctx.fillStyle = COLOR.widen;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.stroke();

    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    ctx.fillStyle = '#ffffff';

    for (let i = 0; i < dirs.length; i++) {
        const dx = dirs[i][0];
        const dy = dirs[i][1];
        const px = -dy;     // 垂直于箭头方向
        const py = dx;

        // 箭杆
        ctx.beginPath();
        ctx.moveTo(cx + (dx * 0.06 + px * 0.11) * r, cy + (dy * 0.06 + py * 0.11) * r);
        ctx.lineTo(cx + (dx * 0.56 + px * 0.11) * r, cy + (dy * 0.56 + py * 0.11) * r);
        ctx.lineTo(cx + (dx * 0.56 - px * 0.11) * r, cy + (dy * 0.56 - py * 0.11) * r);
        ctx.lineTo(cx + (dx * 0.06 - px * 0.11) * r, cy + (dy * 0.06 - py * 0.11) * r);
        ctx.closePath();
        ctx.fill();

        // 箭头
        ctx.beginPath();
        ctx.moveTo(cx + dx * 0.88 * r, cy + dy * 0.88 * r);
        ctx.lineTo(cx + (dx * 0.5 + px * 0.3) * r, cy + (dy * 0.5 + py * 0.3) * r);
        ctx.lineTo(cx + (dx * 0.5 - px * 0.3) * r, cy + (dy * 0.5 - py * 0.3) * r);
        ctx.closePath();
        ctx.fill();
    }
}

function drawHead(p, dir, color, scale) {
    const s = (scale === undefined) ? 1 : Math.max(0, scale);
    const size = (CELL - 3) * s;
    if (size <= 0.4) return;   // 缩没了就别画

    ctx.fillStyle = color;
    roundRect(p.x - size / 2, p.y - size / 2, size, size, size * 0.35);
    ctx.fill();

    // 眼睛跟随前进方向
    const dx = dir.x;
    const dy = dir.y;
    const px = -dy;
    const py = dx;
    const forward = CELL * 0.15 * s;
    const side = CELL * 0.19 * s;

    for (const sign of [1, -1]) {
        const ex = p.x + dx * forward + px * side * sign;
        const ey = p.y + dy * forward + py * side * sign;

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex, ey, CELL * 0.1 * s, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#1b1b1b';
        ctx.beginPath();
        ctx.arc(ex + dx * CELL * 0.03 * s, ey + dy * CELL * 0.03 * s, CELL * 0.045 * s, 0, Math.PI * 2);
        ctx.fill();
    }
}

// 画一条蛇：身体按节分段描粗线（圆头，接缝处自然连成一体），
// 每一节用自己血量对应的颜色。
// 每一节拆成「中点 -> 本节点中心 -> 中点」两小段来画，
// 保证折线始终穿过格子中心 —— 否则转弯时外角会被斜着切掉。
// 折线总长（像素）
function pathLength(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
}

// 沿折线描出 [from, to] 这段弧长（跨拐角也正确）
function strokeArc(pts, from, to) {
    let acc = 0;
    let started = false;
    ctx.beginPath();

    for (let i = 1; i < pts.length; i++) {
        const x0 = pts[i - 1].x;
        const y0 = pts[i - 1].y;
        const dx = pts[i].x - x0;
        const dy = pts[i].y - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len <= 0.0001) continue;

        const s0 = acc;
        acc += len;
        if (acc <= from || s0 >= to) continue;   // 这段不在范围内

        const t0 = Math.max(0, (from - s0) / len);
        const t1 = Math.min(1, (to - s0) / len);
        if (started) {
            ctx.lineTo(x0 + dx * t0, y0 + dy * t0);
        } else {
            ctx.moveTo(x0 + dx * t0, y0 + dy * t0);
            started = true;
        }
        ctx.lineTo(x0 + dx * t1, y0 + dy * t1);
    }

    if (started) ctx.stroke();
}

// 画一条蛇：每一节用自己血量对应的颜色。
// 颜色分界按「离蛇头的弧长」钉死 —— 身体格子在一个步长内是不动的
// （只有头和尾在伸缩），所以按格子中点分界会让伤口一格一格地跳；
// 按弧长分界才能让它跟着身体一起平滑地滑过去。
// segScale < 1 时，每一节各自绕自己的中点收缩（死去时用）
function strokeSnake(pts, body, hp, bodyColor, headColor, dir, segScale) {
    const s = (segScale === undefined) ? 1 : Math.max(0, segScale);
    if (s <= 0.01) return;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = (CELL - 3) * s;

    const total = pathLength(pts);
    const n = body.length;
    // 圆头会让颜色往两头各溢出半个线宽，导致分界整体后移；
    // 起止各加一个圆头半径抵消掉，分界才落在该在的位置
    const cap = (CELL - 3) * s / 2;

    for (let i = 0; i < n; i++) {
        ctx.strokeStyle = segmentColor(bodyColor, hp[i]);

        const a = ((i === 0) ? 0 : (i - 0.5) * CELL) + cap;
        const b = ((i === n - 1) ? total : (i + 0.5) * CELL) + cap;
        const mid = (a + b) / 2;
        strokeArc(pts, mid + (a - mid) * s, mid + (b - mid) * s);
    }

    ctx.shadowBlur = 0;   // 光晕只加在身体上
    drawHead(pts[0], dir, segmentColor(headColor, hp[0]), s);
}

// 以某个点为轴做缩放，用来做出生动画
function withSpawnScale(px, py, s, draw) {
    if (s >= 0.999) {
        draw();
        return;
    }
    if (s <= 0.02) return;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(s, s);
    ctx.translate(-px, -py);
    draw();
    ctx.restore();
}

// 加速光晕：整条蛇一次描完来投阴影。
// 逐节描边的话每一节都会各投一圈，光晕会被后画上去的身体切成一截一截 —— 只留最外面完整的一圈。
function drawBoostGlow(pts, color) {
    if (pts.length === 0) return;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 191, 255, 0.95)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;      // 用身体本色，之后被真正的蛇身盖掉，接缝处不会露边
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = CELL - 3;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // 头是个圆角方，光晕那条线盖不满四个角，这里补上
    const size = CELL - 3;
    roundRect(pts[0].x - size / 2, pts[0].y - size / 2, size, size, size * 0.35);
    ctx.fill();

    ctx.restore();
}

// 无敌期间每隔 120ms 藏一下自己：一眼能看出「现在撞不死」
function snakeBlinking(p) {
    return invincible(p, gameNow) && (Math.floor(gameNow / 120) % 2 === 0);
}

function drawSnake(p) {
    if (!p.alive || p.body.length === 0) return;
    if (snakeBlinking(p)) return;      // 无敌闪烁

    const head = p.body[0];
    const s = spawnScale(p.spawnAt, nowRef);
    const pts = buildPath(p.body, p.dir, progress(p), state === 'running' && !willGrowNext(p));

    withSpawnScale(cxOf(head), cyOf(head), s, function () {
        if (boosted(p)) drawBoostGlow(pts, p.def.body);
        strokeSnake(pts, p.body, p.hp, p.def.body, p.def.head, p.dir);
    });
}

// 阵亡动画：每一节各自绕自己的中点「缓入」缩到 0
// 合作模式的复活道具：粉色圆底 + 白十字，一眼看出是救人的
function drawReviveItem() {
    if (!reviveItem) return;

    const cx = cxOf(reviveItem);
    const cy = cyOf(reviveItem);
    const r = CELL * 0.36;

    ctx.fillStyle = COLOR.revive;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    const w = r * 0.34;
    ctx.fillRect(cx - w / 2, cy - r * 0.6, w, r * 1.2);
    ctx.fillRect(cx - r * 0.6, cy - w / 2, r * 1.2, w);
}

// ------------------------------ 剪短动画 ------------------------------
// 「头缩回去」：被剪掉的头颈从原来的位置往回缩进身体，边缩边淡出。
// 偏移和缩放拆成两个小函数，方便直接测（动画本身没法用像素断言）。
function cutFxK(fx, now) {
    return Math.max(0, Math.min(1, (now - fx.at) / CUT_FX_MS));
}

// 往回缩多少格：0 -> 1.35 格，方向与蛇的行进方向相反
function cutFxOffset(fx, now) {
    const k = cutFxK(fx, now);
    const back = easeOutCubic(k) * CELL * 1.35;
    return { x: -fx.dir.x * back, y: -fx.dir.y * back };
}

// 越缩越小、越淡
function cutFxScale(fx, now) {
    return 1 - easeInCubic(cutFxK(fx, now));
}

function drawCutFx() {
    if (!cutFx) return;
    for (let i = cutFx.length - 1; i >= 0; i--) {
        const fx = cutFx[i];
        if (cutFxK(fx, gameNow) >= 1) {
            cutFx.splice(i, 1);
            continue;
        }
        const off = cutFxOffset(fx, gameNow);
        const pts = buildPath(fx.cells, fx.dir, 0, false);
        ctx.save();
        ctx.translate(off.x, off.y);
        strokeSnake(pts, fx.cells, fx.hp, fx.bodyColor, fx.headColor, fx.dir, cutFxScale(fx, gameNow));
        ctx.restore();
    }
}

function drawCorpses() {
    for (let i = 0; i < corpses.length; i++) {
        const c = corpses[i];
        const t = Math.min(1, (nowRef - c.diedAt) / DEATH_ANIM_MS);
        if (t >= 1 || c.body.length === 0) continue;

        const pts = buildPath(c.body, c.dir, 0, false);
        strokeSnake(pts, c.body, c.hp, c.bodyColor, c.headColor, c.dir,
            1 - easeInCubic(t));
    }
}

function drawEnemy() {
    for (let i = 0; i < enemies.length; i++) {
        const en = enemies[i];
        if (en.body.length === 0) continue;

        const e = ease(Math.max(0, Math.min(en.acc / en.stepMs, 1)));
        const head = en.body[0];

        // 下一步会变长（抢到苹果）的话，这一步尾巴不缩
        const retract = !willEatApple(head.x + en.dir.x, head.y + en.dir.y);

        const def = enemyDef(en);
        const pts = buildPath(en.body, en.dir, e, retract);
        withSpawnScale(cxOf(head), cyOf(head), spawnScale(en.spawnAt, nowRef), function () {
            // 敌人吃到闪电也一样发光
            if (en.boostUntil > 0) drawBoostGlow(pts, def.body);
            strokeSnake(pts, en.body, en.hp, def.body, def.head, en.dir);
        });
    }
}

// '#rrggbb' -> [r, g, b]
function rgbOf(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
}

// 部位的颜色直接由剩余血量决定：满血是本色，血越少压得越暗
function segmentColor(baseHex, hp) {
    const max = levelCfg.hp0;
    const h = (hp === undefined) ? max : Math.max(0, Math.min(hp, max));
    let t = (max <= 1) ? 0 : 1 - (h - 1) / (max - 1);   // 满血 0 -> 血见底 1
    t = Math.max(0, Math.min(t, 1));
    if (t <= 0) return baseHex;

    const c = rgbOf(baseHex);
    const k = 1 - t * 0.72;    // 最暗时压到本色的 28%
    return 'rgb(' + Math.round(c[0] * k) + ',' + Math.round(c[1] * k) + ',' + Math.round(c[2] * k) + ')';
}

// 敌人尸体掉落物：绿色加号 = 加身长，金币 = 加货币
function drawDrops() {
    for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const cx = cxOf(d);
        const cy = cyOf(d);
        const r = CELL * 0.3;

        // 快消失时闪烁提醒
        const left = d.expireAt - nowRef;
        if (left < 3000) {
            ctx.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(left / 120));
        }

        ctx.fillStyle = (d.kind === 'len') ? COLOR.dropLen : COLOR.dropCoin;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        if (d.kind === 'len') {
            const t = r * 0.2;
            ctx.fillRect(cx - t, cy - r * 0.55, t * 2, r * 1.1);
            ctx.fillRect(cx - r * 0.55, cy - t, r * 1.1, t * 2);
        } else {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;
    }
}

function drawOverlay() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 遮罩和文字画在画布坐标系：不跟着缩小
    ctx.fillStyle = COLOR.mask;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);   // 遮罩盖视口，不盖整个世界

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = COLOR.text;
    ctx.font = 'bold 22px ' + FONT;

    // 竞争模式直接报胜负。人数不定，所以看还剩几个活着的。
    let title = '游戏结束';
    if (teamMode === 'vs' && players.length > 1) {
        const alive = [];
        for (let i = 0; i < players.length; i++) {
            if (players[i].alive) alive.push(players[i]);
        }
        if (alive.length === 1) title = alive[0].def.name + ' 获胜';
        else if (alive.length === 0) title = '平局';
    }
    ctx.fillText(title, VIEW_W / 2, VIEW_H / 2 - 26);

    ctx.font = '15px ' + FONT;
    const parts = [];
    for (let i = 0; i < players.length; i++) {
        parts.push(players[i].def.name + ' ' + players[i].score);
    }
    ctx.fillText(parts.join('　'), VIEW_W / 2, VIEW_H / 2 + 6);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '12px ' + FONT;
    ctx.fillText(netRole === 'guest'
        ? (netSpectating()
            ? '观战中 · 等主机重开一局 · 按 Esc 断开'
            : '等主机重开一局（也可以点上面的「请求重开」）· 按 Esc 断开连接')
        : '按空格 / 回车重新开始 · 按 Esc 回到模式选择', VIEW_W / 2, VIEW_H / 2 + 38);
}

function drawPauseOverlay() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLOR.mask;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = COLOR.text;
    ctx.font = 'bold 22px ' + FONT;
    ctx.fillText('已暂停', VIEW_W / 2, VIEW_H / 2 - 16);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '12px ' + FONT;
    ctx.fillText('按 P 或点「继续 ▶」回到游戏', VIEW_W / 2, VIEW_H / 2 + 22);
}

// ------------------------------ 摄像机 ------------------------------
// 跟谁：联机客机跟自己的座位，其他人跟 P1；本人出局就跟第一个还活着的，
// 全死了/在菜单里就保持原位不动。
function cameraFocus() {
    const mine = mySeatIndex();
    if (mine >= 0 && players[mine] && players[mine].alive) return players[mine];
    for (let i = 0; i < players.length; i++) {
        if (players[i] && players[i].alive) return players[i];
    }
    return (players && (players[mine >= 0 ? mine : 0] || players[0])) || null;
}

let camReady = false;
let camLastMs = 0;

// 目标 = 焦点蛇头居中，再夹进世界里。按时间做指数平滑（跟帧率无关）。
function updateCamera() {
    const now = performance.now();
    const dt = camLastMs ? Math.min(80, now - camLastMs) : 16;
    camLastMs = now;

    let tx = camX;
    let ty = camY;
    const p = cameraFocus();
    if (p && p.body && p.body[0]) {
        // 居中用的是「一屏能看到的世界大小」，不是画布尺寸（缩放后两者不一样）
        tx = p.body[0].x * CELL + CELL / 2 - viewWorldW() / 2;
        ty = p.body[0].y * CELL + CELL / 2 - viewWorldH() / 2;
    }
    tx = clampCam(tx, boardWorldW(), viewWorldW());
    ty = clampCam(ty, boardWorldH(), viewWorldH());

    // 第一帧直接就位，否则开局会从左上角飞过去
    const k = camReady ? (1 - Math.exp(-dt / 110)) : 1;
    camX = clampCam(camX + (tx - camX) * k, boardWorldW(), viewWorldW());
    camY = clampCam(camY + (ty - camY) * k, boardWorldH(), viewWorldH());
    camReady = true;
}

// 画面之外的敌人 / 其他玩家：在视口边缘点一个小圆点（用各自的颜色）。
// 大地图上不至于「人跑哪去了都不知道」。
function drawOffscreenHints() {
    const M = 10 / zoom;                  // 离边缘 10 个「屏幕像素」，缩放后同样远
    const vw = viewWorldW();
    const vh = viewWorldH();
    const marks = [];
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p.alive || !p.body[0]) continue;
        marks.push({ x: cxOf(p.body[0]), y: cyOf(p.body[0]), color: p.def.body });
    }
    for (let i = 0; i < enemies.length; i++) {
        const h = enemies[i].body[0];
        if (!h) continue;
        marks.push({ x: cxOf(h), y: cyOf(h), color: enemyDef(enemies[i]).head });
    }

    for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (m.x >= 0 && m.x <= vw && m.y >= 0 && m.y <= vh) continue;
        const x = Math.max(M, Math.min(vw - M, m.x));
        const y = Math.max(M, Math.min(vh - M, m.y));
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.stroke();
    }
}

function render() {
    // dpr × zoom：之后所有绘制都在「世界像素」里，缩放由这一句统一负责
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
    updateCamera();
    drawBoard();

    // 场地正在长大的时候，场上的东西一律裁在场地矩形里 ——
    // 否则新冒出来的那圈格子里的内容会提前出现在还没长到的地方
    const growing = boardGrowing();
    if (growing) {
        const b = boardRect();
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.clip();
    }

    drawApple();
    drawSpeedItem();
    drawWidenItem();
    drawReviveItem();
    drawDrops();
    drawTurrets();
    drawBullets();
    drawCorpses();
    drawEnemy();
    for (let i = 0; i < players.length; i++) drawSnake(players[i]);
    drawCutFx();                   // 被剪掉的头颈往回缩（画在蛇上面）
    if (growing) ctx.restore();

    drawOffscreenHints();          // 屏幕外的目标给个小圆点，画在遮罩下面
    if (state === 'over') drawOverlay();
    else if (state === 'paused') drawPauseOverlay();
}

function syncEnemyHud(now) {
    if (state === 'over' || state === 'menu') {   // 暂停时照样显示，只是数字不动
        enemyTagEl.hidden = true;
        return;
    }
    enemyLeftEl.textContent = enemies.length + '/' + enemyTargetCount(now);
    enemyTagEl.hidden = false;
}

function drawTurrets() {
    for (let i = 0; i < turrets.length; i++) {
        const t = turrets[i];
        const cx = cxOf(t);
        const cy = cyOf(t);
        const size = CELL * 0.74;

        ctx.fillStyle = COLOR.turretBase;
        roundRect(cx - size / 2, cy - size / 2, size, size, size * 0.25);
        ctx.fill();

        // 炮管瞄最近的敌人，没敌人就朝上
        let ang = -Math.PI / 2;
        const aim = nearestEnemyHead(t.x, t.y);
        if (aim) ang = Math.atan2(cyOf(aim) - cy, cxOf(aim) - cx);
        ctx.strokeStyle = COLOR.turretBarrel;
        ctx.lineWidth = CELL * 0.17;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * CELL * 0.44, cy + Math.sin(ang) * CELL * 0.44);
        ctx.stroke();

        ctx.fillStyle = COLOR.turretCore;
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.15, 0, Math.PI * 2);
        ctx.fill();

        // 升级等级：塔下排小点，蓝 = A 跟踪，橙 = B 火力
        const lvA = upgradeLevel(t, 'A');
        const lvB = upgradeLevel(t, 'B');
        if (lvA || lvB) {
            const r = CELL * 0.09;
            const step = r * 2.6;
            let x = cx - step * (lvA + lvB - 1) / 2;
            const y = cy + CELL * 0.42;
            for (let k = 0; k < lvA; k++) {
                ctx.fillStyle = '#4aa3ff';
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                x += step;
            }
            for (let k = 0; k < lvB; k++) {
                ctx.fillStyle = '#ffb703';
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                x += step;
            }
        }
    }
}

function drawBullets() {
    for (let i = 0; i < bullets.length; i++) {
        // 敌方子弹换个颜色，一眼能看出该躲哪颗
        ctx.fillStyle = (bullets[i].from === 'enemy') ? COLOR.enemyBullet : COLOR.bullet;
        ctx.beginPath();
        ctx.arc(pxOf(bullets[i].x), pyOf(bullets[i].y), CELL * 0.16, 0, Math.PI * 2);
        ctx.fill();
    }
}

// 暂停 / 继续
let pauseBtnLabel = '';
function syncPauseBtn() {
    const label = (state === 'paused') ? '继续 ▶' : '暂停 ❚❚';
    if (label !== pauseBtnLabel) {
        pauseBtnEl.textContent = label;
        pauseBtnLabel = label;
    }
    pauseBtnEl.classList.toggle('is-off', state !== 'running' && state !== 'paused');
}

// 「我」控制的是哪条蛇：联机客机是主机分配的座位（可能 >0），
// 本地单人和联机主机都是 0，观战席没有蛇（-1）
function mySeatIndex() {
    if (netRole === 'guest') {
        return (netSeat === null || netSeat < 0) ? -1 : netSeat;
    }
    return 0;
}

// 身长不够 / 到上限时按钮变灰
let buildBtnLabels = ['', ''];
let lastSkin = '';

function syncBuildBtn() {
    // 本地双人才摆出第二个方向键盘（手机上一只手按一个；联机时只有自己那一个）
    const pad2 = document.getElementById('pad2');
    if (pad2) pad2.hidden = !dualLocal();

    const dual = dualLocal();
    const mine = mySeatIndex();

    // 手机端两套皮肤：本地双人（两个方向盘并排、按钮缩小一点）和观战
    // （没有可操作的蛇，方向键/建塔/暂停在 CSS 里收起来）
    const skin = (dual ? 'd' : '') + (netSpectating() ? 's' : '');
    if (skin !== lastSkin) {           // 操作区高度变了，视口跟着重算
        lastSkin = skin;
        updateView();
    }
    document.body.classList.toggle('dualmode', dual);
    document.body.classList.toggle('spectating', netSpectating());

    for (let i = 0; i < buildBtnEls.length; i++) {
        // 本地双人：按钮 i 就是玩家 i，两个都摆出来。
        // 其它情况（单人 / 联机主机 / 联机客机）只留一个按钮，而且它必须显示
        // 「我」那条蛇 —— 联机客机的座位可能是 3、4、5，以前写死 P1/P2，
        // 客机看到的永远不是自己；观战席则一个按钮都不该有。
        const idx = dual ? i : mine;
        const show = dual ? (i < players.length) : (i === 0 && idx >= 0 && !!players[idx]);
        if (!show) {
            buildBtnEls[i].style.display = 'none';
            continue;
        }
        const p = players[idx];
        buildBtnEls[i].style.display = '';

        // 联机时写「我（P3）」并去掉键位提示 —— 客机那边键位和座位对不上
        const who = dual ? p.def.name : (netRole ? '我（' + p.def.name + '）' : p.def.name);
        const key = (dual || !netRole) ? '[' + p.def.buildKey + ']' : '';
        const label = who + ' 建塔' + key + ' −' + levelCfg.turretCost +
            '身长 −' + levelCfg.turretCoins + '币　' + turretCount(p) + '/' + levelCfg.turretMax;
        if (label !== buildBtnLabels[i]) {
            buildBtnEls[i].textContent = label;
            buildBtnLabels[i] = label;
        }
        buildBtnEls[i].classList.toggle('is-off', !canBuild(p));
    }

    syncUpgradeBtns();
}

// 升级按钮：显示「离我最近那座塔」的等级和下一级价格；
// 没塔 / 已满级 / 币不够就变灰，客机只读文案（点了发给主机）。
function syncUpgradeBtns() {
    const dual = dualLocal();
    const mine = mySeatIndex();

    for (let i = 0; i < upABtnEls.length; i++) {
        const idx = dual ? i : mine;
        const show = dual ? (i < players.length) : (i === 0 && idx >= 0 && !!players[idx]);
        const btnA = upABtnEls[i];
        const btnB = upBBtnEls[i];
        if (!btnA || !btnB) continue;

        if (!show) {
            btnA.style.display = 'none';
            btnB.style.display = 'none';
            continue;
        }
        btnA.style.display = '';
        btnB.style.display = '';

        const p = players[idx];
        const t = nearestTurret(p);
        const pair = [[btnA, 'A'], [btnB, 'B']];
        for (let k = 0; k < pair.length; k++) {
            const btn = pair[k][0];
            const path = pair[k][1];
            const name = (path === 'A') ? '跟踪' : '火力';
            let label;
            let off = true;
            if (!t) {
                label = path + ' ' + name + ' · 先建塔';
            } else {
                const lv = upgradeLevel(t, path);
                const cost = upgradeCost(t, path);
                if (cost < 0) {
                    label = path + ' ' + name + ' ' + lv + '/' + TURRET_UP_MAX + ' 满';
                } else {
                    label = path + ' ' + name + ' ' + lv + '→' + (lv + 1) + ' · ' + cost + '币';
                    off = !canUpgrade(p, path);
                }
            }
            if (btn.textContent !== label) btn.textContent = label;
            btn.classList.toggle('is-off', off);
        }
    }
}
