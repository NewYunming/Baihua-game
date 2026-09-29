// 白桦大冒险 PvP 共享模拟：Deno 后端权威帧同步与浏览器本地预测共用同一份代码。
// 构建脚本（scripts/prepare-web-dist.mjs）会剥掉文件尾部的 export 行生成浏览器版
// pvp-sim.js（模块自身也会挂到 globalThis.PvpSim），因此本文件内不得使用 import。
// 物理常量与 index.html 的 CONFIG/Player 保持一致，保证手感与正式游戏相同。

const STEP_MS = 1000 / 60;
const TILE = 32;
const MAP_W = 100;
const MAP_H = 17;
const WORLD_W = MAP_W * TILE;
const GRAVITY = 0.6;
const SPEED = 5;
const JUMP = 12;
const MAX_FALL = 15;
const FIGHTER_W = 24;
const FIGHTER_H = 32;
const MAX_HP = 100;
const ROUND_TICKS = 75 * 60;
const ROUND_END_TICKS = 150;
const MAX_CATCHUP_TICKS = 120;
const MELEE_VERTICAL_TOLERANCE = 40;
const BIOME_KEYS = ['plains', 'snow', 'rain', 'nether', 'end', 'night'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 与 index.html generateMap 同构：连续地表（中央出生区平坦）+ 稀疏浮空平台。
function generateTiles(seed) {
  const rng = mulberry32(seed);
  const tiles = [];
  for (let y = 0; y < MAP_H; y++) tiles.push(new Array(MAP_W).fill(0));
  const groundLevels = [];
  let groundLevel = 12;
  const centerTile = Math.floor(MAP_W / 2);
  for (let x = 0; x < MAP_W; x++) {
    if (Math.abs(x - centerTile) <= 4) {
      groundLevel += Math.sign(12 - groundLevel);
    } else if (rng() < 0.1) {
      groundLevel += rng() < 0.5 ? 1 : -1;
    }
    groundLevel = Math.max(10, Math.min(14, groundLevel));
    groundLevels.push(groundLevel);
  }
  for (let x = 0; x < MAP_W; x++) {
    const level = groundLevels[x];
    for (let y = level; y < MAP_H; y++) tiles[y][x] = y === level ? 1 : 2;
    if (Math.abs(x - centerTile) > 5 && x > 5 && x < MAP_W - 5 && rng() < 0.05) {
      const platformY = level - 4 - Math.floor(rng() * 3);
      const length = 3 + Math.floor(rng() * 4);
      for (let px = 0; px < length && x + px < MAP_W; px++) {
        if (tiles[platformY]) tiles[platformY][x + px] = 1;
      }
    }
  }
  return tiles;
}

function solidAt(tiles, x, y) {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  return Boolean(tiles[ty] && tiles[ty][tx] > 0);
}

function groundYAt(tiles, x, height) {
  const tx = Math.max(0, Math.min(MAP_W - 1, Math.floor(x / TILE)));
  let ty = MAP_H - 1;
  while (ty >= 0 && !(tiles[ty] && tiles[ty][tx] > 0)) ty--;
  if (ty < 0) return (MAP_H - 2) * TILE - height;
  while (ty > 0 && tiles[ty - 1] && tiles[ty - 1][tx] > 0) ty--;
  return ty * TILE - height;
}

const BALANCE = {
  melee: { damage: 1, knockback: 1, knockbackFrames: 9 },
  bow: { damage: 2, knockback: 0.65, knockbackFrames: 8 },
  semi: { damage: 0.5, knockback: 0.35, knockbackFrames: 5 },
  automatic: { damage: 0.35, knockback: 0.15, knockbackFrames: 3 },
};

const ATTACKS = {
  slash: { duration: 18, cooldown: 25, activeStart: 0.2, activeEnd: 0.64 },
  thrust: { duration: 15, cooldown: 21, activeStart: 0.24, activeEnd: 0.52 },
  chop: { duration: 24, cooldown: 34, activeStart: 0.42, activeEnd: 0.64 },
  slam: { duration: 29, cooldown: 42, activeStart: 0.5, activeEnd: 0.7 },
  whip: { duration: 23, cooldown: 32, activeStart: 0.3, activeEnd: 0.7 },
};

// 从正式游戏 WEAPON_DATABASE 挑选的代表性武器，参数与主游戏一致。
const WEAPONS = [
  { name: '木剑', model: 'sword', style: 'slash', baseDamage: 20, rangeBonus: 0, knockbackBonus: 0, color: '#bed8d5' },
  { name: '猎户短矛', model: 'spear', style: 'thrust', baseDamage: 24, rangeBonus: 14, knockbackBonus: 1, color: '#b8e2a3' },
  { name: '风暴战斧', model: 'axe', style: 'chop', baseDamage: 40, rangeBonus: 12, knockbackBonus: 2, color: '#86c8ef' },
  { name: '雷神之锤', model: 'hammer', style: 'slam', baseDamage: 80, rangeBonus: 20, knockbackBonus: 8, color: '#ffe06c' },
  { name: '星火链刃', model: 'whip', style: 'whip', baseDamage: 48, rangeBonus: 24, knockbackBonus: 2, color: '#f3b078' },
  { name: '朽木短弓', model: 'bow', ranged: true, profile: 'bow', baseDamage: 30, magazine: 1, reloadFrames: 60, fireCooldown: 18, projectileSpeed: 11, projectileGravity: 0.08, color: '#b8e2a3' },
  { name: '游侠复合弓', model: 'bow', ranged: true, profile: 'bow', baseDamage: 44, magazine: 1, reloadFrames: 60, fireCooldown: 16, projectileSpeed: 13, projectileGravity: 0.06, color: '#c6d8ef' },
  { name: '铁管手枪', model: 'pistol', ranged: true, profile: 'semi', baseDamage: 17, magazine: 8, reloadFrames: 78, fireCooldown: 13, projectileSpeed: 16, color: '#cfd8dc' },
  { name: '轻型冲锋枪', model: 'rifle', ranged: true, profile: 'automatic', baseDamage: 14, magazine: 18, reloadFrames: 102, fireCooldown: 7, projectileSpeed: 17, spread: 0.045, color: '#b0bec5' },
  { name: '磁轨步枪', model: 'rifle', ranged: true, profile: 'semi', baseDamage: 58, magazine: 5, reloadFrames: 112, fireCooldown: 23, projectileSpeed: 21, color: '#bd9aef' },
];

function weaponAt(seed, round) {
  const rng = mulberry32((seed ^ Math.imul(round, 0x9E3779B9)) >>> 0);
  const data = WEAPONS[Math.floor(rng() * WEAPONS.length) % WEAPONS.length];
  const profile = data.ranged ? data.profile : 'melee';
  const balance = BALANCE[profile];
  const attack = ATTACKS[data.style || 'slash'];
  return {
    name: data.name,
    model: data.model,
    ranged: Boolean(data.ranged),
    profile,
    damage: Math.max(1, data.baseDamage * balance.damage),
    reach: 40 + (data.rangeBonus || 0) + (data.style === 'whip' ? 20 : 0),
    knockback: (8 + (data.knockbackBonus || 0)) * balance.knockback,
    knockbackFrames: balance.knockbackFrames,
    magazine: data.magazine || 0,
    reloadFrames: data.reloadFrames || 0,
    fireCooldown: data.fireCooldown || 25,
    projectileSpeed: data.projectileSpeed || 0,
    projectileGravity: data.projectileGravity || 0,
    projectileSize: data.model === 'bow' ? 3 : 4,
    spread: data.spread || 0,
    duration: attack ? attack.duration : 10,
    cooldown: attack ? attack.cooldown : data.fireCooldown || 25,
    activeStart: attack ? attack.activeStart : 0,
    activeEnd: attack ? attack.activeEnd : 0,
    color: data.color,
  };
}

function newFighter(x, y, facing, weapon) {
  return {
    x, y, vx: 0, vy: 0, kbx: 0, kbT: 0,
    hp: MAX_HP, facing, onGround: false,
    attackTimer: 0, attackDuration: 0, attackCooldown: 0,
    attackSeq: 0, attackHit: false,
    ammo: weapon.ranged ? weapon.magazine : 0,
    reloadTimer: 0, hurtTimer: 0, walkFrame: 0, walkTimer: 0,
  };
}

const zeroInput = () => ({ left: false, right: false, jump: false, attack: false, reload: false });

function spawnFighters(seed, weapon) {
  const tiles = generateTiles(seed);
  const make = (tileX, facing) => {
    const x = tileX * TILE;
    return newFighter(x, groundYAt(tiles, x + FIGHTER_W / 2, FIGHTER_H) - 2, facing, weapon);
  };
  return [make(44, 1), make(56, -1)];
}

function newMatchState(seed, biome, t) {
  const weapon = weaponAt(seed, 1);
  return {
    v: 2, status: 'active', seed, biome,
    round: 1, wins: [0, 0], tick: 0,
    roundStartTick: 0, roundEndTick: 0, winner: null,
    fighters: spawnFighters(seed, weapon),
    projectiles: [],
    inputs: [zeroInput(), zeroInput()],
    onlineAt: [t, t], lastSimAt: t,
  };
}

function wrappedDeltaX(fromX, toX) {
  let delta = toX - fromX;
  if (delta > WORLD_W / 2) delta -= WORLD_W;
  else if (delta < -WORLD_W / 2) delta += WORLD_W;
  return delta;
}

function edgeGapX(a, b) {
  const center = Math.abs(wrappedDeltaX(a.x + FIGHTER_W / 2, b.x + FIGHTER_W / 2));
  return Math.max(0, center - FIGHTER_W);
}

function edgeGapY(a, b) {
  return Math.max(0, a.y - (b.y + FIGHTER_H), b.y - (a.y + FIGHTER_H));
}

function collide(tiles, f) {
  f.onGround = false;
  const left = Math.floor(f.x / TILE);
  const right = Math.floor((f.x + FIGHTER_W) / TILE);
  const top = Math.floor(f.y / TILE);
  const bottom = Math.floor((f.y + FIGHTER_H) / TILE);
  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (tiles[ty] && tiles[ty][tx] > 0) {
        const tileX = tx * TILE;
        const tileY = ty * TILE;
        const overlaps = f.x < tileX + TILE && f.x + FIGHTER_W > tileX && f.y < tileY + TILE && f.y + FIGHTER_H > tileY;
        if (!overlaps) continue;
        if (f.vy > 0 && f.y + FIGHTER_H - f.vy <= tileY) {
          f.y = tileY - FIGHTER_H; f.vy = 0; f.onGround = true;
        } else if (f.vy < 0 && f.y - f.vy >= tileY + TILE) {
          f.y = tileY + TILE; f.vy = 0;
        } else if (f.vx > 0) {
          f.x = tileX - FIGHTER_W;
        } else if (f.vx < 0) {
          f.x = tileX + TILE;
        }
      }
    }
  }
}

