/**
 * Ghost outlines for CSG negatives.
 *
 * Extracted from App.tsx, unchanged. These draw the *absence* of material, so
 * they have no MuJoCo geom of their own and cannot be rendered by the ordinary
 * geom path.
 */
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { positiveBounds, geomMatrixOf, clipSegmentsToBox } from '../../utils/csg';

// Negative (subtracted) shapes have no MuJoCo geom at all — they're holes, not
// solids — so nothing would show where you're cutting. Draw them as red
// wireframes on the selected body only: placing a hole you can't see is
// guesswork, and drawing them always would clutter every other body.
export const CsgNegativeGhosts = ({ model, data, mujoco, sceneGraph, selectedNodeId }: any) => {
  const groupRef = useRef<THREE.Group>(null);

  const target = useMemo(() => {
    if (!selectedNodeId) return null;
    const find = (nodes: any[]): any => {
      for (const n of nodes || []) {
        if (n.id === selectedNodeId) return n;
        const c = find(n.children);
        if (c) return c;
      }
      return null;
    };
    const node = find(sceneGraph?.nodes || []);
    if (!node?.csgEnabled) return null;
    const negatives = (node.geoms || []).filter((g: any) => g.csg === 'difference' && !g.csgDerived);
    const intersects = (node.geoms || []).filter((g: any) => g.csg === 'intersection' && !g.csgDerived);
    if (negatives.length === 0 && intersects.length === 0) return null;
    return {
      node,
      // Outlines are clipped to the solid's extent — see positiveBounds.
      bounds: positiveBounds(node),
      ghosts: [...negatives.map((g: any) => ({ g, kind: 'neg' })), ...intersects.map((g: any) => ({ g, kind: 'int' }))],
    };
  }, [sceneGraph, selectedNodeId]);

  const bodyId = useMemo(() => {
    if (!target || !model || !mujoco) return -1;
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, target.node.name || target.node.id);
  }, [target, model, mujoco]);

  // The ghosts live in the body's frame, so the group tracks the body rather
  // than any geom — a negative isn't in the model to have a geom_xpos of its own.
  useFrame(() => {
    if (!groupRef.current || bodyId === -1 || !data) return;
    if ((window as any).DISABLE_USEFRAME) return;
    const activeData = useStore.getState().data;
    if (data !== activeData) return;
    try {
      const o = bodyId * 9;
      const m = data.xmat;
      const mat = new THREE.Matrix4().set(
        m[o], m[o + 1], m[o + 2], 0,
        m[o + 3], m[o + 4], m[o + 5], 0,
        m[o + 6], m[o + 7], m[o + 8], 0,
        0, 0, 0, 1
      );
      groupRef.current.position.set(data.xpos[bodyId * 3], data.xpos[bodyId * 3 + 1], data.xpos[bodyId * 3 + 2]);
      groupRef.current.quaternion.setFromRotationMatrix(mat);
    } catch { /* body deleted mid-frame */ }
  });

  if (!target || bodyId === -1) return null;

  return (
    <group ref={groupRef}>
      {target.ghosts.map(({ g, kind }: any) => (
        <CsgGhostOutline
          key={g.name}
          geom={g}
          color={kind === 'neg' ? '#ef4444' : '#38bdf8'}
          bounds={target.bounds}
          csgCentroid={target.node.csgCentroid}
        />
      ))}
    </group>
  );
};

// One negative shape, drawn as EDGES ONLY and clipped to the solid it cuts.
//
// Two deliberate choices:
//
// LineSegments over an EdgesGeometry, not a mesh with material.wireframe:
// wireframe draws every triangle of the tessellation including the diagonal
// splitting each quad, which on a sphere is dense enough to read as a shaded
// solid. EdgesGeometry keeps only edges where faces actually meet at an angle.
//
// Clipped to the host's bounds: a negative MUST overshoot the solid (a flush cut
// leaves coincident faces, i.e. non-manifold CSG output), but drawing it at full
// length is actively misleading — a cylinder punched through a thin disc renders
// as a tall tube floating in space with only a sliver of it doing any cutting.
// The points are baked into body space here so the clip is a one-off in the
// useMemo rather than per-frame renderer clipping-plane work.
export const CsgGhostOutline = ({ geom, color, bounds, csgCentroid }: { geom: any; color: string; bounds: { min: number[]; max: number[] } | null; csgCentroid?: number[] }) => {
  const key = JSON.stringify([geom.type, geom.size, geom.pos, geom.euler, geom.quat, bounds, csgCentroid]);

  const edges = useMemo(() => {
    const s = geom.size || [];
    const r = s[0] || 0.1;
    let base: THREE.BufferGeometry;
    // Segment counts are kept low on purpose: this is an annotation, not a
    // surface, and a 32-segment outline is visual noise at this size.
    switch (geom.type) {
      case 'box':
        base = new THREE.BoxGeometry(r * 2, (s[1] ?? r) * 2, (s[2] ?? r) * 2);
        break;
      case 'cylinder':
        base = new THREE.CylinderGeometry(r, r, (s[1] ?? 0.1) * 2, 16);
        base.rotateX(Math.PI / 2); // Three.js cylinders are Y-long; MuJoCo's are Z-long
        break;
      case 'capsule':
        base = new THREE.CapsuleGeometry(r, (s[1] ?? 0.1) * 2, 4, 16);
        base.rotateX(Math.PI / 2);
        break;
      case 'ellipsoid':
        base = new THREE.SphereGeometry(1, 16, 10);
        // Scale the geometry itself, not the mesh: edge angles have to be
        // computed on the squashed shape or the outline won't match it.
        base.scale(r, s[1] ?? r, s[2] ?? r);
        break;
      default:
        base = new THREE.SphereGeometry(r, 16, 10);
        break;
    }

    const e = new THREE.EdgesGeometry(base, 1);
    base.dispose();

    // Bake the geom's own pos/rotation in, so the segments are in body space and
    // can be clipped against the body-space bounds directly.
    const src = e.getAttribute('position').array as ArrayLike<number>;
    const m = geomMatrixOf(geom);
    if (csgCentroid && csgCentroid.length >= 3) {
      const p = geom.pos || [0, 0, 0];
      // X and Y only — see csgFrameOffset: the compiled body is not re-origined in Z.
      m.setPosition(p[0] - csgCentroid[0], p[1] - csgCentroid[1], p[2]);
    }
    const baked = new Array<number>(src.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
      baked[i] = v.x; baked[i + 1] = v.y; baked[i + 2] = v.z;
    }
    e.dispose();

    let clipped = bounds ? clipSegmentsToBox(baked, bounds.min, bounds.max) : baked;

    // A cutting tool is often LARGER than the part in the directions across the
    // cut — chopping the top off a cone needs a box wider than the cone. Every
    // edge of such a box lies on a face outside the solid, so clipping the lines
    // correctly removes all of them and the cut becomes invisible. When that
    // happens, fall back to outlining the REGION being removed: the negative's
    // bounding box intersected with the solid's. Indicative rather than exact,
    // but it shows where material is going, which is the point of the overlay.
    if (bounds && clipped.length < Math.max(12, baked.length * 0.45) && baked.length > 0) {
      clipped = baked;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(clipped, 3));
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => edges.dispose(), [edges]);

  // No position/rotation: the segments are already in body-space coordinates.
  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
};
