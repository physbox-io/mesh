/**
 * Pulley rope rendering.
 *
 * A rope is a coupling of the joints at its ends and its wheel rather than a
 * simulated cable, so it has no geometry of its own and is drawn from the
 * bodies it ties: from the face of each end toward the wheel, up to the
 * wheel's tangent point on that end's side, and over the rim, with any
 * further strands an end hangs from. utils/pulleyRope.ts lays it out.
 */
import { useRef, useMemo, useEffect, useCallback } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useOrbitEnable } from './useOrbitEnable';
import type { SceneGraph, SceneNode } from '../../types/scene';
import type { DataMirror, FrameFlagWindow, ModelMirror, MujocoShim } from '../../types/sceneLayer';
import { restPoses } from '../../utils/sceneCouplings';
import { ropeLayout, ropePolylines, type RopeLayout, type V3 } from '../../utils/pulleyRope';

interface PulleyRopesRendererProps {
  model: ModelMirror | null;
  data: DataMirror | null;
  mujoco: MujocoShim | null;
  /** Null only before a scene exists; every reader below tolerates it. */
  sceneGraph: SceneGraph | null;
}

interface PulleyRopeMarkersProps {
  sceneGraph: SceneGraph;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
}

/** A rope to draw: its layout, or just the two bodies it joins when it has none. */
interface DrawnRope { id: string; leftId: string; rightId: string; layout?: RopeLayout }

// Dynamic glowing pulley cable/rope renderer
export const PulleyRopesRenderer = ({ model, data, mujoco, sceneGraph }: PulleyRopesRendererProps) => {
  const lineRefs = useRef<{ [ropeId: string]: THREE.LineSegments | null }>({});
  const bodyIdCache = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!model || !mujoco) return;
    const c: Record<string, number> = {};
    for (let b = 0; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
      if (name) c[name] = b;
    }
    const mapNodeIds = (nodes?: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        const bId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, n.id);
        if (bId !== -1) c[n.id] = bId;
        else if (n.name && c[n.name] !== undefined) c[n.id] = c[n.name];
        mapNodeIds(n.children);
      }
    };
    mapNodeIds(sceneGraph?.nodes);
    bodyIdCache.current = c;
  }, [model, mujoco, sceneGraph]);

  // A rope switched off with the hierarchy's eye is not drawn, like any body.
  const hiddenNodeIds = useStore((state) => state.hiddenNodeIds);

  // Every rope with both ends, laid out at the rest pose.
  const pulleyRopes = useMemo(() => {
    const hidden = new Set(hiddenNodeIds);
    const nodes = sceneGraph?.nodes ?? [];
    const byId = new Map<string, SceneNode>();
    const found: SceneNode[] = [];
    const traverse = (list: SceneNode[], ancestorHidden: boolean) => {
      for (const n of list || []) {
        byId.set(n.id, n);
        const isHidden = ancestorHidden || hidden.has(n.id);
        if (n.isPulleyRope && n.leftTargetId && n.rightTargetId && !isHidden) found.push(n);
        traverse(n.children, isHidden);
      }
    };
    traverse(nodes, false);
    if (!found.length) return [];
    const poses = restPoses(nodes);
    return found.map((n): DrawnRope => ({
      id: n.id, leftId: n.leftTargetId!, rightId: n.rightTargetId!, layout: ropeLayout(n, byId, poses).layout,
    }));
  }, [sceneGraph, hiddenNodeIds]);

  useFrame(() => {
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    if (!model || !data || !mujoco) return;

    const body = (id: string) => bodyIdCache.current[id] ?? -1;
    const pos = (b: number): V3 => [data.xpos[b * 3], data.xpos[b * 3 + 1], data.xpos[b * 3 + 2]];
    // A body-frame vector in the world: xmat is row-major.
    const rot = (b: number, v: V3): V3 => {
      const m = data.xmat, o = b * 9;
      return [
        m[o] * v[0] + m[o + 1] * v[1] + m[o + 2] * v[2],
        m[o + 3] * v[0] + m[o + 4] * v[1] + m[o + 5] * v[2],
        m[o + 6] * v[0] + m[o + 7] * v[1] + m[o + 8] * v[2],
      ];
    };
    const at = (b: number, local: V3): V3 => {
      const p = pos(b), r = rot(b, local);
      return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
    };

    for (const rope of pulleyRopes) {
      const line = lineRefs.current[rope.id];
      if (!line) continue;
      const leftB = body(rope.leftId), rightB = body(rope.rightId);
      if (leftB === -1 || rightB === -1) continue;
      let lines: V3[][];
      const lay = rope.layout;
      if (!lay) {
        // Not a rope the model couples (an end that cannot slide): drawn
        // straight between the bodies, so it can be seen and fixed.
        lines = [[pos(leftB), pos(rightB)]];
      } else {
        const end = (b: number, e: RopeLayout['left']) => ({ attach: at(b, e.attachLocal), axis: rot(b, e.axisLocal), sign: e.sign, strands: e.strands });
        const wheelB = lay.wheel ? body(lay.wheel.nodeId) : -1;
        const wheel = lay.wheel && wheelB !== -1
          ? { centre: pos(wheelB), axis: rot(wheelB, lay.wheel.axisLocal), radius: lay.wheel.radius }
          : null;
        lines = ropePolylines(end(leftB, lay.left), end(rightB, lay.right), wheel);
      }
      const points: THREE.Vector3[] = [];
      for (const l of lines) {
        for (let i = 0; i + 1 < l.length; i++) points.push(new THREE.Vector3(...l[i]), new THREE.Vector3(...l[i + 1]));
      }
      line.geometry.setFromPoints(points);
    }
  });

  if (pulleyRopes.length === 0) return null;

  return (
    <>
      {pulleyRopes.map((rope) => (
        <lineSegments key={rope.id} ref={(el: THREE.LineSegments | null) => { lineRefs.current[rope.id] = el; }}>
          <bufferGeometry />
          <lineBasicMaterial color="#3b82f6" linewidth={3.5} transparent opacity={0.9} />
        </lineSegments>
      ))}
    </>
  );
};

