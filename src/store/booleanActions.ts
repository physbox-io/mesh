// ---------------------------------------------------------------------------
// The store's booleans: a shape's boolean op, the compiled mesh and convex
// pieces landing on a body, and combining whole bodies into one
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom, CsgOp } from '../types/scene';
import { hasEdgeRounds } from '../utils/edgeRound';
import { reseatHardware } from '../utils/hardwareParts';
import { type CombineOp, cageInFrame, geomsForCombine, nodeWorldMatrix, removeMergedBody } from '../utils/combineBodies';
import { getGeomFrame } from '../utils/laserCutExporter';
import { deserializeCage, faceCount, serializeCage } from '../utils/latticeMesh';
import { latticeBoolean } from '../utils/latticeBoolean';
import { type CsgResult, CSG_DEFAULT_SECTORS, scadForDisplay, csgHashOf } from '../utils/csg';
import { collisionHashOf, type ColliderResult } from '../utils/convexDecomposition';
import { cloneSceneGraph, findNode } from './sceneClone';
import { retargetReferences } from './breakage';
import { dropStaleColliders, rebuildAfterGeomEdit } from './geomEdits';
import type { SliceDeps } from './sliceDeps';

export interface BooleanActions {
  setGeomCsgOp: (nodeId: string, geomIndex: number, csg: CsgOp) => void;
  applyNodeCsg: (nodeId: string, result: CsgResult, skipRecompile?: boolean) => void;
  applyNodeColliders: (nodeId: string, result: ColliderResult, skipRecompile?: boolean) => void;
  setNodeCollisionError: (nodeId: string, error: string | null, hash?: string) => void;
  setNodeCsgError: (nodeId: string, error: string | null, hash?: string) => void;
  /**
   * Merges other bodies into this one and applies a boolean between them.
   *
   * The move the boolean tools were missing. A body's geoms ARE its boolean
   * program, so two separate bodies could never cut each other however they
   * overlapped — the only way to subtract a sphere from a cube was to create
   * the sphere on the cube. This brings the sphere over: its shapes are
   * rewritten into the cube's frame, marked with the operation, and the body
   * they came from is removed.
   *
   * `union` leaves them as ordinary added shapes, which is a compound body and
   * needs no boolean at all. `difference` and `intersection` turn the boolean
   * on, and the result is compiled like any other.
   */
  combineBodies: (targetId: string, sourceIds: string[], op: CombineOp) => void;
}

