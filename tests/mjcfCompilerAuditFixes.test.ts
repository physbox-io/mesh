import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { prepareScene } from '../src/utils/mjcfPrepare';
import { collectMeshAssets } from '../src/utils/mjcfMeshAssets';
import { constraintsXml } from '../src/utils/mjcfConstraints';
import { withUniqueNames } from '../src/utils/uniqueNames';
import { buildBreakModel } from '../src/utils/breakModel';
import { withoutDanglingReferences } from '../src/utils/danglingReferences';
import { mergeConstraintReports, type ConstraintReport } from '../src/utils/constraintResiduals';
import { applyBodyMass } from '../src/utils/bodyMass';
import { flatMesh } from '../src/utils/mjcfFlatMesh';
import { quatRotateVec, type QuatWXYZ } from '../src/utils/sceneTree';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => {
  mj = await load_mujoco();
}, 60_000);

const compileAndLoad = (scene: SceneGraph) => {
  const xml = compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0);
  const model = mj.MjModel.from_xml_string(xml);
  model.delete();
  return xml;
};

// A simple unit tetrahedron in Y-up coordinates.
const TET_VERTS = [
  0, 0, 0,
  0.1, 0, 0,
  0, 0.1, 0,
  0, 0, 0.1,
];
const TET_FACES = [
  0, 2, 1,
  0, 1, 3,
  1, 2, 3,
  2, 0, 3,
];

