import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BACKGROUND_OPTIONS,
  DEFAULT_ENVIRONMENT,
  environmentOf,
  isBackgroundId,
  takeEnvironment,
  withEnvironment,
} from '../src/store/sceneEnvironment';
import type { BackgroundId, SceneGraph } from '../src/types/scene';
import {
  buildConcreteSidewalkTextures,
  buildCuttingMatTexture,
  buildEquirectSkybox,
  buildGraffitiBrickWallTextures,
  buildGraniteTextures,
  buildMeadowGroundTextures,
  buildPegboardTexture,
  buildTileableBrickTextures,
  buildTracedEquirectTexture,
  buildWoodTextures,
  buildWovenRugTextures,
} from '../src/utils/backgroundTextures';
import {
  BACKGROUND_LIGHTING,
  buildCoffeeTableGeometries,
  buildMeadowGeometries,
  buildMountainGeometries,
  buildUrbanGeometries,
  buildWorkbenchGeometries,
  meadowElevation,
  mountainElevation,
} from '../src/utils/backgroundScenery';
import { drawnContentBounds } from '../src/utils/frameScene';
import { bodyOf } from '../src/utils/measureScene';
import { despecklePixel3x3 } from '../src/utils/tracedDespeckle';
import { withSceneryColorTrim } from '../src/utils/tracerGeometry';

const REALISTIC_IDS: Array<Exclude<BackgroundId, 'studio'>> = [
  'meadow',
  'mountains',
  'urban',
  'workbench',
  'coffee_table',
];

function assertValidGeometry(geo: THREE.BufferGeometry, requireRgbaColor = false) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  expect(pos).toBeDefined();
  expect(norm).toBeDefined();
  expect(uv).toBeDefined();
  expect(pos.count).toBeGreaterThan(0);
  expect(norm.count).toBe(pos.count);
  expect(uv.count).toBe(pos.count);

  let allFinite = true;
  for (let i = 0; i < pos.array.length; i++) {
    if (!Number.isFinite(pos.array[i]) || !Number.isFinite(norm.array[i])) {
      allFinite = false;
      break;
    }
  }
  expect(allFinite).toBe(true);
  if (requireRgbaColor) {
    const color = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(color).toBeDefined();
    expect(color.itemSize).toBe(4);
    expect(color.count).toBe(pos.count);
  }
}

/** Assert every triangle of a heightfield mesh winds upward (+Y normal in Three.js). */
function assertUpwardTerrainWinding(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.getIndex();
  expect(index).not.toBeNull();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const triCount = index!.count / 3;
  let minCrossY = Infinity;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, index!.getX(t * 3));
    b.fromBufferAttribute(pos, index!.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, index!.getX(t * 3 + 2));
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cross.crossVectors(ab, ac);
    if (cross.y < minCrossY) minCrossY = cross.y;
  }
  expect(minCrossY).toBeGreaterThan(0);
}

describe('environment background state & persistence', () => {
  it('lists studio plus realistic-scale render backgrounds', () => {
    expect(BACKGROUND_OPTIONS.map((o) => o.id)).toEqual([
      'studio',
      'meadow',
      'mountains',
      'urban',
      'workbench',
      'coffee_table',
    ]);
    expect(DEFAULT_ENVIRONMENT.background).toBe('studio');
    for (const opt of BACKGROUND_OPTIONS) {
      expect(isBackgroundId(opt.id)).toBe(true);
    }
    expect(isBackgroundId('mars_colony')).toBe(false);
    expect(isBackgroundId(42)).toBe(false);
  });

  it('round-trips background with the scene environment and ignores unknown values', () => {
    for (const id of REALISTIC_IDS) {
      const saved = withEnvironment(
        { nodes: [] } as SceneGraph,
        { ...DEFAULT_ENVIRONMENT, background: id },
      );
      expect(saved.environment?.background).toBe(id);
      const { environment } = takeEnvironment(saved);
      expect(environment?.background).toBe(id);
    }

    expect(environmentOf({ background: 'unknown' as BackgroundId }).background).toBe('studio');
  });
});

