/**
 * Keeping a running job recoverable across a reload, a sleep, or the power
 * going off.
 *
 * Everything `webSerialManager` needs to pick a job back up — the program, and
 * the line it reached — has always lived in that singleton's fields, which is
 * to say in the tab. That is enough for the failures it was written for (a
 * snapped cutter, a limit switch, a nudged USB lead), because the tab survives
 * all three. It is not enough for the failure that actually costs the most: a
 * twenty-hour relief, a laptop that sleeps at hour six, and a `program` array
 * that went with it. `resumeFromLine` then answers "there is no program to
 * resume", and the only way back is to run the whole file again from the top.
 *
 * So the program is written down when the job starts, and the line it has
 * reached is written down as it goes.
 *
 * Two records rather than one, because they are written on completely different
 * clocks. The program is megabytes and never changes for the length of the job;
 * the line changes every few milliseconds and is a number. Putting them in one
 * blob would mean rewriting the megabytes to record the number — on the machine
 * that is streaming G-code over USB at the time.
 *
 * Two places, for the same reason the rest of the app has two places:
 *
 *  - **localStorage**, for everybody. Survives a reload, a crash, a sleep and a
 *    power cut, costs nothing, needs no account. It is the source of truth when
 *    it has the record, because it is the one that cannot be stale.
 *  - **The account**, for Pro. Survives what localStorage does not: a browser
 *    profile that clears site data, a laptop that does not come back, and the
 *    operator carrying on from a different machine. It is also the only option
 *    for a program too big for localStorage, which for a long relief carve is
 *    the ordinary case rather than the exotic one — see `MAX_LOCAL_BYTES`.
 *
 * Nothing here is load-bearing for the machine. A checkpoint that fails to
 * write is a resume that is not offered later; it is never a reason to refuse
 * to run a job, which is why every write in this file swallows its own errors.
 */

import {
  isProAccount,
  getStoredAuthToken,
  putCloudDocument,
  fetchCloudDocument,
  fetchCloudDocuments,
  deleteCloudDocument,
} from './apiClient';

/**
 * Which app's documents these are.
 *
 * Deliberately *not* `physics`, which is the scene. The checkpoint is bookkeeping
 * rather than work: it should not appear anywhere the account's documents are
 * listed, and giving it its own app id is what keeps it out, since every listing
 * is filtered by one.
 */
const APP_ID = 'physics-job';

const PROGRAM_KEY = 'physics_job_checkpoint_program';
const PROGRESS_KEY = 'physics_job_checkpoint_progress';
/** This browser's identity, so its own records can be found again by id. */
const INSTALL_KEY = 'physics_job_checkpoint_install';

/**
 * The largest program written to localStorage.
 *
 * The origin quota is about 5 MB for the whole app — shared with the scene, the
 * presets and the auth session — so the ceiling here is not "what fits" but
 * "what fits without evicting the work the operator would rather keep". Two
 * megabytes is roughly a quarter of a million lines of G-code, which covers
 * every laser job and most routing, and does not cover a fine-stepover relief.
 *
 * A program over this is not a failure: it is the case the cloud copy exists
 * for, and `tooLargeForLocal` is what the UI reads to say so.
 */
const MAX_LOCAL_BYTES = 2 * 1024 * 1024;

/** How often the reached line is written locally while a job streams. */
const LOCAL_PROGRESS_MS = 2000;

/**
 * How often it goes to the account.
 *
 * Slower by a factor of thirty because it is an HTTP request that makes a
 * revision, and a job running for a day would otherwise leave a five-figure
 * revision history behind it. A minute of lost progress on a resume costs a
 * minute of recut surface, which is the right side of that trade.
 */
const CLOUD_PROGRESS_MS = 60000;

/**
 * How long a checkpoint is worth offering.
 *
 * Long enough to cover a job abandoned on a Friday and picked up on a Monday.
 * Past that the stock has almost certainly come off the bed, and an offer to
 * descend into a cut that is no longer under the spindle is worse than no offer
 * at all.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Why the last progress record was written. */
export type CheckpointReason =
  | 'streaming'
  | 'alarm'
  | 'cancelled'
  | 'disconnected'
  | 'parked';

