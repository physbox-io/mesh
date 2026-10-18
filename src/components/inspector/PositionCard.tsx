import { offsetSpan } from '../../utils/sliderSpan';
import { getStickyRotation } from '../../utils/geom';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';

/** Position and rotation; applies to every node. */
export function PositionCard({ node }: { node: SceneNode }) {
  const rotateAroundCOM = useStore((s) => s.rotateAroundCOM);
  const setRotateAroundCOM = useStore((s) => s.setRotateAroundCOM);
  const updateNodePos = useStore((s) => s.updateNodePos);
  const updateNodeRotation = useStore((s) => s.updateNodeRotation);

  // Utility to handle moving free bodies
  const handleMove = (axis: 0 | 1 | 2, val: number) => {
    const cleanVal = isNaN(val) ? 0 : val;

    // Always update the scene-graph initial position (persists on reset/restart)
    const currentPos = [...node.pos] as [number, number, number];
    currentPos[axis] = cleanVal;
    updateNodePos(node.id, currentPos);

    // Also directly move the body in the live sim (via the physics worker) so
    // only THIS body moves, regardless of whether playing or paused. This
    // avoids the full forceReset recompile (from updateNodePos alone) which
    // was snapping all other bodies back to their initial positions.
    const freeJoint = node.joints?.find((j) => j.type === 'free');
    if (freeJoint) {
      getPhysicsWorkerClient().setQpos(freeJoint.name, axis, cleanVal);
    }
  };

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
        <span>Position Offset</span>
        <DocsInfoButton tab="offset" />
      </h3>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-500 font-medium">X Position</label>
            <SliderValue
              value={node.pos[0]}
              onChange={(v) => handleMove(0, v)}
              decimals={1}
              unit="mm"
              scale={1000}
              className="text-xs text-slate-500"
            />
          </div>
          <RangeInput 
            {...offsetSpan(node.pos[0])}
            className="w-full accent-blue-500 cursor-pointer" 
            value={node.pos[0]} 
            onChange={(v) => handleMove(0, v)} 
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-500 font-medium">Y Position</label>
            <SliderValue
              value={node.pos[1]}
              onChange={(v) => handleMove(1, v)}
              decimals={1}
              unit="mm"
              scale={1000}
              className="text-xs text-slate-500"
            />
          </div>
          <RangeInput 
            {...offsetSpan(node.pos[1])}
            className="w-full accent-blue-500 cursor-pointer" 
            value={node.pos[1]} 
            onChange={(v) => handleMove(1, v)} 
          />
        </div>
        <div className="flex flex-col gap-1.5">
          {(() => {
            // For dynamic mesh bodies, pos[2] = centroid Z, not base Z.
            // Compute centroid offset from renderVertices so slider 0 = base on ground.
            const dynMesh = node.geoms?.find((g) => g.dynamic && g.renderVertices);
            const centroidZ = dynMesh
              ? -Math.min(...(dynMesh.renderVertices as number[]).filter((_: number, i: number) => i % 3 === 2))
              : 0;
            const displayZ = node.pos[2] - centroidZ;
            return (<>
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-500 font-medium flex items-center gap-1">
                  Z Position (Height)
                  {centroidZ > 0 ? <span className="text-slate-300 text-[10px]">(+{(centroidZ * 1000).toFixed(1)} mm centroid)</span> : null}
                </label>
                <SliderValue
                  value={displayZ}
                  onChange={(v) => handleMove(2, v + centroidZ)}
                  decimals={1}
                  unit="mm"
                  scale={1000}
                  className="text-xs text-slate-500"
                />
              </div>
              <RangeInput
                {...offsetSpan(displayZ)}
                className="w-full accent-blue-500 cursor-pointer"
                value={displayZ}
                onChange={(v) => handleMove(2, v + centroidZ)}
              />
            </>);
          })()}
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Rotation Pivot</span>
          <label 
            className="text-xs font-medium text-slate-600 flex items-center gap-1.5 cursor-pointer bg-slate-50 hover:bg-slate-100 px-2 py-0.5 rounded border border-slate-200 transition-colors"
            title={rotateAroundCOM ? "Rotate component in-place around its Center of Mass" : "Rotate component around World Origin (0,0,0)"}
          >
            <input 
              type="checkbox" 
              checked={rotateAroundCOM} 
              onChange={(e) => setRotateAroundCOM(e.target.checked)} 
              className="w-3.5 h-3.5 rounded text-blue-500 accent-blue-500 cursor-pointer"
            />
            Center of Mass
          </label>
        </div>
        <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
          <label className="text-xs text-slate-500 flex items-center justify-between font-medium">X Rotation
            <SliderValue value={getStickyRotation(node.euler ? node.euler[0] : 0)} onChange={(v) => updateNodeRotation(node.id, 0, v)} decimals={0} unit="°" min={0} max={360} />
          </label>
          <RangeInput 
            min="0" 
            max="360" 
            step="1" 
            className="w-full accent-blue-500 cursor-pointer" 
            value={node.euler ? node.euler[0] : 0} 
            onChange={(v) => updateNodeRotation(node.id, 0, v)} 
          />
        </div>
        <div className="flex flex-col gap-1.5 mt-1">
          <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Y Rotation
            <SliderValue value={getStickyRotation(node.euler ? node.euler[1] : 0)} onChange={(v) => updateNodeRotation(node.id, 1, v)} decimals={0} unit="°" min={0} max={360} />
          </label>
          <RangeInput 
            min="0" 
            max="360" 
            step="1" 
            className="w-full accent-blue-500 cursor-pointer" 
            value={node.euler ? node.euler[1] : 0} 
            onChange={(v) => updateNodeRotation(node.id, 1, v)} 
          />
        </div>
        <div className="flex flex-col gap-1.5 mt-1">
          <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Z Rotation
            <SliderValue value={getStickyRotation(node.euler ? node.euler[2] : 0)} onChange={(v) => updateNodeRotation(node.id, 2, v)} decimals={0} unit="°" min={0} max={360} />
          </label>
          <RangeInput 
            min="0" 
            max="360" 
            step="1" 
            className="w-full accent-blue-500 cursor-pointer" 
            value={node.euler ? node.euler[2] : 0} 
            onChange={(v) => updateNodeRotation(node.id, 2, v)} 
          />
        </div>
      </div>
    </div>
  );
}
