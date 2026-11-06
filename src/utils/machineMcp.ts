import {
  ArmingGate,
  cancelAgentJobOnDisarm,
  createMachineHandlers,
  describeMachine,
  disarmWhenMachineStops,
  refuseWhileJobHoldsMachine,
  requireNumber,
  type ArmingState,
  type MachineControl,
} from '@physbox-io/machining';
import { webSerialManager, ZERO_SEARCH_MM } from './webSerialManager';
import type { ResumeOptions } from '@physbox-io/machining';
import { fetchMachineDevices } from './apiClient';
import { generateSolidMachining, measurePart, deriveSolidOptions, DEFAULT_SOLID_OPTIONS } from './solidMachiningExporter';
import { MATERIALS } from './feedsAndSpeeds';
import { runSettings } from './runSettings';
import { readTouchPlateMm } from './touchPlate';
import type { SceneGraph } from '../types/scene';

// ---------------------------------------------------------------------------
// Driving Mesh's machine from MCP
// ---------------------------------------------------------------------------
//
// The command set and the arming gate are shared with Volt and Etch. What is
// here is the part that is Mesh's: carving the scene that is loaded, and the
// zeroing and probing routines that are shaped by cutting a solid rather than
// a board.

/**
 * The gate. One per tab, because there is one machine.
 *
 * A person disarming stops the job the agent started, and only that: "stop
 * letting Claude move this" has to change something now, but it is no reason to
 * reset a job a person started. An e-stop, an alarm or a lost link closes it too.
 */
export const machineArming = new ArmingGate({
  onDisarm: reason => cancelAgentJobOnDisarm(webSerialManager, reason),
});
disarmWhenMachineStops(webSerialManager, machineArming);

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
/** The bench stock's thickness as the bridge last saw it, in mm. */
let benchThicknessMm: number | null = null;
/** What the last carve was asked for, so a framing lap frames that job. */
let lastCarveArgs: Record<string, unknown> = {};

export function setCurrentScene(scene: SceneGraph | null, stock?: { thicknessMm: number }): void {
  currentScene = scene;
  benchThicknessMm = stock?.thicknessMm ?? null;
}

/**
 * The options a carve is cut with: the defaults, what was asked, and the
 * bench stock's thickness when nothing was asked and the part fits in it —
 * the board described once on the bench, not re-guessed from the part. A part
 * taller than the bench stock falls back to stock sized from the part.
 */
export function carveOptions(args: Record<string, unknown>) {
  const dia = requireNumber(args, 'toolDiaMm', { default: 3, min: 0.01, max: MAX_TOOL_DIA_MM })!;
  const sides = requireNumber(args, 'sides', { min: 1, max: 2 });
  const askedThickness = requireNumber(args, 'stockThicknessMm', { min: 0.01, max: MAX_STOCK_THICKNESS_MM });
  let stockThicknessMm: number | undefined;
  let stockFrom: 'asked' | 'bench' | 'part' = 'part';
  if (askedThickness !== undefined) {
    stockThicknessMm = askedThickness;
    stockFrom = 'asked';
  } else if (benchThicknessMm && currentScene) {
    const part = measurePart(currentScene, '+z', 100);
    if (part && part.z <= benchThicknessMm + 1e-6) {
      stockThicknessMm = benchThicknessMm;
      stockFrom = 'bench';
    }
  }
  // Feeds, speeds and stepdowns worked out for the bit, the material and the
  // connected machine, as the export dialog does. Spreading
  // DEFAULT_SOLID_OPTIONS alone cut every carve with the defaults' wood recipe
  // — M3 S12000 at F1500 whatever bit or material was named — which is about
  // seven times the feed a 1 mm bit can take in aluminium.
  const motion = webSerialManager.getState().motion;
  const asked = {
    ...(sides !== undefined ? { sides } : {}),
    // Planned from any face; only setup 1 is ever run from here.
    ...(args.setups === 'auto' ? { setups: 'auto' as const } : {}),
    ...(stockThicknessMm !== undefined ? { stockThicknessMm } : {}),
    ...(typeof args.material === 'string' ? { material: args.material } : {}),
    roughingToolDiaMm: dia,
    finishingToolDiaMm: dia,
  } as Parameters<typeof deriveSolidOptions>[1];
  const options = currentScene
    ? deriveSolidOptions(currentScene, asked, motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y))
    : { ...DEFAULT_SOLID_OPTIONS, ...asked };
  return { options, dia, stockFrom };
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
  const result = generateSolidMachining(currentScene, carveOptions(lastCarveArgs).options);
  if (!result.success || !result.stock) return null;
  const { widthMm, depthMm } = result.stock as { widthMm: number; depthMm: number };
  if (!Number.isFinite(widthMm) || !Number.isFinite(depthMm)) return null;
  return { minX: 0, minY: 0, maxX: widthMm, maxY: depthMm };
}

