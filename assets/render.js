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
    if (typeof syncSaveBtns === 'function') syncSaveBtns();    // 存档按钮的可用状态
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
    // 永久速度倍率（全场增益道具叠的）：有就一起显示，比如「×1.10」
    let mul = 1;
    for (let i = 0; i < players.length; i++) {
        if (players[i] && players[i].permMul > mul) mul = players[i].permMul;
    }
    const mulTxt = (mul > 1.001) ? ' ×' + mul.toFixed(2) : '';

    const unitEl = document.getElementById('boostUnit');
    if (left > 0) {
        boostLeftEl.textContent = String(left) + mulTxt;
        if (unitEl) unitEl.hidden = false;
        boostEl.hidden = false;
    } else if (mul > 1.001) {
        // 没有限时加速，只有永久倍率：显示常驻的「×1.02」，不显示秒数后缀
        boostLeftEl.textContent = mulTxt.trim();
        if (unitEl) unitEl.hidden = true;
        boostEl.hidden = false;
    } else {
        boostEl.hidden = true;
    }
}

// ------------------------------ 插值 ------------------------------
// 当前这一步的进度 0~1，再套上缓动曲线
// 下一步会不会「走不过去」：墙、或者不死的设定下撞到蛇/炮塔。
// 提前判断的作用：这半步干脆不插值 —— 否则头会先朝障碍物插过去，被挡住时再弹回上一格，
// 看起来就是「一顿」。撞墙和撞蛇必须用同一个判断，否则两种动画不一样。
function blockedAhead(p) {
    if (!p || !p.body || !p.body[0] || !p.dir) return false;
    const h = p.body[0];
    const nx = h.x + p.dir.x;
    const ny = h.y + p.dir.y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return true;   // 场地边界
    if (typeof wallAt === 'function' && wallAt(nx, ny)) return true;  // 随机障碍物（和墙同样处理）

    // 只有「关卡碰撞不死」是「挡住」；作弊 /god snake 是「穿过去」——
    // 穿过去的时候当然要继续播动画，不能把 progress 按在 0（那样看着像没动画）。
    const blocking = (typeof levelCfg !== 'undefined' && levelCfg.noCrash);
    if (!blocking) return false;

    if (typeof enemyAt === 'function' && enemyAt(nx, ny, null)) return true;
    if (typeof playerAt === 'function' && playerAt(nx, ny, p)) return true;
    if (typeof occupiedByTurret === 'function' && occupiedByTurret(nx, ny)) return true;
    for (let i = 0; i < p.body.length; i++) {
        if (p.body[i].x === nx && p.body[i].y === ny) return true;
    }
    return false;
}

function progress(p) {
    // 前方被挡（墙 / 蛇 / 炮塔）：这半步不插值，头贴住原地。
    // 注意不能用「上一步被挡住」的标记 —— 那个标记在转向后还留着，
    // 会把下一步的整段动画按在 0，看起来就是「位置突然跳一格」。
    if (blockedAhead(p)) return 0;
    return ease(Math.max(0, Math.min(p.acc / p.stepMs, 1)));
}

// 出洞：进房后身体从洞里一点点拉长。
//   k = 0..1 进度；可见长度从 2 节长到全身，尾巴停在某一节中间 -> 连续，不是一格一格跳。
const ROOM_EMERGE_MAX_MS = 1200;

// 出洞进度（0~1）：这一个步长里身体还要「长出来」多少。
// 注意是「整条蛇连续地变长」，不是把某一节单独画在一边 —— 那样会出现
// 断开的一节、以及描边连出来的细线（踩过这个坑）。
function emergeGrow(p) {
    if (!p || !(p.emergeLeft > 0) || p.body.length <= 2) return 0;
    return 1 - easeOutCubic(Math.max(0, Math.min(1, (p.acc || 0) / (p.stepMs || 1))));
}

// 出生 / 进房缩放动画：0 -> 1.15（缓入放大）-> 1（回收一点）
// 和物品出生那条曲线同一个手感，只是时长取 SPAWN_ANIM_MS。
function spawnScale(at, now) {
    if (at === undefined || at === null || at < 0) return 1;
    const t = (now - at) / SPAWN_ANIM_MS;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const peak = 1.15;
    if (t < 0.55) return peak * easeInCubic(t / 0.55);
    return 1 + (peak - 1) * (1 - easeOutCubic((t - 0.55) / 0.45));
}

