// ---------------------------------------------------------------------------
// Hardware checks: will it seal, and will the screw hold?
//
// SEALS.
// A static O-ring seal leaks for a handful of reasons, and every one of them is
// geometry: squeezed too little it leaks, too much and it is crushed or the lid
// will not close; a groove too full has nowhere for the rubber to go; a ring
// stretched too far thins and lets go; and a lid that does not cover the whole
// groove leaves a stretch of ring pressing on nothing. None of that needs a
// fluid simulation. It needs the groove (from its cut) and whatever presses on
// it (from where the other parts actually are), measured against each other.
//
// So for each O-ring groove this casts short rays from the ring's line out of
// the groove, into the other bodies: up out of a face groove into the lid,
// out from a piston groove into the bore, in from a bore groove onto the shaft.
// The distance each ray goes before it meets something is the room the ring
// has there, and squeeze, fill and coverage follow from it.
//
// SCREWS. A cap screw's head bears on the plastic under it, and too little of
// that and the head pulls through when the screw is tightened or loaded: the
// one way a seated screw fails that its geometry shows.
//
// PURE, like dfm.ts: a scene in, findings out.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { DfmFinding, DfmProcess } from './dfm';
import { isBoughtIn } from './boughtIn';
import { appendSolidTriangles } from './contourSliceExporter';
import { csgFrameOffset, resolveCsgGeoms, surfaceUnder } from './csg';
import { getNodeWorldTransform } from './laserCutExporter';
import { GLANDS, O_RINGS, SEAL_LIMITS } from './hardwareSizes';
import { cordOf, seatFor } from './hardwareParts';
import { metricThread } from './metricThreads';
import { rimCentreline } from './sealGrooves';
import { RUNNER_SIDE_SPACE_MM } from './linearParts';
import { rigidBodies } from './linearPlacement';

/** Rays per groove: enough to find a lid that misses a corner. */
const SAMPLES = 16;
/** How far past the groove a mating surface is looked for, m. */
const REACH = 0.01;
/** Rays start this far back inside the groove, so a lid already pressed in is still found, m. */
const BACK = 0.0005;

interface Body { id: string; tris: Float64Array }

function bodiesOf(scene: SceneGraph): { bodies: Body[]; worlds: Map<string, THREE.Matrix4> } {
  const bodies: Body[] = [];
  const worlds = new Map<string, THREE.Matrix4>();
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      worlds.set(n.id, world);
      if (!isBoughtIn(n) && !n.simulation) {
        const out: number[] = [];
        for (const g of resolveCsgGeoms(n, 'render')) if (g.role !== 'collision') appendSolidTriangles(g, world, out);
        if (out.length) bodies.push({ id: n.id, tris: Float64Array.from(out) });
      }
      walk(n.children || [], world);
    }
  };
  walk(scene.nodes || []);
  return { bodies, worlds };
}

