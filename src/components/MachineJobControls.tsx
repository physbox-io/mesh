import React, { useState } from 'react';
import { AlertCircle, Play, Pause, Square, Hand, ChevronsDown, Gauge, RotateCcw, Cpu, Box, Loader2 } from 'lucide-react';
import { webSerialManager, type MachineState, type OverrideStep } from '../utils/webSerialManager';
import { checkJobEnvelope, type JobExtent } from '../utils/workEnvelope';
import { formatDuration } from '../utils/timeEstimate';
import { NumberInput } from '@physbox-io/ui';
import { ProbeCircuitStatus } from './ProbeCircuitStatus';
import { CheckpointBadge } from './CheckpointBadge';
import { JogPad } from './JogPad';
import { ConfirmModal } from './ConfirmModal';
import { useStore } from '../store/useStore';

/**
 * Running a job from the browser: stop it, pick it up again, and deal with what
 * it stopped for.
 *
 * These used to be written out three times — once in each export modal — and had
 * drifted: the laser offered to re-zero Z at a tool change, the contour modal
 * did not, and none of the three had a way to pause a job that was simply
 * cutting too deep in a place the operator had just noticed. The only choices
 * were to watch it finish or to hit E-Stop, which on a relief that has been
 * running for two hours means the piece is scrap, because a soft reset loses the
 * position and the carve cannot be re-registered.
 */

/**
 * The way into Machine Setup from a banner that has just told somebody to
 * unlock, home or zero: that is where all three live, and a banner that names
 * them without a way there leaves the operator hunting for it.
 */
const OpenSetupButton: React.FC<{ onOpen?: () => void }> = ({ onOpen }) => {
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  return (
    <button
      onClick={() => {
        onOpen?.();
        setMachineConfigOpen(true);
      }}
      title="Connect, unlock, home and zero the machine"
      className="mr-auto px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-slate-950 text-xs font-bold rounded-lg flex items-center gap-1.5 cursor-pointer"
    >
      <Cpu className="w-3.5 h-3.5" />
      <span>Machine Setup</span>
    </button>
  );
};

/**
 * What the machine stopped for, and what has to happen before it carries on.
 *
 * The gate on Resume is the point of this. A tool change means a different tool
 * length, so the Z datum the job started with is now wrong — and wrong in the
 * direction that drives the new bit into the work. Nothing on the controller
 * knows that has happened, so the button that would send it back into the cut
 * stays shut until one of the two zeroing routes has run, or until the operator
 * says outright that they have already dealt with it.
 */
