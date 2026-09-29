import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-supabase.mjs';
import { handleArena } from '../functions/handler.mjs';

const tables = () => ({
    users: [], sessions: [], login_attempts: [], scores: [], friendships: [], matches: [],
});

const fake = createFakeSupabase(tables());

async function call(op, body, { token = '', method, headers = {}, query = {} } = {}) {
    const isWrite = body !== undefined;
    const url = isWrite
        ? 'https://baihua.test/functions/v1/app'
        : `https://baihua.test/functions/v1/app?${new URLSearchParams({ op, ...(token ? { t: token } : {}), ...query })}`;
    const request = new Request(url, {
        method: method || (isWrite ? 'POST' : 'GET'),
        headers: {
            ...(isWrite ? { 'content-type': 'application/json', origin: 'https://baihua.test' } : {}),
            ...headers,
        },
        body: isWrite ? JSON.stringify({ op, ...(token ? { token } : {}), ...body }) : undefined,
    });
    const response = await handleArena({ request, supabase: fake });
    return { status: response.status, body: await response.json() };
}

const register = async (username, password = 'baihua-test-password') => {
    const result = await call('register', { username, password });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { id: result.body.user.id, username, token: result.body.token };
};

// --- 账号 ---
const first = await register('旅人甲');
assert.ok(first.token.length === 64, '注册应返回会话令牌');
assert.ok(!fake.store.sessions[0].token_hash.includes(first.token), '令牌只存哈希');
assert.equal((await call('register', { username: first.username, password: 'baihua-test-password' })).status, 409);
assert.equal((await call('login', { username: first.username, password: 'wrong-password-xxx' })).status, 401);
const relogin = await call('login', { username: first.username, password: 'baihua-test-password' });
assert.equal(relogin.status, 200);
assert.ok(relogin.body.token, '登录返回新令牌');
assert.equal((await call('register', { username: 'ab', password: 'baihua-test-password' })).status, 400);
assert.equal((await call('login', { username: first.username, password: 'short' })).status, 400);
assert.equal((await call('register')).status, 405, '注册只接受 POST');
assert.equal((await call('no-such-op')).status, 401, '未登录时任何操作都应先要求登录');
assert.equal((await call('login', { username: first.username, password: 'baihua-test-password' },
    { headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } })).status, 403);

for (let i = 0; i < 8; i++) await call('login', { username: first.username, password: 'wrong-password-xxx' });
assert.equal((await call('login', { username: first.username, password: 'baihua-test-password' })).status, 429, '连续失败后应限流');
fake.store.login_attempts = [];

// --- 档案与在线状态 ---
const me = await call('me', {}, { token: first.token });
assert.equal(me.status, 200);
assert.equal(me.body.user.username, '旅人甲');
assert.deepEqual(me.body.scores, []);

const second = await register('旅人乙');
const secondMe = await call('me', {}, { token: second.token });
assert.equal(secondMe.status, 200);

// --- 战绩与排行榜 ---
const run = (wave, kills, durationMs, mode = 'story') => ({
    summary: { mode, cause: 'hazard', reachedWave: wave, kills, durationMs, finalWeapon: { name: '雷神之锤' } },
});
assert.equal((await call('score', run(3, 10, 5000), { token: first.token })).body.improved, true);
assert.equal((await call('score', run(1, 50, 5000), { token: first.token })).body.improved, false, '更低波次不应上榜');
const tied = await call('score', run(3, 20, 5000), { token: first.token });
assert.equal(tied.body.improved, true, '同波次更高击杀应刷新最佳');
assert.equal((await call('score', { summary: { mode: 'story', cause: 'victory', reachedWave: 9, kills: 9, durationMs: 9000 } }, { token: first.token })).status, 400);
await call('score', run(2, 5, 4000, 'endless'), { token: second.token });

const story = await call('leaderboard');
assert.equal(story.status, 200);
assert.equal(story.body.entries.length, 1, '每位玩家只出现一次');
assert.equal(story.body.entries[0].username, '旅人甲');
assert.equal(story.body.entries[0].wave, 3, '同用户只保留最佳');
assert.equal(story.body.entries[0].kills, 20, '同波次按击杀数取更高');
const endless = await call('leaderboard', undefined, { query: { mode: 'endless' } });
assert.equal(endless.body.entries.length, 1);
assert.equal(endless.body.entries[0].username, '旅人乙');

