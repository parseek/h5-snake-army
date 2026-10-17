// ------------------------------ 存档 / 读档 ------------------------------
// 只存「本地单人 / 本地双人」的一局：联机房主存档没意义（人一散就复不回去），
// 座机更是只拿得到快照。存的是整局状态的 JSON，放 localStorage。
//
// 刻意不存的东西：best（全局记录）、音效/主题（那是设置，另有存储）、
// corpses / cutFx（纯动画残留，读回来就当没有）。
const RUN_KEY = 'snake-army-run';      // v1 时代的单槽 key（保留，读的时候会迁移过来）
const RUN_SLOT_KEY = 'snake-army-run-';  // v2：snake-army-run-0/1/2
const RUN_VER = 2;
const SAVE_SLOTS = 3;

// ---- 存储助手：所有存档读写都走这里，坏数据 / 配额满都不许把游戏搞崩 ----
function storeGet(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function storeSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        return false;      // 配额满 / 隐私模式
    }
}

function storeDel(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) { }
}

function slotKey(slot) {
    return RUN_SLOT_KEY + slot;
}

// 存档版本迁移：老存档不许因为版本变了就作废
function migrateRun(d) {
    if (!d || typeof d !== 'object') return null;
    if (!d.v) d.v = 1;
    if (d.v > RUN_VER) return null;                 // 未来的版本，读不了

    if (d.v === 1) {
        // v1 -> v2：加了「随机数流位置」。老存档没有种子，就给一个固定的，
        // 这样老存档读回来以后的行为至少是稳定的
        if (!d.rng) d.rng = [1, 1];
        d.v = 2;
    }
    return d;
}

function canSaveRun() {
    if (typeof netRole !== 'undefined' && netRole) return false;      // 联机不存
    if (typeof state === 'undefined') return false;
    return state === 'running' || state === 'paused';
}

// 把一局压成纯数据（只放 JSON 能表达的东西）
function runSnapshot() {
    const packPlayer = function (p) {
        return {
            i: p.def.i === undefined ? players.indexOf(p) : p.def.i,
            body: p.body.map(function (c) { return [c.x, c.y]; }),
            hp: p.hp.slice(),
            dir: [p.dir.x, p.dir.y],
            queue: p.queue.map(function (d) { return [d.x, d.y]; }),
            acc: p.acc,
            stepMs: p.stepMs,
            boostUntil: p.boostUntil || 0,
            permMul: p.permMul || 1,
            coins: p.coins || 0,
            score: p.score || 0,
            spawnAt: p.spawnAt,
            alive: !!p.alive,
            invUntil: p.invUntil || 0
        };
    };

    return {
        v: RUN_VER,
        at: Date.now(),
        mode: mode,
        team: teamMode,
        cols: COLS,
        rows: ROWS,
        cfg: levelCfg,
        now: gameNow,
        runStartAt: runStartAt,
        rng: (typeof rndState === 'function') ? [rndState(), rngSeed] : null,
        players: players.map(packPlayer),
        apples: apples.map(function (a) { return [a.x, a.y]; }),
        powerUps: {
            speed: powerList('speed').map(function (a) { return [a.x, a.y]; }),
            widen: powerList('widen').map(function (a) { return [a.x, a.y]; })
        },
        powerRespawnAt: { speed: powerRespawnAt.speed || 0, widen: powerRespawnAt.widen || 0 },
        enemies: enemies.map(function (en) {
            return {
                kind: en.kind,
                body: en.body.map(function (c) { return [c.x, c.y]; }),
                hp: en.hp.slice(),
                dir: [en.dir.x, en.dir.y],
                acc: en.acc,
                baseStepMs: en.baseStepMs,
                stepMs: en.stepMs,
                spawnAt: en.spawnAt,
                boostUntil: en.boostUntil || 0,
                boostAt: en.boostAt || 0,
                shootAt: en.shootAt || 0
            };
        }),
        enemyRespawns: enemyRespawns.slice(),
        drops: drops.map(function (d) {
            return [d.x, d.y, d.kind === 'len' ? 1 : 0, d.expireAt, d.at || 0];
        }),
        turrets: turrets.map(function (t) {
            return [t.x, t.y, players.indexOf(t.owner), t.cooldownUntil || 0, t.upA || 0, t.upB || 0];
        }),
        bullets: bullets.map(function (b) {
            return [b.x, b.y, b.vx, b.vy, b.from === 'enemy' ? 1 : 0, b.dmg || 1, b.homing || 0];
        }),
        revive: reviveItem ? [reviveItem.x, reviveItem.y, reviveItem.at || 0] : null,
        room: (typeof room !== 'undefined' && room) ? JSON.parse(JSON.stringify(room)) : null,
        roomRun: (typeof roomRun !== 'undefined' && roomRun) ? {
            i: roomRun.i, total: roomRun.total, seed: roomRun.seed,
            floor: roomRun.floor || 1,
            boss: roomRun.boss,
            revives: roomRun.revives || 0,
            done: roomRun.done || {}, seen: roomRun.seen || {}, memo: roomRun.memo || {}
        } : null
    };
}

