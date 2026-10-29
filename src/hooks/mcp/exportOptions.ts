// ---------------------------------------------------------------------------
// The options an MCP relief or machining export is run with, read from the
// command and checked for parameters that have been retired
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { deriveSolidOptions, type SolidMachiningOptions } from '../../utils/solidMachiningExporter';
import {
  APP_RELIEF_DEFAULTS, DEFAULT_RELIEF_OPTIONS, deriveReliefFeeds, type ReliefCarveOptions,
} from '../../utils/reliefCarveExporter';
import { BLOCK_FACES, type BlockFace } from '../../utils/orient';
import { lastReliefOptions } from '../../utils/lastReliefOptions';
import { webSerialManager } from '../../utils/webSerialManager';
import type { SceneGraph } from '../../types/scene';

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

export const RESIZE_INSTEAD =
  'Parts are cut at their modelled size, as in the dialog: resize the part in the scene (physics_update_object).';

/**
 * The relief job an MCP command plans: the dialog's last plan if there is one,
 * else the scene's and the bench's, with the command's own overrides on top.
 * Shared by EXPORT_RELIEF and ADD_SIMULATION, so a simulation is of the
 * program the export would hand over.
 */
export function reliefOptionsFor(msg: Record<string, unknown>): { options: ReliefCarveOptions; fromDialog: boolean } {
  refuseRetired(msg, { scalePercent: [RESIZE_INSTEAD, 100] });
  const store = useStore.getState();
  const motion = webSerialManager.getState().motion;
  const dialog = lastReliefOptions();
  const base: ReliefCarveOptions = dialog
    ? { ...DEFAULT_RELIEF_OPTIONS, ...dialog }
    : {
        ...DEFAULT_RELIEF_OPTIONS,
        ...APP_RELIEF_DEFAULTS,
        ...store.carveSettings,
        stockWidthMm: store.stock.widthMm,
        stockDepthMm: store.stock.depthMm,
        stockThicknessMm: store.stock.thicknessMm,
        material: store.material,
      };
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  const shape = msg.finishingToolType === 'flat' || msg.finishingToolType === 'ball_nose' || msg.finishingToolType === 'v_bit'
    ? msg.finishingToolType
    : undefined;
  const asked: Partial<ReliefCarveOptions> = {
    ...(num(msg.roughingToolDiaMm) ? { roughingToolDiaMm: num(msg.roughingToolDiaMm) } : {}),
    ...(num(msg.finishingToolDiaMm) ? { finishingToolDiaMm: num(msg.finishingToolDiaMm) } : {}),
    ...(shape ? { finishingToolType: shape } : {}),
    ...(num(msg.carveDepthMm) ? { carveDepthMm: num(msg.carveDepthMm) } : {}),
    ...(typeof msg.material === 'string' ? { material: msg.material as ReliefCarveOptions['material'] } : {}),
    ...(msg.roughingStrategy === 'adaptive' || msg.roughingStrategy === 'raster' ? { roughingStrategy: msg.roughingStrategy } : {}),
    ...(typeof msg.roughingEnabled === 'boolean' ? { roughingEnabled: msg.roughingEnabled } : {}),
    ...(num(msg.stockWidthMm) ? { stockWidthMm: num(msg.stockWidthMm) } : {}),
    ...(num(msg.stockDepthMm) ? { stockDepthMm: num(msg.stockDepthMm) } : {}),
    ...(num(msg.stockThicknessMm) ? { stockThicknessMm: num(msg.stockThicknessMm) } : {}),
    ...(['auto', 'model', 'fill', 'proportional'].includes(msg.verticalScaleMode as string)
      ? { verticalScaleMode: msg.verticalScaleMode as ReliefCarveOptions['verticalScaleMode'] }
      : {}),
    ...(num(msg.verticalExaggeration) ? { verticalExaggeration: num(msg.verticalExaggeration) } : {}),
    // 'actual' is the dialog's Actual Size; 'manual' is its old name.
    ...(msg.fitMode === 'fit' ? { fitMode: 'fit' as const } : {}),
    ...(msg.fitMode === 'actual' || msg.fitMode === 'manual' ? { fitMode: 'manual' as const } : {}),
    ...(['auto', 'carve', 'skip'].includes(msg.backgroundMode as string)
      ? { backgroundMode: msg.backgroundMode as ReliefCarveOptions['backgroundMode'] }
      : {}),
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

/**
 * `setups` as an agent may send it: 'auto', 1 or 2, or the faces to cut from
 * as a list or a comma-separated string ('+z,+x,-x'), named as the block
 * stands for setup 1. Anything else is left out, which keeps `sides`.
 */
export function parseSetups(v: unknown): SolidMachiningOptions['setups'] | undefined {
  if (v === 'auto') return 'auto';
  if (v === 1 || v === '1') return 1;
  if (v === 2 || v === '2') return 2;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return undefined;
  const faces = list.map((f) => String(f).trim().toLowerCase()).filter((f): f is BlockFace => (BLOCK_FACES as string[]).includes(f));
  return faces.length > 0 ? faces : undefined;
}

/** The solid-machining job an MCP command plans. Shared by EXPORT_MACHINING and ADD_SIMULATION. */
export function machiningOptionsFor(msg: Record<string, unknown>, scene: SceneGraph) {
  const dia = typeof msg.toolDiaMm === 'number' && msg.toolDiaMm > 0 ? msg.toolDiaMm : 3;
  // Feeds, speeds and stepdowns worked out for the material and the
  // connected machine, as the dialog does; DEFAULT_SOLID_OPTIONS alone is
  // a wood recipe whatever material is named.
  const motion = webSerialManager.getState().motion;
  const boardInstead =
    'The stock is the bench board, as in the dialog: set it with physics_set_environment.';
  refuseRetired(msg, {
    scalePercent: [RESIZE_INSTEAD, 100],
    stockWidthMm: [boardInstead, 0],
    stockDepthMm: [boardInstead, 0],
    stockThicknessMm: [boardInstead, 0],
  });
  const setups = parseSetups(msg.setups);
  const options = deriveSolidOptions(scene, {
    scalePercent: 100,
    board: useStore.getState().stock,
    stockWidthMm: 0,
    stockDepthMm: 0,
    stockThicknessMm: 0,
    ...(typeof msg.sides === 'number' ? { sides: msg.sides } : {}),
    ...(setups !== undefined ? { setups } : {}),
    ...(typeof msg.clearanceMm === 'number' ? { clearanceMm: msg.clearanceMm } : {}),
    ...(typeof msg.toolStickoutMm === 'number' ? { toolStickoutMm: msg.toolStickoutMm } : {}),
    ...(typeof msg.material === 'string' ? { material: msg.material } : {}),
    ...(msg.finishingToolType === 'flat' || msg.finishingToolType === 'ball_nose' || msg.finishingToolType === 'v_bit'
      ? { finishingToolType: msg.finishingToolType }
      : {}),
    roughingToolDiaMm: dia,
    finishingToolDiaMm: dia,
  } as Parameters<typeof deriveSolidOptions>[1], motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y));
  return options;
}
