// ---------------------------------------------------------------------------
// The store's paint: vertex paint, surface textures, face splits and colour
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom } from '../types/scene';
import { DEFAULT_PAINT_HARDNESS, type PaintLayer } from '../utils/vertexPaint';
import type { FaceSplit, SurfaceTexture } from '../utils/surfaceTexture';
import { cloneSceneGraph, findNode } from './sceneClone';
import type { SliceDeps } from './sliceDeps';

export interface BatchColorEntry {
  nodeId: string;
  geomName?: string;
  rgba: number[];
}

export interface PaintActions {
  // --- Coloring -----------------------------------------------------------
  //
  // Brushed onto part of a surface, not applied to a whole body — see
  // utils/vertexPaint. Purely how the scene looks: a geom's colour has never
  // fed the physics or any exporter.
  /** Whether a drag in the viewport paints bodies instead of selecting them. */
  paintMode: boolean;
  /** The colour the brush is holding, as 0..1 rgb to match a geom's rgba. */
  paintColor: [number, number, number];
  /** Brush radius in metres. */
  paintRadius: number;
  /** Coverage one dab lays down at the centre of the brush, 0..1. */
  paintFlow: number;
  /** Share of the radius laid down at full strength before the edge falls off, 0..1. */
  paintHardness: number;
  togglePaintMode: () => void;
  setPaintColor: (rgb: [number, number, number]) => void;
  setPaintBrush: (patch: { radius?: number; flow?: number; hardness?: number }) => void;
  /** Stores a finished stroke. Passing undefined strips a geom back to bare. */
  setGeomPaint: (nodeId: string, geomName: string, layer: PaintLayer | undefined) => void;
  /**
   * Replaces a geom's surface patterns (see utils/surfaceTexture), or clears
   * them with undefined. No recompile: the MJCF never reads them.
   */
  setGeomTextures: (nodeId: string, geomName: string, textures: SurfaceTexture[] | undefined) => void;
  /** Replace a geom's knife seams (SceneGeom.faceSplits). One undo step; no recompile. */
  setGeomFaceSplits: (nodeId: string, geomName: string, splits: FaceSplit[] | undefined, recordUndo?: boolean) => void;
  /** Sets a body's base colour — one geom by name, or all of them. */
  setGeomColor: (nodeId: string, geomName: string | undefined, rgba: number[]) => void;
  /** Sets base colours for multiple bodies/geoms in one store transaction + one recompile. */
  setGeomColorsBatch: (entries: BatchColorEntry[]) => number;
  /** Takes the paint off every geom of the scene. */
  clearAllPaint: () => void;
}

