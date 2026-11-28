import { useMemo, useState } from 'react';
import { Printer, Scissors } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { SceneNode } from '../types/scene';
import type { ModelMirror } from '../types/sceneLayer';
import { layoutPattern, patternSvg } from '../utils/cloth/patternSvg';
import { DEFAULT_PATTERN_OPTIONS, garmentPatternPieces, patternLayoutOptions, patternLines, patternTitle, printPattern, printWidth, stalePatternIds } from '../utils/cloth/patternExport';
import { staleBodies } from '../utils/sceneSummary';
import { modelBuiltFrom } from '../store/modelProvenance';
import { downloadBlob } from '../utils/downloadBlob';
import { openTiledPrintWindow, PAPER_SPECS, type PaperFormat } from '../utils/tiledPaperPrint';
import { layoutRects } from '../utils/cloth/patternSvg';

/** Overlay colours on the pattern preview. */
const OVERLAY = { boning: '#d97706', zipper: '#2563eb', trim: '#334' };

const fileStem = (s: string) => s.trim().replace(/\s+/g, '_') || 'pattern';

/**
 * A garment's sewing pattern to look at, download and print: the pieces its
 * modelled shell was cut into, laid flat. Shared by the garment's Pattern card
 * and the bottom bar's Unfold, so both export the same pattern with the same
 * defaults as MCP's physics_export_cut.
 */
