// Split for Print: real manifold wasm, real boxes.
//
// What has to hold: every section fits the bed the way it says it is posed,
// nothing is lost or gained in the cutting, every section is a closed solid
// wound outward, the joinery takes away (or adds) exactly what it should, and
// a peg never ends up on the face a section is printed on.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { splitForPrint, sectionPoseMatrix, type SplitResult } from '../src/utils/printSplit';
import { layoutOnBed, packOnBed, rotatePoints, type Vec3 } from '../src/utils/printPlate';
import { supportArea } from '../src/utils/printSupport';
import { analyzeMesh } from '../src/utils/meshIntegrity';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

/** An axis-aligned box as a triangle soup, metres, wound outward. Sizes in mm. */
function box(sx: number, sy: number, sz: number, at: Vec3 = [0, 0, 0]): Float64Array {
  const [x0, y0, z0] = at.map((v) => v / 1000);
  const [x1, y1, z1] = [x0 + sx / 1000, y0 + sy / 1000, z0 + sz / 1000];
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], // bottom, top
    [0, 1, 5, 4], [2, 3, 7, 6], // front, back
    [1, 2, 6, 5], [3, 0, 4, 7], // right, left
  ];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return Float64Array.from(out);
}

const bed200 = { widthMm: 200, depthMm: 200, heightMm: 200 };
const ok = (r: SplitResult) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

/** A section turned into its print pose, as a soup in mm. */
function posedSoup(s: { positions: Float32Array; faces: Uint32Array; up: Vec3; spin: number }): Float64Array {
  const R = sectionPoseMatrix(s);
  const p = rotatePoints(R, s.positions);
  const soup = new Float64Array(s.faces.length * 3);
  for (let i = 0; i < s.faces.length; i++) {
    soup[i * 3] = p[s.faces[i] * 3] * 1000;
    soup[i * 3 + 1] = p[s.faces[i] * 3 + 1] * 1000;
    soup[i * 3 + 2] = p[s.faces[i] * 3 + 2] * 1000;
  }
  return soup;
}

function posedExtent(s: { positions: Float32Array; faces: Uint32Array; up: Vec3; spin: number }): number[] {
  const soup = posedSoup(s);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], soup[i + k]); hi[k] = Math.max(hi[k], soup[i + k]); }
  }
  return [0, 1, 2].map((k) => hi[k] - lo[k]);
}

