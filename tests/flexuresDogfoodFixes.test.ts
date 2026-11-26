import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';
import {
  applyFlexureToNode,
  bendLeafPoint,
  buildFlexureGeoms,
  evaluateFlexureSpec,
} from '../src/utils/flexure';
import { analyseDfm } from '../src/utils/dfm';
import { hardwareCutGeoms, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { useStore } from '../src/store/useStore';
import { compliantFlexuresPreset } from '../src/presets/compliantFlexures';

/** Computes the 8 world/body-frame corners of an oriented box geom. */
function boxCorners(g: SceneGeom): THREE.Vector3[] {
  const pos = new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0);
  const q = g.quat && g.quat.length === 4
    ? new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]).normalize()
    : new THREE.Quaternion();
  const [hx, hy, hz] = [g.size?.[0] ?? 0, g.size?.[1] ?? 0, g.size?.[2] ?? 0];
  const corners: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(new THREE.Vector3(sx * hx, sy * hy, sz * hz).applyQuaternion(q).add(pos));
      }
    }
  }
  return corners;
}

describe('Compliant Flexures & Snap-Fits Dogfooding Fixes', () => {
  // -------------------------------------------------------------------------
  // Bug 1: Serpentine flexure with even folds drives anchor pads into moving body
  // -------------------------------------------------------------------------
  describe('1. Serpentine anchor pad clearance for even and odd folds', () => {
    const makeSlider = (): SceneNode => ({
      id: 'stage',
      name: 'Stage',
      pos: [0, 0, 0.03],
      geoms: [{ name: 'shuttle', type: 'box', size: [0.012, 0.016, 0.008] }],
      joints: [{ name: 'stage_slide', type: 'slide', axis: [0, 1, 0], pos: [0, 0, 0] }],
      children: [],
    });

    it.each([2, 3, 4, 5, 6])('keeps fixed anchor pads completely outside the moving body for folds=%i', (folds) => {
      const res = applyFlexureToNode(makeSlider(), {
        kind: 'serpentine',
        filament: 'petg',
        thicknessMm: 1.0,
        lengthMm: 18,
        widthMm: 8,
        folds,
      });
      expect(res).not.toBeNull();
      const { node } = res!;
      const bodyHalfX = 0.012;
      const anchors = node.geoms.filter((g) => g.name.startsWith('flexure_anchor_'));
      expect(anchors).toHaveLength(2);

      for (const anchor of anchors) {
        expect(anchor.bend).toBeDefined();
        expect(anchor.bend!.w0).toBe(0);
        expect(anchor.bend!.w1).toBe(0);
        // Every corner of the anchor pad must stay strictly outside the moving body's X face (with clearance >= 1.5 mm)
        const minAbsX = Math.min(...boxCorners(anchor).map((c) => Math.abs(c.x)));
        expect(minAbsX).toBeGreaterThanOrEqual(bodyHalfX + 0.0014);

        // Even at full slide travel ±q, bendLeafPoint keeps the fixed anchor strictly outside the body's X span
        const maxQ = (node.flexure!.maxTravel / 1000);
        for (const q of [-maxQ, maxQ]) {
          const fromMoved = bendLeafPoint(anchor.bend!.from as [number, number, number], anchor.bend!, node.joints[0], q);
          const toMoved = bendLeafPoint(anchor.bend!.to as [number, number, number], anchor.bend!, node.joints[0], q);
          expect(Math.abs(fromMoved[0])).toBeGreaterThanOrEqual(bodyHalfX + 0.0014);
          expect(Math.abs(toMoved[0])).toBeGreaterThanOrEqual(bodyHalfX + 0.0014);
        }
      }
    });

    it('uses default folds=4 without penetrating the moving body', () => {
      const res = applyFlexureToNode(makeSlider(), { kind: 'serpentine', filament: 'petg' });
      expect(res).not.toBeNull();
      expect(res!.evaluation.spec.folds).toBe(4);
      const anchors = res!.node.geoms.filter((g) => g.name.startsWith('flexure_anchor_'));
      expect(anchors).toHaveLength(2);
      for (const anchor of anchors) {
        const minAbsX = Math.min(...boxCorners(anchor).map((c) => Math.abs(c.x)));
        expect(minAbsX).toBeGreaterThan(0.012 + 0.0014);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Bug 2: UPDATE_OBJECT supports flexure add/update/remove and validates errors
  // -------------------------------------------------------------------------
  describe('2. UPDATE_OBJECT flexure lifecycle', () => {
    const makeCtx = () => ({ store: useStore.getState(), send: vi.fn() } as unknown as Parameters<typeof objectCommands.UPDATE_OBJECT>[1]);

    beforeEach(() => {
      const recompileSpy = vi.fn(async () => {});
      const hinged: SceneNode = {
        id: 'hinge_arm',
        name: 'Hinge Arm',
        pos: [0, 0, 0.05],
        geoms: [{ name: 'arm_box', type: 'box', size: [0.02, 0.01, 0.004], pos: [0.02, 0, 0] }],
        joints: [{ name: 'arm_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0] }],
        children: [],
      };
      const fixedBox: SceneNode = {
        id: 'fixed_block',
        name: 'Fixed Block',
        pos: [0.1, 0, 0.02],
        geoms: [{ name: 'block', type: 'box', size: [0.02, 0.02, 0.02] }],
        joints: [],
        children: [],
      };
      useStore.setState({
        sceneGraph: { nodes: [hinged, fixedBox] },
        recompile: recompileSpy,
        lastCompileError: null,
      } as unknown as Partial<ReturnType<typeof useStore.getState>>);
    });

    it('applies, updates, and cleanly reverts flexure via UPDATE_OBJECT', async () => {
      // 1. Apply flexure to hinged body
      const applyRes = (await objectCommands.UPDATE_OBJECT(
        {
          targetId: 'hinge_arm',
          updates: { flexure: { kind: 'blade', filament: 'petg', thicknessMm: 1.0, lengthMm: 14, widthMm: 10 } },
        },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(applyRes.ok).toBe(true);

      let arm = useStore.getState().sceneGraph.nodes[0];
      expect(arm.flexure?.kind).toBe('blade');
      expect(arm.flexure?.thicknessMm).toBe(1.0);
      expect(arm.geoms.some((g) => g.name.startsWith('flexure_'))).toBe(true);
      expect(arm.joints[0].stiffness).toBeGreaterThan(0);
      expect(arm.joints[0].limited).toBe(true);
      const initialStiffness = arm.joints[0].stiffness!;

      // 2. Partial update merges with existing flexure and recalculates stiffness
      const patchRes = (await objectCommands.UPDATE_OBJECT(
        {
          targetId: 'hinge_arm',
          updates: { flexure: { thicknessMm: 1.4 } },
        },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(patchRes.ok).toBe(true);
      arm = useStore.getState().sceneGraph.nodes[0];
      expect(arm.flexure?.kind).toBe('blade');
      expect(arm.flexure?.thicknessMm).toBe(1.4);
      expect(arm.joints[0].stiffness).toBeGreaterThan(initialStiffness);

      // 3. Passing flexure: null calls revertFlexure and removes flexure geoms & joint spring params
      const revertRes = (await objectCommands.UPDATE_OBJECT(
        {
          targetId: 'hinge_arm',
          updates: { flexure: null },
        },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(revertRes.ok).toBe(true);
      arm = useStore.getState().sceneGraph.nodes[0];
      expect(arm.flexure).toBeUndefined();
      expect(arm.geoms.some((g) => g.name.startsWith('flexure_'))).toBe(false);
      expect(arm.joints[0].stiffness).toBe(0);
      expect(arm.joints[0].damping).toBe(0);
      expect(arm.joints[0].limited).toBe(false);
      expect(arm.joints[0].range).toBeUndefined();
    });

    it('rejects flexure on non-jointed bodies and rejects invalid kind or filament', async () => {
      const noJoint = (await objectCommands.UPDATE_OBJECT(
        { targetId: 'fixed_block', updates: { flexure: { kind: 'blade', filament: 'petg' } } },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(noJoint.ok).toBe(false);
      expect(noJoint.error).toMatch(/hinge.*slide/i);

      const badKind = (await objectCommands.UPDATE_OBJECT(
        { targetId: 'hinge_arm', updates: { flexure: { kind: 'serpentine', filament: 'petg' } } },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(badKind.ok).toBe(false);
      expect(badKind.error).toMatch(/serpentine.*hinge/i);

      const badFilament = (await objectCommands.UPDATE_OBJECT(
        { targetId: 'hinge_arm', updates: { flexure: { kind: 'blade', filament: 'unobtanium' } } },
        makeCtx(),
      )) as { ok: boolean; error?: string };
      expect(badFilament.ok).toBe(false);
      expect(badFilament.error).toMatch(/unobtanium/i);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 3: fillBodyDefaults validates flexure joint compatibility & filament
  // -------------------------------------------------------------------------
  describe('3. fillBodyDefaults flexure validation', () => {
    it('throws when flexure is placed on a body without a hinge or slide joint', () => {
      expect(() =>
        fillBodyDefaults({
          id: 'static_flex',
          name: 'Static Flex',
          geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
          joints: [],
          flexure: { kind: 'blade', filament: 'petg' },
        }),
      ).toThrow(/hinge.*slide/i);

      expect(() =>
        fillBodyDefaults({
          id: 'free_flex',
          name: 'Free Flex',
          geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
          joints: [{ type: 'free' }],
          flexure: { kind: 'blade', filament: 'petg' },
        }),
      ).toThrow(/hinge.*slide/i);
    });

    it('throws when flexure kind is incompatible with the joint type or filament is unsupported', () => {
      expect(() =>
        fillBodyDefaults({
          id: 'bad_kind_hinge',
          name: 'Bad Kind Hinge',
          geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
          joints: [{ name: 'j', type: 'hinge', axis: [0, 1, 0] }],
          flexure: { kind: 'bistable', filament: 'petg' },
        }),
      ).toThrow(/bistable.*hinge/i);

      expect(() =>
        fillBodyDefaults({
          id: 'bad_kind_slide',
          name: 'Bad Kind Slide',
          geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
          joints: [{ name: 'j', type: 'slide', axis: [0, 1, 0] }],
          flexure: { kind: 'cross_pivot', filament: 'petg' },
        }),
      ).toThrow(/cross_pivot.*slide/i);

      expect(() =>
        fillBodyDefaults({
          id: 'bad_fil',
          name: 'Bad Filament',
          geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
          joints: [{ name: 'j', type: 'hinge', axis: [0, 1, 0] }],
          flexure: { kind: 'blade', filament: 'nylon' },
        }),
      ).toThrow(/nylon/i);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 4: Cross-pivot strip clear separation >= 0.4 mm at narrow widths
  // -------------------------------------------------------------------------
  describe('4. Cross-pivot narrow width strip separation', () => {
    it('raises minimum widthMm for cross_pivot to 4.0 mm in evaluateFlexureSpec', () => {
      const ev = evaluateFlexureSpec({ kind: 'cross_pivot', widthMm: 2.0, filament: 'petg' }, 'hinge');
      expect(ev.spec.widthMm).toBe(4.0);
    });

    it.each([2.0, 3.0, 4.0, 5.0, 8.0])('guarantees >= 0.4 mm axial gap between crossed leaves at widthMm=%f', (widthMm) => {
      const joint = { name: 'j', type: 'hinge' as const, axis: [0, 1, 0], pos: [0, 0, 0] };
      const ev = evaluateFlexureSpec({ kind: 'cross_pivot', widthMm, filament: 'petg' }, 'hinge');
      // Also test direct buildFlexureGeoms with raw narrow widthMm to verify geometry guard
      const geoms = buildFlexureGeoms(joint, { ...ev.spec, widthMm });
      expect(geoms).toHaveLength(2);
      const [g0, g1] = geoms;
      // Joint axis is +Y; each leaf's Y center is pos[1] and Y half-extent is size[2] (halfWidth = halfB * 0.5)
      const c0 = g0.pos![1];
      const c1 = g1.pos![1];
      const halfExtent0 = g0.size![2];
      const halfExtent1 = g1.size![2];
      const clearGapM = Math.abs(c1 - c0) - halfExtent0 - halfExtent1;
      expect(clearGapM).toBeGreaterThanOrEqual(0.0004 - 1e-6);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 5: DFM catches localized 90° flat overhangs on upright snap_hook lips
  // -------------------------------------------------------------------------
  describe('5. DFM detects upright snap_hook catch-lip 90° overhangs', () => {
    function buildLidWithHook(size: 'S' | 'M' | 'L', upright = true): SceneGraph {
      const node: SceneNode = {
        id: 'lid',
        name: 'Enclosure Lid',
        pos: [0, 0, 0],
        csgEnabled: true,
        geoms: [{ name: 'plate', type: 'box', size: [0.03, 0.03, 0.005], pos: [0, 0, 0.005] }],
        joints: [],
        children: [],
      };
      const spec: HardwareCutSpec = upright
        ? { group: 'snap1', kind: 'snap_hook', size, at: [0, 0, 0.01], normal: [0, 0, 1] }
        : { group: 'snap1', kind: 'snap_hook', size, at: [0.03, 0, 0.005], normal: [1, 0, 0], quarter: 0 };
      const pieces = hardwareCutGeoms(spec, node.id, node);
      for (const piece of pieces) {
        node.geoms.push(piece);
        Object.assign(piece, cutGeometry(node, piece));
      }
      return { nodes: [node] };
    }

    it.each(['S', 'M', 'L'] as const)('flags upright size-%s snap_hook catch lip on a large lid as a warning', (size) => {
      const report = analyseDfm(buildLidWithHook(size, true), 'print', { asPlaced: true, filament: 'pla' });
      const severe = report.findings.find((f) => f.id === 'print_severe_overhang');
      expect(severe).toBeDefined();
      expect(severe!.severity).toBe('warning');
      expect(severe!.detail).toMatch(/90°/);
    });

    it('stays quiet when a lid has no upright flat overhang ledge', () => {
      const plainLid: SceneGraph = {
        nodes: [{
          id: 'plain_lid',
          name: 'Plain Lid',
          pos: [0, 0, 0],
          geoms: [{ name: 'plate', type: 'box', size: [0.03, 0.03, 0.005], pos: [0, 0, 0.005] }],
          joints: [],
          children: [],
        }],
      };
      const report = analyseDfm(plainLid, 'print', { asPlaced: true, filament: 'pla' });
      expect(report.findings.find((f) => f.id === 'print_severe_overhang')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Bug 6: compliantFlexuresPreset bistable arch meets PETG wall & SF >= 1.0
  // -------------------------------------------------------------------------
  describe('6. compliantFlexuresPreset bistable arch specs', () => {
    it('meets PETG minWallMm (>= 0.9 mm), has safetyFactor >= 1.0, and produces zero flexure warnings', () => {
      const frame = compliantFlexuresPreset.nodes[0];
      const bistable = frame.children.find((c) => c.id === 'bistable_toggle_shuttle');
      expect(bistable).toBeDefined();
      expect(bistable!.flexure).toBeDefined();
      expect(bistable!.flexure!.thicknessMm).toBeGreaterThanOrEqual(0.9);

      const ev = evaluateFlexureSpec(bistable!.flexure!, 'slide');
      expect(ev.safetyFactor).toBeGreaterThanOrEqual(1.0);
      expect(ev.warnings).toEqual([]);
    });
  });
});
