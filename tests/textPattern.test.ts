import { describe, it, expect } from 'vitest';
import {
  circleGuide,
  decodeContours,
  encodeContours,
  fillContours,
  flattenSvgPath,
  layoutText,
  type Contour,
  type FontLike,
  type PathCommand,
} from '../src/utils/textOutline';
import { TEXT_PATTERN, hasFreshOutline, textSignature } from '../src/utils/textPattern';
import { applySurfaceTextures, type SurfaceTexture } from '../src/utils/surfaceTexture';
import { patternById } from '../src/utils/surfacePatterns';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { creasedGeometry } from '../src/utils/creasedNormals';
import { colorsForCopy } from '../src/utils/vertexPaint';
import { exportThreeMf, linearToSrgbHex } from '../src/utils/threeMfExporter';

/*
 * What these defend: lettering has to come out the right way round, the
 * size asked for, where it was asked for, and solid -- a variable font draws
 * a glyph from overlapping pieces, and filling those even-odd punches holes
 * where they cross. Engraving has to sink the letters, not the ground round
 * them. No network: a fake font of rectangles stands in for a real one.
 */

const UPM = 1000;
const CAP = 700;
const ADVANCE = 600;

/** A rectangle, y-down like opentype.js, wound one way or the other. */
function rectCmds(x0: number, y0: number, x1: number, y1: number, reverse = false): PathCommand[] {
  const pts = reverse ? [[x0, y0], [x0, y1], [x1, y1], [x1, y0]] : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return [
    { type: 'M', x: pts[0][0], y: pts[0][1] },
    ...pts.slice(1).map(([x, y]) => ({ type: 'L', x, y })),
    { type: 'Z' },
  ];
}

/**
 * Every letter is a solid block 500 wide and a capital tall; 'O' is a block
 * with a hole; '+' is two overlapping bars wound the same way; ' ' is empty.
 */
const fakeFont: FontLike = {
  unitsPerEm: UPM,
  ascender: 800,
  descender: -200,
  tables: { os2: { sCapHeight: CAP } },
  charToGlyph(ch) {
    return {
      advanceWidth: ADVANCE,
      getPath(x, y, size) {
        const k = size / UPM;
        const X = (u: number) => x + u * k, Y = (v: number) => y - v * k;
        if (ch === ' ') return { commands: [] };
        if (ch === 'O') {
          return { commands: [...rectCmds(X(50), Y(0), X(550), Y(CAP)), ...rectCmds(X(200), Y(150), X(400), Y(CAP - 150), true)] };
        }
        if (ch === '+') {
          return { commands: [...rectCmds(X(50), Y(300), X(550), Y(400)), ...rectCmds(X(250), Y(50), X(350), Y(650))] };
        }
        return { commands: rectCmds(X(50), Y(0), X(550), Y(CAP)) };
      },
    };
  },
};

function bounds(contours: Contour[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of contours) for (let j = 0; j < k.length; j += 2) {
    x0 = Math.min(x0, k[j]); x1 = Math.max(x1, k[j]); y0 = Math.min(y0, k[j + 1]); y1 = Math.max(y1, k[j + 1]);
  }
  return { x0, y0, x1, y1 };
}

/** Coverage at a point, by filling a 1x1 grid centred on it. */
const coverAt = (contours: Contour[], x: number, y: number) => fillContours(contours, 1, 1, x, y, 0.01, 0.01)[0];

