import { describe, it, expect } from 'vitest';
import {
  applyDab,
  buildPaintGeometry,
  canvasFromLayer,
  emptyCanvas,
  isPaintable,
  layerFromCanvas,
  paintArgsFromSize,
  paintResolution,
  sampleColor,
  toGeometrySpace,
  writeVertexColors,
} from '../src/utils/vertexPaint';
import { cloneSceneGraph } from '../src/store/useStore';
import type { SceneGraph } from '../src/types/scene';

/** A row of four vertices a millimetre apart along X, at the origin. */
const ROW = new Float32Array([
  0, 0, 0,
  0.001, 0, 0,
  0.002, 0, 0,
  0.05, 0, 0,
]);

const RED = [1, 0, 0];

describe('applyDab', () => {
  it('covers only what the brush reaches', () => {
    const canvas = emptyCanvas(4, []);
    const touched = applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: RED, flow: 1 });

    expect(touched).toEqual({ lo: 0, hi: 2 });
    expect(canvas.data[3]).toBeGreaterThan(0);      // under the middle
    // The vertex 50 mm away is outside a 2.5 mm brush and must stay bare —
    // this is the difference between a pip and a painted face.
    expect(canvas.data[3 * 4 + 3]).toBe(0);
  });

  it('builds up when the same place is painted again', () => {
    const canvas = emptyCanvas(4, []);
    const dab = () => applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: RED, flow: 0.3 });

    dab();
    const once = canvas.data[3];
    dab();
    const twice = canvas.data[3];
    for (let i = 0; i < 20; i++) dab();
    const many = canvas.data[3];

    expect(once).toBeGreaterThan(0);
    expect(twice).toBeGreaterThan(once);
    // Coverage approaches full without ever passing it, which is what keeps a
    // heavily worked area from banding.
    expect(many).toBeGreaterThan(0.95);
    expect(many).toBeLessThanOrEqual(1);
  });

  it('blends towards a second colour rather than replacing the first', () => {
    const canvas = emptyCanvas(4, []);
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: [1, 0, 0], flow: 0.5 });
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: [0, 0, 1], flow: 0.5 });

    expect(canvas.data[0]).toBeGreaterThan(0.1); // some red survives
    expect(canvas.data[2]).toBeGreaterThan(0.1); // some blue is on top
  });

  it('erases back towards bare', () => {
    const canvas = emptyCanvas(4, []);
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: RED, flow: 1 });
    const covered = canvas.data[3];
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: RED, flow: 1, erase: true });

    expect(covered).toBeGreaterThan(0.9);
    expect(canvas.data[3]).toBeLessThan(covered);
  });

  it('reports nothing when the brush misses the surface entirely', () => {
    const canvas = emptyCanvas(4, []);
    expect(applyDab(canvas, ROW, { x: 1, y: 1, z: 1, radius: 0.002, color: RED, flow: 1 })).toBeNull();
  });
});

describe('storage', () => {
  it('round-trips through the sparse form', () => {
    const canvas = emptyCanvas(4, [2, 2, 2]);
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: RED, flow: 1 });

    const layer = layerFromCanvas(canvas)!;
    expect(layer.res).toEqual([2, 2, 2]);
    // Only what carries paint is stored — the far vertex is not in the file.
    expect(layer.idx).not.toContain(3);
    expect(layer.rgba.length).toBe(layer.idx.length * 4);

    const restored = canvasFromLayer(layer, 4, layer.res);
    for (let v = 0; v < 4; v++) {
      expect(restored.data[v * 4 + 3]).toBeCloseTo(canvas.data[v * 4 + 3], 2);
    }
  });

  it('stores nothing for a canvas nobody painted', () => {
    expect(layerFromCanvas(emptyCanvas(4, []))).toBeUndefined();
  });

  it('drops a layer that no longer fits its surface instead of misplacing it', () => {
    const layer = { res: [], idx: [99], rgba: [255, 0, 0, 255] };
    const restored = canvasFromLayer(layer, 4, []);
    expect(Array.from(restored.data).every((v) => v === 0)).toBe(true);
  });

  it('survives a scene-graph clone, which is what saving and undo both use', () => {
    const scene = {
      nodes: [{
        id: 'die', name: 'die', pos: [0, 0, 0], children: [],
        geoms: [{ name: 'die_g', type: 'box', size: [0.01, 0.01, 0.01], paint: { res: [8, 8, 8], idx: [3], rgba: [255, 0, 0, 255] } }],
      }],
    };
    const clone = cloneSceneGraph(scene as unknown as SceneGraph);
    expect(clone.nodes[0].geoms?.[0].paint).toEqual({ res: [8, 8, 8], idx: [3], rgba: [255, 0, 0, 255] });
    // And through JSON, which is what the file on disk is.
    expect(JSON.parse(JSON.stringify(clone)).nodes[0].geoms[0].paint.idx).toEqual([3]);
  });
});