describe('equirectangular skyboxes & procedural PBR textures', () => {
  it('builds HalfFloat equirectangular skybox + HDR environment textures for every preset', () => {
    for (const id of REALISTIC_IDS) {
      const pair = buildEquirectSkybox(id);
      for (const tex of [pair.background, pair.environment]) {
        expect(tex.mapping).toBe(THREE.EquirectangularReflectionMapping);
        expect(tex.type).toBe(THREE.HalfFloatType);
        expect(tex.flipY).toBe(false);
        expect(tex.image.data).toBeInstanceOf(Uint16Array);
        expect(tex.image.width).toBe(1024);
        expect(tex.image.height).toBe(512);
      }

      // Environment map has HDR hotspot energy exceeding the clamped display background.
      const bgArr = pair.background.image.data as Uint16Array;
      const envArr = pair.environment.image.data as Uint16Array;
      let maxBg = 0;
      let maxEnv = 0;
      for (let i = 0; i < bgArr.length; i += 4) {
        maxBg = Math.max(maxBg, THREE.DataUtils.fromHalfFloat(bgArr[i]));
        maxEnv = Math.max(maxEnv, THREE.DataUtils.fromHalfFloat(envArr[i]));
      }
      expect(maxBg).toBeLessThanOrEqual(1.01);
      expect(maxEnv).toBeGreaterThan(2.0);
      expect(BACKGROUND_LIGHTING[id].keyIntensity).toBeGreaterThan(0);
      expect(BACKGROUND_LIGHTING[id].keyLightAngularRadius).toBeGreaterThan(0.01);

      pair.background.dispose();
      pair.environment.dispose();
    }
  });

  it('builds seamless wrap-around granite, brick, and oak floor textures without boundary jumps', () => {
    for (const pair of [buildGraniteTextures(), buildTileableBrickTextures(), buildWoodTextures('oak_floor')]) {
      const w = pair.map.image.width;
      const h = pair.map.image.height;
      const data = pair.map.image.data as Uint8Array;

      // Mean absolute luminance step across the wrap seam (x = w-1 -> 0, y = h-1 -> 0)
      // must stay comparable to interior neighbour steps — catching any non-periodic UV jump.
      let seamStepX = 0;
      let innerStepX = 0;
      for (let y = 0; y < h; y++) {
        const iLeft = (y * w + 0) * 4;
        const iRight = (y * w + (w - 1)) * 4;
        const iMidA = (y * w + (w >> 1)) * 4;
        const iMidB = (y * w + (w >> 1) + 1) * 4;
        seamStepX += Math.abs(data[iLeft] - data[iRight]);
        innerStepX += Math.abs(data[iMidA] - data[iMidB]);
      }
      seamStepX /= h;
      innerStepX /= h;

      let seamStepY = 0;
      let innerStepY = 0;
      for (let x = 0; x < w; x++) {
        const iTop = (0 * w + x) * 4;
        const iBot = ((h - 1) * w + x) * 4;
        const iMidA = ((h >> 1) * w + x) * 4;
        const iMidB = (((h >> 1) + 1) * w + x) * 4;
        seamStepY += Math.abs(data[iTop] - data[iBot]);
        innerStepY += Math.abs(data[iMidA] - data[iMidB]);
      }
      seamStepY /= w;
      innerStepY /= w;

      expect(seamStepX).toBeLessThan(Math.max(14, innerStepX * 2.2));
      expect(seamStepY).toBeLessThan(Math.max(14, innerStepY * 2.2));

      pair.map.dispose();
      pair.normalMap.dispose();
    }
  });

  it('builds distinct street-art murals across center, left_alley, and right_wing brick walls', () => {
    const center = buildGraffitiBrickWallTextures('center');
    const left = buildGraffitiBrickWallTextures('left_alley');
    const right = buildGraffitiBrickWallTextures('right_wing');
    const cData = center.map.image.data as Uint8Array;
    const lData = left.map.image.data as Uint8Array;
    const rData = right.map.image.data as Uint8Array;

    let diffCL = 0;
    let diffCR = 0;
    let diffLR = 0;
    for (let i = 0; i < cData.length; i += 16) {
      diffCL += Math.abs(cData[i] - lData[i]) + Math.abs(cData[i + 1] - lData[i + 1]) + Math.abs(cData[i + 2] - lData[i + 2]);
      diffCR += Math.abs(cData[i] - rData[i]) + Math.abs(cData[i + 1] - rData[i + 1]) + Math.abs(cData[i + 2] - rData[i + 2]);
      diffLR += Math.abs(lData[i] - rData[i]) + Math.abs(lData[i + 1] - rData[i + 1]) + Math.abs(lData[i + 2] - rData[i + 2]);
    }
    const samples = cData.length / 16;
    expect(diffCL / samples).toBeGreaterThan(15);
    expect(diffCR / samples).toBeGreaterThan(15);
    expect(diffLR / samples).toBeGreaterThan(15);

    for (const s of [center, left, right]) {
      s.map.dispose();
      s.normalMap.dispose();
    }
  });

  it('builds procedural surface textures and tangent-space normal maps cleanly', () => {
    const sets = [
      buildMeadowGroundTextures(),
      buildGraniteTextures(),
      buildTileableBrickTextures(),
      buildGraffitiBrickWallTextures('center'),
      buildConcreteSidewalkTextures(),
      buildWoodTextures('butcher_oak'),
      buildWoodTextures('walnut'),
      buildWoodTextures('oak_floor'),
      buildWovenRugTextures(),
    ];
    for (const s of sets) {
      expect(s.map.image.width).toBeGreaterThanOrEqual(256);
      expect(s.normalMap.image.width).toBeGreaterThanOrEqual(256);
      s.map.dispose();
      s.normalMap.dispose();
    }
    const mat = buildCuttingMatTexture();
    const peg = buildPegboardTexture();
    expect(mat).toBeDefined();
    expect(peg.image.width).toBe(64);
    mat.dispose();
    peg.dispose();
  });
});

