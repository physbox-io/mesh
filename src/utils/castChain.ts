// ---------------------------------------------------------------------------
// One click from master to finished piece
// ---------------------------------------------------------------------------
//
// Add Simulation on a Mold tab runs the whole job, as the maker would:
//
//   - Silicone: pour silicone into the box round the master, take the mold
//     off and turn it over, cut vents where air would be trapped, and pour the
//     material in through the opening the master's foot left.
//   - Sand and Lost PLA: stand the printed pattern in the smallest flask that
//     holds it with enough cover, fill round it, take the pattern away, and pour
//     the metal down the sprue. The flask is illustrative; a real one is often
//     bigger, which changes only how much sand or investment goes in.
//
// Each finished piece is set the way the master stands and comes with what a
// maker weighs out and how far it is from the master. Pure apart from the
// geometry engine, so it runs on the mold worker. All lengths are mm, Z up.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { SceneGraph } from '../types/scene';
import type { IndexedMesh } from './stlMesh';
import { stlToMesh } from './stlMesh';
import { loadManifold } from './sculptCut';
import { manifoldToMeshMm } from './timberBreakdown';
import { castColumnSpans } from './columnSolid';
import { pourIntoCavity } from './pourCast';
import { pourNodeFor } from './pourTarget';
import { planPourBox, sceneWithPourBox, masterSoupMm } from './pourBoxScene';
import { simulateCastFromMoldNode } from './moldCastSimulation';
import { generateCastPattern, type CastOptions } from './castPatternExporter';
import { collectSceneTriangles } from './contourSliceExporter';
import { castMaterial, castMaterialWarnings, castWeightG, mixGrams, type CastMaterialId, type SiliconeId } from './castMaterials';
import type { PourBoxOptions } from './siliconeMold';

/** Narrower than this, mm across, and a pour will not go in through the opening. */
export { MIN_POUR_HOLE_MM as MIN_POUR_OPENING_MM } from './siliconeMold';
import { MIN_POUR_HOLE_MM as MIN_POUR_OPENING_MM } from './siliconeMold';
/** Sand round a sand-cast pattern, at the sides and below, mm. */
export const SAND_COVER_MM = 25;
/** What a rammed flask of green sand weighs, g/cm³. */
const SAND_DENSITY = 1.5;
/** Vents cut through a silicone mold, mm across. */
const VENT_DIA_MM = 2;
/** More trapped pockets than this and the mold wants rethinking, not venting. */
const MAX_VENTS = 12;

export interface ChainPiece {
  /** As the master stands: centred in plan, on Z = 0. */
  mesh: IndexedMesh;
  volumeMm3: number;
  material: CastMaterialId;
  weightG: number;
  /** The parts to weigh out, where the material is mixed. */
  mix: { a: number; b: number; aLabel: string; bLabel: string } | null;
  /** Metal in the sprue, runner, riser and vents: cut off and remelted. */
  gating?: { volumeMm3: number; weightG: number };
  /** Distance between the piece's surface and the master's, both ways, mm. */
  deviation: { maxMm: number; meanMm: number } | null;
  notes: string[];
}

export type ChainResult<T> = ({ ok: true; piece: ChainPiece; warnings: string[] } & T) | { ok: false; error: string };

// --- Geometry helpers -------------------------------------------------------

function soupOf(mesh: IndexedMesh): Float64Array {
  const out = new Float64Array(mesh.faces.length * 3);
  for (let i = 0; i < mesh.faces.length; i++) {
    const v = mesh.faces[i] * 3;
    out[i * 3] = mesh.positions[v];
    out[i * 3 + 1] = mesh.positions[v + 1];
    out[i * 3 + 2] = mesh.positions[v + 2];
  }
  return out;
}

function meshOf(m: Manifold): IndexedMesh {
  const { positionsMm, faces } = manifoldToMeshMm(m);
  return { positions: positionsMm, faces };
}

/**
 * A triangle soup (mm) as one solid. It is split into shells that share edges
 * first, not vertices: two geoms that touch at a point (a stem's top and a
 * cap's underside both fan from the centre) would otherwise weld into one
 * shell that is not a manifold. Each shell is made a solid and the shells are
 * unioned, which also takes out the faces where they meet inside. Null when a
 * shell is not closed.
 */
