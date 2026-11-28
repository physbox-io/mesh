import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { breakageCommands } from '../src/hooks/mcp/breakageCommands';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { useStore } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import { canCrumple } from '../src/utils/breakThresholds';
import { buildBreakModel } from '../src/utils/breakModel';
import { isJoinBlob, joinMaterial } from '../src/utils/joinMaterials';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const makeCtx = () => ({
  store: useStore.getState(),
  respond: () => {},
});

describe('Bug 1 & 2: SET_CRUMPLE rejects ball, free, and slide joints', () => {
  beforeEach(() => {
    useStore.setState({
      sceneGraph: {
        nodes: [
          {
            id: 'ball_body', name: 'ball_body', pos: [0, 0, 1],
            geoms: [{ name: 'ball_g', type: 'box', size: [0.1, 0.1, 0.1], mass: 1 }],
            joints: [{ name: 'ball_j', type: 'ball', pos: [0, 0, 0] }],
            children: [],
          },
          {
            id: 'free_body', name: 'free_body', pos: [0, 0, 1],
            geoms: [{ name: 'free_g', type: 'box', size: [0.1, 0.1, 0.1], mass: 1 }],
            joints: [{ name: 'free_j', type: 'free' }],
            children: [],
          },
          {
            id: 'slide_body', name: 'slide_body', pos: [0, 0, 1],
            geoms: [{ name: 'slide_g', type: 'box', size: [0.1, 0.1, 0.1], mass: 1 }],
            joints: [{ name: 'slide_j', type: 'slide', axis: [0, 0, 1] }],
            children: [],
          },
          {
            id: 'hinge_body', name: 'hinge_body', pos: [0, 0, 1],
            geoms: [{ name: 'hinge_g', type: 'box', size: [0.1, 0.1, 0.1], mass: 1 }],
            joints: [{ name: 'hinge_j', type: 'hinge', axis: [0, 1, 0] }],
            children: [],
          },
        ],
      },
    });
  });

  it('refuses ball, free, and slide joints when jointName is explicit', async () => {
    for (const [targetId, jointName, kind] of [
      ['ball_body', 'ball_j', 'ball'],
      ['free_body', 'free_j', 'free'],
      ['slide_body', 'slide_j', 'slide'],
    ] as const) {
      const res = await breakageCommands.SET_CRUMPLE(
        { targetId, jointName, crumpleTorqueNm: 5, crumpleRangeDeg: [0, 45] },
        makeCtx(),
      ) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toContain(kind);
    }
  });

  it('refuses ball, free, and slide joints when jointName is omitted', async () => {
    for (const targetId of ['ball_body', 'free_body', 'slide_body']) {
      const res = await breakageCommands.SET_CRUMPLE(
        { targetId, crumpleTorqueNm: 5, crumpleRangeDeg: [0, 45] },
        makeCtx(),
      ) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/hinge/i);
    }
  });

  it('accepts hinge joints with or without explicit jointName', async () => {
    const res = await breakageCommands.SET_CRUMPLE(
      { targetId: 'hinge_body', jointName: 'hinge_j', crumpleTorqueNm: 5, crumpleRangeDeg: [0, 45] },
      makeCtx(),
    ) as { ok: boolean; joint?: string; crumpleTorqueNm?: number; crumpleRangeDeg?: [number, number] };
    expect(res.ok).toBe(true);
    expect(res.joint).toBe('hinge_j');
    expect(res.crumpleTorqueNm).toBe(5);
    expect(res.crumpleRangeDeg).toEqual([0, 45]);
  });

  it('canCrumple returns false for slide/ball/free joints and MJCF ignores stray crumpleRangeDeg on slide', () => {
    expect(canCrumple({ type: 'hinge', crumpleTorqueNm: 5 })).toBe(true);
    expect(canCrumple({ type: 'slide', crumpleTorqueNm: 5 })).toBe(false);
    expect(canCrumple({ type: 'ball', crumpleTorqueNm: 5 })).toBe(false);
    expect(canCrumple({ type: 'free', crumpleTorqueNm: 5 })).toBe(false);

    const scene: SceneGraph = {
      nodes: [{
        id: 's', name: 's', pos: [0, 0, 1],
        geoms: [{ name: 'sg', type: 'box', size: [0.1, 0.1, 0.1], mass: 1 }],
        joints: [{
          name: 'sj', type: 'slide', axis: [0, 0, 1],
          crumpleTorqueNm: 5, crumpleRangeDeg: [0, 80],
        }],
        children: [],
      }],
    };
    const xml = compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0);
    expect(xml).not.toContain('range="0 80"');
  });
});

