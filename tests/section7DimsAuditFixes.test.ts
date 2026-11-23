import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  bodyMesh,
  drawnPieces,
  frameOf,
  layOut,
  liveList,
  locationLinks,
  measureSection,
  mjPose,
  nodeFrameOf,
  type DrawnPiece,
} from '../src/components/scene/DimensionOverlay';
import {
  bodyViewDimensions,
  locationDimensions,
  sheetAxes,
  type BodyMesh,
  type DiameterDim,
  type LinearDim,
} from '../src/utils/viewDimensions';
import {
  bodyOf,
  measureInScene,
  sceneCandidates,
  snapInScene,
} from '../src/utils/measureScene';
import {
  chooseSnap,
  chooseSnapNear,
  fitCircle,
  fitPlane,
  measureAngle,
  nearbyVertices,
} from '../src/utils/measureSnap';
import { buildInvoluteGearNode } from '../src/utils/mechanismParts';
import { rotateMeshGeomsAbsolute } from '../src/store/meshGeomTransforms';
import type { SceneNode } from '../types/scene';
import type { DataMirror, ModelMirror, MujocoShim } from '../src/types/sceneLayer';

const mm = (v: number) => v / 1000;

function bodyFromGeo(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, id = 'part'): BodyMesh {
  const g = geometry.clone();
  if (matrix) g.applyMatrix4(matrix);
  const positions = Array.from(g.getAttribute('position').array as ArrayLike<number>);
  const faces = g.index
    ? Array.from(g.index.array as ArrayLike<number>)
    : Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { id, positions, faces };
}

function linear(dims: { dims: unknown[] } | null, axis: 'u' | 'v', row?: 1 | 2): LinearDim[] {
  return (dims?.dims ?? []).filter((d): d is LinearDim =>
    (d as LinearDim).kind === 'linear' &&
    (d as LinearDim).axis === axis &&
    (row === undefined || (d as LinearDim).row === row));
}

function diameters(dims: { dims: unknown[] } | null): DiameterDim[] {
  return (dims?.dims ?? []).filter((d): d is DiameterDim => (d as DiameterDim).kind === 'diameter');
}

