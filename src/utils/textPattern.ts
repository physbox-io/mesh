// ---------------------------------------------------------------------------
// Text, as a surface pattern: lettering engraved into a face or embossed on
// it, in any Google font, straight, on an arc, on a wave or along a path.
//
// It goes on a face the way every other pattern does (surfaceTexture.ts), so
// it follows a cylinder round, is drawn and exported with the part, and goes
// to the laser's engrave layer and the CNC carve with nothing written for it.
//
// The font is only needed once: `prepare` fetches it, lays the text out and
// saves the outline in the options (textOutline.ts). `build` fills that
// outline in on whatever grid it is given and needs nothing else.
// ---------------------------------------------------------------------------

import { num, str, type PatternOptions, type PatternSpec } from './patternKit';
import {
  decodeContours,
  encodeContours,
  fillContours,
  layoutText,
  type TextAlign,
  type TextLayout,
  type TextPath,
} from './textOutline';
import { DEFAULT_FONT, loadFont } from './fontLibrary';

/** Option keys the outline depends on: change one and it is laid out again. */
const LAYOUT_KEYS = [
  'text', 'fontFamily', 'fontWeight', 'heightMm', 'letterSpacingMm', 'lineSpacing', 'align',
  'path', 'arcRadiusMm', 'arcSide', 'waveAmpMm', 'waveLengthMm', 'pathD', 'pathAlign', 'pathOffsetMm',
  'boxMm', 'boxPadMm',
] as const;

/** What the saved outline was laid out from. */
export function textSignature(opts: PatternOptions): string {
  return JSON.stringify(LAYOUT_KEYS.map((k) => opts[k] ?? null));
}

/** True when the saved outline is the one these options describe. */
export function hasFreshOutline(opts: PatternOptions): boolean {
  return typeof opts.outline === 'string' && opts.outlineSig === textSignature(opts);
}

export function textLayoutOf(opts: PatternOptions): TextLayout {
  return {
    text: str(opts, 'text', ''),
    heightMm: num(opts, 'heightMm', 8),
    letterSpacingMm: num(opts, 'letterSpacingMm', 0),
    lineSpacing: num(opts, 'lineSpacing', 1.6),
    align: str(opts, 'align', 'centre') as TextAlign,
    weight: num(opts, 'fontWeight', 400),
    path: str(opts, 'path', 'straight') as TextPath,
    arcRadiusMm: num(opts, 'arcRadiusMm', 30),
    arcSide: str(opts, 'arcSide', 'top') === 'bottom' ? 'bottom' : 'top',
    waveAmpMm: num(opts, 'waveAmpMm', 4),
    waveLengthMm: num(opts, 'waveLengthMm', 40),
    pathD: str(opts, 'pathD', ''),
    pathAlign: str(opts, 'pathAlign', 'centre') as TextLayout['pathAlign'],
    pathOffsetMm: num(opts, 'pathOffsetMm', 0),
    boxMm: num(opts, 'boxMm', 0),
    boxPadMm: num(opts, 'boxPadMm', 3),
  };
}

const onPath = (...paths: TextPath[]) => ({ key: 'path', is: paths });

