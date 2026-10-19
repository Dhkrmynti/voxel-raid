// Deterministic game simulation: fixed 60 Hz steps, seeded RNG, analytic hitboxes.
// No three.js scene and no DOM — the same code can replay a recorded run on the server.
// The view (Game.js) feeds it one input per tick and turns the emitted events into effects.
import {
  BOSS_MINIONS,
  BOSS_TOKEN_DROPS,
  CRIT_MULT,
  ENEMY_TYPES,
  FIRST_INTERMISSION,
  POWERUP_SCORE_MULT,
  POWERUPS,
  TOKEN_SCORE,
  WAVE_BONUS,
  WAVE_INTERMISSION,
  WEAPONS,
  isBossWave,
  multiplierFor,
  spawnInterval,
  waveRoster,
} from './rules.js';
import { datan2, dcos, dexp, dhypot, dsin } from './dmath.js';

export { SIM_VERSION } from './version.js';

export const TICK = 1 / 60;
export const ARENA = 30; // half-size of the square arena
export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.4;
export const MAX_HP = 100;
export const MAX_SHIELD = POWERUPS.shield.amount;
export const DASH_COOLDOWN = 1.1;
const DASH_SPEED = 24;
const DASH_TIME = 0.16;
const HURT_IFRAMES = 0.12; // brief immunity after a hit so bursts can't stack in one instant
const WALK_SPEED = 8;
const MAX_PITCH = 1.45;
const MAX_ALIVE = 18;
const SWAP_TIME = 0.25;
const RAY_RANGE = 120;
const EXPLOSION_RADIUS = 3.5;
const EXPLOSION_ENEMY_DMG = 60;
const BOSS_SCALE = 2.6;

// [x, z, height] — each pillar has a 2x2 footprint
export const PILLARS = [
  [-12, -12, 4],
  [12, -12, 4],
  [-12, 12, 4],
  [12, 12, 4],
  [0, -19, 3],
  [0, 19, 3],
  [-19, 0, 3],
  [19, 0, 3],
  [-6, 5, 2],
  [6, -5, 2],
];

// Hitboxes in model space (before scale), model facing +Z. `crit` marks the weak spot.
const HITBOXES = {
  grunt: [
    { min: [-0.55, 0, -0.45], max: [0.55, 1.1, 0.45] },
    { min: [-0.55, 1.1, -0.45], max: [0.55, 1.63, 0.48], crit: true },
  ],
  runner: [
    { min: [-0.4, 0, -0.5], max: [0.4, 0.85, 0.5] },
    { min: [-0.4, 0.45, 0.3], max: [0.4, 0.85, 0.54], crit: true },
  ],
  shooter: [
    { min: [-0.45, 0, -0.35], max: [0.45, 1.35, 0.35] },
    { min: [-0.45, 1.35, -0.35], max: [0.45, 1.85, 0.42], crit: true },
  ],
  exploder: [
    { min: [-0.45, 0, -0.45], max: [0.45, 1.08, 0.45] },
    { min: [-0.12, 1.08, -0.12], max: [0.12, 1.4, 0.12], crit: true },
  ],
  boss: [
    { min: [-0.65, 0, -0.5], max: [0.65, 1.15, 0.5] },
    { min: [-0.65, 1.15, -0.5], max: [0.65, 1.95, 0.55], crit: true },
  ],
};

