import * as THREE from 'three';

export const unitBox = new THREE.BoxGeometry(1, 1, 1);

// Deterministic RNG so textures look identical on every load.
function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

export function pixelTexture(size, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function floorTexture() {
  const r = rng(7);
  return pixelTexture(16, (ctx, s) => {
    ctx.fillStyle = '#241a3d';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = r() < 0.5 ? '#2c2149' : '#1d1433';
      ctx.fillRect(Math.floor(r() * s), Math.floor(r() * s), 1, 1);
    }
    ctx.fillStyle = '#3a2a63';
    ctx.fillRect(0, 0, s, 1);
    ctx.fillRect(0, 0, 1, s);
  });
}

export function blockTexture() {
  const r = rng(13);
  return pixelTexture(16, (ctx, s) => {
    ctx.fillStyle = '#5b4a92';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#41336e';
    for (let y = 0; y < s; y += 4) {
      ctx.fillRect(0, y + 3, s, 1);
      const off = (y / 4) % 2 ? 4 : 0;
      for (let x = off; x < s; x += 8) ctx.fillRect(x, y, 1, 3);
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = r() < 0.5 ? '#6d5ba8' : '#4c3d80';
      ctx.fillRect(Math.floor(r() * s), Math.floor(r() * s), 1, 1);
    }
    ctx.fillStyle = '#7d6bc0';
    ctx.fillRect(0, 0, s, 1);
  });
}

export function starField(count, radius, color = 0xffffff) {
  const pos = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(Math.random() * 2 - 1, Math.random() * 0.9 + 0.05, Math.random() * 2 - 1).normalize().multiplyScalar(radius);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 1, sizeAttenuation: false, fog: false }));
}

// Small helper for composing models out of boxes. Materials are created per model
// so an individual enemy can flash white when hit.
function builder() {
  const group = new THREE.Group();
  const mats = new Map();
  const add = (color, size, pos, emissive = 0x000000, parent = group) => {
    const key = `${color}-${emissive}`;
    let m = mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, emissive });
      m.userData.baseEmissive = new THREE.Color(emissive);
      mats.set(key, m);
    }
    const mesh = new THREE.Mesh(unitBox, m);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(pos[0], pos[1], pos[2]);
    parent.add(mesh);
    return mesh;
  };
  // A limb hangs from a pivot so it can swing around the hip/shoulder.
  const limb = (color, size, hip) => {
    const pivot = new THREE.Group();
    pivot.position.set(hip[0], hip[1], hip[2]);
    group.add(pivot);
    add(color, size, [0, -size[1] / 2, 0], 0x000000, pivot);
    return pivot;
  };
  return { group, add, limb, mats };
}

