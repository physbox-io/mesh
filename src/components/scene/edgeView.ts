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

export function edgeColorOf(color: number[] | undefined): THREE.Color {
  const [r, g, b] = color ?? [0.8, 0.8, 0.8];
  // Darken in HSL rather than scaling RGB: scaling a pale blue toward black
  // desaturates it into grey, whereas dropping lightness keeps the hue so the
  // line still reads as "this body's edge".
  const c = new THREE.Color(r, g, b);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(0, hsl.l * 0.45));
  return c;
}

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
