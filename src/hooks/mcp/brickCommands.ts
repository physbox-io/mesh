// Brickwork over MCP: the Brick dialog's count, and its bricks put in the scene.

import type { McpCommands } from './types';
import { BRICK_STANDARDS, DEFAULT_BRICKWORK_OPTIONS, type BrickBond, type BrickStandardId } from '../../utils/brickwork';
import { layBricksOffThread } from '../../utils/brickworkClient';
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
    const placement = msg.placement === 'replace' ? 'replace' : msg.placement === 'none' ? 'none' : 'beside';
    let outcome;
    try {
      outcome = await layBricksOffThread(store.sceneGraph, bodyId, {
        standardId: (msg.standardId as BrickStandardId | undefined) ?? DEFAULT_BRICKWORK_OPTIONS.standardId,
        bond: (msg.bond as BrickBond | undefined) ?? DEFAULT_BRICKWORK_OPTIONS.bond,
        jointMm: typeof msg.jointMm === 'number' ? msg.jointMm : undefined,
        wastagePct: typeof msg.wastagePct === 'number' ? msg.wastagePct : DEFAULT_BRICKWORK_OPTIONS.wastagePct,
        placement: placement === 'none' ? 'beside' : placement,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const r = outcome.result;
    if (placement !== 'none') {
      store.prepareForDiscreteChange();
      await settleScene(outcome.nodes, { replacesScene: false });
    }
    return {
      ok: true,
      laid: placement !== 'none',
      brick: r.standard.label,
      bond: r.bond,
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
      warnings: r.warnings,
    };
  },
};
