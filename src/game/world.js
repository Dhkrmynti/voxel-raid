// The arena around the player: a fixed backdrop (sky, skyline, dust) plus walls, cover and
// colours that are rebuilt whenever the arena changes.
import * as THREE from 'three';
import { ARENA, ARENAS, LOW_COVER } from './sim.js';
import { blockTexture, floorTexture, neon, starField, unitBox } from './voxel.js';

const DUST_COUNT = 260;

// Per-arena look: neon colours, wall tint range ([r, g, b] min and max) and sky/fog colour.
const ARENA_THEMES = {
  citadel: { primary: 0xff3fa4, secondary: 0x3ff2ff, tintMin: [0.82, 0.82, 0.82], tintMax: [1, 1, 1], sky: 0x120a24 },
  foundry: { primary: 0xff7b29, secondary: 0x3fe0c5, tintMin: [0.95, 0.62, 0.5], tintMax: [1, 0.78, 0.62], sky: 0x1a0d12 },
};

export class World {
  constructor(scene) {
    this.scene = scene;
    this.arenaId = null;
    scene.add(new THREE.HemisphereLight(0xb79bff, 0x1a0f2e, 1.5));
    const sun = new THREE.DirectionalLight(0xffd9f0, 2.0);
    sun.position.set(10, 20, 6);
    scene.add(sun);

    const ftex = floorTexture();
    ftex.repeat.set(ARENA, ARENA);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2), new THREE.MeshLambertMaterial({ map: ftex }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshLambertMaterial({ color: 0x0d0819 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);

    this.blockTexture = blockTexture();
    this.arenaGroup = new THREE.Group();
    scene.add(this.arenaGroup);

    const towerMat = new THREE.MeshLambertMaterial({ color: 0x1c1233 });
    const capMats = [neon(0xff3fa4, 2), neon(0x3ff2ff, 2)];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2 + Math.random() * 0.1;
      const dist = 45 + Math.random() * 25;
      const w = 3 + Math.random() * 5;
      const h = 6 + Math.random() * 22;
      const tower = new THREE.Mesh(unitBox, towerMat);
      tower.scale.set(w, h, w);
      tower.position.set(Math.cos(a) * dist, h / 2, Math.sin(a) * dist);
      scene.add(tower);
      const cap = new THREE.Mesh(unitBox, capMats[i % 2]);
      cap.scale.set(w * 0.5, 0.4, w * 0.5);
      cap.position.set(tower.position.x, h + 0.2, tower.position.z);
      scene.add(cap);
    }
    scene.add(starField(700, 110));

    // Slow-drifting dust motes give the arena some depth.
    const dust = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      dust.set([(Math.random() * 2 - 1) * ARENA, Math.random() * 8, (Math.random() * 2 - 1) * ARENA], i * 3);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3));
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0xb79bff, size: 1, sizeAttenuation: false, transparent: true, opacity: 0.55 }),
    );
    scene.add(this.dust);
  }

  /** Walls, cover, lights and colours for one arena; rebuilt only when the arena changes. */
  setArena(id) {
    if (this.arenaId === id) return;
    this.arenaId = id;
    const theme = ARENA_THEMES[id];
    const group = this.arenaGroup;
    group.traverse((o) => {
      if (o.isMesh) o.material.dispose(); // the block texture is shared and survives
      if (o.isInstancedMesh) o.dispose();
    });
    group.clear();

    this.scene.background.setHex(theme.sky);
    this.scene.fog.color.setHex(theme.sky);
    const a = new THREE.PointLight(theme.primary, 10, 30, 1);
    a.position.set(-12, 5, -12);
    const b = new THREE.PointLight(theme.secondary, 10, 30, 1);
    b.position.set(12, 5, 12);
    group.add(a, b);

    // Perimeter wall and cover blocks as one instanced mesh of unit voxels.
    const cells = [];
    for (let y = 0; y < 3; y++) {
      for (let i = -ARENA; i < ARENA; i++) {
        const c = i + 0.5;
        cells.push([c, y + 0.5, -ARENA + 0.5], [c, y + 0.5, ARENA - 0.5]);
        if (i > -ARENA && i < ARENA - 1) cells.push([-ARENA + 0.5, y + 0.5, c], [ARENA - 0.5, y + 0.5, c]);
      }
    }
    const glowMat = neon(theme.secondary);
    const ledgeMat = neon(theme.primary, 1.4);
    this.pillarGlow = { mat: glowMat, base: glowMat.color.clone() };
    for (const [x, z, w, d, h] of ARENAS[id].blocks) {
      for (let y = 0; y < Math.ceil(h); y++) {
        for (let ix = 0; ix < w; ix++) {
          for (let iz = 0; iz < d; iz++) cells.push([x - w / 2 + ix + 0.5, y + 0.5, z - d / 2 + iz + 0.5]);
        }
      }
      if (h > LOW_COVER) {
        const glow = new THREE.Mesh(unitBox, glowMat);
        glow.scale.setScalar(0.5);
        glow.position.set(x, h + 0.25, z);
        group.add(glow);
      } else {
        // A neon ledge marks waist-high cover you can shoot over.
        const ledge = new THREE.Mesh(unitBox, ledgeMat);
        ledge.scale.set(w + 0.02, 0.08, d + 0.02);
        ledge.position.set(x, h + 0.04, z);
        group.add(ledge);
      }
    }
    const blocks = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ map: this.blockTexture }), cells.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    cells.forEach(([x, y, z], i) => {
      blocks.setMatrixAt(i, m.makeTranslation(x, y, z));
      const k = Math.random();
      const [r0, g0, b0] = theme.tintMin;
      const [r1, g1, b1] = theme.tintMax;
      blocks.setColorAt(i, col.setRGB(r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k));
    });
    group.add(blocks);

    const trimMat = neon(theme.primary, 1.1);
    this.trim = { mat: trimMat, base: trimMat.color.clone() };
    for (const [sx, sz, x, z] of [
      [ARENA * 2, 1.02, 0, -ARENA + 0.5],
      [ARENA * 2, 1.02, 0, ARENA - 0.5],
      [1.02, ARENA * 2, -ARENA + 0.5, 0],
      [1.02, ARENA * 2, ARENA - 0.5, 0],
    ]) {
      const trim = new THREE.Mesh(unitBox, trimMat);
      trim.scale.set(sx, 0.1, sz);
      trim.position.set(x, 3.05, z);
      group.add(trim);
    }
  }

  set dustVisible(visible) {
    this.dust.visible = visible;
  }

  /** Neon that pulses on the music's beat (0–1) and slowly drifting dust. */
  animate(dt, time, beat) {
    if (this.trim) {
      this.trim.mat.color.copy(this.trim.base).multiplyScalar(1 + beat * 0.7);
      this.pillarGlow.mat.color.copy(this.pillarGlow.base).multiplyScalar(0.85 + beat * 0.4);
    }
    const pos = this.dust.geometry.attributes.position;
    for (let i = 0; i < DUST_COUNT; i++) {
      let y = pos.getY(i) + dt * (0.15 + (i % 7) * 0.03);
      if (y > 8) y = 0;
      pos.setY(i, y);
      pos.setX(i, pos.getX(i) + Math.sin(time * 0.3 + i) * dt * 0.1);
    }
    pos.needsUpdate = true;
  }
}
