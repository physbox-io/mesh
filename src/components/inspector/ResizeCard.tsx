import { useStore } from '../../store/useStore';
import { lengthSpan } from '../../utils/sliderSpan';
import type { SceneNode } from '../../types/scene';
import { ThreadField } from '../ThreadField';
import { SliderValue } from '../SliderValue';
import { ScaleControls } from '../ScaleCard';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';
import { ShapeParamFields } from './ShapeParamFields';
import { CurveFields } from './CurveFields';

/*
 * Resize. Here, after rotation, because it is the third thing
 * you do to a component and the panes below are a long way to
 * go for it. It carries the whole-body Scale multiplier as well:
 * Scale used to be a second card of its own in this slot, the
 * same control over the same state, with no telling the two
 * apart. The active sub-geom is resolved here rather than
 * inherited, since the geom-properties block it used to sit
 * inside now comes further down.
 */
export function ResizeCard({ node: selectedNode }: { node: SceneNode }) {
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);

  if (!selectedNode.geoms || selectedNode.geoms.length === 0) return null;
  const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
  const geom = selectedNode.geoms[activeIndex];
  if (!geom) return null;
  return (
    <>
      {!selectedNode.id.includes('gear') && (
        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
            <span className="flex items-center gap-1">📏 Resize Component</span>
            <DocsInfoButton tab="resize" />
          </h3>

          {selectedNode.teeth === undefined && (
            <div className="flex flex-col gap-2 pb-1 border-b border-slate-100">
              <label className="text-xs font-medium text-slate-500 flex justify-between">
                Scale <span>applies to every sub-geom together</span>
              </label>
              <ScaleControls nodeId={selectedNode.id} />
            </div>
          )}

          {geom.type === 'sphere' && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={geom.size[0]} onChange={(v) => {
                  const r = v;
                  updateNodeGeom(selectedNode.id, { size: [r] }, activeIndex);
                }} decimals={2} unit="m" min={0.01} /></label>
              <RangeInput 
                {...lengthSpan(geom.size[0])}
                value={geom.size[0]}
                onChange={(v) => {
                  const r = v;
                  updateNodeGeom(selectedNode.id, { size: [r] }, activeIndex);
                }}
                className="w-full accent-blue-500 cursor-pointer" 
              />
            </div>
          )}

          <ShapeParamFields node={selectedNode} geom={geom} />

          <CurveFields node={selectedNode} />

          {geom.type === 'ellipsoid' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Radius X <SliderValue value={geom.size[0]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[0])}
                  value={geom.size[0]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Y <SliderValue value={geom.size[1]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[1])}
                  value={geom.size[1]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Z <SliderValue value={geom.size[2]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[2])}
                  value={geom.size[2]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
            </div>
          )}

          {geom.type === 'box' && !selectedNode.isWedge && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Width (X) <SliderValue value={geom.size[0]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[0])}
                  value={geom.size[0]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <SliderValue value={geom.size[1]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[1])}
                  value={geom.size[1]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={geom.size[2]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                  }} decimals={2} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[2])}
                  value={geom.size[2]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
            </div>
          )}

          {(geom.type === 'capsule' || geom.type === 'cylinder') && !selectedNode.isPulleyWheel && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={geom.size[0]} onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { 
                      size: geom.size[1] !== undefined ? [val, geom.size[1]] : [val] 
                    }, activeIndex);
                  }} decimals={3} unit="m" min={0.01} /></label>
                <RangeInput 
                  {...lengthSpan(geom.size[0])}
                  value={geom.size[0]}
                  onChange={(v) => {
                    const val = v;
                    updateNodeGeom(selectedNode.id, { 
                      size: geom.size[1] !== undefined ? [val, geom.size[1]] : [val] 
                    }, activeIndex);
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
              {geom.size[1] !== undefined && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-500 flex justify-between">Length (Half-Height) <SliderValue value={geom.size[1]} onChange={(v) => {
                      const val = v;
                      updateNodeGeom(selectedNode.id, { size: [geom.size[0], val] }, activeIndex);
                    }} decimals={2} unit="m" min={0.01} /></label>
                  <RangeInput 
                    {...lengthSpan(geom.size[1])}
                    value={geom.size[1]}
                    onChange={(v) => {
                      const val = v;
                      updateNodeGeom(selectedNode.id, { size: [geom.size[0], val] }, activeIndex);
                    }}
                    className="w-full accent-blue-500 cursor-pointer" 
                  />
                </div>
              )}
              {geom.type === 'cylinder' && !geom.cutNormal && (
                <ThreadField node={selectedNode} geom={geom} index={activeIndex} />
              )}
              {geom.fromto !== undefined && (() => {
                // Held in a local so the handlers below, which
                // are functions and so lose the narrowing above,
                // read the same array.
                const fromto = geom.fromto;
                const dirX = fromto[3] - fromto[0];
                const dirY = fromto[4] - fromto[1];
                const dirZ = fromto[5] - fromto[2];
                const currentLength = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ) || 1.0;

                return (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-slate-500 flex justify-between">
                      Length (Segment) <SliderValue value={currentLength} onChange={(v) => {
                        const newVal = v;
                        const scale = newVal / currentLength;
                        const newFromto = [
                          fromto[0],
                          fromto[1],
                          fromto[2],
                          fromto[0] + dirX * scale,
                          fromto[1] + dirY * scale,
                          fromto[2] + dirZ * scale
                        ];
                        updateNodeGeom(selectedNode.id, { fromto: newFromto }, activeIndex);
                      }} decimals={2} unit="m" min={0.01} />
                    </label>
                    <RangeInput 
                      {...lengthSpan(currentLength)}
                      value={currentLength} 
                      onChange={(v) => {
                        const newVal = v;
                        const scale = newVal / currentLength;
                        const newFromto = [
                          fromto[0],
                          fromto[1],
                          fromto[2],
                          fromto[0] + dirX * scale,
                          fromto[1] + dirY * scale,
                          fromto[2] + dirZ * scale
                        ];
                        updateNodeGeom(selectedNode.id, { fromto: newFromto }, activeIndex);
                      }}
                      className="w-full accent-blue-500 cursor-pointer" 
                    />
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </>
  );
}
