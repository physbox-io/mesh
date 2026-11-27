import { describe, it, expect } from 'vitest';
import {
  HARDWARE_KINDS,
  hardwareCutGeoms,
  hardwareSpecOf,
  type HardwareCutSpec,
} from '../src/utils/hardwareCuts';
import {
  HARDWARE_PARTS,
  PARTS_FOR_CUT,
  hardwarePartName,
  hardwarePartNode,
  isBoughtIn,
  normalizePart,
  seatFor,
  seatPart,
} from '../src/utils/hardwareParts';
import {
  CLEARANCE_HOLES,
  COUNTERBORES,
  INSERTS,
  MAGNETS,
  O_RINGS,
  STANDOFF_HEIGHTS,
  WASHERS,
} from '../src/utils/hardwareSizes';
import { hardwareList } from '../src/utils/hardwareList';
import { metricThread } from '../src/utils/metricThreads';
import { cutGeometry } from '../src/utils/csg';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/** A solid block 60 × 60 × `thickMm` mm, top face at z = +thickMm/2000. */
const block = (id: string, thickMm = 20, pos = [0, 0, 0]): SceneNode => ({
  id,
  name: id,
  pos,
  csgEnabled: true,
  joints: [],
  children: [],
  geoms: [{ name: `${id}_b`, type: 'box', size: [0.03, 0.03, thickMm / 2000] } as SceneGeom],
} as SceneNode);

function applyCut(node: SceneNode, over: Partial<HardwareCutSpec>): string {
  const spec: HardwareCutSpec = {
    group: 'g1',
    kind: 'magnet_pocket',
    size: '',
    at: [0, 0, 0.01],
    normal: [0, 0, 1],
    ...over,
  };
  for (const piece of hardwareCutGeoms(spec, node.id, node)) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return spec.group;
}

describe('hardwareSizes additions', () => {
  it('defines standard neodymium disc magnet sizes and standoff heights', () => {
    expect(MAGNETS['8×3']).toEqual([8, 3]);
    expect(Object.keys(MAGNETS)).toEqual([
      '6×2', '6×3', '8×2', '8×3', '10×2', '10×3', '12×3', '15×3', '20×3',
    ]);
    expect(STANDOFF_HEIGHTS).toEqual([4, 5, 6, 8, 10, 12, 15, 20]);
  });
});

