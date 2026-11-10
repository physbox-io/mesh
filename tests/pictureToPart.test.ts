import { describe, it, expect } from 'vitest';
import { partMask, normalizeMask, maskIoU, bestView, usablePhotoMask, viewDirection, MASK_N } from '../src/utils/silhouette';
import { runPictureToPart, sizeDifferences, sizeMm, type PartLoopDeps } from '../src/utils/pictureToPart';
import type { RawNode } from '../src/utils/sceneNodes';

/** Triangles of an axis-aligned box, metres. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return out;
}

/** An L in the XZ plane, 10 mm deep in Y: a tall leg on the left, a foot to the right. */
const L = [...box(0, 0, 0, 0.02, 0.01, 0.1), ...box(0.02, 0, 0, 0.08, 0.01, 0.02)];

/** The L as a camera in front (-Y) would photograph it, as a w x h mask. */
function photoOfL(w = 160, h = 200, mirrored = false): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // part spans x 20..140 (80 mm -> 120 px), z 0..100 mm -> rows 180..30
      const mmX = (x - 20) / 1.5, mmZ = (180 - y) / 1.5;
      const X = mirrored ? 80 - mmX : mmX;
      const inLeg = X >= 0 && X <= 20 && mmZ >= 0 && mmZ <= 100;
      const inFoot = X >= 20 && X <= 80 && mmZ >= 0 && mmZ <= 20;
      m[y * w + x] = inLeg || inFoot ? 1 : 0;
    }
  }
  return m;
}

describe('silhouette', () => {
  it('draws the L from the front the way a photo of it looks', () => {
    const photo = normalizeMask(photoOfL(), 160, 200)!;
    const front = partMask(L, { azimuthDeg: 0, elevationDeg: 0 })!;
    expect(maskIoU(front, photo)).toBeGreaterThan(0.9);
    // from behind it is mirrored, and overlaps much less
    const back = partMask(L, { azimuthDeg: 180, elevationDeg: 0 })!;
    expect(maskIoU(back, photo)).toBeLessThan(0.6);
  });

  it('finds the direction a photo was taken from', () => {
    const photo = normalizeMask(photoOfL(), 160, 200)!;
    const m = bestView(L, photo)!;
    expect(m.iou).toBeGreaterThan(0.9);
    expect(m.elevationDeg).toBeLessThanOrEqual(15);
    expect(Math.min(m.azimuthDeg, 360 - m.azimuthDeg)).toBeLessThanOrEqual(20);
    // the mirrored photo is the back
    const back = bestView(L, normalizeMask(photoOfL(160, 200, true), 160, 200)!)!;
    expect(Math.abs(back.azimuthDeg - 180)).toBeLessThanOrEqual(20);
  });

  it('a top-down view looks down Z', () => {
    expect(viewDirection({ azimuthDeg: 0, elevationDeg: 90 })[2]).toBeCloseTo(1, 6);
    const top = partMask(L, { azimuthDeg: 0, elevationDeg: 90 })!;
    // 80 x 10 mm from above: a thin bar, so a fraction of the square
    const filled = top.reduce((n, v) => n + v, 0) / (MASK_N * MASK_N);
    expect(filled).toBeLessThan(0.2);
  });

  it('trusts a part on a background, not a split that fills the frame', () => {
    expect(usablePhotoMask(photoOfL(), 160, 200)).toBe(true);
    expect(usablePhotoMask(new Uint8Array(100).fill(1), 10, 10)).toBe(false);
    expect(usablePhotoMask(new Uint8Array(100), 10, 10)).toBe(false);
  });
});

describe('size check', () => {
  it('names an axis that misses a written size', () => {
    expect(sizeMm(box(0, 0, 0, 0.08, 0.01, 0.1))!.map((v) => Math.round(v))).toEqual([80, 10, 100]);
    expect(sizeDifferences([80, 10, 100], [80, 10, 100])).toEqual([]);
    const d = sizeDifferences([80, 10, 90], [80, 10, 100]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/90\.0 mm along Z.*100 mm/);
  });
});

/**
 * A scripted session: each builder reply sets the foot's length; the part's
 * triangles follow the last applied nodes.
 */
