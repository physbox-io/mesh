// ---------------------------------------------------------------------------
// Putting linear motion to work: what rides on what, and what is fixed to it
//
// A slide is between a body and its parent, so a printed carriage that has to
// run on a rod cannot simply be told so — the rod is already some other body's
// child, or nobody's. What makes it run is a weld from the printed part to the
// bushing (or rail carriage, or drawer member), which IS on the slide. These
// work out those welds, and where the moving piece has to start so the part
// does not jump to it, and say in one sentence why when they cannot.
//
// PURE: each takes a scene (already cloned by the caller) and edits it.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwarePart, SceneGraph, SceneNode } from '../types/scene';
import { csgFrameOffset, sourcePositiveBounds } from './csg';
import { documentWorldMatrix, hardwarePartNode } from './hardwareParts';
import { hardwareSpecOf } from './hardwareCuts';
import { isBoughtIn } from './boughtIn';
import { LM_UU, RUNNER_LENGTHS, RUNNER_SIDE_SPACE_MM } from './linearParts';

type Outcome = { ok: true; ids?: string[] } | { ok: false; problem: string };

function all(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const n of nodes) { out.push(n); all(n.children || [], out); }
  return out;
}
const byId = (scene: SceneGraph, id: string) => all(scene.nodes).find((n) => n.id === id) ?? null;
const carriageOf = (part: SceneNode) => all(part.children || []).find((c) => c.hardwarePart?.piece === 'carriage') ?? null;

/** Bodies welded to a moving piece: what rides on it. */
export function riders(scene: SceneGraph, pieceId: string): SceneNode[] {
  return all(scene.nodes).filter((n) => n.weldTargetId === pieceId);
}

/**
 * Welds `bodyId` to a moving piece, so it rides it. Refuses a body already
 * welded to something else, a bought part, and the piece's own part.
 */
export function fixToPiece(scene: SceneGraph, pieceId: string, bodyId: string): Outcome {
  const piece = byId(scene, pieceId);
  const body = byId(scene, bodyId);
  if (!piece?.hardwarePart?.piece) return { ok: false, problem: 'That is not a moving piece of a rail, rod or runner.' };
  if (!body) return { ok: false, problem: `No body '${bodyId}'.` };
  if (isBoughtIn(body)) return { ok: false, problem: `${body.name} is a bought part; fix the part it belongs to.` };
  if (all([body]).some((n) => n.id === pieceId)) return { ok: false, problem: `${body.name} carries this piece; it cannot ride on it.` };
  if (body.weldTargetId && body.weldTargetId !== pieceId) {
    const other = byId(scene, body.weldTargetId);
    return { ok: false, problem: `${body.name} is already welded to ${other?.name ?? body.weldTargetId}; take that off first.` };
  }
  body.weldTargetId = pieceId;
  return { ok: true };
}

/**
 * A part with a bushing housing rides the rod on the housing's line: the rod's
 * bushing is moved along its slide to where the housing is, and the part is
 * welded to it.
 */