// 把一条蛇抽象成折线：蛇头沿方向探出 e 格，蛇尾同步缩回 e 格
// tailE：尾巴单独用的偏移（0~1）。出洞动画里身体是「半截」的，
// 头还在整格上、尾巴停在某一节的中间，所以两者不能共用一个 e。
function buildPath(body, dir, e, retract, tailE) {
    const te = (tailE === undefined) ? e : tailE;
    const head = body[0];

    // 蛇头先探出去。但位置要夹在场地里：无敌顶着墙时逻辑上这一步不成立，
    // 画面上也不能继续往墙里伸（否则看起来一直在「顶」）。
    const hx = Math.max(0.5, Math.min(COLS - 0.5, head.x + 0.5 + dir.x * e));
    const hy = Math.max(0.5, Math.min(ROWS - 0.5, head.y + 0.5 + dir.y * e));
    const pts = [{ x: hx * CELL - camX + renderOffsetX, y: hy * CELL - camY + renderOffsetY }];

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
        pts[pts.length - 1] = { x: tx + (px - tx) * te, y: ty + (py - ty) * te };
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

// 不同种类房间的主色：给玩家一个一眼可辨的地面基调
const ROOM_TINT = {
    safe: 'rgba(70, 200, 140, 0.10)',
    battle: 'rgba(120, 150, 210, 0.07)',
    supply: 'rgba(230, 180, 80, 0.10)',
    chest: 'rgba(255, 210, 90, 0.16)',
    boss: 'rgba(220, 90, 90, 0.14)'
};

function roomTint() {
    if (typeof room === 'undefined' || !room) return null;
    return ROOM_TINT[room.kind] || null;
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

    // 房间种类底色：很淡的一层，不抢蛇和道具的颜色
    const tint = roomTint();
    if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    // 随机障碍物：深色石块（画在网格线之前，线会盖在上面）
    if (typeof walls !== 'undefined' && walls && walls.length) {
        for (let i = 0; i < walls.length; i++) {
            const w = walls[i];
            const x = pxOf(w.x);
            const y = pyOf(w.y);
            if (x + CELL < b.x || x > b.x + b.w || y + CELL < b.y || y > b.y + b.h) continue;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
        }
    }

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

// 本层小地图：右下角的小方格。暗 = 没进过、灰 = 进过、亮 = 清过、描边 = 当前。
function drawFloorMap() {
    if (typeof roomRun === 'undefined' || !roomRun || !roomRun.rooms) return;
    if (typeof room === 'undefined' || !room) return;

    const rooms = roomRun.rooms;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < rooms.length; i++) {
        if (rooms[i].gx > maxX) maxX = rooms[i].gx;
        if (rooms[i].gy > maxY) maxY = rooms[i].gy;
    }
    const cols = maxX + 1;
    const rows = maxY + 1;
    const gap = 3;
    const cellPx = 11;
    const w = cols * cellPx + (cols - 1) * gap;
    const h = rows * cellPx + (rows - 1) * gap;
    const pad = 8;
    const ox = VIEW_W - w - pad;
    const oy = VIEW_H - h - pad;
    // gy = 0 是北边（n 方向 dy = -1），画在上方；不翻 y 轴的话门的方向会和房间对不上
    const cellY = function (gy) { return oy + gy * (cellPx + gap); };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(ox - 6, oy - 6, w + 12, h + 12, 6);
    ctx.fill();

    // 先把房间之间的「走廊」连出来，否则只看方块分不清哪两间相通
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.lineWidth = 2;
    for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        const cx1 = ox + r.gx * (cellPx + gap) + cellPx / 2;
        const cy1 = cellY(r.gy) + cellPx / 2;
        for (const d in r.doors) {
            const n = rooms[r.doors[d]];
            if (!n) continue;
            // 只画「东」和「南」，免得一条线画两遍
            if (d !== 'e' && d !== 's') continue;
            const cx2 = ox + n.gx * (cellPx + gap) + cellPx / 2;
            const cy2 = cellY(n.gy) + cellPx / 2;
            ctx.beginPath();
            ctx.moveTo(cx1, cy1);
            ctx.lineTo(cx2, cy2);
            ctx.stroke();
        }
    }

    for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        const x = ox + r.gx * (cellPx + gap);
        const y = cellY(r.gy);
        const cleared = !!(roomRun.done && roomRun.done[i]);
        const visited = !!(roomRun.memo && roomRun.memo[i]) || i === roomRun.i;
        ctx.fillStyle = cleared ? 'rgba(140, 240, 180, 0.85)'
            : (visited ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 255, 255, 0.14)');
        roundRect(x, y, cellPx, cellPx, 2);
        ctx.fill();
        if (i === roomRun.i) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.lineWidth = 2;
            roundRect(x - 1.5, y - 1.5, cellPx + 3, cellPx + 3, 3);
            ctx.stroke();
        }
    }
}