function applyHit(target, damage, direction, knockback, knockbackFrames) {
  target.hp = Math.max(0, target.hp - damage);
  target.kbT = knockbackFrames;
  target.kbx = direction * knockback;
  if (target.onGround) target.vy = -4;
  target.hurtTimer = 9;
}

function startReload(f, weapon) {
  f.reloadTimer = weapon.reloadFrames;
}

function fireRanged(state, tiles, side, weapon) {
  const f = state.fighters[side];
  f.ammo--;
  f.attackCooldown = Math.max(3, weapon.fireCooldown);
  f.attackTimer = Math.min(10, weapon.fireCooldown);
  f.attackDuration = f.attackTimer;
  f.attackSeq++;
  const rng = mulberry32((state.seed ^ Math.imul(state.tick, 0x27220A95) ^ Math.imul(side + 1, 0x85EBCA6B)) >>> 0);
  const muzzleX = f.x + FIGHTER_W / 2 + f.facing * 12;
  const muzzleY = f.y + 16;
  const pellets = weapon.model === 'shotgun' ? 5 : 1;
  for (let i = 0; i < pellets; i++) {
    const centered = pellets === 1 ? 0 : i / (pellets - 1) - 0.5;
    const angle = (f.facing === 1 ? 0 : Math.PI) + centered * weapon.spread * 2 + (rng() - 0.5) * weapon.spread;
    state.projectiles.push({
      x: muzzleX, y: muzzleY,
      vx: Math.cos(angle) * weapon.projectileSpeed,
      vy: Math.sin(angle) * weapon.projectileSpeed,
      dmg: weapon.damage, o: side, g: weapon.projectileGravity,
      l: 190, sz: weapon.projectileSize, hit: false,
    });
  }
  if (f.ammo <= 0) startReload(f, weapon);
}