// 当前选中的槽位（界面上那个下拉框）
function currentSlot() {
    const sel = document.getElementById('saveSlotSel');
    const n = sel ? Number(sel.value) : 0;
    return (n >= 0 && n < SAVE_SLOTS) ? n : 0;
}

// 存档。slot 不传就用界面上选中的那个。返回 true = 存下了
function saveRun(slot) {
    if (!canSaveRun()) return false;
    const s = (slot === undefined) ? currentSlot() : slot;
    const ok = storeSet(slotKey(s), runSnapshot());
    if (ok) syncSaveBtns();
    return ok;
}

// 所有槽位的摘要（开始页 / 槽位下拉框用）
function listRuns() {
    const out = [];
    for (let i = 0; i < SAVE_SLOTS; i++) {
        const d = storeGet(slotKey(i));
        const m = d ? migrateRun(d) : null;
        out.push({
            slot: i,
            empty: !m,
            at: m ? m.at : 0,
            label: m ? describeRun(m) : ''
        });
    }
    return out;
}

// 最近的一局（开始页的「继续」读这个）
function latestRun() {
    let best = null;
    for (const r of listRuns()) {
        if (r.empty) continue;
        if (!best || r.at > best.at) best = r;
    }
    return best;
}

// 读某个槽位（含版本迁移）。不传 slot 就取最近的一局
function readRun(slot) {
    if (slot === undefined) {
        const latest = latestRun();
        if (!latest) return null;

        // 顺手把 v1 那条老存档迁到槽 0（存过一次以后就不用再迁）
        const legacy = storeGet(RUN_KEY);
        if (legacy) {
            const m = migrateRun(legacy);
            if (m) {
                storeSet(slotKey(latest.slot), m);
                storeDel(RUN_KEY);
            }
        }
        return readRun(latest.slot);
    }

    const d = storeGet(slotKey(slot));
    const m = d ? migrateRun(d) : null;
    if (!m || !m.players || !m.players.length) return null;
    return m;
}

function hasRun(slot) {
    if (slot === undefined) return !!latestRun();
    const d = storeGet(slotKey(slot));
    return !!migrateRun(d);
}