export function paintActions({ set, get }: SliceDeps): PaintActions {
  return {
    paintMode: false,

    paintColor: [0.91, 0.30, 0.24],

    paintRadius: 0.008,

    paintFlow: 0.35,

    paintHardness: DEFAULT_PAINT_HARDNESS,

    togglePaintMode: () => set((state) => ({ paintMode: !state.paintMode })),

    setPaintColor: (paintColor) => set({ paintColor }),

    setPaintBrush: (patch) => set((state) => ({
      paintRadius: patch.radius ?? state.paintRadius,
      paintFlow: patch.flow ?? state.paintFlow,
      paintHardness: patch.hardness ?? state.paintHardness,
    })),

    setGeomPaint: (nodeId, geomName, layer) => {
      const existing = findNode(get().sceneGraph.nodes, nodeId);
      const index = existing?.geoms?.findIndex((geom: SceneGeom) => geom.name === geomName) ?? -1;
      if (index === -1) return;

      get().recordInteraction('paint');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node?.geoms?.[index]) return;
      if (layer) node.geoms[index].paint = layer;
      else delete node.geoms[index].paint;

      // Deliberately no recompile.
      //
      // Every other geom edit has to rebuild the MJCF and swap the model in the
      // physics worker, because every other geom edit changes something MuJoCo
      // reads. Paint is not one: the emitter names the attributes it writes, no
      // exporter reads vertex colour, and the viewport takes a geom's colour off
      // the scene graph rather than out of the compiled model. Rebuilding here
      // would drop the simulation back to its initial pose once per stroke to
      // change nothing the simulation can see.
      set({ sceneGraph: newScene });
    },

    setGeomTextures: (nodeId, geomName, textures) => {
      const existing = findNode(get().sceneGraph.nodes, nodeId);
      const index = existing?.geoms?.findIndex((geom: SceneGeom) => geom.name === geomName) ?? -1;
      if (index === -1) return;

      get().recordInteraction('pattern');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node?.geoms?.[index]) return;
      if (textures?.length) node.geoms[index].textures = textures;
      else delete node.geoms[index].textures;
      // No recompile, for the reason setGeomPaint gives: the physics is the
      // shape as authored, and the viewport and the exporters read the
      // patterns off the scene graph (utils/geomSurface).
      set({ sceneGraph: newScene });
    },

    setGeomFaceSplits: (nodeId, geomName, splits, recordUndo = true) => {
      const existing = findNode(get().sceneGraph.nodes, nodeId);
      if (!existing?.geoms?.some((geom: SceneGeom) => geom.name === geomName)) return;
      if (recordUndo) get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const geom = findNode(newScene.nodes, nodeId)?.geoms?.find((g: SceneGeom) => g.name === geomName);
      if (!geom) return;
      if (splits?.length) geom.faceSplits = splits;
      else delete geom.faceSplits;
      // No recompile: a seam changes no shape (see setGeomTextures).
      set({ sceneGraph: newScene });
    },

    setGeomColor: (nodeId, geomName, rgba) => {
      get().recordInteraction('node-geom');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node?.geoms?.length) return;

      // No name means the whole body, which is what colouring an imported mesh or
      // a boolean body usually means — those arrive as several geoms and leaving
      // some of them the old colour is never what was asked for.
      const targets = geomName ? node.geoms.filter((g: SceneGeom) => g.name === geomName) : node.geoms;
      if (!targets.length) return;
      for (const geom of targets) {
        geom.rgba = [rgba[0] ?? 0.8, rgba[1] ?? 0.8, rgba[2] ?? 0.8, rgba[3] ?? geom.rgba?.[3] ?? 1];
      }
      if (!geomName && node.isCurve && targets[0].rgba) {
        (node as SceneNode & { rgba?: number[] }).rgba = [...targets[0].rgba];
      }

      // Base colour does go into the MJCF, unlike paint, so this one recompiles —
      // once for the whole body rather than once per geom.
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, true);
    },

    setGeomColorsBatch: (entries) => {
      if (!entries.length) return 0;
      get().recordInteraction('node-geom');
      const newScene = cloneSceneGraph(get().sceneGraph);
      let colored = 0;
      for (const entry of entries) {
        const node = findNode(newScene.nodes, entry.nodeId);
        if (!node) continue;
        const explicitAlpha = entry.rgba.length === 4 ? entry.rgba[3] : undefined;
        if (node.cloth) {
          if (node.cloth.garment) {
            if (entry.geomName) {
              const attached = node.cloth.garment.attached ?? [];
              node.cloth = {
                ...node.cloth,
                garment: {
                  ...node.cloth.garment,
                  attached: attached.map((a) =>
                    a.name === entry.geomName
                      ? { ...a, rgba: [entry.rgba[0], entry.rgba[1], entry.rgba[2], explicitAlpha ?? a.rgba?.[3] ?? 1] }
                      : a,
                  ),
                },
              };
              colored += 1;
            } else {
              const c = [entry.rgba[0], entry.rgba[1], entry.rgba[2], explicitAlpha ?? node.cloth.garment.rgba?.[3] ?? 1];
              node.cloth = { ...node.cloth, garment: { ...node.cloth.garment, rgba: c } };
              colored += 1;
            }
          } else {
            const pieces = node.cloth.pieces ?? [];
            node.cloth = {
              ...node.cloth,
              pieces: pieces.map((p) =>
                !entry.geomName || p.name === entry.geomName
                  ? { ...p, rgba: [entry.rgba[0], entry.rgba[1], entry.rgba[2], explicitAlpha ?? p.rgba?.[3] ?? 1] }
                  : p,
              ),
            };
            colored += entry.geomName ? 1 : pieces.length;
          }
          continue;
        }
        if (!node.geoms?.length) continue;
        const targets = entry.geomName ? node.geoms.filter((g: SceneGeom) => g.name === entry.geomName) : node.geoms;
        for (const geom of targets) {
          geom.rgba = [entry.rgba[0] ?? 0.8, entry.rgba[1] ?? 0.8, entry.rgba[2] ?? 0.8, explicitAlpha ?? geom.rgba?.[3] ?? 1];
          colored += 1;
        }
        if (!entry.geomName && node.isCurve && targets[0]?.rgba) {
          (node as SceneNode & { rgba?: number[] }).rgba = [...targets[0].rgba];
        }
      }
      if (colored > 0) {
        set({ sceneGraph: newScene });
        get().recompile(newScene, undefined, true);
      }
      return colored;
    },

    clearAllPaint: () => {
      get().recordInteraction('paint');
      const newScene = cloneSceneGraph(get().sceneGraph);
      let found = false;
      const walk = (nodes: SceneNode[]) => {
        for (const node of nodes || []) {
          for (const geom of node.geoms || []) {
            if (geom.paint) { delete geom.paint; found = true; }
          }
          walk(node.children);
        }
      };
      walk(newScene.nodes);
      if (found) set({ sceneGraph: newScene });
    },
  };
}
