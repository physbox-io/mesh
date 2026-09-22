import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { bodyFeatures, neighbourFeatures, transformFeatures, documentAxes, graphAxes } from '../src/utils/mateFeatures';
import type { SceneNode } from '../src/types/scene';
import type { AxisFeature, FaceFeature, MateFeature } from '../src/utils/mateSnap';

/** A body drawn the way the app draws one: a named group holding a mesh. */
function body(id: string, mesh: THREE.Mesh, at: [number, number, number] = [0, 0, 0]): THREE.Group {
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

const faces = (features: MateFeature[]) => features.filter((f): f is FaceFeature => f.kind === 'face');
const axes = (features: MateFeature[]) => features.filter((f): f is AxisFeature => f.kind === 'axis');

describe('the faces of a drawn part', () => {
  it('gives a box six of them, pointing outward', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.3));
    const group = body('block', mesh);
    scene(group);

    const found = faces(bodyFeatures([group], 'block'));
    expect(found).toHaveLength(6);
    // Every normal is a unit vector, and every pair opposes another.
    for (const f of found) {
      expect(Math.hypot(...f.normal)).toBeCloseTo(1, 9);
    }
    const sum = found.reduce((a, f) => [a[0] + f.normal[0], a[1] + f.normal[1], a[2] + f.normal[2]], [0, 0, 0]);
    for (const c of sum) expect(c).toBeCloseTo(0, 9);
  });

  it('puts the top face where MuJoCo puts up, not where the renderer does', () => {
    // The renderer is Y-up and MuJoCo is Z-up; a face read off the scene has to
    // come back in the frame the drag arithmetic is written in, or a part would
    // mate to the side of its neighbour instead of the top.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.2));
    const group = body('plate', mesh, [0, 0.5, 0]);
    scene(group);

    const found = faces(bodyFeatures([group], 'plate'));
    const up = found.find((f) => f.normal[2] > 0.99);
    expect(up).toBeDefined();
    // Three.js y = 0.5 is MuJoCo z = 0.5, and the top is half the height above.
    // Seven places, not twelve: a bounding box is measured from the geometry's
    // own float32 positions, so the last couple of digits are the renderer's.
    expect(up!.point[2]).toBeCloseTo(0.55, 7);
    expect(up!.point[0]).toBeCloseTo(0, 7);
    expect(up!.point[1]).toBeCloseTo(0, 7);
  });

  it('measures how far a face reaches across itself', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.4));
    const group = body('panel', mesh);
    scene(group);
    const up = faces(bodyFeatures([group], 'panel')).find((f) => f.normal[2] > 0.99);
    // Half the LARGER of the two dimensions lying in that face: 0.4 / 2.
    expect(up!.extent).toBeCloseTo(0.2, 7);
  });
});

describe('the axis of a drawn cylinder', () => {
  it('comes back as a line with a radius, in the MuJoCo frame', () => {
    // A cylinder is built along its own +Y, which is MuJoCo's +Z when nothing
    // has turned it — the upright peg case.
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 24));
    const group = body('peg', mesh);
    scene(group);

    const found = axes(bodyFeatures([group], 'peg'));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].radius).toBeCloseTo(0.005, 9);
    expect(Math.abs(found[0].dir[2])).toBeCloseTo(1, 9);
  });

  it('follows the cylinder when it is laid on its side', () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 24));
    // Tipped so its axis lies along the renderer's +Z, which is MuJoCo's −Y.
    mesh.rotation.x = Math.PI / 2;
    const group = body('pin', mesh);
    scene(group);

    const found = axes(bodyFeatures([group], 'pin'));
    expect(found.length).toBeGreaterThan(0);
    expect(Math.abs(found[0].dir[1])).toBeCloseTo(1, 6);
    expect(Math.abs(found[0].dir[2])).toBeCloseTo(0, 6);
  });
});

describe('what the rest of the scene offers', () => {
  it('leaves the body being dragged out of its own candidates', () => {
    const dragged = body('moving', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
    const other = body('still', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)), [0.12, 0, 0]);
    const root = scene(dragged, other);

    const found = neighbourFeatures(root, 'moving', [0, 0, 0], 0.5);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.nodeId).not.toBe('moving');
  });

  it('ignores a ghost, which is an unnamed copy of the part being dragged', () => {
    const dragged = body('moving', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
    const ghost = dragged.clone(true);
    ghost.name = ''; // exactly what the gizmo does before adding it
    const root = scene(dragged, ghost);

    expect(neighbourFeatures(root, 'moving', [0, 0, 0], 0.5)).toHaveLength(0);
  });

  it('walks nothing that is out of reach', () => {
    const dragged = body('moving', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
    const faraway = body('distant', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)), [40, 0, 0]);
    const root = scene(dragged, faraway);

    expect(neighbourFeatures(root, 'moving', [0, 0, 0], 0.05)).toHaveLength(0);
  });
});

