// What control scripts got wrong, what they logged, and what they cost.
//
// The physics worker runs every scripted body's `new Function('api', src)` on
// every step. Before this module, a script that threw, a typo'd actuator name
// and every api.log line went to the worker's console and nowhere else, so an
// agent driving the app over MCP saw a scene that "just didn't move" — and a
// script costing 4 ms a step quietly ran live play at a tenth of real time.
//
// Kept out of physicsWorker.ts (which cannot be imported outside a Worker
// realm) so it can be tested on its own: see tests/scriptDiagnostics.test.ts.
// Store-free: the worker bundle pulls it in.

/** One distinct mistake a script made: the same body and message is one entry. */
export interface ScriptProblem {
  body: string;
  message: string;
  /** Sim time, s, of the first occurrence. */
  firstAtTime: number;
  /** How many times it happened: for a runtime error, how many steps it failed on. */
  count: number;
}

/** Distinct problems kept; past this, new ones are only counted. */
export const MAX_SCRIPT_PROBLEMS = 50;

const isRuntimeError = (message: string) => message.startsWith('runtime error');

/** "Script on 'cart': runtime error: x is not defined (first at t=0.301 s, failed on 700 steps)". */
export const formatScriptProblem = (p: ScriptProblem): string => {
  const times = p.count > 1 ? `, ${isRuntimeError(p.message) ? `failed on ${p.count} steps` : `${p.count} times`}` : '';
  return `Script on '${p.body}': ${p.message} (first at t=${p.firstAtTime.toFixed(3)} s${times})`;
};

export class ScriptProblemLog {
  private problems = new Map<string, ScriptProblem>();
  /** Problems seen after the table was full. */
  overflow = 0;
  /** Bumped whenever a new distinct problem is added or the log is cleared. */
  version = 0;

  /** Records one occurrence. True the first time this body + message is seen, so the caller can log it once. */
  note(body: string, message: string, time: number): boolean {
    const key = `${body}\u0000${message}`;
    const seen = this.problems.get(key);
    if (seen) {
      seen.count++;
      return false;
    }
    if (this.problems.size >= MAX_SCRIPT_PROBLEMS) {
      this.overflow++;
      return false;
    }
    this.problems.set(key, { body, message, firstAtTime: Number.isFinite(time) ? time : 0, count: 1 });
    this.version++;
    return true;
  }

  get size(): number {
    return this.problems.size;
  }

  clear(): void {
    if (this.problems.size === 0 && this.overflow === 0) return;
    this.problems.clear();
    this.overflow = 0;
    this.version++;
  }

  /** Forgets the problems of these bodies (by name): their scripts have changed. */
  clearBodies(bodies: Set<string>): void {
    let changed = false;
    for (const [key, p] of this.problems) {
      if (bodies.has(p.body)) { this.problems.delete(key); changed = true; }
    }
    if (changed) this.version++;
  }

  list(): ScriptProblem[] {
    return [...this.problems.values()].map((p) => ({ ...p }));
  }

  /** One line per problem, with when it started and how often, for a run's warnings. */
  warnings(): string[] {
    const out = [...this.problems.values()].map(formatScriptProblem);
    if (this.overflow > 0) out.push(`Scripts made ${this.overflow} more mistake(s) beyond the ${MAX_SCRIPT_PROBLEMS} listed.`);
    return out;
  }
}

// ---- api.log ---------------------------------------------------------------

export interface ScriptLogLine {
  /** Sim time, s. */
  t: number;
  body: string;
  msg: string;
}

/** Longest single line kept, in characters. */
export const MAX_LOG_LINE = 500;

/** A log argument as text: strings as they are, everything else as JSON where it can be. */
export const logText = (args: unknown[]): string => {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean' || a === null || a === undefined) return String(a);
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  });
  const text = parts.join(' ');
  return text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text;
};

/** The last `capacity` api.log lines, oldest first. */
export class ScriptLogRing {
  private buf: ScriptLogLine[] = [];
  private head = 0;
  /** Every line ever pushed, kept or not. */
  total = 0;
  readonly capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  push(t: number, body: string, args: unknown[]): void {
    const line = { t, body, msg: logText(args) };
    if (this.buf.length < this.capacity) this.buf.push(line);
    else { this.buf[this.head] = line; this.head = (this.head + 1) % this.capacity; }
    this.total++;
  }

  /** Lines pushed but no longer held. */
  get dropped(): number {
    return this.total - this.buf.length;
  }

  /** Oldest first; `last` keeps only the newest N. */
  entries(last?: number): ScriptLogLine[] {
    const ordered = this.buf.length < this.capacity ? [...this.buf] : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
    return last !== undefined && last < ordered.length ? ordered.slice(ordered.length - last) : ordered;
  }

