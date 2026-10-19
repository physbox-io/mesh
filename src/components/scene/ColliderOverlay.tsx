/**
 * What the contact solver actually collides, drawn over the model.
 *
 * A decomposed body collides as convex pieces the viewport never shows, and a
 * hidden proxy box is invisible by design. Either can be wrong — a piece
 * bridging a slot, a proxy left behind when a parameter changed — and the
 * only way to find out used to be reading penetration numbers. One picture
 * shows it: every piece outlined in its own colour, in its body's frame, so it
 * moves with the body.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { resolveCsgGeoms } from '../../utils/csg';
import { CsgGhostOutline } from './CsgGhosts';
import type { SceneGeom, SceneGraph, SceneNode } from '../../types/scene';
import type { DataMirror, FrameFlagWindow, ModelMirror, MujocoShim } from '../../types/sceneLayer';

const PALETTE = ['#f43f5e', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

/** What collides but is not drawn as itself: convex pieces, collision-only and invisible geoms. */
function collidersOf(node: SceneNode): SceneGeom[] {
  const drawn = new Set(resolveCsgGeoms(node, 'render').map((g) => g.name));
  return resolveCsgGeoms(node, 'physics').filter((g) => {
    const collides = g.contype !== 0 || g.conaffinity !== 0;
    if (!collides) return false;
    if (!drawn.has(g.name)) return true;
    return (g.rgba?.[3] ?? 1) === 0;
  }).map((g) => {
    // Collider meshes carry Y-up `vertices`; the outline reads Z-up ones.
    if (g.type === 'mesh' && !g.renderVertices && g.vertices) {
      const v = g.vertices;
      const renderVertices = new Array<number>(v.length);
      for (let i = 0; i + 2 < v.length; i += 3) {
        renderVertices[i] = v[i];
        renderVertices[i + 1] = -v[i + 2];
        renderVertices[i + 2] = v[i + 1];
      }
      return { ...g, renderVertices };
    }
    return g;
  });
}

const BodyColliders = ({ node, geoms, model, data, mujoco }: {
  node: SceneNode; geoms: SceneGeom[]; model: ModelMirror; data: DataMirror; mujoco: MujocoShim;
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const bodyId = useMemo(
    () => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name || node.id),
    [model, mujoco, node.name, node.id],
  );
  useFrame(() => {
    if (!groupRef.current || bodyId < 0) return;
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    if (data !== useStore.getState().data) return;
    try {
      const o = bodyId * 9;
      const m = data.xmat;
      const mat = new THREE.Matrix4().set(
        m[o], m[o + 1], m[o + 2], 0,
        m[o + 3], m[o + 4], m[o + 5], 0,
        m[o + 6], m[o + 7], m[o + 8], 0,
        0, 0, 0, 1,
      );
      groupRef.current.position.set(data.xpos[bodyId * 3], data.xpos[bodyId * 3 + 1], data.xpos[bodyId * 3 + 2]);
      groupRef.current.quaternion.setFromRotationMatrix(mat);
    } catch { /* body deleted mid-frame */ }
  });
  if (bodyId < 0) return null;
  return (
    <group ref={groupRef}>
      {geoms.map((g, i) => (
        <CsgGhostOutline
          key={g.name}
          geom={g}
          color={PALETTE[i % PALETTE.length]}
          bounds={null}
          csgCentroid={node.csgEnabled ? node.csgCentroid : undefined}
        />
      ))}
    </group>
  );
};

export const ColliderOverlay = ({ model, data, mujoco, sceneGraph }: {
  model: ModelMirror | null; data: DataMirror | null; mujoco: MujocoShim | null; sceneGraph: SceneGraph | null;
}) => {
  const bodies = useMemo(() => {
    const out: { node: SceneNode; geoms: SceneGeom[] }[] = [];
    const walk = (nodes: SceneNode[]) => {
      for (const node of nodes || []) {
        const geoms = collidersOf(node);
        if (geoms.length > 0) out.push({ node, geoms });
        walk(node.children);
      }
    };
    walk(sceneGraph?.nodes ?? []);
    return out;
  }, [sceneGraph]);
  if (!model || !data || !mujoco) return null;
  return (
    <>
      {bodies.map(({ node, geoms }) => (
        <BodyColliders key={node.id} node={node} geoms={geoms} model={model} data={data} mujoco={mujoco} />
      ))}
    </>
  );
};
