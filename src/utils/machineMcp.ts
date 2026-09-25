import {
  ArmingGate,
  createMachineHandlers,
  describeMachine,
  type ArmingState,
  type MachineControl,
} from '@physbox-io/machining';
import { webSerialManager, ZERO_SEARCH_MM } from './webSerialManager';
import type { ResumeOptions } from './jobResume';
import { fetchMachineDevices } from './apiClient';
import { generateSolidMachining, DEFAULT_SOLID_OPTIONS } from './solidMachiningExporter';
import { MATERIALS } from './feedsAndSpeeds';
import { runSettings } from './runSettings';
import type { SceneGraph } from '../types/scene';

// ---------------------------------------------------------------------------
// Driving Mesh's machine from MCP
// ---------------------------------------------------------------------------
//
// The command set and the arming gate are shared with Volt and Etch. What is
// here is the part that is Mesh's: carving the scene that is loaded, and the
// zeroing and probing routines that are shaped by cutting a solid rather than
// a board.
//
// The manager this drives does not extend the package's GrblMachine — its
// streaming is ack-driven and woven through resume-from-line and park — and it
// does not need to. The handlers depend on `MachineControl`, which is the set
// of things a machine has to be able to do to be driven from a conversation,
// and this manager satisfies it.

/**
 * The gate. One per tab, because there is one machine.
 *
 * Disarming cancels whatever the agent had running. A window closed while a
 * carve is streaming has to stop the carve — otherwise "stop letting Claude
 * move this" would be a button that changes nothing until the next command,
 * which is the opposite of what someone reaching for it wants.
 */
export const machineArming = new ArmingGate({
  onDisarm: () => {
    if (webSerialManager.isRunning() || webSerialManager.isJobPaused()) {
      void webSerialManager.cancelJob();
    }
  },
});

/** What the UI banner watches. */
export function subscribeToArming(listener: (state: ArmingState) => void): () => void {
  return machineArming.subscribe(listener);
}

/**
 * The scene, as the bridge last saw it.
 *
 * The handlers are built once and live as long as the tab, while the scene is
 * store state that changes under them. The bridge points this at whatever it
 * is answering about, so a carve is always of the scene on screen.
 */
let currentScene: SceneGraph | null = null;

export function setCurrentScene(scene: SceneGraph | null): void {
  currentScene = scene;
}

/**
 * The stock outline, for a framing lap.
 *
 * Taken from the machining program rather than the scene's bounding box: the
 * stock is what is clamped to the bed, and it is bigger than the part by
 * whatever the exporter decided it needed.
 */
function jobBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!currentScene?.nodes?.length) return null;
  const result = generateSolidMachining(currentScene, DEFAULT_SOLID_OPTIONS);
  if (!result.success || !result.stock) return null;
  const { widthMm, depthMm } = result.stock as { widthMm: number; depthMm: number };
  if (!Number.isFinite(widthMm) || !Number.isFinite(depthMm)) return null;
  return { minX: 0, minY: 0, maxX: widthMm, maxY: depthMm };
}

/**
 * Carves the scene that is loaded.
 *
 * A solid is machined from more than one side, and the sides are separate
 * programs with the part re-fixtured between them — so this runs one side and
 * says which, rather than pretending a carve is a single button press. `side`
 * picks it; the default is the first.
 */
