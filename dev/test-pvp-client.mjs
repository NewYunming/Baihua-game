// 双客户端对决联调：把 dist/pvp-sim.js + dist/pvp.js 装进 vm 沙箱，只桩掉 index.html
// 的绘制与全局状态，网络仍打到本地服务器（dev/serve-local.mjs）上的真实 handler。
// 这样本地预测、服务器权威回滚、回合流转和 HUD 绘制路径都被真正执行过。
// 用法：node scripts/prepare-web-dist.mjs && node dev/serve-local.mjs & node dev/test-pvp-client.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const BASE = 'http://127.0.0.1:8787';
const API = `${BASE}/functions/v1/app`;

const simSource = await readFile(new URL('../dist/pvp-sim.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../dist/pvp.js', import.meta.url), 'utf8');

const WEAPON_DATABASE = {
    COMMON: [
        { name: '木剑', model: 'sword', baseDamage: 20, rangeBonus: 0, knockbackBonus: 0 },
        { name: '猎户短矛', model: 'spear', baseDamage: 24, rangeBonus: 14, knockbackBonus: 1, attackStyle: 'thrust' },
        { name: '朽木短弓', model: 'bow', category: 'ranged', balanceProfile: 'bow', baseDamage: 30, magazine: 1, reloadFrames: 60, fireCooldown: 18, projectileSpeed: 11, projectileGravity: 0.08 },
        { name: '铁管手枪', model: 'pistol', category: 'ranged', balanceProfile: 'semi', baseDamage: 17, magazine: 8, reloadFrames: 78, fireCooldown: 13, projectileSpeed: 16 },
    ],
    RARE: [
        { name: '精铁长剑', model: 'sword', baseDamage: 35, rangeBonus: 8 },
        { name: '风暴战斧', model: 'axe', baseDamage: 40, rangeBonus: 12, knockbackBonus: 2 },
        { name: '游侠复合弓', model: 'bow', category: 'ranged', balanceProfile: 'bow', baseDamage: 44, magazine: 1, reloadFrames: 60, fireCooldown: 16, projectileSpeed: 13, projectileGravity: 0.06 },
        { name: '轻型冲锋枪', model: 'rifle', category: 'ranged', balanceProfile: 'automatic', baseDamage: 14, magazine: 18, reloadFrames: 102, fireCooldown: 7, projectileSpeed: 17, spread: 0.045 },
    ],
    EPIC: [
        { name: '星火链刃', model: 'whip', baseDamage: 48, rangeBonus: 24, knockbackBonus: 2, attackStyle: 'whip' },
        { name: '磁轨步枪', model: 'rifle', category: 'ranged', balanceProfile: 'semi', baseDamage: 58, magazine: 5, reloadFrames: 112, fireCooldown: 23, projectileSpeed: 21, pierce: 1 },
    ],
    LEGENDARY: [
        { name: '雷神之锤', model: 'hammer', baseDamage: 80, rangeBonus: 20, knockbackBonus: 8 },
    ],
};

function createClient(label) {
    const stats = { draws: 0, shots: 0, errors: [], lastResponse: null };
    const noop = () => {};
    const ctx = new Proxy({}, {
        get: (target, key) => (key in target ? target[key] : noop),
        set: (target, key, value) => { target[key] = value; return true; },
    });

    class Player {
        constructor(x, y) { this.x = x; this.y = y; this.width = 24; this.height = 32; this.reloadMax = 1; }
        draw() { stats.draws++; }
    }
    class Weapon {
        constructor(data, rarity) {
            this.name = data.name; this.model = data.model; this.rarity = rarity;
            this.isRanged = data.category === 'ranged';
            this.magazine = data.magazine || 0;
            this.reloadFrames = data.reloadFrames || 60;
        }
        getMagazineSize() { return this.magazine; }
        getReloadFrames() { return this.reloadFrames; }
    }
    class Projectile {
        constructor() { this.trail = []; }
        draw() { stats.shots++; }
    }

    const sandbox = {
        console,
        performance,
        structuredClone,
        Math, Date, JSON, Number, String, Boolean, Array, Object, Set, Map, Error, Promise,
        setInterval: (fn, ms) => setInterval(fn, ms).unref(),
        clearInterval, setTimeout,
        fetch: async (url, options) => {
            const response = await fetch(url, { ...options, headers: { origin: BASE, ...(options?.headers || {}) } });
            return response;
        },
        WEAPON_DATABASE,
        BIOMES: Object.fromEntries(['plains', 'snow', 'rain', 'nether', 'end', 'night']
            .map(key => [key, { name: key, weather: null }])),
        currentBiome: { name: 'plains', weather: null },
        tiles: [],
        MAP_WIDTH: 100,
        MAP_HEIGHT: 17,
        CONFIG: { CANVAS_WIDTH: 960, CANVAS_HEIGHT: 540, TILE_SIZE: 32 },
        camera: { x: 0, y: 0 },
        keys: {},
        mousePressed: false,
        reducedMotion: false,
        manualPaused: false,
        gameState: 'title',
        Player, Weapon, Projectile,
        spawnWeatherParticles: noop, generateClouds: noop, updateClouds: noop,
        stopMusic: noop, stopBossMusic: noop, clearInputState: noop,
        resetPauseForStateTransition: noop, syncTouchControlsVisibility: noop,
        drawSky: noop, drawBackdropDetails: noop, drawClouds: noop, drawMap: noop,
        drawWeatherParticles: noop,
        getNearestWrappedScreenX: x => x,
        resetToTitle() { sandbox.gameState = 'title'; stats.resetToTitle = (stats.resetToTitle || 0) + 1; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(simSource, context, { filename: `${label}/pvp-sim.js` });
    assert.equal(typeof sandbox.PvpSim, 'object', `${label}: pvp-sim.js 应挂到 globalThis.PvpSim`);
    vm.runInContext(clientSource, context, { filename: `${label}/pvp.js` });
    assert.equal(typeof sandbox.baihuaPvpUpdate, 'function', `${label}: pvp.js 应注册 update 钩子`);
    assert.equal(typeof sandbox.baihuaPvpRender, 'function', `${label}: pvp.js 应注册 render 钩子`);
    assert.equal(typeof sandbox.baihuaPvpEscape, 'function', `${label}: pvp.js 应注册 escape 钩子`);

    return { label, sandbox, stats, ctx };
}

async function call(token, op, body, query) {
    const response = body
        ? await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: BASE },
            body: JSON.stringify({ op, token, ...body }),
        })
        : await fetch(`${API}?${new URLSearchParams({ op, ...(token ? { t: token } : {}), ...(query || {}) })}`);
    const result = await response.json();
    if (!response.ok) throw new Error(`${op} → ${response.status} ${result.error || ''}`);
    return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = Date.now();
