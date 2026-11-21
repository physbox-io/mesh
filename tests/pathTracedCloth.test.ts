import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StaticGeometryGenerator } from 'three-gpu-pathtracer/src/core/utils/StaticGeometryGenerator.js';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { weaveTexture } from '../src/components/scene/clothWeaveTexture';
import { clothPieceHalfThickness, syncClothSlabGeometry } from '../src/components/scene/ClothLayer';
import { buildClothTrims, placeClothTrims } from '../src/components/scene/clothTrims';
import {
  buildRefinedClothTracedGeometry,
  buildTracedScene,
  collectBodies,
  sameSignature,
  SCENE_TOLERANCE,
  sceneSignature,
} from '../src/components/scene/PathTracedView';
import { flagInWindPreset } from '../src/presets/flagInWind';
import { clothRun } from './clothSimHarness';
import type { FlexInfo } from '../src/workers/physicsWorkerProtocol';

function makeClothSlabGeometry(flex: FlexInfo): THREE.BufferGeometry {
  const N = flex.vertnum;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
  const uv = new Float32Array(4 * N);
  const uv1 = new Float32Array(4 * N);
  if (flex.flat?.uv && flex.flat.uv.length === N) {
    for (let i = 0; i < N; i++) {
      const [u, v] = flex.flat.uv[i];
      uv[2 * i] = uv[2 * (i + N)] = u * 4 + 0.5;
      uv[2 * i + 1] = uv[2 * (i + N) + 1] = v * 4 + 0.5;
      uv1[2 * i] = uv1[2 * (i + N)] = u;
      uv1[2 * i + 1] = uv1[2 * (i + N) + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  const seen = new Map<string, number>();
  for (let t = 0; t < flex.elems.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = flex.elems[t + e];
      const b = flex.elems[t + ((e + 1) % 3)];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  const index: number[] = [...flex.elems];
  for (let t = 0; t < flex.elems.length; t += 3) {
    index.push(flex.elems[t] + N, flex.elems[t + 2] + N, flex.elems[t + 1] + N);
  }
  for (let t = 0; t < flex.elems.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = flex.elems[t + e];
      const b = flex.elems[t + ((e + 1) % 3)];
      if ((seen.get(a < b ? `${a},${b}` : `${b},${a}`) ?? 0) !== 1) continue;
      index.push(a, b + N, b, a, a + N, b + N);
    }
  }
  g.setIndex(index);
  return g;
}

function makeSampleFlex(): FlexInfo {
  const stitches = Array.from({ length: 12 }, (_, i) => ({
    kind: 'stitch' as const,
    particle: i % 4,
    toward: (i + 1) % 4,
    t: (i % 3) * 0.3,
    size: 0.003,
    rgba: [0.6, 0.25, 0.05, 1],
  }));
  return {
    name: 'jacket__frontL',
    vertadr: 0,
    vertnum: 4,
    elems: [0, 1, 2, 0, 2, 3],
    rgba: [0.9, 0.4, 0.1, 1],
    material: 'denim',
    flat: {
      uv: [
        [0, 0],
        [0.2, 0],
        [0.2, 0.3],
        [0, 0.3],
      ],
      outline: [0, 1, 2, 3],
      strain95: 0.01,
      marks: [],
    },
    trims: [
      { kind: 'button', particle: 0, size: 0.015, rgba: [0.2, 0.2, 0.25, 1] },
      {
        kind: 'zipper',
        particle: 0,
        toward: 3,
        t: 0.2,
        run: 0,
        zip: { trim: 0, at: 0.2 },
        size: 0.004,
        rgba: [0.8, 0.8, 0.82, 1],
      },
      {
        kind: 'zipper',
        particle: 0,
        toward: 3,
        t: 0.8,
        run: 0,
        end: true,
        zip: { trim: 0, at: 0.8 },
        size: 0.004,
        rgba: [0.8, 0.8, 0.82, 1],
      },
      ...stitches,
    ],
  };
}

describe('PathTracedView + ClothLayer stability', () => {
  it('keeps cloth geometry & trim buffer versions constant across repeated paused syncs, and advances when flexvert_xpos or zip state changes', () => {
    const flex = makeSampleFlex();
    const geom = makeClothSlabGeometry(flex);
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(flex.rgba[0], flex.rgba[1], flex.rgba[2]),
      roughness: 0.9,
      side: THREE.DoubleSide,
      normalMap: weaveTexture('denim'),
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    const clothMesh = new THREE.Mesh(geom, mat);
    clothMesh.castShadow = true;

    const trims = buildClothTrims(flex);
    const root = new THREE.Scene();
    const zUpGroup = new THREE.Group();
    zUpGroup.rotation.x = -Math.PI / 2;
    zUpGroup.add(clothMesh);
    for (const g of trims.groups) zUpGroup.add(g.mesh);
    for (const t of trims.tapes) zUpGroup.add(t.mesh);
    root.add(zUpGroup);

    const src = new Float64Array([
      0.0, 0.0, 1.0,
      0.2, 0.0, 1.0,
      0.2, 0.02, 1.3,
      0.0, 0.02, 1.3,
    ]);
    const scratch = { p: new Float32Array(12), n: new Float32Array(12) };
    const h = CLOTH_THICKNESS / 2;
    const zipsInitial = [{ cloth: 'jacket', trim: 0, fastened: 0.8 }];

    // First sync populates the cloth slab and trims from rest.
    expect(syncClothSlabGeometry(geom, flex, src, [], scratch)).toBe(true);
    expect(placeClothTrims(trims, flex.name, scratch.p, scratch.n, h, zipsInitial)).toBe(true);
    root.updateMatrixWorld(true);

    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const v0 = posAttr.version;
    const trimVersions0 = trims.groups.map((g) => g.mesh.instanceMatrix.version);
    const tapeVersions0 = trims.tapes.map((t) => (t.geometry.getAttribute('position') as THREE.BufferAttribute).version);

    const bodies0 = collectBodies(root);
    expect(bodies0.length).toBeGreaterThanOrEqual(4); // cloth + button + zipper + slider + stitch + tape
    const sig0 = sceneSignature(bodies0);

    // Simulate 10 paused React re-renders (e.g. `usePathTraceStatus` switching
    // `waiting -> building -> compiling -> rendering` or selection changes).
    // Even if `syncClothSlabGeometry` / `placeClothTrims` run on identical `src`,
    // buffer `.version`s and `sceneSignature` must NOT change!
    for (let k = 0; k < 10; k++) {
      const freshCopyOfSamePositions = new Float64Array(src);
      expect(syncClothSlabGeometry(geom, flex, freshCopyOfSamePositions, [], scratch)).toBe(false);
      expect(placeClothTrims(trims, flex.name, scratch.p, scratch.n, h, zipsInitial)).toBe(false);
      const sigK = sceneSignature(collectBodies(root));
      expect(sameSignature(sigK, sig0, SCENE_TOLERANCE)).toBe(true);
    }
    expect(posAttr.version).toBe(v0);
    expect(trims.groups.map((g) => g.mesh.instanceMatrix.version)).toEqual(trimVersions0);
    expect(trims.tapes.map((t) => (t.geometry.getAttribute('position') as THREE.BufferAttribute).version)).toEqual(
      tapeVersions0,
    );

    // Advancing cloth vertices (`flexvert_xpos` stepping forward) MUST bump `.version` and `sceneSignature`.
    src[2] += 0.015; // z of vertex 0 moves by 15 mm
    expect(syncClothSlabGeometry(geom, flex, src, [], scratch)).toBe(true);
    expect(placeClothTrims(trims, flex.name, scratch.p, scratch.n, h, zipsInitial)).toBe(true);
    expect(posAttr.version).toBe(v0 + 1);
    const sigMoved = sceneSignature(collectBodies(root));
    expect(sameSignature(sigMoved, sig0, SCENE_TOLERANCE)).toBe(false);

    // Moving the zipper slider (`clothZips` fastened fraction changing) MUST bump slider `instanceMatrix.version`.
    const zipsUndone = [{ cloth: 'jacket', trim: 0, fastened: 0.0 }];
    expect(placeClothTrims(trims, flex.name, scratch.p, scratch.n, h, zipsUndone)).toBe(true);
    const sigUnzipped = sceneSignature(collectBodies(root));
    expect(sameSignature(sigUnzipped, sigMoved, SCENE_TOLERANCE)).toBe(false);
  });

  it('builds a clean PathTracedView scene for selected/printed/woven cloth + trims without selection glow or count=0 crashes', () => {
    const flex = makeSampleFlex();
    const geom = makeClothSlabGeometry(flex);
    const weave = weaveTexture('denim');
    const selectedClothMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.3, 0.5, 0.8),
      roughness: 0.9,
      side: THREE.FrontSide,
      normalMap: weave,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    // Selected garment tint in raster view (`ClothLayer.tsx`).
    selectedClothMat.emissive.set(0x223355);

    const clothMesh = new THREE.Mesh(geom, selectedClothMat);
    clothMesh.castShadow = true;
    clothMesh.userData = { clothVertCount: flex.vertnum, clothTriCount: flex.elems.length / 3 };

    const src = new Float64Array([
      0.0, 0.0, 1.0,
      0.2, 0.0, 1.0,
      0.2, 0.02, 1.3,
      0.0, 0.02, 1.3,
    ]);
    const scratch = { p: new Float32Array(12), n: new Float32Array(12) };
    syncClothSlabGeometry(geom, flex, src, [], scratch);

    const trims = buildClothTrims(flex);
    placeClothTrims(trims, flex.name, scratch.p, scratch.n, CLOTH_THICKNESS / 2);

    // Add a degenerate `count = 0` InstancedMesh to verify `collectBodies` skips it cleanly.
    const emptyInstanced = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.01, 0.01, 0.01),
      new THREE.MeshStandardMaterial(),
      0,
    );
    emptyInstanced.castShadow = true;

    const live = new THREE.Scene();
    live.add(clothMesh, emptyInstanced);
    for (const g of trims.groups) live.add(g.mesh);
    for (const t of trims.tapes) live.add(t.mesh);
    live.updateMatrixWorld(true);

    const bodies = collectBodies(live);
    expect(bodies).not.toContain(emptyInstanced);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial());
    const ownedMaterials: THREE.Material[] = [];
    const ownedTextures: THREE.Texture[] = [];
    const ownedGeometries: THREE.BufferGeometry[] = [];

    const traced = buildTracedScene(
      live,
      bodies,
      floor,
      '#f8fafc',
      'studio',
      ownedMaterials,
      ownedTextures,
      ownedGeometries,
    );
    traced.updateMatrixWorld(true);

    // 1. Selected garment's raster blue emissive tint (`0x223355`) must have `emissiveIntensity === 0` in Render mode,
    // and its live `FrontSide` closed slab is refined into a `DoubleSide` 4x4 PN-triangle middle surface (2 * 16 = 32 tris, 25 welded verts)!
    const tracedMeshes: THREE.Mesh[] = [];
    traced.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== floor) tracedMeshes.push(o as THREE.Mesh);
    });
    const tracedCloth = tracedMeshes.find((m) => m.geometry.getIndex()?.count === 2 * 16 * 3);
    expect(tracedCloth).toBeDefined();
    expect(tracedCloth!.geometry.getAttribute('position').count).toBe(25);
    const tracedClothMat = tracedCloth!.material as THREE.MeshPhysicalMaterial;
    expect(tracedClothMat.emissiveIntensity).toBe(0);
    expect(tracedClothMat.side).toBe(THREE.DoubleSide);
    // Live raster material stays `FrontSide`!
    expect(selectedClothMat.side).toBe(THREE.FrontSide);

    // 2. Unprinted cloth's `uv1` (pattern metres) is promoted onto `uv` so `three-gpu-pathtracer`
    // samples `weaveTexture` at true metre scale instead of stretching 12 mm across the whole panel.
    const promotedUv = tracedCloth!.geometry.getAttribute('uv') as THREE.BufferAttribute;
    expect(promotedUv.getX(1)).toBeCloseTo(0.2, 5);
    expect(promotedUv.getY(2)).toBeCloseTo(0.3, 5);

    // 3. The 12-stitch InstancedMesh (> 8 instances) was merged into a single static mesh
    // with `castShadow = false` propagated onto its material, keeping object count compact.
    const nonShadowMeshes = tracedMeshes.filter(
      (m) => (m.material as THREE.MeshStandardMaterial & { castShadow?: boolean }).castShadow === false,
    );
    expect(nonShadowMeshes.length).toBeGreaterThanOrEqual(2); // merged stitches + zipper tape

    // 4. Printed cloth (`material.map` + `weaveTexture` `channel === 1`): `buildTracedScene`
    // keeps `map` on `uv` and drops `normalMap` on the traced material clone so one tiny
    // weave tile isn't stretched across the SVG motif, while `sceneSignature` detects async `map` arrival!
    const printedMat = selectedClothMat.clone();
    printedMat.normalMap = weave;
    const printedCloth = new THREE.Mesh(geom, printedMat);
    printedCloth.castShadow = true;
    const printedScene = new THREE.Scene();
    printedScene.add(printedCloth);
    printedScene.updateMatrixWorld(true);
    const sigBeforePrint = sceneSignature(collectBodies(printedScene));
    const printTex = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat);
    printTex.needsUpdate = true;
    printedMat.map = printTex;
    const sigAfterPrint = sceneSignature(collectBodies(printedScene));
    expect(sameSignature(sigBeforePrint, sigAfterPrint, SCENE_TOLERANCE)).toBe(false);

    const printOwnedMats: THREE.Material[] = [];
    const printOwnedTexs: THREE.Texture[] = [];
    const printOwnedGeos: THREE.BufferGeometry[] = [];
    const tracedPrinted = buildTracedScene(
      printedScene,
      collectBodies(printedScene),
      floor,
      '#f8fafc',
      'studio',
      printOwnedMats,
      printOwnedTexs,
      printOwnedGeos,
    );
    let tracedPrintedMesh: THREE.Mesh | undefined;
    tracedPrinted.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== floor) tracedPrintedMesh = o as THREE.Mesh;
    });
    expect(tracedPrintedMesh).toBeDefined();
    expect((tracedPrintedMesh!.material as THREE.MeshPhysicalMaterial).map).toBe(printTex);
    expect((tracedPrintedMesh!.material as THREE.MeshPhysicalMaterial).normalMap).toBeNull();
    // Live raster material remains untouched (`normalMap` still bound on `uv1`).
    expect(printedMat.normalMap).toBe(weave);

    // 5. Verify `three-gpu-pathtracer`'s `StaticGeometryGenerator` merges the entire traced cloth + trims scene cleanly!
    const generator = new StaticGeometryGenerator(traced);
    generator.attributes = ['position', 'normal', 'tangent', 'color', 'uv', 'uv2'];
    const mergedResult = generator.generate();
    expect(mergedResult.geometry.getAttribute('position').count).toBeGreaterThan(20);
    expect(mergedResult.materials.length).toBeGreaterThanOrEqual(4);

    printTex.dispose();
    printedMat.dispose();
    for (const m of printOwnedMats) m.dispose();
    for (const t of printOwnedTexs) t.dispose();
    for (const g of printOwnedGeos) g.dispose();
    for (const m of ownedMaterials) m.dispose();
    for (const t of ownedTextures) t.dispose();
    for (const g of ownedGeometries) g.dispose();
  });

  it('traces the real flag_in_wind preset (SVG printed ensign + burgee + brass studs) with stable paused signatures', async () => {
    const cr = await clothRun(flagInWindPreset.nodes);
    cr.run(0.15, { wind: [6, 0, 0] });

    const flexes = cr.sim.renderLayout();
    expect(flexes.map((f) => f.name)).toEqual(['ensign_flag__ensign', 'burgee_pennant__burgee']);

    const src = new Float64Array(3 * cr.sim.renderSize());
    cr.sim.writeRender(src);

    const live = new THREE.Scene();
    const zUpGroup = new THREE.Group();
    zUpGroup.rotation.x = -Math.PI / 2;
    live.add(zUpGroup);

    const pieces = flexes.map((flex) => {
      const geom = makeClothSlabGeometry(flex);
      const printTex = new THREE.DataTexture(new Uint8Array(64), 4, 4, THREE.RGBAFormat);
      printTex.needsUpdate = true;
      const mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(1, 1, 1),
        map: printTex,
        normalMap: weaveTexture(flex.material),
        normalScale: new THREE.Vector2(0.6, 0.6),
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      mesh.userData = { clothVertCount: flex.vertnum, clothTriCount: flex.elems.length / 3 };
      zUpGroup.add(mesh);

      const trims = buildClothTrims(flex);
      for (const g of trims.groups) zUpGroup.add(g.mesh);
      for (const t of trims.tapes) zUpGroup.add(t.mesh);

      const halfH = clothPieceHalfThickness(flex);
      const scratch = { p: new Float32Array(3 * flex.vertnum), n: new Float32Array(3 * flex.vertnum) };
      expect(syncClothSlabGeometry(geom, flex, src, [], scratch, halfH)).toBe(true);
      expect(placeClothTrims(trims, flex.name, scratch.p, scratch.n, halfH)).toBe(true);
      return { flex, geom, mat, printTex, trims, scratch, halfH };
    });

    // Ripstop ensign (`0.2 mm` fabric -> `0.1 mm` half-thickness) is 20x thinner than the old 4 mm solver margin!
    expect(pieces[0].halfH).toBeCloseTo(0.0001, 6);
    expect(pieces[1].halfH).toBeCloseTo(0.0005, 6);

    live.updateMatrixWorld(true);
    const sig0 = sceneSignature(collectBodies(live));

    // Repeated paused re-renders on `flag_in_wind` keep `sceneSignature` 100% invariant.
    for (let k = 0; k < 5; k++) {
      for (const pc of pieces) {
        expect(syncClothSlabGeometry(pc.geom, pc.flex, src, [], pc.scratch, pc.halfH)).toBe(false);
        expect(placeClothTrims(pc.trims, pc.flex.name, pc.scratch.p, pc.scratch.n, pc.halfH)).toBe(false);
      }
      expect(sameSignature(sceneSignature(collectBodies(live)), sig0, SCENE_TOLERANCE)).toBe(true);
    }

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial());
    const mats: THREE.Material[] = [];
    const texs: THREE.Texture[] = [];
    const geos: THREE.BufferGeometry[] = [];
    const t0 = performance.now();
    const traced = buildTracedScene(live, collectBodies(live), floor, '#f8fafc', 'studio', mats, texs, geos);
    const buildMs = performance.now() - t0;
    expect(buildMs).toBeLessThan(1000);
    traced.updateMatrixWorld(true);

    const generator = new StaticGeometryGenerator(traced);
    generator.attributes = ['position', 'normal', 'tangent', 'color', 'uv', 'uv2'];
    const merged = generator.generate();
    // 16x curved PN-triangle middle-surface refinement turns ~800 coarse flag triangles into > 10,000 smooth facets!
    expect(merged.geometry.getIndex()!.count / 3).toBeGreaterThan(8000);

    for (const pc of pieces) {
      pc.geom.dispose();
      pc.mat.dispose();
      pc.printTex.dispose();
    }
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    for (const g of geos) g.dispose();
  });

  it('curves coarse cloth triangles smoothly onto a cylinder via PN-triangle middle-surface refinement with zero twin-slab crossings', () => {
    // Build a 4-column curved strip (`c = 0, 1, 2, 3`) on a cylinder of radius R = 0.08 m (80 mm)
    // with 40 mm chords (angle step θ = 0.5 rad ≈ 28.6°), where interior columns `c = 1, 2` have
    // symmetric neighbor triangles so their vertex normals match the true radial cylinder normal!
    const R = 0.08;
    const angles = [0, 0.5, 1.0, 1.5];
    const flex: FlexInfo = {
      name: 'curved__strip',
      vertadr: 0,
      vertnum: 8,
      elems: [
        0, 1, 5, 0, 5, 4,
        1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6,
      ],
      rgba: [0.95, 0.95, 0.98, 1],
      material: 'ripstop',
      flat: {
        uv: [
          [0, 0], [0.04, 0], [0.08, 0], [0.12, 0],
          [0, 0.04], [0.04, 0.04], [0.08, 0.04], [0.12, 0.04],
        ],
        outline: [0, 1, 2, 3, 7, 6, 5, 4],
        strain95: 0,
        marks: [],
      },
    };
    const src = new Float64Array(24);
    for (let c = 0; c < 4; c++) {
      const a = angles[c];
      for (let r = 0; r < 2; r++) {
        const idx = r * 4 + c;
        src[3 * idx] = R * Math.sin(a);
        src[3 * idx + 1] = r * 0.04;
        src[3 * idx + 2] = R * Math.cos(a);
      }
    }
    const slab = makeClothSlabGeometry(flex);
    const scratch = { p: new Float32Array(24), n: new Float32Array(24) };
    syncClothSlabGeometry(slab, flex, src, [], scratch);

    // 1. Raster slab check on interior bay `(1 -> 2)`: top face radius strictly > bottom face radius!
    const slabPos = slab.getAttribute('position') as THREE.BufferAttribute;
    const topMidX = 0.5 * (slabPos.getX(1) + slabPos.getX(2));
    const topMidZ = 0.5 * (slabPos.getZ(1) + slabPos.getZ(2));
    const botMidX = 0.5 * (slabPos.getX(9) + slabPos.getX(10));
    const botMidZ = 0.5 * (slabPos.getZ(9) + slabPos.getZ(10));
    expect(Math.hypot(topMidX, topMidZ)).toBeGreaterThan(Math.hypot(botMidX, botMidZ));

    // 2. Path-traced PN-triangle refinement check on interior bay `(1 -> 2 -> 6 -> 5)`:
    // Flat chord midpoint had radius `R * cos(0.25) = 77.513 mm` (2.49 mm flat sagitta error!).
    // Refined PN-triangle interior vertices arch smoothly outward onto `R ≈ 80.0 mm` (within < 0.25 mm of true cylinder!).
    const refined = buildRefinedClothTracedGeometry(slab, 8, 6, 4)!;
    expect(refined).not.toBeNull();
    expect(refined.getIndex()!.count / 3).toBe(6 * 16); // 96 smooth sub-triangles
    const rPos = refined.getAttribute('position') as THREE.BufferAttribute;
    const rIdx = refined.getIndex()!;
    // Sub-triangles `2 * 16 .. 4 * 16 - 1` (`32 .. 63`) belong to the middle bay `[1, 2, 6, 5]`.
    let minInteriorRad = Infinity;
    let maxInteriorRad = -Infinity;
    for (let t = 32; t < 64; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = rIdx.getX(3 * t + k);
        const rad = Math.hypot(rPos.getX(vi), rPos.getZ(vi));
        minInteriorRad = Math.min(minInteriorRad, rad);
        maxInteriorRad = Math.max(maxInteriorRad, rad);
      }
    }
    expect(minInteriorRad).toBeGreaterThan(R - 0.00025);
    expect(maxInteriorRad).toBeLessThan(R + 0.00025);

    slab.dispose();
    refined.dispose();
  });
});
