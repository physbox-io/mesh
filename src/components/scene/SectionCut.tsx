/**
 * The section view's cut, drawn: the parts clipped away in front of the plane,
 * and the cut face filled and hatched at 45° as a drawing marks a section.
 * Where to cut and what the face is come from the Dims overlay, which
 * measures the section (store/sectionStore, utils/sectionSlice); this only
 * draws it, and only while the overlay is drawing its figures.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useSection } from '../../store/sectionStore';
import { useStore } from '../../store/useStore';
import { isDrawingView } from '../../utils/cameraViews';
import { bodyOf } from '../../utils/measureScene';
import { hatchSegments } from '../../utils/sectionSlice';

const FILL = '#e2e8f0';
const HATCH = '#475569';
/** Hatch lines across a part's cut face, about: their spacing follows the cut's size. */
const HATCH_LINES = 40;
/** The face drawn this far toward the camera from the plane, so the clipped part never shows through it. */
const LIFT_M = 1e-5;

/** Document frame (Z-up) to three's (Y-up). */
const toThree = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];

/**
 * Normalizes a section plane `dot(p, normal) = offset` (document Z-up frame)
 * into a unit-normal plane in both document and Three.js Y-up frames.
 * Returns `null` if any component is non-finite or the normal is degenerate.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeSectionPlane(
  normal: readonly [number, number, number],
  offset: number,
): { normal: [number, number, number]; threeNormal: [number, number, number]; constant: number } | null {
  const [nx, ny, nz] = normal;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz) || !Number.isFinite(offset)) {
    return null;
  }
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len <= 1e-12) return null;
  const ux = nx / len;
  const uy = ny / len;
  const uz = nz / len;
  return {
    normal: [ux, uy, uz],
    threeNormal: toThree(ux, uy, uz),
    constant: -offset / len,
  };
}

/** Attaches `plane` to `material.clippingPlanes` without clobbering other clipping planes. */
// eslint-disable-next-line react-refresh/only-export-components
export function attachClippingPlane(material: THREE.Material, plane: THREE.Plane): boolean {
  if (material.clippingPlanes?.includes(plane)) return false;
  material.clippingPlanes = material.clippingPlanes ? [...material.clippingPlanes, plane] : [plane];
  material.needsUpdate = true;
  return true;
}

/** Detaches only `plane` from `material.clippingPlanes`, preserving any other clipping planes. */
// eslint-disable-next-line react-refresh/only-export-components
export function detachClippingPlane(material: THREE.Material, plane: THREE.Plane): boolean {
  if (!material.clippingPlanes?.includes(plane)) return false;
  const remaining = material.clippingPlanes.filter((p) => p !== plane);
  material.clippingPlanes = remaining.length > 0 ? remaining : null;
  material.needsUpdate = true;
  return true;
}

/**
 * True when an object represents a scene part that Section View should clip:
 * either a mesh inside a named body group (`bodyOf`) or an instanced batch of
 * static boxes (`StaticBoxInstances`) carrying `userData.nodeIds`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isSectionPart(object: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = object; cur; cur = cur.parent) {
    if (cur.userData?.isOverlay || cur.userData?.isBackground) return false;
  }
  if (bodyOf(object)) return true;
  const inst = object as THREE.InstancedMesh;
  return Boolean(inst.isInstancedMesh && Array.isArray(object.userData?.nodeIds));
}

/** Every material on a part's own meshes: what the cut clips. */
// eslint-disable-next-line react-refresh/only-export-components
export function partMaterials(scene: THREE.Object3D): THREE.Material[] {
  const out: THREE.Material[] = [];
  scene.traverse((object) => {
    const drawn = object as THREE.Mesh;
    if (!drawn.material || !isSectionPart(drawn)) return;
    for (const m of Array.isArray(drawn.material) ? drawn.material : [drawn.material]) out.push(m);
  });
  return out;
}