describe('text layout', () => {
  it('sets capitals the height asked for, centred, reading left to right and upright', () => {
    const c = layoutText(fakeFont, { text: 'AB', heightMm: 10 });
    const b = bounds(c);
    expect(b.y1 - b.y0).toBeCloseTo(10, 6);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(0, 6);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(0, 6);
    // Two letters, the first on the left.
    const firstMid = (c[0][0] + c[0][2]) / 2;
    expect(firstMid).toBeLessThan(0);
    // Upright: the glyph's "top" (y = CAP in font units) is +y here.
    expect(c[0].filter((_, j) => j % 2 === 1).every((y) => y >= -5 - 1e-9 && y <= 5 + 1e-9)).toBe(true);
  });

  it('stacks lines downward, centred on the block, at the line spacing asked for', () => {
    const c = layoutText(fakeFont, { text: 'A\nA', heightMm: 10, lineSpacing: 2 });
    const tops = c.map((k) => Math.max(...k.filter((_, j) => j % 2 === 1))).sort((a, b) => b - a);
    expect(tops[0] - tops[1]).toBeCloseTo(20, 6);
    const b = bounds(c);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(0, 6);
  });

  it('adds letter spacing between letters only', () => {
    const plain = bounds(layoutText(fakeFont, { text: 'AAA', heightMm: 7 }));
    const spaced = bounds(layoutText(fakeFont, { text: 'AAA', heightMm: 7, letterSpacingMm: 2 }));
    expect(spaced.x1 - spaced.x0 - (plain.x1 - plain.x0)).toBeCloseTo(4, 6);
  });

  it('draws a box round the text that fills with it, not against it', () => {
    const c = layoutText(fakeFont, { text: 'A', heightMm: 10, boxMm: 1, boxPadMm: 2 });
    const b = bounds(c);
    // Letter 5 mm wide (500/700 of 7... scaled), padded 2, line 1, either side.
    expect(b.y1 - b.y0).toBeCloseTo(10 + 2 * 3, 6);
    expect(coverAt(c, 0, b.y1 - 0.5)).toBeCloseTo(1, 6); // on the line
    expect(coverAt(c, 0, b.y1 - 2)).toBeCloseTo(0, 6); // in the gap
    expect(coverAt(c, 0, 0)).toBeCloseTo(1, 6); // the letter
  });

  it('lays text round a circle: over the top reading clockwise, letters standing on the radius', () => {
    const r = 30;
    const c = layoutText(fakeFont, { text: 'AAA', heightMm: 5, path: 'arc', arcRadiusMm: r, arcSide: 'top' });
    for (const k of c) for (let j = 0; j < k.length; j += 2) {
      const d = Math.hypot(k[j], k[j + 1]);
      // A flat glyph's corners dip just inside the circle, and its top corners reach just past r + h.
      expect(d).toBeGreaterThan(r - 0.6);
      expect(d).toBeLessThan(r + 5 + 0.6);
    }
    // The middle letter at the top, the first to its left.
    const mid = (k: Contour) => [k.filter((_, j) => j % 2 === 0).reduce((a, b) => a + b, 0) / (k.length / 2), k.filter((_, j) => j % 2 === 1).reduce((a, b) => a + b, 0) / (k.length / 2)];
    const [m0, m1] = [mid(c[0]), mid(c[1])];
    expect(m1[0]).toBeCloseTo(0, 6);
    expect(m1[1]).toBeGreaterThan(0);
    expect(m0[0]).toBeLessThan(0);
  });

  it('lays text under the bottom of the same ring, reading left to right, capitals pointing in', () => {
    const r = 30, h = 5;
    const c = layoutText(fakeFont, { text: 'AAA', heightMm: h, path: 'arc', arcRadiusMm: r, arcSide: 'bottom' });
    const xs = c.map((k) => k.filter((_, j) => j % 2 === 0).reduce((a, b) => a + b, 0) / (k.length / 2));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    for (const k of c) for (let j = 0; j < k.length; j += 2) {
      const d = Math.hypot(k[j], k[j + 1]);
      expect(d).toBeGreaterThan(r - 0.6);
      expect(d).toBeLessThan(r + h + 0.6);
      expect(k[j + 1]).toBeLessThan(0);
    }
  });

  it('follows a custom SVG path, y down as SVG draws it', () => {
    // A straight path going up-right in SVG (y down), so up-right here too.
    const c = layoutText(fakeFont, { text: 'AA', heightMm: 5, path: 'custom', pathD: 'M 0 0 L 100 -100', pathAlign: 'start' });
    const mids = c.map((k) => [k.filter((_, j) => j % 2 === 0).reduce((a, b) => a + b, 0), k.filter((_, j) => j % 2 === 1).reduce((a, b) => a + b, 0)]);
    expect(mids[1][0]).toBeGreaterThan(mids[0][0]);
    expect(mids[1][1]).toBeGreaterThan(mids[0][1]);
  });

  it('rejects an empty custom path with a message', () => {
    expect(() => layoutText(fakeFont, { text: 'A', heightMm: 5, path: 'custom', pathD: '' })).toThrow(/custom path is empty/);
  });
});