function stepFighter(state, tiles, side, weapon) {
  const f = state.fighters[side];
  const other = state.fighters[1 - side];
  const input = state.inputs[side] || zeroInput();

  const inputVx = (input.right ? SPEED : 0) - (input.left ? SPEED : 0);
  if (inputVx !== 0) f.facing = inputVx > 0 ? 1 : -1;
  f.vx = inputVx + (f.kbT > 0 ? f.kbx : 0);
  if (f.kbT > 0) f.kbT--;

  if (input.jump && f.onGround) { f.vy = -JUMP; f.onGround = false; }

  if (weapon.ranged) {
    if (f.ammo <= 0 && f.reloadTimer <= 0) startReload(f, weapon);
    else if (input.reload && f.ammo < weapon.magazine && f.reloadTimer <= 0) startReload(f, weapon);
  }

  if (input.attack && f.attackCooldown <= 0 && f.reloadTimer <= 0) {
    if (weapon.ranged) {
      if (f.ammo > 0) fireRanged(state, tiles, side, weapon);
    } else {
      f.attackSeq++;
      f.attackHit = false;
      f.attackDuration = weapon.duration;
      f.attackTimer = weapon.duration;
      f.attackCooldown = weapon.cooldown;
    }
  }

  if (!weapon.ranged && f.attackTimer > 0 && !f.attackHit && f.attackDuration > 0) {
    const progress = 1 - f.attackTimer / f.attackDuration;
    if (progress >= weapon.activeStart && progress <= weapon.activeEnd && other.hp > 0) {
      const dx = wrappedDeltaX(f.x + FIGHTER_W / 2, other.x + FIGHTER_W / 2);
      const inFront = Math.sign(dx || f.facing) === f.facing;
      if (inFront && edgeGapX(f, other) <= weapon.reach && edgeGapY(f, other) <= MELEE_VERTICAL_TOLERANCE) {
        f.attackHit = true;
        applyHit(other, weapon.damage, f.facing, weapon.knockback, weapon.knockbackFrames);
      }
    }
  }

  f.vy = Math.min(MAX_FALL, f.vy + GRAVITY);
  f.x += f.vx;
  f.y += f.vy;

  if (f.y > MAP_H * TILE + 200) {
    f.y = -80;
    f.vy = 6;
    f.hp = Math.max(0, f.hp - Math.max(5, Math.round(MAX_HP * 0.08)));
  }

  collide(tiles, f);

  if (f.x < 0) f.x = WORLD_W - FIGHTER_W;
  else if (f.x > WORLD_W - FIGHTER_W) f.x = 0;
  if ((f.x === WORLD_W - FIGHTER_W || f.x === 0) && solidAt(tiles, f.x + FIGHTER_W / 2, f.y + FIGHTER_H - 2)) {
    f.y = groundYAt(tiles, f.x + FIGHTER_W / 2, FIGHTER_H) - 2;
    f.vy = 0;
    f.onGround = true;
  }

  if (f.attackTimer > 0) f.attackTimer--;
  if (f.attackCooldown > 0) f.attackCooldown--;
  if (f.hurtTimer > 0) f.hurtTimer--;
  if (f.reloadTimer > 0) {
    f.reloadTimer--;
    if (f.reloadTimer <= 0) f.ammo = weapon.magazine;
  }
  if (f.vx !== 0) {
    f.walkTimer++;
    if (f.walkTimer > 8) { f.walkTimer = 0; f.walkFrame = (f.walkFrame + 1) % 4; }
  } else {
    f.walkFrame = 0;
  }
}