describe('the painted surface', () => {
  it('subdivides a small box finely enough to hold a pip', () => {
    const args = paintArgsFromSize('box', [0.01, 0.01, 0.01]);
    expect(args).toEqual([0.02, 0.02, 0.02]);

    const res = paintResolution('box', args);
    const geometry = buildPaintGeometry('box', args, res)!;
    const count = geometry.getAttribute('position').count;

    // A 20 mm die needs enough vertices across a face that a 3 mm pip is not a
    // single quad, and few enough that a scene of them still draws.
    expect(res[0]).toBeGreaterThan(10);
    expect(count).toBeGreaterThan(500);
    expect(count).toBeLessThan(80000);
  });

  it('keeps the vertex count when a painted body is resized at the same resolution', () => {
    const res = paintResolution('box', paintArgsFromSize('box', [0.01, 0.01, 0.01]));
    const small = buildPaintGeometry('box', paintArgsFromSize('box', [0.01, 0.01, 0.01]), res)!;
    const grown = buildPaintGeometry('box', paintArgsFromSize('box', [0.02, 0.02, 0.02]), res)!;

    // The stored `res` travelling with the paint is what makes this true, and
    // it is why resizing a painted die moves the pips instead of dropping them.
    expect(grown.getAttribute('position').count).toBe(small.getAttribute('position').count);
  });

  it('knows what can hold paint', () => {
    expect(isPaintable('box')).toBe(true);
    expect(isPaintable('mesh')).toBe(true);
    // A wedge draws itself from a six-vertex prism; one dab would flood a face.
    expect(isPaintable('box', true)).toBe(false);
    expect(isPaintable('plane')).toBe(false);
  });

  it('turns a geom-frame point into the space a cylinder is built in', () => {
    // Three builds cylinders along Y and the renderer stands them up, so the
    // top of a Z-up cylinder is +Y in geometry space.
    expect(toGeometrySpace('cylinder', [0, 0, 0.05])).toEqual([0, 0.05, -0]);
    expect(toGeometrySpace('box', [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('what gets drawn', () => {
  it('shows the body colour where there is no paint and the paint where there is', () => {
    const canvas = emptyCanvas(4, []);
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: [1, 0, 0], flow: 1 });

    const colors = new Float32Array(4 * 3);
    writeVertexColors(colors, [0, 0, 1, 1], canvas);

    // The far vertex is the body's own blue...
    expect(Array.from(colors.slice(9, 12))).toEqual([0, 0, 1]);
    // ...and the one under the brush is red.
    expect(colors[0]).toBeGreaterThan(0.9);
    expect(colors[2]).toBeLessThan(0.1);
  });

  it('picks up the colour actually showing, not the one underneath', () => {
    const canvas = emptyCanvas(4, []);
    applyDab(canvas, ROW, { x: 0, y: 0, z: 0, radius: 0.0025, color: [1, 0, 0], flow: 1 });

    const onPaint = sampleColor(canvas, ROW, [0, 0, 1], 0, 0, 0)!;
    const offPaint = sampleColor(canvas, ROW, [0, 0, 1], 0.05, 0, 0)!;

    expect(onPaint[0]).toBeGreaterThan(0.9);
    expect(offPaint).toEqual([0, 0, 1]);
  });
});
