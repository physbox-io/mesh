import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldOptions, type MoldExportResult, type MoldMeshHalf, type Triangle3D } from '../src/utils/moldExporter';
import { unprintableRoofs } from '../src/utils/moldRoofs';
import { linerPartingChoice } from '../src/utils/moldRoofScore';
import { simulateCastFromMoldResult } from '../src/utils/moldCastSimulation';
import { moldSummary } from '../src/utils/moldExporter';
import { loadManifold } from '../src/utils/sculptCut';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

// A HIPS gear insert printed with its face closed over the casting: liner
// roofed the cavity, the slicer supported the roof, and the support filled
// the cavity. Nothing a half prints may hang over cast space now. Thin liner
// roofing a cavity up to the face goes to the other half as a pad on its face;
// a thicker roof cuts the insert into pieces that each print without one.
//
// The part here is plain blocks, parted at z = 10 mm: a frame-shaped plate
// (z 10..12) over a block (z 4..9.4) held to it by four pillars, with a post
// up the middle of the frame's window.
//  - Over the block, inside the window, the liner from the block's top to the
//    face is 0.6 mm thick and the lid has no part there: it moves to the lid.
//  - Under the frame the same 0.6 mm of liner has plate above it, so it stays,
//    and the insert is cut at the block's top.

const MM = 0.001;
const box = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SceneGeom =>
  ({ name, type: 'box', size: [((x1 - x0) / 2) * MM, ((y1 - y0) / 2) * MM, ((z1 - z0) / 2) * MM], pos: [((x0 + x1) / 2) * MM, ((y0 + y1) / 2) * MM, ((z0 + z1) / 2) * MM] }) as SceneGeom;

const geoms: SceneGeom[] = [
  box('block', -12, -12, 4, 12, 12, 9.4),
  box('frameL', -20, -20, 10, -7, 20, 12),
  box('frameR', 7, -20, 10, 20, 20, 12),
  box('frameF', -7, -20, 10, 7, -7, 12),
  box('frameB', -7, 7, 10, 7, 20, 12),
  box('post', -2, -2, 4, 2, 2, 12),
  ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy], k) => box(`pillar${k}`, sx * 9.5 - 1, sy * 9.5 - 1, 9, sx * 9.5 + 1, sy * 9.5 + 1, 10.2)),
];
const scene = {
  nodes: [{ id: 'p', name: 'part', type: 'body', pos: [0, 0, 0], geoms, joints: [], children: [] }],
  castPrep: { draftDeg: 1, draftMode: 'remove', partingZ: 10 * MM, edges: null, originals: {} },
} as unknown as SceneGraph;

const OPTS: MoldOptions = {
  ...DEFAULT_MOLD_OPTIONS,
  moldType: 'clamshell',
  pullDirection: '+z',
  includeSprue: true,
  includeVents: true,
  dissolvableLiner: true,
  linerPair: 'asa_hips',
  castMaterial: 'epoxy',
  wallMarginMm: 12,
};

function crossings(tris: Triangle3D[], x: number, y: number): number[] {
  const out: number[] = [];
  for (const t of tris) {
    const [a, b, c] = [t.a, t.b, t.c];
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * a[2] + l2 * b[2] + l3 * c[2]);
  }
  out.sort((p, q) => p - q);
  return out.filter((z, i) => i === 0 || z - out[i - 1] > 1e-6);
}

const centre = (h: MoldMeshHalf) => [(h.bounds.minX + h.bounds.maxX) / 2, (h.bounds.minY + h.bounds.maxY) / 2];

