import React, { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ChevronsUp, ChevronsDown, Crosshair, Lightbulb, Navigation, Octagon, Info, Check, Hand, AlertTriangle } from 'lucide-react';
import { NumberInput } from './NumberInput';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import {
  MAX_GUIDE_POWER_PCT,
  readGuideJiggle,
  readGuidePower,
  writeGuideJiggle,
  writeGuidePower,
} from '../utils/guideSpot';

/**
 * Setting the job's origin on a live machine: jog the tool where you want it,
 * zero X/Y there, then set Z — either off a touch plate or by hand.
 *
 * The jog pad exists because "zero XY" on its own is only ever half an answer —
 * it fixes the origin at wherever the tool happens to be, and there is no way to
 * get it over the corner of the stock from the browser without driving it. Steps
 * are the usual coarse/medium/fine ladder, so the last approach is a tenth at a
 * time.
 *
 * Both Z routes are offered rather than just the probe, because the probe is
 * the one that is often unavailable: it needs a touch plate, a continuity clip
 * and stock the clip can see. Painted MDF, anything in a wooden jig, and every
 * machine whose probe input was never wired up rule it out — and on those the
 * only way to a datum is the one every router owner already knows, which is to
 * wind the bit down until it just marks the surface and call that zero.
 *
 * Lives in the shared Machine Setup dialog, which follows the app's theme — so
 * every colour here is written for both.
 */
