/**
 * The "Edges" view: a thin dark line along every real corner of a body.
 *
 * Under the scene's light rig two faces meeting at a corner can land on the
 * same brightness, and a cube goes flat — you see a hexagon, not a box. The
 * wireframe toggle answers a different question (what tessellation does the
 * machine see) and is far too busy for this: it draws every diagonal of every
 * quad. This draws only edges whose two faces meet at more than `threshold`
 * degrees, so a box gets twelve lines, a cylinder its two rims, and a sphere
 * nothing at all.
 *
 * The line is a darker tint of the body's own colour rather than black, so an
 * edged scene still reads as the same scene with its corners found, not as a
 * blueprint. The mesh it sits on is pushed back a hair with polygonOffset (see
 * materialProps in SceneLayer) — that, not anything here, is what keeps the
 * lines from flickering through the surface they lie on.
 */
import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { edgeColorOf } from './edgeView';

interface Props {
  /** The surface to outline, in the same local frame the lines will be drawn in. */
  geometry: THREE.BufferGeometry | null | undefined;
  color: number[] | undefined;
  threshold: number;
  /** Passed straight through to the lineSegments so the outline shares the mesh's placement. */
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

export const FeatureEdges = ({ geometry, color, threshold, rotation, scale }: Props) => {
  const edges = useMemo(() => {
    if (!geometry) return null;
    // A scaled mesh (an ellipsoid) has to have its edge angles taken on the
    // scaled shape, so bake the scale into a copy rather than trust the
    // lineSegments' scale to do the right thing with angles.
    const base = scale ? geometry.clone().scale(scale[0], scale[1], scale[2]) : geometry;
    const e = new THREE.EdgesGeometry(base, threshold);
    if (base !== geometry) base.dispose();
    return e;
  }, [geometry, threshold, scale?.[0], scale?.[1], scale?.[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { edges?.dispose(); }, [edges]);

  const lineColor = useMemo(() => edgeColorOf(color), [color]);

  if (!edges || edges.getAttribute('position').count === 0) return null;
  return (
    <lineSegments geometry={edges} rotation={rotation} raycast={() => null}>
      <lineBasicMaterial color={lineColor} transparent opacity={0.75} toneMapped={false} />
    </lineSegments>
  );
};
