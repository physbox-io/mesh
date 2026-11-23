// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSTL,
  computeBoundingBox,
  MAX_STL_TRIANGLES,
} from '../src/utils/stlParser';
import {
  sliceLoops,
  buildRegions,
  regionsMatch,
  uniformOffset,
  reconstructPrismatic,
  type Region,
} from '../src/utils/stlFeatures';
import { svgProfile } from '../src/utils/profileImport';
import { isImageFile, decodeImageUrl } from '../src/utils/decodeImage';
import {
  cappedGridDimensions,
  imageToHeightmapMesh,
  DEFAULT_HEIGHTMAP_OPTIONS,
  MAX_HEIGHTMAP_CELLS,
} from '../src/utils/heightmapMesh';
import {
  validatePcbSpec,
  decodePcbHandoff,
  encodePcbHandoff,
  generatePcbEnclosure,
  applyPcbToEnclosureBody,
  PCB_PRESETS,
  type PcbMechanicalSpec,
} from '../src/utils/pcbEnclosureSync';
import { boxGeom } from '../src/utils/hardwareGeometry';
import {
  stepsFor,
  validateStepForPayload,
  MAX_COSIM_DT_MS,
} from '../src/utils/coSimLink';
import { useCavityStore, clearCavities } from '../src/store/cavityStore';
import { useStore } from '../src/store/useStore';
import { usePanels } from '../src/store/panelsStore';
import { usePcbHandoffLink } from '../src/hooks/usePcbHandoffLink';
import { ImportPcbModal } from '../src/components/ImportPcbModal';
import { ImportProfileModal, shapesPath } from '../src/components/ImportProfileModal';

type Tri = [number[], number[], number[]];

function writeBinarySTL(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let i = 0; i < 3; i++) view.setFloat32(off + i * 4, 0, true);
    off += 12;
    for (const v of [a, b, c]) {
      for (let i = 0; i < 3; i++) view.setFloat32(off + i * 4, v[i], true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

function quad(a: number[], b: number[], c: number[], d: number[]): Tri[] {
  return [[a, b, c], [a, c, d]];
}

function boxTris(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Tri[] {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const p = (x: number, y: number, z: number) => [x, y, z];
  return [
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...quad(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)),
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)),
    ...quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...quad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)),
  ];
}

function rectLoop(cx: number, cy: number, w: number, h: number): [number, number][] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

// ---------------------------------------------------------------------------
// #1, #15, #62: pcbEnclosureSync validation, wall cutout depth, standoffs
// ---------------------------------------------------------------------------

