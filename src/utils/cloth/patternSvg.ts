/**
 * A garment's pieces laid out to cut: each flattened panel (garmentFlatten)
 * as an outline, side by side with its name, a grain line (up the body) and
 * how far it had to give to lie flat. Millimetres, as a cutter reads them.
 */

export interface PatternPiece {
  name: string;
  /** Flat positions, metres. */
  uv: [number, number][];
  /** Indices into `uv`, in order round the piece. */
  outline: number[];
  strain95: number;
  /** Trims on the piece, by point index. */
  marks?: { kind: string; particle: number; size: number }[];
  /** Boning channels, as runs of point indices. */
  lines?: number[][];
  /** Double-ended darts inside the outline, as loops of point indices: drawn as part of its outline. */
  darts?: number[][];
}

export interface PatternLayout {
  pieces: { name: string; strain95: number; x: number; y: number; w: number; h: number; path: string; marks: { kind: string; x: number; y: number; r: number }[]; channels: string[] }[];
  width: number;
  height: number;
}

const MM = 1000, GAP = 30, MARGIN = 20;

/** The pieces in a row, each in its own box; everything in mm, y down the page. */
export function layoutPattern(pieces: PatternPiece[]): PatternLayout {
  let x = MARGIN, height = 0;
  const out: PatternLayout['pieces'] = [];
  for (const p of [...pieces].sort((a, b) => a.name.localeCompare(b.name))) {
    if (p.outline.length < 3) continue;
    const pts = p.outline.map((i) => p.uv[i]);
    const u0 = Math.min(...pts.map((q) => q[0])), u1 = Math.max(...pts.map((q) => q[0]));
    const v0 = Math.min(...pts.map((q) => q[1])), v1 = Math.max(...pts.map((q) => q[1]));
    const w = (u1 - u0) * MM, h = (v1 - v0) * MM;
    const X = (u: number) => x + (u - u0) * MM, Y = (v: number) => MARGIN + (v1 - v) * MM;
    const loop = (ids: number[]) => ids.map((i, k) => `${k ? 'L' : 'M'}${X(p.uv[i][0]).toFixed(1)} ${Y(p.uv[i][1]).toFixed(1)}`).join(' ') + ' Z';
    const path = [p.outline, ...(p.darts ?? [])].map(loop).join(' ');
    // Placement marks for what is sewn on at a point; topstitching is sewn after, not marked.
    const marks = (p.marks ?? []).filter((m) => m.kind !== 'stitch').map((m) => ({ kind: m.kind, x: X(p.uv[m.particle][0]), y: Y(p.uv[m.particle][1]), r: (m.size * MM) / 2 }));
    const channels = (p.lines ?? []).map((run) => run.map((i, k) => `${k ? 'L' : 'M'}${X(p.uv[i][0]).toFixed(1)} ${Y(p.uv[i][1]).toFixed(1)}`).join(' '));
    out.push({ name: p.name, strain95: p.strain95, x, y: MARGIN, w, h, path, marks, channels });
    x += w + GAP;
    height = Math.max(height, h);
  }
  return { pieces: out, width: x - GAP + MARGIN, height: height + 2 * MARGIN + 24 };
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The layout as an SVG document, 1 unit = 1 mm. */
export function patternSvg(pieces: PatternPiece[], title = 'pattern'): string {
  const L = layoutPattern(pieces);
  const body = L.pieces.map((p) => {
    const gx = p.x + p.w / 2, g0 = p.y + p.h * 0.25, g1 = p.y + p.h * 0.75;
    return [
      `<path d="${p.path}" fill="none" stroke="#000" stroke-width="0.5"/>`,
      ...p.channels.map((d) => `<path d="${d}" fill="none" stroke="#000" stroke-width="0.4" stroke-dasharray="3 1.5"><title>boning channel</title></path>`),
      ...p.marks.map((m) => `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${Math.max(0.8, m.r).toFixed(1)}" fill="${m.kind === 'zipper' ? '#000' : 'none'}" stroke="#000" stroke-width="0.4"><title>${escXml(m.kind)}</title></circle>`),
      `<line x1="${gx.toFixed(1)}" y1="${g1.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${g0.toFixed(1)}" stroke="#888" stroke-width="0.4" marker-end="url(#arrow)"/>`,
      `<text x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + p.h + 14).toFixed(1)}" font-size="8" font-family="sans-serif" text-anchor="middle">${escXml(p.name)} · ${Math.round(p.w)}×${Math.round(p.h)} mm · ease to lie flat ${(p.strain95 * 100).toFixed(0)}%</text>`,
    ].join('\n');
  }).join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width.toFixed(0)}mm" height="${L.height.toFixed(0)}mm" viewBox="0 0 ${L.width.toFixed(1)} ${L.height.toFixed(1)}">`,
    `<title>${escXml(title)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#888"/></marker></defs>`,
    body,
    `</svg>`,
  ].join('\n');
}
