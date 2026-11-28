// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 };
});

vi.mock('../src/hooks/mcp/settleScene', () => ({
  settleScene: vi.fn(async (nodes: unknown[]) => {
    const { useStore } = await import('../src/store/useStore');
    const prev = useStore.getState().sceneGraph;
    // Give OpenSCAD-based profile nodes a dummy vertex so IMPORT_PROFILE sees them as compiled.
    const hydrated = (nodes as Array<{ scad?: string; geoms?: Array<Record<string, unknown>> }>).map((n) => {
      if (n.scad && n.geoms?.[0] && !n.geoms[0].renderVertices && !n.geoms[0].vertices) {
        return {
          ...n,
          geoms: [
            { ...n.geoms[0], renderVertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], faces: [0, 1, 2] },
            ...n.geoms.slice(1),
          ],
        };
      }
      return n;
    });
    useStore.setState({
      sceneGraph: { ...prev, nodes: hydrated as typeof prev.nodes },
    });
    return { ok: true };
  }),
}));

import { sceneCommands } from '../src/hooks/mcp/sceneCommands';
import { profileCommands } from '../src/hooks/mcp/profileCommands';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { findNodeInScene } from '../src/hooks/mcp/bridgeUtils';
import { svgProfile, svgScaleMm, profileNode } from '../src/utils/profileImport';
import { useStore } from '../src/store/useStore';
import type { SceneNode } from '../src/types/scene';

type Tri = [number[], number[], number[]];

function quad(a: number[], b: number[], c: number[], d: number[]): Tri[] {
  return [[a, b, c], [a, c, d]];
}

/** Closed box with outward-facing CCW winding. */
function boxTris(sx: number, sy: number, sz: number): Tri[] {
  const x0 = 0, x1 = sx, y0 = 0, y1 = sy, z0 = 0, z1 = sz;
  const p = (x: number, y: number, z: number) => [x, y, z];
  return [
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)), // bottom (-Z)
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)), // top (+Z)
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)), // front (-Y)
    ...quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)), // back (+Y)
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)), // left (-X)
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)), // right (+X)
  ];
}