describe('realistic-scale 3D background geometries & isolation', () => {
  it('builds Meadow at metre scale with vibrant oversaturated greens and high-subdivision trees, flowers & stones', () => {
    expect(meadowElevation(0, 0)).toBe(0);
    expect(meadowElevation(0.15, -0.12)).toBe(0);

    const geos = buildMeadowGeometries();
    assertValidGeometry(geos.terrain, true);
    assertValidGeometry(geos.foliage, true);
    assertValidGeometry(geos.stones, true);
    assertUpwardTerrainWinding(geos.terrain);

    const tBox = geos.terrain.boundingBox!;
    expect(tBox.max.x - tBox.min.x).toBeCloseTo(340, 0);
    expect(tBox.max.y).toBeGreaterThan(3);

    // Every field stone uses a 1,280-triangle smooth template (26 * 1,280 > 30,000 tris);
    // multi-bough trees + multi-petal botanical flowers exceed 300,000 smooth triangles.
    expect(geos.stones.getIndex()!.count / 3).toBeGreaterThan(30000);
    expect(geos.foliage.getIndex()!.count / 3).toBeGreaterThan(300000);

    // Terrain vertex colours are bright, saturated summer greens (mean green >> red/blue).
    const tCol = geos.terrain.getAttribute('color') as THREE.BufferAttribute;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < tCol.count; i++) {
      sumR += tCol.getX(i);
      sumG += tCol.getY(i);
      sumB += tCol.getZ(i);
    }
    expect(sumG / tCol.count).toBeGreaterThan(0.75);
    expect(sumG).toBeGreaterThan(sumR * 2.0);
    expect(sumG).toBeGreaterThan(sumB * 6.0);

    geos.terrain.dispose();
    geos.foliage.dispose();
    geos.stones.dispose();
  });

  it('builds Mountains at metre scale with bright granite outcrop and smooth high-poly boulders', () => {
    expect(mountainElevation(0, 0)).toBe(0);
    expect(mountainElevation(0.2, 0.2)).toBe(0);

    const geos = buildMountainGeometries();
    assertValidGeometry(geos.terrain, true);
    assertValidGeometry(geos.scree, true);
    assertUpwardTerrainWinding(geos.terrain);

    const tBox = geos.terrain.boundingBox!;
    expect(tBox.max.x - tBox.min.x).toBeCloseTo(680, 0);
    expect(tBox.max.y).toBeGreaterThan(45);
    // 36 cobbles (1,280 tris) + 22 boulders (5,120 tris) > 150,000 smooth rock triangles.
    expect(geos.scree.getIndex()!.count / 3).toBeGreaterThan(150000);

    geos.terrain.dispose();
    geos.scree.dispose();
  });

  it('builds Urban sidewalk flush at Y=0 with full brickwork on all walls and 3 differing graffiti murals', () => {
    const geos = buildUrbanGeometries();
    assertValidGeometry(geos.sidewalk);
    assertValidGeometry(geos.brickWalls, true);
    assertValidGeometry(geos.graffitiWall);
    assertValidGeometry(geos.leftGraffitiWall, true);
    assertValidGeometry(geos.rightGraffitiWall, true);
    assertValidGeometry(geos.matteProps, true);
    assertValidGeometry(geos.metalProps, true);

    geos.sidewalk.computeBoundingBox();
    geos.graffitiWall.computeBoundingBox();
    expect(geos.sidewalk.boundingBox!.max.y).toBeCloseTo(0, 5);
    expect(geos.graffitiWall.boundingBox!.min.z).toBeCloseTo(-0.517, 3);
    expect(geos.graffitiWall.boundingBox!.max.y).toBeCloseTo(2.85, 3);
    expect(geos.brickWalls.boundingBox!.max.x - geos.brickWalls.boundingBox!.min.x).toBeCloseTo(24, 1);

    geos.sidewalk.dispose();
    geos.brickWalls.dispose();
    geos.graffitiWall.dispose();
    geos.leftGraffitiWall.dispose();
    geos.rightGraffitiWall.dispose();
    geos.matteProps.dispose();
    geos.metalProps.dispose();
  });

  it('builds Lab Workbench at 1.60 x 0.80 m with A2 cutting mat and split matte/metal props', () => {
    const geos = buildWorkbenchGeometries();
    assertValidGeometry(geos.oakWood, true);
    assertValidGeometry(geos.cuttingMat);
    assertValidGeometry(geos.pegboard);
    assertValidGeometry(geos.matteProps, true);
    assertValidGeometry(geos.metalProps, true);

    geos.cuttingMat.computeBoundingBox();
    const matBox = geos.cuttingMat.boundingBox!;
    expect(matBox.max.x - matBox.min.x).toBeCloseTo(0.6, 5);
    expect(matBox.max.z - matBox.min.z).toBeCloseTo(0.45, 5);
    expect(matBox.max.y).toBeCloseTo(0.0004, 5);
    // Floor sits ~0.78 m below the benchtop.
    expect(geos.matteProps.boundingBox!.min.y).toBeLessThan(-0.75);

    geos.oakWood.dispose();
    geos.cuttingMat.dispose();
    geos.pegboard.dispose();
    geos.matteProps.dispose();
    geos.metalProps.dispose();
  });

  it('builds Cozy Coffee Table with tabletop flush at Y=0, glazed ceramics, and floor at -0.42 m', () => {
    const geos = buildCoffeeTableGeometries();
    assertValidGeometry(geos.walnutWood, true);
    assertValidGeometry(geos.rug);
    assertValidGeometry(geos.oakFloor);
    assertValidGeometry(geos.ceramicProps, true);
    assertValidGeometry(geos.matteProps, true);

    geos.rug.computeBoundingBox();
    geos.oakFloor.computeBoundingBox();
    expect(geos.walnutWood.boundingBox!.max.y).toBeCloseTo(0, 4);
    expect(geos.rug.boundingBox!.max.y).toBeCloseTo(-0.415, 3);
    expect(geos.oakFloor.boundingBox!.max.y).toBeCloseTo(-0.42, 4);

    geos.walnutWood.dispose();
    geos.rug.dispose();
    geos.oakFloor.dispose();
    geos.ceramicProps.dispose();
    geos.matteProps.dispose();
  });

  it('stays invisible to bodyOf and drawnContentBounds so framing and measurement ignore scenery', () => {
    const scene = new THREE.Scene();
    const bgGroup = new THREE.Group();
    bgGroup.userData = { isBackground: true };
    const { terrain } = buildMountainGeometries();
    const bgMesh = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial());
    bgMesh.castShadow = true;
    bgMesh.userData = { isBackground: true, tracedScenery: true };
    bgGroup.add(bgMesh);
    scene.add(bgGroup);

    // Add one real 100 mm part inside a body-named group.
    const partGroup = new THREE.Group();
    partGroup.name = 'gear_1';
    const partMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1), new THREE.MeshStandardMaterial());
    partMesh.position.set(0, 0.01, 0);
    partMesh.castShadow = true;
    partGroup.add(partMesh);
    scene.add(partGroup);

    expect(bodyOf(bgMesh)).toBeNull();
    expect(bodyOf(partMesh)).toBe('gear_1');

    const bounds = drawnContentBounds(scene, [{ id: 'gear_1', name: 'gear_1', pos: [0, 0, 0] }]);
    expect(bounds).not.toBeNull();
    expect(bounds!.max[0] - bounds!.min[0]).toBeCloseTo(0.1, 4);

    terrain.dispose();
    partMesh.geometry.dispose();
  });
});

