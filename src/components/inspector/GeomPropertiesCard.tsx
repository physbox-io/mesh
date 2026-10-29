import { useStore } from '../../store/useStore';
import { sliderSpan } from '../../utils/sliderSpan';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';
import { MaterialCard } from './MaterialCard';
import { CouplingCard } from './CouplingCard';
import { displayedGeomMass, primitiveVolume } from '../../utils/geomMassDisplay';

/**
 * The active sub-geom's properties, split by inspector tab: its colour on
 * Main, its offset on Shape, its mass, contact and material on Physics. Main
 * puts SubGeomSelector above Resize itself; the other tabs get it here.
 */
export function GeomPropertiesCard({ node: selectedNode, part }: { node: SceneNode; part: 'main' | 'shape' | 'physics' }) {
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);
  const density = useStore((s) => s.density);
  const gravityZ = useStore((s) => s.gravityZ);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  const model = useStore((s) => s.model);

  if (!selectedNode.geoms || selectedNode.geoms.length === 0) return null;
  const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
  const geom = selectedNode.geoms[activeIndex];
  if (!geom) return null;
  const bodyId = model?._idMaps?.body?.[selectedNode.id];
  const bodyMass = bodyId !== undefined && bodyId >= 0 ? model?.body_mass?.[bodyId] : undefined;
  const mass = displayedGeomMass(selectedNode, activeIndex, bodyMass);
  const shownMass = mass?.kg ?? 0;
  return (
    <div className="flex flex-col gap-4">
      {part !== 'main' && <SubGeomSelector node={selectedNode} />}

      {/* Position Offset Control for Sub-Geom */}
      {part === 'shape' && (() => {
        const pos = geom.pos || [0, 0, 0];
        return (
          // Folded until opened: most bodies never move a sub-geom off its origin.
          // The class is only the starting state; the header click toggles it (see
          // the collapse effect), and React leaves it alone while the prop is unchanged.
          <div className="is-collapsed p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
            <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
              <span className="flex items-center gap-1">📍 Geom Position Offset</span>
              <DocsInfoButton tab="offset" />
            </h3>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">X Offset <SliderValue value={pos[0]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                  }} decimals={1} unit="mm" scale={1000} /></label>
                <RangeInput 
                  {...sliderSpan(pos[0], -1, 1)}
                  value={pos[0]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Y Offset <SliderValue value={pos[1]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [pos[0], val, pos[2]] }, activeIndex);
                  }} decimals={1} unit="mm" scale={1000} /></label>
                <RangeInput 
                  {...sliderSpan(pos[1], -1, 1)}
                  value={pos[1]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [pos[0], val, pos[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Z Offset <SliderValue value={pos[2]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [pos[0], pos[1], val] }, activeIndex);
                  }} decimals={1} unit="mm" scale={1000} /></label>
                <RangeInput 
                  {...sliderSpan(pos[2], -1, 1)}
                  value={pos[2]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { pos: [pos[0], pos[1], val] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
            </div>
          </div>
        );
      })()}

      {part === 'physics' && (
      <>
      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
          <span>Mass</span>
          <DocsInfoButton tab="gravity" />
        </h3>
        <label className="text-xs font-medium text-slate-500 flex justify-between">Value <SliderValue value={shownMass} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} decimals={shownMass > 0 && shownMass < 0.1 ? 3 : 2} unit="kg" min={0} max={50} /></label>
        <RangeInput min="0" max="50" step="0.001" value={shownMass} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} className="w-full accent-blue-500 cursor-pointer" />
        {mass?.computed && (
          <p className="text-[10px] text-slate-500">
            {mass.scope === 'body' ? 'Whole body, computed' : 'Computed'} from volume × density
            {typeof geom.density === 'number' ? ` (${Math.round(geom.density)} kg/m³)` : ' (1000 kg/m³)'}. Setting a value fixes it.
          </p>
        )}
        {mass && !mass.computed && geom.type === 'mesh' && (
          <button
            type="button"
            className="self-start text-[10px] text-blue-600 hover:underline"
            onClick={() => updateNodeGeom(selectedNode.id, { mass: undefined }, activeIndex)}
          >
            Weigh by volume instead
          </button>
        )}

        {(() => {
          // fromto capsules included: see primitiveVolume.
          const volM3 = primitiveVolume(geom);
          if (!(volM3 > 0) || !Number.isFinite(volM3)) return null;
          const m = shownMass;
          const objDensity = m / volM3;
          const gAbs = Math.abs(gravityZ);
          // Against the ambient medium set in Environment.
          const buoyancyN = density * volM3 * gAbs;
          const weightN = m * gAbs;
          const status = buoyancyN > weightN * 1.02 ? 'floats' : buoyancyN < weightN * 0.98 ? 'sinks' : 'neutral';

          return (
            <div className="pt-2 border-t border-slate-100 flex flex-col gap-1 text-[11px] text-slate-600">
              <div className="flex justify-between items-center font-mono text-[10px]">
                <span>Volume:</span>
                <span>{(volM3 * 1000).toFixed(2)} L ({Math.round(volM3 * 1e9).toLocaleString()} mm³)</span>
              </div>
              <div className="flex justify-between items-center font-mono text-[10px]">
                <span>Object Density:</span>
                <span className="font-bold">{objDensity.toFixed(0)} kg/m³</span>
              </div>
              {density > 0 && (
                <>
                  <div className="flex justify-between items-center font-mono text-[10px] text-slate-500">
                    <span>Buoyancy / Weight @ {density.toFixed(2)} kg/m³:</span>
                    <span>{buoyancyN.toFixed(2)}N / {weightN.toFixed(2)}N</span>
                  </div>
                  <div className="flex justify-between items-center mt-0.5">
                    <span className="font-semibold text-slate-500 text-[10px]">Fluid Status:</span>
                    {status === 'floats' && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">🟢 FLOATS (F_b &gt; W)</span>}
                    {status === 'sinks' && <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 font-bold text-[10px]">🔴 SINKS (W &gt; F_b)</span>}
                    {status === 'neutral' && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px]">🟡 NEUTRAL (F_b ≈ W)</span>}
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>

      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
          <span className="flex items-center gap-1">💥 Collision Physics</span>
          <DocsInfoButton tab="collision" />
        </h3>
        <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
          <input 
            type="checkbox" 
            checked={geom.contype !== 0 && geom.conaffinity !== 0}
            onChange={(e) => {
              const enabled = e.target.checked;
              updateNodeGeom(selectedNode.id, {
                contype: enabled ? 1 : 0,
                conaffinity: enabled ? 1 : 0
              }, activeIndex);
            }}
            className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
          />
          Enable Collisions
        </label>
      </div>

      <MaterialCard node={selectedNode} geom={geom} activeIndex={activeIndex} />

      <CouplingCard node={selectedNode} />
      </>
      )}

      {part === 'main' && (() => {
        const rgba = geom.rgba || [0.5, 0.5, 0.5, 1];
        const rHex = Math.floor((rgba[0] ?? 0.5) * 255).toString(16).padStart(2, '0');
        const gHex = Math.floor((rgba[1] ?? 0.5) * 255).toString(16).padStart(2, '0');
        const bHex = Math.floor((rgba[2] ?? 0.5) * 255).toString(16).padStart(2, '0');
        return (
          <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
            <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">Appearance</h3>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Color (RGB)</span>
              <input type="color" value={`#${rHex}${gHex}${bHex}`} 
                onChange={(e) => {
                  const hex = e.target.value;
                  const r = parseInt(hex.slice(1,3), 16)/255;
                  const g = parseInt(hex.slice(3,5), 16)/255;
                  const b = parseInt(hex.slice(5,7), 16)/255;
                  // Keep the alpha: picking a colour must not
                  // silently turn a pane of glass back into a wall.
                  updateNodeGeom(selectedNode.id, {rgba: [r, g, b, rgba[3] ?? 1]}, activeIndex);
                }} 
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm" 
              />
            </div>
            <label className="text-xs font-medium text-slate-500 flex justify-between mt-1">
              Opacity <span>{Math.round((rgba[3] ?? 1) * 100)}%</span>
            </label>
            <RangeInput min="0" max="1" step="0.01" value={rgba[3] ?? 1}
              onChange={(v) => updateNodeGeom(
                selectedNode.id,
                {rgba: [rgba[0] ?? 0.5, rgba[1] ?? 0.5, rgba[2] ?? 0.5, v]},
                activeIndex,
              )}
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>
        );
      })()}
    </div>
  );
}

/** Which of a multi-geom body's shapes the geom cards below it edit. */
export function SubGeomSelector({ node: selectedNode }: { node: SceneNode }) {
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  if (!selectedNode.geoms || selectedNode.geoms.length < 2) return null;
  const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
  const geom = selectedNode.geoms[activeIndex];
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <label className="text-xs font-semibold text-slate-600">Select Sub-Geometry</label>
      <select
        value={activeIndex}
        onChange={(e) => setActiveGeomIndex(parseInt(e.target.value))}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
      >
        {selectedNode.geoms.map((g, idx) => (
          // Generated boolean geoms aren't editable — a body with
          // 16 sector colliders would otherwise bury its two real
          // shapes at the bottom of this list. Values stay the
          // real indices so activeGeomIndex still means one thing.
          g.csgDerived ? null : (
          <option key={idx} value={idx}>
            {g.csg === 'difference' ? '\u2796 ' : g.csg === 'intersection' ? '\u2229 ' : ''}{g.name || `Geom ${idx + 1}`} ({g.type})
          </option>
          )
        ))}
      </select>
      <div className="text-[10px] text-slate-400 font-semibold px-0.5 flex justify-between uppercase tracking-wider">
        <span>Type: {geom.type}</span>
        {geom.name && <span>Name: {geom.name}</span>}
      </div>
    </div>
  );
}