/**
 * Which program a carve asked for: a planned job's setup number, or side A or B,
 * given as a letter or as 1 or 2. Agents send these as strings as often as not.
 */
export function pickCarveTarget<P extends { index: number }, S extends { side: 'A' | 'B' }>(
  args: Record<string, unknown>,
  planned: P[] | null,
  sides: S[]
): { wanted: number | 'A' | 'B' | undefined; side: P | S | undefined } {
  if (planned) {
    const wanted = requireNumber(args, 'setup', { default: 1, min: 1 })!;
    return { wanted, side: planned.find(s => s.index === wanted) };
  }
  if (args.side === undefined || args.side === null) return { wanted: sides[0]?.side, side: sides[0] };
  const asked = String(args.side).trim().toUpperCase();
  const wanted = asked === 'A' || asked === '1' ? 'A' : asked === 'B' || asked === '2' ? 'B' : null;
  if (!wanted) {
    throw new Error(`\`side\` has to be A, B, 1 or 2; got ${JSON.stringify(args.side)}. Nothing was sent to the machine.`);
  }
  return { wanted, side: sides.find(s => s.side === wanted) };
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

  lastCarveArgs = { ...args };
  const { options, dia, stockFrom } = carveOptions(args);

  const result = generateSolidMachining(currentScene, options);
  if (!result.success) {
    throw new Error(result.error || 'The machining program could not be generated.');
  }

  // A planned job is run by setup number; a one- or two-sided one by side, as before.
  const planned = result.plan && result.setups ? result.setups : null;
  const { wanted, side } = pickCarveTarget(args, planned, result.sides);
  if (!side?.gcode) {
    throw new Error(
      planned
        ? `This plan has no setup ${wanted}. It has ${planned.length}.`
        : `This program has no side ${wanted}. It cuts ${result.sides.map(s => s.side).join(', ')}.`
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
    name: planned ? `carve setup ${wanted}` : `carve side ${side.side}`,
    // Every setup after the first needs the block turned by hand, so the runner refuses it here.
    origin: 'mcp',
    machine: 'cnc',
    setup: {
      sequenceId: `mcp-solid-${result.sides[0].gcode.length}`,
      index: planned ? Number(wanted) : side.side === 'B' ? 2 : 1,
      of: planned ? planned.length : result.sides.length,
      locate: result.pins.length > 0 ? 'pins' : 'knownSpot',
    },
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

  // `runJob` returns null when the browser is the streamer; the device path
  // reports whether it was taken. But null is also a refusal (no Z zero, a job
  // already running), which used to be reported to the agent as a cut under
  // way - so a null with nothing streaming is the refusal, and says why.
  if (run && !run.delivered) throw new Error(run.message);
  // RUNNING rather than `isRunning`: the stream is still starting at this point.
  if (!run && webSerialManager.getState().status !== 'RUNNING') {
    throw new Error(webSerialManager.getState().lastError ?? 'The job did not start.');
  }

  const minutes = Math.round((result.estimatedTimeSeconds ?? 0) / 60);
  return {
    summary:
      `Cutting side ${side.side} of ${result.sides.length} at depth ${side.depthMm}mm, ` +
      `${dia}mm tool, roughly ${minutes} minutes, ` +
      (stockFrom === 'bench'
        ? `in the ${options.stockThicknessMm} mm bench stock. `
        : stockFrom === 'asked'
          ? `in ${options.stockThicknessMm} mm stock. `
          : `in stock sized from the part${benchThicknessMm ? ` (the ${benchThicknessMm} mm bench stock is thinner than it)` : ''}. `) +
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
 * claim rather than a fact. Numbers are read with the package's `requireNumber`,
 * so "0.1" is a tenth of a millimetre and "fast" is a refusal, not a default.
 */
type McpArgs = Record<string, unknown>;

/** Past any bit a hobby machine holds, and any thickness: only a typo gets here. */
const MAX_TOOL_DIA_MM = 100;
const MAX_STOCK_THICKNESS_MM = 2000;
/** A touch plate, in the range the panel's own field takes. */
const MAX_TOUCH_PLATE_MM = 100;
/** A machine that has not reported `$130`-`$132` gets this, not the benefit of the doubt. */
const UNKNOWN_TRAVEL_MM = 5000;
/** A hundred points a side is hours of probing: past that it is a typo. */
const MAX_PROBE_POINTS = 100;

/** The machine's own travel on each axis, as far as it has said. */
function travel() {
  const reported = webSerialManager.getState().motion.travel;
  return {
    x: reported?.x || UNKNOWN_TRAVEL_MM,
    y: reported?.y || UNKNOWN_TRAVEL_MM,
    z: reported?.z || UNKNOWN_TRAVEL_MM,
  };
}

/** The fastest this machine moves, when it has said; unbounded on an assumed profile. */
function maxFeed(): number | undefined {
  const { source, maxRate } = webSerialManager.getState().motion;
  return source === 'machine' ? Math.max(maxRate.x, maxRate.y, maxRate.z) : undefined;
}

/** A guide lap's arguments: what `frameJob` takes. */
function frameArgs(args: McpArgs) {
  return {
    guidePower: requireNumber(args, 'guidePower', { min: 0, max: 100 }),
    safeZMm: requireNumber(args, 'safeZMm', { min: 0, max: travel().z }),
  };
}

/** Bounds an agent gave for a probe grid, checked against the machine. */
function probeBounds(raw: Record<string, unknown>) {
  const reach = travel();
  const side = (name: string, max: number) => requireNumber(raw, name, { default: 0, min: -max, max })!;
  return {
    minX: side('minX', reach.x),
    minY: side('minY', reach.y),
    maxX: side('maxX', reach.x),
    maxY: side('maxY', reach.y),
  };
}

/** A resume's options, each one a checked number or left out. */
function resumeOptions(raw: unknown): ResumeOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  return {
    plungeFeed: requireNumber(options, 'plungeFeed', { min: 1, max: maxFeed() }),
    spindleWarmupSeconds: requireNumber(options, 'spindleWarmupSeconds', { min: 0, max: 600 }),
    extraClearance: requireNumber(options, 'extraClearance', { min: 0, max: travel().z }),
  };
}

/** Mesh's full machine command set, keyed by the bridge command names. */
export function createMeshMachineHandlers(): Record<
  string,
  (args: McpArgs) => Promise<unknown>
> {
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
      frameJob: async (bounds, args) => {
        const { guidePower, safeZMm } = frameArgs(args);
        return webSerialManager.frameJob(bounds, guidePower, {
          // The lap of a carve is a router's, whatever `$32` says.
          ...(args.bounds ? {} : { laserMode: false }),
          safeZMm,
        });
      },
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
    MACHINE_JOG: async (args: McpArgs) => {
      const reach = travel();
      for (const axis of ['x', 'y', 'z'] as const) {
        requireNumber(args, axis, { min: -reach[axis], max: reach[axis] });
      }
      requireNumber(args, 'feedRate', { max: maxFeed() });
      return shared.jog(args);
    },
    MACHINE_HOME: shared.home,
    MACHINE_UNLOCK: shared.unlock,
    MACHINE_GOTO_ORIGIN: async (args: McpArgs) => {
      machineArming.requireArmed('goto_origin');
      requireNumber(args, 'safeZMm', { min: 0, max: travel().z });
      const refusal = webSerialManager.unzeroedLiftRefusal('going to the origin');
      if (refusal) throw new Error(refusal);
      return shared.goto_origin(args);
    },
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
      refuseWhileJobHoldsMachine(machine, 'zero Z');

      if (args.here === true || args.here === 'true') {
        const offset = requireNumber(args, 'offsetMm', { default: 0, min: -travel().z, max: travel().z })!;
        machineArming.noteAgentCommand('zero_z', `here offset=${offset}`);
        const result = await webSerialManager.zeroZHere(offset);
        if (!result.success) throw new Error(result.message);
        return { ...describeMachine(machine, machineArming), message: result.message };
      }

      const plate = requireNumber(args, 'touchPlateMm', {
        default: readTouchPlateMm(),
        min: 0,
        max: MAX_TOUCH_PLATE_MM,
      })!;
      const search = requireNumber(args, 'searchDepthMm', { default: ZERO_SEARCH_MM, min: 0.1, max: travel().z })!;
      const feed = requireNumber(args, 'feedRate', { default: 50, min: 1, max: maxFeed() })!;
      machineArming.noteAgentCommand('zero_z', `plate=${plate}`);
      const result = await webSerialManager.zeroZ(plate, search, feed);
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
      refuseWhileJobHoldsMachine(machine, 'zero the axes');
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
      refuseWhileJobHoldsMachine(machine, 'probe the surface');
      machineArming.noteAgentCommand('probe_surface');

      const bounds =
        args.bounds && typeof args.bounds === 'object'
          ? probeBounds(args.bounds as Record<string, unknown>)
          : jobBounds();
      if (!bounds) {
        throw new Error('There is nothing to probe: pass bounds, or load a scene first.');
      }

      const grid = await webSerialManager.probeGrid(
        bounds,
        requireNumber(args, 'cols', { default: 3, min: 2, max: MAX_PROBE_POINTS })!,
        requireNumber(args, 'rows', { default: 3, min: 2, max: MAX_PROBE_POINTS })!
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
      refuseWhileJobHoldsMachine(machine, 'resume from a line');
      const fromLine = requireNumber(args, 'fromLine', { min: 0 });
      if (fromLine === undefined) {
        throw new Error('Give fromLine: the program line to pick the job back up at.');
      }
      machineArming.noteAgentCommand('resume_from_line', `line=${fromLine}`);
      // Only checked numbers get through: these go straight into G-code, where a
      // string extraClearance concatenated into "G0 Z105" and a bad plungeFeed
      // became "FNaN", refused only after the spindle had been started.
      const options = resumeOptions(args.options);
      webSerialManager.expectAgentJob();
      let result: { ok: boolean; message: string };
      try {
        result = webSerialManager.resumeFromLine(fromLine, options);
      } catch (err) {
        webSerialManager.expectAgentJob(false);
        throw err;
      }
      if (!result.ok) {
        webSerialManager.expectAgentJob(false);
        throw new Error(result.message);
      }
      return { ...describeMachine(machine, machineArming), message: result.message };
    },

    /** What a resume would do, without doing it. Read-only, so never gated. */
    MACHINE_PREVIEW_RESUME: async (args: McpArgs) => {
      const fromLine = requireNumber(args, 'fromLine', { min: 0 });
      if (fromLine === undefined) {
        throw new Error('Give fromLine: the program line a resume would pick up at.');
      }
      const plan = webSerialManager.previewResume(fromLine, resumeOptions(args.options));
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
