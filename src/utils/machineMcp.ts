import {
  ArmingGate,
  cancelAgentJobOnDisarm,
  createMachineHandlers,
  describeMachine,
  describeResumePreview,
  disarmWhenMachineStops,
  refuseWhileJobHoldsMachine,
  requireNumber,
  type ArmingState,
  type MachineControl,
} from '@physbox-io/machining';
import { webSerialManager, ZERO_SEARCH_MM } from './webSerialManager';
import type { ResumeOptions } from '@physbox-io/machining';
import { fetchMachineDevices } from './apiClient';
import {
  measurePart,
  deriveSolidOptions,
  DEFAULT_SOLID_OPTIONS,
  type SolidMachiningOptions,
  type SolidMachiningResult,
} from './solidMachiningExporter';
import { ExportWorkerClient } from './exportWorkerClient';
import { FACE_NAME, parseSetups } from './orient';
import { MATERIALS } from './feedsAndSpeeds';
import { runSettings } from './runSettings';
import { readTouchPlateMm } from '@physbox-io/ui/suite';
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
/** Full bench stock dimensions (`widthMm × depthMm × thicknessMm`) as the bridge last saw them. */
let benchStock: { widthMm: number; depthMm: number; thicknessMm: number } | null = null;
/** The bench stock's thickness as the bridge last saw it, in mm. */
let benchThicknessMm: number | null = null;
/** What the last carve was asked for, so a framing lap frames that job. */
let lastCarveArgs: Record<string, unknown> = {};

export function setCurrentScene(
  scene: SceneGraph | null,
  stock?: { widthMm?: number; depthMm?: number; thicknessMm: number }
): void {
  currentScene = scene;
  if (!scene) lastCarveArgs = {};
  benchThicknessMm = stock?.thicknessMm ?? null;
  benchStock =
    stock && typeof stock.widthMm === 'number' && stock.widthMm > 0 && typeof stock.depthMm === 'number' && stock.depthMm > 0
      ? { widthMm: stock.widthMm, depthMm: stock.depthMm, thicknessMm: stock.thicknessMm }
      : null;
}

/**
 * The options a carve is cut with: the defaults, what was asked, and the
 * bench stock (`board: benchStock`) when nothing was asked and the part fits
 * in it — matching `ExportSolidMachiningModal` and `physics_export_machining`
 * so the WCS part origin on the machine matches the preview and export.
 */
