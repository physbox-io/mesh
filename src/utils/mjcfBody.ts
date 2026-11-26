import type { SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { isNodeRotationBaked } from './sceneTree';
import { geomSizeProblem } from './geomSize';
import { geomFriction } from './contactFriction';
import { clutchDriverBodyXml, isClutchedMotor } from './motorClutch';
import { flatMesh } from './mjcfFlatMesh';
import { xmlAttr } from './xmlAttr';

/*
 * One body of the scene as MJCF: its joints, its geoms and its children. A
 * body's rotation is left off when its vertices already carry it
 * (`isNodeRotationBaked`, sceneTree.ts).
 */

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
  // A hole in the list is an entry left out, read from the first as a short
  // size is; only a data-less mesh standing in as a box still gets 0.1.
  const isPlane = type === 'plane';
  const arr = Array.isArray(rawSize)
    ? rawSize.map((v: unknown) => (v === undefined ? undefined : (typeof v === 'number' && !isNaN(v) && (isPlane ? v >= 0 : v > 0)) ? v : 0.1))
    : [0.1, 0.1, 0.1];

  if (type === 'sphere') {
    return `${arr[0] || 0.1}`;
  }
  if (type === 'cylinder' || type === 'capsule') {
    const r = arr[0] || 0.1;
    const h = arr[1] || arr[0] || 0.1;
    return `${r} ${h}`;
  }
  if (isPlane) {
    const x = arr[0] ?? 0;
    const y = arr[1] ?? arr[0] ?? 0;
    const z = arr[2] ?? 0.1;
    return `${x} ${y} ${z}`;
  }
  // For 'box' or fallback primitive shapes
  const x = arr[0] || 0.1;
  const y = arr[1] || arr[0] || x;
  const z = arr[2] || arr[0] || x;
  return `${x} ${y} ${z}`;
};

/**
 * What a geom weighs and how it touches, the same whatever shape it is emitted
 * as. The thin box a flat mesh becomes kept its own copy of these, and lost
 * the geom's solref, solimp, margin and gap.
 */
const physicalAttrs = (geom: SceneGeom, massless: boolean): string => {
  let attrs = '';
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
  // Never below 0.001: no friction at all is unstable in MuJoCo (contactFriction.ts).
  const friction = geomFriction(geom);
  if (friction) attrs += ` friction="${friction.join(' ')}"`;
  if (geom.solref) attrs += ` solref="${geom.solref.join(' ')}"`;
  if (geom.solimp) attrs += ` solimp="${geom.solimp.join(' ')}"`;
  if (geom.margin !== undefined) attrs += ` margin="${geom.margin}"`;
  if (geom.gap !== undefined) attrs += ` gap="${geom.gap}"`;
  return attrs;
};

const buildGeom = (geom: SceneGeom, massless = false) => {
  if (geom.type === 'hfield' && geom.hfield && geom.hfield.nrow >= 2 && geom.hfield.ncol >= 2 && geom.hfield.data.length >= geom.hfield.nrow * geom.hfield.ncol) {
    let attrs = `name="${xmlAttr(geom.name)}" type="hfield" hfield="${xmlAttr(geom.name)}"`;
    if (geom.rgba) attrs += ` rgba="${geom.rgba.join(' ')}"`;
    if (geom.pos) attrs += ` pos="${geom.pos.join(' ')}"`;
    if (geom.quat) {
      attrs += ` quat="${geom.quat.join(' ')}"`;
    } else if (geom.euler) {
      attrs += ` euler="${geom.euler.join(' ')}"`;
    }
    return `<geom ${attrs}${physicalAttrs(geom, massless)} />`;
  }
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
    return `<geom ${slab}${physicalAttrs(geom, massless)} />`;
  }
  const emptyMesh = geom.type === 'mesh' && (
    flat === 'speck'
    || (flat !== null && rotated)
    || (!hasMeshData && (
      (Array.isArray(geom.vertices) && geom.vertices.length === 0)
      || (Array.isArray(geom.faces) && geom.faces.length === 0)
    ))
  );
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
  return `<geom ${attrs}${physicalAttrs(geom, massless)} />`;
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

export type WorldPosMap = Map<string, [number, number, number]>;