function makePlateWithPolygonHole(
  w: number,
  d: number,
  t: number,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  phase = 0,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(w, 0);
  shape.lineTo(w, d);
  shape.lineTo(0, d);
  shape.closePath();
  const hole = new THREE.Path();
  for (let i = 0; i < sides; i++) {
    // Clockwise in XY so it is a hole inside the CCW outer contour
    const a = phase - (2 * Math.PI * i) / sides;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  hole.closePath();
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
}

function makeShadowMesh(geo: THREE.BufferGeometry, material?: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, material ?? new THREE.MeshStandardMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function makeMockMirrors(entries: { name: string; pos: [number, number, number]; mat?: number[] }[]) {
  const nameToId = new Map(entries.map((e, i) => [e.name, i + 1]));
  const xpos = new Float64Array((entries.length + 1) * 3);
  const xmat = new Float64Array((entries.length + 1) * 9);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  xmat.set(identity, 0);
  entries.forEach((e, i) => {
    const b = i + 1;
    xpos.set(e.pos, b * 3);
    xmat.set(e.mat ?? identity, b * 9);
  });
  const mujoco = {
    mjtObj: { mjOBJ_BODY: { value: 1 } },
    mj_name2id: (_m: unknown, _t: number, name: string) => nameToId.get(name) ?? -1,
  } as unknown as MujocoShim;
  const model = { nbody: entries.length + 1 } as unknown as ModelMirror;
  const data = { xpos, xmat } as unknown as DataMirror;
  return { model, data, mujoco };
}

describe('Section 7 audit — scene mesh gathering & filtering (DimensionOverlay + measureScene)', () => {
  it('excludes hidden objects, opacity-0 invisible geoms, material.visible=false, background scenery, and overlays', () => {
    const root = new THREE.Scene();

    const visibleGroup = new THREE.Group();
    visibleGroup.name = 'real_part';
    visibleGroup.add(makeShadowMesh(new THREE.BoxGeometry(mm(40), mm(20), mm(10))));
    root.add(visibleGroup);

    // Hidden group (visible = false)
    const hiddenGroup = new THREE.Group();
    hiddenGroup.name = 'hidden_part';
    hiddenGroup.visible = false;
    hiddenGroup.add(makeShadowMesh(new THREE.BoxGeometry(mm(80), mm(80), mm(80))));
    root.add(hiddenGroup);

    // Translucent-zero (rgba[3] === 0) proxy geom inside a real body
    const invisibleMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const proxyMesh = makeShadowMesh(new THREE.BoxGeometry(mm(500), mm(500), mm(500)), invisibleMat);
    visibleGroup.add(proxyMesh);

    // material.visible === false geom
    const hiddenMat = new THREE.MeshStandardMaterial();
    hiddenMat.visible = false;
    visibleGroup.add(makeShadowMesh(new THREE.BoxGeometry(mm(300), mm(300), mm(300)), hiddenMat));

    // Overlay group wrapping a named descendant
    const overlayRoot = new THREE.Group();
    overlayRoot.userData = { isOverlay: true };
    const overlayNamed = new THREE.Group();
    overlayNamed.name = 'dfm_ghost';
    overlayNamed.add(makeShadowMesh(new THREE.BoxGeometry(mm(200), mm(200), mm(200))));
    overlayRoot.add(overlayNamed);
    root.add(overlayRoot);

    // Background scenery wrapping a named descendant
    const bgRoot = new THREE.Group();
    bgRoot.userData = { isBackground: true };
    const bgNamed = new THREE.Group();
    bgNamed.name = 'workbench_table';
    bgNamed.add(makeShadowMesh(new THREE.BoxGeometry(2, 1, 1)));
    bgRoot.add(bgNamed);
    root.add(bgRoot);

    root.updateMatrixWorld(true);

    // bodyOf must reject overlay/background ancestors even when a child group is named
    expect(bodyOf(overlayNamed.children[0])).toBeNull();
    expect(bodyOf(bgNamed.children[0])).toBeNull();

    // drawnPieces must only return the visible real_part mesh (1 piece, 40×20×10)
    const gathered = drawnPieces(root, null);
    expect([...gathered.keys()]).toEqual(['real_part']);
    expect(gathered.get('real_part')!.pieces).toHaveLength(1);

    // measureScene must also ignore hidden, opacity-0, overlay, and background meshes
    const candidates = sceneCandidates(root, [0, 0, 0], 1);
    const ids = new Set(candidates.map((c) => c.nodeId).filter(Boolean));
    expect([...ids]).toEqual(['real_part']);
  });

  it('skips zero-scale (0,0,0) uncompiled/hidden StaticBoxInstances slots in both Dims and measureScene', () => {
    const root = new THREE.Scene();
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 2);
    inst.castShadow = true;
    // Slot 0: real 20×20×20 mm box placed at x = 0.5 m (far from origin)
    const realMat = new THREE.Matrix4()
      .makeTranslation(0.5, 0, 0)
      .multiply(new THREE.Matrix4().makeScale(mm(20), mm(20), mm(20)));
    inst.setMatrixAt(0, realMat);
    // Slot 1: hidden/uncompiled slot zeroed with makeScale(0,0,0) on the SAME body
    inst.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));
    inst.userData = { nodeIds: ['rail', 'rail'] };
    inst.instanceMatrix.needsUpdate = true;
    root.add(inst);
    root.updateMatrixWorld(true);

    // Dims must NOT stretch 'rail' back to (0,0,0) or destroy its frame
    const gathered = drawnPieces(root, null);
    expect(gathered.get('rail')!.pieces).toHaveLength(1);
    const mesh = bodyMesh('rail', gathered.get('rail')!.pieces);
    const dims = bodyViewDimensions(mesh, 'front');
    expect(linear(dims, 'u', 2)[0].valueMm).toBeCloseTo(20, 4);
    expect(linear(dims, 'v', 2)[0].valueMm).toBeCloseTo(20, 4);

    // measureScene near origin (0,0,0) must NOT emit phantom snap candidates from the zeroed slot
    expect(sceneCandidates(root, [0, 0, 0], 0.05)).toEqual([]);
  });

  it('keeps nested parent-child groups separate (child meshes belong to child, never unioned into parent)', () => {
    const root = new THREE.Scene();
    const parent = new THREE.Group();
    parent.name = 'base_plate';
    parent.add(makeShadowMesh(new THREE.BoxGeometry(mm(60), mm(10), mm(40))));

    const child = new THREE.Group();
    child.name = 'top_block';
    child.position.set(mm(80), 0, 0);
    child.add(makeShadowMesh(new THREE.BoxGeometry(mm(20), mm(10), mm(20))));
    parent.add(child);
    root.add(parent);
    root.updateMatrixWorld(true);

    const gathered = drawnPieces(root, null);
    expect([...gathered.keys()].sort()).toEqual(['base_plate', 'top_block']);
    const parentDims = bodyViewDimensions(bodyMesh('base_plate', gathered.get('base_plate')!.pieces), 'front');
    const childDims = bodyViewDimensions(bodyMesh('top_block', gathered.get('top_block')!.pieces), 'front');
    expect(linear(parentDims, 'u', 2)[0].valueMm).toBeCloseTo(60, 4);
    expect(linear(childDims, 'u', 2)[0].valueMm).toBeCloseTo(20, 4);
  });

  it('reports scaled sphere/cylinder radii accurately and never gives an ellipsoid a bogus 2000 mm diameter', () => {
    const root = new THREE.Scene();

    // Ellipsoid rendered as unit SphereGeometry(1) with non-uniform scale (SceneLayer convention)
    const ellipGroup = new THREE.Group();
    ellipGroup.name = 'egg';
    const ellipMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial());
    ellipMesh.scale.set(mm(10), mm(20), mm(15));
    ellipGroup.add(ellipMesh);
    root.add(ellipGroup);

    // Uniformly scaled sphere (radius 5mm × scale 2 = 10mm radius => ⌀20mm)
    const ballGroup = new THREE.Group();
    ballGroup.name = 'ball';
    ballGroup.position.set(0.1, 0, 0);
    const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(mm(5), 24, 16), new THREE.MeshStandardMaterial());
    ballMesh.scale.set(2, 2, 2);
    ballGroup.add(ballMesh);
    root.add(ballGroup);
    root.updateMatrixWorld(true);

    const eggSnap = snapInScene(root, [0, 0, 0], 0.005);
    expect(eggSnap.label).toContain('ellipsoid centre of egg');
    expect(eggSnap.radius).toBeUndefined();

    const ballRead = measureInScene(root, [0.1, 0, 0], [0, 0, 0], { withinMm: 3 });
    expect(ballRead.from.diameterMm).toBeCloseTo(20, 3);
    expect(ballRead.to.diameterMm).toBeUndefined();
  });

  it('preserves outward winding for mirrored (negative-determinant) meshes in bodyMesh', () => {
    const g = new THREE.CylinderGeometry(mm(10), mm(10), mm(30), 32);
    // Stand upright in Three Y-up (axis = Y -> doc Z) and mirror X
    const m = new THREE.Matrix4().makeScale(-1, 1, 1);
    const pieces: DrawnPiece[] = [{ id: 'mirrored_cyl', geometry: g, matrix: m }];
    const bm = bodyMesh('mirrored_cyl', pieces);
    // Seen side-on from front, outward winding must classify it as a boss (⌀20 × 30)
    const dims = bodyViewDimensions(bm, 'front');
    expect(linear(dims, 'u', 2)[0].label).toBe('⌀20');
    expect(linear(dims, 'v', 2)[0].label).toBe('30');
  });
});

