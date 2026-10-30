import { useStore, cloneSceneGraph } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SettledNumberInput } from '../SettledInputs';
import { DocsInfoButton } from '../docs/DocsInfoButton';
import { isRackBody } from '../../utils/rackMeshing';
import { findNodeById } from '../../utils/sceneTree';

/** Joint Mechanical Coupling Configuration */
export function CouplingCard({ node: selectedNode }: { node: SceneNode }) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const updateScene = useStore((s) => s.updateScene);

  if (!(selectedNode.joints && selectedNode.joints.length > 0)) return null;
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <span className="flex items-center gap-1">⚙️ Mechanical Coupling</span>
        <DocsInfoButton tab="coupling" />
      </h3>

      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
        <input 
          type="checkbox" 
          checked={selectedNode.allowCoupling !== false}
          onChange={(e) => {
            const enabled = e.target.checked;
            const newScene = cloneSceneGraph(sceneGraph);
            const traverse = (nodes: SceneNode[]) => {
              if (!nodes) return false;
              for (const node of nodes) {
                if (node.id === selectedNode.id) {
                  node.allowCoupling = enabled;
                  return true;
                }
                if (traverse(node.children)) return true;
              }
              return false;
            };
            traverse(newScene.nodes);
            updateScene(newScene);
          }}
          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
        />
        Enable Coupling
      </label>

      {selectedNode.joints.some((j) => j.type === 'slide') && (
        <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1" title="A rack is coupled to a hinged wheel that meshes with it">
          <input
            type="checkbox"
            checked={isRackBody(selectedNode)}
            disabled={selectedNode.toothForm?.kind === 'rack'}
            onChange={(e) => {
              const newScene = cloneSceneGraph(sceneGraph);
              const node = findNodeById(newScene.nodes, selectedNode.id);
              if (!node) return;
              if (e.target.checked) node.isRack = true;
              else delete node.isRack;
              updateScene(newScene);
            }}
            className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
          />
          Rack (teeth on this slide)
        </label>
      )}

      {selectedNode.allowCoupling !== false && (() => {
        // Gather list of other jointed nodes in the scene
        const list: SceneNode[] = [];
        const traverse = (items: SceneNode[]) => {
          for (const item of items) {
            if (item.id !== selectedNode.id && item.joints && item.joints.length > 0) {
              list.push(item);
            }
            if (item.children) {
              traverse(item.children);
            }
          }
        };
        traverse(sceneGraph.nodes);

        return (
          <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Couple Target Component</span>
              <select
                value={selectedNode.coupleTargetId || ''}
                onChange={(e) => {
                  const val = e.target.value || undefined;
                  const newScene = cloneSceneGraph(sceneGraph);
                  const traverse2 = (nodes: SceneNode[]) => {
                    if (!nodes) return false;
                    for (const node of nodes) {
                      if (node.id === selectedNode.id) {
                        node.coupleTargetId = val;
                        // Default ratio depending on type if target selected and no custom ratio set
                        if (val && node.coupleRatio === undefined) {
                          const target = findNodeById(newScene.nodes, val);
                          node.coupleRatio = isRackBody(node) || (target && isRackBody(target)) ? 0.2 : -1.0;
                        }
                        return true;
                      }
                      if (traverse2(node.children)) return true;
                    }
                    return false;
                  };
                  traverse2(newScene.nodes);
                  updateScene(newScene);
                }}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
              >
                <option value="">[Auto Proximity Fallback]</option>
                {list.map(node => (
                  <option key={node.id} value={node.id}>
                    {node.name || node.id} ({node.joints[0].type})
                  </option>
                ))}
              </select>
            </div>

            {selectedNode.coupleTargetId && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Coupling Ratio</span>
                <div className="flex gap-1.5 items-center">
                  <select
                    value={
                      selectedNode.coupleRatio === -1.0 ? 'gear' :
                      selectedNode.coupleRatio === 0.2 ? 'pinion_rack' :
                      selectedNode.coupleRatio === 1.0 ? 'direct' :
                      'custom'
                    }
                    onChange={(e) => {
                      const type = e.target.value;
                      let ratio = -1.0;
                      if (type === 'gear') ratio = -1.0;
                      else if (type === 'pinion_rack') ratio = 0.2;
                      else if (type === 'direct') ratio = 1.0;
                      else ratio = selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0;

                      const newScene = cloneSceneGraph(sceneGraph);
                      const traverse2 = (nodes: SceneNode[]) => {
                        if (!nodes) return false;
                        for (const node of nodes) {
                          if (node.id === selectedNode.id) {
                            node.coupleRatio = ratio;
                            return true;
                          }
                          if (traverse2(node.children)) return true;
                        }
                        return false;
                      };
                      traverse2(newScene.nodes);
                      updateScene(newScene);
                    }}
                    className="px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer flex-1"
                  >
                    <option value="gear">Gears meshing (-1.0)</option>
                    <option value="pinion_rack">Rack & Pinion (0.2)</option>
                    <option value="direct">Direct link (1.0)</option>
                    <option value="custom">Custom Ratio...</option>
                  </select>

                  <SettledNumberInput
                    step="0.05"
                    value={selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0}
                    onChange={(val) => {
                      const newScene = cloneSceneGraph(sceneGraph);
                      const traverse2 = (nodes: SceneNode[]) => {
                        if (!nodes) return false;
                        for (const node of nodes) {
                          if (node.id === selectedNode.id) {
                            node.coupleRatio = val;
                            return true;
                          }
                          if (traverse2(node.children)) return true;
                        }
                        return false;
                      };
                      traverse2(newScene.nodes);
                      updateScene(newScene);
                    }}
                    className="w-16 px-1.5 py-1.5 border border-slate-200 rounded text-xs text-center font-mono outline-none focus:border-blue-500"
                    title="Custom gear coupling ratio"
                  />
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