export function rideOnRod(scene: SceneGraph, hostId: string, group: string): Outcome {
  const host = byId(scene, hostId);
  const spec = host && hardwareSpecOf(host.geoms || [], group);
  if (!host || !spec || spec.kind !== 'lm_housing') return { ok: false, problem: 'That is not a bushing housing.' };
  const pocket = host.geoms.find((g) => g.hardware?.group === group && g.hardware.part === 'pocket' && !g.csgDerived);
  const hostWorld = documentWorldMatrix(scene, hostId);
  if (!pocket?.pos || !pocket.size || !hostWorld) return { ok: false, problem: 'The housing has not been placed yet.' };
  const [, bushLen] = LM_UU[spec.size];
  // Where the bushing's middle goes: down the pocket by half its length.
  const n = new THREE.Vector3(...(spec.normal as [number, number, number])).normalize();
  const offset = new THREE.Vector3(...(csgFrameOffset(host) as [number, number, number]));
  const centre = new THREE.Vector3(...(pocket.pos as [number, number, number]))
    .addScaledVector(n, (bushLen / 1000) / 2 - (pocket.size[1] ?? 0))
    .sub(offset).applyMatrix4(hostWorld);
  const axis = n.clone().transformDirection(hostWorld);

  for (const rod of all(scene.nodes)) {
    if (rod.hardwarePart?.kind !== 'linear_rod' || rod.hardwarePart.piece || rod.hardwarePart.size !== spec.size) continue;
    const world = documentWorldMatrix(scene, rod.id);
    const bush = carriageOf(rod);
    if (!world || !bush) continue;
    const origin = new THREE.Vector3().setFromMatrixPosition(world);
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(world);
    if (Math.abs(dir.dot(axis)) < 0.999) continue;
    const along = centre.clone().sub(origin).dot(dir);
    if (centre.clone().sub(origin).addScaledVector(dir, -along).length() > 0.0005) continue;
    const travel = ((rod.hardwarePart.lengthMm ?? 0) - bushLen) / 2000;
    if (Math.abs(along) > travel + 1e-6) {
      return { ok: false, problem: `The housing is ${((Math.abs(along) - travel) * 1000).toFixed(1)} mm past the end of the bushing's travel on ${rod.name}.` };
    }
    const ridden = riders(scene, bush.id).filter((r) => r.id !== hostId);
    if (ridden.length) return { ok: false, problem: `${ridden[0].name} already rides that bushing; give this part a rod of its own.` };
    // The bushing starts where the housing is, and can still go to both ends.
    bush.pos = [0, 0, +along.toFixed(6)];
    const slide = bush.joints.find((j) => j.type === 'slide');
    if (slide) slide.range = [+(-travel - along).toFixed(6), +(travel - along).toFixed(6)];
    return fixToPiece(scene, bush.id, hostId);
  }
  return { ok: false, problem: `No Ø${spec.size} rod runs through this housing. Put the rod on its line first.` };
}

interface Box { min: THREE.Vector3; max: THREE.Vector3 }

function worldBox(scene: SceneGraph, node: SceneNode): Box | null {
  const b = sourcePositiveBounds(node);
  const m = documentWorldMatrix(scene, node.id);
  if (!b || !m) return null;
  const off = csgFrameOffset(node);
  const box = new THREE.Box3();
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    box.expandByPoint(new THREE.Vector3(x - (off[0] ?? 0), y - (off[1] ?? 0), z - (off[2] ?? 0)).applyMatrix4(m));
  }
  return { min: box.min, max: box.max };
}

/**
 * A pair of drawer runners for a drawer standing in its cabinet: sized to the
 * drawer's depth, one each side against it, the cabinet members fixed in the
 * cabinet and the drawer welded to a drawer member. Which way the drawer comes out
 * is read off the cabinet: its front is the side the drawer is flush with.
 */
