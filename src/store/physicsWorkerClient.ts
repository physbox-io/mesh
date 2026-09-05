// Thin wrapper around the physics Worker (src/workers/physicsWorker.ts).
//
// The worker owns the live MuJoCo module/model/data and the step loop; this
// client just does postMessage plumbing and exposes small async methods that
// mirror what useStore.ts's recompile()/action methods used to do directly
// against a same-thread MjModel/MjData.

export interface BuiltResult {
  ok: boolean;
  error?: string;
  fatal?: boolean;
  nq?: number; nv?: number; nu?: number; ngeom?: number; nbody?: number;
  timestep?: number;
  geom_size?: number[]; body_mass?: number[]; body_inertia?: number[];
  body_dofnum?: number[]; body_parentid?: number[];
  geom_type?: number[]; geom_rgba?: number[];
  jnt_qposadr?: number[]; jnt_dofadr?: number[];
  idMaps?: { body: Record<string, number>; joint: Record<string, number>; geom: Record<string, number>; actuator: Record<string, number> };
  time?: number;
  isShared?: boolean;
  qpos?: Float64Array; qvel?: Float64Array; ctrl?: Float64Array;
  xfrc_applied?: Float64Array; qfrc_applied?: Float64Array;
  xpos?: Float64Array; xmat?: Float64Array; cvel?: Float64Array;
  geom_xpos?: Float64Array; geom_xmat?: Float64Array;
}

export interface FrameSnapshot {
  time: number;
  isShared?: boolean;
  qpos?: Float64Array; qvel?: Float64Array; ctrl?: Float64Array;
  xfrc_applied?: Float64Array; qfrc_applied?: Float64Array;
  xpos?: Float64Array; xmat?: Float64Array; cvel?: Float64Array;
  geom_xpos?: Float64Array; geom_xmat?: Float64Array;
}

type Pending<T> = { resolve: (r: T) => void; reject: (e: Error) => void };

export class PhysicsWorkerClient {
  private worker: Worker;
  private pendingBuilds = new Map<string, Pending<BuiltResult>>();
  private pendingHeadless = new Map<string, Pending<any>>();
  private pendingHistory = new Map<string, Pending<any[]>>();
  private pendingTelemetry = new Map<string, Pending<any>>();
  onFrame: ((snap: FrameSnapshot) => void) | null = null;
  onError: ((message: string, fatal: boolean, lastState?: { qpos: number[]; qvel: number[]; time: number }) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('../workers/physicsWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (evt: MessageEvent) => {
      const msg = evt.data;
      switch (msg.type) {
        case 'BUILT': {
          const pending = this.pendingBuilds.get(msg.id);
          if (pending) {
            this.pendingBuilds.delete(msg.id);
            const { type: _t, id: _id, ...rest } = msg;
            pending.resolve(rest);
          }
          break;
        }
        case 'FRAME':
          this.onFrame?.(msg);
          break;
        case 'ERROR':
          this.onError?.(msg.message, !!msg.fatal, msg.lastState);
          break;
        case 'HEADLESS_RESULT': {
          const pending = this.pendingHeadless.get(msg.id);
          if (pending) {
            this.pendingHeadless.delete(msg.id);
            const { type: _t, id: _id, ...rest } = msg;
            pending.resolve(rest);
          }
          break;
        }
        case 'HISTORY_RESULT': {
          const pending = this.pendingHistory.get(msg.id);
          if (pending) {
            this.pendingHistory.delete(msg.id);
            pending.resolve(msg.history);
          }
          break;
        }
        case 'TELEMETRY_RESULT': {
          const pending = this.pendingTelemetry.get(msg.id);
          if (pending) {
            this.pendingTelemetry.delete(msg.id);
            pending.resolve(msg.telemetry);
          }
          break;
        }
        default:
          break;
      }
    };
  }

  build(
    xml: string,
    sceneGraph: any,
    preserveState: boolean,
    seedState?: { qpos: number[]; qvel: number[]; ctrl?: number[]; time: number },
  ): Promise<BuiltResult> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingBuilds.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'BUILD', id, xml, sceneGraph, preserveState, seedState });
    });
  }

  setPlaying(isPlaying: boolean) { this.worker.postMessage({ type: 'SET_PLAYING', isPlaying }); }
  // Drives the worker's step loop in lockstep with the main thread's own
  // requestAnimationFrame, so physics stepping stays in phase with rendering
  // instead of drifting against an independent worker-side timer.
  tick(delta: number) { this.worker.postMessage({ type: 'TICK', delta }); }
  setEnv(windX: number, windY: number) { this.worker.postMessage({ type: 'SET_ENV', windX, windY }); }
  setDrag(nodeId: string | null, target: { x: number; y: number; z: number } | null) { this.worker.postMessage({ type: 'SET_DRAG', nodeId, target }); }
  setKeys(keys: string[]) { this.worker.postMessage({ type: 'SET_KEYS', keys }); }
  setQpos(jointName: string, axis: number, value: number) { this.worker.postMessage({ type: 'SET_QPOS', jointName, axis, value }); }
  setCtrl(actuatorName: string, value: number) { this.worker.postMessage({ type: 'SET_CTRL', actuatorName, value }); }
  updateScript(nodeId: string, script: string) { this.worker.postMessage({ type: 'UPDATE_SCRIPT', nodeId, script }); }

  runHeadless(xml: string, sceneGraph: any, ticks: number): Promise<any> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingHeadless.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'RUN_HEADLESS', id, xml, sceneGraph, ticks });
    });
  }

  getHistory(): Promise<any[]> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingHistory.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_HISTORY', id });
    });
  }

  getTelemetry(): Promise<any> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingTelemetry.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_TELEMETRY', id });
    });
  }

  // True while the worker still owes an answer to a build/headless/history/
  // telemetry request. The periodic recycle checks this so it doesn't
  // terminate a worker mid-build and turn a legitimate request into a failure.
  hasPendingWork(): boolean {
    return this.pendingBuilds.size > 0 || this.pendingHeadless.size > 0
        || this.pendingHistory.size > 0 || this.pendingTelemetry.size > 0;
  }

  clearHistory() {
    this.worker.postMessage({ type: 'CLEAR_HISTORY' });
  }

  terminate() {
    this.worker.terminate();
    // A terminated worker will never answer anything it was already asked, so
    // every in-flight request has to be settled here. Left pending they hang
    // forever, and so does whatever is awaiting them - that's how an MCP
    // command whose recompile was still running when the periodic recycle
    // fired ended up never replying, leaving the "MCP Active" badge on screen
    // for the rest of the session. The message deliberately avoids the words
    // recompile() sniffs for when deciding a failure was WASM heap exhaustion.
    const err = new Error('The physics worker was recycled before this request completed.');
    const settle = (map: Map<string, Pending<any>>) => {
      for (const pending of map.values()) pending.reject(err);
      map.clear();
    };
    settle(this.pendingBuilds);
    settle(this.pendingHeadless);
    settle(this.pendingHistory);
    settle(this.pendingTelemetry);
  }
}