function session(footLengths: number[], critics: { differences: string[]; match: number }[]) {
  let b = 0, c = 0;
  let current: RawNode[] = [];
  const applied: RawNode[][] = [];
  const builderPrompts: string[] = [];
  const deps: PartLoopDeps = {
    async llm(system, user) {
      if (system.startsWith('You are an inspector')) {
        const r = critics[Math.min(c++, critics.length - 1)];
        return { text: '```json\n' + JSON.stringify(r) + '\n```', truncated: false };
      }
      builderPrompts.push(user);
      const foot = footLengths[Math.min(b++, footLengths.length - 1)];
      const nodes = [{ id: 'part', name: 'part', foot }];
      return { text: '```json\n' + JSON.stringify({ nodes, view: { azimuthDeg: 10, elevationDeg: 5 }, overallMm: [80, 10, 100] }) + '\n```', truncated: false };
    },
    async apply(nodes) {
      current = nodes;
      applied.push(nodes);
      return { ok: true };
    },
    partNodes: () => current,
    partTriangles: () => {
      const foot = (current[0] as unknown as { foot: number }).foot;
      return [...box(0, 0, 0, 0.02, 0.01, 0.1), ...box(0.02, 0, 0, 0.02 + foot, 0.01, 0.02)];
    },
    render: async () => ({ mediaType: 'image/jpeg', data: 'R' }),
  };
  return { deps, applied, builderPrompts };
}

const photo = normalizeMask(photoOfL(), 160, 200)!;

describe('runPictureToPart', () => {
  it('stops as soon as the critic finds nothing and the size is right', async () => {
    const { deps } = session([0.06], [{ differences: [], match: 10 }]);
    const r = await runPictureToPart({ request: '', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: photo, sceneSystem: 'S' }, deps);
    expect(r.stoppedBecause).toBe('matched');
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0].scoreKind).toBe('overlap');
    expect(r.rounds[0].score).toBeGreaterThan(0.9);
  });

  it('feeds the measured size miss to the builder even when the critic is happy', async () => {
    const { deps, builderPrompts } = session([0.03, 0.06], [{ differences: [], match: 9 }, { differences: [], match: 10 }]);
    const r = await runPictureToPart({ request: '', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: photo, sceneSystem: 'S' }, deps);
    expect(r.rounds[0].differences.join(' ')).toMatch(/50\.0 mm along X/);
    expect(builderPrompts[1]).toMatch(/50\.0 mm along X/);
    expect(r.stoppedBecause).toBe('matched');
  });

  it('undoes a round that makes the outline worse, and tells the builder', async () => {
    // right, then much too long, then right again
    const { deps, applied, builderPrompts } = session([0.06, 0.2, 0.06], [
      { differences: ['the foot has a chamfer'], match: 7 },
      { differences: ['the foot is far too long'], match: 3 },
      { differences: [], match: 10 },
    ]);
    const r = await runPictureToPart({ request: '', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: photo, sceneSystem: 'S' }, deps);
    expect(r.rounds[1].rolledBack).toBe(true);
    // the undo re-applied round 1's nodes
    expect((applied[2][0] as unknown as { foot: number }).foot).toBe(0.06);
    expect(builderPrompts[2]).toMatch(/WORSE/);
    expect(r.bestRound).toBe(3);
  });

  it('gives up after two rounds without improvement and keeps the best', async () => {
    const { deps } = session([0.06, 0.06, 0.06, 0.06], [{ differences: ['a chamfer'], match: 7 }]);
    const r = await runPictureToPart({ request: '', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: photo, sceneSystem: 'S', maxRounds: 6 }, deps);
    expect(r.stoppedBecause).toBe('no improvement');
    expect(r.rounds).toHaveLength(3);
    expect(r.remaining).toEqual(['a chamfer']);
  });

  it('rates by the critic when the photo has no usable outline, and stops when asked', async () => {
    const ctl = new AbortController();
    const { deps } = session([0.06], [{ differences: ['x'], match: 6 }]);
    deps.onProgress = (p) => { if (p.round === 2 && p.stage === 'revising') ctl.abort(); };
    deps.signal = ctl.signal;
    const r = await runPictureToPart({ request: '', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: null, sceneSystem: 'S' }, deps);
    expect(r.rounds[0].scoreKind).toBe('critic');
    expect(r.rounds[0].score).toBeCloseTo(0.6, 6);
    expect(r.stoppedBecause).toBe('stopped');
  });

  it('retries a reply with no nodes once, then reports the failure', async () => {
    const deps: PartLoopDeps = {
      llm: async () => ({ text: 'I cannot.', truncated: false }),
      apply: async () => ({ ok: true }),
      partNodes: () => [],
      partTriangles: () => [],
      render: async () => null,
    };
    const r = await runPictureToPart({ request: '', photos: [], photoMask: null, sceneSystem: 'S' }, deps);
    expect(r.stoppedBecause).toBe('failed');
    expect(r.error).toMatch(/no "nodes"/);
  });
});
