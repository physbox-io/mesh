import React, { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import { type WeakSpot } from '../utils/printAnalysis';
import {
  setActiveDfmFinding,
  setHoveredDfmFinding,
  useDfmFocus,
  type DfmFocusTarget,
} from '../utils/dfmWorkerClient';
import { metresPerPixel } from '../utils/cameraScale';
import { AlertTriangle, Info, AlertOctagon, Wrench, X } from 'lucide-react';

interface PrintAnalysisOverlayProps {
  activeSpotId?: string | null;
  onSelectSpot?: (spot: WeakSpot | null) => void;
}

const NO_RAYCAST = () => null;
const OVERLAY_USER_DATA = { isOverlay: true, skipExport: true } as const;

// Shared unit geometries scaled dynamically by `metresPerPixel` so hovering or
// focusing findings never allocates or rebuilds GPU buffers.
const UNIT_SPHERE = new THREE.SphereGeometry(1, 14, 14);
const UNIT_RING = new THREE.RingGeometry(1.45, 1.85, 24);

const STEM_POINTS: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 5.5],
];

const SEVERITY_COLOR: Record<DfmFocusTarget['severity'], string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

const PROCESS_BADGE: Record<string, string> = {
  print: '3D print',
  cnc: '3-axis CNC',
  cast: 'Casting',
};

interface FindingPinProps {
  target: DfmFocusTarget;
  isActive: boolean;
  showTooltip: boolean;
  onClose?: () => void;
  onSelectNode?: (nodeId: string) => void;
}