describe('the guides', () => {
  it('runs a circle at constant radius, its tangent square to the radius', () => {
    for (const side of ['top', 'bottom'] as const) {
      const g = circleGuide(10, side);
      for (const s of [-5, 0, 7, 20]) {
        const p = g.at(s);
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
        expect(p.x * p.tx + p.y * p.ty).toBeCloseTo(0, 9);
        expect(p.tx).toBeDefined();
      }
      // Left to right through the middle.
      expect(g.at(0).tx).toBeGreaterThan(0.99);
    }
  });

  it('flattens every SVG command, relative and absolute, arcs included', () => {
    const [line] = flattenSvgPath('m 10 10 h 10 v 10 l -10 0 z', 0.01);
    expect(line.slice(0, 8)).toEqual([10, 10, 20, 10, 20, 20, 10, 20]);
    expect(line.slice(-2)).toEqual([10, 10]);
    // A half circle of radius 5 from (0,0) to (10,0), every point on it.
    const [arc] = flattenSvgPath('M0 0 A5 5 0 0 1 10 0', 0.01);
    for (let j = 0; j < arc.length; j += 2) expect(Math.hypot(arc[j] - 5, arc[j + 1])).toBeCloseTo(5, 6);
    expect(arc.length).toBeGreaterThan(20);
    // Sweep 1 in y-down goes through negative y (the top of the screen).
    expect(Math.min(...arc.filter((_, j) => j % 2 === 1))).toBeLessThan(-4.9);
    const [curve] = flattenSvgPath('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0 Q 25 5 30 0 T 40 0', 0.01);
    expect(curve.slice(-2)).toEqual([40, 0]);
    expect(() => flattenSvgPath('M 0', 0.01)).toThrow();
    expect(() => flattenSvgPath('10 10', 0.01)).toThrow();
  });
});

describe('filling', () => {
  it('fills overlapping pieces solid (nonzero) and leaves a counter open', () => {
    const plus = layoutText(fakeFont, { text: '+', heightMm: 7 });
    // Where the bars cross: covered once, not cancelled.
    const b = bounds(plus);
    expect(coverAt(plus, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)).toBeCloseTo(1, 6);
    const o = layoutText(fakeFont, { text: 'O', heightMm: 7 });
    expect(coverAt(o, 0, 0)).toBeCloseTo(0, 6);
    const ob = bounds(o);
    expect(coverAt(o, ob.x0 + 0.5, 0)).toBeCloseTo(1, 6);
  });

  it('ramps across an edge over one cell, by how much of the cell is inside', () => {
    const sq: Contour = [0, 0, 10, 0, 10, 10, 0, 10];
    // Cells 1 wide centred at x = -1, 0, 1: the edge at 0 halves the middle one.
    const row = fillContours([sq], 3, 1, -1, 5, 1, 1);
    expect(Array.from(row)).toEqual([0, 0.5, 1]);
  });

  it('round-trips the saved outline to a hundredth of a millimetre', () => {
    const c = layoutText(fakeFont, { text: 'OA', heightMm: 6.123 });
    const back = decodeContours(encodeContours(c));
    expect(back.length).toBe(c.length);
    for (let i = 0; i < c.length; i++) {
      for (let j = 0; j < back[i].length; j++) expect(Math.abs(back[i][j] - c[i][j])).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });
});

/** The pattern's options as `prepare` leaves them, with the fake font. */
function prepared(over: Record<string, string | number> = {}) {
  const o = { ...TEXT_PATTERN.defaults, ...over };
  const layout = layoutText(fakeFont, {
    text: String(o.text), heightMm: Number(o.heightMm), path: 'straight',
  });
  return { ...o, outline: encodeContours(layout), outlineSig: textSignature(o) };
}

describe('the Text pattern', () => {
  it('is registered as a figure, ahead of the textures', () => {
    const spec = patternById('text');
    expect(spec?.figure).toBe(true);
    expect(spec?.prepare).toBeTypeOf('function');
  });

  it('knows when its outline is stale', () => {
    const o = prepared();
    expect(hasFreshOutline(o)).toBe(true);
    expect(hasFreshOutline({ ...o, text: 'other' })).toBe(false);
    // Moving it is not a new layout.
    expect(hasFreshOutline({ ...o, offsetXMm: 5 })).toBe(true);
  });

  it('builds the letters in the middle of the board, moved by the offsets, and nothing without an outline', () => {
    const o = prepared({ text: 'A', heightMm: 10 });
    const cols = 101, rows = 101; // 0.5 mm cells over 50 mm
    const grid = TEXT_PATTERN.build(cols, rows, { widthM: 0.05, depthM: 0.05 }, o);
    expect(grid[50 * cols + 50]).toBeCloseTo(1, 6);
    expect(grid[0]).toBe(0);
    const moved = TEXT_PATTERN.build(cols, rows, { widthM: 0.05, depthM: 0.05 }, { ...o, offsetXMm: 15, offsetYMm: 10 });
    expect(moved[50 * cols + 50]).toBe(0);
    expect(moved[(50 + 20) * cols + 50 + 30]).toBeCloseTo(1, 6);
    expect(Array.from(TEXT_PATTERN.build(5, 5, { widthM: 0.01, depthM: 0.01 }, { ...TEXT_PATTERN.defaults })).every((v) => v === 0)).toBe(true);
  });
});

/** An axis-aligned box as a triangle soup, outward-wound. */
function box(hx: number, hy: number, hz: number): { positions: number[]; faces: number[] } {
  const c = (sx: number, sy: number, sz: number) => [sx * hx, sy * hy, sz * hz];
  const quads = [
    [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
    [c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1), c(-1, -1, -1)],
    [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)],
    [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)],
    [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)],
    [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
  ];
  const positions: number[] = [];
  const faces: number[] = [];
  for (const [a, b, cc, d] of quads) for (const tri of [[a, b, cc], [a, cc, d]]) for (const p of tri) {
    faces.push(positions.length / 3);
    positions.push(...p);
  }
  return { positions, faces };
}

