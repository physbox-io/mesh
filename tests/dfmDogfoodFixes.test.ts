import { describe, it, expect } from 'vitest';
import {
  analyseDfm,
  narrowestAirGap,
  PRINT_MIN_AIR_GAP_MM,
  resolveDfmCastMaterialStrict,
} from '../src/utils/dfm';
import { dfmCommands } from '../src/hooks/mcp/dfmCommands';
import { useStore } from '../src/store/useStore';
import { boxMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const meshBody = (m: { verts: number[]; faces: number[] }, extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'part',
  name: 'part',
  type: 'body',
  pos: [0, 0, 0],
  joints: [],
  children: [],
  geoms: [{
    name: 'part_mesh',
    type: 'mesh',
    size: [1],
    renderVertices: m.verts,
    vertices: zupToYupFlat(m.verts),
    faces: m.faces,
  } as SceneGeom],
  ...extra,
});

const boxBody = (
  c: [number, number, number],
  h: [number, number, number],
  id: string,
  extra: Partial<SceneNode> = {},
): SceneNode => meshBody(boxMesh(c, h), { id, name: id, ...extra });

const runCheckDfm = (scene: SceneGraph, msg: Record<string, unknown>) =>
  dfmCommands.CHECK_DFM(msg, {
    store: { ...useStore.getState(), sceneGraph: scene },
    toId: (v: unknown) => v,
  } as never) as Promise<Record<string, unknown>>;

describe('CHECK_DFM parent-subtree scoping (Issue 1)', () => {
  const buildCabinetScene = (): SceneGraph => {
    // 6 wood panels (18 mm thick, all clean) + 2 thin unrequested child hardware parts under bottom_panel.
    const thinHardwareLatch = boxBody([0, 0, 0.05], [0.0002, 0.02, 0.02], 'brass_latch');
    const thinHardwarePin = boxBody([0.05, 0, 0.05], [0.0002, 0.02, 0.02], 'hinge_pin');
    const front = boxBody([0, -0.05, 0.03], [0.04, 0.009, 0.02], 'front_panel');
    const back = boxBody([0, 0.05, 0.03], [0.04, 0.009, 0.02], 'back_panel');
    const left = boxBody([-0.05, 0, 0.03], [0.009, 0.04, 0.02], 'left_panel');
    const right = boxBody([0.05, 0, 0.03], [0.009, 0.04, 0.02], 'right_panel');
    const lid = boxBody([0, 0, 0.06], [0.04, 0.04, 0.009], 'lid_panel');
    const bottom = boxBody([0, 0, 0.009], [0.04, 0.04, 0.009], 'bottom_panel', {
      children: [front, back, left, right, lid, thinHardwareLatch, thinHardwarePin],
    });
    return { nodes: [bottom] } as SceneGraph;
  };

  it('respects explicit comma-separated master_id lists without leaking unrequested child hardware', async () => {
    const sc = buildCabinetScene();
    const res = await runCheckDfm(sc, {
      process: 'print',
      masterId: 'front_panel,back_panel,left_panel,right_panel,bottom_panel,lid_panel',
    });

    expect(res.ok).toBe(true);
    const checked = res.checked as { label: string; ids: string[] };
    expect(checked.ids).toEqual([
      'front_panel',
      'back_panel',
      'left_panel',
      'right_panel',
      'bottom_panel',
      'lid_panel',
    ]);
    const findings = res.findings as { id: string; title: string }[];
    expect(findings.some((f) => f.id.includes('brass_latch') || f.id.includes('hinge_pin'))).toBe(false);
  });

  it('supports explicit include_children: false on a single parent node and rejects non-boolean values', async () => {
    const sc = buildCabinetScene();
    const res = await runCheckDfm(sc, {
      process: 'print',
      masterId: 'bottom_panel',
      include_children: false,
    });
    expect(res.ok).toBe(true);
    expect((res.checked as { ids: string[] }).ids).toEqual(['bottom_panel']);
    const findings = res.findings as { id: string }[];
    expect(findings.some((f) => f.id.includes('brass_latch') || f.id.includes('hinge_pin'))).toBe(false);

    // Default single-root behavior still includes descendants.
    const withChildren = await runCheckDfm(sc, {
      process: 'print',
      masterId: 'bottom_panel',
    });
    expect(withChildren.ok).toBe(true);
    const childFindings = withChildren.findings as { id: string }[];
    expect(childFindings.some((f) => f.id.includes('brass_latch'))).toBe(true);

    // Non-boolean include_children is rejected.
    const bad = await runCheckDfm(sc, { process: 'print', masterId: 'bottom_panel', include_children: 'no' });
    expect(bad.ok).toBe(false);
  });
});