export function SectionCut() {
  const cut = useSection((s) => s.cut);
  const cameraView = useStore((s) => s.cameraView);
  // A ref, not state: the plane is moved in place every frame, and the
  // materials hold this one object.
  const planeRef = useRef(new THREE.Plane());
  const clippedRef = useRef(false);
  const prevLocalClippingRef = useRef<boolean | null>(null);
  const clippedMaterialsRef = useRef<Set<THREE.Material>>(new Set());
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);

  // Trigger a frame in demand-rendered mode whenever the cut changes.
  useEffect(() => {
    invalidate();
  }, [cut, invalidate]);

  // Unmounted mid-cut: nothing stays clipped and localClippingEnabled is restored.
  useEffect(() => () => {
    if (!clippedRef.current) return;
    const plane = planeRef.current;
    for (const m of partMaterials(scene)) {
      detachClippingPlane(m, plane);
    }
    for (const m of clippedMaterialsRef.current) {
      detachClippingPlane(m, plane);
    }
    clippedMaterialsRef.current.clear();
    gl.localClippingEnabled = prevLocalClippingRef.current ?? false;
    prevLocalClippingRef.current = null;
    clippedRef.current = false;
    invalidate();
  }, [gl, scene, invalidate]);
  const view = isDrawingView(cameraView) ? cameraView : null;

  const geometry = useMemo(() => {
    if (!cut || !view) return null;
    const planeData = normalizeSectionPlane(cut.normal, cut.offset);
    if (!planeData) return null;
    const [nx, ny, nz] = planeData.normal;
    const lift = (p: number[]) => {
      const out: number[] = [];
      for (let i = 0; i < p.length; i += 3) {
        out.push(...toThree(p[i] - nx * LIFT_M, p[i + 1] - ny * LIFT_M, p[i + 2] - nz * LIFT_M));
      }
      return new Float32Array(out);
    };
    const fill: number[] = [];
    const lines: number[] = [];
    for (const part of cut.parts) {
      fill.push(...part.fill);
      // Spaced to the part's cut, so a small part still gets a few lines.
      let lo = Infinity, hi = -Infinity;
      for (const loop of part.loops) for (const p of loop) for (const x of p) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      const spacing = Math.max((hi - lo) / HATCH_LINES, 1e-4);
      lines.push(...hatchSegments(part.loops, view, cut.offset, spacing));
      for (const loop of part.loops) {
        for (let i = 0; i < loop.length; i++) lines.push(...loop[i], ...loop[(i + 1) % loop.length]);
      }
    }
    const fillGeometry = new THREE.BufferGeometry();
    fillGeometry.setAttribute('position', new THREE.BufferAttribute(lift(fill), 3));
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(lift(lines), 3));
    return { fill: fillGeometry, lines: lineGeometry };
  }, [cut, view]);
  useEffect(() => () => { geometry?.fill.dispose(); geometry?.lines.dispose(); }, [geometry]);

  // Clip the parts: keep what lies at or past the plane along the line of
  // sight. Checked every frame while cutting, as a part rebuilt mid-cut gets
  // new materials; skipped completely when no cut is active and unclipped.
  useFrame(({ gl: frameGl, scene: frameScene }) => {
    const plane = planeRef.current;
    const planeData = cut ? normalizeSectionPlane(cut.normal, cut.offset) : null;
    if (!planeData) {
      if (!clippedRef.current) return;
      for (const m of partMaterials(frameScene)) {
        detachClippingPlane(m, plane);
      }
      for (const m of clippedMaterialsRef.current) {
        detachClippingPlane(m, plane);
      }
      clippedMaterialsRef.current.clear();
      frameGl.localClippingEnabled = prevLocalClippingRef.current ?? false;
      prevLocalClippingRef.current = null;
      clippedRef.current = false;
      return;
    }
    if (!clippedRef.current) {
      prevLocalClippingRef.current = frameGl.localClippingEnabled;
      clippedRef.current = true;
    }
    frameGl.localClippingEnabled = true;
    plane.normal.set(...planeData.threeNormal);
    plane.constant = planeData.constant;
    for (const m of partMaterials(frameScene)) {
      if (attachClippingPlane(m, plane) || m.clippingPlanes?.includes(plane)) {
        clippedMaterialsRef.current.add(m);
      }
    }
  });

  if (!geometry) return null;
  return (
    <group>
      <mesh geometry={geometry.fill} raycast={() => null} renderOrder={990}>
        <meshBasicMaterial color={FILL} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <lineSegments geometry={geometry.lines} raycast={() => null} renderOrder={991}>
        <lineBasicMaterial color={HATCH} toneMapped={false} />
      </lineSegments>
    </group>
  );
}