export function addDrawerRunners(scene: SceneGraph, drawerId: string, newId: () => string): Outcome {
  const drawer = byId(scene, drawerId);
  if (!drawer || isBoughtIn(drawer)) return { ok: false, problem: 'Select the drawer: runners go on its sides.' };
  const d = worldBox(scene, drawer);
  if (!d) return { ok: false, problem: `${drawer.name} has no solid to put runners on.` };
  // The cabinet: the smallest other body round the drawer.
  let carcass: SceneNode | null = null;
  let carcassBox: Box | null = null;
  for (const n of all(scene.nodes)) {
    if (n.id === drawerId || isBoughtIn(n) || all([n]).some((c) => c.id === drawerId) || all([drawer]).some((c) => c.id === n.id)) continue;
    const b = worldBox(scene, n);
    if (!b || !(b.min.x <= d.min.x + 1e-4 && b.min.y <= d.min.y + 1e-4 && b.max.x >= d.max.x - 1e-4 && b.max.y >= d.max.y - 1e-4)) continue;
    const vol = (x: Box) => (x.max.x - x.min.x) * (x.max.y - x.min.y) * (x.max.z - x.min.z);
    if (!carcassBox || vol(b) < vol(carcassBox)) { carcass = n; carcassBox = b; }
  }
  if (!carcass || !carcassBox) return { ok: false, problem: `Stand ${drawer.name} inside its cabinet first: the runners are fixed to the cabinet.` };

  // The front is the cabinet side the drawer is flush with.
  const gaps: { axis: 'x' | 'y'; sign: 1 | -1; gap: number }[] = [
    { axis: 'x', sign: -1, gap: d.min.x - carcassBox.min.x }, { axis: 'x', sign: 1, gap: carcassBox.max.x - d.max.x },
    { axis: 'y', sign: -1, gap: d.min.y - carcassBox.min.y }, { axis: 'y', sign: 1, gap: carcassBox.max.y - d.max.y },
  ];
  const front = gaps.reduce((a, b) => (b.gap < a.gap ? b : a));
  const f = new THREE.Vector3(front.axis === 'x' ? front.sign : 0, front.axis === 'y' ? front.sign : 0, 0);
  const across: 'x' | 'y' = front.axis === 'x' ? 'y' : 'x';
  const depthMm = (front.axis === 'x' ? d.max.x - d.min.x : d.max.y - d.min.y) * 1000;
  const length = [...RUNNER_LENGTHS].reverse().find((l) => Number(l) <= depthMm + 1e-6);
  if (!length) return { ok: false, problem: `${drawer.name} is ${depthMm.toFixed(0)} mm deep; the shortest runner is ${RUNNER_LENGTHS[0]} mm.` };

  const L = Number(length) / 1000;
  const cabinetFrame = documentWorldMatrix(scene, carcass.id);
  if (!cabinetFrame) return { ok: false, problem: `${carcass.name} is not in the scene.` };
  const frontPlane = front.sign > 0 ? (front.axis === 'x' ? d.max.x : d.max.y) : (front.axis === 'x' ? d.min.x : d.min.y);
  const height = d.max.z - d.min.z;
  // Low on the drawer's side, or in the middle of a shallow one.
  const z = height < 0.055 ? (d.min.z + d.max.z) / 2 : d.min.z + 0.0275;
  const t = RUNNER_SIDE_SPACE_MM / 1000;
  const ids: string[] = [];
  let first: SceneNode | null = null;
  for (const side of [-1, 1] as const) {
    const sideFace = side < 0 ? (across === 'x' ? d.min.x : d.min.y) : (across === 'x' ? d.max.x : d.max.y);
    // Its +Y toward the drawer, so the drawer member is on the drawer's side.
    const y = new THREE.Vector3(across === 'x' ? -side : 0, across === 'y' ? -side : 0, 0);
    const basis = new THREE.Matrix4().makeBasis(f, y, f.clone().cross(y));
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);
    const centreAcross = sideFace + side * (t / 2);
    const back = frontPlane - front.sign * L;
    const pos = new THREE.Vector3(
      front.axis === 'x' ? back : centreAcross,
      front.axis === 'y' ? back : centreAcross,
      z,
    );
    const id = newId();
    const part: HardwarePart = { kind: 'drawer_runner', size: length };
    const runner = hardwarePartNode(part, id);
    // Screwed to the cabinet: a rigid child of it, as a seated part is. A weld
    // here would leave a 200 g runner carrying the drawer on a soft constraint,
    // and the drawer would sag onto the cabinet floor.
    const local = cabinetFrame.clone().invert().multiply(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
    const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
    local.decompose(lp, lq, new THREE.Vector3());
    runner.pos = lp.toArray().map((v) => +v.toFixed(6));
    runner.quat = [lq.w, lq.x, lq.y, lq.z].map((v) => +v.toFixed(9));
    runner.joints = [];
    // Hard against the cabinet's wall: what holds it is the hierarchy, not contacts.
    for (const g of runner.geoms) if (g.role !== 'visual') { g.contype = 0; g.conaffinity = 0; }
    carcass.children = [...(carcass.children || []), runner];
    ids.push(id);
    const slide = carriageOf(runner)!;
    if (!first) {
      first = runner;
      if (drawer.weldTargetId && drawer.weldTargetId !== slide.id) {
        return { ok: false, problem: `${drawer.name} is already welded to something; take that off first.` };
      }
      drawer.weldTargetId = slide.id;
    } else {
      // The second runner follows the first slide for slide, rather than being
      // welded to the drawer as well: two welds round one loop fight each
      // other, and pull the drawer past its stops.
      const middle = runner.children[0];
      const firstMiddle = first.children[0];
      middle.coupleTargetId = firstMiddle.id;
      middle.coupleRatio = 1;
      slide.coupleTargetId = carriageOf(first)!.id;
      slide.coupleRatio = 1;
    }
  }
  return { ok: true, ids };
}