// All models face +Z and stand on y = 0.
export function buildEnemyModel(type) {
  const { group, add, limb, mats } = builder();
  let legs = [];
  let arms = [];
  let colors = [];

  if (type === 'grunt') {
    legs = [limb(0x2f7a3a, [0.32, 0.5, 0.32], [-0.28, 0.5, 0]), limb(0x2f7a3a, [0.32, 0.5, 0.32], [0.28, 0.5, 0])];
    add(0x5ed35a, [1.1, 1.0, 0.9], [0, 1.0, 0]);
    add(0x8cf07a, [1.1, 0.15, 0.9], [0, 1.55, 0]);
    add(0xff3030, [0.22, 0.16, 0.06], [-0.25, 1.18, 0.46], 0xff2020);
    add(0xff3030, [0.22, 0.16, 0.06], [0.25, 1.18, 0.46], 0xff2020);
    add(0x1f4d25, [0.6, 0.12, 0.06], [0, 0.82, 0.46]);
    arms = [limb(0x4cb84c, [0.24, 0.7, 0.24], [-0.68, 1.35, 0.05]), limb(0x4cb84c, [0.24, 0.7, 0.24], [0.68, 1.35, 0.05])];
    colors = [0x5ed35a, 0x2f7a3a, 0x8cf07a];
  } else if (type === 'runner') {
    for (const [x, z] of [[-0.3, 0.3], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3]]) {
      legs.push(limb(0x7a1f1f, [0.18, 0.35, 0.18], [x, 0.35, z]));
    }
    add(0xe8413c, [0.8, 0.5, 1.0], [0, 0.6, 0]);
    for (const z of [-0.3, 0, 0.3]) add(0xffd23f, [0.15, 0.25, 0.15], [0, 0.95, z]);
    add(0xfff35c, [0.16, 0.12, 0.04], [-0.2, 0.68, 0.51], 0xffd000);
    add(0xfff35c, [0.16, 0.12, 0.04], [0.2, 0.68, 0.51], 0xffd000);
    colors = [0xe8413c, 0xffd23f, 0x7a1f1f];
  } else if (type === 'shooter') {
    legs = [limb(0x3b2470, [0.3, 0.6, 0.3], [-0.25, 0.6, 0]), limb(0x3b2470, [0.3, 0.6, 0.3], [0.25, 0.6, 0])];
    add(0x9b5de5, [0.9, 1.2, 0.7], [0, 1.2, 0]);
    add(0x2a1650, [0.7, 0.3, 0.06], [0, 1.5, 0.36]);
    add(0x3ff2ff, [0.4, 0.12, 0.04], [0, 1.5, 0.4], 0x00e5ff);
    add(0x444455, [0.26, 0.26, 0.9], [0.6, 1.2, 0.25]);
    add(0x3ff2ff, [0.18, 0.18, 0.06], [0.6, 1.2, 0.72], 0x00e5ff);
    add(0x3b2470, [0.08, 0.4, 0.08], [0, 2.0, 0]);
    add(0xff3fa4, [0.16, 0.16, 0.16], [0, 2.25, 0], 0xff3fa4);
    colors = [0x9b5de5, 0x3ff2ff, 0x3b2470];
  } else if (type === 'exploder') {
    legs = [limb(0x1a1020, [0.2, 0.3, 0.2], [-0.22, 0.3, 0]), limb(0x1a1020, [0.2, 0.3, 0.2], [0.22, 0.3, 0])];
    add(0x2a1a2e, [0.9, 0.6, 0.9], [0, 0.6, 0]);
    add(0x2a1a2e, [0.7, 0.2, 0.7], [0, 0.98, 0]);
    add(0xff7b29, [0.92, 0.12, 0.92], [0, 0.55, 0], 0x662200);
    add(0xfff35c, [0.16, 0.12, 0.04], [-0.2, 0.75, 0.46], 0xffd000);
    add(0xfff35c, [0.16, 0.12, 0.04], [0.2, 0.75, 0.46], 0xffd000);
    add(0x6b5a40, [0.08, 0.2, 0.08], [0, 1.18, 0]);
    // The fuse tip is its own material so the view can make it blink.
    add(0xffd23f, [0.14, 0.14, 0.14], [0, 1.32, 0], 0xff7b29);
    colors = [0xff7b29, 0x2a1a2e, 0xffd23f];
  } else if (type === 'boss') {
    legs = [limb(0x6b2d0f, [0.4, 0.5, 0.4], [-0.32, 0.5, 0]), limb(0x6b2d0f, [0.4, 0.5, 0.4], [0.32, 0.5, 0])];
    add(0xff7b29, [1.3, 1.1, 1.0], [0, 1.05, 0]);
    add(0xffb36b, [0.7, 0.5, 0.05], [0, 0.9, 0.51]);
    for (const x of [-0.3, 0.3]) {
      add(0xffffff, [0.3, 0.22, 0.05], [x, 1.25, 0.51]);
      add(0xff0040, [0.12, 0.12, 0.06], [x, 1.25, 0.54], 0xff0040);
      add(0x2b1a0f, [0.15, 0.35, 0.15], [x * 1.7, 1.75, 0]);
    }
    add(0xffd23f, [0.9, 0.15, 0.6], [0, 1.68, 0], 0x553300);
    for (const x of [-0.35, 0, 0.35]) add(0xffd23f, [0.15, 0.2, 0.15], [x, 1.85, 0], 0x553300);
    arms = [limb(0xd9631c, [0.3, 0.8, 0.3], [-0.82, 1.45, 0.05]), limb(0xd9631c, [0.3, 0.8, 0.3], [0.82, 1.45, 0.05])];
    colors = [0xff7b29, 0xffd23f, 0x6b2d0f];
  }

  return { group, legs, arms, colors, materials: [...mats.values()] };
}

import { DEFAULT_SKIN } from './skins.js';

export { DEFAULT_SKIN };

