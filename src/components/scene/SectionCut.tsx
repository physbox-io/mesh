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
 * True when an object represents a scene part that Section View should clip:
 * either a mesh inside a named body group (`bodyOf`) or an instanced batch of
 * static boxes (`StaticBoxInstances`) carrying `userData.nodeIds`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isSectionPart(object: THREE.Object3D): boolean {
  if (object.userData?.isOverlay || object.userData?.isBackground) return false;
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
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  // Unmounted mid-cut: nothing stays clipped.
  useEffect(() => () => {
    if (!clippedRef.current) return;
    const plane = planeRef.current;
    for (const m of partMaterials(scene)) {
      if (m.clippingPlanes?.includes(plane)) { m.clippingPlanes = null; m.needsUpdate = true; }
    }
    gl.localClippingEnabled = false;
    clippedRef.current = false;
  }, [gl, scene]);
  const view = isDrawingView(cameraView) ? cameraView : null;

  const geometry = useMemo(() => {
    if (!cut || !view) return null;
    const [nx, ny, nz] = cut.normal;
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
    if (!cut) {
      if (!clippedRef.current) return;
      for (const m of partMaterials(frameScene)) {
        if (m.clippingPlanes?.includes(plane)) {
          m.clippingPlanes = null;
          m.needsUpdate = true;
        }
      }
      frameGl.localClippingEnabled = false;
      clippedRef.current = false;
      return;
    }
    frameGl.localClippingEnabled = true;
    clippedRef.current = true;
    plane.normal.set(...toThree(...cut.normal));
    plane.constant = -cut.offset;
    for (const m of partMaterials(frameScene)) {
      const clipped = m.clippingPlanes?.includes(plane) ?? false;
      if (!clipped) {
        m.clippingPlanes = [plane];
        m.needsUpdate = true;
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
