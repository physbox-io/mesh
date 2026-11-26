import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { useStore } from '../src/store/useStore';
import { useDentStore, dentKey, deformedGeometry } from '../src/store/dentStore';
import { useGarmentSculpt } from '../src/store/garmentSculptStore';
import { openingScene, useSceneLoad } from '../src/store/sceneLoadStore';
import { markUserEdit } from '../src/store/editGuard';
import { clonePlain, cloneSceneGraph, type WorkingGeom, type WorkingNode } from '../src/store/sceneClone';
import { translateMeshGeoms, toRenderVertices } from '../src/store/meshGeomTransforms';
import { dentBody } from '../src/store/breakage';
import { shareUnchanged } from '../src/utils/shareUnchanged';
import { rewriteGeom } from '../src/utils/combineBodies';
import { copyBodies, pasteBodies } from '../src/utils/duplicateNodes';
import { decomposeInChunks } from '../src/utils/chunkedDecomposition';
import { cutAtReflexEdges, cutCurved } from '../src/utils/reflexCuts';
import {
  DECOMPOSE_TIMEOUT_MS,
  decomposeMeshOffThread,
  setVhacdWorkerFactory,
  vhacdJobsPending,
  type WorkerLike,
} from '../src/utils/vhacdWorkerClient';
import { compileToMJCF } from '../src/utils/mjcf';
import { csgHashOf } from '../src/utils/csg';
import { collisionHashOf } from '../src/utils/convexDecomposition';
import { generateGearGeoms } from '../src/presets/presetScenes';
import { boxLattice, serializeCage, toSceneGeom } from '../src/utils/latticeMesh';
import { ConvexMeshDecomposition } from '../src/vendor/vhacd/vhacd.js';
import instantiateVhacd from '../src/vendor/vhacd/vhacd-wasm.js';
import * as physicsEngine from '../src/store/physicsEngine';
import { denseCollidersSettled } from '../src/store/denseColliders';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { VhacdRequest, VhacdResponse } from '../src/workers/vhacdProtocol';

const tick = () => new Promise((r) => setTimeout(r, 0));

const boxNode = (id: string, pos: [number, number, number] = [0, 0, 0.1], extra: Partial<SceneNode> = {}): SceneNode => ({
  id,
  name: id,
  type: 'body',
  pos,
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.05, 0.05, 0.05], rgba: [0.5, 0.5, 0.5, 1] }],
  joints: [],
  children: [],
  ...extra,
} as SceneNode);

// Unit cube in Three.js Y-up space: x in [-0.1, 0.1], y in [0, 0.2], z in [-0.1, 0.1]
// Maps to MuJoCo Z-up: x in [-0.1, 0.1], y in [-0.1, 0.1], z in [0, 0.2]
const UNIT_CUBE_YUP = [
  -0.1, 0.0, -0.1,  0.1, 0.0, -0.1,  0.1, 0.0, 0.1,  -0.1, 0.0, 0.1,
  -0.1, 0.2, -0.1,  0.1, 0.2, -0.1,  0.1, 0.2, 0.1,  -0.1, 0.2, 0.1,
];
const UNIT_CUBE_ZUP = toRenderVertices(UNIT_CUBE_YUP);
const UNIT_CUBE_FACES = [
  0, 1, 2,  0, 2, 3,
  4, 6, 5,  4, 7, 6,
  0, 4, 5,  0, 5, 1,
  1, 5, 6,  1, 6, 2,
  2, 6, 7,  2, 7, 3,
  3, 7, 4,  3, 4, 0,
];

function signedVolume(verts: number[], faces: number[]): number {
  let vol6 = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3;
    const b = faces[i + 1] * 3;
    const c = faces[i + 2] * 3;
    vol6 +=
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) +
      verts[a + 1] * (verts[b + 2] * verts[c] - verts[b] * verts[c + 2]) +
      verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  return vol6 / 6;
}