export const MachineWorkOriginPanel: React.FC<{
  machineState: MachineState;
  /** Laser has no touch plate, so the Z section is hidden for it. */
  showZProbe?: boolean;
  /**
   * Whether the head on this machine is a laser.
   *
   * Decides the guide spot, which exists for lasers and only for lasers: a
   * router's cutter is a thing you can look at, and firing a spindle to find
   * out where it is standing would be a poor way of asking.
   */
  isLaser?: boolean;
  /** Deep-links to the zeroing walkthrough in the app's Reference Guide. */
  onOpenDocs?: () => void;
}> = ({ machineState, showZProbe = true, isLaser = false, onOpenDocs }) => {
  const [step, setStep] = useState(1);
  const [feedrate, setFeedrate] = useState(1000);
  const [plateThickness, setPlateThickness] = useState(12.0);
  const [isProbingZ, setIsProbingZ] = useState(false);
  const [probeMessage, setProbeMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Thickness of whatever is between the tool tip and the surface for a manual touch-off. */
  const [gaugeThickness, setGaugeThickness] = useState(0);
  // Ticks the steps off as they are done. Which of the three you have actually
  // finished is invisible on the machine itself, and getting it wrong is the
  // beginner's mistake that ends with a cut in the wrong place.
  const [xyZeroed, setXyZeroed] = useState(false);
  const [guidePower, setGuidePower] = useState(readGuidePower);
  const [guideJiggle, setGuideJiggle] = useState(readGuideJiggle);

  // The beam does not outlive the panel. The manager's own timeout would catch
  // this eventually; putting the spot out here means it happens the moment the
  // window they were sighting through goes away. Read live rather than from
  // this render's state: an unconditional M5 would stop a *spindle* if the
  // panel unmounted mid-job.
  useEffect(
    () => () => {
      if (webSerialManager.getState().guideSpot) void webSerialManager.guideSpotOff();
    },
    []
  );

  const handleGuideSpot = () => {
    if (machineState.guideSpot) void webSerialManager.guideSpotOff();
    else void webSerialManager.guideSpotOn(guidePower);
  };

  const busy = machineState.status === 'RUNNING' || isProbingZ;
  const zZeroed = probeMessage?.ok === true;
  // The manager raises this at a tool-change pause and drops it as soon as
  // either zeroing route has run. Until then the datum on the machine belongs
  // to the bit that just came out of the collet.
  const staleZ = machineState.needsZZero;

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

  const handleZeroZHere = async () => {
    setProbeMessage(null);
    const result = await webSerialManager.zeroZHere(gaugeThickness);
    setProbeMessage({ ok: result.success, text: result.message });
  };

  /*
   * The panel is a guest wherever it is put — the Machine Setup dialog, which
   * follows the app's theme — so nothing here may assume a dark ground. It did,
   * and a jog pad of near-black buttons sat in the middle of a white dialog for
   * anyone not using dark mode.
   */
  const jogBtn =
    'flex items-center justify-center h-8 rounded-lg bg-slate-200 dark:bg-slate-800 ' +
    'hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-200 ' +
    'dark:disabled:hover:bg-slate-800 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 ' +
    'transition-colors cursor-pointer';
  const actionBtn =
    'flex-1 py-1.5 px-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 text-xs ' +
    'font-semibold rounded-lg flex items-center justify-center space-x-1.5 cursor-pointer';

  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center space-x-1.5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Set Work Origin</h4>
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
        <div className="flex items-center space-x-2 text-[11px] font-mono bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1">
          <span className="text-slate-500">WPos:</span>
          <span>
            X:{machineState.wpos.x.toFixed(2)} Y:{machineState.wpos.y.toFixed(2)} Z:{machineState.wpos.z.toFixed(2)}
          </span>
        </div>
      </div>

      {staleZ && showZProbe && (
        <div className="flex items-start space-x-2 rounded-lg bg-amber-500/10 border border-amber-500/50 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong className="font-bold">Z zero belongs to the previous tool.</strong> The bit that
            just came out was a different length, so the datum on the machine is wrong by that
            difference — and wrong in the direction of driving the new tool into the work. Touch off
            again below, by hand or on the plate, before resuming.
          </span>
        </div>
      )}

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
                  className={`flex-1 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                    step === s ? 'bg-emerald-500 text-slate-950' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
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
              className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200"
            />
            <span className="text-[10px] text-slate-500">mm/min</span>
          </div>
        </div>

        <div className="flex flex-col justify-end space-y-2">
          <div className="flex items-center space-x-2">
            <button onClick={handleZeroXY} disabled={busy} className={actionBtn}>
              {xyZeroed
                ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                : <Crosshair className="w-3.5 h-3.5 text-emerald-500" />}
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

          {/* The guide spot. A laser's cutting point is invisible until it
              fires: the head is a lump of metal several millimetres across, and
              the red pointer diode some machines carry sits off the optical
              axis — so jogging by eye against either sets zero a fixed distance
              from where the beam actually lands, and every job then cuts that
              far off, in the same direction, every time. */}
          {isLaser && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleGuideSpot}
                  disabled={!machineState.connected || busy}
                  title={
                    machineState.guideSpot
                      ? 'Switch the beam off'
                      : 'Fire the beam at pointer power so you can see exactly where the origin will be'
                  }
                  className={
                    machineState.guideSpot
                      ? 'flex-1 py-1.5 px-2 bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold rounded-lg flex items-center justify-center space-x-1.5 cursor-pointer'
                      : actionBtn
                  }
                >
                  <Lightbulb className={`w-3.5 h-3.5 ${machineState.guideSpot ? '' : 'text-amber-500'}`} />
                  <span>{machineState.guideSpot ? 'Guide Spot On — Switch Off' : 'Guide Spot'}</span>
                </button>
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    min={0.1}
                    max={MAX_GUIDE_POWER_PCT}
                    step="0.1"
                    value={guidePower}
                    onChange={(v) => {
                      const next = writeGuidePower(v);
                      setGuidePower(next);
                      // Re-fired at the new power while it is lit, so "raise it
                      // until you can see the dot" is one number box rather
                      // than a toggle-off-edit-toggle-on cycle.
                      if (machineState.guideSpot) void webSerialManager.guideSpotOn(next);
                    }}
                    title={`Pointer power, as a percentage of your controller's full scale ($30). Capped at ${MAX_GUIDE_POWER_PCT}%.`}
                    className="w-14 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200"
                  />
                  {/* The S word as well as the percentage: it is what actually
                      goes down the wire, and it is the number every other laser
                      tool and forum post is quoted in. */}
                  <span className="text-[10px] text-slate-500 whitespace-nowrap">
                    % (S{webSerialManager.guidePowerAsS(guidePower)})
                  </span>
                </div>
              </div>

              {/* Some controllers gate the laser on motion below anything a `$`
                  setting reaches, so the dot only exists while the head moves.
                  Nothing can detect that — it is observed once, by the person
                  watching the dot blink out. */}
              <label
                title="For machines whose laser only fires while moving: traces a 0.1 mm cross around the spot to keep it lit. The cross returns to its own centre, so the point you are sighting does not move."
                className="flex items-center space-x-1.5 text-[10px] text-slate-500 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={guideJiggle}
                  onChange={(e) => {
                    const next = writeGuideJiggle(e.target.checked);
                    setGuideJiggle(next);
                    // Applied to a spot that is already lit, so the answer to
                    // "is this what my machine needs" is the dot in front of
                    // them. Unticking needs no call: the loop reads the setting
                    // each cycle and stops on its own, beam still commanded on.
                    if (next && machineState.guideSpot) void webSerialManager.guideSpotOn(guidePower);
                  }}
                  className="accent-amber-500 cursor-pointer"
                />
                <span>Jiggle to stay lit</span>
              </label>

              <p className="text-[10px] text-slate-500 leading-snug">
                Wear your glasses, put scrap under the head, and jog the <em>dot</em> onto the corner
                of the stock before zeroing — not the head. Raise the percentage until you can see
                it. Laser mode (<code>$32</code>) is switched off while the spot is lit and back on
                the moment it goes out, because GRBL will not fire a stationary head with it on. The
                spot times out after two minutes on its own.
              </p>
            </div>
          )}

          {showZProbe && (
            <div className="space-y-1.5">
              <span className="block text-[10px] uppercase font-bold text-slate-500">
                <span className="text-blue-400">3.</span> Set Z zero
                {zZeroed && <Check className="inline w-3 h-3 ml-1 text-emerald-500" />}
              </span>

              {/* By hand first: it is the route that works on every machine and
                  every material, and the one people reach for at a tool change
                  with the touch plate still in a drawer. */}
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleZeroZHere}
                  disabled={busy}
                  title="Take work Z 0 from where the tool is standing right now — no probe, no touch plate"
                  className={actionBtn}
                >
                  <Hand className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Set Z Zero Here</span>
                </button>
                <div className="flex items-center space-x-1">
                  <NumberInput
                    min={0}
                    max={100}
                    step="0.1"
                    value={gaugeThickness}
                    onChange={setGaugeThickness}
                    title="Anything between the tip and the surface — a slip of paper is about 0.1 mm, a 1-2-3 block is 25.4. Leave at 0 when the bit is touching the work itself."
                    className="w-16 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200"
                  />
                  <span className="text-[10px] text-slate-500 whitespace-nowrap">mm gauge</span>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button onClick={handleZeroZ} disabled={busy} className={actionBtn}>
                  <ChevronsDown className="w-3.5 h-3.5 text-amber-500" />
                  <span>{isProbingZ ? 'Probing…' : 'Probe Z Zero'}</span>
                </button>
                <div className="flex items-center space-x-1">
                  <NumberInput
                    min={0}
                    max={100}
                    step="0.1"
                    value={plateThickness}
                    onChange={setPlateThickness}
                    title="Touch plate thickness — work Z 0 ends up this far below the plate's top face"
                    className="w-16 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200"
                  />
                  <span className="text-[10px] text-slate-500 whitespace-nowrap">mm plate</span>
                </div>
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
        {showZProbe &&
          ' For Z, either wind the bit down until it just marks the surface and press Set Z Zero Here' +
          ' — putting a feeler under it and entering its thickness as the gauge — or clip the probe' +
          ' lead to the tool, sit the plate on the stock, park the tool a few mm above it, and probe.'}
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
