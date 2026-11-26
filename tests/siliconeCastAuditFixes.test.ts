import { describe, it, expect, beforeEach } from 'vitest';
import type { SceneGraph, SceneNode, SceneGeom } from '../src/types/scene';
import { siliconeChain } from '../src/utils/castChain';
import { simulatedBody } from '../src/utils/simulatedPart';
import { meshIntegrity } from '../src/utils/sceneSummary';
import { castCommands } from '../src/hooks/mcp/castCommands';
import { addPourBoxToScene } from '../src/utils/pourBoxActions';
import { addSiliconeChain } from '../src/utils/castChainActions';
import { useStore } from '../src/store/useStore';
import { castMaterial } from '../src/utils/castMaterials';
import { sceneStockTransform } from '../src/hooks/useAddSimulation';
import { compileToMJCF } from '../src/utils/mjcf';
import { loadManifold } from '../src/utils/sculptCut';
import { cleanManifoldMesh } from '../src/utils/printedMesh';
import { analyzeMesh, weldByPosition } from '../src/utils/meshIntegrity';

const body = (id: string, geoms: SceneGeom[], pos = [0, 0, 0]): SceneNode =>
  ({ id, name: id, type: 'body', pos, joints: [], geoms, children: [] } as unknown as SceneNode);
const box = (name: string, half: number[], pos = [0, 0, 0]): SceneGeom =>
  ({ name, type: 'box', size: half, pos } as SceneGeom);
const cyl = (name: string, r: number, half: number, pos = [0, 0, 0]): SceneGeom =>
  ({ name, type: 'cylinder', size: [r, half], pos } as SceneGeom);

/** A mushroom: stem + overhanging cap (triggers auto-vents on silicone mold). */
const mushroom: SceneGraph = {
  nodes: [body('mushroom', [cyl('stem', 0.005, 0.006, [0, 0, 0.006]), cyl('cap', 0.014, 0.003, [0, 0, 0.015])])],
};

/** Two ledges stacked over each other: spool with multiple auto-vents. */
const spool: SceneGraph = {
  nodes: [body('spool', [
    cyl('a', 0.008, 0.0025, [0, 0, 0.0025]), cyl('n1', 0.005, 0.0015, [0, 0, 0.0065]),
    cyl('b', 0.008, 0.0025, [0, 0, 0.0105]), cyl('n2', 0.005, 0.0015, [0, 0, 0.0145]),
    cyl('c', 0.008, 0.0025, [0, 0, 0.0185]),
  ])],
};

/** A concrete-scale stepped block (80 x 80 x 50 mm with overhanging lip). */
const concretePot: SceneGraph = {
  nodes: [body('planter', [
    box('base', [0.035, 0.035, 0.015], [0, 0, 0.015]),
    box('rim', [0.042, 0.042, 0.01], [0, 0, 0.04]),
  ])],
};

/** A hollow concrete planter (outer cylinder minus inner cylinder cavity). */
const hollowPlanter: SceneGraph = {
  nodes: [body('hollow_planter', [
    cyl('outer', 0.04, 0.03, [0, 0, 0.03]),
    { name: 'inner', type: 'cylinder', size: [0.028, 0.024], pos: [0, 0, 0.036], csg: 'difference' } as SceneGeom,
  ])],
};

/** An arched concrete bookend (two pillars + top arch bar, overhangs underside). */
const archBookend: SceneGraph = {
  nodes: [body('bookend', [
    box('left', [0.01, 0.025, 0.03], [-0.025, 0, 0.03]),
    box('right', [0.01, 0.025, 0.03], [0.025, 0, 0.03]),
    box('bridge', [0.035, 0.025, 0.01], [0, 0, 0.07]),
  ])],
};

