import React, { useState } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ChevronsUp, ChevronsDown, Crosshair, Navigation, Octagon, Info, Check } from 'lucide-react';
import { NumberInput } from './NumberInput';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';

/**
 * Setting the job's origin on a live machine: jog the tool where you want it,
 * zero X/Y there, then touch off Z on a plate.
 *
 * The jog pad exists because "zero XY" on its own is only ever half an answer —
 * it fixes the origin at wherever the tool happens to be, and there is no way to
 * get it over the corner of the stock from the browser without driving it. Steps
 * are the usual coarse/medium/fine ladder, so the last approach is a tenth at a
 * time.
 *
 * Shared by the laser, contour and relief modals, which all sit on the same dark
 * machine panel.
 */
export const MachineWorkOriginPanel: React.FC<{
  machineState: MachineState;
  /** Laser has no touch plate, so the Z section is hidden for it. */
  showZProbe?: boolean;
  /** Deep-links to the zeroing walkthrough in the app's Reference Guide. */
  onOpenDocs?: () => void;
}> = ({ machineState, showZProbe = true, onOpenDocs }) => {
  const [step, setStep] = useState(1);
  const [feedrate, setFeedrate] = useState(1000);
  const [plateThickness, setPlateThickness] = useState(12.0);
  const [isProbingZ, setIsProbingZ] = useState(false);
  const [probeMessage, setProbeMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Ticks the steps off as they are done. Which of the three you have actually
  // finished is invisible on the machine itself, and getting it wrong is the
  // beginner's mistake that ends with a cut in the wrong place.
  const [xyZeroed, setXyZeroed] = useState(false);

  const busy = machineState.status === 'RUNNING' || isProbingZ;
  const zZeroed = probeMessage?.ok === true;

  const jog = (x: number, y: number, z: number) => {
    setXyZeroed(false); // moved since zeroing, so the origin is no longer here
    return webSerialManager.jog({ x: x * step, y: y * step, z: z * step }, feedrate);
  };

  const handleZeroXY = async () => {
    await webSerialManager.zeroXY();
    setXyZeroed(true);
  };

  const handleZeroZ = async () => {
    setIsProbingZ(true);
    setProbeMessage(null);
    try {
      const result = await webSerialManager.zeroZ(plateThickness);
      setProbeMessage({ ok: result.success, text: result.message });
    } finally {
      setIsProbingZ(false);
    }
  };

  const jogBtn = 'flex items-center justify-center h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-200 transition-colors';
  const actionBtn = 'flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1.5';

  return (
    <div className="pt-3 border-t border-slate-800 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center space-x-1.5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">Set Work Origin</h4>
          {onOpenDocs && (
            <button
              type="button"
              onClick={onOpenDocs}
              title="New to this? Open the step-by-step zeroing guide"
              className="text-slate-500 hover:text-blue-400 transition-colors cursor-pointer"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center space-x-2 text-[11px] font-mono bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
          <span className="text-slate-500">WPos:</span>
          <span>
            X:{machineState.wpos.x.toFixed(2)} Y:{machineState.wpos.y.toFixed(2)} Z:{machineState.wpos.z.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Jog pad — XY on the left cluster, Z on its own column, as on a pendant */}
        <div className="flex flex-col space-y-1.5">
          <span className="text-[10px] uppercase font-bold text-slate-500">
            <span className="text-blue-400">1.</span> Jog to your origin
          </span>
          <div className="flex items-start space-x-3">
          <div className="grid grid-cols-3 gap-1 w-[132px]">
            <span />
            <button disabled={busy} onClick={() => jog(0, 1, 0)} title={`Y +${step} mm`} className={jogBtn}>
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <span />
            <button disabled={busy} onClick={() => jog(-1, 0, 0)} title={`X -${step} mm`} className={jogBtn}>
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button
              disabled={busy}
              onClick={() => webSerialManager.jogCancel()}
              title="Stop the current jog"
              className={`${jogBtn} text-red-400`}
            >
              <Octagon className="w-3.5 h-3.5" />
            </button>
            <button disabled={busy} onClick={() => jog(1, 0, 0)} title={`X +${step} mm`} className={jogBtn}>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <span />
            <button disabled={busy} onClick={() => jog(0, -1, 0)} title={`Y -${step} mm`} className={jogBtn}>
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <span />
          </div>

          <div className="grid grid-cols-1 gap-1 w-10">
            <button disabled={busy} onClick={() => jog(0, 0, 1)} title={`Z +${step} mm`} className={jogBtn}>
              <ChevronsUp className="w-3.5 h-3.5" />
            </button>
            <span className="text-[9px] text-center text-slate-500 font-bold leading-8">Z</span>
            <button disabled={busy} onClick={() => jog(0, 0, -1)} title={`Z -${step} mm`} className={jogBtn}>
              <ChevronsDown className="w-3.5 h-3.5" />
            </button>
          </div>
          </div>
        </div>

        {/* Step / feed, then fix the origin where the jogging left the tool */}
        <div className="space-y-2">
          <div>
            <span className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Jog Step (mm)</span>
            <div className="flex space-x-1">
              {[0.1, 1, 10].map((s) => (
                <button
                  key={s}
                  onClick={() => setStep(s)}
                  className={`flex-1 py-1 text-xs font-bold rounded-lg transition-colors ${
                    step === s ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-[10px] uppercase font-bold text-slate-500 whitespace-nowrap">Feed</span>
            <NumberInput
              min={10}
              max={5000}
              step="50"
              integer
              value={feedrate}
              onChange={setFeedrate}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-200"
            />
            <span className="text-[10px] text-slate-500">mm/min</span>
          </div>
        </div>

        <div className="flex flex-col justify-end space-y-2">
          <div className="flex items-center space-x-2">
            <button onClick={handleZeroXY} disabled={busy} className={actionBtn}>
              {xyZeroed
                ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                : <Crosshair className="w-3.5 h-3.5 text-emerald-400" />}
              <span><span className="text-blue-400">2.</span> Set XY Zero Here</span>
            </button>
            <button
              onClick={() => webSerialManager.gotoWorkOrigin()}
              disabled={busy}
              title="Retract and drive to the work origin to check where it landed"
              className={actionBtn}
            >
              <Navigation className="w-3.5 h-3.5 text-blue-400" />
              <span>Go To Zero</span>
            </button>
          </div>

          {showZProbe && (
            <div className="flex items-center space-x-2">
              <button onClick={handleZeroZ} disabled={busy} className={actionBtn}>
                {zZeroed
                  ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                  : <ChevronsDown className="w-3.5 h-3.5 text-amber-400" />}
                <span>{isProbingZ ? 'Probing…' : <><span className="text-blue-400">3.</span> Probe Z Zero</>}</span>
              </button>
              <div className="flex items-center space-x-1">
                <NumberInput
                  min={0}
                  max={100}
                  step="0.1"
                  value={plateThickness}
                  onChange={setPlateThickness}
                  title="Touch plate thickness — work Z 0 ends up this far below the plate's top face"
                  className="w-16 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-200"
                />
                <span className="text-[10px] text-slate-500 whitespace-nowrap">mm plate</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The machine's own complaints — a refused command or a probe that missed
          used to go only into state that nothing rendered. */}
      {machineState.lastError && !probeMessage && (
        <p className="text-[11px] leading-relaxed text-red-400 font-semibold">{machineState.lastError}</p>
      )}

      {probeMessage && (
        <p
          className={`text-[11px] leading-relaxed ${
            probeMessage.ok ? 'text-emerald-400' : 'text-red-400 font-semibold'
          }`}
        >
          {probeMessage.text}
        </p>
      )}

      <p className="text-[11px] text-slate-500 leading-relaxed">
        Jog the tool over the corner of your stock where the job's origin should sit, then set XY zero.
        {showZProbe && ' For Z, clip the probe lead to the tool, sit the plate on the stock, park the tool a few mm above it, and probe.'}
        {onOpenDocs && (
          <>
            {' '}
            <button
              type="button"
              onClick={onOpenDocs}
              className="text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer"
            >
              Full walkthrough →
            </button>
          </>
        )}
      </p>
    </div>
  );
};
