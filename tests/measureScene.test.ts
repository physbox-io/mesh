import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { measureInScene, snapInScene, sceneCandidates, toThree, toMujoco } from '../src/utils/measureScene';
import type { Vec3 } from '../src/utils/measureSnap';

/**
 * A body drawn the way the app draws one: a named group holding a mesh.
 * `bodyOf` uses that name to tell the model from the floor grid.
 */
function body(id: string, mesh: THREE.Mesh, at: Vec3 = [0, 0, 0]): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.position.set(...at);
  group.add(mesh);
  return group;
}

function scene(...groups: THREE.Object3D[]): THREE.Scene {
  const root = new THREE.Scene();
  for (const group of groups) root.add(group);
  root.updateMatrixWorld(true);
  return root;
}

describe('the frame swap', () => {
  it('goes both ways', () => {
    const point: Vec3 = [0.1, 0.2, 0.3];
    expect(toMujoco(toThree(point))).toEqual(point);
  });

  it('puts MuJoCo Z up where the renderer puts Y', () => {
    const up = toThree([0, 0, 1]);
    expect(up[1]).toBe(1);
    expect(up[0]).toBe(0);
    expect(Math.abs(up[2])).toBe(0);
  });
});

describe('what the scene offers to snap to', () => {
  it('ignores anything that is not inside a named body group', () => {
    const loose = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02));
    const root = scene(loose);
    expect(sceneCandidates(root, [0, 0, 0], 0.1).length).toBe(0);
  });

  it('gives a box its eight corners and its middle', () => {
    const root = scene(body('block', new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02))));
    const centres = sceneCandidates(root, [0, 0, 0], 0.1).filter((c) => c.kind === 'centre');
    expect(centres.some((c) => c.label.includes('centre of block'))).toBe(true);
    const corners = sceneCandidates(root, [0, 0, 0], 0.1).filter((c) => c.label === 'corner of block');
    // Eight analytic corners, plus whatever the tessellation contributes.
    expect(corners.length).toBeGreaterThanOrEqual(8);
  });

  it('gives a cylinder its axis and both ends', () => {
    const root = scene(body('pin', new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.04, 24))));
    const labels = sceneCandidates(root, [0, 0, 0], 0.1).map((c) => c.label);
    expect(labels).toContain('axis centre of pin');
    expect(labels.filter((l) => l === 'end centre of pin').length).toBe(2);
  });

  it('walks nothing on a body that is nowhere near', () => {
    const root = scene(body('far', new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01)), [5, 0, 0]));
    expect(sceneCandidates(root, [0, 0, 0], 0.05).length).toBe(0);
  });
});

describe('snapping a coordinate that is a little off', () => {
  it('lands on the axis of a cylinder', () => {
    // A pin at x = 30 mm; the caller guessed 31.
    const root = scene(body('pin', new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.02, 24)), [0.03, 0, 0]));
    const snap = snapInScene(root, [0.031, 0, 0], 0.005);
    expect(snap.kind).toBe('centre');
    expect(snap.point[0]).toBeCloseTo(0.03, 9);
    expect(snap.movedBy).toBeCloseTo(0.001, 9);
  });

  it('says so when nothing was near enough to have been meant', () => {
    const root = scene(body('pin', new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.02, 24))));
    const snap = snapInScene(root, [0.5, 0, 0], 0.003);
    expect(snap.movedBy).toBe(0);
    expect(snap.label).toMatch(/nothing was near/);
  });
});

describe('measuring', () => {
  it('gives the distance in millimetres, and what each end landed on', () => {
    const root = scene(
      body('a', new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.01, 16)), [0, 0, 0]),
      body('b', new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.01, 16)), [0.05, 0, 0]),
    );
    // Both guesses are half a millimetre out; both snap to the real axes, and
    // the answer is the 50 mm the two bodies are actually apart.
    const reading = measureInScene(root, [0.0005, 0, 0], [0.0495, 0, 0], { withinMm: 3 });
    expect(reading.distanceMm).toBeCloseTo(50, 6);
    expect(reading.from.snappedTo).toContain('a');
    expect(reading.to.snappedTo).toContain('b');
    expect(reading.from.movedByMm).toBeCloseTo(0.5, 6);
  });

  it('reports the per-axis parts in the MuJoCo frame', () => {
    const reading = measureInScene(null, [0, 0, 0], [0.003, 0.004, 0.005], { snap: false });
    expect(reading.deltaMm).toEqual([3, 4, 5]);
  });

  it('measures an angle when given a corner', () => {
    const reading = measureInScene(null, [0.01, 0, 0], [0, 0.01, 0], { corner: [0, 0, 0], snap: false });
    expect(reading.angleDegrees).toBeCloseTo(90, 6);
    expect(reading.said).toMatch(/90\.00°/);
  });

  it('takes the points as given when snapping is off', () => {
    const root = scene(body('pin', new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.02, 24))));
    const reading = measureInScene(root, [0.001, 0, 0], [0.011, 0, 0], { snap: false });
    expect(reading.distanceMm).toBeCloseTo(10, 6);
    expect(reading.from.movedByMm).toBe(0);
  });

  it('works with no scene at all, so a caller can just do arithmetic', () => {
    const reading = measureInScene(null, [0, 0, 0], [0.02, 0, 0]);
    expect(reading.distanceMm).toBeCloseTo(20, 6);
  });
});

describe('static boxes drawn as one instanced mesh', () => {
  /** The way SceneLayer draws scenery: unit cubes, transforms in the instances. */
  function track(count: number, spacing: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), count);
    const matrix = new THREE.Matrix4();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      matrix.makeTranslation(i * spacing, 0, 0);
      matrix.multiply(new THREE.Matrix4().makeScale(0.02, 0.02, 0.02));
      mesh.setMatrixAt(i, matrix);
      ids.push(`plank_${i}`);
    }
    mesh.userData = { nodeIds: ids };
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  it('offers a corner of an instance, and says which body it belongs to', () => {
    const mesh = track(3, 0.1);
    const root = new THREE.Scene();
    root.add(mesh);
    root.updateMatrixWorld(true);
    // The middle plank's centre is at x = 0.1; its corners are 10 mm out on each
    // axis, so this looks for the one at +x +y +z.
    const found = sceneCandidates(root, [0.11, 0.01, 0.01], 0.005);
    expect(found.some((c) => c.label === 'corner of plank_1')).toBe(true);
  });

  it('leaves out instances that are nowhere near', () => {
    const mesh = track(3, 2);
    const root = new THREE.Scene();
    root.add(mesh);
    root.updateMatrixWorld(true);
    const labels = new Set(sceneCandidates(root, [0, 0, 0], 0.05).map((c) => c.label));
    expect(labels.has('corner of plank_0')).toBe(true);
    expect(labels.has('corner of plank_2')).toBe(false);
  });

  it('measures corner to corner across two planks', () => {
    const mesh = track(2, 0.1);
    const root = new THREE.Scene();
    root.add(mesh);
    root.updateMatrixWorld(true);
    // Both guesses are a millimetre off the corner they meant.
    const reading = measureInScene(root, [0.011, 0.011, 0.009], [0.089, 0.011, 0.009], { withinMm: 4 });
    expect(reading.from.snappedTo).toBe('corner of plank_0');
    expect(reading.to.snappedTo).toBe('corner of plank_1');
    // Corner at x = 0.01 to corner at x = 0.09: 80 mm.
    expect(reading.distanceMm).toBeCloseTo(80, 6);
  });
});