/** Nearest hit along a ray against one body's triangles, or Infinity. Möller–Trumbore. */
function rayHit(tris: Float64Array, o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
  let best = Infinity;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3(), s = new THREE.Vector3();
  for (let t = 0; t + 8 < tris.length; t += 9) {
    e1.set(tris[t + 3] - tris[t], tris[t + 4] - tris[t + 1], tris[t + 5] - tris[t + 2]);
    e2.set(tris[t + 6] - tris[t], tris[t + 7] - tris[t + 1], tris[t + 8] - tris[t + 2]);
    p.crossVectors(d, e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-18) continue;
    const inv = 1 / det;
    s.set(o.x - tris[t], o.y - tris[t + 1], o.z - tris[t + 2]);
    const u = s.dot(p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    q.crossVectors(s, e1);
    const v = d.dot(q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = e2.dot(q) * inv;
    if (dist > 0 && dist < best && dist <= maxT) best = dist;
  }
  return best;
}

interface Ray { from: THREE.Vector3; dir: THREE.Vector3 }

/** The rays for one groove, in world space, each starting on the ring's line; and how the ring is held there. */
function groovRays(host: SceneNode, world: THREE.Matrix4, g: SceneGeom): { rays: Ray[]; floorM: number; widthM: number; floorRadiusM?: number; radial: boolean; centre: THREE.Vector3 } | null {
  const offset = new THREE.Vector3(...(csgFrameOffset(host) as [number, number, number]));
  const toWorld = (p: THREE.Vector3) => p.clone().sub(offset).applyMatrix4(world);
  const turn = new THREE.Matrix3().setFromMatrix4(world);
  const dirWorld = (v: THREE.Vector3) => v.clone().applyMatrix3(turn).normalize();
  const n = new THREE.Vector3(...((g.cutNormal ?? [0, 0, 1]) as [number, number, number])).normalize();
  const depth = g.cutDepth ?? 0;
  const seal = g.hardware?.seal;

  if (g.type === 'mesh') {
    const path = rimCentreline(g);
    if (!path || !g.cutOutline) return null;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    if (g.cutTwist) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), g.cutTwist));
    const under = surfaceUnder(host, g.cutAt ?? [0, 0, 0], g.cutNormal ?? [0, 0, 1], g);
    const entry = new THREE.Vector3(...((under?.entry ?? g.cutAt ?? [0, 0, 0]) as [number, number, number]));
    const rays: Ray[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const [x, y] = path[Math.floor((i / SAMPLES) * path.length)];
      const p = new THREE.Vector3(x, y, 0).applyQuaternion(q).add(entry);
      rays.push({ from: toWorld(p), dir: dirWorld(n) });
    }
    const outer = g.cutOutline, inner = g.cutHoles?.[0];
    const width = inner ? Math.hypot(outer[0][0] - inner[inner.length - 1][0], outer[0][1] - inner[inner.length - 1][1]) : 0;
    return { rays, floorM: depth, widthM: width, radial: false, centre: toWorld(entry) };
  }

  if (!g.pos || !g.quat || !g.size) return null;
  const centre = new THREE.Vector3(...(g.pos as [number, number, number]));
  const q = new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
  const outer = g.size[0];
  const inner = g.ringInner ?? 0;
  const rays: Ray[] = [];
  const radial = seal === 'piston' || seal === 'bore';
  if (radial) {
    // Out from the floor of a piston groove into the bore; in from the floor
    // of a bore groove onto the shaft.
    const floor = seal === 'piston' ? inner : outer;
    for (let i = 0; i < SAMPLES; i++) {
      // Half a step round, off the seams a round part is tessellated along.
      const a = ((i + 0.5) / SAMPLES) * Math.PI * 2;
      const r = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).applyQuaternion(q);
      const p = centre.clone().addScaledVector(r, floor);
      rays.push({ from: toWorld(p), dir: dirWorld(seal === 'piston' ? r : r.clone().negate()) });
    }
    return { rays, floorM: 0, widthM: (g.size[1] ?? 0) * 2, floorRadiusM: floor, radial, centre: toWorld(centre) };
  }
  // A face groove: up out of its floor, round the ring's line.
  const entry = centre.clone().addScaledVector(n, depth - (g.size[1] ?? 0));
  const line = (outer + inner) / 2;
  for (let i = 0; i < SAMPLES; i++) {
    // Half a step round, off the seams a round part is tessellated along.
      const a = ((i + 0.5) / SAMPLES) * Math.PI * 2;
    const p = entry.clone().add(new THREE.Vector3(Math.cos(a) * line, Math.sin(a) * line, 0).applyQuaternion(q));
    rays.push({ from: toWorld(p), dir: dirWorld(n) });
  }
  return { rays, floorM: depth, widthM: outer - inner, radial, centre: toWorld(entry) };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mmText = (m: number) => `${(m * 1000).toFixed(2).replace(/\.?0+$/, '')} mm`;

/**
 * Every hardware finding for the bodies in `scene`, measured against what is
 * around them in `whole` (the full scene, when only one body is analysed).
 */
export function hardwareFindings(scene: SceneGraph, process: DfmProcess, whole: SceneGraph = scene): DfmFinding[] {
  return [...sealFindings(scene, process, whole), ...screwFindings(scene, process, whole), ...runnerFindings(scene, process, whole)];
}

