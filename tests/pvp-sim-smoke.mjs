import assert from 'node:assert/strict';
import SIM from '../functions/pvp-sim.mjs';

const tiles = SIM.generateTiles(12345);
assert.equal(tiles.length, SIM.MAP_H);
assert.deepEqual(SIM.generateTiles(12345), tiles, '同种子地图必须一致');
assert.notDeepEqual(SIM.generateTiles(12346), tiles, '不同种子地图应不同');
for (let x = 0; x < SIM.MAP_W; x++) assert.ok(tiles[SIM.MAP_H - 1][x] > 0, '底行必须实心');

function run(seed, script, steps) {
  const state = SIM.newMatchState(seed, SIM.pickBiome(seed), 0);
  const seen = { projectiles: 0, hpDrop: false };
  for (let i = 0; i < steps; i++) {
    state.inputs = script(i, state);
    SIM.stepMatch(state, 1, i * SIM.STEP_MS);
    seen.projectiles = Math.max(seen.projectiles, state.projectiles.length);
    if (state.fighters[0].hp < 100 || state.fighters[1].hp < 100) seen.hpDrop = true;
  }
  return { state, seen };
}

const meleeScript = (i, state) => {
  const [a, b] = state.fighters;
  const approach = (me, target) => {
    const d = SIM.wrappedDeltaX(me.x, target.x);
    const moving = Math.abs(d) > 8;
    return { left: d < -8, right: d > 8, jump: moving, attack: Math.abs(d) < 60, reload: false };
  };
  return [approach(a, b), approach(b, a)];
};

const first = run(777, meleeScript, 60 * 120);
const second = run(777, meleeScript, 60 * 120);
assert.equal(JSON.stringify(first.state.fighters), JSON.stringify(second.state.fighters), '模拟必须确定性');
assert.equal(JSON.stringify(first.state.projectiles), JSON.stringify(second.state.projectiles));
assert.ok(first.seen.hpDrop, '近战脚本应造成掉血');
assert.ok(first.state.wins[0] + first.state.wins[1] >= 1 || first.state.status !== 'active', '两分钟内应分出至少一局');

let rangedOk = false;
for (let seed = 1; seed < 40 && !rangedOk; seed++) {
  const weapon = SIM.weaponAt(seed, 1);
  if (!weapon.ranged) continue;
  const hold = () => [
    { left: false, right: true, jump: false, attack: true, reload: true },
    { left: true, right: false, jump: false, attack: true, reload: true },
  ];
  const result = run(seed, hold, 60 * 20);
  if (result.seen.projectiles > 0) rangedOk = true;
}
assert.ok(rangedOk, '远程武器应产生弹道');

const pending = SIM.newPendingState(42);
assert.equal(pending.status, 'pending');
const activated = SIM.newMatchState(pending.seed, pending.biome, 1000);
SIM.stepMatch(activated, 60, 2000);
assert.equal(activated.tick, 60);
assert.equal(activated.status, 'active');

console.log('pvp-sim smoke OK');
