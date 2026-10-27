import { useShallow } from 'zustand/react/shallow';
import { Hammer, Sparkles } from 'lucide-react';
import { useDentStore } from '../../store/dentStore';
import { useStore } from '../../store/useStore';
import { isDentable, needsConversionForDenting } from '../../utils/dentMesh';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { CUSTOM_DENT, CUSTOM_SHATTER, DEFORM_MATERIALS, deformMaterial, dentFields, estimateBodyMass, materialUpdates, shatterFields } from '../../utils/deformMaterials';
import { SettledNumberInput } from '../SettledInputs';
import { LoadBreakSection, LoadOnlyCard } from './LoadBreakSection';
import { memberShape } from '../../utils/memberStrength';

/*
 * Deformation — what this body does when it is hit hard: break
 * into pieces, take a dent, both or neither. A material fills in
 * numbers that belong together; see utils/deformMaterials.ts.
 * Shattering is per body and denting per geom, so the card
 * works on the one geom a dent would be made in.
 */
export function DeformationCard({ node: selectedNode }: { node: SceneNode }) {
  const lastShatter = useStore((s) => s.lastShatter);
  const makeDentable = useStore((s) => s.makeDentable);
  const shatteredBodies = useStore((s) => s.visibleShatteredBodies);
  const updateNode = useStore((s) => s.updateNode);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  // Only this body's dents: a subscription to the whole map re-rendered the
  // panel for every dent anywhere in the scene, several a second while things
  // are colliding.
  const dents = useDentStore(useShallow((s) => {
    const mine: typeof s.dents = {};
    const prefix = `${selectedNode.id}/`;
    for (const key in s.dents) if (key.startsWith(prefix)) mine[key] = s.dents[key];
    return mine;
  }));

  // Offered on primitives too. A dent moves vertices and a
  // fracture cuts them, and a primitive has none, so turning
  // either on converts the shape into the mesh it already looked
  // like — see utils/dentMesh.ts. A plane is the one thing that
  // cannot be converted; it is infinite in the solver.
  const candidates = (selectedNode.geoms || []).filter(
    (g) => isDentable(g) || needsConversionForDenting(g),
  );
  if (candidates.length === 0) return memberShape(selectedNode) ? <LoadOnlyCard node={selectedNode} /> : null;
  const geom = candidates.find((g) => (g.dentYieldNs ?? 0) > 0) ?? candidates[0];
  const gi = (selectedNode.geoms || []).indexOf(geom);
  const willConvert = needsConversionForDenting(geom);
  const nodeId = selectedNode.id;

  const shatterOn = typeof selectedNode.shatterImpulseNs === 'number' && selectedNode.shatterImpulseNs > 0;
  const loadOn = !!selectedNode.loadStrength;
  const canBreakUnderLoad = !!memberShape(selectedNode) && (selectedNode.joints || []).some((j) => j.type === 'free');
  const dentOn = typeof geom.dentYieldNs === 'number' && geom.dentYieldNs > 0;
  const material = deformMaterial(selectedNode.deformMaterial);
  const movable = (selectedNode.joints || []).length > 0;
  const inPieces = !!shatteredBodies[nodeId];
  const info = lastShatter?.nodeId === nodeId ? lastShatter : null;
  const marks = dents[`${nodeId}/${geom.name}`];
  const massKg = estimateBodyMass(selectedNode);

  // Any number changed by hand means the body is no longer the
  // material the dropdown names.
  const markCustom = () => {
    if (selectedNode.deformMaterial && selectedNode.deformMaterial !== 'custom') {
      updateNode(nodeId, { deformMaterial: 'custom' });
    }
  };
  const tuneNode = (u: Partial<SceneNode>) => {
    updateNode(nodeId, selectedNode.deformMaterial ? { ...u, deformMaterial: 'custom' } : u);
  };
  const tuneGeom = (u: Partial<SceneGeom>) => {
    updateNodeGeom(nodeId, u, gi);
    markCustom();
  };

  const setShatter = (on: boolean) => {
    if (!on) { updateNode(nodeId, { shatterImpulseNs: undefined }); return; }
    if (willConvert) makeDentable(nodeId, gi, {});
    updateNode(nodeId, shatterFields(material?.shatter ?? CUSTOM_SHATTER, massKg));
  };
  const setDent = (on: boolean) => {
    if (on) makeDentable(nodeId, gi, dentFields(material?.dent ?? CUSTOM_DENT));
    else updateNodeGeom(nodeId, { dentYieldNs: undefined }, gi);
  };
  const pickMaterial = (id: string) => {
    const m = deformMaterial(id);
    if (!m) { updateNode(nodeId, { deformMaterial: id === 'custom' ? 'custom' : undefined }); return; }
    const r = materialUpdates(selectedNode, m, { shatter: shatterOn, dent: dentOn, load: loadOn }, canBreakUnderLoad);
    for (const [i, u] of Object.entries(r.geoms)) updateNodeGeom(nodeId, u, Number(i));
    if (r.dent) makeDentable(nodeId, gi, dentFields(m.dent!));
    else {
      if (dentOn) updateNodeGeom(nodeId, { dentYieldNs: undefined }, gi);
      if (r.shatter && willConvert) makeDentable(nodeId, gi, {});
    }
    updateNode(nodeId, r.node);
  };

  // The material's strength, or hardwood's when the material is Custom.
  const setLoad = (on: boolean) => {
    if (!on) { updateNode(nodeId, { loadStrength: undefined }); return; }
    updateNode(nodeId, { loadStrength: { ...(material ?? deformMaterial('hardwood')!).strength } });
  };

  const breakSpeed = shatterOn && massKg > 0 ? selectedNode.shatterImpulseNs! / massKg : null;

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Hammer className="w-3.5 h-3.5 text-amber-600" /> Deformation
        {(inPieces || marks) && (
          <span className="ml-auto text-[10px] font-semibold text-rose-600">
            {inPieces
              ? 'in pieces'
              : marks!.holes ? `${marks!.holes} hole${marks!.holes === 1 ? '' : 's'}` : `${marks!.count} dent${marks!.count === 1 ? '' : 's'}`}
          </span>
        )}
      </h3>

      <div className="flex items-center gap-2">
        <label className="text-[10px] text-slate-500 w-20 shrink-0">Material</label>
        <select
          value={material?.id ?? 'custom'}
          onChange={(e) => pickMaterial(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
          title="Fills in the numbers below, and the density, so the body weighs what it is made of."
        >
          <option value="custom">Custom</option>
          {DEFORM_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
      {material && (
        <p className="text-[10px] text-slate-400 leading-snug">{material.note}</p>
      )}

      {willConvert && !shatterOn && !dentOn && (
        <p className="text-[10px] text-slate-400 leading-snug">
          A {geom.type} has no vertices to break or push in. Turning on Shatters
          or Dents rebuilds it as the mesh it already looks like
          {canBreakUnderLoad ? ', and a mesh no longer breaks under load.' : '.'}
        </p>
      )}

      {/* ---- Under load ---- */}
      <LoadBreakSection node={selectedNode} onToggle={setLoad} />

      {/* ---- Shattering ---- */}
      <label
        className={`flex items-center gap-2 text-xs cursor-pointer ${material && !material.shatter ? 'text-slate-400' : 'text-slate-700'}`}
        title={material && !material.shatter ? `${material.label} does not shatter. Choose Custom to make it.` : undefined}
      >
        <input
          type="checkbox"
          checked={shatterOn}
          disabled={!!material && !material.shatter}
          onChange={(e) => setShatter(e.target.checked)}
          className="accent-rose-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <Sparkles className="w-3 h-3 text-rose-500" /> Shatters
      </label>

      {shatterOn && !movable && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
          This body is fixed in place, so nothing can hit it hard enough to
          matter. Give it a joint under Body &amp; Joints to let it be struck.
        </p>
      )}

      {shatterOn && (
        <div className="flex flex-col gap-2 pl-5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Breaks at</label>
            <SettledNumberInput
              step="0.5"
              min={0}
              value={selectedNode.shatterImpulseNs ?? 0}
              onChange={(v) => tuneNode({ shatterImpulseNs: v })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
          </div>
          {breakSpeed !== null && (
            <p className="text-[10px] text-slate-400 leading-snug -mt-1">
              A {(massKg * 1000 < 1000 ? `${Math.round(massKg * 1000)} g` : `${massKg.toFixed(1)} kg`)} body
              stopped from {breakSpeed.toFixed(1)} m/s — a drop of
              about {(breakSpeed * breakSpeed / 19.62 * 1000).toFixed(0)} mm onto something hard
              {selectedNode.shatterThicknessRef
                ? `, where the wall is ${+(selectedNode.shatterThicknessRef * 1000).toFixed(1)} mm. Thinner breaks sooner: half that wall, half the blow.`
                : '.'}
            </p>
          )}
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Rated wall</label>
            <SettledNumberInput
              step="1" min={0}
              value={+((selectedNode.shatterThicknessRef ?? 0) * 1000).toFixed(1)}
              onChange={(v) => tuneNode({ shatterThicknessRef: v > 0 ? v / 1000 : undefined })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
              placeholder="any"
              title="The wall thickness the number above is for. Hit somewhere thinner and it breaks sooner; thicker, and it takes more (up to three times). Measured where the blow lands. Zero: thickness does not matter."
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">mm</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Pieces</label>
            <input
              type="range" min={2} max={24} step={1}
              value={selectedNode.shatterPieces ?? 8}
              onChange={(e) => tuneNode({ shatterPieces: parseInt(e.target.value, 10) })}
              className="flex-1 accent-rose-500 cursor-pointer"
            />
            <span className="text-[10px] text-slate-500 w-8 shrink-0 text-right">{selectedNode.shatterPieces ?? 8}</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Pattern</label>
            <select
              value={selectedNode.shatterPattern ?? 'radial'}
              onChange={(e) => tuneNode({ shatterPattern: e.target.value as 'uniform' | 'radial' })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
              title="Radial crowds the small pieces around the point of impact, which is what really happens and what reads as a blow."
            >
              <option value="radial">Around the impact</option>
              <option value="uniform">Evenly</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Pieces break</label>
            <select
              value={selectedNode.shatterDepth ?? 0}
              onChange={(e) => tuneNode({ shatterDepth: parseInt(e.target.value, 10) || undefined })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
              title="Whether the pieces can break again when they land. Each generation multiplies the body count and every break rebuilds the model, so a scene set to cascade will hitch its way down."
            >
              <option value={0}>Not again</option>
              <option value={1}>Once more</option>
              <option value={2}>Twice more</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Scatter</label>
            <SettledNumberInput
              step="0.1"
              min={0}
              value={selectedNode.shatterSpread ?? 0}
              onChange={(v) => tuneNode({ shatterSpread: v || undefined })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">m/s</span>
          </div>
          {info && (
            <div className="flex items-center gap-2 text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 leading-snug">
              <span className="flex-1">
                Broke into {info.pieces} pieces at {info.time.toFixed(2)} s, taking {info.impulseNs.toFixed(1)} N·s{info.wallM !== undefined ? ` where the wall is ${(info.wallM * 1000).toFixed(1)} mm` : ''}. Reset makes it whole.
              </span>
            </div>
          )}
        </div>
      )}

      {/* ---- Denting ---- */}
      <label
        className={`flex items-center gap-2 text-xs cursor-pointer ${material && !material.dent ? 'text-slate-400' : 'text-slate-700'}`}
        title={material && !material.dent ? `${material.label} does not dent. Choose Custom to make it.` : undefined}
      >
        <input
          type="checkbox"
          checked={dentOn}
          disabled={!!material && !material.dent}
          onChange={(e) => setDent(e.target.checked)}
          className="accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <Hammer className="w-3 h-3 text-amber-600" /> Dents
      </label>

      {dentOn && (
        <div className="flex flex-col gap-2 pl-5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Yields at</label>
            <SettledNumberInput
              step="0.5" min={0}
              value={geom.dentYieldNs ?? 0}
              onChange={(v) => tuneGeom({ dentYieldNs: v })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Deepest</label>
            <SettledNumberInput
              step="1" min={0}
              value={Math.round((geom.dentMaxDepth ?? 0.02) * 1000)}
              onChange={(v) => tuneGeom({ dentMaxDepth: v / 1000 })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">mm</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 w-20 shrink-0">Pierces at</label>
            <SettledNumberInput
              step="1" min={0}
              value={geom.pierceImpulseNs ?? 0}
              onChange={(v) => tuneGeom({ pierceImpulseNs: v || undefined })}
              className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
              placeholder="never"
              title="Above this the surface is holed rather than dented: the material under the striker is gone, not pushed aside. Leave at zero and it can never be pierced."
            />
            <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
          </div>
          {(geom.pierceImpulseNs ?? 0) > 0 && (geom.pierceImpulseNs ?? 0) <= (geom.dentYieldNs ?? 0) * 1.5 && (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
              Piercing this close to the yield leaves almost no range in which this
              behaves like a sheet — nearly everything that marks it will go through.
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer mt-1">
            <input
              type="checkbox"
              checked={!!geom.deformCollision}
              onChange={(e) => updateNodeGeom(nodeId,
                { deformCollision: e.target.checked || undefined }, gi)}
              className="accent-amber-500 cursor-pointer"
            />
            Damage is real, not just seen
          </label>
          {geom.deformCollision ? (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
              Every mark now changes what this body collides as: things fall
              through the holes, and an edge worn away stops holding what it used
              to. <strong>It is slow on purpose.</strong> Damage reaches the
              solver by rebuilding the model, and the surface has to be broken
              into convex pieces each time — a hull would fill every crater and
              every hole straight back in. Expect a hitch per blow.
            </p>
          ) : (
            <p className="text-[10px] text-slate-400 leading-snug">
              <strong className="text-slate-500">Damage is cosmetic.</strong> The
              surface shows the crater, but contact keeps using the undamaged
              shape — so something can rest on the hole it just made. Tick the box
              above to make it real, and read what that costs.
              {marks && ` Deepest so far ${(marks.deepest * 1000).toFixed(1)} mm`}
              {marks?.holes ? `, and holed through ${marks.holes} time${marks.holes === 1 ? '' : 's'}` : ''}
              {marks && '.'}
            </p>
          )}
        </div>
      )}

      {(shatterOn || dentOn) && (
        <p className="text-[10px] text-slate-400 leading-snug">
          Blows are measured as impulse, not force, so the number means the same
          thing whatever the solver is doing: a 200 g body arriving at 5 m/s and
          stopping dead is about 1 N·s.{shatterOn && dentOn && ' A blow hard enough to shatter does not also dent.'}
        </p>
      )}
    </div>
  );
}
