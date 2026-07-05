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
  jnt_qposadr?: number[]; jnt_dofadr?: number[];
  idMaps?: { body: Record<string, number>; joint: Record<string, number>; geom: Record<string, number>; actuator: Record<string, number> };
  time?: number;
  qpos?: Float64Array; qvel?: Float64Array; ctrl?: Float64Array;
  xfrc_applied?: Float64Array; qfrc_applied?: Float64Array;
  xpos?: Float64Array; xmat?: Float64Array; cvel?: Float64Array;
  geom_xpos?: Float64Array; geom_xmat?: Float64Array;
}

export interface FrameSnapshot {
  time: number;
  qpos: Float64Array; qvel: Float64Array; ctrl: Float64Array;
  xfrc_applied: Float64Array; qfrc_applied: Float64Array;
  xpos: Float64Array; xmat: Float64Array; cvel: Float64Array;
  geom_xpos: Float64Array; geom_xmat: Float64Array;
  historyEntry?: any;
}

export class PhysicsWorkerClient {
  private worker: Worker;
  private pendingBuilds = new Map<string, { resolve: (r: BuiltResult) => void }>();
  private pendingHeadless = new Map<string, { resolve: (r: any) => void }>();
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
    return new Promise((resolve) => {
      this.pendingBuilds.set(id, { resolve });
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
    return new Promise((resolve) => {
      this.pendingHeadless.set(id, { resolve });
      this.worker.postMessage({ type: 'RUN_HEADLESS', id, xml, sceneGraph, ticks });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
