import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { GarmentDraft } from '../src/types/cloth';
import type { SceneNode } from '../src/types/scene';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentPlan } from '../src/utils/cloth/garmentPlan';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clothModel } from '../src/utils/cloth/clothModel';
import {
  bodyFormLandmarksSummary,
  clothNodeSummary,
  collectClothNodes,
  exportClothPatternUnfold,
} from '../src/utils/cloth/clothSummary';
import { objectReply } from '../src/utils/objectReply';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { bodyFormNode } from '../src/utils/cloth/clothNodes';
import { useStore } from '../src/store/useStore';

const form = clampBodyForm({ figure: 'female' });
const L = bodyLandmarks(form);

function makeFormNode(id = 'form', name = 'form'): SceneNode {
  return {
    id,
    name,
    type: 'body',
    pos: [0, 0, 0],
    quat: [1, 0, 0, 0],
    geoms: [],
    bodyForm: form,
    children: [],
  };
}

function makeGarmentNode(draft: GarmentDraft, id = 'dress', name = 'dress'): SceneNode {
  return {
    id,
    name,
    type: 'body',
    pos: [0, 0, 0],
    quat: [1, 0, 0, 0],
    geoms: [],
    cloth: { garment: draft },
    children: [],
  };
}

describe('Asymmetric Garment Audit Fixes', () => {
  describe('1. seams[].on panel scoping and attached failure warnings', () => {
    it('scopes a torso seam plane with on: ["front", "back"] so sleeves are not sliced', () => {
      const draft: GarmentDraft = {
        garment: 'tshirt',
        fitTo: 'form',
        sleeve: 0.45,
        length: 0.35,
        seams: [
          {
            name: 'torso_waist',
            point: [0, 0, L.waistZ + 0.04],
            normal: [0, 0, 1],
            on: ['front', 'back'],
          },
        ],
      };
      const shell = garmentShell(draft, form);
      const seamEdges = shell.seams.filter((s) => s.name === 'torso_waist');
      expect(seamEdges.length).toBeGreaterThan(8);
      // Every vertex on the scoped torso_waist seam must belong to torso ('skin'), never arms.
      const sleeveParts = seamEdges
        .flatMap((s) => s.path)
        .map((i) => shell.part?.[i])
        .filter((p) => p === 'armL' || p === 'armR');
      expect(sleeveParts).toHaveLength(0);
      // Compare with unscoped seam: unscoped DOES slice sleeves, scoped does NOT.
      const unscoped = garmentShell({ ...draft, seams: [{ name: 'torso_waist', point: [0, 0, L.waistZ + 0.04], normal: [0, 0, 1] }] }, form);
      const unscopedSleeveParts = unscoped.seams
        .filter((s) => s.name === 'torso_waist')
        .flatMap((s) => s.path)
        .map((i) => unscoped.part?.[i])
        .filter((p) => p === 'armL' || p === 'armR');
      expect(unscopedSleeveParts.length).toBeGreaterThan(0);
    }, 120000);

    it('accepts a single string for seams[].on (e.g. on: "front")', () => {
      const draft: GarmentDraft = {
        garment: 'dress',
        fitTo: 'form',
        sleeve: 0,
        seams: [
          {
            name: 'front_empire',
            point: [0, 0, L.bustZ - 0.05],
            normal: [0, 0, 1],
            on: 'front',
          },
        ],
      };
      const shell = garmentShell(draft, form);
      const seamEdges = shell.seams.filter((s) => s.name === 'front_empire');
      expect(seamEdges.length).toBeGreaterThan(6);
      // All points on front_empire should lie on the front (-y) side of the garment.
      const seamYs = seamEdges.flatMap((s) => s.path.map((i) => shell.points[i][1]));
      expect(Math.max(...seamYs)).toBeLessThan(0.03);
    }, 120000);

    it('emits clear clothWarnings when an attached panel matches zero edges or has an invalid outline', () => {
      const formNode = makeFormNode();
      const draft: GarmentDraft = {
        garment: 'dress',
        fitTo: 'form',
        sleeve: 0,
        attached: [
          {
            name: 'missing_ruffle',
            along: 'nonexistent_seam',
            outline: [[0, 0], [0.2, 0], [0.2, 0.08], [0, 0.08]],
          },
          {
            name: 'bad_outline',
            along: 'hem',
            outline: [[0, 0], [0.1, 0]],
          },
        ],
      };
      const garmentNode = makeGarmentNode(draft);
      const model = clothModel(garmentNode, new THREE.Matrix4(), [formNode, garmentNode]);
      expect(model.warnings?.some((w) => w.includes('missing_ruffle') && w.includes('nonexistent_seam'))).toBe(true);
      expect(model.warnings?.some((w) => w.includes('bad_outline') && w.includes('fewer than 3'))).toBe(true);
    }, 120000);
  });

  describe('2. Native per-side sleeve authoring (sleeveL / sleeveR)', () => {
    it('supports single-sleeve garments with sleeveL > 0 and sleeveR: 0 without cuts hack', () => {
      const draft: GarmentDraft = {
        garment: 'dress',
        fitTo: 'form',
        sleeveL: 0.48,
        sleeveR: 0,
      };
      const plan = garmentPlan(draft, form);
      expect(plan.covers.some((c) => c.part === 'armL')).toBe(true);
      expect(plan.covers.some((c) => c.part === 'armR')).toBe(false);
      expect(plan.cuts.some((c) => c.kind === 'armhole' && c.limb === 'armR')).toBe(true);
      expect(plan.cuts.some((c) => c.kind === 'armhole' && c.limb === 'armL')).toBe(false);

      const shell = garmentShell(draft, form);
      const names = shell.panels.map((p) => p.name);
      expect(names.some((n) => n.startsWith('sleeveL'))).toBe(true);
      expect(names.some((n) => n.startsWith('sleeveR'))).toBe(false);
    }, 120000);

    it('falls back to sleeve when only one side overrides it', () => {
      const draft: GarmentDraft = {
        garment: 'tshirt',
        fitTo: 'form',
        sleeve: 0.25,
        sleeveR: 0,
      };
      const plan = garmentPlan(draft, form);
      expect(plan.covers.some((c) => c.part === 'armL')).toBe(true);
      expect(plan.covers.some((c) => c.part === 'armR')).toBe(false);
    });
  });

  describe('3. curves kind: "open" slit splitting and missed-curve diagnostics', () => {
    it('splits an internal open thigh slit into separate solver particles on a flared skirt', () => {
      const formNode = makeFormNode();
      const draft: GarmentDraft = {
        garment: 'skirt',
        fitTo: 'form',
        length: 0.65,
        flare: 1.6,
        curves: [
          {
            kind: 'open',
            name: 'thigh_slit',
            points: [
              [-0.08, -0.14, 0.78],
              [-0.11, -0.16, 0.60],
              [-0.14, -0.18, 0.40],
            ],
          },
        ],
      };
      const shell = garmentShell(draft, form);
      const slitSeams = shell.seams.filter((s) => s.name === 'thigh_slit');
      expect(slitSeams.length).toBeGreaterThan(5);
      expect(slitSeams.every((s) => s.open)).toBe(true);

      const garmentNode = makeGarmentNode(draft, 'skirt', 'skirt');
      const model = clothModel(garmentNode, new THREE.Matrix4(), [formNode, garmentNode]);
      // Internal open slit vertices must be duplicated into distinct particles so the slit actually opens!
      expect(model.x0.length / 3).toBeGreaterThan(shell.points.length);
      expect(model.warnings ?? []).toEqual([]);
    }, 120000);

    it('emits a clear clothWarnings entry when curve control points miss all garment panels', () => {
      const formNode = makeFormNode();
      const draft: GarmentDraft = {
        garment: 'skirt',
        fitTo: 'form',
        length: 0.35,
        curves: [
          {
            kind: 'open',
            name: 'off_garment_slit',
            points: [
              [0.8, -0.8, 0.1],
              [0.9, -0.8, 0.05],
            ],
          },
          {
            kind: 'open',
            name: 'too_short_curve',
            points: [[0, -0.15, 0.7]],
          },
        ],
      };
      const garmentNode = makeGarmentNode(draft, 'skirt', 'skirt');
      const model = clothModel(garmentNode, new THREE.Matrix4(), [formNode, garmentNode]);
      expect(model.warnings?.some((w) => w.includes('off_garment_slit') && w.includes('missed all garment panels'))).toBe(true);
      expect(model.warnings?.some((w) => w.includes('too_short_curve') && w.includes('at least 2'))).toBe(true);
    }, 120000);
  });

  describe('4. physics_export_cut(kind="unfold", sheet_mode="soft_goods") on cloth garments', () => {
    it('exports 2D garment pattern pieces as SVG with seam allowance', async () => {
      // A built form (its meshes made), as a scene holds one: an unbuilt form
      // hid that the export unfolded the mannequin rather than the dress.
      const formNode = bodyFormNode('form', 'form', { figure: 'female' });
      const draft: GarmentDraft = {
        garment: 'dress',
        fitTo: 'form',
        sleeveL: 0.35,
        sleeveR: 0,
      };
      const dressNode = makeGarmentNode(draft, 'asym_dress', 'asym_dress');
      const nodes = [formNode, dressNode];

      const clothNodes = collectClothNodes(nodes);
      expect(clothNodes).toHaveLength(1);

      const direct = exportClothPatternUnfold(clothNodes, nodes, undefined, { seamAllowanceMm: 12 });
      expect(direct.ok).toBe(true);
      if (direct.ok) {
        expect(direct.svg).toContain('<svg');
        expect(direct.svg).toContain('data-operation="cut"');
        expect(direct.svg).toContain('stitching line');
        expect(direct.pieceNames.some((n) => n.startsWith('sleeveL'))).toBe(true);
        expect(direct.pieceNames.some((n) => n.startsWith('sleeveR'))).toBe(false);
      }

      // Exercise the MCP EXPORT_CUT handler end-to-end.
      const prevGraph = useStore.getState().sceneGraph;
      try {
        useStore.setState({ sceneGraph: { ...prevGraph, nodes } });
        const reply = await cutCommands.EXPORT_CUT(
          {
            kind: 'unfold',
            sheetMode: 'soft_goods',
            masterId: 'asym_dress',
            seamAllowanceMm: 10,
          },
          { store: useStore.getState() },
        ) as Record<string, unknown>;
        expect(reply.ok).toBe(true);
        const summary = reply.summary as Record<string, unknown>;
        expect(summary.mode).toBe('soft_goods');
        expect(summary.pieces).toBeGreaterThanOrEqual(3);
        expect(summary.seamAllowanceMm).toBe(10);
        const files = reply.files as Array<{ name: string; bytes: number; contentBase64?: string }>;
        expect(files).toHaveLength(1);
        expect(files[0].name).toMatch(/\.svg$/);
        expect(files[0].bytes).toBeGreaterThan(200);
      } finally {
        useStore.setState({ sceneGraph: prevGraph });
      }
    }, 120000);
  });

  describe('5. physics_get_object on cloth and bodyForm bodies', () => {
    it('includes anatomical landmark Z-heights on bodyForm bodies', () => {
      const formNode = makeFormNode();
      const summary = bodyFormLandmarksSummary(form);
      expect(summary.landmarksMm.hpsZ).toBeGreaterThan(summary.landmarksMm.shoulderZ);
      expect(summary.landmarksMm.shoulderZ).toBeGreaterThan(summary.landmarksMm.bustZ);
      expect(summary.landmarksMm.bustZ).toBeGreaterThan(summary.landmarksMm.waistZ);
      expect(summary.landmarksMm.waistZ).toBeGreaterThan(summary.landmarksMm.hipZ);
      expect(summary.landmarksMm.hipZ).toBeGreaterThan(summary.landmarksMm.kneeZ);

      const reply = objectReply(formNode, { scene: [formNode] });
      expect(reply.landmarksMm).toEqual(summary.landmarksMm);
      expect(reply.landmarks).toEqual(summary.landmarks);
    });

    it('includes clothSummary on cloth bodies (both fallback and live flex mirror)', () => {
      const formNode = makeFormNode();
      const dressNode = makeGarmentNode(
        { garment: 'dress', fitTo: 'form', sleeveL: 0.3, sleeveR: 0 },
        'asym_dress',
        'asym_dress',
      );
      const reply = objectReply(dressNode, { scene: [formNode, dressNode] });
      const cs = reply.clothSummary as ReturnType<typeof clothNodeSummary>;
      expect(cs).toBeTruthy();
      expect(cs!.pieceCount).toBeGreaterThanOrEqual(3);
      expect(cs!.pieces.some((p) => p.startsWith('sleeveL'))).toBe(true);
      expect(cs!.vertCount).toBeGreaterThan(50);
      expect(cs!.triCount).toBeGreaterThan(50);
      expect(cs!.bboxMm).toBeTruthy();
      expect(cs!.bboxMm!.size[2]).toBeGreaterThan(400);
    }, 120000);
  });
});