describe('Section 7 audit — tessellated cylinders, holes, blind bores & occlusion', () => {
  it('measures a 16-sided cylinder (facet angle 22.5° > 20°) accurately end-on and side-on even when rotated by half a facet', () => {
    // 16-sided Ø100 mm cylinder, 40 mm tall, rotated by π/16 so vertex AABB is 98.08 mm (< 100 mm!)
    const rot = new THREE.Matrix4()
      .makeRotationZ(Math.PI / 16)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const cyl16 = bodyFromGeo(new THREE.CylinderGeometry(mm(50), mm(50), mm(40), 16), rot, 'cyl16');

    const top = bodyViewDimensions(cyl16, 'topDown');
    // End-on: single Ø100 label, NO bogus 98.1 AABB width/height
    expect(top?.dims.map((d) => d.label)).toEqual(['⌀100']);

    const front = bodyViewDimensions(cyl16, 'front');
    // Side-on: true diameter Ø100 and height 40, NO bogus 1 mm sagitta sliver chain or vertical crease stops
    expect(linear(front, 'u', 2).map((d) => d.label)).toEqual(['⌀100']);
    expect(linear(front, 'v', 2).map((d) => d.label)).toEqual(['40']);
    expect(linear(front, 'u', 1)).toEqual([]);
  });

  it('measures a 16-sided Ø10 mm through-hole in a plate accurately (circumradius 10 mm, not 9.81 mm chord)', () => {
    const plate = bodyFromGeo(
      makePlateWithPolygonHole(mm(60), mm(40), mm(6), mm(30), mm(20), mm(5), 16, Math.PI / 16),
      undefined,
      'plate16',
    );
    const top = bodyViewDimensions(plate, 'topDown');
    expect(diameters(top).map((d) => d.label)).toEqual(['⌀10']);
    // Hole centre located at x = 30, y = 20 (midpoints of 60×40)
    expect(linear(top, 'u', 1).map((d) => d.label)).toEqual(['30']);
    expect(linear(top, 'v', 1).map((d) => d.label)).toEqual(['20']);
    // And no bogus slants from the 16 rim segments
    expect((top?.dims ?? []).filter((d) => d.kind === 'angle')).toEqual([]);
  });

  it('measures a 32-sided Ø50 mm rotated cylinder side-on as exact Ø50 (not sagitta-clipped Ø49.8)', () => {
    const rot = new THREE.Matrix4()
      .makeRotationZ(Math.PI / 32)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const cyl32 = bodyFromGeo(new THREE.CylinderGeometry(mm(25), mm(25), mm(20), 32), rot, 'cyl32');
    const front = bodyViewDimensions(cyl32, 'front');
    expect(linear(front, 'u', 2).map((d) => d.label)).toEqual(['⌀50']);
    expect(linear(front, 'u', 1)).toEqual([]);
  });

  it('detects a blind hex pocket on the front face as hex A/F while hiding a blind bore on the back face', () => {
    // 40×40×10 mm block built from a solid 4 mm bottom slab + 6 mm top slab with a hex through-hole (10 mm A/F)
    const hexInradius = mm(5);
    const hexCircumradius = hexInradius / Math.cos(Math.PI / 6);
    const bottom = bodyFromGeo(new THREE.BoxGeometry(mm(40), mm(40), mm(4)).translate(mm(20), mm(20), mm(2)));
    const topWall = bodyFromGeo(
      makePlateWithPolygonHole(mm(40), mm(40), mm(6), mm(20), mm(20), hexCircumradius, 6)
        .translate(0, 0, mm(4)),
    );
    const blindHex: BodyMesh = {
      id: 'blind_hex',
      positions: [...(bottom.positions as number[]), ...(topWall.positions as number[])],
      faces: [
        ...(bottom.faces as number[]),
        ...(topWall.faces as number[]).map((i) => i + bottom.positions.length / 3),
      ],
    };
    const top = bodyViewDimensions(blindHex, 'topDown');
    expect(diameters(top).map((d) => d.label)).toEqual(['hex 10 A/F']);

    // Now test a back-face round boss completely hidden behind an opaque plate in topDown view
    const plate = bodyFromGeo(new THREE.BoxGeometry(mm(60), mm(60), mm(10)).translate(0, 0, mm(5)));
    const backBoss = bodyFromGeo(
      new THREE.CylinderGeometry(mm(8), mm(8), mm(10), 32).rotateX(Math.PI / 2).translate(0, 0, mm(-5)),
    );
    const hiddenBoss: BodyMesh = {
      id: 'hidden_boss',
      positions: [...(plate.positions as number[]), ...(backBoss.positions as number[])],
      faces: [
        ...(plate.faces as number[]),
        ...(backBoss.faces as number[]).map((i) => i + plate.positions.length / 3),
      ],
    };
    const topHidden = bodyViewDimensions(hiddenBoss, 'topDown');
    expect(diameters(topHidden)).toEqual([]);
  });
});

