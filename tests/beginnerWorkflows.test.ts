import { describe, it, expect } from 'vitest';
import { parseMeshDeepLink, stripMeshDeepLinkSearch } from '../src/utils/deepLink';
import { parseMmSvg, tileSvgForHomePrint } from '../src/utils/tiledPaperPrint';
import { layoutPattern, patternSvg, type PatternPiece } from '../src/utils/cloth/patternSvg';
import { buildItems } from '../src/components/buildItems';

describe('Mesh deep-link parser', () => {
  it('parses valid preset, machine, craft modal, mold tab, and unfold mode', () => {
    expect(parseMeshDeepLink('?preset=birdhouse&open=unfold&mode=papercraft')).toEqual({
      preset: 'birdhouse',
      open: 'unfold',
      unfoldMode: 'papercraft',
    });
    expect(parseMeshDeepLink('?preset=casting_flask&open=mold&tab=sand&machine=fdm')).toEqual({
      preset: 'casting_flask',
      open: 'mold',
      moldTab: 'sand',
      machine: 'fdm',
    });
    expect(parseMeshDeepLink('?preset=monkey_head&open=mold&tab=lost-pla')).toEqual({
      preset: 'monkey_head',
      open: 'mold',
      moldTab: 'lost-pla',
    });
    expect(parseMeshDeepLink('?preset=sealed_jar&open=mold&tab=silicone')).toEqual({
      preset: 'sealed_jar',
      open: 'mold',
      moldTab: 'silicone',
    });
    expect(parseMeshDeepLink('?preset=sealed_jar&open=mold&tab=slip')).toEqual({
      preset: 'sealed_jar',
      open: 'mold',
      moldTab: 'slip',
    });
    expect(parseMeshDeepLink('?preset=tailored_outfit_on_form')).toEqual({
      preset: 'tailored_outfit_on_form',
    });
    expect(parseMeshDeepLink('?preset=marimba_cascade')).toEqual({
      preset: 'marimba_cascade',
    });
    expect(parseMeshDeepLink('?preset=pipe_greenhouse&open=pipes')).toEqual({
      preset: 'pipe_greenhouse',
      open: 'pipes',
    });
    expect(parseMeshDeepLink('?preset=bowed_cello')).toEqual({
      preset: 'bowed_cello',
    });
    expect(parseMeshDeepLink('?preset=hydrostatic_flotation&tour=1')).toEqual({
      preset: 'hydrostatic_flotation',
      tour: true,
    });
    expect(parseMeshDeepLink('?preset=pendulum&run=1')).toEqual({
      preset: 'pendulum',
      run: true,
    });
  });

  it('ignores unknown presets, machines, or modal names cleanly', () => {
    expect(parseMeshDeepLink('')).toBeNull();
    expect(parseMeshDeepLink('?preset=not_a_real_preset&open=bogus&machine=plasma')).toBeNull();
    expect(parseMeshDeepLink('?preset=not_a_real_preset&machine=laser')).toEqual({
      machine: 'laser',
    });
  });

  it('strips consumed deep-link params while preserving mcp/share params and hash', () => {
    expect(
      stripMeshDeepLinkSearch('https://mesh.physbox.io/?preset=birdhouse&open=unfold&mode=papercraft&mcp=ws://localhost:8765#etch=abc')
    ).toBe('/?mcp=ws%3A%2F%2Flocalhost%3A8765#etch=abc');
    expect(stripMeshDeepLinkSearch('https://mesh.physbox.io/?preset=pendulum&tour=1')).toBe('/');
  });
});