describe('silicone mold & concrete casting audit fixes', () => {
  beforeEach(() => {
    useStore.getState().updateScene({ nodes: [] });
  });

  describe('1. Manifold silicone mold mesh (nonManifoldEdges === 0)', () => {
    it('produces a watertight, manifold silicone mold mesh for vented mushroom, spool, stepped, hollow planter, and arch bookend', async () => {
      for (const [label, scene, id, mat, opts] of [
        ['mushroom', mushroom, 'mushroom', 'concrete', {}],
        ['spool', spool, 'spool', 'concrete', {}],
        ['planter', concretePot, 'planter', 'concrete', {}],
        ['hollow_planter', hollowPlanter, 'hollow_planter', 'concrete', {}],
        ['hollow_planter_round', hollowPlanter, 'hollow_planter', 'concrete', { shape: 'round' as const }],
        ['bookend', archBookend, 'bookend', 'concrete', {}],
        ['bookend_pour_hole', archBookend, 'bookend', 'concrete', { hole: 'pour' as const }],
      ] as const) {
        const r = await siliconeChain(scene, [id], opts, mat);
        expect(r.ok, `${label}: ${r.ok ? '' : r.error}`).toBe(true);
        if (!r.ok) continue;

        const simMold = simulatedBody(
          { ...r.siliconeMold, cellMm: 0, toleranceMm: 0 },
          { modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [0, 0, 0], modelMaxMm: [50, 50, 50] },
          { id: `mold_${label}`, name: `Simulated: Silicone mold ${label}`, kind: 'mold', placement: 'beside' },
        );
        const integrity = meshIntegrity(simMold.geoms[0]);
        expect(integrity.watertight, `${label} mold integrity: ${JSON.stringify(integrity)}`).toBe(true);
        expect(integrity.nonManifoldEdges ?? 0, `${label} mold nonManifoldEdges`).toBe(0);
        expect(integrity.boundaryEdges ?? 0, `${label} mold boundaryEdges`).toBe(0);
        expect(integrity.degenerateTriangles ?? 0, `${label} mold degenerateTriangles`).toBe(0);

        const simCast = simulatedBody(
          { ...r.piece.mesh, cellMm: 0, toleranceMm: 0 },
          { modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [0, 0, 0], modelMaxMm: [50, 50, 50] },
          { id: `cast_${label}`, name: `Simulated: Concrete ${label}`, kind: 'cast', placement: 'beside' },
        );
        const castIntegrity = meshIntegrity(simCast.geoms[0]);
        expect(castIntegrity.watertight, `${label} cast integrity: ${JSON.stringify(castIntegrity)}`).toBe(true);
        expect(castIntegrity.nonManifoldEdges ?? 0, `${label} cast nonManifoldEdges`).toBe(0);
      }
    }, 60000);

    it('cleanManifoldMesh eliminates boolean slivers and guarantees zero non-manifold edges after float32-metre welding', async () => {
      const wasm = await loadManifold();
      const block = wasm.Manifold.cube([20, 20, 20], false);
      // Subtract a 16-gon vent cylinder rotated 11.25° near a wall (1.0 mm from x = 0)
      const vent = wasm.Manifold.cylinder(22, 1.0, 1.0, 16).rotate([0, 0, 11.25]).translate([1.0, 10, -1]);
      const sub = block.subtract(vent);
      const cleaned = cleanManifoldMesh(sub);
      block.delete();
      vent.delete();
      sub.delete();

      const metres = new Float32Array(cleaned.positions.length);
      for (let i = 0; i < cleaned.positions.length; i++) metres[i] = cleaned.positions[i] / 1000;
      const welded = weldByPosition(metres, cleaned.faces);
      const check = analyzeMesh(welded.positions, welded.faces);
      expect(check).not.toBeNull();
      expect(check!.closed).toBe(true);
      expect(check!.nonManifoldEdges).toBe(0);
      expect(check!.boundaryEdges).toBe(0);
      expect(check!.degenerateTriangles).toBe(0);
      expect(check!.consistentlyWound).toBe(true);
    });
  });

  describe('2. Simulated cast & silicone mold Z=0 placement and real material density', () => {
    it('places both simulated concrete cast and silicone mold cleanly on z=0 even when pour box base is at z=-6mm, and sets real densities', async () => {
      useStore.getState().updateScene(concretePot);
      // Add pour box to scene (its base sits at z = -6mm..0mm)
      await addPourBoxToScene(['planter'], { coverMm: 8, baseMm: 6 });
      const baseNode = useStore.getState().sceneGraph.nodes.find((n) => n.name.includes('pour_base'));
      expect(baseNode).toBeDefined();
      expect(baseNode!.pos[2]).toBeCloseTo(-0.006, 4);

      // sceneStockTransform should not inherit the pour base's -6 mm floor offset
      const st = sceneStockTransform();
      expect(st.modelMinMm[2]).toBeCloseTo(0, 3);

      const r = await siliconeChain(useStore.getState().sceneGraph, ['planter'], {}, 'concrete');
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;

      const added = await addSiliconeChain(r, ['planter']);
      const nodes = useStore.getState().sceneGraph.nodes;
      const castNode = nodes.find((n) => n.id === added.piece.id)!;
      const moldNode = nodes.find((n) => n.id === added.siliconeMold!.id)!;
      expect(castNode).toBeDefined();
      expect(moldNode).toBeDefined();

      // (a) Resting cleanly on z = 0, NOT inheriting pour base's -0.006 offset
      expect(castNode.pos[2]).toBeCloseTo(0, 5);
      expect(moldNode.pos[2]).toBeCloseTo(0, 5);

      // (b) Real material density set on geoms & emitted in MJCF XML (concrete 2400 kg/m³, platinum silicone 1080 kg/m³)
      const concreteDensity = Math.round(castMaterial('concrete').densityGcm3 * 1000);
      const platinumDensity = Math.round(castMaterial('platinum').densityGcm3 * 1000);
      expect(castNode.density).toBe(concreteDensity);
      expect(moldNode.density).toBe(platinumDensity);
      expect(castNode.geoms[0].density).toBe(concreteDensity);
      expect(moldNode.geoms[0].density).toBe(platinumDensity);

      const xml = compileToMJCF({ nodes: [castNode, moldNode] });
      expect(xml).toContain(`density="${concreteDensity}"`);
      expect(xml).toContain(`density="${platinumDensity}"`);
    }, 60000);
  });

  describe('3. Helpful cross-reference errors in EXPORT_CAST and SET_CAST_PREP', () => {
    it('guides users to physics_make_pour_box and silicone simulation when EXPORT_CAST rejects non-metals or method=silicone', async () => {
      useStore.getState().updateScene(concretePot);
      const ctx = { store: useStore.getState(), toId: (s: unknown) => String(s) } as never;

      for (const nonMetal of ['concrete', 'plaster', 'resin', 'jesmonite']) {
        const res = (await castCommands.EXPORT_CAST({ metal: nonMetal }, ctx)) as { ok: boolean; error?: string };
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/physics_make_pour_box/);
        expect(res.error).toMatch(/physics_add_simulation/);
        expect(res.error).toMatch(/silicone/);
      }

      const siliconeMethodRes = (await castCommands.EXPORT_CAST({ method: 'silicone' }, ctx)) as { ok: boolean; error?: string };
      expect(siliconeMethodRes.ok).toBe(false);
      expect(siliconeMethodRes.error).toMatch(/physics_make_pour_box/);
      expect(siliconeMethodRes.error).toMatch(/physics_add_simulation/);
    });

    it('explains that silicone molds flex over undercuts when SET_CAST_PREP rejects method=silicone', async () => {
      useStore.getState().updateScene(concretePot);
      const ctx = { store: useStore.getState(), toId: (s: unknown) => String(s) } as never;

      const res = (await castCommands.SET_CAST_PREP({ method: 'silicone' }, ctx)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/flex/i);
      expect(res.error).toMatch(/physics_make_pour_box/);
    });
  });
});