describe('Section 7 audit — baked rotation, renamed bodies, cloth parents & section cuts', () => {
  it('restores true local axes for an all-mesh body rotated via rotateMeshGeomsAbsolute (baked rotation)', () => {
    const box = new THREE.BoxGeometry(mm(40), mm(10), mm(20)); // Y-up: X=40, Y(up)=10, Z=20
    const yUpVerts = Array.from(box.getAttribute('position').array as ArrayLike<number>);
    const faces = Array.from(box.index!.array as ArrayLike<number>);
    const node: SceneNode = {
      id: 'rotated_mesh',
      name: 'Rotated Mesh',
      pos: [0, 0, 0],
      euler: [0, 0, 30],
      geoms: [{ name: 'g0', type: 'mesh', size: [1], vertices: yUpVerts, faces }],
      joints: [],
      children: [],
    };
    rotateMeshGeomsAbsolute(node, [0, 0, 30]);

    // Static mesh renders at identity matrixWorld with baked Y-up vertices
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(node.geoms[0].vertices!, 3));
    geo.setIndex(faces);
    const piece: DrawnPiece = { id: node.id, geometry: geo, matrix: new THREE.Matrix4() };

    const frame = nodeFrameOf([piece], node);
    expect(frame).toBeDefined();
    const bm = bodyMesh(node.id, [piece], undefined, node);
    const dims = bodyViewDimensions(bm, 'topDown');
    // True box dimensions (40 × 20) + 30° angle, NOT world-AABB diagonal (44.6 × 37.3)
    expect(linear(dims, 'u', 2)[0].valueMm).toBeCloseTo(40, 1);
    expect(linear(dims, 'v', 2)[0].valueMm).toBeCloseTo(20, 1);
    expect((dims?.dims ?? []).filter((d) => d.kind === 'angle').map((a) => a.label)).toEqual(['30°']);
  });

  it('resolves renamed bodies in mjPose (name fallback to id) and skips cloth parents in locationLinks', () => {
    const mirrors = makeMockMirrors([
      { name: 'frame_id', pos: [0.05, 0, 0.1] },
      { name: 'child_body', pos: [0.15, 0, 0.2] },
    ]);
    const child: SceneNode = {
      id: 'child_body', name: 'Child Display Name', pos: [0.1, 0, 0.1], geoms: [], joints: [], children: [],
    };
    const clothParent: SceneNode = {
      id: 'cloth_1', name: 'Cloth', pos: [0, 0, 0], geoms: [], joints: [], children: [child],
      cloth: { width: 0.1, height: 0.1, cols: 4, rows: 4 } as SceneNode['cloth'],
    };
    const rootNode: SceneNode = {
      id: 'frame_id', name: 'Renamed Frame', pos: [0.05, 0, 0.1], geoms: [], joints: [], children: [clothParent],
    };

    expect(mjPose(rootNode, mirrors)?.at).toEqual([0.05, 0, 0.1]);
    expect(mjPose(child, mirrors)?.at).toEqual([0.15, 0, 0.2]);

    const links = locationLinks(['child_body'], [rootNode], mirrors);
    expect(links).toHaveLength(1);
    expect(links[0].parent).toBe('frame_id');
    expect(links[0].from).toEqual([0.05, 0, 0.1]);
    expect(links[0].to).toEqual([0.15, 0, 0.2]);

    const locDims = locationDimensions(links, 'front');
    expect(locDims[0].across?.label).toBe('100');
    expect(locDims[0].up?.label).toBe('100');
  });

  it('measures section cuts accurately without foreshortening tilted parts, filtering >10m floors, and handling large meshes', () => {
    // 1. A 40×40×40 mm box tilted 30° about X (tilted out of the front view cut plane):
    // Cutting it in `front` view produces a cross-section taller than 40 mm along Z (40 / cos(30°) ≈ 46.2 mm).
    // Passing the 30°-tilted frame onto the 2D cut slab used to foreshorten the cut height by cos(30°).
    const tiltedGeo = new THREE.BoxGeometry(mm(40), mm(40), mm(40));
    const tiltedMat = new THREE.Matrix4().makeRotationX((30 * Math.PI) / 180);
    const piecesMap = new Map<string, { pieces: DrawnPiece[] }>([
      ['tilted', { pieces: [{ id: 'tilted', geometry: tiltedGeo, matrix: tiltedMat }] }],
      // Oversized 20m floor slab that must be ignored by measureSection
      ['floor_slab', { pieces: [{ id: 'floor_slab', geometry: new THREE.BoxGeometry(20, 0.1, 20), matrix: new THREE.Matrix4() }] }],
    ]);

    const cut = measureSection(piecesMap, 'front', 0.5);
    expect(cut.dims.map((d) => d.id)).toEqual(['tilted']);
    const uOverall = linear(cut.dims[0], 'u', 2)[0].valueMm;
    const vOverall = linear(cut.dims[0], 'v', 2)[0].valueMm;
    expect(uOverall).toBeCloseTo(40, 1);
    expect(vOverall).toBeCloseTo(40 / Math.cos((30 * Math.PI) / 180), 0);

    // 2. Large mesh (> 50k tris, > 150k face indices) must not throw RangeError in measureSection
    const bigSphere = new THREE.SphereGeometry(mm(20), 160, 160); // ~51k triangles, >153k indices
    const bigMap = new Map<string, { pieces: DrawnPiece[] }>([
      ['big', { pieces: [{ id: 'big', geometry: bigSphere, matrix: new THREE.Matrix4() }] }],
    ]);
    expect(() => measureSection(bigMap, 'front', 0.5)).not.toThrow();
  });
});

