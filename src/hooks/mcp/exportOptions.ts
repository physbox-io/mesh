// ---------------------------------------------------------------------------
// The options an MCP relief or machining export is run with, read from the
// command and checked for parameters that have been retired
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { MATERIALS, type MaterialId } from '../../utils/feedsAndSpeeds';
import { deriveSolidOptions, type SolidMachiningOptions, type UpAxis } from '../../utils/solidMachiningExporter';
import {
  APP_RELIEF_DEFAULTS, DEFAULT_RELIEF_OPTIONS, deriveReliefFeeds, type ReliefCarveOptions,
} from '../../utils/reliefCarveExporter';
import { parseSetups } from '../../utils/orient';
import { lastReliefOptions } from '../../utils/lastReliefOptions';
import { webSerialManager } from '../../utils/webSerialManager';
import type { SceneGraph } from '../../types/scene';

const MATERIAL_IDS = new Set<string>(MATERIALS.map((m) => m.id));
const MATERIAL_LIST = MATERIALS.map((m) => m.id).join(', ');

function validateMaterial(v: unknown): MaterialId | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !MATERIAL_IDS.has(v)) {
    throw new Error(`Unknown material '${String(v)}'. Choose one of: ${MATERIAL_LIST}.`);
  }
  return v as MaterialId;
}

function requireFinitePos(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return v;
}

function requireFiniteNonNeg(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return v;
}

function requireEnum<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

function requireBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`${name} must be a boolean.`);
  }
  return v;
}

/**
 * A parameter the dialogs no longer offer, refused rather than ignored, so an
 * agent that still sends it hears what to do instead. `harmless` is the value
 * that asks for nothing: older servers send stockThicknessMm 0 on every call,
 * and 0 always meant "size it to the part".
 */
export function refuseRetired(msg: Record<string, unknown>, retired: Record<string, [string, unknown]>): void {
  for (const [key, [instead, harmless]] of Object.entries(retired)) {
    if (msg[key] !== undefined && msg[key] !== harmless) throw new Error(`${key} is no longer taken. ${instead}`);
  }
}

/** The stock is set once, for every export, as the status bar sets it. */
export const BOARD_INSTEAD =
  'The stock is the bench board, as in the dialogs: set it with physics_set_environment.';

export const RESIZE_INSTEAD =
  'Parts are cut at their modelled size, as in the dialog: resize the part in the scene (physics_update_object).';

/**
 * The relief job an MCP command plans: the dialog's last plan if there is one,
 * else the scene's and the bench's, with the command's own overrides on top.
 * Shared by EXPORT_RELIEF and ADD_SIMULATION, so a simulation is of the
 * program the export would hand over.
 */
