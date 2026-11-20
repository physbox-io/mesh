import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { ClothSpec } from '../src/types/cloth';
import { ClothCcd } from '../src/utils/cloth/clothCcd';
import { buildSdf, colliderContact, meshShape, sceneColliders, type Collider } from '../src/utils/cloth/clothColliders';
import { buildClothWorld } from '../src/utils/cloth/clothWorld';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import type { ClothModel } from '../src/utils/cloth/clothModel';
import { addRod, type RodConstraints } from '../src/utils/cloth/clothRods';
import { CLOTH_SUBSTEP, ClothSim, clothNormalCoefficient } from '../src/utils/cloth/xpbd';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { boxMesh, zupToYupFlat } from './helpers/meshes';
import { clothRun, mujocoReady } from './clothSimHarness';

const squareEdges = (s: number) => [
  { id: 'bottom', pts: [[-s / 2, -s / 2], [s / 2, -s / 2]] },
  { id: 'right', pts: [[s / 2, -s / 2], [s / 2, s / 2]] },
  { id: 'top', pts: [[s / 2, s / 2], [-s / 2, s / 2]] },
  { id: 'left', pts: [[-s / 2, s / 2], [-s / 2, -s / 2]] },
] as NonNullable<ClothSpec['pieces']>[number]['edges'];

