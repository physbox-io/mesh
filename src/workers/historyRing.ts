// The physics worker's telemetry history, and the filtered reads of it.
//
// Kept out of physicsWorker.ts so it can be tested without a Worker realm or
// MuJoCo (see tests/physicsHistory.test.ts).
//
// Why filter here rather than on the main thread: a full buffer (5000 frames,
// ~20 bodies) is ~14 MB as JSON and took ~0.5 s just to structured-clone
// across postMessage. Its only consumer is physics_get_history, and no agent
// can read 14 MB anyway. Cutting the slice down *before* it is posted removes
// the clone cost and the payload together.

import type { HistoryEntry, HistoryFrame, HistoryQuery } from './physicsWorkerProtocol';

export class HistoryRing {
  private buf: (HistoryEntry | undefined)[];
  private head = 0; // index the next push writes to
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** O(1): overwrites the oldest entry once full (no Array.shift()). */
  push(entry: HistoryEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  latest(): HistoryEntry | null {
    if (this.count === 0) return null;
    return this.buf[(this.head - 1 + this.capacity) % this.capacity] ?? null;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /** Entry `i` counted from the oldest held. */
  private at(i: number): HistoryEntry {
    return this.buf[(this.head - this.count + i + this.capacity) % this.capacity]!;
  }

  /**
   * Oldest → newest, in this order:
   *   1. `sinceTime` drops frames recorded before that sim time;
   *   2. `last` keeps only the newest N of what is left;
   *   3. `stride` keeps every kth frame, raised as far as `maxFrames` needs,
   *      counted back from the newest so the newest is always included;
   *   4. `bodies` / `include` trim what each frame carries.
   * Frames are shallow copies: entries in the ring are never mutated.
   */
  query(q: HistoryQuery = {}): { frames: HistoryFrame[]; total: number; stride: number } {
    let start = 0;
    if (q.sinceTime !== undefined) {
      // Times only increase between CLEAR_HISTORYs, so binary search.
      let lo = 0, hi = this.count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.at(mid).time < q.sinceTime) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }
    if (q.last !== undefined && q.last >= 0) start = Math.max(start, this.count - Math.floor(q.last));
    const n = this.count - start;

    let stride = Math.max(1, Math.floor(q.stride ?? 1));
    if (q.maxFrames !== undefined && q.maxFrames > 0) stride = Math.max(stride, Math.ceil(n / Math.floor(q.maxFrames)));

    const bodyFilter = q.bodies && q.bodies.length > 0 ? new Set(q.bodies) : null;
    const include = q.include ? new Set(q.include) : null;
    const project = (e: HistoryEntry): HistoryFrame => {
      if (!bodyFilter && !include) return e;
      const f: HistoryFrame = { time: e.time };
      if (!include || include.has('bodies')) {
        f.bodies = bodyFilter
          ? Object.fromEntries(Object.entries(e.bodies).filter(([k]) => bodyFilter.has(k)))
          : e.bodies;
      }
      if (!include || include.has('joints')) f.joints = e.joints;
      if (!include || include.has('contacts')) f.contacts = e.contacts;
      if (!include || include.has('aero')) f.aeroDiagnostics = e.aeroDiagnostics;
      return f;
    };

    const frames: HistoryFrame[] = [];
    if (n <= 0) return { frames, total: this.count, stride };
    // First kept index such that (count - 1 - i) % stride === 0.
    const first = start + ((n - 1) % stride);
    for (let i = first; i < this.count; i += stride) frames.push(project(this.at(i)));
    return { frames, total: this.count, stride };
  }
}