const register = async name => {
    const result = await call('', 'register', { username: name, password: 'baihua-test-password' });
    return { id: result.user.id, name, token: result.token };
};

const host = await register(`联调甲${stamp % 100000}`);
const guest = await register(`联调乙${stamp % 100000}`);
await call(host.token, 'friend', { userId: guest.id });
const hostView = await call(host.token, 'me', {});
const link = hostView.friends.find(item => item.userId === guest.id);
await call(guest.token, 'acceptFriend', { id: link.id });

const clientA = createClient('host');
const clientB = createClient('guest');

// 客户端只通过 baihuaSocialNet 触网，这里顺便截下最近一次响应给机器人当"看到的对手"。
function wireNet(client, token) {
    client.sandbox.baihuaSocialNet = {
        api: async (op, data) => {
            const result = await call(token, op, data);
            client.stats.lastResponse = result;
            return result;
        },
        notify: message => { client.stats.notice = message; },
        refresh: async () => {},
        isHubOpen: () => false,
    };
}
wireNet(clientA, host.token);
wireNet(clientB, guest.token);

const invited = await call(host.token, 'challenge', { userId: guest.id });
const asHost = await call(host.token, 'match', { id: invited.id });
assert.equal(asHost.status, 'pending');
assert.equal(asHost.arena.status, 'pending', '邀请阶段应只有种子和群系');

assert.equal(clientA.sandbox.baihuaPvp.start(asHost, { opponent: guest.name }), true);
assert.equal(clientA.sandbox.gameState, 'pvp', '发起方应切到 pvp 状态');
assert.equal(clientA.sandbox.baihuaPvp.isActive(), true);

const accepted = await call(guest.token, 'acceptMatch', { id: invited.id });
assert.equal(accepted.arena.status, 'active');
assert.equal(accepted.side, 1);
assert.equal(clientB.sandbox.baihuaPvp.start(accepted, { opponent: host.name }), true);
assert.equal(clientB.sandbox.gameState, 'pvp', '被邀请方应切到 pvp 状态');

// 机器人：A 原地不动（只保活），B 追近后持续出手。
// 朝向由最后一次移动输入决定（与正式游戏一致），所以要确认面对着对手再停手，否则会穿过对手
// 背对着人空挥；站定了却打不掉血（差一层台阶、子弹掠过头顶）就一直朝对手走，被挡住才跳。
const botState = new Map();
function driveBot(client, side, aggressive) {
    const view = client.stats.lastResponse?.arena;
    const keys = client.sandbox.keys;
    keys.KeyA = keys.KeyD = keys.Space = keys.KeyJ = keys.KeyR = false;
    if (!view || view.status !== 'active' || !view.fighters) return;
    if (!aggressive) return;
    const me = view.fighters[side];
    const foe = view.fighters[1 - side];
    const memory = botState.get(client) || { prevX: me.x, lastFoeHp: foe.hp, stall: 0 };
    botState.set(client, memory);
    memory.stall = foe.hp < memory.lastFoeHp ? 0 : memory.stall + 1;
    memory.lastFoeHp = foe.hp;
    const delta = foe.x - me.x;
    const want = delta >= 0 ? 1 : -1;
    const gap = Math.max(0, me.y - (foe.y + 32), foe.y - (me.y + 32));
    keys.KeyJ = true;
    if (memory.stall > 45 || gap > 40 || Math.abs(delta) > 44 || me.facing !== want) {
        if (want > 0) keys.KeyD = true; else keys.KeyA = true;
        if (Math.abs(me.x - memory.prevX) < 1) keys.Space = true;
    }
    memory.prevX = me.x;
}

