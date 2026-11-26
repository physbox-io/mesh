// Brickwork over MCP: the Brick dialog's count, and its bricks put in the scene.

import type { McpCommands } from './types';
import { useStore } from '../../store/useStore';
import { BRICK_STANDARDS, DEFAULT_BRICKWORK_OPTIONS, type BrickBond, type BrickStandardId } from '../../utils/brickwork';
import { layBricksOffThread } from '../../utils/brickworkClient';
import { normalToySize, TOY_SIZES, type ToyInventory, type ToySize } from '../../utils/toyBricks';
import { findNodeInScene } from './bridgeUtils';
import { settleScene } from './settleScene';

const BONDS: BrickBond[] = ['stretcher', 'english', 'flemish', 'stack'];
const PLACEMENTS = ['beside', 'replace', 'none'] as const;

export const brickCommands: McpCommands = {
  BUILD_BRICKWORK: async (msg, { store, toId }) => {
    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a string.' };
    }
    const rawBody = typeof msg.bodyId === 'string' && msg.bodyId ? msg.bodyId : null;
    const found = rawBody ? findNodeInScene(store.sceneGraph.nodes, resolveId(rawBody) as string) : null;
    if (rawBody && !found) return { ok: false, error: `No body '${rawBody}'.` };
    const bodyId = found ? found.id : null;
    if (msg.standardId !== undefined && (typeof msg.standardId !== 'string' || !Object.hasOwn(BRICK_STANDARDS, msg.standardId))) {
      return { ok: false, error: `standardId is one of ${Object.keys(BRICK_STANDARDS).join(', ')}.` };
    }
    if (msg.bond !== undefined && !BONDS.includes(msg.bond as BrickBond)) return { ok: false, error: `bond is one of ${BONDS.join(', ')}.` };
    if (msg.jointMm !== undefined && (typeof msg.jointMm !== 'number' || !Number.isFinite(msg.jointMm) || msg.jointMm <= 0)) {
      return { ok: false, error: 'jointMm must be a positive number (mortar joint width in mm).' };
    }
    if (msg.wastagePct !== undefined && (typeof msg.wastagePct !== 'number' || !Number.isFinite(msg.wastagePct) || msg.wastagePct < 0)) {
      return { ok: false, error: 'wastagePct must be a non-negative number (extra bricks percent, e.g. 5).' };
    }
    if (msg.placement !== undefined && !PLACEMENTS.includes(msg.placement as (typeof PLACEMENTS)[number])) {
      return { ok: false, error: `placement is one of ${PLACEMENTS.join(', ')}.` };
    }
    let toySizes: ToySize[] | undefined;
    if (msg.toySizes !== undefined) {
      if (!Array.isArray(msg.toySizes) || msg.toySizes.length === 0) {
        return { ok: false, error: `toySizes is a non-empty list of brick sizes (AxB, e.g. ${TOY_SIZES.join(', ')}).` };
      }
      toySizes = [];
      for (const t of msg.toySizes) {
        const size = typeof t === 'string' ? normalToySize(t) : null;
        if (!size) return { ok: false, error: `toySizes: '${String(t)}' is not a brick size (AxB, 1–32 studs).` };
        if (!toySizes.includes(size)) toySizes.push(size);
      }
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
        if (!size || (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))) return { ok: false, error: `toyInventory: '${k}' is not a size (AxB) with a count or null.` };
        toyInventory[size] = v as number | null;
      }
    }
    if (msg.hollowStuds !== undefined && (typeof msg.hollowStuds !== 'number' || !Number.isFinite(msg.hollowStuds) || msg.hollowStuds < 0)) {
      return { ok: false, error: 'hollowStuds is the wall thickness in studs for a hollow toy-brick build; 0 for solid.' };
    }
    const rawIncludeMortar = msg.includeMortar ?? msg.include_mortar ?? msg.mortar;
    if (rawIncludeMortar !== undefined && typeof rawIncludeMortar !== 'boolean') {
      return { ok: false, error: 'includeMortar (include_mortar) must be a boolean.' };
    }
    const placement = (msg.placement as (typeof PLACEMENTS)[number] | undefined) ?? 'beside';
    const saved = store.sceneGraph.brickwork;
    const standardId = (msg.standardId as BrickStandardId | undefined) ?? saved?.standardId ?? DEFAULT_BRICKWORK_OPTIONS.standardId;
    const sameStd = !saved?.standardId || standardId === saved.standardId;
    const brickwork = {
      standardId,
      bond: (msg.bond as BrickBond | undefined) ?? saved?.bond ?? DEFAULT_BRICKWORK_OPTIONS.bond,
      ...(typeof msg.jointMm === 'number' ? { jointMm: msg.jointMm } : sameStd && saved?.jointMm !== undefined ? { jointMm: saved.jointMm } : {}),
      wastagePct: typeof msg.wastagePct === 'number' ? msg.wastagePct : (saved?.wastagePct ?? DEFAULT_BRICKWORK_OPTIONS.wastagePct),
      ...(toySizes ? { toySizes } : !toyInventory && saved?.toySizes ? { toySizes: saved.toySizes } : {}),
      ...(toyInventory ? { toyInventory } : !toySizes && saved?.toyInventory ? { toyInventory: saved.toyInventory } : {}),
      ...(typeof msg.hollowStuds === 'number' ? { hollowStuds: Math.round(msg.hollowStuds) } : saved?.hollowStuds !== undefined ? { hollowStuds: saved.hollowStuds } : {}),
      ...(typeof rawIncludeMortar === 'boolean' ? { includeMortar: rawIncludeMortar } : saved?.includeMortar !== undefined ? { includeMortar: saved.includeMortar } : {}),
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
      const settled = await settleScene(outcome.nodes, { replacesScene: false, sceneFields: { brickwork } });
      if (!settled.ok) {
        return { ok: false, error: settled.error || 'Scene failed to compile after laying brickwork.' };
      }
      const latest = useStore.getState();
      if (placement === 'replace' && latest.selectedNodeId && !findNodeInScene(outcome.nodes, latest.selectedNodeId)) {
        latest.setSelectedNodeId(null);
      }
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
      closers: r.closers,
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
