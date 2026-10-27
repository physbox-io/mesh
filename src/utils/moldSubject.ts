// ---------------------------------------------------------------------------
// What a mold is made of: the selection, or the whole scene
// ---------------------------------------------------------------------------
//
// Every kind of mold follows one rule. With parts selected it molds those
// parts, children and all, where they stand; with nothing selected it molds
// every body in the scene. Simulated bodies (earlier molds and casts) are never
// part of it.
//
// The engines read a whole SceneGraph, so the subject is handed to them as one:
// the picked subtrees lifted to the top level, each carrying its world pose,
// and the rest of the scene's settings (castPrep among them) kept.

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';
import { isPourTooling, withoutTooling } from './pourTooling';

export interface MoldSubject {
  /** The scene the engines mold. */
  scene: SceneGraph;
  /** The top-level bodies in it. */
  ids: string[];
  /** What the dialog says it is molding: "dragon", or "whole scene (3 parts)". */
  label: string;
}

function isSimulation(nodes: SceneNode[], id: string): boolean {
  for (const n of nodes) {
    if (n.id === id) return Boolean(n.simulation || isPourTooling(n));
    if (n.children?.length && isSimulation(n.children, id)) return true;
  }
  return false;
}

/** The node with its world pose as its own, so it can stand at the top level. */
function lifted(node: SceneNode, world: THREE.Matrix4): SceneNode {
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  world.decompose(pos, q, new THREE.Vector3());
  const { euler: _euler, ...rest } = node;
  return { ...rest, pos: [pos.x, pos.y, pos.z], quat: [q.w, q.x, q.y, q.z] };
}

export function moldSubject(scene: SceneGraph, selection: readonly string[]): MoldSubject {
  // Simulations and the pour box round a master are not the part.
  const real = (n: SceneNode) => !n.simulation && !isPourTooling(n);
  // A simulation or a pour box is never molded, so one left selected (an Add
  // Simulation selects what it adds) counts as nothing selected.
  const ids = selection.filter((id) => !isSimulation(scene.nodes, id));
  if (ids.length === 0) {
    const nodes = scene.nodes.filter(real).map(withoutTooling);
    return {
      scene: nodes.length === scene.nodes.length && nodes.every((n, i) => n === scene.nodes[i]) ? scene : { ...scene, nodes },
      ids: nodes.map((n) => n.id),
      label: nodes.length === 1 ? nodes[0].name : `whole scene (${nodes.length} parts)`,
    };
  }
  const wanted = new Set(ids);
  const picked: SceneNode[] = [];
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      if (!real(n)) continue;
      const world = getNodeWorldTransform(n, parent);
      // A picked body brings its children; one picked inside it is in already.
      if (wanted.has(n.id)) picked.push(withoutTooling(parent ? lifted(n, world) : n));
      else walk(n.children || [], world);
    }
  };
  walk(scene.nodes);
  return {
    scene: { ...scene, nodes: picked },
    ids: picked.map((n) => n.id),
    label: picked.length <= 2 ? picked.map((n) => n.name).join(' and ') : `${picked[0].name} and ${picked.length - 1} more`,
  };
}

/** The selection as the dialogs read it: the clicked body first. */
export function selectedIds(state: { selectedNodeId: string | null; extraSelectedIds: string[] }): string[] {
  const { selectedNodeId, extraSelectedIds } = state;
  return selectedNodeId ? [selectedNodeId, ...extraSelectedIds.filter((id) => id !== selectedNodeId)] : [];
}

/**
 * What an MCP call molds: `masterId` (comma-separated for several bodies) if
 * given, else every body. Not the selection, as the dialog does: an agent
 * cannot see it, and adding a body or a simulation moves it.
 */
export function mcpMoldSubject(
  scene: SceneGraph,
  masterId: unknown,
  resolve: (id: string) => SceneNode | null,
): MoldSubject | { error: string } {
  const named = typeof masterId === 'string' ? masterId.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const missing = named.filter((id) => !resolve(id));
  if (missing.length) return { error: `No body called ${missing.join(', ')}.` };
  const ids = named.map((id) => resolve(id)!.id);
  if (ids.length && ids.every((id) => isSimulation(scene.nodes, id))) {
    return { error: `${named.join(', ')} ${named.length === 1 ? 'is a simulation or a pour box' : 'are simulations or pour boxes'}, not part of the design: pass master_id for the part to mold.` };
  }
  const subject = moldSubject(scene, ids);
  if (!subject.ids.length) return { error: 'There is nothing to mold: the scene holds only earlier simulations. Add the part first.' };
  return subject;
}