// 换房过渡里「用覆盖层」的两种：黑场淡入 / 马赛克方块消失
function drawRoomFade() {
    if (typeof roomFxState !== 'function') return;
    const fx = roomFxState(nowRef);
    if (fx.k >= 1) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (fx.type === 'fade') {
        if (fx.alpha <= 0.01) return;
        ctx.fillStyle = 'rgba(0, 0, 0, ' + fx.alpha.toFixed(3) + ')';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        return;
    }

    if (fx.type === 'mosaic') {
        // 方块从大变小、一块块散开：k=0 时整屏被大块盖住，k=1 时全没了
        const cols = 12;
        const rows = Math.max(4, Math.round(12 * VIEW_H / Math.max(1, VIEW_W)));
        const bw = VIEW_W / cols;
        const bh = VIEW_H / rows;
        const grow = 1 - easeOutCubic(fx.k);
        const size = Math.min(bw, bh) * (1.15 * grow);
        if (size <= 0.5) return;
        ctx.fillStyle = 'rgba(0, 0, 0, ' + (0.55 + 0.45 * fx.k).toFixed(3) + ')';
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                // 交错出现/消失，看起来更像马赛克而不是一块黑板
                if ((r + c) % 2 === 1 && fx.k < 0.45) continue;
                ctx.fillRect(c * bw - size / 2 + bw / 2, r * bh - size / 2 + bh / 2, size, size);
            }
        }
    }
}

// 房间的两端是同一个东西：一个「洞」。
//   d = -1 左边的洞（回上一间，随时能回） / +1 右边的门（清场后去下一间）
//   open = 现在能不能过（能过就绿色脉动 + 箭头，不能过就暗着）
// 两边形状、大小完全一样，只有箭头方向不同。
const HOLE_R = 0.82;       // 洞的半径（格）—— 正圆，两边共用

function drawRoomPortal(at, dir, open) {
    if (!at) return;
    // 位置直接取「画出来的场地」的边缘：场地长大时门跟着右墙走、洞跟着左墙走。
    // 不自己插值 —— 那会和场地长大的 renderOffset 叠加，看起来是双倍位移。
    // 贴到对应的那面墙（用「画出来的场地」尺寸，场地长大时会跟着走）
    const boardW = boardWorldW();
    const boardH = boardWorldH();
    let px = at.x;
    let py = at.y;
    if (dir === 'e') px = (boardW / CELL) - 1;
    else if (dir === 'w') px = 0;
    else if (dir === 'n') py = 0;
    else if (dir === 's') py = (boardH / CELL) - 1;
    const cx = px * CELL - camX + CELL / 2;
    const cy = py * CELL - camY + CELL / 2;
    const rx = CELL * HOLE_R;
    const ry = CELL * HOLE_R;

    // 外圈：被顶起来的一圈土（让坑有厚度）
    ctx.fillStyle = 'rgba(120, 96, 64, 0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.16, ry * 1.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // 坑内部：中间最黑，往外淡一点
    const g = ctx.createRadialGradient(cx, cy, CELL * 0.06, cx, cy, rx);
    g.addColorStop(0, 'rgba(0, 0, 0, 0.96)');
    g.addColorStop(0.65, 'rgba(0, 0, 0, 0.88)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    if (open) {
        const pulse = 0.5 + 0.5 * Math.abs(Math.sin(nowRef / 240));
        ctx.strokeStyle = 'rgba(140, 240, 180, ' + (0.55 + 0.4 * pulse) + ')';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        // 箭头：朝这扇门通向的方向
        const ax = (dir === 'e') ? 1 : (dir === 'w' ? -1 : 0);
        const ay = (dir === 's') ? 1 : (dir === 'n' ? -1 : 0);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.beginPath();
        if (ax !== 0) {
            ctx.moveTo(cx + ax * rx * 0.42, cy);
            ctx.lineTo(cx - ax * rx * 0.36, cy - ry * 0.44);
            ctx.lineTo(cx - ax * rx * 0.36, cy + ry * 0.44);
        } else {
            ctx.moveTo(cx, cy + ay * ry * 0.42);
            ctx.lineTo(cx - rx * 0.44, cy - ay * ry * 0.36);
            ctx.lineTo(cx + rx * 0.44, cy - ay * ry * 0.36);
        }
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
    }
}

