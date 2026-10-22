/**
 * Helpers for the edge view — kept out of FeatureEdges.tsx so that file only
 * exports a component and fast refresh keeps working.
 */
import * as THREE from 'three';

/**
 * Crease angle, in degrees, above which an edge is drawn.
 *
 * A 32-segment cylinder or sphere has 11.25° between neighbouring facets, so
 * anything above that hides the tessellation while keeping every corner a
 * person would call a corner. Meshes get a wider margin because a smoothed
 * lattice or a sculpt is thousands of near-coplanar triangles that would
 * otherwise draw as a grey blob — the same reasoning CsgGhostOutline uses.
 */
export const EDGE_THRESHOLD_PRIMITIVE = 20;
export const EDGE_THRESHOLD_MESH = 30;

/**
 * The edge line: black, or white in dark mode, drawn opaque. It used to be a
 * darker tint of the body's colour at 75 % opacity, which on a pale or busy
 * body was too faint to define anything — a CAD-style ink line is the point.
 */
export const edgeColor = (dark: boolean) => (dark ? '#ffffff' : '#000000');

/**
 * The wedge's triangular prism as a geometry, for the edge pass. It must
 * match WedgeGeometry in SceneLayer vertex for vertex, or the lines would sit
 * beside the body they outline.
 */
export function wedgeGeometry(width: number, depth: number, height: number): THREE.BufferGeometry {
  const halfW = width / 2;
  const halfD = depth / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -halfW, height, -halfD,
    -halfW, height,  halfD,
     halfW, 0,      -halfD,
     halfW, 0,       halfD,
    -halfW, 0,      -halfD,
    -halfW, 0,       halfD,
  ], 3));
  g.setIndex([
    0, 1, 3,  0, 3, 2,
    4, 2, 3,  4, 3, 5,
    4, 5, 1,  4, 1, 0,
    4, 0, 2,
    5, 3, 1,
  ]);
  return g;
}
