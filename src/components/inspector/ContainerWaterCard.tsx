import { useMemo } from 'react';
import { Droplets } from 'lucide-react';
import type { SceneNode } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { measureContainerBasin } from '../../utils/hydrostatics';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';

/**
 * Container Water card (Physics tab):
 * Appears automatically on any open-top container, tank, bowl, tub, or cup,
 * allowing its interior cavity to be filled with bounded freshwater (`0–100%`)
 * without flooding the surrounding scene floor.
 */
export function ContainerWaterCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const recompile = useStore((s) => s.recompile);

  const basin = useMemo(() => measureContainerBasin(node), [node]);
  if (!basin) return null;

  const maxDepthMm = Math.max(1, (basin.rimZ - basin.floorZ) * 1000);
  const fill = typeof node.waterFill === 'number' && node.waterFill > 0.005 ? node.waterFill : 0;
  const isFilled = fill > 0;
  const pct = Math.round(fill * 100);
  const curDepthMm = +(fill * maxDepthMm).toFixed(0);

  const applyFill = (nextFill: number | undefined) => {
    updateNode(node.id, { waterFill: nextFill }, true);
    const latest = useStore.getState().sceneGraph;
    void recompile(latest, undefined, false);
  };

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Droplets className="w-3.5 h-3.5 text-cyan-500" /> Container Water
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={isFilled}
          title={isFilled ? 'Drain water from this container' : 'Fill this container with freshwater for Archimedes buoyancy'}
          onClick={() => applyFill(isFilled ? undefined : 0.8)}
          className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
            isFilled ? 'bg-cyan-500' : 'bg-slate-300 dark:bg-slate-700'
          }`}
        >
          <span
            className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
              isFilled ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {isFilled && (
        <div className="flex flex-col gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between items-center">
            <span>Fill Level ({curDepthMm} mm)</span>
            <SliderValue
              value={pct}
              onChange={(v) => applyFill(Math.max(5, Math.min(100, v)) / 100)}
              decimals={0}
              unit="%"
              min={5}
              max={100}
            />
          </label>
          <RangeInput
            min="5"
            max="100"
            step="1"
            value={pct}
            onChange={(v) => applyFill(v / 100)}
            className="w-full accent-cyan-500 cursor-pointer"
          />
        </div>
      )}
    </div>
  );
}
