import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { rewriteGeom } from '../src/utils/combineBodies';
import { positiveBounds, flatFaceAt, evaluateNodeCsg } from '../src/utils/csg';
import { imprintOf } from '../src/utils/dentMesh';
import { boxLattice, vertexAt, addFace, orientFaces, toSceneGeom } from '../src/utils/latticeMesh';
import { generateLaserCutGcode, generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import { exportContourSliceSvg, DEFAULT_CONTOUR_OPTIONS } from '../src/utils/contourSliceExporter';
import { generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import { compileToMJCF } from '../src/utils/mjcf';
import { useStore } from '../src/store/useStore';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

vi.mock('../src/utils/openscad', () => ({
  compileSCAD: vi.fn(),
  setScadCompileListener: vi.fn(),
}));

// Unit cube in Three.js Y-up coordinates ([0,1]^3)
const CUBE_YUP_VERTS = [
  0, 0, 0,  1, 0, 0,  1, 0, 1,  0, 0, 1,
  0, 1, 0,  1, 1, 0,  1, 1, 1,  0, 1, 1,
];
const CUBE_FACES = [
  0, 1, 2,  0, 2, 3,
  4, 6, 5,  4, 7, 6,
  0, 4, 5,  0, 5, 1,
  1, 5, 6,  1, 6, 2,
  2, 6, 7,  2, 7, 3,
  3, 7, 4,  3, 4, 0,
];

describe('audit fixes', () => {
  it('1. rewriteGeom preserves static mesh vertices when renderVertices is absent', () => {
    const geom: SceneGeom = {
      name: 'static_mesh',
      type: 'mesh',
      size: [1],
      vertices: [...CUBE_YUP_VERTS],
      faces: [...CUBE_FACES],
    };
    const shift = new THREE.Matrix4().makeTranslation(2, 3, 4);
    const rewritten = rewriteGeom(geom, shift);
    expect(rewritten.renderVertices?.length).toBe(CUBE_YUP_VERTS.length);
    expect(rewritten.vertices?.length).toBe(CUBE_YUP_VERTS.length);
    // Origin (0,0,0) shifted by Z-up (2,3,4) -> Z-up (2,3,4)
    expect(rewritten.renderVertices!.slice(0, 3)).toEqual([2, 3, 4]);
  });

  it('2. positiveBounds and flatFaceAt work on static meshes without renderVertices', () => {
    const node: SceneNode = {
      id: 'static_cube',
      name: 'static_cube',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [{
        name: 'cube_g',
        type: 'mesh',
        size: [1],
        vertices: [...CUBE_YUP_VERTS],
        faces: [...CUBE_FACES],
      }],
    };
    const bounds = positiveBounds(node);
    expect(bounds).not.toBeNull();
    // Y-up (x in [0,1], y in [0,1], z in [0,1]) maps to Z-up (x in [0,1], y in [-1,0], z in [0,1])
    expect(bounds!.min).toEqual([0, -1, 0]);
    expect(bounds!.max).toEqual([1, 0, 1]);

    const topHit = flatFaceAt(node, [0.5, -0.5, 2], [0, 0, -1]);
    expect(topHit).not.toBeNull();
    expect(topHit!.normal[0]).toBeCloseTo(0, 6);
    expect(topHit!.normal[1]).toBeCloseTo(0, 6);
    expect(topHit!.normal[2]).toBeCloseTo(1, 6);
  });

  it('3. evaluateNodeCsg slices around the unshifted Z hole origin so elevated horizontal holes decompose cleanly', async () => {
    const openscad = await import('../src/utils/openscad');
    // Build a hollow tube along the X axis elevated at Z = 0.5 (spanning z in [0.4, 0.6])
    const renderVertices: number[] = [];
    const vertices: number[] = [];
    const faces: number[] = [];
    const N = 16;
    const rOut = 0.1, rIn = 0.05;
    for (const x of [-0.05, 0.05]) {
      for (const r of [rOut, rIn]) {
        for (let i = 0; i < N; i++) {
          const a = (2 * Math.PI * i) / N;
          const y = r * Math.cos(a);
          const z = 0.5 + r * Math.sin(a);
          renderVertices.push(x, y, z);
          vertices.push(x, z, -y);
        }
      }
    }
    const idx = (xIdx: number, rIdx: number, i: number) => xIdx * 2 * N + rIdx * N + (i % N);
    for (let i = 0; i < N; i++) {
      // Outer wall (+r normal)
      faces.push(idx(0, 0, i), idx(1, 0, i), idx(1, 0, i + 1));
      faces.push(idx(0, 0, i), idx(1, 0, i + 1), idx(0, 0, i + 1));
      // Inner wall (-r normal)
      faces.push(idx(0, 1, i), idx(1, 1, i + 1), idx(1, 1, i));
      faces.push(idx(0, 1, i), idx(0, 1, i + 1), idx(1, 1, i + 1));
      // -X cap
      faces.push(idx(0, 0, i), idx(0, 0, i + 1), idx(0, 1, i + 1));
      faces.push(idx(0, 0, i), idx(0, 1, i + 1), idx(0, 1, i));
      // +X cap
      faces.push(idx(1, 0, i), idx(1, 1, i + 1), idx(1, 0, i + 1));
      faces.push(idx(1, 0, i), idx(1, 1, i), idx(1, 1, i + 1));
    }
    vi.mocked(openscad.compileSCAD).mockResolvedValueOnce({
      vertices,
      renderVertices,
      faces,
    });
    const node: SceneNode = {
      id: 'elevated_tube',
      name: 'elevated_tube',
      type: 'body',
      pos: [0, 0, 0],
      joints: [{ name: 't_free', type: 'free' }],
      children: [],
      csgEnabled: true,
      csgCollision: 'decompose',
      geoms: [
        { name: 'block', type: 'box', size: [0.05, 0.1, 0.1], pos: [0, 0, 0.5] },
        // Horizontal bore along the X axis (euler [0, 90, 0] turns cylinder Z axis onto X) at Z = 0.5
        { name: 'bore', type: 'cylinder', size: [0.05, 0.08], pos: [0, 0, 0.5], euler: [0, 90, 0], csg: 'difference' },
      ],
    };
    const res = await evaluateNodeCsg(node);
    expect(res).not.toBeNull();
    expect(res!.mode).toBe('decompose');
    const colliders = res!.geoms.filter((g) => g.csgDerived === 'collider');
    expect(colliders.length).toBe(16);
  });

  it('4. imprintOf considers all three axes so a flat plate thin along Y uses its narrowest dimension', () => {
    const plateThinInY: SceneGeom = {
      name: 'plate',
      type: 'box',
      size: [0.08, 0.004, 0.08],
    };
    const imprint = imprintOf(plateThinInY);
    expect(imprint).not.toBeNull();
    expect(imprint!.radius).toBeCloseTo(0.004, 6);
  });

  it('5. orientFaces uses area-weighted Newell normals so a tiny inverted sliver cannot flip a solid', () => {
    const lattice = boxLattice(0.001, 100);
    // Flip one face of the box so orientFaces has to walk and orient the component
    lattice.faces[0]!.reverse();
    // Attach a tiny face far along +Z whose unit normal points inward (-Z)
    const vFar1 = vertexAt(lattice, 0, 0, 10000);
    const vFar2 = vertexAt(lattice, 1, 0, 10000);
    const vFar3 = vertexAt(lattice, 0, 1, 10000);
    // Share vertex 0 with the box so it belongs to the same connected component
    addFace(lattice, [0, vFar1, vFar2, vFar3]);
    orientFaces(lattice);
    // Drop the auxiliary tiny face before checking the box's enclosed volume
    lattice.faces.pop();
    const geom = toSceneGeom(lattice, 0, 0);
    let vol6 = 0;
    const v = geom.renderVertices;
    const f = geom.faces;
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
      vol6 +=
        v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
        v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
    }
    expect(vol6).toBeGreaterThan(0);
  });

  it('6. generateLaserCutGcode retracts to safeZ before XY rapid and generateContourSliceGcode honours placedPos2D', () => {
    const panel = {
      id: 'p1',
      name: 'P1',
      thickness: 0.003,
      origin3D: { x: 0, y: 0, z: 0 },
      normal3D: { x: 0, y: 0, z: 1 },
      uAxis3D: { x: 1, y: 0, z: 0 },
      vAxis3D: { x: 0, y: 1, z: 0 },
      outerPolygon2D: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      innerCutouts2D: [],
      edges3D: [],
      placedPos2D: { x: 50, y: 60 },
      width2D: 20,
      height2D: 20,
    };
    const cnc = generateLaserCutGcode([panel], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      safeZ: 7,
      cutterCompensation: 'off',
    });
    // Up at safe Z by the time of the first rapid across the stock, which
    // lands on the panel where it was placed.
    let z: number | null = null;
    const lines = cnc.gcode.split('\n');
    const firstXY = lines.findIndex((l) => /^G0 X/.test(l));
    for (const l of lines.slice(0, firstXY)) {
      const m = /^G[01]\b[^;]*Z(-?[\d.]+)/.exec(l);
      if (m) z = parseFloat(m[1]);
    }
    expect(z).toBe(7);
    const at = (l: string) => ({ x: parseFloat(/X(-?[\d.]+)/.exec(l)![1]), y: parseFloat(/Y(-?[\d.]+)/.exec(l)![1]) });
    const p = at(lines[firstXY]);
    expect(p.x).toBeGreaterThanOrEqual(50);
    expect(p.x).toBeLessThanOrEqual(70);
    expect(p.y).toBeGreaterThanOrEqual(60);
    expect(p.y).toBeLessThanOrEqual(80);

    const sliceGcode = generateContourSliceGcode({
      success: true,
      sheetCount: 1,
      layers: [
        {
          index: 0,
          z: 0,
          loops: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]],
          pieceCount: 1,
          areaMm2: 100,
          placedPos2D: { x: 120, y: 80 },
          modelOffset2D: { x: 0, y: 0 },
        },
      ],
    }, { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser', cutterCompensation: 'off' });
    const first = sliceGcode.gcode.split('\n').find((l) => /^G0 X/.test(l))!;
    const x = parseFloat(/X(-?[\d.]+)/.exec(first)![1]);
    const y = parseFloat(/Y(-?[\d.]+)/.exec(first)![1]);
    expect(x).toBeGreaterThanOrEqual(120);
    expect(x).toBeLessThanOrEqual(130);
    expect(y).toBeGreaterThanOrEqual(80);
    expect(y).toBeLessThanOrEqual(90);
  });

  it('7. exportContourSliceSvg scales areaMm2 and labelPos2D when scaleFactor !== 1', () => {
    const scene: SceneGraph = {
      nodes: [{
        id: 'box1',
        name: 'box1',
        type: 'body',
        pos: [0, 0, 0.01],
        joints: [],
        children: [],
        // 100 mm x 100 mm x 6 mm box (half-extents 0.05, 0.05, 0.003)
        geoms: [{ name: 'g1', type: 'box', size: [0.05, 0.05, 0.003] }],
      }],
    };
    const res = exportContourSliceSvg(scene, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.003,
      pinHoles: false,
      scaleFactor: 0.5,
      includeLabels: true,
    });
    expect(res.success).toBe(true);
    const layer = res.layers![0];
    // 100 mm x 100 mm = 10,000 mm^2; at 0.5x scale -> 50 mm x 50 mm = 2,500 mm^2
    expect(layer.areaMm2).toBeCloseTo(2500, 0);
  });

  it('8. generateSolidMachining emits an explicit cutting feedrate on helical registration pin bores', () => {
    const scene: SceneGraph = {
      nodes: [{
        id: 'block',
        name: 'block',
        type: 'body',
        pos: [0, 0, 0.01],
        joints: [],
        children: [],
        geoms: [{ name: 'b_g', type: 'box', size: [0.01, 0.01, 0.005] }],
      }],
    };
    const job = generateSolidMachining(scene, {
      sides: 2,
      roughingEnabled: true,
      roughingToolDiaMm: 6,
      pinDiaMm: 8,
      roughingFeedrate: 1200,
      roughingPlungeRate: 300,
    });
    expect(job.success).toBe(true);
    const sideA = job.sides[0].gcode;
    const pinStart = sideA.indexOf('; --- OP 0: registration pins');
    const pinEnd = sideA.indexOf('G0 X0 Y0 ; back over the origin before the part');
    expect(pinStart).toBeGreaterThanOrEqual(0);
    expect(pinEnd).toBeGreaterThan(pinStart);
    const pinSection = sideA.slice(pinStart, pinEnd);
    const helicalMoves = pinSection
      .split('\n')
      .filter((line) => /^G1 X[-\d.]+ Y[-\d.]+ Z[-\d.]+/.test(line));
    expect(helicalMoves.length).toBeGreaterThan(0);
    // The helix is fed so that it comes down no faster than the plunge rate,
    // which is below the cutting feed; every move still names its feed.
    for (const move of helicalMoves) {
      const feed = Number(/ F(\d+)/.exec(move)?.[1]);
      expect(feed).toBeGreaterThanOrEqual(300);
      expect(feed).toBeLessThanOrEqual(1200);
    }
    // The flat lap that trues the hole is cut at the cutting feed.
    expect(pinSection).toMatch(/^G1 X[-\d.]+ Y[-\d.]+ F1200$/m);
  });

  it('9. withoutMeshData strips all mesh vertex buffers and compileToMJCF recognises baseRenderVertices as baked', () => {
    const scene: SceneGraph = {
      nodes: [{
        id: 'n1',
        name: 'n1',
        type: 'body',
        pos: [0, 0, 0.2],
        euler: [30, 45, 60],
        joints: [{ name: 'n1_free', type: 'free' }],
        children: [],
        geoms: [{
          name: 'n1_mesh',
          type: 'mesh',
          size: [1],
          dynamic: true,
          vertices: [...CUBE_YUP_VERTS],
          renderVertices: [...CUBE_YUP_VERTS],
          baseRenderVertices: [...CUBE_YUP_VERTS],
          colliderVertices: [...CUBE_YUP_VERTS],
          colliderFaces: [...CUBE_FACES],
          faces: [...CUBE_FACES],
        }],
      }],
    };
    const stripped = withoutMeshData(scene);
    const g = stripped.nodes[0].geoms[0];
    expect(g.baseRenderVertices).toBeUndefined();
    expect(g.colliderVertices).toBeUndefined();
    expect(g.colliderFaces).toBeUndefined();

    const xml = compileToMJCF(scene);
    const bodyOpenTag = (xml.match(/<body name="n1"[^>]*>/) || [''])[0];
    expect(bodyOpenTag).not.toContain('euler=');
  });

  it('10. updateNodeRotation keeps dynamic mesh collision vertices and renderVertices aligned in Z-up space', () => {
    const store = useStore.getState();
    const initialRender = [1, 0, 0,  0, 1, 0,  0, 0, 1];
    // Y-up vertices that map to initialRender via (x, y, z) -> (x, -z, y)
    const initialYup = [1, 0, 0,  0, 0, -1,  0, 1, 0];
    useStore.setState({
      sceneGraph: {
        nodes: [{
          id: 'rot_mesh',
          name: 'rot_mesh',
          type: 'body',
          pos: [0, 0, 0],
          joints: [{ name: 'rot_free', type: 'free' }],
          children: [],
          geoms: [{
            name: 'rot_g',
            type: 'mesh',
            size: [1],
            dynamic: true,
            vertices: [...initialYup],
            renderVertices: [...initialRender],
            faces: [0, 1, 2],
          }],
        }],
      },
    });
    // Rotate +90 deg around Z-up Z axis: (1, 0, 0) -> (0, 1, 0) in Z-up
    store.updateNodeRotation('rot_mesh', 2, 90, false);
    const updated = useStore.getState().sceneGraph.nodes[0].geoms[0];
    expect(updated.baseVertices).toBeDefined();
    expect(updated.baseRenderVertices).toBeDefined();
    expect(updated.renderVertices![0]).toBeCloseTo(0, 5);
    expect(updated.renderVertices![1]).toBeCloseTo(1, 5);
    expect(updated.renderVertices![2]).toBeCloseTo(0, 5);
  });
});