export function reliefOptionsFor(msg: Record<string, unknown>): { options: ReliefCarveOptions; fromDialog: boolean } {
  refuseRetired(msg, {
    scalePercent: [RESIZE_INSTEAD, 100],
    stockWidthMm: [BOARD_INSTEAD, 0],
    stockDepthMm: [BOARD_INSTEAD, 0],
    stockThicknessMm: [BOARD_INSTEAD, 0],
  });
  const store = useStore.getState();
  const motion = webSerialManager.getState().motion;
  const dialog = lastReliefOptions();
  // The stock is the bench's, whatever the dialog last planned on.
  const bench = { stockWidthMm: store.stock.widthMm, stockDepthMm: store.stock.depthMm, stockThicknessMm: store.stock.thicknessMm };
  const base: ReliefCarveOptions = dialog
    ? { ...DEFAULT_RELIEF_OPTIONS, ...dialog, ...bench }
    : {
        ...DEFAULT_RELIEF_OPTIONS,
        ...APP_RELIEF_DEFAULTS,
        ...store.carveSettings,
        stockWidthMm: store.stock.widthMm,
        stockDepthMm: store.stock.depthMm,
        stockThicknessMm: store.stock.thicknessMm,
        material: store.material,
      };
  const roughingToolDiaMm = requireFinitePos(msg.roughingToolDiaMm, 'roughingToolDiaMm');
  const finishingToolDiaMm = requireFinitePos(msg.finishingToolDiaMm, 'finishingToolDiaMm');
  const shape = requireEnum(msg.finishingToolType, 'finishingToolType', ['flat', 'ball_nose', 'v_bit'] as const);
  const carveDepthMm = requireFinitePos(msg.carveDepthMm, 'carveDepthMm');
  const material = validateMaterial(msg.material);
  const roughingStrategy = requireEnum(msg.roughingStrategy, 'roughingStrategy', ['adaptive', 'raster'] as const);
  const roughingEnabled = requireBool(msg.roughingEnabled, 'roughingEnabled');
  const verticalScaleMode = requireEnum(msg.verticalScaleMode, 'verticalScaleMode', ['auto', 'model', 'fill', 'proportional'] as const);
  const verticalExaggeration = requireFinitePos(msg.verticalExaggeration, 'verticalExaggeration');
  const rawFitMode = requireEnum(msg.fitMode, 'fitMode', ['fit', 'actual', 'manual'] as const);
  const backgroundMode = requireEnum(msg.backgroundMode, 'backgroundMode', ['auto', 'carve', 'skip'] as const);
  requireEnum(msg.units, 'units', ['mm', 'in'] as const);

  const asked: Partial<ReliefCarveOptions> = {
    ...(roughingToolDiaMm !== undefined ? { roughingToolDiaMm } : {}),
    ...(finishingToolDiaMm !== undefined ? { finishingToolDiaMm } : {}),
    ...(shape !== undefined ? { finishingToolType: shape } : {}),
    ...(carveDepthMm !== undefined ? { carveDepthMm } : {}),
    ...(material !== undefined ? { material } : {}),
    ...(roughingStrategy !== undefined ? { roughingStrategy } : {}),
    ...(roughingEnabled !== undefined ? { roughingEnabled } : {}),
    ...(verticalScaleMode !== undefined ? { verticalScaleMode } : {}),
    ...(verticalExaggeration !== undefined ? { verticalExaggeration } : {}),
    // 'actual' is the dialog's Actual Size; 'manual' is its old name.
    ...(rawFitMode === 'fit' ? { fitMode: 'fit' as const } : {}),
    ...(rawFitMode === 'actual' || rawFitMode === 'manual' ? { fitMode: 'manual' as const } : {}),
    ...(backgroundMode !== undefined ? { backgroundMode } : {}),
  };
  const merged: ReliefCarveOptions = { ...base, ...asked, scalePercent: 100 };
  // The dialog's feeds stand, overrides and all, unless what they were
  // worked out for has been changed here.
  const rederive = !dialog || ['roughingToolDiaMm', 'finishingToolDiaMm', 'carveDepthMm', 'material']
    .some((k) => k in asked);
  const options: ReliefCarveOptions = {
    ...merged,
    ...(rederive
      ? deriveReliefFeeds(merged, motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y))
      : {}),
    motionProfile: motion,
    // The probed bed belongs to the dialog's session at the machine.
    meshLevelGrid: null,
    applyMeshLeveling: false,
  };
  return { options, fromDialog: !!dialog };
}

export { parseSetups };

/**
 * What a solid-machining job over MCP is planned with when the command does
 * not say: physics_export_machining's own defaults. The server sends those on
 * every export but none of them with physics_add_simulation, which left a
 * simulation of "the export" planning two sides in hardwood while the export
 * cut one in aluminium. Defaulting here, for both, keeps them one job.
 */
export const MCP_MACHINING_DEFAULTS = {
  sides: 1,
  material: 'aluminium',
  toolDiaMm: 3,
  finishingToolType: 'flat',
} as const;

const UP_AXES = ['+z', '-z', '+x', '-x', '+y', '-y'] as const;
const FINISHING_STRATEGIES = ['raster', 'waterline', 'hybrid', 'spiral', 'radial'] as const;

