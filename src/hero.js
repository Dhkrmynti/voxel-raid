import * as THREE from 'three';
import { buildEnemyModel, floorTexture, starField, unitBox } from './game/voxel.js';

const PIXEL_SCALE = 4;

// Floating voxel island with the enemy roster, rendered behind the landing hero.
export function initHero(canvas, heroSection) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  } catch {
    return { setActive() {} };
  }
  renderer.setPixelRatio(1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0716);
  scene.fog = new THREE.Fog(0x0b0716, 14, 40);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

  scene.add(new THREE.HemisphereLight(0xb79bff, 0x1a0f2e, 1.6));
  const sun = new THREE.DirectionalLight(0xffd9f0, 2.2);
  sun.position.set(5, 10, 7);
  scene.add(sun);
  const pink = new THREE.PointLight(0xff3fa4, 12, 20, 1);
  pink.position.set(-4, 3, 3);
  const cyan = new THREE.PointLight(0x3ff2ff, 12, 20, 1);
  cyan.position.set(4, 2, -3);
  scene.add(pink, cyan);

  const world = new THREE.Group();
  scene.add(world);

  // Island: a disc of voxels that tapers downward
  const cells = [];
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) {
      const d = Math.hypot(x, z);
      for (let y = 0; y < 4; y++) if (d < 6.2 - y * 1.6) cells.push([x, -y, z, y]);
    }
  }
  const island = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ map: floorTexture() }), cells.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  cells.forEach(([x, y, z, depth], i) => {
    island.setMatrixAt(i, m.makeTranslation(x, y, z));
    if (depth === 0) c.set((x + z) % 2 === 0 ? 0xc9b8ff : 0xa58cf0);
    else c.set(depth === 1 ? 0x7a5fc0 : 0x4a3a7a);
    island.setColorAt(i, c);
  });
  world.add(island);

  const roster = [
    ['grunt', [-2.2, 0.5, 0.8], 0.4, 1],
    ['runner', [0.6, 0.5, 2.6], -0.1, 1],
    ['shooter', [2.6, 0.5, 0.4], -0.5, 1],
    ['boss', [0, 0.5, -2.4], 0, 1.7],
  ].map(([type, pos, rot, scale]) => {
    const model = buildEnemyModel(type);
    model.group.position.set(...pos);
    model.group.rotation.y = rot;
    model.group.scale.setScalar(scale);
    world.add(model.group);
    return { ...model, baseY: pos[1], seed: Math.random() * 6 };
  });

  const cubeMats = [0xff3fa4, 0x3ff2ff, 0xffd23f].map((color) => new THREE.MeshBasicMaterial({ color }));
  const cubes = [];
  for (let i = 0; i < 36; i++) {
    const mesh = new THREE.Mesh(unitBox, cubeMats[i % 3]);
    mesh.scale.setScalar(0.15 + Math.random() * 0.25);
    world.add(mesh);
    cubes.push({
      mesh,
      r: 7 + Math.random() * 4,
      a: Math.random() * Math.PI * 2,
      y: -2 + Math.random() * 8,
      s: 0.1 + Math.random() * 0.25,
    });
  }
  scene.add(starField(600, 80));

  const mouse = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX / window.innerWidth - 0.5;
    mouse.y = e.clientY / window.innerHeight - 0.5;
  });

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(Math.ceil(w / PIXEL_SCALE), Math.ceil(h / PIXEL_SCALE), false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const wide = w > 900;
    world.position.set(wide ? 4.6 : 0, wide ? 0 : -2.2, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  let active = true;
  let visible = true;
  let raf = null;
  const clock = new THREE.Clock();

  function frame() {
    if (!active || !visible) {
      raf = null;
      return;
    }
    raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    world.rotation.y = Math.sin(t * 0.2) * 0.5;
    for (const r of roster) {
      r.group.position.y = r.baseY + Math.abs(Math.sin(t * 2 + r.seed)) * 0.15;
      r.legs.forEach((l, i) => (l.rotation.x = Math.sin(t * 4 + r.seed + (i % 2) * Math.PI) * 0.5));
      r.arms.forEach((a, i) => (a.rotation.x = Math.sin(t * 4 + r.seed + (i % 2 ? 0 : Math.PI)) * 0.3));
    }
    for (const cb of cubes) {
      cb.a += cb.s * 0.016;
      cb.mesh.position.set(Math.cos(cb.a) * cb.r, cb.y + Math.sin(t + cb.a) * 0.5, Math.sin(cb.a) * cb.r);
      cb.mesh.rotation.x = cb.mesh.rotation.y = t + cb.a;
    }
    camera.position.x += (mouse.x * 2 - camera.position.x) * 0.05;
    camera.position.y += (5.5 - mouse.y * 1.5 - camera.position.y) * 0.05;
    camera.position.z = 15;
    camera.lookAt(0, 1, 0);
    renderer.render(scene, camera);
  }

  function kick() {
    if (active && visible && raf === null) {
      clock.getDelta();
      raf = requestAnimationFrame(frame);
    }
  }

  // Stop rendering once the hero has scrolled out of view
  if (heroSection && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      kick();
    }).observe(heroSection);
  }
  kick();

  return {
    setActive(v) {
      active = v;
      kick();
    },
  };
}
