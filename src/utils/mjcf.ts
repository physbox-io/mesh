import type { SceneGraph, SceneNode, SceneGeom, SceneJoint } from '../types/scene';
import { generateWedgeMeshData } from './geom';
import { analyzeMesh } from './meshIntegrity';
import { checkMeshInertia } from './meshInertiaCheck';
import { resolveCsgGeoms } from './csg';
import { encodeMsh, mshFileName, type MeshFileSink } from './meshVfs';
import { PairMemo } from './arrayMemo';
import { isNodeRotationBaked, nodeLocalQuat, quatMultiply, quatRotateVec, quatRotateVecInv, type QuatWXYZ } from './sceneTree';
import { uniquifyNamesInPlace } from './uniqueNames';
import { geomSizeProblem } from './geomSize';
import { applyBodyMass } from './bodyMass';
import { dropDanglingReferencesInPlace } from './danglingReferences';
import { buildBreakModel } from './breakModel';
import { RIGID_COUPLING, jointCouplingXml } from './jointCoupling';
import { gearBody, meshingGears, type GearBody } from './gearMeshing';
import { estimateJointInertia, relocateCoupledFriction, type CouplingEdge } from './coupledFriction';
import { contactArenaXml } from './contactArena';
import { UNSLIPPING_CLUTCH, clutchDriverBodyXml, clutchDriverJointName, clutchTendonXml, isClutchedMotor } from './motorClutch';

/**
 * A name as an attribute value. Names are whatever someone typed, and a body
 * called `Lid & base` or `6" pipe` made the XML unreadable and the build fail.
 * MuJoCo's parser decodes the entities again, so the model holds the name as
 * typed and the viewport's lookups by name still find it.
 */