/** The program, written once when the job starts. */
export interface CheckpointProgram {
  version: 1;
  /** Identifies this run, so a progress record cannot be applied to another program. */
  id: string;
  startedAt: number;
  jobName: string | null;
  settings: Record<string, unknown> | null;
  gcode: string;
  totalLines: number;
  /** The cloud document the program was generated from, when there is one. */
  documentId: string | null;
}

/** How far it got, written repeatedly. */
export interface CheckpointProgress {
  version: 1;
  id: string;
  at: number;
  fromLine: number;
  reason: CheckpointReason;
}

/** A checkpoint recovered from somewhere, ready to be handed to the manager. */
export interface RestorableCheckpoint {
  program: CheckpointProgram;
  progress: CheckpointProgress;
  /** Which store it came back from, which is worth saying out loud in the offer. */
  source: 'local' | 'cloud';
  /**
   * The line is older than the program's own last word on it.
   *
   * True when the program came from the account and the line did too: the cloud
   * record is written on a slow clock, so it can be up to `CLOUD_PROGRESS_MS`
   * behind where the machine actually got to. The operator is told, because the
   * answer is to wind the line back rather than to trust it.
   */
  approximate: boolean;
}

/** What the UI says about where the running job is being kept. */
export interface CheckpointStatus {
  /** Whether there is a checkpoint for a job at all. */
  active: boolean;
  /** Written to this browser's storage. */
  local: boolean;
  /** Written to the account. */
  cloud: boolean;
  /** Too big for this browser, so only the account can hold it. */
  tooLargeForLocal: boolean;
  /** The program's size, for saying how much too big. */
  bytes: number;
}

const IDLE_STATUS: CheckpointStatus = {
  active: false,
  local: false,
  cloud: false,
  tooLargeForLocal: false,
  bytes: 0,
};

let status: CheckpointStatus = { ...IDLE_STATUS };
const listeners = new Set<(s: CheckpointStatus) => void>();

/** The run being checkpointed, held so progress writes can be cheap. */
let current: CheckpointProgram | null = null;
let lastLocalWrite = 0;
let lastCloudWrite = 0;
let cloudWriteInFlight = false;
/**
 * A progress record that arrived while one was already going out.
 *
 * Latest wins, and it is sent as soon as the wire is free. Without this the
 * forced writes — the alarm, the dropped lead, the park — would be exactly the
 * ones dropped: they come at the end of a stream of ordinary ones, so there is
 * very often a request already in flight when they land, and they are the only
 * writes whose loss actually costs anything.
 */
let cloudPending: CheckpointProgress | null = null;

function setStatus(patch: Partial<CheckpointStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

export function getCheckpointStatus(): CheckpointStatus {
  return { ...status };
}

export function subscribeCheckpoint(fn: (s: CheckpointStatus) => void): () => void {
  listeners.add(fn);
  fn(getCheckpointStatus());
  return () => {
    listeners.delete(fn);
  };
}

/** Bytes, as something to put in a sentence. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // A full quota, a private window, site data blocked. All of them mean the
    // same thing here: this copy does not exist, and the account copy — if there
    // is one — is the only one.
    return false;
  }
}

function dropLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do about it */
  }
}

/**
 * This browser's id, made once and kept.
 *
 * The cloud records are addressed by it so the ordinary case — same laptop,
 * next morning — is a single fetch by a known id rather than a listing. The
 * listing is still the fallback for the case the id is the very thing that was
 * lost; see `loadCheckpoint`.
 */