describe('path-traced 3x3 outlier / firefly despeckle filter', () => {
  it('clamps isolated white/shiny fireflies and heals black/NaN pits while preserving 1 px lines & edges', () => {
    const midNeighbours: Array<[number, number, number]> = Array.from({ length: 8 }, () => [0.42, 0.45, 0.48]);

    // 1. Isolated glossy firefly at luminance ~14.0 surrounded by ~0.45 neighbours -> clamped down near ~0.72.
    const firefly = despecklePixel3x3([14.0, 13.5, 12.0], midNeighbours, 1.0);
    expect(firefly[0]).toBeLessThan(1.0);
    expect(firefly[1]).toBeLessThan(1.0);
    expect(firefly[0]).toBeGreaterThan(0.4);

    // 2. Isolated dead black speck (0, 0, 0) surrounded by lit ~0.45 neighbours -> healed to ~0.45.
    const blackPit = despecklePixel3x3([0, 0, 0], midNeighbours, 1.0);
    expect(blackPit[0]).toBeCloseTo(0.42, 3);
    expect(blackPit[1]).toBeCloseTo(0.45, 3);
    expect(blackPit[2]).toBeCloseTo(0.48, 3);

    // 3. NaN / Inf channel -> replaced cleanly with finite trimmed neighbour mean.
    const nanPix = despecklePixel3x3([Number.NaN, 0.5, Number.POSITIVE_INFINITY], midNeighbours, 1.0);
    expect(nanPix[0]).toBeCloseTo(0.42, 3);
    expect(nanPix[1]).toBeCloseTo(0.45, 3);

    // 4. Genuine 1-pixel-wide bright line (2 of 8 neighbours share the bright highlight) -> untouched!
    const lineNeighbours: Array<[number, number, number]> = [
      [3.2, 3.2, 3.2],
      [3.1, 3.1, 3.1],
      [0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3],
    ];
    const realLine = despecklePixel3x3([3.3, 3.3, 3.3], lineNeighbours, 1.0);
    expect(realLine).toEqual([3.3, 3.3, 3.3]);
  });

  it('trims Meadow and Mountain Render-mode saturation & albedo without mutating live raster geometry', () => {
    expect(BACKGROUND_LIGHTING.meadow.traced).toBeDefined();
    expect(BACKGROUND_LIGHTING.mountains.traced).toBeDefined();
    expect(BACKGROUND_LIGHTING.urban.traced).toBeUndefined();

    const liveGeo = new THREE.PlaneGeometry(1, 1);
    const liveColors = new Float32Array([
      0.1, 0.9, 0.02, 1,
      0.1, 0.9, 0.02, 1,
      0.1, 0.9, 0.02, 1,
      0.1, 0.9, 0.02, 1,
    ]);
    liveGeo.setAttribute('color', new THREE.BufferAttribute(liveColors, 4));

    const trimmed = withSceneryColorTrim(liveGeo, BACKGROUND_LIGHTING.meadow.traced!.sceneryDesaturate);
    const dst = trimmed.getAttribute('color') as THREE.BufferAttribute;
    // Live geometry stays completely untouched for the raster view.
    expect((liveGeo.getAttribute('color') as THREE.BufferAttribute).getY(0)).toBeCloseTo(0.9, 5);
    // Traced copy pulls green down and red/blue up toward luminance while preserving Rec.709 luma.
    expect(dst.getY(0)).toBeLessThan(0.9);
    expect(dst.getX(0)).toBeGreaterThan(0.1);
    const lumaBefore = 0.2126 * 0.1 + 0.7152 * 0.9 + 0.0722 * 0.02;
    const lumaAfter = 0.2126 * dst.getX(0) + 0.7152 * dst.getY(0) + 0.0722 * dst.getZ(0);
    expect(lumaAfter).toBeCloseTo(lumaBefore, 5);

    liveGeo.dispose();
  });

  it('balances Meadow and Mountain Render-mode equirect environments to prevent cyan snow clip and ground over-glow', () => {
    for (const id of ['meadow', 'mountains'] as const) {
      const pair = buildEquirectSkybox(id);
      const tuning = BACKGROUND_LIGHTING[id].traced!;
      const tracedBg = buildTracedEquirectTexture(pair.background, {
        desaturate: tuning.skyboxDesaturate,
        scale: tuning.skyboxScale,
      });
      const tracedEnv = buildTracedEquirectTexture(pair.environment, {
        desaturate: tuning.envDesaturate,
        scale: 1,
        hotspotClamp: tuning.envHotspotClamp,
      });

      const liveEnvArr = pair.environment.image.data as Uint16Array;
      const tracedEnvArr = tracedEnv.image.data as Uint16Array;
      const liveBgArr = pair.background.image.data as Uint16Array;
      const tracedBgArr = tracedBg.image.data as Uint16Array;

      // Measure mean relative chroma (peak - min) / peak across sky pixels:
      // Render-mode skybox should be ~10%+ calmer without mutating live raster textures,
      // and Render-mode HDR environment should strongly tame excess sky colour cast & hotspot spikes.
      let liveBgChroma = 0;
      let tracedBgChroma = 0;
      let liveEnvChroma = 0;
      let tracedEnvChroma = 0;
      let maxTracedEnv = 0;
      let count = 0;

      for (let i = 0; i < liveBgArr.length; i += 16) {
        const lr = THREE.DataUtils.fromHalfFloat(liveBgArr[i]);
        const lg = THREE.DataUtils.fromHalfFloat(liveBgArr[i + 1]);
        const lb = THREE.DataUtils.fromHalfFloat(liveBgArr[i + 2]);
        const tr = THREE.DataUtils.fromHalfFloat(tracedBgArr[i]);
        const tg = THREE.DataUtils.fromHalfFloat(tracedBgArr[i + 1]);
        const tb = THREE.DataUtils.fromHalfFloat(tracedBgArr[i + 2]);

        const er = THREE.DataUtils.fromHalfFloat(liveEnvArr[i]);
        const eg = THREE.DataUtils.fromHalfFloat(liveEnvArr[i + 1]);
        const eb = THREE.DataUtils.fromHalfFloat(liveEnvArr[i + 2]);
        const ter = THREE.DataUtils.fromHalfFloat(tracedEnvArr[i]);
        const teg = THREE.DataUtils.fromHalfFloat(tracedEnvArr[i + 1]);
        const teb = THREE.DataUtils.fromHalfFloat(tracedEnvArr[i + 2]);

        const lPeak = Math.max(lr, lg, lb, 1e-4);
        const tPeak = Math.max(tr, tg, tb, 1e-4);
        const ePeak = Math.max(er, eg, eb, 1e-4);
        const tePeak = Math.max(ter, teg, teb, 1e-4);

        liveBgChroma += (lPeak - Math.min(lr, lg, lb)) / lPeak;
        tracedBgChroma += (tPeak - Math.min(tr, tg, tb)) / tPeak;
        liveEnvChroma += (ePeak - Math.min(er, eg, eb)) / ePeak;
        tracedEnvChroma += (tePeak - Math.min(ter, teg, teb)) / tePeak;
        count++;
      }
      for (let i = 0; i < tracedEnvArr.length; i += 4) {
        maxTracedEnv = Math.max(maxTracedEnv, THREE.DataUtils.fromHalfFloat(tracedEnvArr[i]));
      }

      expect(tracedBgChroma / count).toBeLessThan((liveBgChroma / count) * 0.95);
      expect(tracedEnvChroma / count).toBeLessThan((liveEnvChroma / count) * 0.92);
      expect(maxTracedEnv).toBeLessThan(8.5);

      pair.background.dispose();
      pair.environment.dispose();
      tracedBg.dispose();
      tracedEnv.dispose();
    }
  });
});
