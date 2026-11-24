// ---------------------------------------------------------------------------
// True-scale 1:1 home-printer tiling (A4 / US Letter) for flat SVG patterns
// ---------------------------------------------------------------------------
//
// Many beginners making papercraft, hand-stitched leather goods, or sewn
// garments do not own a laser cutter or large-format plotter — they own an
// inkjet or laser office printer. Browsers scale oversized SVGs to fit a single
// sheet unless sliced into printable pages.
//
// `tileSvgForHomePrint` slices any millimetre-unit SVG (`viewBox="0 0 W H"`)
// into overlapping A4 (210×297 mm) or US Letter (215.9×279.4 mm) pages with:
//   - Crop borders around the printable safe area
//   - Numbered corner alignment diamonds across adjacent sheets (R1·C1, R1·C2…)
//   - A 50 × 50 mm scale-verification square on Sheet 1 ("Measure 50 mm — print
//     at 100% / Actual Size")
//
// `openTiledPrintWindow` opens a clean print-ready multi-page HTML document in
// a new tab/window (or downloads it as a standalone `.html` printable packet
// when pop-ups are blocked).

export type PaperFormat = 'a4' | 'letter';

export interface PaperSpec {
  id: PaperFormat;
  label: string;
  widthMm: number;
  heightMm: number;
  /** Safe printer margin around all four sides in mm. */
  marginMm: number;
  /** Overlap between adjacent tiles in mm so glue/tape seams line up easily. */
  overlapMm: number;
}

export const PAPER_SPECS: Record<PaperFormat, PaperSpec> = {
  a4: {
    id: 'a4',
    label: 'A4 (210 × 297 mm)',
    widthMm: 210,
    heightMm: 297,
    marginMm: 12,
    overlapMm: 10,
  },
  letter: {
    id: 'letter',
    label: 'US Letter (8.5 × 11 in)',
    widthMm: 215.9,
    heightMm: 279.4,
    marginMm: 12,
    overlapMm: 10,
  },
};

export interface TiledPage {
  row: number;
  col: number;
  pageNumber: number;
  totalPages: number;
  /** Crop origin in source SVG mm. */
  srcX: number;
  srcY: number;
  /** Printable window size in mm. */
  tileW: number;
  tileH: number;
  svg: string;
}