function installId(): string {
  const existing = readLocal<string>(INSTALL_KEY);
  if (typeof existing === 'string' && existing) return existing;
  const made = `i${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  writeLocal(INSTALL_KEY, made);
  return made;
}

function programDocId(): string {
  return `mesh-job-program-${installId()}`;
}

function progressDocId(): string {
  return `mesh-job-progress-${installId()}`;
}

/** Whether the account can be written to at all. */
function cloudAvailable(): boolean {
  return !!getStoredAuthToken() && isProAccount();
}

/**
 * Starts checkpointing a job.
 *
 * Called with the program as it was handed to the streamer, before the first
 * line goes out — a checkpoint written after streaming starts is a checkpoint
 * that does not cover the first minutes, which is a real window on a job whose
 * first move is the deepest one.
 *
 * Returns synchronously with what could be written locally. The cloud copy goes
 * out behind it and updates `status` when it lands, because a job must not wait
 * on a network request to begin.
 */
export function beginCheckpoint(input: {
  gcode: string;
  totalLines: number;
  jobName?: string | null;
  settings?: Record<string, unknown> | null;
  documentId?: string | null;
}): CheckpointStatus {
  const program: CheckpointProgram = {
    version: 1,
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    jobName: input.jobName ?? null,
    settings: input.settings ?? null,
    gcode: input.gcode,
    totalLines: input.totalLines,
    documentId: input.documentId ?? null,
  };
  current = program;
  lastLocalWrite = 0;
  lastCloudWrite = 0;
  cloudPending = null;

  // Measured on the string rather than on `JSON.stringify` of the record: the
  // difference is the escaping, and the point of the number is to be quoted to
  // somebody as the size of their job.
  const bytes = program.gcode.length;
  const fits = bytes <= MAX_LOCAL_BYTES;
  const local = fits && writeLocal(PROGRAM_KEY, program);
  if (!local) dropLocal(PROGRAM_KEY);

  setStatus({
    active: true,
    local,
    cloud: false,
    tooLargeForLocal: !fits || (!local && bytes > 0),
    bytes,
  });

  recordProgress(0, 'streaming', true);

  if (cloudAvailable()) {
    void putCloudDocument({
      id: programDocId(),
      appId: APP_ID,
      name: program.jobName || 'Untitled job',
      data: program,
    })
      .then(() => setStatus({ cloud: true }))
      .catch(() => setStatus({ cloud: false }));
  }

  return getCheckpointStatus();
}

/**
 * Records how far the job has got.
 *
 * Called from the streamer on every line, so the throttle is the whole design:
 * without it this would be a `JSON.stringify` and a storage write per G-code
 * block, on the thread that is pacing the serial port.
 *
 * `force` is for the moments that are not "still going" — the alarm, the drop,
 * the park — where the next thing to happen may be the tab closing, and waiting
 * out an interval would lose the one write that mattered.
 */
export function recordProgress(
  fromLine: number,
  reason: CheckpointReason = 'streaming',
  force = false
): void {
  if (!current) return;

  const now = Date.now();
  const record: CheckpointProgress = {
    version: 1,
    id: current.id,
    at: now,
    fromLine,
    reason,
  };

  if (force || now - lastLocalWrite >= LOCAL_PROGRESS_MS) {
    lastLocalWrite = now;
    writeLocal(PROGRESS_KEY, record);
  }

  if (!cloudAvailable()) return;
  if (!force && now - lastCloudWrite < CLOUD_PROGRESS_MS) return;

  lastCloudWrite = now;
  pushCloudProgress(record);
}

/** Sends one progress record, queueing behind any already in flight. */
function pushCloudProgress(record: CheckpointProgress): void {
  if (cloudWriteInFlight) {
    cloudPending = record;
    return;
  }

  cloudWriteInFlight = true;
  void putCloudDocument({
    id: progressDocId(),
    appId: APP_ID,
    name: 'Job progress',
    data: record,
  })
    .catch(() => {
      /* The local copy is the one that matters; this is the spare. */
    })
    .finally(() => {
      cloudWriteInFlight = false;
      const next = cloudPending;
      cloudPending = null;
      // Only if the job is still the one that record belongs to: a checkpoint
      // cleared while a write was out must not be resurrected by its own tail.
      if (next && current?.id === next.id) pushCloudProgress(next);
    });
}

/**
 * Forgets the job.
 *
 * Called when a job runs to its end, and when the operator discards the offer to
 * resume one that did not. Both mean the same thing: there is nothing left to
 * pick up, and an offer made tomorrow would be an offer to cut a piece that is
 * no longer on the machine.
 */
export function clearCheckpoint(): void {
  current = null;
  lastLocalWrite = 0;
  lastCloudWrite = 0;
  cloudPending = null;
  dropLocal(PROGRAM_KEY);
  dropLocal(PROGRESS_KEY);
  setStatus({ ...IDLE_STATUS });

  if (!cloudAvailable()) return;
  void deleteCloudDocument(programDocId());
  void deleteCloudDocument(progressDocId());
}

/** Whether a record is recent enough to still describe something on the machine. */
function fresh(at: number): boolean {
  return Number.isFinite(at) && Date.now() - at < TTL_MS;
}

function usable(program: unknown, progress: unknown): boolean {
  const p = program as CheckpointProgram | null;
  const q = progress as CheckpointProgress | null;
  if (!p || !q) return false;
  if (p.version !== 1 || q.version !== 1) return false;
  if (typeof p.gcode !== 'string' || !p.gcode) return false;
  // A progress record from a different run says nothing about this program, and
  // applying it would be a resume at an arbitrary line of the wrong file.
  if (p.id !== q.id) return false;
  if (!fresh(q.at)) return false;
  // Nothing was cut, so there is nothing to pick up — just run it again.
  return q.fromLine > 0;
}

/**
 * Finds a job left behind by a previous session.
 *
 * Local first and cloud second, because the local record is the one written
 * every two seconds and the cloud record is the one written every minute:
 * whenever both exist, the local one is both fresher and free.
 *
 * The cloud search is by id first and by listing second. The id lives in
 * localStorage alongside everything else, so a browser that has been cleared —
 * or a different laptop entirely, which is the case a Pro account is for — has
 * lost it, and the only way back to the record is to ask the account what it
 * holds.
 */
export async function loadCheckpoint(): Promise<RestorableCheckpoint | null> {
  const localProgram = readLocal<CheckpointProgram>(PROGRAM_KEY);
  const localProgress = readLocal<CheckpointProgress>(PROGRESS_KEY);
  if (usable(localProgram, localProgress)) {
    return {
      program: localProgram!,
      progress: localProgress!,
      source: 'local',
      approximate: false,
    };
  }

  if (!cloudAvailable()) return null;

  try {
    let program = await fetchCloudDocument(programDocId())
      .then((d) => d.data as CheckpointProgram)
      .catch(() => null);
    let progress = await fetchCloudDocument(progressDocId())
      .then((d) => d.data as CheckpointProgress)
      .catch(() => null);

    if (!usable(program, progress)) {
      // The id is gone with the storage that held it. Ask the account instead.
      const docs = await fetchCloudDocuments(APP_ID);
      const programDoc = docs
        .filter((d) => d.id.startsWith('mesh-job-program-'))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!programDoc) return null;
      const suffix = programDoc.id.slice('mesh-job-program-'.length);
      program = await fetchCloudDocument(programDoc.id)
        .then((d) => d.data as CheckpointProgram)
        .catch(() => null);
      progress = await fetchCloudDocument(`mesh-job-progress-${suffix}`)
        .then((d) => d.data as CheckpointProgress)
        .catch(() => null);
    }

    if (!usable(program, progress)) return null;

    // Whichever way it was found, a cloud line is up to a minute behind the cut.
    return { program: program!, progress: progress!, source: 'cloud', approximate: true };
  } catch {
    return null;
  }
}

/**
 * Re-arms checkpointing for a job that has been restored and is about to run on.
 *
 * Without this a resumed job would stream with `current` still null, record no
 * progress at all, and be unrecoverable the second time — which is the time it
 * matters most, because by then the operator has already lost a day once.
 */
export function adoptCheckpoint(program: CheckpointProgram): void {
  current = program;
  lastLocalWrite = 0;
  lastCloudWrite = 0;
  cloudPending = null;

  /*
   * Written back down, not just remembered.
   *
   * A job recovered from the account arrives on a browser whose storage is
   * empty — that is how it came to be recovered from the account. Adopting it
   * without writing it here would leave the local progress records pointing at
   * a program that is not local, and the *second* interruption would have to go
   * back to the network for something this machine has been holding in memory
   * all along.
   */
  const bytes = program.gcode.length;
  const local = bytes <= MAX_LOCAL_BYTES && writeLocal(PROGRAM_KEY, program);

  setStatus({
    active: true,
    local,
    cloud: cloudAvailable(),
    tooLargeForLocal: bytes > MAX_LOCAL_BYTES,
    bytes,
  });
}

/** For tests: the ceiling, so a fixture can be built either side of it. */
export const CHECKPOINT_LIMITS = { MAX_LOCAL_BYTES, LOCAL_PROGRESS_MS, CLOUD_PROGRESS_MS, TTL_MS };
