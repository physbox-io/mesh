import { describe, expect, it } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import { extractTimberMembers, meshMmToManifold } from '../src/utils/timberBreakdown';
import { synthesizeTimberJoinery } from '../src/utils/timberJoinery';
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
    expect(cutPlan.buildGuideMarkdown).toContain("Bird's-Eye Corner Orientation Map");
    expect(cutPlan.buildGuideMarkdown).toContain('Leg_FL');
    expect(cutPlan.buildGuideMarkdown).toContain('Reference Datum Faces');
    expect(cutPlan.buildGuideMarkdown).toContain('Two-Stage Glue-Up & Squaring Checklist');
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
    expect(res.parts.filter((p) => p.member.role === 'leg').length).toBe(4);
    expect(res.parts.filter((p) => p.member.role === 'rail').length).toBe(8);
    expect(res.parts.filter((p) => p.member.role === 'panel').length).toBe(2);

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
});



