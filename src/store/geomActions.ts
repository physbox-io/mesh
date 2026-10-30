// ---------------------------------------------------------------------------
// The store's edits to a body's shapes: a geom's fields, its OpenSCAD source,
// deleting one, and insetting them all
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom } from '../types/scene';
import { reconcileEdgeRounds } from '../utils/edgeRound';
import { CSG_DEFAULT_SECTORS, sourcePositiveBounds, reconcileCuts, hasBooleanOps } from '../utils/csg';
import { insetNegatives } from '../utils/scaleNode';
import { generateGearGeoms } from '../presets/presetScenes';
import { cloneSceneGraph, findNode } from './sceneClone';
import { dropStaleColliders, rebuildAfterGeomEdit } from './geomEdits';
import type { SliceDeps } from './sliceDeps';
import { assertGeomSizes } from '../utils/geomSize';

export interface GeomActions {
  updateNodeGeom: (id: string, updates: Partial<SceneGeom>, geomIndex?: number) => void;
  updateNodeScad: (id: string, scadCode: string, compiledData: { vertices: number[], faces: number[], renderVertices: number[] }, skipRecompile?: boolean) => void;
  // --- CSG (boolean modifiers) ---
  deleteNodeGeom: (nodeId: string, geomIndex: number) => void;
  /**
   * Puts a scaled copy of a body's own shape inside it, marked as a hole.
   *
   * The shortest path from a solid to a hollow one. Factors are per-axis, and
   * an axis above 1 is how the copy is made to pass right through — a cylinder
   * with a [0.8, 0.8, 1.05] copy of itself subtracted is a pipe, where the same
   * copy shrunk on all three would be a sealed cavity nobody can see.
   */
  insetNodeGeoms: (nodeId: string, factor: [number, number, number], pocket?: { axis: 0 | 1 | 2; side: 1 | -1 }) => void;
}

