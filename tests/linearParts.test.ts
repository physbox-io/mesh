// Linear motion: rails, rods with bushings, drawer runners. These check that
// each moving piece is on a slide limited to the length it runs on, that rails
// and rods go into their seats, that a part rides a rod through its housing
// and a drawer gets a runner each side, that a wrong side space is caught, and
// — in real MuJoCo — that a carriage and a drawer stop at their ends.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { hardwarePartNode, seatPart, HARDWARE_PARTS } from '../src/utils/hardwareParts';
import { LM_UU, MGN, RUNNER_SIDE_SPACE_MM } from '../src/utils/linearParts';
import { addDrawerRunners, fixToPiece, rideOnRod } from '../src/utils/linearPlacement';
import { runnerFindings } from '../src/utils/hardwareChecks';
import { hardwareList, packBars } from '../src/utils/hardwareList';
import { hardwareCutGeoms, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { compileToMJCF } from '../src/utils/mjcf';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { HardwarePartKind, SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const body = (id: string, geoms: Partial<SceneGeom>[], pos = [0, 0, 0], free = false): SceneNode => ({
  id, name: id, pos, csgEnabled: true, children: [],
  joints: free ? [{ name: `${id}_free`, type: 'free' }] : [],
  geoms: geoms.map((g, i) => ({ name: `${id}_${i}`, mass: 0.1, ...g }) as SceneGeom),
} as SceneNode);

function cut(node: SceneNode, over: Partial<HardwareCutSpec>): string {
  const spec: HardwareCutSpec = { group: 'g1', kind: 'rail_seat', size: '', at: [0, 0, 0], normal: [0, 0, 1], ...over };
  for (const piece of hardwareCutGeoms(spec, node.id, node)) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return spec.group;
}

const slideOf = (n: SceneNode) => n.joints.find((j) => j.type === 'slide')!;
const all = (nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] => { for (const n of nodes) { out.push(n); all(n.children, out); } return out; };

describe('the parts', () => {
  it('builds every size, every mesh closed and outward, every moving piece on a limited slide', () => {
    for (const kind of ['mgn_rail', 'linear_rod', 'drawer_runner'] as HardwarePartKind[]) {
      for (const size of HARDWARE_PARTS[kind].sizes) {
        const part = hardwarePartNode({ kind, size }, `p_${kind}_${size}`);
        for (const n of all([part])) {
          for (const g of n.geoms.filter((x) => x.type === 'mesh')) {
            const a = analyzeMesh(g.renderVertices!, g.faces!)!;
            expect(a.closed && a.consistentlyWound && a.volume > 0, `${kind} ${size} ${g.name}`).toBe(true);
          }
          if (n.hardwarePart?.piece) {
            expect(slideOf(n).limited).toBe(true);
            // A moving piece never touches what it runs in.
            for (const g of n.geoms.filter((x) => x.role !== 'visual')) expect(g.contype).toBe(0);
          }
        }
      }
    }
  });

  it('lets an MGN12 carriage travel the rail less its own length', () => {
    const rail = hardwarePartNode({ kind: 'mgn_rail', size: 'MGN12', lengthMm: 300 }, 'r');
    const range = slideOf(rail.children[0]).range!;
    const travel = (300 - MGN.MGN12.block[0]) / 2000;
    expect(range[0]).toBeCloseTo(-travel, 6);
    expect(range[1]).toBeCloseTo(travel, 6);
  });

  it('gives a drawer runner its own length of extension, over two slides', () => {
    const runner = hardwarePartNode({ kind: 'drawer_runner', size: '400' }, 'd');
    const middle = runner.children[0];
    const drawer = middle.children[0];
    expect(slideOf(middle).range![1] + slideOf(drawer).range![1]).toBeCloseTo(0.4, 6);
  });
});

describe('seats', () => {
  it('cuts a rail seat with a hole at every bolt, and beds the rail on its floor', () => {
    const plate = body('plate', [{ type: 'box', size: [0.2, 0.03, 0.005], pos: [0, 0, 0] }]);
    const group = cut(plate, { kind: 'rail_seat', size: 'MGN12', lengthMm: 300, at: [0, 0, 0.005] });
    const holes = plate.geoms.filter((g) => g.hardware?.part.startsWith('hole'));
    expect(holes).toHaveLength(Math.floor((300 - 8) / MGN.MGN12.rail[2]) + 1);
    const xs = holes.map((h) => h.cutAt![0]).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(0.025, 6);
    const rail = hardwarePartNode({ kind: 'mgn_rail', size: 'MGN9' }, 'r');
    plate.children.push(rail);
    expect(seatPart(rail, plate, group)).toBe(true);
    expect(rail.hardwarePart).toMatchObject({ size: 'MGN12', lengthMm: 300 });
    expect(rail.pos[2]).toBeCloseTo(0.005 - 0.0015, 6);
  });

  it('turns a rail seat across the face', () => {
    const plate = body('plate', [{ type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0, 0] }]);
    cut(plate, { kind: 'rail_seat', size: 'MGN12', lengthMm: 200, turned: true, at: [0, 0, 0.005] });
    const ys = plate.geoms.filter((g) => g.hardware?.part.startsWith('hole')).map((h) => h.cutAt![1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.1);
  });
});

describe('riding a rod', () => {
  /** A frame with a rod standing in a socket on its top, and a block whose housing is on the rod's line. */
  const rig = (offsetMm = 0) => {
    const frame = body('frame', [{ type: 'box', size: [0.05, 0.05, 0.01], pos: [0, 0, 0] }]);
    const socket = cut(frame, { kind: 'rod_clamp', size: '8', at: [0, 0, 0.01] });
    const rod = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 200 }, 'rod');
    frame.children.push(rod);
    seatPart(rod, frame, socket);
    // A block at z = 0.1, its housing bored down from its top, on the rod's line.
    const block = body('block', [{ type: 'box', size: [0.02, 0.02, 0.015], pos: [0, 0, 0] }], [offsetMm / 1000, 0, 0.1], true);
    const housing = cut(block, { kind: 'lm_housing', size: '8', at: [0, 0, 0.015] });
    return { scene: { nodes: [frame, block] } as SceneGraph, block, housing, rod };
  };

  it('moves the bushing to the housing and welds the block to it, still free to both ends', () => {
    const { scene, block, housing, rod } = rig();
    expect(rideOnRod(scene, block.id, housing)).toEqual({ ok: true });
    const bush = rod.children[0];
    expect(block.weldTargetId).toBe(bush.id);
    const [lo, hi] = slideOf(bush).range!;
    const travel = (200 - LM_UU['8'][1]) / 2000;
    expect(hi - lo).toBeCloseTo(2 * travel, 6);
    expect(lo).toBeLessThan(0);
  });

  it('refuses a housing off the rod\'s line', () => {
    const { scene, block, housing } = rig(3);
    const r = rideOnRod(scene, block.id, housing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/No Ø8 rod/);
  });

  it('will not weld a body already welded to something else', () => {
    const { scene, block, rod } = rig();
    block.weldTargetId = 'elsewhere';
    const r = fixToPiece(scene, rod.children[0].id, block.id);
    expect(r.ok).toBe(false);
  });
});

