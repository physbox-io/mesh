import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, moldStlParts, DEFAULT_MOLD_OPTIONS, type MoldOptions, type MoldExportResult, type MoldMeshHalf, type Triangle3D } from '../src/utils/moldExporter';
import { buildPartManifold } from '../src/utils/moldManifold';
import { unprintableRoofs } from '../src/utils/moldRoofs';
import { boreSolids } from '../src/utils/moldGating';
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
  // A printer that bridges nothing, so every roof here has to be cut or lifted.
  printLimits: { minSkinMm: 0.2, minWallMm: 0.4, bridgeMm: 0 },
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
      // And by most of its width, not a mushroom on feet: a gear insert 45°
      // self-supporting stood on a fifth of its widest layer, and in HIPS
      // the nozzle knocked it off the bed every time.
      const box = body.boundingBox();
      let widest = 0;
      for (let z = box.min[2] + 0.3; z < box.max[2]; z += 0.5) {
        const s = body.slice(z);
        widest = Math.max(widest, s.area());
        s.delete();
      }
      expect(first.area() / widest, `${name}: first layer against the widest`).toBeGreaterThan(0.5);
      first.delete();
      body.delete();
    }
    expect(insert.liner!.steps.join(' ')).toMatch(/supports off: nothing in them needs any/);
  });
});

describe('an insert under a part with an uneven underside', () => {
  // A 30 mm plate (z 6..10) with a 4 mm post under one corner (z 0..6), parted
  // at its top: the gear sculpture's shape in small. Built down at 45°, the
  // insert stood on the post's foot and flared out to the plate: a mushroom a
  // slicer passes and the nozzle knocks off the bed.
  it('stands on a flat base as wide as the insert', () => {
    const uneven = {
      nodes: [{ id: 'u', name: 'uneven', type: 'body', pos: [0, 0, 0], geoms: [box('plate', -15, -15, 6, 15, 15, 10), box('post', 7, 7, 0, 11, 11, 6)], joints: [], children: [] }],
      castPrep: { draftDeg: 1, draftMode: 'remove', partingZ: 10 * MM, edges: null, originals: {} },
    } as unknown as SceneGraph;
    const r = generateMoldMeshes(uneven, { ...OPTS, linerConstruction: 'insert' }, wasm);
    expect(r.success, r.error).toBe(true);
    const objs = objects(r.threeMf!);
    for (const pattern of [/^Cavity half insert/, /^Lid half insert/]) {
      const name = [...objs.keys()].find((n) => pattern.test(n))!;
      expect(name).toBeDefined();
      const o = objs.get(name)!;
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(o.positions), triVerts: Uint32Array.from(o.faces) });
      mesh.merge();
      const body = new wasm.Manifold(mesh);
      const b = body.boundingBox();
      expect(b.min[2], `${name}: rests on z = 0`).toBeCloseTo(0, 2);
      const first = body.slice(b.min[2] + 0.1);
      const top = body.slice(b.max[2] - 0.5);
      for (const island of first.decompose()) expect(island.area(), `${name}: base island`).toBeGreaterThan(10);
      expect(first.area() / top.area(), `${name}: first layer against the face`).toBeGreaterThan(0.75);
      for (const c of [first, top, body]) c.delete();
    }
  }, 120_000);
});

