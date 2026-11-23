// Turning a DFM report into something the viewport can draw.
//
// Split from the component so it can be tested without a renderer, and so the
// colour ramp lives next to the geometry it colours rather than inside a React
// file that happens to mount it.

import * as THREE from 'three';
import type { DfmReport } from './dfm';

/** Cool to hot. Nothing at 0 — those triangles are not drawn at all. */
function heatColor(h: number, out: THREE.Color): THREE.Color {
  // Amber at the threshold, red at the worst. Two hues rather than a rainbow:
  // the question is "how bad", and a rainbow makes that an ordering puzzle.
  return out.setHSL(
    THREE.MathUtils.lerp(0.11, 0.0, Math.min(1, h)),
    0.95,
    THREE.MathUtils.lerp(0.55, 0.42, Math.min(1, h)),
  );
}

/**
 * Outward offset along each triangle's geometric face normal, in world metres
 * (0.08 mm). SceneCanvas enables `logarithmicDepthBuffer: true`, which writes
 * `gl_FragDepthEXT` and makes WebGL `polygonOffset` a hardware no-op; a tiny
 * geometric normal lift prevents coplanar Z-fighting against the part surface.
 */
export const HEAT_NORMAL_OFFSET_M = 0.00008;

export function buildHeatGeometry(report: DfmReport): THREE.BufferGeometry | null {
  const count = report.heat.length;
  if (!count) return null;

  let hotCount = 0;
  for (let t = 0; t < count; t++) if (report.heat[t] > 0.001) hotCount++;
  if (hotCount === 0) return null;

  const positions = new Float32Array(hotCount * 9);
  const colors = new Float32Array(hotCount * 9);
  const c = new THREE.Color();
  let w = 0;
  for (let t = 0; t < count; t++) {
    const h = report.heat[t];
    if (h <= 0.001) continue;
    heatColor(h, c);
    const src = t * 9;
    const x0 = report.tris[src], y0 = report.tris[src + 1], z0 = report.tris[src + 2];
    const x1 = report.tris[src + 3], y1 = report.tris[src + 4], z1 = report.tris[src + 5];
    const x2 = report.tris[src + 6], y2 = report.tris[src + 7], z2 = report.tris[src + 8];
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const ox = len > 1e-12 ? (nx / len) * HEAT_NORMAL_OFFSET_M : 0;
    const oy = len > 1e-12 ? (ny / len) * HEAT_NORMAL_OFFSET_M : 0;
    const oz = len > 1e-12 ? (nz / len) * HEAT_NORMAL_OFFSET_M : 0;

    const dst = w * 9;
    positions[dst] = x0 + ox;
    positions[dst + 1] = y0 + oy;
    positions[dst + 2] = z0 + oz;
    positions[dst + 3] = x1 + ox;
    positions[dst + 4] = y1 + oy;
    positions[dst + 5] = z1 + oz;
    positions[dst + 6] = x2 + ox;
    positions[dst + 7] = y2 + oy;
    positions[dst + 8] = z2 + oz;

    for (let v = 0; v < 3; v++) {
      colors[dst + v * 3] = c.r;
      colors[dst + v * 3 + 1] = c.g;
      colors[dst + v * 3 + 2] = c.b;
    }
    w++;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}
