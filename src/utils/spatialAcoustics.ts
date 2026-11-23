// ---------------------------------------------------------------------------
// Camera-Relative 3D-to-Stereo Spatial Acoustic Projection (Starter #6c)
// ---------------------------------------------------------------------------
//
// Projects live MuJoCo Z-up world coordinates (x_m, y_m, z_m) into the
// Three.js Y-up viewport camera frame (matching SceneVisuals' [-PI/2, 0, 0]
// rotation: (x_t, y_t, z_t) = (x_m, z_m, -y_m)) and computes:
//   - Equal-power horizontal stereo azimuth pan in [-0.78, +0.78] with
//     near-field width softening so bench-scale mechanisms never hard-split
//     unnaturally on headphones
//   - Woodworth–Schlosberg spherical-head Interaural Time Difference (ITD)
//   - Scale-invariant inverse-distance gain & high-frequency air rolloff
//     normalized to the camera's active framing radius
//
// Pure & SSR/Vitest-safe: returns centered unity defaults whenever no camera
// or WebAudio StereoPannerNode is present.
// ---------------------------------------------------------------------------

export interface SpatialAcousticParams {
  /** Equal-power stereo pan in [-0.78, +0.78] (- = Left, + = Right). */
  pan: number;
  /** Scale-invariant inverse-distance amplitude multiplier in [0.18, 1.25]. */
  distanceGain: number;
  /** High-frequency air-absorption lowpass cutoff in [2800, 18000] Hz. */
  airLowpassHz: number;
  /** Woodworth–Schlosberg spherical-head ITD in seconds (+ delays right ear for left-side source). */
  itdSec: number;
  /** Euclidean camera-to-source distance in metres. */
  distanceM: number;
}

export interface CameraPoseLike {
  matrixWorld?: { elements: ArrayLike<number> };
}

export interface ModelIdMapsLike {
  _idMaps?: Record<string, Record<string, number> | Record<number, string> | undefined>;
}

export interface DataPoseMirrorLike {
  xpos?: ArrayLike<number>;
  xmat?: ArrayLike<number>;
}

const HEAD_RADIUS_M = 0.0875;
const SPEED_OF_SOUND_AIR = 343.0;
export const MAX_STEREO_PAN = 0.78;

export const DEFAULT_SPATIAL_PARAMS: Readonly<SpatialAcousticParams> = Object.freeze({
  pan: 0,
  distanceGain: 1.0,
  airLowpassHz: 18000,
  itdSec: 0,
  distanceM: 0.5,
});

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0.5 * (lo + hi);
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Converts a point from MuJoCo Z-up world coordinates `(x_m, y_m, z_m)` into
 * Three.js Y-up world coordinates `(x_m, z_m, -y_m)`, matching `<group rotation={[-Math.PI / 2, 0, 0]}>`
 * in `SceneVisuals`.
 */
export function mujocoWorldToThreeWorld(
  mjPos: ArrayLike<number>,
): [number, number, number] {
  const xm = Number(mjPos[0]) || 0;
  const ym = Number(mjPos[1]) || 0;
  const zm = Number(mjPos[2]) || 0;
  return [xm, zm, -ym];
}

/**
 * Resolves a body's live world position in MuJoCo Z-up coordinates `[x, y, z]` from
 * the main-thread `ModelMirror` and `DataMirror` (`O(1)` typed-array read), optionally
 * transforming a body-local contact/strike offset `localPoint` through `data.xmat`.
 */
export function resolveBodyWorldPosMuJoCo(
  nodeId: string,
  modelMirror?: ModelIdMapsLike | null,
  dataMirror?: DataPoseMirrorLike | null,
  localPoint?: ArrayLike<number> | null,
  fallbackNodePos?: ArrayLike<number> | null,
): [number, number, number] | null {
  const bodyMap = modelMirror?._idMaps?.body as Record<string, number> | undefined;
  const bId = bodyMap?.[nodeId];
  const xpos = dataMirror?.xpos;
  if (typeof bId === 'number' && bId >= 0 && xpos && bId * 3 + 2 < xpos.length) {
    const ox = xpos[bId * 3];
    const oy = xpos[bId * 3 + 1];
    const oz = xpos[bId * 3 + 2];
    if (Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz)) {
      const xmat = dataMirror?.xmat;
      if (
        localPoint &&
        typeof localPoint[0] === 'number' &&
        typeof localPoint[1] === 'number' &&
        typeof localPoint[2] === 'number' &&
        xmat &&
        bId * 9 + 8 < xmat.length
      ) {
        const lx = localPoint[0] || 0;
        const ly = localPoint[1] || 0;
        const lz = localPoint[2] || 0;
        const m = bId * 9;
        const wx = ox + xmat[m] * lx + xmat[m + 1] * ly + xmat[m + 2] * lz;
        const wy = oy + xmat[m + 3] * lx + xmat[m + 4] * ly + xmat[m + 5] * lz;
        const wz = oz + xmat[m + 6] * lx + xmat[m + 7] * ly + xmat[m + 8] * lz;
        if (Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(wz)) {
          return [wx, wy, wz];
        }
      }
      return [ox, oy, oz];
    }
  }
  if (
    fallbackNodePos &&
    typeof fallbackNodePos[0] === 'number' &&
    typeof fallbackNodePos[1] === 'number' &&
    typeof fallbackNodePos[2] === 'number' &&
    Number.isFinite(fallbackNodePos[0]) &&
    Number.isFinite(fallbackNodePos[1]) &&
    Number.isFinite(fallbackNodePos[2])
  ) {
    return [fallbackNodePos[0], fallbackNodePos[1], fallbackNodePos[2]];
  }
  return null;
}

