import { describe, it, expect } from 'vitest';
import { boxMesh } from './helpers/meshes';
import { repairMesh, repairSceneGeom, yupToZup, zupToYup } from '../src/utils/meshRepair';
import type { SceneGeom } from '../src/types/scene';

describe('meshRepair', () => {
  it('1. welds float32 seam cracks between adjacent cells', () => {
    // Construct a box split into two halves with a 1e-5 gap along the seam
    const box = boxMesh([0, 0, 0], [0.5, 0.5, 0.5]);
    // Duplicate vertices 4..7 (the top face) with a 1e-5 offset
    const verts = [...box.verts];
    const offsetStart = verts.length / 3;
    const gap = 1e-5;
    for (let i = 4; i < 8; i++) {
      verts.push(box.verts[i * 3] + gap, box.verts[i * 3 + 1], box.verts[i * 3 + 2]);
    }

    // Rewrite the first 2 triangles (the +Z face, indices 4,5,6,7) to use offsetStart..offsetStart+3
    const faces = [...box.faces];
    for (let i = 0; i < 6; i++) {
      faces[i] = faces[i] - 4 + offsetStart;
    }

    const report = repairMesh(verts, faces, { weldTolerance: 1e-4 });
    expect(report.before.boundaryEdges).toBeGreaterThan(0);
    expect(report.before.closed).toBe(false);

    expect(report.weldedVertices).toBeGreaterThanOrEqual(4);
    expect(report.after.boundaryEdges).toBe(0);
    expect(report.after.closed).toBe(true);
    expect(report.after.volume).toBeGreaterThan(0);
  });

  it('2. removes degenerate zero-area triangles and folded duplicate ear triangles', () => {
    const box = boxMesh([0, 0, 0], [0.1, 0.1, 0.1]);
    const verts = [...box.verts];
    const faces = [...box.faces];

    // Add degenerate triangles
    // (a) Same vertex used multiple times
    faces.push(0, 0, 1);
    // (b) 3 collinear vertices
    const colStart = verts.length / 3;
    verts.push(0, 0, 0, 0.05, 0.05, 0.05, 0.1, 0.1, 0.1);
    faces.push(colStart, colStart + 1, colStart + 2);

    // Add a folded duplicate ear sticking off edge (0, 1)
    const earVertIdx = verts.length / 3;
    verts.push(0, 0, 0.5);
    // Two triangles on the same 3 vertices with opposite winding
    faces.push(0, 1, earVertIdx);
    faces.push(0, earVertIdx, 1);

    const report = repairMesh(verts, faces);

    expect(report.before.degenerateTriangles).toBeGreaterThan(0);
    expect(report.before.nonManifoldEdges).toBeGreaterThan(0);

    expect(report.removedDegenerate).toBeGreaterThanOrEqual(2);
    expect(report.removedDuplicate).toBeGreaterThanOrEqual(2);
    expect(report.after.degenerateTriangles).toBe(0);
    expect(report.after.nonManifoldEdges).toBe(0);
    expect(report.after.closed).toBe(true);
  });

  it('3. fills open holes on a box missing one face', () => {
    const box = boxMesh([0, 0, 0], [0.1, 0.1, 0.1]);
    // The first 6 indices are the 2 triangles of the +Z quad
    const facesMissingTop = box.faces.slice(6);

    const report = repairMesh(box.verts, facesMissingTop);

    expect(report.before.boundaryEdges).toBe(4);
    expect(report.before.closed).toBe(false);

    expect(report.filledLoops).toBe(1);
    expect(report.after.boundaryEdges).toBe(0);
    expect(report.after.closed).toBe(true);
    expect(report.after.volume).toBeCloseTo(0.2 * 0.2 * 0.2, 4);
  });

  it('4. fixes inverted or inconsistent triangle winding', () => {
    const box = boxMesh([0, 0, 0], [0.1, 0.1, 0.1]);

    // Subcase A: Uniformly inverted mesh (signed volume < 0)
    const invertedFaces = [...box.faces];
    for (let i = 0; i < invertedFaces.length; i += 3) {
      const tmp = invertedFaces[i + 1];
      invertedFaces[i + 1] = invertedFaces[i + 2];
      invertedFaces[i + 2] = tmp;
    }

    const reportA = repairMesh(box.verts, invertedFaces);
    expect(reportA.before.volume).toBeLessThan(0);
    expect(reportA.flippedShells).toBe(1);
    expect(reportA.after.consistentlyWound).toBe(true);
    expect(reportA.after.volume).toBeGreaterThan(0);
    expect(reportA.after.closed).toBe(true);

    // Subcase B: Inconsistent winding (some faces flipped)
    const inconsistentFaces = [...box.faces];
    // Flip only triangle 0 and triangle 2
    const tmp0 = inconsistentFaces[1];
    inconsistentFaces[1] = inconsistentFaces[2];
    inconsistentFaces[2] = tmp0;
    const tmp2 = inconsistentFaces[7];
    inconsistentFaces[7] = inconsistentFaces[8];
    inconsistentFaces[8] = tmp2;

    const reportB = repairMesh(box.verts, inconsistentFaces);
    expect(reportB.before.consistentlyWound).toBe(false);
    expect(reportB.after.consistentlyWound).toBe(true);
    expect(reportB.after.volume).toBeGreaterThan(0);
    expect(reportB.after.closed).toBe(true);
  });

  it('5. repairSceneGeom updates both renderVertices (Z-up) and vertices (Y-up)', () => {
    const box = boxMesh([0, 0, 0], [0.1, 0.2, 0.3]);

    // Case A: Input with renderVertices (Z-up)
    const geomWithRender: SceneGeom = {
      name: 'part1',
      type: 'mesh',
      size: [0.1, 0.2, 0.3],
      renderVertices: [...box.verts],
      faces: [...box.faces],
    };

    const resA = repairSceneGeom(geomWithRender);
    expect(resA).not.toBeNull();
    const { geom: outA, report: repA } = resA!;
    expect(repA.after.closed).toBe(true);
    expect(outA.renderVertices).toBeDefined();
    expect(outA.vertices).toBeDefined();
    expect(outA.renderVertices!.length).toBe(outA.vertices!.length);

    // Verify Z-up -> Y-up coordinate conversion: (x, y, z) -> (x, z, -y)
    for (let i = 0; i < outA.renderVertices!.length; i += 3) {
      const rx = outA.renderVertices![i];
      const ry = outA.renderVertices![i + 1];
      const rz = outA.renderVertices![i + 2];
      expect(outA.vertices![i]).toBeCloseTo(rx);
      expect(outA.vertices![i + 1]).toBeCloseTo(rz);
      expect(outA.vertices![i + 2]).toBeCloseTo(-ry);
    }

    // Case B: Input with ONLY vertices (Y-up)
    const yupVerts = zupToYup(box.verts);
    expect(yupToZup(yupVerts)).toEqual(box.verts);
    const geomWithYup: SceneGeom = {
      name: 'part2',
      type: 'mesh',
      size: [0.1, 0.2, 0.3],
      vertices: yupVerts,
      faces: [...box.faces],
    };

    const resB = repairSceneGeom(geomWithYup);
    expect(resB).not.toBeNull();
    const { geom: outB } = resB!;
    expect(outB.renderVertices).toBeDefined();
    expect(outB.vertices).toBeDefined();
    expect(outB.renderVertices![0]).toBeCloseTo(box.verts[0]);
    expect(outB.renderVertices![1]).toBeCloseTo(box.verts[1]);
    expect(outB.renderVertices![2]).toBeCloseTo(box.verts[2]);

    // Case C: Non-mesh geom returns null
    const boxGeom: SceneGeom = {
      name: 'box1',
      type: 'box',
      size: [1, 1, 1],
    };
    expect(repairSceneGeom(boxGeom)).toBeNull();
  });

  it('handles polygon hole filling with >= 5 vertices via ear clipping', () => {
    // Create an open prism with a pentagonal top hole
    // 5 bottom vertices (z = 0), 5 top vertices (z = 1)
    const verts: number[] = [];
    const R = 1.0;
    for (let i = 0; i < 5; i++) {
      const theta = (2 * Math.PI * i) / 5;
      verts.push(R * Math.cos(theta), R * Math.sin(theta), 0);
    }
    for (let i = 0; i < 5; i++) {
      const theta = (2 * Math.PI * i) / 5;
      verts.push(R * Math.cos(theta), R * Math.sin(theta), 1);
    }

    const faces: number[] = [];
    // Bottom cap: fan around vertex 0 (reversed for -Z)
    for (let i = 1; i < 4; i++) {
      faces.push(0, i + 1, i);
    }
    // Side walls
    for (let i = 0; i < 5; i++) {
      const next = (i + 1) % 5;
      const b1 = i;
      const b2 = next;
      const t1 = i + 5;
      const t2 = next + 5;
      // Quad (b1, b2, t2, t1)
      faces.push(b1, b2, t2);
      faces.push(b1, t2, t1);
    }

    // Top face is left open (a 5-vertex hole)
    const report = repairMesh(verts, faces);
    expect(report.before.boundaryEdges).toBe(5);
    expect(report.filledLoops).toBe(1);
    expect(report.after.boundaryEdges).toBe(0);
    expect(report.after.closed).toBe(true);
    expect(report.after.volume).toBeGreaterThan(0);
  });

  it('respects options to disable hole filling, winding fix, or welding', () => {
    const box = boxMesh([0, 0, 0], [0.1, 0.1, 0.1]);
    const facesMissingTop = box.faces.slice(6);

    const reportNoFill = repairMesh(box.verts, facesMissingTop, { fillHoles: false });
    expect(reportNoFill.filledLoops).toBe(0);
    expect(reportNoFill.after.closed).toBe(false);

    // Inverted without fixWinding
    const invertedFaces = [...box.faces];
    for (let i = 0; i < invertedFaces.length; i += 3) {
      const tmp = invertedFaces[i + 1];
      invertedFaces[i + 1] = invertedFaces[i + 2];
      invertedFaces[i + 2] = tmp;
    }
    const reportNoFixWinding = repairMesh(box.verts, invertedFaces, { fixWinding: false });
    expect(reportNoFixWinding.flippedShells).toBe(0);
    expect(reportNoFixWinding.after.volume).toBeLessThan(0);
  });
});
