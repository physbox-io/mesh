import React, { useState, useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import { useStore } from '../store/useStore';
import { analyzeSceneMechanicalWeaknesses, type WeakSpot } from '../utils/printAnalysis';
import { AlertTriangle, Info, AlertOctagon, Wrench, X } from 'lucide-react';

interface PrintAnalysisOverlayProps {
  activeSpotId?: string | null;
  onSelectSpot?: (spot: WeakSpot | null) => void;
}

export const PrintAnalysisOverlay: React.FC<PrintAnalysisOverlayProps> = ({
  activeSpotId,
  onSelectSpot,
}) => {
  const sceneGraph = useStore(state => state.sceneGraph);
  const printAnalysisEnabled = useStore(state => state.printAnalysisEnabled);
  const setSelectedNodeId = useStore(state => state.setSelectedNodeId);

  const [hoveredSpot, setHoveredSpot] = useState<WeakSpot | null>(null);

  const analysis = useMemo(() => {
    if (!printAnalysisEnabled || !sceneGraph) return null;
    return analyzeSceneMechanicalWeaknesses(sceneGraph);
  }, [sceneGraph, printAnalysisEnabled]);

  if (!printAnalysisEnabled || !analysis) return null;

  return (
    <group name="print-analysis-overlay" renderOrder={999}>
      {/* 3D Print Build Plate Reference Grid Footprint (220mm x 220mm at ground plane Z=0) */}
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[0.22, 0.22]} />
        <meshBasicMaterial
          color="#3b82f6"
          wireframe
          transparent
          opacity={0.15}
          depthWrite={false}
        />
      </mesh>

      {/* Weak Spot 3D Markers with Anchored Surface Pins & Leader Lines */}
      {analysis.weakSpots.map((spot) => {
        const [mx, my, mz] = spot.position;
        const [sx, sy, sz] = spot.surfacePoint || spot.position;
        const elevatedZ = mz + 0.035; // Elevated 35mm above surface

        const isHovered = hoveredSpot?.id === spot.id;
        const isActive = activeSpotId === spot.id;
        const isHighlighted = isHovered || isActive;

        let color = '#f59e0b'; // Amber warning
        if (spot.severity === 'critical') color = '#ef4444'; // Red critical
        else if (spot.severity === 'info') color = '#3b82f6'; // Blue info
        else if (spot.category === 'hardware') color = '#ec4899'; // Pink hardware

        return (
          <group key={spot.id} renderOrder={1000}>
            {/* 3D Visual Leader Line connecting Surface Anchor to Elevated Dot */}
            <Line
              points={[
                [sx, sy, sz],
                [mx, my, elevatedZ],
              ]}
              color={color}
              lineWidth={isHighlighted ? 2.5 : 1.5}
              transparent
              opacity={isHighlighted ? 0.9 : 0.6}
            />

            {/* Surface Anchor Pin (Rests directly on target mesh feature) */}
            <mesh position={[sx, sy, sz]}>
              <sphereGeometry args={[0.004, 10, 10]} />
              <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} />
            </mesh>

            {/* Elevated Callout Dot */}
            <group position={[mx, my, elevatedZ]}>
              <mesh
                onClick={(e) => {
                  e.stopPropagation();
                  if (spot.nodeId) setSelectedNodeId(spot.nodeId);
                  if (onSelectSpot) {
                    onSelectSpot(isActive ? null : spot);
                  }
                }}
                onPointerOver={(e) => {
                  e.stopPropagation();
                  setHoveredSpot(spot);
                }}
                onPointerOut={(e) => {
                  e.stopPropagation();
                  setHoveredSpot(null);
                }}
              >
                <sphereGeometry args={[isHighlighted ? 0.009 : 0.006, 12, 12]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={isHighlighted ? 0.95 : 0.8}
                  depthTest={false}
                />
              </mesh>

              {/* Highlight Ring when Active */}
              {isHighlighted && (
                <mesh>
                  <ringGeometry args={[0.012, 0.015, 24]} />
                  <meshBasicMaterial
                    color={color}
                    transparent
                    opacity={0.85}
                    depthTest={false}
                    side={2}
                  />
                </mesh>
              )}

              {/* HTML Tooltip Callout */}
              {isHighlighted && (
                <Html
                  position={[0, 0, 0.02]}
                  center
                  style={{ pointerEvents: 'none', transition: 'all 0.15s ease-out' }}
                >
                  <div className="w-64 bg-slate-900/95 backdrop-blur-md border border-slate-700/80 text-white rounded-xl shadow-2xl p-3 z-50 text-left pointer-events-auto select-none">
                    <div className="flex items-center justify-between gap-1.5 mb-1.5 border-b border-slate-800 pb-1.5">
                      <div className="flex items-center gap-1.5 truncate">
                        {spot.severity === 'critical' && <AlertOctagon className="w-4 h-4 text-red-400 shrink-0" />}
                        {spot.severity === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                        {spot.severity === 'info' && <Info className="w-4 h-4 text-blue-400 shrink-0" />}
                        <div className="text-xs font-bold truncate text-slate-100">{spot.title}</div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onSelectSpot) onSelectSpot(null);
                          setHoveredSpot(null);
                        }}
                        className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
                        title="Close alert"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="text-[11px] text-slate-300 mb-2 leading-relaxed">
                      {spot.description}
                    </div>

                    <div className="bg-blue-950/60 border border-blue-800/50 rounded-lg p-2 flex items-start gap-1.5 text-[10px] text-blue-200">
                      <Wrench className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold text-blue-300">Remedy: </span>
                        {spot.recommendation}
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[9px] text-slate-400 font-mono">
                      <span className="capitalize px-1.5 py-0.5 bg-slate-800 rounded border border-slate-700">
                        {spot.category}
                      </span>
                      <span className="truncate max-w-[120px]">Node: {spot.nodeName}</span>
                    </div>
                  </div>
                </Html>
              )}
            </group>
          </group>
        );
      })}
    </group>
  );
};