/** How far side space may be off a runner's 12.7 mm before the drawer binds or falls off it, mm. */
const SIDE_SPACE_SLACK_MM = 0.5;

/**
 * One finding per drawer runner whose side space is wrong: the gap from the
 * drawer's side to the cabinet's, measured across the runner, against the
 * 12.7 mm every ball-bearing runner is made for. Too little and the drawer
 * binds; too much and the runner cannot reach both. The commonest drawer
 * mistake there is, and one a ruler finds only once it is built.
 */
export function runnerFindings(scene: SceneGraph, process: DfmProcess, whole: SceneGraph = scene): DfmFinding[] {
  const { bodies, worlds } = bodiesOf(whole);
  const everything: SceneNode[] = [];
  const collect = (nodes: SceneNode[]) => { for (const n of nodes) { everything.push(n); collect(n.children || []); } };
  collect(whole.nodes || []);
  const out: DfmFinding[] = [];
  const mine: SceneNode[] = [];
  const pick = (nodes: SceneNode[]) => { for (const n of nodes) { if (n.hardwarePart?.kind === 'drawer_runner' && !n.hardwarePart.piece) mine.push(n); pick(n.children || []); } };
  pick(scene.nodes || []);
  const parentOf = new Map<string, string>();
  const link = (nodes: SceneNode[]) => { for (const n of nodes) { for (const c of n.children || []) parentOf.set(c.id, n.id); link(n.children || []); } };
  link(whole.nodes || []);
  for (const runner of mine) {
    // Fixed in its cabinet, or welded to it.
    const carcass = parentOf.get(runner.id) ?? runner.weldTargetId;
    const slide = everything.find((n) => n.id === `${runner.id}_carriage`);
    // The drawer rides this slide, or the one this slide is coupled to.
    const led = slide?.coupleTargetId ?? slide?.id;
    const drawer = led && everything.find((n) => n.weldTargetId === led)?.id;
    const world = worlds.get(runner.id);
    if (!carcass || !drawer || !world) continue;
    const L = Number(runner.hardwarePart!.size) / 1000;
    const middle = new THREE.Vector3(L / 2, 0, 0).applyMatrix4(world);
    const toward = new THREE.Vector3(0, 1, 0).transformDirection(world);
    // Against the whole drawer and the whole cabinet: either may be built of boards.
    const reach = (id: string, dir: THREE.Vector3) => {
      const root = everything.find((n) => n.id === id);
      const ids = new Set(root ? rigidBodies(root).map((n) => n.id) : [id]);
      let best = Infinity;
      for (const b of bodies) if (ids.has(b.id)) best = Math.min(best, rayHit(b.tris, middle, dir, 0.05));
      return best;
    };
    const space = (reach(drawer, toward) + reach(carcass, toward.clone().negate())) * 1000;
    if (!Number.isFinite(space)) continue;
    const off = space - RUNNER_SIDE_SPACE_MM;
    if (Math.abs(off) <= SIDE_SPACE_SLACK_MM) continue;
    const by = `${(Math.abs(off) * 2).toFixed(1)} mm`;
    out.push({
      id: `runner_${runner.id}`, process, severity: 'critical',
      title: `${runner.name}: ${space.toFixed(1)} mm side space`,
      detail: `Ball-bearing runners take ${RUNNER_SIDE_SPACE_MM} mm each side of the drawer, ±${SIDE_SPACE_SLACK_MM}; this one has ${space.toFixed(1)} mm, so the drawer ${off < 0 ? 'binds' : 'will not reach both runners'}.`,
      fix: off < 0 ? `Make the drawer ${by} narrower, or the cabinet that much wider inside.` : `Make the drawer ${by} wider, or the cabinet that much narrower inside.`,
      position: middle.toArray() as [number, number, number],
      metric: space,
    });
  }
  return out;
}

/** Plastic under a cap screw's head, in screw diameters, below which it pulls through. */
const UNDER_HEAD_DIAMETERS = 1.2;