export const JobPauseBanner: React.FC<{
  machineState: MachineState;
  /** e.g. "Resume Carve", "Resume Next Sheet". */
  resumeLabel: string;
  /** A laser has no Z datum and no touch plate, so it gets neither offer. */
  showZTools?: boolean;
  /** Touch plate thickness for the probe route, matching the origin panel's default. */
  plateThicknessMm?: number;
}> = ({ machineState, resumeLabel, showZTools = true, plateThicknessMm = 12.0 }) => {
  const [overridden, setOverridden] = React.useState(false);
  const [overrideFor, setOverrideFor] = React.useState<string | null>(null);

  const paused = machineState.status.startsWith('PAUSED');
  // A fresh pause is a fresh decision: an override given for the last tool
  // change must not still be standing at the next one. Derived during render
  // rather than in an effect, so there is no frame in which the stale override
  // is still live.
  if (overridden && overrideFor !== machineState.pauseMessage) {
    setOverridden(false);
    setOverrideFor(null);
  }

  if (!paused) return null;

  const toolChange = machineState.status === 'PAUSED_TOOL';
  const parked = machineState.status === 'PAUSED_PARKED';
  // `resumeFromPark` takes no override, so neither does its button here — the
  // same gate as the Resume Here in the transport.
  const blocked = showZTools && machineState.needsZZero && (parked || !overridden);
  const allowResume = () => {
    setOverridden(true);
    setOverrideFor(machineState.pauseMessage ?? null);
  };

  return (
    <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500 flex flex-col space-y-3 text-amber-800 dark:text-amber-300">
      <div className="flex items-center space-x-3">
        <AlertCircle className="w-6 h-6 text-amber-500 flex-shrink-0" />
        <div>
          <h4 className="font-bold text-sm">
            {machineState.status === 'PAUSED_OPERATOR' ? 'Paused' : 'Action Required: Machine Paused'}
          </h4>
          <p className="text-xs leading-relaxed font-semibold">{machineState.pauseMessage}</p>
        </div>
      </div>

      {toolChange && showZTools && (
        <p className="text-[11px] leading-relaxed">
          The new bit is a different length from the one that came out, so the machine's Z zero no
          longer describes where the tip is. Touch off again before resuming: jog the tip down onto
          the work and take zero from there, or probe it on the plate. The machine is free to move
          while it waits: jog it where you like, and resuming lifts back to the job's own clear
          height before it carries on.
        </p>
      )}
      {toolChange && showZTools && (
        <ProbeCircuitStatus active={machineState.probePinActive} seen={machineState.probeCircuitSeen} />
      )}

      {/* The same freedom, for a stop that needs no touching off: the sheet
          being swapped is the one the tool is parked over. */}
      {machineState.status === 'PAUSED_MATERIAL' && (
        <p className="text-[11px] leading-relaxed">
          The machine is stopped and free to move. Jog it where you like. Resuming lifts back to the
          job's own clear height before it carries on.
        </p>
      )}

      {/* The pad the text above keeps mentioning. Not on a feed hold: GRBL
          refuses to jog in Hold, and the tool is still in the cut. */}
      {machineState.status !== 'PAUSED_OPERATOR' && (
        <div className="rounded-lg bg-white/60 dark:bg-slate-950/40 border border-amber-500/30 p-2.5 space-y-2 text-slate-700 dark:text-slate-200">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-[10px] uppercase font-bold text-slate-500">Jog</span>
            <span className="text-[11px] font-mono tabular-nums">
              <span className="text-slate-500">WPos </span>
              X:{machineState.wpos.x.toFixed(2)} Y:{machineState.wpos.y.toFixed(2)} Z:
              {machineState.wpos.z.toFixed(2)}
            </span>
          </div>
          <JogPad />
        </div>
      )}

      {/*
        What a pause is and is not insurance against.
        A feed hold holds the position in the controller, which is why Resume
        picks the cut up exactly — and which is also why it is worth nothing at
        all once the controller loses power. The program is written down
        separately so that case has a way back, and this says so at the moment
        somebody is deciding whether they can walk away.
      */}
      <CheckpointBadge
        feedHold={machineState.status === 'PAUSED_OPERATOR'}
        className="text-amber-700/90 dark:text-amber-300/80"
      />

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-amber-500/30">
        <OpenSetupButton />
        {toolChange && showZTools && (
          <>
            <button
              onClick={() => webSerialManager.zeroZHere()}
              title="Take work Z 0 from where the tool is standing right now"
              className="px-3 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-semibold rounded-lg flex items-center space-x-1.5 cursor-pointer"
            >
              <Hand className="w-3.5 h-3.5 text-emerald-400" />
              <span>Set Z Zero Here</span>
            </button>
            <button
              onClick={() => webSerialManager.zeroZ(plateThicknessMm)}
              className="px-3 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-semibold rounded-lg flex items-center space-x-1.5 cursor-pointer"
            >
              <ChevronsDown className="w-3.5 h-3.5 text-amber-400" />
              <span>Probe Z Zero</span>
            </button>
          </>
        )}

        {blocked && !parked && (
          <button
            onClick={allowResume}
            title="Only if the Z datum is already right for the tool now in the spindle"
            className="px-3 py-1.5 text-amber-700 dark:text-amber-400 hover:underline text-xs font-semibold cursor-pointer"
          >
            Z is already set, let me resume
          </button>
        )}

        <button
          // A park let go of the program, so `resumeJob` has nothing to release
          // and returned without a word; it is put back from the park point.
          onClick={() =>
            void (parked
              ? webSerialManager.resumeFromPark({ isLaser: !showZTools })
              : webSerialManager.resumeJob({ zIsSet: overridden }))
          }
          disabled={blocked}
          title={blocked ? 'Set Z zero for the new tool first' : undefined}
          className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-xs rounded-lg flex items-center space-x-1.5 cursor-pointer"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>{resumeLabel}</span>
        </button>
      </div>
    </div>
  );
};

/**
 * The offer to pick a job back up where it stopped.
 *
 * This is the banner that saves the afternoon. Everything that kills a carve
 * early — a snapped cutter, a limit switch, a nudged USB cable — kills it hours
 * in, and until now the only way back was to run the whole file again from the
 * top, recutting hours of finished surface to reach the point it stopped at.
 *
 * Two things have to be said plainly before anyone presses it. The first is the
 * depth: a resume rapids across the work and then descends to whatever Z the
 * program had reached, and the operator is the only one who can confirm that
 * the stock in front of them is still the shape the program thinks it is. The
 * second is the tool. A resume after a snapped bit is a resume onto a new bit
 * of a different length, which makes the existing Z datum wrong in the
 * direction of driving it into the work — so the line number is offered as an
 * editable field rather than a fait accompli, and the Z warning is not
 * dismissible.
 */
