import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import load_mujoco from '@mujoco/mujoco';
import { compileShirt } from './shirtScene.mjs';

const SEW_TIME = 1.0;
const stats = document.getElementById('stats');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 50);
camera.position.set(1.1, 1.5, 1.9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.25, 0);
controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 2);
scene.add(sun);
scene.add(new THREE.GridHelper(4, 40, 0x333842, 0x262a31));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// MuJoCo is Z-up; everything it owns hangs under this Y-up group.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

const mujoco = await load_mujoco();
let sim = null, meshes = [], stepTimes = [], sewDoneAt = null;

function clearWorld() {
  for (const o of [...world.children]) { world.remove(o); o.geometry?.dispose(); }
  meshes = [];
}

function buildBody(model, data) {
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9b39a, roughness: 0.8 });
  for (let g = 0; g < model.ngeom; g++) {
    const type = model.geom_type[g], s = model.geom_size.slice(3 * g, 3 * g + 3);
    let geo;
    if (type === 2) geo = new THREE.SphereGeometry(s[0], 24, 16);
    else if (type === 4) { geo = new THREE.SphereGeometry(1, 32, 20); geo.scale(s[0], s[1], s[2]); }
    else if (type === 3) { geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 20); geo.rotateX(Math.PI / 2); }
    else continue;
    const m = new THREE.Mesh(geo, skin);
    const p = data.geom_xpos, r = data.geom_xmat;
    const mat = new THREE.Matrix4().set(
      r[9 * g], r[9 * g + 1], r[9 * g + 2], p[3 * g],
      r[9 * g + 3], r[9 * g + 4], r[9 * g + 5], p[3 * g + 1],
      r[9 * g + 6], r[9 * g + 7], r[9 * g + 8], p[3 * g + 2],
      0, 0, 0, 1);
    m.matrixAutoUpdate = false;
    m.matrix.copy(mat);
    world.add(m);
  }
}

function buildCloth(model) {
  const colors = [0x3b7bd4, 0x2a5fa8];
  for (let f = 0; f < model.nflex; f++) {
    const vadr = model.flex_vertadr[f], vnum = model.flex_vertnum[f];
    const eadr = model.flex_elemdataadr[f], enum_ = model.flex_elemnum[f];
    const idx = Array.from(model.flex_elem.slice(eadr, eadr + 3 * enum_));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * vnum), 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ color: colors[f % 2], roughness: 0.95, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    world.add(mesh);
    meshes.push({ mesh, vadr, vnum });
  }
}

function syncCloth() {
  const xp = sim.data.flexvert_xpos;
  for (const { mesh, vadr, vnum } of meshes) {
    const pos = mesh.geometry.attributes.position;
    pos.array.set(xp.subarray ? xp.subarray(3 * vadr, 3 * (vadr + vnum)) : xp.slice(3 * vadr, 3 * (vadr + vnum)));
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
}

let compileMs = 0;
function restart() {
  if (sim) { sim.data.delete(); sim.model.delete(); sim = null; }
  clearWorld();
  stats.textContent = 'compiling…';
  setTimeout(() => {
    const spacing = Number(document.getElementById('spacing').value);
    const selfcollide = document.getElementById('self').checked ? 'auto' : 'none';
    const t = performance.now();
    sim = compileShirt(mujoco, { spacing, selfcollide });
    compileMs = performance.now() - t;
    stepTimes = []; sewDoneAt = null;
    buildBody(sim.model, sim.data);
    buildCloth(sim.model);
    syncCloth();
  }, 20);
}
document.getElementById('restart').onclick = restart;
document.getElementById('spacing').onchange = restart;
document.getElementById('self').onchange = restart;
restart();

let lastFrame = performance.now(), simPerWall = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const wallDt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (sim) {
    const { model, data } = sim;
    const target = data.time + wallDt;
    const budgetEnd = performance.now() + 25; // keep the page responsive
    const simStart = data.time, t0 = performance.now();
    let n = 0;
    while (data.time < target && performance.now() < budgetEnd) {
      sim.setSew(data.time / SEW_TIME);
      mujoco.mj_step(model, data);
      n++;
    }
    const spent = performance.now() - t0;
    if (n) { stepTimes.push(spent / n); if (stepTimes.length > 60) stepTimes.shift(); }
    simPerWall = 0.9 * simPerWall + 0.1 * ((data.time - simStart) / Math.max(wallDt, 1e-3));
    syncCloth();
    const gap = sim.seamGap() * 1000;
    if (sewDoneAt === null && gap < 5) sewDoneAt = data.time;
    const ms = stepTimes.reduce((a, b) => a + b, 0) / Math.max(1, stepTimes.length);
    stats.textContent =
      `MuJoCo ${mujoco.mj_versionString?.() ?? ''}\n` +
      `vertices     ${sim.nvert}\n` +
      `seam pairs   ${sim.pairs.length}\n` +
      `compile      ${compileMs.toFixed(0)} ms\n` +
      `step         ${ms.toFixed(2)} ms (dt ${model.opt.timestep * 1000} ms)\n` +
      `speed        ${(simPerWall * 100).toFixed(0)}% of real time\n` +
      `sim time     ${data.time.toFixed(2)} s\n` +
      `seam gap     ${gap.toFixed(1)} mm\n` +
      `sewn at      ${sewDoneAt === null ? '…' : sewDoneAt.toFixed(2) + ' s'}\n` +
      `contacts     ${data.ncon}`;
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
