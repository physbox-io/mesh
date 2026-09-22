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
    for (let k = 0; k < 9; k++) positions[w * 9 + k] = report.tris[src + k];
    for (let v = 0; v < 3; v++) {
      colors[w * 9 + v * 3] = c.r;
      colors[w * 9 + v * 3 + 1] = c.g;
      colors[w * 9 + v * 3 + 2] = c.b;
    }
    w++;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  return geom;
}
