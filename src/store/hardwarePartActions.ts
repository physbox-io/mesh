// ---------------------------------------------------------------------------
// The store's hardware-part actions
//
// Kept out of useStore.ts, which is big enough. The geometry and the rules —
// what a part is, where it sits in a cut, what a screw fastens — are pure
// functions in utils/hardwareParts.ts; this only takes the scene, applies them,
// and hands the result back as one undo step.
// ---------------------------------------------------------------------------

import type { HardwarePart, HardwarePartKind, SceneGraph, SceneNode } from '../types/scene';
import {
  HARDWARE_PARTS, PARTS_FOR_CUT, fasten, hardwarePartNode, rebuildPart, screwFit, seatFor, seatPart, seatedIn,
} from '../utils/hardwareParts';
import { BEARINGS } from '../utils/hardwareSizes';
import { findNodeById } from '../utils/sceneTree';
import type { PhysicsState } from './useStore';

export interface HardwarePartActions {
  /**
   * Puts a bought part in the scene and returns its id. With a body picked, it
   * goes where it is made to go if it can: into the body's first hardware cut
   * that takes it and has nothing in it yet, or — for a shaft — through a
   * picked bearing's bore. Otherwise it stands on its own at `position`.
   */
  addHardwarePart: (kind: HardwarePartKind, position: number[], targetId?: string | null) => string | null;
  /** Seats a new part in one of a body's hardware cuts. Returns its id, or null when the cut cannot take one. */
  seatHardwarePart: (hostId: string, group: string, kind?: HardwarePartKind) => string | null;
  /**
   * Changes a part's size, length or washer. A seated part's size is its cut's
   * size, so that changes the cut, and the part follows.
   */
  setHardwarePart: (partId: string, changes: Partial<Pick<HardwarePart, 'size' | 'lengthMm' | 'washer'>>) => void;
}

interface Deps {
  set: (partial: Partial<PhysicsState>) => void;
  get: () => PhysicsState;
  clone: (scene: SceneGraph) => SceneGraph;
}

const newId = (kind: HardwarePartKind) => `${kind}_${Math.random().toString(36).slice(2, 10)}`;

function parentOf(nodes: SceneNode[], id: string, parent: SceneNode | null = null): SceneNode | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    const found = parentOf(n.children || [], id, n);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A cut on `host` that takes `kind` and has nothing in it: the picked one first. */
function emptyCutFor(host: SceneNode, kind: HardwarePartKind, preferredGroup?: string): string | null {
  const groups: string[] = [];
  for (const g of host.geoms || []) {
    const h = g.hardware;
    if (!h || g.csgDerived || groups.includes(h.group)) continue;
    if (PARTS_FOR_CUT[h.kind].includes(kind) && !seatedIn(host, h.group)) groups.push(h.group);
  }
  if (preferredGroup && groups.includes(preferredGroup)) return preferredGroup;
  return groups[0] ?? null;
}

/**
 * Seats `part`, already under `host` in `scene`, in `group`; for a screw, sizes
 * it to what it reaches and fastens that. Mutates `scene`.
 */
function seatInScene(scene: SceneGraph, host: SceneNode, part: SceneNode, group: string): boolean {
  if (!seatPart(part, host, group)) return false;
  if (part.hardwarePart?.kind !== 'screw') return true;
  const seat = seatFor(host, group, 'screw');
  if (!seat || seat.gripM === undefined) return true;
  const spec = host.geoms.find((g) => g.hardware?.group === group)?.hardware;
  // Into an insert the screw comes from outside and its length is the insert's.
  if (spec?.kind === 'insert' || spec?.kind === 'insert_boss') return true;
  const fit = screwFit(scene, host, part, seat.gripM);
  rebuildPart(part, { ...part.hardwarePart!, lengthMm: fit.lengthMm });
  if (fit.target) fasten(part, host, fit.target);
  return true;
}