export const JobResumeBanner: React.FC<{
  machineState: MachineState;
  /** A laser has no Z to descend to, so it gets none of the depth talk. */
  showZTools?: boolean;
  /**
   * Runs before Machine Setup opens. The restore dialog sits above Setup, so it
   * steps aside first; the offer itself stays live in the export modals.
   */
  onOpenSetup?: () => void;
}> = ({ machineState, showZTools = true, onOpenSetup }) => {
  const resume = machineState.resume;
  const [line, setLine] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const running = machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');
  const target = line ?? resume?.fromLine ?? 0;
  const preview = React.useMemo(
    () => (resume ? webSerialManager.previewResume(target, { isLaser: !showZTools }) : null),
    // needsZZero too: the manager reads it, and once Z is zeroed a resume at a
    // tool change steps past the M6, which changes the plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resume, target, machineState.needsZZero, showZTools]
  );

  if (!resume || running) return null;

  const pending = resume.pendingPause;
  const atToolChange = pending?.kind === 'tool-change';
  const why =
    pending && resume.reason === 'alarm'
      // It had already stopped, on purpose, and the alarm came after: a stop
      // that otherwise reads as random, and a re-zero demand that reads as
      // arbitrary, until it says what the job was waiting for.
      ? `It had stopped for ${atToolChange ? 'a tool change' : 'a programmed stop'}, with everything before it cut, when the controller alarmed (a limit switch while lifting clear).`
      : resume.reason === 'alarm'
      ? 'The controller alarmed (a limit switch, or a reset part way through).'
      : resume.reason === 'disconnected'
        ? 'The connection to the machine dropped.'
        : resume.reason === 'interrupted'
          // Nothing in the app saw this one end. The program was read back out
          // of storage, which is the only reason there is anything to offer.
          ? 'This browser went away while the job was streaming — a closed tab, a sleeping laptop, or the power going off.'
          : 'The job was stopped.';

  // What the preamble will actually do, not what the program was doing when it
  // stopped: a resume onto a tool change makes no descent at all.
  const depth = preview?.descendsToZ;
  const done = Math.round((resume.fromLine / Math.max(1, resume.totalLines)) * 100);

  const go = () => {
    const res = webSerialManager.resumeFromLine(target, { isLaser: !showZTools });
    setError(res.ok ? null : res.message);
  };

  return (
    <div className="p-4 rounded-xl bg-sky-500/10 border-2 border-sky-500 flex flex-col space-y-3 text-sky-900 dark:text-sky-200">
      <div className="flex items-center space-x-3">
        <RotateCcw className="w-6 h-6 text-sky-500 flex-shrink-0" />
        <div>
          <h4 className="font-bold text-sm">Job stopped {done}% of the way through</h4>
          <p className="text-xs leading-relaxed font-semibold">
            {why} It reached line {resume.fromLine.toLocaleString()} of{' '}
            {resume.totalLines.toLocaleString()}. It can be picked up from there instead of
            starting again.
          </p>
        </div>
      </div>

      {resume.restored && (
        <p className="text-[11px] leading-relaxed font-semibold">
          The machine has been through a power cycle since, so nothing on it is still true: home it,
          confirm the work origin, and zero Z for whatever tool is actually in the spindle.
          {resume.approximate && (
            <> The line below was recorded once a minute, so wind it back rather than forward.</>
          )}
        </p>
      )}

      {pending && (
        <p className="text-xs leading-relaxed font-semibold">{pending.message}</p>
      )}

      {showZTools && atToolChange && (
        <p className="text-[11px] leading-relaxed">
          Unlock the machine and jog Z down off the switch, fit the new bit, and zero Z on the same
          surface as before. X and Y did not move, so they need nothing. Resuming carries on with the
          new tool from the tool change; it does not stop for it a second time.
          {depth !== null && depth !== undefined ? (
            <> Resuming will move over the stopping point and descend to <strong>Z{depth.toFixed(2)} mm</strong>.</>
          ) : (
            <> Resuming lifts to the job's clear height and carries on from there.</>
          )}
        </p>
      )}

      {showZTools && !atToolChange && (
        <p className="text-[11px] leading-relaxed">
          Before resuming: clear the tool from the work by hand, and re-home the machine if it
          alarmed. If the bit was changed, its length is different and the Z zero is now wrong.
          Touch off again first.
          {depth !== null && depth !== undefined ? (
            <> Resuming will move over the stopping point and descend to <strong>Z{depth.toFixed(2)} mm</strong>.</>
          ) : (
            <> Resuming will move over the stopping point without going back down into the cut.</>
          )}
        </p>
      )}

      {preview?.state.uncertain && (
        <p className="text-[11px] leading-relaxed font-semibold text-amber-700 dark:text-amber-300">
          {preview.state.uncertainBecause}
        </p>
      )}

      {error && (
        <p className="text-[11px] leading-relaxed font-semibold text-red-700 dark:text-red-300">{error}</p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-sky-500/30">
        <OpenSetupButton onOpen={onOpenSetup} />
        <label className="flex items-center gap-1.5 text-[11px] font-semibold mr-auto">
          <span>Resume from line</span>
          <NumberInput
            min={0}
            max={resume.totalLines}
            value={target}
            onChange={v => v !== undefined && setLine(Math.max(0, Math.min(resume.totalLines, v)))}
                      className="w-24 bg-white dark:bg-slate-900 border border-sky-500/40 rounded px-1.5 py-1 font-mono text-[11px] text-slate-800 dark:text-slate-100"
            title="Back this off a little to recut the last stretch, which is usually safer than trying to land exactly on the break"
                      integer
                    />
        </label>
        <button
          onClick={() => webSerialManager.clearResumePoint()}
          className="px-3 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-semibold rounded-lg cursor-pointer"
        >
          Discard
        </button>
        <button
          onClick={go}
          // A laser has no Z to zero, so a datum never set this session stays
          // unset for good, and would hold its resume shut for good.
          disabled={!machineState.connected || (showZTools && machineState.needsZZero)}
          title={
            !machineState.connected
              ? 'Connect to the machine first'
              : showZTools && machineState.needsZZero
                ? 'Set Z zero for the tool that is in the spindle now'
                : 'Rebuild the machine state and carry on from this line'
          }
          className="px-3 py-1.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold rounded-lg flex items-center space-x-1.5 cursor-pointer"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>Resume from line {target.toLocaleString()}</span>
        </button>
      </div>
    </div>
  );
};

/**
 * Add Simulation: puts the part this program will leave into the scene, cut
 * back out of the stock, to look at and measure before any wood is spent.
 *
 * Offered whenever there is a program, machine or no machine, so it sits
 * beside the start button rather than inside it. The second half of the button
 * says where the part goes and switches it: beside the model at the size it
 * will really be, or over the model, where an over-cut or a missed area shows.
 */
export const AddSimulationButton: React.FC<{
  disabled: boolean;
  onSimulate: (placement: 'beside' | 'overlay') => void;
  /** 0 to 1 while one is running; null when idle. */
  progress: number | null;
  error?: string | null;
  /**
   * For an output that is geometry already (a pattern, a mold): its own label,
   * and always beside the model, since there is no fit to lay it back over.
   */
  label?: string;
  besideOnly?: boolean;
}> = ({ disabled, onSimulate, progress, error, label = 'Add Simulation', besideOnly = false }) => {
  const [placement, setPlacement] = useState<'beside' | 'overlay'>('beside');
  const busy = progress !== null;
  return (
    <div className="flex items-center" title={error ?? undefined}>
      <button
        onClick={() => onSimulate(placement)}
        disabled={disabled || busy}
        title={
          error
            ? `The last simulation failed: ${error}`
            : besideOnly
              ? 'Add it to the scene beside the model'
              : 'Cut this program out of a block of the stock and add the result to the scene'
        }
        className={`flex items-center space-x-2 whitespace-nowrap pl-4 py-2 bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/70 disabled:opacity-40 disabled:cursor-not-allowed text-amber-900 dark:text-amber-100 font-bold text-xs border border-amber-300 dark:border-amber-700 cursor-pointer ${besideOnly ? 'rounded-lg pr-4' : 'rounded-l-lg pr-3'}`}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />}
        {/* The reason on the button itself: a bare 'failed' sent people hunting for a tooltip. */}
        <span className="max-w-[18rem] truncate">{busy
            ? `Simulating ${Math.round((progress ?? 0) * 100)}%`
            : error ? `Failed: ${error}` : label}</span>
      </button>
      {!besideOnly && <button
        onClick={() => setPlacement((p) => (p === 'beside' ? 'overlay' : 'beside'))}
        disabled={busy}
        title={
          placement === 'beside'
            ? 'Beside the model, at the size it will come off the machine. Click to lay it over the model instead.'
            : 'Over the model, scaled back to it. Click to put it beside the model instead.'
        }
        className="whitespace-nowrap px-2.5 py-2 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 disabled:opacity-40 text-amber-800 dark:text-amber-200 text-[11px] font-semibold rounded-r-lg border border-l-0 border-amber-300 dark:border-amber-700 cursor-pointer"
      >
        {placement === 'beside' ? 'Beside' : 'Overlay'}
      </button>}
    </div>
  );
};

/**
 * Start / pause / resume / stop, as one control that knows which of the four is
 * meaningful right now.
 *
 * Pause and E-Stop are deliberately different buttons doing different things.
 * The feed hold decelerates along the path and keeps the position, so the cut
 * picks up exactly where it left off; E-Stop is a soft reset, which drops the
 * position and ends the piece. Offering only the second is why people used to
 * stand and watch a job they already knew was wrong.
 */
export const JobTransport: React.FC<{
  machineState: MachineState;
  canStart: boolean;
  onStart: () => void;
  startLabel: string;
  /** 'footer' is the big modal-footer treatment; 'inline' fits the machine panel. */
  variant?: 'footer' | 'inline';
  /** A laser has no Z datum, so an unconfirmed one can't hurt it — every CNC mode does. */
  requiresZZero?: boolean;
}> = ({ machineState, canStart, onStart, startLabel, variant = 'footer', requiresZZero = true }) => {
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const running = machineState.status === 'RUNNING';
  const paused = machineState.status.startsWith('PAUSED');
  const parked = machineState.status === 'PAUSED_PARKED';
  // A laser has no Z datum to set, so its never-set one must not hold any
  // button here shut: Start, Resume from line, Resume Here or Resume.
  const blockedByZZero = requiresZZero && machineState.needsZZero;
  const isLaser = !requiresZZero;

  /*
   * `whitespace-nowrap` on both, and `px-2` inline rather than `px-3`.
   *
   * The inline row is three buttons sharing whatever width the machine panel
   * has left, and without this the narrowest of them broke its label at the
   * hyphen — an emergency stop rendered as "E-" above "Stop". A control that is
   * pressed in a hurry has to read as one word at a glance.
   */
  const base =
    variant === 'footer'
      ? 'flex items-center justify-center space-x-2 whitespace-nowrap px-4 py-2 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer'
      : 'flex items-center justify-center space-x-1.5 whitespace-nowrap w-full py-1.5 px-2 font-bold text-xs rounded-lg cursor-pointer';
  const icon = variant === 'footer' ? 'w-4 h-4' : 'w-3.5 h-3.5';

  if (!running && !paused) {
    const resume = machineState.resume;
    const startOver = () => {
      if (resume) setConfirmStartOver(true);
      else onStart();
    };

    // A stopped job stays the thing on offer until it is resumed or let go:
    // closing the modal and coming back must not turn its button into a Start
    // that silently throws the resume point away.
    if (resume) {
      const which = resume.jobName ? `the ${resume.jobName} job` : 'the stopped job';
      return (
        <div className={variant === 'footer' ? 'flex items-center gap-2' : 'flex items-center gap-2 w-full'}>
          {confirmStartOver && (
            <ConfirmModal
              title="Start job over from the beginning?"
              confirmLabel="Start over"
              tone="amber"
              body={
                <p>
                  Starting from the beginning discards the offer to resume {which} at line{' '}
                  {resume.fromLine.toLocaleString()}.
                </p>
              }
              onCancel={() => setConfirmStartOver(false)}
              onConfirm={() => {
                setConfirmStartOver(false);
                onStart();
              }}
            />
          )}
          {resumeError && (
            <ConfirmModal
              title="Could not resume job"
              confirmLabel="OK"
              hideCancel
              tone="red"
              body={<p>{resumeError}</p>}
              onCancel={() => setResumeError(null)}
              onConfirm={() => setResumeError(null)}
            />
          )}
          <button
            onClick={startOver}
            disabled={!canStart || blockedByZZero}
            title="Run the whole program again from the first line. Asks first, because it discards the resume point."
            className={`${base} bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200`}
          >
            <RotateCcw className={icon} />
            <span>Start Over</span>
          </button>
          <button
            onClick={() => {
              const res = webSerialManager.resumeFromLine(resume.fromLine, { isLaser });
              if (!res.ok) setResumeError(res.message);
            }}
            disabled={blockedByZZero}
            title={
              blockedByZZero
                ? 'Set Z zero for the tool that is in the spindle now'
                : `Carry on${resume.jobName ? ` with ${resume.jobName}` : ''} from line ${resume.fromLine.toLocaleString()}`
            }
            className={`${base} bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950`}
          >
            <Play className={`${icon} fill-current`} />
            <span>Resume from line {resume.fromLine.toLocaleString()}</span>
          </button>
        </div>
      );
    }

    return (
      <button
        onClick={onStart}
        disabled={!canStart || blockedByZZero}
        title={blockedByZZero ? 'Set Z zero in Machine Setup before running a job' : undefined}
        className={`${base} bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950`}
      >
        <Play className={`${icon} fill-current`} />
        <span>{startLabel}</span>
      </button>
    );
  }

  if (parked) {
    return (
      <div className={variant === 'footer' ? 'flex items-center gap-2' : 'flex items-center gap-2 w-full'}>
        <button
          onClick={() => webSerialManager.resumeFromPark({ isLaser })}
          disabled={blockedByZZero}
          title={
            blockedByZZero
              ? 'Set Z zero for the new tool first'
              : 'Drive back over the parked point and carry on cutting from the line that was actually reached'
          }
          className={`${base} bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950`}
        >
          <Play className={`${icon} fill-current`} />
          <span>Resume Here</span>
        </button>
        <button
          onClick={() => webSerialManager.discardPark()}
          title="Give up on the parked job. The machine stays where it is; the program is let go."
          className={`${base} bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200`}
        >
          <Square className={icon} />
          <span>Discard</span>
        </button>
      </div>
    );
  }

  return (
    <div className={variant === 'footer' ? 'flex items-center gap-2' : 'flex items-center gap-2 w-full'}>
      {running ? (
        <button
          onClick={() => webSerialManager.pauseJob()}
          title="Feed hold. Decelerates and stops without losing position, so the cut resumes exactly where it stopped"
          className={`${base} bg-amber-500 hover:bg-amber-600 text-slate-950`}
        >
          <Pause className={icon} />
          <span>Pause</span>
        </button>
      ) : (
        <button
          onClick={() => webSerialManager.resumeJob({ zIsSet: isLaser })}
          disabled={blockedByZZero}
          title={blockedByZZero ? 'Set Z zero for the new tool first' : 'Cycle start'}
          className={`${base} bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950`}
        >
          <Play className={`${icon} fill-current`} />
          <span>Resume</span>
        </button>
      )}
      {/* The gap between "pause" and "abandon". A feed hold leaves the tool
          sitting in the cut and GRBL refuses to jog in Hold, so pausing to
          actually look at the work used to mean scrapping the job. */}
      <button
        onClick={() => webSerialManager.parkJob({ isLaser })}
        title="Stop the cut, retract, and hand the machine back so you can jog it about. The line actually reached is kept, so it can carry on from there."
        className={`${base} bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200`}
      >
        <ChevronsDown className={icon} />
        <span>Park</span>
      </button>
      <button
        onClick={() => webSerialManager.cancelJob()}
        title="Soft reset: stops the machine now and loses the position. The line it reached is kept, to resume after re-homing and re-zeroing."
        className={`${base} bg-red-600 hover:bg-red-700 text-white`}
      >
        <Square className={icon} />
        <span>E-Stop</span>
      </button>
    </div>
  );
};

/**
 * The last thing to read before pressing start.
 *
 * Everything a G-code file assumes about the setup is written in it, and none
 * of it reaches the person standing at the machine. The worst of those is the
 * spindle speed: every file this app writes opens with an `M3 S12000`, and on
 * the trim routers and VFD-and-a-dial spindles most of its users own, that word
 * does precisely nothing — the speed is a knob, and if nobody says what to turn
 * it to it stays wherever the last job left it. Cutting hardwood with the dial
 * still set for acrylic is a burnt cut and a blunt bit, from a file that
 * mentioned the number only in a comment nobody opened.
 *
 * So it is stated here, in the panel with the start button in it, in the order
 * the setup actually happens: fit the tool, set the speed, check the origin.
 */
export const JobPreflight: React.FC<{
  machineState: MachineState;
  /** What to fit, already described — e.g. "6.35 mm flat end mill, 2-flute upcut". */
  tool?: string;
  /** A second tool the job stops to swap to partway through. */
  secondTool?: string;
  /** Spindle speed the program commands. Omitted for a laser. */
  rpm?: number;
  /** What is clamped down, for the line that explains the speed. */
  material?: string;
  /** Where the operator has to have zeroed. */
  origin: string;
  /** Anything the recommendation had to compromise on, in one sentence. */
  caveat?: string | null;
  /**
   * The box the job sweeps, in work coordinates, checked against the machine's
   * own travel limits.
   *
   * The controller has been asked what it can do since the motion profile went
   * in; three more settings in the same `$$` dump — `$130` to `$132` — say how
   * far it can go, and nothing was reading them. So a 600 mm layout exported
   * cheerfully onto a 400 mm machine and the first anyone heard of it was the
   * gantry arriving at the end of its rail.
   */
  extent?: JobExtent;
}> = ({ machineState, tool, secondTool, rpm, material, origin, caveat, extent }) => {
  // Only while it is worth reading: mid-job the pause banner and the progress
  // bar are what matters, and a checklist for a job already running is noise.
  if (!machineState.connected) return null;
  if (machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED')) return null;

  const rows: { n: number; label: string; value: React.ReactNode }[] = [];
  if (tool) {
    rows.push({
      n: rows.length + 1,
      label: 'Fit',
      value: (
        <span>
          {tool}
          {secondTool && (
            <span className="text-slate-500 dark:text-slate-400">
              {' '}(the job stops partway to swap to {secondTool})
            </span>
          )}
        </span>
      ),
    });
  }
  if (rpm !== undefined && rpm > 0) {
    rows.push({
      n: rows.length + 1,
      label: 'Set the spindle to',
      value: (
        <span>
          <span className="font-bold text-base text-emerald-400">{rpm.toLocaleString()} RPM</span>
          {material && <span className="text-slate-500 dark:text-slate-400"> for {material}</span>}
        </span>
      ),
    });
  }
  rows.push({ n: rows.length + 1, label: 'Zero on', value: origin });

  // The work origin in machine coordinates is the difference between where the
  // machine says it is and where the job says it is — which is exactly the
  // offset the job will be run at.
  const workOrigin = {
    x: machineState.mpos.x - machineState.wpos.x,
    y: machineState.mpos.y - machineState.wpos.y,
    z: machineState.mpos.z - machineState.wpos.z,
  };
  const envelope = extent
    ? checkJobEnvelope(extent, machineState.motion, workOrigin, machineState.mpos, machineState.hasHomed)
    : null;

  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Before you start</h4>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.n} className="flex items-baseline gap-2 text-xs text-slate-700 dark:text-slate-200">
            <span className="flex-shrink-0 w-4 text-blue-400 font-bold">{r.n}.</span>
            <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap">{r.label}</span>
            <span className="min-w-0">{r.value}</span>
          </li>
        ))}
      </ol>
      {caveat && <p className="text-[11px] leading-relaxed text-amber-400">{caveat}</p>}

      {envelope && envelope.problems.length > 0 && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/40 px-2.5 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wide text-red-400">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>This job does not fit the machine</span>
          </div>
          {envelope.problems.map((p, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-red-300">{p.message}</p>
          ))}
          {machineState.motion.softLimits && (
            <p className="text-[11px] leading-relaxed text-red-400/80">
              Soft limits are on, so the controller will alarm and stop rather than drive into the
              stop, but it will do so partway through, with the work already cut into.
            </p>
          )}
        </div>
      )}

      {envelope && envelope.problems.length === 0 && envelope.sizeChecked && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          {envelope.placementChecked
            ? `Fits the machine, and fits from this work origin.`
            : `Fits the machine. ${envelope.placementSkippedBecause ?? ''}`}
        </p>
      )}

      {envelope && !envelope.sizeChecked && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          {envelope.placementSkippedBecause}
        </p>
      )}
    </div>
  );
};


