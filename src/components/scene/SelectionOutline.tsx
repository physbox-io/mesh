import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Outline } from '@react-three/postprocessing';
import { BlendFunction, type OutlineEffect } from 'postprocessing';
import type * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { findNode } from '../../store/sceneClone';

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
  const lastRef = useRef<{
    recompileId: number;
    selectedNodeId: string | null;
    extraSelectedIds: string[];
    geomFocused: boolean;
    activeGeomIndex: number;
    sceneGraph: unknown;
  } | null>(null);

  useFrame(() => {
    const outline = effect.current;
    if (!outline) return;
    const { selectedNodeId, extraSelectedIds, recompileId, geomFocused, activeGeomIndex, sceneGraph } = useStore.getState();
    const current = outline.selection;
    const prev = lastRef.current;
    if (
      prev
      && prev.recompileId === recompileId
      && prev.selectedNodeId === selectedNodeId
      && prev.extraSelectedIds === extraSelectedIds
      && prev.geomFocused === geomFocused
      && prev.activeGeomIndex === activeGeomIndex
      && (!geomFocused || prev.sceneGraph === sceneGraph)
    ) {
      let allMounted = true;
      for (const obj of current) {
        if (!obj.parent) {
          allMounted = false;
          break;
        }
      }
      if (allMounted && (selectedNodeId || extraSelectedIds.length > 0 ? current.size > 0 : current.size === 0)) {
        return;
      }
    }
    lastRef.current = { recompileId, selectedNodeId, extraSelectedIds, geomFocused, activeGeomIndex, sceneGraph };

    if (!selectedNodeId && extraSelectedIds.length === 0) {
      if (current.size > 0) current.clear();
      return;
    }

    const focusedGeomName = geomFocused && selectedNodeId
      ? findNode(sceneGraph?.nodes, selectedNodeId)?.geoms?.[activeGeomIndex]?.name ?? null
      : null;

    const ids = new Set(extraSelectedIds);
    if (selectedNodeId) ids.add(selectedNodeId);

    // A Set: a body's group can hold another of the same name (a geom's own
    // group inside its node's), and a duplicate would never match below.
    const meshes = new Set<THREE.Object3D>();
    // A geom picked on its own in the hierarchy is outlined alone, by the tag
    // DynamicGeom puts on its group. One with no group of its own (a boolean
    // body's member, a cut) finds nothing and the whole body is outlined.
    if (focusedGeomName) {
      scene.traverse((o) => {
        if (o.name !== selectedNodeId || o.userData.geomName !== focusedGeomName) return;
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) meshes.add(c);
        });
      });
    }
    // The rest of the selection, still whole bodies.
    if (meshes.size > 0 && selectedNodeId) ids.delete(selectedNodeId);
    if (ids.size > 0) {
      scene.traverse((o) => {
        if (!o.name || !ids.has(o.name)) return;
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) meshes.add(c);
        });
      });
    }

    if (current.size === meshes.size) {
      let same = true;
      for (const m of meshes) {
        if (!current.has(m)) { same = false; break; }
      }
      if (same) return;
    }
    current.set(Array.from(meshes));
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