describe('1:1 home-printer SVG tiling (A4 & US Letter)', () => {
  const smallSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="150mm" viewBox="0 0 120 150"><defs><marker id="arrow"><path d="M0 0 L5 5"/></marker></defs><path d="M10 10 L110 140" marker-end="url(#arrow)"/></svg>`;
  const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="540mm" viewBox="0 0 420 540"><rect x="0" y="0" width="420" height="540"/></svg>`;

  it('parses mm dimensions and inner body from SVG viewBox', () => {
    const parsed = parseMmSvg(smallSvg);
    expect(parsed.widthMm).toBe(120);
    expect(parsed.heightMm).toBe(150);
    expect(parsed.inner).toContain('marker-end="url(#arrow)"');
  });

  it('fits a small pattern onto a single A4 page with a 50x50 mm scale check square', () => {
    const doc = tileSvgForHomePrint(smallSvg, { paper: 'a4', title: 'Pouch & Flap' });
    expect(doc.cols).toBe(1);
    expect(doc.rows).toBe(1);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].svg).toContain('width="210mm" height="297mm"');
    expect(doc.pages[0].svg).toContain('50 × 50 mm');
    expect(doc.pages[0].svg).toContain('id="arrow_p1"');
    expect(doc.pages[0].svg).toContain('url(#arrow_p1)');
    expect(doc.html).toContain('Pouch &amp; Flap');
    expect(doc.html).toContain('@page { size: A4 portrait; margin: 0; }');
  });

  it('tiles an oversized pattern across overlapping US Letter sheets with join labels', () => {
    const doc = tileSvgForHomePrint(largeSvg, { paper: 'letter', title: 'Bodice Pattern' });
    // US Letter printable area = (215.9 - 24) x (279.4 - 24) = 191.9 x 255.4 mm; step = 181.9 x 245.4 mm.
    // 420 mm wide -> 3 cols; 540 mm tall -> 3 rows => 9 pages.
    expect(doc.cols).toBe(3);
    expect(doc.rows).toBe(3);
    expect(doc.pages).toHaveLength(9);
    expect(doc.pages[0].svg).toContain('50 × 50 mm');
    expect(doc.pages[0].svg).toContain('Join → Row 1 Col 2');
    expect(doc.pages[0].svg).toContain('Join ↓ Row 2 Col 1');
    // Only sheet 1 carries the 50x50 mm ruler box so later sheets stay uncluttered.
    expect(doc.pages[1].svg).not.toContain('50 × 50 mm');
    expect(doc.html).toContain('@page { size: letter portrait; margin: 0; }');
  });
});

describe('Garment pattern seam allowance', () => {
  // 100 mm x 200 mm rectangular panel in metres
  const rectPiece: PatternPiece = {
    name: 'Front Panel',
    uv: [
      [0, 0],
      [0.1, 0],
      [0.1, 0.2],
      [0, 0.2],
    ],
    outline: [0, 1, 2, 3],
    strain95: 0.02,
  };

  it('keeps net sewing outline by default when seamAllowanceMm is 0 or omitted', () => {
    const net = layoutPattern([rectPiece]);
    expect(net.pieces).toHaveLength(1);
    expect(net.pieces[0].w).toBeCloseTo(100, 3);
    expect(net.pieces[0].h).toBeCloseTo(200, 3);
    expect(net.pieces[0].sewPath).toBeUndefined();

    const svg = patternSvg([rectPiece], 'vest');
    expect(svg).toContain('data-operation="cut"');
    expect(svg).not.toContain('stitching line');
  });

  it('grows outer cut line by seamAllowanceMm and emits inner dashed stitching line', () => {
    const withSeam = layoutPattern([rectPiece], { seamAllowanceMm: 12 });
    expect(withSeam.pieces).toHaveLength(1);
    expect(withSeam.pieces[0].w).toBeCloseTo(124, 3);
    expect(withSeam.pieces[0].h).toBeCloseTo(224, 3);
    expect(withSeam.pieces[0].sewPath).toBeDefined();
    expect(withSeam.pieces[0].path).not.toBe(withSeam.pieces[0].sewPath);

    const svg = patternSvg([rectPiece], 'vest', { seamAllowanceMm: 12 });
    expect(svg).toContain('data-operation="cut"');
    expect(svg).toContain('<title>stitching line</title>');
    expect(svg).toContain('+12 mm seam');
  });
});

describe('BuildMenu zero-machine craft access', () => {
  it('exposes Papercraft & leather unfolding at the top of Make regardless of bench machine', () => {
    let unfolded = false;
    const items = buildItems({
      unfold: () => {
        unfolded = true;
      },
      partsList: () => {},
      hasHardware: false,
    });
    expect(items[0].label).toBe('Papercraft & leather');
    items[0].run();
    expect(unfolded).toBe(true);
  });
});
