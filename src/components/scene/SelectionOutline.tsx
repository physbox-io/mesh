import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Outline } from '@react-three/postprocessing';
import { BlendFunction, type OutlineEffect } from 'postprocessing';
import type * as THREE from 'three';
import { useStore } from '../../store/useStore';

/**
 * An outline around the selected bodies, in place of the blue tint they used to
 * be drawn with (SceneLayer keeps the tint for Hi-Res off). A tint recolours the
 * whole part, so the colour you are looking at is not the part's colour; an
 * outline leaves the surface alone.
 *
 * Found by name rather than wrapped in <Select>: each body draws inside a group
 * named after its node, and a wrapping group would change the parent of every
 * geom in the scene. Re-read every frame drawn, because a rebuild replaces the
 * meshes without changing the selection. Frames are on demand, so a still view
 * costs nothing.
 *
 * Alpha blending, not the effect's default screen: screen adds the outline's
 * colour, which on the light theme's near-white backdrop adds nothing.
 */
export function SelectionOutline() {
  const effect = useRef<OutlineEffect>(null);
  const scene = useThree((s) => s.scene);

  useFrame(() => {
    const outline = effect.current;
    if (!outline) return;
    const { selectedNodeId, extraSelectedIds } = useStore.getState();
    const ids = new Set(extraSelectedIds);
    if (selectedNodeId) ids.add(selectedNodeId);

    // A Set: a body's group can hold another of the same name (a geom's own
    // group inside its node's), and a duplicate would never match below.
    const meshes = new Set<THREE.Object3D>();
    if (ids.size > 0) {
      scene.traverse((o) => {
        if (!o.name || !ids.has(o.name)) return;
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) meshes.add(c);
        });
      });
    }

    const current = outline.selection;
    if (current.size === meshes.size && [...meshes].every((m) => current.has(m))) return;
    current.set([...meshes]);
  });

  return (
    <Outline
      ref={effect}
      blendFunction={BlendFunction.ALPHA}
      visibleEdgeColor={0x3b82f6}
      hiddenEdgeColor={0x3b82f6}
      edgeStrength={4}
      xRay={false}
      resolutionScale={1}
    />
  );
}
