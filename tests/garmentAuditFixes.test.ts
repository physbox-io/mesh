import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { limbLoft } from '../src/utils/cloth/limbLoft';
import { formLimbs, limbSections } from '../src/utils/cloth/formLimbs';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { bodyFormKey, mergeBodyForm, needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { buildBodyFormOffThread, BodyFormSupersededError } from '../src/utils/cloth/bodyFormClient';
import { bodyFormNode, garmentNode, releaseGarments } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { delaunay } from '../src/utils/cloth/delaunay';
import { healFlatTriangles } from '../src/utils/cloth/garmentSurface';
import { reposeDraft, reposeGarments } from '../src/utils/cloth/garmentRepose';
import { closestOnTri } from '../src/utils/cloth/clothColliders';
import { clothRun } from './clothSimHarness';
import type { SceneNode } from '../src/types/scene';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('garment & body-form audit regression fixes', () => {
  it('loads clothPresets and urbanCollection lazily in < 500 ms without eager body-form meshing', async () => {
    const t0 = performance.now();
    const clothPresets = await import('../src/presets/clothPresets');
    const { urbanCollectionPreset } = await import('../src/presets/urbanCollection');
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);

    let formCount = 0;
    const visit = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (n.bodyForm) {
          formCount++;
          expect(n.geoms.length, `preset form ${n.name} should start lazy`).toBe(0);
          expect(needsBodyFormBuild(n)).toBe(true);
        }
        if (n.children?.length) visit(n.children);
      }
    };
    for (const val of Object.values(clothPresets)) {
      if (val && typeof val === 'object' && 'nodes' in val) visit((val as { nodes: SceneNode[] }).nodes);
    }
    visit(urbanCollectionPreset.nodes);
    expect(formCount).toBeGreaterThanOrEqual(14);
  });

  it('keeps bodyFormKey invariant to node name/id renames', () => {
    const a = bodyFormNode('f1', 'Form A', { figure: 'female', chest: 0.94 });
    const b = { ...a, id: 'f2', name: 'Renamed Form' };
    expect(bodyFormKey(b)).toBe(bodyFormKey(a));
    expect(needsBodyFormBuild(b)).toBe(false);
  });

  it('preserves a moved & rotated dress form world pose in releaseGarments', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' }, [1.25, -0.6, 0.1]);
    form.euler = [0, 0, 45];
    // Simulate a garment whose own pos was left at [0, 0, 0] while fitted to the moved form.
    const g = garmentNode('dress', 'dress', { garment: 'dress' }, form);
    g.pos = [0, 0, 0];
    delete g.euler;
    delete g.quat;

    const [released] = releaseGarments([g], [form]);
    expect(released.cloth?.garment?.fitTo).toBeUndefined();
    expect(released.cloth?.garment?.form?.figure).toBe('female');
    expect(released.pos?.[0]).toBeCloseTo(1.25, 6);
    expect(released.pos?.[1]).toBeCloseTo(-0.6, 6);
    expect(released.pos?.[2]).toBeCloseTo(0.1, 6);
    expect(released.euler).toEqual([0, 0, 45]);
  });

  it('produces 0 inverted faces on bent knees/elbows and handles parallel side vectors in limbLoft', () => {
    // 1. Sharp knee bend with thick thigh ([G-1]: previously had 54 inverted quads).
    const m = clampBodyForm({ figure: 'female', kneeBend: 110, thigh: 0.85, hip: 1.2 });
    const leg = formLimbs(m).legL;
    const secs = limbSections(leg);
    const { vertices, faces } = limbLoft(secs, [1, 0, 0]);
    expect(vertices.every(Number.isFinite)).toBe(true);

    // Check every ring-strip quad face normal points outward relative to the local section axis,
    // and check positive enclosed volume with zero degenerate/NaN triangles.
    const ang = 48; // leg has custom shape -> 48 angles
    const capRings = 4;
    let inverted = 0;
    // Convert Three.js Y-up (x, z, -y) back to Z-up (x, y, z) to compare against section centres.
    const ptZ = (idx: number) => [vertices[3 * idx], -vertices[3 * idx + 2], vertices[3 * idx + 1]];
    for (let i = 0; i + 1 < secs.length; i++) {
      const r = capRings + i;
      const cMid = [
        0.5 * (secs[i].p[0] + secs[i + 1].p[0]),
        0.5 * (secs[i].p[1] + secs[i + 1].p[1]),
        0.5 * (secs[i].p[2] + secs[i + 1].p[2]),
      ];
      const baseF = (r * ang) * 2 * 3;
      for (let f = baseF; f < baseF + ang * 2 * 3; f += 3) {
        const a = ptZ(faces[f]), b = ptZ(faces[f + 1]), c = ptZ(faces[f + 2]);
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const mx = (a[0] + b[0] + c[0]) / 3 - cMid[0];
        const my = (a[1] + b[1] + c[1]) / 3 - cMid[1];
        const mz = (a[2] + b[2] + c[2]) / 3 - cMid[2];
        if (nx * mx + ny * my + nz * mz < 0) inverted++;
      }
    }
    expect(inverted).toBe(0);

    // 2. Parallel side vector `side || t` fallback.
    const vertical = limbLoft(
      [
        { p: [0, 0, 0], w: 0.05, h: 0.04 },
        { p: [0, 0, 0.2], w: 0.05, h: 0.04 },
        { p: [0, 0, 0.4], w: 0.04, h: 0.03 },
      ],
      [0, 0, 1],
    );
    expect(vertical.vertices.every(Number.isFinite)).toBe(true);
    let areaSum = 0;
    for (let f = 0; f < vertical.faces.length; f += 3) {
      const i0 = 3 * vertical.faces[f], i1 = 3 * vertical.faces[f + 1], i2 = 3 * vertical.faces[f + 2];
      const ux = vertical.vertices[i1] - vertical.vertices[i0], uy = vertical.vertices[i1 + 1] - vertical.vertices[i0 + 1], uz = vertical.vertices[i1 + 2] - vertical.vertices[i0 + 2];
      const vx = vertical.vertices[i2] - vertical.vertices[i0], vy = vertical.vertices[i2 + 1] - vertical.vertices[i0 + 1], vz = vertical.vertices[i2 + 2] - vertical.vertices[i0 + 2];
      areaSum += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    expect(areaSum).toBeGreaterThan(0.05);
  });

  it('preserves full joined front+lapel outline area on a cropped shawl bolero and keeps trim runs pure', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const bolero = garmentNode(
      'bolero',
      'bolero',
      {
        garment: 'jacket',
        length: -0.18,
        lapels: { break: 0.24, width: 0.07, shawl: true },
        collar: { stand: 0.015, standFront: 0.005, fall: 0.06 },
        trims: [{ kind: 'button', along: 'opening', spacing: 0.06 }],
      },
      form,
    );
    const m1 = clothModel(bolero, new THREE.Matrix4(), [form, bolero]);
    const m2 = clothModel(bolero, new THREE.Matrix4(), [form, bolero]);

    // Deterministic trim run numbering across repeated clothModel calls ([G-6]).
    const runs1 = m1.groups.flatMap((g) => (g.trims ?? []).map((t) => t.run));
    const runs2 = m2.groups.flatMap((g) => (g.trims ?? []).map((t) => t.run));
    expect(runs1.length).toBeGreaterThan(0);
    expect(runs2).toEqual(runs1);

    // Outline polygon area must match 2D triangle mesh area for every joined front panel ([G-4]).
    for (const grp of m1.groups) {
      if (!grp.name.includes('front') || !grp.flat) continue;
      const { uv, outline } = grp.flat;
      let polyArea = 0;
      for (let i = 0; i < outline.length; i++) {
        const p = uv[outline[i]], q = uv[outline[(i + 1) % outline.length]];
        polyArea += p[0] * q[1] - q[0] * p[1];
      }
      polyArea = 0.5 * Math.abs(polyArea);

      let triArea = 0;
      for (let t = 0; t < grp.tris.length; t += 3) {
        const a = uv[grp.tris[t]], b = uv[grp.tris[t + 1]], c = uv[grp.tris[t + 2]];
        triArea += 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
      }
      // Note: shawl collar halves are laid onto the front by rigid 2D fit (`fit2` in garmentCollars.ts),
      // so curved gorge/neckline chords differ slightly (~10–28 cm^2 on ~1350 cm^2) from triangle sum,
      // whereas the pre-fix `fwd <= m - fwd` splice cut off >= 35.8 cm^2 (or half the cropped front!).
      expect(Math.abs(polyArea - triArea), grp.name).toBeLessThan(0.003);
      expect(polyArea, grp.name).toBeGreaterThan(0.97 * triArea);
    }
  });

  it('escapes XML special characters in patternSvg titles, piece names, and mark kinds', () => {
    const svg = patternSvg(
      [
        {
          name: 'Front & <Lapel> "A"',
          uv: [[0, 0], [0.1, 0], [0.1, 0.2], [0, 0.2]],
          outline: [0, 1, 2, 3],
          strain95: 0.01,
          marks: [{ kind: 'button & "snap" <1>', particle: 0, size: 0.01 }],
        },
      ],
      'Jacket <Draft> & "Test"',
    );
    expect(svg).toContain('Jacket &lt;Draft&gt; &amp; &quot;Test&quot;');
    expect(svg).toContain('Front &amp; &lt;Lapel&gt; &quot;A&quot;');
    expect(svg).toContain('button &amp; &quot;snap&quot; &lt;1&gt;');
    expect(svg).not.toContain('<Lapel>');
    expect(svg).not.toContain('<Draft>');
  });

  it('coalesces queued builds per key and isolates worker timeouts in bodyFormClient', async () => {
    vi.useFakeTimers();
    const posted: { id: number; prefix: string }[] = [];
    let latestWorker: { onmessage: ((e: MessageEvent) => void) | null; terminate: () => void } | null = null;
    class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestWorker = this;
      }
      postMessage(req: { id: number; prefix: string }) {
        posted.push({ id: req.id, prefix: req.prefix });
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', MockWorker);

    const m1 = clampBodyForm({ chest: 0.90 });
    const m2 = clampBodyForm({ chest: 0.94 });
    const m3 = clampBodyForm({ chest: 0.98 });
    const other = clampBodyForm({ chest: 1.02 });

    // First job starts immediately on worker; m2 & m3 queue behind same key 'formA' -> m2 is superseded!
    const p1 = buildBodyFormOffThread(m1, 'formA', 'formA');
    const p2 = buildBodyFormOffThread(m2, 'formA', 'formA');
    const p3 = buildBodyFormOffThread(m3, 'formA', 'formA');
    const pOther = buildBodyFormOffThread(other, 'formB', 'formB');

    await expect(p2).rejects.toBeInstanceOf(BodyFormSupersededError);
    expect(posted.length).toBe(1);

    // Timeout active job p1: only p1 should reject, and p3 should now start on a fresh worker!
    vi.advanceTimersByTime(60_001);
    await expect(p1).rejects.toThrow(/took too long/);
    expect(posted.length).toBe(2);

    // Complete p3 and then pOther cleanly.
    latestWorker!.onmessage!({ data: { type: 'BUILT', id: posted[1].id, geoms: [] } } as MessageEvent);
    await expect(p3).resolves.toEqual([]);
    expect(posted.length).toBe(3);
    latestWorker!.onmessage!({ data: { type: 'BUILT', id: posted[2].id, geoms: [] } } as MessageEvent);
    await expect(pOther).resolves.toEqual([]);
  });

  it('couples extreme anatomical measurements in clampBodyForm without self-intersection or runaway bust', () => {
    const extreme = clampBodyForm({
      figure: 'female',
      chest: 1.6,
      underbust: 0.45,
      shoulderWidth: 0.25,
      hip: 0.5,
      thigh: 0.85,
    });
    expect(extreme.underbust).toBeGreaterThanOrEqual(extreme.chest - 0.35);
    expect(extreme.shoulderWidth).toBeGreaterThan(0.35);
    expect(extreme.thigh!).toBeLessThanOrEqual(0.75 * extreme.hip + 1e-5);
    const L = bodyLandmarks(extreme);
    expect(Number.isFinite(L.bustProminence)).toBe(true);
    expect(L.bustProminence).toBeLessThan(0.25);
  });

  it('handles <3-vertex degenerate panels, near-collinear/duplicate Delaunay points, stale byEdge splits, and landmark repose', () => {
    // 1. flattenPanel with < 3 vertices returns cleanly without NaN.
    const deg = flattenPanel('tiny', [[0, 0, 0], [0.1, 0, 0]], [], []);
    expect(deg.uv.every(([u, v]) => Number.isFinite(u) && Number.isFinite(v))).toBe(true);

    // 2. delaunay with duplicate and near-collinear points far from origin.
    const pts: [number, number][] = [
      [1000, 2000],
      [1000 + 1e-12, 2000 - 1e-12], // duplicate
      [1000.1, 2000],
      [1000.2, 2000 + 1e-11], // near-collinear
      [1000.1, 2000.1],
    ];
    const dTris = delaunay(pts);
    expect(dTris.length).toBeGreaterThanOrEqual(3);
    expect(dTris.includes(1)).toBe(false); // duplicate skipped cleanly

    // 3. healFlatTriangles when two flat slivers share a neighbour triangle in the same pass.
    const hPts = [
      [0, 0, 0],     // 0
      [1, 0, 0],     // 1
      [0.5, 1, 0],   // 2 (big central triangle 0-1-2)
      [0.5, 0, 0],   // 3 (midpoint on 0-1)
      [0.75, 0.5, 0], // 4 (midpoint on 1-2)
    ];
    // Central tri (0, 1, 2) bordered by two collinear zero-area T-junction slivers (1, 0, 3) and (2, 1, 4).
    const healed = healFlatTriangles(hPts, [0, 1, 2, 1, 0, 3, 2, 1, 4], 1e-3);
    expect(healed.tris.length).toBe(9); // split into 3 valid triangles covering area 0.5
    let hArea = 0;
    for (let t = 0; t < healed.tris.length; t += 3) {
      const a = hPts[healed.tris[t]], b = hPts[healed.tris[t + 1]], c = hPts[healed.tris[t + 2]];
      hArea += 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    }
    expect(hArea).toBeCloseTo(0.5, 6);

    // 4. reposeDraft rotates landmark-anchored dart direction on limb and transforms arm-only plane z.
    const from = clampBodyForm({ figure: 'female', armAngle: 15, elbowBend: 0 });
    const to = clampBodyForm({ figure: 'female', armAngle: 80, elbowBend: 90 });
    const elbowL = formLimbs(from).armL.path.at(formLimbs(from).armL.path.jointAt);
    const reposed = reposeDraft(
      {
        garment: 'tshirt',
        sleeve: 0.5,
        darts: [{ name: 'elbowDart', apex: { limb: 'armL', along: 'joint', face: [0, -1, 0] }, length: 0.08, direction: [0, 0, 1] }],
        cuts: [{ name: 'cuffTrim', point: [elbowL[0], elbowL[1], elbowL[2]], normal: [1, 0, 0], on: ['armL'], z: [elbowL[2] - 0.05, elbowL[2] + 0.05] }],
      },
      from,
      to,
    );
    const newDir = reposed.darts![0].direction!;
    // Direction [0, 0, 1] at the elbow must rotate significantly when armAngle + elbowBend change!
    expect(Math.hypot(newDir[0], newDir[1], newDir[2] - 1)).toBeGreaterThan(0.2);
    const newZ = reposed.cuts![0].z!;
    expect(newZ[0]).not.toBeCloseTo(elbowL[2] - 0.05, 2);
  });

  it('builds and settles a manifold, hole-free, smooth upward-facing baseball cap brim in urban_collection and coherent collar/lapel winding', async () => {
    const { urbanCollectionPreset } = await import('../src/presets/urbanCollection');
    const { shirtAndJacketPreset } = await import('../src/presets/clothPresets');

    const countDuplicateHalfEdges = (tris: number[]) => {
      const seen = new Set<string>();
      let dup = 0;
      for (let t = 0; t < tris.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
          const key = `${a}->${b}`;
          if (seen.has(key)) dup++;
          seen.add(key);
        }
      }
      return dup;
    };

    // 1. Collared/lapelled jacket groups must have 0 duplicate half-edges across joined lapels and collar pieces.
    const sjNodes = shirtAndJacketPreset.nodes;
    const sjJacket = sjNodes.find((n) => n.name === 'jacket')!;
    const sjModel = clothModel(sjJacket, new THREE.Matrix4(), sjNodes);
    for (const grpName of ['jacket__frontL', 'jacket__frontR', 'jacket__collarStand', 'jacket__collar']) {
      const grp = sjModel.groups.find((g) => g.name === grpName)!;
      expect(grp, grpName).toBeDefined();
      expect(countDuplicateHalfEdges(grp.tris), grpName).toBe(0);
    }

    // 2. Baseball cap visor (`cap__peak`) in urban_collection: hole-free 2D triangulation & 100% manifold winding at build.
    const uNodes = urbanCollectionPreset.nodes;
    const formA = uNodes.find((n) => n.name === 'formA')!;
    const cap = uNodes.find((n) => n.name === 'cap')!;

    const cm = clothModel(cap, new THREE.Matrix4(), uNodes);
    const peak = cm.groups.find((g) => g.name === 'cap__peak')!;
    expect(peak).toBeDefined();
    expect(countDuplicateHalfEdges(peak.tris)).toBe(0);

    const { uv, outline } = peak.flat!;
    let polyArea = 0;
    const outlineEdges = new Set<string>();
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      polyArea += uv[a][0] * uv[b][1] - uv[b][0] * uv[a][1];
      outlineEdges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
    polyArea = 0.5 * Math.abs(polyArea);

    let triArea = 0;
    const edgeUse = new Map<string, number>();
    for (let t = 0; t < peak.tris.length; t += 3) {
      const ids = [peak.tris[t], peak.tris[t + 1], peak.tris[t + 2]];
      const [pa, pb, pc] = ids.map((k) => uv[k]);
      triArea += 0.5 * Math.abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]));
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      }
    }
    expect(Math.abs(polyArea - triArea)).toBeLessThan(1e-5);
    for (const [k, cnt] of edgeUse) {
      expect(cnt, `edge ${k} manifold`).toBeLessThanOrEqual(2);
      if (cnt === 1) expect(outlineEdges.has(k), `interior hole edge ${k}`).toBe(true);
    }

    // 3. Settle & drape urban_collection baseball cap on formA:
    // every peak triangle must face upward (+Z) with smooth adjacent normals (zero craters/dimples/inversions).
    const r = await clothRun([formA, cap]);
    let capBase = 0;
    for (const m of r.models) {
      if (m.name === 'cap') break;
      capBase += m.invMass.length;
    }

    const inspectPeak3D = (x: Float64Array) => {
      const normals: number[][] = [];
      let downCount = 0;
      const triByEdge = new Map<string, number[]>();
      for (let t = 0; t < peak.tris.length; t += 3) {
        const ids = [peak.tris[t], peak.tris[t + 1], peak.tris[t + 2]];
        const [pa, pb, pc] = ids.map((l) => capBase + peak.particles[l]);
        const ux = x[3 * pb] - x[3 * pa], uy = x[3 * pb + 1] - x[3 * pa + 1], uz = x[3 * pb + 2] - x[3 * pa + 2];
        const vx = x[3 * pc] - x[3 * pa], vy = x[3 * pc + 1] - x[3 * pa + 1], vz = x[3 * pc + 2] - x[3 * pa + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz);
        expect(nl).toBeGreaterThan(1e-8);
        normals.push([nx / nl, ny / nl, nz / nl]);
        if (nz <= 0) downCount++;
        for (let e = 0; e < 3; e++) {
          const a = ids[e], b = ids[(e + 1) % 3];
          const k = a < b ? `${a},${b}` : `${b},${a}`;
          (triByEdge.get(k) ?? triByEdge.set(k, []).get(k)!).push(t / 3);
        }
      }
      let minAdjDot = 1;
      for (const [, ts] of triByEdge) {
        if (ts.length !== 2) continue;
        const n0 = normals[ts[0]], n1 = normals[ts[1]];
        minAdjDot = Math.min(minAdjDot, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]);
      }
      return { downCount, minAdjDot };
    };

    const atSettle = inspectPeak3D(r.sim.x);
    expect(atSettle.downCount).toBe(0);
    expect(atSettle.minAdjDot).toBeGreaterThan(0.7);

    r.run(0.5);
    const afterDrape = inspectPeak3D(r.sim.x);
    expect(afterDrape.downCount).toBe(0);
    expect(afterDrape.minAdjDot).toBeGreaterThan(0.88);
  }, 120_000);

  it('eliminates harsh >=30° FeatureEdges seams at hips/thighs/wrists/elbows/ankles and keeps proportional hands, face, and feet', () => {
    const maxDihedralOf = (vertices: number[], faces: number[], zFilter?: (z: number) => boolean) => {
      const pts: [number, number, number][] = [];
      for (let i = 0; i < vertices.length; i += 3) pts.push([vertices[i], -vertices[i + 2], vertices[i + 1]]);
      const normals: [number, number, number][] = [];
      const edgeTris = new Map<string, number[]>();
      for (let t = 0; t < faces.length; t += 3) {
        const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1e-12;
        normals.push([nx / nl, ny / nl, nz / nl]);
        for (const [p, q] of [[ia, ib], [ib, ic], [ic, ia]]) {
          const k = p < q ? `${p},${q}` : `${q},${p}`;
          let list = edgeTris.get(k);
          if (!list) { list = []; edgeTris.set(k, list); }
          list.push(t / 3);
        }
      }
      let maxDeg = 0, over30 = 0;
      for (const [k, ts] of edgeTris) {
        if (ts.length !== 2) continue;
        const [ia, ib] = k.split(',').map(Number);
        const zMid = 0.5 * (pts[ia][2] + pts[ib][2]);
        if (zFilter && !zFilter(zMid)) continue;
        const n0 = normals[ts[0]], n1 = normals[ts[1]];
        const d = Math.max(-1, Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
        const deg = (Math.acos(d) * 180) / Math.PI;
        if (deg > maxDeg) maxDeg = deg;
        if (deg >= 30) over30++;
      }
      return { maxDeg, over30, pts };
    };

    for (const figure of ['male', 'female'] as const) {
      const form = bodyFormNode('form', 'form', { figure });
      const m = form.bodyForm!;
      const L = bodyLandmarks(m);
      const skin = form.geoms.find((g) => g.name === 'form_skin')!;
      const legL = form.geoms.find((g) => g.name === 'form_legL')!;
      const armL = form.geoms.find((g) => g.name === 'form_armL')!;
      const thumbL = form.geoms.find((g) => g.name === 'form_thumbL')!;
      const headSkin = form.geoms.find((g) => g.name === 'form_headSkin')!;

      // 1. Zero >=30° sharp edges across torso, hips/groin, legs, ankles, elbows, wrists, hands, and thumbs!
      expect(maxDihedralOf(skin.vertices!, skin.faces!).over30, `${figure} skin >=30°`).toBe(0);
      expect(maxDihedralOf(legL.vertices!, legL.faces!).over30, `${figure} legL >=30°`).toBe(0);
      expect(maxDihedralOf(armL.vertices!, armL.faces!).over30, `${figure} armL >=30°`).toBe(0);
      expect(maxDihedralOf(thumbL.vertices!, thumbL.faces!).over30, `${figure} thumbL >=30°`).toBe(0);

      // 2. Hip/crotch join: torso skin tucks cleanly inside upper thighs at crotchZ (no outer overhang shelf).
      const skinStats = maxDihedralOf(skin.vertices!, skin.faces!);
      const legStats = maxDihedralOf(legL.vertices!, legL.faces!);
      const skinOuterAtCrotch = Math.max(...skinStats.pts.filter((p) => Math.abs(p[2] - L.crotchZ) < 0.008).map((p) => p[0]));
      const legOuterAtCrotch = Math.max(...legStats.pts.filter((p) => Math.abs(p[2] - L.crotchZ) < 0.008).map((p) => p[0]));
      expect(skinOuterAtCrotch).toBeLessThan(legOuterAtCrotch);

      // 3. Hand proportions: sleek palm width (< 8.2 cm) and proportional wrist-to-tip reach (< 17.5 cm).
      const limbs = formLimbs(m);
      const palmSec = limbs.armL.section(m.armLength + 0.04);
      expect(2 * palmSec.w).toBeLessThan(0.082);
      expect(2 * palmSec.w).toBeGreaterThan(0.062);
      const handReach = limbs.armL.length - m.armLength + (limbs.armL.endCap ?? 0);
      expect(handReach).toBeLessThan(0.175);
      expect(handReach).toBeGreaterThan(0.145);

      // 4. Face smoothness (zero >=30° FeatureEdges scratches across headSkin), supraorbital brow arch,
      // clean nasion indentation (no top-of-nose bulge), and slender non-bulbous nasal tip.
      const s = m.height / 1.75;
      const faceStats = maxDihedralOf(headSkin.vertices!, headSkin.faces!);
      expect(faceStats.over30, `${figure} headSkin >=30°`).toBe(0);
      expect(faceStats.maxDeg, `${figure} headSkin maxDihedral`).toBeLessThan(30);

      const frontMinY = (zRel: number, xAbs: number, xTol = 0.004, zTol = 0.003) =>
        Math.min(
          ...faceStats.pts
            .filter((p) => p[1] < 0 && Math.abs(Math.abs(p[0]) - xAbs * s) < xTol * s && Math.abs(p[2] - (m.height + zRel * s)) < zTol * s)
            .map((p) => p[1]),
        );
      // Brow arch at x = +-30 mm stands proud (-Y) of the recessed upper orbital sulcus beneath it.
      const browY = frontMinY(-0.106, 0.030, 0.004, 0.002);
      const orbitSulcusY = frontMinY(-0.115, 0.030, 0.004, 0.0018);
      expect(browY, `${figure} brow arch proud of orbital sulcus`).toBeLessThan(orbitSulcusY - 0.0012 * s);

      // Nasion at z = -0.112..-0.115 has no outward bulge ahead of glabella (-0.105) and steps out cleanly down the bridge.
      const glabellaY = frontMinY(-0.105, 0, 0.004);
      const nasionY = frontMinY(-0.111, 0, 0.004);
      const midBridgeY = frontMinY(-0.135, 0, 0.004);
      expect(nasionY, `${figure} no glabella/nasion bulge`).toBeGreaterThanOrEqual(glabellaY - 0.0005 * s);
      expect(midBridgeY, `${figure} nasal bridge rises cleanly from nasion`).toBeLessThan(nasionY - 0.006 * s);

      // Slender, refined nasal tip (projection 3–6 mm past philtrum, tip crest half-width < 8 mm — never bulbous).
      const noseMinY = Math.min(...faceStats.pts.filter((p) => Math.abs(p[0]) < 0.01 * s && p[2] > m.height - 0.165 * s && p[2] < m.height - 0.140 * s).map((p) => p[1]));
      const philtrumMinY = Math.min(...faceStats.pts.filter((p) => Math.abs(p[0]) < 0.01 * s && p[2] > m.height - 0.176 * s && p[2] < m.height - 0.166 * s).map((p) => p[1]));
      expect(noseMinY).toBeLessThan(philtrumMinY - 0.0025 * s);
      expect(noseMinY, `${figure} nose not overly protruding`).toBeGreaterThan(nasionY - 0.016 * s);
      const tipCrestHalfWidth = Math.max(
        ...faceStats.pts
          .filter((p) => p[2] > m.height - 0.156 * s && p[2] < m.height - 0.144 * s && p[1] < noseMinY + 0.003 * s)
          .map((p) => Math.abs(p[0])),
      );
      expect(tipCrestHalfWidth, `${figure} slender nasal tip crest`).toBeLessThan(0.009 * s);

      // 5. Ankle & foot bounds: clears floor (z >= 0.012) with natural adult heel-to-toe length (22–27 cm).
      const footPts = legStats.pts.filter((p) => p[2] < 0.09);
      const minFootZ = Math.min(...footPts.map((p) => p[2]));
      const footLenY = Math.max(...footPts.map((p) => p[1])) - Math.min(...footPts.map((p) => p[1]));
      expect(minFootZ).toBeGreaterThanOrEqual(0.012);
      expect(footLenY).toBeGreaterThan(0.22);
      expect(footLenY).toBeLessThan(0.27);
    }
  });

  it('keeps visual thumbs attached as meshes and prevents feet/knees from poking through ballgown in a deep squat', async () => {
    const { ballgownPreset } = await import('../src/presets/clothPresets');
    const nodes = structuredClone(ballgownPreset.nodes);
    const prev = nodes[0].bodyForm!;
    const squat = mergeBodyForm(prev, { kneeBend: 95, stance: 10 });
    nodes[0].bodyForm = squat;
    const reposed = reposeGarments(nodes, nodes[0].name || nodes[0].id, prev, squat);

    // 1. Visual thumbs are lofted `type: 'mesh'` geoms anchored directly on the squatting hands (never stale primitive capsules).
    const builtForm = bodyFormNode('form', 'form', squat);
    for (const side of ['L', 'R'] as const) {
      const thumb = builtForm.geoms.find((g) => g.name === `form_thumb${side}`)!;
      const arm = builtForm.geoms.find((g) => g.name === `form_arm${side}`)!;
      expect(thumb.type).toBe('mesh');
      expect(thumb.role).toBe('visual');
      // Thumb base sits within 15 mm of the palm mesh in the squatting pose.
      const tx = thumb.vertices![0], ty = -thumb.vertices![2], tz = thumb.vertices![1];
      let minHandDist = Infinity;
      for (let i = 0; i < arm.vertices!.length; i += 3) {
        const ax = arm.vertices![i], ay = -arm.vertices![i + 2], az = arm.vertices![i + 1];
        minHandDist = Math.min(minHandDist, Math.hypot(tx - ax, ty - ay, tz - az));
      }
      expect(minHandDist).toBeLessThan(0.015);
    }

    // 2. Standing 2D pattern cut (`flat.uv` area) is unchanged by kneeBend/stance (no faked pattern pouch),
    // while 3D placement + XPBD settle drapes the ballgown cleanly over the squatting knees and feet with zero poke-through!
    const standingModel = clothModel(ballgownPreset.nodes[1], new THREE.Matrix4(), [bodyFormNode('form', 'form', prev), ...ballgownPreset.nodes.slice(1)]);
    const cr = await clothRun(reposed);
    cr.sim.settleNow();
    const sumUvArea = (m: ReturnType<typeof clothModel>) =>
      m.groups.reduce((acc, g) => {
        if (!g.flat) return acc;
        let area = 0;
        for (let t = 0; t < g.tris.length; t += 3) {
          const a = g.flat.uv[g.tris[t]], b = g.flat.uv[g.tris[t + 1]], c = g.flat.uv[g.tris[t + 2]];
          area += 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
        }
        return acc + area;
      }, 0);
    expect(Math.abs(sumUvArea(cr.models[0]) / sumUvArea(standingModel) - 1)).toBeLessThan(0.015);

    const rayHits = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: Float64Array, tris: ArrayLike<number>) => {
      let hits = 0;
      for (let t = 0; t < tris.length; t += 3) {
        const ia = 3 * tris[t], ib = 3 * tris[t + 1], ic = 3 * tris[t + 2];
        const ax = x[ia], ay = x[ia + 1], az = x[ia + 2];
        const e1x = x[ib] - ax, e1y = x[ib + 1] - ay, e1z = x[ib + 2] - az;
        const e2x = x[ic] - ax, e2y = x[ic + 1] - ay, e2z = x[ic + 2] - az;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) hits++;
      }
      return hits;
    };

    const x = cr.sim.x, tris = cr.models[0].tris;
    const q = [0, 0, 0];
    let footExposed = 0;
    let worstProtrusion = 0;
    for (const gName of ['form_legL', 'form_legR']) {
      const g = builtForm.geoms.find((m) => m.name === gName)!;
      for (let i = 0; i < g.vertices!.length; i += 6) {
        const lx = g.vertices![i], ly = -g.vertices![i + 2], lz = g.vertices![i + 1];
        if (lz > 0.45) continue;
        const dx = lx, dy = ly - 0.02, rl = Math.hypot(dx, dy) || 1;
        if (rayHits(lx, ly, lz, dx / rl, dy / rl, 0.005, x, tris) === 0) {
          if (lz < 0.20) footExposed++;
          let bestDist = Infinity;
          for (let t = 0; t < tris.length; t += 3) {
            const ia = 3 * tris[t], ib = 3 * tris[t + 1], ic = 3 * tris[t + 2];
            closestOnTri(lx, ly, lz, [x[ia], x[ia + 1], x[ia + 2]], [x[ib], x[ib + 1], x[ib + 2]], [x[ic], x[ic + 1], x[ic + 2]], q);
            bestDist = Math.min(bestDist, Math.hypot(lx - q[0], ly - q[1], lz - q[2]));
          }
          worstProtrusion = Math.max(worstProtrusion, bestDist);
        }
      }
    }
    expect(footExposed).toBe(0);
    expect(worstProtrusion).toBeLessThan(0.002);
    expect(cr.clearance()).toBeGreaterThan(-0.004);
    expect(cr.crossings().length).toBe(0);
  }, 120000);
});
