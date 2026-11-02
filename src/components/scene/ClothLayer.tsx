/**
 * Draws cloth (utils/cloth): one mesh per piece, its vertices read each frame
 * from the worker's flexvert_xpos. Mounted inside SceneLayer's Z-up group, so
 * MuJoCo's world coordinates go in as they are.
 *
 * Two-sided on purpose. Cloth has an inside and an outside that are both
 * seen, unlike a solid, whose back faces must stay culled (CLAUDE.md, face
 * winding).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneGraph, SceneNode } from '../../types/scene';
import type { DataMirror, FrameFlagWindow, ModelMirror } from '../../types/sceneLayer';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';

interface Props {
  model: ModelMirror | null;
  data: DataMirror | null;
  sceneGraph: SceneGraph | null;
}

/** Cloth bodies by name, so a flex `<body>__<piece>` finds the node it belongs to. */
function clothNodes(nodes: SceneNode[] | undefined, out = new Map<string, SceneNode>()) {
  for (const n of nodes ?? []) {
    if (n.cloth) out.set(n.name || n.id, n);
    clothNodes(n.children, out);
  }
  return out;
}

function ClothPiece({ flex, node, selected, data }: { flex: FlexInfo; node: SceneNode | undefined; selected: boolean; data: DataMirror }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * flex.vertnum), 3));
    g.setIndex(flex.elems);
    return g;
  }, [flex]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color(flex.rgba[0], flex.rgba[1], flex.rgba[2]),
    roughness: 0.95,
    side: THREE.DoubleSide,
  }), [flex]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.emissive.set(selected ? 0x223355 : 0x000000);
  }, [material, selected]);

  // Positions before the first frame too, so a paused scene shows its cloth.
  const sync = () => {
    const src = data.flexvert_xpos;
    if (!src || src.length < 3 * (flex.vertadr + flex.vertnum)) return;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const o = 3 * flex.vertadr;
    for (let i = 0; i < 3 * flex.vertnum; i++) arr[i] = src[o + i];
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  };
  useEffect(sync); // eslint-disable-line react-hooks/exhaustive-deps -- every render, on purpose
  const lastTime = useRef(-1);
  useFrame(() => {
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    // Only when the cloth has moved: normals over thousands of triangles are not free.
    if (data.time === lastTime.current) return;
    lastTime.current = data.time ?? -1;
    sync();
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!node) return;
    e.stopPropagation();
    if (useStore.getState().paintMode) return;
    useStore.getState().setSelectedNodeId(node.id);
  };
  return <mesh geometry={geometry} material={material} frustumCulled={false} castShadow receiveShadow onClick={onClick} />;
}

export function ClothLayer({ model, data, sceneGraph }: Props) {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const hiddenNodeIds = useStore((s) => s.hiddenNodeIds);
  const byName = useMemo(() => clothNodes(sceneGraph?.nodes), [sceneGraph]);
  const flexes = model?.flexes;
  if (!flexes?.length || !data) return null;
  const hidden = new Set(hiddenNodeIds);
  return (
    <>
      {flexes.map((flex) => {
        const node = byName.get(flex.name.slice(0, flex.name.lastIndexOf('__')));
        if (node && hidden.has(node.id)) return null;
        return <ClothPiece key={flex.name} flex={flex} node={node} selected={!!node && node.id === selectedNodeId} data={data} />;
      })}
    </>
  );
}