describe('Bug 3: Rotated isComposite cable with weldLastToId', () => {
  const sims: Sim[] = [];
  afterAll(() => { sims.forEach((s) => s.dispose()); });

  it('transforms slack cable vertices and gravity sag into rotated cable local frame and lands B_last on target', async () => {
    // Cable starts at [0, 0, 1.5], rotated 90 deg about Z (euler [0, 0, 90]),
    // and welds its last segment to an anchor at [1.0, 0, 1.5] with length 1.3 m.
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'anchor_end', name: 'anchor_end', pos: [1.0, 0, 1.5],
          geoms: [{ name: 'ae_g', type: 'sphere', size: [0.04] }],
          joints: [], children: [],
        },
        {
          id: 'cable', name: 'cable', pos: [0, 0, 1.5], euler: [0, 0, 90],
          isComposite: true, compositeType: 'cable',
          compositeCount: '11 1 1', compositeSize: '1.3', compositePrefix: 'cab_',
          weldLastToId: 'anchor_end',
          geoms: [{ name: 'cab_g', type: 'capsule', size: [0.012], rgba: [0.76, 0.56, 0.34, 1] }],
          joints: [{ name: 'cab_j', type: 'hinge', damping: 0.05, stiffness: 0 }],
          children: [],
        },
      ],
    };

    const sim = await simulate(scene);
    sims.push(sim);

    // Check vertices in XML: world delta is (+1, 0, 0). Under +90 deg Z rotation,
    // local +X points to world +Y, local -Y points to world +X -> end vertex in local frame is (0, -1, 0).
    const match = sim.xml.match(/vertex="([^"]+)"/);
    expect(match).not.toBeNull();
    const nums = match![1].split(/\s+/).map(Number);
    const lastIdx = nums.length - 3;
    expect(nums[lastIdx]).toBeCloseTo(0, 3);
    expect(nums[lastIdx + 1]).toBeCloseTo(-1, 3);
    expect(nums[lastIdx + 2]).toBeCloseTo(0, 3);

    // Midpoint vertex must sag along local -Z (same as world -Z for Z-rotation).
    const midIdx = Math.floor(nums.length / 6) * 3;
    expect(nums[midIdx + 2]).toBeLessThan(-0.2);

    // In MuJoCo WASM, B_last's body origin sits at vertex n-2 (one segment back from
    // vertex n-1 = anchor_end; for a 10-segment 1.3m parabolic sag over 1m span, the
    // steep end segment is ~0.169m long, vs ~1.41m if rotation were ignored).
    const bLast0 = sim.bodyPos('cab_B_last');
    expect(Math.hypot(bLast0[0] - 1.0, bLast0[1] - 0, bLast0[2] - 1.5)).toBeLessThan(0.18);

    sim.run(0.3);
    const bLastAfter = sim.bodyPos('cab_B_last');
    expect(Math.hypot(bLastAfter[0] - 1.0, bLastAfter[1] - 0, bLastAfter[2] - 1.5)).toBeLessThan(0.18);
  }, 60_000);

  it('accounts for rotated parent frame and tilts gravity sag properly', async () => {
    // Parent at [0, 0, 1.5] rotated 90 deg about Y (euler [0, 90, 0]):
    // parent local +X maps to world -Z, parent local +Z maps to world +X.
    // Child cable at local [0, 0, 0.2] -> world [0.2, 0, 1.5], with parent quat.
    // Anchor at world [1.2, 0, 1.5]. Span = 1.0 m along world +X, length = 1.3 m.
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'anchor_p', name: 'anchor_p', pos: [1.2, 0, 1.5],
          geoms: [{ name: 'ap_g', type: 'sphere', size: [0.04] }],
          joints: [], children: [],
        },
        {
          id: 'rot_parent', name: 'rot_parent', pos: [0, 0, 1.5], euler: [0, 90, 0],
          geoms: [{ name: 'rp_g', type: 'box', size: [0.04, 0.04, 0.04] }],
          joints: [],
          children: [{
            id: 'child_cable', name: 'child_cable', pos: [0, 0, 0.2],
            isComposite: true, compositeType: 'cable',
            compositeCount: '11 1 1', compositeSize: '1.3', compositePrefix: 'cc_',
            weldLastToId: 'anchor_p',
            geoms: [{ name: 'cc_g', type: 'capsule', size: [0.012] }],
            joints: [{ name: 'cc_j', type: 'hinge', damping: 0.05, stiffness: 0 }],
            children: [],
          }],
        },
      ],
    };

    const sim = await simulate(scene);
    sims.push(sim);

    const bLast = sim.bodyPos('cc_B_last');
    expect(Math.hypot(bLast[0] - 1.2, bLast[1] - 0, bLast[2] - 1.5)).toBeLessThan(0.18);

    // Midpoint body (cc_B_5) must sag DOWNWARD in world Z (below 1.5), not sideways in X/Y.
    const bMid = sim.bodyPos('cc_B_5');
    expect(bMid[2]).toBeLessThan(1.3);
    expect(Math.abs(bMid[1])).toBeLessThan(0.05);
  }, 60_000);
});

