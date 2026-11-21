import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagInWindPreset } from '../src/presets/flagInWind';
import { PRESETS } from '../src/presets/presetScenes';
import { FABRICS } from '../src/components/inspector/garmentFields';
import { weaveTexture } from '../src/components/scene/clothWeaveTexture';
import type { ClothMaterialName } from '../src/types/cloth';
import {
  evaluateGustWind,
  solveAeroAcousticVoice,
  solveClothSnapPulse,
  type AeroSynthParams,
  type SnapSynthParams,
} from '../src/utils/aeroAcoustics';
import { ensureNativeAeroBank, postWorkletAeroUpdate } from '../src/utils/modalAudioWorklet';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { cornerHold, pieceSize } from '../src/utils/cloth/clothSheet';
import { estimateBodyModes, resolveTwoBodyImpact } from '../src/utils/modalAudio';
import { makePresetNoteCard } from '../src/utils/noteCards';
import { objectReply } from '../src/utils/objectReply';
import { PRESET_SHELF } from '../src/utils/sceneCatalog';
import { clothRun, percentile } from './clothSimHarness';
import { simulate } from './helpers/simulate';

describe('Flag-in-the-Wind Aeroacoustics, Ripstop Fabric & MCP Parity', () => {
  it('registers ripstop (55 g/m² marine ripstop nylon) in CLOTH_MATERIALS, FABRICS, and weaveTexture', () => {
    const ripstop = CLOTH_MATERIALS.ripstop;
    expect(ripstop).toBeDefined();
    expect(ripstop.arealDensity).toBeCloseTo(0.055, 4);
    expect(ripstop.young).toBe(8e6);
    expect(ripstop.poisson).toBeCloseTo(0.22, 3);
    expect(ripstop.thickness).toBeCloseTo(0.0002, 6);
    expect(ripstop.bending).toBe(true);
    expect(ripstop.damping).toBeCloseTo(0.16, 3);
    expect(ripstop.friction).toBeCloseTo(0.30, 3);
    expect(ripstop.windCd).toBeCloseTo(1.25, 3);

    expect(FABRICS.some((f) => f.id === 'ripstop')).toBe(true);

    const tex = weaveTexture('ripstop');
    expect(tex).toBeDefined();
    expect(tex.image.width).toBe(128);
    expect(tex.image.height).toBe(128);
    const data = tex.image.data as Uint8Array;
    let minR = 255;
    let maxR = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < minR) minR = data[i];
      if (data[i] > maxR) maxR = data[i];
    }
    expect(maxR - minR).toBeGreaterThan(10);
  });

  it('registers flag_in_wind in PRESETS, PRESET_SHELF ("Make it"), and PRESET_NOTE_CARDS with clean cloth geometry', () => {
    const entry = PRESETS.flag_in_wind;
    expect(entry).toBeDefined();
    expect(entry.environment).toMatchObject({ windX: 8.8, windY: 0.6 });
    expect(entry.camera).toBeDefined();
    expect(PRESET_SHELF.flag_in_wind).toBe('Make it');

    const card = makePresetNoteCard('flag_in_wind');
    expect(card).not.toBeNull();
    expect(card!.markdown).toMatch(/^#\s+/);
    expect(card!.markdown).toContain('## Physics');
    expect(card!.markdown).toContain('## Try it');

    const nodes = flagInWindPreset.nodes;
    const flagpole = nodes.find((n) => n.id === 'flagpole')!;
    const shackle = (flagpole.children ?? []).find((c) => c.id === 'halyard_shackle');
    const ensign = nodes.find((n) => n.id === 'ensign_flag')!;
    const burgee = nodes.find((n) => n.id === 'burgee_pennant')!;

    expect(flagpole).toBeDefined();
    expect(flagpole.deformMaterial).toBe('softMetal');
    expect(shackle).toBeDefined();
    expect(ensign?.cloth?.material).toBe('ripstop');
    expect(ensign?.cloth?.pattern?.svg).toContain('<svg');
    expect(burgee?.cloth?.material).toBe('canvas');
    expect(burgee?.cloth?.pattern?.svg).toContain('<svg');

    // ClothCard inspector sizing & corner-hold compatibility
    const [ew, eh] = pieceSize(ensign.cloth!.pieces![0]);
    expect(ew).toBeCloseTo(0.92, 3);
    expect(eh).toBeCloseTo(0.56, 3);
    expect(cornerHold(ensign.cloth!.ties, 'ensign', 'hoist')).toEqual({ kind: 'body', to: 'flagpole' });
    expect(cornerHold(ensign.cloth!.ties, 'ensign', 'bottom')).toEqual({ kind: 'body', to: 'flagpole' });
    expect(cornerHold(ensign.cloth!.ties, 'ensign', 'fly')).toEqual({ kind: 'free' });
    expect(cornerHold(ensign.cloth!.ties, 'ensign', 'top')).toEqual({ kind: 'free' });

    const [bw, bh] = pieceSize(burgee.cloth!.pieces![0]);
    expect(bw).toBeCloseTo(0.46, 3);
    expect(bh).toBeCloseTo(0.26, 3);
  });

  it('compiles cleanly in MuJoCo with 0 t=0 contacts, hollow-tube flagpole modes, and halyard shackle clinks in 8.8 m/s wind', async () => {
    const nodes = flagInWindPreset.nodes;
    const flagpole = nodes.find((n) => n.id === 'flagpole')!;
    const shackle = flagpole.children!.find((c) => c.id === 'halyard_shackle')!;

    const poleProfile = estimateBodyModes(flagpole, true);
    expect(poleProfile.fundamentalHz).toBeGreaterThan(20);
    expect(poleProfile.modes.length).toBeGreaterThan(0);
    expect(poleProfile.hasAcousticCavity).toBe(true);
    expect(poleProfile.bodyIr).not.toBeNull();

    // Grommet tie-load & brass shackle impacts excite audible structural voices on flagpole
    const grommetHit = resolveTwoBodyImpact(poleProfile, flagpole, {
      impulseNs: 0.08,
      strikerNode: shackle,
      localPoint: [0.035, 0, 2.48],
    });
    expect(grommetHit.voices.length).toBeGreaterThan(0);
    expect(grommetHit.voices.some((v) => v.gain > 0.01)).toBe(true);

    const sim = await simulate(flagInWindPreset, { windX: 8.8, windY: 0.6 });
    try {
      expect(sim.data.ncon).toBe(0);

      const poleBid = sim.bodyId('flagpole');
      const shackleBid = sim.bodyId('halyard_shackle');
      expect(poleBid).toBeGreaterThan(0);
      expect(shackleBid).toBeGreaterThan(0);

      let clinkContacts = 0;
      const steps = Math.round(1.2 / sim.model.opt.timestep);
      for (let s = 0; s < steps; s++) {
        sim.step(1);
        const contactVec = sim.data.contact;
        try {
          const ncon = contactVec.size();
          for (let c = 0; c < ncon; c++) {
            const ct = contactVec.get(c);
            if (!ct) continue;
            try {
              const b1 = sim.model.geom_bodyid[ct.geom1];
              const b2 = sim.model.geom_bodyid[ct.geom2];
              if ((b1 === poleBid && b2 === shackleBid) || (b1 === shackleBid && b2 === poleBid)) {
                clinkContacts++;
                break;
              }
            } finally {
              ct.delete();
            }
          }
        } finally {
          contactVec.delete();
        }
      }

      expect(clinkContacts).toBeGreaterThan(0);
      for (let i = 0; i < sim.data.qpos.length; i++) {
        expect(Number.isFinite(sim.data.qpos[i])).toBe(true);
      }
      for (let i = 0; i < sim.data.qvel.length; i++) {
        expect(Number.isFinite(sim.data.qvel[i])).toBe(true);
      }
    } finally {
      sim.dispose();
    }
  });

  it('simulates both ripstop ensign and canvas burgee (< 460 vertices) over 2.0 s in 8.8 m/s wind with finite state and 0 self-crossings', async () => {
    const r = await clothRun(flagInWindPreset.nodes);
    expect(r.sim.n).toBeGreaterThan(150);
    expect(r.sim.n).toBeLessThan(460);
    for (const m of r.models) {
      expect(m.warnings ?? []).toEqual([]);
    }

    const windEnv = {
      wind: [8.8, 0.6, 0] as [number, number, number],
      gustAt: evaluateGustWind,
    };
    r.run(1.75, windEnv);
    const speed = r.speedOver(0.25, windEnv);

    for (let i = 0; i < r.sim.x.length; i++) {
      expect(Number.isFinite(r.sim.x[i])).toBe(true);
    }
    expect(speed).toBeGreaterThan(0.05);
    expect(r.crossings()).toEqual([]);
    expect(r.clearance()).toBeGreaterThan(-0.002);
    expect(percentile(r.strains(), 0.95)).toBeLessThan(0.08);

    const loads = r.sim.tieLoads();
    expect(loads.length).toBe(5);
    expect(r.models.flatMap((m) => m.ties).every((t) => t.body === 'flagpole')).toBe(true);
    expect(loads.every((l) => Number.isFinite(l.newtons))).toBe(true);
    expect(Math.max(...loads.map((l) => l.newtons))).toBeGreaterThan(0.2);

    // Calm air check: flags drape cleanly against the mast without self-crossings
    const calm = await clothRun(flagInWindPreset.nodes);
    calm.run(1.5, { wind: [0, 0, 0] });
    expect(calm.crossings()).toEqual([]);
    for (let i = 0; i < calm.sim.x.length; i++) {
      expect(Number.isFinite(calm.sim.x[i])).toBe(true);
    }
  }, 120_000);

  it('monotonically shifts whip-snap peak Hz and weave rustle Hz downward from ripstop -> taffeta -> woven -> canvas across solver and physics_get_object', () => {
    const order: ClothMaterialName[] = ['ripstop', 'taffeta', 'woven', 'canvas'];
    const snapHz = order.map((mat) =>
      solveClothSnapPulse({
        nodeId: 'test_flag',
        impulseNs: 0.08,
        relSpeedMps: 8.8,
        arealDensityKgM2: CLOTH_MATERIALS[mat].arealDensity,
      }).centerHz,
    );
    const rustleHz = order.map((mat) =>
      solveAeroAcousticVoice({
        hubOrBodyId: 'test_flag',
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: 8.8,
        relSpeedMps: 8.8,
        alphaDeg: 18,
        areaM2: 0.5,
        chordM: 0.9,
        thicknessM: CLOTH_MATERIALS[mat].thickness,
        aeroForceN: 3.0,
        isCloth: true,
        bendRateRadPerSec: 14,
        arealDensityKgM2: CLOTH_MATERIALS[mat].arealDensity,
      }).rustleFreqHz,
    );

    // Ripstop (~2.8 kHz) > Taffeta (~1.8 kHz) > Woven (~1.4 kHz) > Canvas (~500 Hz)
    expect(snapHz[0]).toBeGreaterThan(2200);
    expect(snapHz[0]).toBeLessThan(3500);
    expect(snapHz[3]).toBeGreaterThan(350);
    expect(snapHz[3]).toBeLessThan(750);
    for (let i = 1; i < order.length; i++) {
      expect(snapHz[i - 1]).toBeGreaterThan(snapHz[i]);
      expect(rustleHz[i - 1]).toBeGreaterThan(rustleHz[i]);
    }

    // physics_get_object (`objectReply`) cloth_aero reporting & monotonic parity
    const nodes = flagInWindPreset.nodes;
    const ensign = nodes.find((n) => n.id === 'ensign_flag')!;
    const burgee = nodes.find((n) => n.id === 'burgee_pennant')!;

    const ensignReply = objectReply(ensign, { scene: nodes });
    const burgeeReply = objectReply(burgee, { scene: nodes });
    const wovenReply = objectReply(
      { ...ensign, cloth: { ...ensign.cloth!, material: 'woven' } },
      { scene: nodes },
    );

    const aEnsign = ensignReply.acoustics as Record<string, unknown>;
    const aWoven = wovenReply.acoustics as Record<string, unknown>;
    const aBurgee = burgeeReply.acoustics as Record<string, unknown>;

    expect(aEnsign).toMatchObject({
      role: 'cloth_aero',
      material: 'ripstop',
      arealDensityKgM2: 0.055,
    });
    expect(aWoven).toMatchObject({
      role: 'cloth_aero',
      material: 'woven',
      arealDensityKgM2: 0.12,
    });
    expect(aBurgee).toMatchObject({
      role: 'cloth_aero',
      material: 'canvas',
      arealDensityKgM2: 0.4,
    });

    expect(Number(aEnsign.snapCenterHz)).toBeGreaterThan(Number(aWoven.snapCenterHz));
    expect(Number(aWoven.snapCenterHz)).toBeGreaterThan(Number(aBurgee.snapCenterHz));
    expect(Number(aEnsign.rustleFreqHz)).toBeGreaterThan(Number(aWoven.rustleFreqHz));
    expect(Number(aWoven.rustleFreqHz)).toBeGreaterThan(Number(aBurgee.rustleFreqHz));
  });

  it('keeps mcp-docs.json and systemInstructions.txt aligned on ripstop, flag_in_wind, and cloth_aero', () => {
    const repoRoot = resolve(__dirname, '..');
    const mcpDocsRaw = readFileSync(resolve(repoRoot, 'mcp-docs.json'), 'utf8');
    const mcpDocs = JSON.parse(mcpDocsRaw) as Record<string, unknown>;
    expect(mcpDocs).toBeDefined();
    expect(mcpDocsRaw).toContain('ripstop');
    expect(mcpDocsRaw).toContain('flag_in_wind');
    expect(mcpDocsRaw).toContain('cloth_aero');

    const sysPrompt = readFileSync(resolve(repoRoot, 'src/components/systemInstructions.txt'), 'utf8');
    expect(sysPrompt).toContain('ripstop');
    expect(sysPrompt).toContain('flag_in_wind');
    expect(sysPrompt).toContain('cloth_aero');
  });

  it('drives end-to-end ClothSim.consumeAeroTelemetry on flag_in_wind (billow voices, fly whip-snaps, flagpole tie impacts, Aeolian hum, and calm silence)', async () => {
    const nodes = flagInWindPreset.nodes;
    const flagpole = nodes.find((n) => n.id === 'flagpole')!;
    const shackle = flagpole.children!.find((c) => c.id === 'halyard_shackle')!;
    const poleProfile = estimateBodyModes(flagpole, true);

    const r = await clothRun(nodes);
    const windEnv = {
      wind: [8.8, 0.6, 0] as [number, number, number],
      gustAt: evaluateGustWind,
    };

    const allSnaps: ReturnType<typeof r.sim.consumeAeroTelemetry>['snaps'] = [];
    const allTieImpacts: ReturnType<typeof r.sim.consumeAeroTelemetry>['tieImpacts'] = [];
    const latestVoiceById = new Map<string, ReturnType<typeof r.sim.consumeAeroTelemetry>['voices'][number]>();

    // Step 2.4 s in 40 ms worker-equivalent telemetry windows
    for (let step = 0; step < 60; step++) {
      r.run(0.04, windEnv);
      const tel = r.sim.consumeAeroTelemetry(1.225, false);
      for (const v of tel.voices) latestVoiceById.set(v.hubOrBodyId, v);
      allSnaps.push(...tel.snaps);
      allTieImpacts.push(...tel.tieImpacts);
    }

    const ensignVoice = latestVoiceById.get('ensign_flag');
    const burgeeVoice = latestVoiceById.get('burgee_pennant');
    expect(ensignVoice).toBeDefined();
    expect(burgeeVoice).toBeDefined();
    expect(ensignVoice!.isCloth).toBe(true);
    expect(ensignVoice!.worldPos).toBeDefined();

    const solvedEnsign = solveAeroAcousticVoice(ensignVoice!);
    const solvedBurgee = solveAeroAcousticVoice(burgeeVoice!);
    expect(solvedEnsign.active).toBe(true);
    expect(solvedEnsign.noiseGain).toBeGreaterThan(0);
    expect(solvedEnsign.rustleGain).toBeGreaterThan(0);
    expect(solvedEnsign.amRateHz).toBeGreaterThanOrEqual(2.5);
    expect(solvedEnsign.amRateHz).toBeLessThanOrEqual(16.0);
    // Ultralight ripstop ensign has brighter weave rustle than heavy canvas burgee
    expect(solvedEnsign.rustleFreqHz).toBeGreaterThan(solvedBurgee.rustleFreqHz);

    // Free fly corners emit genuine whip-snaps with 3D worldPos and monotonic seq
    expect(allSnaps.length).toBeGreaterThanOrEqual(1);
    expect(allSnaps[0].worldPos).toBeDefined();
    expect(allSnaps[0].seq).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < allSnaps.length; i++) {
      expect(allSnaps[i].seq!).toBeGreaterThan(allSnaps[i - 1].seq!);
    }
    const solvedSnap = solveClothSnapPulse(allSnaps[0]);
    expect(solvedSnap.gain).toBeGreaterThan(0);

    // Grommet tie jerks target `flagpole` at hoist anchor points and excite structural modal voices
    expect(allTieImpacts.length).toBeGreaterThanOrEqual(1);
    expect(allTieImpacts.every((ti) => ti.bodyName === 'flagpole')).toBe(true);
    const poleExcitation = resolveTwoBodyImpact(poleProfile, flagpole, {
      impulseNs: allTieImpacts[0].impulseNs,
      strikerNode: allTieImpacts[0].isGrommetClink ? shackle : undefined,
      localPoint: allTieImpacts[0].anchorLocal ?? undefined,
    });
    expect(poleExcitation.voices.some((v) => v.gain > 0)).toBe(true);

    // Static slender cylindrical flagpole / halyard stay emits subtle high-Q (Q > 2.8) Strouhal Aeolian hum in 8.8 m/s wind and 0 voices in calm/vacuum
    const sim = await simulate(flagInWindPreset, { windX: 8.8, windY: 0.6 });
    try {
      const poleBid = sim.bodyId('flagpole');
      expect(sim.model.body_dofnum[poleBid]).toBe(0);
      const gStart = sim.model.body_geomadr[poleBid];
      const gCount = sim.model.body_geomnum[poleBid];
      let minSlenderD = Infinity;
      let slenderAreaSum = 0;
      for (let k = 0; k < gCount; k++) {
        const g = gStart + k;
        const gt = sim.model.geom_type[g];
        if (gt !== 3 && gt !== 5) continue;
        const rad = sim.model.geom_size[g * 3] || 0;
        const halfLen = sim.model.geom_size[g * 3 + 1] || 0;
        const diam = 2 * rad;
        const fullLen = gt === 3 ? 2 * halfLen + diam : 2 * halfLen;
        if (diam >= 0.004 && diam <= 0.16 && fullLen / diam >= 6.0) {
          if (diam < minSlenderD) minSlenderD = diam;
          slenderAreaSum += diam * fullLen;
        }
      }
      expect(Number.isFinite(minSlenderD)).toBe(true);
      expect(slenderAreaSum).toBeGreaterThan(0.01);

      const uPerp = Math.hypot(8.8, 0.6);
      const fDrag = 0.5 * 1.225 * 1.1 * Math.min(2.0, slenderAreaSum) * uPerp * uPerp;
      const aeolianVoice = solveAeroAcousticVoice({
        hubOrBodyId: 'flagpole',
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: uPerp,
        relSpeedMps: uPerp,
        alphaDeg: 4.0,
        areaM2: Math.min(2.0, slenderAreaSum),
        chordM: minSlenderD,
        thicknessM: minSlenderD,
        aeroForceN: fDrag,
        arealDensityKgM2: 1.5,
        bendRateRadPerSec: 0,
        gainScale: 0.28,
      });
      expect(aeolianVoice.active).toBe(true);
      expect(aeolianVoice.noiseQ).toBeGreaterThan(2.8);
      expect(aeolianVoice.noiseGain).toBeGreaterThan(0);

      const vacuumAeolian = solveAeroAcousticVoice({
        hubOrBodyId: 'flagpole',
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: uPerp,
        relSpeedMps: uPerp,
        alphaDeg: 4.0,
        areaM2: Math.min(2.0, slenderAreaSum),
        chordM: minSlenderD,
        thicknessM: minSlenderD,
        aeroForceN: fDrag,
        isVacuum: true,
        gainScale: 0.28,
      });
      expect(vacuumAeolian.active).toBe(false);
    } finally {
      sim.dispose();
    }

    // Live XPBD fabric swap (`ripstop` -> `woven` -> `canvas`) shifts live-extracted snap & rustle frequencies downward
    const wovenNodes = nodes.map((n) =>
      n.id === 'ensign_flag' ? { ...n, cloth: { ...n.cloth!, material: 'woven' as const } } : n,
    );
    const wovenRun = await clothRun(wovenNodes);
    let wovenVoice: ReturnType<typeof wovenRun.sim.consumeAeroTelemetry>['voices'][number] | undefined;
    const wovenSnaps: ReturnType<typeof wovenRun.sim.consumeAeroTelemetry>['snaps'] = [];
    for (let step = 0; step < 45; step++) {
      wovenRun.run(0.04, windEnv);
      const tel = wovenRun.sim.consumeAeroTelemetry(1.225, false);
      const ev = tel.voices.find((v) => v.hubOrBodyId === 'ensign_flag');
      if (ev) wovenVoice = ev;
      wovenSnaps.push(...tel.snaps.filter((s) => s.nodeId === 'ensign_flag'));
    }
    expect(wovenVoice).toBeDefined();
    const solvedWoven = solveAeroAcousticVoice(wovenVoice!);
    expect(solvedEnsign.rustleFreqHz).toBeGreaterThan(solvedWoven.rustleFreqHz);
    expect(solvedWoven.rustleFreqHz).toBeGreaterThan(solvedBurgee.rustleFreqHz);
    const ensignSnap = allSnaps.find((s) => s.nodeId === 'ensign_flag');
    const burgeeSnap = allSnaps.find((s) => s.nodeId === 'burgee_pennant');
    if (ensignSnap && wovenSnaps[0]) {
      expect(solveClothSnapPulse(ensignSnap).centerHz).toBeGreaterThan(solveClothSnapPulse(wovenSnaps[0]).centerHz);
    }
    if (wovenSnaps[0] && burgeeSnap) {
      expect(solveClothSnapPulse(wovenSnaps[0]).centerHz).toBeGreaterThan(solveClothSnapPulse(burgeeSnap).centerHz);
    }

    // Calm air ([0, 0, 0]) after settle produces 0 snaps and inactive voices
    const calm = await clothRun(nodes);
    calm.run(2.8, { wind: [0, 0, 0] });
    calm.sim.consumeAeroTelemetry(1.225, false); // clear transient gravity-drop drape
    calm.run(0.3, { wind: [0, 0, 0] });
    const calmTel = calm.sim.consumeAeroTelemetry(1.225, false);
    expect(calmTel.snaps).toHaveLength(0);
    expect(calmTel.voices.every((v) => !solveAeroAcousticVoice(v).active)).toBe(true);
  }, 120_000);

  it('attenuates >2.5 kHz hiss by >= 14 dB relative to 80–650 Hz wind whoosh and sustains rhythmic billow + gust dynamic range over 4.0 s on flag_in_wind', async () => {
    // Exact WebAudio BiquadFilter |H(e^{jw})|^2 transfer function at 48 kHz
    const biquadMagSq = (
      type: 'lowpass' | 'bandpass' | 'peaking',
      f0: number,
      Q: number,
      gainDb: number,
      f: number,
      sr = 48000,
    ): number => {
      const w0 = (2 * Math.PI * f0) / sr;
      const cosw0 = Math.cos(w0);
      const sinw0 = Math.sin(w0);
      const A = Math.pow(10, gainDb / 40);
      let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
      if (type === 'bandpass') {
        const alpha = sinw0 / (2 * Math.max(1e-4, Q));
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
      } else if (type === 'lowpass') {
        const alpha = (sinw0 / 2) * Math.pow(10, -Q / 20);
        b0 = (1 - cosw0) / 2; b1 = 1 - cosw0; b2 = (1 - cosw0) / 2;
        a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
      } else {
        const alpha = sinw0 / (2 * Math.max(1e-4, Q));
        b0 = 1 + alpha * A; b1 = -2 * cosw0; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cosw0; a2 = 1 - alpha / A;
      }
      const w = (2 * Math.PI * f) / sr;
      const cw = Math.cos(w), c2w = Math.cos(2 * w);
      const sw = Math.sin(w), s2w = Math.sin(2 * w);
      const br = b0 + b1 * cw + b2 * c2w;
      const bi = -(b1 * sw + b2 * s2w);
      const ar = a0 + a1 * cw + a2 * c2w;
      const ai = -(a1 * sw + a2 * s2w);
      return (br * br + bi * bi) / Math.max(1e-24, ar * ar + ai * ai);
    };

    const measureBufferPsd = (samples: Float32Array, sr: number, freqHz: number): number => {
      const N = Math.min(samples.length, 32768);
      const numWins = Math.max(1, Math.floor(samples.length / N));
      const w = (2 * Math.PI * freqHz) / sr;
      const coeff = 2 * Math.cos(w);
      let total = 0;
      for (let wi = 0; wi < numWins; wi++) {
        const off = wi * N;
        let s1 = 0, s2 = 0;
        for (let n = 0; n < N; n++) {
          const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
          const s0 = samples[off + n] * win + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        total += (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N * 0.375);
      }
      return total / numWins;
    };

    const makeParam = (init = 0) => ({
      value: init,
      setValueAtTime(v: number) { this.value = v; },
      setTargetAtTime(v: number) { this.value = v; },
      cancelScheduledValues() {},
    });
    const mockCtx = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination: {},
      createGain: () => ({ gain: makeParam(1), connect() {}, disconnect() {} }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: makeParam(1000),
        Q: makeParam(1),
        gain: makeParam(0),
        connect() {},
        disconnect() {},
      }),
      createOscillator: () => ({
        type: 'sine',
        frequency: makeParam(440),
        detune: makeParam(0),
        setPeriodicWave() {},
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      }),
      createWaveShaper: () => ({ curve: null, oversample: 'none', connect() {}, disconnect() {} }),
      createDynamicsCompressor: () => ({
        threshold: makeParam(-3), knee: makeParam(6), ratio: makeParam(10), attack: makeParam(0.002), release: makeParam(0.12), connect() {},
      }),
      createConvolver: () => ({ normalize: false, buffer: null, connect() {}, disconnect() {} }),
      createBuffer: (_ch: number, len: number, sr: number) => {
        const arr = new Float32Array(len);
        return { sampleRate: sr, length: len, getChannelData: () => arr };
      },
      createBufferSource: () => ({
        buffer: null, loop: false, onended: null, connect() {}, disconnect() {}, start() {}, stop() {},
      }),
      createPeriodicWave: () => ({}),
    } as unknown as AudioContext;

    const aeroBank = ensureNativeAeroBank(mockCtx)!;
    expect(aeroBank.noiseSource?.buffer).toBeTruthy();
    const kolmSamples = aeroBank.noiseSource!.buffer!.getChannelData(0);

    // Step live `flag_in_wind` ClothSim + Aeolian flagpole for 4.0 s (100 x 40 ms frames)
    const r = await clothRun(flagInWindPreset.nodes);
    const windEnv = {
      wind: [8.8, 0.6, 0] as [number, number, number],
      gustAt: evaluateGustWind,
    };
    const frames: AeroSynthParams[][] = [];
    const snapsSolved: SnapSynthParams[] = [];

    for (let step = 0; step < 100; step++) {
      r.run(0.04, windEnv);
      const tSec = (step + 1) * 0.04;
      const tel = r.sim.consumeAeroTelemetry(1.225, false);
      const [gx, gy, gz] = evaluateGustWind(8.8, 0.6, 0, 0, 1.0, tSec);
      const uPerp = Math.hypot(gx, gy, gz * 0.25);
      const fDrag = 0.5 * 1.225 * 1.1 * 0.1683 * uPerp * uPerp;
      const poleVoice = solveAeroAcousticVoice({
        hubOrBodyId: 'flagpole',
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: uPerp,
        relSpeedMps: uPerp,
        alphaDeg: 4.0,
        areaM2: 0.1683,
        chordM: 0.006,
        thicknessM: 0.006,
        aeroForceN: fDrag,
        arealDensityKgM2: 1.5,
        bendRateRadPerSec: 0,
        gainScale: 0.28,
      });
      const solvedFrame = [...tel.voices.map((v) => solveAeroAcousticVoice(v)), poleVoice];
      postWorkletAeroUpdate(mockCtx, solvedFrame);
      frames.push(solvedFrame);
      for (const sn of tel.snaps) snapsSolved.push(solveClothSnapPulse(sn));
    }

    // 1. Outdoor wind-whoosh & Aeolian formants sweep organically in 85–280 Hz / 115–210 Hz with 3–7 Hz Kármán billow
    const ensignFrames = frames.map((f) => f.find((v) => v.id === 'ensign_flag')).filter((v): v is AeroSynthParams => !!v);
    const poleFrames = frames.map((f) => f.find((v) => v.id === 'flagpole')).filter((v): v is AeroSynthParams => !!v);
    expect(ensignFrames.length).toBeGreaterThan(80);
    const ensignCenters = ensignFrames.map((v) => v.noiseCenterHz);
    expect(Math.min(...ensignCenters)).toBeGreaterThanOrEqual(85);
    expect(Math.max(...ensignCenters)).toBeLessThanOrEqual(280);
    expect(Math.max(...ensignCenters) - Math.min(...ensignCenters)).toBeGreaterThan(40);
    expect(ensignFrames.every((v) => v.amRateHz >= 2.8 && v.amRateHz <= 7.2 && v.amDepth >= 0.65)).toBe(true);
    expect(poleFrames.every((v) => (v.aeolianFreqHz ?? 0) >= 115 && (v.aeolianFreqHz ?? 0) <= 210 && (v.aeolianGain ?? 0) > 0)).toBe(true);

    // 2. Quantitative Spectral Balance: >2.5 kHz hiss attenuated by >= 14 dB relative to 80–650 Hz whoosh & billow!
    let lowMidWindPower = 0;
    let highHissWindPower = 0;
    const sampledFrames = frames.filter((_, idx) => idx >= 10 && idx % 6 === 0);
    for (let f = 40; f <= 20000; f += 80) {
      const srcPsd = measureBufferPsd(kolmSamples, 48000, f);
      const masterSq = biquadMagSq('peaking', 1850, 0.85, 2.4, f);
      let meanFramePsd = 0;
      for (const fv of sampledFrames) {
        for (const v of fv) {
          if (!v.active) continue;
          const lpHz = v.lowpassHz ?? Math.min(2400, v.noiseCenterHz * 2.0 + 180);
          const whooshPsd =
            srcPsd *
            biquadMagSq('bandpass', v.noiseCenterHz, v.noiseQ, 0, f) *
            biquadMagSq('lowpass', lpHz, 0.707, 0, f) *
            v.noiseGain *
            v.noiseGain;
          const rHz = 320 + 0.20 * v.rustleFreqHz;
          const rustlePsd =
            srcPsd *
            biquadMagSq('bandpass', rHz, 1.35, 0, f) *
            biquadMagSq('lowpass', rHz * 1.28, 0.707, 0, f) *
            (v.rustleGain * 0.36) *
            (v.rustleGain * 0.36);
          meanFramePsd += (whooshPsd + rustlePsd) * masterSq;
        }
      }
      meanFramePsd /= sampledFrames.length;
      if (f >= 80 && f <= 650) lowMidWindPower += meanFramePsd * 80;
      if (f > 2500 && f <= 20000) highHissWindPower += meanFramePsd * 80;
    }

    let snapLowMid = 0;
    let snapHigh = 0;
    for (const s of snapsSolved) {
      if (!s.active) continue;
      const frac = (s.durationSec * 3.5) / 4.0;
      const thumpHz = Math.max(115, Math.min(340, 0.22 * s.centerHz));
      for (let f = 80; f <= 20000; f += 160) {
        const masterSq = biquadMagSq('peaking', 1850, 0.85, 2.4, f);
        const srcSpec = 0.25 / (1 + Math.pow(f * s.durationSec * 2.2, 2)) + 0.025;
        const p =
          (srcSpec *
            frac *
            (biquadMagSq('bandpass', s.centerHz, s.bandpassQ, 0, f) *
              biquadMagSq('lowpass', s.lowpassHz, 0.8, 0, f) *
              s.gain *
              s.gain +
              biquadMagSq('bandpass', thumpHz, 1.4, 0, f) * (0.32 * s.gain) * (0.32 * s.gain)) *
            masterSq) /
          24000;
        if (f >= 80 && f <= 650) snapLowMid += p * 160;
        if (f > 2500 && f <= 20000) snapHigh += p * 160;
      }
    }

    const windAttenuationDb = 10 * Math.log10(lowMidWindPower / Math.max(1e-24, highHissWindPower));
    const combinedAttenuationDb =
      10 * Math.log10((lowMidWindPower + snapLowMid) / Math.max(1e-24, highHissWindPower + snapHigh));
    expect(windAttenuationDb).toBeGreaterThanOrEqual(25);
    expect(combinedAttenuationDb).toBeGreaterThanOrEqual(14);

    // 3. Multi-second billow + gust envelope modulation dynamic range (>= 10 dB P95/P05) + audible ripstop snaps
    const envTrace: number[] = [];
    for (let ms = 200; ms <= 4000; ms += 5) {
      const tSec = ms / 1000;
      const fi = Math.min(frames.length - 1, Math.floor(tSec / 0.04));
      const gustLfo = 0.68 * Math.sin(2 * Math.PI * 0.23 * tSec) + 0.32 * Math.sin(2 * Math.PI * 0.59 * tSec);
      let sumSq = 0;
      frames[fi].forEach((v, si) => {
        if (!v.active) return;
        const hasAm = v.amRateHz >= 0.4 && v.amDepth > 0.01;
        const baseG = hasAm ? v.noiseGain * (1 - 0.44 * v.amDepth) : v.noiseGain;
        const amSwing = hasAm ? v.noiseGain * v.amDepth * 0.50 * Math.sin(2 * Math.PI * v.amRateHz * tSec + si * 0.9) : 0;
        const instG = Math.max(0, baseG + amSwing + baseG * 0.22 * gustLfo);
        sumSq += instG * instG;
      });
      envTrace.push(Math.sqrt(sumSq));
    }
    envTrace.sort((a, b) => a - b);
    const p05 = envTrace[Math.floor(0.05 * envTrace.length)];
    const p95 = envTrace[Math.floor(0.95 * envTrace.length)];
    const dynamicRangeDb = 20 * Math.log10(p95 / Math.max(1e-6, p05));
    expect(dynamicRangeDb).toBeGreaterThanOrEqual(10);
    expect(snapsSolved.some((s) => s.nodeId === 'ensign_flag' && s.gain > 0.02)).toBe(true);
  }, 120_000);
});