export const TEXT_PATTERN: PatternSpec = {
  id: 'text',
  group: 'Lettering',
  label: 'Text',
  blurb: 'Lettering in any Google font, engraved into the face or raised from it, straight or along a curve.',
  caveat: 'Strokes thinner than the cutter cannot be machined: keep letters at least a few millimetres tall for a CNC.',
  figure: true,
  flatTopped: true,
  defaults: {
    text: 'Mesh',
    fontFamily: DEFAULT_FONT,
    fontWeight: '700',
    heightMm: 8,
    letterSpacingMm: 0,
    lineSpacing: 1.6,
    align: 'centre',
    path: 'straight',
    arcRadiusMm: 25,
    arcSide: 'top',
    waveAmpMm: 3,
    waveLengthMm: 40,
    pathD: '',
    pathAlign: 'centre',
    pathOffsetMm: 0,
    offsetXMm: 0,
    offsetYMm: 0,
    boxMm: 0,
    boxPadMm: 3,
  },
  fields: [
    { kind: 'text', key: 'text', label: 'Text', multiline: true, placeholder: 'Type the lettering' },
    { kind: 'font', key: 'fontFamily', label: 'Font', hint: 'Any family in the Google Fonts library.' },
    {
      kind: 'choice', key: 'fontWeight', label: 'Weight', options: [
        { value: '300', label: 'Light' }, { value: '400', label: 'Regular' }, { value: '500', label: 'Medium' },
        { value: '700', label: 'Bold' }, { value: '900', label: 'Black' },
      ],
      hint: 'Heavier letters carve and print more cleanly. A family without that weight uses its nearest.',
    },
    { kind: 'number', key: 'heightMm', label: 'Letter height', min: 0.5, max: 500, step: 0.5, unit: 'mm',
      hint: 'The height of a capital letter.' },
    { kind: 'number', key: 'letterSpacingMm', label: 'Letter spacing', min: -20, max: 100, step: 0.1, unit: 'mm' },
    {
      kind: 'choice', key: 'path', label: 'Runs', section: 'Path', options: [
        { value: 'straight', label: 'Straight' },
        { value: 'arc', label: 'Round a circle' },
        { value: 'wave', label: 'On a wave' },
        { value: 'custom', label: 'Along an SVG path' },
      ],
      hint: 'The line the lettering follows. Each letter stands square to it.',
    },
    { kind: 'number', key: 'lineSpacing', label: 'Line spacing', min: 1, max: 5, step: 0.1, unit: '×',
      hint: 'Baseline to baseline, in letter heights.', when: onPath('straight') },
    {
      kind: 'choice', key: 'align', label: 'Align lines', options: [
        { value: 'left', label: 'Left' }, { value: 'centre', label: 'Centre' }, { value: 'right', label: 'Right' },
      ],
      when: onPath('straight'),
    },
    { kind: 'number', key: 'arcRadiusMm', label: 'Radius', min: 1, max: 2000, step: 0.5, unit: 'mm',
      hint: 'Of the circle the letters stand on; text under the bottom hangs from the same ring.', when: onPath('arc') },
    {
      kind: 'choice', key: 'arcSide', label: 'Side', options: [
        { value: 'top', label: 'Over the top' }, { value: 'bottom', label: 'Under the bottom' },
      ],
      hint: 'Put one of each on a face for a seal: both read upright and share the ring.', when: onPath('arc'),
    },
    { kind: 'number', key: 'waveAmpMm', label: 'Wave height', min: 0, max: 500, step: 0.5, unit: 'mm', when: onPath('wave') },
    { kind: 'number', key: 'waveLengthMm', label: 'Wavelength', min: 2, max: 2000, step: 1, unit: 'mm', when: onPath('wave') },
    { kind: 'text', key: 'pathD', label: 'SVG path (mm)', placeholder: 'M 0 0 C 30 -30 70 -30 100 0',
      hint: 'An SVG path in millimetres, y down as SVG draws it: paste one from Etch or Inkscape. The text runs along it left to right.',
      when: onPath('custom') },
    {
      kind: 'choice', key: 'pathAlign', label: 'Along the path', options: [
        { value: 'start', label: 'From the start' }, { value: 'centre', label: 'Centred' }, { value: 'end', label: 'To the end' },
      ],
      when: onPath('custom'),
    },
    { kind: 'number', key: 'pathOffsetMm', label: 'Slide along', min: -2000, max: 2000, step: 1, unit: 'mm',
      hint: 'Moves the text along its path; on a circle, round it.', when: onPath('arc', 'wave', 'custom') },
    { kind: 'number', key: 'offsetXMm', label: 'Move across', min: -2000, max: 2000, step: 0.5, unit: 'mm', section: 'Place',
      hint: 'From the middle of the face.' },
    { kind: 'number', key: 'offsetYMm', label: 'Move up', min: -2000, max: 2000, step: 0.5, unit: 'mm' },
    { kind: 'number', key: 'boxMm', label: 'Box line', min: 0, max: 50, step: 0.5, unit: 'mm',
      hint: 'A rectangle round the text, this thick, cut or raised with it. 0 for none.', when: onPath('straight') },
    { kind: 'number', key: 'boxPadMm', label: 'Box gap', min: 0, max: 200, step: 0.5, unit: 'mm', when: onPath('straight') },
  ],
  async prepare(opts) {
    const o = { ...TEXT_PATTERN.defaults, ...opts };
    if (hasFreshOutline(o)) return o;
    const family = str(o, 'fontFamily', DEFAULT_FONT).trim() || DEFAULT_FONT;
    const font = await loadFont(family, num(o, 'fontWeight', 400), str(o, 'text', ''));
    const contours = layoutText(font, textLayoutOf(o));
    return { ...o, outline: encodeContours(contours), outlineSig: textSignature(o) };
  },
  build(cols, rows, extent, opts) {
    const outline = str(opts, 'outline', '');
    if (!outline || cols < 1 || rows < 1) return new Float32Array(cols * rows);
    const contours = decodeContours(outline);
    // Pattern space is metres; the outline is mm, centred on the board's middle.
    const dx = cols > 1 ? (extent.widthM * 1000) / (cols - 1) : 1;
    const dy = rows > 1 ? (extent.depthM * 1000) / (rows - 1) : 1;
    const x0 = -(extent.widthM * 1000) / 2 - num(opts, 'offsetXMm', 0);
    const y0 = -(extent.depthM * 1000) / 2 - num(opts, 'offsetYMm', 0);
    return fillContours(contours, cols, rows, x0, y0, dx, dy);
  },
};