function xmlAttr(name: string): string {
  return String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/*
 * Per-mesh work kept across rebuilds. Every build used to re-encode every mesh
 * to .msh bytes and hash them — only to arrive at a file name the worker
 * already held — and run a full integrity analysis for its inertia attribute,
 * for every mesh in the scene, on every edit however small. Keyed on the
 * arrays themselves; see utils/arrayMemo. The bytes are not kept: they are
 * transferred to the worker, which detaches them.
 */
const meshFileNames = new PairMemo<string>();
const meshInertiaAttrs = new PairMemo<string>();
const wedgeMeshCache = new Map<string, ReturnType<typeof generateWedgeMeshData>>();

const getCachedWedgeMeshData = (w: number, d: number, h: number) => {
  const key = `${w}:${d}:${h}`;
  let cached = wedgeMeshCache.get(key);
  if (!cached) {
    cached = generateWedgeMeshData(w, d, h);
    wedgeMeshCache.set(key, cached);
  }
  return cached;
};

const formatGeomSize = (type: string, rawSize: unknown, geom?: SceneGeom): string => {
  // A size given but unusable (negative, zero, text) is an error, named, not a
  // silent 0.1 m: a negative box used to come out 200 mm and 0.32 kg. The MCP
  // and the store refuse one on the way in (utils/geomSize); this catches a
  // document that already held one. Only a size left out, or a data-less mesh
  // standing in as a box, takes the default below.
  if (geom) {
    const problem = geomSizeProblem({ ...geom, type });
    if (problem) throw new Error(problem);
  }
  const arr = Array.isArray(rawSize)
    ? rawSize.map((v: unknown) => (typeof v === 'number' && !isNaN(v) && v > 0) ? v : 0.1)
    : [0.1, 0.1, 0.1];

  if (type === 'sphere') {
    return `${arr[0] || 0.1}`;
  }
  if (type === 'cylinder' || type === 'capsule') {
    const r = arr[0] || 0.1;
    const h = arr[1] || arr[0] || 0.1;
    return `${r} ${h}`;
  }
  // For 'box', 'plane', or fallback primitive shapes
  const x = arr[0] || 0.1;
  const y = arr[1] || arr[0] || x;
  const z = arr[2] || arr[0] || x;
  return `${x} ${y} ${z}`;
};

/**
 * A mesh with no volume, which MuJoCo cannot hull: every vertex in one plane
 * (the first face drawn in an empty lattice), or fewer than four, or all on a
 * line. A flat one is emitted as a thin box lying in its plane, so it still
 * collides where it is drawn; anything less is a speck. Null for a mesh with
 * volume, which compiles as itself. Kept per vertex array, since the asset
 * pass and the geom pass both ask.
 */
const FLAT_HALF_THICKNESS = 0.0005;
type FlatMesh = 'speck' | { pos: number[]; quat: number[]; size: number[] };
const flatMeshes = new WeakMap<number[], FlatMesh | null>();
function flatMesh(vertices: number[]): FlatMesh | null {
  const cached = flatMeshes.get(vertices);
  if (cached !== undefined) return cached;
  // Y-up to MuJoCo's Z-up, as toMjcfVerts does: (x, y, z) -> (x, -z, y).
  const pts: number[][] = [];
  for (let i = 0; i + 2 < vertices.length; i += 3) pts.push([vertices[i], -vertices[i + 2], vertices[i + 1]]);
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  let result: FlatMesh | null = null;
  if (pts.length < 4) result = 'speck';
  else {
    const p0 = pts[0];
    let p1 = p0;
    for (const p of pts) if (dot(sub(p, p0), sub(p, p0)) > dot(sub(p1, p0), sub(p1, p0))) p1 = p;
    const extent = Math.sqrt(dot(sub(p1, p0), sub(p1, p0)));
    const along = extent > 0 ? unit(sub(p1, p0)) : [1, 0, 0];
    let normal = [0, 0, 0];
    for (const p of pts) {
      const c = cross(along, sub(p, p0));
      if (dot(c, c) > dot(normal, normal)) normal = c;
    }
    const tolerance = Math.max(extent, 1e-9) * 1e-7;
    if (extent === 0 || Math.sqrt(dot(normal, normal)) <= tolerance) result = 'speck';
    else {
      const n = unit(normal);
      if (pts.every((p) => Math.abs(dot(n, sub(p, p0))) <= tolerance)) {
        // The box's sides run along the shape's: the grid's axes when the plane
        // is square to them, as a lattice face nearly always is, and otherwise
        // the first edge — the diagonal to the far corner would turn the box
        // 45° off a rectangle and oversize it.
        const square = [0, 1, 2].findIndex((k) => Math.abs(n[k]) > 0.9999);
        const first = sub(pts[1], pts[0]);
        const inPlane = sub(first, n.map((c) => c * dot(first, n)));
        const u = square !== -1
          ? [0, 1, 2].map((k) => (k === (square + 1) % 3 ? 1 : 0))
          : dot(inPlane, inPlane) > 0 ? unit(inPlane) : along;
        const v = cross(n, u);
        let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
        for (const p of pts) {
          const d = sub(p, p0);
          const a = dot(d, u), b = dot(d, v);
          if (a < uLo) uLo = a; if (a > uHi) uHi = a;
          if (b < vLo) vLo = b; if (b > vHi) vHi = b;
        }
        const um = (uLo + uHi) / 2, vm = (vLo + vHi) / 2;
        const pos = [0, 1, 2].map((k) => p0[k] + u[k] * um + v[k] * vm);
        // Rotation with columns u, v, n, as a (w, x, y, z) quaternion.
        const [m00, m10, m20] = u, [m01, m11, m21] = v, [m02, m12, m22] = n;
        const trace = m00 + m11 + m22;
        let q: number[];
        if (trace > 0) {
          const k = Math.sqrt(trace + 1) * 2;
          q = [k / 4, (m21 - m12) / k, (m02 - m20) / k, (m10 - m01) / k];
        } else if (m00 > m11 && m00 > m22) {
          const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
          q = [(m21 - m12) / k, k / 4, (m01 + m10) / k, (m02 + m20) / k];
        } else if (m11 > m22) {
          const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
          q = [(m02 - m20) / k, (m01 + m10) / k, k / 4, (m12 + m21) / k];
        } else {
          const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
          q = [(m10 - m01) / k, (m02 + m20) / k, (m12 + m21) / k, k / 4];
        }
        const size = [Math.max((uHi - uLo) / 2, FLAT_HALF_THICKNESS), Math.max((vHi - vLo) / 2, FLAT_HALF_THICKNESS), FLAT_HALF_THICKNESS];
        result = { pos, quat: q, size };
      }
    }
  }
  flatMeshes.set(vertices, result);
  return result;
}

const buildGeom = (geom: SceneGeom, massless = false) => {
  // A mesh geom is only valid in MJCF if vertex/face array data exists to populate the <asset> block
  const hasMeshData = Array.isArray(geom.vertices) && geom.vertices.length > 0 && Array.isArray(geom.faces) && geom.faces.length > 0;
  const isMesh = geom.type === 'mesh' && hasMeshData;
  // A mesh whose arrays are there but empty — a lattice with nothing drawn in
  // it yet — or too thin to hull, still has to give a free body its mass, so
  // it stands in as a speck that draws nothing and touches nothing. Falling through to the box
  // below made it a 2 m block, from a mesh's `size: [1]`.
  const flat = geom.type === 'mesh' && hasMeshData ? flatMesh(geom.vertices!) : null;
  // A flat mesh turned by its own quat is rare enough to take as a speck
  // rather than compose the two rotations.
  const rotated = !!(geom.quat || geom.euler);
  if (flat && flat !== 'speck' && !rotated) {
    // Placed in the body's frame: the box's own centre, plus wherever the geom sits.
    const at = flat.pos.map((c, k) => c + (geom.pos?.[k] ?? 0));
    let slab = `name="${xmlAttr(geom.name)}" type="box" size="${flat.size.join(' ')}" pos="${at.join(' ')}" quat="${flat.quat.join(' ')}"`;
    if (geom.rgba) slab += ` rgba="${geom.rgba.join(' ')}"`;
    if (geom.mass !== undefined) slab += ` mass="${geom.mass}"`;
    else if (massless) slab += ` mass="0"`;
    else if (geom.density !== undefined) slab += ` density="${geom.density}"`;
    if (geom.role === 'visual') slab += ` contype="0" conaffinity="0"`;
    else {
      if (geom.contype !== undefined) slab += ` contype="${geom.contype}"`;
      if (geom.conaffinity !== undefined) slab += ` conaffinity="${geom.conaffinity}"`;
    }
    if (geom.condim !== undefined) slab += ` condim="${geom.condim}"`;
    if (geom.friction !== undefined) slab += ` friction="${geom.friction.join(' ')}"`;
    return `<geom ${slab} />`;
  }
  const emptyMesh = geom.type === 'mesh' && (flat === 'speck' || (flat !== null && rotated) || (!hasMeshData && Array.isArray(geom.vertices) && geom.vertices.length === 0));
  if (emptyMesh) {
    let speck = `name="${xmlAttr(geom.name)}" type="sphere" size="0.001" rgba="0 0 0 0" contype="0" conaffinity="0"`;
    if (geom.pos) speck += ` pos="${geom.pos.join(' ')}"`;
    if (geom.mass !== undefined) speck += ` mass="${geom.mass}"`;
    else if (massless) speck += ` mass="0"`;
    return `<geom ${speck} />`;
  }
  const geomType = isMesh ? 'mesh' : (geom.type === 'mesh' ? 'box' : (geom.type || 'box'));

  let attrs = `name="${xmlAttr(geom.name)}" type="${geomType}"`;
  if (!isMesh) {
    attrs += ` size="${formatGeomSize(geomType, geom.size, geom.type === 'mesh' ? undefined : geom)}"`;
  } else {
    attrs += ` mesh="${xmlAttr(geom.name)}"`;
  }
  if (geom.rgba) attrs += ` rgba="${geom.rgba.join(' ')}"`;
  if (!isMesh && geom.fromto) attrs += ` fromto="${geom.fromto.join(' ')}"`;
  if (geom.pos) attrs += ` pos="${geom.pos.join(' ')}"`;
  if (geom.quat) {
    attrs += ` quat="${geom.quat.join(' ')}"`;
  } else if (geom.euler) {
    attrs += ` euler="${geom.euler.join(' ')}"`;
  }
  if (geom.mass !== undefined) attrs += ` mass="${geom.mass}"`;
  else if (massless) attrs += ` mass="0"`;
  else if (geom.density !== undefined) attrs += ` density="${geom.density}"`;
  if (geom.role === 'visual') {
    // A visual-only geom is drawn but must not take part in contact — the body's
    // real colliders are elsewhere (see resolveCsgGeoms). Overrides any authored
    // contype/conaffinity rather than merging with it: "visual" is unambiguous.
    attrs += ` contype="0" conaffinity="0"`;
  } else {
    if (geom.contype !== undefined) attrs += ` contype="${geom.contype}"`;
    if (geom.conaffinity !== undefined) attrs += ` conaffinity="${geom.conaffinity}"`;
  }
  if (geom.condim !== undefined) attrs += ` condim="${geom.condim}"`;
  if (geom.friction !== undefined) attrs += ` friction="${geom.friction.join(' ')}"`;
  if (geom.solref) attrs += ` solref="${geom.solref.join(' ')}"`;
  if (geom.solimp) attrs += ` solimp="${geom.solimp.join(' ')}"`;
  if (geom.margin !== undefined) attrs += ` margin="${geom.margin}"`;
  if (geom.gap !== undefined) attrs += ` gap="${geom.gap}"`;
  return `<geom ${attrs} />`;
};

/** The contact exclusions and break limits that go with breakModel's equalities. */
const breakExtrasXml = (b: ReturnType<typeof buildBreakModel>, linked: [string, string][] = []): string => {
  let xml = '';
  const excludes = [...b.excludes, ...linked];
  if (excludes.length) {
    xml += `\n  <contact>${excludes.map(([p, q]) => `\n    <exclude body1="${xmlAttr(p)}" body2="${xmlAttr(q)}" />`).join('')}\n  </contact>`;
  }
  if (b.numerics.length) {
    xml += `\n  <custom>${b.numerics.map((n) => `\n    <numeric name="${xmlAttr(n.name)}" data="${n.data.map((v) => +v.toPrecision(6)).join(' ')}" />`).join('')}\n  </custom>`;
  }
  return xml;
};

/**
 * A cut gear's pitch radius in metres, from the tooth form it was cut to. Its
 * first geom is a mesh, whose size is a placeholder [1], so reading the radius
 * from that coupled every pair of generated gears within 2.4 m of each other.
 */
const pitchRadius = (node: SceneNode): number | undefined => {
  const t = node.toothForm;
  return t && t.kind !== 'rack' ? t.pitchDiameterMm / 2000 : undefined;
};

const buildJoint = (joint: SceneJoint) => {
  // A joint written without a name stays nameless: name="undefined" on two of
  // them is a repeated name, and MuJoCo refuses the model.
  const name = joint.name ? `name="${xmlAttr(joint.name)}" ` : '';
  if (joint.type === 'free') {
    return `<freejoint ${name}/>`;
  }
  let attrs = `${name}type="${joint.type}"`;
  if (joint.pos) attrs += ` pos="${joint.pos.join(' ')}"`;
  if (joint.axis) attrs += ` axis="${joint.axis.join(' ')}"`;
  if (joint.damping !== undefined) attrs += ` damping="${joint.damping}"`;
  if (joint.stiffness !== undefined) attrs += ` stiffness="${joint.stiffness}"`;
  if (joint.springref !== undefined) attrs += ` springref="${joint.springref}"`;
  if (joint.armature !== undefined) attrs += ` armature="${joint.armature}"`;
  // MuJoCo's dry friction is a soft constraint, and at the default impedance
  // (0.9) a joint loaded below its friction still creeps, at a rate that does
  // not depend on the friction at all: a propped lid sagged 0.12 rad/s however
  // high it was set. The creep scales with 1 - d, so d at its 0.9999 ceiling
  // holds to 0.0001 rad/s, and stayed stable from a 2 g part to a 20 kg arm.
  // tests/jointFriction.test.ts.
  if (joint.frictionloss) attrs += ` frictionloss="${joint.frictionloss}" solimpfriction="0.9999 0.9999 0.001 0.5 2"`;
  // A crumple's travel is its range: it is held rigid by its lock until that
  // gives, and then it may fold this far and no further.
  const range = joint.range ?? joint.crumpleRangeDeg;
  const limited = joint.limited ?? (joint.crumpleRangeDeg ? true : undefined);
  if (limited !== undefined) attrs += ` limited="${limited}"`;
  if (range !== undefined) attrs += ` range="${range.join(' ')}"`;
  // Steel end stops: a stiff, near-rigid limit, its time constant a few of
  // the 1 ms timestep — about as stiff as MuJoCo integrates stably.
  if (joint.hardStop) attrs += ` solreflimit="0.004 1" solimplimit="0.99 0.999 0.0002 0.5 2"`;
  return `<joint ${attrs} />`;
};

const buildNode = (node: SceneNode): string => {
  if (!node) return '';
  // Logical-only nodes (e.g. pulley ropes) have no geoms or joints and must not
  // emit a <body> into MJCF — a bodyless body causes implicit inertia artefacts.
  if (node.isPulleyRope) return '';

  const nameStr = node.name || node.id || 'body';
  const posStr = Array.isArray(node.pos) ? node.pos.join(' ') : '0 0 0';

  if (node.isComposite) {
    const type = node.compositeType === 'rope' ? 'cable' : (node.compositeType || 'cable');
    const count = node.compositeCount || '15 1 1';
    const size = node.compositeSize !== undefined ? node.compositeSize : '1.5';
    const prefix = node.compositePrefix || `${nameStr}_`;
    const curve = node.compositeCurve || 's 0 0';

    const damping = node.joints?.[0]?.damping !== undefined ? node.joints[0].damping : 0.05;
    const stiffness = node.joints?.[0]?.stiffness !== undefined ? node.joints[0].stiffness : 0.0;

    const geom = node.geoms?.[0];
    const geomType = geom?.type || 'capsule';
    const geomSize = geom?.size ? geom.size.join(' ') : '0.02';
    const geomRgba = geom?.rgba ? geom.rgba.join(' ') : '0.8 0.4 0.2 1';

    const compositeXml = `<composite type="${type}" count="${count}" size="${size}" curve="${curve}" prefix="${xmlAttr(prefix)}"><joint kind="main" damping="${damping}" stiffness="${stiffness}" /><geom type="${geomType}" size="${geomSize}" rgba="${geomRgba}" /></composite>`;

    let attrs = `name="${xmlAttr(nameStr)}" pos="${posStr}"`;
    if (node.quat) {
      attrs += ` quat="${node.quat.join(' ')}"`;
    } else if (node.euler) {
      attrs += ` euler="${node.euler.join(' ')}"`;
    }
    
    let childrenXml = '';
    (node.children || []).forEach(c => childrenXml += buildNode(c));
    return `<body ${attrs}>${compositeXml}${childrenXml}</body>`;
  }

  let innerXml = '';
  
  (node.joints || []).forEach(j => innerXml += buildJoint(j));
  // A visual-only geom is scenery and must weigh nothing. MuJoCo infers a
  // geom's mass from its volume at a default density of 1000 unless told
  // otherwise, so a decorative shell the size of a jar arrives as a real 27kg
  // bolted to that body. Only when something else in the body carries the mass,
  // though: MuJoCo will not accept a moving body that ends up with none at all.
  const hasSolid = (node.geoms || []).some(g => g.role !== 'visual');
  (node.geoms || []).forEach(g => innerXml += buildGeom(g, hasSolid && g.role === 'visual'));
  (node.children || []).forEach(c => innerXml += buildNode(c));
  
  let frame = ` pos="${posStr}"`;
  if (rotationIsBaked(node)) {
    // Nothing: the vertices already carry it. See `rotationIsBaked`.
  } else if (node.quat) {
    frame += ` quat="${node.quat.join(' ')}"`;
  } else if (node.euler) {
    frame += ` euler="${node.euler.join(' ')}"`;
  }
  // A torque-limited velocity motor drives its joint through a slip clutch
  // from a driver dof beside it, in the same frame. See utils/motorClutch.ts.
  const drivers = (node.joints || []).filter(isClutchedMotor)
    .map((j) => clutchDriverBodyXml(nameStr, frame, j, xmlAttr)).join('');

  return `<body name="${xmlAttr(nameStr)}"${frame}>${innerXml}</body>${drivers}`;
};

/**
 * Whether this body's rotation is already in its vertices.
 *
 * `updateNodeRotation` turns an all-mesh body by rewriting every vertex from an
 * unrotated copy it keeps as `baseVertices` — and it also records the angles in
 * `node.euler`, because that is what the sidebar's rotation sliders read back.
 * Emitting that euler here as well asked MuJoCo to turn the body a second time,
 * on top of vertices already turned, so one rotation arrived as two and a body
 * turned about one axis came out tumbled about three.
 *
 * `baseVertices` is the marker, not the geom type: a mesh body that has never
 * been through that path — one authored in a preset, or imported — has its
 * vertices as they were written and needs the euler to do the turning. The
 * presence of even one non-mesh geom means the same, since the bake only ever
 * runs when every geom is a mesh.
 */
const rotationIsBaked = isNodeRotationBaked;

/*
 * Contact classes, as contype/conaffinity bits. Two geoms touch when either's
 * contype shares a bit with the other's conaffinity.
 *
 * Bit 1 is MuJoCo's default, the body class every geom not told otherwise
 * is in. The exact colliders of Split for Print (SceneGeom.contactClass) live in
 * the 'print' fidelity only, and never meet a body: a pin has to go into a
 * bore the body's hull would have filled in, so it must not see that hull.
 *
 * - A pin is type PIN_CONTACT plus its joint's bit, affinity PIN_CONTACT: it
 *   meets every other pin, and the sockets of its own joint.
 * - A socket is type 0, affinity its joint's bit: it meets only its own
 *   joint's pins — not other sockets (two glued faces' plates coincide, and
 *   coincident slabs in contact rock), and not another joint's pins (a hole
 *   passing near another hole's lining would stop that hole's dowel dead).
 * - The floor carries every bit.
 *
 * Joint bits are 2 to 30, so joints share a bit 29 apart. Two joints that
 * far apart in the cut order are a long way apart in the part too.
 */
const PIN_CONTACT = 2;
const JOINT_BITS = 29;
const FLOOR_CONTACT = 0x7fffffff;
const jointBit = (group: number | undefined) => 1 << (2 + (((group ?? 0) % JOINT_BITS) + JOINT_BITS) % JOINT_BITS);
export const PRINT_CONTACT_TIME = 0.002;

/**
 * Puts each body's geoms into their contact classes, in place.
 *
 * - A pin or a socket lives only in print fidelity; otherwise it is inert.
 *   It never weighs anything — the section's own mesh carries the mass.
 * - A mesh with a separate collider source (`colliderVertices`) is drawn from
 *   its own vertices but collides as the source: the visible mesh is emitted
 *   visual-only and a plain mesh geom beside it takes the contact and the
 *   mass. Not when the body has convex pieces already, which were made from
 *   that same source and replace it (see convexDecomposition.ts).
 *
 * A scene with neither kind of geom comes out byte for byte as it did before
 * this existed, which the native app's golden XML depends on.
 */
function applyContactClasses(nodes: SceneNode[], print: boolean) {
  for (const node of nodes) {
    if (node.geoms?.some((g) => g.contactClass || g.colliderFaces?.length)) {
      // A mesh a decomposition stands in for has already been demoted to
      // visual (or dropped) by resolveCsgGeoms, so the role test below skips
      // it; one the pieces do not cover still collides as its own section.
      const out: SceneGeom[] = [];
      for (const g of node.geoms) {
        if (g.contactClass) {
          const bit = jointBit(g.contactGroup);
          const contype = !print ? 0 : g.contactClass === 'pin' ? PIN_CONTACT | bit : 0;
          const conaffinity = !print ? 0 : g.contactClass === 'pin' ? PIN_CONTACT : bit;
          out.push({ ...g, role: 'collision', mass: 0, density: undefined, contype, conaffinity });
        } else if (
          g.type === 'mesh' && g.role !== 'visual'
          && g.colliderFaces?.length && g.colliderVertices?.length
        ) {
          const { colliderVertices, colliderFaces, ...rest } = g;
          out.push({ ...rest, role: 'visual', mass: undefined, density: undefined });
          // Y-up, as every geom's `vertices` are; renderVertices is Z-up.
          const yUp: number[] = new Array(colliderVertices.length);
          for (let i = 0; i < colliderVertices.length; i += 3) {
            yUp[i] = colliderVertices[i];
            yUp[i + 1] = colliderVertices[i + 2];
            yUp[i + 2] = -colliderVertices[i + 1];
          }
          out.push({
            ...rest,
            name: `${g.name}_collider`,
            role: 'collision',
            vertices: yUp,
            renderVertices: colliderVertices,
            faces: colliderFaces,
            baseVertices: undefined,
            baseRenderVertices: undefined,
            paint: undefined,
          });
        } else {
          out.push(g);
        }
      }
      node.geoms = out;
    }
    applyContactClasses(node.children || [], print);
  }
}

export interface MjcfOptions {
  /**
   * Let bodies that have come to rest sleep (`<flag sleep="enable"/>`): MuJoCo
   * stops integrating and colliding a resting island until something touches
   * it. Asked for only while a scene has shattered, where a settled heap of
   * shards is most of the step, so no other scene changes behaviour.
   */
  sleep?: boolean;
  /**
   * Emit meshes as binary files in the worker's VFS rather than as inline
   * vertex text, where the sink says so. See utils/meshVfs.ts. Left out, every
   * mesh is inline exactly as before, which is what the tests, the exported
   * presets and the native app's golden XML rely on.
   */
  meshFiles?: MeshFileSink;
}

export const compileToMJCF = (
  scene: SceneGraph,
  gravityZ: number = -9.81,
  floorFriction: number = 1.0,
  windX: number = 0,
  windY: number = 0,
  density: number = 0,
  floorBounce: number = 0.0,
  opts: MjcfOptions = {},
) => {
  if (!Array.isArray(scene?.nodes)) {
    throw new Error('compileToMJCF: scene.nodes must be an array (got a malformed SceneGraph)');
  }
  // Copy only what the passes below write to: a node's name and geom list, and
  // a geom's name (plus, for a wedge, its mesh fields, which are replaced rather
  // than edited). Geoms are copied as well as nodes because resolveCsgGeoms
  // hands back the original geom objects, and a rename would leak into the
  // store. Vertex and face arrays are shared — nothing here writes into them,
  // and deep-copying a shattered scene's worth of them cost every rebuild.
  const cloneNodes = (nodes: SceneNode[]): SceneNode[] => nodes.map(n => ({
    ...n,
    ...(n.geoms ? { geoms: n.geoms.map(g => ({ ...g })) } : {}),
    ...(n.children ? { children: cloneNodes(n.children) } : {}),
  }));
  const sceneCopy: SceneGraph = { ...scene, nodes: cloneNodes(scene.nodes) };
  // Before booleans are resolved, so names match what the store keeps.
  uniquifyNamesInPlace(sceneCopy.nodes);

  // Resolve every body down to the geoms that actually simulate: a boolean's
  // negatives are dropped, and depending on the collision mode the colliders are
  // the source primitives, the generated convex sectors, or — for any body whose
  // mesh has been decomposed — its convex pieces. Runs before everything else so
  // name-uniqueness and mesh-asset collection only ever see geoms that will
  // really be emitted. A body with nothing derived is returned untouched.
  // Each body's own geom list, before it is resolved: a convex piece's source
  // mesh is dropped from what is emitted, and bodyMass needs to find it.
  const authoredGeoms = new Map<SceneNode, SceneGeom[]>();
  const resolveCsg = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      authoredGeoms.set(node, node.geoms || []);
      node.geoms = resolveCsgGeoms(node, 'physics');
      resolveCsg(node.children || []);
    }
  };
  resolveCsg(sceneCopy.nodes);

  const printFidelity = scene.simFidelity === 'print';
  applyContactClasses(sceneCopy.nodes, printFidelity);
  // A body's own mass or density, handed to the geoms that are emitted (see
  // utils/bodyMass): MJCF has nowhere to put it on the body itself.
  const applyBodyMasses = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      node.geoms = applyBodyMass(node, node.geoms || [], authoredGeoms.get(node) ?? node.geoms ?? []);
      applyBodyMasses(node.children || []);
    }
  };
  applyBodyMasses(sceneCopy.nodes);

  // The viewport finds each body and geom by its name, so a clash would bind
  // the lookups for both to whichever MuJoCo registered first. Renamed by the
  // same rule the store applies to the graph, so the two agree (see
  // utils/uniqueNames); this pass only finds anything new when a boolean's
  // generated geoms clash, since the graph pass ran on the scene handed in.
  uniquifyNamesInPlace(sceneCopy.nodes);
  // A scene handed straight to the compiler has not been through the store,
  // and one constraint naming a missing body fails the whole model.
  dropDanglingReferencesInPlace(sceneCopy.nodes);

  // Members that break under load become two welded halves, and join blobs
  // weld whatever reaches into them. After the names are final, since the
  // halves and the welds are named from them. See utils/breakModel.ts.
  const breaks = buildBreakModel(sceneCopy.nodes);

  // Runs BEFORE mesh-asset collection: a wedge is rewritten into a mesh geom
  // here, and that mesh still needs to land in the <asset> block below.
  const preprocessNodes = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.isWedge) {
        const w = node.width || 2.0;
        const h = node.height || 0.5;
        const d = node.depth || 1.0;

        if (node.geoms && node.geoms.length > 0) {
          // Collide as the solid triangular prism the user actually sees, not as
          // a thin plate along the slanted face. The top face lands in the same
          // plane either way, so ramps behave as before while the wedge now has
          // real volume to rest and tip on.
          const { vertices, faces, renderVertices } = getCachedWedgeMeshData(w, d, h);
          const g = node.geoms[0];
          g.type = 'mesh';
          g.vertices = vertices;
          g.faces = faces;
          g.renderVertices = renderVertices;
        }
      }
      preprocessNodes(node.children);
    }
  };
  preprocessNodes(sceneCopy.nodes);

  // Collect all mesh geoms so we can emit <asset> entries for them
  const meshAssets: SceneGeom[] = [];
  const collectMeshAssets = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      for (const g of node.geoms || []) {
        // MuJoCo refuses a mesh asset it cannot hull — empty, flat, or a line
        // — so those are left out; buildGeom emits a box or a speck instead.
        if (g.type === 'mesh' && g.vertices?.length && g.faces?.length && !flatMesh(g.vertices)) {
          meshAssets.push(g);
        }
      }
      collectMeshAssets(node.children);
    }
  };
  collectMeshAssets(sceneCopy.nodes);

  // Vertices stored in Three.js Y-up space (X=right, Y=up, Z=depth).
  // MuJoCo is Z-up: rotate (x,y,z) -> (x,-z,y), which keeps the winding (a
  // plain Y/Z swap would mirror it).
  const toMjcfVerts = (verts: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < verts.length; i += 3) {
      out.push(verts[i], -verts[i + 2], verts[i + 1]);
    }
    return out;
  };

  /*
   * How heavy a mesh is, and where its weight sits.
   *
   * MuJoCo's default for a mesh is `inertia="legacy"`: mass and inertia come
   * from the mesh's CONVEX HULL, not from the mesh. For a box, a bracket or a
   * building that is the same answer either way. For anything that encloses
   * mostly air it is not: the oak tree preset is a few cubic metres of timber
   * inside a hull the size of its crown, so the hull gave it a mass of 274
   * TONNES and a centre of mass 3.7m up, in mid-air between the branches. Make
   * it movable and it behaved like a top-heavy dome of water rather than like
   * a tree — a 3 m/s nudge toppled it.
   *
   * `inertia="exact"` integrates the real volume instead, which is what makes
   * a tree weigh what a tree weighs and a building weigh what a building
   * weighs, without either of them having to say so. It is only valid on a
   * closed mesh, though, and on an inside-out one it would come out negative,
   * so it is asked for only where the mesh has been checked and earns it;
   * everything else keeps the hull behaviour it has always had.
   */
  const meshInertia = (g: SceneGeom): string => {
    // A derived collider is a convex hull by construction — closed, wound
    // outward, positive volume — so the exact integral and the hull agree and
    // the answer is known without computing it. Worth short-circuiting: this
    // runs per mesh per rebuild, and a decomposed body has up to 24 of them.
    if (g.csgDerived === 'collider') return ' inertia="exact"';
    const verts = g.renderVertices || g.vertices!;
    return meshInertiaAttrs.get(verts, g.faces!, () => {
      const integrity = analyzeMesh(verts, g.faces!);
      // Closed and wound outward is not enough: a surface folded through
      // itself is both, and its exact inertia can come out non-positive,
      // which MuJoCo refuses for the whole scene. Such a mesh keeps the hull.
      return integrity && integrity.closed && integrity.consistentlyWound && integrity.volume > 0
        && checkMeshInertia(verts, g.faces!).ok
        ? ' inertia="exact"'
        : '';
    });
  };

  const sink = opts.meshFiles;
  sink?.begin();
  const meshAsset = (g: SceneGeom): string => {
    const hull = g.maxHullVert !== undefined ? ` maxhullvert="${g.maxHullVert}"` : '';
    if (sink) {
      const encoded: { bytes?: Uint8Array } = {};
      const file = meshFileNames.get(g.vertices!, g.faces!, () => {
        encoded.bytes = encodeMsh(toMjcfVerts(g.vertices!), g.faces!);
        return mshFileName(encoded.bytes);
      });
      if (sink.useFile(file, !!g.stableMesh)) {
        // Encoded only if the worker does not have it already.
        if (!sink.holds?.(file)) sink.files.set(file, encoded.bytes ?? encodeMsh(toMjcfVerts(g.vertices!), g.faces!));
        return `    <mesh name="${xmlAttr(g.name)}"${meshInertia(g)}${hull} file="${file}" />`;
      }
    }
    const verts = toMjcfVerts(g.vertices!);
    return `    <mesh name="${xmlAttr(g.name)}"${meshInertia(g)}${hull} vertex="${verts.join(' ')}" face="${g.faces!.join(' ')}" />`;
  };

  const assetXml = meshAssets.length > 0
    ? `\n  <asset>\n${meshAssets.map(meshAsset).join('\n')}\n  </asset>`
    : '';

  const actuators: SceneJoint[] = [];
  const pinionNodes: { jointName: string; nodeId: string; pos: [number, number, number]; radius: number }[] = [];
  const rackNodes: { jointName: string; nodeId: string; pos: [number, number, number] }[] = [];

  // First, traverse and compute absolute world positions, orientations, and sizes for all bodies
  const nodeWorldData: { [id: string]: { pos: [number, number, number]; quat: QuatWXYZ; size: number[] } } = {};

  const getAbsolutePositions = (
    nodes: SceneNode[],
    parentPos: [number, number, number] = [0, 0, 0],
    parentQuat: QuatWXYZ = [1, 0, 0, 0],
  ) => {
    if (!nodes) return;
    for (const node of nodes) {
      const rotatedOffset = quatRotateVec(parentQuat, node.pos);
      const worldPos: [number, number, number] = [
        parentPos[0] + rotatedOffset[0],
        parentPos[1] + rotatedOffset[1],
        parentPos[2] + rotatedOffset[2],
      ];
      const worldQuat = quatMultiply(parentQuat, nodeLocalQuat(node));
      const mainGeom = (node.geoms || [])[0];
      const size = mainGeom ? mainGeom.size : [0.1, 0.1, 0.1];
      nodeWorldData[node.id] = { pos: worldPos, quat: worldQuat, size };
      getAbsolutePositions(node.children, worldPos, worldQuat);
    }
  };
  getAbsolutePositions(sceneCopy.nodes);

  // Keep track of gear joints along with their absolute position and size
  const gearJointNodes: GearBody[] = [];
  const jointedNodes: Record<string, string> = {};
  const explicitCouplingNodes: SceneNode[] = [];
  const pulleyRopesList: SceneNode[] = [];
  const weldConstraintsList: { bodyName: string; bodyId?: string; targetId: string; rigid?: boolean }[] = [];
  /*
   * Crumple zones, as locks.
   *
   * A joint with a crumple torque is welded to whatever it hangs off, so it
   * does not move at all until the lock is released — at which point it is an
   * ordinary damped hinge with a limited range. Emitting it as a weld rather
   * than as a stiff spring is what makes it PERMANENT: a spring pulls the part
   * back, and a crumpled one should stay crumpled.
   */
  const crumpleLocks: { jointName: string; bodyName: string; bodyId: string; parentName: string; parentId?: string }[] = [];
  const connectConstraintsList: { bodyId: string; bodyName: string; targetId: string; anchor: number[] }[] = [];
  const nodeNamesMap: Record<string, string> = {};

  const jointsByName = new Map<string, { node: SceneNode; joint: SceneJoint }>();
  const traverse = (nodes: SceneNode[], parentName?: string, parentId?: string) => {
    if (!nodes) return;
    for (const node of nodes) {
      nodeNamesMap[node.id] = node.name;
      for (const j of node.joints || []) jointsByName.set(j.name, { node, joint: j });
      (node.joints || []).forEach((j) => {
        if (j.crumpleTorqueNm === undefined || j.type === 'free') return;
        crumpleLocks.push({ jointName: j.name, bodyName: node.name, bodyId: node.id, parentName: parentName ?? '', parentId });
      });
      if (node.joints && node.joints.length > 0) {
        jointedNodes[node.id] = node.joints[0].name;
      }
      if (node.coupleTargetId) {
        explicitCouplingNodes.push(node);
      }
      if (node.isPulleyRope) {
        pulleyRopesList.push(node);
      }
      if (node.weldTargetId) {
        weldConstraintsList.push({ bodyName: node.name, bodyId: node.id, targetId: node.weldTargetId, ...(node.weldRigid ? { rigid: true } : {}) });
      }
      if (node.isComposite && node.weldLastToId) {
        weldConstraintsList.push({ bodyName: (node.compositePrefix || `${node.name}_`) + 'B_last', targetId: node.weldLastToId });
      }
      if (node.connectTargetId && node.connectAnchor) {
        connectConstraintsList.push({ bodyId: node.id, bodyName: node.name, targetId: node.connectTargetId, anchor: node.connectAnchor });
      }

      const couplingAllowed = node.allowCoupling !== false;
      (node.joints || []).forEach(j => {
        if (j.actuator) actuators.push(j); 
        if (couplingAllowed && node.id.includes('gear') && j.type === 'hinge') {
          const wData = nodeWorldData[node.id] ?? { pos: [0, 0, 0], quat: [1, 0, 0, 0] as QuatWXYZ, size: [] };
          gearJointNodes.push(gearBody(node, j, wData, pitchRadius(node)));
        }
        if (couplingAllowed && node.id.includes('pinion') && j.type === 'hinge') {
          const wData = nodeWorldData[node.id];
          pinionNodes.push({
            jointName: j.name,
            nodeId: node.id,
            pos: wData ? wData.pos : [0, 0, 0],
            radius: pitchRadius(node) ?? (wData ? wData.size[0] : 0.08),
          });
        }
        if (couplingAllowed && node.id.includes('rack') && j.type === 'slide') {
          const wData = nodeWorldData[node.id];
          rackNodes.push({
            jointName: j.name,
            nodeId: node.id,
            pos: wData ? wData.pos : [0, 0, 0],
          });
        }
      });
      traverse(node.children, node.name, node.id);
    }
  };
  traverse(sceneCopy.nodes);

  // A velocity servo far stiffer than the joint it drives (kv*dt over the
  // joint's inertia), on a body held in a closed loop by a pin or a weld, is
  // driven through a clutch that never slips. The implicit integrator treats
  // that gain as inertia the constraint solver does not know about, and the
  // loop's pins tore open: a 50 g scissor-lift slider held by a kv 20000
  // servo folded the lift flat. Through the clutch the solver sees it.
  const looped = new Set<string>();
  for (const c of connectConstraintsList) { looped.add(c.bodyId); looped.add(c.targetId); }
  for (const w of weldConstraintsList) { if (w.bodyId) looped.add(w.bodyId); looped.add(w.targetId); }
  for (let i = 0; i < actuators.length; i++) {
    const j = actuators[i];
    const owner = jointsByName.get(j.name)?.node;
    if (!owner || !looped.has(owner.id) || j.actuator?.type !== 'velocity' || j.actuator.forceLimit !== undefined) continue;
    if (j.type !== 'hinge' && j.type !== 'slide') continue;
    if ((j.actuator.kv ?? 1) * 0.001 <= estimateJointInertia(owner, j)) continue;
    const held: SceneJoint = { ...j, actuator: { ...j.actuator, forceLimit: UNSLIPPING_CLUTCH } };
    actuators[i] = held;
    owner.joints = owner.joints.map((x) => (x.name === j.name ? held : x));
  }

  const actuatorsXml = actuators.map((j) => {
    const act = j.actuator!;
    const clutched = isClutchedMotor(j);
    let attrs = `name="${xmlAttr(j.name)}_actuator" joint="${xmlAttr(clutched ? clutchDriverJointName(j.name) : j.name)}"`;
    if (act.kv !== undefined && act.type === 'velocity') attrs += ` kv="${act.kv}"`;
    if (act.gear !== undefined) attrs += ` gear="${act.gear}"`;
    // A motor's ctrl is its torque. Unlimited, so a linked Volt's stall
    // torque arrives whole rather than clipped to a range nobody set.
    if (act.type === 'motor') attrs += ` ctrllimited="false"`;
    // What the motor can actually put out: a stepper's holding torque. Only
    // when set, so every actuator that had none compiles as it did.
    // A clutched motor's limit is its clutch's friction, not a clamp.
    if (act.forceLimit !== undefined && !clutched) attrs += ` forcelimited="true" forcerange="${-act.forceLimit} ${act.forceLimit}"`;
    return `    <${act.type} ${attrs} />`;
  }).join('\n');
  let equalityXml = '';
  let equalityConstraints = '';
  // Fixed tendons: motor clutches, and the couplings below.
  const tendonLines: string[] = actuators.filter(isClutchedMotor).map((j) => clutchTendonXml(j, xmlAttr));
  const couplingEdges: CouplingEdge[] = [];
  const couple = (name: string, joint1: string, joint2: string, ratio: number | string) => {
    const c = jointCouplingXml(name, joint1, joint2, ratio, xmlAttr);
    couplingEdges.push({ joint1, joint2, ratio: Number(ratio) });
    tendonLines.push(c.tendon);
    equalityConstraints += `\n${c.equality}`;
  };


  // 0. Explicit joint couplings
  let couplingIndex = 1;
  const explicitlyCoupledJointPairs = new Set<string>();

  for (const node of explicitCouplingNodes) {
    const joint1 = jointedNodes[node.id];
    const joint2 = jointedNodes[node.coupleTargetId!];
    if (joint1 && joint2) {
      const ratio = node.coupleRatio !== undefined ? node.coupleRatio : -1.0;
      const pairKey = [joint1, joint2].sort().join('::');
      explicitlyCoupledJointPairs.add(pairKey);
      // Stiff, as teeth in mesh are: at the default 0.02 s a 20 g rack pushing
      // a 5 g block fell 5% behind its pinion. See utils/jointCoupling.ts.
      couple(`explicit_coupling_${couplingIndex++}`, joint1, joint2, ratio);
    }
  }

  // Joints already tied together by explicit couplings, directly or along a
  // chain: the proximity rules below leave those alone.
  const chainOf = new Map<string, string>();
  const root = (j: string): string => {
    let r = j;
    while (chainOf.has(r) && chainOf.get(r) !== r) r = chainOf.get(r)!;
    return r;
  };
  for (const e of couplingEdges) chainOf.set(root(e.joint1), root(e.joint2));
  const sameChain = (a: string, b: string) => root(a) === root(b);

  // 1. Gears fallback dynamic proximity coupling: parallel axes, wheels in
  //    the same plane, centres a pitch-circle sum apart. See utils/gearMeshing.ts.
  const coupledPairs = new Set<string>();
  for (const { a, b, ratio } of meshingGears(gearJointNodes, sameChain)) {
    const pairKey = [a.jointName, b.jointName].sort().join('::');
    if (coupledPairs.has(pairKey) || explicitlyCoupledJointPairs.has(pairKey)) continue;
    coupledPairs.add(pairKey);
    couple(`gear_coupling_${coupledPairs.size}`, a.jointName, b.jointName, ratio.toFixed(6));
  }

  // 2. Pinion and Rack fallback proximity coupling
  let pinionRackCouplingCount = 0;
  for (const p of pinionNodes) {
    for (const r of rackNodes) {
      const dx = p.pos[0] - r.pos[0];
      const dy = p.pos[1] - r.pos[1];
      const dz = p.pos[2] - r.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Only couple if their centers are within 0.5 meters of each other
      if (dist <= 0.5) {
        const pairKey = [p.jointName, r.jointName].sort().join('::');
        if (!coupledPairs.has(pairKey) && !explicitlyCoupledJointPairs.has(pairKey) && !sameChain(p.jointName, r.jointName)) {
          coupledPairs.add(pairKey);
          pinionRackCouplingCount++;
          const pinionRadius = p.radius;
          // MuJoCo's joint equality constrains joint1 = poly(joint2), so this
          // polynomial has to give the PINION ANGLE as a function of the rack's
          // displacement: theta = x / r. It used to emit r itself, which is the
          // relationship the other way round — with r = 0.08 that asked the rack
          // to travel 1/r^2 = 156x too far, so it slammed into its own limit and
          // the whole mechanism bound up instead of driving.
          const turnsPerMetre = pinionRadius > 1e-6 ? 1 / pinionRadius : 12.5;
          const couplingName = pinionRackCouplingCount === 1
            ? 'pinion_rack_coupling'
            : `pinion_rack_coupling_${pinionRackCouplingCount}`;
          couple(couplingName, p.jointName, r.jointName, turnsPerMetre);
        }
      }
    }
  }

  // 3. Pulley Rope Joint Couplings
  let ropeCouplingIndex = 1;
  for (const rope of pulleyRopesList) {
    const { pulleyWheelId, leftTargetId, rightTargetId } = rope;
    if (leftTargetId && rightTargetId) {
      const leftJoint = jointedNodes[leftTargetId];
      const rightJoint = jointedNodes[rightTargetId];
      
      if (leftJoint && rightJoint) {
        // Linear coupling between weights: ratio is -1.0 (as one goes down, other goes up)
        equalityConstraints += `\n    <joint name="rope_coupling_linear_${ropeCouplingIndex}" joint1="${xmlAttr(leftJoint)}" joint2="${xmlAttr(rightJoint)}" polycoef="0 -1 0 0 0" />`;
        
        // Couple pulley wheel Hinge rotation with the Left weight slide joint
        if (pulleyWheelId) {
          const wheelJoint = jointedNodes[pulleyWheelId];
          if (wheelJoint) {
            // Find the pulley wheel node to get its radius
            const findWheel = (nodes: SceneNode[]): SceneNode | null => {
              if (!nodes) return null;
              for (const n of nodes) {
                if (n.id === pulleyWheelId) return n;
                const found = findWheel(n.children);
                if (found) return found;
              }
              return null;
            };
            const wheelNode = findWheel(sceneCopy.nodes);
            const radius = wheelNode?.pulleyRadius || 0.08;
            
            // Rope kinematics: the weight travels the arc the rim turns through,
            // x = r * theta.
            //
            // MuJoCo's joint equality is joint1 = poly(joint2), and joint1 here is
            // the WEIGHT's slide while joint2 is the wheel's hinge — so the
            // coefficient is the radius, not its reciprocal. It used to emit 1/r,
            // which asked for 12.5m of weight travel per radian of wheel: off by
            // 1/r^2 = 156x, impossible to satisfy alongside the left/right rope
            // coupling and gravity, so the solver fought itself and the whole
            // mechanism thrashed. (Same mistake as the rack-and-pinion coupling
            // above; both directions of that relationship look plausible in
            // isolation, which is exactly why they need a test asserting x/theta.)
            equalityConstraints += `\n    <joint name="rope_coupling_angular_${ropeCouplingIndex}" joint1="${xmlAttr(leftJoint)}" joint2="${xmlAttr(wheelJoint)}" polycoef="0 ${radius} 0 0 0" />`;
          }
        }
      }
    }
    ropeCouplingIndex++;
  }

  /** A weld's anchor at body1's origin, in body2's frame (the world's when there is no body2). */
  const weldAnchor = (bodyId: string, targetId?: string): string => {
    const part = nodeWorldData[bodyId];
    const target = targetId ? nodeWorldData[targetId] : { pos: [0, 0, 0], quat: [1, 0, 0, 0] as QuatWXYZ };
    if (!part || !target) return '';
    const local = quatRotateVecInv(target.quat, [
      part.pos[0] - target.pos[0],
      part.pos[1] - target.pos[1],
      part.pos[2] - target.pos[2],
    ]);
    return ` anchor="${local.map(v => v.toFixed(6)).join(' ')}"`;
  };

  // 3b. Crumple locks. Named after the joint rather than numbered, so the
  //     worker can map a released lock straight back to the joint it froze.
  //     Held at the locked body, for the reason given at the welds below.
  for (const lock of crumpleLocks) {
    const target = lock.parentName ? ` body2="${xmlAttr(lock.parentName)}"` : '';
    equalityConstraints += `\n    <weld name="crumple_lock_${xmlAttr(lock.jointName)}" body1="${xmlAttr(lock.bodyName)}"${target}${weldAnchor(lock.bodyId, lock.parentId)} />`;
  }

  // 4. Closed-Loop Weld Constraints
  let weldIndex = 1;
  for (const w of weldConstraintsList) {
    const targetName = nodeNamesMap[w.targetId] || w.targetId;
    // A bolted joint: stiff, where the default weld lets a 3 kg drawer sag
    // millimetres onto what is under it. Only when asked for.
    const stiff = w.rigid ? ' solref="0.004 1" solimp="0.99 0.999 0.0002 0.5 2"' : '';
    // Held at the welded part, not at the target's origin. MuJoCo's default
    // anchor is body2's origin, and a weld held there lets a small part far
    // from it swing round it: a 20 g knob welded to a drawer fell 165 mm in
    // two seconds. The anchor is in body2's frame.
    const anchor = w.bodyId ? weldAnchor(w.bodyId, w.targetId) : '';
    equalityConstraints += `\n    <weld name="weld_constraint_${weldIndex++}" body1="${xmlAttr(w.bodyName)}" body2="${xmlAttr(targetName)}"${anchor}${stiff} />`;
  }

  // 5. Closed-Loop Connect Joint Constraints
  let connectIndex = 1;
  for (const c of connectConstraintsList) {
    const targetName = nodeNamesMap[c.targetId] || c.targetId;
    // Named whenever it is a body in the scene. Only targets with joints of
    // their own used to be, so a pin on a crank's child (a crank pin with no
    // joint, carried round by the crank's) was pinned to the world instead.
    // A fixed body2 is the same as the world to MuJoCo, so naming it costs
    // nothing.
    const hasBody = c.targetId in nodeNamesMap;
    // Held rigid, as a pin is: at MuJoCo's default impedance a pin was only as
    // stiff as the lighter body it held, so a scissor lift's pins opened 7 mm
    // under its 2 kg platform with a 1 kg slider, and it folded flat with a
    // 50 g one. tests/rigidPins.test.ts.
    // MuJoCo's <connect> anchor is always specified in body1's local frame,
    // whether body2 is named or omitted (worldbody).
    const body1World = nodeWorldData[c.bodyId];
    const body1Pos = body1World ? body1World.pos : [0, 0, 0];
    const body1Quat: QuatWXYZ = body1World ? body1World.quat : [1, 0, 0, 0];
    const localAnchor = quatRotateVecInv(body1Quat, [
      c.anchor[0] - body1Pos[0],
      c.anchor[1] - body1Pos[1],
      c.anchor[2] - body1Pos[2],
    ]);
    if (hasBody) {
      equalityConstraints += `\n    <connect name="connect_constraint_${connectIndex++}" body1="${xmlAttr(c.bodyName)}" body2="${xmlAttr(targetName)}" anchor="${localAnchor.map(v => v.toFixed(6)).join(' ')}" ${RIGID_COUPLING} />`;
    } else {
      equalityConstraints += `\n    <connect name="connect_constraint_${connectIndex++}" body1="${xmlAttr(c.bodyName)}" anchor="${localAnchor.map(v => v.toFixed(6)).join(' ')}" ${RIGID_COUPLING} />`;
    }
  }

  for (const line of breaks.equality) equalityConstraints += `\n    ${line}`;

  // Bodies already joined by a coupling or a pin do not also collide: a
  // gear's collider and its mate's touch at the pitch circle, a nut's wraps
  // its screw, a pinned link overlaps its neighbour at the pin. MuJoCo skips a
  // parent and child by itself; these are the joins across the tree.
  const linkedBodies: [string, string][] = [];
  const linkedKeys = new Set<string>();
  const link = (a?: string, b?: string) => {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join('\u0000');
    if (linkedKeys.has(key)) return;
    linkedKeys.add(key);
    linkedBodies.push([a, b]);
  };
  for (const e of couplingEdges) link(jointsByName.get(e.joint1)?.node.name, jointsByName.get(e.joint2)?.node.name);
  for (const c of connectConstraintsList) if (c.targetId in nodeNamesMap) link(c.bodyName, nodeNamesMap[c.targetId]);

  // Dry friction on a coupled joint goes where the chain feels it. The nodes
  // are this compile's copies, so their joint lists can be replaced.
  for (const [jointName, frictionloss] of relocateCoupledFriction(couplingEdges, jointsByName)) {
    const owner = jointsByName.get(jointName)!.node;
    owner.joints = owner.joints.map((j) => (j.name === jointName ? { ...j, frictionloss } : j));
  }

  if (equalityConstraints) {
    equalityXml = `\n  <equality>${equalityConstraints}\n  </equality>`;
  }
  const tendonXml = tendonLines.length ? `\n  <tendon>\n${tendonLines.join('\n')}\n  </tendon>` : '';

  // Contact time constant. MuJoCo will not go below twice the timestep, and at
  // 0.002 s a part resting under gravity sinks about g*t^2 = 0.04 mm into what
  // it rests on — against 4 mm at the standard 0.02. That is the difference
  // between a 0.2 mm clearance meaning something and meaning nothing.
  const contactTime = printFidelity ? PRINT_CONTACT_TIME : 0.02;

  return `
<mujoco model="dynamic_scene">
  <!-- integrator="implicitfast": joint damping and velocity-actuator gains are
       integrated implicitly rather than explicitly. With the default Euler
       integrator a velocity actuator is only stable while kv < 2*I/timestep, so
       a small-but-stiff joint silently detonates: the gear presets (kv=20 on a
       0.0018 kg.m^2 hub) hit "Nan, Inf or huge value in QACC" within 15ms and
       simply never turned. This costs nothing and removes a whole class of
       "the preset does nothing" failure that depends on a body's scale. -->
${breaks.numerics.length ? `  <!-- A floor on rotational inertia, for scenes with breakable members and
       joint blobs. A 1.8 mm strand has almost none about its own axis, and
       MuJoCo softens a weld by the inverse inertia of what it holds: a pasta
       cantilever with a 7 g tip drooped 48 mm and swung, where 1e-8 holds it
       to 0.35 mm. Far below anything a part bigger than a strand has. -->
  <compiler boundinertia="1e-8" />
