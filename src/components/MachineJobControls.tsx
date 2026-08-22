import React from 'react';
import { AlertCircle, Play, Pause, Square, Hand, ChevronsDown, Gauge, RotateCcw } from 'lucide-react';
import { webSerialManager, type MachineState, type OverrideStep } from '../utils/webSerialManager';

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
  const blocked = showZTools && machineState.needsZZero && !overridden;
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
            {machineState.status === 'PAUSED_USER' ? 'Paused' : 'Action Required: Machine Paused'}
          </h4>
          <p className="text-xs leading-relaxed font-semibold">{machineState.pauseMessage}</p>
        </div>
      </div>

      {toolChange && showZTools && (
        <p className="text-[11px] leading-relaxed">
          The new bit is a different length from the one that came out, so the machine's Z zero no
          longer describes where the tip is. Touch off again before resuming — jog the tip down onto
          the work and take zero from there, or probe it on the plate.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-amber-500/30">
        {toolChange && showZTools && (
          <>
            <button
              onClick={() => webSerialManager.zeroZHere()}
              title="Take work Z 0 from where the tool is standing right now"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-lg flex items-center space-x-1.5 cursor-pointer"
            >
              <Hand className="w-3.5 h-3.5 text-emerald-400" />
              <span>Set Z Zero Here</span>
            </button>
            <button
              onClick={() => webSerialManager.zeroZ(plateThicknessMm)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-lg flex items-center space-x-1.5 cursor-pointer"
            >
              <ChevronsDown className="w-3.5 h-3.5 text-amber-400" />
              <span>Probe Z Zero</span>
            </button>
          </>
        )}

        {blocked && (
          <button
            onClick={allowResume}
            title="Only if the Z datum is already right for the tool now in the spindle"
            className="px-3 py-1.5 text-amber-700 dark:text-amber-400 hover:underline text-xs font-semibold cursor-pointer"
          >
            Z is already set — let me resume
          </button>
        )}

        <button
          onClick={() => webSerialManager.resumeJob()}
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
}> = ({ machineState, canStart, onStart, startLabel, variant = 'footer' }) => {
  const running = machineState.status === 'RUNNING';
  const paused = machineState.status.startsWith('PAUSED');

  const base =
    variant === 'footer'
      ? 'flex items-center justify-center space-x-2 whitespace-nowrap px-4 py-2 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer'
      : 'flex items-center justify-center space-x-1.5 w-full py-1.5 px-3 font-bold text-xs rounded-lg cursor-pointer';
  const icon = variant === 'footer' ? 'w-4 h-4' : 'w-3.5 h-3.5';

  if (!running && !paused) {
    return (
      <button
        onClick={onStart}
        disabled={!canStart}
        className={`${base} bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950`}
      >
        <Play className={`${icon} fill-current`} />
        <span>{startLabel}</span>
      </button>
    );
  }

  return (
    <div className={variant === 'footer' ? 'flex items-center gap-2' : 'flex items-center gap-2 w-full'}>
      {running ? (
        <button
          onClick={() => webSerialManager.pauseJob()}
          title="Feed hold — decelerates and stops without losing position, so the cut resumes exactly where it stopped"
          className={`${base} bg-amber-500 hover:bg-amber-600 text-slate-950`}
        >
          <Pause className={icon} />
          <span>Pause</span>
        </button>
      ) : (
        <button
          onClick={() => webSerialManager.resumeJob()}
          disabled={machineState.needsZZero}
          title={machineState.needsZZero ? 'Set Z zero for the new tool first' : 'Cycle start'}
          className={`${base} bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950`}
        >
          <Play className={`${icon} fill-current`} />
          <span>Resume</span>
        </button>
      )}
      <button
        onClick={() => webSerialManager.cancelJob()}
        title="Soft reset. This stops the machine now and loses the position — the job cannot be picked back up"
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
}> = ({ machineState, tool, secondTool, rpm, material, origin, caveat }) => {
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
            <span className="text-slate-400">
              {' '}— the job stops partway to swap to {secondTool}
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
          {material && <span className="text-slate-400"> for {material}</span>}
        </span>
      ),
    });
  }
  rows.push({ n: rows.length + 1, label: 'Zero on', value: origin });

  return (
    <div className="pt-3 border-t border-slate-800 space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">Before you start</h4>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.n} className="flex items-baseline gap-2 text-xs text-slate-200">
            <span className="flex-shrink-0 w-4 text-blue-400 font-bold">{r.n}.</span>
            <span className="text-slate-400 whitespace-nowrap">{r.label}</span>
            <span className="min-w-0">{r.value}</span>
          </li>
        ))}
      </ol>
      {caveat && <p className="text-[11px] leading-relaxed text-amber-400">{caveat}</p>}
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
    'px-1.5 py-1 rounded border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-200 ' +
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
          percent === 100 ? 'text-slate-200' : 'text-amber-400'
        }`}
        title={hint}
      >
        {percent}%
      </span>
      <div className="flex gap-1">
        <button className={step} onClick={() => nudge(-10)} title={`${hint} — down 10%`}>−10</button>
        <button className={step} onClick={() => nudge(-1)} title={`${hint} — down 1%`}>−1</button>
        <button className={step} onClick={reset} title={`${hint} — back to what the program asked for`}>
          <RotateCcw className="w-3 h-3" />
        </button>
        <button className={step} onClick={() => nudge(1)} title={`${hint} — up 1%`}>+1</button>
        <button className={step} onClick={() => nudge(10)} title={`${hint} — up 10%`}>+10</button>
      </div>
    </div>
  );

  return (
    <div className="pt-3 border-t border-slate-800 space-y-2">
      <div className="flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-blue-400" />
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">Live Trim</h4>
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
        'Spindle speed — only on a machine whose controller owns the spindle'
      )}
      <p className="text-[10px] leading-relaxed text-slate-500">
        Applied to the motion already in the buffer, so a cut that is chattering or burning can be
        backed off without stopping the job. Chatter or burn marks mean the feed and the speed are
        wrong for each other — trim here to find the pair that works, then set them for next time.
      </p>
    </div>
  );
};