const FindingPin: React.FC<FindingPinProps> = ({
  target,
  isActive,
  showTooltip,
  onClose,
  onSelectNode,
}) => {
  const anchorRef = useRef<THREE.Group>(null);
  const scaledRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const tmpWorld = useRef(new THREE.Vector3());
  const getThree = useThree((s) => s.get);

  const color = SEVERITY_COLOR[target.severity] ?? '#f59e0b';

  const applyScale = (cam: THREE.Camera, canvasHeight: number, pulse = 1) => {
    const anchor = anchorRef.current;
    const scaled = scaledRef.current;
    if (!anchor || !scaled) return;
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(tmpWorld.current);
    const dist = cam.position.distanceTo(tmpWorld.current);
    const mpp = metresPerPixel(cam, dist, canvasHeight);
    const radius = THREE.MathUtils.clamp(mpp * 6, 0.0015, 0.04);
    scaled.scale.setScalar(radius);
    if (ringRef.current) {
      ringRef.current.scale.setScalar(pulse);
      ringRef.current.lookAt(cam.position);
    }
  };

  // Size immediately before the first paint so a 1 m unit sphere never flashes.
  useLayoutEffect(() => {
    const { camera: cam, size: viewSize } = getThree();
    applyScale(cam, viewSize.height, 1);
  }, [getThree, target.position]);

  useFrame(({ camera: cam, size: viewSize, clock }) => {
    const pulse = isActive ? 1 + 0.14 * Math.sin(clock.getElapsedTime() * 5) : 1;
    applyScale(cam, viewSize.height, pulse);
  });

  const [px, py, pz] = target.position;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;

  return (
    <group ref={anchorRef} position={[px, py, pz]} renderOrder={1000} userData={OVERLAY_USER_DATA}>
      <group ref={scaledRef} userData={OVERLAY_USER_DATA}>
        {/* Leader line from surface anchor up to elevated callout dot */}
        <Line
          points={STEM_POINTS}
          color={color}
          lineWidth={isActive ? 2.5 : 1.8}
          transparent
          opacity={0.9}
          raycast={NO_RAYCAST}
          userData={OVERLAY_USER_DATA}
        />

        {/* Surface anchor dot */}
        <mesh
          geometry={UNIT_SPHERE}
          scale={0.55}
          raycast={NO_RAYCAST}
          userData={OVERLAY_USER_DATA}
        >
          <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} depthWrite={false} />
        </mesh>

        {/* Elevated callout dot + ring + tooltip */}
        <group position={[0, 0, 5.5]} userData={OVERLAY_USER_DATA}>
          <mesh
            geometry={UNIT_SPHERE}
            scale={isActive ? 1.15 : 1}
            userData={OVERLAY_USER_DATA}
            onClick={(e) => {
              e.stopPropagation();
              if (target.nodeId && onSelectNode) onSelectNode(target.nodeId);
              if (isActive && onClose) onClose();
            }}
          >
            <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} depthWrite={false} />
          </mesh>

          <mesh
            ref={ringRef}
            geometry={UNIT_RING}
            raycast={NO_RAYCAST}
            userData={OVERLAY_USER_DATA}
          >
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.85}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>

          {showTooltip && (
            <Html
              position={[0, 0, 2.2]}
              center
              style={{ pointerEvents: 'none', transition: 'all 0.12s ease-out' }}
            >
              <div
                className={`w-64 rounded-xl border border-slate-700/80 bg-slate-900/95 p-3 text-left text-white shadow-2xl backdrop-blur-md select-none ${isActive ? 'pointer-events-auto' : 'pointer-events-none'}`}
              >
                <div className="mb-1.5 flex items-center justify-between gap-1.5 border-b border-slate-800 pb-1.5">
                  <div className="flex items-center gap-1.5 truncate">
                    {target.severity === 'critical' && <AlertOctagon className="h-4 w-4 shrink-0 text-red-400" />}
                    {target.severity === 'warning' && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />}
                    {target.severity === 'info' && <Info className="h-4 w-4 shrink-0 text-blue-400" />}
                    <div className="truncate text-xs font-bold text-slate-100">{target.title}</div>
                  </div>
                  {isActive && onClose && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                      }}
                      className="shrink-0 cursor-pointer rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                      title="Dismiss pin"
                      aria-label="Dismiss pin"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="mb-2 text-[11px] leading-relaxed text-slate-300">
                  {target.detail}
                </div>

                {target.fix && (
                  <div className="flex items-start gap-1.5 rounded-lg border border-blue-800/50 bg-blue-950/60 p-2 text-[10px] text-blue-200">
                    <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
                    <div>
                      <span className="font-semibold text-blue-300">Fix: </span>
                      {target.fix}
                    </div>
                  </div>
                )}

                {(target.process || target.nodeId) && (
                  <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-slate-400">
                    {target.process && (
                      <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5">
                        {PROCESS_BADGE[target.process] ?? target.process}
                      </span>
                    )}
                    {target.nodeId && (
                      <span className="ml-auto max-w-[140px] truncate">{target.nodeId}</span>
                    )}
                  </div>
                )}
              </div>
            </Html>
          )}
        </group>
      </group>
    </group>
  );
};

export const PrintAnalysisOverlay: React.FC<PrintAnalysisOverlayProps> = () => {
  const dfmEnabled = useStore(state => state.dfmEnabled);
  const minimized = useStore(state => state.dfmPanel.minimized);
  const setSelectedNodeId = useStore(state => state.setSelectedNodeId);
  const { hovered, active } = useDfmFocus();

  const open = dfmEnabled && !minimized;
  if (!open) return null;

  const primary = hovered ?? active;
  if (!primary) return null;

  const showSecondaryActive = Boolean(hovered && active && hovered.id !== active.id);

  return (
    <group renderOrder={999} userData={OVERLAY_USER_DATA}>
      <FindingPin
        target={primary}
        isActive={active?.id === primary.id}
        showTooltip
        onClose={() => {
          setActiveDfmFinding(null);
          setHoveredDfmFinding(null);
        }}
        onSelectNode={setSelectedNodeId}
      />
      {showSecondaryActive && active && (
        <FindingPin
          target={active}
          isActive
          showTooltip={false}
          onClose={() => setActiveDfmFinding(null)}
          onSelectNode={setSelectedNodeId}
        />
      )}
    </group>
  );
};