describe('Bug 4: Crumple on a hinge with existing range prefers crumpleRangeDeg', () => {
  let sim: Sim | null = null;
  afterAll(() => { sim?.dispose(); });

  it('overrides prior range and limited=false with crumpleRangeDeg in MJCF and MuJoCo WASM', async () => {
    const scene: SceneGraph = {
      nodes: [{
        id: 'post', name: 'post', pos: [0, 0, 0.5],
        geoms: [{ name: 'post_g', type: 'box', size: [0.04, 0.04, 0.5], mass: 5 }],
        joints: [],
        children: [{
          id: 'arm', name: 'arm', pos: [0.04, 0, 0.4],
          geoms: [{ name: 'arm_g', type: 'box', size: [0.28, 0.03, 0.02], pos: [0.35, 0, 0], mass: 6 }],
          joints: [{
            name: 'arm_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.05,
            limited: false,
            range: [-10, 10],
            crumpleTorqueNm: 3,
            crumpleRangeDeg: [0, 65],
            crumpleDampingAfter: 20,
          }],
          children: [],
        }],
      }],
    };

    const xml = compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toContain('limited="true"');
    expect(xml).toContain('range="0 65"');
    expect(xml).not.toContain('range="-10 10"');

    sim = await simulate(scene);
    // Release the crumple lock and verify it folds well past the old 10 deg limit, stopping at ~65 deg.
    sim.data.eq_active[0] = 0;
    sim.run(1.5);
    const angleDeg = (sim.jointPos('arm_hinge') * 180) / Math.PI;
    expect(angleDeg).toBeGreaterThan(25);
    expect(angleDeg).toBeLessThanOrEqual(65 + 3);
  }, 60_000);
});

describe('Bug 5: fillBodyDefaults for joinMaterial (putty) and isComposite (cable) without geoms', () => {
  const sims: Sim[] = [];
  afterAll(() => { sims.forEach((s) => s.dispose()); });

  it('synthesizes default putty ellipsoid when joinMaterial is set and geoms is omitted', () => {
    const putty = fillBodyDefaults({ id: 'blob1', joinMaterial: 'putty', pos: [0, 0, 100] });
    const mat = joinMaterial('putty')!;
    expect(putty.geoms).toHaveLength(1);
    expect(putty.geoms[0].type).toBe('ellipsoid');
    expect(putty.geoms[0].size).toEqual([0.006, 0.006, 0.006]);
    expect(putty.geoms[0].density).toBe(mat.density);
    expect(putty.geoms[0].rgba).toEqual(mat.rgba);
    expect(isJoinBlob(putty)).toBe(true);

    const glue = fillBodyDefaults({ id: 'glue1', joinMaterial: 'hotGlue', pos: [0, 0, 100] });
    const glueMat = joinMaterial('hotGlue')!;
    expect(glue.geoms[0].type).toBe('ellipsoid');
    expect(glue.geoms[0].density).toBe(glueMat.density);
    expect(glue.geoms[0].rgba).toEqual(glueMat.rgba);
    expect(isJoinBlob(glue)).toBe(true);
  });

  it('synthesizes default cable capsule when isComposite is true and geoms is omitted', () => {
    const cable = fillBodyDefaults({
      id: 'cab1', isComposite: true, compositeType: 'cable',
      compositeCount: '8 1 1', compositeSize: '0.8', pos: [0, 0, 1000],
    });
    expect(cable.geoms).toHaveLength(1);
    expect(cable.geoms[0].type).toBe('capsule');
    expect(cable.geoms[0].size).toEqual([0.012]);
    expect(cable.geoms[0].rgba).toEqual([0.76, 0.56, 0.34, 1]);
  });

  it('simulates both default putty blob (attaching a rod) and default cable in MuJoCo WASM', async () => {
    const puttyNode = fillBodyDefaults({ id: 'putty_node', joinMaterial: 'putty', pos: [0, 0, 200], fixed: true });
    const rodNode = fillBodyDefaults({
      id: 'rod_node', pos: [0, 0, 200],
      geoms: [{ type: 'capsule', fromto: [0, 0, 0, 100, 0, 0], size: [2], density: 1200 }],
    });
    const puttySim = await simulate({ nodes: [puttyNode, rodNode] });
    sims.push(puttySim);
    expect(puttySim.xml).toContain('<connect name="pin:putty_node&gt;rod_node"');
    puttySim.run(0.2);
    // Rod should stay attached near z=0.2 (not fall to floor).
    expect(puttySim.bodyPos('rod_node')[2]).toBeGreaterThan(0.1);

    const cableNode = fillBodyDefaults({
      id: 'cable_node', isComposite: true, compositeType: 'cable',
      compositeCount: '8 1 1', compositeSize: '0.8', pos: [0, 0, 1000],
    });
    const cableSim = await simulate({ nodes: [cableNode] });
    sims.push(cableSim);
    expect(cableSim.xml).toContain('type="capsule" size="0.012"');
    cableSim.run(0.1);
    expect(Number.isFinite(cableSim.bodyPos('cable_node_B_last')[2])).toBe(true);
  }, 60_000);
});