describe('the exported parts', () => {
  it('are closed after the 3MF rounds them, so no slicer has to repair them', () => {
    for (const [name, o] of objects(insert.threeMf!)) {
      const a = analyzeMesh(o.positions, o.faces)!;
      expect(a.closed, `${name}: closed`).toBe(true);
      expect(a.consistentlyWound, `${name}: wound`).toBe(true);
    }
  });

  it('give a horizontal runner a teardrop that holds the whole round bore', () => {
    const [tear] = boreSolids(wasm, { a: [0, 0, -5], b: [20, 0, -5], r: 2, ends: false, fluted: false } as never);
    const round = wasm.Manifold.cylinder(20, 1.99, 1.99, 64, false).rotate([0, 90, 0]).translate([0, 0, -5]);
    expect(round.subtract(tear).volume()).toBeLessThan(0.05);
    expect(tear.boundingBox().max[2]).toBeCloseTo(-5 + 2 * Math.SQRT2, 2);
    // Nothing of it hangs flatter than 45°: its top is a ridge.
    expect(unprintableRoofs(tear, wasm.Manifold.cube([1000, 1000, 1000], true))).toEqual([]);
    round.delete();
    tear.delete();
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
  it('lets a printer bridge a roof held on two sides, never one hung off a single side', () => {
    // A 6 mm wide channel of cast space under a lid, held both sides: a bridge.
    const block = slab(-12, -12, -10, 12, 12, 0);
    const channel = slab(-10, -3, -8, 10, 3, -2);
    const bridged = block.subtract(channel);
    expect(unprintableRoofs(bridged, channel)).not.toEqual([]);
    expect(unprintableRoofs(bridged, channel, 0.2, 1, 5)).toEqual([]);
    // Wider than two reaches: still a roof.
    const wide = slab(-10, -6, -8, 10, 6, -2);
    expect(unprintableRoofs(block.subtract(wide), wide, 0.2, 1, 5)).not.toEqual([]);
    // A 4 mm shelf over cast space from one wall only: a cantilever, however short.
    const wall = slab(-12, -12, -10, -6, 12, 0);
    const shelf = slab(-6, -12, -2, -2, 12, 0);
    const under = slab(-6, -12, -8, 6, 12, -2);
    expect(unprintableRoofs(wall.add(shelf), under, 0.2, 1, 5)).not.toEqual([]);
  });
});

describe('an insert a printer can bridge', () => {
  // A 6 mm wide tunnel (y -3..3) of cast space between two solid HIPS side
  // walls (y < -3 and y > 3), joined to an upper cap (z 10..12) by risers at
  // the two ends (x -12..-10 and 10..12): held on both sides across a 6 mm span
  // with no open inner hole, so FDM (bridgeMm = 5) bridges straight across it
  // while resin / no-bridge (bridgeMm = 0) cuts at the ceiling.
  const bridgeScene = {
    nodes: [{
      id: 'b',
      name: 'bridgeable',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        box('tunnel', -12, -3, 4, 12, 3, 8.6),
        box('riserL', -12, -3, 4, -10, 3, 12),
        box('riserR', 10, -3, 4, 12, 3, 12),
        box('cap', -12, -10, 10, 12, 10, 12),
      ],
      joints: [],
      children: [],
    }],
    castPrep: { draftDeg: 0, draftMode: 'remove', partingZ: 10 * MM, edges: null, originals: {} },
  } as unknown as SceneGraph;

  it('is printed whole when held across two opposite walls, and cut when bridging is off', () => {
    const bridgeOpts = { ...OPTS, draftAngleDeg: 0, includeSprue: false, includeVents: false, linerConstruction: 'insert' as const };
    const noBridge = generateMoldMeshes(bridgeScene, bridgeOpts, wasm);
    expect(noBridge.success, noBridge.error).toBe(true);
    expect(noBridge.liner!.steps.join(' ')).toMatch(/comes in 2 pieces/);

    const fdm = generateMoldMeshes(bridgeScene, { ...bridgeOpts, printLimits: { minSkinMm: 0.2, minWallMm: 0.4, bridgeMm: 5 } }, wasm);
    expect(fdm.success, fdm.error).toBe(true);
    expect(fdm.liner!.steps.join(' ')).not.toMatch(/comes in \d+ pieces/);
    const objs = objects(fdm.threeMf!);
    expect([...objs.keys()].filter((n) => /insert/.test(n))).toEqual(['Cavity half insert (HIPS)', 'Lid half insert (HIPS)']);
    expect(fdm.warnings.join(' ')).not.toMatch(/hanging over the casting/);
  }, 120_000);

  it('never treats an inward flange or annular ceiling around an open shaft hole as a bridge', () => {
    // `scene` has a 5 mm inward ledge around an open 14 x 14 mm window and four
    // 2 x 2 mm pillar holes; and stacked discs on a shaft leave an annular HIPS
    // ceiling around an empty central shaft hole that would print floating loops
    // onto the nozzle if not cut.
    const fdmWindow = generateMoldMeshes(scene, { ...OPTS, linerConstruction: 'insert', printLimits: { minSkinMm: 0.2, minWallMm: 0.4, bridgeMm: 5 } }, wasm);
    expect(fdmWindow.success, fdmWindow.error).toBe(true);
    expect(fdmWindow.liner!.steps.join(' ')).toMatch(/comes in 2 pieces/);

    const stackedOnShaft = {
      nodes: [{
        id: 's',
        name: 'stackedGears',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [
          box('baseGear', -10, -10, 0, 10, 10, 2.4),
          box('shaft', -1.5, -1.5, 0, 1.5, 1.5, 14),
          box('midGear', -7, -7, 5, 7, 7, 7),
          box('topGear', -6, -6, 10, 6, 6, 12),
        ],
        joints: [],
        children: [],
      }],
    } as unknown as SceneGraph;
    const fdmGears = generateMoldMeshes(stackedOnShaft, { ...OPTS, pullDirection: '+z', linerConstruction: 'insert', printLimits: { minSkinMm: 0.2, minWallMm: 0.4, bridgeMm: 5 } }, wasm);
    expect(fdmGears.success, fdmGears.error).toBe(true);
    expect(fdmGears.liner!.steps.join(' ')).toMatch(/comes in 3 pieces/);
    // Every scene part is closed and manifold too.
    const allTris = [...fdmGears.bottomHalf.triangles, ...(fdmGears.topHalf?.triangles ?? [])];
    let off = 0;
    for (const part of moldStlParts(fdmGears)) {
      const slice = allTris.slice(off, off + part.triangles);
      off += part.triangles;
      const pos: number[] = [];
      const fcs: number[] = [];
      const vm = new Map<string, number>();
      for (const tri of slice) {
        for (const v of [tri.a, tri.b, tri.c]) {
          const k = `${Math.fround(v[0])},${Math.fround(v[1])},${Math.fround(v[2])}`;
          let idx = vm.get(k);
          if (idx === undefined) { idx = pos.length / 3; vm.set(k, idx); pos.push(v[0], v[1], v[2]); }
          fcs.push(idx);
        }
      }
      const a = analyzeMesh(pos, fcs)!;
      expect(a.closed, part.name).toBe(true);
      expect(a.consistentlyWound, part.name).toBe(true);
    }
  }, 120_000);
});

describe('watertight meshes with collinear T-junction stitch triangles', () => {
  it('builds a clean Manifold solid without dropping stitch triangles into open holes', () => {
    // A 10 mm cube whose top face has a midpoint vertex (5, 0, 10) splitting one
    // edge, stitched by a zero-area collinear triangle (0,0,10)-(5,0,10)-(10,0,10)
    // as CAD/slicer STLs (such as 3DBenchy) do.
    const tris = Float64Array.from([
      // Bottom (z=0)
      0, 0, 0, 0, 10, 0, 10, 10, 0,
      0, 0, 0, 10, 10, 0, 10, 0, 0,
      // Top (z=10), split at M=(5,0,10)
      0, 0, 10, 5, 0, 10, 10, 10, 10,
      5, 0, 10, 10, 0, 10, 10, 10, 10,
      0, 0, 10, 10, 10, 10, 0, 10, 10,
      // Front (y=0), undivided edge (0,0,10)-(10,0,10) + collinear stitch triangle!
      0, 0, 0, 10, 0, 0, 10, 0, 10,
      0, 0, 0, 10, 0, 10, 0, 0, 10,
      0, 0, 10, 10, 0, 10, 5, 0, 10,
      // Back (y=10)
      0, 10, 0, 0, 10, 10, 10, 10, 10,
      0, 10, 0, 10, 10, 10, 10, 10, 0,
      // Left (x=0)
      0, 0, 0, 0, 0, 10, 0, 10, 10,
      0, 0, 0, 0, 10, 10, 0, 10, 0,
      // Right (x=10)
      10, 0, 0, 10, 10, 0, 10, 10, 10,
      10, 0, 0, 10, 10, 10, 10, 0, 10,
    ]);
    const { part, unsolid } = buildPartManifold(wasm, tris);
    expect(unsolid).toEqual([]);
    expect(part).not.toBeNull();
    expect(part!.volume()).toBeCloseTo(1000, 3);
    part!.delete();
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

  it('parts at the interface above stepped base plates rather than shaving under their tops', () => {
    // Three stepped base plates (tops at z = 2.5, 2.7, 2.9 mm) with a tower
    // standing on the highest one (z = 2.9..15 mm) and an overhang above it
    // (z = 8..15 mm). Parting at z = 2.47 mm shaves 30..430 µm under all three
    // base tops; parting at z = 2.9 mm puts the highest top on the plane and
    // leaves the other two within 0.4 mm to lift as pads without cutting.
    const a = wasm.Manifold.cube([20, 20, 2.9]).translate([-10, -10, 0]);
    const b = wasm.Manifold.cube([14, 14, 2.7]).translate([10, -7, 0]);
    const c = wasm.Manifold.cube([14, 14, 2.5]).translate([-7, 10, 0]);
    const post = wasm.Manifold.cube([6, 6, 12.1]).translate([-3, -3, 2.9]);
    const cap = wasm.Manifold.cube([16, 16, 7]).translate([-8, -8, 8]);
    const part = wasm.Manifold.union([a, b, c, post, cap]);
    const mesh = part.getMesh();
    const tris: number[] = [];
    for (let t = 0; t < mesh.triVerts.length; t++) {
      const i = mesh.triVerts[t] * mesh.numProp;
      tris.push(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
    }
    expect(linerPartingChoice(tris, 0, 15, 2.47).z).toBeCloseTo(2.9, 1);
  });
});