describe('Section 7 Audit — PCB Enclosure Sync (#1, #15, #62)', () => {
  it('#1 rejects null entries, non-finite numbers, and invalid panelMount in validatePcbSpec', () => {
    expect(() => validatePcbSpec(null)).toThrow();
    expect(() => validatePcbSpec([])).toThrow();
    expect(() =>
      validatePcbSpec({
        name: 'Bad',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [null],
        components: [],
      }),
    ).toThrow(/mountingHoles\[0\]/);

    expect(() =>
      validatePcbSpec({
        name: 'Bad',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [null],
      }),
    ).toThrow(/components\[0\]/);

    expect(() =>
      validatePcbSpec({
        name: 'Inf',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [{ id: 'h1', xMm: Infinity, yMm: 0, drillMm: 3 }],
        components: [],
      }),
    ).toThrow(/finite/);

    expect(() =>
      validatePcbSpec({
        name: 'BadFace',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [
          {
            id: 'c1',
            ref: 'J1',
            kind: 'usb_c',
            xMm: 0,
            yMm: 0,
            widthMm: 8,
            depthMm: 6,
            heightMm: 3,
            panelMount: { face: 'bottom', cutoutShape: 'rect' },
          },
        ],
      }),
    ).toThrow(/face/);

    expect(() =>
      validatePcbSpec({
        name: 'UpperFace',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [
          {
            id: 'c1',
            ref: 'J1',
            kind: 'usb_c',
            xMm: 0,
            yMm: 0,
            widthMm: 8,
            depthMm: 6,
            heightMm: 3,
            panelMount: { face: 'TOP', cutoutShape: 'circle' },
          },
        ],
      }),
    ).toThrow(/face/);

    expect(() =>
      validatePcbSpec({
        name: 'BoolPM',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [
          {
            id: 'c1',
            ref: 'J1',
            kind: 'usb_c',
            xMm: 0,
            yMm: 0,
            widthMm: 8,
            depthMm: 6,
            heightMm: 3,
            panelMount: true,
          },
        ],
      }),
    ).toThrow(/panelMount/);

    expect(() =>
      validatePcbSpec({
        name: 'BadShape',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [
          {
            id: 'c1',
            ref: 'J1',
            kind: 'usb_c',
            xMm: 0,
            yMm: 0,
            widthMm: 8,
            depthMm: 6,
            heightMm: 3,
            panelMount: { face: 'front', cutoutShape: 'hexagon', diameterMm: 5 },
          },
        ],
      }),
    ).toThrow(/cutoutShape/);

    expect(() =>
      decodePcbHandoff(JSON.stringify({
        name: 'NaNDim',
        widthMm: 50,
        depthMm: 50,
        mountingHoles: [],
        components: [
          {
            id: 'c1',
            ref: 'J1',
            kind: 'usb_c',
            xMm: 0,
            yMm: 0,
            widthMm: 8,
            depthMm: 6,
            heightMm: 3,
            panelMount: { face: 'front', cutoutShape: 'circle', diameterMm: -2 },
          },
        ],
      })),
    ).toThrow(/positive/);
  });

  it('#15 sets finite wall cutDepth (not 0), skips top cutouts when !includeLid, and respects standoffHeightMm + bottom side in applyPcbToEnclosureBody', () => {
    const wallThicknessMm = 2.5;
    const { baseNode, lidNode } = generatePcbEnclosure(PCB_PRESETS.proto_50x50, {
      wallThicknessMm,
      includeLid: true,
    });
    const baseCutouts = baseNode.geoms.filter((g) => g.name.includes('_cutout_'));
    const lidCutouts = lidNode!.geoms.filter((g) => g.name.includes('_cutout_'));
    expect(baseCutouts.length).toBeGreaterThan(0);
    expect(lidCutouts.length).toBeGreaterThan(0);
    for (const c of [...baseCutouts, ...lidCutouts]) {
      expect(c.cutDepth).toBeCloseTo((wallThicknessMm + 1.5) / 1000, 6);
    }

    // Open-top enclosure: no top-face cutouts should land on baseNode.
    const open = generatePcbEnclosure(PCB_PRESETS.proto_50x50, { includeLid: false });
    expect(open.lidNode).toBeUndefined();
    const topCompIds = new Set(
      PCB_PRESETS.proto_50x50.components
        .filter((c) => c.panelMount?.face === 'top')
        .map((c) => c.id),
    );
    const openBaseCutouts = open.baseNode.geoms.filter((g) => g.name.includes('_cutout_'));
    for (const cut of openBaseCutouts) {
      for (const topId of topCompIds) {
        expect(cut.name).not.toContain(`_cutout_${topId}`);
      }
    }

    // applyPcbToEnclosureBody: honours custom standoffHeightMm and bottom-side components
    const hostNode = {
      id: 'host_box',
      name: 'Host Box',
      type: 'body' as const,
      pos: [0, 0, 0.02],
      joints: [],
      geoms: [boxGeom('host_box_body', [0.04, 0.04, 0.02], [0, 0, 0], [0.5, 0.5, 0.5, 1])],
      children: [],
    };
    const spec: PcbMechanicalSpec = {
      name: 'Dual Side Board',
      widthMm: 40,
      depthMm: 40,
      thicknessMm: 1.6,
      mountingHoles: [{ id: 'mh1', xMm: -15, yMm: -15, drillMm: 3.2, fastener: 'M3' }],
      components: [
        {
          id: 'top_jack',
          ref: 'J1',
          kind: 'usb_c',
          side: 'top',
          xMm: 0,
          yMm: -18,
          widthMm: 9,
          depthMm: 7,
          heightMm: 4,
          panelMount: { face: 'front', cutoutShape: 'rect', widthMm: 9, heightMm: 4 },
        },
        {
          id: 'bot_jack',
          ref: 'J2',
          kind: 'usb_c',
          side: 'bottom',
          xMm: 10,
          yMm: -18,
          widthMm: 9,
          depthMm: 7,
          heightMm: 4,
          panelMount: { face: 'front', cutoutShape: 'rect', widthMm: 9, heightMm: 4 },
        },
      ],
    };

    const updated = applyPcbToEnclosureBody(hostNode, spec, {
      standoffHeightMm: 12,
      wallThicknessMm: 2.5,
    });
    const boss = updated.geoms.find((g) => g.hardware?.part === 'boss')!;
    const topCut = updated.geoms.find((g) => g.name.includes('_cutout_top_jack'))!;
    const botCut = updated.geoms.find((g) => g.name.includes('_cutout_bot_jack'))!;
    expect(boss.cutDepth).toBeCloseTo(0.012, 6);
    expect(botCut.cutAt![2]).toBeLessThan(topCut.cutAt![2]);
    // Distance between top & bottom component centres should be board thickness (1.6) + 2*(4/2) = 5.6 mm.
    expect(topCut.cutAt![2] - botCut.cutAt![2]).toBeCloseTo(0.0056, 5);
  });

  it('#62 clamps boreDepthMm so thin standoffs never get negative or through-floor bores', () => {
    for (const standoffHeightMm of [0.3, 0.5, 1.0, 2.0]) {
      const { baseNode } = generatePcbEnclosure(PCB_PRESETS.proto_50x50, { standoffHeightMm });
      const bores = baseNode.geoms.filter(
        (g) => g.hardware?.kind === 'insert_boss' && g.hardware.part === 'bore',
      );
      expect(bores.length).toBeGreaterThan(0);
      for (const b of bores) {
        expect(b.cutDepth!).toBeGreaterThan(0);
        expect(b.cutDepth!).toBeLessThan(standoffHeightMm / 1000);
        expect(b.size[1]).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// #3: heightmapMesh cell cap
// ---------------------------------------------------------------------------

describe('Section 7 Audit — Heightmap Grid Cap (#3)', () => {
  it('caps total cells to <= 160,000 for extreme banner aspect ratios', () => {
    const banner = cappedGridDimensions(10, 1400, 400);
    expect(banner.cols * banner.rows).toBeLessThanOrEqual(MAX_HEIGHTMAP_CELLS);
    expect(banner.cols).toBeGreaterThanOrEqual(2);
    expect(banner.rows).toBeGreaterThanOrEqual(2);

    const extreme = cappedGridDimensions(1, 100_000, 400);
    expect(extreme.cols * extreme.rows).toBeLessThanOrEqual(MAX_HEIGHTMAP_CELLS);
    expect(extreme.cols).toBeGreaterThanOrEqual(2);
    expect(extreme.rows).toBeGreaterThanOrEqual(2);

    // Tall 10x1400 banner builds cleanly without OOM
    const px = new Uint8ClampedArray(10 * 1400 * 4).fill(180);
    const mesh = imageToHeightmapMesh(px, 10, 1400, {
      ...DEFAULT_HEIGHTMAP_OPTIONS,
      gridCols: 400,
      smoothPasses: 0,
    });
    expect(mesh.cols * mesh.rows).toBeLessThanOrEqual(MAX_HEIGHTMAP_CELLS);
    expect(mesh.triangleCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #4, #14, #39: stlParser hardening, linear array fixes, per-hole diameters
// ---------------------------------------------------------------------------

describe('Section 7 Audit — STL Parser (#4, #14, #39)', () => {
  it('#4 rejects < 84 byte binary, truncated binary, and corrupt huge-header STLs upfront', () => {
    expect(() => parseSTL(new ArrayBuffer(20))).toThrow(/84 bytes|truncated|Invalid/i);

    // Truncated binary: claims 100 triangles (5084 B) in a 134 B buffer
    const truncated = new ArrayBuffer(134);
    new DataView(truncated).setUint32(80, 100, true);
    expect(() => parseSTL(truncated)).toThrow(/Truncated binary STL/i);

    // Corrupt header claiming way above MAX_STL_TRIANGLES
    const huge = new ArrayBuffer(200);
    new DataView(huge).setUint32(80, MAX_STL_TRIANGLES + 500, true);
    expect(() => parseSTL(huge)).toThrow(/maximum supported limit/i);

    // Empty ASCII STL < 84 bytes throws "no triangles" instead of RangeError
    const emptyAscii = new TextEncoder().encode('solid empty\nendsolid empty\n').buffer;
    expect(() => parseSTL(emptyAscii)).toThrow(/no triangles/i);
  });

  it('#4 accepts ArrayLike Float32Array in computeBoundingBox, skips NaN/Infinity vertices, and drops degenerate welded triangles', () => {
    const f32 = new Float32Array([0, 0, 0, NaN, 1, 2, Infinity, 0, 0, 1, 2, 3]);
    const bb = computeBoundingBox(f32);
    expect(bb.min).toEqual([0, 0, 0]);
    expect(bb.max).toEqual([1, 2, 3]);

    // Mix valid box + NaN triangle + Infinity triangle + sub-micron degenerate sliver
    const validBox = boxTris(0.5, 0.5, 0.5, 0.04, 0.04, 0.04);
    const badTris: Tri[] = [
      [[NaN, 0, 0], [0.01, 0, 0], [0, 0.01, 0]],
      [[Infinity, 0, 0], [0.01, 0, 0], [0, 0.01, 0]],
      [[0.5, 0.5, 0.5], [0.5 + 1e-8, 0.5, 0.5], [0.5, 0.52, 0.5]], // welds two vertices together
    ];
    const r = parseSTL(writeBinarySTL([...validBox, ...badTris]), { recentre: true });
    expect(r.faces.length / 3).toBe(12);
    expect(r.boundingBox.size.every(Number.isFinite)).toBe(true);
    expect(r.boundingBox.size[0]).toBeCloseTo(0.04, 5);
    for (let i = 0; i < r.faces.length; i += 3) {
      const a = r.faces[i], b = r.faces[i + 1], c = r.faces[i + 2];
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(c).not.toBe(a);
    }
  });

  it('#14 picks the minimum-centroid island in unsorted linear arrays and does not double-translate perpendicular axes', () => {
    // Deliberately unsorted along Y (0.20, 0.10, 0.15) with non-zero X=0.08 and Z=0.06
    const tris = [0.20, 0.10, 0.15].flatMap((y) => boxTris(0.08, y, 0.06, 0.02, 0.02, 0.02));
    const r = parseSTL(writeBinarySTL(tris), { name: 'unsorted_array' });
    expect(r.inferredSpacing).toBeDefined();
    expect(r.inferredSpacing!.axis).toBe('y');
    expect(r.inferredSpacing!.count).toBe(3);

    // module element() must sit at min-Y (0.10), NOT 0.20
    expect(r.scadCsg).toContain('translate([0.08, 0.1, 0.06])');
    // For-loop must ONLY translate along Y (no second [0.08, ..., 0.06] translation!)
    expect(r.scadCsg).toContain('translate([0, i * spacing, 0]) element();');
    expect(r.scadCsg).not.toContain('translate([0.08, i * spacing, 0.06])');
  });

  it('#39 supports mixed hole diameters, floors flat 2D primitiveGeom.size >= 1e-4, and sanitizes partName newlines', () => {
    // Flat 2D triangle in XY plane (z = 0 everywhere) + newline injection in name
    const flat: Tri[] = [[[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]]];
    const rFlat = parseSTL(writeBinarySTL(flat), { name: 'bad\ncube(1);{x' });
    expect(rFlat.primitiveGeom.size.every((s) => s >= 1e-4)).toBe(true);
    const firstLine = rFlat.scadCsg.split('\n')[0];
    expect(firstLine).not.toContain('\n');
    expect(rFlat.scadCsg).not.toContain('\ncube(1);');

    // Plate with two circular through-holes of DIFFERENT radii (r=0.004 and r=0.008)
    const makeRingCap = (cx: number, cy: number, r: number, z: number, segs: number, top: boolean): Tri[] => {
      // Build a small local square patch around the hole with a circular hole punched through
      const half = 0.02;
      const angles = new Set<number>();
      for (let i = 0; i < segs; i++) angles.add((i / segs) * Math.PI * 2);
      for (const [dx, dy] of [[half, half], [-half, half], [-half, -half], [half, -half]]) {
        const t = Math.atan2(dy, dx);
        angles.add(t < 0 ? t + Math.PI * 2 : t);
      }
      const sorted = [...angles].sort((a, b) => a - b);
      const outer = sorted.map((t) => {
        const c = Math.cos(t), s = Math.sin(t);
        const d = Math.min(
          c > 1e-12 ? half / c : Infinity,
          c < -1e-12 ? -half / c : Infinity,
          s > 1e-12 ? half / s : Infinity,
          s < -1e-12 ? -half / s : Infinity,
        );
        return [cx + d * c, cy + d * s, z];
      });
      const rim = sorted.map((t) => [cx + r * Math.cos(t), cy + r * Math.sin(t), z]);
      const tris: Tri[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const j = (i + 1) % sorted.length;
        if (top) tris.push(...quad(rim[i], outer[i], outer[j], rim[j]));
        else tris.push(...quad(rim[i], rim[j], outer[j], outer[i]));
      }
      return tris;
    };
    const makeHoleWall = (cx: number, cy: number, r: number, h: number, segs: number): Tri[] => {
      const tris: Tri[] = [];
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0), -h];
        const p1 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0), h];
        const p2 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1), h];
        const p3 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1), -h];
        tris.push(...quad(p0, p1, p2, p3));
      }
      return tris;
    };
    // Two adjacent 0.04x0.04 patches sharing x=0 -> single welded 0.08x0.04x0.01 box with two different holes
    const h = 0.005;
    const twoHolePlate: Tri[] = [
      ...makeRingCap(-0.02, 0, 0.004, h, 32, true),
      ...makeRingCap(-0.02, 0, 0.004, -h, 32, false),
      ...makeHoleWall(-0.02, 0, 0.004, h, 32),
      ...makeRingCap(0.02, 0, 0.008, h, 32, true),
      ...makeRingCap(0.02, 0, 0.008, -h, 32, false),
      ...makeHoleWall(0.02, 0, 0.008, h, 32),
      // Outer perimeter walls of the 0.08 x 0.04 x 0.01 plate
      ...quad([-0.04, -0.02, -h], [0.04, -0.02, -h], [0.04, -0.02, h], [-0.04, -0.02, h]),
      ...quad([0.04, -0.02, -h], [0.04, 0.02, -h], [0.04, 0.02, h], [0.04, -0.02, h]),
      ...quad([0.04, 0.02, -h], [-0.04, 0.02, -h], [-0.04, 0.02, h], [0.04, 0.02, h]),
      ...quad([-0.04, 0.02, -h], [-0.04, -0.02, -h], [-0.04, -0.02, h], [-0.04, 0.02, h]),
    ];
    const rHoles = parseSTL(writeBinarySTL(twoHolePlate), { name: 'dual_holes' });
    expect(rHoles.subComponents[0].holes).toHaveLength(2);
    expect(rHoles.scadCsg).toContain('hole_1_d = 0.008;');
    expect(rHoles.scadCsg).toContain('hole_2_d = 0.016;');
    expect(rHoles.scadCsg).toContain('d = hole_1_d');
    expect(rHoles.scadCsg).toContain('d = hole_2_d');
  });
});

// ---------------------------------------------------------------------------
// #17 & #61: profileImport SVG fixes
// ---------------------------------------------------------------------------

describe('Section 7 Audit — SVG Profile Importer (#17, #61)', () => {
  it('#17 handles dual xlink:href + href on <use> without duplicate attribute XML errors', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20mm" height="20mm" viewBox="0 0 20 20">
      <defs><rect id="r" width="20" height="20"/></defs>
      <use xlink:href="#r" href="#r"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.widthMm).toBeCloseTo(20, 3);
  });

  it('#61 accepts namespace-prefixed <svg:svg> roots', () => {
    const svg = `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="30mm" height="15mm" viewBox="0 0 30 15">
      <svg:rect width="30" height="15"/>
    </svg:svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.widthMm).toBeCloseTo(30, 3);
    expect(p.heightMm).toBeCloseTo(15, 3);
  });

  it('#17 filters shapes hidden via CSS <style> rules (visibility: hidden/collapse, opacity: 0)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <style>
        .hid { visibility: hidden; }
        .col { visibility: collapse; }
        .zero { opacity: 0; }
      </style>
      <rect width="20" height="20" fill="black"/>
      <rect x="100" width="50" height="50" class="hid" fill="black"/>
      <rect x="200" width="50" height="50" class="col" fill="black"/>
      <rect x="300" width="50" height="50" class="zero" fill="black"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.widthMm).toBeCloseTo(20, 3);
  });

  it('#17 preserves smooth curves in tiny viewBox="0 0 1 1" SVGs scaled up via widthMm', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">
      <circle cx="0.5" cy="0.5" r="0.4" fill="black"/>
    </svg>`;
    const p = svgProfile(svg, { widthMm: 100 });
    expect(p.widthMm).toBeCloseTo(100, 2);
    // Pre-scale dropCollinear used to collapse this circle down to < 8 points;
    // post-scale 0.005mm tolerance preserves the curved outline.
    expect(p.shapes[0].outline.length).toBeGreaterThanOrEqual(24);
  });
});