/** The 3MF's objects by name, as positions and triangles. */
function objects(threeMf: Uint8Array): Map<string, { positions: number[]; faces: number[] }> {
  const model = strFromU8(unzipSync(threeMf)['3D/3dmodel.model']);
  const out = new Map<string, { positions: number[]; faces: number[] }>();
  for (const m of model.matchAll(/<object id="\d+" type="model" name="([^"]+)">([\s\S]*?)<\/object>/g)) {
    const positions = [...m[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((v) => [+v[1], +v[2], +v[3]]);
    const faces = [...m[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((t) => [+t[1], +t[2], +t[3]]);
    if (faces.length) out.set(m[1], { positions, faces });
  }
  return out;
}

let wasm: ManifoldToplevel;
let insert: MoldExportResult;
let combined: MoldExportResult;
beforeAll(async () => {
  wasm = await loadManifold();
  insert = generateMoldMeshes(scene, { ...OPTS, linerConstruction: 'insert' }, wasm);
  combined = generateMoldMeshes(scene, OPTS, wasm);
}, 180_000);

describe('nothing a lined mold prints hangs over the casting', () => {
  it('moves thin liner roofing the cavity up to the face onto the other half', () => {
    expect(insert.success, insert.error).toBe(true);
    const base = insert.bottomHalf;
    const lid = insert.topHalf!;
    const [bx, by] = centre(base);
    const [lx, ly] = centre(lid);
    // In the window, over the block and clear of the post.
    for (const [x, y] of [[4.5, 4.5], [-4.5, 4.5], [4.5, -4.5], [-4.5, -4.5]]) {
      const below = crossings(base.liner!.liner, bx + x, by + y);
      // Open from the face down to the block's top, 0.6 mm.
      expect(below[below.length - 1], `cavity half at ${x}, ${y}: ${below}`).toBeLessThan(base.partingZMm - 0.4);
      // And the lid carries that 0.6 mm as a pad on its face (the lid is the cavity half turned over about X).
      const above = crossings(lid.liner!.liner, lx + x, ly - y);
      expect(above[above.length - 1], `lid at ${x}, ${-y}: ${above}`).toBeGreaterThan(lid.partingZMm + 0.5);
    }
  });

  it('cuts an insert where liner between two parts of the casting would hang over the lower one', () => {
    expect(insert.warnings.join(' ')).not.toMatch(/hanging over/);
    expect(insert.liner!.steps.join(' ')).toMatch(/cavity half's insert comes in 2 pieces, cut 0\.6 mm below the parting face/);
    const objs = objects(insert.threeMf!);
    const pieces = [...objs.keys()].filter((n) => /insert, piece \d of 2/.test(n));
    expect(pieces).toHaveLength(2);
    for (const name of pieces) {
      const a = analyzeMesh(objs.get(name)!.positions, objs.get(name)!.faces)!;
      expect(a.closed, name).toBe(true);
      expect(a.consistentlyWound, name).toBe(true);
    }
  });

  it('says a one-print mold needs support over the casting, and to print it as holder and insert instead', () => {
    expect(combined.success, combined.error).toBe(true);
    expect(combined.warnings.join(' ')).toMatch(/cavity half's liner has \d+ mm² of HIPS hanging over the casting, most of it 0\.6 mm below the parting face.*Holder \+ insert/);
  });
});

describe('printing the insert', () => {
  it('needs no support anywhere: every holder, insert and piece builds up from the bed', () => {
    const objs = objects(insert.threeMf!);
    const everything = wasm.Manifold.cube([1000, 1000, 1000], true);
    expect(objs.size).toBeGreaterThanOrEqual(5);
    for (const [name, o] of objs) {
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(o.positions), triVerts: Uint32Array.from(o.faces) });
      mesh.merge();
      const body = new wasm.Manifold(mesh);
      expect(unprintableRoofs(body, everything), name).toEqual([]);
      // And it stands on the bed by more than specks: a slicer drops a
      // first-layer island narrower than its line, and calls what was built
      // on it floating (Bambu Studio did, on a boat's insert).
      const first = body.slice(body.boundingBox().min[2] + 0.1);
      for (const island of first.decompose()) expect(island.area(), `${name}: first-layer island`).toBeGreaterThan(1);
      body.delete();
    }
    expect(insert.liner!.steps.join(' ')).toMatch(/supports off: nothing in them needs any/);
  });
});

describe('unprintableRoofs', () => {
  const slab = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    wasm.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);

  it('finds a roof over cast space too wide to bridge, and not one it can', () => {
    // A 20 mm box of cast space under a 2 mm lid, in a cup: the lid hangs 10 mm out.
    const cup = slab(-12, -12, -10, 12, 12, 0);
    const cast = slab(-10, -10, -8, 10, 10, -2);
    const body = cup.subtract(cast);
    const roofs = unprintableRoofs(body, cast);
    expect(roofs).toHaveLength(1);
    expect(roofs[0].depthMm).toBeCloseTo(2, 1);
    expect(roofs[0].areaMm2).toBeGreaterThan(200);
    // A 1.6 mm slot under the same lid: each side reaches 0.8 mm out.
    const slot = slab(-10, -0.8, -8, 10, 0.8, -2);
    const slotted = cup.subtract(slot);
    expect(unprintableRoofs(slotted, slot)).toEqual([]);
    // Cast space open to the top has no roof at all.
    const open = slab(-10, -10, -8, 10, 10, 1);
    const cupOpen = cup.subtract(open);
    expect(unprintableRoofs(cupOpen, open)).toEqual([]);
  });
});

describe('the cut pieces', () => {
  it('are their own parts of the mold body, keyed by pegs, and the mold still casts the part', async () => {
    const names = moldSummary(insert).parts.map((p) => p.name);
    expect(names).toContain('Cavity Half insert, piece 1 of 2 (bottom)');
    expect(names).toContain('Cavity Half insert, piece 2 of 2 (top)');
    // The top piece is 0.6 mm thick: no room for a peg's hole, so none.
    expect(insert.liner!.steps.join(' ')).not.toMatch(/pegs/);
    // Read as solids, holder and pieces cast the same part the one-print mold does.
    const a = await simulateCastFromMoldResult(insert, { trimChannels: true });
    const b = await simulateCastFromMoldResult(combined, { trimChannels: true });
    expect(a.success, a.error).toBe(true);
    expect(b.success, b.error).toBe(true);
    expect(a.fill!.filledShare).toBeGreaterThan(0.99);
    expect(Math.abs(a.castVolumeMm3 - b.castVolumeMm3) / b.castVolumeMm3).toBeLessThan(0.01);
  }, 120_000);
});

describe('a curved roof', () => {
  // A 40 x 20 x 20 mm block with a 6 mm hole through it along X: opened along
  // Z, the hole's top and bottom are curved roofs in one half or the other, and
  // no cut puts a curve on the bed.
  let holed: SceneGraph;
  beforeAll(() => {
    const block = wasm.Manifold.cube([40, 20, 20], true);
    const rod = wasm.Manifold.cylinder(50, 3, 3, 48, true).rotate([0, 90, 0]);
    const part = block.subtract(rod).translate([0, 0, 10]);
    const mesh = part.getMesh();
    const v: number[] = [];
    for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) v.push(mesh.vertProperties[i] * MM, mesh.vertProperties[i + 1] * MM, mesh.vertProperties[i + 2] * MM);
    const g = { name: 'g', type: 'mesh', size: [1], renderVertices: v, vertices: v, faces: Array.from(mesh.triVerts) } as unknown as SceneGeom;
    holed = { nodes: [{ id: 'h', name: 'holed', type: 'body', pos: [0, 0, 0], geoms: [g], joints: [], children: [] }] } as unknown as SceneGraph;
  });

  it('turns the mold to open along the hole when the direction is left to it', () => {
    const r = generateMoldMeshes(holed, { ...OPTS, pullDirection: 'auto', linerConstruction: 'insert' }, wasm);
    expect(r.success, r.error).toBe(true);
    expect(r.pullDirection).toMatch(/x$/);
    expect(r.warnings.join(' ')).not.toMatch(/hanging over/);
  }, 120_000);

  it('says what is left, and the last resort, when the direction is fixed across the hole', () => {
    const r = generateMoldMeshes(holed, { ...OPTS, pullDirection: '+z', linerConstruction: 'insert' }, wasm);
    expect(r.success, r.error).toBe(true);
    const said = r.warnings.join(' ');
    expect(said).toMatch(/insert still has \d+ mm² of HIPS hanging over the casting.*sloped or curved/);
    expect(said).toMatch(/Try another Pull Direction first/);
    expect(said).toMatch(/As a last resort, print the insert with its supports in PVA, and wash it out in warm water/);
    expect(r.liner!.steps[0]).toMatch(/but the roof the warnings name, which prints unsupported/);
  }, 120_000);

  it('parts a lined mold where it leaves least roof only support prints', () => {
    // Two stacked boxes, the top one wider: parted at the shelf between them,
    // the shelf is a flat roof on the plane; parted below it, the shelf is a
    // downward face above the plane, and a sloped chamfer under it is a roof.
    const lower = wasm.Manifold.cube([10, 10, 10]).translate([-5, -5, 0]);
    const upper = wasm.Manifold.cube([20, 20, 10]).translate([-10, -10, 10]);
    const chamfer = wasm.Manifold.hull([wasm.Manifold.cube([10, 10, 0.01]).translate([-5, -5, 7]), wasm.Manifold.cube([20, 20, 0.01]).translate([-10, -10, 10])]);
    const part = wasm.Manifold.union([lower, upper, chamfer]);
    const mesh = part.getMesh();
    const tris: number[] = [];
    for (let t = 0; t < mesh.triVerts.length; t++) {
      const i = mesh.triVerts[t] * mesh.numProp;
      tris.push(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
    }
    // Asked for z = 5, it moves up to the top of the chamfer: below the plane a
    // downward slope is the floor under the casting, above it a roof.
    expect(linerPartingChoice(tris, 0, 20, 5).curvedMm2).toBe(0);
    expect(linerPartingChoice(tris, 0, 20, 5).z).toBeCloseTo(10, 1);
    // Parted through the chamfer, the part of it above the plane counts.
    expect(linerPartingChoice(tris, 8.5, 8.5, 8.5).curvedMm2).toBeGreaterThan(20);
  });
});