describe('Bug 6: Putty pressedInto supports mesh geoms without renderVertices and respects geom local pos/quat', () => {
  const makePutty = (pos: [number, number, number]): SceneNode => ({
    id: 'blob', name: 'blob', pos,
    joinMaterial: 'putty',
    geoms: [{ name: 'blob_g', type: 'ellipsoid', size: [0.02, 0.02, 0.02], density: 1800 }],
    joints: [], children: [],
  });

  it('falls back to Y-up vertices when renderVertices is absent', () => {
    // Y-up vertex (0, 0.1, 0) maps to MuJoCo Z-up (0, 0, 0.1) — right at the blob centre!
    const meshBody: SceneNode = {
      id: 'mesh_only_verts', name: 'mesh_only_verts', pos: [0, 0, 0],
      geoms: [{
        name: 'm_g', type: 'mesh', size: [1],
        vertices: [
          0, 0.1, 0,
          0.05, 0.1, 0,
          0, 0.15, 0,
          0, 0.1, 0.05,
        ],
        faces: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
      }],
      joints: [{ name: 'm_free', type: 'free' }],
      children: [],
    };
    const breaks = buildBreakModel([makePutty([0, 0, 0.1]), meshBody]);
    expect(breaks.equality.some((e) => e.includes('pin:blob&gt;mesh_only_verts') || e.includes('pin:blob>mesh_only_verts'))).toBe(true);
  });

  it('applies geom local pos and euler/quat before testing against the putty blob', () => {
    // Vertex in geom-local Z-up is at [0.1, 0, 0].
    // With geom local euler [0, 0, 90] and local pos [0, 0, 0.05], world point is [0, 0.1, 0.05].
    const meshHit: SceneNode = {
      id: 'mesh_xform_hit', name: 'mesh_xform_hit', pos: [0, 0, 0],
      geoms: [{
        name: 'mh_g', type: 'mesh', size: [1],
        pos: [0, 0, 0.05],
        euler: [0, 0, 90],
        renderVertices: [0.1, 0, 0, 0.2, 0, 0, 0.1, 0.1, 0],
        faces: [0, 1, 2],
      }],
      joints: [{ name: 'mh_free', type: 'free' }],
      children: [],
    };
    const hitBreaks = buildBreakModel([makePutty([0, 0.1, 0.05]), meshHit]);
    expect(hitBreaks.equality.length).toBe(1);
    expect(hitBreaks.equality[0]).toContain('mesh_xform_hit');

    // Without the local transform, [0.1, 0, 0] would have hit a blob at [0.1, 0, 0];
    // WITH the local transform, the mesh moved away from [0.1, 0, 0] so it must NOT attach.
    const missBreaks = buildBreakModel([makePutty([0.1, 0, 0]), meshHit]);
    expect(missBreaks.equality).toHaveLength(0);
  });
});