function toAsciiSTL(tris: Tri[], name = 'test'): string {
  const lines = [`solid ${name}`];
  for (const [a, b, c] of tris) {
    lines.push('  facet normal 0 0 0');
    lines.push('    outer loop');
    lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
    lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
    lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

function toBinarySTLBase64(tris: Tri[], headerBytes?: Uint8Array): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const bytes = new Uint8Array(buf);
  if (headerBytes) {
    bytes.set(headerBytes.subarray(0, Math.min(80, headerBytes.length)), 0);
  }
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
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function makeCtx() {
  const store = useStore.getState();
  const toId = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    return findNodeInScene(store.sceneGraph.nodes, v)?.id ?? v;
  };
  return { store, toId };
}

beforeEach(() => {
  const prev = useStore.getState().sceneGraph;
  useStore.setState({
    sceneGraph: { ...prev, nodes: [], referenceImages: [] },
  });
});

// ---------------------------------------------------------------------------
// Bug 1: IMPORT_STL with dynamic: false must not attach <freejoint>
// ---------------------------------------------------------------------------
describe('Bug 1: IMPORT_STL dynamic: false omits free joint across all modes', () => {
  const stl = toAsciiSTL(boxTris(0.05, 0.05, 0.05));

  for (const mode of ['mesh', 'scad_parametric', 'scad_raw', 'scad_csg', 'primitive'] as const) {
    it(`mode '${mode}' with dynamic: false has no joints and geom.dynamic === false`, async () => {
      const res = await sceneCommands.IMPORT_STL(
        { stlData: stl, name: `static_${mode}`, importMode: mode, dynamic: false },
        makeCtx(),
      ) as { ok: boolean; nodeId: string };
      expect(res.ok).toBe(true);
      const node = findNodeInScene(useStore.getState().sceneGraph.nodes, res.nodeId) as SceneNode;
      expect(node).toBeDefined();
      expect(node.joints).toEqual([]);
      expect(node.geoms[0].dynamic).toBe(false);
    });

    it(`mode '${mode}' with dynamic: true attaches a free joint and sets geom.dynamic === true`, async () => {
      const res = await sceneCommands.IMPORT_STL(
        { stlData: stl, name: `dyn_${mode}`, importMode: mode, dynamic: true },
        makeCtx(),
      ) as { ok: boolean; nodeId: string };
      expect(res.ok).toBe(true);
      const node = findNodeInScene(useStore.getState().sceneGraph.nodes, res.nodeId) as SceneNode;
      expect(node).toBeDefined();
      expect(node.joints).toEqual([{ name: `${res.nodeId}_free`, type: 'free' }]);
      expect(node.geoms[0].dynamic).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Bug 2: svgProfile resolves <style> CSS fill/stroke/opacity (incl. <g> inheritance)
// ---------------------------------------------------------------------------
describe('Bug 2: svgProfile resolves <style> CSS paint and opacity', () => {
  it('treats <style>.cut { fill: none; stroke: #ff0000; }</style> shapes as cut lines preserving holes', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40">
      <style>.cut { fill: none; stroke: #ff0000; }</style>
      <rect class="cut" x="0" y="0" width="80" height="40"/>
      <circle class="cut" cx="20" cy="20" r="5"/>
      <circle class="cut" cx="60" cy="20" r="5"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(2);
  });

  it('inherits <style> CSS fill/stroke from ancestor <g>', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="60mm" viewBox="0 0 60 60">
      <style>.laser { fill: none; stroke: red; }</style>
      <g class="laser">
        <rect x="0" y="0" width="60" height="60"/>
        <circle cx="30" cy="30" r="10"/>
      </g>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(1);
  });

  it('respects <style> fill-opacity: 0 with stroke', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">
      <style>.ghost { fill: #000; fill-opacity: 0; stroke: #00f; stroke-opacity: 1; }</style>
      <rect class="ghost" x="0" y="0" width="50" height="50"/>
      <circle class="ghost" cx="25" cy="25" r="8"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(1);
  });

  it('lets inline style override <style> rule on the same element', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
      <style>.cut { fill: none; stroke: none; }</style>
      <rect class="cut" style="fill: black" x="0" y="0" width="40" height="40"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.widthMm).toBeCloseTo(40, 2);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: IMPORT_STL integrity warnings & appliedScale
// ---------------------------------------------------------------------------
describe('Bug 3: IMPORT_STL reports mesh integrity warnings and appliedScale', () => {
  it('warns on inverted-winding STL (negative signed volume)', async () => {
    const inverted = boxTris(0.05, 0.05, 0.05).map(([a, b, c]): Tri => [a, c, b]);
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(inverted), importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; warnings?: string[]; appliedScale: number[] };
    expect(res.ok).toBe(true);
    expect(res.appliedScale).toEqual([1, 1, 1]);
    expect(res.warnings?.some((w) => /inverted winding|negative signed volume/i.test(w))).toBe(true);
  });

  it('warns on open mesh with boundary edges', async () => {
    const openBox = boxTris(0.05, 0.05, 0.05).slice(2); // remove bottom face
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(openBox), importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; warnings?: string[] };
    expect(res.ok).toBe(true);
    expect(res.warnings?.some((w) => /not watertight|boundary edge/i.test(w))).toBe(true);
  });

  it('warns on non-manifold mesh (3 triangles sharing an edge)', async () => {
    const tris: Tri[] = [
      ...boxTris(0.05, 0.05, 0.05),
      [[0, 0, 0], [0.05, 0, 0], [0.025, -0.05, 0.025]], // fin sharing edge (0,0,0)-(0.05,0,0)
    ];
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(tris), importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; warnings?: string[] };
    expect(res.ok).toBe(true);
    expect(res.warnings?.some((w) => /non-manifold/i.test(w))).toBe(true);
  });

  it('includes appliedScale and auto-scale warning when mm STL is scaled by 0.001', async () => {
    const mmBox = boxTris(50, 50, 50);
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(mmBox), importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; warnings?: string[]; appliedScale: number[] };
    expect(res.ok).toBe(true);
    expect(res.appliedScale).toEqual([0.001, 0.001, 0.001]);
    expect(res.warnings?.some((w) => /0\.001/.test(w))).toBe(true);
  });

  it('returns appliedScale [1, 1, 1] with no warnings for a clean metre-scale box', async () => {
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(boxTris(0.05, 0.05, 0.05)), importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; warnings?: string[]; appliedScale: number[] };
    expect(res.ok).toBe(true);
    expect(res.appliedScale).toEqual([1, 1, 1]);
    expect(res.warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 4: IMPORT_STL supports importMode: 'scad_csg'
// ---------------------------------------------------------------------------
describe('Bug 4: IMPORT_STL supports importMode: scad_csg', () => {
  it('accepts scad_csg and emits CSG OpenSCAD for a box', async () => {
    const res = await sceneCommands.IMPORT_STL(
      { stlData: toAsciiSTL(boxTris(0.04, 0.06, 0.02)), importMode: 'scad_csg' },
      makeCtx(),
    ) as { ok: boolean; importMode: string; scadCode?: string; nodeId: string };
    expect(res.ok).toBe(true);
    expect(res.importMode).toBe('scad_csg');
    expect(res.scadCode).toMatch(/cube\(/);
    const node = findNodeInScene(useStore.getState().sceneGraph.nodes, res.nodeId) as SceneNode;
    expect(node.scad).toMatch(/cube\(/);
  });
});

// ---------------------------------------------------------------------------
// Bug 5: svgUnitMm / svgProfile non-uniform preserveAspectRatio="none"
// ---------------------------------------------------------------------------
describe('Bug 5: svgProfile supports non-uniform preserveAspectRatio="none"', () => {
  it('scales X and Y independently when preserveAspectRatio="none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="40mm" viewBox="0 0 100 100" preserveAspectRatio="none">
      <rect x="0" y="0" width="100" height="100"/>
    </svg>`;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const scale = svgScaleMm(doc.documentElement);
    expect(scale.sx).toBeCloseTo(1, 5);
    expect(scale.sy).toBeCloseTo(0.4, 5);

    const p = svgProfile(svg);
    expect(p.widthMm).toBeCloseTo(100, 3);
    expect(p.heightMm).toBeCloseTo(40, 3);

    // Explicit widthMm preserves the non-uniform 2.5:1 aspect ratio
    const scaled = svgProfile(svg, { widthMm: 50 });
    expect(scaled.widthMm).toBeCloseTo(50, 3);
    expect(scaled.heightMm).toBeCloseTo(20, 3);
  });

  it('keeps uniform meet scaling when preserveAspectRatio is omitted', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="40mm" viewBox="0 0 100 100">
      <rect x="0" y="0" width="100" height="100"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.widthMm).toBeCloseTo(40, 3);
    expect(p.heightMm).toBeCloseTo(40, 3);
  });
});

// ---------------------------------------------------------------------------
// Bug 6: SET_REFERENCE_IMAGE coerces numeric-string height
// ---------------------------------------------------------------------------
describe('Bug 6: SET_REFERENCE_IMAGE parses numeric-string height', () => {
  beforeEach(() => {
    const prev = useStore.getState().sceneGraph;
    useStore.setState({
      sceneGraph: {
        ...prev,
        referenceImages: [{
          id: 'ref1',
          name: 'TestRef',
          src: 'data:image/png;base64,iVBORw0KGgo=',
          aspect: 2,
          plane: 'front',
          pos: [0, 0, 0.1],
          width: 0.2,
          opacity: 0.5,
          overlay: true,
        }],
      },
    });
  });

  it('accepts numeric string height like "250"', async () => {
    const res = await viewCommands.SET_REFERENCE_IMAGE(
      { imageId: 'ref1', height: '250' },
      makeCtx(),
    ) as { ok: boolean; widthMm: number; heightMm: number };
    expect(res.ok).toBe(true);
    expect(res.heightMm).toBeCloseTo(250, 2);
    expect(res.widthMm).toBeCloseTo(500, 2);
  });

  it('rejects non-numeric, empty, or out-of-range string height', async () => {
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'ref1', height: '' }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'ref1', height: 'abc' }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'ref1', height: '-500' }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'ref1', height: '25000' }, makeCtx())).rejects.toThrow(/height/i);
  });
});

// ---------------------------------------------------------------------------
// Bug 7: IMPORT_PROFILE / profileNode default pos is [0, 0, 0]
// ---------------------------------------------------------------------------
describe('Bug 7: IMPORT_PROFILE defaults pos to [0, 0, 0]', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
    <rect x="0" y="0" width="40" height="20"/>
  </svg>`;

  it('profileNode defaults pos to [0, 0, 0]', () => {
    const node = profileNode(svgProfile(svg), { name: 'flat_part' });
    expect(node.pos).toEqual([0, 0, 0]);
  });

  it('IMPORT_PROFILE places the body at [0, 0, 0] when pos is omitted', async () => {
    const res = await profileCommands.IMPORT_PROFILE(
      { svg, name: 'floor_part' },
      makeCtx(),
    ) as { ok: boolean; nodeId: string };
    expect(res.ok).toBe(true);
    const node = findNodeInScene(useStore.getState().sceneGraph.nodes, res.nodeId) as SceneNode;
    expect(node.pos).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Bug 8: Bare base64 binary STL containing substring "solid" still decodes
// ---------------------------------------------------------------------------
describe('Bug 8: Bare base64 binary STL containing "solid" decodes as binary', () => {
  it('decodes bare base64 binary STL even when base64 text contains "solid"', async () => {
    // 6-byte sequence whose base64 encoding contains "solid" (from atob('AAAsolid'))
    const raw = atob('AAAsolid');
    const header = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) header[i] = raw.charCodeAt(i);
    const b64 = toBinarySTLBase64(boxTris(0.05, 0.05, 0.05), header);
    expect(b64).toContain('solid');

    const res = await sceneCommands.IMPORT_STL(
      { stlData: b64, name: 'bin_with_solid', importMode: 'mesh' },
      makeCtx(),
    ) as { ok: boolean; faceCount: number; error?: string };
    expect(res.ok).toBe(true);
    expect(res.faceCount).toBe(12);
  });
});