// 一局存档的一行摘要
function describeRun(d) {
    const t = new Date(d.at || Date.now());
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const when = (t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
    const who = (d.players && d.players.length === 2) ? '双人' : '单人';
    const score = (d.players || []).reduce(function (m, p) { return Math.max(m, p.score || 0); }, 0);
    return when + ' · ' + who + ' · ' + d.cols + '×' + d.rows + ' · 最高 ' + score + ' 分';
}

function runInfo(slot) {
    const d = readRun(slot);
    return d ? describeRun(d) : '';
}

// 读档并直接开玩
function loadRun(slot) {
    const d = readRun(slot);
    if (!d) return false;
    if (typeof netRole !== 'undefined' && netRole) return false;      // 联机中不许读
    if (typeof toggleCfgPanel === 'function') toggleCfgPanel(false);
    if (typeof toggleChat === 'function') toggleChat(false);

    // 关卡配置
    if (typeof applyLevelCfg === 'function') {
        for (const k in levelCfg) if (!(k in d.cfg)) delete levelCfg[k];
        for (const k in d.cfg) levelCfg[k] = d.cfg[k];
        teamMode = levelCfg.team || d.team;
        applyLevelCfg(levelCfg, d.now);
    }

    // 场地
    mode = d.mode;
    COLS = d.cols;
    ROWS = d.rows;
    widenStartAt = 0;
    resizeCanvas();

    // 玩家
    players = d.players.map(function (s) {
        const p = makePlayer(s.i);
        p.body = s.body.map(function (c) { return cell(c[0], c[1]); });
        p.hp = s.hp.slice();
        p.dir = { x: s.dir[0], y: s.dir[1] };
        p.queue = s.queue.map(function (c) { return { x: c[0], y: c[1] }; });
        p.acc = s.acc;
        p.permMul = s.permMul || 1;
        // 没在限时加速里就按「含永久倍率」的基准算，免得读档后速度不对
        p.stepMs = (typeof playerBaseMs === 'function' && !(s.boostUntil && s.boostUntil > d.now))
            ? playerBaseMs(p) : s.stepMs;
        p.boostUntil = s.boostUntil;
        p.coins = s.coins;
        p.score = s.score;
        p.spawnAt = s.spawnAt;
        p.alive = s.alive;
        p.invUntil = s.invUntil;
        return p;
    });

    // 场上的东西
    apples = d.apples.map(function (a) { return { x: a[0], y: a[1], at: d.now }; });
    powerUps = {
        speed: (d.powerUps.speed || []).map(function (a) { return { x: a[0], y: a[1], at: d.now }; }),
        widen: (d.powerUps.widen || []).map(function (a) { return { x: a[0], y: a[1], at: d.now }; })
    };
    powerRespawnAt = { speed: d.powerRespawnAt.speed, widen: d.powerRespawnAt.widen };
    enemies = d.enemies.map(function (s) {
        return {
            kind: s.kind,
            body: s.body.map(function (c) { return cell(c[0], c[1]); }),
            hp: s.hp.slice(),
            dir: { x: s.dir[0], y: s.dir[1] },
            acc: s.acc,
            baseStepMs: s.baseStepMs,
            stepMs: s.stepMs,
            spawnAt: s.spawnAt,
            boostUntil: s.boostUntil,
            boostAt: s.boostAt,
            shootAt: s.shootAt
        };
    });
    enemyRespawns = d.enemyRespawns.slice();
    drops = d.drops.map(function (x) {
        return { x: x[0], y: x[1], kind: x[2] ? 'len' : 'coin', expireAt: x[3], at: x[4] };
    });
    turrets = d.turrets.map(function (t) {
        return { x: t[0], y: t[1], owner: players[t[2]] || players[0], cooldownUntil: t[3], upA: t[4], upB: t[5] };
    });
    bullets = d.bullets.map(function (b) {
        return { x: b[0], y: b[1], vx: b[2], vy: b[3], from: b[4] ? 'enemy' : 'player', dmg: b[5], homing: b[6] };
    });
    reviveItem = d.revive ? { x: d.revive[0], y: d.revive[1], at: d.revive[2] } : null;

    corpses = [];
    cutFx = [];

    // 房间模式：把房间状态一起接回去（否则读回来就变成「关卡说 5 间、但没有房间」）
    if (typeof rogueReset === 'function') rogueReset();
    if (d.roomRun && d.room && typeof rogueRestore === 'function') {
        roomRun = {
            i: d.roomRun.i, total: d.roomRun.total, seed: d.roomRun.seed,
            floor: d.roomRun.floor || 1,
            boss: d.roomRun.boss,
            revives: d.roomRun.revives || 0,
            done: d.roomRun.done || {}, seen: d.roomRun.seen || {}, memo: d.roomRun.memo || {}
        };
        rogueRestore(d.room);
    }

    if (d.rng && typeof rndRestore === 'function') rndRestore(d.rng[0], d.rng[1]);
    gameNow = d.now;
    nowRef = d.now;
    runStartAt = d.runStartAt;

    state = 'running';
    startPanelEl.hidden = true;
    if (typeof netPanelEl !== 'undefined' && netPanelEl) netPanelEl.hidden = true;
    syncPlayingClass();
    syncPauseBtn();
    syncHud();
    return true;
}

function clearRun(slot) {
    const s = (slot === undefined) ? currentSlot() : slot;
    storeDel(slotKey(s));
    storeDel(RUN_KEY);            // 老格式也一起清掉
    syncSaveBtns();
}

// 清除全部槽位（「删档」下拉里选「全部」时用）
function clearAllRuns() {
    for (let i = 0; i < SAVE_SLOTS; i++) storeDel(slotKey(i));
    storeDel(RUN_KEY);
    syncSaveBtns();
}

// 界面：开始页的「继续」+ 关卡修改器底部的「存档 / 读档」
function syncSaveBtns() {
    const runs = listRuns();

    // 槽位下拉框：带上每格的时间和进度，一眼看出哪格有货
    const sel = document.getElementById('saveSlotSel');
    if (sel) {
        for (let i = 0; i < runs.length; i++) {
            const opt = sel.querySelector('option[value="' + i + '"]');
            if (!opt) continue;
            const label = '槽 ' + (i + 1) + (runs[i].empty ? '（空）' : '（' + runs[i].label + '）');
            if (opt.textContent !== label) opt.textContent = label;
        }
    }

    // 开始页的「继续」：取最近的一局
    const latest = latestRun();
    const cont = document.getElementById('continueBtn');
    if (cont) {
        cont.hidden = !latest;
        if (latest) {
            const label = '💾 继续上一局（槽 ' + (latest.slot + 1) + ' · ' + latest.label + '）';
            if (cont.textContent !== label) cont.textContent = label;
        }
    }

    const save = document.getElementById('saveRunBtn');
    if (save) save.disabled = !canSaveRun();
    const load = document.getElementById('loadRunBtn');
    if (load) load.disabled = !hasRun(currentSlot());
    const del = document.getElementById('clearRunBtn');
    if (del) del.disabled = !hasRun(currentSlot());
}

function wireSave() {
    const cont = document.getElementById('continueBtn');
    if (cont) cont.addEventListener('click', function () { if (typeof tapFeedback === 'function') tapFeedback(); loadRun(); });
    const save = document.getElementById('saveRunBtn');
    if (save) save.addEventListener('click', function () {
        if (typeof tapFeedback === 'function') tapFeedback();
        if (saveRun()) { if (typeof cfgNote === 'function') cfgNote('已存档（' + runInfo() + '）'); }
        else if (typeof cfgNote === 'function') cfgNote('这一局存不了（联机中不能存档）');
        syncSaveBtns();
    });
    const load = document.getElementById('loadRunBtn');
    if (load) load.addEventListener('click', function () {
        if (typeof tapFeedback === 'function') tapFeedback();
        if (!loadRun() && typeof cfgNote === 'function') cfgNote('没有可读的存档');
    });
    const del = document.getElementById('clearRunBtn');
    if (del) del.addEventListener('click', function () {
        if (typeof tapFeedback === 'function') tapFeedback();
        const slot = currentSlot();
        clearRun(slot);
        if (typeof cfgNote === 'function') cfgNote('槽 ' + (slot + 1) + ' 的存档已删除');
    });
    const sel = document.getElementById('saveSlotSel');
    if (sel) sel.addEventListener('change', function () { syncSaveBtns(); });
    syncSaveBtns();
}

window.addEventListener('load', wireSave);