describe('hardwareCutGeoms for magnet_pocket, standoff, and threaded_hole', () => {
  it('builds a blind circular magnet_pocket with diameter + fit and thickness + 0.1 mm', () => {
    const geoms = hardwareCutGeoms(
      { group: 'mp1', kind: 'magnet_pocket', size: '10×3', at: [0, 0, 0.01], normal: [0, 0, 1] },
      'box1',
    );
    expect(geoms).toHaveLength(1);
    const pocket = geoms[0];
    expect(pocket.csg).toBe('difference');
    expect(pocket.type).toBe('cylinder');
    expect(pocket.hardware).toMatchObject({ group: 'mp1', kind: 'magnet_pocket', size: '10×3', part: 'pocket' });
    // Default fit for magnet_pocket is 0.15 mm
    expect(pocket.size[0] * 2000).toBeCloseTo(10 + 0.15, 4);
    expect((pocket.cutDepth ?? 0) * 1000).toBeCloseTo(3.1, 4);
  });

  it('builds a standoff with a union boss post and a tapped, insert, or clearance bore', () => {
    const [hole, insertDepth, outside] = INSERTS.M3;

    // Default bore: tapped, default height: 8 mm
    const tappedGeoms = hardwareCutGeoms(
      { group: 'st1', kind: 'standoff', size: 'M3', at: [0, 0, 0.01], normal: [0, 0, 1] },
      'pcb',
    );
    expect(tappedGeoms).toHaveLength(2);
    const [post, bore] = tappedGeoms;
    expect(post.csg).toBe('union');
    expect(post.rgba).toBeUndefined();
    expect(post.size[0] * 2000).toBeCloseTo(outside, 4);
    expect((post.cutDepth ?? 0) * 1000).toBeCloseTo(8, 4);
    expect(post.hardware?.length).toBeCloseTo(0.008, 6);
    expect(bore.csg).toBe('difference');
    expect(bore.thread?.pitch).toBeCloseTo(metricThread('M3')![2] / 1000, 6);
    expect((bore.cutDepth ?? 0) * 1000).toBeCloseTo(8, 4);

    // Insert bore with custom height shorter than insertDepth clamps bore depth to height
    const shortInsertGeoms = hardwareCutGeoms(
      { group: 'st2', kind: 'standoff', size: 'M3', bore: 'insert', lengthMm: 4, fitMm: 0.1, at: [0, 0, 0.01], normal: [0, 0, 1] },
      'pcb',
    );
    expect(shortInsertGeoms[0].cutDepth! * 1000).toBeCloseTo(4, 4);
    expect(shortInsertGeoms[1].size[0] * 2000).toBeCloseTo(hole + 0.1, 4);
    expect(shortInsertGeoms[1].cutDepth! * 1000).toBeCloseTo(4, 4);

    // Insert bore with taller standoff uses insertDepth
    const tallInsertGeoms = hardwareCutGeoms(
      { group: 'st3', kind: 'standoff', size: 'M3', bore: 'insert', lengthMm: 12, at: [0, 0, 0.01], normal: [0, 0, 1] },
      'pcb',
    );
    expect(tallInsertGeoms[1].cutDepth! * 1000).toBeCloseTo(insertDepth, 4);

    // Clearance bore
    const clearGeoms = hardwareCutGeoms(
      { group: 'st4', kind: 'standoff', size: 'M4', bore: 'clearance', lengthMm: 10, at: [0, 0, 0.01], normal: [0, 0, 1] },
      'pcb',
    );
    expect(clearGeoms[1].size[0] * 2000).toBeCloseTo(CLEARANCE_HOLES.M4, 4);
    expect(clearGeoms[1].thread).toBeUndefined();
    expect(clearGeoms[1].cutDepth! * 1000).toBeCloseTo(10, 4);
  });

  it('builds a threaded_hole with metric thread pitch and default 2.5*D depth or custom lengthMm', () => {
    const tM4 = metricThread('M4')!;
    const defGeoms = hardwareCutGeoms(
      { group: 'th1', kind: 'threaded_hole', size: 'M4', at: [0, 0, 0.01], normal: [0, 0, 1] },
      'plate',
    );
    expect(defGeoms).toHaveLength(1);
    expect(defGeoms[0].csg).toBe('difference');
    expect(defGeoms[0].size[0] * 2000).toBeCloseTo(tM4[1], 4);
    expect(defGeoms[0].thread?.pitch).toBeCloseTo(tM4[2] / 1000, 6);
    expect((defGeoms[0].cutDepth ?? 0) * 1000).toBeCloseTo(tM4[1] * 2.5, 4);

    const customGeoms = hardwareCutGeoms(
      { group: 'th2', kind: 'threaded_hole', size: 'M3', lengthMm: 12, at: [0, 0, 0.01], normal: [0, 0, 1] },
      'plate',
    );
    expect((customGeoms[0].cutDepth ?? 0) * 1000).toBeCloseTo(12, 4);
    expect(hardwareSpecOf(customGeoms, 'th2')?.lengthMm).toBeCloseTo(12, 3);
  });

  it('registers HARDWARE_KINDS metadata for all three new cuts', () => {
    expect(HARDWARE_KINDS.magnet_pocket.defaultSize).toBe('8×3');
    expect(HARDWARE_KINDS.standoff.defaultBore).toBe('tapped');
    expect(HARDWARE_KINDS.threaded_hole.defaultSize).toBe('M3');
  });
});

