import { Volume2 } from 'lucide-react';
import { SliderValue } from '../SliderValue';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { ClothMaterialName, ClothSpec } from '../../types/cloth';
import { CLOTH_MATERIALS } from '../../utils/cloth/clothMesh';
import { cornerHold, holdCorner, pieceSize, resizePiece } from '../../utils/cloth/clothSheet';
import { solveAeroAcousticVoice, solveClothSnapPulse } from '../../utils/aeroAcoustics';
import { playAeroSnapPulse, unlockAudioContext } from '../../utils/modalAudio';
import { FABRICS } from './garmentFields';

const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgbaOf = (h: string, a: number) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(a);
const DEFAULT_RGBA = [0.25, 0.5, 0.85, 1];

/**
 * Plain cloth (not a garment): its fabric and colour, each piece's size, and
 * what holds each corner: nothing, pinned where it starts, or tied to a body,
 * wound in to that body's nearest point when the scene plays (a shade sail to
 * its posts). Writes the cloth's `material`, its pieces' `rgba` and outlines,
 * and its `ties`, as MCP does.
 */
export function ClothCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const nodes = useStore((s) => s.sceneGraph.nodes);
  const windX = useStore((s) => s.windX);
  const windY = useStore((s) => s.windY);
  const cloth = node.cloth;
  if (!cloth || cloth.garment || !cloth.pieces?.length) return null;
  const set = (next: Partial<ClothSpec>, settle = false) => updateNode(node.id, { cloth: { ...cloth, ...next } } as Partial<SceneNode>, false, settle);
  const pieces = cloth.pieces;
  const rgba = pieces[0].rgba ?? DEFAULT_RGBA;
  const matName = (cloth.material && cloth.material in CLOTH_MATERIALS ? cloth.material : 'woven') as ClothMaterialName;
  const mat = { ...CLOTH_MATERIALS[matName], ...(cloth.materialOverrides ?? {}) };
  const arealGsm = Math.round(mat.arealDensity * 1000);
  const liveWindMps = Math.hypot(windX || 0, windY || 0);
  const refWindMps = liveWindMps >= 1 ? liveWindMps : 8.5;
  const snapPreview = solveClothSnapPulse({
    nodeId: node.id,
    impulseNs: 0.08,
    relSpeedMps: refWindMps,
    arealDensityKgM2: mat.arealDensity,
  });
  const aeroVoicePreview = solveAeroAcousticVoice({
    hubOrBodyId: node.id,
    bladeCount: 0,
    omegaRadPerSec: 0,
    tipSpeedMps: refWindMps,
    relSpeedMps: refWindMps,
    alphaDeg: 18,
    areaM2: 0.25,
    chordM: 0.5,
    thicknessM: mat.thickness,
    aeroForceN: 2.0,
    isCloth: true,
    bendRateRadPerSec: 12,
    arealDensityKgM2: mat.arealDensity,
  });
  const auditionWhipSnap = () => {
    unlockAudioContext();
    playAeroSnapPulse(snapPreview);
  };
  const others: string[] = [];
  const walk = (list: SceneNode[]) => { for (const n of list) { if (n.id !== node.id && !n.cloth) others.push(n.name || n.id); walk(n.children ?? []); } };
  walk(nodes);
  const label = 'text-xs text-slate-500 dark:text-slate-400 font-medium';
  const select = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer';
  return (
    <div className="flex flex-col gap-2.5 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Cloth</label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1" title="The cloth: how it stretches, bends, drapes and shines">
          <span className={label}>Fabric</span>
          <select className={select} value={cloth.material ?? 'woven'} onChange={(e) => set({ material: e.target.value as ClothMaterialName })}>
            {FABRICS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2" title="Colour of the cloth">
          <span className={label}>Colour</span>
          <input type="color" value={hex(rgba)} onChange={(e) => set({ pieces: pieces.map((p) => ({ ...p, rgba: rgbaOf(e.target.value, p.rgba?.[3] ?? 1) })) }, true)} className="w-8 h-6 border border-slate-200 dark:border-slate-700 rounded cursor-pointer bg-white dark:bg-slate-900" />
        </label>
      </div>
      <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-200/70 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Acoustics</span>
          <button
            type="button"
            onClick={auditionWhipSnap}
            title="Audition trailing-edge N-wave whip-snap for this fabric's areal density"
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 border border-violet-200 dark:border-violet-800 text-[10px] font-semibold text-violet-700 dark:text-violet-300 cursor-pointer transition-colors select-none"
          >
            <Volume2 className="w-3 h-3" />
            Whip Snap
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 text-[11px]">
          <div className="flex flex-col px-1.5 py-1 rounded bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800" title="Fabric areal density σ = mass / area">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Weight</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">{arealGsm} g/m²</span>
          </div>
          <div className="flex flex-col px-1.5 py-1 rounded bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800" title="Trailing-edge N-wave whip-snap spectral peak">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Snap peak</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">{Math.round(snapPreview.centerHz)} Hz</span>
          </div>
          <div className="flex flex-col px-1.5 py-1 rounded bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800" title="High-shelf weave-strain rustle corner frequency">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Rustle</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">{(aeroVoicePreview.rustleFreqHz / 1000).toFixed(1)} kHz</span>
          </div>
        </div>
      </div>
      {pieces.map((p, k) => {
        const [w, l] = pieceSize(p);
        const resize = (nw: number, nl: number) => set({ pieces: pieces.map((q, j) => (j === k ? resizePiece(q, Math.max(0.02, nw), Math.max(0.02, nl)) : q)) }, true);
        return (
          <div key={p.name} className="flex flex-col gap-1.5">
            {pieces.length > 1 && <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{p.name}</span>}
            <div className="flex items-center justify-between gap-2" title="Across and along the piece as cut; it keeps its shape">
              <span className={label}>Size</span>
              <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <SliderValue value={w} onChange={(v) => resize(v, l)} scale={1000} decimals={0} min={0.02} max={20} className="text-xs" />
                ×
                <SliderValue value={l} onChange={(v) => resize(w, v)} scale={1000} decimals={0} unit="mm" min={0.02} max={20} className="text-xs" />
              </span>
            </div>
            <span className={label}>Corners</span>
            {p.edges.map((e) => {
              const hold = cornerHold(cloth.ties, p.name, e.id);
              const value = hold.kind === 'body' ? `body:${hold.to}` : hold.kind;
              const onChange = (v: string) => set({ ties: holdCorner(nodes, node, p.name, e.id, v === 'free' || v === 'pinned' ? v : { to: v.slice(5) }) });
              return (
                <label key={e.id} className="flex items-center justify-between gap-2" title="Free; pinned where it starts; or tied to a body, wound in to its nearest point when the scene plays">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">{cornerName(p.edges, e.pts[0])}</span>
                  <select className={`${select} max-w-[60%]`} value={value} onChange={(ev) => onChange(ev.target.value)}>
                    <option value="free">free</option>
                    <option value="pinned">pinned in place</option>
                    {others.map((o) => <option key={o} value={`body:${o}`}>tied to {o}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Where a corner is on its piece, by which side of the piece's middle it lies (v is north): `north-west`, `south`, ... */
function cornerName(edges: { pts: number[][] }[], at: number[]): string {
  const pts = edges.flatMap((e) => e.pts);
  const mid = [0, 1].map((a) => (Math.max(...pts.map((q) => q[a])) + Math.min(...pts.map((q) => q[a]))) / 2);
  const span = [0, 1].map((a) => Math.max(...pts.map((q) => q[a])) - Math.min(...pts.map((q) => q[a])));
  const side = (a: number, lo: string, hi: string) => (Math.abs(at[a] - mid[a]) < 0.2 * span[a] ? '' : at[a] < mid[a] ? lo : hi);
  return [side(1, 'south', 'north'), side(0, 'west', 'east')].filter(Boolean).join('-') || 'middle';
}
