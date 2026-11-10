// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { svgProfile, traceProfile, profileScad, shapesFromLoops, otsuThreshold, PROFILE_DEFAULTS } from '../src/utils/profileImport';
import { parseScadVariables } from '../src/utils/scadSource';

const square = (x0: number, y0: number, s: number) => [
  { x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s },
];

describe('shapesFromLoops', () => {
  it('nests even-odd: outline, hole, island in the hole', () => {
    const shapes = shapesFromLoops([square(0, 0, 100), square(10, 10, 80), square(40, 40, 20)]);
    expect(shapes).toHaveLength(2);
    const big = shapes.find((s) => s.outline.length === 4 && s.outline[1].x === 100)!;
    expect(big.holes).toHaveLength(1);
    const island = shapes.find((s) => s !== big)!;
    expect(island.holes).toHaveLength(0);
  });

  it('gives each hole to the smallest outline round it', () => {
    const shapes = shapesFromLoops([square(0, 0, 100), square(200, 0, 50), square(210, 10, 10)]);
    const small = shapes.find((s) => s.outline[0].x === 200)!;
    expect(small.holes).toHaveLength(1);
    expect(shapes.find((s) => s.outline[0].x === 0)!.holes).toHaveLength(0);
  });
});

describe('svgProfile', () => {
  it('reads a laser file: a stroked plate with stroked holes, sized from mm units', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40">
      <rect x="0" y="0" width="80" height="40" fill="none" stroke="red"/>
      <circle cx="10" cy="10" r="3" fill="none" stroke="red"/>
      <circle cx="70" cy="10" r="3" fill="none" stroke="red"/>
    </svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(2);
    expect(p.widthMm).toBeCloseTo(80, 3);
    expect(p.heightMm).toBeCloseTo(40, 3);
  });

  it('takes the viewBox scale: 100 user units drawn 50 mm wide', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 100 100">
      <rect x="0" y="0" width="100" height="100"/></svg>`;
    expect(svgProfile(svg).widthMm).toBeCloseTo(50, 3);
  });

  it('assumes 96 dpi with no units, and scales to a requested width', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="96" height="48"/></svg>`;
    expect(svgProfile(svg).widthMm).toBeCloseTo(25.4, 3);
    const p = svgProfile(svg, { widthMm: 120 });
    expect(p.widthMm).toBeCloseTo(120, 3);
    expect(p.heightMm).toBeCloseTo(60, 3);
  });

  it('keeps a filled shape\'s own holes (evenodd ring)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <path fill-rule="evenodd" d="M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z"/></svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(1);
  });

  it('flips y: a shape at the top of the drawing is at +y', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="100mm" viewBox="0 0 10 100">
      <rect x="0" y="0" width="10" height="10"/><rect x="0" y="90" width="10" height="10"/></svg>`;
    const p = svgProfile(svg);
    const tops = p.shapes.map((s) => Math.max(...s.outline.map((q) => q.y))).sort((a, b) => a - b);
    expect(tops[1]).toBeCloseTo(50, 3);
    // the first rect drawn (y=0 in SVG) is the one at the top
    const first = p.shapes[0];
    expect(Math.max(...first.outline.map((q) => q.y))).toBeCloseTo(50, 3);
  });

  it('reports open lines and refuses a drawing of nothing but', () => {
    const open = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10" fill="none" stroke="black"/></svg>`;
    expect(() => svgProfile(open)).toThrow(/open lines/);
    const mixed = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/><path d="M0 0 L10 10" fill="none" stroke="black"/></svg>`;
    expect(svgProfile(mixed).notes.join(' ')).toMatch(/1 open line skipped/);
  });

  it('refuses something that is not an SVG', () => {
    expect(() => svgProfile('<html><body/></html>')).toThrow();
  });
});

/** A w×h RGBA picture, background `bg`, with `paint(x,y)` deciding the part's pixels. */
function picture(w: number, h: number, bg: number, fg: number, paint: (x: number, y: number) => boolean, alpha?: (x: number, y: number) => number) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = paint(x, y) ? fg : bg;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = alpha ? alpha(x, y) : 255;
    }
  }
  return d;
}

// A washer: ring between radius 15 and 35 px, centred in a 100×100 picture.
const ring = (x: number, y: number) => {
  const r = Math.hypot(x - 50, y - 50);
  return r >= 15 && r <= 35;
};

describe('traceProfile', () => {
  it('traces a dark washer on white paper as one shape with one hole, at the width given', () => {
    const t = traceProfile(picture(100, 100, 240, 20, ring), 100, 100, { widthMm: 70 });
    expect(t.darkSubject).toBe(true);
    expect(t.shapes).toHaveLength(1);
    expect(t.shapes[0].holes).toHaveLength(1);
    expect(t.widthMm).toBeCloseTo(70, 3);
    expect(t.heightMm).toBeCloseTo(70, 0);
    // hole is about 30/70 of the outline
    const hole = t.shapes[0].holes[0];
    const holeW = Math.max(...hole.map((p) => p.x)) - Math.min(...hole.map((p) => p.x));
    expect(holeW / 70).toBeGreaterThan(0.38);
    expect(holeW / 70).toBeLessThan(0.48);
  });

  it('a light part on a dark bench comes out the same, unasked', () => {
    const t = traceProfile(picture(100, 100, 25, 230, ring), 100, 100, { widthMm: 70 });
    expect(t.darkSubject).toBe(false);
    expect(t.shapes).toHaveLength(1);
    expect(t.shapes[0].holes).toHaveLength(1);
  });

  it('traces a transparent PNG by its alpha, whatever its colour', () => {
    const px = picture(100, 100, 255, 255, () => false, (x, y) => (ring(x, y) ? 255 : 0));
    const t = traceProfile(px, 100, 100);
    expect(t.byAlpha).toBe(true);
    expect(t.shapes).toHaveLength(1);
    expect(t.shapes[0].holes).toHaveLength(1);
    expect(t.widthMm).toBeCloseTo(PROFILE_DEFAULTS.tracedWidthMm, 3);
  });

  it('drops specks and says so', () => {
    const big = (x: number, y: number) => ring(x / 4, y / 4) || (x >= 10 && x < 13 && y >= 10 && y < 13);
    const t = traceProfile(picture(400, 400, 240, 20, big), 400, 400, { detail: 'fine' });
    expect(t.shapes).toHaveLength(1);
    expect(t.notes.join(' ')).toMatch(/speck/);
  });

  it('closes a part running off the edge of the picture', () => {
    const t = traceProfile(picture(60, 60, 240, 20, (x) => x < 30), 60, 60, { subject: 'dark' });
    expect(t.shapes).toHaveLength(1);
  });

  it('refuses a blank picture', () => {
    expect(() => traceProfile(picture(40, 40, 240, 240, () => false), 40, 40)).toThrow(/No outline/);
  });

  it('coarse detail uses fewer points than fine', () => {
    const px = picture(200, 200, 240, 20, (x, y) => Math.hypot(x - 100, y - 100) < 80);
    const fine = traceProfile(px, 200, 200, { detail: 'fine' }).pointCount;
    const coarse = traceProfile(px, 200, 200, { detail: 'coarse' }).pointCount;
    expect(coarse).toBeLessThan(fine);
  });
});

describe('otsuThreshold', () => {
  it('splits two tones between them', () => {
    const v = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) v[i] = i < 600 ? 0.1 : 0.9;
    const t = otsuThreshold(v);
    expect(t).toBeGreaterThan(0.1);
    expect(t).toBeLessThan(0.9);
  });
});

describe('profileScad', () => {
  it('has a thickness slider, extrudes in mm, scales to metres, and lists holes as paths', () => {
    const p = svgProfile(`<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <path fill-rule="evenodd" d="M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z"/></svg>`);
    const scad = profileScad(p, 4, 'plate');
    const vars = parseScadVariables(scad);
    expect(vars.find((v) => v.name === 'thickness')?.value).toBe(4);
    expect(scad).toMatch(/scale\(0\.001\) linear_extrude\(height=thickness\)/);
    expect(scad).toMatch(/paths=\[\[0,1,2,3\],\[4,5,6,7\]\]/);
  });
});

describe('fixes from the first validation', () => {
  // A dark rectangular plate with four round holes, 500 x 350 px.
  const plate = (x: number, y: number) => {
    if (x < 50 || x > 450 || y < 50 || y > 300) return false;
    for (const [cx, cy] of [[100, 100], [400, 100], [100, 250], [400, 250]]) if (Math.hypot(x - cx, y - cy) < 15) return false;
    return true;
  };

  it('keeps a traced plate\'s corners and its holes at every detail', () => {
    for (const detail of ['fine', 'normal', 'coarse'] as const) {
      const t = traceProfile(picture(500, 350, 240, 20, plate), 500, 350, { detail, widthMm: 200 });
      expect(t.shapes, detail).toHaveLength(1);
      expect(t.shapes[0].holes, detail).toHaveLength(4);
      expect(t.heightMm, detail).toBeCloseTo(125, 0);
    }
  });

  it('keeps small round holes round instead of dropping them', () => {
    const small = (x: number, y: number) => x >= 20 && x < 980 && y >= 20 && y < 680 && Math.hypot(x - 200, y - 200) >= 5;
    const t = traceProfile(picture(1000, 700, 240, 20, small), 1000, 700, { widthMm: 200 });
    expect(t.shapes[0].holes).toHaveLength(1);
    expect(t.shapes[0].holes[0].length).toBeGreaterThanOrEqual(8);
  });

  it('traces the part, not the sheet of paper it lies on, when the table shows round it', () => {
    // mid-grey table, white paper, dark washer on the paper
    const d = new Uint8ClampedArray(400 * 300 * 4);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const onPaper = x > 40 && x < 360 && y > 30 && y < 270;
      const r = Math.hypot(x - 200, y - 150);
      const v = onPaper ? (r >= 20 && r <= 60 ? 25 : 245) : 120;
      const i = (y * 400 + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    const t = traceProfile(d, 400, 300, { widthMm: 40 });
    expect(t.shapes).toHaveLength(1);
    expect(t.shapes[0].holes).toHaveLength(1);
    expect(t.heightMm).toBeCloseTo(40, 0);
    expect(t.notes.join(' ')).toMatch(/sheet/);
  });

  it('traces a photo with a transparent margin by its colours', () => {
    const px = picture(100, 100, 240, 20, ring, (x, y) => (x < 4 || x > 95 || y < 4 || y > 95 ? 0 : 255));
    const t = traceProfile(px, 100, 100, { widthMm: 70 });
    expect(t.shapes).toHaveLength(1);
    expect(t.shapes[0].holes).toHaveLength(1);
    expect(t.widthMm).toBeCloseTo(70, 3);
  });

  it('reads a white-filled, red-stroked laser file as cut lines', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40">
      <rect width="80" height="40" fill="#fff" stroke="red"/><circle cx="10" cy="10" r="3" fill="#fff" stroke="red"/></svg>`;
    const p = svgProfile(svg);
    expect(p.shapes).toHaveLength(1);
    expect(p.shapes[0].holes).toHaveLength(1);
  });

  it('cuts a white knockout out of a black fill', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <rect width="20" height="20" fill="black"/><circle cx="10" cy="10" r="4" fill="white"/></svg>`;
    const p = svgProfile(svg);
    expect(p.cutouts).toHaveLength(1);
    expect(profileScad(p)).toMatch(/difference\(\)/);
  });

  it('leaves hidden layers and clip paths out', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <rect width="20" height="20"/>
      <g style="display:none"><rect x="100" width="200" height="20"/></g>
      <rect x="-300" width="10" height="10" visibility="hidden"/>
      <rect x="300" width="10" height="10" opacity="0"/>
      <clipPath id="c"><rect x="500" width="10" height="10"/></clipPath></svg>`;
    const p = svgProfile(svg);
    expect(p.widthMm).toBeCloseTo(20, 3);
    expect(p.notes.join(' ')).toMatch(/hidden/);
  });

  it('closes an outline left a hair open, and joins separate line segments', () => {
    const nearly = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">
      <path d="M0 0 L10 0 L10 10 L0 10 L0 0.001" fill="none" stroke="black"/></svg>`;
    expect(svgProfile(nearly).shapes).toHaveLength(1);
    const lines = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">
      <line x1="0" y1="0" x2="10" y2="0" stroke="black"/><line x1="10" y1="10" x2="10" y2="0" stroke="black"/>
      <line x1="10" y1="10" x2="0" y2="10" stroke="black"/><line x1="0" y1="10" x2="0" y2="0" stroke="black"/></svg>`;
    const p = svgProfile(lines);
    expect(p.shapes).toHaveLength(1);
    expect(p.widthMm).toBeCloseTo(10, 3);
  });

  it('reads exponent sizes, fits a non-square viewBox, follows <use href>, and names text', () => {
    expect(svgProfile(`<svg xmlns="http://www.w3.org/2000/svg" width="1e2mm" height="1e2mm" viewBox="0 0 100 100"><rect width="50" height="50"/></svg>`).widthMm).toBeCloseTo(50, 3);
    expect(svgProfile(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="10mm" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`).widthMm).toBeCloseTo(10, 3);
    const use = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><defs><rect id="r" width="10" height="10"/></defs><use href="#r"/></svg>`;
    expect(svgProfile(use).widthMm).toBeCloseTo(10, 3);
    expect(() => svgProfile(`<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>`)).toThrow(/convert the text to paths/i);
  });

  it('keeps the thickness slider when the name has a brace in it', () => {
    const p = svgProfile(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`);
    expect(parseScadVariables(profileScad(p, 3, 'logo{v2')).map((v) => v.name)).toContain('thickness');
  });
});
