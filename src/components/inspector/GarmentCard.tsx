import { useMemo, useRef } from 'react';
import { ImagePlus, Scissors, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { ClothPatternPrint } from '../../types/cloth';
import type { ModelMirror } from '../../types/sceneLayer';
import { layoutPattern, patternSvg, type PatternPiece } from '../../utils/cloth/patternSvg';
import { downloadBlob } from '../../utils/downloadBlob';

/** Overlay colours on the pattern preview. */
const OVERLAY = { boning: '#d97706', zipper: '#2563eb', trim: '#334' };

/**
 * A garment's pieces to cut and sew: the panels its modelled shell was cut
 * into at its seams, laid flat (the same pieces the cloth is sewn from, so
 * what is shown is what drapes). Downloaded as an SVG in millimetres, and
 * supports importing an SVG fabric print onto the cloth.
 */
export function GarmentCard({ node }: { node: SceneNode }) {
  const model = useStore((s) => s.model) as ModelMirror | null;
  const name = node.name || node.id;
  const pieces = useMemo<PatternPiece[]>(() => (model?.flexes ?? [])
    .filter((f) => f.flat && f.name.slice(0, f.name.lastIndexOf('__')) === name)
    .map((f) => ({ name: f.name.slice(f.name.lastIndexOf('__') + 2), ...f.flat! })), [model, name]);
  const layout = useMemo(() => layoutPattern(pieces), [pieces]);
  // A stroke unit for the overlays, so they read at the card's size whatever the pieces' extent.
  const u = layout.width / 250;
  const legend = useMemo(() => {
    const kinds = new Set(layout.pieces.flatMap((p) => p.marks.map((m) => m.kind)));
    const out: [string, string, boolean][] = [];
    if (layout.pieces.some((p) => p.channels.length)) out.push(['Boning', OVERLAY.boning, true]);
    if (kinds.has('zipper')) out.push(['Zip', OVERLAY.zipper, false]);
    const points = [...kinds].filter((k) => k !== 'zipper');
    if (points.length) out.push([points.map((k) => k.charAt(0).toUpperCase() + k.slice(1) + 's').join(', '), OVERLAY.trim, false]);
    return out;
  }, [layout]);
  const updateNode = useStore((s) => s.updateNode);
  const fileRef = useRef<HTMLInputElement>(null);
  // A garment's print is on its draft; plain cloth's on the cloth. One place each.
  const pattern = node.cloth?.garment ? node.cloth.garment.pattern : node.cloth?.pattern;
  const svgDataUri = useMemo(() => {
    if (!pattern?.svg) return null;
    const raw = pattern.svg.trim();
    if (raw.startsWith('data:')) return raw;
    const withNs = raw.includes('xmlns=') ? raw : raw.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return `data:image/svg+xml;utf8,${encodeURIComponent(withNs)}`;
  }, [pattern]);
  if (!node.cloth) return null;
  const kind = node.cloth.garment?.garment ?? 'cloth';
  const asPieces = node.cloth.layout === 'pieces';
  const setLayout = (layoutMode: 'worn' | 'pieces') => updateNode(node.id, { cloth: { ...node.cloth!, layout: layoutMode } } as Partial<SceneNode>);
  const setPattern = (next: ClothPatternPrint | undefined, settle = false) => {
    if (node.cloth!.garment) {
      updateNode(node.id, { cloth: { ...node.cloth!, garment: { ...node.cloth!.garment, pattern: next } } } as Partial<SceneNode>, false, settle);
    } else {
      updateNode(node.id, { cloth: { ...node.cloth!, pattern: next } } as Partial<SceneNode>, false, settle);
    }
  };
  const onPickSvg = async (file: File | undefined) => {
    if (!file) return;
    const svg = await file.text();
    setPattern({ svg, scale: pattern?.scale ?? 0.25, tile: pattern?.tile ?? true });
  };
  const tileMm = Math.max(20, (pattern?.scale ?? 0.25) * 1000);
  const patternDefId = `cloth-print-${node.id}`;
  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Pattern</label>
        <span className="text-[10px] text-slate-500 dark:text-slate-400">{kind}, {pieces.length} piece{pieces.length === 1 ? '' : 's'}</span>
      </div>
      {node.cloth.garment && (
        <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px] font-semibold">
          {([['worn', 'Worn', 'Sewn and on the form'], ['pieces', 'Pieces', 'Laid out flat round the form; play to sew them up onto it']] as const).map(([id, label, tip]) => (
            <button key={id} onClick={() => setLayout(id)} title={tip}
              className={`flex-1 py-1.5 transition-colors cursor-pointer ${(asPieces ? 'pieces' : 'worn') === id ? 'bg-purple-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input ref={fileRef} type="file" accept=".svg,image/svg+xml" className="hidden" onChange={(e) => { void onPickSvg(e.target.files?.[0]); e.target.value = ''; }} />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center justify-center gap-1.5 flex-1 py-1.5 px-2 border border-slate-200 dark:border-slate-700 rounded-lg text-[11px] font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          title="Import an SVG graphic or motif to print onto the fabric"
        >
          <ImagePlus className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
          {pattern ? 'Change fabric SVG' : 'Import fabric SVG'}
        </button>
        {pattern && (
          <button
            onClick={() => setPattern(undefined)}
            className="p-1.5 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer"
            title="Remove fabric SVG print"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {pattern && (
        <div className="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-300">
          <span>Repeat</span>
          <input
            type="range" min={0.05} max={0.8} step={0.01} value={pattern.scale ?? 0.25}
            onChange={(e) => setPattern({ ...pattern, scale: parseFloat(e.target.value) }, true)}
            className="flex-1 accent-purple-600"
          />
          <span className="tabular-nums w-10 text-right">{Math.round((pattern.scale ?? 0.25) * 100)} cm</span>
        </div>
      )}
      {pieces.length === 0 ? (
        <div className="text-xs text-slate-500 dark:text-slate-400">Built with the scene; run or rebuild to lay the pieces out.</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded" preserveAspectRatio="xMidYMid meet">
            {svgDataUri && (
              <defs>
                <pattern id={patternDefId} patternUnits="userSpaceOnUse" width={tileMm} height={tileMm}>
                  <rect width={tileMm} height={tileMm} fill="#e9eef7" />
                  <image href={svgDataUri} width={tileMm} height={tileMm} preserveAspectRatio="xMidYMid slice" />
                </pattern>
              </defs>
            )}
            {layout.pieces.map((p) => (
              <g key={p.name}>
                <path d={p.path} fillRule="evenodd" fill={svgDataUri ? `url(#${patternDefId})` : '#e9eef7'} stroke="#334" strokeWidth={Math.max(0.5, layout.width / 400)} />
                {/* Drawn to be seen at this size, in colour (the download keeps true-size lines). */}
                {p.channels.map((d, i) => <path key={`c${i}`} d={d} fill="none" stroke={OVERLAY.boning} strokeWidth={1.6 * u} strokeDasharray={`${3 * u} ${1.5 * u}`} />)}
                {p.marks.map((m, i) => (m.kind === 'zipper'
                  ? <circle key={i} cx={m.x} cy={m.y} r={1.3 * u} fill={OVERLAY.zipper} />
                  : <circle key={i} cx={m.x} cy={m.y} r={Math.max(2 * u, m.r)} fill="#fff" stroke={OVERLAY.trim} strokeWidth={0.7 * u} />))}
                <text x={p.x + p.w / 2} y={p.y + p.h + 14} fontSize={Math.max(8, layout.width / 40)} textAnchor="middle" fill="#64748b">{p.name}</text>
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
              <li key={p.name} title="The width and height of the piece, and how far 95% of it had to give to lie flat: under a few percent cuts as it is; more wants a dart or a stretch fabric.">
                {p.name}: {Math.round(p.w)}×{Math.round(p.h)} mm, {(p.strain95 * 100).toFixed(0)}%
              </li>
            ))}
          </ul>
          <button
            onClick={() => downloadBlob(new Blob([patternSvg(pieces, name)], { type: 'image/svg+xml' }), `${name}_pattern.svg`)}
            className="flex items-center justify-center gap-2 w-full py-2 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 hover:border-emerald-300 transition-colors shadow-sm cursor-pointer"
            title="Download the pieces as an SVG in millimetres: outlines with no seam allowance, a grain line up each, named"
          >
            <Scissors className="w-4 h-4" /> Download pattern (SVG)
          </button>
        </>
      )}
    </div>
  );
}