// 弹速最高 21px/帧，而命中窗口只有约 32px：整帧位移会让贴脸的子弹直接穿过对手，
// 所以出膛先判一次，再按不超过 PROJECTILE_SUBSTEP 的步长分段推进并逐段判定。
const PROJECTILE_SUBSTEP = 6;

function projectileHitFighter(state, p, weapon) {
  if (p.hit) return false;
  const target = state.fighters[1 - p.o];
  if (target.hp <= 0) return false;
  if (Math.abs(p.x - (target.x + FIGHTER_W / 2)) > FIGHTER_W / 2 + p.sz) return false;
  if (Math.abs(p.y - (target.y + FIGHTER_H / 2)) > FIGHTER_H / 2 + p.sz + 12) return false;
  p.hit = true;
  applyHit(target, p.dmg, Math.sign(p.vx || 1), weapon.knockback, weapon.knockbackFrames);
  return true;
}

function stepProjectiles(state, tiles, weapon) {
  const kept = [];
  for (const p of state.projectiles) {
    p.vy += p.g;
    p.l--;
    let alive = p.l > 0 && !projectileHitFighter(state, p, weapon);
    const segments = Math.max(1, Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy)) / PROJECTILE_SUBSTEP));
    for (let i = 0; i < segments && alive; i++) {
      p.x += p.vx / segments;
      p.y += p.vy / segments;
      alive = p.y > -240 && p.y < MAP_H * TILE + 200;
      // 与主游戏一致：玩家武器弹丸止于地图边界，不环形穿越。
      if (alive && (p.x < 0 || p.x >= WORLD_W)) alive = false;
      if (alive && solidAt(tiles, p.x, p.y)) alive = false;
      if (alive && projectileHitFighter(state, p, weapon)) alive = false;
    }
    if (alive) kept.push(p);
  }
  state.projectiles = kept;
}