` : ''}${contactArenaXml(sceneCopy.nodes)}  <option integrator="implicitfast" timestep="0.001" gravity="0 0 ${gravityZ}" wind="${windX} ${windY} 0" density="${density}" iterations="50" tolerance="1e-10" ls_iterations="50" ls_tolerance="1e-12"${opts.sleep ? '><flag sleep="enable" /></option>' : ' />'}${assetXml}
  <default>
    <geom solref="${contactTime} 1" solimp="0.99 0.9999 0.0001 0.5 2" />
  </default>
  <worldbody>
    <light directional="true" pos="-0.3 0.3 1.5" dir="0.3 -0.3 -1.5" diffuse="0.8 0.8 0.8" />
    <geom name="floor" type="plane" size="0.5 0.5 0.1" pos="0 0 0" rgba="0.9 0.9 0.9 1" friction="${floorFriction} 0.005 0.0001" solref="${contactTime} ${Math.max(0, 1 - floorBounce).toFixed(3)}" solimp="0.99 0.9999 0.0001 0.5 2"${printFidelity ? ` contype="${FLOOR_CONTACT}" conaffinity="${FLOOR_CONTACT}"` : ''} />
    
    ${sceneCopy.nodes.map(buildNode).join('\n')}
  </worldbody>
${actuators.length > 0 ? `  <actuator>\n${actuatorsXml}\n  </actuator>` : ''}${tendonXml}${equalityXml}${breakExtrasXml(breaks, linkedBodies)}
</mujoco>
  `.trim();
};
