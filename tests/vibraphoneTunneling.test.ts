import { describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { vibraphoneResonatorsPreset } from '../src/presets/vibraphoneResonators';
import { computeContactDampingRate } from '../src/utils/contactFrictionAcoustics';
import { compileToMJCF } from '../src/utils/mjcf';
import { simulate } from './helpers/simulate';

describe('Motorized Vibraphone Collision & Anti-Tunneling Verification', () => {
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5'] as const;

  it('steps real MuJoCo for 4.0 full seconds (4000 steps) with zero beater-bar or bar-damper pass-through and real strikes + pedal damping on all 6 bars', async () => {
    const nodes = vibraphoneResonatorsPreset.nodes;
    const sim = await simulate(vibraphoneResonatorsPreset);
    try {
      // Zero interpenetrations at t = 0
      expect(sim.data.ncon).toBe(0);

      const dt = sim.model.opt.timestep;
      const totalSteps = Math.round(4.0 / dt);
      expect(totalSteps).toBeGreaterThanOrEqual(2000);

      const damperNode = nodes.find((n) => n.id === 'vibe_damper_bar')!;
      const damperGeom = damperNode.geoms.find((g) => g.name === 'damper_felt_rail')!;
      const damperHalfZ = damperGeom.size[2];
      const damperBid = sim.bodyId(damperNode.name);
      expect(damperBid).toBeGreaterThan(0);

      const frameNode = nodes.find((n) => n.id === 'vibraphone_frame')!;
      const frontRailGeom = frameNode.geoms.find((g) => g.name === 'cord_rail_front')!;
      const cordRailTopZ = (frontRailGeom.pos?.[2] ?? 0) + (frontRailGeom.size[2] ?? 0);

      const barMeta = notes.map((note, i) => {
        const lower = note.toLowerCase();
        const barNode = nodes.find((n) => n.id === `vibe_bar_${lower}`)!;
        const barGeom = barNode.geoms.find((g) => g.name === 'aluminum_bar_body')!;
        const malletNode = nodes.find((n) => n.id === `vibe_mallet_${i + 1}`)!;
        const headGeom = malletNode.geoms.find((g) => g.name === `cord_mallet_head_${i}`)!;
        const shaftGeom = malletNode.geoms.find((g) => g.name === `rattan_shaft_${i}`)!;

        // Verify positive crisp solref on bar, mallet head, mallet shaft, and damper bar, and colliding shaft
        expect(barGeom.solref?.[0]).toBeGreaterThan(0);
        expect(barGeom.solref?.[0]).toBeLessThanOrEqual(0.006);
        expect(headGeom.solref?.[0]).toBeGreaterThan(0);
        expect(headGeom.solref?.[0]).toBeLessThanOrEqual(0.006);
        expect(shaftGeom.contype).not.toBe(0);
        expect(shaftGeom.conaffinity).not.toBe(0);

        const barBid = sim.bodyId(barNode.name);
        const malletBid = sim.bodyId(malletNode.name);
        expect(barBid).toBeGreaterThan(0);
        expect(malletBid).toBeGreaterThan(0);

        return {
          note,
          lower,
          barBid,
          malletBid,
          barHalfZ: barGeom.size[2],
          headLocalY: headGeom.pos![1],
          headLocalZ: headGeom.pos![2],
          headRadius: headGeom.size[0],
        };
      });

      expect(damperGeom.solref?.[0]).toBeGreaterThan(0);
      expect(damperGeom.solref?.[0]).toBeLessThanOrEqual(0.008);

      const barBidToIdx = new Map<number, number>();
      const malletBidToIdx = new Map<number, number>();
      barMeta.forEach((m, idx) => {
        barBidToIdx.set(m.barBid, idx);
        malletBidToIdx.set(m.malletBid, idx);
      });

      const minBeaterMinusBarTop = new Array<number>(6).fill(Infinity);
      const minBarBotMinusDamperTop = new Array<number>(6).fill(Infinity);
      const minBarBotMinusRailTop = new Array<number>(6).fill(Infinity);
      const maxAbsBarSlide = new Array<number>(6).fill(0);
      const minBarSlide = new Array<number>(6).fill(Infinity);
      const beaterBarContactSteps = new Array<number>(6).fill(0);
      const firstStrikeStep = new Array<number>(6).fill(-1);
      const maxReboundAboveBarAfterStrike = new Array<number>(6).fill(-Infinity);
      const damperBarContactSteps = new Array<number>(6).fill(0);
      let steadyDamperSamples = 0;
      let steadyDamperForcePerBarSum = 0;
      const barSlideDofs = barMeta.map((m) => {
        for (let j = 0; j < sim.model.njnt; j++) {
          if (sim.model.jnt_bodyid[j] === m.barBid) return sim.model.jnt_dofadr[j];
        }
        return -1;
      });
      const prevBarQfrcC = new Float64Array(6);
      const barImpactTriggers = new Array<number>(6).fill(0);

      const damperSlideJid = sim.model.jnt_dofadr[
        (() => {
          for (let j = 0; j < sim.model.njnt; j++) {
            // Find joint with slide DOF on damperBid
            if (sim.model.jnt_bodyid[j] === damperBid) return j;
          }
          return -1;
        })()
      ];
      expect(damperSlideJid).toBeGreaterThanOrEqual(0);

      for (let step = 0; step < totalSteps; step++) {
        sim.step(1);

        const xpos = sim.data.xpos;
        const xmat = sim.data.xmat;
        const damperCenterZ = xpos[damperBid * 3 + 2];
        const damperTopZ = damperCenterZ + damperHalfZ;

        const tLoop = sim.time() % 3.20;
        const inSteadyDampWindow = tLoop >= 1.54 && tLoop <= 1.92;
        if (inSteadyDampWindow) {
          // Constraint reaction force on vibe_damper_slide equals downward normal force from all 6 bars
          const normalTotalN = Math.abs(sim.data.qfrc_constraint[damperSlideJid]);
          steadyDamperForcePerBarSum += normalTotalN / 6;
          steadyDamperSamples++;
        }

        for (let i = 0; i < 6; i++) {
          const m = barMeta[i];
          const barCenterZ = xpos[m.barBid * 3 + 2];
          const barTopZ = barCenterZ + m.barHalfZ;
          const barBottomZ = barCenterZ - m.barHalfZ;

          const slide = sim.jointPos(`vibe_bar_${m.lower}_cord`);
          if (Math.abs(slide) > maxAbsBarSlide[i]) maxAbsBarSlide[i] = Math.abs(slide);
          if (slide < minBarSlide[i]) minBarSlide[i] = slide;

          const barFc = sim.data.qfrc_constraint[barSlideDofs[i]];
          const df = barFc - prevBarQfrcC[i];
          prevBarQfrcC[i] = barFc;
          if (Math.abs(df) * dt >= 0.004) {
            barImpactTriggers[i]++;
          }

          const mBase = m.malletBid * 3;
          const rBase = m.malletBid * 9;
          const headCenterZ =
            xpos[mBase + 2] + xmat[rBase + 7] * m.headLocalY + xmat[rBase + 8] * m.headLocalZ;
          const beaterBottomZ = headCenterZ - m.headRadius;

          const beaterClearance = beaterBottomZ - barTopZ;
          if (beaterClearance < minBeaterMinusBarTop[i]) {
            minBeaterMinusBarTop[i] = beaterClearance;
          }
          if (firstStrikeStep[i] >= 0 && step > firstStrikeStep[i] + 15) {
            if (beaterClearance > maxReboundAboveBarAfterStrike[i]) {
              maxReboundAboveBarAfterStrike[i] = beaterClearance;
            }
          }

          const damperClearance = barBottomZ - damperTopZ;
          if (damperClearance < minBarBotMinusDamperTop[i]) {
            minBarBotMinusDamperTop[i] = damperClearance;
          }

          const railClearance = barBottomZ - cordRailTopZ;
          if (railClearance < minBarBotMinusRailTop[i]) {
            minBarBotMinusRailTop[i] = railClearance;
          }
        }

        const contactVec = sim.data.contact;
        try {
          const ncon = contactVec.size();
          for (let c = 0; c < ncon; c++) {
            const ct = contactVec.get(c);
            if (!ct) continue;
            try {
              const b1 = sim.model.geom_bodyid[ct.geom1];
              const b2 = sim.model.geom_bodyid[ct.geom2];

              const barIdx1 = barBidToIdx.get(b1);
              const barIdx2 = barBidToIdx.get(b2);
              const malIdx1 = malletBidToIdx.get(b1);
              const malIdx2 = malletBidToIdx.get(b2);

              if (barIdx1 !== undefined && malIdx2 === barIdx1) {
                beaterBarContactSteps[barIdx1]++;
                if (firstStrikeStep[barIdx1] === -1) firstStrikeStep[barIdx1] = step;
              } else if (barIdx2 !== undefined && malIdx1 === barIdx2) {
                beaterBarContactSteps[barIdx2]++;
                if (firstStrikeStep[barIdx2] === -1) firstStrikeStep[barIdx2] = step;
              }

              if (tLoop >= 1.42 && tLoop <= 1.98) {
                if (b1 === damperBid && barIdx2 !== undefined) {
                  damperBarContactSteps[barIdx2]++;
                } else if (b2 === damperBid && barIdx1 !== undefined) {
                  damperBarContactSteps[barIdx1]++;
                }
              }
            } finally {
              ct.delete();
            }
          }
        } finally {
          contactVec.delete();
        }
      }

      for (let i = 0; i < 6; i++) {
        // 1. ZERO beater-through-plank tunneling across all 4000 steps (`>= -0.004` m)
        expect(minBeaterMinusBarTop[i]).toBeGreaterThanOrEqual(-0.004);
        // 2. Every beater genuinely strikes its bar (producing audible modal impact impulse & bar cord dip) and rebounds cleanly
        expect(beaterBarContactSteps[i]).toBeGreaterThanOrEqual(1);
        expect(barImpactTriggers[i]).toBeGreaterThanOrEqual(1);
        expect(minBarSlide[i]).toBeLessThan(-0.00025);
        expect(maxReboundAboveBarAfterStrike[i]).toBeGreaterThan(0.015);
        // 3. ZERO plank-through-damper-bar tunneling (`>= -0.004` m) & every bar stays on its nodal rail
        expect(minBarBotMinusDamperTop[i]).toBeGreaterThanOrEqual(-0.004);
        expect(minBarBotMinusRailTop[i]).toBeGreaterThan(0.003);
        expect(maxAbsBarSlide[i]).toBeLessThanOrEqual(0.0045);
        // 4. Sustained viscoelastic pedal-damper contact (>= 300 ms >> 35 ms AUDIO_DAMPING gate) on ALL 6 bars
        expect(damperBarContactSteps[i]).toBeGreaterThan(300);
      }

      // 5. Gentle 1-4 N per-bar felt contact force -> strong AUDIO_DAMPING without shoving bars
      expect(steadyDamperSamples).toBeGreaterThan(200);
      const meanForcePerBarN = steadyDamperForcePerBarSum / steadyDamperSamples;
      expect(meanForcePerBarN).toBeGreaterThanOrEqual(1.0);
      expect(meanForcePerBarN).toBeLessThanOrEqual(4.0);

      expect(damperNode.deformMaterial).toBe('rubber');
      expect(computeContactDampingRate(meanForcePerBarN, 0.88, 0.35)).toBeGreaterThan(2.5);
    } finally {
      sim.dispose();
    }
  });

  it('preserves exact analytical box bar colliders after CSG arch mesh installation and blocks continuous downward mallet push', async () => {
    // Simulate post-useCsgCompile state where every `csgEnabled` bar has its derived visual arch mesh installed
    const postCsgScene: SceneGraph = {
      nodes: vibraphoneResonatorsPreset.nodes.map((node): SceneNode => {
        if (!node.id.startsWith('vibe_bar_')) return node;
        return {
          ...node,
          geoms: [
            ...node.geoms,
            {
              name: `${node.name}_csg`,
              type: 'mesh',
              size: [1],
              role: 'visual',
              mass: 0,
              csgDerived: 'visual',
              vertices: [-0.02, -0.005, -0.15, 0.02, -0.005, -0.15, 0.02, 0.005, -0.15, 0, 0.005, 0.15],
              renderVertices: [-0.02, -0.15, -0.005, 0.02, -0.15, -0.005, 0.02, -0.15, 0.005, 0, 0.15, 0.005],
              faces: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
            },
          ],
          // Override nothing else: verify `collision: 'primitives'` keeps the solid box collider!
        };
      }),
    };

    const xml = compileToMJCF(postCsgScene);
    expect(xml).toContain('name="aluminum_bar_body" type="box"');
    expect(xml).not.toContain('_csg');

    // Stress-test continuous downward push (-1.8 N*m = ~2x chord torque held for 250 ms without escapement):
    // hardStop + colliding rattan shaft + analytical box collider block any pass-through!
    const stressScene: SceneGraph = {
      nodes: postCsgScene.nodes.map((node) =>
        node.id === 'vibraphone_frame'
          ? { ...node, script: `if (api.getTime() < 0.25) api.applyJointForce('vibe_mallet_0', -1.8);` }
          : node,
      ),
    };
    const sim = await simulate(stressScene);
    try {
      const c4Node = stressScene.nodes.find((n) => n.id === 'vibe_bar_c4')!;
      const m0Node = stressScene.nodes.find((n) => n.id === 'vibe_mallet_1')!;
      const headGeom = m0Node.geoms.find((g) => g.name === 'cord_mallet_head_0')!;
      const barHalfZ = c4Node.geoms.find((g) => g.name === 'aluminum_bar_body')!.size[2];
      const barBid = sim.bodyId(c4Node.name);
      const malBid = sim.bodyId(m0Node.name);

      let minClearance = Infinity;
      for (let s = 0; s < 400; s++) {
        sim.step(1);
        const barTopZ = sim.data.xpos[barBid * 3 + 2] + barHalfZ;
        const headCenterZ =
          sim.data.xpos[malBid * 3 + 2] +
          sim.data.xmat[malBid * 9 + 7] * headGeom.pos![1] +
          sim.data.xmat[malBid * 9 + 8] * headGeom.pos![2];
        const beaterBottomZ = headCenterZ - headGeom.size[0];
        minClearance = Math.min(minClearance, beaterBottomZ - barTopZ);
      }
      expect(minClearance).toBeGreaterThanOrEqual(-0.004);
    } finally {
      sim.dispose();
    }
  });
});
