import { describe, it, expect } from 'vitest';
import {
  PCB_PRESETS,
  buildPcbNode,
  encodePcbHandoff,
  decodePcbHandoff,
  generatePcbEnclosure,
  applyPcbToEnclosureBody,
  exportPcbFaceplateSvg,
  buildPcbFaceplateEtchUrl,
  type PcbMechanicalSpec,
} from '../src/utils/pcbEnclosureSync';
import { boxGeom } from '../src/utils/hardwareGeometry';

describe('Volt <-> Mesh PCB & Enclosure Co-Design Sync', () => {
  describe('1. PCB_PRESETS & buildPcbNode', () => {
    const presetKeys = [
      'arduino_uno',
      'raspberry_pi_hat',
      'eurorack_3u_10hp',
      'guitar_pedal_1590b',
      'proto_50x50',
    ];

    it('contains all 5 required built-in presets', () => {
      for (const key of presetKeys) {
        expect(PCB_PRESETS[key]).toBeDefined();
        expect(PCB_PRESETS[key].widthMm).toBeGreaterThan(0);
        expect(PCB_PRESETS[key].depthMm).toBeGreaterThan(0);
        expect(PCB_PRESETS[key].mountingHoles.length).toBeGreaterThanOrEqual(4);
        expect(PCB_PRESETS[key].components.length).toBeGreaterThan(0);
      }
    });

    it.each(presetKeys)('builds a valid 3D SceneNode for preset %s', (key) => {
      const spec = PCB_PRESETS[key];
      const node = buildPcbNode(spec, { id: `test_${key}`, pos: [0.01, 0.02, 0.03] });

      expect(node.id).toBe(`test_${key}`);
      expect(node.name).toBe(spec.name);
      expect(node.pos).toEqual([0.01, 0.02, 0.03]);
      expect(node.width).toBeCloseTo(spec.widthMm / 1000, 6);
      expect(node.depth).toBeCloseTo(spec.depthMm / 1000, 6);
      expect(node.height).toBeCloseTo(spec.thicknessMm / 1000, 6);

      // Substrate geom + copper mounting pad rings + component geoms
      expect(node.geoms.length).toBeGreaterThanOrEqual(
        1 + spec.mountingHoles.length + spec.components.length,
      );

      const substrate = node.geoms[0];
      expect(substrate.type).toBe('box');
      expect(substrate.size[0]).toBeCloseTo(spec.widthMm / 2000, 6);
      expect(substrate.size[1]).toBeCloseTo(spec.depthMm / 2000, 6);
      expect(substrate.size[2]).toBeCloseTo(spec.thicknessMm / 2000, 6);
      expect(substrate.mass).toBeGreaterThan(0);

      const totalMass = node.geoms.reduce((sum, g) => sum + (g.mass ?? 0), 0);
      expect(totalMass).toBeGreaterThan(substrate.mass!);

      // Verify copper mounting rings exist as visual mesh geoms
      const padRings = node.geoms.filter((g) => g.name.includes('_pad_'));
      expect(padRings.length).toBe(spec.mountingHoles.length);
      for (const ring of padRings) {
        expect(ring.role).toBe('visual');
        expect(ring.type).toBe('mesh');
      }

      // Verify every component produced at least one geom positioned above/below board surface
      for (const comp of spec.components) {
        const compGeoms = node.geoms.filter((g) => g.name.includes(`_comp_${comp.id}`));
        expect(compGeoms.length).toBeGreaterThanOrEqual(1);
        const primary = compGeoms[0];
        expect(primary.pos?.[2]).toBeGreaterThan(spec.thicknessMm / 2000);
      }
    });
  });

  describe('2. encodePcbHandoff & decodePcbHandoff', () => {
    it('round-trips a PcbMechanicalSpec losslessly via URL fragment, full URL, and JSON', () => {
      const original = PCB_PRESETS.guitar_pedal_1590b;

      const fragment = encodePcbHandoff(original, { format: 'fragment' });
      expect(fragment.startsWith('#v=1&pcb=')).toBe(true);
      const fromFragment = decodePcbHandoff(fragment);
      expect(fromFragment).toEqual(original);

      const fullUrl = encodePcbHandoff(original, {
        format: 'url',
        baseUrl: 'https://mesh.physbox.io/',
      });
      expect(fullUrl.startsWith('https://mesh.physbox.io/#v=1&pcb=')).toBe(true);
      const fromUrl = decodePcbHandoff(fullUrl);
      expect(fromUrl).toEqual(original);

      const jsonStr = encodePcbHandoff(original, { format: 'json' });
      const fromJson = decodePcbHandoff(jsonStr);
      expect(fromJson).toEqual(original);
    });
  });

  describe('3. generatePcbEnclosure & applyPcbToEnclosureBody', () => {
    it('generates a CSG-enabled baseNode, lidNode, and pcbNode with standoffs, cutouts, and passing clearanceReport for all presets', () => {
      for (const [key, spec] of Object.entries(PCB_PRESETS)) {
        const result = generatePcbEnclosure(spec, {
          boardClearanceMm: 2.0,
          standoffHeightMm: 5.0,
          wallThicknessMm: 2.5,
          topClearanceMm: 3.0,
          includeLid: true,
          boreType: 'insert',
        });

        expect(result.baseNode.csgEnabled).toBe(true);
        expect(result.lidNode).toBeDefined();
        expect(result.lidNode!.csgEnabled).toBe(true);
        expect(result.pcbNode.geoms.length).toBeGreaterThan(spec.components.length);

        // Verify outer shell + subtracted inner cavity
        const outerShell = result.baseNode.geoms.find((g) => g.name.endsWith('_outer_shell'));
        const innerCavity = result.baseNode.geoms.find((g) => g.name.endsWith('_inner_cavity'));
        expect(outerShell).toBeDefined();
        expect(innerCavity).toBeDefined();
        expect(innerCavity!.csg).toBe('difference');

        // Verify mounting standoff bosses and bores match every mounting hole
        const bosses = result.baseNode.geoms.filter(
          (g) => g.hardware?.kind === 'insert_boss' && g.hardware.part === 'boss',
        );
        const bores = result.baseNode.geoms.filter(
          (g) => g.hardware?.kind === 'insert_boss' && g.hardware.part === 'bore',
        );
        expect(bosses.length).toBe(spec.mountingHoles.length);
        expect(bores.length).toBe(spec.mountingHoles.length);
        for (const boss of bosses) {
          expect(boss.csg).toBe('union');
          expect(boss.cutDepth).toBeCloseTo(0.005, 6);
        }
        for (const bore of bores) {
          expect(bore.csg).toBe('difference');
        }

        // Verify difference cutouts match every panelMount component on walls/lid
        const panelComponents = spec.components.filter((c) => c.panelMount);
        expect(result.cutouts.length).toBe(panelComponents.length);

        const wallPanelComponents = panelComponents.filter((c) => c.panelMount!.face !== 'top');
        const topPanelComponents = panelComponents.filter((c) => c.panelMount!.face === 'top');

        const baseCutouts = result.baseNode.geoms.filter((g) => g.name.includes('_cutout_'));
        const lidCutouts = result.lidNode!.geoms.filter((g) => g.name.includes('_cutout_'));
        expect(baseCutouts.length).toBe(wallPanelComponents.length);
        expect(lidCutouts.length).toBe(topPanelComponents.length);

        for (const cut of [...baseCutouts, ...lidCutouts]) {
          expect(cut.csg).toBe('difference');
        }

        // Verify clearance report passes for all built-in presets
        expect(
          result.clearanceReport.ok,
          `Preset ${key} failed clearance check: ${JSON.stringify(result.clearanceReport.issues)}`,
        ).toBe(true);
        expect(result.clearanceReport.issues).toHaveLength(0);
      }
    });

    it('detects boss keep-out and wall collision issues when a component is mispositioned', () => {
      const badSpec: PcbMechanicalSpec = {
        ...PCB_PRESETS.proto_50x50,
        components: [
          ...PCB_PRESETS.proto_50x50.components,
          // Collides with top-left mounting hole at (-21, 21) and extends past left wall
          {
            id: 'bad_cap',
            ref: 'C99',
            kind: 'capacitor',
            xMm: -24.0,
            yMm: 21.0,
            widthMm: 10.0,
            depthMm: 10.0,
            heightMm: 8.0,
          },
        ],
      };

      const { clearanceReport } = generatePcbEnclosure(badSpec);
      expect(clearanceReport.ok).toBe(false);
      expect(clearanceReport.issues.some((i) => i.code === 'boss_keepout')).toBe(true);
      expect(clearanceReport.issues.some((i) => i.code === 'wall_collision')).toBe(true);
    });

    it('applies PCB standoffs and panel cutouts to an existing enclosure SceneNode', () => {
      const hostNode = {
        id: 'custom_box',
        name: 'Custom Box',
        type: 'body' as const,
        pos: [0, 0, 0.02],
        joints: [],
        geoms: [boxGeom('custom_box_body', [0.035, 0.035, 0.015], [0, 0, 0], [0.5, 0.5, 0.5, 1])],
        children: [],
      };
      const spec = PCB_PRESETS.proto_50x50;
      const updated = applyPcbToEnclosureBody(hostNode, spec);

      expect(updated.csgEnabled).toBe(true);
      const bosses = updated.geoms.filter(
        (g) => g.hardware?.kind === 'insert_boss' && g.hardware.part === 'boss',
      );
      expect(bosses.length).toBe(spec.mountingHoles.length);
      const cutouts = updated.geoms.filter((g) => g.name.includes('_cutout_'));
      expect(cutouts.length).toBe(spec.components.filter((c) => c.panelMount).length);
    });
  });

  describe('4. exportPcbFaceplateSvg & Etch Handoff', () => {
    it('exports a valid 1:1 SVG with circular, rectangular, and D-shaft cutouts, dial ticks, labels, and Etch URL', async () => {
      const eurorack = PCB_PRESETS.eurorack_3u_10hp;
      const topPanel = exportPcbFaceplateSvg(eurorack, 'top', {
        marginMm: 2.0,
        includeLabels: true,
        includeDialTicks: true,
        includeBoardOutline: true,
      });

      expect(topPanel.widthMm).toBeCloseTo(eurorack.widthMm + 4.0, 3);
      expect(topPanel.heightMm).toBeCloseTo(eurorack.depthMm + 4.0, 3);
      expect(topPanel.cutoutCount).toBe(
        eurorack.mountingHoles.length +
          eurorack.components.filter((c) => c.panelMount?.face === 'top').length,
      );

      expect(topPanel.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(topPanel.svg).toContain(`width="${topPanel.widthMm}mm"`);
      expect(topPanel.svg).toContain(`height="${topPanel.heightMm}mm"`);
      // D-shaft path for potentiometers
      expect(topPanel.svg).toContain('data-cutout-shape="d_shaft"');
      // Circular cutouts for 3.5mm jacks / toggle switch / LEDs
      expect(topPanel.svg).toContain('data-cutout-shape="circle"');
      // Potentiometer dial tick marks
      expect(topPanel.svg).toContain('data-feature="dial-tick"');
      // Component labels
      expect(topPanel.svg).toContain('>FREQ</text>');
      expect(topPanel.svg).toContain('>RES</text>');
      expect(topPanel.svg).toContain('>OUT</text>');

      // Rectangular OLED display cutout on proto_50x50
      const protoPanel = exportPcbFaceplateSvg(PCB_PRESETS.proto_50x50, 'top');
      expect(protoPanel.svg).toContain('data-cutout-shape="rect"');
      expect(protoPanel.svg).toContain('>OLED</text>');

      // Rounded-rect USB-C cutout on front panel of proto_50x50
      const frontPanel = exportPcbFaceplateSvg(PCB_PRESETS.proto_50x50, 'front');
      expect(frontPanel.svg).toContain('data-cutout-shape="rounded_rect"');
      expect(frontPanel.svg).toContain('>USB-C</text>');

      // Valid synchronous and async Etch handoff URLs
      expect(topPanel.etchUrl).toBeDefined();
      expect(topPanel.etchUrl!).toContain('#v=1&');
      expect(topPanel.etchUrl!).toContain('data=');

      const asyncEtchUrl = await buildPcbFaceplateEtchUrl(eurorack, 'top', { thicknessMm: 2.0 });
      expect(asyncEtchUrl).toContain('#v=1&');
      expect(asyncEtchUrl).toContain('data=');
      expect(asyncEtchUrl).toContain('thickness=2');
    });
  });
});
