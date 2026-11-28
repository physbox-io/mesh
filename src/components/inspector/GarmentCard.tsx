import { useMemo, useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { ClothPatternPrint } from '../../types/cloth';
import type { ModelMirror } from '../../types/sceneLayer';
import { RangeInput } from '../RangeInput';
import { GarmentPatternPanel } from '../GarmentPatternPanel';

/**
 * A garment's pieces to cut and sew: the panels its modelled shell was cut
 * into at its seams, laid flat (the same pieces the cloth is sewn from, so
 * what is shown is what drapes). Downloaded as an SVG in millimetres, and
 * supports importing an SVG fabric print onto the cloth.
 */
export function GarmentCard({ node }: { node: SceneNode }) {
  const model = useStore((s) => s.model) as ModelMirror | null;
  const name = node.name || node.id;
  const nodes = useMemo(() => [node], [node]);
  const pieceCount = useMemo(() => (model?.flexes ?? []).filter((f) => f.flat && f.name.slice(0, f.name.lastIndexOf('__')) === name).length, [model, name]);
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
        <span className="text-[10px] text-slate-500 dark:text-slate-400">{kind}, {pieceCount} piece{pieceCount === 1 ? '' : 's'}</span>
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
          <RangeInput
            min={0.05} max={0.8} step={0.01} value={pattern.scale ?? 0.25}
            onChange={(v) => setPattern({ ...pattern, scale: v }, true)}
            className="flex-1 accent-purple-600 cursor-pointer"
          />
          <span className="tabular-nums w-10 text-right">{Math.round((pattern.scale ?? 0.25) * 100)} cm</span>
        </div>
      )}
      {svgDataUri && (
        <svg width="0" height="0" className="absolute" aria-hidden>
          <defs>
            <pattern id={patternDefId} patternUnits="userSpaceOnUse" width={tileMm} height={tileMm}>
              <rect width={tileMm} height={tileMm} fill="#e9eef7" />
              <image href={svgDataUri} width={tileMm} height={tileMm} preserveAspectRatio="xMidYMid slice" />
            </pattern>
          </defs>
        </svg>
      )}
      <GarmentPatternPanel nodes={nodes} title={name} fill={svgDataUri ? `url(#${patternDefId})` : undefined} />
    </div>
  );
}
