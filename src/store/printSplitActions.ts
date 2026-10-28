// ---------------------------------------------------------------------------
// Split for Print: cutting a body into sections that each fit the bed, with
// the joints that hold them together again
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom, SceneJoint } from '../types/scene';
import { nodeWorldMatrix } from '../utils/combineBodies';
import { colliderTemplateOf, hullsToColliderGeoms, meshVolumeAndCentroid, usableColliderHulls } from '../utils/csg';
import { collisionHashOf } from '../utils/convexDecomposition';
import type { FaceSplit, SurfaceTexture } from '../utils/surfaceTexture';
import type { SplitSection } from '../utils/printSplit';
import { featureGeoms } from '../utils/printAssembly';
import { pieceHolding } from '../utils/splitPieces';
import { cloneSceneGraph, findNode } from './sceneClone';
import type { SliceDeps } from './sliceDeps';

/**
 * Edits one cut and re-derives the primitive underneath it.
 *
 * Every cut edit is the same three steps — change the intent, work the geometry
 * out again from the part's own surface, publish — and doing them in one place
 * is what keeps `pos`, `quat` and `size` from ever disagreeing with the spot
 * and depth they are supposed to express.
 */
/**
 * Rebuilds the physics model after an edit to a body's shapes — unless the
 * edit left a boolean body's mesh stale, in which case the build is skipped.
 *
 * useCsgAutoCompile notices the stale hash, evaluates the boolean and runs
 * its own build a moment later. Building here as well means every cut edit
 * costs two model builds, and the first one installs colliders for a mesh
 * that is about to be replaced: pure waste, and a visible stutter before the
 * real result lands. The scene graph itself is already set by the caller, so
 * the panel shows the edit at once either way.
 */
/**
 * Split for Print's section colours: far enough apart that every seam shows,
 * and none of them the selection or warning colours.
 */
const SECTION_COLOURS: [number, number, number][] = [
  [0.36, 0.55, 0.85], [0.92, 0.6, 0.25], [0.4, 0.72, 0.5], [0.78, 0.45, 0.72],
  [0.85, 0.78, 0.35], [0.35, 0.7, 0.75], [0.7, 0.55, 0.42], [0.55, 0.5, 0.85],
];

export interface PrintSplitActions {
  /**
   * Replace a body with the sections Split for Print cut it into: the first
   * keeps the body's id, the rest are new siblings in the same place, each
   * carrying how it is printed (`printPose`) and its exact pin and socket
   * colliders. One undo step. Returns the bodies' ids, in section order.
   */
  splitBodyForPrint: (
    nodeId: string,
    sections: Pick<SplitSection, 'positions' | 'faces' | 'plainPositions' | 'plainFaces' | 'up' | 'spin' | 'colliders' | 'volumeMm3' | 'convexPieces'>[],
    /** Other bodies whose geometry went into the sections — attached children, or bodies selected with it — to remove. */
    absorbed?: string[],
    /**
     * A plain cut (the knife's) rather than a split for print: the pieces keep
     * the part's colour and are given no print pose. `carry`, a section
     * each: the patterns and seams it keeps (utils/knife carryAcrossCut).
     */
    opts?: {
      plain?: boolean;
      carry?: { textures?: SurfaceTexture[]; faceSplits?: FaceSplit[] }[];
      names?: string[];
      centerOrigin?: boolean;
      placement?: 'replace' | 'beside';
    },
  ) => string[];
}