/**
 * Projects a MuJoCo Z-up world position `[x_m, y_m, z_m]` against the Three.js
 * viewport camera's column-major `matrixWorld` to compute stereo pan, ITD,
 * scale-adaptive distance gain, and HF air absorption.
 */
export function resolveSpatialAcousticParams(
  mjWorldPos: ArrayLike<number> | null | undefined,
  camera?: CameraPoseLike | null,
): SpatialAcousticParams {
  if (!mjWorldPos || mjWorldPos.length < 3) return DEFAULT_SPATIAL_PARAMS;
  const xm = Number(mjWorldPos[0]);
  const ym = Number(mjWorldPos[1]);
  const zm = Number(mjWorldPos[2]);
  if (!Number.isFinite(xm) || !Number.isFinite(ym) || !Number.isFinite(zm)) {
    return DEFAULT_SPATIAL_PARAMS;
  }

  const el = camera?.matrixWorld?.elements;
  if (!el || el.length < 16) return DEFAULT_SPATIAL_PARAMS;

  const cx = Number(el[12]);
  const cy = Number(el[13]);
  const cz = Number(el[14]);
  let rx = Number(el[0]);
  let ry = Number(el[1]);
  let rz = Number(el[2]);
  if (
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(cz) ||
    !Number.isFinite(rx) ||
    !Number.isFinite(ry) ||
    !Number.isFinite(rz)
  ) {
    return DEFAULT_SPATIAL_PARAMS;
  }

  const rNormSq = rx * rx + ry * ry + rz * rz;
  if (rNormSq < 1e-12) return DEFAULT_SPATIAL_PARAMS;
  const invRNorm = 1 / Math.sqrt(rNormSq);
  rx *= invRNorm;
  ry *= invRNorm;
  rz *= invRNorm;

  // Inline MuJoCo Z-up -> Three.js Y-up (xm, zm, -ym) with zero temporary array allocation
  const dx = xm - cx;
  const dy = zm - cy;
  const dz = -ym - cz;
  const distM = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const dRight = dx * rx + dy * ry + dz * rz;
  const sinTheta = clamp(dRight / Math.max(0.08, distM), -1, 1);
  const theta = Math.asin(sinTheta);
  const nearFade = smoothstep(0.02, 0.10, distM);

  const pan = Math.round(clamp(MAX_STEREO_PAN * sinTheta * nearFade, -MAX_STEREO_PAN, MAX_STEREO_PAN) * 10000) / 10000;

  // Woodworth–Schlosberg spherical-head ITD: (a / c) * (|theta| + |sin(theta)|)
  const rawItd = (HEAD_RADIUS_M / SPEED_OF_SOUND_AIR) * (Math.abs(theta) + Math.abs(sinTheta)) * nearFade;
  const signSin = sinTheta > 0 ? 1 : sinTheta < 0 ? -1 : 0;
  const itdSec = Math.round(clamp(-signSin * rawItd, -0.00048, 0.00048) * 1e6) / 1e6;

  // Adaptive reference distance scaled to camera framing radius (supports both 160 mm bench parts & 15 m scenes)
  const camOriginDist = clamp(Math.sqrt(cx * cx + cy * cy + cz * cz), 0.18, 6.0);
  const rawGain = Math.pow(camOriginDist / Math.max(0.35 * camOriginDist, distM), 0.65);
  const distanceGain = Math.round(clamp(rawGain, 0.18, 1.25) * 10000) / 10000;

  const excessDist = distM > camOriginDist ? distM - camOriginDist : 0;
  const airLowpassHz = Math.round(clamp(18000 / (1 + 0.12 * excessDist), 2800, 18000) * 10) / 10;

  return {
    pan,
    distanceGain,
    airLowpassHz,
    itdSec,
    distanceM: Math.round(distM * 10000) / 10000,
  };
}

/**
 * Lightweight WebAudio spatial send wrapper (`GainNode -> StereoPannerNode -> destination`)
 * for one-shot percussive impacts or snaps. Falls back cleanly to `destination` when
 * panning/gain are neutral or in headless/mock AudioContexts lacking `createStereoPanner`.
 */
export function createSpatialSend(
  ctx: AudioContext,
  destination: AudioNode,
  spatial?: Partial<SpatialAcousticParams> | null,
): { input: AudioNode; disconnect: () => void } {
  if (!spatial) {
    return { input: destination, disconnect: () => {} };
  }
  const pan = Number.isFinite(spatial.pan) ? clamp(spatial.pan!, -1, 1) : 0;
  const distGain = Number.isFinite(spatial.distanceGain) ? clamp(spatial.distanceGain!, 0.05, 2.0) : 1.0;
  const needsPan = Math.abs(pan) >= 0.005 && typeof ctx.createStereoPanner === 'function';
  const needsGain = Math.abs(distGain - 1.0) >= 0.005 && typeof ctx.createGain === 'function';
  if (!needsPan && !needsGain) {
    return { input: destination, disconnect: () => {} };
  }

  const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
  let head: AudioNode = destination;
  let pannerNode: StereoPannerNode | null = null;
  let gainNode: GainNode | null = null;

  if (needsPan) {
    pannerNode = ctx.createStereoPanner();
    pannerNode.pan.setValueAtTime(pan, now);
    pannerNode.connect(head);
    head = pannerNode;
  }
  if (needsGain) {
    gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(distGain, now);
    gainNode.connect(head);
    head = gainNode;
  }

  return {
    input: head,
    disconnect: () => {
      try { gainNode?.disconnect(); } catch { /* ignore */ }
      try { pannerNode?.disconnect(); } catch { /* ignore */ }
    },
  };
}