// ---------------------------------------------------------------------------
// #18: coSimLink & cavityStore
// ---------------------------------------------------------------------------

describe('Section 7 Audit — Co-Sim Link & Cavity Store (#18)', () => {
  it('guards stepsFor against non-finite and non-positive inputs', () => {
    expect(stepsFor(Infinity, 0.002)).toBe(0);
    expect(stepsFor(NaN, 0.002)).toBe(0);
    expect(stepsFor(-5, 0.002)).toBe(0);
    expect(stepsFor(5, 0)).toBe(0);
    expect(stepsFor(5, NaN)).toBe(0);
    expect(stepsFor(5, Infinity)).toBe(0);
    expect(stepsFor(5, 0.002)).toBe(3);
  });

  it('validates STEP_FOR payload strictly', () => {
    expect(validateStepForPayload({ seq: 1, dtMs: 5, inputs: {}, outputs: ['joint:a.pos'] })).toEqual({
      ok: true,
      seq: 1,
      dtMs: 5,
      inputs: {},
      outputs: ['joint:a.pos'],
    });
    expect(validateStepForPayload({ seq: 1, dtMs: Infinity, inputs: {}, outputs: [] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: 1, dtMs: NaN, inputs: {}, outputs: [] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: 1, dtMs: -1, inputs: {}, outputs: [] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: 1, dtMs: MAX_COSIM_DT_MS + 1, inputs: {}, outputs: [] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: 1, dtMs: 5, inputs: [] as unknown as Record<string, number>, outputs: [] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: 1, dtMs: 5, inputs: {}, outputs: [123 as unknown as string] }).ok).toBe(false);
    expect(validateStepForPayload({ seq: NaN, dtMs: 5, inputs: {}, outputs: [] }).ok).toBe(false);
  });

  it('clears and prunes measured cavities across scene swaps and body deletions', () => {
    clearCavities();
    useCavityStore.getState().setCavity('speaker_a', { volume: 0.002 });
    useCavityStore.getState().setCavity('speaker_b', { volume: 0.004 });
    expect(Object.keys(useCavityStore.getState().measured)).toEqual(['speaker_a', 'speaker_b']);

    useCavityStore.getState().pruneToNodes(['speaker_a']);
    expect(Object.keys(useCavityStore.getState().measured)).toEqual(['speaker_a']);

    clearCavities();
    expect(useCavityStore.getState().measured).toEqual({});

    // Subscription to useStore: swapping activePreset clears stale cavities
    useCavityStore.getState().setCavity('stale_box', { volume: 0.001 });
    const prevPreset = useStore.getState().activePreset;
    useStore.setState({ activePreset: `${prevPreset ?? 'none'}_switched` });
    expect(useCavityStore.getState().measured).toEqual({});
    useStore.setState({ activePreset: prevPreset });
  });
});

