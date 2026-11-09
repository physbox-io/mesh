import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, exportBinarySTL, moldSummary, DEFAULT_MOLD_OPTIONS, type MoldOptions, type MoldExportResult, type MoldMeshHalf, type Triangle3D } from '../src/utils/moldExporter';
import { sealRing, SEAL_GROOVE_CLEAR_MM, SEAL_GROOVE_D_MM, SEAL_TONGUE_H_MM, SEAL_TONGUE_W_MM, DEFAULT_LINER_SKIN_MM } from '../src/utils/moldLiner';
import { moldOptionsFor, moldStepLines } from '../src/utils/moldWorkerClient';
import { loadManifold } from '../src/utils/sculptCut';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

// A real ASA + HIPS gear mold came out of four hours in limonene with the lid
// glued on by its vent plugs and the casting held in the cavity half by the
// runner, all of them bare shell. Everything the pour touches is liner now,
// a lined clamshell seals its seam with a tongue and groove, and the liner can
// be printed as an insert in a reusable holder.

const ball: SceneGraph = {
  nodes: [{ id: 'b1', name: 'ball', type: 'body', pos: [0, 0, 0.03], geoms: [{ name: 'g', type: 'sphere', size: [0.025] } as SceneGeom], joints: [], children: [] }],
};

const OPTS: MoldOptions = {
  ...DEFAULT_MOLD_OPTIONS,
  moldType: 'clamshell',
  pullDirection: '+z',
  includeSprue: true,
  includeVents: true,
  dissolvableLiner: true,
  linerPair: 'asa_hips',
  castMaterial: 'epoxy',
  wallMarginMm: 14,
};

const SKIN = DEFAULT_LINER_SKIN_MM;

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

/** Four points round (x, y) at radius r. */
const around = (x: number, y: number, r: number) => [0, 1, 2, 3].map((k) => [x + r * Math.cos(k * Math.PI / 2 + 0.3), y + r * Math.sin(k * Math.PI / 2 + 0.3)]);

let wasm: ManifoldToplevel;
let combined: MoldExportResult;
let insert: MoldExportResult;
beforeAll(async () => {
  wasm = await loadManifold();
  combined = generateMoldMeshes(ball, OPTS, wasm);
  insert = generateMoldMeshes(ball, { ...OPTS, linerConstruction: 'insert' }, wasm);
}, 120_000);