describe('carrying features through a drag', () => {
  const pivot = new THREE.Vector3(0, 0, 0);

  it('moves a point by the drag and leaves directions alone', () => {
    const start: MateFeature[] = [
      { kind: 'face', point: [0, 0, 0], normal: [0, 0, 1], extent: 0.05, label: 'top' },
    ];
    const moved = faces(transformFeatures(
      start, new THREE.Quaternion(), pivot, new THREE.Vector3(0.01, 0, 0.02),
    ));
    expect(moved[0].point).toEqual([0.01, 0, 0.02]);
    expect(moved[0].normal[2]).toBeCloseTo(1, 12);
  });

  it('turns a normal with the part, about the pivot the gizmo uses', () => {
    const start: MateFeature[] = [
      { kind: 'face', point: [0.1, 0, 0], normal: [1, 0, 0], extent: 0.05, label: 'side' },
    ];
    const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const moved = faces(transformFeatures(start, quarter, pivot, new THREE.Vector3()));
    // The face swings a quarter turn round the origin, normal and all.
    expect(moved[0].point[0]).toBeCloseTo(0, 9);
    expect(moved[0].point[1]).toBeCloseTo(0.1, 9);
    expect(moved[0].normal[0]).toBeCloseTo(0, 9);
    expect(moved[0].normal[1]).toBeCloseTo(1, 9);
  });
});

describe('the holes a document remembers', () => {
  const pose = (at: [number, number, number] = [0, 0, 0]) => ({
    pos: new THREE.Vector3(...at),
    rot: new THREE.Matrix3(),
  });

  /** The cube-with-a-bore from the viewport: a box with a cylinder cut out. */
  const boredCube = (): SceneNode => ({
    id: 'cube2',
    name: 'cube2',
    pos: [0, 0, 0.34],
    geoms: [
      { name: 'cube2_geom', type: 'box', size: [0.08, 0.08, 0.08] },
      {
        name: 'cube2_cut1', type: 'cylinder', csg: 'difference',
        pos: [0.073585, 0, 0.000719], size: [0.024, 0.0855],
        euler: [0, 90, 0],
      },
      // What the boolean produced, and what the renderer actually draws.
      { name: 'cube2_csg', type: 'mesh', size: [1], csgDerived: 'visual', vertices: [], faces: [] },
    ],
    joints: [],
    children: [],
  } as unknown as SceneNode);

  it('finds a bore that the boolean has already swallowed', () => {
    // This is the case the drawn scene cannot answer: after the cut, the hole
    // is a ring of vertices in a mesh and nothing else.
    const found = documentAxes(boredCube(), pose());
    expect(found).toHaveLength(1);
    expect(found[0].radius).toBeCloseTo(0.024, 9);
    expect(found[0].label).toContain('hole');
  });

  it('reads the bore running along the axis it was cut on', () => {
    // Turned 90° about Y, so the cylinder's own +Z lies along world X.
    const found = documentAxes(boredCube(), pose());
    expect(Math.abs(found[0].dir[0])).toBeCloseTo(1, 6);
    expect(Math.abs(found[0].dir[2])).toBeCloseTo(0, 6);
  });

  it('ignores the meshes the boolean generated', () => {
    // Only the authored shapes are features; the visual mesh and the colliders
    // are the same hole counted again.
    expect(documentAxes(boredCube(), pose())).toHaveLength(1);
  });

  it('moves the hole with the body it is in', () => {
    const found = documentAxes(boredCube(), pose([0, 0, 0.34]));
    expect(found[0].point[2]).toBeCloseTo(0.34 + 0.000719, 9);
  });

  it('corrects for a compiled solid being re-origined on its centre of mass', () => {
    // The drawn body is shifted from the frame its cuts were authored in, and a
    // hole read without that correction sits beside the one on screen.
    const node = boredCube();
    (node as unknown as { csgCentroid: number[] }).csgCentroid = [-0.003292, 0, 0];
    const found = documentAxes(node, pose());
    expect(found[0].point[0]).toBeCloseTo(0.073585 + 0.003292, 9);
  });

  it('reads the quaternion a real cut is authored with', () => {
    /*
     * `cutGeometry` writes a MUJOCO quaternion — scalar first, [w,x,y,z] —
     * turning the cutter's own +Z onto the cut normal. Getting that order wrong
     * reads as a hole pointing somewhere plausible but wrong, so the exact form
     * a cut actually stores is pinned here rather than an Euler stand-in.
     */
    const node = boredCube();
    delete (node.geoms[1] as { euler?: number[] }).euler;
    const r = Math.SQRT1_2;
    node.geoms[1].quat = [r, 0, r, 0]; // +Z onto +X
    const found = documentAxes(node, pose());
    expect(found[0].dir[0]).toBeCloseTo(1, 9);
    expect(found[0].dir[1]).toBeCloseTo(0, 9);
    expect(found[0].dir[2]).toBeCloseTo(0, 9);
  });

  it('calls an added cylinder a boss rather than a hole', () => {
    const node = boredCube();
    node.geoms[1].csg = undefined;
    expect(documentAxes(node, pose())[0].label).toContain('boss');
  });

  it('leaves out the body being dragged, and anything out of reach', () => {
    const near = boredCube();
    const far = { ...boredCube(), id: 'faraway', name: 'faraway' };
    const poses = (id: string) => (id === 'faraway' ? pose([5, 0, 0]) : pose());
    const found = graphAxes([near, far] as SceneNode[], poses, {
      exclude: 'nothing', near: [0.07, 0, 0], radius: 0.1,
    });
    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('cube2');

    expect(graphAxes([near] as SceneNode[], poses, {
      exclude: 'cube2', near: [0.07, 0, 0], radius: 0.1,
    })).toHaveLength(0);
  });
});