/**
 * How far through the job is, in the panel the operator is already looking at.
 *
 * All of this existed already — it is in the status bar along the bottom of the
 * window — and none of it could be seen while a carve was running, because the
 * export modal that starts the job is a `fixed inset-0 z-50` overlay and the
 * status bar underneath it is `z-20`. Pressing Start put a blurred sheet over
 * the only progress readout in the app for the whole of a four-hour cut, and
 * `JobPreflight` deliberately blanks itself mid-job on the assumption that
 * something else is showing this. Nothing was.
 *
 * The bar is the same figure the status bar shows: the line the cutter is on,
 * weighted by how long each line takes, since "line 4,000 of 7,000" is not 57%
 * of the wait. The line number is still here, because it is the one to quote
 * when something has gone wrong and the one a resume would restart on.
 */
export const JobProgress: React.FC<{ machineState: MachineState }> = ({ machineState }) => {
  const running =
    machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');
  if (!machineState.connected || !running) return null;

  const { elapsedSeconds: elapsed, remainingSeconds: remaining } = machineState;
  const percent = Math.min(100, machineState.progressPercent);
  const paused = machineState.status.startsWith('PAUSED');

  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {machineState.status === 'PAUSED_PARKED'
            ? 'Parked'
            : paused
              ? 'Paused'
              : 'Cutting'}
        </h4>
        <span className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
          {formatDuration(elapsed)}
          {remaining !== null && (
            <span className="text-slate-400">
              {' '}({formatDuration(remaining)} left)
            </span>
          )}
        </span>
      </div>

      <div
        className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
        title="How far through the job the cutter is"
      >
        <div
          className={`h-full transition-all ${paused ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="font-mono text-[10px] text-slate-400">
        line {machineState.currentLine.toLocaleString()} /{' '}
        {machineState.totalLines.toLocaleString()}
      </p>
    </div>
  );
};

/**
 * Trimming the feed and the spindle while the job is running.
 *
 * Without it, the only response to "this is cutting slightly too fast" is to
 * stop the job, change a number and start again — on stock that has already
 * been cut into and can no longer be registered against the model. Every
 * controller can do this live; nothing here could ask it to.
 *
 * Steps rather than a slider, because that is the protocol: GRBL takes nudges
 * and a reset, and nothing in between. The percentage shown is the controller's
 * own `Ov:` report rather than a tally of what was clicked — an override
 * survives a reload, is cleared by a reset, and may be changed from a pendant,
 * and a readout that remembered its own clicks would be wrong after any of
 * those.
 *
 * These are real-time bytes, so they are acted on immediately rather than
 * queueing behind the thousands of lines already sent. That is the whole point:
 * the buffered lines are exactly what needs slowing down.
 */
export const JobOverrides: React.FC<{ machineState: MachineState }> = ({ machineState }) => {
  const running =
    machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');
  if (!machineState.connected || !running) return null;

  const step =
    'px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 ' +
    'font-mono text-[10px] leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const row = (
    label: string,
    percent: number,
    nudge: (by: OverrideStep) => void,
    reset: () => void,
    hint: string
  ) => (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] uppercase font-semibold text-slate-500">{label}</span>
      <span
        className={`w-11 shrink-0 text-right font-mono text-[11px] font-bold ${
          percent === 100 ? 'text-slate-700 dark:text-slate-200' : 'text-amber-600 dark:text-amber-400'
        }`}
        title={hint}
      >
        {percent}%
      </span>
      <div className="flex gap-1">
        <button className={step} onClick={() => nudge(-10)} title={`${hint}: down 10%`}>−10</button>
        <button className={step} onClick={() => nudge(-1)} title={`${hint}: down 1%`}>−1</button>
        <button className={step} onClick={reset} title={`${hint}: back to what the program asked for`}>
          <RotateCcw className="w-3 h-3" />
        </button>
        <button className={step} onClick={() => nudge(1)} title={`${hint}: up 1%`}>+1</button>
        <button className={step} onClick={() => nudge(10)} title={`${hint}: up 10%`}>+10</button>
      </div>
    </div>
  );

  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
      <div className="flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-blue-400" />
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Live Trim</h4>
      </div>
      {row(
        'Feed',
        machineState.overrides.feed,
        (by) => webSerialManager.nudgeFeedOverride(by),
        () => webSerialManager.resetFeedOverride(),
        'Cutting feed rate'
      )}
      {row(
        'Spindle',
        machineState.overrides.spindle,
        (by) => webSerialManager.nudgeSpindleOverride(by),
        () => webSerialManager.resetSpindleOverride(),
        'Spindle speed (only on a machine whose controller owns the spindle)'
      )}
      {/* Rapids get three fixed steps because GRBL implements exactly three.
          Worth having on a first run of an unfamiliar file: a rapid at quarter
          speed is one you can still hit the stop for. */}
      <div className="flex items-center gap-1.5">
        <span
          className="w-14 shrink-0 text-[10px] uppercase font-semibold text-slate-500"
          title="Travel between cuts — a quarter-speed rapid is one you stay in reach of the stop for"
        >
          Rapids
        </span>
        <span
          className={`w-11 shrink-0 text-right font-mono text-[11px] font-bold ${
            machineState.overrides.rapid === 100
              ? 'text-slate-700 dark:text-slate-200'
              : 'text-amber-600 dark:text-amber-400'
          }`}
        >
          {machineState.overrides.rapid}%
        </span>
        <div className="flex gap-1">
          {([100, 50, 25] as const).map((pct) => (
            <button
              key={pct}
              className={step}
              onClick={() => webSerialManager.setRapidOverride(pct)}
              title={`Travel between cuts at ${pct}% of the rapid speed`}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        Applied to the motion already in the buffer, so a cut that is chattering or burning can be
        backed off without stopping the job. Chatter or burn marks mean the feed and the speed are
        wrong for each other. Trim here to find the pair that works, then set them for next time.
      </p>
    </div>
  );
};