describe('a lined mold sleeves everything the pour touches', () => {
  it('wraps the sprue neck and every vent in liner, through the whole lid', () => {
    expect(combined.success, combined.error).toBe(true);
    const lid = combined.topHalf!;
    const [cx, cy] = centre(lid);
    const f = combined.features!;
    const bores = [
      { at: f.sprue!.atMm, r: f.sprue!.narrowDiaMm! / 2 },
      ...f.vents.map((v) => ({ at: v.atMm, r: v.diaMm / 2 })),
    ];
    expect(bores.length).toBeGreaterThan(1);
    for (const b of bores) {
      for (const [x, y] of around(cx + b.at[0], cy + b.at[1], b.r + SKIN / 2)) {
        expect(crossings(lid.liner!.shell, x, y), `shell beside the bore at ${b.at}`).toEqual([]);
        expect(crossings(lid.liner!.liner, x, y).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('wraps the down-sprue in liner, with shell only under its sleeve', () => {
    const base = combined.bottomHalf;
    const [cx, cy] = centre(base);
    const down = combined.features!.downSprue!;
    for (const [x, y] of around(cx + down.atMm[0], cy + down.atMm[1], down.diaMm / 2 + SKIN / 2)) {
      const lin = crossings(base.liner!.liner, x, y);
      expect(lin[lin.length - 1]).toBeCloseTo(base.partingZMm, 1);
      // Liner from the parting face down to the floor, and the shell only below it.
      for (const z of crossings(base.liner!.shell, x, y)) expect(z).toBeLessThanOrEqual(lin[0] + 1e-3);
    }
  });

  it('keeps every piece closed and wound outward', () => {
    for (const r of [combined, insert]) {
      for (const h of [r.bottomHalf, r.topHalf!]) {
        for (const tris of [h.liner!.shell, h.liner!.liner]) {
          const mesh = stlToMesh(exportBinarySTL(tris));
          const a = analyzeMesh(Array.from(mesh.positions), Array.from(mesh.faces))!;
          expect(a.closed).toBe(true);
          expect(a.consistentlyWound).toBe(true);
        }
      }
    }
  });
});

describe('sealing ridge', () => {
  it('puts a tongue on the lid shell that drops into a groove in the cavity half', () => {
    for (const r of [combined, insert]) {
      expect(r.liner!.sealRidge, r.warnings.join(' ')).toBe(true);
      const lid = r.topHalf!;
      const base = r.bottomHalf;
      const [lx, ly] = centre(lid);
      const [bx, by] = centre(base);
      // Out from the centre at 20°, clear of the pins, sprue and notches.
      const ux = Math.cos(0.35), uy = Math.sin(0.35);
      const tongue: number[] = [];
      const groove: number[] = [];
      for (let d = 15; d < 38; d += 0.05) {
        const top = crossings(lid.liner!.shell, lx + d * ux, ly + d * uy);
        if (top.length && top[top.length - 1] > lid.partingZMm + SEAL_TONGUE_H_MM - 0.05) tongue.push(d);
        // The cavity half is the lid mirrored in Y.
        const floor = crossings(base.liner!.shell, bx + d * ux, by - d * uy);
        if (floor.length && floor[floor.length - 1] < base.partingZMm - SEAL_GROOVE_D_MM + 0.05) groove.push(d);
      }
      expect(tongue.length).toBeGreaterThan(0);
      const t0 = tongue[0], t1 = tongue[tongue.length - 1];
      expect(t1 - t0).toBeCloseTo(SEAL_TONGUE_W_MM, 0);
      // Clear of the groove's walls on both sides.
      expect(groove.some((d) => d < t0 - 0.05)).toBe(true);
      expect(groove.some((d) => d > t1 + 0.05)).toBe(true);
      for (const d of tongue) expect(groove.some((g) => Math.abs(g - d) < 0.03)).toBe(true);
    }
    const plain = generateMoldMeshes(ball, { ...OPTS, sealRidge: false }, wasm);
    expect(plain.liner!.sealRidge).toBe(false);
  });

  it('seats the tongue inside its groove with clearance both sides', () => {
    const sq = (h: number) => new wasm.CrossSection([[[-h, -h], [h, -h], [h, h], [-h, h]]]);
    const face = sq(10);
    const blockFace = sq(25);
    const none = { sockets: [], pins: [], channels: [] };
    const ring = sealRing(wasm, { face, blockFace, features: none }, { face, blockFace, features: none });
    expect('error' in ring).toBe(false);
    if ('error' in ring) return;
    const back = ring.tongue.mirror([0, 1]);
    // The tongue grown by a hair under the clearance still lies in the groove.
    const grown = back.offset(SEAL_GROOVE_CLEAR_MM - 0.02, 'Round');
    expect(grown.subtract(ring.groove).area()).toBeLessThan(1e-3);
    expect(back.area()).toBeGreaterThan(4 * 20 * SEAL_TONGUE_W_MM);
  });

  it('says so and skips it where there is no room', () => {
    const sq = (h: number) => new wasm.CrossSection([[[-h, -h], [h, -h], [h, h], [-h, h]]]);
    const none = { sockets: [], pins: [], channels: [] };
    const ring = sealRing(wasm, { face: sq(10), blockFace: sq(11), features: none }, { face: sq(10), blockFace: sq(11), features: none });
    expect('error' in ring && ring.error).toMatch(/No room for the sealing ridge/);
  });
});

describe('holder and insert', () => {
  it('prints as four bodies: two holders and two inserts', () => {
    expect(insert.success, insert.error).toBe(true);
    expect(insert.liner!.construction).toBe('insert');
    expect(moldSummary(insert).parts.map((p) => p.name)).toEqual([
      'Cavity Half holder', 'Cavity Half insert', 'Lid Half (Pins, Sprue & Vents) holder', 'Lid Half (Pins, Sprue & Vents) insert',
    ]);
    const model = strFromU8(unzipSync(insert.threeMf!)['3D/3dmodel.model']);
    expect(model.match(/holder \(ASA\)/g)).toHaveLength(2);
    expect(model.match(/insert \(HIPS\)/g)).toHaveLength(2);
  });

  it('lifts the holder straight off, clear of the insert', () => {
    const base = insert.bottomHalf;
    const { shell: holder, liner: ins } = base.liner!;
    let checked = 0;
    for (let x = base.bounds.minX + 0.37; x < base.bounds.maxX; x += 1.13) {
      for (let y = base.bounds.minY + 0.41; y < base.bounds.maxY; y += 1.19) {
        const h = crossings(holder, x, y);
        // From the bed up, once: nothing of the holder over the insert.
        expect(h.length === 0 || h.length === 2, `holder at ${x}, ${y}: ${h}`).toBe(true);
        const i = crossings(ins, x, y);
        if (h.length === 2 && i.length) expect(i[0]).toBeGreaterThan(h[1] + 0.1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('tells you to clamp, release and how to dissolve, in the note card too', () => {
    for (const r of [combined, insert]) {
      const steps = r.liner!.steps.join(' ');
      expect(steps).toMatch(/petroleum jelly/);
      expect(steps).toMatch(/clamp them: binder clips round the edge, or at least \d+ g on the lid/);
      expect(steps).toMatch(/d-limonene/);
      expect(steps).toMatch(/never over a flame/);
      expect(moldStepLines(moldSummary(r))[0]).toMatch(/^Step 1: Print/);
    }
    expect(insert.liner!.steps.join(' ')).toMatch(/supports from the build plate only/);
    expect(combined.liner!.clampGrams).toBeGreaterThan(0);
  });

  it('is taken over MCP as liner_construction and seal_ridge', () => {
    expect(moldOptionsFor({ linerConstruction: 'insert', sealRidge: false }).options).toMatchObject({ linerConstruction: 'insert', sealRidge: false });
    expect(moldOptionsFor({ linerConstruction: 'bucket' }).error).toMatch(/liner_construction/);
  });
});