export function carveOptions(args: Record<string, unknown>) {
  const dia = requireNumber(args, 'toolDiaMm', { default: 3, min: 0.01, max: MAX_TOOL_DIA_MM })!;
  const roughDia = requireNumber(args, 'roughingToolDiaMm', { min: 0.01, max: MAX_TOOL_DIA_MM }) ?? dia;
  const finishDia = requireNumber(args, 'finishingToolDiaMm', { min: 0.01, max: MAX_TOOL_DIA_MM }) ?? dia;
  const sides = requireNumber(args, 'sides', { min: 1, max: 2 });
  const askedThickness = requireNumber(args, 'stockThicknessMm', { min: 0.01, max: MAX_STOCK_THICKNESS_MM });
  const clearanceMm = requireNumber(args, 'clearanceMm', { min: 0, max: UNKNOWN_TRAVEL_MM });
  const toolStickoutMm = requireNumber(args, 'toolStickoutMm', { min: 0, max: 500 });
  const setups = parseSetups(args.setups);
  let stockThicknessMm: number | undefined;
  let board: { widthMm: number; depthMm: number; thicknessMm: number } | undefined;
  let stockFrom: 'asked' | 'bench' | 'part' = 'part';
  if (askedThickness !== undefined) {
    stockThicknessMm = askedThickness;
    if (benchStock) board = { ...benchStock, thicknessMm: askedThickness };
    stockFrom = 'asked';
  } else if (benchStock && currentScene) {
    board = benchStock;
    const part = measurePart(currentScene, '+z', 100);
    stockFrom = part && part.z <= benchStock.thicknessMm + 1e-6 ? 'bench' : 'part';
  } else if (benchThicknessMm && currentScene) {
    const part = measurePart(currentScene, '+z', 100);
    if (part && part.z <= benchThicknessMm + 1e-6) {
      stockThicknessMm = benchThicknessMm;
      stockFrom = 'bench';
    }
  }
  const motion = webSerialManager.getState().motion;
  const asked = {
    ...(sides !== undefined ? { sides } : {}),
    ...(setups !== undefined ? { setups } : {}),
    ...(board !== undefined ? { board, stockWidthMm: 0, stockDepthMm: 0, stockThicknessMm: 0 } : {}),
    ...(stockThicknessMm !== undefined ? { stockThicknessMm } : {}),
    ...(clearanceMm !== undefined ? { clearanceMm } : {}),
    ...(toolStickoutMm !== undefined ? { toolStickoutMm } : {}),
    ...(typeof args.material === 'string' ? { material: args.material } : {}),
    ...(args.finishingToolType === 'flat' || args.finishingToolType === 'ball_nose' || args.finishingToolType === 'v_bit'
      ? { finishingToolType: args.finishingToolType }
      : {}),
    roughingToolDiaMm: roughDia,
    finishingToolDiaMm: finishDia,
  } as Parameters<typeof deriveSolidOptions>[1];
  const options = currentScene
    ? deriveSolidOptions(currentScene, asked, motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y))
    : { ...DEFAULT_SOLID_OPTIONS, ...asked };
  return { options, dia: finishDia, stockFrom };
}

/**
 * A carve's program, planned on the export worker as the export tools plan
 * it: a solid's plan takes up to half a minute, and on the page it froze the
 * tab for all of it.
 */
async function planCarve(scene: SceneGraph, options: SolidMachiningOptions): Promise<SolidMachiningResult> {
  const client = new ExportWorkerClient();
  try {
    return await client.run('solid', scene, options);
  } finally {
    client.dispose();
  }
}

/**
 * The stock outline, for a framing lap.
 *
 * Taken from the machining program rather than the scene's bounding box: the
 * stock is what is clamped to the bed, and it is bigger than the part by
 * whatever the exporter decided it needed.
 */