export interface TiledPrintDocument {
  paper: PaperSpec;
  cols: number;
  rows: number;
  pages: TiledPage[];
  html: string;
}

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Extracts inner markup and viewBox dimensions from a millimetre SVG string. */
export function parseMmSvg(svg: string): {
  minX: number;
  minY: number;
  widthMm: number;
  heightMm: number;
  inner: string;
} {
  const svgOpen = /<svg\b[^>]*>/i.exec(svg);
  const header = svgOpen ? svgOpen[0] : svg;
  const vbMatch =
    /viewBox=["']\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(?:[\s,]+)([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(?:[\s,]+)([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(?:[\s,]+)([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*["']/i.exec(
      header
    );
  const wMatch = /\bwidth=["']\s*([\d.]+)\s*(?:mm)?\s*["']/i.exec(header);
  const hMatch = /\bheight=["']\s*([\d.]+)\s*(?:mm)?\s*["']/i.exec(header);
  const minX = vbMatch ? parseFloat(vbMatch[1]) : 0;
  const minY = vbMatch ? parseFloat(vbMatch[2]) : 0;
  const widthMm = Math.max(1, vbMatch ? parseFloat(vbMatch[3]) : wMatch ? parseFloat(wMatch[1]) : 200);
  const heightMm = Math.max(1, vbMatch ? parseFloat(vbMatch[4]) : hMatch ? parseFloat(hMatch[1]) : 200);
  const openEnd = svgOpen ? svgOpen.index + svgOpen[0].length : -1;
  const closeStart = svg.lastIndexOf('</svg>');
  const inner =
    openEnd >= 0 && closeStart >= openEnd ? svg.slice(openEnd, closeStart) : svg;
  return { minX, minY, widthMm, heightMm, inner };
}

/**
 * Slices a millimetre SVG into 1:1 printable A4 or US Letter pages.
 */
export function tileSvgForHomePrint(
  sourceSvg: string,
  options?: { paper?: PaperFormat; title?: string }
): TiledPrintDocument {
  const paper = PAPER_SPECS[options?.paper ?? 'a4'];
  const title = options?.title?.trim() || '1:1 Pattern';
  const { minX, minY, widthMm, heightMm, inner } = parseMmSvg(sourceSvg);

  const printableW = paper.widthMm - 2 * paper.marginMm;
  const printableH = paper.heightMm - 2 * paper.marginMm;
  const stepX = Math.max(20, printableW - paper.overlapMm);
  const stepY = Math.max(20, printableH - paper.overlapMm);
  const halfOverlapX = (printableW - stepX) / 2;
  const halfOverlapY = (printableH - stepY) / 2;

  const cols = Math.max(1, widthMm <= printableW ? 1 : 1 + Math.ceil((widthMm - printableW) / stepX));
  const rows = Math.max(1, heightMm <= printableH ? 1 : 1 + Math.ceil((heightMm - printableH) / stepY));
  const totalPages = cols * rows;

  const fmt = (n: number) => Number(n.toFixed(2));
  const pages: TiledPage[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const pageNumber = r * cols + c + 1;
      const srcX = c * stepX;
      const srcY = r * stepY;
      const clipId = `tile-clip-${r}-${c}`;

      // Corner alignment diamonds at the shared seam corners so mating diamonds
      // across adjacent sheets sit at identical source coordinates, leaving the
      // outer half-overlap strip outside each interior seam as a glue/tape tab.
      const diamond = (cx: number, cy: number) =>
        `<polygon points="${fmt(cx)},${fmt(cy - 3.5)} ${fmt(cx + 3.5)},${fmt(cy)} ${fmt(cx)},${fmt(cy + 3.5)} ${fmt(cx - 3.5)},${fmt(cy)}" fill="none" stroke="#0f172a" stroke-width="0.35"/>` +
        `<line x1="${fmt(cx - 4.5)}" y1="${fmt(cy)}" x2="${fmt(cx + 4.5)}" y2="${fmt(cy)}" stroke="#0f172a" stroke-width="0.25"/>` +
        `<line x1="${fmt(cx)}" y1="${fmt(cy - 4.5)}" x2="${fmt(cx)}" y2="${fmt(cy + 4.5)}" stroke="#0f172a" stroke-width="0.25"/>`;

      const mx = paper.marginMm;
      const my = paper.marginMm;
      const rx = mx + printableW;
      const by = my + printableH;

      const seamL = c > 0 ? mx + halfOverlapX : mx;
      const seamR = c < cols - 1 ? rx - halfOverlapX : rx;
      const seamT = r > 0 ? my + halfOverlapY : my;
      const seamB = r < rows - 1 ? by - halfOverlapY : by;

      // Namespace SVG ids per tile so defs (like arrow markers) don't collide across pages.
      const scopedInner = inner
        .replace(/\bid="([^"]+)"/g, `id="$1_p${pageNumber}"`)
        .replace(/url\(#([^)]+)\)/g, `url(#$1_p${pageNumber})`);

      const scaleBox =
        pageNumber === 1
          ? [
              `<g transform="translate(${fmt(seamR - 54)}, ${fmt(seamB - 54)})">`,
              `  <rect x="0" y="0" width="50" height="50" fill="rgba(255,255,255,0.88)" stroke="#0f172a" stroke-width="0.45"/>`,
              `  <line x1="0" y1="25" x2="50" y2="25" stroke="#94a3b8" stroke-width="0.25" stroke-dasharray="2,1.5"/>`,
              `  <text x="25" y="21" font-family="sans-serif" font-size="3.4" font-weight="bold" text-anchor="middle" fill="#0f172a">50 × 50 mm</text>`,
              `  <text x="25" y="31" font-family="sans-serif" font-size="2.8" text-anchor="middle" fill="#475569">Check with ruler</text>`,
              `  <text x="25" y="36" font-family="sans-serif" font-size="2.6" text-anchor="middle" fill="#475569">(Print at 100%)</text>`,
              `</g>`,
            ].join('\n')
          : '';

      const neighborHints: string[] = [];
      if (c < cols - 1) {
        const hintX = seamR + halfOverlapX / 2;
        const hintY = (seamT + seamB) / 2;
        neighborHints.push(
          `<text x="${fmt(hintX)}" y="${fmt(hintY)}" transform="rotate(90 ${fmt(hintX)} ${fmt(hintY)})" font-family="sans-serif" font-size="2.8" text-anchor="middle" fill="#64748b">Join → Row ${r + 1} Col ${c + 2}</text>`
        );
      }
      if (r < rows - 1) {
        const hintX = (seamL + seamR) / 2;
        const hintY = seamB + halfOverlapY / 2 + 1;
        neighborHints.push(
          `<text x="${fmt(hintX)}" y="${fmt(hintY)}" font-family="sans-serif" font-size="2.8" text-anchor="middle" fill="#64748b">Join ↓ Row ${r + 2} Col ${c + 1}</text>`
        );
      }

      const pageSvg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(paper.widthMm)}mm" height="${fmt(paper.heightMm)}mm" viewBox="0 0 ${fmt(paper.widthMm)} ${fmt(paper.heightMm)}">`,
        `  <defs>`,
        `    <clipPath id="${clipId}"><rect x="${fmt(mx)}" y="${fmt(my)}" width="${fmt(printableW)}" height="${fmt(printableH)}"/></clipPath>`,
        `  </defs>`,
        `  <rect x="0" y="0" width="${fmt(paper.widthMm)}" height="${fmt(paper.heightMm)}" fill="#ffffff"/>`,
        `  <g clip-path="url(#${clipId})">`,
        `    <g transform="translate(${fmt(mx - srcX - minX)}, ${fmt(my - srcY - minY)})">`,
        scopedInner,
        `    </g>`,
        `  </g>`,
        `  <rect x="${fmt(seamL)}" y="${fmt(seamT)}" width="${fmt(seamR - seamL)}" height="${fmt(seamB - seamT)}" fill="none" stroke="#94a3b8" stroke-width="0.25" stroke-dasharray="3,2"/>`,
        `  ${diamond(seamL, seamT)}`,
        `  ${diamond(seamR, seamT)}`,
        `  ${diamond(seamL, seamB)}`,
        `  ${diamond(seamR, seamB)}`,
        `  <text x="${fmt(mx + 2)}" y="${fmt(my - 3)}" font-family="monospace" font-size="3.2" fill="#334155">${escXml(title)} · Page ${pageNumber}/${totalPages} (Row ${r + 1}, Col ${c + 1})</text>`,
        ...neighborHints.map((h) => `  ${h}`),
        scaleBox,
        `</svg>`,
      ]
        .filter(Boolean)
        .join('\n');

      pages.push({
        row: r + 1,
        col: c + 1,
        pageNumber,
        totalPages,
        srcX,
        srcY,
        tileW: printableW,
        tileH: printableH,
        svg: pageSvg,
      });
    }
  }

  const pageSizeCss = paper.id === 'a4' ? 'A4 portrait' : 'letter portrait';
  const html = [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="UTF-8">`,
    `  <title>${escXml(title)} — 1:1 Tiled Print (${paper.label})</title>`,
    `  <style>`,
    `    @page { size: ${pageSizeCss}; margin: 0; }`,
    `    * { box-sizing: border-box; }`,
    `    body { margin: 0; padding: 0; background: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; color: #0f172a; }`,
    `    .print-bar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; background: #0f172a; color: #f8fafc; box-shadow: 0 2px 10px rgba(0,0,0,0.2); }`,
    `    .print-bar strong { font-size: 14px; }`,
    `    .print-bar span { font-size: 12px; color: #cbd5e1; }`,
    `    .print-btn { background: #10b981; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-weight: 700; font-size: 13px; cursor: pointer; }`,
    `    .print-btn:hover { background: #059669; }`,
    `    .sheets { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 20px; }`,
    `    .sheet { background: #fff; box-shadow: 0 4px 18px rgba(15,23,42,0.15); line-height: 0; }`,
    `    @media print {`,
    `      body { background: #fff; }`,
    `      .print-bar { display: none !important; }`,
    `      .sheets { display: block; padding: 0; gap: 0; }`,
    `      .sheet { box-shadow: none; page-break-after: always; break-after: page; margin: 0; }`,
    `      .sheet:last-child { page-break-after: auto; break-after: auto; }`,
    `    }`,
    `  </style>`,
    `</head>`,
    `<body>`,
    `  <div class="print-bar">`,
    `    <div>`,
    `      <strong>${escXml(title)} · ${totalPages} ${totalPages === 1 ? 'sheet' : 'sheets'} (${rows}×${cols} grid, ${paper.label})</strong><br>`,
    `      <span>In your printer dialog, set <b>Scale: 100% / Actual Size</b> and <b>Margins: None</b>. Verify the 50 × 50 mm square on Page 1 with a ruler, trim along the dashed seam lines (leaving the outer overlap strip as a glue/tape tab if desired), and match the corner diamonds.</span>`,
    `    </div>`,
    `    <button class="print-btn" onclick="window.print()">Print 1:1 Sheets</button>`,
    `  </div>`,
    `  <div class="sheets">`,
    ...pages.map((p) => `    <div class="sheet">${p.svg}</div>`),
    `  </div>`,
    `</body>`,
    `</html>`,
  ].join('\n');

  return { paper, cols, rows, pages, html };
}

/**
 * Opens the tiled 1:1 printable sheets in a new tab ready to print, or falls
 * back to downloading the self-contained `.html` print packet if pop-ups are blocked.
 */
export function openTiledPrintWindow(
  sourceSvg: string,
  options?: { paper?: PaperFormat; title?: string; fileStem?: string }
): void {
  const doc = tileSvgForHomePrint(sourceSvg, options);
  const blob = new Blob([doc.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(options?.fileStem || 'pattern').replace(/\s+/g, '_')}_${doc.paper.id}_tiled.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } else {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