function drawRoomHole() {
    if (typeof room === 'undefined' || !room) return;
    // 四面的门：清场后都开
    const list = room.portals || [];
    for (let i = 0; i < list.length; i++) {
        drawRoomPortal(list[i], list[i].dir, !!room.cleared);
    }
    // 起点那间左边是「进来时的洞」—— 只是装饰，通不出去，所以画成暗的
    if (room.entrance) drawRoomPortal(room.entrance, 'n', false);

    // BOSS 房清空后的楼梯：画成向上指的亮门
    if (room.stairs) {
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(nowRef / 260));
        const cx = cxOf(room.stairs);
        const cy = cyOf(room.stairs);
        const r = CELL * 0.62;
        ctx.strokeStyle = 'rgba(255, 230, 140, ' + (0.5 + 0.4 * pulse) + ')';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 240, 200, 0.9)';
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.55);
        ctx.lineTo(cx + r * 0.42, cy + r * 0.25);
        ctx.lineTo(cx - r * 0.42, cy + r * 0.25);
        ctx.closePath();
        ctx.fill();
    }
}

function drawRoomDoor() {
    // 门已经由 drawRoomHole 一起画了，这里留空（旧调用点还在）
}


function drawApple() {
    const r = CELL * 0.32;

    for (let i = 0; i < apples.length; i++) {
        const a = apples[i];
        const cx = cxOf(a);
        const cy = cyOf(a);

        withSpawnScale(cx, cy, popScale(a.at, nowRef), function () {
            ctx.fillStyle = COLOR.apple;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.beginPath();
            ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.28, 0, Math.PI * 2);
            ctx.fill();
        });
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
    withSpawnScale(cx, cy, popScale(p.at, nowRef), function () { drawSpeedBody(cx, cy, r); });
}

// 全场增益道具：金色圆底 + 外圈光环 + 中间的星
function drawTeamItem() {
    const list = powerList('team');
    for (let i = 0; i < list.length; i++) drawTeamAt(list[i]);
}

function drawTeamAt(p) {
    const cx = cxOf(p);
    const cy = cyOf(p);
    const r = CELL * 0.34;
    withSpawnScale(cx, cy, popScale(p.at, nowRef), function () { drawTeamBody(cx, cy, r); });
}

function drawTeamBody(cx, cy, r) {
    const pulse = 0.5 + 0.5 * Math.sin(nowRef / 220);
    ctx.strokeStyle = 'rgba(255, 212, 94, ' + (0.35 + 0.4 * pulse) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.35 + 0.12 * pulse), 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = COLOR.team;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // 中间的星
    ctx.fillStyle = 'rgba(60, 40, 0, 0.85)';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + i * Math.PI / 5;
        const rad = (i % 2 === 0) ? r * 0.62 : r * 0.26;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
}

function drawSpeedBody(cx, cy, r) {
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
    withSpawnScale(cx, cy, popScale(p.at, nowRef), function () { drawWidenBody(cx, cy, r); });
}