/** A closed cylinder along z, outward-wound, with shared vertices. */
function cylinder(r: number, hz: number, segments: number): { positions: number[]; faces: number[] } {
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    positions.push(r * Math.cos(t), r * Math.sin(t), -hz, r * Math.cos(t), r * Math.sin(t), hz);
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -hz);
  const top = bottom + 1;
  positions.push(0, 0, hz);
  const faces: number[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1;
    faces.push(b0, b1, t1, b0, t1, t0, top, t0, t1, bottom, b1, b0);
  }
  return { positions, faces };
}

describe('text on a face', () => {
  // A 60 x 40 mm top, one letter 'A' (a 7.14 x 10 mm block) in the middle.
  const part = box(0.03, 0.02, 0.01);
  const texture = (depthM: number): SurfaceTexture => ({
    pattern: 'text', options: prepared({ text: 'A', heightMm: 10 }), depthM,
    cellM: 0.0005, seedAt: [0, 0, 0.01], seedNormal: [0, 0, 1],
  });
  /** z of the top surface near (x, y), from the vertices there. */
  const topAt = (v: number[], x: number, y: number) => {
    let best = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      if (Math.hypot(v[i] - x, v[i + 1] - y) < 0.0004 && v[i + 2] > 0.005) best = Math.max(best, v[i + 2]);
    }
    return best;
  };

  it('engraves: sinks the letter and leaves the face round it, closed and outward', () => {
    const out = applySurfaceTextures(part.positions, part.faces, [texture(-0.001)]);
    expect(out.regions[0].applied).toBe(true);
    expect(topAt(out.vertices, 0, 0)).toBeCloseTo(0.009, 5);
    expect(topAt(out.vertices, 0.015, 0)).toBeCloseTo(0.01, 6);
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed).toBe(true);
    expect(check.consistentlyWound).toBe(true);
    expect(check.volume).toBeGreaterThan(0);
  });

  it('embosses: raises the letter and leaves the face round it', () => {
    const out = applySurfaceTextures(part.positions, part.faces, [texture(0.0015)]);
    expect(topAt(out.vertices, 0, 0)).toBeCloseTo(0.0115, 5);
    expect(topAt(out.vertices, 0.015, 0)).toBeCloseTo(0.01, 6);
  });

  it('colours the letter and not the face round it, through to the 3MF', () => {
    const red = [0.9, 0.1, 0.1];
    for (const d of [-0.001, 0.0015]) {
      const out = applySurfaceTextures(part.positions, part.faces, [{ ...texture(d), color: red }]);
      const paint = out.paint!;
      expect(paint).toBeDefined();
      // Every painted vertex is in the letter's 7.14 x 10 mm block, give or
      // take a cell, and the letter's middle is painted.
      const painted = new Set(paint.idx);
      for (const v of paint.idx) {
        expect(Math.abs(out.vertices[3 * v])).toBeLessThan(0.0036 + 0.0006);
        expect(Math.abs(out.vertices[3 * v + 1])).toBeLessThan(0.005 + 0.0006);
      }
      let middle = -1, best = Infinity;
      for (let v = 0; v < out.vertices.length / 3; v++) {
        const r = Math.hypot(out.vertices[3 * v], out.vertices[3 * v + 1]);
        if (out.vertices[3 * v + 2] > 0.005 && r < best) { best = r; middle = v; }
      }
      expect(painted.has(middle)).toBe(true);

      // Drawn the way SceneLayer draws it, then written as a 3MF: two filament
      // slots, the letter's triangles in the second.
      const creased = creasedGeometry(new Float32Array(out.vertices), new Uint32Array(out.faces));
      const colors = colorsForCopy([0.8, 0.8, 0.8], paint, out.faces, creased.index, creased.positions.length / 3);
      const result = exportThreeMf([{
        name: 'plate', positions: creased.positions, indices: creased.index, colors, baseColor: [0.8, 0.8, 0.8],
      }]);
      const used = result.palette.filter((p) => p.triangles > 0);
      expect(used.length).toBe(2);
      expect(used[0].hex).toBe(linearToSrgbHex([0.8, 0.8, 0.8]));
      // Paint is stored a byte a channel.
      expect(used[1].hex).toBe(linearToSrgbHex(red.map((c) => Math.round(c * 255) / 255)));
      // The letter is ~6 % of the top; its triangles are a share of the part's.
      expect(used[1].triangles).toBeGreaterThan(50);
      expect(used[1].triangles).toBeLessThan(used[0].triangles);
    }
  });

  it('leaves an uncoloured letter unpainted', () => {
    expect(applySurfaceTextures(part.positions, part.faces, [texture(-0.001)]).paint).toBeUndefined();
  });

  it('draws the laser field as the letter, engraved or embossed', () => {
    for (const d of [-0.001, 0.001]) {
      const field = applySurfaceTextures(part.positions, part.faces, [texture(d)]).regions[0].field!;
      const at = (x: number, y: number) => {
        const p = [x - field.origin[0], y - field.origin[1], 0.01 - field.origin[2]];
        const u = p[0] * field.u[0] + p[1] * field.u[1] + p[2] * field.u[2];
        const v = p[0] * field.v[0] + p[1] * field.v[1] + p[2] * field.v[2];
        return field.data[Math.round(v / field.step) * field.cols + Math.round(u / field.step)];
      };
      expect(at(0, 0)).toBeCloseTo(1, 3);
      expect(at(0.015, 0)).toBeCloseTo(0, 6);
    }
  });

  it('puts text on a cylinder once, on the point picked, not repeated round it', () => {
    const drum = cylinder(0.02, 0.02, 96);
    const seedAt = [0, 0.02, 0];
    const out = applySurfaceTextures(drum.positions, drum.faces, [{
      pattern: 'text', options: prepared({ text: 'A', heightMm: 10 }), depthM: -0.001,
      cellM: 0.0006, seedAt, seedNormal: [0, 1, 0],
    }]);
    expect(out.regions[0].applied).toBe(true);
    expect(out.regions[0].wrap).toEqual({ scaled: 1, blended: false });
    /** The least radius of the side within a millimetre of an angle round it, at mid-height. */
    const radiusAt = (deg: number) => {
      let best = Infinity;
      const v = out.vertices;
      for (let i = 0; i < v.length; i += 3) {
        const r = Math.hypot(v[i], v[i + 1]);
        if (r < 0.015 || Math.abs(v[i + 2]) > 0.001) continue;
        const off = Math.abs(((Math.atan2(v[i + 1], v[i]) * 180) / Math.PI - deg + 540) % 360 - 180);
        if (off * (Math.PI / 180) * 0.02 < 0.001) best = Math.min(best, r);
      }
      return best;
    };
    expect(radiusAt(90)).toBeCloseTo(0.019, 4); // the letter, where it was picked
    expect(radiusAt(-90)).toBeCloseTo(0.02, 4); // and not round the back
    expect(radiusAt(0)).toBeCloseTo(0.02, 4);
  });
});
