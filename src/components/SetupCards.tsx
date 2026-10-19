import React from 'react';
import { Download, Eye, Lightbulb, Play, RotateCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { SolidSetupResult, SetupPlanSummary } from '../utils/solidSetups';
import { setupDiagramSvg } from '../utils/setupDiagram';
import { FACE_NAME, type BlockFace, type StockSize } from '../utils/orient';
import { formatDuration } from '../utils/timeEstimate';

/** "Right end up", "Top up". */
export const faceUpLabel = (f: BlockFace) => `${FACE_NAME[f][0].toUpperCase()}${FACE_NAME[f].slice(1)} up`;

/**
 * The plan for a part machined from more than one face: one card per setup,
 * in the order they run, each with a picture of how the block stands.
 *
 * Written for someone doing this for the first time. Every card says what the
 * block looks like, what this setup is for, and what it costs, and the three
 * things that can be done with it: look at its path, save it, cut it.
 */
export function SetupCards({
  setups,
  firstStock,
  pins,
  plan,
  selected,
  onSelect,
  onDownload,
  onRun,
  canRun,
}: {
  setups: SolidSetupResult[];
  firstStock: StockSize;
  /** Pin centres in setup 1's frame, when the flip is on pins. */
  pins: { x: number; y: number }[];
  plan?: SetupPlanSummary;
  selected: number;
  onSelect: (index: number) => void;
  onDownload: (index: number) => void;
  onRun: (index: number) => void;
  canRun: boolean;
}) {
  const total = setups.reduce((t, s) => t + s.estimatedTimeSeconds, 0);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {plan?.text ?? (setups.length === 1 ? 'One setup, from the top.' : `${setups.length} setups.`)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> About {formatDuration(total)} on the machine in all.</span>
        </p>
        {plan && (
          <p className={`flex items-start gap-1.5 text-xs leading-snug ${plan.remaining.mm3 > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
            {plan.remaining.mm3 > 0 ? <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
            <span>{plan.remaining.text}</span>
          </p>
        )}
        {plan?.redesignHint && (
          <p className="flex items-start gap-1.5 text-xs leading-snug text-slate-600 dark:text-slate-300">
            <Lightbulb className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>{plan.redesignHint}</span>
          </p>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {setups.map((s, i) => {
          const carved = setups.slice(0, i).map((q) => q.upFace);
          const turnedPins =
            s.locate === 'pins' && s.upFace === '-z'
              ? pins.map((p) => ({ x: firstStock.widthMm - p.x, y: p.y }))
              : undefined;
          const svg = setupDiagramSvg({
            upFace: s.upFace,
            firstStock,
            carved,
            locate: s.locate,
            pins: turnedPins,
            window: s.upFace === '+z' || s.upFace === '-z' ? undefined : s.windowBounds,
            widthPx: 220,
          });
          const deep = s.lengthOverDia > 4;
          const isSelected = i === selected;
          return (
            <React.Fragment key={`${s.upFace}-${i}`}>
              {i > 0 && (
                <div className="flex flex-col items-center justify-center text-slate-400 px-0.5" title="Turn the block">
                  <RotateCw className="w-4 h-4" />
                  <span className="text-[9px] uppercase tracking-wide">turn</span>
                </div>
              )}
              <div
                className={`flex-shrink-0 w-[236px] rounded-xl border p-2 space-y-1.5 bg-white dark:bg-slate-900 ${
                  isSelected ? 'border-blue-500 ring-1 ring-blue-500/40' : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-500 text-slate-950 text-[11px] font-bold flex items-center justify-center">
                    {s.index}
                  </span>
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{faceUpLabel(s.upFace)}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-500 dark:text-slate-400">{formatDuration(s.estimatedTimeSeconds)}</span>
                </div>
                <div
                  className="text-slate-700 dark:text-slate-200 flex justify-center"
                  // Built here from numbers, never from user text.
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <ul className="text-[11px] leading-snug text-slate-600 dark:text-slate-300 space-y-0.5">
                  {s.upFace !== '+z' && s.upFace !== '-z' && (
                    <li>Stands {s.standingHeightMm.toFixed(0)} mm tall</li>
                  )}
                  <li className={deep ? 'text-amber-700 dark:text-amber-300' : undefined}>
                    Cuts {s.depthMm.toFixed(1)} mm deep{deep ? `, ${s.lengthOverDia.toFixed(1)}× the bit: go gently` : ''}
                  </li>
                  {s.clearedMm3 > 0 && s.index > 1 && <li>Takes off about {Math.round(s.clearedMm3).toLocaleString()} mm³</li>}
                  {s.allowanceMm > 0 && <li>Leaves {s.allowanceMm.toFixed(1)} mm to sand off where it finishes</li>}
                  <li>{s.locate === 'pins' ? 'Located on the pins' : s.index === 1 ? 'Zero on the near-left corner' : 'Located by touching off the block'}</li>
                </ul>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => onSelect(i)}
                    title="Show this setup's toolpath below"
                    className={`flex-1 py-1 px-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                      isSelected ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" /> Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => onDownload(i)}
                    title="Save this setup's program as a G-code file"
                    className="py-1 px-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-blue-400" /> .gcode
                  </button>
                  <button
                    type="button"
                    onClick={() => onRun(i)}
                    disabled={!canRun}
                    title={s.index === 1 ? 'Cut this setup' : 'Turn the block and cut this setup, step by step'}
                    className="py-1 px-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-slate-950 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Cut
                  </button>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
