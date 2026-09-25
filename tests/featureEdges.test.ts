import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findFeatureEdges, edgesOfSurface, maxSizeFor, suggestedSize, sameEdge } from '../src/utils/featureEdges';

/** A three geometry as the flat positions + faces the finder takes. */
function soup(geometry: THREE.BufferGeometry): { positions: number[]; faces: number[] } {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = Array.from(g.attributes.position.array as ArrayLike<number>);
  return { positions, faces: positions.map((_, i) => i).filter((i) => i < positions.length / 3) };
}

function box(x: number, y: number, z: number) {
  return soup(new THREE.BoxGeometry(x, y, z));
}

/** three's extrusion runs along +Z from 0 to depth, which is up here. */
function extrude(shape: THREE.Shape, depth: number) {
  return soup(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 32 }));
}

describe('findFeatureEdges', () => {
  it('finds a box\'s twelve edges, all straight and convex, in its three groups', () => {
    const { positions, faces } = box(0.04, 0.03, 0.02);
    const found = findFeatureEdges(positions, faces);
    expect(found.edges).toHaveLength(12);
    expect(found.other).toHaveLength(0);
    expect(found.edges.every((e) => e.edge.kind === 'line' && e.edge.convex)).toBe(true);
    expect(found.edges.filter((e) => e.top)).toHaveLength(4);
    expect(found.edges.filter((e) => e.bottom)).toHaveLength(4);
    expect(found.edges.filter((e) => e.vertical)).toHaveLength(4);
    for (const e of found.edges) expect(e.angleDeg).toBeCloseTo(90, 3);
    expect(found.surfaces).toHaveLength(6);
  });

  it('gives each edge the in-face directions pointing away from it', () => {
    const { positions, faces } = box(0.02, 0.02, 0.02);
    const found = findFeatureEdges(positions, faces);
    // The top edge along X at y = +10 mm: one face runs back along -Y, the other down along -Z.
    const edge = found.edges.find((e) => e.edge.kind === 'line' && Math.abs(e.edge.a[1] - 0.01) < 1e-9 &&
      Math.abs(e.edge.a[2] - 0.01) < 1e-9 && Math.abs(e.edge.b[1] - 0.01) < 1e-9 &&
      Math.abs(e.edge.b[2] - 0.01) < 1e-9)!;
    expect(edge).toBeDefined();
    const dirs = [edge.edge.t1, edge.edge.t2].map((t) => t.map((c) => Math.round(c)));
    expect(dirs).toEqual(expect.arrayContaining([[0, -1, 0], [0, 0, -1]]));
  });

  it('finds a cylinder\'s two rims as circles', () => {
    const geometry = new THREE.CylinderGeometry(0.01, 0.01, 0.03, 32).rotateX(Math.PI / 2);
    const { positions, faces } = soup(geometry);
    const found = findFeatureEdges(positions, faces);
    expect(found.edges).toHaveLength(2);
    for (const e of found.edges) {
      expect(e.edge.kind).toBe('circle');
      if (e.edge.kind !== 'circle') continue;
      expect(e.edge.radius).toBeCloseTo(0.01, 6);
      expect(e.edge.segments).toBe(32);
      expect(e.edge.convex).toBe(true);
      // The flat face of a boss's rim runs in toward the centre.
      expect(e.edge.t1[0] * e.edge.ref[0] + e.edge.t1[1] * e.edge.ref[1] + e.edge.t1[2] * e.edge.ref[2]).toBeCloseTo(-1, 6);
    }
    expect(found.edges.filter((e) => e.top)).toHaveLength(1);
    expect(found.edges.filter((e) => e.bottom)).toHaveLength(1);
  });

  it('finds a hole\'s rims as convex circles whose face runs away from the centre', () => {
    const plate = new THREE.Shape();
    plate.moveTo(-0.02, -0.02); plate.lineTo(0.02, -0.02); plate.lineTo(0.02, 0.02); plate.lineTo(-0.02, 0.02); plate.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, 0.005, 0, Math.PI * 2, true);
    plate.holes.push(hole);
    const { positions, faces } = extrude(plate, 0.01);
    const found = findFeatureEdges(positions, faces);
    const rims = found.edges.filter((e) => e.edge.kind === 'circle');
    expect(rims).toHaveLength(2);
    for (const e of rims) {
      if (e.edge.kind !== 'circle') continue;
      expect(e.edge.radius).toBeCloseTo(0.005, 5);
      expect(e.edge.convex).toBe(true);
      const outward = e.edge.t1[0] * e.edge.ref[0] + e.edge.t1[1] * e.edge.ref[1] + e.edge.t1[2] * e.edge.ref[2];
      expect(outward).toBeCloseTo(1, 6);
    }
    expect(found.edges.filter((e) => e.edge.kind === 'line')).toHaveLength(12);
    // The plate is 10 mm thick, so its side faces allow 5 mm on each edge.
    const topOuter = found.edges.filter((e) => e.edge.kind === 'line' && e.top);
    for (const e of topOuter) expect(e.maxSetback).toBeCloseTo(0.005, 4);
  });

  it('allows an edge half the gap to a hole in its face, not half the face', () => {
    const plate = new THREE.Shape();
    plate.moveTo(-0.02, -0.02); plate.lineTo(0.02, -0.02); plate.lineTo(0.02, 0.02); plate.lineTo(-0.02, 0.02); plate.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, 0.005, 0, Math.PI * 2, true);
    plate.holes.push(hole);
    const found = findFeatureEdges(...Object.values(extrude(plate, 0.03)) as [number[], number[]]);
    // 15 mm from each outer top edge to the hole: 7.5 mm each, where the 40 mm face alone would allow 20.
    const topOuter = found.edges.filter((e) => e.edge.kind === 'line' && e.top);
    expect(topOuter).toHaveLength(4);
    for (const e of topOuter) expect(e.maxSetback).toBeCloseTo(0.0075, 4);
  });

  it('marks the inside corner of an L as concave', () => {
    const l = new THREE.Shape();
    l.moveTo(0, 0); l.lineTo(0.03, 0); l.lineTo(0.03, 0.01); l.lineTo(0.01, 0.01); l.lineTo(0.01, 0.03); l.lineTo(0, 0.03); l.closePath();
    const { positions, faces } = extrude(l, 0.02);
    const found = findFeatureEdges(positions, faces);
    expect(found.edges).toHaveLength(18);
    const concave = found.edges.filter((e) => !e.edge.convex);
    expect(concave).toHaveLength(1);
    expect(concave[0].vertical).toBe(true);
    expect(concave[0].angleDeg).toBeCloseTo(90, 3);
  });

  it('stops a gusset\'s sloping edges at the plates it stands on, and a box\'s edges nowhere', () => {
    // An L of two plates with a triangular rib in the corner, all one closed
    // surface: the side view, extruded.
    const side = new THREE.Shape();
    side.moveTo(0, 0); side.lineTo(0.05, 0); side.lineTo(0.05, 0.005); side.lineTo(0.03, 0.005);
    side.lineTo(0.005, 0.03); side.lineTo(0.005, 0.06); side.lineTo(0, 0.06); side.closePath();
    const found = findFeatureEdges(...Object.values(extrude(side, 0.004)) as [number[], number[]]);
    // three's extrusion is along its Z; here the shape's y is up in the part's
    // frame only by construction, so ask which edges slope and check their stops.
    const sloped = found.edges.filter((e) => e.edge.kind === 'line' && e.edge.a.length &&
      Math.abs(Math.abs(e.edge.a[0] - e.edge.b[0]) - Math.abs(e.edge.a[1] - e.edge.b[1])) < 1e-6 &&
      Math.abs(e.edge.a[0] - e.edge.b[0]) > 0.01);
    expect(sloped).toHaveLength(2);
    for (const e of sloped) {
      if (e.edge.kind !== 'line') continue;
      expect(e.edge.stops).toHaveLength(2);
      for (const stop of e.edge.stops!) {
        // Each stop is one of the plates' inner faces: normal along +x or +y.
        expect(Math.max(stop.normal[0], stop.normal[1])).toBeCloseTo(1, 6);
      }
    }
    const { positions, faces } = box(0.02, 0.02, 0.02);
    expect(findFeatureEdges(positions, faces).edges.every((e) => e.edge.kind !== 'line' || !e.edge.stops)).toBe(true);
  });

  it('picks a face\'s outline from its surface', () => {
    const { positions, faces } = box(0.04, 0.03, 0.02);
    const found = findFeatureEdges(positions, faces);
    const top = found.surfaces.findIndex((s) => s.normal[2] > 0.99);
    const outline = edgesOfSurface(found.edges, top);
    expect(outline).toHaveLength(4);
    expect(outline.every((e) => e.top)).toBe(true);
  });

  it('says how big a rounding fits: half the thinnest neighbouring face', () => {
    const { positions, faces } = box(0.04, 0.03, 0.01);
    const found = findFeatureEdges(positions, faces);
    expect(maxSizeFor(found.edges, 'fillet')).toBeCloseTo(0.005, 6);
    expect(maxSizeFor(found.edges, 'chamfer')).toBeCloseTo(0.005, 6);
  });

  it('matches an edge to itself either way round, and not to its neighbour', () => {
    const { positions, faces } = box(0.02, 0.02, 0.02);
    const [a, b] = findFeatureEdges(positions, faces).edges;
    expect(sameEdge(a.edge, a.edge)).toBe(true);
    if (a.edge.kind === 'line') {
      expect(sameEdge(a.edge, { ...a.edge, a: a.edge.b, b: a.edge.a })).toBe(true);
    }
    expect(sameEdge(a.edge, b.edge)).toBe(false);
  });
});

describe('suggestedSize', () => {
  it('offers a friendly fraction of the part', () => {
    expect(suggestedSize(0.04, 0.02)).toBe(0.003);
    expect(suggestedSize(0.1, 0.05)).toBe(0.005);
  });
  it('never offers more than fits', () => {
    expect(suggestedSize(0.1, 0.0015)).toBe(0.001);
    expect(suggestedSize(0.1, 0.0003)).toBeCloseTo(0.0003, 8);
  });
});
