import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';

export function PulleyWheelCard({ node }: { node: SceneNode }) {
  const updatePulleyParams = useStore((s) => s.updatePulleyParams);
  if (!(node.isPulleyWheel)) return null;
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">🛞 Pulley Properties</h3>
      <label className="text-xs font-medium text-slate-500 flex justify-between">
        Pulley Radius <SliderValue value={node.pulleyRadius || 0.4} onChange={(v) => {
          const radVal = v;
          updatePulleyParams(node.id, { pulleyRadius: radVal });
        }} decimals={2} unit="m" min={0.15} max={1.5} />
      </label>
      <RangeInput 
        min="0.15" 
        max="1.5" 
        step="0.01" 
        value={node.pulleyRadius || 0.4} 
        onChange={(v) => {
          const radVal = v;
          updatePulleyParams(node.id, { pulleyRadius: radVal });
        }} 
        className="w-full accent-blue-500 cursor-pointer" 
      />
    </div>
  );
}