/** Collect world-space positions (by node id and name) for anchored composite sag geometry. */
export function collectWorldPositions(nodes: SceneNode[]): WorldPosMap {
  const map: WorldPosMap = new Map();
  const walk = (list: SceneNode[] | undefined, ox: number, oy: number, oz: number) => {
    for (const n of list || []) {
      const x = ox + (n.pos?.[0] ?? 0);
      const y = oy + (n.pos?.[1] ?? 0);
      const z = oz + (n.pos?.[2] ?? 0);
      const pt: [number, number, number] = [x, y, z];
      if (n.id) map.set(n.id, pt);
      if (n.name) map.set(n.name, pt);
      walk(n.children, x, y, z);
    }
  };
  walk(nodes, 0, 0, 0);
  return map;
}

/**
 * Build a sagging parabolic vertex list from `start` to `end` whose piecewise-linear
 * arc length matches `targetLength` (when `targetLength > span`), so increasing a
 * welded cable's length sags smoothly between both anchors instead of jutting past
 * the far anchor.
 */
function buildSlackCableVertices(
  start: [number, number, number],
  end: [number, number, number],
  vertexCount: number,
  targetLength: number,
): string | null {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const span = Math.hypot(dx, dy, dz);
  if (!(span > 1e-4) || !Number.isFinite(targetLength) || targetLength <= span + 1e-4) return null;
  const n = Math.max(3, Math.floor(vertexCount));

  const arcLen = (sag: number): number => {
    let total = 0;
    let px = 0, py = 0, pz = 0;
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      const x = t * dx;
      const y = t * dy;
      const z = t * dz - 4 * sag * t * (1 - t);
      total += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
    }
    return total;
  };

  let lo = 0;
  let hi = targetLength;
  for (let iter = 0; iter < 24; iter++) {
    const mid = 0.5 * (lo + hi);
    if (arcLen(mid) < targetLength) lo = mid;
    else hi = mid;
  }
  const sag = 0.5 * (lo + hi);
  const coords: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = t * dx;
    const y = t * dy;
    const z = t * dz - 4 * sag * t * (1 - t);
    coords.push(x.toFixed(5), y.toFixed(5), z.toFixed(5));
  }
  return coords.join(' ');
}

