import { env } from "cloudflare:workers";

export const runtime = "edge";
const now = () => Date.now();
const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
const db = () => { if (!env.DB) throw new Error("数据库不可用"); return env.DB; };
const id = () => crypto.randomUUID();
const hex = (a: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(a)).map(x => x.toString(16).padStart(2, "0")).join("");
const digest = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function passwordHash(password: string, salt: string) {
  const encoder = new TextEncoder();
  let secret = encoder.encode(password);
  // The production runtime caps each PBKDF2 call at 100,000 iterations.
  for (let pass = 0; pass < 3; pass++) {
    const key = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
    secret = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", salt: encoder.encode(`${salt}:${pass}`), iterations: 100000, hash: "SHA-256"
    }, key, 256));
  }
  return hex(secret);
}
function cookie(request: Request) { return request.headers.get("cookie")?.match(/(?:^|;\s*)baihua_session=([^;]+)/)?.[1] || ""; }
async function currentUser(request: Request) {
  const token = cookie(request); if (!token) return null;
  return db().prepare("SELECT u.id,u.username,u.last_seen AS lastSeen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(await digest(token), now()).first<{id:string;username:string;lastSeen:number}>();
}
async function makeSession(userId: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db().prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(await digest(token), userId, now() + 30*86400000).run();
  return `baihua_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`;
}
function sameOrigin(request: Request) { const origin = request.headers.get("origin"), site=request.headers.get("sec-fetch-site"); return site!=="cross-site" && (!origin || origin===new URL(request.url).origin); }
function cleanName(s: unknown) { return String(s || "").trim().toLowerCase(); }
function integer(v: unknown, max: number) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0; }
const WEAPONS = [
  { name:"木剑", damage:14, reach:74, cooldown:550, color:"#bed8d5" },
  { name:"猎户短矛", damage:12, reach:108, cooldown:620, color:"#b8e2a3" },
  { name:"精铁长剑", damage:16, reach:82, cooldown:600, color:"#c6d8ef" },
  { name:"风暴战斧", damage:21, reach:70, cooldown:820, color:"#86c8ef" },
  { name:"暗影裂刃", damage:18, reach:88, cooldown:630, color:"#bd9aef" },
  { name:"星火链刃", damage:13, reach:116, cooldown:730, color:"#f3b078" },
  { name:"雷神之锤", damage:24, reach:76, cooldown:880, color:"#ffe06c" },
  { name:"天穹贯日枪", damage:17, reach:120, cooldown:730, color:"#80e4ea" },
];
const TALENTS = [
  { name:"锋锐校准", damage:4, speed:0, guard:0 },
  { name:"轻盈步法", damage:0, speed:0.8, guard:0 },
  { name:"坚韧护甲", damage:0, speed:0, guard:3 },
  { name:"迅捷出手", damage:2, speed:0.35, guard:0 },
];
type Fighter = { x:number; hp:number; lastAt:number; lastAttack:number; onlineAt:number };
type Arena = { round:number; wins:[number,number]; fighters:[Fighter,Fighter]; weapon:number; talent:number; roundStarted:number; roundEnds:number; winner:number|null; status:"pending"|"active"|"finished"|"cancelled" };
function newRound(round: number, wins: [number,number], t = now()): Arena {
  const base = (): Fighter => ({ x:0, hp:100, lastAt:t, lastAttack:0, onlineAt:t });
  return { round, wins, fighters:[{...base(),x:145},{...base(),x:815}], weapon:crypto.getRandomValues(new Uint32Array(1))[0]%WEAPONS.length, talent:crypto.getRandomValues(new Uint32Array(1))[0]%TALENTS.length, roundStarted:t, roundEnds:0, winner:null, status:"active" };
}
async function friendOf(a:string,b:string) {
  return !!await db().prepare("SELECT id FROM friendships WHERE status='accepted' AND ((requester_id=? AND recipient_id=?) OR (requester_id=? AND recipient_id=?))").bind(a,b,b,a).first();
}
async function matchFor(userId:string, matchId:string) {
  return db().prepare("SELECT * FROM matches WHERE id=? AND (player1_id=? OR player2_id=?)").bind(matchId,userId,userId).first<{id:string;player1_id:string;player2_id:string;status:string;state:string;version:number;updated_at:number}>();
}
function publicMatch(row: {id:string;player1_id:string;player2_id:string;status:string;state:string}, userId:string) {
  return { id:row.id, opponentId:row.player1_id===userId?row.player2_id:row.player1_id, side:row.player1_id===userId?0:1, status:row.status, arena:JSON.parse(row.state) as Arena };
}
function step(arena:Arena, side:0|1, input:{left?:boolean;right?:boolean;attack?:boolean}, t:number) {
  if (arena.status!=="active" || arena.roundEnds) return;
  const me=arena.fighters[side], other=arena.fighters[1-side];
  const dt=Math.max(0,Math.min(250,t-me.lastAt)); me.lastAt=t; me.onlineAt=t;
  const talent=TALENTS[arena.talent], weapon=WEAPONS[arena.weapon];
  const direction=(input.right?1:0)-(input.left?1:0);
  me.x=Math.max(28,Math.min(932,me.x+direction*(0.18+talent.speed*0.045)*dt));
  if (input.attack && t-me.lastAttack >= weapon.cooldown && Math.abs(me.x-other.x)<=weapon.reach) {
    me.lastAttack=t; other.hp=Math.max(0,other.hp-Math.max(1,weapon.damage+talent.damage-TALENTS[arena.talent].guard));
  }
  const timeout=t-arena.roundStarted>=90000;
  const disconnected=t-other.onlineAt>=12000;
  if (other.hp<=0 || me.hp<=0 || timeout || disconnected) {
    const victor=other.hp<=0 || disconnected ? side : me.hp<=0 ? (1-side) as 0|1 : (me.hp>=other.hp?side:(1-side) as 0|1);
    arena.wins[victor]++; arena.winner=victor; arena.roundEnds=t;
    if (arena.wins[victor]>=2 || arena.round>=3) arena.status="finished";
  }
}
async function arenaAction(row:NonNullable<Awaited<ReturnType<typeof matchFor>>>, side:0|1, action:string, input:{left?:boolean;right?:boolean;attack?:boolean}) {
  for (let i=0;i<5;i++) {
    const latest=i?await db().prepare("SELECT * FROM matches WHERE id=?").bind(row.id).first<typeof row>():row;
    if (!latest) break;
    let arena=JSON.parse(latest.state) as Arena; const t=now();
    if (action==="accept" && latest.status==="pending" && side===1) arena=newRound(1,[0,0],t);
    else if (action==="tick" && latest.status==="active") {
      if (arena.roundEnds && arena.status!=="finished" && t-arena.roundEnds>=2500) arena=newRound(arena.round+1,arena.wins,t);
      else step(arena,side,input,t);
    }
    else if (action==="leave" && latest.status==="pending") arena.status="cancelled";
    else if (action==="leave" && latest.status==="active") {
      arena.wins[1-side]=2; arena.winner=1-side; arena.roundEnds=t; arena.status="finished";
    }
    else return publicMatch(latest,side===0?latest.player1_id:latest.player2_id);
    const result=await db().prepare("UPDATE matches SET state=?, status=?, version=version+1, updated_at=? WHERE id=? AND version=?").bind(JSON.stringify(arena),arena.status,t,row.id,latest.version).run();
    if (result.meta.changes===1) return publicMatch({...latest,state:JSON.stringify(arena),status:arena.status},side===0?latest.player1_id:latest.player2_id);
  }
  throw new Error("对战状态繁忙，请重试");
}
async function handle(request:Request) {
  const url=new URL(request.url), op=request.method==="GET"?url.searchParams.get("op"):null;
  if (request.method==="POST" && !sameOrigin(request)) return json({error:"请求来源无效"},403);
  const body=request.method==="POST" && request.headers.get("content-type")?.includes("application/json") ? await request.json() as Record<string,unknown> : {};
  const action=op||String(body.op||"");
  if (action==="leaderboard" && request.method==="GET") {
    const mode=url.searchParams.get("mode")==="endless"?"endless":"story";
    const rows=await db().prepare(`SELECT username,wave,kills,durationMs,weapon,createdAt FROM (
      SELECT u.username,s.wave,s.kills,s.duration_ms AS durationMs,s.weapon,s.created_at AS createdAt,
      ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.wave DESC,s.kills DESC,s.created_at ASC) AS bestRank
      FROM scores s JOIN users u ON u.id=s.user_id WHERE s.source='death' AND s.mode=?
    ) WHERE bestRank=1 ORDER BY wave DESC,kills DESC,createdAt ASC LIMIT 20`).bind(mode).all();
    return json({mode,entries:rows.results});
  }
  if (action==="register" || action==="login") {
    if (request.method!=="POST") return json({error:"请求方法无效"},405);
    const username=cleanName(body.username), password=String(body.password||"");
    if (!/^[a-z0-9_\u4e00-\u9fff]{3,20}$/.test(username) || password.length<10 || password.length>128) return json({error:"用户名需 3–20 位汉字、字母、数字或下划线；密码至少 10 位"},400);
    const attemptKey=await digest(`${username}:${request.headers.get("cf-connecting-ip")||"unknown"}`);
    const attempts=await db().prepare("SELECT failures,window_start AS windowStart FROM login_attempts WHERE key=?").bind(attemptKey).first<{failures:number;windowStart:number}>();
    if (attempts && now()-attempts.windowStart<900000 && attempts.failures>=8) return json({error:"尝试过多，请 15 分钟后再试"},429);
    let user=await db().prepare("SELECT id,password_hash AS passwordHash,password_salt AS passwordSalt FROM users WHERE username=?").bind(username).first<{id:string;passwordHash:string;passwordSalt:string}>();
    if (action==="register") {
      if (user) return json({error:"用户名已被使用"},409);
      const registrationKey=await digest(`register:${request.headers.get("cf-connecting-ip")||"unknown"}`);
      const registrations=await db().prepare("SELECT failures,window_start AS windowStart FROM login_attempts WHERE key=?").bind(registrationKey).first<{failures:number;windowStart:number}>();
      if (registrations && now()-registrations.windowStart<3600000 && registrations.failures>=20) return json({error:"注册过于频繁，请稍后再试"},429);
      const salt=hex(crypto.getRandomValues(new Uint8Array(16))), userId=id();
      await db().prepare("INSERT INTO users(id,username,password_hash,password_salt,created_at,last_seen) VALUES(?,?,?,?,?,?)").bind(userId,username,await passwordHash(password,salt),salt,now(),now()).run();
      await db().prepare("INSERT INTO login_attempts(key,failures,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN ?-window_start>3600000 THEN 1 ELSE failures+1 END,window_start=CASE WHEN ?-window_start>3600000 THEN ? ELSE window_start END").bind(registrationKey,now(),now(),now(),now()).run();
      user={id:userId,passwordHash:"",passwordSalt:salt};
    } else if (!user || await passwordHash(password,user.passwordSalt)!==user.passwordHash) {
      await db().prepare("INSERT INTO login_attempts(key,failures,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN ?-window_start>900000 THEN 1 ELSE failures+1 END, window_start=CASE WHEN ?-window_start>900000 THEN ? ELSE window_start END").bind(attemptKey,now(),now(),now(),now()).run();
      return json({error:"用户名或密码错误"},401);
    }
    await db().prepare("DELETE FROM login_attempts WHERE key=?").bind(attemptKey).run();
    return json({user:{id:user.id,username}},200,{"Set-Cookie":await makeSession(user.id)});
  }
  const user=await currentUser(request);
  if (!user) return json({error:"请先登录"},401);
  if (action==="logout") {
    await db().prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(cookie(request))).run();
    return json({ok:true},200,{"Set-Cookie":"baihua_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"});
  }
  if (action==="me") {
    await db().prepare("UPDATE users SET last_seen=? WHERE id=?").bind(now(),user.id).run();
    const scores=await db().prepare(`SELECT id,mode,wave,kills,durationMs,weapon,createdAt FROM (
      SELECT id,mode,wave,kills,duration_ms AS durationMs,weapon,created_at AS createdAt,
      ROW_NUMBER() OVER (PARTITION BY mode ORDER BY wave DESC,kills DESC,created_at ASC) AS bestRank
      FROM scores WHERE user_id=? AND source='death'
    ) WHERE bestRank=1 ORDER BY mode`).bind(user.id).all();
    const friends=await db().prepare("SELECT f.id,f.status,u.id AS userId,u.username,u.last_seen AS lastSeen,f.requester_id AS requesterId FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.recipient_id ELSE f.requester_id END WHERE f.requester_id=? OR f.recipient_id=? ORDER BY f.created_at DESC").bind(user.id,user.id,user.id).all();
    const matches=await db().prepare("SELECT m.*,u.username AS opponentName FROM matches m JOIN users u ON u.id=CASE WHEN m.player1_id=? THEN m.player2_id ELSE m.player1_id END WHERE m.player1_id=? OR m.player2_id=? ORDER BY m.updated_at DESC LIMIT 15").bind(user.id,user.id,user.id).all();
    return json({user,scores:scores.results,friends:friends.results,matches:matches.results.map((m:any)=>({...publicMatch(m,user.id),opponentName:m.opponentName})),serverTime:now()});
  }
  if (action==="search") {
    const q=cleanName(url.searchParams.get("q")); if (q.length<2) return json({users:[]});
    const users=await db().prepare("SELECT id,username,last_seen AS lastSeen FROM users WHERE username LIKE ? AND id<>? LIMIT 12").bind(`${q}%`,user.id).all(); return json({users:users.results});
  }
  if (action==="friend") {
    const target=String(body.userId||""); if (!target || target===user.id) return json({error:"请选择其他玩家"},400);
    const existing=await db().prepare("SELECT id,status FROM friendships WHERE (requester_id=? AND recipient_id=?) OR (requester_id=? AND recipient_id=?)").bind(user.id,target,target,user.id).first();
    if (existing) return json({error:"好友申请或好友关系已存在"},409);
    await db().prepare("INSERT INTO friendships(id,requester_id,recipient_id,status,created_at) VALUES(?,?,?,'pending',?)").bind(id(),user.id,target,now()).run(); return json({ok:true});
  }
  if (action==="acceptFriend") {
    const result=await db().prepare("UPDATE friendships SET status='accepted' WHERE id=? AND recipient_id=? AND status='pending'").bind(body.id,user.id).run();
    return result.meta.changes?json({ok:true}):json({error:"申请不可接受"},404);
  }
  if (action==="score") {
    const s=(body.summary||{}) as Record<string,unknown>;
    const mode=s.mode==="endless"?"endless":"story", wave=integer(s.reachedWave,100000), kills=integer(s.kills,10000000), duration=integer(s.durationMs,86400000);
    if (!s.cause || s.cause==="victory" || wave<1 || duration<1000) return json({error:"只记录死亡后的有效战绩"},400);
    const scoreId=id(), weapon=String((s.finalWeapon as Record<string,unknown>|undefined)?.name||"未知武器").slice(0,80);
    const result=await db().prepare(`INSERT INTO scores(id,user_id,mode,wave,kills,duration_ms,weapon,source,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM scores WHERE user_id=? AND mode=? AND source='death'
        AND (wave>? OR (wave=? AND kills>=?))
      )`).bind(scoreId,user.id,mode,wave,kills,duration,weapon,"death",now(),user.id,mode,wave,wave,kills).run();
    return json({ok:true,improved:result.meta.changes===1,id:result.meta.changes===1?scoreId:null});
  }
  if (action==="challenge") {
    const target=String(body.userId||""); if (!await friendOf(user.id,target)) return json({error:"只能邀请好友"},403);
    const other=await db().prepare("SELECT last_seen FROM users WHERE id=?").bind(target).first<{last_seen:number}>();
    if (!other || now()-other.last_seen>15000) return json({error:"好友当前不在线"},409);
    const matchId=id(), state={...newRound(1,[0,0]),status:"pending"};
    await db().prepare("INSERT INTO matches(id,player1_id,player2_id,status,state,version,updated_at) VALUES(?,?,?,'pending',?,0,?)").bind(matchId,user.id,target,JSON.stringify(state),now()).run(); return json({id:matchId});
  }
  if (action==="match" || action==="acceptMatch" || action==="tick" || action==="leaveMatch") {
    const row=await matchFor(user.id,String(body.id||url.searchParams.get("id")||"")); if (!row) return json({error:"对局不存在"},404);
    const side=(row.player1_id===user.id?0:1) as 0|1;
    if (action==="match") return json(publicMatch(row,user.id));
    return json(await arenaAction(row,side,action==="acceptMatch"?"accept":action==="leaveMatch"?"leave":"tick",body as {left?:boolean;right?:boolean;attack?:boolean}));
  }
  return json({error:"未知操作"},404);
}
export async function GET(request:Request) { try { return await handle(request); } catch(e) { console.error(e); return json({error:"服务暂时不可用"},500); } }
export async function POST(request:Request) { try { return await handle(request); } catch(e) { console.error(e); return json({error:"服务暂时不可用"},500); } }
