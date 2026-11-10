// Comparing a part's outline with a photo of it.
//
// Both are reduced to a binary mask cropped to its own bounding box and
// scaled into an N x N square, keeping its aspect, so the comparison ignores
// where the thing sits in the frame and how big it is drawn and looks only at
// its shape. The part is drawn by rasterising its own triangles from a view
// direction, not by reading a screenshot, so the floor, the grid and the
// lighting cannot leak into the score. The direction is found by search: the
// one whose outline overlaps the photo's best.

export type Mask = Uint8Array;

/** Square side of a normalised mask. Enough to tell a hole from a notch. */
export const MASK_N = 96;

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Fitting a box of size w x h into N x N, centred: scale and offsets. */
function fit(w: number, h: number, n: number) {
  const k = (n - 2) / Math.max(w, h, 1e-12);
  return { k, ox: (n - w * k) / 2, oy: (n - h * k) / 2 };
}

/**
 * A picture's mask (1 = part), cropped to the part and scaled into N x N.
 * Null when there is no part in it.
 */
export function normalizeMask(mask: Mask, width: number, height: number, n = MASK_N): Mask | null {
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
  }
  if (b.minX > b.maxX) return null;
  const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1;
  const { k, ox, oy } = fit(w, h, n);
  const out = new Uint8Array(n * n);
  // Sample the source at each target pixel's centre.
  for (let ty = 0; ty < n; ty++) {
    const sy = Math.floor((ty + 0.5 - oy) / k + b.minY);
    if (sy < b.minY || sy > b.maxY) continue;
    for (let tx = 0; tx < n; tx++) {
      const sx = Math.floor((tx + 0.5 - ox) / k + b.minX);
      if (sx < b.minX || sx > b.maxX) continue;
      out[ty * n + tx] = mask[sy * width + sx] ? 1 : 0;
    }
  }
  return out;
}

/**
 * Whether a photo's mask is a part on a background rather than a failed
 * split: a sensible share of the frame, and not mostly running off its edges.
 */
export function usablePhotoMask(mask: Mask, width: number, height: number): boolean {
  let inside = 0;
  for (let i = 0; i < mask.length; i++) inside += mask[i];
  const share = inside / Math.max(1, width * height);
  if (share < 0.02 || share > 0.9) return false;
  let edge = 0, edgeIn = 0;
  const visit = (i: number) => { edge++; edgeIn += mask[i]; };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
  return edgeIn / Math.max(1, edge) < 0.25;
}

/** Intersection over union of two masks of the same size. */
export function maskIoU(a: Mask, b: Mask): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 0;
}

export interface View {
  /** Round the vertical axis: 0 looks at the part's front (camera on -Y), 90 from +X. */
  azimuthDeg: number;
  /** 0 level, 90 straight down. */
  elevationDeg: number;
}

const RAD = Math.PI / 180;

/** Unit vector from the part toward the camera, world Z-up. */
export function viewDirection(v: View): [number, number, number] {
  const az = v.azimuthDeg * RAD, el = v.elevationDeg * RAD;
  return [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
}

/** Screen right and up for a camera looking along -viewDirection, Z up (Y up when looking straight down). */
function screenAxes(v: View): { right: number[]; up: number[] } {
  const d = viewDirection(v);
  const worldUp = Math.abs(d[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  // right = worldUp x d, normalised; up = d x right.
  let right = [worldUp[1] * d[2] - worldUp[2] * d[1], worldUp[2] * d[0] - worldUp[0] * d[2], worldUp[0] * d[1] - worldUp[1] * d[0]];
  const rl = Math.hypot(right[0], right[1], right[2]) || 1;
  right = right.map((c) => c / rl);
  const up = [d[1] * right[2] - d[2] * right[1], d[2] * right[0] - d[0] * right[2], d[0] * right[1] - d[1] * right[0]];
  return { right, up };
}

/**
 * The part's outline from a direction (orthographic), normalised like a photo
 * mask. `tris` is a flat list of triangles, nine numbers each, any unit.
 */
export function partMask(tris: ArrayLike<number>, view: View, n = MASK_N): Mask | null {
  const count = Math.floor(tris.length / 9);
  if (!count) return null;
  const { right, up } = screenAxes(view);
  const u = new Float64Array(count * 3), w = new Float64Array(count * 3);
  let minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity;
  for (let i = 0; i < count * 3; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    u[i] = x * right[0] + y * right[1] + z * right[2];
    // Image rows run down the screen.
    w[i] = -(x * up[0] + y * up[1] + z * up[2]);
    if (u[i] < minU) minU = u[i];
    if (u[i] > maxU) maxU = u[i];
    if (w[i] < minW) minW = w[i];
    if (w[i] > maxW) maxW = w[i];
  }
  const { k, ox, oy } = fit(maxU - minU, maxW - minW, n);
  const out = new Uint8Array(n * n);
  for (let t = 0; t < count; t++) {
    const ax = (u[t * 3] - minU) * k + ox, ay = (w[t * 3] - minW) * k + oy;
    const bx = (u[t * 3 + 1] - minU) * k + ox, by = (w[t * 3 + 1] - minW) * k + oy;
    const cx = (u[t * 3 + 2] - minU) * k + ox, cy = (w[t * 3 + 2] - minW) * k + oy;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));
    const s = area > 0 ? 1 : -1;
    for (let py = y0; py <= y1; py++) {
      const qy = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5;
        const e0 = s * ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax));
        const e1 = s * ((cx - bx) * (qy - by) - (cy - by) * (qx - bx));
        const e2 = s * ((ax - cx) * (qy - cy) - (ay - cy) * (qx - cx));
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) out[py * n + px] = 1;
      }
    }
  }
  return out;
}

export interface ViewMatch extends View {
  iou: number;
}

/**
 * The direction from which the part's outline best overlaps the photo's: a
 * coarse sweep round and over the part, then a finer one round the best.
 * `near`, the builder's guess, breaks near-ties (a symmetric part matches
 * front and back equally).
 */
export function bestView(tris: ArrayLike<number>, photo: Mask, near?: View, n = MASK_N): ViewMatch | null {
  let best: ViewMatch | null = null;
  const angleOff = (v: View) => near
    ? (Math.abs(((v.azimuthDeg - near.azimuthDeg + 540) % 360) - 180) + Math.abs(v.elevationDeg - near.elevationDeg)) / 360
    : 0;
  const tryView = (v: View) => {
    const m = partMask(tris, v, n);
    if (!m) return;
    const iou = maskIoU(m, photo);
    // A hair of preference for the guess: 0.01 IoU per half-turn away.
    const score = iou - 0.02 * angleOff(v);
    const bestScore = best ? best.iou - 0.02 * angleOff(best) : -Infinity;
    if (score > bestScore) best = { ...v, iou };
  };
  for (const el of [0, 15, 30, 45, 60, 75, 90]) {
    for (let az = 0; az < 360; az += el === 90 ? 90 : 30) tryView({ azimuthDeg: az, elevationDeg: el });
  }
  if (!best) return null;
  const coarse: ViewMatch = best;
  for (let daz = -20; daz <= 20; daz += 5) {
    for (let del = -10; del <= 10; del += 5) {
      const el = Math.max(0, Math.min(90, coarse.elevationDeg + del));
      tryView({ azimuthDeg: (coarse.azimuthDeg + daz + 360) % 360, elevationDeg: el });
    }
  }
  return best;
}
