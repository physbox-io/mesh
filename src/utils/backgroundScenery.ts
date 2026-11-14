import * as THREE from 'three';
import type { BackgroundId } from '../types/scene';
import { fbm2, mulberry32, ridged2, smoothstep } from './backgroundTextures';

export interface TracedBackdropTuning {
  /** 0..1 desaturation of the HDR lighting environment (`traced.environment`) in Render mode. */
  envDesaturate: number;
  /** Multiplier on `environmentIntensity` in GPU path-traced Render mode. */
  envScale: number;
  /** Soft-knee cap on HDR hotspot peaks in `traced.environment` (since `ShapedAreaLight` already models the sun). */
  envHotspotClamp: number;
  /** Multiplier on directional/disc key light intensity in Render mode. */
  keyScale: number;
  /** 0..1 blend of `tracedScenery` linear vertex colours toward luminance in Render mode. */
  sceneryDesaturate: number;
  /** Multiplier on `tracedScenery` diffuse reflectance in Render mode to tame multi-bounce ground glow. */
  sceneryAlbedoScale: number;
  /** 0..1 desaturation of the visible skybox backdrop (`traced.background`) in Render mode. */
  skyboxDesaturate: number;
  /** Multiplier on visible skybox linear brightness in Render mode (offsets NeutralToneMapping compression). */
  skyboxScale: number;
  /** Optional 0..1 TracedGlow bloom scale in Render mode (0 disables ground bloom; ~0.75 preserves crisp snowy alpine glow). */
  glowScale?: number;
}

export interface BackgroundLightingConfig {
  /** Key light offset [x, y, z] in Three.js Y-up metres from the shadow frame centre. */
  keyOffset: [number, number, number];
  keyColor: string;
  keyIntensity: number;
  /** Angular radius (radians) of the key area light in GPU path-traced Render mode. */
  keyLightAngularRadius: number;
  /** Minimum half-width of the orthographic shadow box in metres. */
  minShadowHalf: number;
  environmentIntensity: number;
  hemiSkyColor: string;
  hemiGroundColor: string;
  hemiIntensity: number;
  /** Optional Render-mode-only trim so multi-bounce GI doesn't over-saturate or over-glow outdoor ground. */
  traced?: TracedBackdropTuning;
}

export const BACKGROUND_LIGHTING: Record<Exclude<BackgroundId, 'studio'>, BackgroundLightingConfig> = {
  meadow: {
    keyOffset: [2.4, 3.1, 1.8],
    keyColor: '#fff9e6',
    keyIntensity: 2.9,
    keyLightAngularRadius: 0.018,
    minShadowHalf: 1.05,
    environmentIntensity: 1.18,
    hemiSkyColor: '#7dd3fc',
    hemiGroundColor: '#76e828',
    hemiIntensity: 0.62,
    traced: {
      envDesaturate: 0.38,
      envScale: 0.68,
      envHotspotClamp: 3.6,
      keyScale: 0.92,
      sceneryDesaturate: 0.18,
      sceneryAlbedoScale: 0.84,
      skyboxDesaturate: 0.22,
      skyboxScale: 1.05,
    },
  },
  mountains: {
    keyOffset: [-2.2, 3.5, 2.0],
    keyColor: '#fffdf7',
    keyIntensity: 2.8,
    keyLightAngularRadius: 0.012,
    minShadowHalf: 1.05,
    environmentIntensity: 1.14,
    hemiSkyColor: '#a8d5ff',
    hemiGroundColor: '#b0bfcf',
    hemiIntensity: 0.54,
    traced: {
      envDesaturate: 0.16,
      envScale: 0.96,
      envHotspotClamp: 6.5,
      keyScale: 0.98,
      sceneryDesaturate: 0.1,
      sceneryAlbedoScale: 0.98,
      skyboxDesaturate: 0.16,
      skyboxScale: 1.0,
      glowScale: 0.1,
    },
  },
  urban: {
    keyOffset: [2.6, 2.3, 2.1],
    keyColor: '#ffe8c8',
    keyIntensity: 2.05,
    keyLightAngularRadius: 0.024,
    minShadowHalf: 1.2,
    environmentIntensity: 0.82,
    hemiSkyColor: '#9fb6d4',
    hemiGroundColor: '#66605b',
    hemiIntensity: 0.28,
  },
  workbench: {
    keyOffset: [0.7, 2.5, 0.9],
    keyColor: '#fff9ef',
    keyIntensity: 1.65,
    keyLightAngularRadius: 0.075,
    minShadowHalf: 1.05,
    environmentIntensity: 0.72,
    hemiSkyColor: '#e2e8f0',
    hemiGroundColor: '#786452',
    hemiIntensity: 0.22,
  },
  coffee_table: {
    keyOffset: [2.2, 1.8, 1.2],
    keyColor: '#ffecd1',
    keyIntensity: 1.75,
    keyLightAngularRadius: 0.105,
    minShadowHalf: 1.0,
    environmentIntensity: 0.72,
    hemiSkyColor: '#f5ebe0',
    hemiGroundColor: '#6e5038',
    hemiIntensity: 0.22,
  },
};

export interface ColoredPart {
  geo: THREE.BufferGeometry;
  /** Linear or sRGB hex/RGB tuple (converted via THREE.Color for exact sRGB -> linear matching). */
  color: string | [number, number, number];
  matrix?: THREE.Matrix4;
}

const _tmpColor = new THREE.Color();
const _tmpVec = new THREE.Vector3();
const _tmpNorm = new THREE.Vector3();
const _normalMat = new THREE.Matrix3();

/**
 * Merge multiple positioned geometries with per-part solid colours into a single
 * indexed BufferGeometry carrying `position` (3), `normal` (3), `uv` (2) and
 * `color` (4, RGBA linear) — 1 draw call in raster and 1 material in the GPU
 * path tracer. Disposes every input `part.geo` after reading it.
 */
export function mergeColoredParts(parts: ColoredPart[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const p of parts) {
    if (!p.geo.attributes.normal) p.geo.computeVertexNormals();
    const vCount = p.geo.attributes.position.count;
    totalVerts += vCount;
    totalIndices += p.geo.index ? p.geo.index.count : vCount;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const colors = new Float32Array(totalVerts * 4);
  const indices = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const part of parts) {
    const { geo, color, matrix } = part;
    if (typeof color === 'string') {
      _tmpColor.set(color);
    } else {
      _tmpColor.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
    }
    if (matrix) _normalMat.getNormalMatrix(matrix);

    const posAttr = geo.attributes.position;
    const normAttr = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    const vertColorAttr = geo.attributes.color;
    const count = posAttr.count;

    for (let i = 0; i < count; i++) {
      _tmpVec.fromBufferAttribute(posAttr, i);
      if (matrix) _tmpVec.applyMatrix4(matrix);
      positions[(vOffset + i) * 3] = _tmpVec.x;
      positions[(vOffset + i) * 3 + 1] = _tmpVec.y;
      positions[(vOffset + i) * 3 + 2] = _tmpVec.z;

      _tmpNorm.fromBufferAttribute(normAttr, i);
      if (matrix) _tmpNorm.applyMatrix3(_normalMat).normalize();
      normals[(vOffset + i) * 3] = _tmpNorm.x;
      normals[(vOffset + i) * 3 + 1] = _tmpNorm.y;
      normals[(vOffset + i) * 3 + 2] = _tmpNorm.z;

      if (uvAttr) {
        uvs[(vOffset + i) * 2] = uvAttr.getX(i);
        uvs[(vOffset + i) * 2 + 1] = uvAttr.getY(i);
      }

      const cr = vertColorAttr ? vertColorAttr.getX(i) * _tmpColor.r : _tmpColor.r;
      const cg = vertColorAttr ? vertColorAttr.getY(i) * _tmpColor.g : _tmpColor.g;
      const cb = vertColorAttr ? vertColorAttr.getZ(i) * _tmpColor.b : _tmpColor.b;
      colors[(vOffset + i) * 4] = cr;
      colors[(vOffset + i) * 4 + 1] = cg;
      colors[(vOffset + i) * 4 + 2] = cb;
      colors[(vOffset + i) * 4 + 3] = 1;
    }

    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i++) {
        indices[iOffset + i] = vOffset + idx.getX(i);
      }
      iOffset += idx.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[iOffset + i] = vOffset + i;
      }
      iOffset += count;
    }

    vOffset += count;
    geo.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function trs(
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
}

/**
 * Non-uniform radial coordinate mapping u in [-1, 1] -> metres in [-extent, extent].
 * Packs ~8x finer triangles around the origin stage than a uniform grid while
 * reaching hundreds of metres to the horizon without seams.
 */
function radialCoord(u: number, extent: number, linearShare: number): number {
  const s = Math.sign(u);
  const a = Math.abs(u);
  return s * (linearShare * a + (1 - linearShare) * a * a * a) * extent;
}

interface WeldedSphereBase {
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  indices: Uint16Array;
}

const _weldedSphereCache = new Map<number, WeldedSphereBase>();

/**
 * Weld shared vertices of a high-subdivision unit icosahedron.
 * Note: Three.js subdivides each icosahedron edge into `(detail + 1)` segments
 * (`20 * (detail + 1)^2` triangles):
 * - `detail = 7`  -> 642 welded vertices, 1,280 smooth triangles
 * - `detail = 15` -> 2,562 welded vertices, 5,120 smooth triangles
 */
