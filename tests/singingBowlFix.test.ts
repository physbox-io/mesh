import { describe, expect, it } from 'vitest';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { singingBowlFrictionPreset } from '../src/presets/singingBowlFriction';
import { solveContactFrictionVoice } from '../src/utils/contactFrictionAcoustics';
import { checkMeshInertia } from '../src/utils/meshInertiaCheck';
import { analyzeMesh, weldByPosition } from '../src/utils/meshIntegrity';
import { estimateBodyModes } from '../src/utils/modalAudio';
import { meshIntegrity } from '../src/utils/sceneSummary';
import { simulate } from './helpers/simulate';

function collectAllMeshGeoms(nodes: SceneNode[], out: { node: SceneNode; geom: SceneGeom }[] = []) {
  for (const node of nodes) {
    for (const geom of node.geoms ?? []) {
      if (geom.type === 'mesh') out.push({ node, geom });
    }
    if (node.children?.length) collectAllMeshGeoms(node.children, out);
  }
  return out;
}

describe('Tibetan Singing Bowl Pitch & Realistic 2-Manifold Visuals Fix', () => {
  it('builds closed, consistently outward-wound 2-manifolds (signedVolume > 0) for bowl, silk cushion, piping, and walnut plinth', () => {
    const nodes = singingBowlFrictionPreset.nodes;
    const bowl = nodes.find((n) => n.id === 'tibetan_singing_bowl')!;
    const cushionRig = nodes.find((n) => n.id === 'bowl_cushion_rig')!;
    expect(bowl).toBeDefined();
    expect(cushionRig).toBeDefined();

    // No ugly floating overhead gantry scaffolding
    const rigGeomNames = (cushionRig.geoms ?? []).map((g) => g.name);
    expect(rigGeomNames).not.toContain('gantry_rear_post');
    expect(rigGeomNames).not.toContain('gantry_overarm');
    expect(rigGeomNames).toContain('silk_ring_cushion');
    expect(rigGeomNames).toContain('cushion_gold_piping');
    expect(rigGeomNames).toContain('walnut_plinth_stand');

    // Verify puja mallet leans at ~18° on a concealed under-plinth rotary hub
    const orbitHub = cushionRig.children![0];
    const pujaMallet = orbitHub.children![0];
    expect(orbitHub.pos![2]).toBeLessThan(0.02); // concealed inside walnut base
    const suedeSleeve = pujaMallet.geoms.find((g) => g.name === 'puja_suede_sleeve')!;
    expect(Math.abs(suedeSleeve.euler?.[1] ?? 0)).toBeCloseTo(18, 1);

    // Verify authentic Himalayan belly silhouette on `bowl_shell_mesh`
    const bowlShell = bowl.geoms.find((g) => g.name === 'bowl_shell_mesh')!;
    expect(bowlShell).toBeDefined();
    expect(bowlShell.rgba).toEqual([0.76, 0.58, 0.26, 1]);
    const rv = bowlShell.renderVertices!;
    let maxR = 0;
    let maxZ = -Infinity;
    let minZ = Infinity;
    let rimRAtTop = 0;
    for (let i = 0; i + 2 < rv.length; i += 3) {
      const r = Math.hypot(rv[i], rv[i + 1]);
      const z = rv[i + 2];
      if (r > maxR) maxR = r;
      if (z > maxZ) maxZ = z;
      if (z < minZ) minZ = z;
      if (z >= 0.108 && z <= 0.112 && r > rimRAtTop) rimRAtTop = r;
    }
    expect(minZ).toBeCloseTo(0, 4);
    expect(maxZ).toBeGreaterThan(0.108);
    expect(maxZ).toBeLessThan(0.118);
    // Swells out to ~119 mm belly and curves inward to ~109 mm lip!
    expect(maxR).toBeCloseTo(0.119, 2);
    expect(rimRAtTop).toBeGreaterThan(0.107);
    expect(rimRAtTop).toBeLessThan(maxR - 0.005);

    // Every single mesh geom in the preset must be a closed 2-manifold with signedVolume > 0
    // in BOTH MuJoCo Z-up (`renderVertices`) and Three.js Y-up (`vertices`)!
    const allMeshes = collectAllMeshGeoms(nodes);
    expect(allMeshes.length).toBeGreaterThanOrEqual(4);

    for (const { geom } of allMeshes) {
      expect(geom.vertices?.length).toBeGreaterThan(9);
      expect(geom.renderVertices?.length).toBe(geom.vertices!.length);
      expect(geom.faces?.length).toBeGreaterThan(12);

      // 1. Check MuJoCo Z-up `renderVertices` (welded as slicers/sceneSummary check it)
      const weldedZ = weldByPosition(geom.renderVertices!, geom.faces!);
      const mZ = analyzeMesh(weldedZ.positions, weldedZ.faces)!;
      expect(mZ, `${geom.name} Z-up analyzeMesh`).not.toBeNull();
      expect(mZ.closed, `${geom.name} Z-up closed`).toBe(true);
      expect(mZ.consistentlyWound, `${geom.name} Z-up consistentlyWound`).toBe(true);
      expect(mZ.volume, `${geom.name} Z-up signedVolume > 0`).toBeGreaterThan(0);
      expect(mZ.boundaryEdges, `${geom.name} Z-up boundaryEdges`).toBe(0);
      expect(mZ.nonManifoldEdges, `${geom.name} Z-up nonManifoldEdges`).toBe(0);
      expect(mZ.degenerateTriangles, `${geom.name} Z-up degenerateTriangles`).toBe(0);
      expect(checkMeshInertia(geom.renderVertices!, geom.faces!).ok, `${geom.name} Z-up inertia`).toBe(true);

      // 2. Check Three.js Y-up `vertices` (used by FrontSide viewport rendering & MJCF asset export)
      const weldedY = weldByPosition(geom.vertices!, geom.faces!);
      const mY = analyzeMesh(weldedY.positions, weldedY.faces)!;
      expect(mY, `${geom.name} Y-up analyzeMesh`).not.toBeNull();
      expect(mY.closed, `${geom.name} Y-up closed`).toBe(true);
      expect(mY.consistentlyWound, `${geom.name} Y-up consistentlyWound`).toBe(true);
      expect(mY.volume, `${geom.name} Y-up signedVolume > 0`).toBeGreaterThan(0);
      expect(mY.volume).toBeCloseTo(mZ.volume, 7);

      // 3. Verify `physics_get_scene_summary`'s `meshIntegrity` reports zero winding warnings
      const summary = meshIntegrity(geom);
      expect(summary.watertight, `${geom.name} summary watertight`).toBe(true);
      expect(summary.windingInverted, `${geom.name} windingInverted`).toBeUndefined();
      expect(summary.windingMixed, `${geom.name} windingMixed`).toBeUndefined();
      expect(summary.weighedByHull, `${geom.name} weighedByHull`).toBeUndefined();
    }
  });

  it('locks singing_bowl onto a deep ~220 Hz (2,0) rim fundamental + ~607 Hz (3,0) harmonic across a full 3.5 s MuJoCo orbit', async () => {
    const nodes = singingBowlFrictionPreset.nodes;
    const bowl = nodes.find((n) => n.id === 'tibetan_singing_bowl')!;
    const cushionRig = nodes.find((n) => n.id === 'bowl_cushion_rig')!;
    const pujaMallet = cushionRig.children![0].children![0];

    expect(bowl.tunedPitchHz).toBe(220);

    // Verify 3D hollow bronze shell modal extraction (`regime === 'plate'` hollow shell, NOT ~3800 Hz solid block!) + 3D `bodyIr`
    const bowlProfile = estimateBodyModes(bowl, true);
    expect(bowlProfile.regime).toBe('plate');
    expect(bowlProfile.fundamentalHz).toBeLessThan(500);
    expect(bowlProfile.material.qualityQ).toBeGreaterThanOrEqual(700);
    expect(bowlProfile.bodyIr).not.toBeNull();
    expect(bowlProfile.bodyIr!.length).toBeGreaterThan(512);

    // Live headless MuJoCo simulation over a full 3.5 s orbit (> 1.15 complete 360° revolutions!)
    const sim = await simulate(singingBowlFrictionPreset);
    try {
      expect(sim.data.ncon).toBe(0);

      const bowlBid = sim.bodyId(bowl.name);
      const pujaBid = sim.bodyId(pujaMallet.name);
      expect(bowlBid).toBeGreaterThan(0);
      expect(pujaBid).toBeGreaterThan(0);

      const dt = sim.model.opt.timestep;
      const totalSteps = Math.round(3.50 / dt);
      let postEngageSteps = 0;
      let contactSteps = 0;
      let minSlideQ = Infinity;
      let maxSlideQ = -Infinity;
      const sampledVoices: ReturnType<typeof solveContactFrictionVoice>[] = [];
      let prevPujaPos = sim.bodyPos(pujaMallet.name);

      for (let s = 1; s <= totalSteps; s++) {
        sim.step(1);
        const curPujaPos = sim.bodyPos(pujaMallet.name);
        const vxMallet = (curPujaPos[0] - prevPujaPos[0]) / dt;
        const vyMallet = (curPujaPos[1] - prevPujaPos[1]) / dt;
        const vzMallet = (curPujaPos[2] - prevPujaPos[2]) / dt;
        prevPujaPos = curPujaPos;

        const t = sim.time();
        if (t < 0.25) continue;

        postEngageSteps++;
        const qSlide = sim.jointPos('puja_radial_press');
        if (qSlide < minSlideQ) minSlideQ = qSlide;
        if (qSlide > maxSlideQ) maxSlideQ = qSlide;

        // Inspect live MuJoCo contacts between `tibetan_singing_bowl` and `puja_mallet`
        let hitLocalPoint: [number, number, number] | null = null;
        const contactVec = sim.data.contact;
        try {
          const ncon = contactVec.size();
          for (let c = 0; c < ncon; c++) {
            const ct = contactVec.get(c);
            if (!ct) continue;
            try {
              const b1 = sim.model.geom_bodyid[ct.geom1];
              const b2 = sim.model.geom_bodyid[ct.geom2];
              if ((b1 === bowlBid && b2 === pujaBid) || (b1 === pujaBid && b2 === bowlBid)) {
                const pos = ct.pos;
                const wx = pos[0];
                const wy = pos[1];
                const wz = pos[2];
                const bx = sim.data.xpos[bowlBid * 3];
                const by = sim.data.xpos[bowlBid * 3 + 1];
                const bz = sim.data.xpos[bowlBid * 3 + 2];
                hitLocalPoint = [wx - bx, wy - by, wz - bz];
                break;
              }
            } finally {
              ct.delete();
            }
          }
        } finally {
          contactVec.delete();
        }

        if (hitLocalPoint) {
          contactSteps++;
          // Sample acoustic voice every 50 ms across the full 3.5 s orbit
          if (s % Math.max(1, Math.round(0.05 / dt)) === 0) {
            const rContact = Math.hypot(hitLocalPoint[0], hitLocalPoint[1]);
            expect(rContact).toBeGreaterThan(0.105);
            expect(rContact).toBeLessThan(0.115);
            expect(hitLocalPoint[2]).toBeGreaterThan(0.102);
            expect(hitLocalPoint[2]).toBeLessThan(0.115);

            // Compute live circumferential rub alignment exactly as `physicsWorker.ts` does
            const vNorm = Math.hypot(vxMallet, vyMallet, vzMallet);
            const tx = -hitLocalPoint[1] / rContact;
            const ty = hitLocalPoint[0] / rContact;
            const liveRubAlign = Math.abs(vxMallet * tx + vyMallet * ty) / Math.max(1e-6, vNorm);
            expect(liveRubAlign).toBeGreaterThan(0.98);

            const netSpringForce = Math.max(0.4, 2.85 - 85 * qSlide);

            const voice = solveContactFrictionVoice(
              {
                pairId: `${bowl.id}:${pujaMallet.id}`,
                nodeId: bowl.id,
                otherNodeId: pujaMallet.id,
                selfGeomName: 'bowl_lip_ring_collider',
                otherGeomName: 'puja_suede_band',
                tangentSpeed: vNorm,
                rollSpeedMps: 0.0,
                normalForce: netSpringForce,
                muFriction: 0.38,
                rollingRatio: 0.0,
                circumferentialRub: +liveRubAlign.toFixed(3),
                localPoint: hitLocalPoint,
                contactDurationSec: t - 0.06,
              },
              {
                primaryNode: bowl,
                primaryProfile: bowlProfile,
                partnerNode: pujaMallet,
              },
            );
            sampledVoices.push(voice);
          }
        }
      }

      // 1. Uninterrupted steady smooth tangential contact around > 1.25 full 360° orbits!
      expect(
        contactSteps,
        `slide=[${minSlideQ.toFixed(5)}, ${maxSlideQ.toFixed(5)}] orbit=${sim.jointPos('puja_orbit_hinge').toFixed(3)} samples=${sampledVoices.length}`,
      ).toBe(postEngageSteps);
      expect(Math.abs(sim.jointPos('puja_orbit_hinge'))).toBeGreaterThan(2 * Math.PI);
      // Sub-millimeter radial slide ripple (zero polygonal facet chatter!)
      expect(maxSlideQ - minSlideQ).toBeLessThan(0.0012);

      // 2. Every sampled voice across the entire 3.5 s orbit locks cleanly onto `rim_singing` in [195, 250] Hz!
      expect(sampledVoices.length).toBeGreaterThanOrEqual(60);
      for (const v of sampledVoices) {
        expect(v.active).toBe(true);
        expect(v.regime).toBe('rim_singing');
        expect(v.tonalActive).toBe(true);
        expect(v.tonalFreqHz).toBeGreaterThanOrEqual(195);
        expect(v.tonalFreqHz).toBeLessThanOrEqual(250);
        expect(v.tonalFreqHz).toBeCloseTo(220, 1);
        expect(v.mode1Hz).toBeCloseTo(220, 1);
        expect(v.mode2Hz).toBeCloseTo(220 * 2.76, 0); // ~607.2 Hz (3,0) bell harmonic
        expect(v.tonalBeatFreqHz).toBeGreaterThan(v.tonalFreqHz + 0.35);
        expect(v.tonalBeatFreqHz).toBeLessThan(v.tonalFreqHz + 4.0);
        expect(v.patchLowpassHz).toBeLessThan(900);
        expect(v.noiseGain).toBeLessThan(0.02);
      }
    } finally {
      sim.dispose();
    }
  });

  it('prevents rim_singing from locking onto upper 900-2500 Hz modes or bursting into squeal/scrape at initial 24 ms contact', () => {
    const nodes = singingBowlFrictionPreset.nodes;
    const bowl = nodes.find((n) => n.id === 'tibetan_singing_bowl')!;
    const baseProfile = estimateBodyModes(bowl, false);

    // Even without tunedPitchHz and with a low-Q cavity air resonance + shrill upper modes present,
    // `rim_singing` skips the low-Q air mode and locks strictly onto the 224 Hz lowest flexural mode!
    const untunedBowl: SceneNode = { ...bowl, tunedPitchHz: undefined };
    const profileWithAirAndUpper = {
      ...baseProfile,
      fundamentalHz: 1480,
      rawFreqsHz: [92, 224, 618, 1480],
      rawModeQs: [12, 780, 780, 780],
      modes: [
        { freqHz: 1480, gain: 0.9, decaySec: 1.2 },
        { freqHz: 224, gain: 0.7, decaySec: 2.8 },
      ],
    };

    const earlyRimVoice = solveContactFrictionVoice(
      {
        nodeId: untunedBowl.id,
        otherNodeId: 'puja_mallet',
        tangentSpeed: 0.24,
        rollSpeedMps: 0,
        normalForce: 2.2,
        muFriction: 0.42,
        rollingRatio: 0,
        circumferentialRub: 0.95,
        localPoint: [0.110, 0, 0.109],
        contactDurationSec: 0.024, // Very first worker friction emission (> 22 ms)
      },
      { primaryNode: untunedBowl, primaryProfile: profileWithAirAndUpper },
    );

    expect(earlyRimVoice.active).toBe(true);
    expect(earlyRimVoice.regime).toBe('rim_singing');
    expect(earlyRimVoice.tonalFreqHz).toBeCloseTo(224, 1);
    expect(earlyRimVoice.mode1Hz).toBeCloseTo(224, 1);
    expect(earlyRimVoice.mode2Hz).toBeCloseTo(224 * 2.76, 0);
    expect(earlyRimVoice.patchLowpassHz).toBeLessThan(900);
  });
});