describe('#3A MJCF compiler, contact classes & constraints audit fixes', () => {
  it('#1: body with >=2 clutched velocity motors gets distinct driver body/geom names and loads in MuJoCo', () => {
    const scene = {
      nodes: [{
        id: 'gimbal',
        name: 'gimbal',
        type: 'body',
        pos: [0, 0, 0.5],
        joints: [
          { name: 'pan', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 5, forceLimit: 1 } },
          { name: 'tilt', type: 'hinge', axis: [0, 1, 0], actuator: { type: 'velocity', kv: 5, forceLimit: 1 } },
        ],
        geoms: [{ name: 'gimbal_box', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.2 }],
        children: [],
      }],
    } as unknown as SceneGraph;

    const xml = compileAndLoad(scene);
    expect(xml).toContain('name="pan__drive_b"');
    expect(xml).toContain('name="pan__drive_g"');
    expect(xml).toContain('name="tilt__drive_b"');
    expect(xml).toContain('name="tilt__drive_g"');
  });

  it('#2: rotated dynamic dense-import and decomposed meshes do not double-rotate', () => {
    const denseNode = {
      id: 'dense_part',
      name: 'dense_part',
      type: 'body',
      pos: [0, 0, 0.5],
      euler: [0, 90, 0],
      joints: [{ name: 'dense_free', type: 'free' }],
      geoms: [{
        name: 'dense_mesh',
        type: 'mesh',
        size: [1],
        dynamic: true,
        denseColliderOf: 'dense_mesh',
        vertices: TET_VERTS,
        faces: TET_FACES,
        baseVertices: TET_VERTS,
        colliderVertices: TET_VERTS,
        colliderFaces: TET_FACES,
      }],
      children: [],
    } as unknown as SceneNode;

    const decomposedNode = {
      id: 'decomp_part',
      name: 'decomp_part',
      type: 'body',
      pos: [0.5, 0, 0.5],
      euler: [30, 45, 60],
      joints: [{ name: 'decomp_free', type: 'free' }],
      geoms: [
        {
          name: 'decomp_mesh',
          type: 'mesh',
          size: [1],
          vertices: TET_VERTS,
          faces: TET_FACES,
          baseVertices: TET_VERTS,
        },
        {
          name: 'decomp_piece_0',
          type: 'mesh',
          size: [1],
          csgDerived: 'collider',
          colliderOf: 'decomp_mesh',
          vertices: TET_VERTS,
          faces: TET_FACES,
          mass: 0.1,
        },
      ],
      children: [],
    } as unknown as SceneNode;

    const scene = { nodes: [denseNode, decomposedNode] } as unknown as SceneGraph;
    const xml = compileAndLoad(scene);
    // Neither body should emit euler="..." because their rotations were baked into vertices.
    expect(xml).toMatch(/<body name="dense_part" pos="0 0 0\.5">/);
    expect(xml).toMatch(/<body name="decomp_part" pos="0\.5 0 0\.5">/);
    // Original scene objects must not be mutated.
    expect(denseNode.euler).toEqual([0, 90, 0]);
    expect(decomposedNode.euler).toEqual([30, 45, 60]);
  });

  it('#3: cloth, isPulleyRope, and isComposite geoms are skipped in mesh assets and cloth/pulleyRope are skipped in constraints', () => {
    const childBody = {
      id: 'child_mesh_body',
      name: 'child_mesh_body',
      type: 'body',
      pos: [0, 0, 0.2],
      joints: [{ name: 'child_hinge', type: 'hinge', axis: [0, 1, 0], crumpleTorqueNm: 5 }],
      geoms: [{ name: 'child_tet', type: 'mesh', size: [1], vertices: TET_VERTS, faces: TET_FACES }],
      children: [],
    } as unknown as SceneNode;

    const clothNode = {
      id: 'cloth_1',
      name: 'cloth_1',
      type: 'body',
      pos: [0, 0, 0.5],
      cloth: { width: 1, height: 1 },
      weldTargetId: 'parent_body',
      joints: [{ name: 'cloth_joint', type: 'hinge', axis: [0, 1, 0], actuator: { type: 'motor' } }],
      geoms: [{ name: 'cloth_mesh', type: 'mesh', size: [1], vertices: TET_VERTS, faces: TET_FACES }],
      children: [childBody],
    } as unknown as SceneNode;

    const pulleyNode = {
      id: 'rope_1',
      name: 'rope_1',
      type: 'body',
      pos: [0, 0, 0.5],
      isPulleyRope: true,
      geoms: [{ name: 'rope_mesh', type: 'mesh', size: [1], vertices: TET_VERTS, faces: TET_FACES }],
      children: [],
    } as unknown as SceneNode;

    const compositeNode = {
      id: 'cable_1',
      name: 'cable_1',
      type: 'body',
      pos: [0.5, 0, 0.5],
      isComposite: true,
      compositeType: 'cable',
      compositeCount: '6 1 1',
      geoms: [{ name: 'cable_mesh', type: 'mesh', size: [0.02], vertices: TET_VERTS, faces: TET_FACES }],
      children: [],
    } as unknown as SceneNode;

    const parentBody = {
      id: 'parent_body',
      name: 'parent_body',
      type: 'body',
      pos: [0, 0, 0.1],
      geoms: [{ name: 'parent_box', type: 'box', size: [0.1, 0.1, 0.1] }],
      children: [clothNode, pulleyNode],
    } as unknown as SceneNode;

    const assets = collectMeshAssets([parentBody, compositeNode]);
    expect(assets.map((g) => g.name)).toEqual(['child_tet']);

    const xml = compileAndLoad({ nodes: [parentBody, compositeNode] } as unknown as SceneGraph);
    expect(xml).not.toContain('cloth_joint_actuator');
    expect(xml).not.toContain('body1="cloth_1"');
    // Child body's crumple lock attaches to enclosing parent_body, not cloth_1.
    expect(xml).toContain('name="crumple_lock_child_hinge" body1="child_mesh_body" body2="parent_body"');
  });

  it('#4: unnamed joints with actuators/crumpleLocks/couplings get unique names, and breakModel handles unnamed free joints', () => {
    const scene = {
      nodes: [
        {
          id: 'motor_arm',
          name: 'motor_arm',
          type: 'body',
          pos: [0, 0, 0.3],
          coupleTargetId: 'driven_arm',
          joints: [{ type: 'hinge', axis: [0, 1, 0], actuator: { type: 'motor' }, crumpleTorqueNm: 10 }],
          geoms: [{ name: 'm_box', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.2 }],
          children: [],
        },
        {
          id: 'driven_arm',
          name: 'driven_arm',
          type: 'body',
          pos: [0.2, 0, 0.3],
          joints: [{ type: 'hinge', axis: [0, 1, 0] }],
          geoms: [{ name: 'd_box', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.2 }],
          children: [],
        },
      ],
    } as unknown as SceneGraph;

    const uniqued = withUniqueNames(scene);
    expect(uniqued.nodes[0].joints![0].name).toBe('motor_arm_hinge');
    expect(uniqued.nodes[1].joints![0].name).toBe('driven_arm_hinge');

    const xml = compileAndLoad(scene);
    expect(xml).not.toContain('undefined');

    // Unnamed free joints on brittle breakable member + two putty blobs
    const breakNodes = [
      {
        id: 'rod_1',
        name: 'rod_1',
        type: 'body',
        pos: [0, 0, 0.2],
        material: 'spaghetti',
        joints: [{ type: 'free' }],
        geoms: [{ name: 'rod_1_g', type: 'capsule', fromto: [-0.05, 0, 0, 0.05, 0, 0], size: [0.002], mass: 0.01 }],
        children: [],
      },
      {
        id: 'blob_1',
        name: 'blob_1',
        type: 'body',
        pos: [-0.05, 0, 0.2],
        joinMaterial: 'putty',
        joints: [{ type: 'free' }],
        geoms: [{ name: 'blob_1_g', type: 'sphere', size: [0.015], mass: 0.01 }],
        children: [],
      },
      {
        id: 'blob_2',
        name: 'blob_2',
        type: 'body',
        pos: [0.05, 0, 0.2],
        joinMaterial: 'putty',
        joints: [{ type: 'free' }],
        geoms: [{ name: 'blob_2_g', type: 'sphere', size: [0.015], mass: 0.01 }],
        children: [],
      },
    ] as unknown as SceneNode[];

    const prepared = prepareScene({ nodes: breakNodes } as unknown as SceneGraph);
    const allJointNames = prepared.nodes.flatMap((n) => (n.joints || []).map((j) => j.name)).filter(Boolean);
    expect(allJointNames.some((n) => n.includes('undefined'))).toBe(false);
    expect(new Set(allJointNames).size).toBe(allJointNames.length);
    compileAndLoad({ nodes: breakNodes } as unknown as SceneGraph);
  });

  it('#5: self-referencing weldTargetId and connectTargetId are cleared and skipped without crashing MuJoCo', () => {
    const selfWeldNode = {
      id: 'self_a',
      name: 'self_a',
      type: 'body',
      pos: [0, 0, 0.2],
      weldTargetId: 'self_a',
      weldRigid: true,
      joints: [{ name: 'self_a_free', type: 'free' }],
      geoms: [{ name: 'self_a_g', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.1 }],
      children: [],
    } as unknown as SceneNode;

    const selfConnectNode = {
      id: 'self_b',
      name: 'self_b_name',
      type: 'body',
      pos: [0.2, 0, 0.2],
      connectTargetId: 'self_b_name',
      connectAnchor: [0.2, 0, 0.2],
      joints: [{ name: 'self_b_free', type: 'free' }],
      geoms: [{ name: 'self_b_g', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.1 }],
      children: [],
    } as unknown as SceneNode;

    // danglingReferences clears both self-targets
    const cleaned = withoutDanglingReferences({ nodes: [selfWeldNode, selfConnectNode] } as unknown as SceneGraph);
    expect(cleaned.nodes[0].weldTargetId).toBeUndefined();
    expect(cleaned.nodes[0].weldRigid).toBeUndefined();
    expect(cleaned.nodes[1].connectTargetId).toBeUndefined();
    expect(cleaned.nodes[1].connectAnchor).toBeUndefined();

    // Direct constraintsXml call also skips self-targets even without danglingReferences
    const cXml = constraintsXml([selfWeldNode, selfConnectNode], buildBreakModel([]));
    expect(cXml.equality).toBe('');

    // Full compile loads cleanly in MuJoCo
    compileAndLoad({ nodes: [selfWeldNode, selfConnectNode] } as unknown as SceneGraph);
  });

  it('#6: mesh geom with non-empty vertices and empty faces emits a speck, not a 2m box', () => {
    const scene = {
      nodes: [{
        id: 'empty_faces',
        name: 'empty_faces',
        type: 'body',
        pos: [0, 0, 0.5],
        joints: [{ name: 'ef_free', type: 'free' }],
        geoms: [{
          name: 'ef_mesh',
          type: 'mesh',
          size: [1],
          vertices: TET_VERTS,
          faces: [],
          mass: 0.1,
        }],
        children: [],
      }],
    } as unknown as SceneGraph;

    const xml = compileAndLoad(scene);
    expect(xml).toContain('name="ef_mesh" type="sphere" size="0.001" rgba="0 0 0 0" contype="0" conaffinity="0"');
    expect(xml).not.toContain('name="ef_mesh" type="box"');
  });

  it('#7: composite count="1 1 1" clamps to "2 1 1" and attributes are XML-escaped', () => {
    const scene = {
      nodes: [{
        id: 'tiny_cable',
        name: 'tiny_cable',
        type: 'body',
        pos: [0, 0, 0.5],
        isComposite: true,
        compositeType: 'cable',
        compositeCount: '1 1 1',
        compositeSize: '1.2',
        compositeCurve: 's 0 0',
        geoms: [{ name: 'c_g', type: 'capsule', size: [0.01] }],
        children: [],
      }],
    } as unknown as SceneGraph;

    const xml = compileAndLoad(scene);
    expect(xml).toContain('count="2 1 1"');

    // Escaping check with special XML characters
    const injectedXml = compileToMJCF({
      nodes: [{
        id: 'esc_cable',
        name: 'esc_cable',
        type: 'body',
        pos: [0, 0, 0.5],
        isComposite: true,
        compositeType: 'cable',
        compositeCount: '5 1 1',
        compositeSize: '1"bad',
        compositeCurve: 's&0<0>',
        geoms: [{ name: 'e_g', type: 'capsule', size: [0.01] }],
        children: [],
      }],
    } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(injectedXml).toContain('size="1&quot;bad"');
    expect(injectedXml).toContain('curve="s&amp;0&lt;0&gt;"');
  });

  it('#8: nameless nodes use consistent node.name || node.id || "body" fallback in mjcfConstraints and mjcfBody', () => {
    const scene = {
      nodes: [
        {
          id: 'nameless_a',
          name: '',
          type: 'body',
          pos: [0, 0, 0.2],
          joints: [{ name: 'ja', type: 'hinge', axis: [0, 1, 0] }],
          geoms: [{ name: 'ga', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.1 }],
          children: [],
        },
        {
          id: 'nameless_b',
          name: '',
          type: 'body',
          pos: [0.1, 0, 0.2],
          weldTargetId: 'nameless_a',
          joints: [{ name: 'jb', type: 'free' }],
          geoms: [{ name: 'gb', type: 'box', size: [0.05, 0.05, 0.05], mass: 0.1 }],
          children: [],
        },
      ],
    } as unknown as SceneGraph;

    const xml = compileAndLoad(scene);
    expect(xml).toContain('<body name="nameless_a"');
    expect(xml).toContain('<body name="nameless_b"');
    expect(xml).toContain('body1="nameless_b" body2="nameless_a"');
  });

  it('#9: mergeConstraintReports preserves independent worstMm and worstDeg peaks across rebuild segments', () => {
    const seg1: ConstraintReport = {
      constraints: [{
        name: 'weld_1',
        kind: 'weld',
        bodies: ['a', 'b'],
        worstMm: 5.0,
        finalMm: 0.5,
        worstDeg: 0.2,
        finalDeg: 0.1,
        worstAtS: 0.12,
        peakForce: 10,
        finalForce: 2,
        forceUnit: 'N',
      }],
      limits: [],
      warnings: [],
    };
    const seg2: ConstraintReport = {
      constraints: [{
        name: 'weld_1',
        kind: 'weld',
        bodies: ['a', 'b'],
        worstMm: 1.0,
        finalMm: 0.2,
        worstDeg: 4.0,
        finalDeg: 0.3,
        worstAtS: 0.45,
        peakForce: 15,
        finalForce: 1,
        forceUnit: 'N',
      }],
      limits: [],
      warnings: [],
    };

    const merged = mergeConstraintReports([seg1, seg2]);
    expect(merged.constraints).toHaveLength(1);
    expect(merged.constraints[0].worstMm).toBe(5.0);
    expect(merged.constraints[0].worstDeg).toBe(4.0);
    // worstAtS comes from the more severe segment (seg1: 5.0 > 4.0).
    expect(merged.constraints[0].worstAtS).toBe(0.12);
    expect(merged.constraints[0].peakForce).toBe(15);
    expect(merged.constraints[0].finalMm).toBe(0.2);
    expect(merged.constraints[0].finalDeg).toBe(0.3);
  });

  it('#10: formatGeomSize preserves plane size 0 (infinite)', () => {
    const scene = {
      nodes: [{
        id: 'wall_plane',
        name: 'wall_plane',
        type: 'body',
        pos: [0, 0, 0.1],
        geoms: [{ name: 'inf_plane', type: 'plane', size: [0, 0, 0.1] }],
        children: [],
      }],
    } as unknown as SceneGraph;

    const xml = compileAndLoad(scene);
    expect(xml).toContain('name="inf_plane" type="plane" size="0 0 0.1"');
  });

  it('#11: applyBodyMass excludes contactClass geoms from mass distribution', () => {
    const node = {
      id: 'split_part',
      name: 'split_part',
      type: 'body',
      pos: [0, 0, 0],
      mass: 2.0,
      geoms: [
        { name: 'main_box', type: 'box', size: [0.1, 0.1, 0.1] },
        { name: 'pin_collider', type: 'cylinder', size: [0.005, 0.01], contactClass: 'pin', contactGroup: 1 },
        { name: 'socket_collider', type: 'box', size: [0.01, 0.01, 0.01], contactClass: 'socket', contactGroup: 1 },
      ],
      children: [],
    } as unknown as SceneNode;

    const result = applyBodyMass(node);
    expect(result[0].mass).toBeCloseTo(2.0, 6);
    expect(result[1].mass).toBeUndefined();
    expect(result[2].mass).toBeUndefined();
  });

  it('#12: flatMesh orthonormalizes u for near-cardinal normals', () => {
    // Tilt a flat quad ~0.5 deg around X so its normal is near-cardinal (|n_z| ≈ 0.99996 > 0.9999)
    const theta = (0.5 * Math.PI) / 180;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Vertices in Y-up (x, y, z) -> Z-up (x, -z, y).
    // A quad in Z-up tilted around X by theta has Z-up points (x, y*c, y*s),
    // which in Y-up are (x, y*s, -y*c).
    const quadYUp = [
      -0.1, -0.1 * s, 0.1 * c,
       0.1, -0.1 * s, 0.1 * c,
       0.1,  0.1 * s, -0.1 * c,
      -0.1,  0.1 * s, -0.1 * c,
    ];
    const flat = flatMesh(quadYUp);
    expect(flat).not.toBeNull();
    expect(flat).not.toBe('speck');
    if (flat && flat !== 'speck') {
      const q = flat.quat as QuatWXYZ;
      const qLen = Math.hypot(q[0], q[1], q[2], q[3]);
      expect(qLen).toBeCloseTo(1, 10);
      // Local Z axis rotated by q must match the tilted normal [0, -s, c] (up to sign).
      const localZ = quatRotateVec(q, [0, 0, 1]);
      expect(Math.abs(localZ[0])).toBeCloseTo(0, 8);
      expect(Math.abs(localZ[1])).toBeCloseTo(s, 8);
      expect(Math.abs(localZ[2])).toBeCloseTo(c, 8);
    }
  });
});