export function GarmentPatternPanel({ nodes, title, fill }: {
  nodes: SceneNode[];
  title: string;
  /** The preview's fill (a fabric print's pattern), else a plain tint. */
  fill?: string;
}) {
  const model = useStore((s) => s.model) as ModelMirror | null;
  const sceneGraph = useStore((s) => s.sceneGraph);
  const sceneNodes = sceneGraph.nodes;
  // Changed since the model was built (the garment or its form): what the model has is the old pattern.
  const stale = useMemo(() => stalePatternIds(nodes, sceneNodes, staleBodies(sceneGraph, model ? modelBuiltFrom().graph : null)).size > 0, [nodes, sceneNodes, sceneGraph, model]);
  const [seamAllowanceMm, setSeamAllowanceMm] = useState<number>(DEFAULT_PATTERN_OPTIONS.seamAllowanceMm);
  const [hemAllowanceMm, setHemAllowanceMm] = useState<number>(DEFAULT_PATTERN_OPTIONS.hemAllowanceMm);
  const [edgeAllowanceMm, setEdgeAllowanceMm] = useState<Record<string, number>>({});
  const [fold, setFold] = useState<boolean>(DEFAULT_PATTERN_OPTIONS.fold);
  const [showEdges, setShowEdges] = useState(false);
  const [paperFormat, setPaperFormat] = useState<PaperFormat>('a4');
  // From the compiled model only: modelling a garment again here would stall the editor.
  const pieces = useMemo(() => garmentPatternPieces(nodes, sceneNodes, model?.flexes, { build: false }).pieces, [nodes, sceneNodes, model]);
  const lines = useMemo(() => patternLines(pieces), [pieces]);
  const opts = useMemo(() => {
    const base = patternLayoutOptions({ seamAllowanceMm, hemAllowanceMm, edgeAllowanceMm, fold });
    return { ...base, titleBlock: patternTitle(nodes, sceneNodes, pieces, base) };
  }, [seamAllowanceMm, hemAllowanceMm, edgeAllowanceMm, fold, nodes, sceneNodes, pieces]);
  const layout = useMemo(() => layoutPattern(pieces, opts), [pieces, opts]);
  const u = layout.width / 250;
  // Packed to print on the fewest pages of the paper chosen, blank pages left out.
  const pages = useMemo(() => (pieces.length ? printWidth(pieces, opts, paperFormat).pages : 0), [pieces, opts, paperFormat]);
  const legend = useMemo(() => {
    const kinds = new Set(layout.pieces.flatMap((p) => p.marks.map((m) => m.kind)));
    const out: [string, string, boolean][] = [];
    if (layout.pieces.some((p) => p.channels.length)) out.push(['Boning', OVERLAY.boning, true]);
    if (kinds.has('zipper')) out.push(['Zip', OVERLAY.zipper, false]);
    const points = [...kinds].filter((k) => k !== 'zipper');
    if (points.length) out.push([points.map((k) => k.charAt(0).toUpperCase() + k.slice(1) + 's').join(', '), OVERLAY.trim, false]);
    return out;
  }, [layout]);
  if (pieces.length === 0) {
    return <div className="text-xs text-slate-500 dark:text-slate-400">Built with the scene; run or rebuild to lay the pieces out.</div>;
  }
  const svg = () => patternSvg(pieces, title, opts);
  return (
    <>
      {stale && (
        <div className="text-[11px] text-amber-700 dark:text-amber-300">Rebuilding the pattern from your changes; this is the previous one, so downloads wait for it.</div>
      )}
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded" preserveAspectRatio="xMidYMid meet">
        {layout.pieces.map((p) => (
          <g key={p.name}>
            <path d={p.path} fillRule="evenodd" fill={fill ?? '#e9eef7'} stroke="#334" strokeWidth={Math.max(0.5, layout.width / 400)} />
            {p.sewPath && (
              <path d={p.sewPath} fill="none" stroke="#7c3aed" strokeWidth={Math.max(0.4, layout.width / 520)} strokeDasharray={`${2.4 * u} ${1.4 * u}`} />
            )}
            {/* Drawn to be seen at this size, in colour (the download keeps true-size lines). */}
            {p.channels.map((d, i) => <path key={`c${i}`} d={d} fill="none" stroke={OVERLAY.boning} strokeWidth={1.6 * u} strokeDasharray={`${3 * u} ${1.5 * u}`} />)}
            {p.darts.map((d, i) => (
              <g key={`d${i}`}>
                {d.stitch && <path d={d.stitch} fill="none" stroke="#7c3aed" strokeWidth={Math.max(0.4, layout.width / 520)} strokeDasharray={`${2.4 * u} ${1.4 * u}`} />}
                {d.points.map((q, j) => <path key={j} d={`M${q.x - 2 * u} ${q.y} L${q.x + 2 * u} ${q.y} M${q.x} ${q.y - 2 * u} L${q.x} ${q.y + 2 * u}`} stroke="#334" strokeWidth={0.7 * u} />)}
              </g>
            ))}
            {p.marks.map((m, i) => (m.kind === 'zipper'
              ? <circle key={i} cx={m.x} cy={m.y} r={1.3 * u} fill={OVERLAY.zipper} />
              : <circle key={i} cx={m.x} cy={m.y} r={Math.max(2 * u, m.r)} fill="#fff" stroke={OVERLAY.trim} strokeWidth={0.7 * u} />))}
            {p.notches.map((n, i) => <line key={`n${i}`} x1={n.x1} y1={n.y1} x2={n.x2} y2={n.y2} stroke="#334" strokeWidth={0.8 * u} />)}
            {p.fold && <line x1={p.fold.x} y1={p.fold.y0} x2={p.fold.x} y2={p.fold.y1} stroke="#16a34a" strokeWidth={1.2 * u} />}
            {p.grain && <line x1={p.grain.x} y1={p.grain.y0} x2={p.grain.x} y2={p.grain.y1} stroke="#94a3b8" strokeWidth={0.6 * u} />}
            <text x={p.label.x} y={p.label.y} fontSize={Math.max(8, layout.width / 45)} textAnchor="middle" fill="#334155">{p.name}</text>
            <text x={p.label.x} y={p.label.y + Math.max(9, layout.width / 40)} fontSize={Math.max(6, layout.width / 60)} textAnchor="middle" fill="#64748b">{p.cut}</text>
          </g>
        ))}
      </svg>
      {legend.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500 dark:text-slate-400">
          {legend.map(([label, colour, dashed]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="inline-block w-3" style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${colour}` }} />{label}
            </span>
          ))}
        </div>
      )}
      <ul className="text-[10px] text-slate-500 dark:text-slate-400 grid grid-cols-2 gap-x-2">
        {layout.pieces.map((p) => (
          <li key={p.name} title="How many to cut, its size with allowances, and how far the fabric must stretch (or be eased and pressed) to take its shape: within the fabric's give it sews as cut; more wants a dart or a stretchier fabric.">
            {p.name}: {p.cut.toLowerCase()}, {Math.round(p.w)}×{Math.round(p.h)} mm{p.strain95 >= 0.02 ? `, stretch to fit ${(p.strain95 * 100).toFixed(0)}%` : ''}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pt-1 border-t border-slate-200/70 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300" title="Outward seam allowance added round every piece (0 mm exports net sewing lines; 6 mm suits overlocked knits; 10–15 mm suits woven seams)">
        <span className="font-medium shrink-0">Seam allowance</span>
        <input
          type="range" min={0} max={25} step={1} value={seamAllowanceMm}
          onChange={(e) => setSeamAllowanceMm(parseInt(e.target.value, 10) || 0)}
          className="flex-1 accent-purple-600 cursor-pointer"
        />
        <span className="tabular-nums font-mono w-11 text-right">{seamAllowanceMm} mm</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300" title="Allowance turned up on the hem, cuffs and leg ends">
        <span className="font-medium shrink-0">Hem allowance</span>
        <input
          type="range" min={0} max={60} step={1} value={hemAllowanceMm}
          onChange={(e) => setHemAllowanceMm(parseInt(e.target.value, 10) || 0)}
          className="flex-1 accent-purple-600 cursor-pointer"
        />
        <span className="tabular-nums font-mono w-11 text-right">{hemAllowanceMm} mm</span>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer" title="Draw each mirrored pair once, to cut 2, and each piece that is the same either side of its middle as a half, to cut on the fold">
        <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} className="accent-purple-600" />
        Pairs once, symmetric pieces on the fold
      </label>
      {lines.length > 0 && (
        <div className="text-[11px] text-slate-600 dark:text-slate-300">
          <button type="button" onClick={() => setShowEdges((v) => !v)} className="font-medium hover:text-purple-600 cursor-pointer" aria-expanded={showEdges}>
            {showEdges ? '▾' : '▸'} Allowance by edge{Object.keys(edgeAllowanceMm).length ? ` (${Object.keys(edgeAllowanceMm).length} set)` : ''}
          </button>
          {showEdges && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1">
              {lines.map((ln) => (
                <label key={ln} className="flex items-center justify-between gap-1" title={`Allowance on ${ln}, mm; empty uses the ${ln === 'hem' || ln === 'end' || ln.startsWith('cuff') ? 'hem' : 'seam'} allowance`}>
                  <span className="truncate">{ln}</span>
                  <input
                    type="number" min={0} max={80} step={1}
                    value={edgeAllowanceMm[ln] ?? ''}
                    placeholder="—"
                    onChange={(e) => setEdgeAllowanceMm((prev) => {
                      const next = { ...prev };
                      const v = parseFloat(e.target.value);
                      if (e.target.value === '' || !Number.isFinite(v) || v < 0) delete next[ln]; else next[ln] = v;
                      return next;
                    })}
                    className="w-14 px-1 py-0.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-right font-mono"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        disabled={stale}
        onClick={() => downloadBlob(new Blob([svg()], { type: 'image/svg+xml' }), `${fileStem(title)}_pattern.svg`)}
        className="flex items-center justify-center gap-2 w-full py-2 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 hover:border-emerald-300 transition-colors shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        title="Download the pieces as a 1:1 millimetre SVG (with seam allowance and dashed stitching line if > 0 mm)"
      >
        <Scissors className="w-4 h-4" /> Download pattern (SVG)
      </button>
      <div className="flex items-center gap-1.5">
        <select
          value={paperFormat}
          onChange={(e) => setPaperFormat(e.target.value as PaperFormat)}
          aria-label="Home printer paper size"
          className="px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg text-[11px] font-semibold bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          {(Object.keys(PAPER_SPECS) as PaperFormat[]).map((k) => <option key={k} value={k}>{PAPER_SPECS[k].label}</option>)}
        </select>
        <button
          type="button"
          disabled={stale}
          onClick={() => {
            const pr = printPattern(pieces, title, opts, paperFormat);
            openTiledPrintWindow(pr.svg, { paper: paperFormat, title: `${title} sewing pattern`, fileStem: `${fileStem(title)}_pattern`, occupied: layoutRects(pr.layout) });
          }}
          className="flex items-center justify-center gap-1.5 flex-1 py-1.5 px-2.5 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          title="Packed to print 1:1 on the fewest pages, blank pages left out, with corner alignment diamonds and a 50 × 50 mm test square"
        >
          <Printer className="w-3.5 h-3.5" /> Print 1:1 ({pages} page{pages === 1 ? '' : 's'})
        </button>
      </div>
    </>
  );
}
