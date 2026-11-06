import { useMemo } from 'react';
import { Scissors } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { ModelMirror } from '../../types/sceneLayer';
import { layoutPattern, patternSvg, type PatternPiece } from '../../utils/cloth/patternSvg';
import { downloadBlob } from '../../utils/downloadBlob';

/**
 * A garment's pieces to cut and sew: the panels its modelled shell was cut
 * into at its seams, laid flat (the same pieces the cloth is sewn from, so
 * what is shown is what drapes). Downloaded as an SVG in millimetres.
 */
export function GarmentCard({ node }: { node: SceneNode }) {
  const model = useStore((s) => s.model) as ModelMirror | null;
  const name = node.name || node.id;
  const pieces = useMemo<PatternPiece[]>(() => (model?.flexes ?? [])
    .filter((f) => f.flat && f.name.startsWith(`${name}__`))
    .map((f) => ({ name: f.name.slice(name.length + 2), ...f.flat! })), [model, name]);
  const layout = useMemo(() => layoutPattern(pieces), [pieces]);
  const updateNode = useStore((s) => s.updateNode);
  if (!node.cloth?.garment) return null;
  const kind = node.cloth.garment.garment;
  const asPieces = node.cloth.layout === 'pieces';
  const setLayout = (layout: 'worn' | 'pieces') => updateNode(node.id, { cloth: { ...node.cloth!, layout } } as Partial<SceneNode>);
  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Pattern</label>
        <span className="text-[10px] text-slate-500">{kind}, {pieces.length} piece{pieces.length === 1 ? '' : 's'}</span>
      </div>
      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-[11px] font-semibold">
        {([['worn', 'Worn', 'Sewn and on the form'], ['pieces', 'Pieces', 'Laid out flat round the form; play to sew them up onto it']] as const).map(([id, label, tip]) => (
          <button key={id} onClick={() => setLayout(id)} title={tip}
            className={`flex-1 py-1.5 transition-colors cursor-pointer ${(asPieces ? 'pieces' : 'worn') === id ? 'bg-purple-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}>
            {label}
          </button>
        ))}
      </div>
      {pieces.length === 0 ? (
        <div className="text-xs text-slate-500">Built with the scene; run or rebuild to lay the pieces out.</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full bg-white border border-slate-200 rounded" preserveAspectRatio="xMidYMid meet">
            {layout.pieces.map((p) => (
              <g key={p.name}>
                <path d={p.path} fill="#e9eef7" stroke="#334" strokeWidth={Math.max(0.5, layout.width / 400)} />
                {p.marks.map((m, i) => <circle key={i} cx={m.x} cy={m.y} r={Math.max(layout.width / 300, m.r)} fill={m.kind === 'zipper' ? '#667' : '#fff'} stroke="#334" strokeWidth={layout.width / 600} />)}
                <text x={p.x + p.w / 2} y={p.y + p.h + 14} fontSize={Math.max(8, layout.width / 40)} textAnchor="middle" fill="#334">{p.name}</text>
              </g>
            ))}
          </svg>
          <ul className="text-[10px] text-slate-500 grid grid-cols-2 gap-x-2">
            {layout.pieces.map((p) => (
              <li key={p.name} title="The width and height of the piece, and how far 95% of it had to give to lie flat: under a few percent cuts as it is; more wants a dart or a stretch fabric.">
                {p.name}: {Math.round(p.w)}×{Math.round(p.h)} mm, {(p.strain95 * 100).toFixed(0)}%
              </li>
            ))}
          </ul>
          <button
            onClick={() => downloadBlob(new Blob([patternSvg(pieces, name)], { type: 'image/svg+xml' }), `${name}_pattern.svg`)}
            className="flex items-center justify-center gap-2 w-full py-2 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-300 transition-colors shadow-sm cursor-pointer"
            title="Download the pieces as an SVG in millimetres: outlines with no seam allowance, a grain line up each, named"
          >
            <Scissors className="w-4 h-4" /> Download pattern (SVG)
          </button>
        </>
      )}
    </div>
  );
}