describe('splitForPrint — cutting', () => {
  it('cuts a 300 mm box into two that each fit a 200 mm bed, losing nothing', () => {
    const r = ok(splitForPrint(wasm, [box(300, 100, 100)], { bed: bed200, joinery: { kind: 'none' } }));
    expect(r.sections).toHaveLength(2);
    expect(r.cuts).toHaveLength(1);
    // Nothing about a plain box argues for anything but halves.
    expect(r.cuts[0].offset * 1000).toBeCloseTo(150, 6);
    let volume = 0;
    for (const s of r.sections) {
      expect(s.fits).toBe(true);
      const [w, d, h] = posedExtent(s);
      expect(Math.max(w, d)).toBeLessThanOrEqual(190 + 1e-6);
      expect(h).toBeLessThanOrEqual(200 + 1e-6);
      const integrity = analyzeMesh(Array.from(s.positions), Array.from(s.faces))!;
      expect(integrity.closed).toBe(true);
      expect(integrity.consistentlyWound).toBe(true);
      expect(integrity.volume).toBeGreaterThan(0);
      volume += s.volumeMm3;
    }
    expect(Math.abs(volume - 300 * 100 * 100) / (300 * 100 * 100)).toBeLessThan(0.001);
  });

  it('cuts a 500 mm box into three', () => {
    const r = ok(splitForPrint(wasm, [box(500, 100, 100)], { bed: bed200, joinery: { kind: 'none' } }));
    expect(r.sections).toHaveLength(3);
    expect(r.sections.every((s) => s.fits)).toBe(true);
  });

  it('leaves an L-bracket that already fits alone, and stands it the cheapest way up', () => {
    const soups = [box(120, 40, 10), box(10, 40, 80, [0, 0, 10])];
    const r = ok(splitForPrint(wasm, soups, { bed: bed200, joinery: { kind: 'none' } }));
    expect(r.sections).toHaveLength(1);
    expect(r.cuts).toHaveLength(0);
    const s = r.sections[0];
    // Every square-on way up, for comparison.
    const supports = ([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as Vec3[])
      .map((up) => supportArea(posedSoup({ ...s, up, spin: 0 }), 45, 0.5).area);
    expect(s.supportMm2).toBeLessThanOrEqual(Math.min(...supports) + 1e-6);
    expect(s.supportMm2).toBeLessThan(Math.max(...supports));
  });

  it('turns an overhang-heavy T over so it needs next to no support', () => {
    // A stem with a wide bar across its top: printed as modelled, the bar's
    // underside is all overhang. Upside down, it is a stem on a flat bar.
    const soups = [box(20, 20, 80, [40, 40, 0]), box(100, 100, 10, [0, 0, 80])];
    const r = ok(splitForPrint(wasm, soups, { bed: bed200, joinery: { kind: 'none' } }));
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].supportMm2).toBeLessThan(1);
    expect(r.sections[0].up[2]).toBeLessThan(-0.99);
  });

  it('refuses something that is not a solid, and says why', () => {
    const open = box(50, 50, 50).slice(0, 9 * 10);
    // Ten of twelve triangles: two rims meeting at corners, not fillable as simple loops.
    const r = splitForPrint(wasm, [open], { bed: bed200 });
    if (r.ok) {
      // Filling the rim is allowed to rescue it — but then it must be closed.
      for (const s of r.sections) expect(analyzeMesh(Array.from(s.positions), Array.from(s.faces))!.closed).toBe(true);
    } else {
      expect(r.error).toMatch(/split|solid|volume/);
    }
  });
});

describe('splitForPrint — joinery', () => {
  const d = 6, c = 0.2, L = 20;
  const holeVolume = (pins: number) => {
    const r = (d + c) / 2;
    // A 48-gon, which is what the hole is cut with.
    const area = 0.5 * 48 * r * r * Math.sin((2 * Math.PI) / 48);
    return pins * area * (L / 2 + 0.5);
  };

  it('dowel holes take out exactly their own volume from each side', () => {
    const r = ok(splitForPrint(wasm, [box(300, 100, 100)], { bed: bed200, joinery: { kind: 'dowel', diameterMm: d, lengthMm: L, clearanceMm: c } }));
    expect(r.joints).toHaveLength(1);
    const pins = r.joints[0].pins.length;
    expect(pins).toBeGreaterThanOrEqual(2); // a 100 mm face has room for two
    for (const s of r.sections) {
      const plain = analyzeMesh(Array.from(s.plainPositions), Array.from(s.plainFaces))!.volume * 1e9;
      const lost = plain - s.volumeMm3;
      expect(lost).toBeCloseTo(holeVolume(pins), 0);
      expect(s.features.filter((f) => f.kind === 'bore')).toHaveLength(pins);
      expect(analyzeMesh(Array.from(s.positions), Array.from(s.faces))!.closed).toBe(true);
    }
  });

  it('pegs add to one side and holes take from the other', () => {
    const r = ok(splitForPrint(wasm, [box(300, 100, 100)], { bed: bed200, joinery: { kind: 'peg', diameterMm: d, lengthMm: L, clearanceMm: c } }));
    const joint = r.joints[0];
    expect(joint.pegSide).toBeDefined();
    const pegS = joint.pegSide === 'neg' ? joint.neg : joint.pos;
    const holeS = joint.pegSide === 'neg' ? joint.pos : joint.neg;
    const plainVol = (i: number) => analyzeMesh(Array.from(r.sections[i].plainPositions), Array.from(r.sections[i].plainFaces))!.volume * 1e9;
    expect(r.sections[pegS].volumeMm3).toBeGreaterThan(plainVol(pegS));
    expect(r.sections[holeS].volumeMm3).toBeLessThan(plainVol(holeS));
  });

  it('never prints a section standing on its pegs', () => {
    const r = ok(splitForPrint(wasm, [box(500, 120, 60)], { bed: bed200, joinery: { kind: 'peg' } }));
    for (const s of r.sections) {
      for (const f of s.features.filter((x) => x.kind === 'peg')) {
        // Face down means `up` points straight back along the peg.
        expect(s.up[0] * f.axis[0] + s.up[1] * f.axis[1] + s.up[2] * f.axis[2]).toBeGreaterThan(-0.99);
      }
    }
  });

  it('warns instead of placing a pin where the face is too thin for one', () => {
    const r = ok(splitForPrint(wasm, [box(300, 8, 100)], { bed: bed200, joinery: { kind: 'dowel' } }));
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    expect(r.joints.every((j) => j.pins.length === 0)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/held to the rest by glue alone/);
  });
});