export function hardwarePartActions({ set, get, clone }: Deps): HardwarePartActions {
  const commit = (scene: SceneGraph, selectId: string, rebuildId: string) => {
    set({ sceneGraph: scene, selectedNodeId: selectId });
    void get().recompile(scene, rebuildId, false);
  };

  const seatNew = (hostId: string, group: string, kind?: HardwarePartKind): string | null => {
    const current = findNodeById(get().sceneGraph.nodes, hostId);
    const partKind = kind ?? (current && (() => {
      const h = current.geoms.find((g) => g.hardware?.group === group)?.hardware;
      return h ? PARTS_FOR_CUT[h.kind][0] : undefined;
    })());
    if (!current || !partKind || !seatFor(current, group, partKind)) return null;
    get().prepareForDiscreteChange();
    const scene = clone(get().sceneGraph);
    const host = findNodeById(scene.nodes, hostId)!;
    const id = newId(partKind);
    const part = hardwarePartNode({ kind: partKind, size: HARDWARE_PARTS[partKind].defaultSize }, id);
    host.children = [...(host.children || []), part];
    if (!seatInScene(scene, host, part, group)) return null;
    commit(scene, id, id);
    return id;
  };

  return {
    seatHardwarePart: seatNew,

    addHardwarePart: (kind, position, targetId) => {
      const target = targetId ? findNodeById(get().sceneGraph.nodes, targetId) : null;
      if (target && !target.hardwarePart) {
        const active = target.geoms[get().activeGeomIndex ?? -1]?.hardware?.group;
        const group = emptyCutFor(target, kind, active);
        if (group) return seatNew(target.id, group, kind);
      }
      get().prepareForDiscreteChange();
      const scene = clone(get().sceneGraph);
      const id = newId(kind);
      // A shaft through a picked bearing: fixed in its inner race, so it turns
      // with it, and its diameter is the bore's.
      const bearing = target?.hardwarePart?.kind === 'bearing' && !target.hardwarePart.piece ? findNodeById(scene.nodes, target.id) : null;
      const inner = bearing?.children.find((c) => c.hardwarePart?.piece === 'inner');
      if (kind === 'shaft' && bearing && inner) {
        const bore = String(BEARINGS[bearing.hardwarePart!.size]?.[1] ?? 8);
        const part = hardwarePartNode({ kind: 'shaft', size: bore, seat: 'bore' }, id);
        part.joints = [];
        rebuildPart(part, part.hardwarePart!);
        inner.children = [...(inner.children || []), part];
        commit(scene, id, id);
        return id;
      }
      const part = hardwarePartNode({ kind, size: HARDWARE_PARTS[kind].defaultSize }, id);
      // Just above the floor, or wherever it was dropped: it falls from there.
      part.pos = [position[0] ?? 0, position[1] ?? 0, Math.max(position[2] ?? 0, 0.02)];
      scene.nodes = [...scene.nodes, part];
      commit(scene, id, id);
      return id;
    },

    setHardwarePart: (partId, changes) => {
      const current = findNodeById(get().sceneGraph.nodes, partId);
      const spec = current?.hardwarePart;
      if (!current || !spec || spec.piece) return;
      const host = parentOf(get().sceneGraph.nodes, partId);
      const group = spec.seat;
      if (changes.size && changes.size !== spec.size && host && group && group !== 'bore') {
        // The cut is what decides it: resize the cut, and the part follows it
        // (writeHardwareGroup re-seats whatever sits in a group it rewrites).
        get().setHardwareCut(host.id, group, { size: changes.size });
        const { size: _size, ...rest } = changes;
        if (Object.keys(rest).length === 0) return;
        changes = rest;
      }
      get().recordInteraction('hardware-part');
      const scene = clone(get().sceneGraph);
      const node = findNodeById(scene.nodes, partId)!;
      rebuildPart(node, { ...node.hardwarePart!, ...changes });
      commit(scene, partId, partId);
    },
  };
}