export function geomActions({ set, get }: SliceDeps): GeomActions {
  return {
    updateNodeGeom: (id, updates, geomIndex) => {
      get().recordInteraction('node-geom');
      /*
       * Whether this edit changes the shape, or only how it behaves on contact.
       *
       * `recompile`'s third argument does two things: it skips the 50ms debounce,
       * and it rebuilds without carrying the simulation state over. Both are right
       * for a change of geometry — the old state may not even be valid against the
       * new model. Both are wrong for a material property: dragging the contact
       * stiffness slider rebuilt MuJoCo on every pixel of travel and threw the
       * world back to its start each time, which is what made those sliders feel
       * like they were fighting the mouse.
       */
      const STRUCTURAL = ['size', 'vertices', 'faces', 'renderVertices', 'type', 'pos', 'euler', 'quat', 'csg'] as const;
      const structural = STRUCTURAL.some(k => (updates as Record<string, unknown>)[k] !== undefined);
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false; for (const node of nodes) {
          if (node.id === id && node.geoms?.length > 0) {
            if (id.includes('gear')) {
              const centerGeom = node.geoms[0];
              assertGeomSizes([{ ...centerGeom, ...updates }], node.name);
              const currentRadius = centerGeom.size[0];
              const currentTeeth = node.geoms.length - 1;
              const currentColor = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
              const currentContype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
              const currentConaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
            
              let newRadius = currentRadius;
              if (updates.size && Array.isArray(updates.size)) {
                newRadius = updates.size[0];
              }
            
              let newColor = currentColor;
              if (updates.rgba) {
                newColor = updates.rgba;
              }

              let newContype = currentContype;
              if (updates.contype !== undefined) {
                newContype = updates.contype;
              }

              let newConaffinity = currentConaffinity;
              if (updates.conaffinity !== undefined) {
                newConaffinity = updates.conaffinity;
              }
            
              const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
              const isSecondGear = gearNum % 2 === 0;
            
              node.geoms = generateGearGeoms(id, newRadius, currentTeeth, newColor, isSecondGear, newContype, newConaffinity);
            } else {
              let targetGeom = node.geoms[0];
              if (geomIndex !== undefined && geomIndex >= 0 && geomIndex < node.geoms.length) {
                targetGeom = node.geoms[geomIndex];
              } else {
                const mainGeom = node.geoms.find((g: SceneGeom) => g.type === 'sphere' || g.type === 'box' || g.type === 'cylinder');
                if (mainGeom) {
                  targetGeom = mainGeom;
                }
              }
              if (updates.fromto && targetGeom.fromto) {
                const oldFromto = targetGeom.fromto;
                const newFromto = updates.fromto;
                const oldLen = Math.sqrt((oldFromto[3]-oldFromto[0])**2 + (oldFromto[4]-oldFromto[1])**2 + (oldFromto[5]-oldFromto[2])**2) || 1.0;
                const newLen = Math.sqrt((newFromto[3]-newFromto[0])**2 + (newFromto[4]-newFromto[1])**2 + (newFromto[5]-newFromto[2])**2) || 1.0;
                const ratio = newLen / oldLen;
                if (node.children) {
                  node.children.forEach((child: SceneNode) => {
                    child.pos = [child.pos[0] * ratio, child.pos[1] * ratio, child.pos[2] * ratio];
                  });
                }
              }
              const boundsBefore = structural && node.edgeRounds ? sourcePositiveBounds(node) : null;
              // Refused before anything is written: a bad size is an error
              // to the caller, never a 0.1 m default (utils/geomSize).
              assertGeomSizes([{ ...targetGeom, ...updates }], node.name);
              Object.assign(targetGeom, updates);
              if (updates.vertices || updates.faces || updates.renderVertices) dropStaleColliders(node);
              // Rounded edges are stored as points, so they move with the shape.
              if (boundsBefore) reconcileEdgeRounds(node, boundsBefore, sourcePositiveBounds(node));
              /*
                A cut is stated as a face and a depth, so resizing or moving the
                shape it cuts into has to move the cut with it — a hole 10 mm into
                the top of a block is still 10 mm into the top when the block gets
                taller. Only geoms carrying that intent are touched; a negative
                placed by hand keeps its own numbers. See reconcileCuts.
              */
              if (structural) reconcileCuts(node);
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, structural, undefined, structural);
    },

    updateNodeScad: (id, scad, compiledData, skipRecompile) => {
      get().recordInteraction('node-scad');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id || node.name === id) {
            node.scad = scad;
            if (!node.geoms) {
              node.geoms = [];
            }
            let meshGeom = node.geoms.find((g: SceneGeom) => g.type === 'mesh');
            if (!meshGeom && node.geoms.length > 0) {
              meshGeom = node.geoms[0];
            }
            const nodeRgba = (node as { rgba?: number[] }).rgba;
            // number[], as SceneGeom.rgba is: a tuple here made the `as SceneGeom`
            // below an assertion between unrelated types (TS2352).
            const fallbackRgba: number[] =
              Array.isArray(nodeRgba) && nodeRgba.length >= 3
                ? [nodeRgba[0], nodeRgba[1], nodeRgba[2], nodeRgba[3] ?? 1]
                : [0.3, 0.6, 0.9, 1];
            if (!meshGeom) {
              // No `size`: a mesh geom's is unused, the vertices are written a
              // few lines below, and putting a number here would put one in the
              // scene that has never been there.
              meshGeom = {
                id: `geom_${Math.random().toString(36).substring(2, 8)}`,
                name: `${node.name || id}_mesh`,
                type: 'mesh',
                dynamic: true,
                rgba: fallbackRgba,
                mass: 1
              } as SceneGeom;
              node.geoms.push(meshGeom);
            } else if (Array.isArray(nodeRgba) && nodeRgba.length >= 3 && !meshGeom.rgba) {
              meshGeom.rgba = fallbackRgba;
            }
            meshGeom.type = 'mesh';
            meshGeom.dynamic = true;
            meshGeom.vertices = compiledData.vertices;
            meshGeom.faces = compiledData.faces;
            meshGeom.renderVertices = compiledData.renderVertices;
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        set({ sceneGraph: newScene });
        // Bulk callers (e.g. compiling several scad bodies in sequence) pass
        // skipRecompile: firing a recompile per node here creates overlapping,
        // unawaited MJCF/WASM builds that race - a stale one (compiled before a
        // later node's mesh existed) can finish last and silently overwrite the
        // correct final state. Bulk callers run a single recompile after all
        // nodes are updated instead.
        if (!skipRecompile) {
          get().recompile(newScene, id, true);
        }
      }
    },

    // --- CSG (boolean modifiers) ---------------------------------------------
    // A negative geom is an ordinary primitive with csg:'difference' — it's the
    // node's csgEnabled flag plus that marker that turn the body into a boolean.
    // Shapes get onto a body the ordinary ways (drag-in, presets, MCP); flipping
    // one to 'difference' is what makes it a hole.
    deleteNodeGeom: (nodeId, geomIndex) => {
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node || !node.geoms || geomIndex < 0 || geomIndex >= node.geoms.length) return;
      // A piece of a hardware feature goes with the rest of it: half a nut trap
      // is a hole nobody asked for.
      const group = node.geoms[geomIndex].hardware?.group;
      node.geoms = node.geoms.filter((g: SceneGeom, i: number) => i !== geomIndex && !(group && g.hardware?.group === group));
      // Losing the last boolean operator leaves an ordinary compound body; drop
      // the derived mesh with it so the primitives come back into view.
      if (node.csgEnabled && !hasBooleanOps(node)) {
        node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
        node.csgEnabled = false;
        delete node.csgHash;
      }
      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
    },

    insetNodeGeoms: (nodeId, factor, pocket) => {
      const target = findNode(get().sceneGraph.nodes, nodeId);
      if (!target || insetNegatives(target, factor, pocket).length === 0) return;
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      const copies = insetNegatives(node, factor, pocket);
      if (copies.length === 0) return;

      node.geoms = [...node.geoms, ...copies];
      node.csgEnabled = true;
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;

      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
    },
  };
}