describe('packOnBed', () => {
  it('lays parts out without overlap, inside the bed, spilling onto new plates', () => {
    const rects = [
      { w: 150, d: 60 }, { w: 80, d: 80 }, { w: 60, d: 150 }, { w: 120, d: 40 },
      { w: 100, d: 100 }, { w: 30, d: 30 }, { w: 180, d: 90 },
    ];
    const bed = { widthMm: 200, depthMm: 200 };
    const places = packOnBed(rects, bed, 5, 5);
    const boxes = places.map((p, i) => {
      const w = p.turned ? rects[i].d : rects[i].w;
      const d = p.turned ? rects[i].w : rects[i].d;
      return { ...p, w, d };
    });
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(5);
      expect(b.y).toBeGreaterThanOrEqual(5);
      expect(b.x + b.w).toBeLessThanOrEqual(195 + 1e-9);
      expect(b.y + b.d).toBeLessThanOrEqual(195 + 1e-9);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let k = i + 1; k < boxes.length; k++) {
        const a = boxes[i], b = boxes[k];
        if (a.plate !== b.plate) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.d <= b.y || b.y + b.d <= a.y;
        expect(apart).toBe(true);
      }
    }
    expect(Math.max(...places.map((p) => p.plate))).toBeGreaterThan(0);
  });
});

describe('layoutOnBed', () => {
  it('stands each section the way it prints, flat on the plate, inside the bed', () => {
    const r = ok(splitForPrint(wasm, [box(500, 120, 60)], { bed: bed200, joinery: { kind: 'peg' } }));
    const plated = layoutOnBed(r.sections.map((s, i) => ({
      name: `s${i}`, positions: s.positions, faces: s.faces, pose: { up: s.up, spin: s.spin }, colour: [1, 1, 1],
    })), bed200);
    expect(plated).toHaveLength(r.sections.length);
    for (const p of plated) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.positions[i + k]); hi[k] = Math.max(hi[k], p.positions[i + k]); }
      }
      expect(lo[2]).toBeCloseTo(0, 3);
      expect(hi[2]).toBeLessThanOrEqual(200 + 1e-3);
      const x0 = lo[0] - p.plate * (200 + 20);
      expect(x0).toBeGreaterThanOrEqual(5 - 1e-3);
      expect(x0 + hi[0] - lo[0]).toBeLessThanOrEqual(195 + 1e-3);
      expect(lo[1]).toBeGreaterThanOrEqual(5 - 1e-3);
      expect(hi[1]).toBeLessThanOrEqual(195 + 1e-3);
      // Turning and moving keeps it a solid wound outward.
      const integrity = analyzeMesh(Array.from(p.positions), Array.from(p.indices))!;
      expect(integrity.volume).toBeGreaterThan(0);
    }
  });
});

