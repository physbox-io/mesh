import { useStore } from '../../store/useStore';
import { lengthSpan } from '../../utils/sliderSpan';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';

/**
 * Size fields for the shapes sized by parameters on the body rather than by a
 * geom's size: wedge, pyramid, cone, torus and tube. Part of the Resize card.
 */
export function ShapeParamFields({ node, geom }: { node: SceneNode; geom: SceneGeom }) {
  const updateConeParams = useStore((s) => s.updateConeParams);
  const updatePyramidParams = useStore((s) => s.updatePyramidParams);
  const updateTorusParams = useStore((s) => s.updateTorusParams);
  const updateTubeParams = useStore((s) => s.updateTubeParams);
  const updateWedgeParams = useStore((s) => s.updateWedgeParams);

  return (
    <>
      {geom.type === 'box' && node.isWedge && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <SliderValue value={node.width || 2.0} onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { width: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.width || 2.0)}
              value={node.width || 2.0}
              onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { width: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <SliderValue value={node.depth || 1.0} onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { depth: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.depth || 1.0)}
              value={node.depth || 1.0}
              onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { depth: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={node.height || 0.5} onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { height: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.height || 0.5)}
              value={node.height || 0.5}
              onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { height: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1 border-t border-slate-100 pt-2">
            <label className="text-xs font-medium text-slate-600 flex justify-between">Wedge Angle <SliderValue value={node.wedgeAngle !== undefined ? node.wedgeAngle : 14.036} onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { wedgeAngle: val });
              }} decimals={1} unit="°" min={2} max={85} /></label>
            <RangeInput 
              min="2" 
              max="85" 
              step="1" 
              value={node.wedgeAngle !== undefined ? node.wedgeAngle : 14.036}
              onChange={(v) => {
                const val = v;
                updateWedgeParams(node.id, { wedgeAngle: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
        </div>
      )}

      {node.isPyramid && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <SliderValue value={node.width || 0.5} onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { width: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.width || 0.5)}
              value={node.width || 0.5}
              onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { width: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Base Depth (Y) <SliderValue value={node.depth || 0.5} onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { depth: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.depth || 0.5)}
              value={node.depth || 0.5}
              onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { depth: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={node.height || 0.5} onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { height: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.height || 0.5)}
              value={node.height || 0.5}
              onChange={(v) => {
                const val = v;
                updatePyramidParams(node.id, { height: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
        </div>
      )}

      {node.isCone && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={node.radius || 0.3} onChange={(v) => {
                const val = v;
                updateConeParams(node.id, { radius: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.radius || 0.3)}
              value={node.radius || 0.3}
              onChange={(v) => {
                const val = v;
                updateConeParams(node.id, { radius: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Height <SliderValue value={node.height || 0.6} onChange={(v) => {
                const val = v;
                updateConeParams(node.id, { height: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.height || 0.6)}
              value={node.height || 0.6}
              onChange={(v) => {
                const val = v;
                updateConeParams(node.id, { height: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
        </div>
      )}

      {node.isTorus && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Major Radius (Ring) <SliderValue value={node.majorRadius || 0.4} onChange={(v) => {
                const val = v;
                updateTorusParams(node.id, { majorRadius: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.majorRadius || 0.4)}
              value={node.majorRadius || 0.4}
              onChange={(v) => {
                const val = v;
                updateTorusParams(node.id, { majorRadius: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Tube Radius <SliderValue value={node.tubeRadius || 0.1} onChange={(v) => {
                const val = v;
                updateTorusParams(node.id, { tubeRadius: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.tubeRadius || 0.1)}
              value={node.tubeRadius || 0.1}
              onChange={(v) => {
                const val = v;
                updateTorusParams(node.id, { tubeRadius: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
        </div>
      )}

      {node.isTube && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Inner Radius <SliderValue value={node.innerRadius || 0.2} onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { innerRadius: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.innerRadius || 0.2)}
              max={node.outerRadius ? node.outerRadius - 0.01 : 0.29}
              value={node.innerRadius || 0.2} 
              onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { innerRadius: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Outer Radius <SliderValue value={node.outerRadius || 0.3} onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { outerRadius: val });
              }} decimals={1} unit="mm" scale={1000} /></label>
            <RangeInput 
              {...lengthSpan(node.outerRadius || 0.3)}
              min={node.innerRadius ? node.innerRadius + 0.01 : 0.21}
              value={node.outerRadius || 0.3} 
              onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { outerRadius: val });
              }}
              className="w-full accent-blue-500 cursor-pointer" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={node.height || 0.5} onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { height: val });
              }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
            <RangeInput 
              {...lengthSpan(node.height || 0.5)}
              value={node.height || 0.5}
              onChange={(v) => {
                const val = v;
                updateTubeParams(node.id, { height: val });
              }}
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>
        </div>
      )}
    </>
  );
}
