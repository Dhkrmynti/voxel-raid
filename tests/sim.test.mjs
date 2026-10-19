// Simulation tests: determinism, weapon mechanics, and agreement with the score validator.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateRun, WEAPONS } from '../src/game/rules.js';
import { EYE_HEIGHT, idleInput, Sim, TICK } from '../src/game/sim.js';
import { botInput } from './bot.mjs';

function playBot(seed, { maxTicks = 60 * 60 * 6, godMode = true, untilWave = Infinity } = {}) {
  const sim = new Sim(seed);
  const inputs = [];
  for (let t = 0; t < maxTicks && !sim.over && sim.wave < untilWave; t++) {
    if (godMode) sim.player.hp = 100;
    const input = botInput(sim, t);
    inputs.push(input);
    sim.step(input);
    sim.events.length = 0;
  }
  return { sim, inputs };
}

const fingerprint = (sim) =>
  JSON.stringify({
    stats: sim.stats(),
    tick: sim.tick,
    player: sim.player,
    enemies: sim.enemies.map((e) => [e.id, e.x, e.z, e.hp]),
    pickups: sim.pickups.map((k) => [k.id, k.x, k.z]),
  });

describe('determinism', () => {
  test('same seed + same inputs → identical state', () => {
    const a = playBot(42, { maxTicks: 60 * 90, godMode: false });
    const replay = new Sim(42);
    for (const input of a.inputs) {
      replay.step(input);
      replay.events.length = 0;
    }
    assert.equal(fingerprint(replay), fingerprint(a.sim));
  });

  test('different seeds give different runs', () => {
    assert.notEqual(fingerprint(playBot(1, { maxTicks: 60 * 30 }).sim), fingerprint(playBot(2, { maxTicks: 60 * 30 }).sim));
  });
});

describe('gameplay', () => {
  test('weapons unlock on their waves', () => {
    const { sim } = playBot(7, { untilWave: 6 });
    assert.equal(sim.wave, 6);
    assert.deepEqual(sim.weapons.map((w) => w.unlocked), WEAPONS.map((w) => w.unlockWave <= 6));
  });

  test('a head shot crits and the rail pierces every enemy in line', () => {
    const sim = new Sim(1);
    sim.intermission = 999; // keep the wave system out of the way
    const a = sim.spawnEnemy('grunt', { x: 0, z: 0 });
    const b = sim.spawnEnemy('grunt', { x: 0, z: -3 });
    for (const e of [a, b]) {
      e.spawnT = 1;
      e.y = 0;
      e.yaw = 0;
      e.hp = 1000;
    }
    sim.events.length = 0;

    // From z=10 looking straight down -Z at head height of the grunts.
    const fire = (weapon) => {
      sim.weaponIndex = weapon;
      sim.weapons[weapon] = { ammo: 10, unlocked: true };
      sim.cooldown = 0;
      sim.heat = 0;
      sim.player.vx = sim.player.vz = 0;
      sim.player.x = 0;
      sim.player.z = 10;
      sim.player.yaw = 0;
      sim.player.pitch = Math.atan2(1.35 - EYE_HEIGHT, 10);
      sim.fire();
      return sim.events.filter((e) => e.t === 'hit');
    };

    const pulseHits = fire(0);
    assert.equal(pulseHits.length, 1);
    assert.equal(pulseHits[0].id, a.id);
    assert.equal(pulseHits[0].crit, true);
    assert.equal(pulseHits[0].dmg, WEAPONS[0].dmg * 2);

    sim.events.length = 0;
    const railHits = fire(2);
    assert.deepEqual(railHits.map((h) => h.id).sort(), [a.id, b.id].sort());
  });

  test('exploders blow up near the player and their blast can kill other enemies', () => {
    const sim = new Sim(3);
    sim.intermission = 999;
    const boom = sim.spawnEnemy('exploder', { x: 0, z: 8 });
    const victim = sim.spawnEnemy('runner', { x: 1.5, z: 8 });
    for (const e of [boom, victim]) {
      e.spawnT = 1;
      e.y = 0;
    }
    victim.hp = 1;
    for (let i = 0; i < 120 && !boom.dead; i++) sim.step(idleInput());
    assert.ok(boom.dead);
    assert.equal(sim.detonations, 1);
    assert.equal(sim.kills, 1); // the runner caught in the blast
    assert.ok(sim.player.hp < 100);
  });
});

describe('validator agrees with the game', () => {
  for (const seed of [11, 22, 33]) {
    test(`a real bot run (seed ${seed}) passes validateRun`, () => {
      const { sim } = playBot(seed, { untilWave: 12 });
      assert.ok(sim.wave >= 6, `bot only reached wave ${sim.wave}`);
      // Validate at an arbitrary point mid-run, as if the player died right now.
      assert.equal(validateRun(sim.stats(), sim.tick * TICK), null);
    });
  }

  test('a boss wave with minions and enrage still validates', () => {
    const { sim } = playBot(5, { untilWave: 7 });
    assert.ok(sim.wave >= 6);
    assert.equal(validateRun(sim.stats(), sim.tick * TICK), null);
  });
});
