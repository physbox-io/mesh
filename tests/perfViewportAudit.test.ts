import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  DEPTH_RAMP,
  DEPTH_RAMP_GRADIENT,
  computeDeepestCutZ,
  fillToolpathColours,
  fillToolpathPositions,
} from '../src/utils/toolpathBuffers';
import type { PreviewMove } from '../src/utils/toolpathPreviewPath';
import { bodyPoseOf, readBodyPoseInto, type BodyPoseCache } from '../src/components/scene/bodyPose';
import { useStore } from '../src/store/useStore';

const ROOT = resolve(__dirname, '..');
const readSrc = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

function makeMoves(count: number): PreviewMove[] {
  const moves: PreviewMove[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const rapid = i % 25 === 0;
    const pass = i < count / 3 ? 'roughing' : 'finishing';
    const x1 = (i % 400) * 0.5;
    const y1 = Math.floor(i / 400) * 0.5;
    const z1 = rapid ? 5 : -((i % 20) * 0.4);
    const z2 = rapid ? 5 : -(((i + 1) % 20) * 0.4);
    moves[i] = {
      x1, y1, z1,
      x2: x1 + 0.5, y2: y1, z2,
      feed: rapid ? 3000 : 1200,
      rapid,
      pass,
      t0: i * 0.01,
      t1: (i + 1) * 0.01,
    };
  }
  return moves;
}