export function booleanActions({ set, get }: SliceDeps): BooleanActions {
  return {
    setGeomCsgOp: (nodeId, geomIndex, csg) => {
      get().recordInteraction('geom-csg-op');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node?.geoms?.[geomIndex]) return;
      // There has to be something left to cut into. Subtracting a body's only
      // shape would leave it with no positive geometry at all: nothing to render,
      // nothing to collide, and a MuJoCo body with no geoms. Refuse instead.
      if (csg !== 'union') {
        const positivesLeft = node.geoms.filter((g: SceneGeom, i: number) =>
          !g.csgDerived && i !== geomIndex && (!g.csg || g.csg === 'union')).length;
        if (positivesLeft === 0) return;
      }
      node.geoms[geomIndex].csg = csg;
      const hasOps = node.geoms.some((g: SceneGeom) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection')) ||
        hasEdgeRounds(node);
      node.csgEnabled = hasOps;
      if (hasOps) {
        if (node.csgCollision === undefined) node.csgCollision = 'auto';
        if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
      } else {
        // Back to an ordinary compound body — the stale boolean mesh would
        // otherwise keep drawing over the primitives.
        node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
        delete node.csgHash;
      }
      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
    },

    // Installs the output of evaluateNodeCsg: derived geoms replace the previous
    // ones wholesale, source primitives are untouched.
    applyNodeCsg: (nodeId, result, skipRecompile) => {
      // A result is for the shape the body had when its compile STARTED. If the
      // body has changed since — undone, rounded differently, no longer a
      // boolean at all — installing it would put back a shape that is not there
      // (an undone rounding coming straight back). The auto-compiler builds the
      // current one.
      const current = findNode(get().sceneGraph.nodes, nodeId);
      if (!current || !current.csgEnabled || csgHashOf(current) !== result.hash) return;
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      const source = (node.geoms || []).filter((g: SceneGeom) => !g.csgDerived);
      // Patterns and seams on the compiled surface are authored on a derived
      // geom, so they are carried over to the one that replaces it -- by name,
      // or from the only visual mesh to the only visual mesh. Their seeds find
      // the face again on the new surface, or say it has gone.
      const oldVisual = (node.geoms || []).filter((g: SceneGeom) => g.csgDerived === 'visual' && (g.textures?.length || g.faceSplits?.length));
      const newVisual = result.geoms.filter((g: SceneGeom) => g.csgDerived === 'visual');
      const oldCentroid = node.csgCentroid ?? [0, 0, 0];
      const newCentroid = result.centroid ?? [0, 0, 0];
      const transformMarks = (
        textures: SceneGeom['textures'],
        faceSplits: SceneGeom['faceSplits'],
        mat: THREE.Matrix4 | null,
        shift: [number, number, number],
      ): { textures?: SceneGeom['textures']; faceSplits?: SceneGeom['faceSplits'] } => {
        const pt = (p: [number, number, number]): [number, number, number] => {
          const v = new THREE.Vector3(p[0], p[1], p[2]);
          if (mat) v.applyMatrix4(mat);
          return [v.x + shift[0], v.y + shift[1], v.z + shift[2]];
        };
        const dir = (n: [number, number, number]): [number, number, number] => {
          if (!mat) return n;
          const v = new THREE.Vector3(n[0], n[1], n[2]).transformDirection(mat);
          return [v.x, v.y, v.z];
        };
        return {
          textures: textures?.map((t) => ({
            ...t,
            seedAt: pt(t.seedAt as [number, number, number]),
            seedNormal: t.seedNormal ? dir(t.seedNormal as [number, number, number]) : t.seedNormal,
          })),
          faceSplits: faceSplits?.map((s) => ({
            ...s,
            at: pt(s.at as [number, number, number]),
            normal: dir(s.normal as [number, number, number]),
            seeds: s.seeds.map((p) => pt(p as [number, number, number])),
          })),
        };
      };
      const geoms = result.geoms.map((g: SceneGeom) => {
        if (g.csgDerived !== 'visual') return g;
        if (oldVisual.length > 0) {
          const from = oldVisual.find((o: SceneGeom) => o.name === g.name)
            ?? (oldVisual.length === 1 && newVisual.length === 1 ? oldVisual[0] : undefined);
          if (!from) return g;
          const shift: [number, number, number] = [oldCentroid[0] - newCentroid[0], oldCentroid[1] - newCentroid[1], 0];
          return { ...g, ...transformMarks(from.textures, from.faceSplits, null, shift) };
        }
        if (newVisual.length !== 1) return g;
        const markedSources = source.filter(
          (s: SceneGeom) => s.csg !== 'difference' && s.role !== 'visual' && (s.textures?.length || s.faceSplits?.length),
        );
        if (markedSources.length === 0) return g;
        const shift: [number, number, number] = [-newCentroid[0], -newCentroid[1], 0];
        const carriedTextures: NonNullable<SceneGeom['textures']> = [];
        const carriedSplits: NonNullable<SceneGeom['faceSplits']> = [];
        for (const s of markedSources) {
          const m = transformMarks(s.textures, s.faceSplits, getGeomFrame(s).matrix, shift);
          if (m.textures?.length) carriedTextures.push(...m.textures);
          if (m.faceSplits?.length) carriedSplits.push(...m.faceSplits);
        }
        return {
          ...g,
          ...(carriedTextures.length ? { textures: carriedTextures } : {}),
          ...(carriedSplits.length ? { faceSplits: carriedSplits } : {}),
        };
      });
      node.geoms = [...source, ...geoms];
      node.csgHash = result.hash;
      // Summarized, not stored whole: a lattice mesh operand is megabytes of
      // polyhedron literal, and this field is shown, undone and saved.
      node.csgScad = scadForDisplay(result.scad);
      node.csgVolume = result.volume;
      node.csgHullVolume = result.hullVolume;
      node.csgCentroid = result.centroid;
      // The frame the parts seated in it are placed in has moved with the centroid.
      if (oldCentroid.some((v, a) => Math.abs(v - (newCentroid[a] ?? 0)) > 1e-9)) reseatHardware(node);
      node.csgCollision = node.csgCollision ?? 'auto';
      if (result.warning) node.csgWarning = result.warning; else delete node.csgWarning;
      delete node.csgError;
      set({ sceneGraph: newScene });
      // Bulk callers recompile once at the end — see the same note on updateNodeScad.
      if (!skipRecompile) get().recompile(newScene, undefined, false);
    },

    applyNodeColliders: (nodeId, result, skipRecompile) => {
      // A decomposition of a mesh that has since changed — two strokes, the
      // first one's result landing after the second — would install pieces of
      // the wrong shape. The auto-compiler has already queued the right one.
      const current = findNode(get().sceneGraph.nodes, nodeId);
      if (!current || collisionHashOf(current) !== result.hash) return;
      // Nor onto a body that has become a boolean while this ran (rounded, or
      // cut): its colliders come from its boolean, and these would sit on top.
      if (current.csgEnabled) return;
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      // Filters 'collider', NOT every derived geom: a boolean body's visual mesh
      // is derived too, and destroying it would leave the body invisible.
      const kept = (node.geoms || []).filter((g: SceneGeom) => g.csgDerived !== 'collider');
      node.geoms = [...kept, ...result.geoms];
      node.collisionHash = result.hash;
      if (result.geoms.length > 0) node.collisionDecomposed = true; else delete node.collisionDecomposed;
      node.collisionSolidity = +result.verdict.solidity.toFixed(4);
      if (result.cavities?.length) node.collisionCavities = result.cavities; else delete node.collisionCavities;
      if (result.intrusion) node.collisionIntrusion = result.intrusion; else delete node.collisionIntrusion;
      if (result.warning) node.collisionWarning = result.warning; else delete node.collisionWarning;
      delete node.collisionError;
      set({ sceneGraph: newScene });
      if (!skipRecompile) get().recompile(newScene, undefined, false);
    },

    setNodeCollisionError: (nodeId, error, hash) => {
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      if (error) node.collisionError = error; else delete node.collisionError;
      // Record the hash that failed, so a mesh that cannot be decomposed is not
      // retried on every store update — only a real edit re-arms it.
      if (error && hash) node.collisionHash = hash;
      // And stop colliding as the shape before the edit that could not be
      // decomposed: stamping the hash alone left those pieces in place for good.
      // The body collides as its hull instead, which at least contains it.
      const hadColliders = error ? dropStaleColliders(node) : false;
      set({ sceneGraph: newScene });
      if (hadColliders) get().recompile(newScene, undefined, false);
    },

    setNodeCsgError: (nodeId, error, hash) => {
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      if (error) node.csgError = error; else delete node.csgError;
      // Record the hash that failed so the auto-compiler doesn't retry the same
      // broken shape on every store update — only a real edit re-arms it.
      if (error && hash) node.csgHash = hash;
      set({ sceneGraph: newScene });
    },

    combineBodies: (targetId, sourceIds, op) => {
      const scene = get().sceneGraph;
      const target = findNode(scene.nodes, targetId);
      const sources = sourceIds
        .filter(id => id !== targetId)
        .map(id => findNode(scene.nodes, id))
        .filter((n): n is SceneNode => n !== null);
      if (!target || sources.length === 0) return;

      // Every geom is written relative to the body carrying it, so moving one to
      // another body means composing three transforms: the source body's pose,
      // the geom's own, and the inverse of the destination's. This is the first
      // and last of those; utils/combineBodies does the middle one per geom.
      const targetWorld = nodeWorldMatrix(scene.nodes, targetId);
      if (!targetWorld) return;
      const intoTarget = targetWorld.clone().invert();

      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(scene);
      const node = findNode(newScene.nodes, targetId);
      if (!node) return;

      /*
        Two lattice bodies combined become ONE CAGE, not one cage with the other's
        frozen mesh bolted on. The mesh route worked in the sense that the shape
        was there, and failed in the sense that mattered: open the lattice tools
        afterwards and only the first body's corners could be touched, because the
        second was a mesh geom the cage knew nothing about.

        A cage corner lives in its body's frame at `coord * unit - latticeOrigin`
        (the mesh is recentred on its centre of mass; the origin is how far).
        That point goes through the same three transforms as any other geom and
        lands on the target's grid, rounded — so a source turned by something
        other than a right angle comes across as the nearest grid shape, which is
        what the grid means.

        The cages are then put through a real boolean (utils/latticeBoolean),
        which is the difference between a join and a union: concatenating them
        left the surface where the two solids met buried inside the result, along
        with every corner of it. All three operations go this way now — a cage
        cannot carry a 'subtract' marker, but it can be subtracted FROM.
      */
      const merged = node.isLattice && node.latticeCage
        ? deserializeCage(node.latticeCage)
        : null;
      let mergedFaces = 0;
      let mergedResult: ReturnType<typeof deserializeCage> | null = null;

      const taken = new Set<string>((node.geoms || []).map((g: SceneGeom) => g.name).filter(Boolean));
      const brought: SceneGeom[] = [];
      for (const source of sources) {
        const sourceWorld = nodeWorldMatrix(scene.nodes, source.id);
        if (!sourceWorld) continue;
        const relative = intoTarget.clone().multiply(sourceWorld);
        const cage = merged && source.isLattice && source.latticeCage ? deserializeCage(source.latticeCage) : null;
        let combined = false;
        if (cage && merged) {
          // Into a cage of its own rather than straight onto the target's: a
          // boolean compares two solids, and concatenating them first is exactly
          // the join that left a wall buried down the seam.
          const moved = cageInFrame(cage, relative, source.latticeOrigin, node.latticeOrigin, merged.unit);
          const result = latticeBoolean(mergedResult ?? merged, moved, op);
          if (result) {
            mergedResult = result;
            mergedFaces = faceCount(result);
            combined = true;
          }
        }
        // Only the cage went across, so the source's mesh stays behind. If the
        // boolean refused — an open shell, or a difference that removed
        // everything — nothing was combined and the geoms have to come the old
        // way, or the shape would simply vanish.
        brought.push(...geomsForCombine(source, relative, op, taken, combined));
      }
      if (brought.length === 0 && mergedFaces === 0) return;

      node.geoms = [...(node.geoms || []), ...brought];
      if (mergedResult && mergedFaces > 0) {
        node.latticeCage = serializeCage(mergedResult);
        // A new cage is a new document to the editor, which remounts on this.
        node.latticeVersion = (node.latticeVersion ?? 1) + 1;
      }
      // A boolean that happened on the cage has already happened; turning the
      // evaluator on as well would subtract the source a second time.
      if (op !== 'union' && !mergedResult) {
        node.csgEnabled = true;
        if (node.csgCollision === undefined) node.csgCollision = 'auto';
        if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
      }

      // The bodies that were merged in are gone: their shapes are on the target
      // now, and leaving the originals behind would draw every one of them twice
      // and simulate them as separate objects that happen to overlap.
      // The bodies hung off them are not merged, and move to the target.
      // Welds to a merged body hold the merged part now.
      for (const source of sources) {
        removeMergedBody(newScene.nodes, source.id, targetId);
        newScene.nodes = retargetReferences(newScene.nodes, source.id, targetId);
      }

      set({ sceneGraph: newScene, extraSelectedIds: [], selectedNodeId: targetId });
      if (mergedResult && mergedFaces > 0) {
        // Rebuilds the mesh from the merged cage, recentres the body on it, and
        // recompiles — the same path an edit in the lattice tools takes.
        // Written a few lines above, under this same condition.
        get().applyLattice(targetId, node.latticeCage!, node.latticeSubdiv);
        return;
      }
      get().recompile(newScene, targetId, true);
    },
  };
}
