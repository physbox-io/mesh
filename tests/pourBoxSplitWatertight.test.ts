import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildPourBox, type PourBoxMesh } from '../src/utils/siliconeMold';
import { analyzeMesh, weldByPosition } from '../src/utils/meshIntegrity';
import { sceneWithPourBox } from '../src/utils/pourBoxScene';
import { pourBoxStl } from '../src/utils/pourBoxActions';
import { meshIntegrity } from '../src/utils/sceneSummary';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

function boxSoup([x0, y0, z0]: number[], [x1, y1, z1]: number[]): number[] {
  const c = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(d));
  return out;
}

function extrudePolySoup(pts: [number, number][], h: number, z0 = 0): number[] {
  const cs = wasm.CrossSection.ofPolygons([pts], 'Positive');
  const m = cs.extrude(h).translate([0, 0, z0]);
  const gm = m.getMesh();
  const out: number[] = [];
  for (let i = 0; i < gm.triVerts.length; i++) {
    const v = gm.triVerts[i] * gm.numProp;
    out.push(gm.vertProperties[v], gm.vertProperties[v + 1], gm.vertProperties[v + 2]);
  }
  m.delete();
  cs.delete();
  return out;
}

function shieldSoup(): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const x = -25 + 50 * t;
    const y = 30 - 0.01 * x * x;
    pts.push([x, y]);
  }
  pts.push([25, -5], [15, -25], [0, -35], [-15, -25], [-25, -5]);
  return extrudePolySoup(pts.reverse(), 12);
}

function teardropSoup(): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 48; i++) {
    const t = (2 * Math.PI * i) / 48;
    const x = 18 * Math.sin(t) * (1 - 0.35 * Math.cos(t));
    const y = 28 * Math.cos(t);
    pts.push([x, y]);
  }
  return extrudePolySoup(pts.reverse(), 20);
}

function tiltedEllipseSoup(): number[] {
  const pts: [number, number][] = [];
  const ang = 0.42;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < 64; i++) {
    const t = (2 * Math.PI * i) / 64;
    const lx = 32 * Math.cos(t), ly = 16 * Math.sin(t);
    pts.push([lx * ca - ly * sa + 13.7, lx * sa + ly * ca - 8.3]);
  }
  return extrudePolySoup(pts, 30, 5);
}

function pentagonSoup(): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const a = (2 * Math.PI * i) / 5 + 0.17;
    pts.push([22 * Math.cos(a), 22 * Math.sin(a)]);
  }
  return extrudePolySoup(pts, 18);
}

function readStl(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  const positions: number[] = [];
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const o = 84 + t * 50 + 12 + k * 12;
      positions.push(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
    }
  }
  return { positions, faces: positions.map((_, i) => i).filter((i) => i < positions.length / 3) };
}

function expectStrictlyWatertight(m: PourBoxMesh, label: string) {
  const welded = weldByPosition(m.positions, m.faces);
  const a = analyzeMesh(welded.positions, welded.faces)!;
  expect(a, label).not.toBeNull();
  expect(
    {
      closed: a.closed,
      consistentlyWound: a.consistentlyWound,
      boundaryEdges: a.boundaryEdges,
      nonManifoldEdges: a.nonManifoldEdges,
      degenerateTriangles: a.degenerateTriangles,
    },
    label,
  ).toEqual({
    closed: true,
    consistentlyWound: true,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    degenerateTriangles: 0,
  });
  expect(a.volume, label).toBeGreaterThan(0);
}

describe('split pour sleeve watertightness (shape="fit", split_sleeve=true)', () => {
  it('produces strictly watertight sleeve halves, clips, and base with zero degenerate triangles for simple and curved contours', () => {
    const cases: [string, number[]][] = [
      ['boxWide', boxSoup([-35, -18, 0], [35, 18, 45])],
      ['boxTall', boxSoup([-18, -35, 0], [18, 35, 45])],
      ['shield', shieldSoup()],
      ['teardrop', teardropSoup()],
      ['tiltedEllipse', tiltedEllipseSoup()],
      ['pentagon', pentagonSoup()],
      ['asymWedge', [...boxSoup([-26, -32, 0], [18, 32, 32]), ...boxSoup([4, -18, 32], [24, 24, 44])]],
    ];

    for (const [label, soup] of cases) {
      const box = buildPourBox(wasm, soup, { shape: 'fit', splitSleeve: true });
      expect(box.sleeveParts.map((p) => p.key), label).toEqual(['sleeve1', 'sleeve2', 'clip1', 'clip2']);

      expectStrictlyWatertight(box.base, `${label}/base`);
      for (const sp of box.sleeveParts) {
        expectStrictlyWatertight(sp.assembled, `${label}/${sp.key}.assembled`);
        expectStrictlyWatertight(sp.mesh, `${label}/${sp.key}.mesh`);

        // Also verify binary STL round-trip (as a slicer welds float32 vertices).
        const stl = readStl(pourBoxStl(sp.mesh, sp.label));
        expectStrictlyWatertight(stl, `${label}/${sp.key}.stl`);
      }

      // Also verify scene geoms (metres, shifted by shared origin, checked via sceneSummary.meshIntegrity).
      const master: SceneNode = {
        id: 'm', name: label, type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [{ name: 'g', type: 'box', size: [0.01, 0.01, 0.01] } as SceneGeom],
      } as unknown as SceneNode;
      const scene = { nodes: [master] } as unknown as SceneGraph;
      const out = sceneWithPourBox(scene, ['m'], box, { shape: 'fit', splitSleeve: true });
      const baseNode = out.scene.nodes.find((n) => n.id === out.baseId)!;
      const sleeveNode = out.scene.nodes.find((n) => n.id === out.sleeveId)!;
      for (const g of [...baseNode.geoms, ...sleeveNode.geoms]) {
        const mi = meshIntegrity(g);
        expect(mi.watertight, `${label}/${g.name}`).toBe(true);
        expect(mi.boundaryEdges ?? 0, `${label}/${g.name}`).toBe(0);
        expect(mi.nonManifoldEdges ?? 0, `${label}/${g.name}`).toBe(0);
        expect(mi.degenerateTriangles ?? 0, `${label}/${g.name}`).toBe(0);
      }
    }
  });
});