export const buildNode = (node: SceneNode, worldPositions?: WorldPosMap): string => {
  if (!node) return '';
  const posStr = Array.isArray(node.pos) ? node.pos.join(' ') : '0 0 0';
  // Logical-only nodes (e.g. pulley ropes) have no geoms or joints and must not
  // emit a <body> into MJCF — a bodyless body causes implicit inertia artefacts.
  // But a part added with the rope selected lands under it, and was dropped
  // from the model with it. Its position is in the rope's frame, as the rest
  // of the tree reads it (getNodeWorldPos, restPoses), so it goes in a
  // <frame>, which places bodies without being one.
  if (node.isPulleyRope) {
    if (!node.children?.length) return '';
    const turn = node.quat ? ` quat="${node.quat.join(' ')}"` : node.euler ? ` euler="${node.euler.join(' ')}"` : '';
    return `<frame pos="${posStr}"${turn}>${node.children.map((c) => buildNode(c, worldPositions)).join('')}</frame>`;
  }

  const nameStr = node.name || node.id || 'body';

  // Cloth is not MuJoCo's: the cloth solver in the worker owns it
  // (utils/cloth/xpbd.ts), reading where every body is each step. Anything
  // parented to a cloth body is placed in its frame, which places bodies
  // without being one.
  if (node.cloth) {
    if (!node.children?.length) return '';
    const turn = node.quat ? ` quat="${node.quat.join(' ')}"` : node.euler ? ` euler="${node.euler.join(' ')}"` : '';
    return `<frame pos="${posStr}"${turn}>${node.children.map((c) => buildNode(c, worldPositions)).join('')}</frame>`;
  }

  if (node.isComposite) {
    // Only 'cable' survives in MuJoCo 3.17 ('rope' is our alias for it). A
    // saved 'cloth' or 'grid' composite carried a 2D count ('8 8 1') and often
    // a 'sphere' geom, both of which fail MuJoCo 3.17's 1D cable compiler, so
    // collapse them to a 1D capsule cable.
    const rawType = node.compositeType as string | undefined;
    const isLegacy2D = rawType === 'cloth' || rawType === 'grid';
    const type = 'cable';
    const rawCountParts = (node.compositeCount || '15 1 1').trim().split(/\s+/).map(Number);
    const hasMultiDimCount = rawCountParts.some((n, idx) => idx > 0 && Number.isFinite(n) && n > 1);
    const firstCount = rawCountParts[0];
    const hasTooFewCount = !Number.isFinite(firstCount) || firstCount < 2;
    const clampedCount = Number.isFinite(firstCount) ? Math.max(2, Math.floor(firstCount)) : 15;
    const count = isLegacy2D || hasMultiDimCount || hasTooFewCount
      ? `${clampedCount} 1 1`
      : (node.compositeCount || '15 1 1').trim();
    const rawSize = node.compositeSize !== undefined ? String(node.compositeSize).trim() : '1.5';
    const firstSize = parseFloat(rawSize.split(/\s+/)[0] || '');
    const size = isLegacy2D || hasMultiDimCount || /\s/.test(rawSize)
      ? String(Number.isFinite(firstSize) && firstSize > 0 ? firstSize : 1.5)
      : rawSize;
    const prefix = node.compositePrefix || `${nameStr}_`;
    const rawCurve = (node.compositeCurve || 's 0 0').trim();
    const curveParts = rawCurve.split(/\s+/);
    const curve = isLegacy2D && curveParts.filter((c) => c !== '0').length > 1
      ? `${curveParts[0] || 's'} 0 0`
      : rawCurve;

    const damping = node.joints?.[0]?.damping !== undefined ? node.joints[0].damping : 0.05;
    const stiffness = node.joints?.[0]?.stiffness !== undefined ? node.joints[0].stiffness : 0.0;

    const geom = node.geoms?.[0];
    const rawGeomType = geom?.type || 'capsule';
    const validCableGeom = rawGeomType === 'capsule' || rawGeomType === 'cylinder' || rawGeomType === 'box';
    const geomType = (isLegacy2D || !validCableGeom) ? 'capsule' : rawGeomType;
    const geomSize = geomType === 'capsule' || geomType === 'cylinder'
      ? String(geom?.size?.[0] ?? 0.02)
      : (geom?.size ? geom.size.join(' ') : '0.02');
    const geomRgba = geom?.rgba ? geom.rgba.join(' ') : '0.8 0.4 0.2 1';

    const startPos = worldPositions?.get(node.id) ?? (node.name ? worldPositions?.get(node.name) : undefined);
    const endPos = node.weldLastToId ? worldPositions?.get(node.weldLastToId) : undefined;
    const targetLen = parseFloat(size);
    const slackVertices = startPos && endPos
      ? buildSlackCableVertices(startPos, endPos, clampedCount, targetLen)
      : null;

    const compositeXml = slackVertices
      ? `<composite type="${type}" vertex="${slackVertices}" prefix="${xmlAttr(prefix)}"><joint kind="main" damping="${damping}" stiffness="${stiffness}" /><geom type="${geomType}" size="${geomSize}" rgba="${geomRgba}" /></composite>`
      : `<composite type="${type}" count="${xmlAttr(count)}" size="${xmlAttr(size)}" curve="${xmlAttr(curve)}" prefix="${xmlAttr(prefix)}"><joint kind="main" damping="${damping}" stiffness="${stiffness}" /><geom type="${geomType}" size="${geomSize}" rgba="${geomRgba}" /></composite>`;

    let attrs = `name="${xmlAttr(nameStr)}" pos="${posStr}"`;
    if (node.quat) {
      attrs += ` quat="${node.quat.join(' ')}"`;
    } else if (node.euler) {
      attrs += ` euler="${node.euler.join(' ')}"`;
    }
    
    let childrenXml = '';
    (node.children || []).forEach(c => childrenXml += buildNode(c, worldPositions));
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
  (node.children || []).forEach(c => innerXml += buildNode(c, worldPositions));
  
  let frame = ` pos="${posStr}"`;
  if (isNodeRotationBaked(node)) {
    // Nothing: the vertices already carry it. See `isNodeRotationBaked`.
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
