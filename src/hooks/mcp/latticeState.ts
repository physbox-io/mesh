// ---------------------------------------------------------------------------
// The MCP lattice commands' own state: the agent's undo history of cages, and
// running a list of lattice operations on one
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, bridgeFacesMm, dimensionSelectionMm, extrudeMm,
  insetFaceMm, removeFacesMm, revolveMm, sharpenEdgesMm,
} from '../../utils/latticeCommands';
import type { SceneNode } from '../../types/scene';
import {
  deserializeCage, orientFaces, serializeCage, type Axis as LatticeAxis, type Lattice,
} from '../../utils/latticeMesh';
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

/**
 * The sculptable mesh on a node, rebuilt from the geom arrays it is stored as.
 *
 * renderVertices, not vertices: that is the Z-up copy sculptMesh works in, and
 * the one toSceneGeom will write back.
 */
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
  const store = useStore.getState();
  store.updateNode(node.id, { latticeVersion: (node.latticeVersion ?? 1) + 1 });
  store.applyLattice(node.id, serializeCage(lattice), node.latticeSubdiv ?? 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LatticeOpSpec extends Record<string, any> {
  op?: string;
  type?: string;
  kind?: string;
}

export function runLatticeOps(
  lattice: Lattice,
  ops: LatticeOpSpec[],
  initialSubdiv = 0,
  initialThicknessMm = 0,
): { subdiv: number; thicknessMm: number; results: Record<string, unknown>[] } {
  let subdiv = Math.max(0, Math.min(2, Math.round(Number(initialSubdiv) || 0)));
  let thicknessMm = Math.max(0, Number(initialThicknessMm) || 0);
  const results: Record<string, unknown>[] = [];
  for (const item of ops || []) {
    if (!item || typeof item !== 'object') continue;
    const opName = String(item.op ?? item.type ?? item.kind ?? '').toLowerCase();
    switch (opName) {
      case 'extrude': {
        const d = Number(item.distanceMm ?? item.amountMm ?? 10);
        results.push({ op: 'extrude', ...extrudeMm(lattice, item.face, d, item.axis as LatticeAxis | undefined, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'inset': {
        const amt = Number(item.amountMm ?? item.distanceMm ?? 5);
        results.push({ op: 'inset', ...insetFaceMm(lattice, item.face, amt, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'bevel': {
        const amt = Number(item.amountMm ?? item.distanceMm ?? 5);
        results.push({ op: 'bevel', ...bevelFaceMm(lattice, item.face, amt, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'bevel_edges':
      case 'beveledges': {
        const rad = Number(item.radiusMm ?? item.amountMm ?? item.sizeMm ?? 3);
        const mode = item.mode === 'fillet' || item.mode === 'round' ? 'fillet' : 'chamfer';
        results.push({ op: 'bevel_edges', ...bevelEdgesMm(lattice, item.edges, rad, mode, item.mirror as LatticeAxis | undefined, item.loop === true) });
        break;
      }
      case 'faces':
      case 'add_faces':
      case 'addfaces': {
        results.push({ op: 'faces', ...addFacesMm(lattice, item.faces, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'delete_faces':
      case 'deletefaces':
      case 'remove_faces': {
        results.push({ op: 'delete_faces', ...removeFacesMm(lattice, item.faces, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'sharpen': {
        results.push({ op: 'sharpen', ...sharpenEdgesMm(lattice, item.edges, item.sharp !== false, item.mirror as LatticeAxis | undefined, item.loop === true) });
        break;
      }
      case 'circle':
      case 'ring': {
        results.push({
          op: 'circle',
          ...addRingMm(
            lattice,
            item.centre ?? item.center,
            Number(item.diameterMm ?? 10),
            (item.axis as LatticeAxis) || 'z',
            typeof item.sides === 'number' ? item.sides : 0,
            item.mirror as LatticeAxis | undefined,
          ),
        });
        break;
      }
      case 'revolve': {
        results.push({
          op: 'revolve',
          ...revolveMm(
            lattice,
            item.profile,
            (item.axis as LatticeAxis) || 'z',
            typeof item.degrees === 'number' ? item.degrees : 360,
            {
              throughMm: Array.isArray(item.throughMm) ? item.throughMm : undefined,
              segments: typeof item.segments === 'number' ? item.segments : 0,
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
        const which = (item.axis === 'x' || item.axis === 'y' || item.axis === 'z') ? item.axis : 'x';
        const how = item.mode === 'position' ? 'position' : 'size';
        results.push({ op: 'dimension', ...dimensionSelectionMm(lattice, item.corners, which, how, Number(item.valueMm ?? 10)) });
        break;
      }
      case 'orient': {
        results.push({ op: 'orient', flipped: orientFaces(lattice) });
        break;
      }
      case 'smooth': {
        subdiv = Math.max(0, Math.min(2, Math.round(Number(item.level ?? item.subdiv ?? 1))));
        results.push({ op: 'smooth', level: subdiv });
        break;
      }
      case 'wall': {
        thicknessMm = Math.max(0, Number(item.thicknessMm ?? 0));
        results.push({ op: 'wall', thicknessMm });
        break;
      }
      default:
        throw new Error(
          `Unknown lattice op '${opName}'. Valid ops: extrude, inset, bevel, bevel_edges, faces, delete_faces, sharpen, circle, revolve, bridge, dimension, orient, smooth, wall`
        );
    }
  }
  return { subdiv, thicknessMm, results };
}