describe('Section 7 audit — numeric safety, layout caps, sheared frames & gear data', () => {
  it('guards against NaN/Infinity, zero/negative mpp, sheared matrices, empty geometries, and extreme zoom on gear pitch circles', () => {
    // Non-finite positions & empty faces
    expect(bodyViewDimensions({ id: 'nan', positions: [NaN, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] }, 'front')).toBeNull();
    expect(bodyViewDimensions({ id: 'inf', positions: [Infinity, 0, 0, 0, 0, 0, 0, 1, 0], faces: [0, 1, 2] }, 'front')).toBeNull();
    expect(bodyViewDimensions({ id: 'nofaces', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [] }, 'front')).toBeNull();

    // Non-finite frame falls back cleanly to WORLD
    expect(sheetAxes([[NaN, 0, 0], [0, 1, 0], [0, 0, 1]], 'front')).toEqual(sheetAxes(undefined, 'front'));

    // Non-finite location links are skipped
    expect(locationDimensions([{ id: 'bad', from: [0, 0, 0], to: [NaN, 0.1, 0] }], 'front')).toEqual([]);

    // Sheared matrix rejected by frameOf
    const shear = new THREE.Matrix4().set(
      1, 0.5, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    expect(frameOf([{ id: 's', geometry: new THREE.BoxGeometry(1, 1, 1), matrix: shear }])).toBeUndefined();

    // Empty geometry rejected safely by frameOf
    expect(frameOf([{ id: 'e', geometry: new THREE.BufferGeometry(), matrix: new THREE.Matrix4() }])).toBeUndefined();

    // layOut with mpp <= 0 or NaN returns empty drawing
    const boxDims = bodyViewDimensions(bodyFromGeo(new THREE.BoxGeometry(mm(40), mm(20), mm(10))), 'front')!;
    expect(layOut([boxDims], [], 'front', 0).labels).toEqual([]);
    expect(layOut([boxDims], [], 'front', NaN).labels).toEqual([]);

    // Gear pitch circle at extreme zoom (tiny mpp) caps line segments instead of freezing
    const gearNode = buildInvoluteGearNode({ teeth: 16, moduleMm: 1.5, boreKind: 'round', boreDiameterMm: 5 });
    const g = gearNode.geoms[0];
    const gearDims = bodyViewDimensions({
      id: gearNode.id,
      positions: g.renderVertices!,
      faces: g.faces!,
      toothForm: { form: gearNode.toothForm!, origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    }, 'topDown')!;
    const zoomed = layOut([gearDims], [], 'topDown', 1e-7);
    // Capped at <= 2000 segments for the pitch circle (6 floats per segment = 12000 floats) + normal dims
    expect(zoomed.lines.length).toBeLessThan(20000);

    // liveList reports gear and sharedWith cleanly
    const live = liveList([gearDims], [], new Map(), 'topDown');
    expect(live.some((d) => d.kind === 'gear')).toBe(true);

    // measureSnap NaN safety
    expect(fitPlane([[NaN, 0, 0], [1, 0, 0], [0, 1, 0]])).toBeNull();
    expect(fitCircle([[NaN, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]])).toBeNull();
    expect(nearbyVertices([NaN, 0, 0, 0, 0, 0], [0, 0, 0], 1)).toEqual([[0, 0, 0]]);
    expect(measureAngle([NaN, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
    expect(chooseSnap([{ point: [NaN, 0, 0], kind: 'centre', label: 'bad' }], (p) => ({ x: p[0], y: p[1] }), { x: 0, y: 0 })).toBeNull();
    expect(chooseSnapNear([{ point: [NaN, 0, 0], kind: 'centre', label: 'bad' }], [0, 0, 0], 1)).toBeNull();
  });
});
