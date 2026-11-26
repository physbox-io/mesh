import { describe, it, expect } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { generateTubeMeshData } from '../src/utils/geom';
import { tuneWindInstrumentToPitch } from '../src/utils/acousticTuning';
import { extractBoreWaveguide, solvePlayableWindVoice } from '../src/utils/windAcoustics';
import { windPitchReadout } from '../src/utils/acousticAuthoring';
import { objectReply } from '../src/utils/objectReply';

function makeHollowTubeWindNode(opts: {
  id: string;
  exciter: 'flute_jet' | 'reed' | 'brass_lip' | 'flap_valve';
  innerRadius: number;
  outerRadius: number;
  height: number;
  embouchureHz: number;
  breathKPa?: number;
  isTube?: boolean;
  toneholeJoints?: NonNullable<SceneNode['windInstrument']>['toneholeJoints'];
}): SceneNode {
  const md = generateTubeMeshData(opts.innerRadius, opts.outerRadius, opts.height, 24);
  return {
    id: opts.id,
    name: opts.id,
    type: 'body',
    pos: [0, 0, 0.2],
    ...(opts.isTube !== false
      ? {
          isTube: true,
          innerRadius: opts.innerRadius,
          outerRadius: opts.outerRadius,
          height: opts.height,
        }
      : {}),
    geoms: [
      {
        name: `${opts.id}_bore`,
        type: 'mesh',
        size: [1],
        vertices: md.vertices,
        renderVertices: md.renderVertices,
        faces: md.faces,
      },
    ],
    joints: [],
    children: [],
    windInstrument: {
      exciter: opts.exciter,
      breathKPa: opts.breathKPa ?? 3.5,
      embouchureHz: opts.embouchureHz,
      ...(opts.toneholeJoints ? { toneholeJoints: opts.toneholeJoints } : {}),
    },
  };
}

