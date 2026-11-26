/**
 * Tests for two Viewport / Screenshot / Camera fixes:
 * 1. Dimension text labels render as WebGL CanvasTexture sprites (not DOM <Html>
 *    overlays) so physics_get_screenshot(dims=true) captures every numeric figure.
 * 2. Adding the first body to an empty scene via physics_add_object or
 *    physics_create_lattice auto-frames the camera around the new body without
 *    disturbing the camera when subsequent bodies are added.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  createDimensionLabelTexture,
  labelAnchorCenter,
} from '../src/components/scene/DimensionOverlay';
import { framingForBounds, sceneContentBounds } from '../src/utils/frameScene';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.alert = () => {};
if (!('navigator' in g)) g.navigator = { hardwareConcurrency: 4 };

// Mock 2D canvas support on document.createElement('canvas') for Node tests.
function makeMockCanvas(withRoundRect = true) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ctx: Record<string, unknown> = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    scale: (...args: unknown[]) => calls.push({ op: 'scale', args }),
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    closePath: () => calls.push({ op: 'closePath', args: [] }),
    moveTo: (...args: unknown[]) => calls.push({ op: 'moveTo', args }),
    lineTo: (...args: unknown[]) => calls.push({ op: 'lineTo', args }),
    quadraticCurveTo: (...args: unknown[]) => calls.push({ op: 'quadraticCurveTo', args }),
    fill: () => calls.push({ op: 'fill', args: [] }),
    stroke: () => calls.push({ op: 'stroke', args: [] }),
    measureText: (text: string) => ({ width: text.length * 6.5 }),
    fillText: (...args: unknown[]) => calls.push({ op: 'fillText', args }),
  };
  if (withRoundRect) {
    ctx.roundRect = (...args: unknown[]) => calls.push({ op: 'roundRect', args });
  }
  return {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
    _ctx: ctx,
    _calls: calls,
  };
}

let lastMockCanvas: ReturnType<typeof makeMockCanvas> | null = null;
let mockWithRoundRect = true;
g.document = {
  visibilityState: 'hidden',
  documentElement: { classList: { contains: () => false } },
  createElement: (tag: string) => {
    if (tag === 'canvas') {
      lastMockCanvas = makeMockCanvas(mockWithRoundRect);
      return lastMockCanvas;
    }
    return {};
  },
};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setSound() {} setPlaying() {} resume() {} tick() {} terminate() {} clearHistory() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let objectCommands: any;
let latticeCommands: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ objectCommands } = await import('../src/hooks/mcp/objectCommands'));
  ({ latticeCommands } = await import('../src/hooks/mcp/latticeCommands'));
});

const ctx = () => ({ store: useStore.getState(), toId: (v: unknown) => v });

function cameraDistance(cam: { position: [number, number, number]; target: [number, number, number] }) {
  return Math.hypot(
    cam.position[0] - cam.target[0],
    cam.position[1] - cam.target[1],
    cam.position[2] - cam.target[2],
  );
}

describe('DimensionOverlay WebGL label sprites', () => {
  it('maps label anchors to matching THREE.Sprite center coordinates', () => {
    expect(labelAnchorCenter('centre')).toEqual([0.5, 0.5]);
    expect(labelAnchorCenter('left')).toEqual([0, 0.5]);
    expect(labelAnchorCenter('right')).toEqual([1, 0.5]);
  });

  it('renders numeric dimension labels onto a supersampled CanvasTexture for WebGL screenshots', () => {
    mockWithRoundRect = true;
    const sprite = createDimensionLabelTexture('120', { location: false, dark: false });
    expect(sprite).not.toBeNull();
    expect(sprite!.texture).toBeInstanceOf(THREE.CanvasTexture);
    expect(sprite!.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(sprite!.texture.minFilter).toBe(THREE.LinearFilter);
    expect(sprite!.texture.magFilter).toBe(THREE.LinearFilter);
    expect(sprite!.texture.generateMipmaps).toBe(false);
    expect(sprite!.widthPx).toBeGreaterThanOrEqual(24);
    expect(sprite!.heightPx).toBe(14);
    expect(lastMockCanvas!.width).toBe(sprite!.widthPx * 3);
    expect(lastMockCanvas!.height).toBe(sprite!.heightPx * 3);
    expect(lastMockCanvas!._ctx.fillStyle).toBe('#b45309');
    expect(lastMockCanvas!._calls.some((c) => c.op === 'fillText' && c.args[0] === '120')).toBe(true);
    sprite!.texture.dispose();
  });

  it('uses distinct location colours and dark-mode palette, and works without ctx.roundRect', () => {
    mockWithRoundRect = false;
    const sprite = createDimensionLabelTexture('⌀25', { location: true, dark: true, scale: 2 });
    expect(sprite).not.toBeNull();
    expect(lastMockCanvas!._ctx.fillStyle).toBe('#22d3ee');
    expect(lastMockCanvas!._calls.some((c) => c.op === 'quadraticCurveTo')).toBe(true);
    expect(lastMockCanvas!._calls.some((c) => c.op === 'fillText' && c.args[0] === '⌀25')).toBe(true);
    sprite!.texture.dispose();
  });
});

describe('Auto-framing camera when first body is added to an empty scene', () => {
  const farCamera = {
    position: [2.0, -2.0, 1.5] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  };

  it('auto-frames when ADD_OBJECT adds the first body to an empty scene, and preserves camera on later adds', async () => {
    useStore.setState({
      sceneGraph: { nodes: [] },
      cameraOverride: farCamera,
      cameraView: 'perspective',
    });

    const added = await objectCommands.ADD_OBJECT({
      body: {
        id: 'part_120mm',
        name: 'part_120mm',
        pos: [0, 0, 0.06],
        geoms: [{ type: 'box', size: [0.06, 0.06, 0.06] }],
      },
    }, ctx());
    expect(added.ok).toBe(true);

    const afterFirst = useStore.getState();
    expect(afterFirst.cameraOverride).not.toBeNull();
    const expected = framingForBounds(sceneContentBounds(afterFirst.sceneGraph.nodes)!)!;
    expect(afterFirst.cameraOverride.target[2]).toBeCloseTo(0.06, 5);
    expect(cameraDistance(afterFirst.cameraOverride)).toBeCloseTo(cameraDistance(expected), 5);
    expect(cameraDistance(afterFirst.cameraOverride)).toBeLessThan(0.6);

    // A user/agent camera move before adding a second body must be preserved.
    const customCam = {
      position: [0.5, -0.5, 0.4] as [number, number, number],
      target: [0.1, 0, 0.06] as [number, number, number],
    };
    useStore.setState({ cameraOverride: customCam });

    const second = await objectCommands.ADD_OBJECT({
      body: {
        id: 'second_part',
        name: 'second_part',
        pos: [0.2, 0, 0.02],
        geoms: [{ type: 'box', size: [0.02, 0.02, 0.02] }],
      },
    }, ctx());
    expect(second.ok).toBe(true);
    expect(useStore.getState().cameraOverride).toEqual(customCam);
  });

  it('auto-frames when CREATE_LATTICE adds the first body to an empty scene, and preserves camera on later creates', async () => {
    useStore.setState({
      sceneGraph: { nodes: [] },
      cameraOverride: farCamera,
      cameraView: 'perspective',
    });

    const created = await latticeCommands.CREATE_LATTICE({
      name: 'Bracket',
      pos: [0, 0, 0.06],
      sizeMm: 120,
    }, ctx());
    expect(created.ok).toBe(true);

    const afterFirst = useStore.getState();
    expect(afterFirst.cameraOverride).not.toBeNull();
    const expected = framingForBounds(sceneContentBounds(afterFirst.sceneGraph.nodes)!)!;
    expect(afterFirst.cameraOverride.target[2]).toBeCloseTo(0.06, 4);
    expect(cameraDistance(afterFirst.cameraOverride)).toBeCloseTo(cameraDistance(expected), 4);
    expect(cameraDistance(afterFirst.cameraOverride)).toBeLessThan(0.6);

    // Subsequent CREATE_LATTICE must not override the user's camera.
    const customCam = {
      position: [0.4, -0.4, 0.3] as [number, number, number],
      target: [0, 0, 0.05] as [number, number, number],
    };
    useStore.setState({ cameraOverride: customCam });

    const second = await latticeCommands.CREATE_LATTICE({
      name: 'Second',
      pos: [0.15, 0, 0.05],
      sizeMm: 40,
    }, ctx());
    expect(second.ok).toBe(true);
    expect(useStore.getState().cameraOverride).toEqual(customCam);
  });
});
