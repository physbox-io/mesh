import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { hasRotationDelta } from '../src/components/scene/TransformGizmo';
import { toParentQuat } from '../src/components/scene/bodyPose';
import { axisPlaneNormal } from '../src/components/scene/ObjectGestures';
import { planeSection } from '../src/components/scene/FaceKnife';
import { collectVisibleBodyBounds, isValidMarqueeDrag } from '../src/components/scene/MarqueeSelect';
import { resolveBrushScale } from '../src/hooks/useVertexPaint';
import { applyDab, closestPointOnTriangleBary, emptyCanvas } from '../src/utils/vertexPaint';
import { useStore } from '../src/store/useStore';
import type { SceneNode } from '../src/types/scene';

describe('Audit 5B — Direct 3D Editing Tools regression tests', () => {
  describe('TransformGizmo helpers', () => {
    it('hasRotationDelta handles identity, double-cover (-q), tiny noise, real turns, and NaN', () => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
      const negQ = new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w);
      const tinyTurn = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1e-8));
      const realTurn = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.01));
      const nanQ = new THREE.Quaternion(NaN, 0, 0, 1);

      expect(hasRotationDelta(q, q.clone())).toBe(false);
      expect(hasRotationDelta(q, negQ)).toBe(false);
      expect(hasRotationDelta(q, tinyTurn)).toBe(false);
      expect(hasRotationDelta(q, realTurn)).toBe(true);
      expect(hasRotationDelta(q, nanQ)).toBe(false);
    });

    it('toParentQuat passes through top-level bodies and factors out parent rotation for nested children', () => {
      const parentNode: SceneNode = {
        id: 'parent_body',
        name: 'parent_body',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        geoms: [{ name: 'p_box', type: 'box', size: [0.1, 0.1, 0.1] }],
        children: [
          {
            id: 'child_body',
            name: 'child_body',
            type: 'body',
            pos: [0.2, 0, 0],
            joints: [],
            geoms: [{ name: 'c_box', type: 'box', size: [0.05, 0.05, 0.05] }],
            children: [],
          },
        ],
      };

      // Parent rotated 90° around Z in MuJoCo xmat (row-major body-to-world)
      const parentRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const parentMat = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(parentRot));
      // Matrix3.elements is column-major; xmat is row-major
      const e = parentMat.elements;
      const xmat = new Float64Array([
        1, 0, 0, 0, 1, 0, 0, 0, 1, // worldbody (0)
        e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8], // parent_body (1)
      ]);
      const xpos = new Float64Array([0, 0, 0, 0, 0, 0]);

      const prev = useStore.getState();
      useStore.setState({
        sceneGraph: { ...prev.sceneGraph, nodes: [parentNode] },
        model: {} as never,
        data: { xpos, xmat } as never,
        mujoco: {
          mjtObj: { mjOBJ_BODY: { value: 1 } },
          mj_name2id: (_m: unknown, _t: number, name: string) => (name === 'parent_body' ? 1 : -1),
        } as never,
      });

      try {
        // World orientation = 135° around Z => local relative to 90° parent should be 45° around Z
        const worldQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (3 * Math.PI) / 4);
        const topLevelLocal = toParentQuat('parent_body', worldQ);
        expect(topLevelLocal.angleTo(worldQ)).toBeLessThan(1e-6);

        const childLocal = toParentQuat('child_body', worldQ);
        const expectedLocal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
        expect(childLocal.angleTo(expectedLocal)).toBeLessThan(1e-6);
      } finally {
        useStore.setState({
          sceneGraph: prev.sceneGraph,
          model: prev.model,
          data: prev.data,
          mujoco: prev.mujoco,
        });
      }
    });
  });

  describe('ObjectGestures helpers', () => {
    it('axisPlaneNormal produces a plane containing Z even when looking straight down Z', () => {
      const zNormal = axisPlaneNormal(new THREE.Vector3(0, 0, 5), 'z');
      expect(zNormal).not.toBeNull();
      expect(Math.abs(zNormal!.z)).toBeLessThan(1e-6);
      expect(zNormal!.length()).toBeCloseTo(1, 6);

      const xNormal = axisPlaneNormal(new THREE.Vector3(5, 0, 0), 'x');
      expect(xNormal).not.toBeNull();
      expect(Math.abs(xNormal!.x)).toBeLessThan(1e-6);

      const yNormal = axisPlaneNormal(new THREE.Vector3(0, -5, 0), 'y');
      expect(yNormal).not.toBeNull();
      expect(Math.abs(yNormal!.y)).toBeLessThan(1e-6);
    });

    it('axisPlaneNormal returns null on degenerate zero or NaN eye vectors', () => {
      expect(axisPlaneNormal(new THREE.Vector3(0, 0, 0), null)).toBeNull();
      expect(axisPlaneNormal(new THREE.Vector3(NaN, 1, 2), 'z')).toBeNull();
    });
  });

  describe('FaceKnife helpers & undo atomicity', () => {
    it('planeSection skips single-vertex grazing touches, invalid indices, and non-finite inputs', () => {
      // Triangle 0 crosses z=0 cleanly; Triangle 1 only touches z=0 at vertex 3 (d = [0, -1, -1])
      const positions = [
        // tri 0
        0, 0, -1,
        1, 0, 1,
        0, 1, 1,
        // tri 1 (single vertex on plane)
        2, 0, 0,
        3, 0, -1,
        2, 1, -1,
      ];
      const faces = [0, 1, 2, 3, 4, 5, 0, 99, 1]; // 3rd tri has out-of-bounds index
      const segs = planeSection(positions, faces, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
      // Only tri 0 should emit a single segment (6 floats)
      expect(segs).toHaveLength(6);
      expect(segs.every(Number.isFinite)).toBe(true);

      // Zero or NaN normal/origin must return empty
      expect(planeSection(positions, faces, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0))).toEqual([]);
      expect(planeSection(positions, faces, new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(0, 0, 1))).toEqual([]);
    });

    describe('multi-geom setGeomFaceSplits undo atomicity', () => {
      beforeEach(() => {
        const node: SceneNode = {
          id: 'compound',
          name: 'compound',
          type: 'body',
          pos: [0, 0, 0],
          joints: [],
          children: [],
          geoms: [
            { name: 'g1', type: 'box', size: [0.02, 0.02, 0.02] },
            { name: 'g2', type: 'box', size: [0.02, 0.02, 0.02], pos: [0.04, 0, 0] },
          ],
        };
        useStore.setState({
          sceneGraph: { ...useStore.getState().sceneGraph, nodes: [node] },
          undoStack: [],
          redoStack: [],
          tempUndoState: null,
          lastInteractionType: null,
          selectedNodeId: 'compound',
        });
      });

      it('records a single undo entry when splitting two geoms in one stroke', () => {
        const split = { at: [0, 0, 0], normal: [1, 0, 0], seeds: [[0, 0, 0.02]] };
        const store = useStore.getState();
        store.setGeomFaceSplits('compound', 'g1', [split], true);
        store.setGeomFaceSplits('compound', 'g2', [split], false);
        store.flushPendingUndo();

        expect(useStore.getState().undoStack).toHaveLength(1);
        const afterNode = useStore.getState().sceneGraph.nodes[0];
        expect(afterNode.geoms[0].faceSplits).toHaveLength(1);
        expect(afterNode.geoms[1].faceSplits).toHaveLength(1);

        // Single undo reverts both geoms at once
        useStore.getState().undo();
        const undoneNode = useStore.getState().sceneGraph.nodes[0];
        expect(undoneNode.geoms[0].faceSplits).toBeUndefined();
        expect(undoneNode.geoms[1].faceSplits).toBeUndefined();
      });
    });
  });

  describe('MarqueeSelect helpers', () => {
    it('isValidMarqueeDrag rejects zero-size, sub-threshold, and NaN drags', () => {
      expect(isValidMarqueeDrag(100, 100, 100, 100)).toBe(false);
      expect(isValidMarqueeDrag(100, 100, 103, 103)).toBe(false);
      expect(isValidMarqueeDrag(100, 100, NaN, 120)).toBe(false);
      expect(isValidMarqueeDrag(100, 100, 105, 100)).toBe(true);
      expect(isValidMarqueeDrag(100, 100, 90, 90)).toBe(true);
    });

    it('collectVisibleBodyBounds ignores meshes with NaN bounding boxes without corrupting valid siblings', () => {
      const scene = new THREE.Scene();
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'b1';

      const goodGeo = new THREE.BoxGeometry(1, 1, 1);
      const goodMesh = new THREE.Mesh(goodGeo, new THREE.MeshBasicMaterial());

      const badGeo = new THREE.BufferGeometry();
      badGeo.setAttribute('position', new THREE.Float32BufferAttribute([NaN, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      const badMesh = new THREE.Mesh(badGeo, new THREE.MeshBasicMaterial());

      bodyGroup.add(goodMesh, badMesh);
      scene.add(bodyGroup);

      const bounds = collectVisibleBodyBounds(scene, new Set(['b1']));
      const box = bounds.get('b1');
      expect(box).toBeDefined();
      const center = box!.getCenter(new THREE.Vector3());
      expect(Number.isFinite(center.x)).toBe(true);
      expect(Number.isFinite(center.y)).toBe(true);
      expect(Number.isFinite(center.z)).toBe(true);
      expect(center.length()).toBeLessThan(1e-6);
    });
  });

  describe('useVertexPaint & vertexPaint guards', () => {
    it('resolveBrushScale handles mirrored, zero, and NaN scales safely', () => {
      expect(resolveBrushScale(new THREE.Vector3(2, 2, 2))).toBeCloseTo(2, 6);
      expect(resolveBrushScale(new THREE.Vector3(-1, -1, -1))).toBeCloseTo(1, 6);
      expect(resolveBrushScale(new THREE.Vector3(-2, 4, -6))).toBeCloseTo(4, 6);
      expect(resolveBrushScale(new THREE.Vector3(0, 0, 0))).toBe(1);
      expect(resolveBrushScale(new THREE.Vector3(NaN, 1, 1))).toBe(1);
    });

    it('applyDab rejects NaN/non-positive brush parameters without corrupting canvas data', () => {
      const canvas = emptyCanvas(3, [1]);
      const positions = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
      const faces = new Uint32Array([0, 1, 2]);

      expect(applyDab(canvas, positions, { x: NaN, y: 0, z: 0, radius: 0.05, color: [1, 0, 0], flow: 0.5 }, faces)).toBeNull();
      expect(applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: NaN, color: [1, 0, 0], flow: 0.5 }, faces)).toBeNull();
      expect(applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0, color: [1, 0, 0], flow: 0.5 }, faces)).toBeNull();
      expect(applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.05, color: [1, 0, 0], flow: NaN }, faces)).toBeNull();
      expect(applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.05, color: [1, 0, 0], flow: -0.2 }, faces)).toBeNull();
      expect(Array.from(canvas.data).every((v) => v === 0)).toBe(true);

      // NaN hardness falls back cleanly to 0 rather than writing NaN
      const range = applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.05, color: [1, 0, 0], flow: 0.5, hardness: NaN }, faces);
      expect(range).not.toBeNull();
      expect(Array.from(canvas.data).every(Number.isFinite)).toBe(true);
    });

    it('closestPointOnTriangleBary returns finite weights on degenerate zero-area triangles', () => {
      // Collinear vertices (zero area)
      const res = closestPointOnTriangleBary(0.5, 0.1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 0);
      expect(Number.isFinite(res.d2)).toBe(true);
      expect(Number.isFinite(res.wa)).toBe(true);
      expect(Number.isFinite(res.wb)).toBe(true);
      expect(Number.isFinite(res.wc)).toBe(true);
      expect(res.wa + res.wb + res.wc).toBeCloseTo(1, 6);
    });
  });
});