/** One finding per seated cap screw with too little under its head. */
export function screwFindings(scene: SceneGraph, process: DfmProcess, whole: SceneGraph = scene): DfmFinding[] {
  const { worlds } = bodiesOf(whole);
  const out: DfmFinding[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const host of nodes) {
      for (const child of host.children || []) {
        const p = child.hardwarePart;
        if (p?.kind !== 'screw' || !p.seat) continue;
        const kind = host.geoms.find((g) => g.hardware?.group === p.seat)?.hardware?.kind;
        if (kind !== 'counterbore') continue;
        const grip = seatFor(host, p.seat, 'screw')?.gripM;
        const d = (metricThread(p.size)?.[1] ?? 3) / 1000;
        if (grip === undefined || grip >= UNDER_HEAD_DIAMETERS * d) continue;
        const world = worlds.get(child.id);
        out.push({
          id: `screw_${child.id}`, process, severity: 'warning',
          title: `${p.size} screw: ${mmText(grip)} under its head`,
          detail: `The head of ${child.name} bears on ${mmText(grip)} of ${host.name}; under ${mmText(UNDER_HEAD_DIAMETERS * d)} it pulls through when it is done up tight.`,
          fix: `Sink the counterbore ${mmText(UNDER_HEAD_DIAMETERS * d - grip)} less, or make the part that much thicker under it.`,
          position: (world ? new THREE.Vector3().setFromMatrixPosition(world).toArray() : [0, 0, 0]) as [number, number, number],
          metric: grip * 1000,
        });
      }
      walk(host.children || []);
    }
  };
  walk(scene.nodes || []);
  return out;
}

