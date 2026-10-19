// Rendering, input, audio and HUD around the deterministic Sim (sim.js).
// The sim advances in fixed ticks; this view turns its state and events into what the player sees.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { sfx } from './audio.js';
import { music } from './music.js';
import { POWERUPS, WEAPONS } from './rules.js';
import { ReplayWriter } from './replay.js';
import { Effects } from './effects.js';
import { DASH_COOLDOWN, DEFAULT_ARENA, EYE_HEIGHT, MAX_HP, Sim, TICK } from './sim.js';
import { TouchControls } from './touch.js';
import { Tutorial } from './tutorial.js';
import { buildEnemyModel, buildGun, buildPickup, DEFAULT_SKIN, neon, unitBox } from './voxel.js';
import { World } from './world.js';

const MAX_PROJECTILES = 256;
// Render at a fraction of the screen resolution and upscale for the pixel look.
const QUALITY = {
  high: { pixelScale: 3, glow: true, particles: 400, dust: true },
  low: { pixelScale: 4, glow: false, particles: 160, dust: false },
};
const SLOW_FRAME = 1 / 42; // auto quality drops when frames average slower than this
const MAX_STEPS_PER_FRAME = 5;
const REPLAY_SPEEDS = [1, 2, 4];
const BASE_FOV = 75;
const BLOOM_STRENGTH = 0.45;

const WHITE = new THREE.Color(0xffffff);
const ENRAGED = new THREE.Color(0xff2040);
const WEAPON_SFX = ['shoot', 'scatter', 'rail'];
const TRACER = [
  { width: 0.03, life: 0.05 },
  { width: 0.02, life: 0.06 },
  { width: 0.09, life: 0.22 },
];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Inputs are quantized so a recorded run replays bit-for-bit.
const quantize = (v) => Math.round(v * 1e4) / 1e4;
const quantizeStick = (v) => Math.round(v * 100) / 100;
const TOUCH_LOOK = 0.006;
const MOUSE_LOOK = 0.0022;

export class Game {
  constructor({ container, onGameOver, onQuit, onMuteKey, touch = false }) {
    this.container = container;
    this.touch = touch;
    this.onGameOver = onGameOver;
    this.onQuit = onQuit;
    this.onMuteKey = onMuteKey;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'game-canvas';
    container.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x120a24);
    this.scene.fog = new THREE.Fog(0x120a24, 20, 75);