describe('hardwarePartNode for oring, insert, washer, and magnet', () => {
  it('builds an O-ring with closed outward mesh, positive mass, and formatted name', () => {
    const node = hardwarePartNode({ kind: 'oring', size: '20×2' }, 'or1');
    expect(isBoughtIn(node)).toBe(true);
    expect(node.name).toBe('20×2 O-ring');
    expect(node.geoms).toHaveLength(1);
    expect(node.geoms[0].mass).toBeGreaterThan(0);
    const analysis = analyzeMesh(node.geoms[0].renderVertices!, node.geoms[0].faces!)!;
    expect(analysis.closed).toBe(true);
    expect(analysis.consistentlyWound).toBe(true);
    expect(analysis.volume).toBeGreaterThan(0);
  });

  it('builds a knurled brass heat-set insert with brass mass and closed mesh', () => {
    const node = hardwarePartNode({ kind: 'insert', size: 'M3' }, 'ins1');
    expect(node.name).toBe('M3 heat-set insert');
    expect(node.geoms).toHaveLength(1);
    const g = node.geoms[0];
    expect(g.name).toBe('ins1_insert');
    expect(g.mass).toBeGreaterThan(0);
    const analysis = analyzeMesh(g.renderVertices!, g.faces!)!;
    expect(analysis.closed && analysis.consistentlyWound && analysis.volume > 0).toBe(true);
  });

  it('builds an ISO 7089 plain steel washer with closed ring mesh and positive mass', () => {
    const node = hardwarePartNode({ kind: 'washer', size: 'M4' }, 'w1');
    expect(node.name).toBe('M4 washer');
    expect(node.geoms).toHaveLength(1);
    const g = node.geoms[0];
    expect(g.name).toBe('w1_washer');
    expect(g.mass).toBeGreaterThan(0);
    const analysis = analyzeMesh(g.renderVertices!, g.faces!)!;
    expect(analysis.closed && analysis.consistentlyWound && analysis.volume > 0).toBe(true);
  });

  it('builds a neodymium disc magnet with N42 mass and north-pole indicator respecting polarity', () => {
    const posMag = hardwarePartNode({ kind: 'magnet', size: '8×3', polarity: 1 }, 'm1');
    expect(posMag.name).toBe('8×3 magnet');
    expect(posMag.geoms).toHaveLength(2);
    const [disc, north] = posMag.geoms;
    expect(disc.name).toBe('m1_magnet');
    expect(disc.type).toBe('cylinder');
    expect(disc.size[0] * 2000).toBeCloseTo(8, 4);
    expect(disc.size[1] * 2000).toBeCloseTo(3, 4);
    expect(disc.mass).toBeCloseTo(Math.PI * 0.004 ** 2 * 0.003 * 7500, 6);
    expect(north.role).toBe('visual');
    expect(north.pos![2]).toBeGreaterThan(0);
    expect(posMag.hardwarePart?.polarity).toBe(1);

    const negMag = hardwarePartNode({ kind: 'magnet', size: '8×3', polarity: -1 }, 'm2');
    const negNorth = negMag.geoms.find((g) => g.name === 'm2_north')!;
    expect(negNorth.pos![2]).toBeLessThan(0);
    expect(negMag.hardwarePart?.polarity).toBe(-1);

    // Non-magnet parts strip polarity during normalizePart
    const normalizedWasher = normalizePart({ kind: 'washer', size: 'M3', polarity: -1 });
    expect(normalizedWasher.polarity).toBeUndefined();
    expect(hardwarePartName({ kind: 'magnet', size: '12×3' })).toBe('12×3 magnet');
  });

  it('keeps screw first in PARTS_FOR_CUT for counterbore, insert, and insert_boss', () => {
    expect(PARTS_FOR_CUT.counterbore).toEqual(['screw', 'washer']);
    expect(PARTS_FOR_CUT.insert).toEqual(['screw', 'insert']);
    expect(PARTS_FOR_CUT.insert_boss).toEqual(['screw', 'insert']);
    expect(PARTS_FOR_CUT.magnet_pocket).toEqual(['magnet']);
    expect(PARTS_FOR_CUT.standoff).toEqual(['screw', 'insert']);
    expect(PARTS_FOR_CUT.threaded_hole).toEqual(['screw']);
    expect(Object.keys(HARDWARE_PARTS)).toEqual(expect.arrayContaining(['insert', 'washer', 'magnet', 'oring']));
  });
});