export function soupSolid(wasm: ManifoldToplevel, soup: ArrayLike<number>): Manifold | null {
  const q = (v: number) => Math.round(v * 1e4);
  const vertexIds = new Map<string, number>();
  const vid = (i: number) => {
    const k = `${q(soup[i])},${q(soup[i + 1])},${q(soup[i + 2])}`;
    let id = vertexIds.get(k);
    if (id === undefined) vertexIds.set(k, (id = vertexIds.size));
    return id;
  };
  const triCount = Math.floor(soup.length / 9);
  const tv = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) for (let c = 0; c < 3; c++) tv[t * 3 + c] = vid(t * 9 + c * 3);
  // Union-find over triangles that share an edge, and only an edge exactly two
  // triangles use. Where shells touch along an edge (a post's foot on the edge
  // of the bar it stands on) four triangles meet there, and linking through it
  // would make one shell that is not a manifold.
  const parent = Uint32Array.from({ length: triCount }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const edgeUsers = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const a = tv[t * 3 + c], b = tv[t * 3 + ((c + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const users = edgeUsers.get(key);
      if (users) users.push(t);
      else edgeUsers.set(key, [t]);
    }
  }
  for (const users of edgeUsers.values()) {
    if (users.length === 2) parent[find(users[0])] = find(users[1]);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  const solids: Manifold[] = [];
  let open = false;
  for (const tris of groups.values()) {
    if (tris.length < 4) continue;
    const local = new Map<number, number>();
    const pos: number[] = [];
    const faces = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) => {
      for (let c = 0; c < 3; c++) {
        const g = tv[t * 3 + c];
        let l = local.get(g);
        if (l === undefined) {
          local.set(g, (l = pos.length / 3));
          // On the 0.1 µm grid the keys use, so faces two shells share are
          // exactly coplanar and the union fuses them.
          const i = t * 9 + c * 3;
          pos.push(q(soup[i]) / 1e4, q(soup[i + 1]) / 1e4, q(soup[i + 2]) / 1e4);
        }
        faces[j * 3 + c] = l;
      }
    });
    try {
      const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: faces }));
      if (m.isEmpty()) m.delete();
      else solids.push(m);
    } catch {
      open = true;
    }
  }
  if (open || !solids.length) {
    for (const m of solids) m.delete();
    return null;
  }
  if (solids.length === 1) return solids[0];
  try {
    return wasm.Manifold.union(solids);
  } finally {
    for (const m of solids) m.delete();
  }
}

/** A closed mesh as a solid; overlapping shells are unioned. */
function solidOf(wasm: ManifoldToplevel, mesh: IndexedMesh): Manifold | null {
  return soupSolid(wasm, soupOf(mesh));
}

/** Centred in plan and stood on Z = 0, in place. */
function settle(positions: Float32Array | number[]): void {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    x0 = Math.min(x0, positions[i]); x1 = Math.max(x1, positions[i]);
    y0 = Math.min(y0, positions[i + 1]); y1 = Math.max(y1, positions[i + 1]);
    z0 = Math.min(z0, positions[i + 2]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= cy;
    positions[i + 2] -= z0;
  }
}

/** Turned over about X (y and z negated), which keeps the winding. */
function turnedOver(mesh: IndexedMesh): IndexedMesh {
  const p = Float32Array.from(mesh.positions);
  for (let i = 0; i < p.length; i += 3) {
    p[i + 1] = -p[i + 1];
    p[i + 2] = -p[i + 2];
  }
  settle(p);
  return { positions: p, faces: mesh.faces };
}

/**
 * The master's outer surface as triangles in mm, settled the way the pieces
 * are. Its solids are unioned first: where two geoms meet, the faces they share
 * are inside the master, and measuring a piece against them would report gaps
 * that are not there.
 */
export function masterSoup(wasm: ManifoldToplevel, scene: SceneGraph, ids?: string[]): Float64Array {
  const raw = ids && ids.length ? masterSoupMm(scene, ids) : Float64Array.from(collectSceneTriangles(scene).tris, (v) => v * 1000);
  const solid = soupSolid(wasm, raw);
  const soup = solid ? soupOf(meshOf(solid)) : Float64Array.from(raw);
  solid?.delete();
  settle(soup as unknown as number[]);
  return soup;
}

