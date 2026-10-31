// ---------------------------------------------------------------------------
// Split for Print: cutting a body into sections that each fit the bed, with
// the joints that hold them together again
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom, SceneJoint } from '../types/scene';
import { getGeomFrame, getNodeWorldTransform } from '../utils/laserCutExporter';
import { resolveCsgGeoms } from '../utils/csg';
import { isBoughtIn } from '../utils/boughtIn';
import { colouredGeomTriangles } from '../utils/printColours';
import { needsColourCarry, sectionPaint, type ColourSource } from '../utils/sectionPaint';
import { isNodeRotationBaked } from '../utils/sceneTree';
import { colliderTemplateOf, hullsToColliderGeoms, meshVolumeAndCentroid, statedBooleanMass, usableColliderHulls } from '../utils/csg';
import { collisionHashOf } from '../utils/convexDecomposition';
import type { FaceSplit, SurfaceTexture } from '../utils/surfaceTexture';
import type { SplitSection } from '../utils/printSplit';
import { featureGeoms } from '../utils/printAssembly';
import { pieceHolding } from '../utils/splitPieces';
import { cloneSceneGraph, findNode } from './sceneClone';
import type { PrintBed } from '../utils/printBedSettings';
import type { SliceDeps } from './sliceDeps';

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
     * A plain cut (the knife's) rather than a split for print: the pieces are
     * given no print pose. `carry`, a section
     * each: the patterns and seams it keeps (utils/knife carryAcrossCut).
     */
    opts?: {
      plain?: boolean;
      carry?: { textures?: SurfaceTexture[]; faceSplits?: FaceSplit[] }[];
      names?: string[];
      centerOrigin?: boolean;
      placement?: 'replace' | 'beside';
      /** The bed and margin the split was made for, recorded on each print pose for the plate. */
      cutFor?: { bed: PrintBed; marginMm: number };
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

      // A body that fits the bed whole is not cut, so nothing about it changes
      // but which way up it prints: its recipe, colour and paint all stay. With
      // other bodies taken in it is still made one mesh, which is what makes
      // them print as one piece.
      const taken = absorbed.filter((id) => id !== nodeId);
      const cutFor = opts.cutFor
        ? { bedMm: [opts.cutFor.bed.widthMm, opts.cutFor.bed.depthMm, opts.cutFor.bed.heightMm] as [number, number, number], marginMm: opts.cutFor.marginMm }
        : undefined;
      if (sections.length === 1 && !opts.plain && !taken.length && opts.placement !== 'beside') {
        first.printPose = { up: [...sections[0].up] as [number, number, number], spin: sections[0].spin, ...(cutFor ? { cutFor } : {}) };
        set({ sceneGraph: newScene });
        return [nodeId];
      }

      // Every body's world frame before the change, by the rule the soups were
      // taken with (a baked rotation is in the vertices, not the frame).
      const worlds = new Map<string, THREE.Matrix4>();
      const walkWorlds = (list: SceneNode[], parent?: THREE.Matrix4) => {
        for (const n of list) {
          const world = getNodeWorldTransform(n, parent);
          worlds.set(n.id, world);
          walkWorlds(n.children || [], world);
        }
      };
      walkWorlds(get().sceneGraph.nodes);
      const intoPart = (worlds.get(nodeId) ?? new THREE.Matrix4()).clone().invert();

      // The part is this body and the ones absorbed into it: a bare root holding
      // its panels (the birdhouse) has no geoms of its own, and its sections take
      // what they are made of, and what they weigh, from the panels.
      const gone = new Set(absorbed.filter((id) => id !== nodeId));
      const madeOf = [first, ...[...gone].map((id) => findNode(newScene.nodes, id)).filter((n): n is SceneNode => !!n)];
      const solidOf = (n: SceneNode) => (n.geoms || []).filter((g: SceneGeom) =>
        g.csg !== 'difference' && !g.csgDerived && g.role !== 'collision' && g.role !== 'visual');
      const solid = madeOf.flatMap(solidOf);
      const template: SceneGeom | undefined = solid[0] ?? first.geoms?.[0];
      // What it weighs is shared out by volume when it was stated; otherwise
      // each section is weighed from its own volume at the body's density.
      const massOf = (n: SceneNode): number | undefined => {
        const own = solidOf(n);
        return (n.csgEnabled ? statedBooleanMass(n) : n.csgMass) ?? (own.length && own.every((g: SceneGeom) => g.mass !== undefined)
          ? own.reduce((m: number, g: SceneGeom) => m + (g.mass ?? 0), 0)
          : undefined);
      };
      const weighed = madeOf.filter((n) => solidOf(n).length || n.csgEnabled);
      const masses = weighed.map(massOf);
      const totalMass = weighed.length && masses.every((m) => m !== undefined)
        ? masses.reduce((a: number, m) => a + (m ?? 0), 0)
        : undefined;
      const density = solid.find((g: SceneGeom) => g.density !== undefined)?.density;

      // Every piece is in the part's colour, with the part's paint and the
      // colours of its other geoms laid on as paint (utils/sectionPaint): the
      // 3MF prints each piece as the part was drawn. They used to be given a
      // colour each, so the seams showed, and printed in it.
      const rgba = template?.rgba ? [...template.rgba] : [0.8, 0.8, 0.8, 1];
      const colourSources: ColourSource[] = [];
      for (const n of madeOf) {
        if (isBoughtIn(n)) continue;
        const toPart = intoPart.clone().multiply(worlds.get(n.id) ?? new THREE.Matrix4());
        for (const geom of resolveCsgGeoms(n, 'render')) {
          if (geom.role === 'collision') continue;
          const frame = getGeomFrame(geom);
          // A plain geom in the part's own colour leaves its stretch bare.
          if (!geom.paint && !needsColourCarry([{ tris: [], colors: null, rgba: geom.rgba ?? [0.8, 0.8, 0.8, 1] }], rgba)) continue;
          const piece = colouredGeomTriangles(geom, frame.halfLen, new THREE.Matrix4().multiplyMatrices(toPart, frame.matrix));
          if (piece) colourSources.push({ ...piece, rgba: geom.rgba ?? [0.8, 0.8, 0.8, 1] });
        }
      }
      const carryColour = needsColourCarry(colourSources, rgba);
      const totalVolume = sections.reduce((v, sec) => v + sec.volumeMm3, 0) || 1;
      // The sections are cut from the triangles as drawn, which already carry a
      // rotation that was baked into the vertices (see rotationIsBaked in
      // mjcf.ts) — so that rotation must not be applied to them a second time.
      const baked = (first.geoms || []).length > 0
        && first.geoms.every((g: SceneGeom) => g.type === 'mesh')
        && first.geoms.some((g: SceneGeom) =>
          (Array.isArray(g.baseVertices) && g.baseVertices.length > 0) ||
          (Array.isArray(g.baseRenderVertices) && g.baseRenderVertices.length > 0));

      const geomsFor = (id: string, sec: (typeof sections)[number], k: number, offset: number[] = [0, 0, 0]): SceneGeom[] => {
        const paint = carryColour ? sectionPaint(colourSources, sec.positions, sec.faces, rgba, offset) : undefined;
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
            rgba: [...rgba],
            dynamic: true,
            ...(paint ? { paint } : {}),
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
      const poseOf = (sec: (typeof sections)[number]) => ({ up: [...sec.up] as [number, number, number], spin: sec.spin, ...(cutFor ? { cutFor } : {}) });

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
      // What hung off them and was not taken in (a hinged lid, a seated screw)
      // is not part of the cut: it stays, re-hung from the piece it is in, where
      // it was. Its pose is put in the part's frame here, with the old graph's
      // frames; a baked body's rotation lives in its vertices, so only its
      // position moves.
      const rescued: SceneNode[] = [];
      if (opts.placement !== 'beside' && gone.size) {
        for (const id of gone) {
          for (const child of findNode(newScene.nodes, id)?.children || []) {
            if (gone.has(child.id)) continue;
            const world = worlds.get(child.id);
            if (world) {
              const rel = intoPart.clone().multiply(world);
              const p = new THREE.Vector3(), q = new THREE.Quaternion();
              rel.decompose(p, q, new THREE.Vector3());
              child.pos = [p.x, p.y, p.z];
              if (!isNodeRotationBaked(child)) { child.quat = [q.w, q.x, q.y, q.z]; delete child.euler; }
            }
            rescued.push(child);
          }
        }
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
            geoms: geomsFor(name, sec, k, offset),
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
      first.geoms = geomsFor(first.name || first.id, firstCentered.sec, 0, firstCentered.offset);
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
          geoms: geomsFor(name, sec, k + 1, offset),
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
      if (baked) {
        first.children = [...(first.children || []), ...rescued];
      } else {
        const children = [...(first.children || []), ...rescued];
        first.children = [];
        for (const child of children) {
          const p = child.pos ?? [0, 0, 0];
          const k = sections.length > 1 ? pieceHolding(sections, p) : 0;
          child.pos = [p[0] - offsets[k][0], p[1] - offsets[k][1], p[2] - offsets[k][2]];
          pieceNodes[k].children = [...(pieceNodes[k].children || []), child];
        }
      }
      // A body welded or connected to the part, or to a body absorbed into it,
      // goes to the piece it is in or nearest. A baked part keeps the old rule
      // for its children (all on the first piece), and so for these.
      const intoIt = (id: string | undefined) => !!id && (id === nodeId || gone.has(id));
      const retarget = (list: SceneNode[]) => {
        for (const n of list) {
          if ((intoIt(n.weldTargetId) || intoIt(n.connectTargetId)) && !ids.includes(n.id)) {
            const world = worlds.get(n.id);
            let k = 0;
            if (world && !baked && sections.length > 1) {
              const p = new THREE.Vector3().setFromMatrixPosition(world).applyMatrix4(intoPart);
              k = pieceHolding(sections, [p.x, p.y, p.z]);
            }
            if (intoIt(n.weldTargetId)) n.weldTargetId = ids[k];
            if (intoIt(n.connectTargetId)) n.connectTargetId = ids[k];
          }
          retarget(n.children || []);
        }
      };
      retarget(newScene.nodes);
      set({ sceneGraph: newScene, extraSelectedIds: [] });
      get().recompile(newScene, undefined, true);
      return ids;
    },
  };
}
