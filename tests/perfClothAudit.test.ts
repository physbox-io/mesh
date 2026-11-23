import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { bodyFormGeoms, clampBodyForm } from '../src/utils/cloth/bodyForm';
import { headField, headRadius } from '../src/utils/cloth/formHead';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { closeSdf, gridOver, meshSdf, sampleGrid, sampleGridXYZ } from '../src/utils/cloth/formSdf';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { clothModel } from '../src/utils/cloth/clothModel';
import { buildSdf, sceneColliders } from '../src/utils/cloth/clothColliders';
import { ClothSim, CLOTH_SUBSTEP } from '../src/utils/cloth/xpbd';
import { ClothCcd } from '../src/utils/cloth/clothCcd';
import { contourStep, findCrossings, undoCrossingMoves, untangleMesh } from '../src/utils/cloth/clothUntangle';
import { syncClothSlabGeometry } from '../src/components/scene/ClothLayer';
import { buildClothTrims, placeClothTrims } from '../src/components/scene/clothTrims';
import { weaveTexture } from '../src/components/scene/clothWeaveTexture';
import type { FlexInfo } from '../src/workers/physicsWorkerProtocol';

describe('perfClothAudit benchmarks & regressions', () => {
  it('measures bodyForm, garmentShell, flatten, SDF, XPBD, CCD, untangle, and viewport sync', () => {
    // 1. BodyForm build (cold male + partial edit waist change)
    const t0 = performance.now();
    const mMale = clampBodyForm({ figure: 'male', waist: 0.87 });
    const gMale = bodyFormGeoms(mMale, 'bench');
    const tBodyCold = performance.now() - t0;

    const t1 = performance.now();
    const mEdit = clampBodyForm({ figure: 'male', waist: 0.71 });
    const gEdit = bodyFormGeoms(mEdit, 'bench');
    const tBodyEdit = performance.now() - t1;
    expect(gMale.length).toBeGreaterThan(10);
    expect(gEdit.length).toBeGreaterThan(10);

    // 2. GarmentShell + Flatten (jacket on default male form)
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const gNode = garmentNode('jacket', 'jacket', { garment: 'jacket' }, form);
    const t2 = performance.now();
    const shell = garmentShell(gNode.cloth!.garment!, form.bodyForm!);
    const tShell = performance.now() - t2;

    const seamPaths = shell.seams.map((s) => s.path);
    const t3 = performance.now();
    const flats = shell.panels.map((p) => flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, seamPaths, 15, p.upAxis));
    const tFlatten = performance.now() - t3;
    expect(flats.length).toBeGreaterThan(2);
    for (const flat of flats) {
      expect(flat.strain95).toBeLessThan(0.12);
      expect(Math.abs(flat.areaChange)).toBeLessThan(0.12);
    }

    // 3. Mesh SDF build (torso skin)
    const skin = form.geoms.find((g) => g.name === 'form_skin')!;
    const pts: number[][] = [];
    for (let i = 0; i < skin.vertices!.length; i += 3) {
      pts.push([skin.vertices![i], -skin.vertices![i + 2], skin.vertices![i + 1]]);
    }
    const t4 = performance.now();
    const sdf = buildSdf(pts, skin.faces!);
    const tSdf = performance.now() - t4;
    expect(sdf.d.length).toBeGreaterThan(1000);

    // 4. XPBD stepping (tshirt on form, 120 substeps = 0.2s sim time)
    const tshirt = garmentNode('shirt', 'shirt', { garment: 'tshirt' }, form);
    const model = clothModel(tshirt, new THREE.Matrix4(), [form, tshirt]);
    const colliders = sceneColliders([form], true, false);
    const sim = new ClothSim([model], colliders);
    sim.setPoses(() => new THREE.Matrix4());
    sim.settleNow();
    const env = { gravity: [0, 0, -9.81] as [number, number, number], wind: [2.0, 0.5, 0] as [number, number, number], airDensity: 1.2 };
    const t5 = performance.now();
    sim.advance(120 * CLOTH_SUBSTEP, env);
    const tXpbd = performance.now() - t5;

    // 5. Untangle + CCD stress
    const nGrid = 21, hGrid = 0.01;
    const ux: number[] = [], utris: number[] = [];
    const addSheet = (zFn: (i: number, j: number) => number, base: number, off: number) => {
      for (let i = 0; i < nGrid; i++) for (let j = 0; j < nGrid; j++) {
        ux.push((i - (nGrid - 1) / 2) * hGrid + off, (j - (nGrid - 1) / 2) * hGrid + 0.7 * off, zFn(i, j));
      }
      for (let i = 0; i + 1 < nGrid; i++) for (let j = 0; j + 1 < nGrid; j++) {
        const a = base + i * nGrid + j, b = a + nGrid, c = a + 1, d = b + 1;
        utris.push(a, b, d, a, d, c);
      }
    };
    addSheet(() => 0, 0, 0);
    const r0 = ((nGrid - 1) / 2) * hGrid;
    addSheet((i, j) => {
      const r = Math.hypot((i - (nGrid - 1) / 2) * hGrid, (j - (nGrid - 1) / 2) * hGrid) / r0;
      return -0.004 + 0.012 * Math.max(0, 1 - r * r);
    }, nGrid * nGrid, 0.37 * hGrid);
    const uX = Float64Array.from(ux), uT = Int32Array.from(utris), uN = 2 * nGrid * nGrid;
    const uMesh = untangleMesh(uN, uT, []);
    const uW = new Float64Array(uN).fill(1);
    const uDx = new Float64Array(3 * uN), uCnt = new Float64Array(uN);
    const t6 = performance.now();
    let uLeft = findCrossings(uX, uMesh).length;
    for (let st = 0; st < 150 && uLeft > 0; st++) {
      contourStep(uX, uW, uMesh, findCrossings(uX, uMesh), 0.0005, uDx, uCnt);
      for (let k = 0; k < uDx.length; k++) uX[k] += uDx[k];
      uLeft = findCrossings(uX, uMesh).length;
    }
    const tUntangle = performance.now() - t6;
    expect(uLeft).toBe(0);

    // CCD sheet-through-sheet
    const ccdX0 = Float64Array.from(ux);
    for (let i = 0; i < nGrid * nGrid; i++) ccdX0[3 * i + 2] = 0;
    for (let i = nGrid * nGrid; i < uN; i++) ccdX0[3 * i + 2] = 0.05;
    const ccdX1 = Float64Array.from(ccdX0);
    for (let i = nGrid * nGrid; i < uN; i++) ccdX1[3 * i + 2] -= 0.12 + 0.02 * Math.sin(7 * ccdX0[3 * i]);
    const ccd = new ClothCcd(uN, uT, Int32Array.from({ length: uN }, (_, i) => i));
    const t7 = performance.now();
    const ccdStats = ccd.resolve(ccdX0, ccdX1, uW);
    const tCcd = performance.now() - t7;
    expect(ccdStats.met).toBeGreaterThan(0);
    expect(findCrossings(ccdX1, uMesh).length).toBe(0);

    // 6. Viewport syncClothSlabGeometry + placeClothTrims + weaveTexture
    const src = new Float64Array(3 * sim.renderSize());
    sim.writeRender(src);
    const jacketModel = clothModel(gNode, new THREE.Matrix4(), [form, gNode]);
    const jacketSim = new ClothSim([jacketModel], colliders);
    jacketSim.setPoses(() => new THREE.Matrix4());
    const jLayout = jacketSim.renderLayout();
    const jSrc = new Float64Array(3 * jacketSim.renderSize());
    jacketSim.writeRender(jSrc);

    const pieceFlex: FlexInfo = jLayout[0];
    const N = pieceFlex.vertnum;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
    const idx: number[] = [...pieceFlex.elems];
    for (let t = 0; t < pieceFlex.elems.length; t += 3) {
      idx.push(pieceFlex.elems[t] + N, pieceFlex.elems[t + 2] + N, pieceFlex.elems[t + 1] + N);
    }
    geom.setIndex(idx);
    const scratch = { p: new Float32Array(3 * N), n: new Float32Array(3 * N) };
    const trims = buildClothTrims(pieceFlex);
    const t8 = performance.now();
    for (let frame = 0; frame < 120; frame++) {
      jSrc[3 * pieceFlex.vertadr] += 1e-4;
      syncClothSlabGeometry(geom, pieceFlex, jSrc, [], scratch, 0.0005);
      placeClothTrims(trims, pieceFlex.name, scratch.p, scratch.n, 0.0005);
    }
    const tViewport = performance.now() - t8;

    const t9 = performance.now();
    const wTex = weaveTexture('ripstop');
    const tWeave = performance.now() - t9;
    expect(wTex).toBeTruthy();
    geom.dispose();
    for (const g of trims.groups) { g.mesh.geometry.dispose(); (g.mesh.material as THREE.Material).dispose(); }
    for (const tp of trims.tapes) { tp.geometry.dispose(); (tp.mesh.material as THREE.Material).dispose(); }

    console.log(
      `BENCHMARK | bodyCold=${tBodyCold.toFixed(1)}ms bodyEdit=${tBodyEdit.toFixed(1)}ms ` +
      `shell=${tShell.toFixed(1)}ms flatten=${tFlatten.toFixed(1)}ms sdf=${tSdf.toFixed(1)}ms ` +
      `xpbd120=${tXpbd.toFixed(1)}ms untangle=${tUntangle.toFixed(1)}ms ccd=${tCcd.toFixed(1)}ms ` +
      `viewport120f=${tViewport.toFixed(1)}ms weave=${tWeave.toFixed(1)}ms`,
    );
  }, 120_000);

  it('preserves headField mirror symmetry, coarse-to-fine ray accuracy, and cache reuse', () => {
    const f1 = headField('female', 0.055);
    const f2 = headField('female', 0.055);
    expect(f1).toBe(f2);

    // Brute-force fixed 0.001 inward ray marcher (matching headRadius kernel) to validate conservative coarse stepping
    const exactRay = (z: number, an: number) => {
      const ca = Math.cos(an), sa = Math.sin(an);
      for (let r = 0.15; r > 0; r -= 0.001) {
        if (f1(r * ca, r * sa, z) < 0) {
          let lo = r, hi = r + 0.001;
          for (let it = 0; it < 6; it++) {
            const m = 0.5 * (lo + hi);
            if (f1(m * ca, m * sa, z) < 0) lo = m; else hi = m;
          }
          return lo;
        }
      }
      return 0.002;
    };
    const exactHeadRadius = (z: number, a: number) => {
      const fz = Math.min(1, Math.max(0, (-0.094 - z) / 0.010)) * Math.min(1, Math.max(0, (z + 0.225) / 0.014));
      const fa = Math.min(1, Math.max(0, (-Math.sin(a) - 0.30) / 0.30));
      const wFace = fz * fa;
      if (wFace <= 1e-4) {
        const d = 0.035;
        return Math.max(0.002, (exactRay(z, a - d) + 2 * exactRay(z, a) + exactRay(z, a + d)) / 4);
      }
      const da = 0.027;
      const row5 = (zq: number) => (
        exactRay(zq, a - 2 * da) + 4 * exactRay(zq, a - da) + 6 * exactRay(zq, a) + 4 * exactRay(zq, a + da) + exactRay(zq, a + 2 * da)
      ) / 16;
      const dz = 0.0030 * wFace;
      const faceVal = (row5(z - dz) + 2 * row5(z) + row5(z + dz)) / 4;
      if (wFace >= 0.9999) return Math.max(0.002, faceVal);
      const d0 = 0.035;
      const baseVal = (exactRay(z, a - d0) + 2 * exactRay(z, a) + exactRay(z, a + d0)) / 4;
      return Math.max(0.002, baseVal + (faceVal - baseVal) * wFace);
    };

    const zs = [-0.24, -0.18, -0.15, -0.12, -0.09, -0.04];
    const angles = [0, 0.35, Math.PI / 2, 2.1, -Math.PI / 2, -0.45];
    for (const z of zs) {
      for (const an of angles) {
        const fast = headRadius(f1, z, an);
        const ref = exactHeadRadius(z, an);
        expect(Math.abs(fast - ref)).toBeLessThan(1e-5);
        // Exact left-right symmetry across x = 0 (angle an vs pi - an)
        const mirror = headRadius(f1, z, Math.PI - an);
        expect(Math.abs(fast - mirror)).toBeLessThan(1e-6);
      }
    }
  });

  it('caches bodyFormGeoms templates safely across prefixes and skin tones without aliasing mutable fields', () => {
    const mA = clampBodyForm({ figure: 'female', skinTone: '#d9a482' });
    const mB = clampBodyForm({ figure: 'female', skinTone: '#8d5524' });
    const gA = bodyFormGeoms(mA, 'alpha');
    const gB = bodyFormGeoms(mB, 'beta');
    expect(gA.length).toBe(gB.length);
    for (let i = 0; i < gA.length; i++) {
      expect(gA[i].name.startsWith('alpha_')).toBe(true);
      expect(gB[i].name.startsWith('beta_')).toBe(true);
      expect(gA[i].vertices).toBe(gB[i].vertices);
      expect(gA[i].faces).toBe(gB[i].faces);
      expect(gA[i].rgba).not.toBe(gB[i].rgba);
    }
    // Mutating returned rgba must not poison subsequent cache hits
    const origR = gA[0].rgba![0];
    gA[0].rgba![0] = 0.01234;
    const gA2 = bodyFormGeoms(mA, 'alpha');
    expect(gA2[0].rgba![0]).toBeCloseTo(origR, 6);
  });

  it('matches sampleGridXYZ and tight-box closeSdf against reference behavior', () => {
    // Unit icosahedral-like closed box mesh
    const pts = [
      [-0.1, -0.1, -0.1], [0.1, -0.1, -0.1], [0.1, 0.1, -0.1], [-0.1, 0.1, -0.1],
      [-0.1, -0.1, 0.1], [0.1, -0.1, 0.1], [0.1, 0.1, 0.1], [-0.1, 0.1, 0.1],
    ];
    const tris = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6,
      1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
    ];
    const g = gridOver([-0.25, -0.25, -0.25], [0.25, 0.25, 0.25], 0.025);
    const d = meshSdf(g, pts, tris);
    for (const q of [[0, 0, 0], [0.12, -0.05, 0.08], [-0.4, 0.3, 0.2], [0.05, 0.05, -0.1]]) {
      expect(sampleGridXYZ(g, d, q[0], q[1], q[2])).toBe(sampleGrid(g, d, q));
    }
    const beforeOuter = Float32Array.from(d);
    const r = 0.04;
    closeSdf(g, d, r);
    // All cells with original d >= r must remain unchanged, and center remains negative inside
    for (let i = 0; i < d.length; i++) {
      if (beforeOuter[i] >= r) expect(d[i]).toBe(beforeOuter[i]);
    }
    expect(sampleGridXYZ(g, d, 0, 0, 0)).toBeLessThan(-0.05);
  });

  it('keeps sparse findCrossings and undoCrossingMoves exact and consistent', () => {
    // Two overlapping quads: sheet B passes through sheet A
    const x0 = Float64Array.from([
      -0.05, -0.05, 0, 0.05, -0.05, 0, 0.05, 0.05, 0, -0.05, 0.05, 0,
      -0.02, -0.02, 0.02, 0.02, -0.02, 0.02, 0.02, 0.02, 0.02, -0.02, 0.02, 0.02,
    ]);
    const x1 = Float64Array.from(x0);
    // Drop one corner of sheet B through sheet A
    x1[3 * 4 + 2] = -0.02;
    x1[3 * 5 + 2] = -0.02;
    const tris = Int32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const mesh = untangleMesh(8, tris, []);
    const all = findCrossings(x1, mesh);
    expect(all.length).toBeGreaterThan(0);

    // Sparse query on triangles {0, 1, 2} must match full crossings whose triangle and edge both touch `only`
    const onlyArr = Int32Array.from([0, 1, 2]);
    const onlySet = new Set(onlyArr);
    const sparse = findCrossings(x1, mesh, onlyArr);
    const expected = all.filter((c) => onlySet.has(c.t) && (onlySet.has(mesh.edgeTris[2 * c.e]) || onlySet.has(mesh.edgeTris[2 * c.e + 1])));
    expect(sparse.length).toBeGreaterThan(0);
    expect(sparse.length).toBe(expected.length);

    // undoCrossingMoves must cleanly pull crossing vertices back to crossing-free state
    const wasPts: number[][] = [];
    const curPts: number[][] = [];
    for (let i = 0; i < 8; i++) {
      wasPts.push([x0[3 * i], x0[3 * i + 1], x0[3 * i + 2]]);
      curPts.push([x1[3 * i], x1[3 * i + 1], x1[3 * i + 2]]);
    }
    undoCrossingMoves(curPts, wasPts, tris);
    const flatOut = Float64Array.from(curPts.flat());
    expect(findCrossings(flatOut, mesh).length).toBe(0);
  });

  it('skips redundant slab rebuilds on unchanged frames and caches procedural weave textures', () => {
    const flex: FlexInfo = {
      name: 'test__panel',
      vertadr: 0,
      vertnum: 4,
      elems: [0, 1, 2, 0, 2, 3],
      rgba: [0.5, 0.5, 0.5, 1],
      material: 'denim',
    };
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24), 3));
    geom.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
    const src = Float64Array.from([
      0, 0, 0,
      0.1, 0, 0,
      0.1, 0.1, 0,
      0, 0.1, 0,
    ]);
    const scratch = { p: new Float32Array(12), n: new Float32Array(12) };
    expect(syncClothSlabGeometry(geom, flex, src, [], scratch, 0.001)).toBe(true);
    // Identical vertices -> must short-circuit and return false
    expect(syncClothSlabGeometry(geom, flex, src, [], scratch, 0.001)).toBe(false);
    // Move one vertex -> must update and return true
    src[2] = 0.02;
    expect(syncClothSlabGeometry(geom, flex, src, [], scratch, 0.001)).toBe(true);
    geom.dispose();

    // Procedural weave textures are cached per material key
    const t1 = weaveTexture('denim');
    const t2 = weaveTexture('denim');
    const t3 = weaveTexture('velvet');
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
  });
});