// Rope node placeholder marker – renders a glowing ring for each pulley_rope scene node
export const PulleyRopeMarkers = ({ sceneGraph, selectedNodeId, setSelectedNodeId }: PulleyRopeMarkersProps) => {
  const isPlaying = useStore(state => state.isPlaying);
  const setOrbitEnabled = useOrbitEnable();

  // The wheel a rope runs over, so the handle can be sized relative to it.
  const findWheelNode = useCallback((wheelId: string): SceneNode | null => {
    const search = (nodes: SceneNode[]): SceneNode | null => {
      for (const n of nodes || []) {
        if (n.id === wheelId) return n;
        const c = search(n.children);
        if (c) return c;
      }
      return null;
    };
    return search(sceneGraph?.nodes || []);
  }, [sceneGraph]);

  const ropeNodes = useMemo(() => {
    const ropes: SceneNode[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyRope) ropes.push(n);
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return ropes;
  }, [sceneGraph]);

  if (ropeNodes.length === 0) return null;

  return (
    <>
      {ropeNodes.map((rope) => {
        // pos is [x, y_mujoco, z_mujoco] in scene graph space.
        // The SceneVisuals group is rotated [-PI/2, 0, 0], so we skip that rotation
        // and place markers in raw world space (no group rotation wrapper here).
        // MuJoCo X→Three.js X, MuJoCo Y→Three.js -Z, MuJoCo Z→Three.js Y
        const [mx, my, mz] = rope.pos;
        const threePos: [number, number, number] = [mx, mz, -my];
        const isSelected = selectedNodeId === rope.id;
        // Size the handle from the wheel it runs over. It used to be a fixed
        // 0.18-radius torus, which was fine when the presets were metres across
        // but is now larger than the entire pulley stand — and a rope node left
        // at pos [0,0,0] put that ring at the world origin, half of it under the
        // floor, looking like a stray object rather than a drag handle.
        const wheelNode = rope.pulleyWheelId ? findWheelNode(rope.pulleyWheelId) : null;
        const wheelR = wheelNode?.pulleyRadius ?? rope.pulleyRadius ?? 0.08;
        const ringR = Math.max(0.012, wheelR * 0.45);
        const ringThickness = ringR * 0.2;

        return (
          <group key={rope.id} position={threePos}>
            {/* Outer glowing torus ring */}
            <mesh
              rotation={[Math.PI / 2, 0, 0]}
              onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); setSelectedNodeId(rope.id); }}
              onPointerDown={(e: ThreeEvent<PointerEvent>) => {
                if (isPlaying) {
                  e.stopPropagation();
                  // Same reason as the body drag handlers: the orbit gesture
                  // and the drag gesture are the same single touch, so the
                  // camera has to stand down within this event rather than on
                  // the next render.
                  setOrbitEnabled(false);
                  useStore.getState().setDraggedNodeId(rope.id);
                  useStore.getState().setDragDistance(e.distance);
                  const pt = e.point;
                  useStore.getState().setDragTarget({ x: pt.x, y: -pt.z, z: pt.y });
                }
              }}
              onPointerUp={(e: ThreeEvent<PointerEvent>) => {
                if (useStore.getState().draggedNodeId === rope.id) {
                  e.stopPropagation();
                  useStore.getState().setDraggedNodeId(null);
                  useStore.getState().setDragTarget(null);
                  setOrbitEnabled(true);
                }
              }}
            >
              <torusGeometry args={[ringR, ringThickness, 12, 40]} />
              <meshStandardMaterial
                color={isSelected ? '#60a5fa' : '#10b981'}
                emissive={isSelected ? '#3b82f6' : '#047857'}
                emissiveIntensity={isSelected ? 0.8 : 0.4}
                transparent
                opacity={0.92}
              />
            </mesh>
            {/* Small inner dot */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[ringR * 0.4, ringThickness * 0.7, 8, 24]} />
              <meshStandardMaterial
                color={isSelected ? '#93c5fd' : '#6ee7b7'}
                emissive={isSelected ? '#93c5fd' : '#6ee7b7'}
                emissiveIntensity={0.5}
                transparent
                opacity={0.85}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
};
