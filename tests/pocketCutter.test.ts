import { describe, it, expect } from 'vitest';
import { pocketMesh } from '../src/utils/pocketCutter';
import { analyseMesh } from '../src/utils/meshAnalysis';

/** Signed volume in mm³ and the lowest z. */
function measure(m: { verts: number[]; faces: number[] }) {
  let vol = 0;
  for (let i = 0; i < m.faces.length; i += 3) {
    const [a, b, c] = [m.faces[i], m.faces[i + 1], m.faces[i + 2]].map((k) => m.verts.slice(k * 3, k * 3 + 3));
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  let minZ = Infinity;
  for (let i = 2; i < m.verts.length; i += 3) minZ = Math.min(minZ, m.verts[i]);
  return { vol, minZ };
}

describe('a smooth pocket cutter', () => {
  it('is a closed, outward-wound solid as deep as asked', () => {
    for (const spec of [
      { outline: 'rect' as const, widthMm: 62, lengthMm: 98, depthMm: 5, cornerRadiusMm: 12, floor: 'flat' as const },
      { outline: 'ellipse' as const, widthMm: 38, lengthMm: 38, depthMm: 7, floor: 'bowl' as const },
    ]) {
      const m = pocketMesh(spec);
      const a = analyseMesh(m.verts, m.faces);
      expect(a.integrity?.closed ?? (a as { closed?: boolean }).closed).toBe(true);
      const { vol, minZ } = measure(m);
      expect(vol).toBeGreaterThan(0);
      expect(minZ).toBeCloseTo(-spec.depthMm, 1);
    }
  });

  it('holds the volume a flat pocket of that outline should, less its fillet', () => {
    const spec = { outline: 'rect' as const, widthMm: 60, lengthMm: 100, depthMm: 5, cornerRadiusMm: 10, floor: 'flat' as const, floorRadiusMm: 2 };
    const { vol } = measure(pocketMesh(spec, 1));
    // Plan area of the rounded rect times (depth + 1 mm collar), minus a little for the fillet.
    const area = 60 * 100 - (4 - Math.PI) * 10 * 10;
    expect(vol).toBeLessThan(area * 6);
    expect(vol).toBeGreaterThan(area * 6 * 0.95);
  });

  it('makes a bowl that is smooth: no ring drops by more than a fraction of the depth', () => {
    const m = pocketMesh({ outline: 'ellipse', widthMm: 112, lengthMm: 112, depthMm: 6, floor: 'bowl' });
    const zs = [...new Set(m.verts.filter((_, i) => i % 3 === 2).map((z) => +z.toFixed(4)))].sort((p, q) => q - p);
    const steps = zs.slice(1).map((z, i) => zs[i] - z).filter((d) => d > 0);
    // The collar is one step of 1 mm; every floor ring after the rim is fine.
    expect(Math.max(...steps.slice(1))).toBeLessThan(6 / 10);
  });
});