function drawWidenBody(cx, cy, r) {
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
function strokeSnake(pts, body, hp, bodyColor, headColor, dir, segScale, widthMul) {
    const s = (segScale === undefined) ? 1 : Math.max(0, segScale);
    if (s <= 0.01) return;
    const wmul = (widthMul === undefined) ? 1 : Math.max(0.5, widthMul);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = (CELL - 3) * s * wmul;

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
// 物品出生：0 -> POP_PEAK（缓入放大）-> 1（回收一点）。
// 前 55% 放大、后 45% 收回，所以看起来是「弹出来再定住」。
function popScale(at, now) {
    if (at === undefined || at === null) return 1;
    const t = (now - at) / POP_MS;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    if (t < 0.55) return POP_PEAK * easeInCubic(t / 0.55);
    return 1 + (POP_PEAK - 1) * (1 - easeOutCubic((t - 0.55) / 0.45));
}

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
    const eNow = progress(p);
    p.drawnE = eNow;      // 记住这一帧蛇头探出到哪：死亡时尸体要从这里接着画

    // 出洞：整条蛇一起画，靠尾巴停在这一节的中间来表现「正在长出来」。
    // 尾巴偏移 tailE 只能取 0~1，所以身体永远是连续的一条，不会断开。
    const grow = emergeGrow(p);
    const emerging = (p.emergeLeft > 0 && p.body.length > 2);
    // 出洞期间：不按正常规则收尾（尾巴钉在洞口），改用 grow 的分数偏移；
    // 其它时候必须传 undefined，走原来的「尾巴跟着蛇头收」——
    // 否则尾巴会钉住不动、只在逻辑缩尾那一帧跳一格。
    // 出洞时要让 tailE（分数长度）生效，就必须走 retract 分支；
    // 传 false 的话 tailE 根本不会被用到 —— 身体会一格一格地「跳」出来。
    const retract = emerging ? true : (state === 'running' && !willGrowNext(p));
    const pts = buildPath(p.body, p.dir, eNow, retract, emerging ? grow : undefined);

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
    withSpawnScale(cx, cy, popScale(reviveItem.at, nowRef), function () { drawReviveBody(cx, cy, r); });
}

function drawReviveBody(cx, cy, r) {
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

// 尸体蛇头探出的比例：起点 = 死前最后一帧的位置，终点 = 1（整格撞进去），缓出
function corpseEase(c, now) {
    const from = (typeof c.e === 'number') ? c.e : 0;
    const k = Math.max(0, Math.min(1, (now - c.diedAt) / CORPSE_EASE_MS));
    return from + (1 - from) * easeOutCubic(k);
}

function drawCorpses() {
    for (let i = 0; i < corpses.length; i++) {
        const c = corpses[i];
        const t = Math.min(1, (nowRef - c.diedAt) / DEATH_ANIM_MS);
        if (t >= 1 || c.body.length === 0) continue;

        // c.e = 死前最后一帧画到的位置；再用 easeOut 滑到「撞进去那一格」，
        // 所以是「接上 + 缓出」，不是突变。
        const pts = buildPath(c.body, c.dir, corpseEase(c, nowRef), true);
        strokeSnake(pts, c.body, c.hp, c.bodyColor, c.headColor, c.dir,
            1 - easeInCubic(t));
    }
}

function drawEnemy() {
    for (let i = 0; i < enemies.length; i++) {
        const en = enemies[i];
        if (en.body.length === 0) continue;

        const e = ease(Math.max(0, Math.min(en.acc / en.stepMs, 1)));
        en.drawnE = e;        // 同上：敌尸也要接着这一帧的位置画
        const head = en.body[0];

        // 下一步会变长（抢到苹果）的话，这一步尾巴不缩
        // 和玩家那条蛇用同一个判断（苹果 / 加身长的掉落都算变长）
        const retract = !willGrowAt(head.x + en.dir.x, head.y + en.dir.y);

        const def = enemyDef(en);
        const pts = buildPath(en.body, en.dir, e, retract);
        withSpawnScale(cxOf(head), cyOf(head), spawnScale(en.spawnAt, nowRef), function () {
            // 敌人吃到闪电也一样发光
            if (en.boostUntil > 0) drawBoostGlow(pts, def.body);
            strokeSnake(pts, en.body, en.hp, def.body, def.head, en.dir, undefined, def.wide || 1);
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

        withSpawnScale(cx, cy, popScale(d.at, nowRef), function () {
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
        });

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

    // 换房过渡：移动 / 飞入 用变换（作用在整幅画面上）
    if (typeof roomFxState === 'function') {
        const fx = roomFxState(nowRef);
        if (fx.k < 1 && fx.type === 'slide') {
            ctx.translate(fx.dx, 0);
        } else if (fx.k < 1 && fx.type === 'zoom') {
            const cx = viewWorldW() / 2;
            const cy = viewWorldH() / 2;
            ctx.translate(cx, cy);
            ctx.scale(fx.scale, fx.scale);
            ctx.translate(-cx, -cy);
        }
    }

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

    drawRoomHole();                 // 房间模式：蛇正从这里的洞里往外钻
    drawRoomDoor();                 // 房间模式的门（画在苹果下面也行，它占一格不重叠）
    drawApple();
    drawSpeedItem();
    drawWidenItem();
    drawTeamItem();
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
    drawRoomFade();                // 换房间的黑场淡入
    drawFloorMap();                // 本层小地图
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
    // 菜单上不该出现「暂停」——那里只有「本地 / 开启房间」两个会开局的按钮
    pauseBtnEl.hidden = (state === 'menu');
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
