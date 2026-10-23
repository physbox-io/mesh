import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { ReferenceImage } from '../../types/scene';
import { planeAxes, referenceHeight } from '../../utils/referenceImages';

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
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {images.filter((img) => !img.hidden).map((img) => <ReferencePicture key={img.id} img={img} />)}
    </group>
  );
}

function ReferencePicture({ img }: { img: ReferenceImage }) {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load(img.src);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [img.src]);
  useEffect(() => () => texture.dispose(), [texture]);

  const quaternion = useMemo(() => {
    const { right, up, normal } = planeAxes(img.plane);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...normal));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [img.plane]);

  return (
    <mesh
      position={img.pos}
      quaternion={quaternion}
      scale={[img.width, referenceHeight(img), 1]}
      renderOrder={img.overlay ? 999 : 0}
      raycast={() => null}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={img.opacity}
        depthTest={!img.overlay}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
