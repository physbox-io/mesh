// Brickwork over MCP: the Brick dialog's count, and its bricks put in the scene.

import type { McpCommands } from './types';
import { BRICK_STANDARDS, DEFAULT_BRICKWORK_OPTIONS, type BrickBond, type BrickStandardId } from '../../utils/brickwork';
import { layBricksOffThread } from '../../utils/brickworkClient';
import { normalToySize, TOY_SIZES, type ToyInventory, type ToySize } from '../../utils/toyBricks';
import { findNodeInScene } from './bridgeUtils';
import { settleScene } from './settleScene';

const BONDS: BrickBond[] = ['stretcher', 'english', 'flemish', 'stack'];

export const brickCommands: McpCommands = {
  BUILD_BRICKWORK: async (msg, { store }) => {
    const bodyId = typeof msg.bodyId === 'string' && msg.bodyId ? msg.bodyId : null;
    if (bodyId && !findNodeInScene(store.sceneGraph.nodes, bodyId)) return { ok: false, error: `No body '${bodyId}'.` };
    if (msg.standardId !== undefined && !(String(msg.standardId) in BRICK_STANDARDS)) {
      return { ok: false, error: `standardId is one of ${Object.keys(BRICK_STANDARDS).join(', ')}.` };
    }
    if (msg.bond !== undefined && !BONDS.includes(msg.bond as BrickBond)) return { ok: false, error: `bond is one of ${BONDS.join(', ')}.` };
    const toySizes = msg.toySizes;
    if (toySizes !== undefined && (!Array.isArray(toySizes) || toySizes.some((t) => !(TOY_SIZES as readonly string[]).includes(t as string)))) {
      return { ok: false, error: `toySizes is a list of ${TOY_SIZES.join(', ')}.` };
    }
    // How many of each toy brick the builder has: { '2x4': 40, '2x2': null }.
    let toyInventory: ToyInventory | undefined;
    if (msg.toyInventory !== undefined) {
      if (typeof msg.toyInventory !== 'object' || msg.toyInventory === null || Array.isArray(msg.toyInventory)) {
        return { ok: false, error: "toyInventory is a map of size to how many you have, e.g. { '2x4': 40, '2x2': null } (null: any number)." };
      }
      toyInventory = {};
      for (const [k, v] of Object.entries(msg.toyInventory as Record<string, unknown>)) {
        const size = normalToySize(k);
        if (!size || (v !== null && (typeof v !== 'number' || v < 0))) return { ok: false, error: `toyInventory: '${k}' is not a size (AxB) with a count or null.` };
        toyInventory[size] = v as number | null;
      }
    }
    if (msg.hollowStuds !== undefined && (typeof msg.hollowStuds !== 'number' || msg.hollowStuds < 0)) {
      return { ok: false, error: 'hollowStuds is the wall thickness in studs for a hollow toy-brick build; 0 for solid.' };
    }
    const placement = msg.placement === 'replace' ? 'replace' : msg.placement === 'none' ? 'none' : 'beside';
    const saved = store.sceneGraph.brickwork;
    const brickwork = {
      standardId: (msg.standardId as BrickStandardId | undefined) ?? saved?.standardId ?? DEFAULT_BRICKWORK_OPTIONS.standardId,
      bond: (msg.bond as BrickBond | undefined) ?? saved?.bond ?? DEFAULT_BRICKWORK_OPTIONS.bond,
      ...(typeof msg.jointMm === 'number' ? { jointMm: msg.jointMm } : saved?.jointMm !== undefined ? { jointMm: saved.jointMm } : {}),
      wastagePct: typeof msg.wastagePct === 'number' ? msg.wastagePct : (saved?.wastagePct ?? DEFAULT_BRICKWORK_OPTIONS.wastagePct),
      ...(toySizes ? { toySizes: toySizes as ToySize[] } : saved?.toySizes ? { toySizes: saved.toySizes } : {}),
      ...(toyInventory ? { toyInventory } : saved?.toyInventory ? { toyInventory: saved.toyInventory } : {}),
      ...(typeof msg.hollowStuds === 'number' ? { hollowStuds: Math.round(msg.hollowStuds) } : saved?.hollowStuds !== undefined ? { hollowStuds: saved.hollowStuds } : {}),
    };
    let outcome;
    try {
      outcome = await layBricksOffThread(store.sceneGraph, bodyId, {
        ...brickwork,
        placement: placement === 'none' ? 'beside' : placement,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const r = outcome.result;
    if (placement !== 'none') {
      store.prepareForDiscreteChange();
      store.updateScene({ ...store.sceneGraph, brickwork }, true);
      await settleScene(outcome.nodes, { replacesScene: false });
    }
    return {
      ok: true,
      laid: placement !== 'none',
      brick: r.standard.label,
      bondType: r.bondType,
      jointMm: r.jointMm,
      courses: r.courses,
      builtHeightMm: Math.round(r.builtHeightMm),
      modelHeightMm: Math.round(r.modelHeightMm),
      bricksLaid: r.bricks.length,
      whole: r.whole,
      cutPieces: r.cutPieces,
      toBuy: r.toBuy,
      cuts: r.cuts,
      mortarLitres: Math.round(r.mortarLitres),
      mortarBags25kg: r.mortarBags,
      lintels: r.lintels,
      ...(r.parts ? { parts: r.parts } : {}),
      ...(r.short?.length ? { short: r.short } : {}),
      bond: r.bond,
      warnings: r.warnings,
    };
  },
};