const STREAKS = { 3: 'TRIPLE KILL', 5: 'RAMPAGE', 8: 'UNSTOPPABLE', 12: 'GODLIKE', 20: 'VOXEL LEGEND' };
const POWERUP_KINDS = ['rapid', 'double', 'shield'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpAngle = (a, b, t) => {
  const d = ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slab test; returns the entry distance along the ray, or Infinity. */
function rayBox(o, d, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < min[i] || o[i] > max[i]) return Infinity;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

/** An empty input: no movement, no buttons. */
export const idleInput = (yaw = 0, pitch = 0) => ({
  mx: 0,
  mz: 0,
  yaw,
  pitch,
  fire: false,
  jump: false,
  dash: false,
  reload: false,
  weapon: -1,
});

export class Sim {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.nextId = 1;
    this.events = [];
    this.colliders = PILLARS.map(([x, z, h]) => ({ minX: x - 1, maxX: x + 1, minZ: z - 1, maxZ: z + 1, h }));

    this.player = {
      x: 0,
      z: 10,
      y: 0,
      vx: 0,
      vz: 0,
      vy: 0,
      grounded: true,
      yaw: 0,
      pitch: 0,
      hp: MAX_HP,
      shield: 0,
      dashT: 0,
      dashCd: 0,
      dashX: 0,
      dashZ: 0,
      iframes: 0,
    };
    this.weapons = WEAPONS.map((w) => ({ ammo: w.mag, unlocked: w.unlockWave <= 1 }));
    this.weaponIndex = 0;
    this.cooldown = 0;
    this.reloading = 0;
    this.heat = 0;
    this.power = { rapid: 0, double: 0 };

    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.boss = null;

    this.tick = 0;
    this.time = 0;
    this.score = 0;
    this.tokens = 0;
    this.kills = 0;
    this.detonations = 0;
    this.streak = 0;
    this.streakT = 0;
    this.wave = 0;
    this.intermission = FIRST_INTERMISSION;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.spawnInterval = 1;
    this.over = false;
  }

  emit(e) {
    this.events.push(e);
  }

  get weapon() {
    return WEAPONS[this.weaponIndex];
  }

  multiplier() {
    return multiplierFor(this.streak);
  }

  stats() {
    return {
      score: Math.round(this.score),
      wave: this.wave,
      kills: this.kills,
      tokens: this.tokens,
      detonations: this.detonations,
    };
  }

  // ---------- step ----------

  step(input) {
    if (this.over) return;
    this.tick++;
    this.time += TICK;
    this.streakT += TICK;
    if (this.streakT > 3) this.streak = 0;
    this.power.rapid = Math.max(0, this.power.rapid - TICK);
    this.power.double = Math.max(0, this.power.double - TICK);

    this.updatePlayer(input);
    this.updateWeapon(input);
    this.updateWaves();
    this.updateEnemies();
    this.updateProjectiles();
    this.updatePickups();
  }

  // ---------- player ----------

  updatePlayer(input) {
    const p = this.player;
    const dt = TICK;
    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -MAX_PITCH, MAX_PITCH);

    const sin = dsin(p.yaw);
    const cos = dcos(p.yaw);
    let mx = -sin * input.mz + cos * input.mx;
    let mz = -cos * input.mz - sin * input.mx;
    const len = dhypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }

    p.dashCd = Math.max(0, p.dashCd - dt);
    p.iframes = Math.max(0, p.iframes - dt);
    if (input.dash && p.dashCd <= 0) {
      p.dashX = len > 0 ? mx : -sin;
      p.dashZ = len > 0 ? mz : -cos;
      p.dashT = DASH_TIME;
      p.dashCd = DASH_COOLDOWN;
      this.emit({ t: 'dash' });
    }
    if (p.dashT > 0) {
      p.dashT -= dt;
      p.vx = p.dashX * DASH_SPEED;
      p.vz = p.dashZ * DASH_SPEED;
    } else {
      const a = 1 - dexp(-14 * dt);
      p.vx += (mx * WALK_SPEED - p.vx) * a;
      p.vz += (mz * WALK_SPEED - p.vz) * a;
    }
    p.x += p.vx * dt;
    p.z += p.vz * dt;

    if (input.jump && p.grounded) {
      p.vy = 7.5;
      p.grounded = false;
    }
    p.vy -= 22 * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
    }
    this.collide(p, PLAYER_RADIUS);
  }

  /** Circle-vs-AABB push-out against arena bounds and pillars (XZ plane only). */
  collide(pos, r) {
    const lim = ARENA - 1 - r;
    pos.x = clamp(pos.x, -lim, lim);
    pos.z = clamp(pos.z, -lim, lim);
    for (const b of this.colliders) {
      const cx = clamp(pos.x, b.minX, b.maxX);
      const cz = clamp(pos.z, b.minZ, b.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * r;
        pos.z = cz + (dz / d) * r;
      } else {
        const left = pos.x - b.minX;
        const right = b.maxX - pos.x;
        const top = pos.z - b.minZ;
        const bottom = b.maxZ - pos.z;
        const m = Math.min(left, right, top, bottom);
        if (m === left) pos.x = b.minX - r;
        else if (m === right) pos.x = b.maxX + r;
        else if (m === top) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
      }
    }
  }

  insideCollider(x, z, r) {
    return this.colliders.some((b) => x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r);
  }

  damagePlayer(dmg) {
    const p = this.player;
    if (this.over || p.dashT > 0 || p.iframes > 0) return;
    p.iframes = HURT_IFRAMES;
    const absorbed = Math.min(p.shield, dmg);
    p.shield -= absorbed;
    p.hp -= dmg - absorbed;
    this.emit({ t: 'hurt', dmg, shielded: absorbed > 0 });
    if (p.hp <= 0) {
      p.hp = 0;
      this.over = true;
      this.emit({ t: 'gameOver' });
    }
  }

  // ---------- weapons ----------

  updateWeapon(input) {
    const dt = TICK;
    if (
      input.weapon >= 0 &&
      input.weapon < WEAPONS.length &&
      input.weapon !== this.weaponIndex &&
      this.weapons[input.weapon].unlocked
    ) {
      this.weaponIndex = input.weapon;
      this.reloading = 0;
      this.cooldown = Math.max(this.cooldown, SWAP_TIME);
      this.emit({ t: 'switch', weapon: this.weaponIndex });
    }
    this.cooldown -= dt;
    this.heat = Math.max(0, this.heat - dt * 3);
    const state = this.weapons[this.weaponIndex];
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        state.ammo = this.weapon.mag;
      }
    }
    if (input.reload) this.reload();
    if (input.fire && this.cooldown <= 0 && this.reloading <= 0) {
      if (state.ammo > 0) this.fire();
      else this.reload();
    }
  }

  reload() {
    const state = this.weapons[this.weaponIndex];
    if (this.reloading > 0 || state.ammo === this.weapon.mag) return;
    this.reloading = this.weapon.reload;
    this.emit({ t: 'reload', weapon: this.weaponIndex });
  }

  fire() {
    const def = this.weapon;
    const p = this.player;
    this.weapons[this.weaponIndex].ammo--;
    this.cooldown = def.interval * (this.power.rapid > 0 ? 0.5 : 1);
    this.heat = Math.min(1, this.heat + 0.18);

    const cy = dcos(p.yaw);
    const sy = dsin(p.yaw);
    const cp = dcos(p.pitch);
    const sp = dsin(p.pitch);
    const fwd = [-sy * cp, sp, -cy * cp];
    const right = [cy, 0, -sy];
    const up = [sy * sp, cp, cy * sp]; // right × fwd
    const moving = dhypot(p.vx, p.vz) > 1 || !p.grounded;
    const spread = def.id === 'pulse' ? def.spread + (moving ? 0.02 : 0) + this.heat * 0.025 : def.spread;
    const origin = [p.x, p.y + EYE_HEIGHT, p.z];

    const ends = [];
    for (let i = 0; i < def.pellets; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * spread;
      const ox = dcos(a) * r;
      const oy = dsin(a) * r;
      const d = [fwd[0] + right[0] * ox + up[0] * oy, fwd[1] + up[1] * oy, fwd[2] + right[2] * ox + up[2] * oy];
      const l = dhypot(d[0], d[1], d[2]);
      ends.push(this.trace(origin, [d[0] / l, d[1] / l, d[2] / l], def));
    }
    this.emit({ t: 'shot', weapon: this.weaponIndex, ends });
  }

  /** Fires one ray; applies damage and returns where it visibly ended. */
  trace(o, d, def) {
    const wallT = this.rayWorld(o, d);
    const hits = [];
    for (const e of this.enemies) {
      if (e.dead) continue;
      const h = this.rayEnemy(e, o, d);
      if (h.t < wallT) hits.push({ e, ...h });
    }
    hits.sort((a, b) => a.t - b.t || a.e.id - b.e.id);
    const struck = def.pierce ? hits : hits.slice(0, 1);
    for (const h of struck) {
      let dmg = def.dmg;
      if (def.falloff) dmg *= Math.max(0.4, 1 - h.t / def.falloff);
      if (h.crit) dmg *= CRIT_MULT;
      const point = { x: o[0] + d[0] * h.t, y: o[1] + d[1] * h.t, z: o[2] + d[2] * h.t };
      this.damageEnemy(h.e, Math.round(dmg), point, h.crit);
    }
    const endT = !def.pierce && struck.length ? struck[0].t : wallT;
    const end = { x: o[0] + d[0] * endT, y: o[1] + d[1] * endT, z: o[2] + d[2] * endT };
    if (endT === wallT && wallT < RAY_RANGE) this.emit({ t: 'impact', ...end });
    return end;
  }

  rayWorld(o, d) {
    let t = RAY_RANGE;
    if (d[1] < 0) t = Math.min(t, -o[1] / d[1]);
    for (const b of this.colliders) t = Math.min(t, rayBox(o, d, [b.minX, 0, b.minZ], [b.maxX, b.h, b.maxZ]));
    // Arena walls: the inner faces of the 3-high perimeter.
    const lim = ARENA - 1;
    const tx = d[0] > 0 ? (lim - o[0]) / d[0] : d[0] < 0 ? (-lim - o[0]) / d[0] : Infinity;
    const tz = d[2] > 0 ? (lim - o[2]) / d[2] : d[2] < 0 ? (-lim - o[2]) / d[2] : Infinity;
    const tw = Math.min(tx, tz);
    if (o[1] + d[1] * tw < 3) t = Math.min(t, tw);
    return t;
  }

  rayEnemy(e, o, d) {
    const s = e.scale;
    const c = dcos(e.yaw);
    const n = dsin(e.yaw);
    const px = o[0] - e.x;
    const py = o[1] - e.y;
    const pz = o[2] - e.z;
    // World → model space: rotate by -yaw around Y, then undo the scale.
    const lo = [(px * c - pz * n) / s, py / s, (px * n + pz * c) / s];
    const ld = [(d[0] * c - d[2] * n) / s, d[1] / s, (d[0] * n + d[2] * c) / s];
    let best = Infinity;
    let crit = false;
    for (const box of HITBOXES[e.type]) {
      const t = rayBox(lo, ld, box.min, box.max);
      if (t < best) {
        best = t;
        crit = !!box.crit;
      }
    }
    return { t: best, crit };
  }

  // ---------- waves ----------

  updateWaves() {
    const dt = TICK;
    if (this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) this.startWave(this.wave + 1);
      return;
    }
    if (this.spawnQueue.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemies.length < MAX_ALIVE) {
        this.spawnEnemy(this.spawnQueue.shift());
        this.spawnTimer = this.spawnInterval;
      }
    } else if (this.enemies.length === 0) {
      const bonus = this.wave * WAVE_BONUS;
      this.score += bonus;
      this.player.hp = Math.min(MAX_HP, this.player.hp + 15);
      this.intermission = WAVE_INTERMISSION;
      this.emit({ t: 'waveClear', wave: this.wave, bonus });
    }
  }

  startWave(n) {
    this.wave = n;
    this.spawnQueue = waveRoster(n, this.rng);
    this.spawnTimer = 0.5;
    this.spawnInterval = spawnInterval(n);
    this.emit({ t: 'wave', wave: n, boss: isBossWave(n), count: this.spawnQueue.length });
    WEAPONS.forEach((w, i) => {
      if (w.unlockWave === n && !this.weapons[i].unlocked) {
        this.weapons[i] = { ammo: w.mag, unlocked: true };
        this.emit({ t: 'unlock', weapon: i });
      }
    });
  }

  // ---------- enemies ----------

  spawnEnemy(type, at = null) {
    const def = ENEMY_TYPES[type];
    const scale = type === 'boss' ? BOSS_SCALE : 1;
    const p = this.player;
    let x = at?.x ?? 0;
    let z = at?.z ?? 0;
    if (!at) {
      const edge = ARENA - 3;
      for (let i = 0; i < 30; i++) {
        const side = Math.floor(this.rng() * 4);
        const t = (this.rng() * 2 - 1) * (ARENA - 4);
        [x, z] = side === 0 ? [t, -edge] : side === 1 ? [t, edge] : side === 2 ? [-edge, t] : [edge, t];
        if (dhypot(x - p.x, z - p.z) > 15 && !this.insideCollider(x, z, def.radius)) break;
      }
    }
    const hp = def.hp * (1 + (this.wave - 1) * 0.12);
    const e = {
      id: this.nextId++,
      type,
      def,
      scale,
      x,
      z,
      y: -2 * scale,
      yaw: datan2(p.x - x, p.z - z),
      hp,
      maxHp: hp,
      radius: def.radius,
      speedMul: 1 + Math.min(0.4, this.wave * 0.02),
      attackCd: 0,
      attackAnim: 0,
      shootCd: 1 + this.rng() * 1.5,
      phase: 0,
      fuse: 0,
      enraged: false,
      spawnT: 0,
      strafeDir: this.rng() < 0.5 ? -1 : 1,
      strafeT: 2,
      stuckT: 0,
      sideT: 0,
      sideDir: 1,
      kx: 0,
      kz: 0,
      walk: this.rng() * 6,
      dead: false,
    };
    this.enemies.push(e);
    if (type === 'boss') this.boss = e;
    this.emit({ t: 'spawn', enemy: e });
    return e;
  }

  updateEnemies() {
    const dt = TICK;
    const p = this.player;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.spawnT < 1) {
        e.spawnT = Math.min(1, e.spawnT + dt * 1.6);
        e.y = (e.spawnT - 1) * 2.2 * e.scale;
        continue;
      }
      e.y = 0;

      const dx = p.x - e.x;
      const dz = p.z - e.z;
      const dist = dhypot(dx, dz) || 0.001;
      const nx = dx / dist;
      const nz = dz / dist;
      let mx = nx;
      let mz = nz;

      if (e.type === 'exploder') {
        if (e.fuse > 0) {
          e.fuse -= dt;
          if (e.fuse <= 0) {
            this.detonate(e);
            continue;
          }
        } else if (dist < 2.2) {
          e.fuse = 0.8;
          this.emit({ t: 'fuse', id: e.id });
        }
      }

      e.strafeT -= dt;
      if (e.strafeT <= 0) {
        e.strafeDir *= -1;
        e.strafeT = 2 + this.rng() * 2;
      }
      if (e.type === 'shooter') {
        if (dist < 8) {
          mx = -nx;
          mz = -nz;
        } else if (dist < 15) {
          mx = -nz * e.strafeDir;
          mz = nx * e.strafeDir;
        }
      }
      if (e.sideT > 0) {
        e.sideT -= dt;
        mx += -nz * e.sideDir * 1.5;
        mz += nx * e.sideDir * 1.5;
        const l = dhypot(mx, mz) || 1;
        mx /= l;
        mz /= l;
      }
      for (const o of this.enemies) {
        if (o === e || o.dead) continue;
        const ox = e.x - o.x;
        const oz = e.z - o.z;
        const d = dhypot(ox, oz);
        const min = e.radius + o.radius;
        if (d < min && d > 0.0001) {
          const push = (min - d) / min;
          mx += (ox / d) * push * 2;
          mz += (oz / d) * push * 2;
        }
      }

      const fuseSlow = e.fuse > 0 ? 0.35 : 1;
      const speed = e.def.speed * e.speedMul * (e.attackAnim > 0 ? 0.3 : 1) * fuseSlow;
      const stopDist = e.radius + PLAYER_RADIUS + 0.2;
      const moveScale = e.type !== 'shooter' && dist < stopDist ? 0 : 1;
      const prevX = e.x;
      const prevZ = e.z;
      e.x += (mx * speed * moveScale + e.kx) * dt;
      e.z += (mz * speed * moveScale + e.kz) * dt;
      const kd = dexp(-8 * dt);
      e.kx *= kd;
      e.kz *= kd;
      this.collide(e, e.radius);

      const moved = dhypot(e.x - prevX, e.z - prevZ);
      if (moveScale > 0 && moved < speed * dt * 0.35) {
        e.stuckT += dt;
        if (e.stuckT > 0.25 && e.sideT <= 0) {
          e.sideT = 0.9;
          e.sideDir = this.rng() < 0.5 ? -1 : 1;
          e.stuckT = 0;
        }
      } else e.stuckT = 0;

      e.yaw = lerpAngle(e.yaw, datan2(dx, dz), 1 - dexp(-10 * dt));
      e.walk += dt * speed * 2.2;
      e.attackAnim = Math.max(0, e.attackAnim - dt * 3);

      e.attackCd -= dt;
      if (e.type !== 'exploder' && dist < stopDist + 0.35 && e.attackCd <= 0 && p.y < 1.2 * e.scale) {
        this.damagePlayer(e.def.dmg);
        e.attackCd = e.type === 'runner' ? 0.7 : 1.1;
        e.attackAnim = 1;
      }

      if (e.def.ranged) {
        e.shootCd -= dt;
        if (e.shootCd <= 0 && dist < 30) this.enemyShoot(e, nx, nz);
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  enemyShoot(e, nx, nz) {
    const p = this.player;
    const origin = { x: e.x + nx * e.radius, y: 1.2 * e.scale, z: e.z + nz * e.radius };
    const tx = p.x - origin.x;
    const ty = p.y + EYE_HEIGHT * 0.7 - origin.y;
    const tz = p.z - origin.z;
    const tl = dhypot(tx, ty, tz) || 1;
    const aim = [tx / tl, ty / tl, tz / tl];
    if (e.type === 'shooter') {
      this.spawnProjectile(
        origin,
        aim.map((v) => v * 13),
        e.def.dmg,
      );
      e.shootCd = 1.4 + this.rng();
    } else {
      const cadence = e.enraged ? 0.7 : 1;
      e.phase = (e.phase + 1) % 3;
      if (e.phase === 0) {
        const off = this.rng() * Math.PI;
        const n = e.enraged ? 20 : 14;
        for (let i = 0; i < n; i++) {
          const a = off + (i / n) * Math.PI * 2;
          const ring = { x: e.x + dcos(a) * e.radius, y: 1.2, z: e.z + dsin(a) * e.radius };
          this.spawnProjectile(ring, [dcos(a) * 9, 0, dsin(a) * 9], 10);
        }
        e.shootCd = 1.6 * cadence;
      } else {
        for (const a of [-0.15, 0, 0.15]) {
          // Rotate the aim around Y by `a`.
          const c = dcos(a);
          const s = dsin(a);
          this.spawnProjectile(origin, [(aim[0] * c + aim[2] * s) * 15, aim[1] * 15, (-aim[0] * s + aim[2] * c) * 15], 10);
        }
        e.shootCd = 1.0 * cadence;
      }
    }
    this.emit({ t: 'enemyShot', x: origin.x, y: origin.y, z: origin.z });
  }

  damageEnemy(e, dmg, point, crit = false) {
    if (e.dead) return;
    e.hp -= dmg;
    this.emit({ t: 'hit', id: e.id, dmg, crit, x: point.x, y: point.y, z: point.z });
    if (e.type !== 'boss') {
      const dx = e.x - this.player.x;
      const dz = e.z - this.player.z;
      const d = dhypot(dx, dz) || 1;
      e.kx += (dx / d) * 3;
      e.kz += (dz / d) * 3;
    }
    if (e.type === 'boss' && !e.enraged && e.hp > 0 && e.hp < e.maxHp / 2) this.enrage(e);
    if (e.hp <= 0) this.killEnemy(e);
  }

  enrage(boss) {
    boss.enraged = true;
    boss.speedMul *= 1.4;
    this.emit({ t: 'enrage', id: boss.id });
    for (let i = 0; i < BOSS_MINIONS; i++) {
      const a = (i / BOSS_MINIONS) * Math.PI * 2;
      const at = { x: boss.x + dcos(a) * 3.5, z: boss.z + dsin(a) * 3.5 };
      this.collide(at, 0.5);
      this.spawnEnemy('runner', at);
    }
  }

  killEnemy(e) {
    e.dead = true;
    const isBoss = e.type === 'boss';
    this.kills++;
    this.streak++;
    this.streakT = 0;
    const gained = e.def.score * this.multiplier() * (this.power.double > 0 ? POWERUP_SCORE_MULT : 1);
    this.score += gained;
    this.emit({ t: 'kill', id: e.id, type: e.type, x: e.x, y: e.y + e.scale, z: e.z, score: gained });
    if (STREAKS[this.streak]) this.emit({ t: 'streak', name: STREAKS[this.streak], streak: this.streak });

    const at = { x: e.x, y: e.y + e.scale, z: e.z };
    if (isBoss) {
      for (let i = 0; i < BOSS_TOKEN_DROPS; i++) this.dropPickup('token', at);
      for (let i = 0; i < 2; i++) this.dropPickup('health', at);
      this.dropPickup(POWERUP_KINDS[Math.floor(this.rng() * POWERUP_KINDS.length)], at);
      this.boss = null;
    } else {
      const r = this.rng();
      if (r < 0.5) this.dropPickup('token', at);
      else if (r < 0.6) this.dropPickup('health', at);
      else if (r < 0.67) this.dropPickup(POWERUP_KINDS[Math.floor(this.rng() * POWERUP_KINDS.length)], at);
    }
    if (e.type === 'exploder') this.explode(e);
  }

  /** An exploder that reached the player blows up on its own — not a kill. */
  detonate(e) {
    e.dead = true;
    this.detonations++;
    this.emit({ t: 'detonate', id: e.id });
    this.explode(e);
  }

  explode(e) {
    this.emit({ t: 'explode', x: e.x, y: 0.6, z: e.z, r: EXPLOSION_RADIUS });
    const p = this.player;
    const pd = dhypot(p.x - e.x, p.z - e.z);
    if (pd < EXPLOSION_RADIUS) this.damagePlayer(Math.round(e.def.dmg * (1 - (pd / EXPLOSION_RADIUS) * 0.5)));
    // Chain reactions: the blast hurts other enemies, and those kills count for the player.
    for (const o of this.enemies) {
      if (o.dead || o === e) continue;
      const d = dhypot(o.x - e.x, o.z - e.z);
      if (d < EXPLOSION_RADIUS + o.radius) {
        this.damageEnemy(o, Math.round(EXPLOSION_ENEMY_DMG * (1 - (d / (EXPLOSION_RADIUS + o.radius)) * 0.5)), {
          x: o.x,
          y: 1,
          z: o.z,
        });
      }
    }
  }

  // ---------- projectiles ----------

  spawnProjectile(pos, vel, dmg) {
    this.projectiles.push({ id: this.nextId++, x: pos.x, y: pos.y, z: pos.z, vx: vel[0], vy: vel[1], vz: vel[2], dmg, life: 4 });
  }

  updateProjectiles() {
    const dt = TICK;
    const p = this.player;
    for (const pr of this.projectiles) {
      pr.life -= dt;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.z += pr.vz * dt;
      const hitWall =
        pr.y < 0.1 ||
        Math.abs(pr.x) > ARENA - 1 ||
        Math.abs(pr.z) > ARENA - 1 ||
        this.colliders.some((b) => pr.x > b.minX && pr.x < b.maxX && pr.z > b.minZ && pr.z < b.maxZ && pr.y < b.h);
      if (hitWall) {
        pr.life = 0;
        this.emit({ t: 'projHit', x: pr.x, y: pr.y, z: pr.z });
        continue;
      }
      const dx = pr.x - p.x;
      const dy = pr.y - (p.y + 1.0);
      const dz = pr.z - p.z;
      if (dx * dx + dy * dy + dz * dz < 0.5) {
        pr.life = 0;
        this.damagePlayer(pr.dmg);
      }
    }
    this.projectiles = this.projectiles.filter((pr) => pr.life > 0);
  }

  // ---------- pickups ----------

  dropPickup(kind, at) {
    const a = this.rng() * Math.PI * 2;
    const s = 1 + this.rng() * 3;
    const pk = {
      id: this.nextId++,
      kind,
      x: at.x,
      y: Math.max(0.8, at.y),
      z: at.z,
      vx: dcos(a) * s,
      vz: dsin(a) * s,
      vy: 3,
      landed: false,
      life: 14,
    };
    this.pickups.push(pk);
    this.emit({ t: 'drop', pickup: pk });
  }

  updatePickups() {
    const dt = TICK;
    const p = this.player;
    for (const pk of this.pickups) {
      pk.life -= dt;
      if (!pk.landed) {
        pk.vy -= 15 * dt;
        pk.x += pk.vx * dt;
        pk.z += pk.vz * dt;
        pk.y += pk.vy * dt;
        if (pk.y <= 0.6) {
          pk.y = 0.6;
          pk.landed = true;
        }
      }
      const wantsIt = pk.kind !== 'health' || p.hp < MAX_HP;
      const dx = p.x - pk.x;
      const dz = p.z - pk.z;
      const d = dhypot(dx, dz);
      if (wantsIt && d < 4 && d > 0.001) {
        const pull = (10 * (1 - d / 4) + 4) * dt;
        pk.x += (dx / d) * Math.min(pull, d);
        pk.z += (dz / d) * Math.min(pull, d);
      }
      this.collide(pk, 0.3);
      if (wantsIt && d < 1.1) {
        pk.life = 0;
        this.collect(pk.kind);
      }
    }
    this.pickups = this.pickups.filter((pk) => pk.life > 0);
  }

  collect(kind) {
    const p = this.player;
    if (kind === 'token') {
      this.tokens++;
      this.score += TOKEN_SCORE;
    } else if (kind === 'health') {
      p.hp = Math.min(MAX_HP, p.hp + 25);
    } else if (kind === 'shield') {
      p.shield = Math.min(MAX_SHIELD, p.shield + POWERUPS.shield.amount);
    } else {
      this.power[kind] = POWERUPS[kind].duration;
    }
    this.emit({ t: 'pickup', kind });
  }
}