function getWeldedSphereBase(detail: 7 | 15): WeldedSphereBase {
  const cached = _weldedSphereCache.get(detail);
  if (cached) return cached;

  const src = new THREE.IcosahedronGeometry(1, detail);
  const srcPos = src.attributes.position as THREE.BufferAttribute;
  const vertMap = new Map<string, number>();
  const uniqueX: number[] = [];
  const uniqueY: number[] = [];
  const uniqueZ: number[] = [];
  const triIndices: number[] = [];

  for (let i = 0; i < srcPos.count; i++) {
    const px = srcPos.getX(i);
    const py = srcPos.getY(i);
    const pz = srcPos.getZ(i);
    const key = `${Math.round(px * 32768)},${Math.round(py * 32768)},${Math.round(pz * 32768)}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = uniqueX.length;
      vertMap.set(key, idx);
      uniqueX.push(px);
      uniqueY.push(py);
      uniqueZ.push(pz);
    }
    triIndices.push(idx);
  }
  src.dispose();

  const base: WeldedSphereBase = {
    ux: Float32Array.from(uniqueX),
    uy: Float32Array.from(uniqueY),
    uz: Float32Array.from(uniqueZ),
    indices: Uint16Array.from(triIndices),
  };
  _weldedSphereCache.set(detail, base);
  return base;
}

/**
 * Build a high-subdivision, smoothly weathered unit-radius cobble or boulder template
 * (`detail = 7`: 1,280 tris; `detail = 15`: 5,120 tris). Uses strictly band-limited smooth
 * FBM waves (no spiky ridged creases) so vertex normals remain velvety smooth.
 */
function buildSmoothRockGeometry(
  detail: 7 | 15,
  seed: number,
  irregularity = 0.2,
  bottomFlatten = 0.68,
): THREE.BufferGeometry {
  const base = getWeldedSphereBase(detail);
  const vCount = base.ux.length;
  const positions = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const ox = (seed % 97) * 0.73;
  const oy = ((seed * 5) % 83) * 0.59;
  const oz = ((seed * 7) % 89) * 0.61;

  for (let i = 0; i < vCount; i++) {
    const nx = base.ux[i];
    const ny = base.uy[i];
    const nz = base.uz[i];
    // Band-limited multi-axis FBM swells create natural water-worn / glacially-smoothed forms.
    const swellA = fbm2(nx * 1.15 + ox, nz * 1.15 + ny * 0.65 + oz, 3, seed);
    const swellB = fbm2(ny * 1.35 + oy, nx * 0.9 - nz * 0.9 + ox, 3, seed + 29);
    const strata = Math.sin((ny * 2.6 + swellA * 0.9) * Math.PI) * 0.035;
    const disp = 1 + ((swellA - 0.5) * 0.75 + (swellB - 0.5) * 0.45) * irregularity + strata;
    const squash = 1 - (1 - bottomFlatten) * smoothstep(-0.05, -0.75, ny);
    positions[i * 3] = nx * disp;
    positions[i * 3 + 1] = ny * disp * squash;
    positions[i * 3 + 2] = nz * disp;
    uvs[i * 2] = 0.5 + nx * 0.5;
    uvs[i * 2 + 1] = 0.5 + nz * 0.5;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(base.indices.slice(), 1));
  out.computeVertexNormals();
  return out;
}

/**
 * Build a high-subdivision (`detail = 7`, 1,280 smooth triangles) billowing leafy canopy puff
 * with baked sunlit-crown-to-shaded-underside RGBA vertex colors.
 */
function buildCanopyBillowTemplate(seed: number): THREE.BufferGeometry {
  const base = getWeldedSphereBase(7);
  const vCount = base.ux.length;
  const positions = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const colors = new Float32Array(vCount * 4);

  const cTopSun = new THREE.Color('#a4ff36');
  const cMidCrown = new THREE.Color('#52dc1e');
  const cShadeUnder = new THREE.Color('#257e16');
  const cLeafWork = new THREE.Color();
  const ox = (seed % 71) * 0.67;
  const oz = ((seed * 11) % 79) * 0.53;

  for (let i = 0; i < vCount; i++) {
    const nx = base.ux[i];
    const ny = base.uy[i];
    const nz = base.uz[i];
    const lobe = fbm2(nx * 1.45 + ox, nz * 1.45 + ny * 0.9 + oz, 3, seed);
    const fine = fbm2(ny * 2.1 - oz, nx * 1.8 + nz * 1.6 + ox, 2, seed + 43);
    const disp = 1 + (lobe - 0.5) * 0.28 + (fine - 0.5) * 0.12;
    positions[i * 3] = nx * disp;
    positions[i * 3 + 1] = ny * disp * 0.88;
    positions[i * 3 + 2] = nz * disp;
    uvs[i * 2] = 0.5 + nx * 0.5;
    uvs[i * 2 + 1] = 0.5 + nz * 0.5;

    // Sunlit +X/+Y/+Z crown highlight transitioning smoothly to rich emerald canopy depth underneath.
    const sunBias = Math.max(-1, Math.min(1, ny * 0.72 + nx * 0.36 + nz * 0.28 + (lobe - 0.5) * 0.35));
    if (sunBias >= 0) {
      cLeafWork.copy(cMidCrown).lerp(cTopSun, smoothstep(0.0, 0.85, sunBias));
    } else {
      cLeafWork.copy(cMidCrown).lerp(cShadeUnder, smoothstep(0.0, 0.85, -sunBias));
    }
    colors[i * 4] = cLeafWork.r;
    colors[i * 4 + 1] = cLeafWork.g;
    colors[i * 4 + 2] = cLeafWork.b;
    colors[i * 4 + 3] = 1;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  out.setIndex(new THREE.BufferAttribute(base.indices.slice(), 1));
  out.computeVertexNormals();
  return out;
}

/**
 * Build a smooth 3D cupped, rounded botanical petal mesh (`7` length rings x `5` width cols =
 * 48 smooth triangles per petal) with narrow basal claw, full rounded obovate blade, and
 * gentle spoon curvature.
 */
function buildCuppedPetalGeometry(
  length: number,
  maxWidth: number,
  cupLift: number,
  nodTip: number,
): THREE.BufferGeometry {
  const lenSegs = 6;
  const widSegs = 4;
  const cols = widSegs + 1;
  const rows = lenSegs + 1;
  const vCount = rows * cols;
  const positions = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    const t = r / lenSegs; // 0 at receptacle base -> 1 at rounded tip
    // Obovate teardrop botanical width profile (smoothly rounded tip, slender base).
    const profile = Math.sin(Math.pow(t, 0.62) * Math.PI);
    const halfW = maxWidth * 0.5 * profile;
    const z = t * length;
    const archY = Math.sin(t * Math.PI * 0.82) * cupLift - t * t * nodTip;

    for (let c = 0; c < cols; c++) {
      const u = (c / widSegs) * 2 - 1; // -1..+1 across petal width
      const spoonY = (1 - u * u) * -0.14 * maxWidth + Math.abs(u) * 0.08 * maxWidth;
      const vi = r * cols + c;
      positions[vi * 3] = u * halfW;
      positions[vi * 3 + 1] = archY + spoonY * profile;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = c / widSegs;
      uvs[vi * 2 + 1] = t;
    }
  }

  for (let r = 0; r < lenSegs; r++) {
    for (let c = 0; c < widSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, e, b, a, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a smooth arched lance-shaped basal leaf (`7 x 3` grid = 36 smooth triangles)
 * springing from the base of a wildflower stem.
 */
function buildArchedLeafGeometry(length: number, maxWidth: number, archHeight: number): THREE.BufferGeometry {
  const lenSegs = 6;
  const widSegs = 3;
  const cols = widSegs + 1;
  const rows = lenSegs + 1;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    const t = r / lenSegs;
    const profile = Math.sin(Math.pow(t, 0.72) * Math.PI);
    const halfW = maxWidth * 0.5 * profile;
    const z = t * length;
    const y = Math.sin(t * Math.PI * 0.78) * archHeight;
    for (let c = 0; c < cols; c++) {
      const u = (c / widSegs) * 2 - 1;
      const vFold = Math.abs(u) * 0.16 * maxWidth * profile;
      const vi = r * cols + c;
      positions[vi * 3] = u * halfW;
      positions[vi * 3 + 1] = y + vFold;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = c / widSegs;
      uvs[vi * 2 + 1] = t;
    }
  }

  for (let r = 0; r < lenSegs; r++) {
    for (let c = 0; c < widSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, e, b, a, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a complete high-resolution botanical wildflower template (`~800-1,000` smooth
 * triangles per blossom: curved 10-seg tubular stem, 2 arched lance leaves, green calyx
 * cup, 6-13 individual 3D cupped rounded petals, and smooth 16x10 floret dome).
 */
function buildWildflowerSpeciesTemplate(species: 'daisy' | 'buttercup' | 'violet'): THREE.BufferGeometry {
  const parts: ColoredPart[] = [];
  const stemH = species === 'daisy' ? 0.068 : species === 'buttercup' ? 0.062 : 0.056;
  const curveLean = 0.008;

  // Smooth curved cylindrical stem (5 height segments x 10 radial segments).
  const stemGeo = new THREE.CylinderGeometry(0.00085, 0.00135, stemH, 10, 5);
  stemGeo.translate(0, stemH * 0.5, 0);
  const sPos = stemGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sPos.count; i++) {
    const t = Math.max(0, Math.min(1, sPos.getY(i) / stemH));
    sPos.setZ(i, sPos.getZ(i) + t * t * curveLean);
  }
  stemGeo.computeVertexNormals();
  parts.push({ geo: stemGeo, color: '#42cc1c' });

  // Two opposite arched basal lance leaves.
  parts.push({
    geo: buildArchedLeafGeometry(0.026, 0.0058, 0.014),
    color: '#4ce020',
    matrix: trs([0, 0.003, 0], [0, 0.7, 0]),
  });
  parts.push({
    geo: buildArchedLeafGeometry(0.023, 0.0052, 0.012),
    color: '#3ec918',
    matrix: trs([0, 0.004, 0], [0, -2.2, 0]),
  });

  const headPos: [number, number, number] = [0, stemH, curveLean];
  const headPitch = 0.22; // Slight natural sunward nod matching stem tangent
  const headFrame = trs(headPos, [headPitch, 0, 0]);

  // Smooth flared green sepal calyx cup beneath the petals.
  parts.push({
    geo: new THREE.CylinderGeometry(0.0032, 0.0011, 0.0028, 12, 1),
    color: '#38b818',
    matrix: headFrame.clone().multiply(trs([0, -0.0012, 0])),
  });

  if (species === 'daisy') {
    const petalCount = 13;
    const petalTpl = buildCuppedPetalGeometry(0.0088, 0.0028, 0.0016, 0.0012);
    for (let p = 0; p < petalCount; p++) {
      const yaw = (p / petalCount) * Math.PI * 2 + (p & 1) * 0.03;
      const lift = (p & 1) * 0.04;
      parts.push({
        geo: petalTpl.clone(),
        color: p % 2 === 0 ? '#ffffff' : '#fefce8',
        matrix: headFrame
          .clone()
          .multiply(trs([0, 0.0003, 0], [0, yaw, 0]))
          .multiply(trs([0, 0, 0.0018], [-0.08 + lift, 0, 0])),
      });
    }
    petalTpl.dispose();
    parts.push({
      geo: new THREE.SphereGeometry(0.0028, 16, 10),
      color: '#facc15',
      matrix: headFrame.clone().multiply(trs([0, 0.0008, 0], [0, 0, 0], [1, 0.58, 1])),
    });
  } else if (species === 'buttercup') {
    const petalCount = 6;
    const petalTpl = buildCuppedPetalGeometry(0.0072, 0.0058, 0.0034, 0.0004);
    for (let p = 0; p < petalCount; p++) {
      const yaw = (p / petalCount) * Math.PI * 2;
      parts.push({
        geo: petalTpl.clone(),
        color: p % 2 === 0 ? '#fde047' : '#facc15',
        matrix: headFrame
          .clone()
          .multiply(trs([0, 0.0002 + (p & 1) * 0.0002, 0], [0, yaw, 0]))
          .multiply(trs([0, 0, 0.001], [-0.22, 0, 0])),
      });
    }
    petalTpl.dispose();
    parts.push({
      geo: new THREE.SphereGeometry(0.0022, 14, 10),
      color: '#f59e0b',
      matrix: headFrame.clone().multiply(trs([0, 0.0009, 0], [0, 0, 0], [1, 0.65, 1])),
    });
  } else {
    // 'violet': soft cupped meadow violet / cranesbill blossom.
    const petalCount = 8;
    const petalTpl = buildCuppedPetalGeometry(0.0078, 0.0044, 0.0026, 0.0008);
    for (let p = 0; p < petalCount; p++) {
      const yaw = (p / petalCount) * Math.PI * 2;
      parts.push({
        geo: petalTpl.clone(),
        color: p % 2 === 0 ? '#e879f9' : '#f0abfc',
        matrix: headFrame
          .clone()
          .multiply(trs([0, 0.0002 + (p & 1) * 0.00018, 0], [0, yaw, 0]))
          .multiply(trs([0, 0, 0.0012], [-0.16, 0, 0])),
      });
    }
    petalTpl.dispose();
    parts.push({
      geo: new THREE.SphereGeometry(0.002, 14, 10),
      color: '#fef08a',
      matrix: headFrame.clone().multiply(trs([0, 0.0008, 0], [0, 0, 0], [1, 0.6, 1])),
    });
  }

  return mergeColoredParts(parts);
}

// ---------------------------------------------------------------------------
// 1. MEADOW (grassy clearing at Y=0, 40-90 mm grass blades, wildflowers, hills)
// ---------------------------------------------------------------------------

export function meadowElevation(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= 0.24) return 0;
  // Gentle micro-undulation around 0.3..4 m, rising into scenic rolling hills 10..170 m out.
  const nearBlend = smoothstep(0.24, 1.4, r);
  const hillBlend = smoothstep(4.5, 38.0, r);
  const micro = (fbm2(x * 0.65 + 2.1, z * 0.65 - 1.4, 3, 101) - 0.52) * 0.045;
  const rolling =
    (fbm2(x * 0.018 + 5.4, z * 0.018 + 3.2, 4, 107) - 0.36) * 18.0 +
    (fbm2(x * 0.052 - 1.8, z * 0.052 + 7.1, 3, 113) - 0.45) * 3.4;
  // Keep foreground in front of camera (+X, +Z) slightly lower so it never blocks a low camera.
  const viewClear = 1 - 0.65 * smoothstep(0.0, 12.0, x + z) * (1 - smoothstep(14.0, 45.0, r));
  return nearBlend * micro + hillBlend * rolling * viewClear;
}

export interface MeadowGeometries {
  terrain: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  stones: THREE.BufferGeometry;
}

export function buildMeadowGeometries(): MeadowGeometries {
  const segs = 112;
  const halfExtent = 170;
  const terrain = new THREE.PlaneGeometry(1, 1, segs, segs);
  terrain.rotateX(-Math.PI / 2); // +Y outward normal, counter-clockwise winding.

  const pos = terrain.attributes.position as THREE.BufferAttribute;
  const uv = terrain.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 4);
  // Hyper-vibrant, sun-drenched oversaturated summer meadow greens & golden-chartreuse hills.
  const cClearing = new THREE.Color('#6ee326');
  const cMoss = new THREE.Color('#42db18');
  const cLush = new THREE.Color('#74f524');
  const cSunHill = new THREE.Color('#a2ff30');
  const cDistant = new THREE.Color('#5ce846');
  const cWork = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i) * 2;
    const uz = pos.getZ(i) * 2;
    const x = radialCoord(ux, halfExtent, 0.055);
    const z = radialCoord(uz, halfExtent, 0.055);
    const y = meadowElevation(x, z);
    pos.setXYZ(i, x, y, z);
    // Matches buildMeadowGroundTextures() [1, 1] seamless 3.4 m tile.
    uv.setXY(i, x / 3.4, z / 3.4);

    const r = Math.hypot(x, z);
    const patch = fbm2(x * 0.35 + 9.2, z * 0.35 - 4.1, 3, 131);
    const clearingMix = smoothstep(0.12, 0.42, r + (patch - 0.5) * 0.09);
    cWork.copy(cClearing).lerp(cMoss, clearingMix);
    cWork.lerp(cLush, smoothstep(0.3, 2.5, r) * (0.48 + 0.52 * patch));
    cWork.lerp(cSunHill, smoothstep(1.2, 13.0, y + patch * 3.5));
    cWork.lerp(cDistant, smoothstep(65, 168, r) * 0.48);

    colors[i * 4] = cWork.r;
    colors[i * 4 + 1] = cWork.g;
    colors[i * 4 + 2] = cWork.b;
    colors[i * 4 + 3] = 1;
  }
  terrain.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  terrain.computeVertexNormals();
  terrain.computeBoundingBox();
  terrain.computeBoundingSphere();

  // Build 2,200 arched sunlit grass blades directly into one preallocated BufferGeometry,
  // then merge with high-detail multi-petal botanical wildflowers and billowing woodland trees.
  const rng = mulberry32(202605);
  const bladeCount = 2200;
  const bladeVerts = new Float32Array(bladeCount * 7 * 3);
  const bladeNorms = new Float32Array(bladeCount * 7 * 3);
  const bladeUvs = new Float32Array(bladeCount * 7 * 2);
  const bladeColors = new Float32Array(bladeCount * 7 * 4);
  const bladeTriIndices = new Uint16Array(bladeCount * 15);
  const grassPaletteColors = ['#4ae016', '#68f222', '#88fc2c', '#38cc14', '#a6ff38'].map(
    (hex) => new THREE.Color(hex),
  );
  const localOffsets: ReadonlyArray<[number, number, number, number]> = [
    [-0.5, 0.0, 0.0, 0.78],
    [0.5, 0.0, 0.0, 0.78],
    [-0.36, 0.36, 0.18, 0.96],
    [0.36, 0.36, 0.18, 0.96],
    [-0.18, 0.72, 0.55, 1.14],
    [0.18, 0.72, 0.55, 1.14],
    [0.0, 1.0, 1.0, 1.28],
  ];
  const triPattern = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6];

  for (let i = 0; i < bladeCount; i++) {
    const t = rng();
    const r = 0.165 + Math.pow(t, 1.85) * 3.1;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const edgeScale = smoothstep(0.15, 0.36, r);
    const bladeH = (0.034 + rng() * 0.06) * (0.55 + 0.45 * edgeScale);
    const bladeW = 0.0028 + rng() * 0.0022;
    const y = meadowElevation(x, z) - 0.002;
    const yaw = rng() * Math.PI * 2;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const bend = (0.22 + rng() * 0.42) * bladeH;
    const baseCol = grassPaletteColors[i % grassPaletteColors.length];
    const vBase = i * 7;

    const nx = -sinY * 0.62;
    const ny = 0.78;
    const nz = cosY * 0.62;

    for (let k = 0; k < 7; k++) {
      const [lx, ly, bendScale, shade] = localOffsets[k];
      const wx = lx * bladeW;
      const wz = bendScale * bend;
      const vi = (vBase + k) * 3;
      bladeVerts[vi] = x + wx * cosY + wz * sinY;
      bladeVerts[vi + 1] = y + ly * bladeH;
      bladeVerts[vi + 2] = z - wx * sinY + wz * cosY;

      bladeNorms[vi] = nx;
      bladeNorms[vi + 1] = ny;
      bladeNorms[vi + 2] = nz;

      const ui = (vBase + k) * 2;
      bladeUvs[ui] = lx + 0.5;
      bladeUvs[ui + 1] = ly;

      const ci = (vBase + k) * 4;
      bladeColors[ci] = baseCol.r * shade;
      bladeColors[ci + 1] = baseCol.g * shade;
      bladeColors[ci + 2] = baseCol.b * shade * 0.9;
      bladeColors[ci + 3] = 1;
    }

    const iBase = i * 15;
    for (let ti = 0; ti < 15; ti++) {
      bladeTriIndices[iBase + ti] = vBase + triPattern[ti];
    }
  }

  const grassBatchGeo = new THREE.BufferGeometry();
  grassBatchGeo.setAttribute('position', new THREE.BufferAttribute(bladeVerts, 3));
  grassBatchGeo.setAttribute('normal', new THREE.BufferAttribute(bladeNorms, 3));
  grassBatchGeo.setAttribute('uv', new THREE.BufferAttribute(bladeUvs, 2));
  grassBatchGeo.setAttribute('color', new THREE.BufferAttribute(bladeColors, 4));
  grassBatchGeo.setIndex(new THREE.BufferAttribute(bladeTriIndices, 1));

  const foliageParts: ColoredPart[] = [
    { geo: grassBatchGeo, color: '#ffffff' },
  ];

  // Botanical multi-petal wildflowers (Oxeye Daisies, Meadow Buttercups, Wild Violets)
  // with curved 10-seg stems, arched basal leaves, and 6-13 cupped 3D rounded petals each.
  const flowerTemplates = [
    buildWildflowerSpeciesTemplate('daisy'),
    buildWildflowerSpeciesTemplate('buttercup'),
    buildWildflowerSpeciesTemplate('violet'),
  ];
  for (let i = 0; i < 90; i++) {
    const r = 0.22 + Math.pow(rng(), 1.48) * 2.35;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const y = meadowElevation(x, z) - 0.001;
    const scale = 0.82 + rng() * 0.44;
    const tiltX = (rng() - 0.5) * 0.16;
    const tiltZ = (rng() - 0.5) * 0.16;
    const tpl = flowerTemplates[i % flowerTemplates.length];
    foliageParts.push({
      geo: tpl.clone(),
      color: '#ffffff',
      matrix: trs([x, y, z], [tiltX, rng() * Math.PI * 2, tiltZ], [scale, scale, scale]),
    });
  }
  for (const tpl of flowerTemplates) tpl.dispose();

  // High-resolution multi-bough broadleaf woodland trees (48 m .. 125 m out) at true 7-14 m height:
  // smooth 14-seg tapered trunk + 3 diverging primary boughs topped by 8 overlapping 1,280-triangle
  // organic canopy billows with sunlit-crown-to-shaded-underside leaf color gradients.
  const billowTemplates = [
    buildCanopyBillowTemplate(901),
    buildCanopyBillowTemplate(937),
    buildCanopyBillowTemplate(977),
    buildCanopyBillowTemplate(1013),
  ];
  const crownLayout: ReadonlyArray<[number, number, number, number]> = [
    [0.0, 0.76, 0.0, 0.62],
    [-0.46, 0.52, 0.24, 0.54],
    [0.48, 0.54, 0.2, 0.52],
    [0.06, 0.5, -0.48, 0.53],
    [-0.32, 0.64, -0.32, 0.48],
    [0.36, 0.66, -0.26, 0.47],
    [-0.18, 0.44, 0.44, 0.46],
    [0.24, 0.46, 0.42, 0.45],
  ];
  const boughDirs: ReadonlyArray<[number, number, number]> = [
    [-0.38, 0.42, 0.18],
    [0.4, 0.44, 0.16],
    [0.04, 0.42, -0.4],
  ];
  const treeTints = ['#ffffff', '#f2ffd9', '#e6ffcf'];

  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2 + (rng() - 0.5) * 0.18;
    const r = 50 + rng() * 76;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const y = meadowElevation(x, z) - 0.15;
    const h = 7.2 + rng() * 6.8;
    const crownSpan = h * (0.44 + rng() * 0.1);
    const treeYaw = rng() * Math.PI * 2;
    const cosT = Math.cos(treeYaw);
    const sinT = Math.sin(treeYaw);

    // Smooth 14-segment tapered trunk + flared root collar.
    foliageParts.push({
      geo: new THREE.CylinderGeometry(h * 0.026, h * 0.052, h * 0.44, 14, 2),
      color: '#664730',
      matrix: trs([x, y + h * 0.21, z], [(rng() - 0.5) * 0.05, treeYaw, (rng() - 0.5) * 0.05]),
    });
    for (const [bx, by, bz] of boughDirs) {
      const wx = (bx * cosT - bz * sinT) * crownSpan * 0.5;
      const wz = (bx * sinT + bz * cosT) * crownSpan * 0.5;
      foliageParts.push({
        geo: new THREE.CylinderGeometry(h * 0.012, h * 0.022, h * 0.24, 10, 1),
        color: '#5c3f2a',
        matrix: trs(
          [x + wx * 0.55, y + h * by, z + wz * 0.55],
          [bz * 0.75, treeYaw, -bx * 0.75],
        ),
      });
    }

    const tint = treeTints[i % treeTints.length];
    for (let b = 0; b < crownLayout.length; b++) {
      const [lx, ly, lz, radFrac] = crownLayout[b];
      const wx = (lx * cosT - lz * sinT) * crownSpan;
      const wz = (lx * sinT + lz * cosT) * crownSpan;
      const billowR = crownSpan * radFrac * (0.92 + rng() * 0.16);
      const tpl = billowTemplates[(i + b) % billowTemplates.length];
      foliageParts.push({
        geo: tpl.clone(),
        color: tint,
        matrix: trs(
          [x + wx, y + h * ly, z + wz],
          [0, treeYaw + b * 0.9, 0],
          [billowR * 1.08, billowR * 0.9, billowR * 1.04],
        ),
      });
    }
  }
  for (const tpl of billowTemplates) tpl.dispose();

  // Smooth water-worn river/field cobbles (16-54 mm) around the clearing border:
  // each stone uses a 1,280-triangle (`detail = 7`) smooth sculpted cobble template.
  const stoneTemplates = Array.from({ length: 6 }, (_, k) =>
    buildSmoothRockGeometry(7, 3100 + k * 37, 0.16, 0.66),
  );
  const stoneParts: ColoredPart[] = [];
  const stoneTones = ['#b8b2a6', '#c7c1b4', '#a39d92', '#d1cbc0'];
  for (let i = 0; i < 26; i++) {
    const r = 0.19 + Math.pow(rng(), 1.55) * 1.25;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const rad = 0.009 + rng() * 0.019;
    const y = meadowElevation(x, z) + rad * 0.18;
    stoneParts.push({
      geo: stoneTemplates[i % stoneTemplates.length].clone(),
      color: stoneTones[i % stoneTones.length],
      matrix: trs(
        [x, y, z],
        [(rng() - 0.5) * 0.28, rng() * Math.PI * 2, (rng() - 0.5) * 0.28],
        [rad * (1.18 + rng() * 0.22), rad * (0.58 + rng() * 0.16), rad * (0.94 + rng() * 0.22)],
      ),
    });
  }
  for (const tpl of stoneTemplates) tpl.dispose();

  return {
    terrain,
    foliage: mergeColoredParts(foliageParts),
    stones: mergeColoredParts(stoneParts),
  };
}

// ---------------------------------------------------------------------------
// 2. MOUNTAINS (granite outcrop at Y=0, smooth alpine cobbles/boulders, snow peaks)
// ---------------------------------------------------------------------------

export function mountainElevation(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= 0.34) return 0;

  // Immediate rocky granite shoulder (0.34..5 m), then alpine glacial valley & high crags.
  const ledgeDrop = smoothstep(0.34, 2.2, r) * ((fbm2(x * 0.45 + 3.1, z * 0.45 - 2.7, 3, 211) - 0.58) * 0.22);
  const valley = -smoothstep(5.0, 42.0, r) * (1 - smoothstep(55.0, 145.0, r)) * 16.0;
  const ridge = ridged2(x * 0.0085 + 4.2, z * 0.0085 - 3.6, 5, 223);
  const detail = ridged2(x * 0.032 - 2.1, z * 0.032 + 5.8, 4, 229);
  const azimuthBias = 0.58 + 0.42 * smoothstep(-80, 90, -(x * 0.65 + z * 0.75));
  const peaks = smoothstep(26.0, 185.0, r) * (ridge * ridge * 138 + detail * 16) * azimuthBias;
  return ledgeDrop + valley + peaks;
}

export interface MountainGeometries {
  terrain: THREE.BufferGeometry;
  scree: THREE.BufferGeometry;
}

export function buildMountainGeometries(): MountainGeometries {
  const segs = 140;
  const halfExtent = 340;
  const terrain = new THREE.PlaneGeometry(1, 1, segs, segs);
  terrain.rotateX(-Math.PI / 2);

  const pos = terrain.attributes.position as THREE.BufferAttribute;
  const uv = terrain.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i) * 2;
    const uz = pos.getZ(i) * 2;
    const x = radialCoord(ux, halfExtent, 0.032);
    const z = radialCoord(uz, halfExtent, 0.032);
    const y = mountainElevation(x, z);
    pos.setXYZ(i, x, y, z);
    // Matches buildGraniteTextures() [1, 1] seamless 4.8 m tile.
    uv.setXY(i, x / 4.8, z / 4.8);
  }
  terrain.computeVertexNormals();

  const norm = terrain.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 4);
  // Bright sunlit high-altitude pale Sierra/Alpine granite, meadow tundra, and pure snow.
  const cGranite = new THREE.Color('#c8ced8');
  const cWarmFeldspar = new THREE.Color('#d8cec2');
  const cDarkGneiss = new THREE.Color('#9aa5b5');
  const cLichen = new THREE.Color('#92b864');
  const cCliff = new THREE.Color('#828fa3');
  const cTundra = new THREE.Color('#74b548');
  const cSnow = new THREE.Color('#ffffff');
  const cWork = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = norm.getY(i);
    const r = Math.hypot(x, z);
    const nearMottle = fbm2(x * 0.85 - 3.4, z * 0.85 + 2.1, 3, 233);
    const vein = ridged2(x * 0.24 + 5.1, z * 0.24 - 1.8, 3, 239);
    const patch = fbm2(x * 0.09 + 1.9, z * 0.09 - 6.3, 4, 241);

    cWork.copy(cGranite);
    cWork.lerp(cWarmFeldspar, smoothstep(0.45, 0.78, nearMottle) * 0.45);
    cWork.lerp(cDarkGneiss, smoothstep(0.58, 0.88, vein) * smoothstep(0.18, 0.9, r) * 0.34);
    cWork.lerp(cLichen, smoothstep(0.32, 1.9, r) * smoothstep(0.56, 0.82, patch) * 0.42);
    if (r > 8) {
      cWork.lerp(cTundra, smoothstep(-2, -12, y) * smoothstep(0.68, 0.92, ny) * 0.68);
    }
    const steep = 1 - smoothstep(0.5, 0.84, ny);
    cWork.lerp(cCliff, steep * smoothstep(2.0, 20.0, r) * 0.65);
    const snowLine = smoothstep(10.0, 34.0, y + (patch - 0.5) * 14.0) * smoothstep(0.44, 0.76, ny);
    cWork.lerp(cSnow, snowLine);

    colors[i * 4] = cWork.r;
    colors[i * 4 + 1] = cWork.g;
    colors[i * 4 + 2] = cWork.b;
    colors[i * 4 + 3] = 1;
  }
  terrain.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  terrain.computeBoundingBox();
  terrain.computeBoundingSphere();

  // High-subdivision smooth glacially-weathered granite cobbles (`detail = 7`: 1,280 tris)
  // and alpine talus boulders (`detail = 15`: 5,120 tris) — zero low-poly faceted clasts.
  const rng = mulberry32(8848);
  const screeParts: ColoredPart[] = [];
  const rockPalette = ['#c6ccd6', '#b2bac6', '#d4cdc2', '#a4aebc', '#cfd5de', '#b8c0ae'];

  const cobbleTemplates = Array.from({ length: 6 }, (_, k) =>
    buildSmoothRockGeometry(7, 5200 + k * 41, 0.21, 0.65),
  );
  const boulderTemplates = Array.from({ length: 6 }, (_, k) =>
    buildSmoothRockGeometry(15, 6300 + k * 53, 0.24, 0.68),
  );

  // Smooth alpine granite cobbles (18-68 mm) around r = 0.30..2.5 m.
  for (let i = 0; i < 36; i++) {
    const r = 0.30 + Math.pow(rng(), 1.35) * 2.2;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const size = 0.016 + rng() * 0.032;
    const y = mountainElevation(x, z) + size * 0.16;
    screeParts.push({
      geo: cobbleTemplates[i % cobbleTemplates.length].clone(),
      color: rockPalette[i % rockPalette.length],
      matrix: trs(
        [x, y, z],
        [(rng() - 0.5) * 0.36, rng() * Math.PI * 2, (rng() - 0.5) * 0.36],
        [size * (1.12 + rng() * 0.42), size * (0.58 + rng() * 0.28), size * (0.92 + rng() * 0.38)],
      ),
    });
  }

  // Smooth sculpted alpine talus boulders (0.16-0.85 m, 5,120 smooth tris each) across 2.3..12 m.
  for (let i = 0; i < 22; i++) {
    const r = 2.3 + rng() * 9.5;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const size = 0.16 + rng() * 0.4;
    const y = mountainElevation(x, z) + size * 0.14;
    screeParts.push({
      geo: boulderTemplates[i % boulderTemplates.length].clone(),
      color: rockPalette[(i + 2) % rockPalette.length],
      matrix: trs(
        [x, y, z],
        [(rng() - 0.5) * 0.34, rng() * Math.PI * 2, (rng() - 0.5) * 0.34],
        [size * (1.15 + rng() * 0.4), size * (0.62 + rng() * 0.26), size * (0.94 + rng() * 0.36)],
      ),
    });
  }

  for (const tpl of cobbleTemplates) tpl.dispose();
  for (const tpl of boulderTemplates) tpl.dispose();

  return {
    terrain,
    scree: mergeColoredParts(screeParts),
  };
}

// ---------------------------------------------------------------------------
// 3. URBAN / GRAFFITI WALL (concrete sidewalk at Y=0, brick + multi-mural walls)
// ---------------------------------------------------------------------------

/**
 * Build a structural masonry BoxGeometry positioned at `[cx, cy, cz]` with world-space
 * planar UVs mapped to `1.80 m x 1.80 m` per `[0..1]` UV repeat (matching
 * `buildTileableBrickTextures()`'s 8 x 24 running-bond courses) on ALL 6 faces.
 */
function buildWorldBrickBox(
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  color = '#ffffff',
): ColoredPart {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(cx, cy, cz);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const norm = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const tileM = 1.8;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(norm.getX(i));
    const ay = Math.abs(norm.getY(i));
    if (ay > 0.5) {
      uv.setXY(i, x / tileM, z / tileM);
    } else if (ax > 0.5) {
      uv.setXY(i, z / tileM, y / tileM);
    } else {
      uv.setXY(i, x / tileM, y / tileM);
    }
  }
  return { geo, color };
}

export interface UrbanGeometries {
  sidewalk: THREE.BufferGeometry;
  brickWalls: THREE.BufferGeometry;
  graffitiWall: THREE.BufferGeometry;
  leftGraffitiWall: THREE.BufferGeometry;
  rightGraffitiWall: THREE.BufferGeometry;
  matteProps: THREE.BufferGeometry;
  metalProps: THREE.BufferGeometry;
}

export function buildUrbanGeometries(): UrbanGeometries {
  // Sidewalk top at Y = 0 (width 24 m along X, Z from -0.60 m to +1.38 m, thickness 0.14 m).
  const sidewalk = new THREE.BoxGeometry(24, 0.14, 1.98);
  sidewalk.translate(0, -0.07, 0.39);
  // Scale UVs so 1 texture repeat = 1.2 m x 1.2 m concrete slab.
  const swUv = sidewalk.attributes.uv as THREE.BufferAttribute;
  const swPos = sidewalk.attributes.position as THREE.BufferAttribute;
  const swNorm = sidewalk.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < swUv.count; i++) {
    if (Math.abs(swNorm.getY(i)) > 0.5) {
      swUv.setXY(i, swPos.getX(i) / 24, swPos.getZ(i) / 24);
    }
  }

  // Structural running-bond brick walls, corner returns & pilasters — every single face
  // (front, back, alley side, right block return, pilasters) carries world-scaled brickwork!
  const brickParts: ColoredPart[] = [
    // Continuous rear brick building facade (X = -12..+12 m, Y = 0..2.85 m, front at Z = -0.52 m).
    buildWorldBrickBox(24.0, 2.85, 0.24, 0, 1.425, -0.64, '#ffffff'),
    // Left side-alley return brick wall (inner +X face at X = -3.19 m, Z = -0.76..+4.44 m).
    buildWorldBrickBox(0.26, 3.02, 5.2, -3.32, 1.51, 1.84, '#f8efe8'),
    // Right block-end return brick wall (inner -X face at X = +9.47 m, Z = -0.76..+3.64 m).
    buildWorldBrickBox(0.26, 3.02, 4.4, 9.6, 1.51, 1.44, '#faf2ec'),
    // Projecting brick pilasters framing the distinct street-art bays cleanly.
    buildWorldBrickBox(0.32, 2.94, 0.3, 3.24, 1.47, -0.63, '#f5ebe4'),
    buildWorldBrickBox(0.32, 2.94, 0.3, -9.8, 1.47, -0.63, '#f5ebe4'),
  ];

  // 1. Center mural bay ('center' variant): 6.18 m wide x 2.73 m tall above plinth at Z = -0.517 m.
  const graffitiWall = new THREE.PlaneGeometry(6.18, 2.73, 1, 1);
  graffitiWall.translate(0.03, 0.12 + 2.73 / 2, -0.517);

  // 2. Left alley & outer left wing mural bays ('left_alley' variant — magenta/violet/lime wave mural).
  const leftMuralParts: ColoredPart[] = [
    // Left alley return wall (+X courtyard face at X = -3.187 m, Z = -0.45..+4.35 m).
    {
      geo: new THREE.PlaneGeometry(4.8, 2.78, 1, 1),
      color: '#ffffff',
      matrix: trs([-3.187, 0.12 + 2.78 / 2, 1.92], [0, Math.PI / 2, 0]),
    },
    // Outer left rear wing (+Z face between X = -9.64 m and X = -3.45 m).
    {
      geo: new THREE.PlaneGeometry(5.96, 2.73, 1, 1),
      color: '#ffffff',
      matrix: trs([-6.55, 0.12 + 2.73 / 2, -0.517]),
    },
  ];

  // 3. Right wing & right block-return mural bays ('right_wing' variant — cobalt/amber/coral sunburst mural).
  const rightMuralParts: ColoredPart[] = [
    // Right rear wing (+Z face between X = +3.40 m pilaster and X = +9.47 m return wall).
    {
      geo: new THREE.PlaneGeometry(5.96, 2.73, 1, 1),
      color: '#ffffff',
      matrix: trs([6.43, 0.12 + 2.73 / 2, -0.517]),
    },
    // Right block-end return wall (-X face at X = +9.467 m, Z = -0.45..+3.55 m).
    {
      geo: new THREE.PlaneGeometry(4.0, 2.78, 1, 1),
      color: '#ffffff',
      matrix: trs([9.467, 0.12 + 2.78 / 2, 1.52], [0, -Math.PI / 2, 0]),
    },
  ];

  const matteParts: ColoredPart[] = [];
  const metalParts: ColoredPart[] = [];

  // Full-length concrete wall base plinths (120 mm tall) & limestone coping caps across ALL walls.
  matteParts.push({
    geo: new THREE.BoxGeometry(24.04, 0.12, 0.29),
    color: '#8e8e89',
    matrix: trs([0, 0.06, -0.635]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(24.1, 0.068, 0.32),
    color: '#9ca3af',
    matrix: trs([0, 2.884, -0.64]),
  });
  // Left alley return plinth + coping stone.
  matteParts.push({
    geo: new THREE.BoxGeometry(0.31, 0.12, 5.24),
    color: '#8a8a85',
    matrix: trs([-3.32, 0.06, 1.84]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.34, 0.068, 5.28),
    color: '#9ca3af',
    matrix: trs([-3.32, 3.054, 1.84]),
  });
  // Right block return plinth + coping stone.
  matteParts.push({
    geo: new THREE.BoxGeometry(0.31, 0.12, 4.44),
    color: '#8a8a85',
    matrix: trs([9.6, 0.06, 1.44]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.34, 0.068, 4.48),
    color: '#9ca3af',
    matrix: trs([9.6, 3.054, 1.44]),
  });
  // Pilaster stone caps.
  for (const px of [-9.8, 3.24]) {
    matteParts.push({
      geo: new THREE.BoxGeometry(0.38, 0.07, 0.36),
      color: '#a1a8b3',
      matrix: trs([px, 2.975, -0.63]),
    });
  }

  // Granite street curb (150 mm wide x 145 mm tall) at Z = 1.38 m + weathered asphalt roadway at Y = -0.14 m.
  matteParts.push({
    geo: new THREE.BoxGeometry(24, 0.145, 0.15),
    color: '#94948e',
    matrix: trs([0, -0.068, 1.455]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(24, 0.04, 14),
    color: '#2d3036',
    matrix: trs([0, -0.16, 8.4]),
  });
  // Faded yellow street lane dashes (100 mm wide x 1.8 m long).
  for (let x = -9; x <= 9; x += 3.6) {
    matteParts.push({
      geo: new THREE.BoxGeometry(1.8, 0.003, 0.1),
      color: '#d4a024',
      matrix: trs([x, -0.139, 3.4]),
    });
  }

  // Galvanized steel electrical conduit (Ø 28 mm) + junction box (110 x 110 x 55 mm) on the brick wall.
  metalParts.push({
    geo: new THREE.CylinderGeometry(0.014, 0.014, 2.6, 16),
    color: '#cbd5e1',
    matrix: trs([1.05, 1.3, -0.498]),
  });
  metalParts.push({
    geo: new THREE.CylinderGeometry(0.011, 0.011, 1.35, 14),
    color: '#cbd5e1',
    matrix: trs([0.375, 0.92, -0.502], [0, 0, Math.PI / 2]),
  });
  metalParts.push({
    geo: new THREE.BoxGeometry(0.11, 0.11, 0.055),
    color: '#b6c2d2',
    matrix: trs([1.05, 0.92, -0.492]),
  });
  for (const cy of [0.35, 0.72, 1.25, 1.85, 2.4]) {
    metalParts.push({
      geo: new THREE.BoxGeometry(0.052, 0.018, 0.032),
      color: '#94a3b8',
      matrix: trs([1.05, cy, -0.504]),
    });
  }

  // Painted charcoal & safety-yellow steel street bollard (Ø 114 mm x 0.86 m) near the curb.
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.057, 0.057, 0.84, 28),
    color: '#27272a',
    matrix: trs([1.18, 0.42, 1.22]),
  });
  matteParts.push({
    geo: new THREE.SphereGeometry(0.057, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
    color: '#27272a',
    matrix: trs([1.18, 0.84, 1.22]),
  });
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.0585, 0.0585, 0.09, 28),
    color: '#eab308',
    matrix: trs([1.18, 0.71, 1.22]),
  });
  metalParts.push({
    geo: new THREE.CylinderGeometry(0.082, 0.086, 0.016, 28),
    color: '#71717a',
    matrix: trs([1.18, 0.008, 1.22]),
  });

  // Smooth water-worn curbside pebbles (`detail = 7`, 1,280 smooth triangles each) along the plinth.
  const rng = mulberry32(404);
  const urbanPebbleTpl = buildSmoothRockGeometry(7, 7109, 0.16, 0.66);
  for (let i = 0; i < 12; i++) {
    const gx = -1.15 + rng() * 2.3;
    const gz = -0.46 + rng() * 0.08;
    const gr = 0.006 + rng() * 0.011;
    matteParts.push({
      geo: urbanPebbleTpl.clone(),
      color: i % 2 === 0 ? '#8c857e' : '#b5afa8',
      matrix: trs(
        [gx, gr * 0.35, gz],
        [(rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3],
        [gr * 1.2, gr * 0.58, gr * 1.0],
      ),
    });
  }
  urbanPebbleTpl.dispose();

  return {
    sidewalk,
    brickWalls: mergeColoredParts(brickParts),
    graffitiWall,
    leftGraffitiWall: mergeColoredParts(leftMuralParts),
    rightGraffitiWall: mergeColoredParts(rightMuralParts),
    matteProps: mergeColoredParts(matteParts),
    metalProps: mergeColoredParts(metalParts),
  };
}

// ---------------------------------------------------------------------------
// 4. LAB / WORKBENCH (1.60 x 0.80 m oak bench at Y=0, A2 cutting mat, tools)
// ---------------------------------------------------------------------------

export interface WorkbenchGeometries {
  oakWood: THREE.BufferGeometry;
  cuttingMat: THREE.BufferGeometry;
  pegboard: THREE.BufferGeometry;
  matteProps: THREE.BufferGeometry;
  metalProps: THREE.BufferGeometry;
}

export function buildWorkbenchGeometries(): WorkbenchGeometries {
  // Solid 40 mm butcher-block top (1.60 m x 0.80 m, top flush at Y = 0) + upper shelf at Y = 0.68 m.
  const oakParts: ColoredPart[] = [
    {
      geo: new THREE.BoxGeometry(1.6, 0.04, 0.8),
      color: '#ffffff',
      matrix: trs([0, -0.02, -0.05]),
    },
    {
      geo: new THREE.BoxGeometry(1.6, 0.024, 0.22),
      color: '#f5efe6',
      matrix: trs([0, 0.692, -0.34]),
    },
  ];

  // A2 self-healing ESD cutting mat: exact 600 mm x 450 mm, resting 0.4 mm proud at Y = +0.0004 m.
  const cuttingMat = new THREE.PlaneGeometry(0.6, 0.45);
  cuttingMat.rotateX(-Math.PI / 2);
  cuttingMat.translate(0, 0.0004, -0.02);

  // Perforated pegboard (1.60 m x 0.85 m) standing at the back edge of the bench (Z = -0.45 m).
  const pegboard = new THREE.PlaneGeometry(1.6, 0.85);
  pegboard.translate(0, 0.425, -0.448);

  const matteParts: ColoredPart[] = [];
  const metalParts: ColoredPart[] = [];

  // Heavy powder-coated steel workbench frame (50 x 50 mm legs down to workshop floor at Y = -0.78 m).
  const legFrameColor = '#27303f';
  for (const lx of [-0.74, 0.74]) {
    for (const lz of [-0.39, 0.29]) {
      matteParts.push({
        geo: new THREE.BoxGeometry(0.05, 0.74, 0.05),
        color: legFrameColor,
        matrix: trs([lx, -0.41, lz]),
      });
      // Rubber leveling feet (Ø 64 mm).
      matteParts.push({
        geo: new THREE.CylinderGeometry(0.028, 0.032, 0.018, 14),
        color: '#18181b',
        matrix: trs([lx, -0.771, lz]),
      });
    }
    // Side stretcher bars + pegboard uprights.
    matteParts.push({
      geo: new THREE.BoxGeometry(0.04, 0.04, 0.68),
      color: legFrameColor,
      matrix: trs([lx, -0.62, -0.05]),
    });
    matteParts.push({
      geo: new THREE.BoxGeometry(0.032, 0.88, 0.032),
      color: legFrameColor,
      matrix: trs([lx, 0.44, -0.466]),
    });
  }
  // Rear crossbeam + pegboard backing panel + shelf brackets.
  matteParts.push({
    geo: new THREE.BoxGeometry(1.6, 0.85, 0.012),
    color: '#3f4652',
    matrix: trs([0, 0.425, -0.456]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(1.48, 0.04, 0.04),
    color: legFrameColor,
    matrix: trs([0, -0.62, -0.39]),
  });
  for (const bx of [-0.52, 0, 0.52]) {
    matteParts.push({
      geo: new THREE.BoxGeometry(0.022, 0.018, 0.2),
      color: legFrameColor,
      matrix: trs([bx, 0.671, -0.34]),
    });
  }

  // Digital Lab Bench Power Supply (145 mm W x 200 mm D x 165 mm H) at (-0.56, 0, -0.24), angled 12° inward.
  const psuYaw = 0.21;
  const psuCenter: [number, number, number] = [-0.56, 0.0825, -0.24];
  const psuGroup = (localPos: [number, number, number], localRot: [number, number, number] = [0, 0, 0]) => {
    const parent = trs(psuCenter, [0, psuYaw, 0]);
    return parent.multiply(trs(localPos, localRot));
  };
  matteParts.push({
    geo: new THREE.BoxGeometry(0.145, 0.165, 0.2),
    color: '#334155',
    matrix: psuGroup([0, 0, 0]),
  });
  // Brushed anodized aluminum PSU front faceplate.
  metalParts.push({
    geo: new THREE.BoxGeometry(0.136, 0.154, 0.008),
    color: '#d8e0ea',
    matrix: psuGroup([0, 0, 0.101]),
  });
  // Dark OLED readout window + green/amber digits bars.
  matteParts.push({
    geo: new THREE.BoxGeometry(0.108, 0.052, 0.006),
    color: '#0f172a',
    matrix: psuGroup([0, 0.038, 0.104]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.072, 0.012, 0.004),
    color: '#34d399',
    matrix: psuGroup([-0.01, 0.048, 0.106]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.072, 0.012, 0.004),
    color: '#fbbf24',
    matrix: psuGroup([-0.01, 0.028, 0.106]),
  });
  // Knurled rotary knobs (Ø 18 mm) + red/black/green 4 mm banana binding posts with brass/nickel collars.
  for (const kx of [-0.036, 0.036]) {
    matteParts.push({
      geo: new THREE.CylinderGeometry(0.009, 0.009, 0.014, 16),
      color: '#1e293b',
      matrix: psuGroup([kx, -0.018, 0.108], [Math.PI / 2, 0, 0]),
    });
    metalParts.push({
      geo: new THREE.CylinderGeometry(0.0055, 0.0055, 0.003, 14),
      color: '#e2e8f0',
      matrix: psuGroup([kx, -0.018, 0.1155], [Math.PI / 2, 0, 0]),
    });
  }
  const posts: Array<[number, string]> = [[-0.036, '#ef4444'], [0, '#22c55e'], [0.036, '#1e293b']];
  for (const [px, pColor] of posts) {
    matteParts.push({
      geo: new THREE.CylinderGeometry(0.0055, 0.0055, 0.012, 12),
      color: pColor,
      matrix: psuGroup([px, -0.054, 0.109], [Math.PI / 2, 0, 0]),
    });
    metalParts.push({
      geo: new THREE.CylinderGeometry(0.0032, 0.0032, 0.018, 10),
      color: '#e5c158',
      matrix: psuGroup([px, -0.054, 0.109], [Math.PI / 2, 0, 0]),
    });
  }

  // Row of 4 ESD parts organizer bins along back right (each 92 mm W x 120 mm D x 62 mm H).
  const binColors = ['#2563eb', '#2563eb', '#d97706', '#2563eb'];
  for (let i = 0; i < 4; i++) {
    const bx = 0.24 + i * 0.102;
    const bz = -0.355;
    matteParts.push({
      geo: new THREE.BoxGeometry(0.092, 0.062, 0.12),
      color: binColors[i],
      matrix: trs([bx, 0.031, bz]),
    });
    // White label slot on front lip.
    matteParts.push({
      geo: new THREE.BoxGeometry(0.056, 0.014, 0.004),
      color: '#f8fafc',
      matrix: trs([bx, 0.016, bz + 0.061]),
    });
  }

  // Brushed Stainless-Steel Vernier Calipers (175 mm scale beam + fixed/sliding jaws, 3.5 mm thick) on right oak apron.
  const calMatrix = (lx: number, ly: number, lz: number) =>
    trs([0.45, 0.002, 0.05], [0, -0.34, 0]).multiply(trs([lx, ly, lz]));
  metalParts.push({
    geo: new THREE.BoxGeometry(0.175, 0.0032, 0.016),
    color: '#e2e8f0',
    matrix: calMatrix(0, 0, 0),
  });
  metalParts.push({
    geo: new THREE.BoxGeometry(0.014, 0.0034, 0.056),
    color: '#e2e8f0',
    matrix: calMatrix(-0.08, 0, 0.02),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.038, 0.006, 0.022),
    color: '#1e293b',
    matrix: calMatrix(-0.032, 0.002, 0),
  });
  metalParts.push({
    geo: new THREE.BoxGeometry(0.013, 0.0034, 0.056),
    color: '#e2e8f0',
    matrix: calMatrix(-0.046, 0, 0.02),
  });

  // Filament spool (Ø 200 mm x 68 mm) & caliper case resting on the upper shelf (Y = 0.704 m).
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.1, 0.1, 0.066, 24),
    color: '#1e293b',
    matrix: trs([-0.36, 0.804, -0.34], [0, 0.3, Math.PI / 2]),
  });
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.088, 0.088, 0.056, 24),
    color: '#f97316',
    matrix: trs([-0.36, 0.804, -0.34], [0, 0.3, Math.PI / 2]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.24, 0.042, 0.14),
    color: '#475569',
    matrix: trs([0.34, 0.725, -0.34], [0, -0.08, 0]),
  });

  // Workshop concrete floor (5.8 x 5.8 m at Y = -0.78 m) + studio shop walls behind bench.
  matteParts.push({
    geo: new THREE.BoxGeometry(5.8, 0.06, 5.8),
    color: '#525760',
    matrix: trs([0, -0.81, 0.4]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(5.8, 3.0, 0.12),
    color: '#676e79',
    matrix: trs([0, 0.72, -1.35]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.12, 3.0, 5.8),
    color: '#606772',
    matrix: trs([-2.25, 0.72, 0.4]),
  });

  return {
    oakWood: mergeColoredParts(oakParts),
    cuttingMat,
    pegboard,
    matteProps: mergeColoredParts(matteParts),
    metalProps: mergeColoredParts(metalParts),
  };
}

// ---------------------------------------------------------------------------
// 5. COZY COFFEE TABLE (1.24 x 0.68 m walnut table at Y=0, mug, books, room)
// ---------------------------------------------------------------------------

export interface CoffeeTableGeometries {
  walnutWood: THREE.BufferGeometry;
  rug: THREE.BufferGeometry;
  oakFloor: THREE.BufferGeometry;
  ceramicProps: THREE.BufferGeometry;
  matteProps: THREE.BufferGeometry;
}

export function buildCoffeeTableGeometries(): CoffeeTableGeometries {
  const walnutParts: ColoredPart[] = [];

  // Mid-century oiled walnut tabletop (1.24 m x 0.68 m x 28 mm, top surface flush at Y = 0).
  walnutParts.push({
    geo: new THREE.BoxGeometry(1.2, 0.028, 0.64),
    color: '#ffffff',
    matrix: trs([0, -0.014, -0.02]),
  });
  // Soft rounded walnut edge rails around perimeter.
  walnutParts.push({
    geo: new THREE.CylinderGeometry(0.014, 0.014, 1.2, 12),
    color: '#ffffff',
    matrix: trs([0, -0.014, 0.3], [0, 0, Math.PI / 2]),
  });
  walnutParts.push({
    geo: new THREE.CylinderGeometry(0.014, 0.014, 1.2, 12),
    color: '#ffffff',
    matrix: trs([0, -0.014, -0.34], [0, 0, Math.PI / 2]),
  });
  walnutParts.push({
    geo: new THREE.CylinderGeometry(0.014, 0.014, 0.64, 12),
    color: '#ffffff',
    matrix: trs([-0.6, -0.014, -0.02], [Math.PI / 2, 0, 0]),
  });
  walnutParts.push({
    geo: new THREE.CylinderGeometry(0.014, 0.014, 0.64, 12),
    color: '#ffffff',
    matrix: trs([0.6, -0.014, -0.02], [Math.PI / 2, 0, 0]),
  });

  // Lower slatted walnut magazine shelf at Y = -0.21 m + 4 splayed tapered legs down to Y = -0.42 m.
  for (let s = -3; s <= 3; s++) {
    walnutParts.push({
      geo: new THREE.BoxGeometry(0.92, 0.012, 0.042),
      color: '#f2e8df',
      matrix: trs([0, -0.21, -0.02 + s * 0.068]),
    });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      walnutParts.push({
        geo: new THREE.CylinderGeometry(0.02, 0.012, 0.405, 14),
        color: '#f5ece4',
        matrix: trs(
          [sx * 0.49, -0.224, -0.02 + sz * 0.24],
          [sz * 0.11, 0, -sx * 0.12],
        ),
      });
    }
  }

  // Woven bouclé living-room area rug (2.40 m x 1.70 m x 5 mm) at Y = -0.4175 m.
  const rug = new THREE.BoxGeometry(2.4, 0.005, 1.7);
  rug.translate(0, -0.4175, -0.08);

  // Honey-oak living-room staggered-plank floor (6.8 m x 6.8 m, top at Y = -0.42 m).
  // Assign explicit planar world-space UVs so `repeat = [2, 2]` maps 20 plank rows
  // across every 2.80 m (= 140 mm wide floorboards running lengthwise along X)
  // with zero UV stretching and zero tile-boundary joins.
  const oakFloor = new THREE.BoxGeometry(6.8, 0.04, 6.8);
  oakFloor.translate(0.4, -0.44, 0.4);
  const flPos = oakFloor.attributes.position as THREE.BufferAttribute;
  const flNorm = oakFloor.attributes.normal as THREE.BufferAttribute;
  const flUv = oakFloor.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < flUv.count; i++) {
    if (Math.abs(flNorm.getY(i)) > 0.5) {
      flUv.setXY(i, flPos.getX(i) / 5.6 + 0.5, flPos.getZ(i) / 5.6 + 0.5);
    }
  }

  const ceramicParts: ColoredPart[] = [];
  const matteParts: ColoredPart[] = [];

  // 1. Glazed Ceramic Coffee Mug (Ø 84 mm x 92 mm) & Saucer (Ø 138 mm) at (-0.35, 0, -0.15).
  const mugX = -0.35;
  const mugZ = -0.15;
  const saucerProfile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.042, 0),
    new THREE.Vector2(0.069, 0.014),
    new THREE.Vector2(0.066, 0.017),
    new THREE.Vector2(0.038, 0.005),
    new THREE.Vector2(0, 0.005),
  ];
  ceramicParts.push({
    geo: new THREE.LatheGeometry(saucerProfile, 32),
    color: '#f5f0e8',
    matrix: trs([mugX, 0, mugZ]),
  });
  const mugProfile = [
    new THREE.Vector2(0, 0.005),
    new THREE.Vector2(0.038, 0.005),
    new THREE.Vector2(0.042, 0.095),
    new THREE.Vector2(0.0375, 0.095),
    new THREE.Vector2(0.034, 0.012),
    new THREE.Vector2(0, 0.012),
  ];
  ceramicParts.push({
    geo: new THREE.LatheGeometry(mugProfile, 32),
    color: '#ede5d8',
    matrix: trs([mugX, 0, mugZ]),
  });
  ceramicParts.push({
    geo: new THREE.TorusGeometry(0.025, 0.0055, 12, 22, Math.PI),
    color: '#ede5d8',
    matrix: trs([mugX - 0.039, 0.052, mugZ], [0, 0, Math.PI / 2]),
  });
  // Glossy dark espresso liquid surface inside the mug.
  ceramicParts.push({
    geo: new THREE.CylinderGeometry(0.0365, 0.036, 0.004, 28),
    color: '#2b160c',
    matrix: trs([mugX, 0.078, mugZ]),
  });

  // 2. Stack of two linen-bound hardcover art/design books at (0.38, 0, -0.14).
  const book1Matrix = trs([0.38, 0.013, -0.14], [0, 0.14, 0]);
  matteParts.push({
    geo: new THREE.BoxGeometry(0.215, 0.026, 0.275),
    color: '#b4533c',
    matrix: book1Matrix,
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.207, 0.021, 0.268),
    color: '#f5f0e1',
    matrix: book1Matrix.clone().multiply(trs([0.004, 0, 0])),
  });
  const book2Matrix = trs([0.375, 0.037, -0.135], [0, -0.06, 0]);
  matteParts.push({
    geo: new THREE.BoxGeometry(0.185, 0.022, 0.238),
    color: '#526863',
    matrix: book2Matrix,
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.178, 0.017, 0.231),
    color: '#f8f4e8',
    matrix: book2Matrix.clone().multiply(trs([0.0035, 0, 0])),
  });

  // 3. Unglazed terracotta planter (Ø 90 mm x 80 mm) + smooth succulent rosette at (-0.42, 0, 0.14).
  const potX = -0.42;
  const potZ = 0.14;
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.045, 0.034, 0.078, 32),
    color: '#c26a4a',
    matrix: trs([potX, 0.039, potZ]),
  });
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.047, 0.047, 0.014, 32),
    color: '#c87050',
    matrix: trs([potX, 0.074, potZ]),
  });
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.041, 0.041, 0.006, 28),
    color: '#3f2e24',
    matrix: trs([potX, 0.076, potZ]),
  });
  const succulentLeafTpl = new THREE.SphereGeometry(0.015, 20, 14);
  for (let ring = 0; ring < 3; ring++) {
    const count = ring === 0 ? 8 : ring === 1 ? 6 : 4;
    const rad = ring === 0 ? 0.023 : ring === 1 ? 0.013 : 0.005;
    const leafScale = ring === 0 ? 1.0 : ring === 1 ? 0.78 : 0.52;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + ring * 0.52;
      matteParts.push({
        geo: succulentLeafTpl.clone(),
        color: ring === 0 ? '#4d8252' : ring === 1 ? '#649e68' : '#82ba82',
        matrix: trs(
          [potX + Math.cos(a) * rad, 0.083 + ring * 0.007, potZ + Math.sin(a) * rad],
          [Math.sin(a) * (0.42 - ring * 0.08), -a, -Math.cos(a) * (0.42 - ring * 0.08)],
          [1.28 * leafScale, 0.42 * leafScale, 0.72 * leafScale],
        ),
      });
    }
  }
  succulentLeafTpl.dispose();

  // 4. Cozy Oatmeal-Linen 3-Seater Sofa behind the coffee table (Z = -1.04 .. -1.90 m, floor at Y = -0.42 m).
  const sofaZ = -1.46;
  matteParts.push({
    geo: new THREE.BoxGeometry(2.16, 0.24, 0.86),
    color: '#d9d0c3',
    matrix: trs([0, -0.24, sofaZ]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(2.16, 0.74, 0.2),
    color: '#d4cabd',
    matrix: trs([0, 0.05, sofaZ - 0.34]),
  });
  for (const ax of [-0.99, 0.99]) {
    matteParts.push({
      geo: new THREE.BoxGeometry(0.18, 0.56, 0.86),
      color: '#d4cabd',
      matrix: trs([ax, -0.08, sofaZ]),
    });
  }
  for (const cx of [-0.6, 0, 0.6]) {
    matteParts.push({
      geo: new THREE.BoxGeometry(0.59, 0.15, 0.66),
      color: '#e3dbd0',
      matrix: trs([cx, -0.045, sofaZ + 0.08]),
    });
    matteParts.push({
      geo: new THREE.BoxGeometry(0.58, 0.4, 0.16),
      color: '#dfd6c9',
      matrix: trs([cx, 0.22, sofaZ - 0.18], [-0.14, 0, 0]),
    });
  }
  matteParts.push({
    geo: new THREE.BoxGeometry(0.34, 0.34, 0.12),
    color: '#b85d43',
    matrix: trs([-0.74, 0.18, sofaZ - 0.06], [-0.18, 0.35, -0.15]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.32, 0.32, 0.12),
    color: '#6b8072',
    matrix: trs([0.74, 0.17, sofaZ - 0.06], [-0.18, -0.32, 0.14]),
  });

  // 5. Warm plaster living-room L-walls (floor Y = -0.42 m to +2.25 m) + baseboard + framed art.
  matteParts.push({
    geo: new THREE.BoxGeometry(5.8, 2.68, 0.12),
    color: '#e7dfd3',
    matrix: trs([0.2, 0.92, -2.12]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.12, 2.68, 5.8),
    color: '#e2d9cc',
    matrix: trs([-2.4, 0.92, 0.2]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(5.7, 0.11, 0.022),
    color: '#f5f2eb',
    matrix: trs([0.2, -0.365, -2.05]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.022, 0.11, 5.7),
    color: '#f5f2eb',
    matrix: trs([-2.33, -0.365, 0.2]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.76, 0.96, 0.032),
    color: '#5c3d28',
    matrix: trs([0, 1.18, -2.045]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.71, 0.91, 0.012),
    color: '#f7f3eb',
    matrix: trs([0, 1.18, -2.025]),
  });
  matteParts.push({
    geo: new THREE.CylinderGeometry(0.18, 0.18, 0.008, 28),
    color: '#c26a4a',
    matrix: trs([-0.06, 1.24, -2.018], [Math.PI / 2, 0, 0]),
  });
  matteParts.push({
    geo: new THREE.BoxGeometry(0.32, 0.22, 0.009),
    color: '#3d5a58',
    matrix: trs([0.08, 1.02, -2.017]),
  });

  return {
    walnutWood: mergeColoredParts(walnutParts),
    rug,
    oakFloor,
    ceramicProps: mergeColoredParts(ceramicParts),
    matteProps: mergeColoredParts(matteParts),
  };
}
