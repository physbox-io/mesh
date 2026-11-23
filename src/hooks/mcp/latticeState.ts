// ---------------------------------------------------------------------------
// The MCP lattice commands' own state: the agent's undo history of cages, and
// running a list of lattice operations on one
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, bridgeFacesMm, dimensionSelectionMm, extrudeMm,
  insetFaceMm, MAX_RING_SIDES, removeFacesMm, revolveMm, sharpenEdgesMm,
} from '../../utils/latticeCommands';
import type { SceneNode } from '../../types/scene';
import {
  deserializeCage, orientFaces, restoreLattice, serializeCage, type Axis as LatticeAxis, type Lattice,
} from '../../utils/latticeMesh';
import { fuseFlushFaces, unionOverlappingPieces } from '../../utils/latticeSketch';
import { findNodeInScene } from './bridgeUtils';

/**
 * The last few cages of each lattice body, so an operation can be taken back off.
 *
 * Whole snapshots rather than inverse operations, as everywhere else this mode
 * keeps history: a cage is a few hundred integers, and a snapshot cannot get an
 * inverse subtly wrong. Separate from the editor's own history, so undoing over
 * MCP never swallows a person's work.
 */
export const latticeHistory = new Map<string, Lattice[]>();

export const LATTICE_HISTORY_DEPTH = 8;

