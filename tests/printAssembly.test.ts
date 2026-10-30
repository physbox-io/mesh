// Split for Print's assembly test, in real MuJoCo and real Manifold.
//
// The point of these is that a split which will not go back together fails
// here, for the reason it would fail on the bench: a pin that does not find its
// hole holds the part a pin's length off its seat; a single pin lets it turn;
// two sections that overlap, overlap.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { checkSplit, splitForPrint, type SplitResult } from '../src/utils/printSplit';
import { buildAssemblyPlan, runAssembly, runStage, type MujocoLike } from '../src/utils/printAssembly';
import { compileToMJCF, PRINT_CONTACT_TIME } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

let wasm: ManifoldToplevel;
let mj: MujocoLike;
beforeAll(async () => {
  wasm = await loadManifold();
  mj = (await load_mujoco()) as unknown as MujocoLike;
}, 60_000);

/** An axis-aligned box as a triangle soup, metres, wound outward. Sizes in mm. */
function box(sx: number, sy: number, sz: number): Float64Array {
  const [x1, y1, z1] = [sx / 1000, sy / 1000, sz / 1000];
  const c = [[0, 0, 0], [x1, 0, 0], [x1, y1, 0], [0, y1, 0], [0, 0, z1], [x1, 0, z1], [x1, y1, z1], [0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return Float64Array.from(out);
}

const bed = { widthMm: 200, depthMm: 200, heightMm: 200 };
const compile = (scene: SceneGraph) => compileToMJCF(scene, -9.81, 0.3);
const split = (soup: Float64Array, kind: 'none' | 'dowel' | 'peg') => {
  const r = splitForPrint(wasm, [soup], { bed, joinery: { kind } });
  if (!r.ok) throw new Error(r.error);
  return r as Extract<SplitResult, { ok: true }>;
};

describe('assembly in MuJoCo', () => {
  it('seats a box split in two on two dowels, with about the clearance as play', () => {
    const r = split(box(300, 100, 100), 'dowel');
    const plan = buildAssemblyPlan(r);
    expect(plan.stages.map((s) => s.kind)).toEqual(['dowels', 'join']);
    // Each dowel stays with the section it was dropped into, for the replay.
    expect(plan.stages[0].moving.every((d) => d.host === r.joints[0].neg)).toBe(true);
    const report = runAssembly(mj, plan, compile);
    expect(report.ok).toBe(true);
    for (const s of report.stages) {
      expect(s.seated).toBe(true);
      expect(Math.abs(s.gapMm)).toBeLessThanOrEqual(0.1);
      expect(s.diverged).toBe(false);
    }
    const join = report.stages[1];
    expect(join.playMm).not.toBeNull();
    // Side to side, the whole diametral clearance and not much more.
    expect(join.playMm!).toBeGreaterThan(0.05);
    expect(join.playMm!).toBeLessThan(0.5);
    expect(join.rotates).toBe(false);
  }, 60_000);

  it('seats pegs in their holes', () => {
    const report = runAssembly(mj, buildAssemblyPlan(split(box(500, 120, 60), 'peg')), compile);
    expect(report.stages).toHaveLength(2);
    expect(report.ok).toBe(true);
  }, 60_000);

  it('stands a part off its seat by about a pin length when a hole is 2 mm out', () => {
    const r = split(box(300, 100, 100), 'dowel');
    const join = buildAssemblyPlan(r).stages[1];
    // Move one dowel 2 mm sideways: the incoming part's hole no longer lines up with it.
    const scene: SceneGraph = {
      ...join.scene,
      nodes: join.scene.nodes.map((n) => (n.name === 'dowel_0' ? { ...n, pos: [n.pos[0] + 0.002, n.pos[1], n.pos[2]] } : n)),
    };
    const result = runStage(mj, compile(scene), { ...join, scene });
    expect(result.seated).toBe(false);
    // It rides on the dowel: well clear of 0.1 mm, and no more than the 9.5 mm the dowel stands proud.
    expect(result.gapMm).toBeGreaterThan(3);
    expect(result.gapMm).toBeLessThan(10);
    expect(result.notes.join(' ')).toMatch(/short of its seat/);
  }, 60_000);

  it('flags a joint held by a single pin as free to turn', () => {
    // A 16 mm square face has room for one 6 mm dowel and no more.
    const r = split(box(300, 16, 16), 'dowel');
    expect(r.joints[0].pins).toHaveLength(1);
    const report = runAssembly(mj, buildAssemblyPlan(r), compile);
    const join = report.stages.find((s) => s.kind === 'join')!;
    expect(join.seated).toBe(true);
    expect(join.rotates).toBe(true);
    expect(join.notes.join(' ')).toMatch(/turn about its pin/);
  }, 60_000);

  it('seats a plain cut, with no limit on how far it slides', () => {
    const report = runAssembly(mj, buildAssemblyPlan(split(box(300, 100, 100), 'none')), compile);
    expect(report.stages).toHaveLength(1);
    const join = report.stages[0];
    expect(join.seated).toBe(true);
    expect(join.playMm).toBeNull();
    expect(join.ok).toBe(true);
  }, 60_000);
});

describe('a concave part, cut on the diagonal', () => {
  it('seats every joint of the wall bracket, enlarged and split for a 70 mm bed', async () => {
    // Its sections are L-shaped (collided as exact convex pieces, not hulls)
    // and one sits tall on a small diagonal face (held square, not toppled).
    const { partSoups } = await import('../src/utils/printSplitClient');
    const { latticeBracketPreset } = await import('../src/presets/latticeBracket');
    const soups = partSoups(latticeBracketPreset.nodes[0]).soups.map((s) => s.map((v) => v * 2));
    const r = splitForPrint(wasm, soups, { bed: { widthMm: 70, depthMm: 70, heightMm: 70 }, joinery: { kind: 'dowel' } });
    if (!r.ok) throw new Error(r.error);
    expect(r.sections.some((s) => s.convexPieces.length > 0)).toBe(true);
    const report = runAssembly(mj, buildAssemblyPlan(r), compile);
    for (const s of report.stages) {
      expect(s.diverged).toBe(false);
      expect(Math.abs(s.gapMm)).toBeLessThanOrEqual(0.1);
      expect(s.ok).toBe(true);
    }
  }, 120_000);

  it('seats every joint at 3x on a 100 mm bed, where holes from neighbouring faces meet at the corners', async () => {
    // Before holes kept clear of each other, and sockets met only their own
    // joint's pins, a lining here caught the next joint's dowel part way in.
    const { partSoups } = await import('../src/utils/printSplitClient');
    const { latticeBracketPreset } = await import('../src/presets/latticeBracket');
    const soups = partSoups(latticeBracketPreset.nodes[0]).soups.map((s) => s.map((v) => v * 3));
    const r = splitForPrint(wasm, soups, { bed: { widthMm: 100, depthMm: 100, heightMm: 100 }, joinery: { kind: 'dowel' } });
    if (!r.ok) throw new Error(r.error);
    const report = runAssembly(mj, buildAssemblyPlan(r), compile);
    for (const s of report.stages) expect(s.ok).toBe(true);
    // Its pinless slivers are between sections pinned elsewhere: nothing to warn about.
    expect(r.warnings.join(' ')).not.toMatch(/glue alone/);
    // And no two holes in a section come within a wall of each other.
    for (const sec of r.sections) {
      const bores = sec.features.filter((f) => f.kind === 'bore');
      for (let a = 0; a < bores.length; a++) {
        for (let b = a + 1; b < bores.length; b++) {
          if (bores[a].joint === bores[b].joint) continue;
          expect(segmentGapMm(bores[a], bores[b])).toBeGreaterThan(0);
        }
      }
    }
  }, 120_000);
});

/** Closest approach of two holes' walls, mm (negative when they cut into each other). */
function segmentGapMm(
  a: { at: number[]; axis: number[]; depth: number; radius: number },
  b: { at: number[]; axis: number[]; depth: number; radius: number },
): number {
  let best = Infinity;
  for (let i = 0; i <= 40; i++) {
    const p = a.at.map((v, k) => v + a.axis[k] * a.depth * (i / 40));
    for (let j = 0; j <= 40; j++) {
      const q = b.at.map((v, k) => v + b.axis[k] * b.depth * (j / 40));
      best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
  }
  return (best - a.radius - b.radius) * 1000;
}

describe('exact checks', () => {
  it('passes a clean split', () => {
    for (const kind of ['dowel', 'peg'] as const) {
      const soup = box(300, 100, 100);
      const r = split(soup, kind);
      const checks = checkSplit(wasm, r.sections, r.joints, [soup]);
      expect(checks.interferenceMm3).toBeLessThan(1e-3);
      expect(checks.reunionErrorMm3).toBeLessThan(1);
      expect(checks.misalignedPins).toBe(0);
      expect(checks.ok).toBe(true);
    }
  });

  it('catches a section nudged 1 mm into its neighbour', () => {
    const soup = box(300, 100, 100);
    const r = split(soup, 'dowel');
    const n = r.cuts[0].normal;
    // The section on the negative side, pushed 1 mm along the normal into the other.
    const neg = r.joints[0].neg;
    const nudged = r.sections.map((s, i) => {
      if (i !== neg) return s;
      const move = (p: Float32Array) => p.map((v, k) => v + n[k % 3] * 0.001);
      return { ...s, positions: move(s.positions), plainPositions: move(s.plainPositions) };
    });
    const checks = checkSplit(wasm, nudged, r.joints, [soup]);
    expect(checks.ok).toBe(false);
    // A 100 x 100 face pushed 1 mm in: about 10 000 mm³, less the holes.
    expect(checks.interferenceMm3).toBeGreaterThan(9000);
    expect(checks.worstPair).toEqual([0, 1].sort());
    expect(checks.reunionErrorMm3).toBeGreaterThan(1000);
  });
});

describe('print fidelity in the MJCF', () => {
  const scene: SceneGraph = {
    nodes: [{
      id: 'b', name: 'b', pos: [0, 0, 0.1], joints: [], children: [],
      geoms: [
        { name: 'g', type: 'box', size: [0.01, 0.01, 0.01] },
        { name: 'pin', type: 'cylinder', size: [0.003, 0.01], role: 'collision', contactClass: 'pin', contactGroup: 0 },
        { name: 'socket', type: 'box', size: [0.001, 0.001, 0.001], role: 'collision', contactClass: 'socket', contactGroup: 0 },
        { name: 'other_socket', type: 'box', size: [0.001, 0.001, 0.001], role: 'collision', contactClass: 'socket', contactGroup: 1 },
      ],
    }],
  };

  it('is stiff, and puts pins and sockets in their classes', () => {
    const xml = compileToMJCF({ ...scene, simFidelity: 'print' });
    expect(xml).toContain(`solref="${PRINT_CONTACT_TIME} 1"`);
    // A pin meets every pin (bit 2) and its own joint's sockets (bit 4 for joint 0);
    // a socket meets only its own joint's pins, and another joint's socket another bit.
    expect(xml).toMatch(/name="pin"[^>]*contype="6" conaffinity="2"/);
    expect(xml).toMatch(/name="socket"[^>]*contype="0" conaffinity="4"/);
    expect(xml).toMatch(/name="other_socket"[^>]*contype="0" conaffinity="8"/);
    expect(xml).toMatch(/name="floor"[^>]*contype="2147483647" conaffinity="2147483647"/);
    // Pins and sockets weigh nothing; the body does.
    expect(xml).toMatch(/name="pin"[^>]*mass="0"/);
  });

  it('leaves them inert in standard fidelity, and a scene without them untouched', () => {
    const xml = compileToMJCF(scene);
    expect(xml).toMatch(/name="pin"[^>]*contype="0" conaffinity="0"/);
    expect(xml).toContain('solref="0.02 1"');
    const plainScene: SceneGraph = { nodes: [{ ...scene.nodes[0], geoms: [scene.nodes[0].geoms[0]] }] };
    expect(compileToMJCF({ ...plainScene, simFidelity: 'standard' })).toBe(compileToMJCF(plainScene));
    expect(compileToMJCF(plainScene)).not.toMatch(/contype|conaffinity/);
  });

  it('collides a mesh with a collider source as that source, and draws it as itself', () => {
    const tri = (v: number[]) => v;
    const cube = (h: number) => tri([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h]);
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
    const yUp = (v: number[]) => v.flatMap((_, i) => (i % 3 ? [] : [v[i], v[i + 2], -v[i + 1]]));
    const meshScene: SceneGraph = {
      nodes: [{
        id: 'm', name: 'm', pos: [0, 0, 0.1], joints: [{ name: 'm_free', type: 'free' }], children: [],
        geoms: [{
          name: 'm_mesh', type: 'mesh', size: [1], dynamic: true, mass: 1,
          renderVertices: cube(0.02), vertices: yUp(cube(0.02)), faces,
          colliderVertices: cube(0.01), colliderFaces: faces,
        }],
      }],
    };
    const xml = compileToMJCF(meshScene);
    expect(xml).toMatch(/name="m_mesh"[^>]*contype="0" conaffinity="0"/);
    expect(xml).toMatch(/name="m_mesh_collider"[^>]*mass="1"/);
    expect(xml).toMatch(/<mesh name="m_mesh_collider"[^>]*vertex="-0.01 /);
  });
});