describe('Acoustics dogfooding audit fixes', () => {
  describe('1. tuneWindInstrumentToPitch exciter classification & converged tunedPitchHz', () => {
    it('scales bore length for short flute_jet with low default embouchureHz instead of taking flap_valve path', () => {
      // Short 0.16m open flute has f1 ≈ 950 Hz; default embouchureHz=260 < 950 * 0.45
      const shortFlute = makeHollowTubeWindNode({
        id: 'short_flute',
        exciter: 'flute_jet',
        innerRadius: 0.008,
        outerRadius: 0.010,
        height: 0.16,
        embouchureHz: 260,
      });
      const beforeBore = extractBoreWaveguide(shortFlute)!;
      expect(beforeBore.resonantModesHz[0]).toBeGreaterThan(750);
      expect(shortFlute.windInstrument!.embouchureHz).toBeLessThan(beforeBore.resonantModesHz[0] * 0.45);

      const tuned = tuneWindInstrumentToPitch(shortFlute, 440);
      expect(tuned.height!).toBeGreaterThan(shortFlute.height! * 1.5);

      const afterBore = extractBoreWaveguide(tuned)!;
      const afterVoice = solvePlayableWindVoice(afterBore, 3.5, tuned.windInstrument!.embouchureHz);
      expect(Math.abs(afterVoice.pitchHz - 440)).toBeLessThan(2.5);
      expect(tuned.tunedPitchHz).toBeCloseTo(afterVoice.pitchHz, 1);
    });

    it('scales bore length for short reed with low default embouchureHz instead of taking flap_valve path', () => {
      // Short 0.12m cylindrical reed bore has f1 ≈ 680 Hz; embouchureHz=260 < 680 * 0.45
      const shortReed = makeHollowTubeWindNode({
        id: 'short_reed',
        exciter: 'reed',
        innerRadius: 0.007,
        outerRadius: 0.010,
        height: 0.12,
        embouchureHz: 260,
      });
      const beforeBore = extractBoreWaveguide(shortReed)!;
      expect(beforeBore.resonantModesHz[0]).toBeGreaterThan(580);
      expect(shortReed.windInstrument!.embouchureHz).toBeLessThan(beforeBore.resonantModesHz[0] * 0.45);

      const tuned = tuneWindInstrumentToPitch(shortReed, 330);
      expect(tuned.height!).toBeGreaterThan(shortReed.height! * 1.5);

      const afterBore = extractBoreWaveguide(tuned)!;
      const afterVoice = solvePlayableWindVoice(afterBore, 3.5, tuned.windInstrument!.embouchureHz);
      expect(Math.abs(afterVoice.pitchHz - 330)).toBeLessThan(2.5);
      expect(tuned.tunedPitchHz).toBeCloseTo(afterVoice.pitchHz, 1);
    });

    it('keeps autonomous embouchure-only tuning strictly for flap_valve', () => {
      const flap = makeHollowTubeWindNode({
        id: 'whoopee_nozzle',
        exciter: 'flap_valve',
        innerRadius: 0.006,
        outerRadius: 0.009,
        height: 0.08,
        embouchureHz: 55,
      });
      const tuned = tuneWindInstrumentToPitch(flap, 110);
      expect(tuned.height).toBe(flap.height);
      expect(tuned.windInstrument!.embouchureHz).toBe(110);
      expect(tuned.tunedPitchHz).toBe(110);
    });

    it('stamps tunedPitchHz with actual converged bestHz when bore scaling hits clamp', () => {
      // 0.14m flute (~1100 Hz) asked to tune down to 40 Hz -> hits 5.5x max scale clamp (~220 Hz)
      const flute = makeHollowTubeWindNode({
        id: 'clamped_flute',
        exciter: 'flute_jet',
        innerRadius: 0.008,
        outerRadius: 0.010,
        height: 0.14,
        embouchureHz: 440,
      });
      const tuned = tuneWindInstrumentToPitch(flute, 40);
      const afterBore = extractBoreWaveguide(tuned)!;
      const afterVoice = solvePlayableWindVoice(afterBore, 3.5, tuned.windInstrument!.embouchureHz);
      // Should report actual clamped pitch (~200+ Hz), NOT falsely stamp 40 Hz
      expect(tuned.tunedPitchHz).toBeGreaterThan(100);
      expect(Math.abs(tuned.tunedPitchHz! - afterVoice.pitchHz)).toBeLessThan(0.5);
    });
  });

  describe('2. solveConicalBoreTMM cache key sub-cell tonehole resolution', () => {
    it('sweeps tonehole axialFraction smoothly within a single cell without staircase jumps', () => {
      const fractions = [0.500, 0.504, 0.508, 0.512, 0.516, 0.520, 0.524, 0.528];
      const pitches: number[] = [];

      for (const frac of fractions) {
        const node = makeHollowTubeWindNode({
          id: 'sweep_clar',
          exciter: 'reed',
          innerRadius: 0.0075,
          outerRadius: 0.010,
          height: 0.45,
          embouchureHz: 260,
          toneholeJoints: [{ jointName: 'h1', axialFraction: frac, diameterMm: 9 }],
        });
        // Joint position 0.15 -> openAmount = 1.0 (fully open hinge/key hole)
        const bore = extractBoreWaveguide(node, { h1: 0.15 })!;
        pitches.push(bore.resonantModesHz[0]);
      }

      // Every step should be smooth (no 52-cent cell-boundary staircase jump) and distinct across sub-cell steps
      const uniquePitches = new Set(pitches.map((p) => p.toFixed(2)));
      expect(uniquePitches.size).toBeGreaterThanOrEqual(7);
      for (let i = 1; i < pitches.length; i++) {
        const cents = Math.abs(1200 * Math.log2(pitches[i] / pitches[i - 1]));
        expect(cents).toBeLessThan(28);
        // Moving the open hole closer to the bell (higher axialFraction) lengthens the active bore -> lower pitch
        expect(pitches[i]).toBeLessThanOrEqual(pitches[i - 1] + 0.05);
      }
    });
  });

  describe('3. muteFactor on thick-walled tubes vs genuinely constricted bells', () => {
    it('reports muteFactor ≈ 0 for an unobstructed uniform thick-walled tube (rIn=7mm, rOut=11mm)', () => {
      const thickWoodTube = makeHollowTubeWindNode({
        id: 'thick_wood_clarinet',
        exciter: 'reed',
        innerRadius: 0.007,
        outerRadius: 0.011,
        height: 0.40,
        embouchureHz: 260,
      });
      const bore = extractBoreWaveguide(thickWoodTube)!;
      expect(bore.muteFactor ?? 0).toBeLessThan(0.02);
    });

    it('reports positive muteFactor when the bell inner airway is genuinely constricted', () => {
      // Build a multi-ring hollow thick-walled tube (rIn=7mm, rOut=11mm) with a genuine bell constriction
      // (3 inward mute baffles inside the bell end z in [0.13, 0.19], reducing both rEff and star minRatio)
      const nRings = 16;
      const nSeg = 24;
      const h = 0.40;
      const rIn = 0.007;
      const rOut = 0.011;
      const rv: number[] = [];
      const faces: number[] = [];
      const ringVertCount = nSeg * 2; // outer + inner per ring
      for (let ri = 0; ri <= nRings; ri++) {
        const s = ri / nRings;
        const z = (s - 0.5) * h;
        for (let si = 0; si < nSeg; si++) {
          const ang = (si / nSeg) * Math.PI * 2;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          // Outer wall stays uniform rOut
          rv.push(rOut * ca, rOut * sa, z);
          // Mouthpiece slightly narrower (5mm) so bore orientation stays mouth->bell,
          // mid-bore is 7mm, and bell end (s >= 0.82) is genuinely constricted to 4.2mm
          let rLocal = rIn;
          if (s <= 0.15) {
            rLocal = 0.005;
          } else if (s >= 0.82) {
            rLocal = 0.0042;
          }
          rv.push(rLocal * ca, rLocal * sa, z);
        }
      }
      for (let ri = 0; ri < nRings; ri++) {
        const b0 = ri * ringVertCount;
        const b1 = (ri + 1) * ringVertCount;
        for (let si = 0; si < nSeg; si++) {
          const sn = (si + 1) % nSeg;
          // Outer wall (outward normal)
          const o00 = b0 + si * 2;
          const o01 = b0 + sn * 2;
          const o10 = b1 + si * 2;
          const o11 = b1 + sn * 2;
          faces.push(o00, o01, o11, o00, o11, o10);
          // Inner wall (inward normal)
          const i00 = o00 + 1;
          const i01 = o01 + 1;
          const i10 = o10 + 1;
          const i11 = o11 + 1;
          faces.push(i00, i11, i01, i00, i10, i11);
        }
      }
      // End caps (annular rings at bottom ri=0 and top ri=nRings)
      const topBase = nRings * ringVertCount;
      for (let si = 0; si < nSeg; si++) {
        const sn = (si + 1) % nSeg;
        faces.push(si * 2, si * 2 + 1, sn * 2 + 1, si * 2, sn * 2 + 1, sn * 2);
        faces.push(topBase + si * 2, topBase + sn * 2, topBase + sn * 2 + 1, topBase + si * 2, topBase + sn * 2 + 1, topBase + si * 2 + 1);
      }
      const mutedNode: SceneNode = {
        id: 'constricted_bell_tube',
        name: 'constricted_bell_tube',
        type: 'body',
        pos: [0, 0, 0.2],
        geoms: [{ name: 'muted_bore', type: 'mesh', size: [1], renderVertices: rv, faces }],
        joints: [],
        children: [],
        windInstrument: { exciter: 'reed', breathKPa: 3.5, embouchureHz: 260 },
      };
      const mutedBore = extractBoreWaveguide(mutedNode)!;
      expect(mutedBore.muteFactor ?? 0).toBeGreaterThan(0.25);
    });
  });

  describe('4. objectReply air-column overtoneRatio/regime and tunedPitchHz inclusion', () => {
    it('reports air-column overtoneRatio and regime for windInstrument (reed & flute)', () => {
      const reed = makeHollowTubeWindNode({
        id: 'reply_reed',
        exciter: 'reed',
        innerRadius: 0.007,
        outerRadius: 0.011,
        height: 0.40,
        embouchureHz: 200,
      });
      const reedBore = extractBoreWaveguide(reed)!;
      const expectedReed = windPitchReadout(reed.windInstrument!, reedBore);
      const reedReply = objectReply(reed) as { acoustics?: Record<string, unknown> };
      expect(reedReply.acoustics).toBeDefined();
      expect(reedReply.acoustics!.regime).toBe('air_column');
      expect(reedReply.acoustics!.overtoneRatio).toBeCloseTo(expectedReed.overtoneRatio, 2);
      // Cylindrical stopped reed has odd harmonics -> overtoneRatio near 3.0 (not solid flexural 2.756)
      expect(reedReply.acoustics!.overtoneRatio as number).toBeGreaterThan(2.85);

      const flute = makeHollowTubeWindNode({
        id: 'reply_flute',
        exciter: 'flute_jet',
        innerRadius: 0.008,
        outerRadius: 0.010,
        height: 0.40,
        embouchureHz: 400,
      });
      const fluteBore = extractBoreWaveguide(flute)!;
      const expectedFlute = windPitchReadout(flute.windInstrument!, fluteBore);
      const fluteReply = objectReply(flute) as { acoustics?: Record<string, unknown> };
      expect(fluteReply.acoustics!.regime).toBe('air_column');
      expect(fluteReply.acoustics!.overtoneRatio).toBeCloseTo(expectedFlute.overtoneRatio, 2);
      // Open-open flute has all harmonics -> overtoneRatio near 2.0
      expect(fluteReply.acoustics!.overtoneRatio as number).toBeGreaterThan(1.85);
      expect(fluteReply.acoustics!.overtoneRatio as number).toBeLessThan(2.15);
    });

    it('reports air-column overtoneRatio and regime for resonatorTube', () => {
      const md = generateTubeMeshData(0.02, 0.022, 0.30, 24);
      const closedTube: SceneNode = {
        id: 'res_closed',
        name: 'res_closed',
        type: 'body',
        pos: [0, 0, 0.2],
        isTube: true,
        innerRadius: 0.02,
        outerRadius: 0.022,
        height: 0.30,
        geoms: [{ name: 'res_g', type: 'mesh', size: [1], vertices: md.vertices, renderVertices: md.renderVertices, faces: md.faces }],
        joints: [],
        children: [],
        resonatorTube: { endCondition: 'open_closed' },
      };
      const closedReply = objectReply(closedTube) as { acoustics?: Record<string, unknown> };
      expect(closedReply.acoustics).toBeDefined();
      expect(closedReply.acoustics!.regime).toBe('air_column');
      expect(closedReply.acoustics!.overtoneRatio).toBeCloseTo(3, 2);

      const openTube: SceneNode = {
        ...closedTube,
        id: 'res_open',
        resonatorTube: { endCondition: 'open_open' },
      };
      const openReply = objectReply(openTube) as { acoustics?: Record<string, unknown> };
      expect(openReply.acoustics!.regime).toBe('air_column');
      expect(openReply.acoustics!.overtoneRatio).toBeCloseTo(2, 2);
    });

    it('includes acoustics in objectReply for a plain body that only has tunedPitchHz', () => {
      const plainTunedBar: SceneNode = {
        id: 'plain_tuned_bar',
        name: 'plain_tuned_bar',
        type: 'body',
        pos: [0, 0, 0.1],
        tunedPitchHz: 440,
        geoms: [{ name: 'bar', type: 'box', size: [0.15, 0.02, 0.008] }],
        joints: [],
        children: [],
      };
      const reply = objectReply(plainTunedBar) as { acoustics?: Record<string, unknown> };
      expect(reply.acoustics).toBeDefined();
      expect(typeof reply.acoustics!.fundamentalHz).toBe('number');
      expect(typeof reply.acoustics!.note).toBe('string');
    });
  });

  describe('5. scaleGeomAlongSingleAxis scales colliderVertices, baseVertices, and baseRenderVertices', () => {
    it('scales all 5 mesh vertex arrays along the bore axis in their respective coordinate frames', () => {
      const md = generateTubeMeshData(0.008, 0.010, 0.30, 24);
      const node: SceneNode = {
        id: 'custom_mesh_flute',
        name: 'custom_mesh_flute',
        type: 'body',
        pos: [0, 0, 0.2],
        // Not isTube -> tuneWindInstrumentToPitch invokes scaleGeomAlongSingleAxis on the mesh geom!
        geoms: [
          {
            name: 'flute_mesh',
            type: 'mesh',
            size: [1],
            renderVertices: [...md.renderVertices],
            colliderVertices: [...md.renderVertices],
            baseRenderVertices: [...md.renderVertices],
            vertices: [...md.vertices],
            baseVertices: [...md.vertices],
            faces: md.faces,
          },
        ],
        joints: [],
        children: [],
        windInstrument: {
          exciter: 'flute_jet',
          breathKPa: 3.5,
          embouchureHz: 500,
        },
      };

      const tuned = tuneWindInstrumentToPitch(node, 330);
      const g0 = node.geoms[0];
      const g1 = tuned.geoms[0];

      // Bore axis is Z (index 2 in Z-up; index 1 in Three.js Y-up).
      const zSpan = (arr: number[], axisIdx: number) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = axisIdx; i < arr.length; i += 3) {
          if (arr[i] < lo) lo = arr[i];
          if (arr[i] > hi) hi = arr[i];
        }
        return hi - lo;
      };

      const expectedScale = zSpan(g1.renderVertices!, 2) / zSpan(g0.renderVertices!, 2);
      expect(expectedScale).toBeGreaterThan(1.3);

      // Z-up arrays: scaled along axis 2, unchanged along axis 0 & 1
      expect(zSpan(g1.colliderVertices!, 2) / zSpan(g0.colliderVertices!, 2)).toBeCloseTo(expectedScale, 4);
      expect(zSpan(g1.colliderVertices!, 0) / zSpan(g0.colliderVertices!, 0)).toBeCloseTo(1, 4);
      expect(zSpan(g1.baseRenderVertices!, 2) / zSpan(g0.baseRenderVertices!, 2)).toBeCloseTo(expectedScale, 4);
      expect(zSpan(g1.baseRenderVertices!, 0) / zSpan(g0.baseRenderVertices!, 0)).toBeCloseTo(1, 4);

      // Y-up arrays: Z-up axis 2 maps to Y-up axis 1; X (0) and Z (2) unchanged
      expect(zSpan(g1.vertices!, 1) / zSpan(g0.vertices!, 1)).toBeCloseTo(expectedScale, 4);
      expect(zSpan(g1.vertices!, 0) / zSpan(g0.vertices!, 0)).toBeCloseTo(1, 4);
      expect(zSpan(g1.baseVertices!, 1) / zSpan(g0.baseVertices!, 1)).toBeCloseTo(expectedScale, 4);
      expect(zSpan(g1.baseVertices!, 0) / zSpan(g0.baseVertices!, 0)).toBeCloseTo(1, 4);
    });
  });
});
