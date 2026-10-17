// 聊天框指令（控制台风格）
//   /cheats 1  开作弊模式，之后才能用作弊指令；/cheats 0 关掉
//   同步局里只有主机能用（别人的本地状态和主机不同步，加了会乱）
let svCheats = false;

// 三个「基础开关」属于关卡设置（levelCfg.safeWall / safeSnake / safeBullet），
// 不属于 god。god 只是一键把它们一起打开/关掉。
function godFlags() {
    return [levelCfg.safeWall === true, levelCfg.safeSnake === true, levelCfg.safeBullet === true];
}

function godAllOn() {
    const f = godFlags();
    return f[0] && f[1] && f[2];
}

function setGodAll(on) {
    levelCfg.safeWall = on;
    levelCfg.safeSnake = on;
    levelCfg.safeBullet = on;
    return on;
}

const CMD_ALIAS = {
    'sv_cheats': 'cheats',
    'ch': 'cheats',
    'h': 'help',
    '?': 'help'
};

const CMD_LIST = [
    ['/help', '列出所有指令'],
    ['/cheats 1|0', '开 / 关作弊模式（别的作弊指令都要先开）'],
    ['/god', '一键打开三个基础开关：撞墙不死、撞蛇穿过、子弹不掉血'],
    ['/give speed|widen|team', '在地上放一个道具'],
    ['/len <节数>', '设置身长'],
    ['/hp <点数>', '设置每节血量'],
    ['/speed <毫秒>', '设置每步间隔（越小越快）'],
    ['/clear', '清空当前房间的敌人'],
    ['/room <序号>', '跳到本层某一间（从 1 开始）'],
    ['/boss', '直接传送到本层的 BOSS 房（调试用）'],
    ['/rooms', '查看本层房间'],
    ['/kill', '自杀']
];

function cmdSay(text) {
    if (typeof chatPush === 'function') chatPush('系统', text, false);
    return true;
}

function cmdHelp() {
    cmdSay('可用指令：');
    for (let i = 0; i < CMD_LIST.length; i++) cmdSay(CMD_LIST[i][0] + '  —  ' + CMD_LIST[i][1]);
    return true;
}

// 返回 true 表示这条输入被当成指令处理了（不再当聊天发出去）
function cmdRun(raw) {
    const line = String(raw || '').trim();
    if (line.charAt(0) !== '/') return false;

    const parts = line.slice(1).split(/\s+/);
    let name = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    name = CMD_ALIAS[name] || name;

    if (!name) return false;
    if (name === 'help') return cmdHelp();

    // 同步局里只允许主机用
    if (typeof netRole !== 'undefined' && netRole === 'guest') {
        return cmdSay('同步局里不能用作弊指令（只有主机能改）。');
    }

    if (name === 'cheats') {
        const on = (arg === '1' || arg === 'on' || arg === 'true');
        svCheats = on;
        if (!on) setGodAll(false);
        return cmdSay(on ? '作弊模式已开启。' : '作弊模式已关闭。');
    }

    if (!svCheats) return cmdSay('作弊模式没开：先输入 /cheats 1');

    if (name === 'god') {
        const arg2 = (arg || '').toLowerCase();
        const on = (arg2 === '1' || arg2 === 'on' || arg2 === 'true') ? true
            : (arg2 === '0' || arg2 === 'off' || arg2 === 'false') ? false
                : !godAllOn();
        setGodAll(on);
        return cmdSay(on ? '无敌：开（三个基础开关全开）' : '无敌：关');
    }

    if (name === 'give') {
        const kinds = (typeof POWER_KINDS !== 'undefined') ? POWER_KINDS : [];
        if (kinds.indexOf(arg) < 0) return cmdSay('用法：/give ' + kinds.join('|'));
        spawnPowerUp(arg);
        return cmdSay('放置了『' + arg + '』道具（如果没出现，可能是同屏上限或场地满了）。');
    }

    if (name === 'len') {
        const n = Math.round(Number(arg));
        if (!(n >= 2 && n <= 80)) return cmdSay('用法：/len 2~80');
        const p = players[0];
        while (p.body.length < n) {
            const t = p.body[p.body.length - 1];
            p.body.push({ x: t.x - (p.dir.x || 0), y: t.y - (p.dir.y || 0) });
            p.hp.push(levelCfg.hp0);
        }
        while (p.body.length > n) { p.body.pop(); p.hp.pop(); }
        syncHud();
        return cmdSay('身长 = ' + n);
    }

    if (name === 'hp') {
        const n = Math.round(Number(arg));
        if (!(n >= 1 && n <= 9)) return cmdSay('用法：/hp 1~9');
        for (let i = 0; i < players[0].hp.length; i++) players[0].hp[i] = n;
        syncHud();
        return cmdSay('每节血量 = ' + n);
    }

    if (name === 'speed') {
        const n = Math.round(Number(arg));
        if (!(n >= 35 && n <= 1200)) return cmdSay('用法：/speed 35~1200（毫秒）');
        levelCfg.stepMs = n;
        for (let i = 0; i < players.length; i++) {
            if (players[i].boostUntil) setStepMs(players[i], n * SPEED_FACTOR);
            else setStepMs(players[i], n);
        }
        return cmdSay('每步间隔 = ' + n + 'ms');
    }

    if (name === 'clear') {
        const had = enemies.length;
        enemies = [];
        if (typeof updateRooms === 'function') updateRooms(gameNow);
        return cmdSay('清掉了 ' + had + ' 个敌人。');
    }

    if (name === 'room') {
        if (typeof rogueOn !== 'function' || !rogueOn() || !roomRun) return cmdSay('现在不是房间模式。');
        const idx = Math.round(Number(arg)) - 1;
        if (!(idx >= 0 && idx < roomRun.total)) return cmdSay('用法：/room 1~' + roomRun.total);
        rogueEnter(idx, 'e');
        return cmdSay('进入第 ' + (idx + 1) + ' 间。');
    }

    if (name === 'boss') {
        if (typeof rogueOn !== 'function' || !rogueOn() || !roomRun) return cmdSay('现在不是房间模式。');
        const idx = (roomRun.boss === undefined || roomRun.boss === null) ? -1 : roomRun.boss;
        if (idx < 0 || idx >= roomRun.total) return cmdSay('这一层没有标出 BOSS 房。');
        rogueEnter(idx, 'e');
        return cmdSay('传送到 BOSS 房（第 ' + (idx + 1) + ' 间，共 ' + roomRun.total + ' 间）。');
    }

    if (name === 'rooms') {
        if (typeof rogueOn !== 'function' || !rogueOn() || !roomRun) return cmdSay('现在不是房间模式。');
        const rooms = roomRun.rooms || [];
        const out = [];
        for (let i = 0; i < rooms.length; i++) {
            const r = rooms[i];
            out.push((i + 1) + (roomRun.done[i] ? '✔' : '·') + '(' + r.gx + ',' + r.gy + ')');
        }
        return cmdSay('本层：' + out.join(' '));
    }

    if (name === 'kill') {
        players[0].alive = false;
        if (typeof killPlayer === 'function') killPlayer(players[0], gameNow);
        return cmdSay('已自杀。');
    }

    return cmdSay('没有这个指令：/' + name + '（/help 看列表）');
}