describe('ToolpathView large-G-code typed-array buffers', () => {
  it('fills positions and colours matching THREE.Color sRGB->linear values and viridis depth ramp', () => {
    const moves: PreviewMove[] = [
      { x1: 0, y1: 0, z1: 5, x2: 10, y2: 0, z2: 5, feed: 3000, rapid: true, pass: 'roughing', t0: 0, t1: 1 },
      { x1: 10, y1: 0, z1: 0, x2: 20, y2: 5, z2: -4, feed: 1000, rapid: false, pass: 'roughing', t0: 1, t1: 2 },
      { x1: 20, y1: 5, z1: -4, x2: 30, y2: 5, z2: -8, feed: 800, rapid: false, pass: 'finishing', t0: 2, t1: 3 },
    ];

    const deepest = computeDeepestCutZ(moves);
    expect(deepest).toBe(-8);

    const positions = fillToolpathPositions(moves);
    expect(Array.from(positions)).toEqual([
      0, 0, 5, 10, 0, 5,
      10, 0, 0, 20, 5, -4,
      20, 5, -4, 30, 5, -8,
    ]);

    const opColours = fillToolpathColours(moves, 'operation', deepest);
    const travel = new THREE.Color(0x475569);
    const rough = new THREE.Color(0xf59e0b);
    const finish = new THREE.Color(0x3b82f6);
    expect(opColours[0]).toBeCloseTo(travel.r, 5);
    expect(opColours[1]).toBeCloseTo(travel.g, 5);
    expect(opColours[2]).toBeCloseTo(travel.b, 5);
    expect(opColours[6]).toBeCloseTo(rough.r, 5);
    expect(opColours[7]).toBeCloseTo(rough.g, 5);
    expect(opColours[8]).toBeCloseTo(rough.b, 5);
    expect(opColours[12]).toBeCloseTo(finish.r, 5);
    expect(opColours[13]).toBeCloseTo(finish.g, 5);
    expect(opColours[14]).toBeCloseTo(finish.b, 5);

    // Refilling into the same buffer mutates in-place without reallocating.
    const depthColours = fillToolpathColours(moves, 'depth', deepest, opColours);
    expect(depthColours).toBe(opColours);

    // Rapid still gets travel colour in depth mode.
    expect(depthColours[0]).toBeCloseTo(travel.r, 5);
    // z = 0 maps to top of DEPTH_RAMP (t = 1).
    const top = DEPTH_RAMP[DEPTH_RAMP.length - 1];
    expect(depthColours[6]).toBeCloseTo(top[0], 5);
    expect(depthColours[7]).toBeCloseTo(top[1], 5);
    expect(depthColours[8]).toBeCloseTo(top[2], 5);
    // z = -8 (deepest) maps to bottom of DEPTH_RAMP (t = 0).
    const bottom = DEPTH_RAMP[0];
    expect(depthColours[15]).toBeCloseTo(bottom[0], 5);
    expect(depthColours[16]).toBeCloseTo(bottom[1], 5);
    expect(depthColours[17]).toBeCloseTo(bottom[2], 5);

    expect(DEPTH_RAMP_GRADIENT).toContain('linear-gradient(to left,');
  });

  it('builds and re-colours 120,000-move toolpath buffers quickly in-place', () => {
    const moves = makeMoves(120_000);
    const t0 = performance.now();
    const deepest = computeDeepestCutZ(moves);
    const pos = fillToolpathPositions(moves);
    const col = fillToolpathColours(moves, 'depth', deepest);
    const col2 = fillToolpathColours(moves, 'operation', deepest, col);
    const elapsedMs = performance.now() - t0;

    expect(pos.length).toBe(120_000 * 6);
    expect(col2).toBe(col);
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe('readBodyPoseInto zero-allocation useFrame helper', () => {
  const origState = {
    model: useStore.getState().model,
    data: useStore.getState().data,
    mujoco: useStore.getState().mujoco,
  };

  afterEach(() => {
    useStore.setState(origState);
  });

  it('writes live MuJoCo pose into caller vectors and caches mj_name2id per (model, nodeId)', () => {
    const name2id = vi.fn((_m: unknown, _t: number, name: string) => (name === 'part_a' ? 1 : -1));
    const model = { nbody: 2 };
    const data = {
      xpos: new Float64Array([0, 0, 0, 1.5, -2.25, 0.75]),
      xmat: new Float64Array([
        1, 0, 0, 0, 1, 0, 0, 0, 1,
        0, -1, 0, 1, 0, 0, 0, 0, 1,
      ]),
    };
    const mujoco = { mj_name2id: name2id, mjtObj: { mjOBJ_BODY: { value: 1 } } };
    useStore.setState({ model: model as never, data: data as never, mujoco: mujoco as never });

    const outPos = new THREE.Vector3();
    const outRot = new THREE.Matrix3();
    const cache: BodyPoseCache = { model: null, nodeId: '', bodyId: -1 };

    // Simulate 100 frames on the same model & nodeId: mj_name2id runs only once.
    for (let f = 0; f < 100; f++) {
      const live = readBodyPoseInto('part_a', [0, 0, 0], outPos, outRot, cache);
      expect(live).toBe(true);
    }
    expect(name2id).toHaveBeenCalledTimes(1);
    expect(outPos.x).toBeCloseTo(1.5, 6);
    expect(outPos.y).toBeCloseTo(-2.25, 6);
    expect(outPos.z).toBeCloseTo(0.75, 6);

    // Matches bodyPoseOf() numerically.
    const allocPose = bodyPoseOf('part_a', [0, 0, 0]);
    expect(allocPose.live).toBe(true);
    expect(allocPose.pos.distanceTo(outPos)).toBeLessThan(1e-9);
    expect(allocPose.rot.elements).toEqual(outRot.elements);

    // Unknown body falls back cleanly to authored position & identity rotation.
    const missing = readBodyPoseInto('missing_body', [3, 4, 5], outPos, outRot, cache);
    expect(missing).toBe(false);
    expect(outPos.toArray()).toEqual([3, 4, 5]);
    expect(outRot.elements).toEqual(new THREE.Matrix3().elements);
  });
});

describe('Viewport GPU disposal, useFrame hygiene, and Zustand selector regressions', () => {
  const auditedSceneFiles = [
    'src/components/scene/SceneLayer.tsx',
    'src/components/scene/TransformGizmo.tsx',
    'src/components/scene/ObjectGestures.tsx',
    'src/components/scene/FaceKnife.tsx',
    'src/components/scene/EdgeRoundTool.tsx',
    'src/components/scene/CenterOfGravityOverlay.tsx',
    'src/components/SculptSurface.tsx',
    'src/components/LatticeSurface.tsx',
    'src/components/AxisLegendDrawer.tsx',
    'src/components/PrintAnalysisOverlay.tsx',
  ];

  it('uses selector-scoped useThree() calls in all audited viewport components', () => {
    for (const file of auditedSceneFiles) {
      const src = readSrc(file);
      expect(src, `${file} should not call bare useThree()`).not.toMatch(/useThree\(\s*\)/);
    }
  });

  it('disposes GPU geometries and materials in FaceKnife unmount and EdgeRoundTool cleanup', () => {
    const faceKnife = readSrc('src/components/scene/FaceKnife.tsx');
    expect(faceKnife).toContain('disposeLineGroup(layer.current)');

    const edgeRound = readSrc('src/components/scene/EdgeRoundTool.tsx');
    expect(edgeRound).toContain('pickMesh.geometry.dispose()');
    expect(edgeRound).toContain('(pickMesh.material as THREE.Material).dispose()');
  });

  it('avoids per-frame Matrix4 and setFromPoints GPU churn in hot useFrame loops', () => {
    for (const file of ['src/components/scene/ColliderOverlay.tsx', 'src/components/scene/CsgGhosts.tsx']) {
      const src = readSrc(file);
      const start = src.indexOf('useFrame(');
      const end = src.indexOf('\n  });', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const frameBlock = src.slice(start, end);
      expect(frameBlock, `${file} useFrame must reuse Matrix4 ref`).not.toContain('new THREE.Matrix4()');
    }

    const pulley = readSrc('src/components/scene/PulleyRopes.tsx');
    expect(pulley).not.toContain('setFromPoints(');
    expect(pulley).toContain('writePolylineSegments');

    const sceneLayer = readSrc('src/components/scene/SceneLayer.tsx');
    const mouseDragIdx = sceneLayer.indexOf('export const MouseDragForceRenderer');
    const sceneCaptureIdx = sceneLayer.indexOf('export const SceneCapture');
    const mouseDragSrc = sceneLayer.slice(mouseDragIdx, sceneCaptureIdx);
    expect(mouseDragSrc).not.toContain('setFromPoints(');
    expect(mouseDragSrc).toContain('lineGeometry.dispose()');
  });

  it('keeps AppHeader, SettingsPopover, DfmHeatmap, CenterOfGravityOverlay, and DimensionOverlay guarded from idle subscriptions', () => {
    const appHeader = readSrc('src/components/header/AppHeader.tsx');
    expect(appHeader).not.toContain('useSelectedNode');

    const settings = readSrc('src/components/header/SettingsPopover.tsx');
    expect(settings).toContain('SettingsPopoverBody');

    const dfm = readSrc('src/components/scene/DfmHeatmap.tsx');
    expect(dfm).toContain('DfmHeatmapActive');

    const cog = readSrc('src/components/scene/CenterOfGravityOverlay.tsx');
    expect(cog).toContain('CenterOfGravityOverlayActive');

    const dims = readSrc('src/components/scene/DimensionOverlay.tsx');
    expect(dims).toContain('DimensionOverlayActive');

    const statusBar = readSrc('src/components/BottomStatusBar.tsx');
    expect(statusBar).toContain('ModeStatusChip');
    expect(statusBar).toContain('hardwareNodesCache');
  });

  it('does not subscribe every DynamicGeom to isPlaying', () => {
    const sceneLayer = readSrc('src/components/scene/SceneLayer.tsx');
    const start = sceneLayer.indexOf('export const DynamicGeom');
    const end = sceneLayer.indexOf('export const DragInteractionController');
    const dynamicGeomSrc = sceneLayer.slice(start, end);
    expect(dynamicGeomSrc).not.toMatch(/useStore\(\s*(?:state|s)\s*=>\s*(?:state|s)\.isPlaying\s*\)/);
  });
});
