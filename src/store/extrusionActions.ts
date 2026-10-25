// ---------------------------------------------------------------------------
// The store's extrusion actions
//
// Joining two profiles where they meet, and putting a carriage on a V-slot.
// The rules — where two profiles meet, where a bracket goes in their corner —
// are pure, in utils/extrusionParts.ts; this applies them as one undo step.
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode } from '../types/scene';
import { carriageRange, joinPose, meeting, type JoinKind } from '../utils/extrusionParts';
import { hardwarePartNode } from '../utils/hardwareParts';
import { findNodeById } from '../utils/sceneTree';
import type { PhysicsState } from './useStore';

export type JoinResult = { id: string } | { problem: string };

export interface ExtrusionActions {
  /**
   * Joins two extrusion profiles where the end of one stands on a side of the
   * other, with a corner bracket in their inside corner, a joint plate across
   * their shared outside face, or an end-tap screw through one into the
   * other's end. The piece is fixed to the profile whose side is met, and
   * welds the other to it. Says why when the two do not meet.
   */
  joinProfiles: (firstId: string, secondId: string, kind: JoinKind, size?: string) => JoinResult;
  /** Puts a wheel carriage on a V-slot profile, sliding along it between its ends. */
  addCarriage: (profileId: string) => JoinResult;
}

interface Deps {
  set: (partial: Partial<PhysicsState>) => void;
  get: () => PhysicsState;
  clone: (scene: SceneGraph) => SceneGraph;
}

const newId = (kind: string) => `${kind}_${Math.random().toString(36).slice(2, 10)}`;

/** Takes a piece out of the contact solver: it sits on or in its profile, and what holds it is the hierarchy. */
function quiet(node: SceneNode) {
  for (const g of node.geoms) {
    if (g.role === 'visual') continue;
    g.contype = 0;
    g.conaffinity = 0;
  }
}

export function extrusionActions({ set, get, clone }: Deps): ExtrusionActions {
  const commit = (scene: SceneGraph, id: string) => {
    set({ sceneGraph: scene, selectedNodeId: id });
    void get().recompile(scene, id, false);
  };

  return {
    joinProfiles: (firstId, secondId, kind, size) => {
      const m = meeting(get().sceneGraph, firstId, secondId);
      if ('problem' in m) return m;
      const pose = joinPose(m, kind, size);
      if ('problem' in pose) return pose;
      get().prepareForDiscreteChange();
      const scene = clone(get().sceneGraph);
      const host = findNodeById(scene.nodes, m.b.id)!;
      const id = newId(kind);
      const part = hardwarePartNode({
        kind, size: pose.size, ...(pose.lengthMm ? { lengthMm: pose.lengthMm } : {}), seat: 'frame', fastens: m.a.id,
      }, id);
      part.pos = pose.pos;
      part.quat = pose.quat;
      part.joints = [];
      quiet(part);
      // The weld is the piece's own: see note 2 in utils/extrusionParts.ts.
      part.weldTargetId = m.a.id;
      part.weldRigid = true;
      host.children = [...(host.children || []), part];
      commit(scene, id);
      return { id };
    },

    addCarriage: (profileId) => {
      const profile = findNodeById(get().sceneGraph.nodes, profileId);
      if (profile?.hardwarePart?.kind !== 'extrusion' || profile.hardwarePart.size !== '2020V') {
        return { problem: 'A wheel carriage runs on V-slot: select a V-slot 2020 profile.' };
      }
      get().prepareForDiscreteChange();
      const scene = clone(get().sceneGraph);
      const host = findNodeById(scene.nodes, profileId)!;
      const id = newId('vslot_carriage');
      const part = hardwarePartNode({ kind: 'vslot_carriage', size: '20', seat: 'rail' }, id);
      part.pos = [0, 0, 0];
      part.joints = [{
        name: `${id}_slide`, type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0],
        limited: true, range: carriageRange(host.hardwarePart!.lengthMm ?? 300, 0), damping: 0.05,
      }];
      quiet(part);
      host.children = [...(host.children || []), part];
      commit(scene, id);
      return { id };
    },
  };
}
