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
assert.ok(accepted.body.arena.weapon >= 0 && accepted.body.arena.weapon < 8, '双方共用随机装备');

let guest = accepted.body;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 服务端按真实经过时间推进移动与冷却，所以这段用挂钟驱动的回合需要真实等待。
for (let i = 0; i < 400 && Math.abs(guest.arena.fighters[1].x - guest.arena.fighters[0].x) > 60; i++) {
    guest = (await call('tick', { id: matchId, left: true }, { token: second.token })).body;
    await sleep(25);
}
assert.ok(guest.arena.fighters[1].x < 815, '后退应改变坐标');
assert.ok(Math.abs(guest.arena.fighters[1].x - guest.arena.fighters[0].x) <= 70, '双方应能进入最短武器射程');
for (let i = 0; i < 600 && !guest.arena.roundEnds; i++) {
    guest = (await call('tick', { id: matchId, attack: true }, { token: second.token })).body;
    await sleep(25);
}
assert.ok(guest.arena.roundEnds, '持续攻击应结束本局');
assert.ok(guest.arena.fighters[0].hp <= 0, '被攻击方应掉血至倒');
assert.equal(guest.arena.fighters[1].hp, 100, '未出手的一方不应掉血');
assert.equal(guest.arena.winner, 1, '先手方应赢下本局');
assert.ok(guest.arena.wins[1] >= 1);
const versioned = fake.store.matches.find(row => String(row.id) === matchId);
assert.ok(Number(versioned.version) > 1, '每次写入都应递增版本号');
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