const personal = await call('me', {}, { token: first.token });
assert.equal(personal.body.scores.length, 1, '个人最佳按模式去重');
assert.equal(personal.body.scores[0].wave, 3);

// --- 好友 ---
assert.equal((await call('search', undefined, { query: { q: '旅人' } })).status, 401, '未登录不可搜索');
const searched = await call('search', undefined, { token: first.token, query: { q: '旅人乙' } });
assert.equal(searched.body.users.length, 1);
const friendIdFromSearch = searched.body.users[0].id;
assert.equal((await call('friend', { userId: friendIdFromSearch }, { token: first.token })).status, 200);
assert.equal((await call('friend', { userId: friendIdFromSearch }, { token: first.token })).status, 409, '重复申请应被拒');
const secondLinks = await call('me', {}, { token: second.token });
const pending = secondLinks.body.friends.find(link => link.status === 'pending');
assert.ok(pending, '对方应看到待处理申请');
assert.equal(pending.requesterId, first.id);
assert.equal((await call('acceptFriend', { id: pending.id }, { token: second.token })).status, 200);
assert.equal((await call('acceptFriend', { id: pending.id }, { token: second.token })).status, 404, '重复接受不应成功');
const firstLinks = await call('me', {}, { token: first.token });
assert.equal(firstLinks.body.friends.filter(link => link.status === 'accepted').length, 1);

// --- PvP ---
await call('me', {}, { token: second.token });
const friendId = firstLinks.body.friends.find(link => link.status === 'accepted').userId;
const invited = await call('challenge', { userId: friendId }, { token: first.token });
assert.equal(invited.status, 200, JSON.stringify(invited.body));
const matchId = invited.body.id;
const asHost = await call('match', { id: matchId }, { token: first.token });
assert.equal(asHost.body.side, 0);
assert.equal(asHost.body.status, 'pending');
assert.equal(asHost.body.arena.status, 'pending');
assert.equal(asHost.body.opponentId, friendId);
const stranger = await register('旅人丙');
assert.equal((await call('match', { id: matchId }, { token: stranger.token })).status, 404, '非对局参与者不可见');
const accepted = await call('acceptMatch', { id: matchId }, { token: second.token });
assert.equal(accepted.status, 200);
assert.equal(accepted.body.arena.status, 'active');
assert.equal(accepted.body.side, 1);
assert.ok(Number.isInteger(accepted.body.arena.seed), '对局应携带地图种子');
assert.ok(accepted.body.arena.biome, '对局应携带群系');
const hostView = await call('match', { id: matchId }, { token: first.token });
assert.equal(
    JSON.stringify({ ...hostView.body.arena, lastSimAt: 0 }),
    JSON.stringify({ ...accepted.body.arena, lastSimAt: 0 }),
    '双方应看到同一份权威状态');