async function carveCurrentScene(args: Record<string, unknown>): Promise<{ summary: string }> {
  if (!currentScene?.nodes?.length) {
    throw new Error('The scene is empty — there is nothing to machine.');
  }

  const dia = typeof args.toolDiaMm === 'number' && args.toolDiaMm > 0 ? args.toolDiaMm : 3;
  const options = {
    ...DEFAULT_SOLID_OPTIONS,
    ...(typeof args.sides === 'number' ? { sides: args.sides } : {}),
    ...(typeof args.stockThicknessMm === 'number'
      ? { stockThicknessMm: args.stockThicknessMm }
      : {}),
    ...(typeof args.material === 'string' ? { material: args.material } : {}),
    roughingToolDiaMm: dia,
    finishingToolDiaMm: dia,
  } as NonNullable<Parameters<typeof generateSolidMachining>[1]>;

  const result = generateSolidMachining(currentScene, options);
  if (!result.success) {
    throw new Error(result.error || 'The machining program could not be generated.');
  }

  const wanted = typeof args.side === 'number' ? args.side : result.sides[0]?.side;
  const side = result.sides.find(s => s.side === wanted);
  if (!side?.gcode) {
    throw new Error(
      `This program has no side ${wanted}. It cuts ${result.sides.map(s => s.side).join(', ')}.`
    );
  }

  // Worth refusing rather than cutting: geometry the tool cannot reach comes
  // out as an unmachined lump, and the operator finds out three hours in.
  const unreachable = result.unreachablePercent ?? 0;
  if (unreachable > 5 && args.acceptUnreachable !== true) {
    throw new Error(
      `${unreachable.toFixed(1)}% of this part cannot be reached by a ${dia}mm tool, so it would ` +
        'come out with unmachined material on it. Use a smaller tool, cut from more sides, or ' +
        'pass acceptUnreachable: true if that is understood and wanted.'
    );
  }

  const state = webSerialManager.getState();
  if (!state.connected) throw new Error('No machine is connected. Connect one first.');

  const run = await webSerialManager.runJob(side.gcode, {
    name: `carve side ${side.side}`,
    estimatedSeconds: result.estimatedTimeSeconds,
    // An agent never opens a dialog, so this is the only place the run archive
    // can be told what the program it is about to stream actually cuts.
    settings: runSettings({
      material: MATERIALS.find(m => m.id === options.material)?.label ?? String(options.material),
      machine: 'cnc',
      stockThicknessMm: options.stockThicknessMm,
      tool: `${dia}mm end mill`,
      spindleRpm: options.spindleRpm,
      cutFeedrate: options.finishingFeedrate,
      depthMm: side.depthMm,
    }),
  });

  // `runJob` returns null when the browser is the streamer; the job is under
  // way either way, and the device path reports whether it was taken.
  if (run && !run.delivered) throw new Error(run.message);

  const minutes = Math.round((result.estimatedTimeSeconds ?? 0) / 60);
  return {
    summary:
      `Cutting side ${side.side} of ${result.sides.length} at depth ${side.depthMm}mm, ` +
      `${dia}mm tool, roughly ${minutes} minutes. ` +
      (result.sides.length > 1
        ? `The part has to be re-fixtured and side ${result.sides.find(s => s.side !== side.side)?.side} run separately.`
        : ''),
  };
}

/**
 * What a command's arguments are before anybody has looked at them.
 *
 * `unknown` rather than `any`: these arrive as JSON over the bridge, from an
 * agent that may be a different version of a different app, so every field is a
 * claim rather than a fact. The handlers below narrow what they read — a
 * `feedRate` that arrived as the string "50" should fall back to the default
 * rather than be handed to the machine.
 */
type McpArgs = Record<string, unknown>;

/** A number from an argument, or the fallback when it is anything else. */
function num<T extends number | undefined>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Mesh's full machine command set, keyed by the bridge command names. */
export function createMeshMachineHandlers(): Record<
  string,
  (args: McpArgs) => Promise<unknown>
