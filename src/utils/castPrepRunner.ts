/**
 * Runs "Prepare for casting" against the live store: the async half of
 * castPrep.ts. Finding a body's edges and compiling its roundings both go
 * through the OpenSCAD worker pool, so this cannot be one store action — it is
 * a short sequence of them, of which only the first takes an undo snapshot, so
 * the whole thing undoes in one step.
 *
 *   1. Switch any prep already on off, so a change of settings never stacks.
 *   2. beginCastPrep: snapshot every body's shape onto sceneGraph.castPrep.
 *   3. Edges: find each body's edges, plan the breaks, write them, compile.
 *      A body whose roundings will not compile goes back as it was.
 *   4. Draft (sand only): bake the taper into every body.
 *   5. finishCastPrep: fingerprint each body as prep left it.
 */
import { useStore } from '../store/useStore';
import { compileCsgNodes } from '../hooks/useCsgCompile';
import { generateCastPattern } from './castPatternExporter';
import { bodyEdges, bodyUp, whyNotRoundable } from './edgeRoundBase';
import { nodeWorldMatrix } from './combineBodies';
import {
  bodySolids,
  eachBody,
  edgeOnPlane,
  planEdgeRounds,
  shapeSignature,
  snapshotShape,
  whyNotPrepped,
} from './castPrep';
import type { CastPrep, EdgeRoundFeature, SceneGraph, SceneNode } from '../types/scene';

export interface CastPrepOptions {
  /** Sand draws the pattern, so it gets draft and keeps its parting face sharp; lost PLA gets edges only. */
  method: 'sand' | 'lost-pla';
  /** Degrees; ignored for lost PLA. 0 for no draft. */
  draftDeg: number;
  draftMode: 'add' | 'remove';
  /** Break the edges at all. */
  edges: boolean;
  /** Outside chamfer in mm (the inside fillet is half again), or 'auto' to size from each part. */
  edgeSizeMm: number | 'auto';
  /** The parting plane, as the Cast dialog takes it: mm above the part's base, or 'auto'. */
  partingFromBaseMm: number | 'auto';
}

export interface CastPrepReport {
  ok: boolean;
  error?: string;
  /** Bodies prep treated. One whose edges would not break is still drafted, and still counts. */
  treated: number;
  draftDeg: number;
  /** Largest breaks used, mm; null when edges were off. */
  edges: { chamferMm: number; filletMm: number } | null;
  sharpEdges: number;
  skipped: { name: string; reason: string }[];
}

function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/** The parting plane the Cast dialog would use, as a world height in metres. */
export function findPartingZ(scene: SceneGraph, partingFromBaseMm: number | 'auto'): number {
  // The pattern without its gating is all that is needed to choose a plane.
  const r = generateCastPattern({ ...scene, castPrep: undefined }, { method: 'sand', addGating: false, partingFromBaseMm });
  return r.summary.partingWorldZ;
}

const round2 = (m: number) => Math.round(m * 1e5) / 100;

