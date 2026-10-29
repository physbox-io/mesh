// The fold guard on inward strokes leaves a crisp punch its steep wall.
//
// `draw` inverted with hardness 0.8 and depthMm is the documented way to cut
// an eye socket or a slit: a flat floor at the asked depth and a near-vertical
// wall. A face on that wall turns from facing the brush to facing sideways,
// which an over-eager fold test took for a fold and halved the dab for.

import { describe, it, expect } from 'vitest';
import { buildSculptBaseSized } from '../src/utils/sculptBases';
import { applySculptStroke } from '../src/utils/sculptCommands';

describe('a hard, depth-limited punch', () => {
  it('reaches its depth with a steep wall', () => {
    const mesh = buildSculptBaseSized('sphere', 0.08);
    const top = 0.04;
    const radius = 0.004;
    const at = Array.from({ length: 8 }, () => [0, 0, top]);
    const result = applySculptStroke(mesh, { brush: 'draw', invert: true, radius, strength: 1, hardness: 0.8, depthMm: 2.5, at });
    expect(result.warning).toBeUndefined();
    const p = mesh.positions;
    let floor = Infinity;
    // Inside the hard core (0.8 of the radius) and just outside the brush.
    let rimLow = Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const r = Math.hypot(p[i * 3], p[i * 3 + 1]);
      if (p[i * 3 + 2] < 0) continue;
      if (r < 0.5 * radius) floor = Math.min(floor, p[i * 3 + 2]);
      if (r > 1.05 * radius && r < 1.3 * radius) rimLow = Math.min(rimLow, p[i * 3 + 2]);
    }
    // The floor is at the asked depth, to a tenth of a millimetre or so.
    expect(top - floor).toBeGreaterThan(0.0023);
    expect(top - floor).toBeLessThan(0.0027);
    // And the wall is steep: 2.5 mm of depth gone within a fifth of the radius
    // or so outside the hard core, the rim barely touched.
    const rimDrop = top - rimLow - (top - Math.sqrt(top * top - (1.3 * radius) ** 2));
    expect(rimDrop).toBeLessThan(0.001);
  });
});