describe('seatFor new hardware parts and cuts', () => {
  it('seats a magnet flush inside a magnet_pocket', () => {
    const host = block('h1');
    const group = applyCut(host, { kind: 'magnet_pocket', size: '8×3' });
    const seat = seatFor(host, group)!;
    // Top face at z = 10 mm; 3 mm thick magnet centred at 10 - 1.5 = 8.5 mm
    expect(seat).not.toBeNull();
    expect(seat.pos[2]).toBeCloseTo(0.0085, 6);
    expect(seat.part).toEqual({ kind: 'magnet', size: '8×3' });
  });

  it('seats an insert flush in insert, insert_boss, and standoff cuts', () => {
    const m3DepthM = INSERTS.M3[1] / 1000;

    // 1. insert hole
    const hInsert = block('hi');
    const gInsert = applyCut(hInsert, { kind: 'insert', size: 'M3' });
    const sInsert = seatFor(hInsert, gInsert, 'insert')!;
    expect(sInsert.pos[2]).toBeCloseTo(0.01 - m3DepthM / 2, 6);
    expect(sInsert.part).toEqual({ kind: 'insert', size: 'M3' });

    // 2. insert_boss (boss stands m3DepthM above top face z = 0.01)
    const hBoss = block('hb');
    const gBoss = applyCut(hBoss, { kind: 'insert_boss', size: 'M3' });
    const sBoss = seatFor(hBoss, gBoss, 'insert')!;
    expect(sBoss.pos[2]).toBeCloseTo(0.01 + m3DepthM - m3DepthM / 2, 5);
    expect(sBoss.part).toEqual({ kind: 'insert', size: 'M3' });

    // 3. standoff (10 mm tall post above z = 0.01 -> top at z = 0.02)
    const hStandoff = block('hs');
    const gStandoff = applyCut(hStandoff, { kind: 'standoff', size: 'M3', bore: 'insert', lengthMm: 10 });
    const sStandoff = seatFor(hStandoff, gStandoff, 'insert')!;
    expect(sStandoff.pos[2]).toBeCloseTo(0.02 - m3DepthM / 2, 5);
    expect(sStandoff.part).toEqual({ kind: 'insert', size: 'M3' });
  });

  it('seats a washer on the floor of a counterbore', () => {
    const host = block('hw');
    const group = applyCut(host, { kind: 'counterbore', size: 'M4' });
    const seat = seatFor(host, group, 'washer')!;
    const cbDepthM = COUNTERBORES.M4[1] / 1000;
    const washerThickM = WASHERS.M4[2] / 1000;
    expect(seat).not.toBeNull();
    expect(seat.pos[2]).toBeCloseTo(0.01 - (cbDepthM - washerThickM / 2), 6);
    expect(seat.part).toEqual({ kind: 'washer', size: 'M4' });
  });

  it('seats a screw in threaded_hole and standoff cuts', () => {
    const hThread = block('ht');
    const gThread = applyCut(hThread, { kind: 'threaded_hole', size: 'M4', lengthMm: 12 });
    const sThread = seatFor(hThread, gThread)!;
    expect(sThread.pos[2]).toBeCloseTo(0.01, 6);
    expect(sThread.part).toMatchObject({ kind: 'screw', size: 'M4', lengthMm: 12 });

    const hStandoff = block('hs2');
    const gStandoff = applyCut(hStandoff, { kind: 'standoff', size: 'M3', bore: 'tapped', lengthMm: 10 });
    const sStandoff = seatFor(hStandoff, gStandoff)!;
    // Bearing on top of the 10 mm standoff (z = 0.01 + 0.01 = 0.02)
    expect(sStandoff.pos[2]).toBeCloseTo(0.02, 5);
    expect(sStandoff.part).toMatchObject({ kind: 'screw', size: 'M3', lengthMm: 10 });

    // seatPart integrates cleanly
    const screwNode = hardwarePartNode({ kind: 'screw', size: 'M3' }, 'sc1');
    hStandoff.children.push(screwNode);
    expect(seatPart(screwNode, hStandoff, gStandoff)).toBe(true);
    expect(screwNode.hardwarePart?.seat).toBe(gStandoff);
  });

  it('seats an O-ring in an oring face groove', () => {
    const host = block('ho');
    const group = applyCut(host, { kind: 'oring', size: '20×2', seal: 'face' });
    const seat = seatFor(host, group)!;
    expect(seat).not.toBeNull();
    expect(seat.part.kind).toBe('oring');
    expect(O_RINGS[seat.part.size]).toBeDefined();
    expect(seat.part.path?.length).toBeGreaterThan(8);
  });
});

describe('hardwareList counts insert, washer, magnet, and oring', () => {
  it('tallies each new part kind accurately', () => {
    const scene: SceneGraph = {
      nodes: [
        hardwarePartNode({ kind: 'insert', size: 'M3' }, 'i1'),
        hardwarePartNode({ kind: 'insert', size: 'M3' }, 'i2'),
        hardwarePartNode({ kind: 'washer', size: 'M4' }, 'w1'),
        hardwarePartNode({ kind: 'magnet', size: '8×3', polarity: 1 }, 'm1'),
        hardwarePartNode({ kind: 'magnet', size: '8×3', polarity: -1 }, 'm2'),
        hardwarePartNode({ kind: 'oring', size: '20×2' }, 'o1'),
      ],
    };
    const list = hardwareList(scene);
    const byName = Object.fromEntries(list.rows.map((r) => [r.name, r]));
    expect(byName['M3 heat-set insert']).toMatchObject({ kind: 'insert', size: 'M3', count: 2 });
    expect(byName['M4 washer']).toMatchObject({ kind: 'washer', size: 'M4', count: 1 });
    expect(byName['8×3 magnet']).toMatchObject({ kind: 'magnet', size: '8×3', count: 2 });
    expect(byName['20×2 O-ring']).toMatchObject({ kind: 'oring', size: '20×2', count: 1 });
  });
});