describe('Section 7 Store & V-HACD Audit Fixes', () => {
  const origRecompile = useStore.getState().recompile;

  beforeEach(async () => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useDentStore.getState().clear();
    useGarmentSculpt.getState().set({ target: null });
    useStore.setState({
      recompile: vi.fn(async () => {}),
      sceneGraph: { nodes: [boxNode('a'), boxNode('b', [0.3, 0, 0.1])] },
      activePreset: 'pendulum',
      selectedNodeId: null,
      extraSelectedIds: [],
      activeGeomIndex: 0,
      geomFocused: false,
      draggedNodeId: null,
      dragTarget: null,
      edgeRoundSession: null,
      paintMode: false,
      measureMode: null,
      gestureStatus: null,
      castPrepGuardOpen: false,
      castPrepBusy: null,
      brokenConstraints: [],
      shatteredBodies: {},
      visibleShatteredBodies: {},
      deformedGeoms: {},
      model: null,
      data: null,
      undoStack: [],
      redoStack: [],
      tempUndoState: null,
      lastInteractionType: null,
      background: 'studio',
      waterLevel: null,
    });
    await tick();
  });

  afterEach(() => {
    useStore.setState({ recompile: origRecompile });
    vi.useRealTimers();
    setVhacdWorkerFactory(null);
  });

  // -------------------------------------------------------------------------
  // #2: External useStore.setState passes through sharingUnchangedNodes
  // -------------------------------------------------------------------------
  describe('#2 external useStore.setState middleware', () => {
    it('runs withUniqueNames, withoutDanglingReferences, shareUnchanged, and editGuard on useStore.setState', async () => {
      const a = boxNode('a');
      const b = boxNode('b', [0.2, 0, 0.1], { weldTargetId: 'missing_body' });
      // Duplicate geom name across bodies
      b.geoms[0].name = 'a_g';

      useStore.setState({ sceneGraph: { nodes: [a, b] } });
      const sg = useStore.getState().sceneGraph;
      expect(sg.nodes[1].geoms[0].name).toBe('a_g_2');
      expect(sg.nodes[1].weldTargetId).toBeUndefined();

      // Untouched node `a` is shared by reference when only `b` changes
      const cloned = cloneSceneGraph(sg);
      cloned.nodes[1].pos = [0.5, 0, 0.1];
      useStore.setState({ sceneGraph: cloned });
      expect(useStore.getState().sceneGraph.nodes[0]).toBe(sg.nodes[0]);
      expect(useStore.getState().sceneGraph.nodes[1]).not.toBe(sg.nodes[1]);

      // Cast-Prep editGuard blocks external useStore.setState when userEditPending is true
      const armedGraph: SceneGraph = {
        nodes: [boxNode('a')],
        castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      };
      useStore.setState({ sceneGraph: armedGraph });
      const before = useStore.getState().sceneGraph;
      markUserEdit();
      useStore.setState({ sceneGraph: { ...before, nodes: [boxNode('a', [1, 0, 0])] } });
      expect(useStore.getState().sceneGraph).toBe(before);
      expect(useStore.getState().castPrepGuardOpen).toBe(true);
      await tick();
    });
  });

  // -------------------------------------------------------------------------
  // #5, #32 & #72: sceneSwapActions & sceneLoadStore
  // -------------------------------------------------------------------------
  describe('#5, #32 & #72 sceneSwapActions & sceneLoadStore', () => {
    it('does not mutate activePreset or dispatch event on corrupt/missing user preset', () => {
      const events: Event[] = [];
      const origDispatch = globalThis.dispatchEvent;
      const spy = vi.fn((ev: Event) => { events.push(ev); return true; });
      (globalThis as unknown as { dispatchEvent: typeof spy }).dispatchEvent = spy;
      try {
        const prevGraph = useStore.getState().sceneGraph;
        useStore.setState({ activePreset: 'pendulum', selectedNodeId: 'a' });
        useStore.getState().loadPreset('user:definitely_does_not_exist_999');
        expect(useStore.getState().activePreset).toBe('pendulum');
        expect(useStore.getState().sceneGraph).toBe(prevGraph);
        expect(useStore.getState().selectedNodeId).toBe('a');
        expect(events).toHaveLength(0);
      } finally {
        (globalThis as unknown as { dispatchEvent: typeof origDispatch }).dispatchEvent = origDispatch;
      }
    });

    it('clears the 60s GIVE_UP_MS timeout in openingScene finally block', async () => {
      vi.useFakeTimers();
      await openingScene('test-fail', () => false);
      expect(useSceneLoad.getState().opening).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      const p = openingScene('test-ok', () => {
        useStore.setState((s) => ({ cameraResetToken: s.cameraResetToken + 1 }));
        return true;
      });
      await p;
      expect(useSceneLoad.getState().opening).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('bypasses Cast-Prep editGuard, clears breakage & transient tool states on loadPreset and loadGeneratedScene', () => {
      const armedGraph: SceneGraph = {
        nodes: [boxNode('a')],
        castPrep: { draftDeg: 3, draftMode: 'add', partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      };
      useStore.setState({
        sceneGraph: armedGraph,
        castPrepGuardOpen: true,
        selectedNodeId: 'a',
        extraSelectedIds: ['b'],
        activeGeomIndex: 2,
        geomFocused: true,
        draggedNodeId: 'a',
        dragTarget: { x: 1, y: 2, z: 3 },
        edgeRoundSession: { nodeId: 'a', base: [], editIndex: null, mode: 'fillet', size: 0.002, picked: [] },
        paintMode: true,
        measureMode: 'distance',
        brokenConstraints: ['a:b'],
        shatteredBodies: { a: [boxNode('shard_1')] },
        deformedGeoms: { 'a/a_g': { vertices: [0, 0, 0], renderVertices: [0, 0, 0], faces: [0, 0, 0] } },
      });
      useGarmentSculpt.getState().set({ target: 'garment_1' });
      useDentStore.getState().dent('a/a_g', UNIT_CUBE_ZUP, UNIT_CUBE_FACES, [0, 0, 0.2], [0, 0, 1], 0.01, 0.05);

      useStore.getState().loadGeneratedScene({ nodes: [boxNode('gen_part')] }, null);
      const s1 = useStore.getState();
      expect(s1.sceneGraph.nodes.map((n) => n.id)).toEqual(['gen_part']);
      expect(s1.castPrepGuardOpen).toBe(false);
      expect(s1.extraSelectedIds).toEqual([]);
      expect(s1.activeGeomIndex).toBe(0);
      expect(s1.geomFocused).toBe(false);
      expect(s1.draggedNodeId).toBeNull();
      expect(s1.dragTarget).toBeNull();
      expect(s1.edgeRoundSession).toBeNull();
      expect(s1.paintMode).toBe(false);
      expect(s1.measureMode).toBeNull();
      expect(s1.brokenConstraints).toEqual([]);
      expect(s1.shatteredBodies).toEqual({});
      expect(s1.deformedGeoms).toEqual({});
      expect(useDentStore.getState().dents).toEqual({});
      expect(useGarmentSculpt.getState().target).toBeNull();

      // Now test loadPreset while Cast-Prep is armed again
      useStore.setState({
        sceneGraph: armedGraph,
        castPrepGuardOpen: true,
        paintMode: true,
        measureMode: 'angle',
        extraSelectedIds: ['b'],
      });
      useGarmentSculpt.getState().set({ target: 'garment_2' });
      useStore.getState().loadPreset('empty');
      const s2 = useStore.getState();
      expect(s2.sceneGraph.nodes).toEqual([]);
      expect(s2.activePreset).toBe('empty');
      expect(s2.castPrepGuardOpen).toBe(false);
      expect(s2.paintMode).toBe(false);
      expect(s2.measureMode).toBeNull();
      expect(s2.extraSelectedIds).toEqual([]);
      expect(useGarmentSculpt.getState().target).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #10 & #56: geomActions (legacy cog heuristic & updateNodeScad)
  // -------------------------------------------------------------------------
  describe('#10 & #56 geomActions', () => {
    it('does not wipe mesh/SCAD/toothForm bodies whose id contains "gear", and preserves peg on legacy cogs', () => {
      const landingGear: SceneNode = {
        id: 'landing_gear',
        name: 'landing_gear',
        type: 'body',
        pos: [0, 0, 0.1],
        joints: [],
        children: [],
        geoms: [{
          name: 'landing_gear_mesh',
          type: 'mesh',
          size: [1],
          dynamic: true,
          vertices: [...UNIT_CUBE_YUP],
          renderVertices: [...UNIT_CUBE_ZUP],
          faces: [...UNIT_CUBE_FACES],
          rgba: [0.5, 0.5, 0.5, 1],
        }],
      };
      const legacyGearGeoms = generateGearGeoms('gear_1', 0.2, 8, [0.5, 0.5, 0.5, 1], false);
      legacyGearGeoms.push({
        name: 'gear_1_pusher_peg',
        type: 'cylinder',
        size: [0.02, 0.05],
        pos: [0.15, 0, 0.06],
        rgba: [0.9, 0.2, 0.2, 1],
      });
      const legacyGear: SceneNode = {
        id: 'gear_1',
        name: 'gear_1',
        type: 'body',
        pos: [0, 0, 0.1],
        joints: [],
        children: [],
        geoms: legacyGearGeoms,
      };
      useStore.setState({ sceneGraph: { nodes: [landingGear, legacyGear] } });

      // Changing color on landing_gear must NOT replace mesh with box cogs
      useStore.getState().updateNodeGeom('landing_gear', { rgba: [1, 0, 0, 1] }, 0);
      const lgAfter = useStore.getState().sceneGraph.nodes[0];
      expect(lgAfter.geoms).toHaveLength(1);
      expect(lgAfter.geoms[0].type).toBe('mesh');
      expect(lgAfter.geoms[0].rgba).toEqual([1, 0, 0, 1]);

      // Resizing legacy cog hub must preserve the peg and keep 8 teeth (not 9!)
      useStore.getState().updateNodeGeom('gear_1', { size: [0.3, 0.02] }, 0);
      const gearAfter = useStore.getState().sceneGraph.nodes[1];
      const pegs = gearAfter.geoms.filter((g) => g.name.includes('peg'));
      const teeth = gearAfter.geoms.filter((g) => g.name.includes('tooth'));
      expect(pegs).toHaveLength(1);
      expect(pegs[0].pos).toEqual([0.15, 0, 0.06]);
      expect(teeth).toHaveLength(8);
      expect(gearAfter.geoms[0].size[0]).toBeCloseTo(0.3, 6);
    });

    it('updateNodeScad targets !csgDerived mesh, drops stale colliders, clears base* and tunedPitchHz', () => {
      const scadNode: SceneNode = {
        id: 'scad_part',
        name: 'scad_part',
        type: 'body',
        pos: [0, 0, 0.1],
        joints: [],
        children: [],
        tunedPitchHz: 440,
        collisionDecomposed: true,
        geoms: [
          {
            name: 'scad_part_collider_0',
            type: 'mesh',
            size: [1],
            csgDerived: 'collider',
            vertices: [...UNIT_CUBE_YUP],
            faces: [...UNIT_CUBE_FACES],
          },
          {
            name: 'scad_part_mesh',
            type: 'mesh',
            size: [1],
            dynamic: true,
            vertices: [...UNIT_CUBE_YUP],
            renderVertices: [...UNIT_CUBE_ZUP],
            faces: [...UNIT_CUBE_FACES],
            baseVertices: [...UNIT_CUBE_YUP],
            baseRenderVertices: [...UNIT_CUBE_ZUP],
            baseColliderVertices: [...UNIT_CUBE_ZUP],
          } as WorkingGeom,
        ],
      };
      useStore.setState({ sceneGraph: { nodes: [scadNode] } });

      const freshVerts = UNIT_CUBE_YUP.map((v) => v * 2);
      const freshRender = UNIT_CUBE_ZUP.map((v) => v * 2);
      useStore.getState().updateNodeScad('scad_part', 'cube(2);', {
        vertices: freshVerts,
        renderVertices: freshRender,
        faces: [...UNIT_CUBE_FACES],
      }, true);

      const updated = useStore.getState().sceneGraph.nodes[0];
      expect(updated.tunedPitchHz).toBeUndefined();
      expect(updated.collisionDecomposed).toBeUndefined();
      expect(updated.geoms.some((g) => g.csgDerived === 'collider')).toBe(false);
      expect(updated.geoms).toHaveLength(1);
      const mesh = updated.geoms[0] as WorkingGeom;
      expect(mesh.name).toBe('scad_part_mesh');
      expect(mesh.vertices).toEqual(freshVerts);
      expect(mesh.baseVertices).toBeUndefined();
      expect(mesh.baseRenderVertices).toBeUndefined();
      expect(mesh.baseColliderVertices).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // #12 & #27: shapeParamActions synchronous set, cache clear, tube r1 < r2
  // -------------------------------------------------------------------------
  describe('#12 & #27 shapeParamActions', () => {
    it('commits synchronously so rapid updates do not clobber each other, clears stale colliders/base*, and clamps tube 0 < r1 < r2', () => {
      const tube: SceneNode = {
        id: 'tube1',
        name: 'tube1',
        type: 'body',
        pos: [0, 0, 0.2],
        isTube: true,
        innerRadius: 0.2,
        outerRadius: 0.3,
        height: 0.5,
        tunedPitchHz: 330,
        collisionDecomposed: true,
        joints: [],
        children: [],
        geoms: [
          {
            name: 'tube1_mesh',
            type: 'mesh',
            size: [1],
            dynamic: true,
            vertices: [...UNIT_CUBE_YUP],
            renderVertices: [...UNIT_CUBE_ZUP],
            faces: [...UNIT_CUBE_FACES],
            baseVertices: [...UNIT_CUBE_YUP],
            baseRenderVertices: [...UNIT_CUBE_ZUP],
            baseColliderVertices: [...UNIT_CUBE_ZUP],
          } as WorkingGeom,
          {
            name: 'tube1_col_0',
            type: 'mesh',
            size: [1],
            csgDerived: 'collider',
            vertices: [...UNIT_CUBE_YUP],
            faces: [...UNIT_CUBE_FACES],
          },
        ],
      };
      useStore.setState({ sceneGraph: { nodes: [tube] } });

      // Two synchronous updates back-to-back must both persist
      useStore.getState().updateTubeParams('tube1', { height: 0.8 });
      useStore.getState().updateTubeParams('tube1', { outerRadius: 0.45 });
      const n1 = useStore.getState().sceneGraph.nodes[0];
      expect(n1.height).toBeCloseTo(0.8, 6);
      expect(n1.outerRadius).toBeCloseTo(0.45, 6);
      expect(n1.tunedPitchHz).toBeUndefined();
      expect(n1.collisionDecomposed).toBeUndefined();
      expect(n1.geoms.some((g) => g.csgDerived === 'collider')).toBe(false);
      expect((n1.geoms[0] as WorkingGeom).baseVertices).toBeUndefined();
      expect((n1.geoms[0] as WorkingGeom).baseRenderVertices).toBeUndefined();
      expect((n1.geoms[0] as WorkingGeom).baseColliderVertices).toBeUndefined();

      // Invalid inverted / zero radii must enforce 0 < r1 < r2 and positive signed volume
      useStore.getState().updateTubeParams('tube1', { innerRadius: 0.9 });
      const n2 = useStore.getState().sceneGraph.nodes[0];
      expect(n2.innerRadius!).toBeGreaterThan(0);
      expect(n2.innerRadius!).toBeLessThan(n2.outerRadius!);
      expect(signedVolume(n2.geoms[0].renderVertices!, n2.geoms[0].faces!)).toBeGreaterThan(0);

      useStore.getState().updateTubeParams('tube1', { innerRadius: -0.5, outerRadius: 0 });
      const n3 = useStore.getState().sceneGraph.nodes[0];
      expect(n3.innerRadius!).toBeGreaterThan(0);
      expect(n3.outerRadius!).toBeGreaterThan(n3.innerRadius!);
      expect(signedVolume(n3.geoms[0].renderVertices!, n3.geoms[0].faces!)).toBeGreaterThan(0);
    });

    it('is intercepted synchronously by Cast-Prep editGuard', async () => {
      const cone: SceneNode = {
        id: 'cone1',
        name: 'cone1',
        type: 'body',
        pos: [0, 0, 0.2],
        isCone: true,
        radius: 0.2,
        height: 0.4,
        joints: [],
        children: [],
        geoms: [{ name: 'cone1_mesh', type: 'mesh', size: [1], dynamic: true, vertices: [...UNIT_CUBE_YUP], renderVertices: [...UNIT_CUBE_ZUP], faces: [...UNIT_CUBE_FACES] }],
      };
      const armedGraph: SceneGraph = {
        nodes: [cone],
        castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      };
      useStore.setState({ sceneGraph: armedGraph });
      const before = useStore.getState().sceneGraph;
      useStore.getState().updateConeParams('cone1', { radius: 0.5 });
      expect(useStore.getState().sceneGraph).toBe(before);
      expect(useStore.getState().castPrepGuardOpen).toBe(true);
      await tick();
    });
  });

  // -------------------------------------------------------------------------
  // #13: updateNodePos & translateMeshGeoms on static mesh bodies
  // -------------------------------------------------------------------------
  describe('#13 static mesh coordinate-space transform & updateNodePos', () => {
    it('promotes moved static mesh body to dynamic so Three.js, MJCF mesh, and collider agree with zero double-translation', () => {
      const staticMesh: SceneNode = {
        id: 'statue',
        name: 'statue',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        children: [],
        geoms: [{
          name: 'statue_mesh',
          type: 'mesh',
          size: [1],
          vertices: [...UNIT_CUBE_YUP],
          faces: [...UNIT_CUBE_FACES],
          colliderVertices: [...UNIT_CUBE_ZUP],
          colliderFaces: [...UNIT_CUBE_FACES],
        }],
      };
      useStore.setState({ sceneGraph: { nodes: [staticMesh] } });
      useStore.getState().updateNodePos('statue', [1.2, -0.4, 0.7]);

      const moved = useStore.getState().sceneGraph.nodes[0];
      const g = moved.geoms[0];
      expect(moved.pos).toEqual([1.2, -0.4, 0.7]);
      expect(g.dynamic).toBe(true);
      // Local vertices must NOT be double-translated; they stay equal to original local shape
      expect(g.vertices).toEqual(UNIT_CUBE_YUP);
      expect(g.renderVertices).toEqual(UNIT_CUBE_ZUP);
      expect(g.colliderVertices).toEqual(UNIT_CUBE_ZUP);
      // MJCF emits the body pos once and mesh vertices in Z-up body frame
      const xml = compileToMJCF(useStore.getState().sceneGraph);
      expect(xml).toContain('pos="1.2 -0.4 0.7"');
    });

    it('translateMeshGeoms maps Z-up delta (dx, dy, dz) to Y-up (dx, dz, -dy) on vertices and (dx, dy, dz) on Z-up colliderVertices', () => {
      const node: SceneNode = {
        id: 'statue2',
        name: 'statue2',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        children: [],
        geoms: [{
          name: 'statue2_mesh',
          type: 'mesh',
          size: [1],
          vertices: [...UNIT_CUBE_YUP],
          faces: [...UNIT_CUBE_FACES],
          colliderVertices: [...UNIT_CUBE_ZUP],
          colliderFaces: [...UNIT_CUBE_FACES],
          baseVertices: [...UNIT_CUBE_YUP],
          baseColliderVertices: [...UNIT_CUBE_ZUP],
        } as WorkingGeom],
      };
      translateMeshGeoms(node, 0.5, -0.3, 1.1);
      const g = node.geoms[0] as WorkingGeom;
      const converted = toRenderVertices(g.vertices!);
      for (let i = 0; i < UNIT_CUBE_ZUP.length; i += 3) {
        expect(converted[i]).toBeCloseTo(UNIT_CUBE_ZUP[i] + 0.5, 9);
        expect(converted[i + 1]).toBeCloseTo(UNIT_CUBE_ZUP[i + 1] - 0.3, 9);
        expect(converted[i + 2]).toBeCloseTo(UNIT_CUBE_ZUP[i + 2] + 1.1, 9);
        expect(g.colliderVertices![i]).toBeCloseTo(UNIT_CUBE_ZUP[i] + 0.5, 9);
        expect(g.colliderVertices![i + 1]).toBeCloseTo(UNIT_CUBE_ZUP[i + 1] - 0.3, 9);
        expect(g.colliderVertices![i + 2]).toBeCloseTo(UNIT_CUBE_ZUP[i + 2] + 1.1, 9);
      }
      const baseConverted = toRenderVertices(g.baseVertices!);
      expect(baseConverted[0]).toBeCloseTo(UNIT_CUBE_ZUP[0] + 0.5, 9);
      expect(baseConverted[1]).toBeCloseTo(UNIT_CUBE_ZUP[1] - 0.3, 9);
      expect(baseConverted[2]).toBeCloseTo(UNIT_CUBE_ZUP[2] + 1.1, 9);
      expect(g.baseColliderVertices![2]).toBeCloseTo(UNIT_CUBE_ZUP[2] + 1.1, 9);
    });
  });

  // -------------------------------------------------------------------------
  // #28 & #55: detachToTopLevel undo, Cast-Prep guard, renamed body lookup
  // -------------------------------------------------------------------------
  describe('#28 & #55 detachToTopLevel', () => {
    it('is undoable and preserves live MuJoCo pose for renamed bodies', async () => {
      const child = boxNode('child_id', [0.1, 0, 0], { name: 'renamed_arm' });
      const parent = boxNode('parent_id', [0, 0, 0.5], { children: [child] });
      const fakeModel = { _idMaps: { body: { renamed_arm: 1 } } } as never;
      const fakeData = {
        xpos: new Float64Array([0, 0, 0, 2.5, 3.5, 4.5]),
        xmat: new Float64Array([
          1, 0, 0, 0, 1, 0, 0, 0, 1,
          1, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      } as never;
      useStore.setState({ sceneGraph: { nodes: [parent] }, model: fakeModel, data: fakeData });

      expect(useStore.getState().detachToTopLevel('child_id')).toBe(true);
      const detached = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'child_id')!;
      expect(detached.pos).toEqual([2.5, 3.5, 4.5]);
      await tick();

      // Must be undoable!
      expect(useStore.getState().undoStack.length).toBeGreaterThan(0);
      useStore.getState().undo();
      expect(useStore.getState().sceneGraph.nodes).toHaveLength(1);
      expect(useStore.getState().sceneGraph.nodes[0].children[0].id).toBe('child_id');
    });

    it('is blocked by Cast-Prep editGuard when draft is baked in', async () => {
      const parent = boxNode('p', [0, 0, 0], { children: [boxNode('c', [0.1, 0, 0])] });
      const armed: SceneGraph = {
        nodes: [parent],
        castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      };
      useStore.setState({ sceneGraph: armed });
      expect(useStore.getState().detachToTopLevel('c')).toBe(false);
      expect(useStore.getState().castPrepGuardOpen).toBe(true);
      expect(useStore.getState().sceneGraph.nodes).toHaveLength(1);
      await tick();
    });
  });

  // -------------------------------------------------------------------------
  // #33, #34, #35: V-HACD WASM leak, Manifold handle cleanup, worker race
  // -------------------------------------------------------------------------
  describe('#33, #34, #35 V-HACD & Manifold WASM safety', () => {
    it('#33 empirical V-HACD WASM computeConvexHulls executes 60 iterations with zero Embind C++ heap drift', async () => {
      const decomposer = await ConvexMeshDecomposition.create();
      const positions = Float64Array.from(UNIT_CUBE_ZUP);
      const indices = Uint32Array.from(UNIT_CUBE_FACES);
      // Warm up & verify real vendored ConvexMeshDecomposition across 50 iterations
      for (let i = 0; i < 50; i++) {
        const hulls = decomposer.computeConvexHulls(
          { positions, indices },
          { maxHulls: 4, voxelResolution: 1000, maxVerticesPerHull: 16 },
        );
        expect(hulls.length).toBeGreaterThan(0);
        expect(hulls[0].positions.length).toBeGreaterThanOrEqual(12);
      }
      // Empirically verify zero malloc pointer drift on a standalone WASM instance
      // when params, hulls, and every hull are .delete()d as vhacd.js now does.
      const mod = await instantiateVhacd();
      const runOnce = () => {
        const params = new mod.Parameters();
        params.maxHulls = 4;
        params.voxelResolution = 1000;
        params.maxVerticesPerHull = 16;
        let pPts = 0, pTris = 0, dec: { compute: (...a: number[]) => { size(): number; get(i: number): { delete(): void }; delete(): void }; dispose(): void } | undefined;
        let hulls: { size(): number; get(i: number): { delete(): void }; delete(): void } | undefined;
        try {
          pPts = mod._malloc(8 * positions.length);
          pTris = mod._malloc(4 * indices.length);
          mod.HEAPF64.set(positions, pPts / 8);
          mod.HEAPU32.set(indices, pTris / 4);
          dec = new mod.MeshDecomposer(params, 0);
          hulls = dec!.compute(pPts, positions.length / 3, pTris, indices.length / 3);
          for (let i = 0; i < hulls!.size(); i++) hulls!.get(i).delete();
        } finally {
          hulls?.delete();
          dec?.dispose();
          params.delete();
          if (pPts) mod._free(pPts);
          if (pTris) mod._free(pTris);
        }
      };
      // Warm up allocator
      for (let i = 0; i < 5; i++) runOnce();
      const probe = () => { const p = mod._malloc(64); mod._free(p); return p; };
      const pBefore = probe();
      for (let i = 0; i < 50; i++) runOnce();
      const pAfter = probe();
      expect(pAfter - pBefore).toBeLessThanOrEqual(1024);
    });

    it('#34 deletes all Manifold handles when callbacks/operations throw in decomposeInChunks, cutAtReflexEdges, and cutCurved', async () => {
      // 1) decomposeInChunks: decompose throws while current handle is popped from queue
      const created: Array<{ deleted: number }> = [];
      const makeMockManifold = (opts: {
        splitThrows?: boolean;
        decomposeThrows?: boolean;
        empty?: boolean;
        verts?: number[];
        faces?: number[];
      } = {}): Manifold => {
        const tracker = { deleted: 0 };
        created.push(tracker);
        const verts = opts.verts ?? UNIT_CUBE_ZUP.map((v) => v * 1000);
        const faces = opts.faces ?? UNIT_CUBE_FACES;
        const m = {
          status: () => 'NoError',
          isEmpty: () => !!opts.empty,
          volume: () => 1000,
          surfaceArea: () => 600,
          boundingBox: () => ({ min: [-100, -100, 0], max: [100, 100, 200] }),
          getMesh: () => ({
            numVert: verts.length / 3,
            numProp: 3,
            vertProperties: Float32Array.from(verts),
            triVerts: Uint32Array.from(faces),
          }),
          decompose: () => {
            if (opts.decomposeThrows) throw new Error('decompose boom');
            return [makeMockManifold({ splitThrows: opts.splitThrows })];
          },
          splitByPlane: () => {
            if (opts.splitThrows) throw new Error('split boom');
            return [makeMockManifold(), makeMockManifold()];
          },
          delete: () => { tracker.deleted += 1; },
        };
        return m as unknown as Manifold;
      };

      // Non-convex dented cube so convexChunkHull does not short-circuit before calling the throwing vhacd callback
      const dentedVerts = [...UNIT_CUBE_ZUP, 0, 0, 0.05];
      const dentedFaces = [
        ...UNIT_CUBE_FACES.slice(0, 6), // bottom (2 tris)
        ...UNIT_CUBE_FACES.slice(12),   // 4 sides (8 tris)
        4, 5, 8, 5, 6, 8, 6, 7, 8, 7, 4, 8, // top dented inward to vertex 8
      ];
      const mockWasm = {
        Mesh: class { constructor(public cfg: unknown) {} },
        Manifold: class {
          constructor() { return makeMockManifold({ verts: dentedVerts.map((v) => v * 1000), faces: dentedFaces }); }
          static compose() { return makeMockManifold({ verts: dentedVerts.map((v) => v * 1000), faces: dentedFaces }); }
        },
      } as unknown as ManifoldToplevel;

      await expect(
        decomposeInChunks(
          mockWasm,
          dentedVerts,
          dentedFaces,
          async () => { throw new Error('vhacd boom'); },
          () => ({}),
        ),
      ).rejects.toThrow('vhacd boom');
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((c) => c.deleted === 1)).toBe(true);

      // 2) cutAtReflexEdges: solidComponents throws on a second component after split
      created.length = 0;
      const lShapeWasm = {
        Mesh: class { constructor(public cfg: unknown) {} },
        Manifold: class {
          constructor() {
            return makeMockManifold({ decomposeThrows: true });
          }
        },
      } as unknown as ManifoldToplevel;
      expect(() => cutAtReflexEdges(lShapeWasm, UNIT_CUBE_ZUP, UNIT_CUBE_FACES, 16)).toThrow('decompose boom');
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((c) => c.deleted === 1)).toBe(true);

      // 3) cutCurved: throws while iterating initial cells before loop starts
      created.length = 0;
      let cellCall = 0;
      const curvedWasm = {
        Mesh: class { constructor(public cfg: unknown) {} },
        Manifold: class {
          constructor() {
            cellCall++;
            const tracker = { deleted: 0 };
            created.push(tracker);
            return {
              status: () => 'NoError',
              isEmpty: () => false,
              getMesh: () => {
                if (cellCall === 2) throw new Error('getMesh boom');
                return {
                  numVert: UNIT_CUBE_ZUP.length / 3,
                  numProp: 3,
                  vertProperties: Float32Array.from(UNIT_CUBE_ZUP.map((v) => v * 1000)),
                  triVerts: Uint32Array.from(UNIT_CUBE_FACES),
                };
              },
              delete: () => { tracker.deleted += 1; },
            };
          }
        },
      } as unknown as ManifoldToplevel;
      expect(() =>
        cutCurved(
          curvedWasm,
          [{ verts: UNIT_CUBE_ZUP, faces: UNIT_CUBE_FACES }, { verts: UNIT_CUBE_ZUP, faces: UNIT_CUBE_FACES }],
          16,
          1e-4,
        ),
      ).toThrow('getMesh boom');
      expect(created).toHaveLength(2);
      expect(created.every((c) => c.deleted === 1)).toBe(true);
    });

    it('#35 stale worker onerror/onmessage after timeout does not reject the replacement worker job', async () => {
      vi.useFakeTimers();
      const workers: Array<WorkerLike & { savedOnError?: ((e: unknown) => void) | null; savedOnMsg?: ((e: MessageEvent<VhacdResponse>) => void) | null; lastId?: number }> = [];
      setVhacdWorkerFactory(() => {
        const w: WorkerLike & { savedOnError?: ((e: unknown) => void) | null; savedOnMsg?: ((e: MessageEvent<VhacdResponse>) => void) | null; lastId?: number } = {
          onmessage: null,
          onerror: null,
          terminate() {},
          postMessage(msg: VhacdRequest) {
            w.lastId = msg.id;
            // Capture the handler refs before stopWorker nulls them to simulate an in-flight browser event
            w.savedOnError = w.onerror;
            w.savedOnMsg = w.onmessage;
          },
        };
        workers.push(w);
        return w;
      });

      const job1 = decomposeMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]).then(() => 'ok', (e: Error) => e.message);
      const job2 = decomposeMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]).then(() => 'ok', (e: Error) => e.message);

      // Advance past job1 timeout -> worker[0] terminated, worker[1] started for job2
      await vi.advanceTimersByTimeAsync(DECOMPOSE_TIMEOUT_MS + 10);
      expect(await job1).toBe('Convex decomposition timed out.');
      expect(workers).toHaveLength(2);
      expect(workers[0].onmessage).toBeNull();
      expect(workers[0].onerror).toBeNull();

      // Fire stale worker[0]'s captured onerror & onmessage -> must be ignored!
      workers[0].savedOnError?.(new Error('late stale crash'));
      workers[0].savedOnMsg?.({ data: { type: 'DECOMPOSE_ERROR', id: workers[1].lastId!, message: 'stale' } } as MessageEvent<VhacdResponse>);
      expect(vhacdJobsPending()).toBe(1);

      // Now worker[1] resolves job2 cleanly
      workers[1].onmessage?.({ data: { type: 'DECOMPOSED', id: workers[1].lastId!, hulls: [] } } as MessageEvent<VhacdResponse>);
      expect(await job2).toBe('ok');
      expect(vhacdJobsPending()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // #36: dentBody Y-up fallback & geom-local point/normal transform
  // -------------------------------------------------------------------------
  describe('#36 dentBody coordinate spaces', () => {
    it('converts Y-up vertices to Z-up when renderVertices is absent and transforms point/normal into geom-local frame', () => {
      // A horizontal plate at geom.pos = [0, 0, 0.5], rotated 90 deg about Z (euler [0, 0, 90]),
      // stored ONLY as Y-up `vertices` (no `renderVertices`).
      // In geom-local Z-up: x in [-0.1, 0.1], y in [-0.1, 0.1], z in [0, 0.2] (top face at z = 0.2).
      const node: SceneNode = {
        id: 'plate',
        name: 'plate',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        children: [],
        geoms: [{
          name: 'plate_mesh',
          type: 'mesh',
          size: [1],
          pos: [0, 0, 0.5],
          euler: [0, 0, 90],
          vertices: [...UNIT_CUBE_YUP],
          faces: [...UNIT_CUBE_FACES],
          dentYieldNs: 1,
          dentDepthPerNs: 0.005,
          dentRadius: 0.08,
        }],
      };

      // Body-frame hit at top face near local corner (0.1, 0.1, 0.2):
      // Local (0.08, 0.08, 0.2) rotated +90 deg Z => (-0.08, 0.08, 0.2), plus pos [0,0,0.5] => (-0.08, 0.08, 0.7)
      dentBody(node, [-0.08, 0.08, 0.7], [0, 0, 1], 10);
      const key = dentKey('plate', 'plate_mesh');
      const d = useDentStore.getState().dents[key];
      expect(d).toBeDefined();
      const geomOut = deformedGeometry(key)!;
      // Local corner (0.1, 0.1, 0.2) is vertex 5 in UNIT_CUBE_ZUP (x=0.1, y=-z_yup=0.1, z=y_yup=0.2)
      // Verify ONLY the struck corner pushed down in -Z, while (-0.1, 0.1, 0.2) stayed flat at z=0.2 and Y stayed in [-0.1, 0.1]
      let struckZ = Infinity;
      let otherTopZ = Infinity;
      let maxAbsY = 0;
      for (let i = 0; i < geomOut.renderVertices.length; i += 3) {
        const ox = UNIT_CUBE_ZUP[i];
        const oy = UNIT_CUBE_ZUP[i + 1];
        const oz = UNIT_CUBE_ZUP[i + 2];
        const y = geomOut.renderVertices[i + 1];
        const z = geomOut.renderVertices[i + 2];
        maxAbsY = Math.max(maxAbsY, Math.abs(y));
        if (oz > 0.15 && ox > 0 && oy > 0) struckZ = z;
        if (oz > 0.15 && ox < 0 && oy > 0) otherTopZ = z;
      }
      expect(struckZ).toBeLessThan(0.195);
      expect(otherTopZ).toBeCloseTo(0.2, 5);
      expect(maxAbsY).toBeCloseTo(0.1, 5);
    });
  });

  // -------------------------------------------------------------------------
  // #44 & #71: historyActions (waterLevel/background + transient cleanup)
  // -------------------------------------------------------------------------
  describe('#44 & #71 historyActions', () => {
    it('records and restores waterLevel & background, and clears transient selection/breakage/dents on undo/redo', async () => {
      useStore.getState().setEnvironment({ waterLevel: 0.25, background: 'meadow' });
      useStore.getState().flushPendingUndo();
      expect(useStore.getState().undoStack).toHaveLength(1);
      expect(useStore.getState().waterLevel).toBe(0.25);
      expect(useStore.getState().background).toBe('meadow');

      // Populate transient selection, breakage, and dents before undo
      useStore.setState({
        extraSelectedIds: ['b'],
        activeGeomIndex: 1,
        geomFocused: true,
        draggedNodeId: 'a',
        dragTarget: { x: 1, y: 0, z: 0 },
        edgeRoundSession: { nodeId: 'a', base: [], editIndex: null, mode: 'chamfer', size: 0.001, picked: [] },
        brokenConstraints: ['a:b'],
        shatteredBodies: { a: [boxNode('s1')] },
      });
      useDentStore.getState().dent('a/a_g', UNIT_CUBE_ZUP, UNIT_CUBE_FACES, [0, 0, 0.2], [0, 0, 1], 0.01, 0.05);

      useStore.getState().undo();
      const afterUndo = useStore.getState();
      expect(afterUndo.waterLevel).toBeNull();
      expect(afterUndo.background).toBe('studio');
      expect(afterUndo.extraSelectedIds).toEqual([]);
      expect(afterUndo.activeGeomIndex).toBe(0);
      expect(afterUndo.geomFocused).toBe(false);
      expect(afterUndo.draggedNodeId).toBeNull();
      expect(afterUndo.edgeRoundSession).toBeNull();
      expect(afterUndo.brokenConstraints).toEqual([]);
      expect(afterUndo.shatteredBodies).toEqual({});
      expect(useDentStore.getState().dents).toEqual({});

      useStore.getState().redo();
      expect(useStore.getState().waterLevel).toBe(0.25);
      expect(useStore.getState().background).toBe('meadow');
    });
  });

  // -------------------------------------------------------------------------
  // #49: shareUnchanged collider arrays & sceneClone deep-clone / TypedArrays
  // -------------------------------------------------------------------------
  describe('#49 shareUnchanged & sceneClone', () => {
    it('compares colliderVertices/colliderFaces/baseColliderVertices by reference in shareUnchanged', () => {
      const colV = [...UNIT_CUBE_ZUP];
      const colF = [...UNIT_CUBE_FACES];
      const prev: SceneGraph = {
        nodes: [{
          id: 'm',
          name: 'm',
          type: 'body',
          pos: [0, 0, 0],
          joints: [],
          children: [],
          geoms: [{
            name: 'm_g',
            type: 'mesh',
            size: [1],
            vertices: [...UNIT_CUBE_YUP],
            faces: [...UNIT_CUBE_FACES],
            colliderVertices: colV,
            colliderFaces: colF,
            baseColliderVertices: colV,
          } as WorkingGeom],
        }],
      };
      const sameRef = cloneSceneGraph(prev);
      shareUnchanged(prev, sameRef);
      expect(sameRef.nodes[0]).toBe(prev.nodes[0]);

      const replacedCol = cloneSceneGraph(prev);
      replacedCol.nodes[0].geoms[0].colliderVertices = [...colV];
      shareUnchanged(prev, replacedCol);
      expect(replacedCol.nodes[0]).not.toBe(prev.nodes[0]);
    });

    it('deep-clones castPrep & referenceImages in cloneSceneGraph and preserves TypedArrays in clonePlain', () => {
      const f32 = new Float32Array([1.5, -2.25, 3.75]);
      const clonedArr = clonePlain(f32);
      expect(clonedArr).toBeInstanceOf(Float32Array);
      expect(clonedArr).not.toBe(f32);
      expect(Array.from(clonedArr)).toEqual([1.5, -2.25, 3.75]);

      const sg: SceneGraph = {
        nodes: [boxNode('a')],
        castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals: { a: { shape: { pos: [0, 0, 0] }, signature: 'sig' } }, skipped: [], sharpEdges: 0 },
        referenceImages: [{ id: 'img1', name: 'ref', dataUrl: 'data:,', plane: 'xy', pos: [0, 0, 0], size: [0.1, 0.1], opacity: 0.5, rotation: 0 }],
      };
      const copy = cloneSceneGraph(sg);
      copy.castPrep!.draftDeg = 5;
      copy.referenceImages![0].opacity = 0.9;
      expect(sg.castPrep!.draftDeg).toBe(2);
      expect(sg.referenceImages![0].opacity).toBe(0.5);
    });
  });

  // -------------------------------------------------------------------------
  // #57, #58, #59: combineBodies, duplicateNodes, printSplitActions, booleanActions
  // -------------------------------------------------------------------------
  describe('#57, #58, #59 combine, duplicate, printSplit, boolean errors', () => {
    it('#57 combineBodies enables csgEnabled on mixed lattice + non-lattice difference, and rewriteGeom applies mesh quat & transforms colliderVertices', () => {
      // Test rewriteGeom with mesh quat + colliderVertices + stale base*
      const half = Math.SQRT1_2;
      const meshGeom: WorkingGeom = {
        name: 'rot_mesh',
        type: 'mesh',
        size: [1],
        pos: [0.1, 0, 0],
        quat: [half, 0, 0, half], // +90 deg about Z
        renderVertices: [1, 0, 0,  0, 0, 0,  0, 0, 1],
        vertices: [1, 0, 0,  0, 0, 0,  0, 1, 0],
        colliderVertices: [1, 0, 0,  0, 0, 0,  0, 0, 1],
        faces: [0, 1, 2],
        baseVertices: [1, 0, 0],
        baseRenderVertices: [1, 0, 0],
        baseColliderVertices: [1, 0, 0],
      };
      const rewritten = rewriteGeom(meshGeom, new THREE.Matrix4()) as WorkingGeom;
      // (1,0,0) rotated +90 deg about Z => (0,1,0), then translated by pos (0.1,0,0) => (0.1, 1, 0)
      expect(rewritten.renderVertices![0]).toBeCloseTo(0.1, 6);
      expect(rewritten.renderVertices![1]).toBeCloseTo(1.0, 6);
      expect(rewritten.colliderVertices![0]).toBeCloseTo(0.1, 6);
      expect(rewritten.colliderVertices![1]).toBeCloseTo(1.0, 6);
      expect(rewritten.baseVertices).toBeUndefined();
      expect(rewritten.baseRenderVertices).toBeUndefined();
      expect(rewritten.baseColliderVertices).toBeUndefined();

      // Mixed lattice + non-lattice difference
      const cage1 = boxLattice(0.01, 6);
      const cage2 = boxLattice(0.01, 4);
      const g1 = toSceneGeom(cage1, 0, 0);
      const g2 = toSceneGeom(cage2, 0, 0);
      const targetLat: SceneNode = {
        id: 'lat_target', name: 'lat_target', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        isLattice: true, latticeCage: serializeCage(cage1), latticeOrigin: [0, 0, 0],
        geoms: [{ name: 'lat_target_mesh', type: 'mesh', size: [1], dynamic: true, latticeGeom: true, ...g1 }],
      };
      const sourceLat: SceneNode = {
        id: 'lat_cut', name: 'lat_cut', type: 'body', pos: [0.02, 0, 0], joints: [], children: [],
        isLattice: true, latticeCage: serializeCage(cage2), latticeOrigin: [0, 0, 0],
        geoms: [{ name: 'lat_cut_mesh', type: 'mesh', size: [1], dynamic: true, latticeGeom: true, ...g2 }],
      };
      const boxCut = boxNode('box_cut', [0, 0, 0]);
      useStore.setState({ sceneGraph: { nodes: [targetLat, sourceLat, boxCut] } });
      useStore.getState().combineBodies('lat_target', ['lat_cut', 'box_cut'], 'difference');
      const combined = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'lat_target')!;
      expect(combined.csgEnabled).toBe(true);
      expect(combined.geoms.some((g) => g.csg === 'difference')).toBe(true);
    });

    it('#58 duplicateNodes clears basePos, promotes static meshes to dynamic, and remaps/clears hardwarePart.fastens & flexure.bridgeNodeId', () => {
      const plate = boxNode('plate', [0, 0, 0], { basePos: [0, 0, 0] } as Partial<WorkingNode>);
      const screw = boxNode('screw', [0.05, 0, 0], {
        hardwarePart: { kind: 'screw', size: 'M3', fastens: 'plate' },
      });
      const extScrew = boxNode('ext_screw', [0.05, 0.05, 0], {
        hardwarePart: { kind: 'screw', size: 'M3', fastens: 'outside_plate' },
      });
      const flex = boxNode('flex', [0, 0.05, 0], {
        flexure: { kind: 'living_hinge', thicknessMm: 1, lengthMm: 10, widthMm: 10, axis: [0, 1, 0], bridgeNodeId: 'outside_bridge' },
      } as Partial<SceneNode>);
      const staticPart: SceneNode = {
        id: 'static_part',
        name: 'static_part',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        children: [],
        geoms: [{ name: 'static_part_mesh', type: 'mesh', size: [1], vertices: [...UNIT_CUBE_YUP], faces: [...UNIT_CUBE_FACES] }],
      };
      const scene: SceneGraph = {
        nodes: [plate, screw, extScrew, flex, staticPart, boxNode('outside_plate'), boxNode('outside_bridge')],
      };
      const cloneNodes = (nodes: SceneNode[]) => cloneSceneGraph({ nodes }).nodes;
      const board = copyBodies(scene, ['plate', 'screw', 'ext_screw', 'flex', 'static_part'], cloneNodes)!;
      const newIds = pasteBodies(scene, board, 1, cloneNodes);

      const [plate2, screw2, extScrew2, flex2, static2] = newIds.map((id) => scene.nodes.find((n) => n.id === id)!);
      expect((plate2 as WorkingNode).basePos).toBeUndefined();
      expect(screw2.hardwarePart?.fastens).toBe(plate2.id);
      expect(extScrew2.hardwarePart?.fastens).toBeUndefined();
      expect(flex2.flexure?.bridgeNodeId).toBeUndefined();
      expect(static2.geoms[0].dynamic).toBe(true);
      expect(static2.geoms[0].renderVertices).toEqual(UNIT_CUBE_ZUP);
    });

    it('#59 printSplitActions rotates centerOrigin offset by body local rotation and strips basePos/tunedPitchHz/collision*', () => {
      const rotated = boxNode('part', [1, 2, 3], {
        euler: [0, 0, 90], // +90 deg about Z: local +X becomes parent +Y
        tunedPitchHz: 520,
        collisionCavities: [{ center: [0, 0, 0], volumeMm3: 10, coveredBy: 0 }],
        collisionIntrusion: 0.002,
        collisionUncovered: 0.1,
      });
      (rotated as WorkingNode).basePos = [1, 2, 3];
      useStore.setState({ sceneGraph: { nodes: [rotated] } });

      // Section shifted by local (+0.2, 0, 0): positions around x in [0.1, 0.3], y in [-0.05, 0.05], z in [-0.05, 0.05]
      const makeSec = (cx: number) => ({
        positions: new Float32Array([
          cx - 0.05, -0.05, -0.05,  cx + 0.05, -0.05, -0.05,  cx + 0.05, 0.05, -0.05,  cx - 0.05, 0.05, -0.05,
          cx - 0.05, -0.05,  0.05,  cx + 0.05, -0.05,  0.05,  cx + 0.05, 0.05,  0.05,  cx - 0.05, 0.05,  0.05,
        ]),
        faces: new Uint32Array(UNIT_CUBE_FACES),
        plainPositions: new Float32Array([
          cx - 0.05, -0.05, -0.05,  cx + 0.05, -0.05, -0.05,  cx + 0.05, 0.05, -0.05,  cx - 0.05, 0.05, -0.05,
          cx - 0.05, -0.05,  0.05,  cx + 0.05, -0.05,  0.05,  cx + 0.05, 0.05,  0.05,  cx - 0.05, 0.05,  0.05,
        ]),
        plainFaces: new Uint32Array(UNIT_CUBE_FACES),
        up: [0, 0, 1] as [number, number, number],
        spin: 0,
        colliders: [],
        volumeMm3: 1000,
        convexPieces: [],
      });

      const ids = useStore.getState().splitBodyForPrint('part', [makeSec(0.2), makeSec(-0.2)], [], { centerOrigin: true });
      const p1 = useStore.getState().sceneGraph.nodes.find((n) => n.id === ids[0])!;
      const p2 = useStore.getState().sceneGraph.nodes.find((n) => n.id === ids[1])!;
      // Local offset (+0.2, 0, 0) rotated +90 deg Z => parent offset (0, +0.2, 0)
      expect(p1.pos[0]).toBeCloseTo(1, 6);
      expect(p1.pos[1]).toBeCloseTo(2.2, 6);
      expect(p1.pos[2]).toBeCloseTo(3, 6);
      expect(p2.pos[0]).toBeCloseTo(1, 6);
      expect(p2.pos[1]).toBeCloseTo(1.8, 6);
      expect(p2.pos[2]).toBeCloseTo(3, 6);
      // Stale fields stripped on both pieces
      for (const p of [p1, p2]) {
        expect((p as WorkingNode).basePos).toBeUndefined();
        expect(p.tunedPitchHz).toBeUndefined();
        expect(p.collisionCavities).toBeUndefined();
        expect(p.collisionIntrusion).toBeUndefined();
        expect(p.collisionUncovered).toBeUndefined();
      }
    });

    it('#59 setNodeCollisionError & setNodeCsgError ignore stale hashes', () => {
      const node: SceneNode = {
        id: 'bool_box',
        name: 'bool_box',
        type: 'body',
        pos: [0, 0, 0.1],
        csgEnabled: true,
        joints: [],
        children: [],
        geoms: [
          { name: 'b1', type: 'box', size: [0.05, 0.05, 0.05] },
          { name: 'h1', type: 'cylinder', size: [0.01, 0.06], csg: 'difference' },
        ],
      };
      const meshNode: SceneNode = {
        id: 'mesh_body',
        name: 'mesh_body',
        type: 'body',
        pos: [0, 0, 0.1],
        joints: [],
        children: [],
        geoms: [{ name: 'm1', type: 'mesh', size: [1], dynamic: true, vertices: [...UNIT_CUBE_YUP], renderVertices: [...UNIT_CUBE_ZUP], faces: [...UNIT_CUBE_FACES] }],
      };
      useStore.setState({ sceneGraph: { nodes: [node, meshNode] } });

      // Stale CSG error ignored
      useStore.getState().setNodeCsgError('bool_box', 'stale boom', 'wrong_hash');
      expect(useStore.getState().sceneGraph.nodes[0].csgError).toBeUndefined();
      // Matching CSG error applied
      const validCsgHash = csgHashOf(useStore.getState().sceneGraph.nodes[0]);
      useStore.getState().setNodeCsgError('bool_box', 'real boom', validCsgHash);
      expect(useStore.getState().sceneGraph.nodes[0].csgError).toBe('real boom');

      // Stale collision error ignored
      useStore.getState().setNodeCollisionError('mesh_body', 'stale col err', 'wrong_hash');
      expect(useStore.getState().sceneGraph.nodes[1].collisionError).toBeUndefined();
      // Matching collision error applied
      const validColHash = collisionHashOf(useStore.getState().sceneGraph.nodes[1]);
      useStore.getState().setNodeCollisionError('mesh_body', 'real col err', validColHash);
      expect(useStore.getState().sceneGraph.nodes[1].collisionError).toBe('real col err');
    });
  });

  // -------------------------------------------------------------------------
  // #37: denseColliders async retry does not push undo / wipe redo / trip guard
  // -------------------------------------------------------------------------
  describe('#37 denseColliders async retry safety', () => {
    it('does not push spurious undo steps, wipe redoStack, or open Cast-Prep guard when refreshing dense colliders', async () => {
      // Seed a redo entry and arm Cast-Prep draft
      const armedWithRedo: SceneGraph = {
        nodes: [boxNode('a')],
        castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      };
      useStore.setState({
        sceneGraph: armedWithRedo,
        undoStack: [],
        redoStack: [{
          sceneGraph: { nodes: [boxNode('future')] },
          gravityZ: -9.81, windX: 0, windY: 0, density: 0, floorFriction: 1, floorBounce: 0,
          background: 'studio', waterLevel: null, selectedNodeId: null, latticeNodeId: null,
        }],
        castPrepGuardOpen: false,
      });
      await denseCollidersSettled();
      expect(useStore.getState().undoStack).toHaveLength(0);
      expect(useStore.getState().redoStack).toHaveLength(1);
      expect(useStore.getState().castPrepGuardOpen).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // #38: simulationActions build races (superseded build, IR throw, recycle race)
  // -------------------------------------------------------------------------
  describe('#38 simulationActions build races', () => {
    it('resumes heldClient if superseded after client.build or if prewarmSceneAcousticIRs throws, and aborts recycleWorkerSeamlessly on scene change', async () => {
      const resumeSpy = vi.fn();
      const setPlayingSpy = vi.fn();
      let resolveFirstBuild!: (v: unknown) => void;
      const buildSpy = vi.fn()
        .mockImplementationOnce(() => new Promise((r) => { resolveFirstBuild = r; }))
        .mockImplementationOnce(async () => ({
          ok: true, isShared: false, ngeom: 0, nbody: 1, nq: 0, nv: 0, nu: 0,
          geom_name: [], body_name: ['world'], geom_type: new Int32Array(0),
          geom_size: new Float64Array(0), geom_rgba: new Float32Array(0),
          xpos: new Float64Array(3), xmat: new Float64Array(9),
          geom_xpos: new Float64Array(0), geom_xmat: new Float64Array(0),
          qpos: new Float64Array(0), qvel: new Float64Array(0), ctrl: new Float64Array(0),
          time: 0,
        }));

      const fakeClient = {
        meshFiles: undefined,
        setEnv: vi.fn(),
        build: buildSpy,
        resume: resumeSpy,
        setPlaying: setPlayingSpy,
        hasPendingWork: () => false,
      };
      const clientSpy = vi.spyOn(physicsEngine, 'getPhysicsWorkerClient').mockReturnValue(fakeClient as never);
      const irSpy = vi.spyOn(physicsEngine, 'prewarmSceneAcousticIRs').mockImplementation(() => {
        throw new Error('IR boom');
      });
      const recycleSpy = vi.spyOn(physicsEngine, 'recycleWorker').mockImplementation(() => {});
      const paintSpy = vi.spyOn(physicsEngine, 'onNextPaint').mockImplementation((cb) => cb());

      try {
        useStore.setState({ recompile: origRecompile, isPlaying: true });
        const g1: SceneGraph = { nodes: [boxNode('n1')] };
        const g2: SceneGraph = { nodes: [boxNode('n2')] };

        // Start build 1 (forceReset=true skips debounce, enters client.build with hold=true because isPlaying=true)
        const p1 = useStore.getState().recompile(g1, undefined, true);
        // Supersede with build 2 while build 1 is awaiting client.build
        const p2 = useStore.getState().recompile(g2, undefined, true);
        // Resolve build 1 now -> token mismatch must resume heldClient and bail!
        resolveFirstBuild({ ok: true });
        await Promise.all([p1, p2]);

        // Called once for superseded build 1, and once for build 2 when prewarmSceneAcousticIRs threw
        expect(resumeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(useStore.getState().lastCompileError).toContain('IR boom');

        // Now test recycleWorkerSeamlessly aborting when sceneGraph changes mid-build
        irSpy.mockImplementation(() => {});
        let resolveRecycleBuild!: (v: unknown) => void;
        buildSpy.mockImplementationOnce(() => new Promise((r) => { resolveRecycleBuild = r; }));
        const origHeap = physicsEngine.lastHeapBytes;
        physicsEngine.setLastHeapBytes(physicsEngine.RECYCLE_HEAP_BYTES + 10_000_000);
        const startGraph: SceneGraph = { nodes: [boxNode('before_recycle')] };
        const newerGraph: SceneGraph = { nodes: [boxNode('after_recycle')] };
        useStore.setState({
          sceneGraph: startGraph,
          recompileId: 12345,
          data: { qpos: new Float64Array(0), qvel: new Float64Array(0), ctrl: new Float64Array(0), time: 1.5 } as never,
        });
        const pRecycle = useStore.getState().recycleWorkerSeamlessly();
        // Change sceneGraph while recycle build is in flight
        useStore.setState({ sceneGraph: newerGraph });
        resolveRecycleBuild({
          ok: true, isShared: false, ngeom: 0, nbody: 1, nq: 0, nv: 0, nu: 0,
          geom_name: [], body_name: ['world'], geom_type: new Int32Array(0),
          geom_size: new Float64Array(0), geom_rgba: new Float64Array(0),
          xpos: new Float64Array(3), xmat: new Float64Array(9),
          geom_xpos: new Float64Array(0), geom_xmat: new Float64Array(0),
          qpos: new Float64Array(0), qvel: new Float64Array(0), ctrl: new Float64Array(0),
          time: 1.5,
        });
        await pRecycle;
        // Must have aborted without overwriting recompileId or model!
        expect(useStore.getState().recompileId).toBe(12345);
        expect(useStore.getState().sceneGraph).toBe(newerGraph);
        physicsEngine.setLastHeapBytes(origHeap);
      } finally {
        clientSpy.mockRestore();
        irSpy.mockRestore();
        recycleSpy.mockRestore();
        paintSpy.mockRestore();
      }
    });
  });
});