/** View models for each weapon in rules.WEAPONS: 'pulse' | 'scatter' | 'rail'. */
export function buildGun(variant = 'pulse') {
  const { group, add } = builder();
  let body;
  let glow;
  let accent;
  let muzzleZ;
  if (variant === 'scatter') {
    body = add(DEFAULT_SKIN.body, [0.16, 0.16, 0.42], [0, 0, 0]);
    add(0x1a1a24, [0.07, 0.07, 0.34], [-0.04, 0.03, -0.36]);
    add(0x1a1a24, [0.07, 0.07, 0.34], [0.04, 0.03, -0.36]);
    add(0x1a1a24, [0.13, 0.06, 0.16], [0, -0.06, -0.28]); // pump
    glow = add(DEFAULT_SKIN.glow, [0.17, 0.03, 0.2], [0, 0.085, 0.02], DEFAULT_SKIN.glow);
    add(0x1a1a24, [0.1, 0.18, 0.1], [0, -0.14, 0.1]);
    accent = add(DEFAULT_SKIN.accent, [0.18, 0.04, 0.04], [0, 0, -0.2], DEFAULT_SKIN.accent);
    add(DEFAULT_SKIN.body, [0.12, 0.14, 0.16], [0, -0.02, 0.28]);
    muzzleZ = -0.55;
  } else if (variant === 'rail') {
    body = add(DEFAULT_SKIN.body, [0.11, 0.13, 0.5], [0, 0, 0.02]);
    add(0x1a1a24, [0.05, 0.05, 0.42], [0, 0.02, -0.44]);
    glow = add(DEFAULT_SKIN.glow, [0.03, 0.08, 0.44], [0.06, 0.02, -0.4], DEFAULT_SKIN.glow);
    add(DEFAULT_SKIN.glow, [0.03, 0.08, 0.44], [-0.06, 0.02, -0.4], DEFAULT_SKIN.glow);
    add(0x1a1a24, [0.09, 0.18, 0.1], [0, -0.13, 0.1]);
    accent = add(DEFAULT_SKIN.accent, [0.07, 0.07, 0.07], [0, 0.11, 0.08], DEFAULT_SKIN.accent);
    add(0x1a1a24, [0.06, 0.05, 0.18], [0, 0.12, -0.06]); // scope
    add(DEFAULT_SKIN.body, [0.1, 0.12, 0.18], [0, -0.02, 0.32]);
    muzzleZ = -0.68;
  } else {
    body = add(DEFAULT_SKIN.body, [0.12, 0.14, 0.45], [0, 0, 0]);
    add(0x1a1a24, [0.07, 0.07, 0.3], [0, 0.02, -0.35]);
    glow = add(DEFAULT_SKIN.glow, [0.13, 0.03, 0.3], [0, 0.075, -0.02], DEFAULT_SKIN.glow);
    add(0x1a1a24, [0.09, 0.18, 0.1], [0, -0.13, 0.08]);
    accent = add(DEFAULT_SKIN.accent, [0.05, 0.05, 0.05], [0, 0.1, 0.12], DEFAULT_SKIN.accent);
    add(DEFAULT_SKIN.body, [0.1, 0.12, 0.15], [0, -0.02, 0.28]); // stock shares the body material
    muzzleZ = -0.52;
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, muzzleZ);
  group.add(muzzle);
  const flash = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
  flash.scale.setScalar(0.12);
  flash.position.copy(muzzle.position);
  flash.visible = false;
  group.add(flash);
  const skinMaterials = { body: body.material, glow: glow.material, accent: accent.material };
  return { group, muzzle, flash, skinMaterials };
}

const POWERUP_LOOK = {
  rapid: [0xffd23f, 0xff7b29],
  double: [0xc77dff, 0xffffff],
  shield: [0x3fa9ff, 0xffffff],
};

export function buildPickup(kind) {
  const { group, add, mats } = builder();
  if (kind === 'token') {
    add(0xffd23f, [0.5, 0.5, 0.12], [0, 0, 0], 0x664400);
    add(0xfff09a, [0.22, 0.22, 0.14], [0, 0, 0], 0x886600);
  } else if (POWERUP_LOOK[kind]) {
    const [outer, inner] = POWERUP_LOOK[kind];
    add(outer, [0.42, 0.42, 0.42], [0, 0, 0], outer);
    add(inner, [0.2, 0.2, 0.46], [0, 0, 0], inner);
    add(inner, [0.46, 0.2, 0.2], [0, 0, 0], inner);
  } else {
    add(0x2fd16b, [0.45, 0.45, 0.45], [0, 0, 0], 0x0a4a20);
    add(0xffffff, [0.3, 0.1, 0.47], [0, 0, 0], 0x666666);
    add(0xffffff, [0.1, 0.3, 0.47], [0, 0, 0], 0x666666);
  }
  return { group, materials: [...mats.values()] };
}