/** One finding per O-ring groove in the scene: whether it seals, and if not, what to change. */
export function sealFindings(scene: SceneGraph, process: DfmProcess, whole: SceneGraph = scene): DfmFinding[] {
  const grooves: { host: SceneNode; g: SceneGeom }[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const n of nodes) {
      for (const g of n.geoms || []) {
        if (!g.csgDerived && g.hardware?.part === 'groove' && (g.hardware.kind === 'oring' || g.hardware.kind === 'seal_cord')) grooves.push({ host: n, g });
      }
      walk(n.children || []);
    }
  };
  walk(scene.nodes || []);
  if (!grooves.length) return [];

  const { bodies, worlds } = bodiesOf(whole);
  const out: DfmFinding[] = [];
  for (const { host, g } of grooves) {
    const world = worlds.get(host.id);
    const geo = world && groovRays(host, world, g);
    if (!geo) continue;
    const size = g.hardware!.size;
    const cord = cordOf(size) / 1000;
    const label = g.hardware!.kind === 'seal_cord' ? `Ø${size} cord seal` : `${size} O-ring`;
    const position = geo.centre.toArray() as [number, number, number];
    const finding = (severity: DfmFinding['severity'], title: string, detail: string, fix: string, metric?: number): DfmFinding => ({
      id: `seal_${host.id}_${g.hardware!.group}`, process, severity, title, detail, fix, position, ...(metric !== undefined ? { metric } : {}),
    });

    // The room the ring has at each sample, past the groove floor (radial) or the face (axial).
    const gaps: number[] = [];
    for (const ray of geo.rays) {
      const o = ray.from.clone().addScaledVector(ray.dir, -BACK);
      let best = Infinity;
      for (const b of bodies) if (b.id !== host.id) best = Math.min(best, rayHit(b.tris, o, ray.dir, REACH + BACK));
      if (Number.isFinite(best)) gaps.push(best - BACK);
    }
    if (gaps.length === 0) {
      out.push(finding('info', `${label}: nothing presses on it yet`,
        `No part sits within ${mmText(REACH)} of the groove in ${host.name}, so the seal cannot be checked.`,
        geo.radial ? 'Put the part it seals against in place: the bore over the boss, or the shaft through the bore.' : 'Put the lid in place over the groove.'));
      continue;
    }
    if (gaps.length < geo.rays.length) {
      out.push(finding('critical', `${label}: the mating part misses part of the ring`,
        `Only ${gaps.length} of ${geo.rays.length} points round the groove in ${host.name} have anything over them; the rest of the ring presses on nothing and leaks there.`,
        'Line the mating part up over the whole groove, or move the groove inside its edge.'));
      continue;
    }
    // Room for the cord: the groove's depth plus the gap to the lid (axial),
    // or the radial gap from the floor to the mating wall.
    const room = (gap: number) => (geo.radial ? gap : geo.floorM + gap);
    const loose = room(Math.max(...gaps));
    const tight = room(Math.min(...gaps));
    const squeezeLow = (cord - loose) / cord;
    const squeezeHigh = (cord - tight) / cord;
    const fill = (Math.PI * cord * cord / 4) / (geo.widthM * Math.max(tight, 1e-6));
    // The room the gland table gives this cord: what a fix aims for.
    const gland = GLANDS[String(cordOf(size))];
    const targetRoom = gland ? (geo.radial ? gland.radial[0] : gland.face[0]) / 1000 : cord * 0.78;

    const stretch = (() => {
      const ring = O_RINGS[size];
      if (!ring || !geo.radial || geo.floorRadiusM === undefined) return 0;
      const idR = ring[0] / 2000;
      // On a piston groove's floor, or on the shaft through a bore groove.
      const onto = g.hardware!.seal === 'piston' ? geo.floorRadiusM : geo.floorRadiusM - Math.min(...gaps);
      return onto / idR - 1;
    })();

    const where = geo.radial ? (g.hardware!.seal === 'piston' ? 'the bore' : 'the shaft') : 'the lid';
    if (squeezeLow < SEAL_LIMITS.squeezeMin) {
      const move = loose - targetRoom;
      out.push(finding('critical', `${label}: squeezed only ${pct(Math.max(0, squeezeLow))}`,
        `The ring has ${mmText(loose)} of room for a ${mmText(cord)} cord; under ${pct(SEAL_LIMITS.squeezeMin)} squeeze it leaks.`,
        geo.radial
          ? `Make ${where} ${mmText(move * 2)} smaller across, or use a thicker cord.`
          : `Bring ${where} ${mmText(move)} closer, or use a thicker cord.`,
        squeezeLow));
      continue;
    }
    if (squeezeHigh > SEAL_LIMITS.squeezeMax) {
      const move = targetRoom - tight;
      out.push(finding('critical', `${label}: crushed, ${pct(squeezeHigh)} squeeze`,
        `The ring has only ${mmText(tight)} of room for a ${mmText(cord)} cord; past ${pct(SEAL_LIMITS.squeezeMax)} it takes a set, splits, or stops ${where} going home.`,
        geo.radial ? `Make ${where} ${mmText(move * 2)} bigger across.` : `Give the ring ${mmText(move)} more room: deepen the groove or stand ${where} off.`,
        squeezeHigh));
      continue;
    }
    if (fill > SEAL_LIMITS.fillMax) {
      const wide = (Math.PI * cord * cord / 4) / (0.72 * tight);
      out.push(finding('critical', `${label}: groove ${pct(fill)} full`,
        `Squeezed, the rubber has to go somewhere, and past ${pct(SEAL_LIMITS.fillMax)} full it is forced out of the groove and cut.`,
        `Widen the groove to ${mmText(wide)}.`, fill));
      continue;
    }
    if (stretch > SEAL_LIMITS.stretchMax) {
      out.push(finding('critical', `${label}: stretched ${pct(stretch)}`,
        `Past ${pct(SEAL_LIMITS.stretchMax)} the cord thins and the ring loses its grip.`,
        'Use a ring with a larger inside diameter.', stretch));
      continue;
    }
    const even = Math.abs(squeezeHigh - squeezeLow) < 0.05 ? '' : `, ${pct(squeezeLow)} to ${pct(squeezeHigh)} round the ring`;
    out.push({ ...finding('info', `${label}: seals`,
      `${pct((squeezeLow + squeezeHigh) / 2)} squeeze${even}, groove ${pct(fill)} full${stretch > 0.001 ? `, ${pct(stretch)} stretch` : ''}.`,
      'Print the walls it seals with 3 or more perimeters: thinner FDM walls weep however good the seal.'), passed: true });
  }
  return out;
}
