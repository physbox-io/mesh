/**
 * Pulley rope rendering.
 *
 * Extracted from App.tsx, unchanged. A rope is a joint-equality abstraction
 * rather than a simulated cable, so it has no geometry of its own and is drawn
 * from the positions of the bodies it constrains.
 */
import { useRef, useMemo, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useOrbitEnable } from './useOrbitEnable';

// Dynamic glowing pulley cable/rope renderer
export const PulleyRopesRenderer = ({ model, data, mujoco, sceneGraph }: any) => {
  const lineRefs = useRef<{ [ropeId: string]: any }>({});
  const bodyIdCache = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!model || !mujoco) return;
    const c: Record<string, number> = {};
    for (let b = 0; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
      if (name) c[name] = b;
    }
    bodyIdCache.current = c;
  }, [model, mujoco]);
  
  // Find all pulley rope nodes in the scene
  const pulleyRopes = useMemo(() => {
    const ropes: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyRope && n.leftTargetId && n.rightTargetId) {
          ropes.push(n);
        }
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return ropes;
  }, [sceneGraph]);

  // Helper to find wheel node radius reactively
  const findWheelNode = useCallback((wheelId: string) => {
    const traverse = (nodes: any[]): any => {
      if (!nodes) return null;
      for (const n of nodes) {
        if (n.id === wheelId) return n;
        const c = traverse(n.children);
        if (c) return c;
      }
      return null;
    };
    return traverse(sceneGraph.nodes);
  }, [sceneGraph]);

  useFrame(() => {
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;
    if ((window as any).DISABLE_USEFRAME) return;
    if (!model || !data || !mujoco) return;

    for (const rope of pulleyRopes) {
      try {
        const leftId = bodyIdCache.current[rope.leftTargetId] ?? -1;
        const rightId = bodyIdCache.current[rope.rightTargetId] ?? -1;

        if (leftId === -1 || rightId === -1) continue;

        const lx = data.xpos[leftId * 3];
        const ly = data.xpos[leftId * 3 + 1];
        const lz = data.xpos[leftId * 3 + 2];

        const rx = data.xpos[rightId * 3];
        const ry = data.xpos[rightId * 3 + 1];
        const rz = data.xpos[rightId * 3 + 2];

        const points: THREE.Vector3[] = [];

        if (rope.pulleyWheelId) {
          // Pulley wheel present: arc-over-wheel geometry
          const wheelId = bodyIdCache.current[rope.pulleyWheelId] ?? -1;
          if (wheelId === -1) {
            // Wheel not yet spawned — fall back to straight line
            points.push(new THREE.Vector3(lx, ly, lz));
            points.push(new THREE.Vector3(rx, ry, rz));
          } else {
            const wx = data.xpos[wheelId * 3];
            const wy = data.xpos[wheelId * 3 + 1];
            const wz = data.xpos[wheelId * 3 + 2];
            const wheelNode = findWheelNode(rope.pulleyWheelId);
            // 0.4 was a pre-rescale default: it drew a rope arcing over a
            // 0.4m rim around a wheel whose geoms are 0.08.
            const rad = wheelNode?.pulleyRadius || 0.08;
            // Attach near the top of each weight rather than a fixed 0.15 above
            // it — another pre-rescale constant, which left the rope ending in
            // mid-air well clear of the weight it is supposed to hold.
            const attach = rad * 0.5;

            points.push(new THREE.Vector3(lx, ly, lz + attach));
            points.push(new THREE.Vector3(wx - rad, wy, wz));
            const segments = 12;
            for (let i = 1; i < segments; i++) {
              const phi = Math.PI - (Math.PI * i) / segments;
              points.push(new THREE.Vector3(
                wx + rad * Math.cos(phi),
                wy,
                wz + rad * Math.sin(phi)
              ));
            }
            points.push(new THREE.Vector3(wx + rad, wy, wz));
            points.push(new THREE.Vector3(rx, ry, rz + attach));
          }
        } else {
          // No wheel — straight rope between the two bodies
          points.push(new THREE.Vector3(lx, ly, lz));
          points.push(new THREE.Vector3(rx, ry, rz));
        }

        const line = lineRefs.current[rope.id];
        if (line) {
          line.geometry.setFromPoints(points);
        }
      } catch (e) {
        // Safe check
      }
    }
  });

  if (pulleyRopes.length === 0) return null;

  return (
    <>
      {pulleyRopes.map((rope) => (
        <line key={rope.id} ref={(el) => { lineRefs.current[rope.id] = el; }}>
          <bufferGeometry />
          <lineBasicMaterial color="#3b82f6" linewidth={3.5} transparent opacity={0.9} />
        </line>
      ))}
    </>
  );
};

// Rope node placeholder marker – renders a glowing ring for each pulley_rope scene node
export const PulleyRopeMarkers = ({ sceneGraph, selectedNodeId, setSelectedNodeId }: any) => {
  const isPlaying = useStore(state => state.isPlaying);
  const setOrbitEnabled = useOrbitEnable();

  // The wheel a rope runs over, so the handle can be sized relative to it.
  const findWheelNode = useCallback((wheelId: string): any => {
    const search = (nodes: any[]): any => {
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
    const ropes: any[] = [];
    const traverse = (nodes: any[]) => {
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
              onClick={(e: any) => { e.stopPropagation(); setSelectedNodeId(rope.id); }}
              onPointerDown={(e: any) => {
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
              onPointerUp={(e: any) => {
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