// ---------------------------------------------------------------------------
// #40 & #41: decodeImage & ImportProfileModal cutouts preview
// ---------------------------------------------------------------------------

describe('Section 7 Audit — Image Decoding & Profile Cutouts Preview (#40, #41)', () => {
  it('#40 isImageFile matches by MIME type or filename extension even when file.type is empty', () => {
    expect(isImageFile({ name: 'photo.png', type: '' })).toBe(true);
    expect(isImageFile({ name: 'SCAN.JPEG', type: '' })).toBe(true);
    expect(isImageFile({ name: 'logo.webp', type: '' })).toBe(true);
    expect(isImageFile({ name: 'blob_without_ext', type: 'image/png' })).toBe(true);
    expect(isImageFile({ name: 'bracket.stl', type: '' })).toBe(false);
    expect(isImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('#41 decodeImageUrl throws on 0x0 intrinsic images instead of returning a 1x1 blank canvas', async () => {
    const OrigImage = globalThis.Image;
    class ZeroImage {
      naturalWidth = 0;
      naturalHeight = 0;
      decoding = 'async';
      crossOrigin = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.Image = ZeroImage as unknown as typeof Image;
    try {
      await expect(decodeImageUrl('data:image/svg+xml,<svg/>', 512)).rejects.toThrow(/zero intrinsic dimensions/i);
    } finally {
      globalThis.Image = OrigImage;
    }
  });

  it('#41 ImportProfileModal preview renders profile.cutouts via SVG mask and outline stroke', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <rect width="20" height="20" fill="black"/>
      <circle cx="10" cy="10" r="4" fill="white"/>
    </svg>`;
    const file = new File([svg], 'knockout.svg', { type: 'image/svg+xml' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          React.createElement(ImportProfileModal, {
            initialFile: file,
            onClose: () => {},
            onImportNode: () => {},
          }),
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 260));
      });
      const mask = container.querySelector('svg defs mask');
      expect(mask).not.toBeNull();
      const maskPaths = mask!.querySelectorAll('path');
      expect(maskPaths.length).toBeGreaterThanOrEqual(1);
      // Verify shapesPath produces valid SVG path string for cutouts
      const profile = svgProfile(svg);
      expect(shapesPath(profile.cutouts!)).toMatch(/^M.*Z$/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// #2, #16, #42, #60: usePcbHandoffLink & ImportPcbModal integration
// ---------------------------------------------------------------------------

describe('Section 7 Audit — PCB Handoff Link & ImportPcbModal (#2, #16, #42, #60)', () => {
  const savedState = useStore.getState();

  beforeEach(() => {
    usePanels.setState({ isPcbImportOpen: false, pcbHandoff: null });
    window.history.replaceState(null, '', window.location.pathname);
  });

  afterEach(() => {
    useStore.setState({
      sceneGraph: savedState.sceneGraph,
      selectedNodeId: savedState.selectedNodeId,
    });
    vi.restoreAllMocks();
  });

  it('#16 usePcbHandoffLink listens to hashchange while tab is already open', async () => {
    const Host = () => {
      usePcbHandoffLink();
      return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(Host));
      });
      expect(usePanels.getState().isPcbImportOpen).toBe(false);

      const frag = encodePcbHandoff(PCB_PRESETS.proto_50x50, { format: 'fragment' });
      window.location.hash = frag;
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(usePanels.getState().isPcbImportOpen).toBe(true);
      expect(usePanels.getState().pcbHandoff).toBe(frag);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('#16/#2/#42/#60 ImportPcbModal opens object initialSpec on handoff tab, syncs updates, routes through updateScene with suffixed inner names, guards apply_to_selected, and defers revokeObjectURL', async () => {
    const updateSceneSpy = vi.fn((next) => {
      useStore.setState({ sceneGraph: next });
    });
    const setSelectedSpy = vi.fn((id: string | null) => {
      useStore.setState({ selectedNodeId: id });
    });
    const origUpdate = useStore.getState().updateScene;
    const origSelect = useStore.getState().setSelectedNodeId;
    useStore.setState({
      sceneGraph: { name: 'Test Scene', nodes: [] },
      selectedNodeId: null,
      updateScene: updateSceneSpy,
      setSelectedNodeId: setSelectedSpy,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();

    try {
      // 1. Object initialSpec opens on handoff tab (not preset)
      await act(async () => {
        root.render(
          React.createElement(ImportPcbModal, {
            isOpen: true,
            onClose,
            initialSpec: PCB_PRESETS.proto_50x50,
          }),
        );
      });
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea!.value).toContain('50x50 Sensor / MCU Node');

      // 2. Updating initialSpec while open updates the handoff textarea
      await act(async () => {
        root.render(
          React.createElement(ImportPcbModal, {
            isOpen: true,
            onClose,
            initialSpec: PCB_PRESETS.arduino_uno,
          }),
        );
      });
      expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toContain('Arduino Uno R3');

      // 3. Save 1:1 SVG defers URL.revokeObjectURL (does not call synchronously)
      vi.useFakeTimers();
      const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-svg');
      const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save 1:1 SVG'),
      )!;
      await act(async () => {
        saveBtn.click();
      });
      expect(createUrlSpy).toHaveBeenCalledTimes(1);
      expect(revokeUrlSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(revokeUrlSpy).toHaveBeenCalledWith('blob:mock-svg');
      vi.useRealTimers();

      // 4. Add enclosure twice -> uses updateScene and suffixes inner geom & joint names
      const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Add PCB + Enclosure to Scene'),
      )!;
      await act(async () => { addBtn.click(); });
      await act(async () => { addBtn.click(); });
      expect(updateSceneSpy).toHaveBeenCalledTimes(2);
      const nodes = useStore.getState().sceneGraph.nodes;
      expect(nodes.length).toBe(6); // 2 * (base + pcb + lid)
      const allGeomNames = nodes.flatMap((n) => (n.geoms || []).map((g) => g.name));
      const allJointNames = nodes.flatMap((n) => (n.joints || []).map((j) => j.name));
      expect(new Set(allGeomNames).size).toBe(allGeomNames.length);
      expect(new Set(allJointNames).size).toBe(allJointNames.length);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useStore.setState({ updateScene: origUpdate, setSelectedNodeId: origSelect });
    }
  });
});

// ---------------------------------------------------------------------------
// #43: stlFeatures.ts 2.5D feature reconstruction
// ---------------------------------------------------------------------------

describe('Section 7 Audit — 2.5D Feature Reconstruction (#43)', () => {
  it('sliceLoops handles vertices lying exactly on the slice plane and rejects unclosed chains', () => {
    // Stacked two-tier box sharing vertices right on the plane z = 0.05
    const r = parseSTL(
      writeBinarySTL([
        ...boxTris(0, 0, 0.025, 0.1, 0.1, 0.05),
        ...boxTris(0, 0, 0.075, 0.1, 0.1, 0.05),
      ]),
    );
    const loops = sliceLoops(r.renderVertices, r.faces, 2, 0.05, 1e-4);
    expect(loops).toHaveLength(1);
    expect(loops[0].length).toBe(4);

    // Open mesh (only 2 walls of a box) should NOT produce a closed loop
    const openVerts = [
      0, 0, 0,  0.1, 0, 0,  0.1, 0, 0.1,  0, 0, 0.1,
      0.1, 0.1, 0,  0.1, 0.1, 0.1,
    ];
    const openFaces = [
      0, 1, 2,  0, 2, 3,
      1, 4, 5,  1, 5, 2,
    ];
    expect(sliceLoops(openVerts, openFaces, 2, 0.05, 1e-4)).toHaveLength(0);
  });

  it('regionsMatch uses separate tolerances for area, centre, exact hole count, and hole geometry', () => {
    const a: Region[] = [
      { outer: rectLoop(0, 0, 0.1, 0.1), holes: [rectLoop(0.02, 0, 0.01, 0.01)] },
      { outer: rectLoop(0.3, 0, 0.1, 0.1), holes: [] },
    ];
    // Reversed order -> still matches
    const bReordered: Region[] = [a[1], a[0]];
    expect(regionsMatch(a, bReordered, 1e-4)).toBe(true);

    // Different hole count even when tol is large (>= 1) -> must NOT match
    const cNoHole: Region[] = [{ outer: rectLoop(0, 0, 0.1, 0.1), holes: [] }, a[1]];
    expect(regionsMatch(a, cNoHole, 5)).toBe(false);

    // Same outer & same hole count, but hole moved -> must NOT match
    const dMovedHole: Region[] = [
      { outer: rectLoop(0, 0, 0.1, 0.1), holes: [rectLoop(-0.02, 0, 0.01, 0.01)] },
      a[1],
    ];
    expect(regionsMatch(a, dMovedHole, 1e-4)).toBe(false);

    // Same outer & same hole position, but hole resized -> must NOT match
    const eBiggerHole: Region[] = [
      { outer: rectLoop(0, 0, 0.1, 0.1), holes: [rectLoop(0.02, 0, 0.03, 0.03)] },
      a[1],
    ];
    expect(regionsMatch(a, eBiggerHole, 1e-4)).toBe(false);
  });

  it('uniformOffset sorts regions deterministically and validates hole offsets', () => {
    const bot: Region[] = [
      { outer: rectLoop(0, 0, 0.1, 0.1), holes: [rectLoop(0, 0, 0.02, 0.02)] },
      { outer: rectLoop(0.3, 0, 0.1, 0.1), holes: [] },
    ];
    // Top shrunk uniformly by 0.005 on both islands, in REVERSED order, with unchanged through-hole
    const topShrunk: Region[] = [
      { outer: rectLoop(0.3, 0, 0.09, 0.09), holes: [] },
      { outer: rectLoop(0, 0, 0.09, 0.09), holes: [rectLoop(0, 0, 0.02, 0.02)] },
    ];
    const d = uniformOffset(bot, topShrunk, 1e-4);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(0.005, 5);

    // Top with chamfered hole expanding outward by the same 0.005 -> valid chamfer
    const topChamferedHole: Region[] = [
      { outer: rectLoop(0.3, 0, 0.09, 0.09), holes: [] },
      { outer: rectLoop(0, 0, 0.09, 0.09), holes: [rectLoop(0, 0, 0.03, 0.03)] },
    ];
    expect(uniformOffset(bot, topChamferedHole, 1e-4)).toBeCloseTo(0.005, 5);

    // Top where hole shifted sideways -> NOT a uniform offset
    const topShiftedHole: Region[] = [
      { outer: rectLoop(0.3, 0, 0.09, 0.09), holes: [] },
      { outer: rectLoop(0, 0, 0.09, 0.09), holes: [rectLoop(0.015, 0, 0.02, 0.02)] },
    ];
    expect(uniformOffset(bot, topShiftedHole, 1e-4)).toBeNull();
  });

  it('reconstructPrismatic rebuilds a prismatic box with accurate volume', () => {
    const r = parseSTL(writeBinarySTL(boxTris(0, 0, 0.025, 0.1, 0.06, 0.05)));
    const model = reconstructPrismatic(r.renderVertices, r.faces, 0.1 * 0.06 * 0.05);
    expect(model).not.toBeNull();
    expect(model!.volume).toBeCloseTo(0.1 * 0.06 * 0.05, 6);
    expect(buildRegions(sliceLoops(r.renderVertices, r.faces, 2, 0.025, 1e-4))).toHaveLength(1);
  });
});
