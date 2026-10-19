// Arenas and the shielder enemy.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateRun, WEAPONS } from '../src/game/rules.js';
import { ARENAS, EYE_HEIGHT, idleInput, Sim, TICK } from '../src/game/sim.js';
import { replayRun } from '../src/game/verify.js';
import { botInput, playToDeath } from './bot.mjs';

/** A sim with the wave system parked, so tests can place enemies by hand. */
function quietSim(arena = 'citadel') {
  const sim = new Sim(1, { arena });
  sim.intermission = 1e9;
  return sim;
}

function place(sim, type, x, z, yaw = 0) {
  const e = sim.spawnEnemy(type, { x, z });
  Object.assign(e, { spawnT: 1, y: 0, yaw, hp: 1e6 });
  sim.events.length = 0;
  return e;
}

/** Fires `weapon` from (x, z) at a target point and returns the sim events. */
function shoot(sim, weapon, from, at) {
  Object.assign(sim.player, { x: from.x, z: from.z, y: 0, vx: 0, vz: 0, grounded: true });
  sim.weaponIndex = weapon;
  sim.weapons[weapon] = { ammo: 10, unlocked: true };
  sim.cooldown = 0;
  sim.heat = 0;
  const dx = at.x - from.x;
  const dz = at.z - from.z;
  sim.player.yaw = Math.atan2(-dx, -dz);
  sim.player.pitch = Math.atan2(at.y - EYE_HEIGHT, Math.hypot(dx, dz));
  sim.events.length = 0;
  sim.fire();
  return sim.events;
}

describe('shielder', () => {
  const PULSE = WEAPONS.findIndex((w) => w.id === 'pulse');
  const RAIL = WEAPONS.findIndex((w) => w.id === 'rail');

  test('the front shield blocks a normal shot', () => {
    const sim = quietSim();
    const e = place(sim, 'shielder', 0, 0, 0); // facing +Z, toward the shooter
    const events = shoot(sim, PULSE, { x: 0, z: 10 }, { x: 0, y: 1, z: 0 });
    assert.ok(events.some((ev) => ev.t === 'blocked' && ev.id === e.id));
    assert.ok(!events.some((ev) => ev.t === 'hit'));
  });

  test('the visor above the shield is still a weak spot', () => {
    const sim = quietSim();
    const e = place(sim, 'shielder', 0, 0, 0);
    const hit = shoot(sim, PULSE, { x: 0, z: 10 }, { x: 0, y: 1.95, z: 0 }).find((ev) => ev.t === 'hit');
    assert.equal(hit?.id, e.id);
    assert.equal(hit.crit, true);
  });

  test('flanking or the rail gets through', () => {
    const sim = quietSim();
    const e = place(sim, 'shielder', 0, 0, 0);
    const side = shoot(sim, PULSE, { x: 10, z: 0 }, { x: 0, y: 1, z: 0 });
    assert.ok(side.some((ev) => ev.t === 'hit' && ev.id === e.id));
    const rail = shoot(sim, RAIL, { x: 0, z: 10 }, { x: 0, y: 1, z: 0 });
    assert.ok(rail.some((ev) => ev.t === 'hit' && ev.id === e.id));
  });
});

describe('foundry arena', () => {
  test('waist-high walls stop movement but not bullets', () => {
    const sim = quietSim('foundry');
    // The low wall at x = 6 spans x 3..9, z -1..1. Stand south of it and walk north into it.
    Object.assign(sim.player, { x: 6, z: 3 });
    for (let i = 0; i < 60; i++) sim.step({ ...idleInput(0, 0), mz: 1 });
    assert.ok(sim.player.z >= 1.4, `player walked through the wall (z=${sim.player.z})`);

    const e = place(sim, 'grunt', 6, -3, Math.PI);
    const events = shoot(sim, 0, { x: 6, z: 3 }, { x: 6, y: 1.35, z: -3 });
    assert.ok(
      events.some((ev) => ev.t === 'hit' && ev.id === e.id),
      'shot should pass over the low wall',
    );
  });

  test('every block fits inside the arena and away from the player spawn', () => {
    for (const [id, arena] of Object.entries(ARENAS)) {
      const sim = new Sim(1, { arena: id });
      assert.ok(!sim.insideCollider(0, 10, 0.4), `${id}: player spawns inside cover`);
      for (const [x, z, w, d] of arena.blocks) {
        assert.ok(Math.abs(x) + w / 2 < 29 && Math.abs(z) + d / 2 < 29, `${id}: block outside the walls`);
      }
    }
  });

  test('unknown arenas are refused', () => {
    assert.throws(() => new Sim(1, { arena: 'nope' }), /Unknown arena/);
  });
});

describe('both arenas stay deterministic and validator-safe', () => {
  for (const arena of Object.keys(ARENAS)) {
    test(`${arena}: replay matches and bot runs validate`, () => {
      const { sim, inputs } = playToDeath(Sim, 2024, undefined, { arena });
      const result = replayRun(2024, inputs, arena);
      assert.ok(result.ok);
      assert.deepEqual(result.stats, sim.stats());

      for (const seed of [31, 32, 33]) {
        const run = new Sim(seed, { arena });
        for (let t = 0; t < 60 * 60 * 6 && run.wave < 9; t++) {
          run.player.hp = 100;
          run.step(botInput(run, t));
          run.events.length = 0;
          if (run.wave >= 1 && t % 600 === 0) assert.equal(validateRun(run.stats(), run.tick * TICK), null);
        }
        assert.ok(run.wave >= 6, `${arena} seed ${seed} stalled at wave ${run.wave}`);
      }
    });
  }

  test('a run replayed in the wrong arena does not verify', () => {
    const { sim, inputs } = playToDeath(Sim, 77, undefined, { arena: 'foundry' });
    const wrong = replayRun(77, inputs, 'citadel');
    assert.ok(!wrong.ok || JSON.stringify(wrong.stats) !== JSON.stringify(sim.stats()));
  });
});
