import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { limbLoft } from '../src/utils/cloth/limbLoft';
import { formLimbs, limbSections } from '../src/utils/cloth/formLimbs';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { bodyFormKey, needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { buildBodyFormOffThread, BodyFormSupersededError } from '../src/utils/cloth/bodyFormClient';
import { bodyFormNode, garmentNode, releaseGarments } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { delaunay } from '../src/utils/cloth/delaunay';
import { healFlatTriangles } from '../src/utils/cloth/garmentSurface';
import { reposeDraft } from '../src/utils/cloth/garmentRepose';
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
});
