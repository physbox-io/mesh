/**
 * Compliant flexure leaves, drawn bending.
 *
 * A flexure is a joint with a calibrated spring (utils/flexure.ts); its leaves
 * are visual geoms the physics never sees. Drawn as part of the body they would
 * ride along rigidly, ends floating free of the frame. Instead each leaf carries
 * `bend`, and is drawn here every frame from the body's pose and its joint's
 * position: the end held by the frame stays put, the end on the body follows it,
 * and the leaf flexes between (bendLeafPoint).
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneGeom, SceneGraph, SceneJoint, SceneNode } from '../../types/scene';
import type { DataMirror, FrameFlagWindow, ModelMirror, MujocoShim } from '../../types/sceneLayer';
import { bendLeafPoint } from '../../utils/flexure';

interface FlexureLeavesProps {
  model: ModelMirror | null;
  data: DataMirror | null;
  mujoco: MujocoShim | null;
  sceneGraph: SceneGraph | null;
}

interface Leaf {
  key: string;
  nodeId: string;
  joint: SceneJoint;
  geom: SceneGeom & { bend: NonNullable<SceneGeom['bend']> };
  /** Vertex positions in the body frame at rest; read-only. */
  rest: Float32Array;
  /** Triangle indices of the subdivided box. */
  index: number[];
  color: THREE.Color;
  opacity: number;
}

/** Segments along a leaf's length: enough for the S of a bent beam to read smooth. */
const SEGMENTS = 16;

/** Every bendable leaf in the scene, with its rest shape in its body's frame. */
function collectLeaves(sceneGraph: SceneGraph | null, hidden: Set<string>): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (nodes: SceneNode[], ancestorHidden: boolean) => {
    for (const node of nodes || []) {
      const isHidden = ancestorHidden || hidden.has(node.id);
      const joint = (node.joints || []).find((j) => j.type === 'hinge' || j.type === 'slide');
      if (!isHidden && joint) {
        for (const g of node.geoms || []) {
          if (!g.bend || g.type !== 'box') continue;
          const [hx, hy, hz] = g.size;
          const box = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2, SEGMENTS, 1, 1);
          const q = g.quat ? new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]) : new THREE.Quaternion();
          box.applyMatrix4(new THREE.Matrix4().compose(
            new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0), q, new THREE.Vector3(1, 1, 1),
          ));
          const rgba = g.rgba ?? [0.8, 0.8, 0.8, 1];
          leaves.push({
            key: `${node.id}/${g.name}`,
            nodeId: node.id,
            joint,
            geom: g as Leaf['geom'],
            rest: Float32Array.from(box.attributes.position.array as ArrayLike<number>),
            index: Array.from(box.index!.array as ArrayLike<number>),
            color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
            opacity: rgba[3] ?? 1,
          });
          box.dispose();
        }
      }
      walk(node.children, isHidden);
    }
  };
  walk(sceneGraph?.nodes ?? [], false);
  return leaves;
}

export const FlexureLeaves = ({ model, data, mujoco, sceneGraph }: FlexureLeavesProps) => {
  const hiddenNodeIds = useStore((state) => state.hiddenNodeIds);
  const leaves = useMemo(() => collectLeaves(sceneGraph, new Set(hiddenNodeIds)), [sceneGraph, hiddenNodeIds]);
  // Each mesh owns its geometry (R3F disposes it on unmount); the frame loop
  // writes the bent shape into it, reaching it through these refs.
  const meshes = useRef<Record<string, THREE.Mesh | null>>({});

  // Body and joint-position addresses of each leaf in the compiled model.
  const addresses = useMemo(() => {
    const out = new Map<string, { body: number; qadr: number }>();
    if (!model || !mujoco) return out;
    for (const l of leaves) {
      const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, l.nodeId);
      const jnt = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, l.joint.name);
      const qadr = jnt >= 0 && model.jnt_qposadr ? model.jnt_qposadr[jnt] : -1;
      if (body >= 0) out.set(l.key, { body, qadr });
    }
    return out;
  }, [leaves, model, mujoco]);

  const point = useRef<[number, number, number]>([0, 0, 0]);
  const bent = useRef<[number, number, number]>([0, 0, 0]);
  useFrame(() => {
    const st = useStore.getState();
    if (model !== st.model || data !== st.data) return;
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    if (!model || !data) return;
    for (const l of leaves) {
      const a = addresses.get(l.key);
      const mesh = meshes.current[l.key];
      if (!a || !mesh) continue;
      const geometry = mesh.geometry;
      if (!geometry.getAttribute('position') || geometry.getAttribute('position').array.length !== l.rest.length) {
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(l.rest.length), 3));
        geometry.setIndex(l.index);
      }
      const q = a.qadr >= 0 ? data.qpos[a.qadr] : 0;
      const o = a.body * 3, m = data.xmat, r = a.body * 9;
      const px = data.xpos[o], py = data.xpos[o + 1], pz = data.xpos[o + 2];
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const p = point.current, b = bent.current;
      for (let i = 0; i < arr.length; i += 3) {
        p[0] = l.rest[i]; p[1] = l.rest[i + 1]; p[2] = l.rest[i + 2];
        bendLeafPoint(p, l.geom.bend, l.joint, q, b);
        // Body frame to world: xmat is row-major.
        arr[i] = px + m[r] * b[0] + m[r + 1] * b[1] + m[r + 2] * b[2];
        arr[i + 1] = py + m[r + 3] * b[0] + m[r + 4] * b[1] + m[r + 5] * b[2];
        arr[i + 2] = pz + m[r + 6] * b[0] + m[r + 7] * b[1] + m[r + 8] * b[2];
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
    }
  });

  if (!leaves.length) return null;
  return (
    <>
      {leaves.map((l) => (
        <mesh key={l.key} ref={(el: THREE.Mesh | null) => { meshes.current[l.key] = el; }} castShadow receiveShadow frustumCulled={false} matrixAutoUpdate={false}>
          <bufferGeometry />
          <meshStandardMaterial color={l.color} roughness={0.55} transparent={l.opacity < 1} opacity={l.opacity} />
        </mesh>
      ))}
    </>
  );
};