/** Validates an axis ('x' | 'y' | 'z', case-insensitive). Rejects anything else. */
export function parseAxis(v: unknown, field = 'axis', required = false): LatticeAxis | undefined {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${field} must be 'x', 'y' or 'z'`);
    return undefined;
  }
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    if (lower === 'x' || lower === 'y' || lower === 'z') return lower;
  }
  throw new Error(`${field} must be 'x', 'y' or 'z'`);
}

/** Validates a bevel mode ('chamfer' | 'fillet' | 'round', mapping 'round' -> 'fillet'). */
export function parseBevelMode(v: unknown): 'chamfer' | 'fillet' {
  if (v === undefined || v === null) return 'chamfer';
  if (v === 'chamfer') return 'chamfer';
  if (v === 'fillet' || v === 'round') return 'fillet';
  throw new Error("mode must be 'chamfer', 'fillet' or 'round'");
}

/** Validates smoothing subdivision level (0, 1, or 2). */
export function parseSubdiv(v: unknown, field = 'level'): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 2) {
    throw new Error(`${field} must be a finite number between 0 and 2`);
  }
  return Math.round(v);
}

/** Validates a non-negative wall thickness in millimetres. */
export function parseThicknessMm(v: unknown, field = 'thicknessMm'): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`${field} must be a non-negative finite number of millimetres`);
  }
  return v;
}

/** Validates sides / segments count: 0 (auto) or integer in [3, 256]. */
export function parseRingCount(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || (v !== 0 && (v < 3 || v > MAX_RING_SIDES))) {
    throw new Error(`${field} must be 0 (auto) or an integer from 3 to ${MAX_RING_SIDES}`);
  }
  return v;
}

/** The editable cage on a node, or a refusal that says what to do instead. */
export function latticeOf(node: SceneNode | null | undefined): Lattice {
  if (!node?.latticeCage) {
    throw new Error(`'${node?.id}' has no lattice cage`);
  }
  return deserializeCage(node.latticeCage);
}

/** Resolves an id to a lattice body and its cage, or explains why it is not one. */
export function latticeTarget(store: ReturnType<typeof useStore.getState>, targetId: string): { node: SceneNode; lattice: Lattice } {
  if (!targetId) throw new Error('Missing targetId');
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  if (!node.isLattice || !node.latticeCage) {
    throw new Error(`'${targetId}' is not a lattice body — make one with physics_create_lattice. There is no conversion: the cage is the document, and a primitive, an imported mesh or a sculpt does not have one.`);
  }
  return { node, lattice: deserializeCage(node.latticeCage) };
}

export function pushLatticeHistory(targetId: string, snapshot: Lattice) {
  const stack = latticeHistory.get(targetId) ?? [];
  stack.push(snapshot);
  while (stack.length > LATTICE_HISTORY_DEPTH) stack.shift();
  latticeHistory.set(targetId, stack);
}

/**
 * Writes a cage back and rebuilds the body from it.
 *
 * The version bump comes first and separately: the editor holds its own live
 * copy of the cage while it is open, and only a change of version tells it to
 * load this one rather than carry on with what it has — the same signal
 * setSculptBase sends when it swaps a mesh out.
 */
export function commitLattice(node: SceneNode, lattice: Lattice) {
  fuseTouchingParts(lattice);
  const store = useStore.getState();
  store.recordInteraction('lattice');
  store.updateNode(node.id, { latticeVersion: (node.latticeVersion ?? 1) + 1 }, true);
  store.applyLattice(node.id, serializeCage(lattice), node.latticeSubdiv ?? 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LatticeOpSpec extends Record<string, any> {
  op?: string;
  type?: string;
  kind?: string;
}

/**
 * What the editor does on every commit, for the agent's edits too: faces lying
 * flat against each other facing opposite ways are fused, and closed pieces
 * whose volumes overlap are united (utils/latticeSketch.ts). Without it six
 * boxes drawn flush over MCP stayed six touching boxes: not watertight, and
 * weighed by their hull, 28.5 kg for a 9.7 kg chair. Returns whether it changed
 * anything.
 */
export function fuseTouchingParts(lattice: Lattice): boolean {
  let changed = fuseFlushFaces(lattice) > 0;
  const united = unionOverlappingPieces(lattice);
  if (united) {
    restoreLattice(lattice, united);
    changed = true;
  }
  return changed;
}

export function runLatticeOps(
  lattice: Lattice,
  ops: LatticeOpSpec[],
  initialSubdiv = 0,
  initialThicknessMm = 0,
  { fuse = true }: { fuse?: boolean } = {},
): { subdiv: number; thicknessMm: number; results: Record<string, unknown>[] } {
  let subdiv = parseSubdiv(initialSubdiv, 'subdiv');
  let thicknessMm = parseThicknessMm(initialThicknessMm, 'thicknessMm');
  if (ops !== undefined && !Array.isArray(ops)) {
    throw new Error('ops must be an array of lattice operations');
  }
  const finiteNum = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${field} must be a finite number`);
    }
    return v;
  };
  const results: Record<string, unknown>[] = [];
  for (const item of ops || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each entry in ops must be an object');
    }
    const opName = String(item.op ?? item.type ?? item.kind ?? '').toLowerCase();
    switch (opName) {
      case 'extrude': {
        const d = finiteNum(item.distanceMm ?? item.amountMm ?? 10, 'distanceMm');
        const ax = parseAxis(item.axis, 'axis', false);
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'extrude', ...extrudeMm(lattice, item.face, d, ax, mir) });
        break;
      }
      case 'inset': {
        const amt = finiteNum(item.amountMm ?? item.distanceMm ?? 5, 'amountMm');
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'inset', ...insetFaceMm(lattice, item.face, amt, mir) });
        break;
      }
      case 'bevel': {
        const amt = finiteNum(item.amountMm ?? item.distanceMm ?? 5, 'amountMm');
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'bevel', ...bevelFaceMm(lattice, item.face, amt, mir) });
        break;
      }
      case 'bevel_edges':
      case 'beveledges': {
        const rad = finiteNum(item.radiusMm ?? item.amountMm ?? item.sizeMm ?? 3, 'radiusMm');
        const mode = parseBevelMode(item.mode);
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'bevel_edges', ...bevelEdgesMm(lattice, item.edges, rad, mode, mir, item.loop === true) });
        break;
      }
      case 'faces':
      case 'add_faces':
      case 'addfaces': {
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'faces', ...addFacesMm(lattice, item.faces, mir) });
        break;
      }
      case 'delete_faces':
      case 'deletefaces':
      case 'remove_faces': {
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'delete_faces', ...removeFacesMm(lattice, item.faces, mir) });
        break;
      }
      case 'sharpen': {
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({ op: 'sharpen', ...sharpenEdgesMm(lattice, item.edges, item.sharp !== false, mir, item.loop === true) });
        break;
      }
      case 'circle':
      case 'ring': {
        const dia = finiteNum(item.diameterMm ?? 10, 'diameterMm');
        const ax = parseAxis(item.axis, 'axis', false) ?? 'z';
        const sides = parseRingCount(item.sides, 'sides');
        const mir = parseAxis(item.mirror, 'mirror', false);
        results.push({
          op: 'circle',
          ...addRingMm(lattice, item.centre ?? item.center, dia, ax, sides, mir),
        });
        break;
      }
      case 'revolve': {
        const ax = parseAxis(item.axis, 'axis', false) ?? 'z';
        const deg = item.degrees === undefined ? 360 : finiteNum(item.degrees, 'degrees');
        const segs = parseRingCount(item.segments, 'segments');
        results.push({
          op: 'revolve',
          ...revolveMm(
            lattice,
            item.profile,
            ax,
            deg,
            {
              throughMm: item.throughMm,
              segments: segs,
              closed: item.closed === true,
            },
          ),
        });
        break;
      }
      case 'bridge': {
        results.push({ op: 'bridge', ...bridgeFacesMm(lattice, item.faceA, item.faceB) });
        break;
      }
      case 'dimension': {
        const which = item.axis === undefined ? 'x' : parseAxis(item.axis, 'axis', true)!;
        if (item.mode !== undefined && item.mode !== 'size' && item.mode !== 'position') {
          throw new Error("mode must be 'size' or 'position'");
        }
        const how = item.mode === 'position' ? 'position' : 'size';
        const val = finiteNum(item.valueMm ?? 10, 'valueMm');
        results.push({ op: 'dimension', ...dimensionSelectionMm(lattice, item.corners, which, how, val) });
        break;
      }
      case 'orient': {
        results.push({ op: 'orient', flipped: orientFaces(lattice) });
        break;
      }
      case 'smooth': {
        subdiv = parseSubdiv(item.level ?? item.subdiv ?? 1, 'level');
        results.push({ op: 'smooth', level: subdiv });
        break;
      }
      case 'wall': {
        thicknessMm = parseThicknessMm(item.thicknessMm ?? 0, 'thicknessMm');
        results.push({ op: 'wall', thicknessMm });
        break;
      }
      default:
        throw new Error(
          `Unknown lattice op '${opName}'. Valid ops: extrude, inset, bevel, bevel_edges, faces, delete_faces, sharpen, circle, revolve, bridge, dimension, orient, smooth, wall`
        );
    }
  }
  if (fuse && results.length > 0) fuseTouchingParts(lattice);
  return { subdiv, thicknessMm, results };
}
