// Short-lived visual effects: particle bursts, shattering enemies, tracers, blasts, spawn rings
// and floating damage numbers. Cosmetic only — none of it feeds back into the simulation.
import * as THREE from 'three';
import { DEFAULT_SKIN, neon, NEON, unitBox } from './voxel.js';

const MAX_DMG_NUMBERS = 32;
const ringGeometry = new THREE.RingGeometry(0.7, 1, 24);

export class Effects {
  /**
   * @param {THREE.Scene} scene
   * @param {{ camera: THREE.Camera, numberLayer: HTMLElement, capacity: number }} options
   *   capacity is the most particles ever alive; `maxParticles` can lower it at runtime
   */
  constructor(scene, { camera, numberLayer, capacity }) {
    this.scene = scene;
    this.camera = camera;
    this.numberLayer = numberLayer;
    this.maxParticles = capacity;
    this.tmp = new THREE.Vector3();
    this.dummy = new THREE.Object3D();
    this.colors = new Map();
    this.particles = [];
    this.debris = []; // voxel chunks of destroyed enemies
    this.dyingMaterials = [];
    this.transient = []; // tracers, blasts and spawn rings
    this.numbers = [];

    // Particles are instanced: one draw call however many are alive.
    this.particleMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial(), capacity);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.setColorAt(0, new THREE.Color());
    this.particleMesh.frustumCulled = false;
    this.particleMesh.count = 0;
    scene.add(this.particleMesh);

    this.tracerMat = neon(DEFAULT_SKIN.tracer);
    this.blastMat = new THREE.MeshBasicMaterial({ color: 0xff7b29, transparent: true, opacity: 0.6, depthWrite: false });
    this.blastMat.color.multiplyScalar(2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x3ff2ff, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    this.ringMat.color.multiplyScalar(NEON);
  }

  setTracerColor(hex) {
    this.tracerMat.color.setHex(hex).multiplyScalar(NEON);
  }