function bvhOf(soup: ArrayLike<number>): MeshBVH {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(soup), 3));
  return new MeshBVH(geo);
}

/** Up to `cap` points spread evenly through a soup's vertices. */
function samplePoints(soup: ArrayLike<number>, cap = 20000): THREE.Vector3[] {
  const n = soup.length / 3;
  const stride = Math.max(1, Math.floor(n / cap));
  const out: THREE.Vector3[] = [];
  for (let v = 0; v < n; v += stride) out.push(new THREE.Vector3(soup[v * 3], soup[v * 3 + 1], soup[v * 3 + 2]));
  return out;
}

/**
 * How far the piece strays from the master: every sampled point of each is
 * measured to the other's surface, so a lump on one and a dent in the other
 * both count. Both are taken as they stand, settled the same way.
 */
export function deviationMm(piece: ArrayLike<number>, master: ArrayLike<number>): { maxMm: number; meanMm: number } | null {
  if (piece.length < 9 || master.length < 9) return null;
  const toMaster = bvhOf(master);
  const toPiece = bvhOf(piece);
  let max = 0, sum = 0, n = 0;
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  for (const [points, bvh] of [[samplePoints(piece), toMaster], [samplePoints(master), toPiece]] as const) {
    for (const p of points) {
      bvh.closestPointToPoint(p, hit as never);
      max = Math.max(max, hit.distance);
      sum += hit.distance;
      n++;
    }
  }
  return { maxMm: Math.round(max * 100) / 100, meanMm: Math.round((sum / Math.max(1, n)) * 100) / 100 };
}

/** Manifolds made during a chain, freed together however it ends. */
class Owned {
  private list: Manifold[] = [];
  take<T extends Manifold | null>(m: T): T {
    if (m) this.list.push(m);
    return m;
  }
  free() {
    for (const m of this.list) m.delete();
    this.list = [];
  }
}

function piece(
  mesh: IndexedMesh,
  volumeMm3: number,
  material: CastMaterialId,
  master: Float64Array,
  pla: boolean,
  gating?: { volumeMm3: number; weightG: number },
): ChainPiece {
  const weightG = castWeightG(material, volumeMm3);
  return {
    mesh,
    volumeMm3: Math.round(volumeMm3),
    material,
    weightG: Math.round(weightG * 10) / 10,
    mix: mixGrams(material, weightG),
    ...(gating ? { gating: { volumeMm3: Math.round(gating.volumeMm3), weightG: Math.round(gating.weightG * 10) / 10 } } : {}),
    deviation: deviationMm(soupOf(mesh), master),
    notes: castMaterialWarnings(material, volumeMm3 / 1000, { pla }),
  };
}

// --- Silicone ---------------------------------------------------------------

/**
 * Where air would be trapped in a cavity poured from the top to `level`.
 *
 * The cavity is read as columns of solid spans. Each span's top is a ceiling
 * (unless it is the free surface at the fill level), and air under it rises
 * into a neighbouring column's span that overlaps it and reaches higher. A
 * ceiling with nowhere higher to go traps air: every span is checked, not just
 * the top one in its column, so a pocket under a ledge under another ledge is
 * found too. Each connected patch of trapped ceilings gets one vent, at its
 * highest point.
 */