export function printSplitActions({ set, get }: SliceDeps): PrintSplitActions {
  return {
    splitBodyForPrint: (nodeId, sections, absorbed = [], opts = {}) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node || sections.length === 0) return [nodeId];
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const first = findNode(newScene.nodes, nodeId);
      if (!first) return [nodeId];

      const solid = (first.geoms || []).filter((g: SceneGeom) =>
        g.csg !== 'difference' && !g.csgDerived && g.role !== 'collision' && g.role !== 'visual');
      const template: SceneGeom | undefined = solid[0] ?? first.geoms?.[0];
      // What it weighs is shared out by volume when it was stated; otherwise
      // each section is weighed from its own volume at the body's density.
      const totalMass = first.csgMass ?? (solid.length && solid.every((g: SceneGeom) => g.mass !== undefined)
        ? solid.reduce((m: number, g: SceneGeom) => m + (g.mass ?? 0), 0)
        : undefined);
      const density = solid.find((g: SceneGeom) => g.density !== undefined)?.density;
      const totalVolume = sections.reduce((v, sec) => v + sec.volumeMm3, 0) || 1;
      // The sections are cut from the triangles as drawn, which already carry a
      // rotation that was baked into the vertices (see rotationIsBaked in
      // mjcf.ts) — so that rotation must not be applied to them a second time.
      const baked = (first.geoms || []).length > 0
        && first.geoms.every((g: SceneGeom) => g.type === 'mesh')
        && first.geoms.some((g: SceneGeom) =>
          (Array.isArray(g.baseVertices) && g.baseVertices.length > 0) ||
          (Array.isArray(g.baseRenderVertices) && g.baseRenderVertices.length > 0));

      const geomsFor = (id: string, sec: (typeof sections)[number], k: number): SceneGeom[] => {
        const rgba = opts.plain && template?.rgba
          ? [...template.rgba]
          : [...SECTION_COLOURS[k % SECTION_COLOURS.length], template?.rgba?.[3] ?? 1];
        const renderVertices = Array.from(sec.positions);
        const vertices: number[] = new Array(renderVertices.length);
        for (let i = 0; i < renderVertices.length; i += 3) {
          vertices[i] = renderVertices[i];
          vertices[i + 1] = renderVertices[i + 2];
          vertices[i + 2] = -renderVertices[i + 1];
        }
        return [
          {
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba,
            dynamic: true,
            ...(template?.friction ? { friction: [...template.friction] } : {}),
            ...(template?.condim !== undefined ? { condim: template.condim } : {}),
            ...(totalMass !== undefined
              ? { mass: +(totalMass * (sec.volumeMm3 / totalVolume)).toPrecision(6) }
              : density !== undefined ? { density } : {}),
            vertices,
            renderVertices,
            faces: Array.from(sec.faces),
            colliderVertices: Array.from(sec.plainPositions),
            colliderFaces: Array.from(sec.plainFaces),
            ...(opts.carry?.[k]?.textures?.length ? { textures: opts.carry[k].textures } : {}),
            ...(opts.carry?.[k]?.faceSplits?.length ? { faceSplits: opts.carry[k].faceSplits } : {}),
          },
          ...featureGeoms(sec.colliders, id, rgba),
        ];
      };
      /*
        A concave section collides as the exact convex pieces it was cut into,
        installed here as its decomposition. Its hull would fill the corner its
        neighbour sits in, and V-HACD only approximates, so either way two
        halves of an L would stand apart at their seam.
      */
      const installPieces = (n: SceneNode, sec: (typeof sections)[number]) => {
        if (!sec.convexPieces.length) return;
        const mesh = n.geoms[0];
        const hulls = usableColliderHulls(sec.convexPieces.map((piece) => {
          const verts = Array.from(piece.positions);
          const faces = Array.from(piece.faces);
          return { verts, faces, ...meshVolumeAndCentroid(verts, faces) };
        }));
        const volume = hulls.reduce((v, h) => v + h.volume, 0);
        const mass = mesh.mass ?? (mesh.density ?? 1000) * volume;
        const colliders = hullsToColliderGeoms(hulls, n.name || n.id, colliderTemplateOf(mesh, mesh.rgba ?? [0.3, 0.6, 0.9, 1]), mass);
        if (!colliders.length) return;
        n.geoms.push(...colliders);
        n.collisionDecomposed = true;
        n.collisionHash = collisionHashOf(n);
      };
      const poseOf = (sec: (typeof sections)[number]) => ({ up: [...sec.up] as [number, number, number], spin: sec.spin });

      // Everything that would regenerate the body's geometry from a recipe has
      // to go: the sections ARE the geometry now, and a wedge's or a lattice's
      // recipe would quietly rebuild the whole part over them.
      const GENERATORS = [
        'isWedge', 'isPyramid', 'isCone', 'isTorus', 'isTube', 'isCurve', 'curvePoints',
        'isLattice', 'latticeCage', 'latticeSubdiv', 'latticeThickness', 'latticeOrigin', 'latticeVersion', 'latticeBaked', 'latticeEdited',
        'isSculpt', 'sculptBase', 'sculptVersion', 'sculptEdited',
        'scad', 'csgEnabled', 'csgCollision', 'csgSectors', 'csgFn', 'csgHoleAxis', 'csgMass', 'csgHash', 'csgScad',
        'csgVolume', 'csgHullVolume', 'csgCentroid', 'csgWarning', 'csgError', 'edgeRounds', 'edgeRoundsLost',
        'collisionHash', 'collisionDecomposed', 'collisionSolidity', 'collisionWarning', 'collisionError',
      ] as const;
      const strip = (n: SceneNode) => {
        for (const key of GENERATORS) delete (n as unknown as Record<string, unknown>)[key];
        if (baked) { delete n.euler; delete n.quat; }
      };

      // The other bodies the sections were cut from — children of this one, or
      // others selected with it — are in the sections now, wherever they hung.
      if (opts.placement !== 'beside' && absorbed.length) {
        const gone = new Set(absorbed.filter((id) => id !== nodeId));
        const prune = (list: SceneNode[]): SceneNode[] => list
          .filter((c) => !gone.has(c.id))
          .map((c) => { c.children = prune(c.children || []); return c; });
        newScene.nodes = prune(newScene.nodes);
      }
      const recenterSection = (sec: (typeof sections)[number]): { sec: (typeof sections)[number]; offset: [number, number, number] } => {
        if (!opts.centerOrigin || sec.positions.length < 3) {
          return { sec, offset: [0, 0, 0] };
        }
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < sec.positions.length; i += 3) {
          const x = sec.positions[i], y = sec.positions[i + 1], z = sec.positions[i + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const cx = 0.5 * (minX + maxX);
        const cy = 0.5 * (minY + maxY);
        const cz = 0.5 * (minZ + maxZ);
        const shiftBuf = (buf: Float32Array): Float32Array => {
          const out = new Float32Array(buf.length);
          for (let i = 0; i < buf.length; i += 3) {
            out[i] = buf[i] - cx;
            out[i + 1] = buf[i + 1] - cy;
            out[i + 2] = buf[i + 2] - cz;
          }
          return out;
        };
        return {
          offset: [cx, cy, cz],
          sec: {
            ...sec,
            positions: shiftBuf(sec.positions),
            plainPositions: shiftBuf(sec.plainPositions),
            convexPieces: sec.convexPieces.map((p) => ({ positions: shiftBuf(p.positions), faces: p.faces })),
            colliders: sec.colliders.map((c) => (c.shape === 'prism'
              ? { ...c, positions: c.positions.map((v, i) => v - (i % 3 === 0 ? cx : i % 3 === 1 ? cy : cz)) }
              : { ...c, pos: [c.pos[0] - cx, c.pos[1] - cy, c.pos[2] - cz] as [number, number, number] })),
          },
        };
      };

      const baseName = first.name || first.id;
      const basePos: [number, number, number] = [first.pos?.[0] ?? 0, first.pos?.[1] ?? 0, first.pos?.[2] ?? 0];

      const siblings = (() => {
        const walk = (list: SceneNode[]): SceneNode[] | null => {
          for (const n of list) {
            if (n.id === nodeId) return list;
            const found = walk(n.children || []);
            if (found) return found;
          }
          return null;
        };
        return walk(newScene.nodes) ?? newScene.nodes;
      })();
      const at = siblings.indexOf(first);

      if (opts.placement === 'beside') {
        // Keep original body untouched and place all split sections beside it along +X.
        let allMinX = Infinity, allMaxX = -Infinity;
        for (const s of sections) {
          for (let i = 0; i < s.positions.length; i += 3) {
            const x = s.positions[i];
            if (x < allMinX) allMinX = x;
            if (x > allMaxX) allMaxX = x;
          }
        }
        const spanX = Number.isFinite(allMaxX - allMinX) ? Math.max(0.05, allMaxX - allMinX) : 0.25;
        const shiftX = spanX + 0.08;
        const strippedTemplate: SceneNode = JSON.parse(JSON.stringify(first));
        strip(strippedTemplate);
        const { children: _children, geoms: _geoms, ...rest } = strippedTemplate;
        void _children; void _geoms;

        const ids: string[] = [];
        sections.forEach((rawSec, k) => {
          const { sec, offset } = recenterSection(rawSec);
          const id = `split_${Math.random().toString(36).substring(2, 10)}`;
          ids.push(id);
          const name = opts.names?.[k] || `${baseName}_part${k + 1}`;
          const copy: SceneNode = JSON.parse(JSON.stringify(rest));
          const section: SceneNode = {
            ...copy,
            id,
            name,
            pos: opts.centerOrigin
              ? [basePos[0] + shiftX + offset[0], basePos[1] + offset[1], basePos[2] + offset[2]]
              : [basePos[0] + shiftX, basePos[1], basePos[2]],
            joints: (first.joints || []).map((j: SceneJoint) => ({ ...j, name: `${name}_${String(j.name || 'joint').split('_').pop()}` })),
            weldTargetId: undefined,
            coupleTargetId: undefined,
            connectTargetId: undefined,
            script: undefined,
            geoms: geomsFor(name, sec, k),
            printPose: opts.plain ? undefined : poseOf(sec),
            children: [],
          };
          installPieces(section, sec);
          siblings.splice(at + 1 + k, 0, section);
        });
        set({ sceneGraph: newScene, extraSelectedIds: [] });
        get().recompile(newScene, undefined, true);
        return ids;
      }

      strip(first);
      const firstCentered = recenterSection(sections[0]);
      if (opts.centerOrigin) {
        first.pos = [basePos[0] + firstCentered.offset[0], basePos[1] + firstCentered.offset[1], basePos[2] + firstCentered.offset[2]];
      }
      if (opts.names?.[0]) first.name = opts.names[0];
      first.geoms = geomsFor(first.name || first.id, firstCentered.sec, 0);
      if (opts.plain) delete first.printPose;
      else first.printPose = poseOf(firstCentered.sec);
      installPieces(first, firstCentered.sec);

      const ids = [nodeId];
      const pieceNodes: SceneNode[] = [first];
      const offsets: [number, number, number][] = [firstCentered.offset];
      sections.slice(1).forEach((rawSec, k) => {
        const { sec, offset } = recenterSection(rawSec);
        const id = `split_${Math.random().toString(36).substring(2, 10)}`;
        ids.push(id);
        offsets.push(offset);
        // Named for the part it came from; uniqueNames settles any clash.
        const name = opts.names?.[k + 1] || `${baseName}_part${k + 2}`;
        const { children: _children, geoms: _geoms, ...rest } = first;
        void _children; void _geoms;
        const copy: SceneNode = JSON.parse(JSON.stringify(rest));
        const section: SceneNode = {
          ...copy,
          id,
          name,
          pos: opts.centerOrigin
            ? [basePos[0] + offset[0], basePos[1] + offset[1], basePos[2] + offset[2]]
            : copy.pos,
          joints: (first.joints || []).map((j: SceneJoint) => ({ ...j, name: `${name}_${String(j.name || 'joint').split('_').pop()}` })),
          // A section cut off a welded part is not welded to anything, and a
          // script written for the whole part does not know about this piece.
          weldTargetId: undefined,
          coupleTargetId: undefined,
          connectTargetId: undefined,
          script: undefined,
          geoms: geomsFor(name, sec, k + 1),
          printPose: opts.plain ? undefined : poseOf(sec),
          children: [],
        };
        installPieces(section, sec);
        pieceNodes.push(section);
        siblings.splice(at + 1 + k, 0, section);
      });

      /*
        Everything that hung off the part, or was welded or pinned to it, used to
        stay with the first piece, which keeps the part's id: a screw seated in
        the other half rode along with the wrong one. Each goes to the piece it
        is in (or nearest), placed where it was. Points are in the part's frame,
        which is the frame the sections are in, except where a rotation was baked
        into the mesh -- there the old behaviour stands.
      */
      if (!baked) {
        const children = first.children || [];
        first.children = [];
        for (const child of children) {
          const p = child.pos ?? [0, 0, 0];
          const k = sections.length > 1 ? pieceHolding(sections, p) : 0;
          child.pos = [p[0] - offsets[k][0], p[1] - offsets[k][1], p[2] - offsets[k][2]];
          pieceNodes[k].children = [...(pieceNodes[k].children || []), child];
        }
        const partWorld = nodeWorldMatrix(get().sceneGraph.nodes, nodeId);
        if (partWorld && sections.length > 1) {
          const intoPart = partWorld.clone().invert();
          const retarget = (list: SceneNode[]) => {
            for (const n of list) {
              if ((n.weldTargetId === nodeId || n.connectTargetId === nodeId) && !ids.includes(n.id)) {
                const world = nodeWorldMatrix(get().sceneGraph.nodes, n.id);
                if (world) {
                  const p = new THREE.Vector3().setFromMatrixPosition(world).applyMatrix4(intoPart);
                  const k = pieceHolding(sections, [p.x, p.y, p.z]);
                  if (n.weldTargetId === nodeId) n.weldTargetId = ids[k];
                  if (n.connectTargetId === nodeId) n.connectTargetId = ids[k];
                }
              }
              retarget(n.children || []);
            }
          };
          retarget(newScene.nodes);
        }
      }
      set({ sceneGraph: newScene, extraSelectedIds: [] });
      get().recompile(newScene, undefined, true);
      return ids;
    },
  };
}
