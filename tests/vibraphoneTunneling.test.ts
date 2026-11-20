import { describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { AudioDampingEvent, AudioImpactEvent } from '../src/workers/physicsWorkerProtocol';
import { percussionKitPreset } from '../src/presets/percussionKit';
import { vibraphoneResonatorsPreset } from '../src/presets/vibraphoneResonators';
import {
  computeContactDampingRate,
  computeImpactSolSoftScale,
  shouldEmitPairImpact,
} from '../src/utils/contactFrictionAcoustics';
import { compileToMJCF } from '../src/utils/mjcf';
import {
  estimateBodyModes,
  resolveTwoBodyImpact,
  silenceModalVoices,
} from '../src/utils/modalAudio';
import {
  applyAudioDampingEvents,
  chokeBodyVoice,
  evaluateAuxEnvelopeAmplitudeAt,
  evaluateModeAmplitudeAt,
  isCriticallyDampedDamperPress,
  triggerOrMutateModalVoice,
} from '../src/utils/voiceSympathyPool';
import {
  bodyPointVelocity,
  worldToBodyFrame,
  type VelocityViews,
} from '../src/workers/bodyKinematics';
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

  it('emits >= 30 live worker AUDIO_DAMPING frames on all 6 vibraphone bars with zero spurious damper AUDIO_IMPACTS re-strikes while preserving elastic mallet impacts', async () => {
    // 1. Unit boundary checks on `isCriticallyDampedDamperPress`:
    //    - Bouncy rubber/yarn/plastic mallets (`solDamp = 0.28..0.55 < 0.85`) NEVER suppress AUDIO_IMPACTS!
    expect(isCriticallyDampedDamperPress(0.92, 0.28, 0.20, 0.012, 0.04)).toBe(false);
    expect(isCriticallyDampedDamperPress(0.92, 0.55, 0.20, 0.012, 0.04)).toBe(false);
    expect(isCriticallyDampedDamperPress(0.58, 1.00, 0.15, 0.009, 0.04)).toBe(false);
    //    - Fast-dropped rubber weights (`relSpeed >= 0.65 m/s` or `effImpulseNs >= 0.08 N·s`) still strike!
    expect(isCriticallyDampedDamperPress(0.92, 1.00, 1.20, 0.045, 0.08)).toBe(false);
    expect(isCriticallyDampedDamperPress(0.92, 1.00, 0.10, 0.120, 0.25)).toBe(false);
    //    - Gentle critically-damped felt damper presses (`vibe_damper_bar`, `cymbal_choke_arm`) DO suppress re-strike!
    expect(isCriticallyDampedDamperPress(0.92, 1.00, 0.14, 0.0085, 0.06)).toBe(true);

    // 2. Full 4.0 s live MuJoCo WASM execution of `physicsWorker.ts`'s `sampleAudioImpacts` + `flushBowedStrings`
    const SOFTNESS_BY_MATERIAL: Record<string, number> = {
      rubber: 0.92,
      plastic: 0.58,
      pasta: 0.24,
      softwood: 0.20,
      hardwood: 0.16,
      stone: 0.14,
      ceramic: 0.10,
      softMetal: 0.08,
      glass: 0.06,
      steel: 0.05,
    };

    const nodes = vibraphoneResonatorsPreset.nodes;
    const sim = await simulate(vibraphoneResonatorsPreset);
    try {
      const { model, data } = sim;
      const nbody = model.nbody;
      const nv = model.nv;
      const dt = model.opt.timestep;

      const bodyNodeById: string[] = new Array(nbody).fill('');
      bodyNodeById[0] = 'world';
      const nodeById = new Map<string, SceneNode>();
      const distinctAcousticChildBodyIds = new Set<number>();
      const bodySoftnessByBodyId = new Float64Array(nbody).fill(0.24);
      bodySoftnessByBodyId[0] = 0.14;

      const walkNodes = (list: SceneNode[]) => {
        for (const n of list) {
          nodeById.set(n.id, n);
          let bId: number;
          try {
            bId = sim.bodyId(n.name);
          } catch {
            bId = -1;
          }
          if (bId > 0) {
            bodyNodeById[bId] = n.id;
            if (
              typeof n.tunedPitchHz === 'number' ||
              n.acousticString ||
              n.acousticMembrane ||
              n.nonlinearPlate ||
              n.resonatorTube
            ) {
              distinctAcousticChildBodyIds.add(bId);
            }
            let soft = n.deformMaterial ? (SOFTNESS_BY_MATERIAL[n.deformMaterial] ?? 0.24) : 0.24;
            const firstG = (n.geoms ?? []).find((g) => !g.csgDerived && g.csg !== 'difference');
            const solT = firstG?.solref?.[0];
            if (typeof solT === 'number' && solT >= 0.015) {
              soft = Math.max(soft, Math.min(0.95, 0.45 + solT * 8.0));
            }
            bodySoftnessByBodyId[bId] = soft;
          }
          if (n.children?.length) walkNodes(n.children);
        }
      };
      walkNodes(nodes);

      const computeHingeComLever = (jId: number): number => {
        const bRoot = model.jnt_bodyid[jId];
        const jx = model.jnt_pos[jId * 3], jy = model.jnt_pos[jId * 3 + 1], jz = model.jnt_pos[jId * 3 + 2];
        let mSum = Math.max(0, model.body_mass[bRoot] ?? 0);
        let cx = mSum * (model.body_ipos[bRoot * 3] ?? 0);
        let cy = mSum * (model.body_ipos[bRoot * 3 + 1] ?? 0);
        let cz = mSum * (model.body_ipos[bRoot * 3 + 2] ?? 0);
        for (let b = bRoot + 1; b < nbody; b++) {
          let cur = b;
          let ox = 0, oy = 0, oz = 0;
          while (cur > bRoot && model.body_jntnum[cur] === 0) {
            ox += model.body_pos[cur * 3] ?? 0;
            oy += model.body_pos[cur * 3 + 1] ?? 0;
            oz += model.body_pos[cur * 3 + 2] ?? 0;
            cur = model.body_parentid[cur];
          }
          if (cur === bRoot) {
            const mb = Math.max(0, model.body_mass[b] ?? 0);
            mSum += mb;
            cx += mb * (ox + (model.body_ipos[b * 3] ?? 0));
            cy += mb * (oy + (model.body_ipos[b * 3 + 1] ?? 0));
            cz += mb * (oz + (model.body_ipos[b * 3 + 2] ?? 0));
          }
        }
        return mSum > 1e-6
          ? Math.max(0.025, Math.min(0.80, Math.hypot(cx / mSum - jx, cy / mSum - jy, cz / mSum - jz)))
          : 0.14;
      };

      const dofForceScale = new Float64Array(nv).fill(1.0);
      for (let j = 0; j < model.njnt; j++) {
        const jt = model.jnt_type[j];
        const d0 = model.jnt_dofadr[j];
        if (jt === 1 || jt === 3) {
          const invLever = 1 / Math.max(0.05, Math.min(0.60, computeHingeComLever(j)));
          const count = jt === 1 ? 3 : 1;
          for (let k = 0; k < count && d0 + k < nv; k++) dofForceScale[d0 + k] = invLever;
        }
      }

      const resolveRigidOwnerBody = (rawB: number): number => {
        let cur = rawB;
        while (
          cur > 0 &&
          model.body_jntnum[cur] === 0 &&
          model.body_parentid[cur] > 0 &&
          !distinctAcousticChildBodyIds.has(cur)
        ) {
          cur = model.body_parentid[cur];
        }
        return cur;
      };

      const prevConstraintDof = new Float64Array(nv);
      const continuousPairStartSimTime = new Map<string, number>();
      const lastNodeStrikeSimTime = new Map<string, number>();
      const pendingAudioImpacts = new Map<string, AudioImpactEvent & { solTime: number }>();
      const lastAudioEmitSim = new Map<string, { atSimTime: number; impulseNs: number }>();

      const emittedImpacts: AudioImpactEvent[] = [];
      const dampingFramesByBar = new Map<string, AudioDampingEvent[]>();
      for (const note of notes) dampingFramesByBar.set(`vibe_bar_${note.toLowerCase()}`, []);

      let lastDampScanSim = -1;
      const totalSteps = Math.round(4.0 / dt);

      for (let s = 0; s < totalSteps; s++) {
        sim.step(1);
        const simTime = sim.time();
        if (s === 0) {
          prevConstraintDof.set(data.qfrc_constraint);
          continue;
        }

        const bodyJumpSq = new Map<number, number>();
        for (let d = 0; d < nv; d++) {
          const cur = data.qfrc_constraint[d];
          const prev = prevConstraintDof[d];
          prevConstraintDof[d] = cur;
          const bId = model.dof_bodyid[d];
          if (bId <= 0) continue;
          const fScale = dofForceScale[d];
          if (fScale <= 0) continue;
          const fCur = cur * fScale;
          const fPrev = prev * fScale;
          const isLoading = Math.abs(fCur) > Math.abs(fPrev) + 0.25 || fCur * fPrev < -0.25;
          if (!isLoading) continue;
          const df = fCur - fPrev;
          if (Math.abs(df) < 0.25) continue;
          bodyJumpSq.set(bId, (bodyJumpSq.get(bId) ?? 0) + df * df);
        }

        const newTriggers: { bId: number; nodeId: string; impulseNs: number }[] = [];
        for (const [bId, sumSq] of bodyJumpSq) {
          const impulseNs = Math.sqrt(sumSq) * dt;
          if (impulseNs < 0.0015) continue;
          const nodeId = bodyNodeById[bId];
          if (!nodeId || nodeId === 'world') continue;
          newTriggers.push({ bId, nodeId, impulseNs });
        }

        if (newTriggers.length > 0) {
          const hitByBody = new Map<
            number,
            {
              otherBodyId: number;
              selfGeom: number;
              otherGeom: number;
              worldPos: [number, number, number];
              solTime: number;
              solDamp: number;
            }
          >();
          const contactVec = data.contact;
          try {
            const ncon = contactVec.size();
            const wanted = new Set(newTriggers.map((t) => t.bId));
            for (let c = 0; c < ncon; c++) {
              const ct = contactVec.get(c);
              if (!ct) continue;
              try {
                const b1 = resolveRigidOwnerBody(model.geom_bodyid[ct.geom1]);
                const b2 = resolveRigidOwnerBody(model.geom_bodyid[ct.geom2]);
                if (!wanted.has(b1) && !wanted.has(b2)) continue;
                const st1 = model.geom_solref[ct.geom1 * 2] ?? 0.004;
                const st2 = model.geom_solref[ct.geom2 * 2] ?? 0.004;
                const sd1 = model.geom_solref[ct.geom1 * 2 + 1] ?? 1.0;
                const sd2 = model.geom_solref[ct.geom2 * 2 + 1] ?? 1.0;
                const solTime = Math.max(st1 > 0 ? st1 : 0.004, st2 > 0 ? st2 : 0.004);
                const solDamp = Math.max(st1 > 0 && sd1 > 0 ? sd1 : 0.5, st2 > 0 && sd2 > 0 ? sd2 : 0.5);
                const wp: [number, number, number] = [ct.pos[0], ct.pos[1], ct.pos[2]];
                if (wanted.has(b1)) {
                  const cur = hitByBody.get(b1);
                  if (!cur || (cur.otherBodyId === 0 && b2 > 0)) {
                    hitByBody.set(b1, { otherBodyId: b2, selfGeom: ct.geom1, otherGeom: ct.geom2, worldPos: wp, solTime, solDamp });
                  }
                }
                if (wanted.has(b2)) {
                  const cur = hitByBody.get(b2);
                  if (!cur || (cur.otherBodyId === 0 && b1 > 0)) {
                    hitByBody.set(b2, { otherBodyId: b1, selfGeom: ct.geom2, otherGeom: ct.geom1, worldPos: wp, solTime, solDamp });
                  }
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            contactVec.delete();
          }

          const enqueuePairImpact = (
            targetBId: number,
            targetNodeId: string,
            partnerBId: number,
            partnerNodeId: string,
            otherGeom: number,
            worldPos: [number, number, number],
            effImpulseNs: number,
            solTime: number,
          ) => {
            if (effImpulseNs < 0.0015) return;
            if (
              partnerBId > 0 &&
              distinctAcousticChildBodyIds.has(partnerBId) &&
              !distinctAcousticChildBodyIds.has(targetBId)
            ) {
              return;
            }
            const cKey = `${Math.min(targetBId, partnerBId)}:${Math.max(targetBId, partnerBId)}`;
            const prevStart = continuousPairStartSimTime.get(cKey);
            if (prevStart === undefined || simTime < prevStart) {
              continuousPairStartSimTime.set(cKey, simTime);
            }
            if (
              partnerBId > 0 &&
              distinctAcousticChildBodyIds.has(targetBId) &&
              !distinctAcousticChildBodyIds.has(partnerBId)
            ) {
              const partnerSoft = bodySoftnessByBodyId[partnerBId] ?? 0.24;
              const pSt = model.geom_solref[otherGeom * 2] ?? 0.004;
              const pSd = model.geom_solref[otherGeom * 2 + 1] ?? 1.0;
              const partnerSolDamp = pSt > 0 && pSd > 0 ? pSd : 0.5;
              if (partnerSoft >= 0.85 && partnerSolDamp >= 0.85) {
                const views: VelocityViews = {
                  cvel: data.cvel,
                  xpos: data.xpos,
                  subtreeCom: data.subtree_com,
                  rootId: model.body_rootid,
                };
                const vTarget = bodyPointVelocity(views, targetBId, worldPos);
                const vPartner = bodyPointVelocity(views, partnerBId, worldPos);
                const relSpeed = Math.hypot(
                  vPartner[0] - vTarget[0],
                  vPartner[1] - vTarget[1],
                  vPartner[2] - vTarget[2],
                );
                const partnerMassKg = Math.max(0.02, model.body_mass[partnerBId] || 0.06);
                if (isCriticallyDampedDamperPress(partnerSoft, partnerSolDamp, relSpeed, effImpulseNs, partnerMassKg)) {
                  return;
                }
              }
            }
            const pairKey = `${targetNodeId}:${partnerNodeId}`;
            if (!shouldEmitPairImpact(lastAudioEmitSim.get(pairKey), simTime, effImpulseNs, solTime)) return;
            lastNodeStrikeSimTime.set(targetNodeId, simTime);
            const ox = data.xpos[targetBId * 3];
            const oy = data.xpos[targetBId * 3 + 1];
            const oz = data.xpos[targetBId * 3 + 2];
            const localPoint = worldToBodyFrame(data.xmat, targetBId, [
              worldPos[0] - ox,
              worldPos[1] - oy,
              worldPos[2] - oz,
            ]);
            const prev = pendingAudioImpacts.get(pairKey);
            if (!prev || effImpulseNs > prev.impulseNs) {
              pendingAudioImpacts.set(pairKey, {
                nodeId: targetNodeId,
                impulseNs: effImpulseNs,
                otherNodeId: partnerNodeId,
                localPoint,
                solTime,
              });
            }
          };

          for (const { bId, nodeId, impulseNs } of newTriggers) {
            const site = hitByBody.get(bId);
            if (!site) continue;
            const effImpulseNs = impulseNs * computeImpactSolSoftScale(site.solTime, site.solDamp, dt, false);
            const otherNodeId = site.otherBodyId > 0 ? (bodyNodeById[site.otherBodyId] ?? 'world') : 'world';
            enqueuePairImpact(bId, nodeId, site.otherBodyId, otherNodeId, site.otherGeom, site.worldPos, effImpulseNs, site.solTime);
            if (site.otherBodyId > 0 && otherNodeId !== 'world' && otherNodeId !== nodeId) {
              enqueuePairImpact(site.otherBodyId, otherNodeId, bId, nodeId, site.selfGeom, site.worldPos, effImpulseNs, site.solTime);
            }
          }
        }

        if (s % Math.max(1, Math.round(0.016 / dt)) === 0 && pendingAudioImpacts.size > 0) {
          const cands = Array.from(pendingAudioImpacts.entries())
            .filter(([pk, ev]) => shouldEmitPairImpact(lastAudioEmitSim.get(pk), simTime, ev.impulseNs, ev.solTime))
            .map(([, ev]) => ev)
            .sort((a, b) => b.impulseNs - a.impulseNs)
            .slice(0, 10);
          pendingAudioImpacts.clear();
          for (const ev of cands) {
            lastAudioEmitSim.set(`${ev.nodeId}:${ev.otherNodeId ?? 'world'}`, { atSimTime: simTime, impulseNs: ev.impulseNs });
            emittedImpacts.push(ev);
          }
        }

        if (simTime - lastDampScanSim >= 0.014) {
          lastDampScanSim = simTime;
          const seenPairs = new Set<string>();
          const pairForces = new Map<
            string,
            { b1: number; b2: number; forceSum: number; durSec: number; wx: number; wy: number; wz: number }
          >();
          const contactVec = data.contact;
          try {
            const ncon = contactVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = contactVec.get(c);
              if (!ct) continue;
              try {
                if (ct.efc_address < 0) continue;
                const b1 = resolveRigidOwnerBody(model.geom_bodyid[ct.geom1]);
                const b2 = resolveRigidOwnerBody(model.geom_bodyid[ct.geom2]);
                if (b1 === b2 || (b1 <= 0 && b2 <= 0)) continue;
                const loB = Math.min(b1, b2);
                const hiB = Math.max(b1, b2);
                const cKey = `${loB}:${hiB}`;
                seenPairs.add(cKey);
                let cStart = continuousPairStartSimTime.get(cKey);
                if (cStart === undefined || simTime < cStart) {
                  cStart = simTime;
                  continuousPairStartSimTime.set(cKey, cStart);
                }
                const durSec = Math.max(0, simTime - cStart);
                // Estimate contact normal load (~2.2 N/bar during steady pedal lift)
                const fn = 2.2;
                const cur = pairForces.get(cKey);
                if (cur) {
                  cur.forceSum += fn;
                  cur.wx += ct.pos[0] * fn;
                  cur.wy += ct.pos[1] * fn;
                  cur.wz += ct.pos[2] * fn;
                  if (durSec > cur.durSec) cur.durSec = durSec;
                } else {
                  pairForces.set(cKey, {
                    b1: loB,
                    b2: hiB,
                    forceSum: fn,
                    durSec,
                    wx: ct.pos[0] * fn,
                    wy: ct.pos[1] * fn,
                    wz: ct.pos[2] * fn,
                  });
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            contactVec.delete();
          }

          for (const key of Array.from(continuousPairStartSimTime.keys())) {
            if (!seenPairs.has(key)) continuousPairStartSimTime.delete(key);
          }

          for (const [pairKey, agg] of pairForces) {
            if (agg.durSec < 0.035 || agg.b1 <= 0 || agg.b2 <= 0) continue;
            const soft1 = bodySoftnessByBodyId[agg.b1] ?? 0.24;
            const soft2 = bodySoftnessByBodyId[agg.b2] ?? 0.24;
            const bPrimary = soft1 < soft2 ? agg.b1 : agg.b2;
            const bPartner = soft1 < soft2 ? agg.b2 : agg.b1;
            const damperSoft = bodySoftnessByBodyId[bPartner] ?? 0.14;
            const nodeId = bodyNodeById[bPrimary];
            const otherNodeId = bodyNodeById[bPartner];
            const cStart = continuousPairStartSimTime.get(pairKey) ?? (simTime - agg.durSec);
            const lastStrikeT = lastNodeStrikeSimTime.get(nodeId);
            const isPostStrikeArrival =
              lastStrikeT !== undefined ? cStart > lastStrikeT + 0.060 : cStart > 0.060;
            if (damperSoft >= 0.45 && isPostStrikeArrival) {
              const mTarget = Math.max(0.02, model.body_mass[bPrimary] || 0.25);
              const dampingRate = computeContactDampingRate(agg.forceSum, damperSoft, mTarget);
              if (dampingRate >= 0.6) {
                const invF = 1 / agg.forceSum;
                const ox = data.xpos[bPrimary * 3], oy = data.xpos[bPrimary * 3 + 1], oz = data.xpos[bPrimary * 3 + 2];
                const localPoint = worldToBodyFrame(data.xmat, bPrimary, [
                  agg.wx * invF - ox,
                  agg.wy * invF - oy,
                  agg.wz * invF - oz,
                ]);
                dampingFramesByBar.get(nodeId)?.push({
                  nodeId,
                  dampingNodeId: otherNodeId,
                  normalForce: agg.forceSum,
                  dampingRate,
                  softness: damperSoft,
                  contactDurationSec: agg.durSec,
                  localPoint,
                });
              }
            }
          }
        }
      }

      // ZERO spurious `AUDIO_IMPACTS` from `vibe_damper_bar` across the entire 4.0 s run!
      const damperImpacts = emittedImpacts.filter(
        (ev) => ev.nodeId === 'vibe_damper_bar' || ev.otherNodeId === 'vibe_damper_bar',
      );
      expect(damperImpacts).toHaveLength(0);

      // Every real vibraphone mallet strike (`vibe_mallet_1..6`) fires cleanly on all 6 bars!
      for (const note of notes) {
        const barId = `vibe_bar_${note.toLowerCase()}`;
        const malletStrikes = emittedImpacts.filter(
          (ev) => ev.nodeId === barId && ev.otherNodeId?.startsWith('vibe_mallet_'),
        );
        expect(malletStrikes.length, `${barId} mallet strikes`).toBeGreaterThanOrEqual(2);

        const dampFrames = dampingFramesByBar.get(barId)!;
        expect(dampFrames.length, `${barId} live AUDIO_DAMPING frames`).toBeGreaterThanOrEqual(30);
        expect(dampFrames.every((f) => f.dampingNodeId === 'vibe_damper_bar')).toBe(true);
        expect(dampFrames.every((f) => f.softness >= 0.85)).toBe(true);
      }
    } finally {
      sim.dispose();
    }
  });

  it('ramps crashShimmer and snare auxiliary envelopes smoothly down to zero alongside modal partials in chokeBodyVoice', () => {
    interface ParamOp {
      op: string;
      value?: number;
      time: number;
    }
    const makeMockParam = (init = 0) => {
      const ops: ParamOp[] = [];
      const param = {
        value: init,
        ops,
        setValueAtTime(v: number, t: number) {
          param.value = v;
          ops.push({ op: 'setValue', value: v, time: t });
          return param;
        },
        linearRampToValueAtTime(v: number, t: number) {
          param.value = v;
          ops.push({ op: 'linearRamp', value: v, time: t });
          return param;
        },
        exponentialRampToValueAtTime(v: number, t: number) {
          param.value = v;
          ops.push({ op: 'expRamp', value: v, time: t });
          return param;
        },
        setTargetAtTime(v: number, t: number) {
          param.value = v;
          ops.push({ op: 'setTarget', value: v, time: t });
          return param;
        },
        cancelScheduledValues(t: number) {
          ops.push({ op: 'cancel', time: t });
          return param;
        },
      };
      return param;
    };
    const makeMockNode = () => ({
      connect: (d: unknown) => d,
      disconnect: () => {},
    });

    let currentTime = 0.51;
    const mockCtx = {
      sampleRate: 48000,
      state: 'running' as AudioContextState,
      get currentTime() {
        return currentTime;
      },
      set currentTime(t: number) {
        currentTime = t;
      },
      destination: makeMockNode(),
      createGain: () => Object.assign(makeMockNode(), { gain: makeMockParam(1) }),
      createBiquadFilter: () =>
        Object.assign(makeMockNode(), {
          type: 'highpass',
          frequency: makeMockParam(2800),
          Q: makeMockParam(0.7),
          gain: makeMockParam(0),
        }),
      createStereoPanner: () => Object.assign(makeMockNode(), { pan: makeMockParam(0) }),
      createConvolver: () => Object.assign(makeMockNode(), { normalize: false, buffer: null }),
      createOscillator: () =>
        Object.assign(makeMockNode(), {
          type: 'sine',
          frequency: makeMockParam(440),
          detune: makeMockParam(0),
          start: () => {},
          stop: () => {},
          setPeriodicWave: () => {},
        }),
      createBuffer: (_ch: number, len: number, sr: number) => ({
        sampleRate: sr,
        length: len,
        numberOfChannels: 1,
        duration: len / sr,
        getChannelData: () => new Float32Array(len),
      }),
      createBufferSource: () =>
        Object.assign(makeMockNode(), {
          buffer: null,
          loop: false,
          onended: null,
          start: () => {},
          stop: () => {},
        }),
    } as unknown as AudioContext & { currentTime: number };

    try {
      const pNodes = percussionKitPreset.nodes;
      const crashCymbal = pNodes.find((n) => n.id === 'crash_cymbal')!;
      const cymbalMallet = pNodes.find((n) => n.id === 'cymbal_crash_mallet')!;
      const profile = estimateBodyModes(crashCymbal, true, pNodes);
      const impact = resolveTwoBodyImpact(profile, crashCymbal, {
        impulseNs: 2.6,
        strikerNode: cymbalMallet,
        strikerGeomName: 'cymbal_mallet_head',
        localPoint: [0, -0.11, 0],
        sceneNodes: pNodes,
      });
      expect(impact.crashShimmer).toBeDefined();

      // 1. Trigger crash cymbal at Bar 1 strike (`t = 0.51 s`)
      const group = triggerOrMutateModalVoice({
        ctx: mockCtx,
        outputBus: mockCtx.destination as unknown as AudioNode,
        nodeId: crashCymbal.id,
        level: 0.45,
        tauC: impact.tauC,
        brightness: impact.effectiveBrightness,
        voices: impact.voices,
        crashShimmer: impact.crashShimmer,
        snare: { gain: 0.4, decaySec: 0.35, centerHz: 2400 },
        simTime: 0.508,
      })!;
      expect(group).not.toBeNull();
      expect(group.shimmerEnv).not.toBeNull();
      expect(group.auxEnvelopes.size).toBe(2);

      const shimmerAux = Array.from(group.auxEnvelopes).find((a) => a.kind === 'shimmer')!;
      const snareAux = Array.from(group.auxEnvelopes).find((a) => a.kind === 'snare')!;
      expect(shimmerAux).toBeDefined();
      expect(snareAux).toBeDefined();

      // Advance to `t = 1.074 s` (when `cymbal_choke_arm` emits its first `AUDIO_DAMPING` frame)
      currentTime = 1.074;
      const mode0Before = evaluateModeAmplitudeAt(group.modes[0], currentTime);
      const shimmerBefore = evaluateAuxEnvelopeAmplitudeAt(shimmerAux, currentTime);
      expect(mode0Before).toBeGreaterThan(0.01);
      expect(shimmerBefore).toBeGreaterThan(0.01);

      // Apply sustained `cymbal_choke_arm` contact damping frames (`t = 1.074..1.200 s`)
      for (let t = 1.074; t <= 1.200; t += 0.014) {
        currentTime = t;
        applyAudioDampingEvents(
          mockCtx,
          [
            {
              nodeId: crashCymbal.id,
              dampingNodeId: 'cymbal_choke_arm',
              dampingGeomName: 'choke_felt_pad',
              normalForce: 5.43,
              dampingRate: 7.29,
              softness: 0.92,
              contactDurationSec: t - 1.029,
              localPoint: [0, 0.082, 0],
            },
          ],
          pNodes,
          t,
        );
      }

      const mode0After = evaluateModeAmplitudeAt(group.modes[0], 1.28);
      const shimmerAfter = evaluateAuxEnvelopeAmplitudeAt(shimmerAux, 1.28);
      expect(mode0After).toBeLessThan(mode0Before * 0.12);
      expect(shimmerAfter).toBeLessThan(shimmerBefore * 0.05);

      const shimmerOps = (group.shimmerEnv!.gain as unknown as { ops: ParamOp[] }).ops;
      expect(shimmerOps.some((o) => o.op === 'cancel' && o.time >= 1.074)).toBe(true);
      expect(shimmerOps.some((o) => o.op === 'expRamp' && o.value === 0.0001 && o.time > 1.074 && o.time < 1.60)).toBe(true);
      expect(shimmerOps.some((o) => o.op === 'linearRamp' && o.value === 0 && o.time > 1.074 && o.time < 1.61)).toBe(true);

      // 2. Also verify `chokeBodyVoice` in `'grab'` mode ramps a fresh crash shimmer down in < 0.25 s
      silenceModalVoices(mockCtx, 0);
      currentTime = 2.08;
      const group2 = triggerOrMutateModalVoice({
        ctx: mockCtx,
        outputBus: mockCtx.destination as unknown as AudioNode,
        nodeId: crashCymbal.id,
        level: 0.45,
        tauC: impact.tauC,
        brightness: impact.effectiveBrightness,
        voices: impact.voices,
        crashShimmer: impact.crashShimmer,
        simTime: 2.08,
      })!;
      const shimmerAux2 = Array.from(group2.auxEnvelopes).find((a) => a.kind === 'shimmer')!;
      currentTime = 2.35;
      const grabBefore = evaluateAuxEnvelopeAmplitudeAt(shimmerAux2, currentTime);
      expect(grabBefore).toBeGreaterThan(0.01);
      expect(chokeBodyVoice(mockCtx, crashCymbal.id, { mode: 'grab' })).toBe(true);
      expect(evaluateAuxEnvelopeAmplitudeAt(shimmerAux2, 2.50)).toBeLessThan(grabBefore * 0.02);
    } finally {
      silenceModalVoices(mockCtx, 0);
    }
  });
});
