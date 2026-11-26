import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildMechanism, type MechanismBuild } from '../src/utils/buildMechanism';
import { buildCamMechanism, type CamProfileKind } from '../src/utils/mechanismParts';
import { quatRotateVec } from '../src/utils/sceneTree';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => {
  mj = await load_mujoco();
}, 60_000);

const ok = (r: MechanismBuild | { error: string }): MechanismBuild => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

const find = (ns: SceneNode[], id: string): SceneNode | null => {
  for (const n of ns) {
    if (n.id === id) return n;
    const c = find(n.children || [], id);
    if (c) return c;
  }
  return null;
};

const walk = (ns: SceneNode[], fn: (n: SceneNode) => void) => {
  for (const n of ns) {
    fn(n);
    walk(n.children || [], fn);
  }
};

describe('Mechanisms & Drives dogfooding fixes', () => {
  // -------------------------------------------------------------------------
  // Bug 1: axis ignored in buildMechanism
  // -------------------------------------------------------------------------
  describe('1. axis rotation in buildMechanism', () => {
    it('rejects a zero-length axis vector', () => {
      const res = buildMechanism({ family: 'gear_pair', axis: [0, 0, 0] }, []);
      expect(res).toHaveProperty('error');
    });

    it('rotates gear_pair around origin to match arbitrary axis and runs in MuJoCo', () => {
      const origin: [number, number, number] = [0.1, 0.2, 0.3];
      const built = ok(
        buildMechanism(
          {
            family: 'gear_pair',
            driverTeeth: 16,
            drivenTeeth: 32,
            moduleMm: 1.5,
            origin,
            axis: [1, 0, 0],
            idPrefix: 'ax',
            speed: 6,
          },
          [],
        ),
      );
      const driver = find(built.nodes, 'gear_ax')!;
      const driven = find(built.nodes, 'gear_ax_2')!;

      // Driver sits at origin; its local +Z maps to world +X
      expect(driver.pos).toEqual(origin);
      expect(driver.quat).toBeDefined();
      const worldAxis = quatRotateVec(driver.quat!, [0, 0, 1]);
      expect(worldAxis[0]).toBeCloseTo(1, 5);
      expect(worldAxis[1]).toBeCloseTo(0, 5);
      expect(worldAxis[2]).toBeCloseTo(0, 5);

      // Driven was at +X relative to driver; rotating +Z -> +X (+90° around +Y) maps +X -> -Z
      const cdM = (built.metrics.centerDistanceMm as number) / 1000;
      expect(driven.pos[0]).toBeCloseTo(origin[0], 5);
      expect(driven.pos[1]).toBeCloseTo(origin[1], 5);
      expect(driven.pos[2]).toBeCloseTo(origin[2] - cdM, 5);

      // Verify in MuJoCo WASM: world joint axis is [1, 0, 0] and gears couple at -1/2
      const xml = compileToMJCF({ nodes: built.nodes } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
      const m = mj.MjModel.from_xml_string(xml);
      const d = new mj.MjData(m);
      try {
        mj.mj_forward(m, d);
        const j1 = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, 'gear_ax_hinge');
        const j2 = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, 'gear_ax_2_hinge');
        expect(d.xaxis[j1 * 3 + 0]).toBeCloseTo(1, 4);
        expect(d.xaxis[j1 * 3 + 1]).toBeCloseTo(0, 4);
        expect(d.xaxis[j1 * 3 + 2]).toBeCloseTo(0, 4);

        const act = mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, 'gear_ax_hinge_actuator');
        d.ctrl[act] = 6;
        for (let i = 0; i < 1000; i++) mj.mj_step(m, d);
        const w1 = d.qvel[m.jnt_dofadr[j1]];
        const w2 = d.qvel[m.jnt_dofadr[j2]];
        expect(Math.abs(w1)).toBeGreaterThan(4);
        expect(w2 / w1).toBeCloseTo(-0.5, 3);
      } finally {
        d.delete();
        m.delete();
      }
    });

    it('rotates four_bar root bodies and world-space connectAnchor cleanly for axis=[0,1,0] and [0,0,-1]', () => {
      for (const axis of [
        [0, 1, 0] as [number, number, number],
        [0, 0, -1] as [number, number, number],
        [1, 1, 0] as [number, number, number],
      ]) {
        const origin: [number, number, number] = [0, 0, 0.1];
        const built = ok(
          buildMechanism({ family: 'four_bar', origin, axis, idPrefix: 'fbax', speed: 2.5 }, []),
        );
        const crank = find(built.nodes, 'fourbar_crank_fbax')!;
        expect(crank.quat).toBeDefined();
        const len = Math.hypot(axis[0], axis[1], axis[2]);
        const expected = axis.map((v) => v / len);
        const worldAxis = quatRotateVec(crank.quat!, [0, 0, 1]);
        expect(worldAxis[0]).toBeCloseTo(expected[0], 5);
        expect(worldAxis[1]).toBeCloseTo(expected[1], 5);
        expect(worldAxis[2]).toBeCloseTo(expected[2], 5);

        // Compile and step in MuJoCo: verify crank spins and world hinge axis matches
        const xml = compileToMJCF({ nodes: built.nodes } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
        const m = mj.MjModel.from_xml_string(xml);
        const d = new mj.MjData(m);
        try {
          mj.mj_forward(m, d);
          const jCrank = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, 'fourbar_crank_fbax_hinge');
          expect(d.xaxis[jCrank * 3 + 0]).toBeCloseTo(expected[0], 4);
          expect(d.xaxis[jCrank * 3 + 1]).toBeCloseTo(expected[1], 4);
          expect(d.xaxis[jCrank * 3 + 2]).toBeCloseTo(expected[2], 4);

          const act = mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, 'fourbar_crank_fbax_hinge_actuator');
          d.ctrl[act] = 2.5;
          for (let i = 0; i < 400; i++) mj.mj_step(m, d);
          expect(Math.abs(d.qpos[m.jnt_qposadr[jCrank]])).toBeGreaterThan(0.5);
        } finally {
          d.delete();
          m.delete();
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Bug 2: Cam & Follower initial interpenetration
  // -------------------------------------------------------------------------
  describe('2. Cam & Follower zero initial interpenetration in MuJoCo', () => {
    for (const kind of ['eccentric', 'snail', 'heart', 'harmonic'] as CamProfileKind[]) {
      it(`${kind}: initialMinDist >= 0 at t=0 and preserves full lift span`, () => {
        const mech = buildCamMechanism({ kind, baseRadiusMm: 18, liftMm: 10, origin: [0, 0, 0.05] });
        const xml = compileToMJCF({ nodes: mech.nodes } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
        const m = mj.MjModel.from_xml_string(xml);
        const d = new mj.MjData(m);
        try {
          // Evaluate initial contacts before any stepping
          mj.mj_forward(m, d);
          let initialMinDist = Infinity;
          for (let c = 0; c < d.ncon; c++) {
            const dist = d.contact.get(c).dist;
            if (dist < initialMinDist) initialMinDist = dist;
          }
          expect(initialMinDist, `${kind} initialMinDist`).toBeGreaterThanOrEqual(-1e-6);

          // Step one full revolution and verify lift span is preserved
          const hinge = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, mech.camNode.joints[0].name);
          const slide = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, mech.followerNode.joints[0].name);
          const hq = m.jnt_qposadr[hinge];
          const sq = m.jnt_qposadr[slide];
          const act = mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, `${mech.camNode.joints[0].name}_actuator`);
          d.ctrl[act] = mech.camNode.joints[0].actuator!.ctrlValue!;

          let minS = Infinity;
          let maxS = -Infinity;
          for (let i = 0; i < 80_000; i++) {
            mj.mj_step(m, d);
            const sMm = d.qpos[sq] * 1000;
            if (sMm < minS) minS = sMm;
            if (sMm > maxS) maxS = sMm;
            if (d.qpos[hq] > 2 * Math.PI) break;
          }
          expect(maxS - minS, `${kind} lift span`).toBeGreaterThan(7);
          expect(maxS - minS, `${kind} lift span`).toBeLessThan(11);
        } finally {
          d.delete();
          m.delete();
        }
      }, 30_000);
    }
  });

  // -------------------------------------------------------------------------
  // Bug 3: Duplicate geoms on arborId rebuild
  // -------------------------------------------------------------------------
  describe('3. arborId rebuild deduplicates colliding geom names', () => {
    it('rebuilding a compound gear onto arborId with the same idPrefix replaces rather than duplicates geoms', () => {
      const s1 = ok(
        buildMechanism(
          { family: 'gear_pair', driverTeeth: 16, drivenTeeth: 48, moduleMm: 1, origin: [0, 0, 0.05], idPrefix: 's1' },
          [],
        ),
      );
      const s2First = ok(
        buildMechanism(
          {
            family: 'gear_pair',
            driverTeeth: 16,
            drivenTeeth: 48,
            moduleMm: 1,
            arborId: 'gear_s1_2',
            axialOffsetMm: 10,
            idPrefix: 's2',
          },
          s1.nodes,
        ),
      );
      const arborAfterFirst = find(s2First.nodes, 'gear_s1_2')!;
      const geomCountFirst = arborAfterFirst.geoms.length;

      // Rebuild stage 2 with the same idPrefix onto the same arbor
      const s2Rebuild = ok(
        buildMechanism(
          {
            family: 'gear_pair',
            driverTeeth: 20,
            drivenTeeth: 40,
            moduleMm: 1,
            arborId: 'gear_s1_2',
            axialOffsetMm: 12,
            idPrefix: 's2',
          },
          s2First.nodes,
        ),
      );
      const arborAfterRebuild = find(s2Rebuild.nodes, 'gear_s1_2')!;
      expect(arborAfterRebuild.geoms.length).toBe(geomCountFirst);
      const names = arborAfterRebuild.geoms.map((g) => g.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 4: Invalid 4-bar linkage returns error
  // -------------------------------------------------------------------------
  describe('4. Invalid 4-bar linkage returns an error', () => {
    it('returns { error } when validAssembly is false', () => {
      const res = buildMechanism(
        { family: 'four_bar', groundMm: 200, crankMm: 20, couplerMm: 20, rockerMm: 20 },
        [],
      );
      expect(res).toHaveProperty('error');
      expect((res as { error: string }).error).toMatch(/Invalid 4-bar linkage/i);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 5: Flat parameters forwarded on gear_pair & rack_pinion
  // -------------------------------------------------------------------------
  describe('5. Flat parameters forwarded on gear_pair and rack_pinion', () => {
    it('forwards backlashMm, thicknessMm, pressureAngleDeg, boreKind, boreDiameterMm on gear_pair', () => {
      const built = ok(
        buildMechanism(
          {
            family: 'gear_pair',
            driverTeeth: 16,
            drivenTeeth: 24,
            moduleMm: 2,
            backlashMm: 0.25,
            thicknessMm: 12,
            pressureAngleDeg: 25,
            boreKind: 'hex',
            boreDiameterMm: 6,
            idPrefix: 'fp',
          },
          [],
        ),
      );
      for (const id of ['gear_fp', 'gear_fp_2']) {
        const node = find(built.nodes, id)!;
        expect(node.toothForm?.kind).toBe('involute');
        if (node.toothForm?.kind === 'involute') {
          expect(node.toothForm.backlashMm).toBeCloseTo(0.25, 6);
          expect(node.toothForm.pressureAngleDeg).toBeCloseTo(25, 6);
        }
        // Collision cylinder half-height reflects thicknessMm = 12 mm -> 0.006 m
        const col = node.geoms.find((g) => g.role === 'collision')!;
        expect(col.size![1]).toBeCloseTo(0.006, 6);
      }
    });

    it('forwards flat params including baseHeightMm on rack_pinion', () => {
      const built = ok(
        buildMechanism(
          {
            family: 'rack_pinion',
            pinionTeeth: 16,
            rackTeeth: 12,
            moduleMm: 2,
            backlashMm: 0.2,
            thicknessMm: 10,
            pressureAngleDeg: 25,
            boreKind: 'd_shaft',
            boreDiameterMm: 6,
            baseHeightMm: 11,
            idPrefix: 'rp',
          },
          [],
        ),
      );
      const pinion = find(built.nodes, 'pinion_rp')!;
      expect(pinion.toothForm?.kind).toBe('involute');
      if (pinion.toothForm?.kind === 'involute') {
        expect(pinion.toothForm.backlashMm).toBeCloseTo(0.2, 6);
        expect(pinion.toothForm.pressureAngleDeg).toBeCloseTo(25, 6);
      }
      // Pinion collision cylinder half-height reflects thicknessMm = 10 mm -> 0.005 m
      const pinionCol = pinion.geoms.find((g) => g.role === 'collision')!;
      expect(pinionCol.size![1]).toBeCloseTo(0.005, 6);
      const rack = find(built.nodes, 'rack_rp')!;
      // Rack collision box half-Z is thicknessMm / 2 = 5 mm = 0.005 m
      const rackCol = rack.geoms.find((g) => g.role === 'collision')!;
      expect(rackCol.size![2]).toBeCloseTo(0.005, 6);
      // Rack mesh Y bottom sits at -(dedendumMm + baseHeightMm) = -(2.5 + 11) = -13.5 mm = -0.0135 m
      const rackMesh = rack.geoms.find((g) => g.type === 'mesh')!;
      let minY = Infinity;
      for (let i = 1; i < rackMesh.renderVertices!.length; i += 3) {
        if (rackMesh.renderVertices![i] < minY) minY = rackMesh.renderVertices![i];
      }
      expect(minY).toBeCloseTo(-0.0135, 4);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 6: adjusted clamping warnings & gt2_belt metrics
  // -------------------------------------------------------------------------
  describe('6. gt2_belt metrics & adjusted clamping warnings for gt2_belt, cam_follower, four_bar', () => {
    it('includes centerDistanceMm & reductionRatio in gt2_belt metrics and reports clamped centerDistanceMm', () => {
      const built = ok(
        buildMechanism({ family: 'gt2_belt', driverTeeth: 20, drivenTeeth: 40, centerDistanceMm: 5 }, []),
      );
      expect(typeof built.metrics.centerDistanceMm).toBe('number');
      expect(built.metrics.centerDistanceMm as number).toBeGreaterThan(20);
      expect(built.metrics.reductionRatio).toBeCloseTo(2, 6);
      expect(built.adjusted).toContainEqual({
        field: 'centerDistanceMm',
        requested: 5,
        used: built.metrics.centerDistanceMm,
      });
    });

    it('populates adjusted for cam_follower clamped fields', () => {
      const built = ok(
        buildMechanism(
          { family: 'cam_follower', baseRadiusMm: 4, liftMm: 0.2, thicknessMm: 0.5, samples: 10 },
          [],
        ),
      );
      expect(built.adjusted).toEqual([
        { field: 'baseRadiusMm', requested: 4, used: 8 },
        { field: 'liftMm', requested: 0.2, used: 1 },
        { field: 'thicknessMm', requested: 0.5, used: 2 },
        { field: 'samples', requested: 10, used: 36 },
      ]);
    });

    it('populates adjusted for four_bar clamped fields', () => {
      const built = ok(
        buildMechanism(
          {
            family: 'four_bar',
            groundMm: 80,
            crankMm: 30,
            couplerMm: 75,
            rockerMm: 55,
            linkWidthMm: 2,
            thicknessMm: 1,
            pinDiameterMm: 0.5,
          },
          [],
        ),
      );
      expect(built.adjusted).toEqual([
        { field: 'linkWidthMm', requested: 2, used: 6 },
        { field: 'thicknessMm', requested: 1, used: 3 },
        { field: 'pinDiameterMm', requested: 0.5, used: 2 },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 7: four_bar random 7-char suffix in geom names
  // -------------------------------------------------------------------------
  describe('7. four_bar geom names have no stray random suffix when idPrefix is set', () => {
    it('produces exact idPrefix-based geom names on all 4 link bodies', () => {
      const built = ok(buildMechanism({ family: 'four_bar', idPrefix: 'fb' }, []));
      const geomNames: string[] = [];
      walk(built.nodes, (n) => {
        for (const g of n.geoms) geomNames.push(g.name);
      });
      expect(geomNames).toEqual([
        'fourbar_ground_fb_mesh',
        'fourbar_ground_fb_col',
        'fourbar_crank_fb_mesh',
        'fourbar_crank_fb_col',
        'fourbar_coupler_fb_mesh',
        'fourbar_coupler_fb_col',
        'fourbar_rocker_fb_mesh',
        'fourbar_rocker_fb_col',
      ]);
    });
  });
});
