import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';

/** Gear Config */
export function GearCard({ node }: { node: SceneNode }) {
  const addPusherPeg = useStore((s) => s.addPusherPeg);
  const deletePusherPeg = useStore((s) => s.deletePusherPeg);
  const updateGearTeeth = useStore((s) => s.updateGearTeeth);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  const updatePusherPeg = useStore((s) => s.updatePusherPeg);

  if (!(node.id.includes('gear') && node.geoms)) return null;
  const pegGeom = node.geoms.find((g) => g.name.includes('peg'));
  const gearRadius = node.geoms[0].size[0];
  return (
    <div className="flex flex-col gap-4">
      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚙️ Gear Properties</h3>
        <label className="text-xs font-medium text-slate-500 flex justify-between">
          Teeth Count <span>{node.geoms.length - (pegGeom ? 2 : 1)}</span>
        </label>
        <RangeInput 
          min="4" 
          max="24" 
          step="1" 
          value={node.geoms.length - (pegGeom ? 2 : 1)} 
          onChange={(v) => {
            const teethVal = Math.round(v);
            updateGearTeeth(node.id, teethVal);
          }} 
          className="w-full accent-blue-500 cursor-pointer" 
        />
        <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
          Gear Radius <SliderValue value={gearRadius} onChange={(v) => {
            const r = v;
            updateNodeGeom(node.id, { size: [r, node.geoms[0].size[1]] });
          }} decimals={1} unit="mm" scale={1000} min={0.05} max={5.0} />
        </label>
        <RangeInput 
          min="0.05" 
          max="5.0" 
          step="0.01" 
          value={gearRadius} 
          onChange={(v) => {
            const r = v;
            updateNodeGeom(node.id, { size: [r, node.geoms[0].size[1]] });
          }} 
          className="w-full accent-blue-500 cursor-pointer" 
        />
      </div>

      {/* generateGearGeoms always places the peg, so `pos` is there. */}
      {pegGeom && pegGeom.pos ? (
        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">📍 Pusher Peg Properties</h3>
          <label className="text-xs font-medium text-slate-500 flex justify-between">
            Peg Offset (Radius) <SliderValue value={pegGeom.pos[0]} onChange={(v) => {
              const offsetVal = v;
              updatePusherPeg(node.id, { offset: offsetVal });
            }} decimals={1} unit="mm" scale={1000} min={0.01} max={5.0} />
          </label>
          <RangeInput 
            min="0.01" 
            max="5.0" 
            step="0.01" 
            value={pegGeom.pos[0]} 
            onChange={(v) => {
              const offsetVal = v;
              updatePusherPeg(node.id, { offset: offsetVal });
            }} 
            className="w-full accent-blue-500 cursor-pointer" 
          />
          <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
            Peg Diameter <SliderValue value={pegGeom.size[0]} onChange={(v) => {
              const rVal = v;
              updatePusherPeg(node.id, { size: [rVal, pegGeom.size[1]] });
            }} decimals={1} unit="mm" scale={2000} min={0.005} max={0.5} />
          </label>
          <RangeInput 
            min="0.005" 
            max="0.5" 
            step="0.005" 
            value={pegGeom.size[0]} 
            onChange={(v) => {
              const rVal = v;
              updatePusherPeg(node.id, { size: [rVal, pegGeom.size[1]] });
            }} 
            className="w-full accent-blue-500 cursor-pointer" 
          />
          <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
            Peg Length <SliderValue value={pegGeom.size[1]} onChange={(v) => {
              const hVal = v;
              updatePusherPeg(node.id, { size: [pegGeom.size[0], hVal] });
            }} decimals={1} unit="mm" scale={2000} min={0.01} max={1.0} />
          </label>
          <RangeInput 
            min="0.01" 
            max="1.0" 
            step="0.01" 
            value={pegGeom.size[1]} 
            onChange={(v) => {
              const hVal = v;
              updatePusherPeg(node.id, { size: [pegGeom.size[0], hVal] });
            }} 
            className="w-full accent-blue-500 cursor-pointer" 
          />
          <button
            onClick={() => deletePusherPeg(node.id)}
            className="mt-2 w-full py-1.5 px-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-xs font-medium transition duration-150 shadow-sm border border-red-100"
          >
            🗑️ Remove Pusher Peg
          </button>
        </div>
      ) : (
        <button
          onClick={() => addPusherPeg(node.id)}
          className="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-xs font-semibold transition duration-150 border border-blue-100 flex items-center justify-center gap-1.5 shadow-sm"
        >
          ➕ Add Pusher Peg
        </button>
      )}
    </div>
  );
}
