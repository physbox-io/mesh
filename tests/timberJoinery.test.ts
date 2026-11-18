import { describe, expect, it } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import { extractTimberMembers, meshMmToManifold } from '../src/utils/timberBreakdown';
import { synthesizeTimberJoinery, roundTenonCornerRadiusMm } from '../src/utils/timberJoinery';
import { buildTimberCutPlan } from '../src/utils/timberCutList';

const MM = 1000;

/** Convert a Manifold in mm to a triangle soup in metres (9 numbers per triangle). */
function manifoldMmToSoupMetres(m: import('manifold-3d').Manifold): Float64Array {
  const mesh = m.getMesh();
  const p = mesh.numProp;
  const soup = new Float64Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      soup[t * 9 + k * 3] = mesh.vertProperties[v * p] / MM;
      soup[t * 9 + k * 3 + 1] = mesh.vertProperties[v * p + 1] / MM;
      soup[t * 9 + k * 3 + 2] = mesh.vertProperties[v * p + 2] / MM;
    }
  }
  return soup;
}

describe('Timber & Joinery Breakdown (Table, Chair & 3ft Flower Stand)', () => {
  it('breaks down a 3ft (915 mm) flower stand into mortised legs, mitered-tip tenon rails, planks, sliding CNC windows, and beginner build guide', async () => {
    const wasm = await loadManifold();

    // Build a 3 ft (915 mm) tall flower stand / side table:
    // - 4 legs: 45 x 45 x 915 mm at corners (±177.5, ±177.5)
    // - 4 top aprons (Z = 825..885, 60 mm tall x 22 mm thick x 310 mm between legs)
    // - 4 lower anti-racking stretchers (Z = 200..245, 45 mm tall x 22 mm thick x 310 mm between legs)
    // - 1 tabletop: 420 x 420 x 24 mm at Z = 885..909 mm
    const boxes: import('manifold-3d').Manifold[] = [];

    const legXY = 177.5;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        boxes.push(
          wasm.Manifold.cube([45, 45, 915], true).translate([sx * legXY, sy * legXY, 915 / 2]),
        );
      }
    }

    // Front & Back Top Aprons (along X, spanning between inner leg faces ±155 mm)
    for (const sy of [-1, 1]) {
      boxes.push(
        wasm.Manifold.cube([310, 22, 60], true).translate([0, sy * legXY, 855]),
      );
      // Lower anti-racking stretchers at Z = 222.5 mm
      boxes.push(
        wasm.Manifold.cube([310, 22, 45], true).translate([0, sy * legXY, 222.5]),
      );
    }

    // Left & Right Top Aprons + Lower Stretchers (along Y)
    for (const sx of [-1, 1]) {
      boxes.push(
        wasm.Manifold.cube([22, 310, 60], true).translate([sx * legXY, 0, 855]),
      );
      boxes.push(
        wasm.Manifold.cube([22, 310, 45], true).translate([sx * legXY, 0, 222.5]),
      );
    }

    // Tabletop (420 x 420 x 24 mm, wider than 180 mm maxBoardWidthMm -> splits into 3 planks)
    boxes.push(
      wasm.Manifold.cube([420, 420, 24], true).translate([0, 0, 885 + 12]),
    );

    const soups = boxes.map(manifoldMmToSoupMetres);
    for (const b of boxes) b.delete();

    const res = synthesizeTimberJoinery(wasm, soups, {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      edgeProfile: 'roundover',
      edgeRadiusMm: 4,
      cutterDiaMm: 6,
      tenonLengthMm: 22,
      shoulderMm: 5,
      maxBoardWidthMm: 180,
      tabletopClips: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 4 legs + 8 rails (4 aprons + 4 stretchers) + 3 tabletop planks = 15 parts
    const legs = res.parts.filter((p) => p.member.role === 'leg');
    const rails = res.parts.filter((p) => p.member.role === 'rail');
    const panels = res.parts.filter((p) => p.member.role === 'panel');
    expect(legs.length).toBe(4);
    expect(rails.length).toBe(8);
    expect(panels.length).toBe(3);

    // Check semantic leg naming (Leg_FL, Leg_FR, Leg_BL, Leg_BR) and mirror pairing
    const legIds = legs.map((l) => l.member.id).sort();
    expect(legIds).toEqual(['Leg_BL', 'Leg_BR', 'Leg_FL', 'Leg_FR']);
    const legFL = legs.find((l) => l.member.id === 'Leg_FL')!;
    expect(legFL.member.mirrorOf).toBe('Leg_FR');

    // Every leg has 4 mortises (2 upper aprons + 2 lower stretchers) and stopped edge roundover zones
    for (const leg of legs) {
      expect(leg.mortises.length).toBe(4);
      expect(leg.stoppedEdgeZones.length).toBeGreaterThanOrEqual(1);
    }

    // Every rail has 2 tenons (one at each end) and its totalFinishedLengthMm > shoulderToShoulderMm
    for (const rail of rails) {
      expect(rail.tenons.length).toBe(2);
      expect(rail.totalFinishedLengthMm).toBeGreaterThan(rail.shoulderToShoulderMm + 25);
      // Because two perpendicular rails meet in each corner leg at the same Z height,
      // both tenons must have miteredTip = true so they do not collide inside the leg!
      for (const t of rail.tenons) {
        expect(t.miteredTip).toBe(true);
      }
    }

    // Verify with exact Manifold 3D boolean intersection that no two finished parts overlap!
    const partManifolds = res.parts.map((p) => {
      const posMm = new Float32Array(p.section.positions.length);
      for (let i = 0; i < posMm.length; i++) posMm[i] = p.section.positions[i] * MM;
      return meshMmToManifold(wasm, posMm, p.section.faces);
    });
    try {
      let totalInterferenceMm3 = 0;
      for (let a = 0; a < partManifolds.length; a++) {
        for (let b = a + 1; b < partManifolds.length; b++) {
          const inter = partManifolds[a].intersect(partManifolds[b]);
          totalInterferenceMm3 += inter.volume();
          inter.delete();
        }
      }
      // Tenons sit inside mortises with clearance + 45° mitered tips, so 3D overlap is zero!
      expect(totalInterferenceMm3).toBeLessThan(1.0);
    } finally {
      for (const m of partManifolds) m.delete();
    }

    // Build the Cut Plan for a small 300 x 300 mm hobby CNC bed
    const cutPlan = buildTimberCutPlan(res, {
      cncBedMm: [300, 300, 60],
      defaultStockLengthMm: 2400,
    });

    expect(cutPlan.stockBars.length).toBeGreaterThanOrEqual(2);
    expect(cutPlan.partCards.length).toBe(15);

    // Each 915 mm leg has mortises at Z=855 (60 mm from top) and Z=222.5 (692.5 mm from top).
    // On a 300 mm CNC bed, those two heights are >600 mm apart, so each interior leg face
    // must be split into 2 sliding CNC windows (4 windows total per leg)!
    const flCard = cutPlan.partCards.find((c) => c.partId === 'Leg_FL')!;
    expect(flCard.cncSetups.length).toBe(4);
    const slidingWindows = flCard.cncSetups.filter((s) => s.indexOffsetFromTopMm > 0);
    expect(slidingWindows.length).toBe(2);
    expect(slidingWindows[0].overhangMm).toBeGreaterThan(500);
    expect(slidingWindows[0].gcode).toContain('G21 G90 G17');
    expect(slidingWindows[0].gcode).toContain('M30');

    // Verify beginner-proof buildGuideMarkdown contains all required shop sections
    expect(cutPlan.buildGuideMarkdown).toContain('Bill of Materials');
    expect(cutPlan.buildGuideMarkdown).toContain('Corner Leg Orientation Map');
    expect(cutPlan.buildGuideMarkdown).toContain('Leg_FL');
    expect(cutPlan.buildGuideMarkdown).toContain('Reference Datum Faces');
    expect(cutPlan.buildGuideMarkdown).toContain('Assembly & Squaring Checklist');
    expect(cutPlan.buildGuideMarkdown).toContain('Z-Clip');
  });

  it('decomposes a single unified solid table mesh into separate tabletop, legs, and rails', async () => {
    const wasm = await loadManifold();

    // Union a complete table (top + 4 legs + 4 stretchers) into ONE single solid Manifold
    const pieces: import('manifold-3d').Manifold[] = [
      wasm.Manifold.cube([360, 260, 20], true).translate([0, 0, 410]),
    ];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pieces.push(wasm.Manifold.cube([40, 40, 400], true).translate([sx * 150, sy * 100, 200]));
      }
    }
    for (const sy of [-1, 1]) {
      pieces.push(wasm.Manifold.cube([260, 20, 40], true).translate([0, sy * 100, 360]));
    }
    const singleSolid = wasm.Manifold.union(pieces);
    for (const p of pieces) p.delete();

    const singleSoup = manifoldMmToSoupMetres(singleSolid);
    singleSolid.delete();

    const extracted = extractTimberMembers(wasm, [singleSoup], {
      maxBoardWidthMm: 300,
      splitWidePanels: false,
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;

    // 1 tabletop + 4 legs + 2 front/back rails = 7 extracted members from 1 single solid!
    expect(extracted.members.filter((m) => m.role === 'panel').length).toBe(1);
    expect(extracted.members.filter((m) => m.role === 'leg').length).toBe(4);
    expect(extracted.members.filter((m) => m.role === 'rail').length).toBe(2);
  });

  it('processes the built-in 3ft Flower Stand preset (flowerStandPreset) with zero 3D interference', async () => {
    const wasm = await loadManifold();
    const { flowerStandPreset } = await import('../src/presets/presetScenes');
    const { collectIndividualPartSoups } = await import('../src/utils/timberBreakdown');

    const { items } = collectIndividualPartSoups(flowerStandPreset, ['flower_stand']);
    expect(items.length).toBe(14);

    const res = synthesizeTimberJoinery(
      wasm,
      items.map((it) => it.soup),
      {
        jointMode: 'mortise_tenon',
        tenonCornerFit: 'dogbone',
        edgeProfile: 'roundover',
        edgeRadiusMm: 4,
        maxBoardWidthMm: 200,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 4 legs + 8 rails + 2 top planks = 14 parts
    const panels = res.parts.filter((p) => p.member.role === 'panel');
    expect(res.parts.filter((p) => p.member.role === 'leg').length).toBe(4);
    expect(res.parts.filter((p) => p.member.role === 'rail').length).toBe(8);
    expect(panels.length).toBe(2);

    // Both top planks must be trimmed to their true 380 x 190 x 24 mm shoulder blank
    // (stripping the pre-existing 10 mm alignment tabs on Top_Plank_1 so their OBBs meet flush at Y=0)
    for (const p of panels) {
      expect(p.member.dimsMm[0]).toBeCloseTo(380, 1);
      expect(p.member.dimsMm[1]).toBeCloseTo(190, 1);
      expect(p.member.dimsMm[2]).toBeCloseTo(24, 1);
    }

    // Verify with exact Manifold 3D boolean intersection that no two finished parts in flowerStandPreset overlap!
    const presetManifolds = res.parts.map((p) => {
      const posMm = new Float32Array(p.section.positions.length);
      for (let i = 0; i < posMm.length; i++) posMm[i] = p.section.positions[i] * MM;
      return meshMmToManifold(wasm, posMm, p.section.faces);
    });
    try {
      let totalInterferenceMm3 = 0;
      for (let a = 0; a < presetManifolds.length; a++) {
        for (let b = a + 1; b < presetManifolds.length; b++) {
          const inter = presetManifolds[a].intersect(presetManifolds[b]);
          totalInterferenceMm3 += inter.volume();
          inter.delete();
        }
      }
      expect(totalInterferenceMm3).toBeLessThan(1.0);
    } finally {
      for (const m of presetManifolds) m.delete();
    }

    // Also verify zero 3D interference when maxBoardWidthMm = 180 splits the top into 4 planks
    const res4Planks = synthesizeTimberJoinery(
      wasm,
      items.map((it) => it.soup),
      {
        jointMode: 'mortise_tenon',
        tenonCornerFit: 'dogbone',
        edgeProfile: 'roundover',
        edgeRadiusMm: 4,
        maxBoardWidthMm: 180,
      },
    );
    expect(res4Planks.ok).toBe(true);
    if (res4Planks.ok) {
      expect(res4Planks.parts.filter((p) => p.member.role === 'panel').length).toBe(4);
      const m4 = res4Planks.parts.map((p) => {
        const posMm = new Float32Array(p.section.positions.length);
        for (let i = 0; i < posMm.length; i++) posMm[i] = p.section.positions[i] * MM;
        return meshMmToManifold(wasm, posMm, p.section.faces);
      });
      try {
        let interference4 = 0;
        for (let a = 0; a < m4.length; a++) {
          for (let b = a + 1; b < m4.length; b++) {
            const inter = m4[a].intersect(m4[b]);
            interference4 += inter.volume();
            inter.delete();
          }
        }
        expect(interference4).toBeLessThan(1.0);
      } finally {
        for (const m of m4) m.delete();
      }
    }

    const plan = buildTimberCutPlan(res, {
      cncBedMm: [300, 200, 60],
      defaultStockLengthMm: 1800,
    });
    expect(plan.partCards.length).toBe(14);
    expect(plan.buildGuideMarkdown).toContain('Leg_FL');

    // Verify every generated G-code command fits strictly inside the 3020 CNC envelope (X <= 300 mm, Y <= 200 mm)
    for (const setup of plan.allCncSetups) {
      for (const line of setup.gcode.split('\n')) {
        if (line.startsWith(';')) continue;
        const xm = line.match(/X(-?\d+(?:\.\d+)?)/);
        const ym = line.match(/Y(-?\d+(?:\.\d+)?)/);
        if (xm) {
          const x = parseFloat(xm[1]);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(300);
        }
        if (ym) {
          const y = parseFloat(ym[1]);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(200);
        }
      }
    }

    // Also verify when the user models the entire 3ft flower stand as ONE single unified solid!
    const solidBoxes: import('manifold-3d').Manifold[] = [
      wasm.Manifold.cube([380, 380, 24], true).translate([0, 0, 891 + 12]),
    ];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        solidBoxes.push(wasm.Manifold.cube([45, 45, 891], true).translate([sx * 147.5, sy * 147.5, 891 / 2]));
      }
    }
    for (const sy of [-1, 1]) {
      solidBoxes.push(wasm.Manifold.cube([250, 22, 60], true).translate([0, sy * 147.5, 861]));
      solidBoxes.push(wasm.Manifold.cube([250, 22, 45], true).translate([0, sy * 147.5, 210]));
    }
    for (const sx of [-1, 1]) {
      solidBoxes.push(wasm.Manifold.cube([22, 250, 60], true).translate([sx * 147.5, 0, 861]));
      solidBoxes.push(wasm.Manifold.cube([22, 250, 45], true).translate([sx * 147.5, 0, 210]));
    }
    const unifiedFlowerStand = wasm.Manifold.union(solidBoxes);
    for (const b of solidBoxes) b.delete();
    const unifiedSoup = manifoldMmToSoupMetres(unifiedFlowerStand);
    unifiedFlowerStand.delete();

    const singleSolidRes = synthesizeTimberJoinery(wasm, [unifiedSoup], {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      edgeProfile: 'roundover',
      edgeRadiusMm: 4,
      maxBoardWidthMm: 200,
    });
    expect(singleSolidRes.ok).toBe(true);
    if (singleSolidRes.ok) {
      expect(singleSolidRes.parts.filter((p) => p.member.role === 'leg').length).toBe(4);
      expect(singleSolidRes.parts.filter((p) => p.member.role === 'rail').length).toBe(8);
      expect(singleSolidRes.parts.filter((p) => p.member.role === 'panel').length).toBe(2);
    }
  });

  it('trims leg-to-panel overlap in member dims, preserves off-center lateral mortise offset, skips mitered tips on shallow non-intersecting mortises, and walks the pocket perimeter between dogbone corners', async () => {
    const wasm = await loadManifold();

    // 1. A leg that penetrates 10 mm into a 20 mm tabletop (Z = 0..410 mm vs panel Z = 400..420 mm),
    //    plus two perpendicular rails meeting the leg at the same Z height with shallow 8 mm tenons
    //    (too shallow to intersect inside a 60x60 mm leg), with one rail shifted off-center (+8 mm).
    const leg = wasm.Manifold.cube([60, 60, 410], true).translate([0, 0, 205]);
    const panel = wasm.Manifold.cube([200, 200, 20], true).translate([0, 0, 410]);
    const railX = wasm.Manifold.cube([160, 20, 40], true).translate([110, 8, 380]); // flush with trimmed leg top Z=400!
    const railY = wasm.Manifold.cube([20, 160, 40], true).translate([0, 110, 380]);

    const soups = [leg, panel, railX, railY].map(manifoldMmToSoupMetres);
    leg.delete();
    panel.delete();
    railX.delete();
    railY.delete();

    const res = synthesizeTimberJoinery(wasm, soups, {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 8, // shallow enough that the two perpendicular mortises do NOT intersect inside the 60x60 leg
      shoulderMm: 4,
      maxBoardWidthMm: 300,
      tabletopClips: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const legPart = res.parts.find((p) => p.member.role === 'leg')!;
    // Phase 0 trimmed 10 mm overlap with the panel (410 -> 400 mm), updating member.dimsMm[0] and centerMm[2]
    expect(legPart.member.dimsMm[0]).toBeCloseTo(400, 1);
    expect(legPart.member.centerMm[2]).toBeCloseTo(200, 1);

    // Shallow 8 mm tenons in a 60 mm leg do not intersect in 2D, so miteredTip must remain false
    const rails = res.parts.filter((p) => p.member.role === 'rail');
    expect(rails.length).toBe(2);
    for (const r of rails) {
      for (const t of r.tenons) {
        expect(t.miteredTip).toBe(false);
      }
    }

    // Off-center railX (y = +8 mm on a 60 mm face) has distFromRefEdgeMm != 30 mm (centered)
    const mortiseDistances = legPart.mortises.map((m) => m.distFromRefEdgeMm);
    expect(mortiseDistances.some((d) => Math.abs(d - 30) > 4)).toBe(true);

    // Flush-top rail (Z = 360..400 on a 400 mm leg -> distFromTopEndMm = 20 mm, widthMm = 32 mm)
    // must keep its true centerYMm (Y20) without an artificial +5 mm clamp (which would push it to Y21.075)
    const cutPlan = buildTimberCutPlan(res, { cncBedMm: [300, 300, 60] });
    for (const setup of cutPlan.allCncSetups) {
      expect(setup.gcode).toMatch(/G0 X[\d.]+ Y20\b/);
      // Dogbone relief must walk along the pocket perimeter (emitting G1 to each corner at F900 before each F675 relief move)
      const lines = setup.gcode.split('\n');
      const dogboneIndices = lines
        .map((l, idx) => (l.endsWith('F675') ? idx : -1))
        .filter((idx) => idx >= 0);
      expect(dogboneIndices.length).toBeGreaterThanOrEqual(4);
      for (const idx of dogboneIndices) {
        // The line immediately before the diagonal overcut (F675) must be a perimeter walk (F900) to that corner
        // and the line immediately after returns to that same corner coordinate.
        const before = lines[idx - 1];
        const after = lines[idx + 1];
        expect(before).toMatch(/^G1 X[\d.]+ Y[\d.]+ F900$/);
        expect(before.replace(/ F900$/, '')).toBe(after);
      }
    }
  });

  it('produces saw cuts and dowel hole drilling steps with zero CNC mortises or slots when jointMode is dowel', async () => {
    const wasm = await loadManifold();
    const { flowerStandPreset } = await import('../src/presets/presetScenes');
    const { collectIndividualPartSoups, resolveTimberTargetIds } = await import('../src/utils/timberBreakdown');

    // Selecting a child part (like Leg_FL or Top_Plank_1) in the viewport climbs to the parent assembly ('flower_stand')
    expect(resolveTimberTargetIds(flowerStandPreset.nodes, 'Leg_FL')).toEqual(['flower_stand']);
    expect(resolveTimberTargetIds(flowerStandPreset.nodes, 'Top_Plank_1')).toEqual(['flower_stand']);

    const { items } = collectIndividualPartSoups(flowerStandPreset, ['flower_stand']);
    const res = synthesizeTimberJoinery(
      wasm,
      items.map((it) => it.soup),
      {
        jointMode: 'dowel',
        tenonLengthMm: 20,
        edgeProfile: 'roundover',
        edgeRadiusMm: 4,
        maxBoardWidthMm: 200,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const part of res.parts) {
      expect(part.mortises.length).toBe(0);
      expect(part.tenons.length).toBe(0);
      expect(part.zClipSlots.length).toBe(0);
    }

    const plan = buildTimberCutPlan(res, {
      cncBedMm: [300, 300, 60],
      defaultStockLengthMm: 1800,
    });
    expect(plan.allCncSetups.length).toBe(0);
    for (const card of plan.partCards) {
      expect(card.cncSetups.length).toBe(0);
      expect(card.bandsawSteps.some((s) => s.includes('dowel hole'))).toBe(true);
    }
    // Verify Dowel Depth (tenonLengthMm = 20 mm) yields 40 mm dowel pins and 21 mm hole depth (20 mm + 1 mm relief)
    const legCard = plan.partCards.find((c) => c.partId === 'Leg_FL')!;
    expect(legCard.bandsawSteps.some((s) => s.includes('21 mm dowel hole'))).toBe(true);
  });

  it('produces flush glue-only parts with zero mortises, tenons, dowels, or CNC setups when jointMode is butt', async () => {
    const wasm = await loadManifold();
    const { flowerStandPreset } = await import('../src/presets/presetScenes');
    const { collectIndividualPartSoups } = await import('../src/utils/timberBreakdown');

    const { items } = collectIndividualPartSoups(flowerStandPreset, ['flower_stand']);
    const res = synthesizeTimberJoinery(
      wasm,
      items.map((it) => it.soup),
      {
        jointMode: 'butt',
        edgeProfile: 'none',
        maxBoardWidthMm: 200,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const part of res.parts) {
      expect(part.mortises.length).toBe(0);
      expect(part.tenons.length).toBe(0);
      expect(part.zClipSlots.length).toBe(0);
    }
    for (const joint of res.joints) {
      expect(joint.dowelCentersMm ?? []).toHaveLength(0);
    }

    const plan = buildTimberCutPlan(res, {
      cncBedMm: [300, 300, 60],
    });
    expect(plan.allCncSetups.length).toBe(0);
    for (const card of plan.partCards) {
      expect(card.cncSetups.length).toBe(0);
      expect(card.bandsawSteps.some((s) => s.includes('Cut to '))).toBe(true);
      expect(card.bandsawSteps.some((s) => s.includes('from Bar #'))).toBe(false);
      expect(card.bandsawSteps.some((s) => s.includes('dowel hole'))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Regressions for the timber audit (#17): T-junctions, round tenons, multi-way
// center legs, Y0 datum, end gaps, overlapping rails and Z-clip slots.
// ---------------------------------------------------------------------------

type Wasm = import('manifold-3d').ManifoldToplevel;
type Box = { size: [number, number, number]; at: [number, number, number] };

const LEG_XY = 177.5;

/** A four-leg table (45 mm legs, 22 × 60 aprons at z = 560) plus any extra boxes, as metre soups. */
function tableBoxes(apronLenMm = 310, extra: Box[] = []): Box[] {
  const boxes: Box[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    boxes.push({ size: [45, 45, 600], at: [sx * LEG_XY, sy * LEG_XY, 300] });
  }
  for (const s of [-1, 1]) {
    boxes.push({ size: [apronLenMm, 22, 60], at: [0, s * LEG_XY, 560] });
    boxes.push({ size: [22, apronLenMm, 60], at: [s * LEG_XY, 0, 560] });
  }
  return [...boxes, ...extra];
}

function soupsOf(wasm: Wasm, boxes: Box[]): Float64Array[] {
  return boxes.map((b) => {
    const m = wasm.Manifold.cube(b.size, true).translate(b.at);
    const soup = manifoldMmToSoupMetres(m);
    m.delete();
    return soup;
  });
}

/** Total pairwise 3D intersection volume between every finished part, mm³. */
function totalInterferenceMm3(wasm: Wasm, res: import('../src/utils/timberJoinery').TimberBreakdownResult): number {
  const ms = res.parts.map((p) => {
    const posMm = new Float32Array(p.section.positions.length);
    for (let i = 0; i < posMm.length; i++) posMm[i] = p.section.positions[i] * MM;
    return meshMmToManifold(wasm, posMm, p.section.faces);
  });
  try {
    let total = 0;
    for (let a = 0; a < ms.length; a++) {
      for (let b = a + 1; b < ms.length; b++) {
        const inter = ms[a].intersect(ms[b]);
        total += inter.volume();
        inter.delete();
      }
    }
    return total;
  } finally {
    for (const m of ms) m.delete();
  }
}

/** The G-code lines between a feature's comment and the next comment or retract. */
function featureBlock(gcode: string, commentIncludes: string): string[] {
  const lines = gcode.split('\n');
  const start = lines.findIndex((l) => l.startsWith(';') && l.includes(commentIncludes));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(';') || lines[i].startsWith('M5')) break;
    out.push(lines[i]);
  }
  return out;
}

function xyExtent(block: string[]): { x: [number, number]; y: [number, number] } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of block) {
    if (!l.startsWith('G1')) continue;
    const xm = /X(-?[\d.]+)/.exec(l);
    const ym = /Y(-?[\d.]+)/.exec(l);
    if (xm) { const x = +xm[1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    if (ym) { const y = +ym[1]; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x: [x0, x1], y: [y0, y1] };
}

describe('Timber audit #17 regressions (joinery & cut plan)', () => {
  it('mills a rail-into-rail T-junction mortise along the host apron, not rotated 90°', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(
      wasm,
      soupsOf(wasm, tableBoxes(310, [{ size: [22, 333, 60], at: [0, 0, 560] }])),
      { jointMode: 'mortise_tenon', tenonCornerFit: 'dogbone', cutterDiaMm: 6 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const center = res.parts.find((p) => p.member.id === 'Apron_Center')!;
    expect(center.tenons.map((t) => t.matingMemberId).sort()).toEqual(['Apron_Back', 'Apron_Front']);
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);

    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    const setup = plan.allCncSetups.find(
      (s) => s.partId === 'Apron_Front' && s.operationsSummary.some((o) => o.includes('Apron_Center')),
    )!;
    expect(setup).toBeTruthy();
    // The 50 mm tenon width runs across the apron's 60 mm face (machine X), its 9 mm thickness along the apron (Y).
    const { x, y } = xyExtent(featureBlock(setup.gcode, 'M_Apron_Front_Apron_Center'));
    expect(x[1] - x[0]).toBeGreaterThan(40);
    expect(y[1] - y[0]).toBeLessThan(8);
  });

  it('cuts round_tenon mortises with the same corner radius as their tenons, with zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, tableBoxes()), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'round_tenon',
      cutterDiaMm: 6,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
    for (const j of res.joints) {
      const m = j.mortise!;
      expect(m.cornerRadiusMm).toBeCloseTo(roundTenonCornerRadiusMm(m.widthMm, m.thicknessMm, 6), 3);
    }
    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    // No dogbone overcuts on a rounded mortise.
    for (const s of plan.allCncSetups) expect(s.gcode).not.toContain('F675');
  });

  it('notes chisel_square mortises for hand squaring on the cut plan', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, tableBoxes()), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'chisel_square',
      cutterDiaMm: 6,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    const leg = plan.partCards.find((c) => c.partId === 'Leg_FL')!;
    expect(leg.bandsawSteps.some((s) => s.includes('chisel'))).toBe(true);
    expect(plan.allCncSetups.some((s) => s.operationsSummary.some((o) => o.includes('chisel')))).toBe(true);
  });

  it('keeps opposite-face and 3-way center-leg tenons apart in a 6-leg table', async () => {
    const wasm = await loadManifold();
    const boxes: Box[] = [];
    for (const x of [-300, 0, 300]) for (const sy of [-1, 1]) {
      boxes.push({ size: [45, 45, 600], at: [x, sy * LEG_XY, 300] });
    }
    for (const sy of [-1, 1]) {
      boxes.push({ size: [255, 22, 60], at: [-150, sy * LEG_XY, 560] });
      boxes.push({ size: [255, 22, 60], at: [150, sy * LEG_XY, 560] });
    }
    for (const x of [-300, 0, 300]) boxes.push({ size: [22, 310, 60], at: [x, 0, 560] });

    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, boxes), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 25,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parts.filter((p) => p.member.role === 'leg').length).toBe(6);
    expect(res.joints.filter((j) => j.kind === 'mortise_tenon').length).toBe(14);

    // Each center leg holds two opposite tenons, shortened so they never meet in its 45 mm.
    const centerLegs = res.parts.filter((p) => p.member.role === 'leg' && p.mortises.length === 3);
    expect(centerLegs.length).toBe(2);
    for (const leg of centerLegs) {
      const opposite = leg.mortises.filter((m) => Math.abs(m.inwardNormal[0]) > 0.9);
      expect(opposite.length).toBe(2);
      expect(opposite[0].depthMm + opposite[1].depthMm).toBeLessThan(45 - 0.5);
    }
    // The center apron's tenons are mitred against both of the opposite tenons they meet.
    const centerApron = res.parts.find(
      (p) => p.member.role === 'rail' && Math.abs(p.member.centerMm[0]) < 1 && Math.abs(p.member.axes[0][1]) > 0.9,
    )!;
    for (const t of centerApron.tenons) expect(t.miterPlanes?.length).toBe(2);

    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
  });

  it('places a T-junction mortise and a centered Z-clip slot on a tenoned apron at the same Y', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(
      wasm,
      soupsOf(wasm, tableBoxes(310, [
        { size: [22, 333, 60], at: [0, 0, 560] },
        { size: [420, 420, 24], at: [0, 0, 612] },
      ])),
      { jointMode: 'mortise_tenon', tenonCornerFit: 'dogbone', cutterDiaMm: 6, tabletopClips: true },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const front = res.parts.find((p) => p.member.id === 'Apron_Front')!;
    expect(front.tenons.length).toBe(2);
    expect(front.zClipSlots.length).toBe(1);
    const mortise = front.mortises.find((m) => m.matingMemberId === 'Apron_Center')!;
    // Measured from the tenon tip at the top end of the cut blank.
    expect(mortise.distFromTopEndMm).toBeCloseTo(front.totalFinishedLengthMm / 2, 1);

    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    const setup = plan.allCncSetups.find((s) => s.partId === 'Apron_Front' && s.gcode.includes('Z-Clip'))!;
    expect(setup).toBeTruthy();
    const mortiseRapid = featureBlock(setup.gcode, 'M_Apron_Front_Apron_Center').find((l) => l.startsWith('G0 X'))!;
    const mortiseY = +/Y(-?[\d.]+)/.exec(mortiseRapid)![1];
    const lines = setup.gcode.split('\n');
    const zc = lines.findIndex((l) => l.includes('Z-Clip Expansion Slot'));
    // The slot ramps in from (c - r) to (c + r) along Y.
    const rampFrom = +/Y(-?[\d.]+)/.exec(lines[zc + 1])![1];
    const rampTo = +/Y(-?[\d.]+)/.exec(lines[zc + 2])![1];
    const slotY = (rampFrom + rampTo) / 2;
    expect(mortiseY).toBeCloseTo(front.totalFinishedLengthMm / 2 - setup.indexOffsetFromTopMm, 1);
    expect(Math.abs(mortiseY - slotY)).toBeLessThan(0.05);
  });

  it('cuts Z-clip slots at least as wide as the cutter and ramps into them', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(
      wasm,
      soupsOf(wasm, tableBoxes(310, [{ size: [420, 420, 24], at: [0, 0, 612] }])),
      { jointMode: 'mortise_tenon', cutterDiaMm: 6, tabletopClips: true },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const slots = res.parts.flatMap((p) => p.zClipSlots);
    expect(slots.length).toBe(4);
    for (const s of slots) expect(s.slotWidthMm).toBeGreaterThanOrEqual(6);
    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    for (const s of plan.allCncSetups) {
      // No straight vertical plunge into the wood anywhere in a slot.
      const block = featureBlock(s.gcode, 'Z-Clip Expansion Slot');
      expect(block.some((l) => /^G1 Z/.test(l))).toBe(false);
    }
  });

  it('bridges a small end gap into one solid rail and refuses a gap past tolerance', async () => {
    const wasm = await loadManifold();
    // 306.4 mm aprons between legs 310 mm apart: 1.8 mm gap each end.
    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, tableBoxes(306.4)), { jointMode: 'mortise_tenon', cutterDiaMm: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const rail of res.parts.filter((p) => p.member.role === 'rail')) {
      expect(rail.tenons.length).toBe(2);
      expect(rail.shoulderToShoulderMm).toBeCloseTo(310, 1);
      const posMm = new Float32Array(rail.section.positions.length);
      for (let i = 0; i < posMm.length; i++) posMm[i] = rail.section.positions[i] * MM;
      const solid = meshMmToManifold(wasm, posMm, rail.section.faces);
      const comps = solid.decompose();
      expect(comps.length).toBe(1);
      for (const c of comps) c.delete();
      solid.delete();
    }
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);

    // 299.2 mm aprons: 5.4 mm gap each end, past the 5 mm tolerance.
    const far = synthesizeTimberJoinery(wasm, soupsOf(wasm, tableBoxes(299.2)), { jointMode: 'mortise_tenon', cutterDiaMm: 6 });
    expect(far.ok).toBe(true);
    if (!far.ok) return;
    expect(far.warnings.some((w) => w.includes('short of'))).toBe(true);
    for (const rail of far.parts.filter((p) => p.member.role === 'rail')) {
      expect(rail.tenons.length).toBe(0);
    }
  });

  it('measures an overlapping rail shoulder to shoulder at the leg faces', async () => {
    const wasm = await loadManifold();
    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, tableBoxes(320)), { jointMode: 'mortise_tenon', cutterDiaMm: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const rail of res.parts.filter((p) => p.member.role === 'rail')) {
      expect(rail.shoulderToShoulderMm).toBeCloseTo(310, 1);
      expect(rail.totalFinishedLengthMm).toBeCloseTo(310 + 2 * 22, 1);
    }
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
  });

  it('miters and shortens 4-way center-post tenons cleanly with zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const boxes: Box[] = [
      { size: [45, 45, 600], at: [0, 0, 300] },
      { size: [200, 22, 60], at: [-122.5, 0, 520] },
      { size: [200, 22, 60], at: [122.5, 0, 520] },
      { size: [22, 200, 60], at: [0, -122.5, 520] },
      { size: [22, 200, 60], at: [0, 122.5, 520] },
    ];
    const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, boxes), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 25,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.joints.length).toBe(4);
    for (const j of res.joints) {
      expect(j.tenon!.lengthMm).toBeLessThanOrEqual(20.5);
      expect(j.tenon!.miterPlanes?.length).toBe(2);
    }
    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(0.5);
  });

  it('frames 45° angled knee braces into legs and aprons with zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const base = tableBoxes(310);
    const solids = base.map((b) => wasm.Manifold.cube(b.size, true).translate(b.at));
    // Add a 45° knee brace in the front (-Y) plane between Leg_FL (x = -155) and Apron_Front underside (z = 530)
    // Midpoint (-105, -177.5, 480) lies on x - (-155) = 530 - z = 50 -> span = 100 * sqrt(2) = 141.42 mm;
    // model it slightly overlapping (155 mm) as a user would draw a knee brace!
    const rawBrace = wasm.Manifold.cube([155, 22, 35], true).rotate([0, -45, 0]);
    solids.push(rawBrace.translate([-105, -LEG_XY, 480]));
    rawBrace.delete();

    const soups = solids.map(manifoldMmToSoupMetres);
    for (const s of solids) s.delete();

    const res = synthesizeTimberJoinery(wasm, soups, {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 16,
      edgeProfile: 'square',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const bracePart = res.parts.find((p) => p.member.id.startsWith('Brace_'))!;
    expect(bracePart).toBeTruthy();
    expect(bracePart.member.role).toBe('rail');
    expect(bracePart.tenons.length).toBe(2);
    for (const t of bracePart.tenons) {
      expect(t.shoulderAngleDeg).toBeCloseTo(45, 0);
      expect(t.cutMethod).toBe('cnc');
    }
    // Single connected solid for the brace (no detached tenons) and zero 3D overlap
    const posMm = new Float32Array(bracePart.section.positions.length);
    for (let i = 0; i < posMm.length; i++) posMm[i] = bracePart.section.positions[i] * MM;
    const braceSolid = meshMmToManifold(wasm, posMm, bracePart.section.faces);
    const comps = braceSolid.decompose();
    expect(comps.length).toBe(1);
    for (const c of comps) c.delete();
    braceSolid.delete();

    expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
  });

  it('synthesizes stopped dado joints on panel-to-panel bookcase shelves (both wide and narrow spans)', async () => {
    const wasm = await loadManifold();
    for (const shelfSpanX of [380, 240]) {
      const halfSpan = shelfSpanX / 2;
      const sideX = halfSpan + 10; // 20 mm thick vertical side walls
      const boxes: Box[] = [
        { size: [20, 300, 800], at: [-sideX, 0, 400] },
        { size: [20, 300, 800], at: [sideX, 0, 400] },
        { size: [shelfSpanX, 300, 20], at: [0, 0, 150] },
        { size: [shelfSpanX, 300, 20], at: [0, 0, 450] },
        { size: [shelfSpanX, 300, 20], at: [0, 0, 750] },
      ];
      const res = synthesizeTimberJoinery(wasm, soupsOf(wasm, boxes), {
        jointMode: 'dado',
        tenonCornerFit: 'dogbone',
        cutterDiaMm: 6,
        maxBoardWidthMm: 350,
        edgeProfile: 'square',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.parts.length).toBe(5);
      expect(res.joints.filter((j) => j.kind === 'dado').length).toBe(6);
      const leftSide = res.parts.find((p) => p.member.id === 'Side_Left')!;
      const rightSide = res.parts.find((p) => p.member.id === 'Side_Right')!;
      expect(leftSide.mortises.length).toBe(3);
      expect(rightSide.mortises.length).toBe(3);
      for (const m of leftSide.mortises) {
        expect(m.widthMm).toBeGreaterThan(270);
        expect(m.thicknessMm).toBeGreaterThan(14);
        expect(m.depthMm).toBeCloseTo(10, 1);
      }
      expect(totalInterferenceMm3(wasm, res)).toBeLessThan(1.0);
    }
  });
});