const frames = 60 * 150; // 最多跑 150 秒挂钟
let finished = null;
for (let frame = 0; frame < frames; frame++) {
    driveBot(clientA, 0, false);
    driveBot(clientB, 1, true);
    for (const client of [clientA, clientB]) {
        try {
            client.sandbox.baihuaPvpUpdate();
            client.sandbox.baihuaPvpRender(client.ctx);
        } catch (error) {
            client.stats.errors.push(error);
            throw error;
        }
    }
    const latest = clientB.stats.lastResponse;
    if (latest?.status === 'finished' || latest?.arena?.status === 'finished') { finished = latest; break; }
    await sleep(16);
}

if (!finished) {
    const view = clientB.stats.lastResponse;
    console.log('超时诊断', JSON.stringify({
        status: view?.status, arenaStatus: view?.arena?.status, round: view?.arena?.round,
        wins: view?.arena?.wins, tick: view?.arena?.tick, winner: view?.arena?.winner,
        hp: view?.arena?.fighters?.map(f => [Math.round(f.x), Math.round(f.y), f.hp]),
        noticeB: clientB.stats.notice, noticeA: clientA.stats.notice,
        drawsB: clientB.stats.draws, keysB: clientB.sandbox.keys,
        weapon: view?.arena && clientB.sandbox.PvpSim.weaponAt(view.arena.seed, view.arena.round).name,
    }, null, 1));
}
assert.ok(finished, '对决应在限定时间内打完');
assert.equal(finished.arena.winner, 1, '持续出手的一方应赢下最后一局');
assert.ok(finished.arena.wins[1] >= 2, '三局两胜应记满两局');
assert.ok(finished.arena.fighters[0].hp < 100, '被动方应被打掉血');
assert.equal(finished.arena.fighters[1].hp, 100, '主动方不该掉血');

const hostFinal = await call(host.token, 'match', { id: invited.id });
assert.equal(hostFinal.status, 'finished', '发起方也应看到对局结束');
assert.deepEqual(hostFinal.arena.wins, finished.arena.wins, '双方局分必须一致');
assert.equal(hostFinal.arena.round, finished.arena.round, '双方回合数必须一致');

assert.ok(clientA.stats.draws > 0, '发起方应真的绘制过角色');
assert.ok(clientB.stats.draws > 0, '被邀请方应真的绘制过角色');
assert.ok(clientA.stats.errors.length === 0 && clientB.stats.errors.length === 0, '客户端不应报错');
assert.ok(Array.isArray(clientA.sandbox.tiles) && clientA.sandbox.tiles.length === 17, '对决地图应写进 tiles');
assert.equal(clientA.sandbox.currentBiome.name, finished.arena.biome, '群系应按种子切换');
assert.deepEqual(
    clientA.sandbox.tiles.map(row => row.join('')),
    clientB.sandbox.tiles.map(row => row.join('')),
    '双方必须由同一种子生成同一张地图');

// Esc 认输：结束后应直接退回标题界面。
await sleep(250); // 等 A 也轮询到 finished，否则 result 未落地会走"再按一次确认"分支
clientA.sandbox.baihuaPvpEscape();
assert.equal(clientA.sandbox.baihuaPvp.isActive(), false, '结束后 Esc 应退出对决');
assert.equal(clientA.sandbox.gameState, 'title', '退出后应回到标题界面');
assert.ok(clientA.stats.resetToTitle >= 1, '退出应调用 resetToTitle');

// 认输退出：连按两次 Esc 应真的落回标题界面（leave 曾经先清 active，导致 stop 直接 return）。
await call(guest.token, 'me', {}); // 对决中不会刷新在线状态，重新邀请前要先让对手"上线"
const rematch = await call(host.token, 'challenge', { userId: guest.id });
await call(guest.token, 'acceptMatch', { id: rematch.id });
const rematchHost = await call(host.token, 'match', { id: rematch.id });
assert.equal(clientA.sandbox.baihuaPvp.start(rematchHost, { opponent: guest.name }), true);
assert.equal(clientA.sandbox.gameState, 'pvp');
clientA.sandbox.baihuaPvpEscape();
await sleep(30);
clientA.sandbox.baihuaPvpEscape();
await sleep(300);
assert.equal(clientA.sandbox.baihuaPvp.isActive(), false, '认输后应结束对决');
assert.equal(clientA.sandbox.gameState, 'title', '认输后应回到标题界面');
assert.equal(clientA.stats.notice, '已认输并退出对局', '认输应给出提示');
const afterLeave = await call(guest.token, 'match', { id: rematch.id });
assert.ok(['cancelled', 'finished'].includes(afterLeave.status), `对手应看到对局作废，实际 ${afterLeave.status}`);

console.log(`双客户端对决联调: OK（${finished.arena.round} 局，局分 ${finished.arena.wins.join(':')}，武器 ${clientB.sandbox.PvpSim.weaponAt(finished.arena.seed, 1).name}）`);
process.exit(0);