  burst(pos, colors, count, speed, size = 0.15) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) break;
      const hex = colors[i % colors.length];
      let color = this.colors.get(hex);
      if (!color) {
        color = new THREE.Color(hex);
        this.colors.set(hex, color);
      }
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 1.2 + 0.2, Math.random() * 2 - 1)
        .normalize()
        .multiplyScalar(speed * (0.4 + Math.random()));
      const life = 0.5 + Math.random() * 0.6;
      this.particles.push({
        pos: pos.clone(),
        vel: v,
        rot: 0,
        life,
        maxLife: life,
        size: size * (0.6 + Math.random() * 0.8),
        spin: Math.random() * 10,
        color,
      });
    }
  }

  /** Breaks an enemy model ({ group, materials }) into its voxels, which fly apart and fade. */
  shatter(model, power) {
    const g = model.group;
    g.updateMatrixWorld(true);
    const parts = [];
    g.traverse((o) => o.isMesh && parts.push(o));
    let longest = 0;
    for (const m of parts) {
      this.scene.attach(m); // keeps the world transform
      const dir = m.position.clone().sub(g.position);
      dir.y = Math.max(0.3, dir.y);
      dir.normalize().multiplyScalar(power * (0.5 + Math.random() * 0.8));
      dir.y += power * 0.5;
      const life = 0.9 + Math.random() * 0.6;
      longest = Math.max(longest, life);
      this.debris.push({
        mesh: m,
        vel: dir,
        spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6),
        life,
        maxLife: life,
        base: m.scale.clone(),
      });
    }
    this.scene.remove(g);
    this.dyingMaterials.push({ materials: model.materials, life: longest + 0.05 });
  }

  tracer(from, to, style) {
    const b = new THREE.Vector3(to.x, to.y, to.z);
    const mesh = new THREE.Mesh(unitBox, this.tracerMat);
    mesh.position.copy(from).lerp(b, 0.5);
    mesh.lookAt(b);
    mesh.scale.set(style.width, style.width, from.distanceTo(b));
    this.scene.add(mesh);
    this.transient.push({ mesh, life: style.life, maxLife: style.life, width: style.width });
  }

  /** Expanding flash of an explosion with radius `r`. */
  blast(x, y, z, r) {
    const mesh = new THREE.Mesh(unitBox, this.blastMat.clone());
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.transient.push({ mesh, life: 0.3, maxLife: 0.3, grow: r * 2, owned: true });
  }

  /** Portal ring on the floor where an enemy spawns. */
  ring(x, z, size) {
    const mesh = new THREE.Mesh(ringGeometry, this.ringMat.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.05, z);
    this.scene.add(mesh);
    this.transient.push({ mesh, life: 0.7, maxLife: 0.7, ring: size, owned: true });
  }

  /** Floating text (damage, score) anchored to a world point. */
  number(text, x, y, z, kind) {
    if (this.numbers.length >= MAX_DMG_NUMBERS) this.numbers.shift().el.remove();
    const el = document.createElement('span');
    el.className = `dmg ${kind}`;
    el.textContent = text;
    this.numberLayer.append(el);
    this.numbers.push({ el, x: x + (Math.random() - 0.5) * 0.4, y, z, life: 0.8 });
  }

  update(dt) {
    this.updateParticles(dt);
    this.updateDebris(dt);
    this.updateTransient(dt);
    this.updateNumbers(dt);
  }

  updateParticles(dt) {
    this.particles = this.particles.filter((pt) => (pt.life -= dt) > 0);
    const mesh = this.particleMesh;
    const d = this.dummy;
    this.particles.forEach((pt, i) => {
      pt.vel.y -= 20 * dt;
      pt.pos.addScaledVector(pt.vel, dt);
      if (pt.pos.y < pt.size * 0.5) {
        pt.pos.y = pt.size * 0.5;
        pt.vel.y *= -0.35;
        pt.vel.x *= 0.6;
        pt.vel.z *= 0.6;
      }
      pt.rot += pt.spin * dt;
      d.position.copy(pt.pos);
      d.rotation.set(pt.rot, pt.rot, 0);
      d.scale.setScalar(pt.size * Math.min(1, (pt.life / pt.maxLife) * 2));
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, pt.color);
    });
    mesh.count = this.particles.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  updateDebris(dt) {
    for (const d of this.debris) {
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        continue;
      }
      const m = d.mesh;
      d.vel.y -= 22 * dt;
      m.position.addScaledVector(d.vel, dt);
      if (m.position.y < 0.05) {
        m.position.y = 0.05;
        d.vel.y *= -0.3;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      m.rotation.x += d.spin.x * dt;
      m.rotation.y += d.spin.y * dt;
      m.rotation.z += d.spin.z * dt;
      const k = Math.min(1, (d.life / d.maxLife) * 3);
      m.scale.copy(d.base).multiplyScalar(k);
    }
    this.debris = this.debris.filter((d) => d.life > 0);
    for (const d of this.dyingMaterials) {
      d.life -= dt;
      if (d.life <= 0) d.materials.forEach((m) => m.dispose());
    }
    this.dyingMaterials = this.dyingMaterials.filter((d) => d.life > 0);
  }

  updateTransient(dt) {
    for (const f of this.transient) {
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        if (f.owned) f.mesh.material.dispose();
        continue;
      }
      const k = f.life / f.maxLife;
      if (f.ring) {
        f.mesh.scale.setScalar(f.ring * (1 - k) + 0.3);
        f.mesh.material.opacity = k;
      } else if (f.grow) {
        f.mesh.scale.setScalar(f.grow * (1 - k * k) + 0.2);
        f.mesh.material.opacity = 0.6 * k;
      } else if (f.width) {
        f.mesh.scale.x = f.mesh.scale.y = f.width * k;
      }
    }
    this.transient = this.transient.filter((f) => f.life > 0);
  }

  updateNumbers(dt) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const d of this.numbers) {
      d.life -= dt;
      d.y += dt * 1.2;
      const v = this.tmp.set(d.x, d.y, d.z).project(this.camera);
      if (d.life <= 0 || v.z > 1) {
        d.el.style.opacity = '0';
      } else {
        d.el.style.opacity = String(Math.min(1, d.life * 3));
        d.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
      }
    }
    for (const d of this.numbers) if (d.life <= 0) d.el.remove();
    this.numbers = this.numbers.filter((d) => d.life > 0);
  }

  clear() {
    for (const f of this.transient) {
      this.scene.remove(f.mesh);
      if (f.owned) f.mesh.material.dispose();
    }
    for (const d of this.debris) this.scene.remove(d.mesh);
    for (const d of this.dyingMaterials) d.materials.forEach((m) => m.dispose());
    for (const n of this.numbers) n.el.remove();
    this.particles = [];
    this.particleMesh.count = 0;
    this.debris = [];
    this.dyingMaterials = [];
    this.transient = [];
    this.numbers = [];
  }
}