  clear(): void {
    this.buf = [];
    this.head = 0;
    this.total = 0;
  }
}

// ---- Cost ------------------------------------------------------------------

export interface ScriptTimingReport {
  /** Mean wall time all scripts took per physics step, ms. */
  scriptMsPerStep: number;
  /** Sim seconds advanced per wall second; 1 is real time. Null in a headless run. */
  realtimeFactor: number | null;
  /** Share of wall time spent in scripts, 0..1. */
  scriptShare: number;
  /** The most expensive script, when there is one. */
  slowest?: { body: string; msPerStep: number };
  /** The wall time this was measured over, ms. */
  measuredOverMs: number;
}

/** Shortest window a live figure is reported from, ms of wall time. */
export const TIMING_WINDOW_MS = 1000;

/**
 * Per-step script cost and the realtime factor, measured in windows of about a
 * second of wall time. Cheap: two counters per step, one per scripted body.
 */
export class ScriptTiming {
  private steps = 0;
  private scriptMs = 0;
  private perBody = new Map<string, number>();
  private windowStartWall: number | null = null;
  private windowStartSim = 0;
  /** The last full window's figures. */
  last: ScriptTimingReport | null = null;

  addStep(scriptMs: number): void {
    this.steps++;
    this.scriptMs += scriptMs;
  }

  addBody(body: string, ms: number): void {
    this.perBody.set(body, (this.perBody.get(body) ?? 0) + ms);
  }

  /** The figures since the window opened, without closing it. */
  current(wallMs: number, realtimeFactor: number | null): ScriptTimingReport | null {
    if (this.steps === 0) return null;
    let slowest: ScriptTimingReport['slowest'];
    for (const [body, ms] of this.perBody) {
      if (!slowest || ms / this.steps > slowest.msPerStep) slowest = { body, msPerStep: ms / this.steps };
    }
    return {
      scriptMsPerStep: this.scriptMs / this.steps,
      realtimeFactor,
      scriptShare: wallMs > 0 ? Math.min(1, this.scriptMs / wallMs) : 0,
      ...(slowest ? { slowest } : {}),
      measuredOverMs: wallMs,
    };
  }

  /**
   * Call after each burst of live steps. Closes the window once it spans
   * TIMING_WINDOW_MS, and returns true when that produced a new report.
   */
  tick(nowWallMs: number, simTime: number): boolean {
    if (this.windowStartWall === null) {
      this.windowStartWall = nowWallMs;
      this.windowStartSim = simTime;
      this.resetCounters();
      return false;
    }
    const wall = nowWallMs - this.windowStartWall;
    if (wall < TIMING_WINDOW_MS) return false;
    const rtf = (simTime - this.windowStartSim) / (wall / 1000);
    this.last = this.current(wall, rtf) ?? { scriptMsPerStep: 0, realtimeFactor: rtf, scriptShare: 0, measuredOverMs: wall };
    this.windowStartWall = nowWallMs;
    this.windowStartSim = simTime;
    this.resetCounters();
    return true;
  }

  /** Starts a fresh window: play started, a build, a hold. Keeps `last`. */
  restart(): void {
    this.windowStartWall = null;
    this.resetCounters();
  }

  private resetCounters(): void {
    this.steps = 0;
    this.scriptMs = 0;
    this.perBody.clear();
  }
}

/** Below this realtime factor live play is called slow. */
export const SLOW_RTF = 0.8;
/** Scripts taking more than this share of the wall time are what is making it slow. */
export const SCRIPT_DOMINANT_SHARE = 0.3;

/**
 * A headless run's cost, as the warning live play would deserve: scripts are
 * judged against the real-time budget of one timestep per step.
 */
export const headlessCostWarning = (
  ticks: number, wallMs: number, scriptMs: number, timestepS: number, slowest?: { body: string; msPerStep: number },
): string | null => {
  if (ticks <= 0 || wallMs <= 0) return null;
  const share = scriptMs / wallMs;
  const msPerStep = wallMs / ticks;
  const liveRtf = (timestepS * 1000) / msPerStep;
  if (share < 0.5 || liveRtf >= SLOW_RTF) return null;
  const who = slowest ? ` (slowest: '${slowest.body}' at ${slowest.msPerStep.toFixed(2)} ms)` : '';
  return `Scripts used ${Math.round(share * 100)}% of step time (${(scriptMs / ticks).toFixed(2)} ms/step${who} vs ${(timestepS * 1000).toFixed(2)} ms budget; ~${liveRtf.toFixed(2)}x real time). Reduce per-step work or run every Nth step.`;
};