function endRound(state, winner) {
  state.wins[winner] += 1;
  state.winner = winner;
  state.roundEndTick = state.tick;
  state.status = 'roundEnd';
}

function startNextRound(state, t) {
  state.round += 1;
  const weapon = weaponAt(state.seed, state.round);
  state.fighters = spawnFighters(state.seed, weapon);
  state.projectiles = [];
  state.inputs = [zeroInput(), zeroInput()];
  state.roundStartTick = state.tick;
  state.roundEndTick = 0;
  state.winner = null;
  state.status = 'active';
  state.lastSimAt = t;
}

// 推进 steps 个 60Hz 帧；回合/场次流转也在这里完成，调用方只需存回 state。
function stepMatch(state, steps, t = state.lastSimAt) {
  if (state.status === 'finished' || state.status === 'cancelled' || state.status === 'pending') return state;
  // 不缓存到 state：state 会整体序列化进数据库。
  const tiles = generateTiles(state.seed);
  for (let i = 0; i < steps; i++) {
    const weapon = weaponAt(state.seed, state.round);
    if (state.status === 'active') {
      stepFighter(state, tiles, 0, weapon);
      stepFighter(state, tiles, 1, weapon);
      stepProjectiles(state, tiles, weapon);
      const [a, b] = state.fighters;
      if (a.hp <= 0 || b.hp <= 0) {
        endRound(state, a.hp <= 0 && b.hp <= 0 ? (a.hp === b.hp ? 0 : (a.hp > b.hp ? 0 : 1)) : (b.hp <= 0 ? 0 : 1));
      } else if (state.tick - state.roundStartTick >= ROUND_TICKS) {
        endRound(state, a.hp >= b.hp ? 0 : 1);
      }
    } else if (state.status === 'roundEnd') {
      if (state.tick - state.roundEndTick >= ROUND_END_TICKS) {
        if (state.wins[state.winner] >= 2 || state.round >= 3) state.status = 'finished';
        else startNextRound(state, t);
      }
    }
    state.tick++;
  }
  return state;
}

function pickBiome(seed) {
  const rng = mulberry32((seed ^ 0x51ED270B) >>> 0);
  return BIOME_KEYS[Math.floor(rng() * BIOME_KEYS.length) % BIOME_KEYS.length];
}

function newPendingState(seed) {
  return { v: 2, status: 'pending', seed, biome: pickBiome(seed) };
}

const PVP = {
  STEP_MS, TILE, MAP_W, MAP_H, WORLD_W, MAX_HP, ROUND_TICKS, ROUND_END_TICKS, MAX_CATCHUP_TICKS,
  BIOME_KEYS, WEAPONS,
  mulberry32, generateTiles, groundYAt, solidAt, weaponAt, pickBiome,
  newFighter, newMatchState, newPendingState, zeroInput,
  stepMatch, stepFighter, wrappedDeltaX, edgeGapX, edgeGapY,
  FIGHTER_W, FIGHTER_H,
};
globalThis.PvpSim = PVP;

export default PVP;
export {
  STEP_MS, TILE, MAP_W, MAP_H, WORLD_W, MAX_HP, ROUND_TICKS, ROUND_END_TICKS, MAX_CATCHUP_TICKS,
  BIOME_KEYS, WEAPONS, mulberry32, generateTiles, groundYAt, solidAt, weaponAt, pickBiome,
  newFighter, newMatchState, newPendingState, zeroInput, stepMatch, stepFighter,
  wrappedDeltaX, edgeGapX, edgeGapY, FIGHTER_W, FIGHTER_H,
};
