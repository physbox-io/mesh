// `api.state` — each scripted body's own persistent object.
//
// A control script runs as `new Function('api', src)` once per physics step,
// so its local variables are gone by the next call. `api.state` is the place
// to keep anything that has to last: an integrator, a phase, a timer. Mutate
// its contents (`api.state.integral += e`); the object itself is fixed, and
// assigning `api.state = …` is ignored.
//
// It survives every step and every rebuild that keeps the simulation running
// (an edit mid-play, a shatter), and — the reason it exists rather than ad-hoc
// globals — a worker recycle: the worker is respawned when its WASM heap grows
// and on some rebuilds, which wipes every global a script had set. The state
// travels to the new worker in the seed, alongside qpos/qvel. A Reset or a
// preset load empties it.
//
// The native desktop app implements the same contract (ScriptRuntime), and
// also rewinds this state with its run-ahead buffer, so the same script
// behaves the same in both.

export type ScriptStateMap = Record<string, Record<string, unknown>>;

export class ScriptStateStore {
  private states: ScriptStateMap = {};
  private warnedUncloneable = false;

  /** The node's state object, created empty on first use. */
  stateFor(nodeId: string): Record<string, unknown> {
    let s = this.states[nodeId];
    if (!s) {
      s = {};
      this.states[nodeId] = s;
    }
    return s;
  }

  /** Empties every node's state: Reset, a preset load, a fresh build. */
  clear(): void {
    this.states = {};
  }

  /**
   * A structured-clone copy of every non-empty state, for the seed a fresh
   * worker is built from. `undefined` when there is nothing to carry, or when
   * a state holds something that cannot cross a worker boundary (a function,
   * say) — then it is left behind, as globals always were, with one warning.
   */
  snapshot(): ScriptStateMap | undefined {
    const out: ScriptStateMap = {};
    let any = false;
    for (const [id, s] of Object.entries(this.states)) {
      if (Object.keys(s).length === 0) continue;
      out[id] = s;
      any = true;
    }
    if (!any) return undefined;
    try {
      return structuredClone(out);
    } catch (e) {
      if (!this.warnedUncloneable) {
        this.warnedUncloneable = true;
        console.warn('[Scripts] api.state holds something that cannot be carried across a physics worker restart (keep it to plain values, arrays and objects):', e);
      }
      return undefined;
    }
  }

  /** Replaces every state with a snapshot's (from a seed). */
  restore(snapshot: ScriptStateMap | undefined): void {
    this.states = {};
    if (!snapshot) return;
    for (const [id, s] of Object.entries(snapshot)) {
      if (s && typeof s === 'object') this.states[id] = s;
    }
  }
}

/**
 * Gives an api object its node's state. Not writable — `api.state = x` is
 * ignored in sloppy code and throws in strict code, in both apps — and
 * enumerable so it shows up like the methods do.
 */
export const attachScriptState = (api: object, store: ScriptStateStore, nodeId: string): void => {
  Object.defineProperty(api, 'state', {
    value: store.stateFor(nodeId),
    enumerable: true,
    configurable: true,
    writable: false,
  });
};

/**
 * What a build does to script state. A seed from a recycled worker carries it
 * over; a build that keeps the running simulation (an edit, a shatter) keeps
 * it; anything else — Reset, a preset load — starts empty.
 */
export const scriptStateForBuild = (
  store: ScriptStateStore,
  preserveState: boolean,
  seed: { scriptState?: ScriptStateMap } | undefined,
): void => {
  if (seed) store.restore(seed.scriptState);
  else if (!preserveState) store.clear();
};