/** A cabinet of five plain walls, inside 400 wide, 450 deep, 300 high, open at -Y; and a drawer in it. */
function cabinetAndDrawer(drawerWidthMm: number) {
  const W = 0.4, D = 0.45, H = 0.3, t = 0.018;
  const wall = (half: number[], pos: number[]) => ({ type: 'box' as const, size: half, pos });
  const cabinet = body('cabinet', [
    wall([t / 2, D / 2, H / 2], [-W / 2 - t / 2, 0, H / 2]),
    wall([t / 2, D / 2, H / 2], [W / 2 + t / 2, 0, H / 2]),
    wall([W / 2 + t, D / 2, t / 2], [0, 0, -t / 2]),
    wall([W / 2 + t, D / 2, t / 2], [0, 0, H + t / 2]),
    wall([W / 2 + t, t / 2, H / 2], [0, D / 2 + t / 2, H / 2]),
  ]);
  cabinet.csgEnabled = false;
  // A real drawer's weight: a few kilos of birch ply.
  // Standing clear of the cabinet floor, as a drawer on runners does.
  const drawer = body('drawer', [{ type: 'box', size: [drawerWidthMm / 2000, 0.22, 0.06], pos: [0, 0, 0], mass: 2 }], [0, -D / 2 + 0.22, 0.09], true);
  return { scene: { nodes: [cabinet, drawer] } as SceneGraph, cabinet, drawer };
}

describe('drawer runners', () => {
  let n = 0;
  const newId = () => `run${n++}`;

  it('puts one each side, sized to the drawer, out of the open side', () => {
    const { scene, drawer } = cabinetAndDrawer(400 - 2 * RUNNER_SIDE_SPACE_MM);
    const r = addDrawerRunners(scene, drawer.id, newId);
    expect(r.ok).toBe(true);
    const cabinet = scene.nodes.find((x) => x.id === 'cabinet')!;
    const runners = cabinet.children.filter((x) => x.hardwarePart?.kind === 'drawer_runner');
    // Fixed in the cabinet, rigidly.
    expect(runners).toHaveLength(2);
    expect(runners.every((x) => x.hardwarePart!.size === '400' && x.joints.length === 0)).toBe(true);
    expect(drawer.weldTargetId).toBe(`${runners[0].id}_carriage`);
    // The second follows the first, slide for slide.
    expect(all(runners).find((x) => x.id === `${runners[1].id}_carriage`)!.coupleTargetId).toBe(`${runners[0].id}_carriage`);
    // Out of -Y: the drawer member's +X is the drawer's way out.
    expect(runnerFindings(scene, 'print')).toEqual([]);
  });

  it('catches a drawer 2 mm too wide', () => {
    const { scene, drawer } = cabinetAndDrawer(400 - 2 * RUNNER_SIDE_SPACE_MM + 2);
    // Placed as if it were right: the runner sits where it would on a drawer of the right width.
    addDrawerRunners(scene, drawer.id, newId);
    for (const r of scene.nodes[0].children.filter((x) => x.hardwarePart?.kind === 'drawer_runner')) r.pos[0] = Math.sign(r.pos[0]) * (0.2 - RUNNER_SIDE_SPACE_MM / 2000);
    const findings = runnerFindings(scene, 'print');
    expect(findings).toHaveLength(2);
    expect(findings[0].fix).toMatch(/2\.0 mm narrower/);
  });

  it('says why it cannot fit a drawer standing outside any cabinet', () => {
    const { scene, drawer } = cabinetAndDrawer(370);
    scene.nodes = [drawer];
    const r = addDrawerRunners(scene, drawer.id, newId);
    expect(r.ok).toBe(false);
  });
});