export async function runCastPrep(opts: CastPrepOptions): Promise<CastPrepReport> {
  const store = () => useStore.getState();
  if (store().castPrepBusy) return { ok: false, error: 'Prepare for casting is already running.', treated: 0, draftDeg: 0, edges: null, sharpEdges: 0, skipped: [] };

  const sand = opts.method === 'sand';
  const draftDeg = sand ? Math.max(0, Math.min(15, opts.draftDeg)) : 0;
  store().setCastPrepBusy('Starting…');
  try {
    if (store().sceneGraph.castPrep) store().clearCastPrep();

    // --- Which bodies, and their originals -------------------------------
    const scene = store().sceneGraph;
    const originals: CastPrep['originals'] = {};
    const skipped: CastPrep['skipped'] = [];
    for (const { node, world } of eachBody(scene)) {
      const why = whyNotPrepped(node, world);
      if (why) {
        // A body with nothing solid (the ground) is not worth a line in the report.
        if (bodySolids(node, world).length > 0) skipped.push({ nodeId: node.id, name: node.name, reason: why });
        continue;
      }
      originals[node.id] = { shape: snapshotShape(node), signature: shapeSignature(node) };
    }
    const ids = Object.keys(originals);
    if (ids.length === 0) {
      return { ok: false, error: 'There is no solid part in the scene to prepare.', treated: 0, draftDeg: 0, edges: null, sharpEdges: 0, skipped: skipped.map(({ name, reason }) => ({ name, reason })) };
    }

    const partingZ = sand ? findPartingZ(scene, opts.partingFromBaseMm) : 0;
    store().beginCastPrep({ draftDeg: 0, draftMode: opts.draftMode, partingZ, edges: null, originals, skipped, sharpEdges: 0 });

    // --- Edges -----------------------------------------------------------
    let sharpEdges = 0, chamfer = 0, fillet = 0;
    if (opts.edges) {
      const features: Record<string, EdgeRoundFeature[]> = {};
      const failed: { id: string; reason: string }[] = [];
      const roundable = ids.filter((id) => whyNotRoundable(findNode(store().sceneGraph.nodes, id)) === null);
      for (let i = 0; i < roundable.length; i++) {
        const id = roundable[i];
        const nodes = store().sceneGraph.nodes;
        const node = findNode(nodes, id)!;
        store().setCastPrepBusy(`Finding edges · ${i + 1}/${roundable.length}`);
        try {
          const found = await bodyEdges(node, bodyUp(nodes, id));
          const world = nodeWorldMatrix(nodes, id);
          const plan = planEdgeRounds(
            found.edges,
            found.smallestDimension,
            opts.edgeSizeMm,
            node.edgeRounds ?? [],
            // The parting face is rammed flat on the board: a break there would
            // leave sand overhanging it.
            sand && world ? (e) => e.edge.convex && edgeOnPlane(e, world, partingZ) : undefined,
          );
          sharpEdges += plan.sharp;
          chamfer = Math.max(chamfer, plan.chamfer);
          fillet = Math.max(fillet, plan.fillet);
          if (plan.broken > 0) features[id] = plan.features;
        } catch (err) {
          failed.push({ id, reason: `Edges left sharp: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      if (Object.keys(features).length > 0) {
        store().setCastPrepBusy('Breaking edges…');
        store().writeCastPrepEdges(features);
        await compileCsgNodes(true);
        for (const id of Object.keys(features)) {
          const err = findNode(store().sceneGraph.nodes, id)?.csgError;
          if (err) failed.push({ id, reason: `Edges left sharp: ${err}` });
        }
      }
      store().revertCastPrepEdges(failed);
      if (failed.length > 0) await compileCsgNodes(true);
    }

    // --- Draft -----------------------------------------------------------
    if (draftDeg > 0) {
      store().setCastPrepBusy('Drafting walls…');
      store().bakeCastPrepDraft({ deg: draftDeg, mode: opts.draftMode, partingZ });
    }

    const edges = opts.edges ? { chamferMm: round2(chamfer), filletMm: round2(fillet) } : null;
    store().finishCastPrep({ edges, sharpEdges });
    await store().recompile(store().sceneGraph, undefined, false, true);

    const prep = store().sceneGraph.castPrep;
    return {
      ok: true,
      treated: ids.length,
      draftDeg,
      edges,
      sharpEdges,
      skipped: (prep?.skipped ?? []).map(({ name, reason }) => ({ name, reason })),
    };
  } catch (err) {
    // Half a prep is worse than none: take whatever landed back off.
    if (store().sceneGraph.castPrep) store().clearCastPrep();
    return { ok: false, error: err instanceof Error ? err.message : String(err), treated: 0, draftDeg: 0, edges: null, sharpEdges: 0, skipped: [] };
  } finally {
    store().setCastPrepBusy(null);
  }
}
