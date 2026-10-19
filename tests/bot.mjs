// Shared test bot for the simulation: aims at heads, fires, grabs coins, dashes, upgrades weapons.
import { EYE_HEIGHT, idleInput } from '../src/game/sim.js';

// Head height per enemy type (model space), so the bot lands crits on every kind of enemy.
const AIM_Y = { grunt: 1.35, runner: 0.65, shooter: 1.6, exploder: 0.75, shielder: 1.95, boss: 1.5 };

/** A simple aimbot: faces the nearest enemy's head, fires, grabs coins, switches to the best weapon. */
export function botInput(sim, tick) {
  const p = sim.player;
  const target = sim.enemies
    .filter((e) => !e.dead && e.spawnT >= 1)
    .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  const input = idleInput(p.yaw, p.pitch);
  if (target) {
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const headY = target.y + AIM_Y[target.type] * target.scale;
    input.yaw = Math.round(Math.atan2(-dx, -dz) * 1e4) / 1e4;
    input.pitch = Math.round(Math.atan2(headY - (p.y + EYE_HEIGHT), Math.hypot(dx, dz)) * 1e4) / 1e4;
    input.fire = true;
  }
  const coin = sim.pickups.find((k) => k.kind === 'token');
  if (coin) input.mz = 1;
  if (tick % 90 === 0) input.dash = true;
  const best = sim.weapons
    .map((w, i) => (w.unlocked ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  if (best !== sim.weaponIndex && tick % 30 === 0) input.weapon = best;
  return input;
}

/** Plays a bot run on `Sim` until the player dies; returns the inputs and the final sim. */
export function playToDeath(Sim, seed, maxTicks = 60 * 60 * 30, options = {}) {
  const sim = new Sim(seed, options);
  const inputs = [];
  for (let t = 0; t < maxTicks && !sim.over; t++) {
    const input = botInput(sim, t);
    inputs.push(input);
    sim.step(input);
    sim.events.length = 0;
  }
  return { sim, inputs };
}
