import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, exportBinarySTL, moldSummary, DEFAULT_MOLD_OPTIONS, type MoldOptions, type MoldExportResult, type MoldMeshHalf, type Triangle3D } from '../src/utils/moldExporter';
import { sealRing, SEAL_GROOVE_CLEAR_MM, SEAL_GROOVE_D_MM, SEAL_TONGUE_H_MM, SEAL_TONGUE_W_MM, DEFAULT_LINER_SKIN_MM } from '../src/utils/moldLiner';
import { moldOptionsFor, moldStepLines, moldMasterRecord, moldSceneParts } from '../src/utils/moldWorkerClient';
import { loadManifold } from '../src/utils/sculptCut';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { simulatedBody } from '../src/utils/simulatedPart';
import { simulateCastFromMoldNode, simulateCastFromMoldResult, weldTriangles } from '../src/utils/moldCastSimulation';
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
        const linerPieces: Triangle3D[][] = [];
        if (h.liner!.pieceTriangles) {
          let off = 0;
          for (const count of h.liner!.pieceTriangles) {
            linerPieces.push(h.liner!.liner.slice(off, off + count));
            off += count;
          }
        } else {
          linerPieces.push(h.liner!.liner);
        }
        for (const tris of [h.liner!.shell, ...linerPieces]) {
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
  it('prints as support-free 1-piece holders and captive flat-backed inserts with no loose stem cuts', () => {
    expect(insert.success, insert.error).toBe(true);
    expect(insert.liner!.construction).toBe('insert');
    expect(moldSummary(insert).parts.map((p) => p.name)).toEqual([
      'Cavity Half holder',
      'Cavity Half insert',
      'Lid Half (Pins, Sprue & Vents) holder',
      'Lid Half (Pins, Sprue & Vents) insert',
    ]);
    expect(insert.liner!.steps.join(' ')).not.toMatch(/comes in \d+ pieces/);
    const model = strFromU8(unzipSync(insert.threeMf!)['3D/3dmodel.model']);
    expect(model.match(/holder \(ASA\)/g)).toHaveLength(2);
    expect(model.match(/insert \(HIPS\)/g)).toHaveLength(2);

    // Combined clamshell warns about snipping flared sprue/vent plugs and computes longer seam-first dissolution than insert.
    expect(combined.liner!.steps.join(' ')).toMatch(/snip or drill any flared sprue and vent plugs flush/);
    expect(combined.liner!.thickestLinerMm).toBeGreaterThan(insert.liner!.thickestLinerMm * 2);

    // Without through-floor channels, each half also prints as one holder + one insert (4 bodies total).
    const unchannelled = generateMoldMeshes(
      ball,
      { ...OPTS, linerConstruction: 'insert', includeSprue: false, includeVents: false },
      wasm,
    );
    expect(unchannelled.success, unchannelled.error).toBe(true);
    expect(moldSummary(unchannelled).parts.map((p) => p.name)).toEqual([
      'Cavity Half holder', 'Cavity Half insert', 'Lid Half (Pins, Sprue & Vents) holder', 'Lid Half (Pins, Sprue & Vents) insert',
    ]);
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
    expect(insert.liner!.steps.join(' ')).toMatch(/supports off: nothing in them needs any, and support printed inside the cavity would take the casting's place/);
    expect(combined.liner!.clampGrams).toBeGreaterThan(0);
  });

  it('is taken over MCP as liner_construction and seal_ridge', () => {
    expect(moldOptionsFor({ linerConstruction: 'insert', sealRidge: false }).options).toMatchObject({ linerConstruction: 'insert', sealRidge: false });
    expect(moldOptionsFor({ linerConstruction: 'bucket' }).error).toMatch(/liner_construction/);
  });

  it('keeps fit bottom-fed mug holders as 1 lump with >= 0.20 mm sleeve clearance, exact combined interface, and warning-free open/clamshell insert cast simulation', async () => {
    const MM = 0.001;
    const cupOuter = wasm.Manifold.cylinder(36, 20, 20, 48, false);
    const cupInner = wasm.Manifold.cylinder(32, 16, 16, 48, false).translate([0, 0, 4]);
    const cup = cupOuter.subtract(cupInner);
    const torusCs = new wasm.CrossSection(
      [Array.from({ length: 24 }, (_, k) => [10 + 3 * Math.cos((k * Math.PI) / 12), 3 * Math.sin((k * Math.PI) / 12)] as [number, number])],
      'Positive',
    );
    const handle = wasm.Manifold.revolve(torusCs, 36).rotate([90, 0, 0]).translate([20, 0, 18]);
    torusCs.delete();
    const mugSolid = cup.add(handle.subtract(cupInner));
    const mugVol = mugSolid.volume();
    const pm = mugSolid.getMesh();
    const verts: number[] = [];
    for (let i = 0; i < pm.vertProperties.length; i += pm.numProp) {
      verts.push(pm.vertProperties[i] * MM, pm.vertProperties[i + 1] * MM, pm.vertProperties[i + 2] * MM);
    }
    for (const m of [cupOuter, cupInner, cup, handle, mugSolid]) m.delete();

    const mugScene: SceneGraph = {
      nodes: [{
        id: 'mug',
        name: 'mug',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [{ name: 'g', type: 'mesh', size: [1], renderVertices: verts, vertices: verts, faces: Array.from(pm.triVerts) } as unknown as SceneGeom],
        joints: [],
        children: [],
      }],
    };

    const toM = (tris: Triangle3D[]) => {
      const arr = new Float64Array(tris.length * 9);
      tris.forEach((t, i) => arr.set([...t.a, ...t.b, ...t.c], i * 9));
      const w = weldTriangles(arr, 0);
      return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: w.positions, triVerts: w.faces }));
    };

    const mugFitInsert = generateMoldMeshes(mugScene, {
      ...OPTS,
      blockShape: 'fit',
      sprueFeed: 'bottom',
      linerConstruction: 'insert',
    }, wasm);
    expect(mugFitInsert.success, mugFitInsert.error).toBe(true);
    const bH = toM(mugFitInsert.bottomHalf.liner!.shell);
    const bI = toM(mugFitInsert.bottomHalf.liner!.liner);
    const tH = toM(mugFitInsert.topHalf!.liner!.shell);
    const tI = toM(mugFitInsert.topHalf!.liner!.liner);
    expect(bH.decompose()).toHaveLength(1);
    expect(tH.decompose()).toHaveLength(1);
    expect(bH.intersect(bI).volume()).toBeLessThan(1e-5);
    expect(tH.intersect(tI).volume()).toBeLessThan(1e-5);
    for (const [h, ins, z] of [[bH, bI, mugFitInsert.bottomHalf.partingZMm - 6], [tH, tI, mugFitInsert.topHalf!.partingZMm - 6]] as const) {
      const sH = h.slice(z);
      const sI = ins.slice(z).offset(0.20, 'Round');
      expect(sH.intersect(sI).area()).toBeLessThan(1e-4);
      sH.delete();
      sI.delete();
    }
    for (const m of [bH, bI, tH, tI]) m.delete();

    // Combined fit mug: exact shared mating interface (shell ∩ liner === 0).
    const mugFitCombined = generateMoldMeshes(mugScene, {
      ...OPTS,
      blockShape: 'fit',
      sprueFeed: 'bottom',
      linerConstruction: 'combined',
    }, wasm);
    expect(mugFitCombined.success, mugFitCombined.error).toBe(true);
    const cBS = toM(mugFitCombined.bottomHalf.liner!.shell);
    const cBL = toM(mugFitCombined.bottomHalf.liner!.liner);
    const cTS = toM(mugFitCombined.topHalf!.liner!.shell);
    const cTL = toM(mugFitCombined.topHalf!.liner!.liner);
    expect(cBS.intersect(cBL).volume()).toBeLessThan(1e-5);
    expect(cTS.intersect(cTL).volume()).toBeLessThan(1e-5);
    for (const m of [cBS, cBL, cTS, cTL]) m.delete();

    // Open mug insert: zero bogus "Another cavity" / "Another pocket" warnings on both Result and SceneNode.
    const openMug = generateMoldMeshes(mugScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      pullDirection: '+z',
      dissolvableLiner: true,
      linerConstruction: 'insert',
      castMaterial: 'epoxy',
    }, wasm);
    expect(openMug.success, openMug.error).toBe(true);
    const castRes = await simulateCastFromMoldResult(openMug, { trimChannels: true });
    expect(castRes.success, castRes.error).toBe(true);
    expect(Math.abs(castRes.castVolumeMm3 - mugVol) / mugVol).toBeLessThan(0.02);
    expect(castRes.warnings.some((w) => /another cavity|another pocket/i.test(w))).toBe(false);

    const openSummary = moldSummary(openMug);
    const openMesh = stlToMesh(openMug.binarySTL);
    const openNode = simulatedBody({ ...openMesh, cellMm: 0, toleranceMm: 0 }, {
      modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [-40, -40, 0], modelMaxMm: [40, 40, 45],
    }, { id: 'open_mug_node', name: 'Open Mug Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(openSummary) });
    openNode.simulation = { ...openNode.simulation!, mold: moldMasterRecord(mugScene, openSummary) };
    const castNode = await simulateCastFromMoldNode(openNode, { pour: { direction: 'auto' } });
    expect(castNode.success, castNode.error).toBe(true);
    expect(Math.abs(castNode.castVolumeMm3 - mugVol) / mugVol).toBeLessThan(0.02);
    expect(castNode.warnings.some((w) => /another cavity|another pocket/i.test(w))).toBe(false);
  }, 120_000);
});
