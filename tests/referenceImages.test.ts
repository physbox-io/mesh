import { describe, expect, it } from 'vitest';
import {
  defaultPlacement, describeReferenceImage, planeAxes, readReferencePatch, referenceHeight,
  REFERENCE_DEFAULT_WIDTH, upsertReferenceImage,
} from '../src/utils/referenceImages';

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe('planeAxes', () => {
  it('gives a right-handed frame for each view, facing the camera of the same name', () => {
    for (const plane of ['front', 'side', 'top'] as const) {
      const { right, up, normal } = planeAxes(plane);
      // right x up = normal, so the picture is not mirrored when seen from its view
      expect(cross(right, up)).toEqual(normal);
    }
    expect(planeAxes('front').normal).toEqual([0, -1, 0]);   // the front view looks along +Y from -Y
    expect(planeAxes('side').normal).toEqual([1, 0, 0]);     // the side view looks along -X from +X
    expect(planeAxes('top').normal).toEqual([0, 0, 1]);
  });
});

describe('defaultPlacement', () => {
  const candle = { min: [-0.053, -0.053, 0], max: [0.053, 0.053, 0.107] } as { min: [number, number, number]; max: [number, number, number] };

  it('comes in as wide as the model, centred on it, standing on the floor', () => {
    const p = defaultPlacement('front', 0.8, candle);
    expect(p.width).toBeCloseTo(0.106);
    expect(p.pos[0]).toBeCloseTo(0);
    expect(p.pos[2]).toBeCloseTo(0.106 / 0.8 / 2);
  });

  it('measures a side picture across Y and lays a top one on the floor', () => {
    const wide = { min: [0, -0.2, 0], max: [0.05, 0.2, 0.05] } as typeof candle;
    expect(defaultPlacement('side', 1, wide).width).toBeCloseTo(0.4);
    expect(defaultPlacement('top', 1, wide).pos[2]).toBeLessThan(0.001);
  });

  it('falls back to the default width in an empty scene, and an explicit width wins', () => {
    expect(defaultPlacement('front', 1, null).width).toBe(REFERENCE_DEFAULT_WIDTH);
    expect(defaultPlacement('front', 1, candle, 0.3).width).toBe(0.3);
  });
});

describe('upsertReferenceImage', () => {
  it('adds a picture with defaults and then patches it by id without touching the others', () => {
    const a = upsertReferenceImage(undefined, undefined, { src: 'data:a', aspect: 2, name: 'photo' }, null);
    expect(a.images).toHaveLength(1);
    expect(a.image).toMatchObject({ name: 'photo', plane: 'front', opacity: 0.5, overlay: true, aspect: 2 });
    const b = upsertReferenceImage(a.images, undefined, { src: 'data:b', aspect: 1 }, null);
    const c = upsertReferenceImage(b.images, a.image.id, { opacity: 0.2, plane: 'side' }, null);
    expect(c.images).toHaveLength(2);
    expect(c.image).toMatchObject({ id: a.image.id, opacity: 0.2, plane: 'side', src: 'data:a' });
    expect(c.images[1]).toBe(b.images[1]);
  });

  it('turns a height into a width by the picture\'s aspect', () => {
    const { image } = upsertReferenceImage(undefined, undefined, { src: 'data:a', aspect: 0.8, height: 0.09 }, null);
    expect(image.width).toBeCloseTo(0.072);
    expect(referenceHeight(image)).toBeCloseTo(0.09);
  });

  it('refuses an unknown id, and a new picture with no pixels', () => {
    expect(() => upsertReferenceImage([], 'nope', { opacity: 1 }, null)).toThrow(/No reference image/);
    expect(() => upsertReferenceImage([], 'nope', { src: 'data:x', aspect: 1 }, null)).toThrow(/No reference image/);
    expect(() => upsertReferenceImage([], undefined, { opacity: 1 }, null)).toThrow(/needs a picture/);
  });
});

describe('readReferencePatch', () => {
  it('reads numbers given as strings, and booleans given as "false"', () => {
    expect(readReferencePatch({ width: '0.075', opacity: '0.4', center: ['0', 0, '0.045'], overlay: 'false' }))
      .toEqual({ width: 0.075, opacity: 0.4, pos: [0, 0, 0.045], overlay: false });
  });

  it('names the field it cannot read', () => {
    expect(() => readReferencePatch({ plane: 'back' })).toThrow(/plane must be/);
    expect(() => readReferencePatch({ center: [0, 0] })).toThrow(/center/);
    expect(() => readReferencePatch({ width: 'wide' })).toThrow(/width/);
    expect(() => readReferencePatch({ opacity: 2 })).toThrow(/opacity/);
    expect(() => readReferencePatch({ width: 0 })).toThrow(/width/);
  });
});

it('describes a picture in millimetres, without its pixels', () => {
  const { image } = upsertReferenceImage(undefined, undefined, { src: 'data:big', aspect: 2, width: 0.1 }, null);
  const d = describeReferenceImage(image);
  expect(d).toMatchObject({ widthMm: 100, heightMm: 50, plane: 'front' });
  expect(JSON.stringify(d)).not.toContain('data:big');
});