describe('XPBD solver, collision, and worker carry fixes', () => {
  it('writeRender is strictly read-only and never mutates positions, velocities, or CCD counters', async () => {
    const nodes: SceneNode[] = [{
      id: 'sheet', name: 'sheet', pos: [0, 0, 1],
      cloth: {
        pieces: [
          { name: 'a', edges: squareEdges(0.3), placement: { kind: 'plane', origin: [0, 0, 0.05] } },
          { name: 'b', edges: squareEdges(0.3), placement: { kind: 'plane', origin: [0, 0, 0] } },
        ],
        spacing: 0.06,
        sewTime: 0,
      },
    } as SceneNode];
    const r = await clothRun(nodes);
    // Step by a single 1/600 s substep so ccdSince === 1 (between CCD_EVERY=8 checkpoints).
    r.sim.advance(CLOTH_SUBSTEP, { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.225 });
    const xBefore = Float64Array.from(r.sim.x);
    const stBefore = r.sim.state();
    const callsBefore = r.sim.ccdTotals.calls;
    const out = new Float64Array(3 * r.sim.renderSize());
    r.sim.writeRender(out);
    expect(Array.from(r.sim.x)).toEqual(Array.from(xBefore));
    expect(Array.from(r.sim.state().v)).toEqual(Array.from(stBefore.v));
    expect(r.sim.ccdTotals.calls).toBe(callsBefore);
  });

  it('ClothSim.state() and restore() preserve accumulator, floatUntil, board quaternions, and zipper state across worker recycles', async () => {
    const mj = await mujocoReady();
    const form = bodyFormNode('form', 'form', {});
    const jacket = garmentNode('jacket', 'jacket', {
      garment: 'jacket',
      opening: true,
      trims: [{ kind: 'zipper', along: 'opening', fastened: 0.75 }],
      collar: { stand: 0.04, fall: 0, materialOverrides: { thickness: 0.003, young: 2e8 } },
    }, form);
    jacket.cloth!.spacing = 0.05;
    const graph: SceneGraph = { nodes: [form, jacket] } as SceneGraph;
    const xml = compileToMJCF(graph);
    const m1 = mj.MjModel.from_xml_string(xml);
    const d1 = new mj.MjData(m1);
    mj.mj_forward(m1, d1);
    const stripped = withoutMeshData(graph);
    const w1 = buildClothWorld(mj, m1, d1, stripped, null, false)!;
    // Move the zipper slider mid-run and advance by a non-multiple of CLOTH_SUBSTEP so accumulator > 0.
    w1.sim.setZip('jacket', 0, 0.42);
    w1.advance(0.011, { gravity: [0, 0, -9.81], wind: [3, 0, 0], airDensity: 1.225 });
    const snap = w1.sim.state();
    expect(snap.accumulator).toBeGreaterThan(0);
    expect(snap.boardsQ.length).toBeGreaterThan(0);
    expect(snap.zips[0]).toBeCloseTo(0.42, 6);

    // Simulate a fresh recycled worker (previous === null, carry === true, seedClothState === snap).
    const m2 = mj.MjModel.from_xml_string(xml);
    const d2 = new mj.MjData(m2);
    mj.mj_forward(m2, d2);
    const w2 = buildClothWorld(mj, m2, d2, stripped, null, true, snap)!;
    const snap2 = w2.sim.state();
    expect(snap2.time).toBeCloseTo(snap.time, 9);
    expect(snap2.accumulator).toBeCloseTo(snap.accumulator, 9);
    expect(Array.from(snap2.x)).toEqual(Array.from(snap.x));
    expect(Array.from(snap2.v)).toEqual(Array.from(snap.v));
    expect(Array.from(snap2.boardsQ)).toEqual(Array.from(snap.boardsQ));
    expect(snap2.zips[0]).toBeCloseTo(0.42, 6);

    // Also verify visual-only rgba/pattern edits preserve ClothSim state without re-meshing from scratch.
    const editedGraph: SceneGraph = {
      nodes: [
        form,
        {
          ...jacket,
          cloth: {
            ...jacket.cloth!,
            garment: {
              ...jacket.cloth!.garment!,
              rgba: [0.9, 0.2, 0.2, 1],
              pattern: { svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" fill="red"/></svg>', scale: 0.2 },
            },
          },
        } as SceneNode,
      ],
    } as SceneGraph;
    const w3 = buildClothWorld(mj, m2, d2, withoutMeshData(editedGraph), w2, true)!;
    expect(Array.from(w3.sim.x)).toEqual(Array.from(snap.x));
    expect(w3.sim.renderLayout()[0].rgba).toEqual([0.9, 0.2, 0.2, 1]);

    d1.delete(); m1.delete();
    d2.delete(); m2.delete();
  });

  it('collides cloth against CSG boolean bodies (keepDrawn), wedges, and dynamic dense STL collider copies', async () => {
    const box = boxMesh([0, 0, 0], [0.25, 0.25, 0.15]);
    const csgNode: SceneNode = {
      id: 'csgBlock', name: 'csgBlock', pos: [0, 0, 0.15], csgEnabled: true,
      geoms: [
        { name: 'csg_src', type: 'box', size: [0.25, 0.25, 0.15], pos: [0, 0, 0] },
        { name: 'csg_vis', type: 'mesh', size: [1, 1, 1], csgDerived: 'visual', role: 'visual', vertices: zupToYupFlat(box.verts), renderVertices: box.verts, faces: box.faces },
      ],
    } as SceneNode;
    const clothOverCsg: SceneNode = {
      id: 'drapeCsg', name: 'drapeCsg', pos: [0, 0, 0.36],
      cloth: { pieces: [{ name: 'p', edges: squareEdges(0.3) }], spacing: 0.05, sewTime: 0 },
    } as SceneNode;
    const rCsg = await clothRun([csgNode, clothOverCsg]);
    rCsg.run(0.6);
    // Top of CSG block is at z = 0.30 m: cloth must rest near z ≈ 0.30 m, not fall to z = 0.
    let midZ = -Infinity;
    for (let i = 0; i < rCsg.sim.n; i++) {
      if (Math.hypot(rCsg.sim.x[3 * i], rCsg.sim.x[3 * i + 1]) < 0.08) midZ = Math.max(midZ, rCsg.sim.x[3 * i + 2]);
    }
    expect(midZ).toBeGreaterThan(0.28);

    // Wedge node (isWedge: true): prism ramp rather than oversized bounding box.
    const wedgeNode: SceneNode = {
      id: 'ramp', name: 'ramp', pos: [0, 0, 0], isWedge: true, width: 0.6, depth: 0.6, height: 0.3,
      geoms: [{ name: 'ramp_g', type: 'box', size: [0.3, 0.3, 0.15] }],
    } as SceneNode;
    const clothOverWedge: SceneNode = {
      id: 'drapeWedge', name: 'drapeWedge', pos: [0, 0, 0.38],
      cloth: { pieces: [{ name: 'p', edges: squareEdges(0.2) }], spacing: 0.05, sewTime: 0 },
    } as SceneNode;
    const rWedge = await clothRun([wedgeNode, clothOverWedge]);
    expect(rWedge.colliders.some((c) => c.shape.kind === 'sdf')).toBe(true);
    rWedge.run(0.5);
    let minWedgeZ = Infinity;
    for (let i = 0; i < rWedge.sim.n; i++) minWedgeZ = Math.min(minWedgeZ, rWedge.sim.x[3 * i + 2]);
    expect(minWedgeZ).toBeGreaterThan(0.05);

    // Dynamic dense STL (`colliderVertices` / `colliderFaces` emits `${name}_collider` in MJCF and drops visual mesh).
    const denseNode: SceneNode = {
      id: 'denseStl', name: 'denseStl', pos: [0, 0, 0.2],
      joints: [{ name: 'dense_slide', type: 'slide', axis: [0, 0, 1], range: [0, 0.001], limited: true }],
      geoms: [{
        name: 'dense_vis', type: 'mesh', size: [1, 1, 1], mass: 5,
        vertices: zupToYupFlat(box.verts), renderVertices: box.verts, faces: box.faces,
        colliderVertices: box.verts, colliderFaces: box.faces, denseColliderOf: 'test',
      }],
    } as SceneNode;
    const clothOverDense: SceneNode = {
      id: 'drapeDense', name: 'drapeDense', pos: [0, 0, 0.42],
      cloth: { pieces: [{ name: 'p', edges: squareEdges(0.25) }], spacing: 0.05, sewTime: 0 },
    } as SceneNode;
    const rDense = await clothRun([denseNode, clothOverDense]);
    expect(rDense.colliders.some((c) => c.shape.kind === 'sdf')).toBe(true);
    rDense.run(0.5);
    let midDenseZ = -Infinity;
    for (let i = 0; i < rDense.sim.n; i++) {
      if (Math.hypot(rDense.sim.x[3 * i], rDense.sim.x[3 * i + 1]) < 0.08) midDenseZ = Math.max(midDenseZ, rDense.sim.x[3 * i + 2]);
    }
    expect(midDenseZ).toBeGreaterThan(0.33);
  });

  it('tracks moving rigid collider surface velocity so resting cloth rides a translating slab via friction', () => {
    const model: ClothModel = {
      name: 'patch',
      material: CLOTH_MATERIALS.canvas,
      layer: 0,
      outward: false,
      selfCollide: false,
      sewTime: 0,
      x0: Float64Array.of(-0.02, 0, 0.104, 0.02, 0, 0.104, 0, 0.03, 0.104),
      invMass: Float64Array.of(100, 100, 100),
      tris: [0, 1, 2],
      edges: [0, 1, 1, 2, 2, 0],
      edgeRest: [0.04, Math.hypot(0.02, 0.03), Math.hypot(0.02, 0.03)],
      edgeMin: [0.04, Math.hypot(0.02, 0.03), Math.hypot(0.02, 0.03)],
      edgeStiffness: [1, 1, 1],
      elastics: [], elasticRest: [], elasticFlat: [], elasticAlpha: [],
      bends: [], bendWeights: [], bendArea: [], bendRest: [], bendStiffness: [],
      limits: [], limitRest: [],
      stitches: [], tacks: [], ties: [],
      groups: [{ name: 'patch__p', rgba: [1, 1, 1, 1], material: 'canvas', particles: [0, 1, 2], tris: [0, 1, 2] }],
    };
    const slab: Collider = {
      body: 'slab',
      local: new THREE.Matrix4(),
      shape: { kind: 'box', half: [2, 2, 0.1] },
      friction: 0.9,
      bounds: { min: [-2, -2, -0.1], max: [2, 2, 0.1] },
    };
    const mat = new THREE.Matrix4();
    const sim = new ClothSim([model], [slab]);
    sim.setPoses(() => mat);
    sim.settleNow();

    // Translate the slab at +0.4 m/s along +X for 0.5 s: cloth should ride along with it!
    const speed = 0.4;
    for (let step = 1; step <= 300; step++) {
      mat.makeTranslation(speed * step * CLOTH_SUBSTEP, 0, 0);
      sim.setPoses(() => mat);
      sim.advance(CLOTH_SUBSTEP, { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 0 });
    }
    const meanX = (sim.x[0] + sim.x[3] + sim.x[6]) / 3;
    expect(meanX).toBeGreaterThan(0.12);
  });

  it('ClothCcd dynamic reach catches a stationary point swept by a coarse (> 6 cm) swinging triangle', () => {
    // Corner 0 fixed at origin; corners 1 & 2 are 0.25 m out (> old fixed 0.06 m REACH) swinging down across stationary point 3 at x = 0.02 m (within 2 cm of fixed corner 0, 23 cm away from the moving corners!).
    // Note: triangle (0, 1, 2) with y1=-0.08, y2=+0.08 has normal pointing -Z; at t=0 corners 1 & 2 start at z=+0.02 while point 3 is at z=+0.0005 (below the triangle, i.e. on the +normal side!), and swing down to z=-0.02 through point 3!
    const x0 = Float64Array.of(
      0, 0, 0, 0.25, -0.08, 0.02, 0.25, 0.08, 0.02,
      0.02, 0, 0.0005, -5, 0, 0.0005, -5, 0.01, 0.0005,
    );
    const x1 = Float64Array.of(
      0, 0, 0, 0.25, -0.08, -0.02, 0.25, 0.08, -0.02,
      0.02, 0, 0.0005, -5, 0, 0.0005, -5, 0.01, 0.0005,
    );
    const tris = Int32Array.of(0, 1, 2, 3, 4, 5);
    const root = Int32Array.from({ length: 6 }, (_, i) => i);
    const ccd = new ClothCcd(6, tris, root);
    const st = ccd.resolve(x0, x1, Float64Array.of(0, 1, 1, 1, 1, 1));
    expect(st.met).toBeGreaterThan(0);
    // Point 3 started below triangle (0, 1, 2) (z_p = 0.0005 < z_tri(t=0) = 0.08 * 0.02 = 0.0016) and must remain below z_tri(t=1) at barycentric (0.92, 0.04, 0.04)!
    const zTri = 0.92 * x1[2] + 0.04 * x1[5] + 0.04 * x1[8];
    expect(x1[11]).toBeLessThan(zTri);
  });

  it('meshShape FNV-1a cache distinguishes interior sculpt edits, SdfGrid pushes deep interior points outward, and ellipsoid centre is finite', () => {
    // Subdivide a box or add an interior apex vertex that isn't at index 0, mid, or last:
    const base = boxMesh([0, 0, 0], [0.2, 0.2, 0.2]);
    // Insert extra vertex at index 1 (not 0, not mid, not last) and form a tall pyramid on +Z face!
    const vA = [...base.verts, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.2];
    const vB = [...base.verts, 0, 0, 0.38, 0, 0, 0.2, 0, 0, 0.2];
    // Replace +Z quad (4,5,6,7) with 4 triangles meeting at vertex 8 (index 8 out of 11 -> not 0, not floor(11/2)=5, not 10!).
    const fRest = base.faces.slice(6);
    const faces = [...fRest, 4, 5, 8, 5, 6, 8, 6, 7, 8, 7, 4, 8];
    const sA = meshShape(vA, faces, false);
    const sB = meshShape(vB, faces, false);
    expect(sB.bounds.max[2]).toBeGreaterThan(sA.bounds.max[2] + 0.15);

    // Deep interior point (0, 0, 0) inside a 0.4 x 0.4 x 0.4 m box (cell ≈ 4 mm, so 0.2 m = 50 cells deep >> BAND=2!):
    const grid = buildSdf(
      Array.from({ length: base.verts.length / 3 }, (_, i) => [base.verts[3 * i], base.verts[3 * i + 1], base.verts[3 * i + 2]]),
      base.faces,
    );
    const deep = grid.query(0.03, 0.01, 0.01);
    expect(deep).not.toBeNull();
    expect(deep!.d).toBeLessThan(-0.1);
    expect(Math.hypot(...deep!.n)).toBeCloseTo(1, 5);
    expect(deep!.n[0]).toBeGreaterThan(0.5);

    // Ellipsoid exact centre (0, 0, 0) returns finite negative distance and unit normal (no NaN / 0-normal).
    const ell: Collider = {
      body: 'e',
      local: new THREE.Matrix4(),
      shape: { kind: 'ellipsoid', r: [0.2, 0.12, 0.3] },
      friction: 0.5,
      bounds: { min: [-0.2, -0.12, -0.3], max: [0.2, 0.12, 0.3] },
    };
    const hit = colliderContact(ell, [0, 0, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.d).toBeCloseTo(-0.12, 6);
    expect(Math.hypot(...hit!.n)).toBeCloseTo(1, 6);

    // Verify sceneColliders handles degenerate 0-radius ellipsoid safely too.
    const degCols = sceneColliders([{
      id: 'deg', name: 'deg', pos: [0, 0, 0],
      geoms: [{ name: 'deg_g', type: 'ellipsoid', size: [0, 0.1, 0.1] }],
    } as SceneNode], false);
    const degHit = colliderContact(degCols[0], [0, 0, 0]);
    expect(Number.isFinite(degHit?.d)).toBe(true);
  });

  it('applies still-air aerodynamic drag to falling cloth, keeps clothNormalCoefficient monotonic, and unfolds inverted curved bends/rods', async () => {
    // 1. Monotonic clothNormalCoefficient across [0, pi/2] (zero negative-slope stall drop).
    let prevCn = -1;
    for (let deg = 0; deg <= 90; deg++) {
      const cn = clothNormalCoefficient((deg * Math.PI) / 180, 1.2);
      expect(cn).toBeGreaterThanOrEqual(prevCn - 1e-12);
      prevCn = cn;
    }
    expect(clothNormalCoefficient(Math.PI / 2, 1.2)).toBeCloseTo(1.2, 6);

    // 2. Horizontal handkerchief dropped in still air (wind = [0,0,0]) falls significantly slower in air than in vacuum!
    const sheetNode: SceneNode = {
      id: 'hankie', name: 'hankie', pos: [0, 0, 3],
      cloth: {
        pieces: [{ name: 'p', edges: squareEdges(0.3), placement: { kind: 'plane' } }],
        material: 'taffeta',
        spacing: 0.06,
        sewTime: 0,
      },
    } as SceneNode;
    const inAir = await clothRun([sheetNode]);
    const inVac = await clothRun([sheetNode]);
    inAir.run(0.6, { wind: [0, 0, 0], airDensity: 1.225 });
    inVac.run(0.6, { wind: [0, 0, 0], airDensity: 0 });
    expect(inAir.sim.x[2]).toBeGreaterThan(inVac.sim.x[2] + 0.35);

    // 3. Non-zero curved dihedral hinge and curved rod recover from an inverted (-theta_0) fold instead of locking inside-out!
    // Build a 2-triangle hinge folded +60 deg upward at rest, then flip vertex 3 to -60 deg downward and verify it springs back > 0!
    const L = 0.05, ang = Math.PI / 3;
    // q0=(0,0,0), q1=(0,L,0), q2=(-L, L/2, 0) fixed; q3=(L*cos(ang), L/2, L*sin(ang)) free.
    const x0 = Float64Array.of(
      0, 0, 0,
      0, L, 0,
      -L, L / 2, 0,
      L * Math.cos(ang), L / 2, L * Math.sin(ang),
    );
    // Isometric bend weights for (q0, q1, q2, q3): simple symmetric stencil [k0, k1, k2, k3] = [-1, -1, 1, 1] / L
    const kw = [-1 / L, -1 / L, 1 / L, 1 / L];
    const vx0 = kw[0] * x0[0] + kw[1] * x0[3] + kw[2] * x0[6] + kw[3] * x0[9];
    const vy0 = kw[0] * x0[1] + kw[1] * x0[4] + kw[2] * x0[7] + kw[3] * x0[10];
    const vz0 = kw[0] * x0[2] + kw[1] * x0[5] + kw[2] * x0[8] + kw[3] * x0[11];
    const cRest = Math.hypot(vx0, vy0, vz0);

    const rods: RodConstraints = { links: [], linkRest: [], bends: [], bendRest: [], bendAlpha: [] };
    const rodPts = [[x0[6], x0[7], x0[8]], [0, L / 2, 0], [x0[9], x0[10], x0[11]]];
    // Also test a 3-point curved rod in a separate mini sim:
    const rodMass = [0.01, 0.01, 0.01];
    addRod(rods, [0, 1, 2], false, () => L, rodPts, { along: 'edge', kind: 'flatSteel' }, rodMass);

    const hingeModel: ClothModel = {
      name: 'hinge',
      material: CLOTH_MATERIALS.leather,
      layer: 0, outward: false, selfCollide: false, sewTime: 0,
      x0,
      invMass: Float64Array.of(0, 0, 0, 500),
      tris: [0, 1, 2, 0, 3, 1],
      edges: [0, 1, 1, 2, 2, 0, 0, 3, 3, 1],
      edgeRest: [L, Math.hypot(L, L / 2), Math.hypot(L, L / 2), Math.hypot(L, L / 2), Math.hypot(L, L / 2)],
      edgeMin: [L, Math.hypot(L, L / 2), Math.hypot(L, L / 2), Math.hypot(L, L / 2), Math.hypot(L, L / 2)],
      edgeStiffness: [1, 1, 1, 1, 1],
      elastics: [], elasticRest: [], elasticFlat: [], elasticAlpha: [],
      bends: [0, 1, 2, 3], bendWeights: kw, bendArea: [L * L], bendRest: [cRest], bendStiffness: [20],
      limits: [], limitRest: [], stitches: [], tacks: [], ties: [],
      groups: [{ name: 'hinge__g', rgba: [1, 1, 1, 1], material: 'leather', particles: [0, 1, 2, 3], tris: [0, 1, 2, 0, 3, 1] }],
    };
    const hingeSim = new ClothSim([hingeModel], []);
    hingeSim.settleNow();
    // Snap vertex 3 to the exact mirror-inverted dihedral (-z)! Without signed bendRest, |C| === bendRest there so it locked at -z!
    hingeSim.x[11] = -L * Math.sin(ang);
    const snapInv = hingeSim.state();
    snapInv.x[11] = -L * Math.sin(ang);
    hingeSim.restore(snapInv);
    hingeSim.advance(0.25, { gravity: [0, 0, 0], wind: [0, 0, 0], airDensity: 1.225 });
    expect(hingeSim.x[11]).toBeGreaterThan(0.5 * L * Math.sin(ang));

    // Curved rod: points 0=(-L,0,0) and 2=(L,0,0) fixed, middle point 1=(0,0,0.02) curved +Z at rest; flip to -0.02 and verify recovery > 0!
    const rodModel: ClothModel = {
      name: 'rod',
      material: CLOTH_MATERIALS.canvas,
      layer: 0, outward: false, selfCollide: false, sewTime: 0,
      x0: Float64Array.of(-L, 0, 0, 0, 0, 0.02, L, 0, 0),
      invMass: Float64Array.of(0, 500, 0),
      tris: [0, 1, 2],
      edges: [], edgeRest: [], edgeMin: [], edgeStiffness: [],
      elastics: [], elasticRest: [], elasticFlat: [], elasticAlpha: [],
      bends: [], bendWeights: [], bendArea: [], bendRest: [], bendStiffness: [],
      limits: [], limitRest: [], stitches: [], tacks: [], ties: [],
      rods: {
        links: [0, 1, 1, 2],
        linkRest: [Math.hypot(L, 0.02), Math.hypot(L, 0.02)],
        bends: [0, 1, 2],
        bendRest: [0.04],
        bendAlpha: [1e-4],
      },
      groups: [{ name: 'rod__g', rgba: [1, 1, 1, 1], material: 'canvas', particles: [0, 1, 2], tris: [0, 1, 2] }],
    };
    const rodSim = new ClothSim([rodModel], []);
    rodSim.settleNow();
    const rodSnap = rodSim.state();
    rodSnap.x[5] = -0.02;
    rodSim.restore(rodSnap);
    rodSim.advance(0.25, { gravity: [0, 0, 0], wind: [0, 0, 0], airDensity: 1.225 });
    expect(rodSim.x[5]).toBeGreaterThan(0.01);
  });
});
