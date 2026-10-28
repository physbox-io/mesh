// ---------------------------------------------------------------------------
// The store's palette: adding a body of each kind the palette offers, and
// a bought hardware part
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom, SceneJoint, GeomType } from '../types/scene';
import { belowOffset, besideOffset, restingPos } from '../utils/spawnPlacement';
import { toSceneGeom } from '../utils/sculptMesh';
import { buildSculptBaseSized, DEFAULT_SCULPT_BASE, DEFAULT_SCULPT_SIZE } from '../utils/sculptBases';
import {
  createLattice, deserializeCage, serializeCage, toSceneGeom as latticeToSceneGeom,
  DEFAULT_UNIT as LATTICE_UNIT,
} from '../utils/latticeMesh';
import { CSG_DEFAULT_SECTORS } from '../utils/csg';
import { generateGearGeoms } from '../presets/presetScenes';
import { DEFAULT_JOIN_MATERIAL, joinMaterial } from '../utils/joinMaterials';
import {
  generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData,
  generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS,
  DEFAULT_CURVE_SEGMENTS,
} from '../utils/geom';
import { getNodeWorldPos } from '../utils/sceneTree';
import { findNodeById, cloneSceneGraph, addChildNode } from './sceneClone';
import type { PhysicsWindow } from './physicsEngine';
import type { SliceDeps } from './sliceDeps';

/**
 * How addComponent places a part. By default from its own size: at the top
 * level it stands on the floor at the given x and y, clear of other bodies;
 * under a parent it goes beside it (below it, for the things that hang).
 * `exact` keeps the position as given, for a caller that chose one (MCP).
 */
export interface AddPlacement { exact?: boolean }

/*
 * A curve added from the palette: the shared default track a tenth the size,
 * so it fits the 160 mm view the others do. The DEFAULT_CURVE_* constants stay
 * as they are, because they are also the fallback for curves already saved.
 */
const PALETTE_CURVE_POINTS = DEFAULT_CURVE_POINTS.map((p) => p.map((v) => v * 0.1));

const PALETTE_CURVE_WIDTH = DEFAULT_CURVE_WIDTH * 0.1;

const PALETTE_CURVE_THICKNESS = DEFAULT_CURVE_THICKNESS * 0.1;