export function trappedAirPoints(casting: Manifold, level: number): { x: number; y: number; z: number }[] {
  const { min, max } = casting.boundingBox();
  const span = Math.max(max[0] - min[0], max[1] - min[1]);
  const cell = Math.max(0.5, span / 150);
  const cols = Math.ceil((max[0] - min[0]) / cell) + 1;
  const rows = Math.ceil((max[1] - min[1]) / cell) + 1;
  const spans = castColumnSpans(soupOf(meshOf(casting)), { minX: min[0], minY: min[1], stepX: cell, stepY: cell, cols, rows });
  const tol = Math.max(0.5, cell);
  // Spans of column k are nodes offset[k]/2 .. offset[k+1]/2.
  const node = (k: number) => [spans.offset[k] / 2, spans.offset[k + 1] / 2] as const;
  const bot = (n: number) => spans.z[n * 2];
  const top = (n: number) => spans.z[n * 2 + 1];
  const nodeCount = spans.z.length / 2;
  const colOf = new Int32Array(nodeCount);
  for (let k = 0; k < cols * rows; k++) { const [a, b] = node(k); for (let n = a; n < b; n++) colOf[n] = k; }
  const overlapping = (n: number, k: number): number[] => {
    const out: number[] = [];
    const [a, b] = node(k);
    for (let m = a; m < b; m++) if (bot(m) < top(n) - 1e-6 && top(m) > bot(n) + 1e-6) out.push(m);
    return out;
  };
  const neighbours = (k: number): number[] => {
    const c = k % cols, r = Math.floor(k / cols);
    const out: number[] = [];
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) out.push(rr * cols + cc);
    }
    return out;
  };
  const trapped = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    if (top(n) >= level - tol) continue;
    let escapes = false;
    for (const k of neighbours(colOf[n])) {
      if (overlapping(n, k).some((m) => top(m) > top(n) + 1e-4)) { escapes = true; break; }
    }
    if (!escapes) trapped[n] = 1;
  }
  const seen = new Uint8Array(nodeCount);
  const out: { x: number; y: number; z: number }[] = [];
  for (let n0 = 0; n0 < nodeCount; n0++) {
    if (!trapped[n0] || seen[n0]) continue;
    let best = n0;
    const stack = [n0];
    seen[n0] = 1;
    while (stack.length) {
      const n = stack.pop()!;
      if (top(n) > top(best)) best = n;
      for (const k of neighbours(colOf[n])) {
        for (const m of overlapping(n, k)) if (trapped[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
      }
    }
    const k = colOf[best];
    out.push({ x: min[0] + (k % cols) * cell, y: min[1] + Math.floor(k / cols) * cell, z: top(best) });
  }
  return out.sort((a, b) => b.z - a.z);
}

/**
 * Whether a pour goes in through an opening: some piece of it must be at least
 * `across` mm wide, not just add up to that much area. Four thin legs or a
 * blade-thin foot do not.
 */
export function opensWideEnough(section: CrossSection, across: number): boolean {
  const parts = section.decompose();
  try {
    return parts.some((part) => {
      const core = part.offset(-across / 2 + 1e-3, 'Round');
      const ok = !core.isEmpty() && core.area() > 1e-6;
      core.delete();
      return ok;
    });
  } finally {
    for (const p of parts) p.delete();
  }
}

export interface SiliconeChain {
  /** The silicone mold, as it is poured into, vents cut: centred, on Z = 0. */
  siliconeMold: IndexedMesh;
  /** Vents, in the silicone mold's own frame as added. */
  vents: { x: number; y: number }[];
  silicone: { id: SiliconeId; grams: number; aG: number; bG: number; name: string };
  /** Poured through the master's foot (the mold turned over) or a pour hole (as made). */
  pouredThrough: 'foot' | 'pour hole';
}

/**
 * Pours the silicone mold round the master in its box, turns it over, vents
 * it, and pours the material in through the master's foot (or stands it as
 * made and pours through a pour hole).
 */
export async function siliconeChain(
  scene: SceneGraph,
  ids: string[],
  boxOptions: Partial<PourBoxOptions>,
  material: CastMaterialId,
): Promise<ChainResult<SiliconeChain>> {
  const wasm = await loadManifold();
  const box = await planPourBox(scene, ids, boxOptions);
  const out = sceneWithPourBox(scene, ids, box);
  const mold = pourNodeFor(out.scene.nodes, [...ids, out.baseId, out.sleeveId]);
  if (!mold) return { ok: false, error: 'Select the master: the body to make a silicone mold of.' };
  const pourHole = box.hole?.purpose === 'pour' ? box.hole : null;
  if (pourHole && pourHole.diaMm < MIN_POUR_OPENING_MM) {
    return { ok: false, error: `A pour hole ${pourHole.diaMm} mm across is too narrow to pour through: make it at least ${MIN_POUR_OPENING_MM} mm.` };
  }
  // Poured from the top to the fill line, and handed back turned onto the face
  // the pour left: the silicone mold the right way up to pour into.
  const silicone = await simulateCastFromMoldNode(mold, { pour: { direction: '+z', fillMm: box.report.pourDepthMm } });
  if (!silicone.success) return { ok: false, error: `The silicone would not pour round the master: ${silicone.error}` };
  const master = masterSoup(wasm, scene, ids);

  const own = new Owned();
  try {
    const turned = own.take(solidOf(wasm, silicone.mesh));
    if (!turned) return { ok: false, error: 'The silicone mold did not come out as a solid; repair the master and try again.' };
    // A pour hole is poured through with the mold standing as it was made, its
    // foot closed by the base; otherwise it is turned over and poured through
    // the master's foot, a wick or fixing hole plugged.
    const S = pourHole ? own.take(turned.rotate([180, 0, 0])) : turned;
    let closed = S;
    if (pourHole) {
      // The base it stands on, up through the flash the groove left round the
      // rim to the mold's underside, where the master stood.
      const flash = Math.max(0, box.report.pourDepthMm - box.report.fillHeightMm);
      const b = S.boundingBox();
      const base = own.take(wasm.Manifold.cube([b.max[0] - b.min[0], b.max[1] - b.min[1], 2 + flash + 0.01], false).translate([b.min[0], b.min[1], b.min[2] - 2]));
      closed = own.take(S.add(base));
    }
    const { min, max } = closed.boundingBox();
    // Inset a little in plan, as the pour simulation does: the flash the
    // groove leaves standing round the rim is thinner than that, so it is cut
    // away and holds nothing, and the pour stops at the mold's face.
    const inset = Math.min(0.5, Math.max(0.01, (max[0] - min[0]) * 0.01), Math.max(0.01, (max[1] - min[1]) * 0.01));
    const probeBox = { minX: min[0] + inset, maxX: max[0] - inset, minY: min[1] + inset, maxY: max[1] - inset, minZ: min[2] + 0.001, maxZ: max[2] - 0.001 };
    const probe = own.take(wasm.Manifold.cube(
      [probeBox.maxX - probeBox.minX, probeBox.maxY - probeBox.minY, probeBox.maxZ - probeBox.minZ], false,
    ).translate([probeBox.minX, probeBox.minY, probeBox.minZ]));
    const cavity = own.take(probe.subtract(closed));
    const poured = cavity.isEmpty() ? null : pourIntoCavity(wasm, cavity, probeBox, { direction: '+z' });
    if (!poured) {
      return {
        ok: false,
        error: pourHole
          ? 'Nothing pours through the hole into the master\'s space: put the hole on the master\'s top.'
          : box.hole
            ? `The silicone mold holds nothing poured through the master's foot: the ${box.hole.purpose} hole (${box.hole.diaMm} mm) is too big to plug, or the master has no foot on the base.`
            : 'The silicone mold holds nothing poured from its open side: the master has no foot standing on the base.',
      };
    }
    let casting = own.take(poured.casting);
    const level = casting.boundingBox().max[2];
    if (!pourHole) {
      const opening = casting.slice(level - 0.3);
      const wide = opensWideEnough(opening, MIN_POUR_OPENING_MM);
      opening.delete();
      if (!wide) {
        return {
          ok: false,
          error: `No part of the master's foot is ${MIN_POUR_OPENING_MM} mm across, too narrow to pour ${castMaterial(material).label.toLowerCase()} through. Use Rigid with the PVA liner, or a pour hole.`,
        };
      }
    }

    const warnings: string[] = [];
    let points = trappedAirPoints(casting, level);
    if (points.length > MAX_VENTS) {
      warnings.push(`Air is trapped in ${points.length} places; the ${MAX_VENTS} highest are vented. Turning the master to stand another way may trap less.`);
      points = points.slice(0, MAX_VENTS);
    }
    const sb = S.boundingBox();
    let vented = S;
    for (const p of points) {
      const vent = own.take(wasm.Manifold.cylinder(sb.max[2] - p.z + 1.5, VENT_DIA_MM / 2, VENT_DIA_MM / 2, 16).translate([p.x, p.y, p.z - 0.5]));
      vented = own.take(vented.subtract(vent));
    }
    const siliconeMold = meshOf(vented);
    // Settled as added to the scene; the vents are reported in that frame.
    const vb = vented.boundingBox();
    const vcx = (vb.min[0] + vb.max[0]) / 2, vcy = (vb.min[1] + vb.max[1]) / 2;
    settle(siliconeMold.positions);

    // Poured through a hole, the casting stands as the master does already, with
    // the hole's stub on top to cut off; poured through the foot, it comes out
    // upside down and is turned over.
    if (pourHole) {
      // The stub is the hole's own column: found where the casting meets the
      // top, cut from the hole's foot up. The casting's bottom is the master's
      // foot, the base's top in the world.
      const b = casting.boundingBox();
      const worldFoot = box.report.fillZMm - box.report.fillHeightMm;
      const cutZ = b.min[2] + (pourHole.footMm[2] + 0.5 - worldFoot);
      const mouth = casting.slice(level - 0.3);
      const m = mouth.bounds();
      mouth.delete();
      const r = pourHole.diaMm / 2 + 0.05;
      const stub = own.take(wasm.Manifold.cylinder(level + 1 - cutZ, r, r, 32).translate([(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, cutZ]));
      casting = own.take(casting.subtract(stub));
    }
    const raw = meshOf(casting);
    const volume = casting.volume();
    let finished: IndexedMesh;
    if (pourHole) {
      const pos = Float32Array.from(raw.positions);
      settle(pos);
      finished = { positions: pos, faces: raw.faces };
    } else {
      finished = turnedOver(raw);
    }
    const r = box.report;
    return {
      ok: true,
      piece: piece(finished, volume, material, master, false),
      siliconeMold,
      vents: points.map((p) => ({ x: Math.round((p.x - vcx) * 10) / 10, y: Math.round((p.y - vcy) * 10) / 10 })),
      silicone: { id: r.silicone, grams: r.siliconeG, aG: r.partAG, bG: r.partBG, name: r.siliconeName },
      pouredThrough: pourHole ? 'pour hole' : 'foot',
      warnings: [...r.warnings, ...warnings],
    };
  } finally {
    own.free();
  }
}

// --- Metal ------------------------------------------------------------------

export interface MetalChain {
  /** The flask, mm. */
  flask: { shape: 'box' | 'cylinder'; sizeMm: [number, number, number] };
  /** Sand (sand casting) or investment powder (lost PLA) to fill it, grams. */
  fillG: number;
  /** Share of the part the metal reached from the sprue; null when gated by hand (not poured). */
  filledShare: number | null;
  /** What to melt: the part, the gating and a margin, grams (the pattern dialog's pour). */
  pourWeightG: number;
}

/**
 * Stands the pattern in its flask, fills round it, takes it away and pours the
 * metal down the sprue: the casting is what the pour reaches, cut off its
 * gating and shrunk to size. A body the gating does not reach is not in it.
 */
export async function metalChain(scene: SceneGraph, options: Partial<CastOptions>): Promise<ChainResult<MetalChain>> {
  const wasm = await loadManifold();
  const withGating = generateCastPattern(scene, options);
  if (!withGating.success) return { ok: false, error: withGating.error ?? 'The pattern could not be made.' };
  const partOnly = generateCastPattern(scene, { ...options, addGating: false });
  if (!partOnly.success) return { ok: false, error: partOnly.error ?? 'The pattern could not be made.' };
  const s = withGating.summary;
  const lostPla = s.method === 'lost-pla';
  const metal = (options.metalId ?? 'aluminium') as CastMaterialId;
  const grow = 1 + partOnly.summary.shrinkPercent / 100;
  const warnings: string[] = [];
  const gated = (options.addGating ?? true) && s.sprueDiaMm > 0;

  const own = new Owned();
  try {
    const P = own.take(solidOf(wasm, stlToMesh(withGating.patternStl)));
    const part = own.take(solidOf(wasm, stlToMesh(partOnly.patternStl)));
    if (!P || !part) return { ok: false, error: 'The pattern did not come out as a solid; repair the model and try again.' };
    const { min, max } = P.boundingBox();
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
    let flask: Manifold;
    let flaskInfo: MetalChain['flask'];
    if (lostPla) {
      // Round the whole rig, cup level with the top: never narrower than the rig.
      const dia = Math.max(s.flaskDiaMm, Math.hypot(max[0] - min[0], max[1] - min[1]) + 24);
      const height = Math.max(s.flaskHeightMm, max[2] - min[2] + 12);
      flask = own.take(wasm.Manifold.cylinder(height, dia / 2, dia / 2, 64).translate([cx, cy, max[2] - height]));
      flaskInfo = { shape: 'cylinder', sizeMm: [Math.round(dia), Math.round(dia), Math.round(height)] };
    } else {
      const c = SAND_COVER_MM;
      const size: [number, number, number] = [max[0] - min[0] + 2 * c, max[1] - min[1] + 2 * c, max[2] - min[2] + c];
      flask = own.take(wasm.Manifold.cube(size, false).translate([min[0] - c, min[1] - c, min[2] - c]));
      flaskInfo = { shape: 'box', sizeMm: size.map((v) => Math.round(v)) as [number, number, number] };
    }
    const mold = own.take(flask.subtract(P));
    const fillG = lostPla ? Math.round(s.investmentPowderG) : Math.round((mold.volume() / 1000) * SAND_DENSITY);

    // Poured down the sprue to the top of the flask, in the pattern's frame.
    // Gated by hand, there is no way in to pour through: the part is taken as
    // the pattern made it.
    let reached: Manifold = part;
    let filledShare: number | null = null;
    let gatingMm3 = s.gatingVolumeMm3;
    if (gated) {
      const fb = mold.boundingBox();
      const probeBox = { minX: fb.min[0] + 0.01, maxX: fb.max[0] - 0.01, minY: fb.min[1] + 0.01, maxY: fb.max[1] - 0.01, minZ: fb.min[2] + 0.001, maxZ: fb.max[2] - 0.001 };
      const probe = own.take(wasm.Manifold.cube(
        [probeBox.maxX - probeBox.minX, probeBox.maxY - probeBox.minY, probeBox.maxZ - probeBox.minZ], false,
      ).translate([probeBox.minX, probeBox.minY, probeBox.minZ]));
      const cavity = own.take(probe.subtract(mold));
      const poured = cavity.isEmpty() ? null : pourIntoCavity(wasm, cavity, probeBox, { direction: '+z' });
      if (!poured) return { ok: false, error: 'The metal would not pour: nothing in the flask opens to the top through the sprue.' };
      const casting = own.take(poured.casting);
      reached = own.take(casting.intersect(part));
      filledShare = reached.volume() / Math.max(1e-9, part.volume());
      gatingMm3 = Math.max(0, casting.volume() - reached.volume());
      if (filledShare < 0.02) return { ok: false, error: 'The metal does not reach the part from the sprue: the gating ends short of it.' };
      if (filledShare < 0.97) {
        warnings.push(`The metal reaches only ${Math.round(filledShare * 100)}% of the part from the sprue; the rest is cut off from the gating and is left out of the piece.`);
      }
    }

    // The part as the metal leaves it, shrunk back to size.
    const raw = meshOf(reached);
    const pos = Float32Array.from(raw.positions, (v) => v / grow);
    settle(pos);
    const volume = reached.volume() / grow ** 3;
    // What to melt is the pattern dialog's pour figure; the gating is that less the part.
    const partG = castWeightG(metal, volume);
    const pourWeightG = gated ? Math.max(s.pourWeightG, partG) : partG;
    return {
      ok: true,
      piece: piece({ positions: pos, faces: raw.faces }, volume, metal, masterSoup(wasm, scene), false,
        gated ? { volumeMm3: gatingMm3, weightG: pourWeightG - partG } : undefined),
      flask: flaskInfo,
      fillG,
      filledShare: filledShare === null ? null : Math.round(filledShare * 1000) / 1000,
      pourWeightG: Math.round(pourWeightG),
      warnings: [...withGating.warnings, ...warnings],
    };
  } finally {
    own.free();
  }
}

/** The lines a finished piece adds to its note card, and the dialog shows. */
export function pieceLines(p: ChainPiece): string[] {
  const label = castMaterial(p.material).label.toLowerCase();
  return [
    `${p.volumeMm3.toLocaleString()} mm³, ${p.weightG} g of ${label}` +
      (p.mix ? ` (${Math.round(p.mix.a)} g ${p.mix.aLabel} + ${Math.round(p.mix.b)} g ${p.mix.bLabel})` : ''),
    ...(p.gating ? [`Gating + margin: +${p.gating.weightG} g (${Math.round(p.weightG + p.gating.weightG)} g total melt)`] : []),
    ...(p.deviation ? [`Deviation from master: ${p.deviation.maxMm} mm max, ${p.deviation.meanMm} mm mean`] : []),
    ...p.notes,
  ];
}
