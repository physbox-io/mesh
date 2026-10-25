import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyViewDimensions, type BodyMesh, type LinearDim } from '../src/utils/viewDimensions';
import { bestSectionAt, hatchSegments, sectionOf, sectionPlane, sliceLoops } from '../src/utils/sectionSlice';

const mm = (v: number) => v / 1000;

/**
 * A 60 long (X), 40 wide (Y), 20 high block with a channel along its length:
 * 18 wide, walls 4 down from the top, then a round floor R9 — 13 deep in all.
 */
function channelBlock(): BodyMesh {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(mm(40), 0);
  s.lineTo(mm(40), mm(20));
  s.lineTo(mm(31), mm(20));
  s.lineTo(mm(31), mm(16));
  s.absarc(mm(22), mm(16), mm(9), 0, -Math.PI, true);
  s.lineTo(mm(13), mm(20));
  s.lineTo(0, mm(20));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: mm(60), bevelEnabled: false, curveSegments: 24 });
  // Shape x → Y, shape y → Z, extruded along +X.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  const positions = Array.from(g.getAttribute('position').array as ArrayLike<number>);
  const faces = g.index ? Array.from(g.index.array as ArrayLike<number>) : positions.map((_, i) => i).filter((i) => i < positions.length / 3);
  return { id: 'block', positions, faces };
}

const linear = (d: { dims: unknown[] } | null, axis: 'u' | 'v') =>
  (d?.dims ?? []).filter((x): x is LinearDim => (x as LinearDim).kind === 'linear' && (x as LinearDim).axis === axis);

describe('sliceLoops', () => {
  it('a cut across the channel is one closed outline', () => {
    const loops = sliceLoops(channelBlock().positions, channelBlock().faces, [1, 0, 0], mm(30));
    expect(loops).toHaveLength(1);
    for (const p of loops[0]) expect(p[0]).toBeCloseTo(mm(30), 9);
  });
});

describe('sectionOf', () => {
  it("side view, cut mid-length: the channel's radius, its centre located, and the block's size", () => {
    const block = channelBlock();
    const section = sectionOf(block, 'side', mm(-30))!;
    expect(section).not.toBeNull();
    const d = bodyViewDimensions(section.body, 'side');
    const labels = (d?.dims ?? []).map((x) => (x as { label: string }).label);
    expect(labels).toContain('R9');
    // Up: the floor's centre 16 up, the 4 to the top left to the overall.
    expect(linear(d, 'v').map((x) => x.label)).toEqual(['16', '20']);
    expect(linear(d, 'u').some((x) => x.label === '40')).toBe(true);
  });

  it('fills the cut face with triangles on the plane', () => {
    const section = sectionOf(channelBlock(), 'side', mm(-30))!;
    expect(section.fill.length % 9).toBe(0);
    let area = 0;
    for (let i = 0; i < section.fill.length; i += 9) {
      const [ay, az, by, bz, cy, cz] = [1, 2, 4, 5, 7, 8].map((k) => section.fill[i + k]);
      area += Math.abs((by - ay) * (cz - az) - (bz - az) * (cy - ay)) / 2;
    }
    // 40 × 20 less the 18 × 4 slot and the half-round R9.
    expect(area * 1e6).toBeCloseTo(800 - 72 - (Math.PI * 81) / 2, 0);
  });
});

describe('bestSectionAt', () => {
  it('from the top, cuts through the channel rather than the solid under it', () => {
    const block = channelBlock();
    const at = bestSectionAt(block, 'topDown');
    const { offset } = sectionPlane(block, 'topDown', at);
    // The line of sight is −Z, so the plane is at z = −offset; the channel runs from 7 up.
    expect(-offset).toBeGreaterThan(mm(7));
    expect(-offset).toBeLessThan(mm(20));
  });
});

describe('hatchSegments', () => {
  it('hatches inside the outline and nowhere else', () => {
    const square: [number, number, number][] = [[0, 0, 0], [mm(10), 0, 0], [mm(10), mm(10), 0], [0, mm(10), 0]];
    const segs = hatchSegments([square], 'topDown', 0, mm(1));
    expect(segs.length).toBeGreaterThan(0);
    for (let i = 0; i < segs.length; i += 3) {
      expect(segs[i]).toBeGreaterThanOrEqual(-1e-9);
      expect(segs[i]).toBeLessThanOrEqual(mm(10) + 1e-9);
      expect(segs[i + 1]).toBeGreaterThanOrEqual(-1e-9);
      expect(segs[i + 1]).toBeLessThanOrEqual(mm(10) + 1e-9);
    }
  });
});