describe('bed_mm print build-volume override (Issue 2)', () => {
  const plate230 = { nodes: [boxBody([0, 0, 0.02], [0.115, 0.115, 0.02], 'big_plate')] } as SceneGraph;

  it('overrides bed limits via bed_mm in analyseDfm', () => {
    const fits256 = analyseDfm(plate230, 'print', { bed_mm: [256, 256, 256] });
    expect(fits256.findings.find((f) => f.id === 'print_exceeds_bed')).toBeUndefined();

    const exceeds220 = analyseDfm(plate230, 'print', { bed_mm: [220, 220, 250] });
    const f = exceeds220.findings.find((x) => x.id === 'print_exceeds_bed');
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/220 × 220 × 250 mm/);
  });

  it('accepts bed_mm in CHECK_DFM and validates invalid inputs', async () => {
    const res = await runCheckDfm(plate230, {
      process: 'print',
      masterId: 'big_plate',
      bed_mm: [220, 220, 250],
    });
    expect(res.ok).toBe(true);
    expect(res.bedMm).toEqual([220, 220, 250]);
    const findings = res.findings as { id: string }[];
    expect(findings.some((f) => f.id === 'print_exceeds_bed')).toBe(true);

    const bad = await runCheckDfm(plate230, {
      process: 'print',
      masterId: 'big_plate',
      bed_mm: [220, -10, 250],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('casting metals and resolved minWallMm reporting (Issue 3)', () => {
  const plateMm = (mm: number): SceneGraph => ({
    nodes: [boxBody([0, 0, mm / 2000], [0.02, 0.02, mm / 2000], 'plate')],
  } as SceneGraph);

  it('resolves bronze, aluminium/aluminum, brass, silver, pewter, zinc, and iron with realistic thresholds', () => {
    expect(resolveDfmCastMaterialStrict('bronze')).toMatchObject({ id: 'bronze', minSectionMm: 2.5 });
    expect(resolveDfmCastMaterialStrict('aluminium')).toMatchObject({ id: 'aluminium', minSectionMm: 3.0 });
    expect(resolveDfmCastMaterialStrict('aluminum')).toMatchObject({ id: 'aluminium', minSectionMm: 3.0 });
    expect(resolveDfmCastMaterialStrict('brass')).toMatchObject({ id: 'brass', minSectionMm: 2.5 });
    expect(resolveDfmCastMaterialStrict('silver')).toMatchObject({ id: 'silver', minSectionMm: 1.0 });
    expect(resolveDfmCastMaterialStrict('pewter')).toMatchObject({ id: 'pewter', minSectionMm: 2.0 });
    expect(resolveDfmCastMaterialStrict('zinc')).toMatchObject({ id: 'zinc', minSectionMm: 2.0 });
    expect(resolveDfmCastMaterialStrict('iron')).toMatchObject({ id: 'iron', minSectionMm: 3.5 });
  });

  it('applies per-metal thresholds and reports castMaterial + minWallMm in analyseDfm and CHECK_DFM', async () => {
    const p22 = plateMm(2.2);

    const bronze = analyseDfm(p22, 'cast', { castMaterial: 'bronze' });
    expect(bronze.castMaterial).toBe('bronze');
    expect(bronze.minWallMm).toBe(2.5);
    expect(bronze.findings.find((f) => f.id === 'cast_thin_section')).toBeDefined();

    const pewter = analyseDfm(p22, 'cast', { castMaterial: 'pewter' });
    expect(pewter.castMaterial).toBe('pewter');
    expect(pewter.minWallMm).toBe(2.0);
    expect(pewter.findings.find((f) => f.id === 'cast_thin_section')).toBeUndefined();
    expect(pewter.summary).toMatch(/Pewter.*2 mm/);

    const iron = analyseDfm(plateMm(3.0), 'cast', { castMaterial: 'iron' });
    expect(iron.castMaterial).toBe('iron');
    expect(iron.minWallMm).toBe(3.5);
    expect(iron.findings.find((f) => f.id === 'cast_thin_section')).toBeDefined();

    // Direct analyseDfm with an unknown castMaterial warns and falls back to epoxy.
    const unknown = analyseDfm(p22, 'cast', { castMaterial: 'unobtainium' });
    expect(unknown.castMaterial).toBe('epoxy');
    expect(unknown.minWallMm).toBe(1.0);
    expect(unknown.warnings.some((w) => w.includes('unobtainium'))).toBe(true);

    // CHECK_DFM accepts US spelling 'aluminum' and extra metals, and returns castMaterial + minWallMm.
    const mcpAl = await runCheckDfm(p22, { process: 'cast', masterId: 'plate', castMaterial: 'aluminum' });
    expect(mcpAl.ok).toBe(true);
    expect(mcpAl.castMaterial).toBe('aluminium');
    expect(mcpAl.minWallMm).toBe(3.0);
    expect((mcpAl.findings as { id: string }[]).some((f) => f.id === 'cast_thin_section')).toBe(true);

    const mcpZinc = await runCheckDfm(p22, { process: 'cast', masterId: 'plate', castMaterial: 'zinc' });
    expect(mcpZinc.ok).toBe(true);
    expect(mcpZinc.castMaterial).toBe('zinc');
    expect(mcpZinc.minWallMm).toBe(2.0);
    expect((mcpZinc.findings as { id: string }[]).some((f) => f.id === 'cast_thin_section')).toBe(false);
  });
});

describe('print-in-place air-gap clearance & XY-flat flexure note (Issue 4)', () => {
  it('flags narrow opposing-wall air gaps (< 0.35 mm) in both single-soup and multi-body print assemblies', () => {
    // Two 10 mm thick walls separated by a 0.20 mm air gap along X:
    // wall A: x in [-0.0101, -0.0001], wall B: x in [0.0001, 0.0101] => gap = 0.0002 m = 0.20 mm.
    const wallA = boxBody([-0.0051, 0, 0.01], [0.005, 0.015, 0.01], 'wall_a');
    const wallB = boxBody([0.0051, 0, 0.01], [0.005, 0.015, 0.01], 'wall_b');
    const tightAssembly = { nodes: [wallA, wallB] } as SceneGraph;

    // Multi-body print-in-place assembly check:
    const rMulti = analyseDfm(tightAssembly, 'print', { checkAllAsPlate: true });
    const gapFinding = rMulti.findings.find((f) => f.id === 'print_narrow_gap');
    expect(gapFinding).toBeDefined();
    expect(gapFinding!.metric!).toBeCloseTo(0.2, 1);
    expect(gapFinding!.detail).toMatch(/0\.35 mm/);

    // Tighter 0.15 mm gap is critical (< 0.2 mm).
    const critA = boxBody([-0.005075, 0, 0.01], [0.005, 0.015, 0.01], 'crit_a');
    const critB = boxBody([0.005075, 0, 0.01], [0.005, 0.015, 0.01], 'crit_b');
    const rCrit = analyseDfm({ nodes: [critA, critB] } as SceneGraph, 'print', { asPlaced: true });
    const critGap = rCrit.findings.find((f) => f.id === 'print_narrow_gap');
    expect(critGap).toBeDefined();
    expect(critGap!.severity).toBe('critical');

    // Adequate 0.50 mm clearance (>= 0.35 mm) does NOT trigger print_narrow_gap.
    const clearA = boxBody([-0.00525, 0, 0.01], [0.005, 0.015, 0.01], 'clear_a');
    const clearB = boxBody([0.00525, 0, 0.01], [0.005, 0.015, 0.01], 'clear_b');
    const rClear = analyseDfm({ nodes: [clearA, clearB] } as SceneGraph, 'print', { checkAllAsPlate: true });
    expect(rClear.findings.find((f) => f.id === 'print_narrow_gap')).toBeUndefined();
    expect(narrowestAirGap(rClear.tris, PRINT_MIN_AIR_GAP_MM)).toBeNull();
  });

  it('notes vertical-extruded XY flexure blades >= 0.8 mm as info instead of warning', () => {
    // 1.0 mm thick vertical blade in X (20 mm long in Y, 15 mm tall in Z) checked with a 0.6 mm nozzle (minWallMm = 1.2 mm).
    const blade = { nodes: [boxBody([0, 0, 0.0075], [0.0005, 0.01, 0.0075], 'flex_blade')] } as SceneGraph;
    const rBlade = analyseDfm(blade, 'print', {
      asPlaced: true,
      printer: { process: 'fdm', nozzleMm: 0.6, layerHeightMm: 0.2 },
    });
    const bladeThin = rBlade.findings.find((f) => f.id === 'print_thin_wall');
    expect(bladeThin).toBeDefined();
    expect(bladeThin!.severity).toBe('info');
    expect(bladeThin!.detail).toMatch(/flexure blade/i);

    // Compare with a 1.0 mm thin horizontal floor (thin along Z) under the same 0.6 mm nozzle: still a warning.
    const floor = { nodes: [boxBody([0, 0, 0.0005], [0.02, 0.02, 0.0005], 'thin_floor')] } as SceneGraph;
    const rFloor = analyseDfm(floor, 'print', {
      asPlaced: true,
      printer: { process: 'fdm', nozzleMm: 0.6, layerHeightMm: 0.2 },
    });
    const floorThin = rFloor.findings.find((f) => f.id === 'print_thin_wall');
    expect(floorThin).toBeDefined();
    expect(floorThin!.severity).toBe('warning');
  });
});

/** Extrudes a 2D closed CCW polygon in the XZ plane along Y in [-halfY, +halfY] into an outward-wound triangle soup. */
function extrudeXZPolygon(poly: [number, number][], halfY: number): { verts: number[]; faces: number[] } {
  const n = poly.length;
  const verts: number[] = [];
  // 0..n-1: front face (y = -halfY), n..2n-1: back face (y = +halfY)
  for (const [x, z] of poly) verts.push(x, -halfY, z);
  for (const [x, z] of poly) verts.push(x, halfY, z);
  const faces: number[] = [];
  // Side walls (outward normal in XZ): for CCW polygon in XZ (x right, z up),
  // edge (p[i] -> p[j]) has outward normal (dz, 0, -dx).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // (front_i, back_i, back_j) -> (0, +2h, 0) x (dx, 0, dz) = (2h*dz, 0, -2h*dx) -> outward!
    faces.push(i, n + i, n + j);
    faces.push(i, n + j, j);
  }
  // Ear-clipping triangulation for simple 2D CCW polygon in XZ.
  const idx = Array.from({ length: n }, (_, k) => k);
  const cross2 = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const c1 = cross2(a, b, p), c2 = cross2(b, c, p), c3 = cross2(c, a, p);
    return c1 >= -1e-12 && c2 >= -1e-12 && c3 >= -1e-12;
  };
  const capTris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 500) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length];
      const b = idx[k];
      const c = idx[(k + 1) % idx.length];
      if (cross2(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let contains = false;
      for (const m of idx) {
        if (m === a || m === b || m === c) continue;
        if (inTri(poly[m], poly[a], poly[b], poly[c])) { contains = true; break; }
      }
      if (!contains) {
        capTris.push([a, b, c]);
        idx.splice(k, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) capTris.push([idx[0], idx[1], idx[2]]);
  // Front cap (y = -halfY, outward normal -Y): for CCW in XZ, (a, b, c) has (b-a)x(c-a) = (0, -cross2, 0) -> -Y!
  for (const [a, b, c] of capTris) {
    faces.push(a, b, c);
    // Back cap (y = +halfY, outward normal +Y): reverse winding.
    faces.push(n + a, n + c, n + b);
  }
  return { verts, faces };
}

function meshToFlatTris(m: { verts: number[]; faces: number[] }): Float64Array {
  const out = new Float64Array(m.faces.length * 3);
  for (let i = 0; i < m.faces.length; i++) {
    const vi = m.faces[i] * 3;
    out[i * 3] = m.verts[vi];
    out[i * 3 + 1] = m.verts[vi + 1];
    out[i * 3 + 2] = m.verts[vi + 2];
  }
  return out;
}

describe('narrowestAirGap Round 2 false-positive fixes', () => {
  it('ignores visual-only / flexure leaf geoms bonded to their parent body in multi-body print_narrow_gap checks', () => {
    // Base frame at x in [-0.015, -0.005], moving stage at x in [0.005, 0.015] (10 mm apart).
    // Stage carries flexure leaf geoms whose roots terminate 0.15 mm from base_frame.
    const baseFrame = boxBody([-0.01, 0, 0.01], [0.005, 0.02, 0.01], 'base_frame');
    const stageWithFlexure: SceneNode = {
      ...boxBody([0.01, 0, 0.01], [0.005, 0.02, 0.01], 'moving_stage'),
      geoms: [
        ...boxBody([0.01, 0, 0.01], [0.005, 0.02, 0.01], 'moving_stage').geoms!,
        // Flexure leaf with name 'flexure_*', role: 'visual', and bend metadata — root at x = -0.00485 (0.15 mm from base_frame).
        {
          name: 'flexure_parallel_0',
          type: 'box',
          size: [0.004925, 0.0005, 0.008],
          pos: [0.000075, 0.008, 0.01],
          role: 'visual',
          bend: { axis: [0, 1, 0], from: [0, 0, 0], to: [0.01, 0, 0] },
        } as unknown as SceneGeom,
        // Plain visual-only leaf geom (no flexure_ prefix, no bend) terminating 0.15 mm from base_frame.
        {
          name: 'bonded_visual_leaf',
          type: 'box',
          size: [0.004925, 0.0005, 0.008],
          pos: [0.000075, -0.008, 0.01],
          role: 'visual',
        } as SceneGeom,
        // Promoted flexure_* geom without role: 'visual' terminating 0.15 mm from base_frame.
        {
          name: 'flexure_blade_root',
          type: 'box',
          size: [0.004925, 0.0005, 0.008],
          pos: [0.000075, 0, 0.01],
        } as SceneGeom,
      ],
    };

    const report = analyseDfm({ nodes: [baseFrame, stageWithFlexure] } as SceneGraph, 'print', {
      checkAllAsPlate: true,
    });
    expect(report.findings.find((f) => f.id === 'print_narrow_gap' || f.id.endsWith(':print_narrow_gap'))).toBeUndefined();
  });

  it('does not false-flag acute interior V-creases (45° and steep 70° gable roof ridges) as narrow air gaps', () => {
    // 45° gable roof shell (90° interior ridge apex, 3 mm wall thickness, 30 mm deep along Y).
    const roof45Poly: [number, number][] = [
      [-0.020, 0.000],
      [-0.016, 0.000],
      [0.000, 0.016],
      [0.016, 0.000],
      [0.020, 0.000],
      [0.020, 0.004],
      [0.000, 0.024],
      [-0.020, 0.004],
    ];
    const roof45Mesh = extrudeXZPolygon(roof45Poly, 0.015);
    expect(narrowestAirGap(meshToFlatTris(roof45Mesh), PRINT_MIN_AIR_GAP_MM)).toBeNull();
    const r45 = analyseDfm({ nodes: [meshBody(roof45Mesh, { id: 'gable_45', name: 'gable_45' })] } as SceneGraph, 'print', {
      asPlaced: true,
    });
    expect(r45.findings.find((f) => f.id === 'print_narrow_gap')).toBeUndefined();

    // Very steep 70° gable roof / acute V-crease (40° interior apex angle, dot(nA, nB) ≈ -0.77 < -0.5).
    const roof70Poly: [number, number][] = [
      [-0.014, 0.000],
      [-0.010, 0.000],
      [0.000, 0.0275],
      [0.010, 0.000],
      [0.014, 0.000],
      [0.014, 0.006],
      [0.000, 0.0445],
      [-0.014, 0.006],
    ];
    const roof70Mesh = extrudeXZPolygon(roof70Poly, 0.015);
    expect(narrowestAirGap(meshToFlatTris(roof70Mesh), PRINT_MIN_AIR_GAP_MM)).toBeNull();
    const r70 = analyseDfm({ nodes: [meshBody(roof70Mesh, { id: 'gable_70', name: 'gable_70' })] } as SceneGraph, 'print', {
      asPlaced: true,
    });
    expect(r70.findings.find((f) => f.id === 'print_narrow_gap')).toBeUndefined();
  });

  it('still catches genuine single-part parallel-wall narrow air gaps (< 0.35 mm) in a U-slot', () => {
    // Single watertight U-shaped part: two vertical parallel walls separated by a 0.20 mm slot along X.
    // Left wall: x in [-0.0061, -0.0001], right wall: x in [0.0001, 0.0061], joined by a 4 mm floor at z in [0, 0.004].
    const uSlotPoly: [number, number][] = [
      [-0.0061, 0.000],
      [0.0061, 0.000],
      [0.0061, 0.020],
      [0.0001, 0.020],
      [0.0001, 0.004],
      [-0.0001, 0.004],
      [-0.0001, 0.020],
      [-0.0061, 0.020],
    ];
    const uSlotMesh = extrudeXZPolygon(uSlotPoly, 0.015);
    const gap = narrowestAirGap(meshToFlatTris(uSlotMesh), PRINT_MIN_AIR_GAP_MM);
    expect(gap).not.toBeNull();
    expect(gap!.mm).toBeCloseTo(0.2, 1);
  });
});
