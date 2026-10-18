import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SettledTextInput } from '../SettledInputs';

/** The component name, and the name a control script reaches it by. */
export function BodyBasicsCard({ node }: { node: SceneNode }) {
  const renameNode = useStore((s) => s.renameNode);

  return (
    <div className="flex flex-col gap-1.5 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Component Name</label>
        <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Body API Reference Name. Click to select/copy.">
          api.getPosition('{node.name || node.id}')
        </span>
      </div>
      <SettledTextInput
        value={node.name || ''}
        onChange={(name) => renameNode(node.id, name)}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-800 outline-none focus:border-blue-500 shadow-sm"
        placeholder="Rename component..."
      />
      <span className="text-[9px] font-mono text-slate-400 mt-0.5">ID: {node.id}</span>
    </div>
  );
}

/** The aerodynamics toggle: lift and drag applied automatically. */
export function AerodynamicsCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);

  return (
    <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
      <div>
        <div className="text-xs font-semibold text-slate-700">Aerodynamics</div>
        <div className="text-[10px] text-slate-500">Apply lift and drag automatically</div>
      </div>
      <label className="relative inline-flex items-center cursor-pointer">
        <input 
          type="checkbox" 
          className="sr-only peer"
          checked={node.isAerodynamic || false}
          onChange={(e) => updateNode(node.id, { isAerodynamic: e.target.checked })}
        />
        <div className="w-8 h-4 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500"></div>
      </label>
    </div>
  );
}