> {
  // The manager satisfies MachineControl without extending GrblMachine — see
  // the note at the top of this file.
  const machine: MachineControl = webSerialManager;

  const shared = createMachineHandlers({
    machine,
    gate: machineArming,
    options: {
      runJob: carveCurrentScene,
      jobBounds,
      /*
       * This app's own framing, because on a laser the lap is traced with the
       * guide beam lit — that is the whole point of it, since the operator is
       * watching where the outline falls on the material.
       */
      frameJob: async (bounds, args) =>
        webSerialManager.frameJob(bounds, num(args.guidePower, undefined), {
          safeZMm: num(args.safeZMm, undefined),
        }),
      listDevices: async () => {
        const devices = await fetchMachineDevices();
        return devices.map(d => ({ id: d.deviceId, name: d.name, online: d.online }));
      },
    },
  });

  return {
    MACHINE_STATUS: shared.status,
    MACHINE_SETTINGS: shared.settings,
    MACHINE_LIST_DEVICES: shared.devices,
    MACHINE_ARM: shared.arm,
    MACHINE_DISARM: shared.disarm,
    MACHINE_CONNECT: shared.connect,
    MACHINE_DISCONNECT: shared.disconnect,
    MACHINE_JOG: shared.jog,
    MACHINE_HOME: shared.home,
    MACHINE_UNLOCK: shared.unlock,
    MACHINE_GOTO_ORIGIN: shared.goto_origin,
    MACHINE_ZERO_XY: shared.zero_xy,
    MACHINE_FRAME_JOB: shared.frame_job,
    MACHINE_TRIM: shared.trim,
    MACHINE_PAUSE: shared.pause,
    MACHINE_RESUME: shared.resume,
    MACHINE_CANCEL: shared.cancel,
    MACHINE_ESTOP: shared.estop,
    CARVE_SCENE: shared.run_job,

    /**
     * Sets work Z0, by probing a touch plate or by declaring where the tool is
     * standing.
     *
     * Mesh's own rather than a shared verb because the second of those has no
     * equivalent elsewhere: on a carve the operator often winds the tool down
     * onto the stock by eye, and `here` records that without a probe cycle.
     */
    MACHINE_ZERO_Z: async (args: McpArgs) => {
      machineArming.requireArmed('zero_z');

      if (args.here === true) {
        const offset = num(args.offsetMm, 0);
        machineArming.noteAgentCommand('zero_z', `here offset=${offset}`);
        const result = await webSerialManager.zeroZHere(offset);
        if (!result.success) throw new Error(result.message);
        return { ...describeMachine(machine, machineArming), message: result.message };
      }

      machineArming.noteAgentCommand('zero_z', `plate=${num(args.touchPlateMm, 12)}`);
      const result = await webSerialManager.zeroZ(
        num(args.touchPlateMm, 12),
        num(args.searchDepthMm, ZERO_SEARCH_MM),
        num(args.feedRate, 50)
      );
      if (!result.success) throw new Error(result.message);
      return {
        ...describeMachine(machine, machineArming),
        message: result.message,
        machineZ: result.machineZ,
      };
    },

    /** Sets X, Y and Z all at once, where the tool is standing. */
    MACHINE_ZERO_ALL: async () => {
      machineArming.requireArmed('zero_all');
      machineArming.noteAgentCommand('zero_all');
      await webSerialManager.zeroAllHere();
      await webSerialManager.refreshPosition();
      return describeMachine(machine, machineArming);
    },

    /**
     * Probes a grid across the stock, for levelling a carve against a bed or a
     * workpiece that is not flat.
     */
    MACHINE_PROBE_SURFACE: async (args: McpArgs) => {
      machineArming.requireArmed('probe_surface');
      machineArming.noteAgentCommand('probe_surface');

      const bounds =
        args.bounds && typeof args.bounds === 'object'
          ? (args.bounds as ReturnType<typeof jobBounds>)
          : jobBounds();
      if (!bounds) {
        throw new Error('There is nothing to probe: pass bounds, or load a scene first.');
      }

      const grid = await webSerialManager.probeGrid(
        bounds,
        num(args.cols, 3),
        num(args.rows, 3)
      );

      const zs = grid.points.flat().map(p => p.z);
      return {
        ok: true,
        cols: grid.gridX,
        rows: grid.gridY,
        spanMm: Math.max(...zs) - Math.min(...zs),
        points: grid.points,
      };
    },

    /**
     * Picks a job that ended badly back up, part way through.
     *
     * Mesh's own, and the reason this app's streaming did not move onto the
     * shared base: line eleven thousand of a program means nothing on its own,
     * so the program is replayed without being sent to work out the units,
     * coordinate system, feed, speed and depth that were established thousands
     * of lines earlier, and a short preamble puts the machine back into that
     * state before the cut resumes.
     */
    MACHINE_RESUME_FROM_LINE: async (args: McpArgs) => {
      machineArming.requireArmed('resume_from_line');
      const fromLine = Number(args.fromLine);
      if (!Number.isFinite(fromLine)) {
        throw new Error('Give fromLine: the program line to pick the job back up at.');
      }
      machineArming.noteAgentCommand('resume_from_line', `line=${fromLine}`);
      // Only finite numbers get through: these go straight into G-code, where a
      // string extraClearance concatenated into "G0 Z105" and a bad plungeFeed
      // became "FNaN", refused only after the spindle had been started.
      const raw = (args.options ?? {}) as Record<string, unknown>;
      const options: ResumeOptions = {
        plungeFeed: num(raw.plungeFeed, undefined),
        spindleWarmupSeconds: num(raw.spindleWarmupSeconds, undefined),
        extraClearance: num(raw.extraClearance, undefined),
      };
      const result = webSerialManager.resumeFromLine(fromLine, options);
      if (!result.ok) throw new Error(result.message);
      return { ...describeMachine(machine, machineArming), message: result.message };
    },

    /** What a resume would do, without doing it. Read-only, so never gated. */
    MACHINE_PREVIEW_RESUME: async (args: McpArgs) => {
      const fromLine = Number(args.fromLine);
      if (!Number.isFinite(fromLine)) {
        throw new Error('Give fromLine: the program line a resume would pick up at.');
      }
      const plan = webSerialManager.previewResume(fromLine, args.options as ResumeOptions | undefined);
      if (!plan) return { ok: false, error: 'No program has been sent this session.' };
      return {
        ok: true,
        fromLine: plan.fromLine,
        preamble: plan.preamble,
        uncertain: plan.state.uncertain,
        uncertainBecause: plan.state.uncertainBecause,
      };
    },
  };
}