    // Look/FOV preferences only change how input is read, never the sim, so replays stay valid.
    this.controls = { sensitivity: 1, touchSensitivity: 1, invertY: false, fov: BASE_FOV };
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 150);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.quality = QUALITY.high;
    this.qualityMode = 'auto';
    this.frameTimes = [];
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM_STRENGTH, 0.15, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    this.tmp = new THREE.Vector3();
    this.keys = new Set();
    this.mouseDown = false;
    this.pending = { dash: false, reload: false, weapon: -1 };
    this.aim = { yaw: 0, pitch: 0 };
    this.state = 'idle';
    this.running = false;
    this.sim = null;
    this.acc = 0;

    this.enemyViews = new Map();

    this.pickupViews = new Map();
    this.dummy = new THREE.Object3D();
    // Enemy shots are instanced: one draw call however many are alive.
    this.projMesh = new THREE.InstancedMesh(unitBox, neon(0xff3fa4), MAX_PROJECTILES);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false;
    this.projMesh.count = 0;
    this.scene.add(this.projMesh);
    this.lastAim = { yaw: 0, pitch: 0 };
    this.sway = { x: 0, y: 0 };
    this.flashOverlay = 0;

    const q = (s) => container.querySelector(s);
    this.hud = {
      wave: q('#hud-wave'),
      enemies: q('#hud-enemies'),
      score: q('#hud-score'),
      mult: q('#hud-mult'),
      tokens: q('#hud-tokens'),
      hpFill: q('#hp-fill'),
      hpText: q('#hp-text'),
      shieldFill: q('#shield-fill'),
      ammo: q('#hud-ammo'),
      ammoMax: q('#hud-ammo-max'),
      weaponName: q('#hud-weapon'),
      slots: [...container.querySelectorAll('.slot')],
      dashFill: q('#dash-fill'),
      powers: { rapid: q('#pw-rapid'), double: q('#pw-double') },
      crosshair: q('#crosshair'),
      banner: q('#banner'),
      bannerTitle: q('#banner-title'),
      bannerSub: q('#banner-sub'),
      callout: q('#callout'),
      hurt: q('#hurt'),
      bossBar: q('#boss-bar'),
      bossFill: q('#boss-fill'),
      pause: q('#pause-overlay'),
      dmgLayer: q('#dmg-layer'),
      replayBar: q('#replay-bar'),
      replayLabel: q('#replay-label'),
      replayProgress: q('#replay-progress'),
      replayPause: q('#replay-pause'),
      replaySpeed: q('#replay-speed'),
      flash: q('#screen-flash'),
    };
    this.hudCache = new Map();
    this.world = new World(this.scene);
    this.effects = new Effects(this.scene, {
      camera: this.camera,
      numberLayer: this.hud.dmgLayer,
      capacity: QUALITY.high.particles,
    });

    if (touch) {
      container.classList.add('touch');
      q('#touch-ui').hidden = false;
      this.touchControls = new TouchControls(q('#touch-ui'), {
        onLook: (dx, dy) => {
          if (this.state !== 'playing') return;
          this.look(dx, dy, TOUCH_LOOK * this.controls.touchSensitivity);
        },
        onPause: () => this.state === 'playing' && this.setPaused(true),
      });
    }

    this.buildWeapons();
    this.bindInput();
    this.hud.replayPause.addEventListener('click', () => this.toggleReplayPause());
    this.hud.replaySpeed.addEventListener('click', () => this.cycleReplaySpeed());
    q('#replay-exit').addEventListener('click', () => this.quit());
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop = this.loop.bind(this);
  }

  // ---------- setup ----------

  buildWeapons() {
    this.guns = WEAPONS.map((w) => {
      const gun = buildGun(w.id);
      gun.group.scale.setScalar(0.8);
      // Kept modest: the gun sits right in front of the camera.
      gun.skinMaterials.glow.emissiveIntensity = 0.7;
      gun.skinMaterials.accent.emissiveIntensity = 0.9;
      gun.flash.material.color.multiplyScalar(4);
      gun.group.visible = false;
      this.camera.add(gun.group);
      return gun;
    });
    this.muzzleLight = new THREE.PointLight(0xffcc55, 0, 8, 1);
    this.muzzleLight.position.set(0.3, -0.2, -1);
    this.camera.add(this.muzzleLight);
  }

  /** Applies an arsenal skin ({body, accent, glow}) to every gun, or the default look for null. */
  setSkin(skin) {
    const s = skin ? { ...skin, tracer: skin.glow } : DEFAULT_SKIN;
    for (const gun of this.guns) {
      const m = gun.skinMaterials;
      m.body.color.setHex(s.body);
      m.glow.color.setHex(s.glow);
      m.glow.emissive.setHex(s.glow);
      m.accent.color.setHex(s.accent);
      m.accent.emissive.setHex(s.accent);
    }
    this.effects.setTracerColor(s.tracer);
  }

  /** 'auto' starts high (low on touch devices) and steps down if frames get slow. */
  setQualityMode(mode) {
    this.qualityMode = mode;
    this.frameTimes = [];
    this.applyQuality(mode === 'low' || (mode === 'auto' && this.touch) ? QUALITY.low : QUALITY.high);
  }

  applyQuality(q) {
    this.quality = q;
    this.world.dustVisible = q.dust;
    this.effects.maxParticles = q.particles;
    if (this.effects.particles.length > q.particles) this.effects.particles.length = q.particles;
    this.resize();
  }

  watchFrameRate(dt) {
    if (this.qualityMode !== 'auto' || this.quality === QUALITY.low) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 180) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > SLOW_FRAME) this.applyQuality(QUALITY.low);
  }

  bindInput() {
    window.addEventListener('keydown', (e) => {
      if (this.state === 'replay' || this.state === 'replay-end') {
        if (e.code === 'Space') {
          e.preventDefault();
          this.toggleReplayPause();
        }
        if (e.code === 'KeyF') this.cycleReplaySpeed();
        if (e.code === 'Escape') this.quit();
        return;
      }
      if (this.state !== 'playing') return;
      this.keys.add(e.code);
      if (!e.repeat) {
        if (e.code === 'KeyR') this.pending.reload = true;
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.pending.dash = true;
        if (e.code.startsWith('Digit')) this.pending.weapon = Number(e.code.slice(5)) - 1;
        if (e.code === 'KeyQ') this.pending.weapon = this.lastWeapon ?? -1;
        if (e.code === 'KeyM') this.onMuteKey?.();
      }
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (this.state !== 'playing' || document.pointerLockElement !== this.canvas) return;
      this.look(e.movementX, e.movementY, MOUSE_LOOK * this.controls.sensitivity);
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.state === 'playing' && document.pointerLockElement === this.canvas) this.mouseDown = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    document.addEventListener(
      'wheel',
      (e) => {
        if (this.state !== 'playing' || !this.sim) return;
        this.pending.weapon = this.nextWeapon(e.deltaY > 0 ? 1 : -1);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      if (this.touch) return;
      const locked = document.pointerLockElement === this.canvas;
      if (locked && this.state === 'paused') this.setPaused(false);
      else if (!locked && this.state === 'playing') this.setPaused(true);
    });
    document.addEventListener('pointerlockerror', () => {
      if (!this.touch && this.state === 'playing') this.setPaused(true);
    });
    window.addEventListener('blur', () => {
      if (this.state === 'playing') this.setPaused(true);
    });
  }

  look(dx, dy, scale) {
    this.aim.yaw -= dx * scale;
    this.aim.pitch = clamp(this.aim.pitch - dy * scale * (this.controls.invertY ? -1 : 1), -1.45, 1.45);
  }

  /** Applies { sensitivity, touchSensitivity, invertY, fov } from the player's settings. */
  setControls({ sensitivity, touchSensitivity, invertY, fov }) {
    this.controls = { sensitivity, touchSensitivity, invertY, fov };
  }

  nextWeapon(dir) {
    const unlocked = this.sim.weapons.map((w, i) => (w.unlocked ? i : -1)).filter((i) => i >= 0);
    const at = unlocked.indexOf(this.sim.weaponIndex);
    return unlocked[(at + dir + unlocked.length) % unlocked.length];
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = this.quality.pixelScale;
    this.renderer.setSize(Math.ceil(w / scale), Math.ceil(h / scale), false);
    this.composer.setSize(Math.ceil(w / scale), Math.ceil(h / scale));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- lifecycle ----------

  /**
   * @param {{ seed?: number, arena?: string, tutorial?: () => void }} [options]
   *   `tutorial` turns on first-run hints and is called once the player has finished them
   */
  start({ seed, arena = DEFAULT_ARENA, tutorial } = {}) {
    this.prepare(seed ?? crypto.getRandomValues(new Uint32Array(1))[0], arena);
    if (tutorial)
      this.tutorial = new Tutorial(this.container.querySelector('#tutorial'), { touch: this.touch, onDone: tutorial });
    this.replay = new ReplayWriter(); // every input the sim consumes, for server-side verification
    this.showBanner('BERSIAP!', 'Wave 1 segera dimulai');
    this.state = 'playing';
    this.hud.pause.hidden = true;
    this.hud.replayBar.hidden = true;
    this.lock();
    this.run();
  }

  /**
   * Plays back a recorded run: the same seed and inputs drive the same sim, so it's an exact replay.
   * @param {{ seed: number, arena: string, inputs: object[], label: string }} replay
   */
  startReplay({ seed, arena, inputs, label }) {
    this.prepare(seed, arena);
    this.playback = { inputs, index: 0, speed: 1, paused: false };
    this.replay = null;
    this.hud.replayLabel.textContent = label;
    this.hud.replayPause.textContent = 'JEDA';
    this.hud.replaySpeed.textContent = '1×';
    this.hud.replayBar.hidden = false;
    this.hud.pause.hidden = true;
    this.state = 'replay';
    this.run();
  }

  toggleReplayPause() {
    if (!this.playback || this.state !== 'replay') return;
    this.playback.paused = !this.playback.paused;
    this.hud.replayPause.textContent = this.playback.paused ? 'LANJUT' : 'JEDA';
  }

  cycleReplaySpeed() {
    if (!this.playback) return;
    const next = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(this.playback.speed) + 1) % REPLAY_SPEEDS.length];
    this.playback.speed = next;
    this.hud.replaySpeed.textContent = `${next}×`;
  }

  run() {
    music.start();
    music.setIntensity(0);
    if (!this.running) {
      this.running = true;
      this.clock.getDelta();
      requestAnimationFrame(this.loop);
    }
  }

  /** Fresh sim and a clean view, shared by live games and replays. */
  prepare(seed, arena) {
    this.tutorial?.dispose();
    this.tutorial = null;
    sfx.unlock();
    this.resize();
    this.clearViews();
    this.world.setArena(arena);
    this.sim = new Sim(seed, { arena });
    this.aim = { yaw: 0, pitch: 0 };
    this.pending = { dash: false, reload: false, weapon: -1 };
    this.touchControls?.reset();
    this.lastWeapon = null;
    this.acc = 0;
    this.recoil = 0;
    this.shake = 0;
    this.hurtT = 0;
    this.hurtShield = false;
    this.hitT = 0;
    this.critT = 0;
    this.flashT = 0;
    this.swapT = 0;
    this.fovKick = 0;
    this.bobPhase = 0;
    this.deathT = 0;
    this.camera.rotation.z = 0;
    this.showGun(0);
    this.hud.bossBar.hidden = true;
    this.hud.callout.classList.remove('show');
    this.hudCache.clear();
    this.clearBanners();
  }

  resume() {
    if (this.state !== 'paused') return;
    if (this.touch || document.pointerLockElement === this.canvas) this.setPaused(false);
    else this.lock();
  }

  quit() {
    this.state = 'idle';
    this.running = false;
    this.playback = null;
    this.tutorial?.dispose();
    this.tutorial = null;
    this.hud.pause.hidden = true;
    this.hud.replayBar.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.clearBanners();
    clearTimeout(this.calloutTimer);
    music.stop();
    this.onQuit?.();
  }

  lock() {
    if (this.touch) {
      // Phones: no pointer lock; go fullscreen landscape where the browser allows it.
      document.documentElement
        .requestFullscreen?.()
        .then(() => screen.orientation?.lock?.('landscape'))
        .catch(() => {});
      return;
    }
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => this.state === 'playing' && this.setPaused(true));
    } catch {
      this.setPaused(true);
    }
  }

  setPaused(paused) {
    this.state = paused ? 'paused' : 'playing';
    this.hud.pause.hidden = !paused;
    this.keys.clear();
    this.mouseDown = false;
    this.touchControls?.reset();
    this.acc = 0;
  }

  clearViews() {
    for (const v of this.enemyViews.values()) this.removeEnemyView(v);
    for (const v of this.pickupViews.values()) this.removePickupView(v);
    this.effects.clear();
    this.enemyViews.clear();
    this.pickupViews.clear();
    this.projMesh.count = 0;
  }

  gameOver() {
    this.state = 'over';
    // An unfinished tutorial comes back next run.
    this.tutorial?.dispose();
    this.tutorial = null;
    this.mouseDown = false;
    this.keys.clear();
    this.hud.bossBar.hidden = true;
    this.clearBanners();
    if (document.pointerLockElement) document.exitPointerLock();
    sfx.gameOver();
    music.stop(1.5);
    this.onGameOver?.(this.sim.stats(), this.replay.bytes());
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.state === 'playing') {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK && steps < MAX_STEPS_PER_FRAME && !this.sim.over) {
        const input = this.sampleInput();
        this.replay.push(input);
        this.sim.step(input);
        this.acc -= TICK;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.acc = 0; // too slow to catch up: drop time instead of spiralling
      this.handleEvents();
      if (this.sim.over) this.gameOver();
    } else if (this.state === 'replay') {
      this.stepReplay(dt);
    }
    if (this.sim) this.updateView(dt);
    if (this.state === 'playing') this.watchFrameRate(dt);
    if (this.quality.glow) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  stepReplay(dt) {
    const pb = this.playback;
    if (!pb.paused) {
      this.acc += dt * pb.speed;
      let steps = 0;
      while (this.acc >= TICK && steps < MAX_STEPS_PER_FRAME * pb.speed && pb.index < pb.inputs.length && !this.sim.over) {
        const input = pb.inputs[pb.index++];
        this.aim.yaw = input.yaw;
        this.aim.pitch = input.pitch;
        this.sim.step(input);
        this.acc -= TICK;
        steps++;
      }
    }
    this.handleEvents();
    this.hud.replayProgress.style.width = `${(pb.index / pb.inputs.length) * 100}%`;
    if (this.sim.over || pb.index >= pb.inputs.length) {
      this.state = 'replay-end';
      this.showBanner('REPLAY SELESAI', 'Tekan KELUAR untuk kembali');
      music.stop(1.5);
    }
  }

  sampleInput() {
    const k = this.keys;
    const mz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const input = {
      mx,
      mz,
      yaw: quantize(this.aim.yaw),
      pitch: quantize(this.aim.pitch),
      fire: this.mouseDown,
      jump: k.has('Space'),
      dash: this.pending.dash,
      reload: this.pending.reload,
      weapon: this.pending.weapon,
    };
    this.pending = { dash: false, reload: false, weapon: -1 };
    if (this.touchControls) {
      const t = this.touchControls.consume();
      if (t.mx || t.mz) {
        input.mx = quantizeStick(t.mx);
        input.mz = quantizeStick(t.mz);
      }
      input.fire ||= t.fire;
      input.jump ||= t.jump;
      input.dash ||= t.dash;
      input.reload ||= t.reload;
      if (t.cycle) input.weapon = this.nextWeapon(1);
    }
    return input;
  }

  // ---------- sim events → effects ----------

  handleEvents() {
    const sim = this.sim;
    for (const ev of sim.events) {
      switch (ev.t) {
        case 'spawn':
          this.addEnemyView(ev.enemy);
          break;
        case 'hit': {
          const v = this.enemyViews.get(ev.id);
          if (v) {
            v.flash = 0.07;
            v.squash = 1;
            this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), v.model.colors, ev.crit ? 6 : 3, 4, 0.1);
          }
          this.effects.number(String(ev.dmg), ev.x, ev.y, ev.z, ev.crit ? 'crit' : '');
          if (ev.crit) {
            this.critT = 0.15;
            sfx.crit();
          } else {
            this.hitT = 0.12;
            sfx.hit();
          }
          break;
        }
        case 'kill': {
          const v = this.enemyViews.get(ev.id);
          const boss = ev.type === 'boss';
          if (v) {
            this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), v.model.colors, boss ? 40 : 10, boss ? 10 : 7, boss ? 0.35 : 0.2);
            this.effects.shatter(v.model, boss ? 9 : 6);
            this.enemyViews.delete(ev.id);
          }
          this.effects.number(`+${Math.round(ev.score)}`, ev.x, ev.y + 0.6, ev.z, 'score');
          sfx.at(this.spot(ev.x, ev.z), 'kill');
          if (boss) {
            this.hud.bossBar.hidden = true;
            this.shake = 1;
            this.screenFlash(0.7);
            sfx.bossDown();
          }
          break;
        }
        case 'detonate': {
          const v = this.enemyViews.get(ev.id);
          if (v) {
            this.effects.shatter(v.model, 8);
            this.enemyViews.delete(ev.id);
          }
          break;
        }
        case 'explode': {
          this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), [0xff7b29, 0xffd23f, 0x2a1a2e], 36, 9, 0.25);
          this.effects.blast(ev.x, ev.y, ev.z, ev.r);
          const dist = Math.hypot(ev.x - sim.player.x, ev.z - sim.player.z);
          if (dist < 12) {
            this.shake = Math.min(1, this.shake + 0.5);
            this.screenFlash(0.35 * (1 - dist / 12));
          }
          sfx.at(this.spot(ev.x, ev.z), 'explode');
          break;
        }
        case 'fuse': {
          const e = sim.enemies.find((x) => x.id === ev.id);
          if (e) sfx.at(this.spot(e.x, e.z), 'fuse');
          break;
        }
        case 'shot':
          this.onShot(ev);
          break;
        case 'blocked':
          this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), [0x3fa9ff, 0xffffff], 5, 4, 0.08);
          sfx.at(this.spot(ev.x, ev.z), 'shieldHit');
          break;
        case 'impact':
          this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), [0x8b7bd8, 0x5b4a92], 4, 3, 0.08);
          break;
        case 'projHit':
          this.effects.burst(this.tmp.set(ev.x, ev.y, ev.z), [0xff3fa4], 4, 3, 0.08);
          break;
        case 'enemyShot':
          sfx.at(this.spot(ev.x, ev.z), 'enemyShoot');
          break;
        case 'hurt':
          this.hurtT = 1;
          this.hurtShield = ev.shielded;
          this.shake = Math.min(1, this.shake + 0.45);
          if (ev.shielded) sfx.shieldHit();
          else sfx.hurt();
          break;
        case 'drop':
          this.addPickupView(ev.pickup);
          break;
        case 'pickup':
          if (ev.kind === 'token') sfx.pickup();
          else if (ev.kind === 'health') sfx.heal();
          else {
            sfx.powerup();
            this.showCallout(POWERUPS[ev.kind].name, 'power');
          }
          break;
        case 'wave':
          if (ev.boss) {
            this.showBanner(`BOSS WAVE ${ev.wave}`, 'Raja Voxel datang!');
            sfx.boss();
          } else {
            this.showBanner(`WAVE ${ev.wave}`, `${ev.count} musuh mendekat`);
            sfx.wave();
          }
          break;
        case 'waveClear':
          this.showBanner(`WAVE ${ev.wave} CLEAR`, `+${ev.bonus} bonus · +15 HP`);
          sfx.waveClear();
          break;
        case 'unlock':
          this.showBanner(`SENJATA BARU: ${WEAPONS[ev.weapon].name}`, `Tekan ${ev.weapon + 1} atau scroll untuk ganti`);
          sfx.weaponUnlock();
          break;
        case 'enrage':
          this.showCallout('RAJA VOXEL MENGAMUK!', 'danger');
          this.shake = 0.8;
          this.screenFlash(0.3);
          sfx.boss();
          break;
        case 'streak':
          this.showCallout(ev.name, 'streak');
          sfx.streak();
          break;
        case 'dash':
          this.fovKick = 1;
          sfx.dash();
          break;
        case 'reload':
          sfx.reload();
          break;
        case 'switch':
          this.lastWeapon = this.shownWeapon;
          this.showGun(ev.weapon);
          this.swapT = 0.25;
          sfx.swap();
          break;
        default:
          break;
      }
    }
    this.tutorial?.observe(sim.events);
    sim.events.length = 0;
  }

  onShot(ev) {
    const style = TRACER[ev.weapon];
    this.recoil = ev.weapon === 2 ? 1.6 : ev.weapon === 1 ? 1.3 : 1;
    this.flashT = ev.weapon === 2 ? 0.08 : 0.05;
    this.camera.updateMatrixWorld(true);
    this.guns[ev.weapon].muzzle.getWorldPosition(this.tmp);
    for (const end of ev.ends) this.effects.tracer(this.tmp, end, style);
    if (ev.weapon === 2) this.shake = Math.min(1, this.shake + 0.25);
    sfx[WEAPON_SFX[ev.weapon]]();
  }

  showGun(index) {
    this.shownWeapon = index;
    this.guns.forEach((g, i) => (g.group.visible = i === index));
  }

  // ---------- entity views ----------

  addEnemyView(e) {
    const model = buildEnemyModel(e.type);
    model.group.scale.setScalar(e.scale);
    model.group.position.set(e.x, e.y, e.z);
    this.scene.add(model.group);
    const fuseMat = e.type === 'exploder' ? model.materials.find((m) => m.color.getHex() === 0xffd23f) : null;
    // Eyes, visors and fuses glow through the bloom pass.
    for (const m of model.materials) if (m.userData.baseEmissive.getHex() !== 0) m.emissiveIntensity = 2;
    this.enemyViews.set(e.id, { model, flash: 0, flashing: false, fuseMat, squash: 0 });
    this.effects.burst(this.tmp.set(e.x, 0.3, e.z), [0x9b5de5, 0x3ff2ff], e.type === 'boss' ? 30 : 10, 5);
    this.effects.ring(e.x, e.z, e.radius * 2.2 + 0.5);
    if (e.type === 'boss') this.hud.bossBar.hidden = false;
  }

  removeEnemyView(v) {
    this.scene.remove(v.model.group);
    v.model.materials.forEach((m) => m.dispose());
  }

  addPickupView(pk) {
    const { group, materials } = buildPickup(pk.kind);
    for (const m of materials) if (m.emissive.getHex() !== 0) m.emissiveIntensity = 1.8;
    group.position.set(pk.x, pk.y, pk.z);
    this.scene.add(group);
    this.pickupViews.set(pk.id, { group, materials });
  }

  removePickupView(v) {
    this.scene.remove(v.group);
    v.materials.forEach((m) => m.dispose());
  }

  syncEntities(dt) {
    const sim = this.sim;
    const t = sim.time;
    const alive = new Set();
    for (const e of sim.enemies) {
      const v = this.enemyViews.get(e.id);
      if (!v || e.dead) continue;
      alive.add(e.id);
      const g = v.model.group;
      g.position.set(e.x, e.y, e.z);
      g.rotation.y = e.yaw;
      v.squash = Math.max(0, v.squash - dt * 8);
      const k = v.squash;
      g.scale.set(e.scale * (1 + 0.16 * k), e.scale * (1 - 0.2 * k), e.scale * (1 + 0.16 * k));
      v.model.legs.forEach((l, i) => (l.rotation.x = Math.sin(e.walk + (i % 2) * Math.PI) * 0.7));
      v.model.arms.forEach((a, i) => {
        a.rotation.x = e.attackAnim > 0 ? -1.6 * e.attackAnim : Math.sin(e.walk + (i % 2 ? 0 : Math.PI)) * 0.4;
      });
      v.flash -= dt;
      const flashing = v.flash > 0;
      const glowing = e.enraged && Math.sin(t * 10) > 0;
      const mode = flashing ? 'flash' : glowing ? 'enraged' : 'base';
      if (mode !== v.mode) {
        v.mode = mode;
        v.model.materials.forEach((m) =>
          m.emissive.copy(mode === 'flash' ? WHITE : mode === 'enraged' ? ENRAGED : m.userData.baseEmissive),
        );
      }
      if (v.fuseMat && e.fuse > 0) v.fuseMat.emissive.setHex(Math.sin(t * 40) > 0 ? 0xffffff : 0xff2000);
    }
    for (const [id, v] of this.enemyViews) {
      if (!alive.has(id)) {
        this.removeEnemyView(v);
        this.enemyViews.delete(id);
      }
    }

    const d = this.dummy;
    const shots = Math.min(sim.projectiles.length, MAX_PROJECTILES);
    for (let i = 0; i < shots; i++) {
      const pr = sim.projectiles[i];
      d.position.set(pr.x, pr.y, pr.z);
      d.rotation.set(t * 10 + pr.id, t * 7, 0);
      d.scale.setScalar(0.3);
      d.updateMatrix();
      this.projMesh.setMatrixAt(i, d.matrix);
    }
    this.projMesh.count = shots;
    this.projMesh.instanceMatrix.needsUpdate = true;

    const livePk = new Set();
    for (const pk of sim.pickups) {
      const v = this.pickupViews.get(pk.id);
      if (!v) continue;
      livePk.add(pk.id);
      v.group.position.set(pk.x, pk.landed ? pk.y + Math.sin(t * 3 + pk.id) * 0.12 : pk.y, pk.z);
      v.group.rotation.y = t * 3 + pk.id;
      // Hide pickups that pass right through the camera instead of filling the screen.
      const nearEye = v.group.position.distanceTo(this.camera.position) < 0.8;
      v.group.visible = !nearEye && (pk.life > 3 || Math.floor(pk.life * 8) % 2 === 0);
    }
    for (const [id, v] of this.pickupViews) {
      if (!livePk.has(id)) {
        this.removePickupView(v);
        this.pickupViews.delete(id);
      }
    }
  }

  // ---------- per-frame view ----------

  updateView(dt) {
    if (this.state === 'over' || (this.state === 'replay-end' && this.sim.over)) {
      if (this.deathT === 0) this.updateHud(0); // show the killing blow (HP 0) before the HUD freezes
      this.deathT += dt;
      this.guns.forEach((g) => (g.group.visible = false));
      this.camera.position.y = Math.max(0.35, this.camera.position.y - dt * 2.5);
      this.camera.rotation.z = Math.min(0.45, this.deathT * 0.8);
    } else if (this.state === 'playing' || this.state === 'paused' || this.state.startsWith('replay')) {
      this.updateCamera(dt);
      this.syncEntities(dt);
      this.updateHud(dt);
      if (this.state === 'playing') this.tutorial?.update(this.sim, dt);
    }
    this.effects.update(dt);
    this.updateAmbience(dt);
  }

  updateAmbience(dt) {
    const sim = this.sim;
    if (this.state === 'playing' || this.state === 'replay') music.setIntensity(sim.boss ? 2 : sim.intermission > 0 ? 0 : 1);

    const beat = music.pulse();
    this.world.animate(dt, sim.time, beat);
    this.bloom.strength = BLOOM_STRENGTH + beat * 0.12;

    this.flashOverlay = Math.max(0, this.flashOverlay - dt * 3);
    this.hud.flash.style.opacity = String(this.flashOverlay);
  }

  screenFlash(strength) {
    this.flashOverlay = Math.min(1, Math.max(this.flashOverlay, strength));
  }

  /** Stereo position of a world point relative to where the player is looking. */
  spot(x, z) {
    const p = this.sim.player;
    const dx = x - p.x;
    const dz = z - p.z;
    const dist = Math.hypot(dx, dz) || 1;
    const right = (dx * Math.cos(this.aim.yaw) - dz * Math.sin(this.aim.yaw)) / dist;
    return { pan: clamp(right * 0.85, -0.85, 0.85), vol: clamp(1.1 - dist / 40, 0.2, 1) };
  }

  updateCamera(dt) {
    const p = this.sim.player;
    const cam = this.camera;
    const speedH = Math.hypot(p.vx, p.vz);
    const moveF = Math.min(1, speedH / 8);
    if (p.grounded && speedH > 0.5) this.bobPhase += dt * Math.min(speedH, 9) * 1.6;
    const bob = Math.sin(this.bobPhase) * 0.05 * moveF;

    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sh = this.shake * this.shake * 0.4;
    cam.position.set(
      p.x + (Math.random() - 0.5) * sh,
      EYE_HEIGHT + p.y + bob + (Math.random() - 0.5) * sh,
      p.z + (Math.random() - 0.5) * sh,
    );
    // Aim comes straight from the mouse so the camera never lags behind a tick.
    cam.rotation.set(this.aim.pitch, this.aim.yaw, 0);

    this.fovKick = Math.max(0, this.fovKick - dt * 4);
    const fov = this.controls.fov + this.fovKick * 10;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    this.recoil = Math.max(0, this.recoil - dt * 8);
    this.swapT = Math.max(0, this.swapT - dt);
    const def = this.sim.weapon;
    const dip = this.sim.reloading > 0 ? Math.sin((1 - this.sim.reloading / def.reload) * Math.PI) : 0;
    const swap = this.swapT / 0.25;
    // The gun lags slightly behind the mouse, which makes aiming feel weighty.
    const ease = 1 - Math.exp(-12 * dt);
    this.sway.x += (clamp((this.aim.yaw - this.lastAim.yaw) * 2.5, -0.08, 0.08) - this.sway.x) * ease;
    this.sway.y += (clamp((this.aim.pitch - this.lastAim.pitch) * -2.5, -0.06, 0.06) - this.sway.y) * ease;
    this.lastAim.yaw = this.aim.yaw;
    this.lastAim.pitch = this.aim.pitch;
    const g = this.guns[this.shownWeapon].group;
    g.position.set(
      0.3 + Math.cos(this.bobPhase * 0.5) * 0.012 * moveF + this.sway.x,
      -0.28 - Math.abs(Math.sin(this.bobPhase * 0.5)) * 0.015 * moveF - dip * 0.2 - swap * 0.3 + this.sway.y,
      -0.55 + this.recoil * 0.08,
    );
    g.rotation.set(this.recoil * 0.15 - dip * 0.7, this.sway.x * 1.5, dip * 0.4 + this.sway.x);

    this.flashT -= dt;
    const gun = this.guns[this.shownWeapon];
    gun.flash.visible = this.flashT > 0;
    gun.flash.rotation.z = Math.random() * Math.PI;
    this.muzzleLight.intensity = this.flashT > 0 ? 6 : 0;
  }

  // ---------- HUD ----------

  /** Banners queue up so a wave start and a weapon unlock are both readable. */
  showBanner(title, sub) {
    this.bannerQueue ??= [];
    this.bannerQueue.push({ title, sub });
    if (this.bannerQueue.length > 2) this.bannerQueue.shift(); // stale banners are dropped
    if (!this.bannerTimer) this.nextBanner();
  }

  nextBanner() {
    const h = this.hud;
    const next = this.bannerQueue.shift();
    if (!next) {
      h.banner.classList.remove('show');
      this.bannerTimer = null;
      return;
    }
    h.bannerTitle.textContent = next.title;
    h.bannerSub.textContent = next.sub;
    h.banner.classList.add('show');
    this.bannerTimer = setTimeout(() => {
      h.banner.classList.remove('show');
      this.bannerTimer = setTimeout(() => this.nextBanner(), 250);
    }, 1900);
  }

  clearBanners() {
    clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
    this.bannerQueue = [];
    this.hud.banner.classList.remove('show');
  }

  showCallout(text, kind) {
    const el = this.hud.callout;
    el.textContent = text;
    el.className = `hud show ${kind}`;
    clearTimeout(this.calloutTimer);
    this.calloutTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  setText(el, v) {
    if (this.hudCache.get(el) !== v) {
      el.textContent = v;
      this.hudCache.set(el, v);
    }
  }

  updateHud(dt) {
    const h = this.hud;
    const sim = this.sim;
    const p = sim.player;
    this.setText(h.wave, String(sim.wave));
    this.setText(h.enemies, String(sim.enemies.length + sim.spawnQueue.length));
    this.setText(h.score, Math.round(sim.score).toLocaleString('id-ID'));
    const m = sim.multiplier();
    const dbl = sim.power.double > 0;
    this.setText(h.mult, [m > 1 ? `x${m}` : '', dbl ? '2X' : ''].filter(Boolean).join(' · '));
    this.setText(h.tokens, String(sim.tokens));

    const hpPct = (p.hp / MAX_HP) * 100;
    h.hpFill.style.width = `${hpPct}%`;
    h.hpFill.classList.toggle('low', hpPct < 30);
    h.shieldFill.style.width = `${(p.shield / MAX_HP) * 100}%`;
    this.setText(h.hpText, p.shield > 0 ? `${Math.ceil(p.hp)} +${Math.ceil(p.shield)}` : String(Math.ceil(p.hp)));

    const def = sim.weapon;
    const ammo = sim.weapons[sim.weaponIndex].ammo;
    this.setText(h.weaponName, def.name);
    this.setText(h.ammo, sim.reloading > 0 ? 'RELOAD' : String(ammo));
    this.setText(h.ammoMax, ` / ${def.mag}`);
    h.ammo.classList.toggle('low', sim.reloading <= 0 && ammo <= Math.ceil(def.mag * 0.2));
    h.slots.forEach((el, i) => {
      el.classList.toggle('active', i === sim.weaponIndex);
      el.classList.toggle('locked', !sim.weapons[i].unlocked);
    });
    h.dashFill.style.width = `${(1 - p.dashCd / DASH_COOLDOWN) * 100}%`;
    h.dashFill.classList.toggle('ready', p.dashCd <= 0);

    for (const [kind, el] of Object.entries(h.powers)) {
      const left = sim.power[kind];
      el.hidden = left <= 0;
      if (left > 0) this.setText(el.querySelector('b'), `${Math.ceil(left)}s`);
    }

    this.hitT -= dt;
    this.critT -= dt;
    h.crosshair.classList.toggle('hit', this.hitT > 0);
    h.crosshair.classList.toggle('crit', this.critT > 0);
    this.hurtT = Math.max(0, this.hurtT - dt * 2);
    const lowHp = hpPct < 30 ? 0.25 + Math.sin(sim.time * 6) * 0.1 : 0;
    h.hurt.style.opacity = String(Math.min(1, this.hurtT * 0.8 + lowHp));
    h.hurt.classList.toggle('shield', this.hurtShield && this.hurtT > 0);

    if (sim.boss) {
      h.bossFill.style.width = `${Math.max(0, (sim.boss.hp / sim.boss.maxHp) * 100)}%`;
      h.bossBar.classList.toggle('enraged', sim.boss.enraged);
    }
  }
}