/** The solid-machining job an MCP command plans. Shared by EXPORT_MACHINING and ADD_SIMULATION. */
export function machiningOptionsFor(msg: Record<string, unknown>, scene: SceneGraph) {
  const boardInstead = BOARD_INSTEAD;
  refuseRetired(msg, {
    scalePercent: [RESIZE_INSTEAD, 100],
    stockWidthMm: [boardInstead, 0],
    stockDepthMm: [boardInstead, 0],
    stockThicknessMm: [boardInstead, 0],
  });
  const dia = requireFinitePos(msg.toolDiaMm, 'toolDiaMm') ?? MCP_MACHINING_DEFAULTS.toolDiaMm;
  const roughDia = requireFinitePos(msg.roughingToolDiaMm, 'roughingToolDiaMm') ?? dia;
  const finishDia = requireFinitePos(msg.finishingToolDiaMm, 'finishingToolDiaMm') ?? dia;
  let sides: 1 | 2 = MCP_MACHINING_DEFAULTS.sides;
  if (msg.sides !== undefined && msg.sides !== null) {
    if (msg.sides !== 1 && msg.sides !== 2) {
      throw new Error('sides must be 1 or 2.');
    }
    sides = msg.sides;
  }
  let setups: ReturnType<typeof parseSetups>;
  if (msg.setups !== undefined && msg.setups !== null) {
    setups = parseSetups(msg.setups);
    if (setups === undefined) {
      throw new Error("setups must be 'auto', 1, 2, or face names like '+z,+x,-x'.");
    }
  }
  const up = requireEnum(msg.up, 'up', UP_AXES);
  const autoOrient = requireBool(msg.autoOrient, 'autoOrient');
  let maxSetups: number | undefined;
  if (msg.maxSetups !== undefined && msg.maxSetups !== null) {
    if (typeof msg.maxSetups !== 'number' || !Number.isFinite(msg.maxSetups) || !Number.isInteger(msg.maxSetups) || msg.maxSetups < 1) {
      throw new Error('maxSetups must be a positive integer.');
    }
    maxSetups = msg.maxSetups;
  }
  const clearanceMm = requireFinitePos(msg.clearanceMm, 'clearanceMm');
  const toolStickoutMm = requireFinitePos(msg.toolStickoutMm, 'toolStickoutMm');
  const roughingEnabled = requireBool(msg.roughingEnabled, 'roughingEnabled');
  const finishingEnabled = requireBool(msg.finishingEnabled, 'finishingEnabled');
  const finishingStrategy = requireEnum(msg.finishingStrategy, 'finishingStrategy', FINISHING_STRATEGIES);
  const finishingVBitAngleDeg = requireFinitePos(msg.finishingVBitAngleDeg, 'finishingVBitAngleDeg');
  const tabCount = requireFiniteNonNeg(msg.tabCount, 'tabCount');
  const tabWidthMm = requireFinitePos(msg.tabWidthMm, 'tabWidthMm');
  const tabThicknessMm = requireFinitePos(msg.tabThicknessMm, 'tabThicknessMm');
  const registrationPins = requireBool(msg.registrationPins, 'registrationPins');
  const pinDiaMm = requireFinitePos(msg.pinDiaMm, 'pinDiaMm');
  const pinDepthMm = requireFinitePos(msg.pinDepthMm, 'pinDepthMm');
  const topSkinMm = requireFiniteNonNeg(msg.topSkinMm, 'topSkinMm');
  const throughCutMm = requireFiniteNonNeg(msg.throughCutMm, 'throughCutMm');
  const material = validateMaterial(msg.material) ?? MCP_MACHINING_DEFAULTS.material;
  const finishingToolType =
    requireEnum(msg.finishingToolType, 'finishingToolType', ['flat', 'ball_nose', 'v_bit'] as const)
    ?? MCP_MACHINING_DEFAULTS.finishingToolType;
  requireEnum(msg.units, 'units', ['mm', 'in'] as const);
  // Feeds, speeds and stepdowns worked out for the material and the
  // connected machine, as the dialog does; DEFAULT_SOLID_OPTIONS alone is
  // a wood recipe whatever material is named.
  const motion = webSerialManager.getState().motion;
  const options = deriveSolidOptions(scene, {
    scalePercent: 100,
    board: useStore.getState().stock,
    stockWidthMm: 0,
    stockDepthMm: 0,
    stockThicknessMm: 0,
    sides,
    ...(setups !== undefined ? { setups } : {}),
    ...(up !== undefined ? { up: up as UpAxis } : {}),
    ...(autoOrient !== undefined ? { autoOrient } : {}),
    ...(maxSetups !== undefined ? { maxSetups } : {}),
    ...(clearanceMm !== undefined ? { clearanceMm } : {}),
    ...(toolStickoutMm !== undefined ? { toolStickoutMm } : {}),
    ...(roughingEnabled !== undefined ? { roughingEnabled } : {}),
    ...(finishingEnabled !== undefined ? { finishingEnabled } : {}),
    ...(finishingStrategy !== undefined
      ? { finishingStrategy: finishingStrategy as SolidMachiningOptions['finishingStrategy'] }
      : {}),
    ...(finishingVBitAngleDeg !== undefined ? { finishingVBitAngleDeg } : {}),
    ...(tabCount !== undefined ? { tabCount } : {}),
    ...(tabWidthMm !== undefined ? { tabWidthMm } : {}),
    ...(tabThicknessMm !== undefined ? { tabThicknessMm } : {}),
    ...(registrationPins !== undefined ? { registrationPins } : {}),
    ...(pinDiaMm !== undefined ? { pinDiaMm } : {}),
    ...(pinDepthMm !== undefined ? { pinDepthMm } : {}),
    ...(topSkinMm !== undefined ? { topSkinMm } : {}),
    ...(throughCutMm !== undefined ? { throughCutMm } : {}),
    material,
    finishingToolType,
    roughingToolDiaMm: roughDia,
    finishingToolDiaMm: finishDia,
  } as Parameters<typeof deriveSolidOptions>[1], motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y));
  return options;
}
