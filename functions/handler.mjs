// Ported from website/app/api/route.ts (Cloudflare D1) to the Sites PostgREST
// adapter: no FKs or SQL window functions here, so best-per-player rankings and
// the optimistic match write are resolved in application code.
import PVP from './pvp-sim.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', ...headers },
});
const now = () => Date.now();
const newId = () => crypto.randomUUID();
const hex = (buffer) => Array.from(new Uint8Array(buffer)).map((x) => x.toString(16).padStart(2, '0')).join('');
const digest = async (value) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

class ServiceUnavailable extends Error {}

function unwrap(result) {
  if (result.error) throw new ServiceUnavailable(result.error.code || 'database_request_failed');
  return result.data;
}

async function passwordHash(password, salt) {
  const encoder = new TextEncoder();
  let secret = encoder.encode(password);
  // Three chained passes keep the stored work factor above the runtime's per-call cap.
  for (let pass = 0; pass < 3; pass++) {
    const key = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits']);
    secret = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', salt: encoder.encode(`${salt}:${pass}`), iterations: 100000, hash: 'SHA-256',
    }, key, 256));
  }
  return hex(secret);
}

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return (forwarded && forwarded.split(',')[0].trim()) || request.headers.get('x-real-ip') || 'unknown';
}

function tokenOf(request, params, body) {
  const raw = String(body.token || params.get('t') || '');
  return TOKEN.test(raw) ? raw : '';
}

// Cross-origin deployments (GitHub Pages → Supabase) register their origins here;
// same-origin traffic is always allowed.
const allowedOrigins = new Set();
export function allowOrigins(...origins) {
  for (const origin of origins) if (origin) allowedOrigins.add(origin.replace(/\/+$/, ''));
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins.has(origin)) return true;
  const site = request.headers.get('sec-fetch-site');
  return site !== 'cross-site' && (!origin || origin === new URL(request.url).origin);
}

// Nested PostgREST filters: an .or() chain would widen, not narrow, this pair lookup.
function betweenPair(a, b) {
  return `and(requester_id.eq.${a},recipient_id.eq.${b}),and(requester_id.eq.${b},recipient_id.eq.${a})`;
}

function cleanName(value) { return String(value || '').trim().toLowerCase(); }

function integer(value, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0;
}

async function makeSession(db, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  unwrap(await db.from('sessions').insert({
    token_hash: await digest(token), user_id: userId, expires_at: now() + 30 * 86400000,
  }).select('token_hash'));
  return token;
}

async function currentUser(db, token) {
  if (!token) return null;
  const session = unwrap(await db.from('sessions')
    .select('user_id,expires_at').eq('token_hash', await digest(token)).maybeSingle());
  if (!session || Number(session.expires_at) <= now()) return null;
  const profile = unwrap(await db.from('users')
    .select('id,username,last_seen').eq('id', session.user_id).maybeSingle());
  if (!profile) return null;
  return { id: String(profile.id), username: profile.username, lastSeen: Number(profile.last_seen) };
}

async function tooMany(db, key, windowMs, limit) {
  const row = unwrap(await db.from('login_attempts').select('failures,window_start').eq('key', key).maybeSingle());
  return Boolean(row) && now() - Number(row.window_start) < windowMs && Number(row.failures) >= limit;
}

async function bumpAttempt(db, key, windowMs) {
  const t = now();
  const row = unwrap(await db.from('login_attempts').select('failures,window_start').eq('key', key).maybeSingle());
  const within = row && t - Number(row.window_start) < windowMs;
  unwrap(await db.from('login_attempts').upsert({
    key,
    failures: within ? Number(row.failures) + 1 : 1,
    window_start: within ? Number(row.window_start) : t,
  }, { onConflict: 'key' }).select('key'));
}

const DISCONNECT_MS = 12000;

function randSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// state v2 = 完整帧状态（见 functions/pvp-sim.mjs）。v1 的一维对决状态视为作废，
// 客户端收到 cancelled 后自行丢弃旧对局。
function saneState(value) {
  const state = typeof value === 'string' ? safeJson(value) : value;
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.v !== 2) return null;
  if (!['pending', 'active', 'roundEnd', 'finished', 'cancelled'].includes(state.status)) return null;
  if (!Number.isInteger(state.seed) || !PVP.BIOME_KEYS.includes(state.biome)) return null;
  if (state.status === 'pending' || state.status === 'cancelled') return state;
  if (!Number.isInteger(state.round) || state.round < 1 || state.round > 3) return null;
  if (!Array.isArray(state.wins) || state.wins.length !== 2
    || !state.wins.every((w) => Number.isInteger(w) && w >= 0 && w <= 2)) return null;
  if (!Number.isInteger(state.tick) || state.tick < 0) return null;
  if (!Array.isArray(state.fighters) || state.fighters.length !== 2) return null;
  for (const fighter of state.fighters) {
    if (!fighter || typeof fighter !== 'object') return null;
    if (![fighter.x, fighter.y, fighter.vx, fighter.vy, fighter.hp, fighter.facing,
      fighter.attackTimer, fighter.attackCooldown, fighter.ammo, fighter.reloadTimer]
      .every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  }
  if (!Array.isArray(state.projectiles) || state.projectiles.length > 300) return null;
  for (const projectile of state.projectiles) {
    if (!projectile || typeof projectile !== 'object') return null;
    if (![projectile.x, projectile.y, projectile.vx, projectile.vy, projectile.dmg,
      projectile.o, projectile.g, projectile.l, projectile.sz]
      .every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  }
  if (!Array.isArray(state.inputs) || state.inputs.length !== 2) return null;
  if (!Array.isArray(state.onlineAt) || state.onlineAt.length !== 2
    || !state.onlineAt.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (typeof state.lastSimAt !== 'number') return null;
  return state;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function publicMatch(row, userId) {
  const arena = saneState(row.state);
  return {
    id: String(row.id),
    opponentId: String(row.player1_id === userId ? row.player2_id : row.player1_id),
    side: row.player1_id === userId ? 0 : 1,
    status: arena ? row.status : 'cancelled',
    arena,
    serverTime: now(),
  };
}

async function arenaAction(db, row, side, action, move) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = attempt
      ? unwrap(await db.from('matches').select('*').eq('id', row.id).maybeSingle())
      : row;
    if (!latest) break;
    const stored = saneState(latest.state);
    if (!stored) break;
    const state = structuredClone(stored);
    const t = now();
    if (action === 'accept' && latest.status === 'pending' && side === 1) {
      Object.assign(state, PVP.newMatchState(state.seed, state.biome, t));
    } else if (action === 'tick' && (latest.status === 'active' || latest.status === 'roundEnd')) {
      state.inputs[side] = move;
      state.onlineAt[side] = t;
      const other = 1 - side;
      if (t - state.onlineAt[other] >= DISCONNECT_MS) {
        state.status = 'finished';
        state.wins[side] = 2;
        state.winner = side;
        state.roundEndTick = state.tick;
      } else {
        const gap = Math.max(0, Math.min(PVP.MAX_CATCHUP_TICKS * PVP.STEP_MS, t - state.lastSimAt));
        PVP.stepMatch(state, Math.floor(gap / PVP.STEP_MS), t);
        state.lastSimAt = t;
      }
    } else if (action === 'leave' && latest.status === 'pending') {
      state.status = 'cancelled';
    } else if (action === 'leave' && (latest.status === 'active' || latest.status === 'roundEnd')) {
      state.status = 'finished';
      state.wins[1 - side] = 2;
      state.winner = 1 - side;
      state.roundEndTick = state.tick;
    } else {
      return publicMatch(latest, side === 0 ? latest.player1_id : latest.player2_id);
    }
    const written = await db.from('matches')
      .update({ state, status: state.status, version: Number(latest.version) + 1, updated_at: t })
      .eq('id', latest.id).eq('version', Number(latest.version)).select('id');
    const changed = unwrap(await written);
    if (Array.isArray(changed) && changed.length === 1) {
      return publicMatch({
        ...latest, state, status: state.status, version: Number(latest.version) + 1,
      }, side === 0 ? latest.player1_id : latest.player2_id);
    }
  }
  throw Object.assign(new Error('对战状态繁忙，请重试'), { status: 409 });
}

async function handleRequest({ request, supabase: db }) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const isPost = request.method === 'POST';
  const op = isPost ? null : params.get('op');
  let body = {};
  if (isPost) {
    if (!sameOrigin(request)) return json({ error: '请求来源无效' }, 403);
    const type = request.headers.get('content-type') || '';
    const raw = await request.text();
    if (!type.includes('application/json')) return json({ error: '请求内容无效' }, 415);
    if (raw.length > 16384) return json({ error: '请求内容过大' }, 413);
    body = safeJson(raw) || {};
    if (typeof body !== 'object' || Array.isArray(body)) body = {};
  }
  const action = op || String(body.op || '');
  const token = tokenOf(request, params, body);

  if (action === 'leaderboard' && request.method === 'GET') {
    const mode = params.get('mode') === 'endless' ? 'endless' : 'story';
    const scored = unwrap(await db.from('scores')
      .select('user_id,wave,kills,duration_ms,weapon,created_at')
      .eq('source', 'death').eq('mode', mode)
      .order('wave', { ascending: false }).order('kills', { ascending: false })
      .order('created_at', { ascending: true }).limit(600));
    const best = new Map();
    for (const row of scored || []) {
      if (!best.has(row.user_id)) best.set(row.user_id, row);
    }
    const ranked = [...best.entries()]
      .sort((a, b) => Number(b[1].wave) - Number(a[1].wave)
        || Number(b[1].kills) - Number(a[1].kills)
        || Number(a[1].created_at) - Number(b[1].created_at))
      .slice(0, 20);
    const ids = ranked.map(([id]) => String(id));
    const people = ids.length
      ? unwrap(await db.from('users').select('id,username').in('id', ids)) || [] : [];
    const names = new Map(people.map((person) => [String(person.id), person.username]));
    return json({
      mode,
      entries: ranked.map(([id, row]) => ({
        username: names.get(String(id)) || '旅人',
        wave: Number(row.wave), kills: Number(row.kills),
        durationMs: Number(row.duration_ms), weapon: row.weapon, createdAt: Number(row.created_at),
      })),
    });
  }

  if (action === 'register' || action === 'login') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    const username = cleanName(body.username);
    const password = String(body.password || '');
    if (!/^[a-z0-9_\u4e00-\u9fff]{3,20}$/.test(username) || password.length < 10 || password.length > 128) {
      return json({ error: '用户名需 3–20 位汉字、字母、数字或下划线；密码至少 10 位' }, 400);
    }
    const attemptKey = await digest(`${username}:${clientIp(request)}`);
    if (await tooMany(db, attemptKey, 900000, 8)) return json({ error: '尝试过多，请 15 分钟后再试' }, 429);
    let account = unwrap(await db.from('users')
      .select('id,password_hash,password_salt').eq('username', username).maybeSingle());
    if (action === 'register') {
      if (account) return json({ error: '用户名已被使用' }, 409);
      const registrationKey = await digest(`register:${clientIp(request)}`);
      if (await tooMany(db, registrationKey, 3600000, 20)) {
        return json({ error: '注册过于频繁，请稍后再试' }, 429);
      }
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const userId = newId();
      unwrap(await db.from('users').insert({
        id: userId, username,
        password_hash: await passwordHash(password, salt),
        password_salt: salt, created_at: now(), last_seen: now(),
      }).select('id'));
      await bumpAttempt(db, registrationKey, 3600000);
      account = { id: userId };
    } else {
      if (!account || await passwordHash(password, account.password_salt) !== account.password_hash) {
        await bumpAttempt(db, attemptKey, 900000);
        return json({ error: '用户名或密码错误' }, 401);
      }
    }
    unwrap(await db.from('login_attempts').delete().eq('key', attemptKey).select('key'));
    return json({ user: { id: String(account.id), username }, token: await makeSession(db, String(account.id)) });
  }

  const user = await currentUser(db, token);
  if (!user) return json({ error: '请先登录' }, 401);

  if (action === 'logout') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    unwrap(await db.from('sessions').delete().eq('token_hash', await digest(token)).select('token_hash'));
    return json({ ok: true });
  }

  if (action === 'me') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    unwrap(await db.from('users').update({ last_seen: now() }).eq('id', user.id).select('id'));
    const mine = unwrap(await db.from('scores')
      .select('id,mode,wave,kills,duration_ms,weapon,created_at')
      .eq('user_id', user.id).eq('source', 'death')
      .order('wave', { ascending: false }).order('kills', { ascending: false })
      .order('created_at', { ascending: true }).limit(200)) || [];
    const personal = new Map();
    for (const row of mine) {
      if (!personal.has(row.mode)) personal.set(row.mode, row);
    }
    const links = unwrap(await db.from('friendships')
      .select('id,status,requester_id,recipient_id,created_at')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('created_at', { ascending: false }).limit(200)) || [];
    const otherIds = [...new Set(links.map((link) => String(
      link.requester_id === user.id ? link.recipient_id : link.requester_id,
    )))];
    const profiles = otherIds.length
      ? unwrap(await db.from('users').select('id,username,last_seen').in('id', otherIds)) || [] : [];
    const profileById = new Map(profiles.map((person) => [String(person.id), person]));
    const games = unwrap(await db.from('matches').select('*')
      .or(`player1_id.eq.${user.id},player2_id.eq.${user.id}`)
      .order('updated_at', { ascending: false }).limit(15)) || [];
    const opponentIds = [...new Set(games.map((game) => publicMatch(game, user.id).opponentId))];
    const opponents = opponentIds.length
      ? unwrap(await db.from('users').select('id,username').in('id', opponentIds)) || [] : [];
    const opponentById = new Map(opponents.map((person) => [String(person.id), person.username]));
    return json({
      user: { id: user.id, username: user.username },
      scores: [...personal.values()].map((row) => ({
        id: String(row.id), mode: row.mode, wave: Number(row.wave), kills: Number(row.kills),
        durationMs: Number(row.duration_ms), weapon: row.weapon, createdAt: Number(row.created_at),
      })).sort((a, b) => a.mode.localeCompare(b.mode)),
      friends: links.map((link) => {
        const otherId = String(link.requester_id === user.id ? link.recipient_id : link.requester_id);
        const person = profileById.get(otherId);
        return {
          id: String(link.id), status: link.status, userId: otherId,
          username: person?.username || '旅人',
          lastSeen: Number(person?.last_seen || 0),
          requesterId: String(link.requester_id),
        };
      }),
      matches: games.map((game) => ({
        ...publicMatch(game, user.id),
        opponentName: opponentById.get(publicMatch(game, user.id).opponentId) || '旅人',
      })),
      serverTime: now(),
    });
  }

  if (action === 'search' && request.method === 'GET') {
    const query = cleanName(params.get('q')).replace(/[%_]/g, '');
    if (query.length < 2) return json({ users: [] });
    const found = unwrap(await db.from('users')
      .select('id,username,last_seen').ilike('username', `${query}%`).neq('id', user.id)
      .limit(12)) || [];
    return json({
      users: found.map((person) => ({
        id: String(person.id), username: person.username, lastSeen: Number(person.last_seen),
      })),
    });
  }

  if (action === 'friend') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    const target = String(body.userId || '');
    if (!UUID.test(target) || target === user.id) return json({ error: '请选择其他玩家' }, 400);
    const existing = (unwrap(await db.from('friendships')
      .select('id,status')
      .or(betweenPair(user.id, target))
      .limit(1)) || [])[0];
    if (existing) return json({ error: '好友申请或好友关系已存在' }, 409);
    unwrap(await db.from('friendships').insert({
      id: newId(), requester_id: user.id, recipient_id: target, status: 'pending', created_at: now(),
    }).select('id'));
    return json({ ok: true });
  }

  if (action === 'acceptFriend') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    const linkId = String(body.id || '');
    if (!UUID.test(linkId)) return json({ error: '申请不可接受' }, 404);
    const changed = unwrap(await db.from('friendships')
      .update({ status: 'accepted' }).eq('id', linkId).eq('recipient_id', user.id).eq('status', 'pending')
      .select('id'));
    return changed?.length ? json({ ok: true }) : json({ error: '申请不可接受' }, 404);
  }

  if (action === 'score') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    const summary = (body.summary || {});
    const mode = summary.mode === 'endless' ? 'endless' : 'story';
    const wave = integer(summary.reachedWave, 100000);
    const kills = integer(summary.kills, 10000000);
    const duration = integer(summary.durationMs, 86400000);
    if (!summary.cause || summary.cause === 'victory' || wave < 1 || duration < 1000) {
      return json({ error: '只记录死亡后的有效战绩' }, 400);
    }
    const weapon = String(summary.finalWeapon?.name || '未知武器').slice(0, 80);
    const best = unwrap(await db.from('scores')
      .select('wave,kills').eq('user_id', user.id).eq('mode', mode).eq('source', 'death')
      .order('wave', { ascending: false }).order('kills', { ascending: false }).limit(1)) || [];
    const top = best[0];
    const improved = !top || wave > Number(top.wave) || (wave === Number(top.wave) && kills > Number(top.kills));
    if (!improved) return json({ ok: true, improved: false, id: null });
    const scoreId = newId();
    unwrap(await db.from('scores').insert({
      id: scoreId, user_id: user.id, mode, wave, kills, duration_ms: duration, weapon,
      source: 'death', created_at: now(),
    }).select('id'));
    return json({ ok: true, improved: true, id: scoreId });
  }

  if (action === 'challenge') {
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    const target = String(body.userId || '');
    if (!UUID.test(target)) return json({ error: '只能邀请好友' }, 403);
    const bond = (unwrap(await db.from('friendships').select('id')
      .eq('status', 'accepted')
      .or(betweenPair(user.id, target))
      .limit(1)) || [])[0];
    if (!bond) return json({ error: '只能邀请好友' }, 403);
    const other = unwrap(await db.from('users').select('last_seen').eq('id', target).maybeSingle());
    if (!other || now() - Number(other.last_seen) > 15000) return json({ error: '好友当前不在线' }, 409);
    const matchId = newId();
    unwrap(await db.from('matches').insert({
      id: matchId, player1_id: user.id, player2_id: target, status: 'pending',
      state: PVP.newPendingState(randSeed()), version: 0, updated_at: now(),
    }).select('id'));
    return json({ id: matchId });
  }

  if (action === 'match' || action === 'acceptMatch' || action === 'tick' || action === 'leaveMatch') {
    const matchId = String(body.id || params.get('id') || '');
    if (!UUID.test(matchId)) return json({ error: '对局不存在' }, 404);
    const row = unwrap(await db.from('matches').select('*').eq('id', matchId).maybeSingle());
    if (!row || (row.player1_id !== user.id && row.player2_id !== user.id)) {
      return json({ error: '对局不存在' }, 404);
    }
    const side = row.player1_id === user.id ? 0 : 1;
    if (action === 'match') {
      if (!isPost) return json({ error: '请求方法无效' }, 405);
      return json(publicMatch(row, user.id));
    }
    if (!isPost) return json({ error: '请求方法无效' }, 405);
    return json(await arenaAction(db, row, side,
      action === 'acceptMatch' ? 'accept' : action === 'leaveMatch' ? 'leave' : 'tick',
      {
        left: Boolean(body.left), right: Boolean(body.right), jump: Boolean(body.jump),
        attack: Boolean(body.attack), reload: Boolean(body.reload),
      }));
  }

  return json({ error: '未知操作' }, 404);
}

export async function handleArena({ request, supabase }) {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: '请求方法无效' }, 405, { allow: 'GET, POST' });
    }
    return await handleRequest({ request, supabase });
  } catch (error) {
    if (error instanceof ServiceUnavailable) return json({ error: '服务暂时不可用' }, 503);
    if (error && typeof error.message === 'string' && error.message.includes('对战')) {
      return json({ error: error.message }, error.status || 409);
    }
    return json({ error: '服务暂时不可用' }, 503);
  }
}