describe('the hardware list', () => {
  it('counts parts once each, not their moving pieces', () => {
    const nodes = [
      hardwarePartNode({ kind: 'bearing', size: '608' }, 'b1'),
      hardwarePartNode({ kind: 'bearing', size: '608' }, 'b2'),
      hardwarePartNode({ kind: 'screw', size: 'M3', lengthMm: 12 }, 's1'),
    ];
    const list = hardwareList({ nodes } as SceneGraph);
    expect(list.rows.find((r) => r.name === '608 bearing')?.count).toBe(2);
    expect(list.rows).toHaveLength(2);
  });

  it('packs lengths onto the fewest bars, then the shortest bar that takes the last', () => {
    const { bars, tooLongMm } = packBars([900, 900, 500, 400, 2500], [2000, 1500, 1000]);
    expect(tooLongMm).toEqual([2500]);
    expect(bars.map((b) => b.lengthMm)).toEqual([2000, 1000]);
    expect(bars[0].cutsMm).toEqual([900, 900]);
  });
});

describe('in MuJoCo', () => {
  function run(scene: SceneGraph, seconds: number, before: (model: any, data: any) => void) {
    const model = mj.MjModel.from_xml_string(compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0));
    const data = new mj.MjData(model);
    before(model, data);
    const steps = Math.round(seconds / model.opt.timestep);
    for (let i = 0; i < steps; i++) mj.mj_step(model, data);
    return { model, data, done: () => { data.delete(); model.delete(); } };
  }
  const qposOf = (r: { model: any; data: any }, joint: string) => r.data.qpos[r.model.jnt_qposadr[mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_JOINT.value, joint)]];

  it('stops an MGN12 carriage at both ends of a 300 mm rail', () => {
    for (const sign of [1, -1]) {
      const base = body('base', [{ type: 'box', size: [0.2, 0.03, 0.005], pos: [0, 0, 0] }]);
      const group = cut(base, { kind: 'rail_seat', size: 'MGN12', lengthMm: 300, at: [0, 0, 0.005] });
      const rail = hardwarePartNode({ kind: 'mgn_rail', size: 'MGN12' }, 'rail');
      base.children.push(rail);
      seatPart(rail, base, group);
      // Flung at the end: it gets there, and no further, whatever it does after.
      const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [base] } as SceneGraph, -9.81, 1, 0, 0, 0, 0));
      const data = new mj.MjData(model);
      const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'rail_travel');
      // About as hard as a hand flings one.
      data.qvel[model.jnt_dofadr[j]] = sign * 0.5;
      let furthest = 0;
      for (let i = 0; i < Math.round(1 / model.opt.timestep); i++) {
        mj.mj_step(model, data);
        furthest = Math.max(furthest, sign * data.qpos[model.jnt_qposadr[j]]);
      }
      const travel = (300 - MGN.MGN12.block[0]) / 2000;
      expect(furthest).toBeGreaterThan(travel - 0.002);
      expect(furthest).toBeLessThan(travel + 0.001);
      data.delete();
      model.delete();
    }
  }, 60_000);

  it('pulls a drawer out its runners\' length and no further', () => {
    const { scene, drawer } = cabinetAndDrawer(400 - 2 * RUNNER_SIDE_SPACE_MM);
    let n = 0;
    addDrawerRunners(scene, drawer.id, () => `run${n++}`);
    const r = run(scene, 2, (model, data) => {
      // Pulled out of the open side, -Y, hard enough to reach the stops.
      const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'drawer');
      data.xfrc_applied[id * 6 + 1] = -20;
    });
    const id = mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_BODY.value, 'drawer');
    const y = r.data.xpos[id * 3 + 1];
    const startY = -0.225 + 0.22;
    expect(startY - y).toBeGreaterThan(0.38);
    expect(startY - y).toBeLessThan(0.42);
    r.done();
  }, 60_000);
});
