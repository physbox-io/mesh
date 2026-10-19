/**
 * A picture of the block as it stands for a setup, for someone who has never
 * turned a part over between cuts.
 *
 * Drawn in cabinet projection (the front face square on, depth at half
 * scale going back up and to the right), which reads at a glance without
 * any training: the top, the front and the right-hand face are seen. Each is
 * named as the block stood for setup 1, so "right end up, front towards you"
 * can be matched to the block on the bench. The face the spindle cuts is
 * shaded, faces earlier setups have cut are marked, and the spot to zero on,
 * or the pins, are shown.
 */

import { FACE_NAME, setupFrame, type BlockFace, type StockSize } from './orient';

export interface SetupDiagramInput {
  upFace: BlockFace;
  /** The block as it stood for setup 1. */
  firstStock: StockSize;
  /** Faces earlier setups have cut, named as in setup 1. */
  carved?: BlockFace[];
  locate: 'pins' | 'knownSpot';
  /** Pin centres in this setup's frame, when it is located on pins. */
  pins?: { x: number; y: number }[];
  /** Where this setup cuts, in its own frame: shown on the top. */
  window?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Pixel width of the drawing. */
  widthPx?: number;
}

const DEPTH_SCALE = 0.5;
const ANGLE = Math.PI / 4;

/** Escapes text for SVG. */
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The diagram as an SVG string. Colours come from `currentColor` and two CSS
 * variables with fallbacks, so it follows the app's light and dark themes.
 */
export function setupDiagramSvg(input: SetupDiagramInput): string {
  const frame = setupFrame(input.upFace, input.firstStock);
  const { widthMm: W, depthMm: D, thicknessMm: T } = frame.stock;
  const dx = Math.cos(ANGLE) * DEPTH_SCALE, dy = Math.sin(ANGLE) * DEPTH_SCALE;
  // Model units to the page, with room round the block for the labels: they
  // sit outside it on short leaders, since a block stood on end has faces too
  // narrow to write on.
  const spanX = W + D * dx, spanY = T + D * dy;
  const widthPx = input.widthPx ?? 240;
  const padL = 76, padR = 84, padT = 26, padB = 26;
  const k = Math.min((widthPx - padL - padR) / Math.max(spanX, 1e-6), 150 / Math.max(spanY, 1e-6));
  const heightPx = spanY * k + padT + padB;
  // Bed at the bottom, x to the right, y going back up-right, z up.
  const P = (x: number, y: number, z: number): [number, number] => [
    padL + (x + y * dx) * k,
    heightPx - padB - (z + y * dy) * k,
  ];
  const poly = (pts: [number, number, number][]) =>
    pts.map((p) => P(...p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const text = (x: number, y: number, label: string, anchor: 'start' | 'middle' | 'end', bold = false) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="${bold ? 700 : 500}" fill="currentColor">${esc(label)}</text>`;
  const leader = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="currentColor" stroke-opacity="0.5" stroke-width="0.8"/>`;

  const top: [number, number, number][] = [[0, 0, T], [W, 0, T], [W, D, T], [0, D, T]];
  const front: [number, number, number][] = [[0, 0, 0], [W, 0, 0], [W, 0, T], [0, 0, T]];
  const right: [number, number, number][] = [[W, 0, 0], [W, D, 0], [W, D, T], [W, 0, T]];
  const carved = new Set(input.carved ?? []);
  const name = (f: BlockFace, up = false) =>
    up ? `${FACE_NAME[f]} (cut now)` : carved.has(f) ? `${FACE_NAME[f]} (cut)` : FACE_NAME[f];

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx.toFixed(0)} ${heightPx.toFixed(0)}" ` +
      `width="${widthPx.toFixed(0)}" height="${heightPx.toFixed(0)}" role="img" ` +
      `aria-label="${esc(`Block standing ${FACE_NAME[input.upFace]} up`)}" font-family="system-ui, sans-serif">`,
    '<defs><pattern id="carved" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-opacity="0.35" stroke-width="2"/></pattern></defs>'
  );
  // The bed, so "down" is unmistakable.
  const [bx0, by0] = P(0, 0, 0);
  const bx1 = P(W, D, 0)[0];
  parts.push(`<line x1="${(bx0 - 10).toFixed(1)}" y1="${(by0 + 3).toFixed(1)}" x2="${(bx1 + 10).toFixed(1)}" y2="${(by0 + 3).toFixed(1)}" stroke="currentColor" stroke-opacity="0.4" stroke-width="2"/>`);
  for (const [pts, face, up] of [[front, frame.faceAt.near, false], [right, frame.faceAt.right, false], [top, frame.faceAt.up, true]] as const) {
    const fill = up ? 'var(--setup-up, #3b82f6)' : 'var(--setup-side, #94a3b8)';
    parts.push(`<polygon points="${poly([...pts])}" fill="${fill}" fill-opacity="${up ? 0.55 : 0.2}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`);
    if (carved.has(face)) parts.push(`<polygon points="${poly([...pts])}" fill="url(#carved)"/>`);
  }

  // Labels. The top's above the block, the right-hand face's beside it, the
  // front's under the bed.
  const [tx, ty] = P(W / 2, D / 2, T);
  const topY = P(0, D, T)[1] - 10;
  parts.push(leader(tx, ty, tx, topY + 3), text(tx, topY, name(frame.faceAt.up, true), 'middle', true));
  const [rx, ry] = P(W, D / 2, T / 2);
  const labelX = P(W, D, 0)[0] + 8;
  parts.push(leader(rx, ry, labelX - 2, ry), text(labelX, ry + 4, name(frame.faceAt.right), 'start'));
  const [fx] = P(W / 2, 0, 0);
  parts.push(text(fx, by0 + 18, `${name(frame.faceAt.near)} (towards you)`, 'middle'));

  // Where this setup cuts, outlined on the top.
  if (input.window) {
    const w = input.window;
    parts.push(`<polygon points="${poly([[w.minX, w.minY, T], [w.maxX, w.minY, T], [w.maxX, w.maxY, T], [w.minX, w.maxY, T]])}" fill="none" stroke="var(--setup-up, #3b82f6)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  }

  if (input.locate === 'pins' && input.pins) {
    for (const p of input.pins) {
      const [x, y] = P(p.x, p.y, T);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="var(--setup-datum, #f59e0b)" stroke="currentColor" stroke-width="1"/>`);
    }
    const [x, y] = P(input.pins[0].x, input.pins[0].y, T);
    parts.push(leader(x - 4, y, padL - 4, y), text(padL - 6, y + 4, 'on the pins', 'end', true));
  } else {
    // The near-left corner of the top, where X0 Y0 Z0 goes.
    const [x, y] = P(0, 0, T);
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="var(--setup-datum, #f59e0b)" stroke="currentColor" stroke-width="1"/>`,
      text(x - 8, y + 4, 'zero here', 'end', true)
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

/** What the drawing cannot show, in words: which faces are down and away. */
export function hiddenFaces(upFace: BlockFace, firstStock: StockSize): string {
  const f = setupFrame(upFace, firstStock).faceAt;
  return `On the bed: ${FACE_NAME[f.down]}. Away from you: ${FACE_NAME[f.far]}. On your left: ${FACE_NAME[f.left]}.`;
}
