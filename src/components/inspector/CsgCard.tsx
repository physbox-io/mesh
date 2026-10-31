import { Donut, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { CsgOp, SceneNode } from '../../types/scene';
import { CSG_DEFAULT_SECTORS, csgHashOf, csgMassOf, csgSourceGeoms } from '../../utils/csg';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';
import { CutControls } from '../CutControls';

/** Boolean Modifiers (CSG) — subtract/intersect one primitive with another */
export function CsgCard({ node: selectedNode }: { node: SceneNode }) {
  const deleteNodeGeom = useStore((s) => s.deleteNodeGeom);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  const setGeomCsgOp = useStore((s) => s.setGeomCsgOp);
  const updateNode = useStore((s) => s.updateNode);

  const source = csgSourceGeoms(selectedNode);
  const solids = source.filter((g) => g.type !== 'plane');
  const ops = source.filter((g) => g.csg === 'difference' || g.csg === 'intersection');
  const isCsg = !!selectedNode.csgEnabled && ops.length > 0;
  // Offered on anything with a solid to cut into — OpenSCAD and
  // imported parts included: Cut makes a hole in any of them.
  if (!isCsg && (solids.length === 0 || selectedNode.isCurve || selectedNode.isPulleyRope)) return null;

  const mode = selectedNode.csgCollision ?? 'auto';
  const colliders = (selectedNode.geoms || []).filter((g) => g.csgDerived === 'collider');
  const visual = (selectedNode.geoms || []).find((g) => g.csgDerived === 'visual');
  const stale = isCsg && csgHashOf(selectedNode) !== selectedNode.csgHash;
  const effectiveMode = colliders.length > 0 ? 'decompose' : (visual ? (visual.role === 'visual' ? 'primitives' : 'hull') : null);

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Donut className="w-3.5 h-3.5 text-rose-500" /> Boolean Modifiers
        {stale && <span className="ml-auto text-[10px] font-semibold text-amber-600 animate-pulse">recompiling…</span>}
      </h3>
      <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
        Combines geoms in order using Union, Difference, or Intersection.
      </p>

      {/* Cut. The only way to put a shape ON a body: dragging one
          in from the sidebar makes a CHILD BODY, whose geoms
          belong to a different boolean program and are invisible
          to this one — which is what the line above used to
          advise, wrongly, for years. */}
      <div className="flex flex-col gap-1.5 pb-1 border-b border-slate-100">
        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
          Cut a shape out of it
        </label>
        <CutControls node={selectedNode} compact />
      </div>

      {/* Per-geom operator */}
      <div className="flex flex-col gap-1.5">
        {source.map((g) => {
          const idx = (selectedNode.geoms || []).indexOf(g);
          return (
            <div key={g.name || idx} className="flex items-center gap-1.5">
              <span className={`flex-1 text-[10px] font-mono truncate ${g.csg === 'difference' ? 'text-rose-500' : 'text-slate-500'}`} title={g.name}>
                {g.name || `Geom ${idx + 1}`} <span className="text-slate-300">· {g.type}</span>
              </span>
              {/* Mirrors setGeomCsgOp's guard: a body must keep at
                  least one positive shape, or there is nothing to
                  cut into and no geometry left to emit. */}
              {(() => {
                const otherPositives = source.filter((o, i) =>
                  i !== source.indexOf(g) && (!o.csg || o.csg === 'union')).length;
                const canSubtract = otherPositives > 0;
                return (
                  <select
                    value={g.csg || 'union'}
                    onChange={(e) => setGeomCsgOp(selectedNode.id, idx, e.target.value as CsgOp)}
                    className="px-1.5 py-1 border border-slate-200 rounded text-[10px] bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-semibold"
                    title={canSubtract ? undefined : 'This is the body\u2019s only shape, so there is nothing for it to be cut out of. Use Cut above to take a shape out of it.'}
                  >
                    <option value="union">＋ add</option>
                    <option value="difference" disabled={!canSubtract}>－ subtract</option>
                    <option value="intersection" disabled={!canSubtract}>∩ intersect</option>
                  </select>
                );
              })()}
              <button
                onClick={() => { deleteNodeGeom(selectedNode.id, idx); setActiveGeomIndex(0); }}
                disabled={solids.length <= 1}
                className="p-1 rounded border border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                title={solids.length <= 1 ? 'A body needs at least one shape' : 'Delete this shape'}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {isCsg && (
        <>
          <div className="flex flex-col gap-1 pt-1 border-t border-slate-100">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Collision</label>
            <select
              value={mode}
              onChange={(e) => updateNode(selectedNode.id, { csgCollision: e.target.value as SceneNode['csgCollision'] })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
            >
              <option value="auto">Auto (decompose if there is a hole axis)</option>
              <option value="decompose">Convex sectors (holes collide)</option>
              <option value="primitives">Source primitives (holes are solid)</option>
              <option value="hull">Convex hull (whole shape is solid)</option>
            </select>
            {/* MuJoCo hulls every mesh geom, so this trade-off is
                unavoidable and worth stating outright rather than
                letting it surprise someone mid-experiment. */}
            <p className="text-[10px] text-slate-400 leading-snug mt-0.5">
              {effectiveMode === 'decompose'
                ? `Colliding as ${colliders.length} convex sectors. The hole is real, and a peg can pass through it. Each sector spans a chord of the inner surface, so it intrudes ~${(100 * (1 - Math.cos(Math.PI / (selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS)))).toFixed(1)}% of the hole radius.`
                : effectiveMode === 'hull'
                  ? 'One mesh geom that both draws and collides. MuJoCo takes its convex hull, so every hole and dip is filled for contact.'
                  : 'The boolean mesh is visual only; the source primitives collide. Exact convex contact, but holes are solid.'}
            </p>
          </div>

          {(mode === 'auto' || mode === 'decompose') && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">
                  Sectors <span>{selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS}</span>
                </label>
                <RangeInput min="4" max="48" step="1"
                  value={selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS}
                  onChange={(v) => updateNode(selectedNode.id, { csgSectors: Math.round(v) })}
                  className="w-full accent-blue-500 cursor-pointer"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-500">Hole axis</label>
                <select
                  value={selectedNode.csgHoleAxis ?? 'auto'}
                  onChange={(e) => updateNode(selectedNode.id, { csgHoleAxis: e.target.value as SceneNode['csgHoleAxis'] })}
                  className="px-2 py-1 border border-slate-200 rounded text-[11px] bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                >
                  <option value="auto">Auto</option>
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </div>
            </>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">
              Total mass <SliderValue value={csgMassOf(selectedNode, selectedNode.csgVolume ?? 0)} onChange={(v) => updateNode(selectedNode.id, { collisionMass: v, csgMass: undefined })} decimals={3} unit="kg" min={0.01} max={20} />
            </label>
            <RangeInput min="0.01" max="20" step="0.01"
              value={csgMassOf(selectedNode, selectedNode.csgVolume ?? 0)}
              onChange={(v) => updateNode(selectedNode.id, { collisionMass: v, csgMass: undefined })}
              className="w-full accent-blue-500 cursor-pointer"
            />
            {/* MuJoCo would derive mass from the hull's volume, which
                for a ring is wildly more material than there is. Show
                both figures so the number above is a choice, not a guess. */}
            {selectedNode.csgVolume !== undefined && (
              <p className="text-[10px] text-slate-400 leading-snug">
                True volume <span className="font-mono text-slate-500">{Math.round(selectedNode.csgVolume * 1e9).toLocaleString()} mm³</span>
                {selectedNode.csgHullVolume ? <> · convex hull <span className="font-mono text-slate-500">{Math.round(selectedNode.csgHullVolume * 1e9).toLocaleString()} mm³</span></> : null}
                {selectedNode.csgVolume > 0 && <> · density <span className="font-mono text-slate-500">{((csgMassOf(selectedNode, selectedNode.csgVolume ?? 0)) / selectedNode.csgVolume).toFixed(0)} kg/m³</span></>}
              </p>
            )}
          </div>

          {selectedNode.csgWarning && (
            <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-1.5 leading-snug">{selectedNode.csgWarning}</div>
          )}
          {selectedNode.csgError && (
            <div className="text-[10px] text-rose-800 bg-rose-50 border border-rose-200 rounded p-1.5 leading-snug">
              <strong>Boolean failed:</strong> <span className="font-mono break-all">{selectedNode.csgError}</span>
            </div>
          )}

          {visual && (
            <div className="text-[10px] text-slate-400 font-mono">
              {(visual.vertices?.length ?? 0) / 3} verts · {(visual.faces?.length ?? 0) / 3} tris
              {colliders.length > 0 ? ` · ${colliders.length} colliders` : ''}
            </div>
          )}

          {selectedNode.csgScad && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-slate-500 font-semibold select-none">Generated OpenSCAD</summary>
              <textarea
                readOnly
                value={selectedNode.csgScad}
                className="w-full h-32 mt-1.5 font-mono text-[10px] leading-relaxed p-2 bg-slate-950 text-emerald-300 rounded border border-slate-700 resize-y"
                spellCheck={false}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}
