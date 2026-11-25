import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { ReferenceImage } from '../../types/scene';
import { planeAxes, referenceHeight } from '../../utils/referenceImages';

const NOOP_RAYCAST = () => null;

export interface ResolvedReferenceTransform {
  position: [number, number, number];
  scale: [number, number, number];
  opacity: number;
}

/**
 * Validates finite position, positive width & aspect, and clamps opacity to `[0, 1]`.
 * Returns `null` when the reference image would otherwise produce NaN/Infinity transforms.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveReferenceTransform(
  img: Pick<ReferenceImage, 'pos' | 'width' | 'aspect' | 'opacity'>,
): ResolvedReferenceTransform | null {
  if (!Array.isArray(img.pos) || img.pos.length !== 3) return null;
  const [px, py, pz] = img.pos;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  if (!Number.isFinite(img.width) || img.width <= 0) return null;
  if (!Number.isFinite(img.aspect) || img.aspect <= 0) return null;
  const height = referenceHeight(img);
  if (!Number.isFinite(height) || height <= 0) return null;
  const opacity = Number.isFinite(img.opacity) ? Math.min(1, Math.max(0, img.opacity)) : 0.5;
  return {
    position: [px, py, pz],
    scale: [img.width, height, 1],
    opacity,
  };
}

/**
 * The scene's reference images, each a picture on a plane in its drawing view.
 *
 * Unlit (MeshBasicMaterial), so the mesh exports - which take lit meshes only -
 * leave them out, and with raycast stubbed so a click on a body behind one still
 * reaches the body. An overlay picture skips the depth test and draws last, so
 * it lies over the model to trace from; otherwise the model hides it.
 */
export function ReferenceImages() {
  const images = useStore((s) => s.sceneGraph.referenceImages);
  if (!images?.length) return null;
  return (
    <group rotation={[-Math.PI / 2, 0, 0]} userData={{ skipExport: true, isOverlay: true }}>
      {images.filter((img) => !img.hidden).map((img) => <ReferencePicture key={img.id} img={img} />)}
    </group>
  );
}

function ReferencePicture({ img }: { img: ReferenceImage }) {
  const invalidate = useThree((s) => s.invalidate);
  const [loadedEntry, setLoadedEntry] = useState<{ src: string; texture: THREE.Texture } | null>(null);
  const { src, plane, pos, width, aspect, opacity, overlay } = img;

  useEffect(() => {
    if (!src || !src.trim()) return;
    let cancelled = false;
    let activeTexture: THREE.Texture | null = null;
    const loader = new THREE.TextureLoader();
    const pending = loader.load(
      src,
      (loaded) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.anisotropy = 4;
        loaded.needsUpdate = true;
        activeTexture = loaded;
        setLoadedEntry({ src, texture: loaded });
        invalidate();
      },
      undefined,
      () => {
        if (!cancelled) {
          pending.dispose();
          setLoadedEntry((prev) => (prev?.src === src ? null : prev));
          invalidate();
        }
      },
    );
    return () => {
      cancelled = true;
      pending.dispose();
      if (activeTexture && activeTexture !== pending) {
        activeTexture.dispose();
      }
      invalidate();
    };
  }, [src, invalidate]);

  const texture = loadedEntry?.src === src ? loadedEntry.texture : null;

  const quaternion = useMemo(() => {
    const { right, up, normal } = planeAxes(plane);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...normal));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [plane]);

  const transform = useMemo(
    () => resolveReferenceTransform({ pos, width, aspect, opacity }),
    [pos, width, aspect, opacity],
  );

  if (!texture || !transform) return null;

  return (
    <mesh
      position={transform.position}
      quaternion={quaternion}
      scale={transform.scale}
      renderOrder={overlay ? 999 : 0}
      raycast={NOOP_RAYCAST}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={transform.opacity}
        depthTest={!overlay}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