export interface AddComponentActions {
  /**
   * Adds a part and returns its id. With `parentId` it goes under that body and
   * the parent stays selected, so several adds in a row land side by side
   * rather than each under the last. Without one it goes at the top level and
   * is selected.
   */
  addComponent: (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid' | 'curve' | 'ring' | 'sculpt' | 'lattice' | 'blob', position: number[], parentId?: string | null, opts?: AddPlacement) => string;
  /** Adds a body; it is selected once built unless `select` is false. */
  addHardwareComponentNode: (hardwareNode: SceneNode, opts?: { select?: boolean }) => void;
}

export function addComponentActions({ set, get }: SliceDeps): AddComponentActions {
  return {
    addComponent: (type, position, parentId, opts) => {
      get().prepareForDiscreteChange();
      const { sceneGraph } = get();
      const newScene = cloneSceneGraph(sceneGraph);
    
      // 8-character random unique suffix (no millisecond timestamp)
      const id = `${type}_${Math.random().toString(36).substring(2, 10)}`;
    
      // Determine target local position
      let localPos: [number, number, number] = [position[0], position[1], position[2]];
    
      const isChild = !!parentId && !!findNodeById(newScene.nodes, parentId);
    
      if (isChild && parentId) {
        // Find parent world position to make drop coordinates relative to parent!
        const parentWorldPos = getNodeWorldPos(newScene.nodes, parentId);
        if (parentWorldPos) {
          localPos = [
            position[0] - parentWorldPos[0],
            position[1] - parentWorldPos[1],
            position[2] - parentWorldPos[2]
          ];
        }
      }

      let geomType: GeomType = type as GeomType;
      let size: number[] = [0.2];
      let rgba = [0.5, 0.5, 0.5, 1];
      let mass = 1;
      let joints: SceneJoint[] = [];
      let geoms: SceneGeom[] = [];
    
      const isChildJoint = isChild;
    
      if (type === 'gear') {
        const radius = 0.05;
        const teeth = 12;
        const color = [0.5, 0.5, 0.5, 1];
        geoms = generateGearGeoms(id, radius, teeth, color, false);
        joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1], damping: 0.5 }];
      } else if (type === 'pulley_wheel') {
        const r = 0.05;
        const thickness = 0.025;
        const spindle_r = r * 0.8;
        const spindle_h = thickness / 2 - 0.005;
        const flange_h = 0.005;
      
        geoms = [
          { name: `${id}_spindle`, type: 'cylinder', size: [spindle_r, spindle_h], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.5 },
          { name: `${id}_flange_l`, type: 'cylinder', size: [r, flange_h], pos: [0, -spindle_h - flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 },
          { name: `${id}_flange_r`, type: 'cylinder', size: [r, flange_h], pos: [0, spindle_h + flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 }
        ];
        joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.2 }];
      } else if (type === 'pulley_rope') {
        geoms = [];
        joints = [];
      } else if (type === 'curve') {
        // Rigid curved track: spline through control points, decomposed into
        // convex box segments so collision follows the real curve.
        geoms = generateCurveGeoms(id, PALETTE_CURVE_POINTS, PALETTE_CURVE_WIDTH, PALETTE_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS);
        joints = []; // static — welded to world like the wedge
        localPos = [localPos[0], localPos[1], 0]; // tracks sit on the ground, not in the air
      } else {
        if (type === 'box') {
          geomType = 'box';
          size = [0.05, 0.05, 0.05];
          rgba = [0.8, 0.2, 0.2, 1];
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'sphere') {
          geomType = 'sphere';
          size = [0.05];
          rgba = [0.2, 0.8, 0.2, 1];
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'capsule') {
          geomType = 'capsule';
          size = [0.01, 0.05];
          rgba = [0.6, 0.6, 0.6, 1];
          // Standalone poles are free bodies and fall like any other shape; only
          // when nested under a parent does a hinge (pendulum rod) make sense.
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'cylinder') {
          geomType = 'cylinder';
          size = [0.05, 0.04];
          rgba = [0.9, 0.6, 0.1, 1];
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'bob') {
          geomType = 'sphere';
          size = [0.04];
          rgba = [0.2, 0.6, 1.0, 1];
          mass = 10.0;
          joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }];
        } else if (type === 'wedge') {
          geomType = 'box';
          size = [0.06, 0.03, 0.015];
          rgba = [0.8, 0.5, 0.2, 1];
          // A wedge is a solid object, not a fixture: it falls and can be tipped
          // over like anything else. Set the joint to Fixed to weld it in place.
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'mesh') {
          // Dynamic icosahedron: radius 0.06, centred at body origin.
          // body pos = localPos handles spawn placement.
          // vertices: Y-up centred at (0,0,0) for the Three.js static render path fallback.
          // renderVertices: Z-up centred at (0,0,0) — icosahedron centroid is exactly (0,0,0).
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.5, 0.7, 0.9, 1],
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices: [-0.0315,0.051,0,0.0315,0.051,0,-0.0315,-0.051,0,0.0315,-0.051,0,0,-0.0315,0.051,0,0.0315,0.051,0,-0.0315,-0.051,0,0.0315,-0.051,0.051,0,-0.0315,0.051,0,0.0315,-0.051,0,-0.0315,-0.051,0,0.0315],
            // renderVertices: raw Z-up (Y↔Z swap only: Y-up (x,y,z)→(x,-z,y)), no centroid subtraction
            renderVertices: [-0.0315,0,0.051,0.0315,0,0.051,-0.0315,0,-0.051,0.0315,0,-0.051,0,-0.051,-0.0315,0,-0.051,0.0315,0,0.051,-0.0315,0,0.051,0.0315,0.051,0.0315,0,0.051,-0.0315,0,-0.051,0.0315,0,-0.051,-0.0315,0],
            faces: [0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1],
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'openscad') {
          // Default cube shape, will compile into a custom CSG mesh on render/edit
          geoms = [{
            name: `${id}_geom`,
            type: 'mesh',
            size: [1],
            rgba: [0.3, 0.6, 0.9, 1], // beautiful blue
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices: [
              -0.05, -0.05, -0.05,
               0.05, -0.05, -0.05,
               0.05,  0.05, -0.05,
              -0.05,  0.05, -0.05,
              -0.05, -0.05,  0.05,
               0.05, -0.05,  0.05,
               0.05,  0.05,  0.05,
              -0.05,  0.05,  0.05
            ],
            renderVertices: [
              -0.05,  0.05, -0.05,
               0.05,  0.05, -0.05,
               0.05,  0.05,  0.05,
              -0.05,  0.05,  0.05,
              -0.05, -0.05, -0.05,
               0.05, -0.05, -0.05,
               0.05, -0.05,  0.05,
              -0.05, -0.05,  0.05
            ],
            faces: [
              0, 2, 1,  0, 3, 2,
              4, 5, 6,  4, 6, 7,
              0, 1, 5,  0, 5, 4,
              1, 2, 6,  1, 6, 5,
              2, 3, 7,  2, 7, 6,
              3, 0, 4,  3, 4, 7
            ]
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'pyramid') {
          const w = 0.1;
          const d = 0.1;
          const h = 0.1;
          const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.85, 0.35, 0.15, 1], // reddish orange
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'cone') {
          const r = 0.05;
          const h = 0.1;
          const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.15, 0.65, 0.85, 1], // cyan blue
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'torus') {
          const R = 0.04;
          const r = 0.012;
          const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.55, 0.35, 0.85, 1], // purple
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'tube') {
          const r1 = 0.03;
          const r2 = 0.05;
          const h = 0.08;
          const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.35, 0.75, 0.35, 1], // green
            mass: 1,
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'ellipsoid') {
          geomType = 'ellipsoid';
          size = [0.06, 0.04, 0.03];
          rgba = [0.85, 0.55, 0.15, 1]; // yellow/orange
          joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'sculpt') {
          // A ball of clay: a subdivided icosahedron, uniform enough all over
          // that the first stroke lands the same wherever it is put. Detail is
          // added by the brush as it goes (see utils/sculptMesh.ts), so the base
          // is deliberately coarse — starting dense would only make every stroke
          // slower without making any of them finer.
          const { vertices, renderVertices, faces } = toSceneGeom(buildSculptBaseSized(DEFAULT_SCULPT_BASE, DEFAULT_SCULPT_SIZE));
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.82, 0.72, 0.62, 1], // unfired clay
            // No mass: weighed by its volume at 1000 kg/m³ (see generatedMeshMass).
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices,
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'lattice') {
          // An empty grid: the first thing drawn is the user's own, and the
          // panel's Add cube puts back the box this used to start as. See
          // utils/latticeMesh.ts.
          const cage = serializeCage(createLattice(LATTICE_UNIT));
          const { vertices, renderVertices, faces } = latticeToSceneGeom(deserializeCage(cage), 0);
          // Centred on the origin already, so the offset it starts with is zero —
          // but it is written down rather than assumed, because applyLattice
          // applies the CHANGE in offset and needs somewhere to start from.
          geoms = [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [0.55, 0.68, 0.85, 1], // drafting blue, to read as constructed
            // No mass: weighed by its volume at 1000 kg/m³ (see generatedMeshMass).
            condim: 3,
            dynamic: true,
            vertices,
            faces,
            renderVertices,
            // The cage's own geom, named as such from the start — a body that
            // later carries a cut has more than one mesh on it. See applyLattice.
            latticeGeom: true,
          }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        } else if (type === 'ring') {
          // The canonical boolean: a flattened ellipsoid with a slimmer ellipsoid
          // punched through it along Z. The negative is only a little taller than
          // the disc: it has to pierce right through (a flush cut leaves coincident
          // faces), but overshooting by multiples just makes a big outline in the
          // editor for no benefit. Nothing here is special-cased downstream —
          // it's just two ordinary primitives and a csg marker, so every slider in
          // the panel reshapes it and the mesh is regenerated from scratch.
          geoms = [
            { name: `${id}_body`, type: 'ellipsoid', size: [0.06, 0.06, 0.02], mass: 1, rgba: [0.85, 0.65, 0.2, 1], condim: 3 },
            { name: `${id}_hole`, type: 'ellipsoid', size: [0.03, 0.03, 0.035], csg: 'difference', pos: [0, 0, 0], rgba: [0.9, 0.25, 0.35, 1] },
          ];
          joints = [{ name: `${id}_free`, type: 'free' }];
        }
        if (type !== 'mesh' && type !== 'openscad' && type !== 'pyramid' && type !== 'cone' && type !== 'torus' && type !== 'tube' && type !== 'ring' && type !== 'sculpt' && type !== 'lattice') {
          geoms = [{ name: `${id}_geom`, type: geomType, size, mass, rgba }];
        }
        if (type === 'blob') {
          // A joint: a 12 mm ball of putty, weighing what putty weighs. Whatever
          // reaches into it is welded to it. See utils/joinMaterials.ts.
          const putty = joinMaterial(DEFAULT_JOIN_MATERIAL)!;
          geoms = [{ name: `${id}_geom`, type: 'ellipsoid', size: [0.006, 0.006, 0.006], rgba: [...putty.rgba], density: putty.density }];
          joints = [{ name: `${id}_free`, type: 'free' }];
        }
      }

      // MuJoCo allows a free joint only on a top-level body, and most branches
      // above give one unconditionally. Nested, the part gets the same hinge the
      // primitives get as children.
      if (isChild) {
        joints = joints.map((j): SceneJoint => j.type === 'free'
          ? { name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }
          : j);
      }

      const newNode: SceneNode = {
        id, name: id, type: 'body', pos: localPos,
        joints,
        geoms,
        children: [],
        ...(type === 'blob' ? { joinMaterial: DEFAULT_JOIN_MATERIAL } : {}),
        ...(type === 'wedge' ? {
          isWedge: true,
          width: 0.12,
          depth: 0.06,
          height: 0.03,
          wedgeAngle: 14.036
        } : {}),
        ...(type === 'pyramid' ? {
          isPyramid: true,
          // These must match the mesh built above. They are what the properties
          // panel shows and what a slider regenerates from, so a disagreement
          // makes the shape jump the first time one is touched — and a shape that
          // grows while its body stays put ends up inside the floor, which MuJoCo
          // resolves by ejecting it through.
          width: 0.1,
          depth: 0.1,
          height: 0.1
        } : {}),
        ...(type === 'cone' ? {
          isCone: true,
          radius: 0.05,
          height: 0.1
        } : {}),
        ...(type === 'torus' ? {
          isTorus: true,
          majorRadius: 0.04,
          tubeRadius: 0.012
        } : {}),
        ...(type === 'tube' ? {
          isTube: true,
          innerRadius: 0.03,
          outerRadius: 0.05,
          height: 0.08
        } : {}),
        ...(type === 'pulley_wheel' ? {
          isPulleyWheel: true,
          // Must match the flange geoms above (r = 0.05). It was 0.4, so a
          // dragged-in wheel drew its rope on a 0.4m rim around an 0.08m wheel
          // and coupled the rope kinematics to the wrong radius.
          pulleyRadius: 0.05
        } : {}),
        ...(type === 'pulley_rope' ? {
          isPulleyRope: true,
          pulleyWheelId: '',
          leftTargetId: '',
          rightTargetId: ''
        } : {}),
        ...(type === 'openscad' ? {
          scad: `// Example OpenSCAD Code\ndifference() {\n  cube([0.1, 0.1, 0.1], center=true);\n  sphere(d=0.12, $fn=16);\n}`
        } : {}),
        ...(type === 'ring' ? {
          csgEnabled: true,
          csgCollision: 'auto' as const,
          csgSectors: CSG_DEFAULT_SECTORS,
          csgMass: 1,
        } : {}),
        ...(type === 'sculpt' ? {
          isSculpt: true,
          sculptBase: DEFAULT_SCULPT_BASE,
          sculptVersion: 1,
        } : {}),
        ...(type === 'lattice' ? {
          isLattice: true,
          latticeCage: serializeCage(createLattice(LATTICE_UNIT)),
          latticeSubdiv: 0,
          latticeVersion: 1,
          latticeOrigin: [0, 0, 0],
        } : {}),
        ...(type === 'curve' ? {
          isCurve: true,
          curvePoints: PALETTE_CURVE_POINTS.map(p => [...p]),
          curveWidth: PALETTE_CURVE_WIDTH,
          curveThickness: PALETTE_CURVE_THICKNESS,
          curveSegments: DEFAULT_CURVE_SEGMENTS
        } : {}),
      };

      // Placed by its size, now that it has one: see utils/spawnPlacement.ts.
      if (!opts?.exact) {
        const parent = isChild ? findNodeById(newScene.nodes, parentId!) : null;
        if (parent) {
          newNode.pos = type === 'capsule' || type === 'bob'
            ? [0, 0, belowOffset(parent, newNode)]
            : [besideOffset(parent, newNode), 0, 0];
        } else if (!isChild) {
          newNode.pos = restingPos(newNode, newScene.nodes, position);
        }
      }

      if (isChild && parentId) {
        addChildNode(newScene.nodes, parentId, newNode);
      } else {
        newScene.nodes.push(newNode);
      }
    
      // A nested part leaves its parent selected: the next add goes beside it,
      // not under it.
      const selectId = isChild ? parentId! : typeof window !== 'undefined' && (window as PhysicsWindow).NO_SELECT ? null : id;
      /*
       * The body is written to the store HERE, not left for the recompile to land.
       *
       * recompile is debounced and drops out entirely when a later one supersedes
       * it, without ever writing its scene. So a body added while anything else
       * was touching the scene simply never appeared — no error, no node. Over MCP
       * that surfaced as physics_create_sculpt timing out after ten seconds
       * waiting for a node that was never going to arrive, which is how it failed
       * for a whole session once the app got busy.
       *
       * Writing it now also means the id can be used on the very next line, which
       * is what every caller wants and what the add-a-single-body bridge command
       * needs.
       */
      set(selectId === null ? { sceneGraph: newScene } : { sceneGraph: newScene, selectedNodeId: selectId });
      get().recompile(newScene, selectId);
      return id;
    },

    addHardwareComponentNode: (hardwareNode, opts) => {
      get().prepareForDiscreteChange();
      const sceneGraph = get().sceneGraph;
      const newNodes = [...sceneGraph.nodes, hardwareNode];
      // In the store now, not when the build lands: a build that finds the scene
      // changed under it keeps the newer scene, so a body that only rode in on the
      // build was lost to any edit made meanwhile — a collider decomposition
      // finishing just after a load took a simulated cast that way.
      const select = opts?.select !== false;
      // Selected, it is the whole selection, not one more body in it.
      set({ sceneGraph: { ...sceneGraph, nodes: newNodes }, ...(select ? { extraSelectedIds: [] } : {}) });
      get().recompile(get().sceneGraph, select ? hardwareNode.id : undefined);
    },
  };
}