describe('partSoups', () => {
  it('takes a body together with the rigid bodies under it, so a part built as panels can be split', async () => {
    const { partSoups } = await import('../src/utils/printSplitClient');
    const { birdhousePreset } = await import('../src/presets/presetScenes');
    const root = birdhousePreset.nodes[0];
    // The root itself holds nothing; its seven panels are child bodies.
    expect(root.geoms).toHaveLength(0);
    const { soups, absorbed } = partSoups(root);
    expect(absorbed).toHaveLength(7);
    expect(soups).toHaveLength(7);
    const r = ok(splitForPrint(wasm, soups, { bed: { widthMm: 150, depthMm: 150, heightMm: 150 }, joinery: { kind: 'dowel' } }));
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    expect(r.sections.every((s) => s.fits)).toBe(true);
  });

  it('leaves out a child with a joint of its own: it is a separate part', async () => {
    const { partSoups } = await import('../src/utils/printSplitClient');
    const cube = { name: 'c', type: 'box' as const, size: [0.01, 0.01, 0.01] };
    const node = {
      id: 'p', name: 'p', pos: [0, 0, 0], joints: [], geoms: [cube],
      children: [
        { id: 'fixed', name: 'fixed', pos: [0.02, 0, 0], joints: [], geoms: [{ ...cube, name: 'f' }], children: [] },
        { id: 'hinged', name: 'hinged', pos: [0, 0.05, 0], joints: [{ name: 'h', type: 'hinge' as const }], geoms: [{ ...cube, name: 'h' }], children: [] },
      ],
    };
    const { soups, absorbed } = partSoups(node);
    expect(absorbed).toEqual(['fixed']);
    expect(soups).toHaveLength(2);
    // The rigid child lands where it is attached, in the parent's frame.
    const xs = Array.from(soups[1]).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0.01, 9);
  });
});

describe('exact convex pieces', () => {
  it('cuts a concave section into convex pieces that fill it exactly', () => {
    // An L that fits the bed: one section, solidity well under 1.
    const r = ok(splitForPrint(wasm, [box(120, 40, 10), box(10, 40, 80, [0, 0, 10])], { bed: bed200, joinery: { kind: 'none' } }));
    const s = r.sections[0];
    expect(s.solidity).toBeLessThan(0.6);
    expect(s.convexPieces.length).toBe(2);
    const vol = (p: { positions: Float32Array; faces: Uint32Array }) =>
      analyzeMesh(Array.from(p.positions), Array.from(p.faces))!.volume * 1e9;
    const total = s.convexPieces.reduce((v, p) => v + vol(p), 0);
    expect(total).toBeCloseTo(vol({ positions: s.plainPositions, faces: s.plainFaces }), 0);
  });

  it('leaves a convex section alone', () => {
    const r = ok(splitForPrint(wasm, [box(300, 100, 100)], { bed: bed200, joinery: { kind: 'none' } }));
    for (const s of r.sections) expect(s.convexPieces).toHaveLength(0);
  });
});

describe('selectionSoups', () => {
  it('takes several selected bodies as one part, in the first one\'s frame', async () => {
    const { selectionSoups } = await import('../src/utils/printSplitClient');
    const cube = (name: string) => ({ name, type: 'box' as const, size: [0.01, 0.01, 0.01] });
    const scene = {
      nodes: [
        { id: 'a', name: 'a', pos: [0.1, 0, 0], joints: [], geoms: [cube('ga')], children: [] },
        { id: 'b', name: 'b', pos: [0.12, 0, 0], joints: [], geoms: [cube('gb')], children: [] },
        { id: 'c', name: 'c', pos: [5, 0, 0], joints: [], geoms: [cube('gc')], children: [] },
      ],
    };
    const { soups, absorbed } = selectionSoups(scene, ['a', 'b']);
    expect(absorbed).toEqual(['b']);
    expect(soups).toHaveLength(2);
    // b sits 20 mm along from a, and a's frame is the origin.
    const xs = Array.from(soups[1]).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0.01, 7);
    expect(Math.max(...xs)).toBeCloseTo(0.03, 7);
    // Touching cubes split as one solid.
    const r = ok(splitForPrint(wasm, soups, { bed: bed200, joinery: { kind: 'none' } }));
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].volumeMm3).toBeCloseTo(2 * 20 * 20 * 20, 0);
  });
});