export async function jobBounds(): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | null> {
  if (!currentScene?.nodes?.length) return null;
  const result = await planCarve(currentScene, carveOptions(lastCarveArgs).options);
  if (!result.success || !result.stock) return null;
  const planned = (result.plan || lastCarveArgs.setups !== undefined) && result.setups ? result.setups : null;
  const { side } = pickCarveTarget(lastCarveArgs, planned, result.sides);
  const targetStock = (planned && side && 'stock' in side ? side.stock : result.stock) as {
    widthMm: number;
    depthMm: number;
  };
  const { widthMm, depthMm } = targetStock;
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
  const scene = currentScene;
  if (!scene?.nodes?.length) {
    throw new Error('The scene is empty — there is nothing to machine.');
  }

  // The machine is asked first and the plan made after: refused, a carve
  // plans nothing. And asked again once the plan is back, for whatever
  // started while it was being made.
  const refuseBusy = () => {
    if (!webSerialManager.getState().connected) throw new Error('No machine is connected. Connect one first.');
    if (webSerialManager.isRunning() || webSerialManager.isJobPaused()) {
      throw new Error('A job is already running or paused. Cancel it before starting another.');
    }
  };
  refuseBusy();

  lastCarveArgs = { ...args };
  const { options, dia, stockFrom } = carveOptions(args);

  const result = await planCarve(scene, options);
  refuseBusy();
  if (!result.success) {
    throw new Error(result.error || 'The machining program could not be generated.');
  }

  // A planned job (or any job with explicit `setups`) is run by setup number;
  // a legacy one- or two-sided job by side, as before.
  const planned = (result.plan || args.setups !== undefined) && result.setups ? result.setups : null;
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

  const locate = 'locate' in side
    ? side.locate
    : result.pins.length > 0 && side.side === 'B'
      ? 'pins'
      : 'knownSpot';
  const setupSeconds = side.estimatedTimeSeconds ?? result.estimatedTimeSeconds;
  const resolvedThicknessMm = result.stock.thicknessMm;

  // The run handler said the next stream is the agent's, for a few seconds;
  // a big part's plan takes longer than that, and the job then started as a
  // person's, which a disarm does not stop.
  webSerialManager.expectAgentJob();
  const run = await webSerialManager.runJob(side.gcode, {
    name: planned ? `carve setup ${wanted}` : `carve side ${side.side}`,
    // Every setup after the first needs the block turned by hand, so the runner refuses it here.
    origin: 'mcp',
    machine: 'cnc',
    setup: {
      sequenceId: `mcp-solid-${(planned?.[0]?.gcode ?? result.sides[0]?.gcode ?? side.gcode).length}`,
      index: planned ? Number(wanted) : side.side === 'B' ? 2 : 1,
      of: planned ? planned.length : result.sides.length,
      locate,
    },
    estimatedSeconds: setupSeconds,
    // An agent never opens a dialog, so this is the only place the run archive
    // can be told what the program it is about to stream actually cuts.
    settings: runSettings({
      material: MATERIALS.find(m => m.id === options.material)?.label ?? String(options.material),
      machine: 'cnc',
      stockThicknessMm: resolvedThicknessMm,
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

  const minutes = Math.round((setupSeconds ?? 0) / 60);
  const headLabel =
    planned && 'upFace' in side
      ? `Cutting setup ${side.index} of ${side.of} (${FACE_NAME[side.upFace]} up)`
      : `Cutting side ${side.side} of ${result.sides.length}`;
  const remainingNote = planned
    ? planned.length > 1
      ? `The block has to be re-fixtured for the remaining ${planned.length - 1} setup${planned.length === 2 ? '' : 's'}.`
      : ''
    : result.sides.length > 1
      ? `The part has to be re-fixtured and side ${result.sides.find(s => s.side !== side.side)?.side} run separately.`
      : '';
  return {
    summary:
      `${headLabel} at depth ${side.depthMm}mm, ` +
      `${dia}mm tool, roughly ${minutes} minutes, ` +
      (stockFrom === 'bench'
        ? `in the ${resolvedThicknessMm} mm bench stock. `
        : stockFrom === 'asked'
          ? `in ${resolvedThicknessMm} mm stock. `
          : `in stock sized from the part${benchThicknessMm ? ` (the ${benchThicknessMm} mm bench stock is thinner than it)` : ''}. `) +
      remainingNote,
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
      /*
       * This app's own framing, because on a laser the lap is traced with the
       * guide beam lit — that is the whole point of it, since the operator is
       * watching where the outline falls on the material.
       */
      frameJob: async (bounds, args) => {
        const { guidePower, safeZMm } = frameArgs(args);
        return webSerialManager.frameJob(bounds, guidePower, {
          // The lap of a carve is a router's, whatever `$32` says.
          ...(args.bounds && !args.carveStock ? {} : { laserMode: false }),
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
    MACHINE_FRAME_JOB: async (args: McpArgs) => {
      if (args.bounds && typeof args.bounds === 'object') return shared.frame_job(args);
      // Round the carve's stock, which takes planning the carve: on the
      // worker, and only once the lap would not be refused anyway.
      machineArming.requireArmed('frame_job');
      if (!webSerialManager.getState().connected) throw new Error('No machine is connected. Connect one first.');
      refuseWhileJobHoldsMachine(machine, 'frame the job');
      const bounds = await jobBounds();
      return shared.frame_job(bounds ? { ...args, bounds, carveStock: true } : args);
    },
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
          : await jobBounds();
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
      // The same shape as Etch's and Volt's.
      return describeResumePreview(plan && { ...plan, totalLines: webSerialManager.getState().totalLines });
    },
  };
}
