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
  const arr = Array.isArray(rawSize)
    ? rawSize.map((v: unknown) => (v === undefined ? undefined : (typeof v === 'number' && !isNaN(v) && v > 0) ? v : 0.1))
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
    const slabFriction = geomFriction(geom);
    if (slabFriction) slab += ` friction="${slabFriction.join(' ')}"`;
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
  // Never below 0.001: no friction at all is unstable in MuJoCo (contactFriction.ts).
  const friction = geomFriction(geom);
  if (friction) attrs += ` friction="${friction.join(' ')}"`;
  if (geom.solref) attrs += ` solref="${geom.solref.join(' ')}"`;
  if (geom.solimp) attrs += ` solimp="${geom.solimp.join(' ')}"`;
  if (geom.margin !== undefined) attrs += ` margin="${geom.margin}"`;
  if (geom.gap !== undefined) attrs += ` gap="${geom.gap}"`;
  return `<geom ${attrs} />`;
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

export const buildNode = (node: SceneNode): string => {
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