let guest = accepted.body;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 服务端按真实经过时间补帧，所以这段要真实等待；双方都得发 tick 保活，否则掉线判负。
// 进攻方走到武器能命中的距离、且确认自己面对着对手才停手（朝向来自最后一次移动输入，
// 否则可能穿过对手背对着人空挥）；被台阶挡住才跳——一直跳会落上浮空平台，
// 那样双方垂直差超过命中容差，弹丸永远打不到人。
const STANDOFF = 44;
const VERTICAL_TOLERANCE = 40;   // 与 pvp-sim 的 MELEE_VERTICAL_TOLERANCE 一致
const verticalGap = (a, b) => Math.max(0, a.y - (b.y + 32), b.y - (a.y + 32));
const chase = (me, other, prevX, stuck) => {
    const input = { attack: true };
    const delta = other.x - me.x;
    const want = delta >= 0 ? 1 : -1;
    // 站定了却打不到人（差一层台阶、子弹从头顶掠过）就一直朝对手走，被挡住就跳，
    // 宁可贴到脸上也不要站在原地空挥。
    if (stuck || verticalGap(me, other) > VERTICAL_TOLERANCE || Math.abs(delta) > STANDOFF || me.facing !== want) {
        if (want > 0) input.right = true; else input.left = true;
        if (Math.abs(me.x - prevX) < 1) input.jump = true;
    }
    return input;
};
let prevX = guest.arena.fighters[1].x;
let lastFoeHp = guest.arena.fighters[0].hp;
let stall = 0;
let closest = Infinity;
let movedLeft = false;
let i = 0;
for (; i < 900 && guest.arena.status === 'active'; i++) {
    await call('tick', { id: matchId }, { token: first.token });
    const me = guest.arena.fighters[1];
    guest = (await call('tick', { id: matchId, ...chase(me, guest.arena.fighters[0], prevX, stall > 45) },
        { token: second.token })).body;
    prevX = me.x;
    const foeHp = guest.arena.fighters[0].hp;
    stall = foeHp < lastFoeHp ? 0 : stall + 1;
    lastFoeHp = foeHp;
    closest = Math.min(closest, Math.abs(guest.arena.fighters[1].x - guest.arena.fighters[0].x));
    if (guest.arena.fighters[1].x < 1768) movedLeft = true;
    await sleep(20);
}
if (!movedLeft || closest > 70 || !(guest.arena.roundEndTick > 0)) {
    console.log('卡住诊断', JSON.stringify({
        seed: guest.arena.seed, round: guest.arena.round, tick: guest.arena.tick,
        status: guest.arena.status, winner: guest.arena.winner, iterations: i,
        movedLeft, closest: Math.round(closest),
        fighters: guest.arena.fighters.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), hp: f.hp, facing: f.facing })),
    }));
}
assert.ok(movedLeft, '进攻方应能移动');
assert.ok(closest <= 70, '双方应能进入最短武器射程');
assert.ok(guest.arena.roundEndTick > 0, '持续攻击应结束本局');
assert.ok(guest.arena.fighters[0].hp <= 0, '被攻击方应掉血至倒');
assert.equal(guest.arena.fighters[1].hp, 100, '未出手的一方不应掉血');
assert.equal(guest.arena.winner, 1, '先手方应赢下本局');
assert.ok(guest.arena.wins[1] >= 1);
const versioned = fake.store.matches.find(row => String(row.id) === matchId);
assert.ok(Number(versioned.version) > 1, '每次写入都应递增版本号');

// v1 旧对局状态应被视作作废，客户端收到 cancelled 后自行丢弃。
fake.store.matches.push({
    id: '00000000-0000-4000-8000-000000000001', player1_id: first.id, player2_id: second.id,
    status: 'active', state: { round: 1, wins: [0, 0], fighters: [{}, {}], status: 'active' },
    version: 0, updated_at: Date.now(),
});
const legacy = await call('match', { id: '00000000-0000-4000-8000-000000000001' }, { token: first.token });
assert.equal(legacy.body.status, 'cancelled', 'v1 状态不应再进入对局');

const left = await call('leaveMatch', { id: matchId }, { token: first.token });
assert.ok(['finished', 'cancelled'].includes(left.body.status));
const finished = await call('match', { id: matchId }, { token: second.token });
assert.ok(['finished', 'cancelled'].includes(finished.body.status));
const guestMatches = await call('me', {}, { token: second.token });
assert.ok(guestMatches.body.matches.some(match => String(match.id) === matchId && match.opponentName));

// --- 退出登录 ---
assert.equal((await call('logout', {}, { token: second.token })).status, 200);
assert.equal((await call('me', {}, { token: second.token })).status, 401, '退出后会话应失效');
assert.equal((await call('me', {}, { token: 'f'.repeat(64) })).status, 401, '伪造令牌不可用');
const corrupt = await handleArena({
    request: new Request('https://baihua.test/functions/v1/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://baihua.test' },
        body: '{"op":"me"',
    }),
    supabase: fake,
});
assert.equal(corrupt.status, 401, '非法 JSON 应回落到未登录而非崩溃');
assert.equal((await call('unknown-op', {})).status, 401);

console.log('function handler 本地夹具测试: OK');
