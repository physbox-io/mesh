import React from 'react';
import type { LiveHeadActivity, SvgLiveOverlayState } from '../utils/svgLiveOverlay';

/**
 * Memoised wrapper for the static SVG string so 5 Hz machine status polls never
 * trigger React to re-apply `dangerouslySetInnerHTML` and rebuild the SVG DOM.
 */
export const StaticSvgLayer = React.memo(function StaticSvgLayer({
  html,
  className,
}: {
  html: string;
  className: string;
}) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

function activityLabel(activity: LiveHeadActivity, mode: 'laser' | 'cnc'): string {
  switch (activity) {
    case 'cutting':
      return mode === 'laser' ? 'Laser ON' : 'Cutting';
    case 'rapid':
      return 'Rapid';
    case 'paused':
      return 'Paused';
    case 'alarm':
      return 'Alarm';
    case 'idle':
    default:
      return 'Idle';
  }
}

function activityStroke(activity: LiveHeadActivity, mode: 'laser' | 'cnc'): string {
  switch (activity) {
    case 'cutting':
      return mode === 'laser' ? '#F97316' : '#10B981';
    case 'rapid':
      return '#0EA5E9';
    case 'paused':
      return '#F59E0B';
    case 'alarm':
      return '#DC2626';
    case 'idle':
    default:
      return '#6366F1';
  }
}

function activityDotClass(activity: LiveHeadActivity, mode: 'laser' | 'cnc'): string {
  switch (activity) {
    case 'cutting':
      return mode === 'laser' ? 'bg-orange-500 animate-pulse' : 'bg-emerald-500 animate-pulse';
    case 'rapid':
      return 'bg-sky-500';
    case 'paused':
      return 'bg-amber-500 animate-pulse';
    case 'alarm':
      return 'bg-red-600 animate-pulse';
    case 'idle':
    default:
      return 'bg-indigo-400';
  }
}

/**
 * Non-interactive 2D SVG live machine overlay positioned over the static cut preview.
 * Shares the exact same `viewBox` as the static SVG so it scales pixel-for-pixel in
 * both "Fit to width" and "Actual size" modes.
 */
export const SvgLiveOverlay: React.FC<{ state: SvgLiveOverlayState }> = React.memo(
  function SvgLiveOverlay({ state }) {
    const maxDim = Math.max(state.viewBoxWidth, state.viewBoxHeight, 1);
    // Scale-invariant marker unit so crosshairs stay crisp on both 100mm and 2400mm sheets.
    const unit = Math.max(1.2, Math.min(20, maxDim / 95));
    const strokeW = Math.max(0.4, unit * 0.16);
    const completedStrokeW = Math.max(0.8, unit * 0.24);
    const color = activityStroke(state.activity, state.machineMode);

    const cx = state.inBounds ? state.headX : state.clampedHeadX;
    const cy = state.inBounds ? state.headY : state.clampedHeadY;
    const ringR = unit * 1.15;
    const crossLen = unit * 2.1;
    const bitRadius =
      state.machineMode === 'cnc' && state.bitDiameterMm && state.bitDiameterMm > 0
        ? state.bitDiameterMm / 2
        : 0;

    return (
      <svg
        data-testid="svg-live-overlay"
        data-activity={state.activity}
        data-machine-mode={state.machineMode}
        data-active-sheet={state.activeSheetIndex}
        viewBox={`0 0 ${state.viewBoxWidth} ${state.viewBoxHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 w-full h-full pointer-events-none select-none overflow-visible"
        aria-hidden="true"
      >
        {/* Active sheet highlight when a multi-sheet job is running */}
        {state.isLiveJob && state.totalSheets > 1 && (
          <rect
            data-testid="live-active-sheet-frame"
            x={0}
            y={state.activeSheetRect.topY}
            width={state.activeSheetRect.widthMm}
            height={state.activeSheetRect.heightMm}
            fill="none"
            stroke={color}
            strokeWidth={strokeW * 1.4}
            strokeOpacity={0.55}
            strokeDasharray={`${unit * 1.4} ${unit * 0.8}`}
          />
        )}

        {/* Completed cut toolpath trail */}
        {state.completedPathD && (
          <path
            data-testid="live-completed-path"
            d={state.completedPathD}
            fill="none"
            stroke="#10B981"
            strokeWidth={completedStrokeW}
            strokeOpacity={0.85}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Live machine head marker */}
        <g
          data-testid="live-head-marker"
          transform={`translate(${cx.toFixed(3)} ${cy.toFixed(3)})`}
          opacity={state.activity === 'idle' ? 0.78 : 1}
        >
          {/* True-scale router bit footprint */}
          {bitRadius > 0 && (
            <circle
              r={bitRadius}
              fill={color}
              fillOpacity={state.activity === 'cutting' ? 0.25 : 0.12}
              stroke={color}
              strokeWidth={Math.min(strokeW, bitRadius * 0.25)}
              strokeOpacity={0.75}
            />
          )}

          {/* Active cutting glow halo */}
          {state.activity === 'cutting' && (
            <circle
              r={ringR * 1.55}
              fill={color}
              fillOpacity={state.machineMode === 'laser' ? 0.24 : 0.16}
            />
          )}

          {/* Outer target ring (dashed when paused or off-sheet) */}
          <circle
            r={ringR}
            fill="none"
            stroke={color}
            strokeWidth={strokeW * 1.25}
            strokeDasharray={
              !state.inBounds || state.activity === 'paused'
                ? `${unit * 0.55} ${unit * 0.4}`
                : undefined
            }
          />

          {/* Crosshair ticks */}
          <line
            x1={-crossLen}
            y1={0}
            x2={-ringR * 0.45}
            y2={0}
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
          <line
            x1={ringR * 0.45}
            y1={0}
            x2={crossLen}
            y2={0}
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
          <line
            x1={0}
            y1={-crossLen}
            x2={0}
            y2={-ringR * 0.45}
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
          <line
            x1={0}
            y1={ringR * 0.45}
            x2={0}
            y2={crossLen}
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
          />

          {/* Distinct center core: laser beam dot vs CNC router diagonal flute cross */}
          {state.machineMode === 'laser' ? (
            <circle
              r={state.activity === 'cutting' ? unit * 0.42 : unit * 0.24}
              fill={state.activity === 'cutting' ? '#EF4444' : color}
            />
          ) : (
            <>
              <line
                x1={-ringR * 0.48}
                y1={-ringR * 0.48}
                x2={ringR * 0.48}
                y2={ringR * 0.48}
                stroke={color}
                strokeWidth={strokeW * 0.9}
                strokeLinecap="round"
              />
              <line
                x1={-ringR * 0.48}
                y1={ringR * 0.48}
                x2={ringR * 0.48}
                y2={-ringR * 0.48}
                stroke={color}
                strokeWidth={strokeW * 0.9}
                strokeLinecap="round"
              />
              <circle r={unit * 0.22} fill={color} />
            </>
          )}
        </g>
      </svg>
    );
  },
);

/**
 * Compact live status & coordinate readout pill placed in the preview corner.
 * Matches `ToolpathView`'s dark HUD styling and stays non-interactive.
 */
export const SvgLiveHud: React.FC<{ state: SvgLiveOverlayState }> = React.memo(
  function SvgLiveHud({ state }) {
    const label = activityLabel(state.activity, state.machineMode);
    return (
      <div
        data-testid="svg-live-hud"
        className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-2 px-2 py-1 rounded-lg bg-slate-900/85 text-slate-100 border border-slate-700/80 shadow-sm text-[10px] font-mono tabular-nums pointer-events-none select-none backdrop-blur-xs"
      >
        <span className="inline-flex items-center gap-1.5 font-sans font-semibold uppercase tracking-wide text-[9px]">
          <span className={`w-1.5 h-1.5 rounded-full ${activityDotClass(state.activity, state.machineMode)}`} />
          <span>{label}</span>
        </span>
        <span className="text-slate-300">
          X{state.workX.toFixed(1)} Y{state.workY.toFixed(1)}
          {state.machineMode === 'cnc' ? ` Z${state.workZ.toFixed(1)}` : ''}
        </span>
        {state.totalSheets > 1 && (
          <span className="text-slate-400">
            S{state.activeSheetIndex + 1}/{state.totalSheets}
          </span>
        )}
        {!state.inBounds && (
          <span className="text-amber-400 font-sans font-semibold">Off-sheet</span>
        )}
      </div>
    );
  },
);
