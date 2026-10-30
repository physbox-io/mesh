/**
 * What physics_get_scene_summary says about a scene: each body by its pose,
 * joints and geoms, mesh geoms by their counts, bounds and integrity rather
 * than their arrays, how each body collides, and what the solver weighs it at.
 *
 * Kept out of the MCP bridge, and away from the store, so it can be tested on
 * a plain scene graph: everything it needs about the live app (the compiled
 * model, the graph that model was built from) is handed in.
 */
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { ModelMirror } from '../types/sceneLayer';
import { analyzeMesh } from './meshIntegrity';
import { checkMeshInertia } from './meshInertiaCheck';
import { cageOriginInBodyMm } from './latticeFrame';
import { csgFrameOffset, csgHashOf, collisionModeOf, hasBooleanOps, meshChecksum } from './csg';
import { collidersAreStale, intrusionSentence, solidMeshGeoms, SOLIDITY_DECOMPOSE_BELOW } from './convexDecomposition';
import { measurePart } from './solidMachiningExporter';
import { collidingGeomBoxes } from './collisionCheck';
import type { BodyWorldPos } from './bodyWorld';

export const bboxOf = (flatVerts: number[] | undefined) => {
  if (!flatVerts || flatVerts.length === 0) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flatVerts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = flatVerts[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
};

/**
 * A mesh geom's bounds in the MuJoCo (Z-up) frame every other figure is in.
 * A collider carries only Y-up `vertices`, and measuring those reported its
 * box with Y and Z swapped beside the visual mesh's.
 */
export const geomBboxOf = (g: SceneGeom) => {
  if (g.renderVertices?.length) return bboxOf(g.renderVertices);
  const b = bboxOf(g.vertices);
  // Y-up (x, y, z) is Z-up (x, -z, y).
  return b && { min: [b.min[0], -b.max[2], b.min[1]], max: [b.max[0], -b.min[2], b.max[1]] };
};

/**
 * Whether a mesh geom actually encloses anything.
 *
 * physics_get_lattice and physics_get_sculpt have always reported `watertight`,
 * and a raw mesh geom reported nothing at all — so a mesh assembled by hand out
 * of pieces could be full of open rims and inside-out triangles and every reply
 * would happily describe it by its vertex count and bounding box. That is a
 * scene which renders perfectly and exports as nothing, and it is not the kind
 * of thing anybody spots by looking.
 *
 * The three checks live in utils/meshIntegrity.ts, because the MJCF compiler
 * asks the same questions of the same mesh for a different reason — whether
 * MuJoCo can integrate its true volume for its mass — and the two must not
 * drift apart on what "closed" means.
 */
export function meshIntegrity(g: SceneGeom): Record<string, unknown> {
  const faces = g.faces || [];
  const pos = g.renderVertices || g.vertices || [];
  const triangles = faces.length / 3;
  if (!triangles || !pos.length) return {};
  const m = analyzeMesh(pos, faces);
  if (!m) return { watertight: 'not checked — too many triangles' };
  return {
    watertight: m.closed,
    ...(m.boundaryEdges ? { boundaryEdges: m.boundaryEdges } : {}),
    ...(m.nonManifoldEdges ? { nonManifoldEdges: m.nonManifoldEdges } : {}),
    ...(m.degenerateTriangles ? { degenerateTriangles: m.degenerateTriangles } : {}),
    ...(m.closed && m.volume < 0 ? { windingInverted: true } : {}),
    // The case signed volume cannot see: some faces one way, some the other.
    ...(m.closed && !m.consistentlyWound ? { windingMixed: true } : {}),
    // Closed and wound outward, but folded through itself: its exact inertia
    // would not be positive, so mjcf.ts weighs it by its convex hull instead.
    ...(m.closed && m.consistentlyWound && !checkMeshInertia(pos, faces).ok
      ? { weighedByHull: true, note: 'The surface passes through itself, so this mesh is weighed by its convex hull, not its shape.' }
      : {}),
  };
}

/**
 * The bench stock against the design: the board every carve uses, and how the
 * scene's footprint and height compare with it, in plain numbers. Makers think
 * of their oak as stock, not as part of the design, and "the design is 5 mm
 * wider than your stock" is the sentence that saves the board.
 */
export function stockReport(scene: SceneGraph, stock: { widthMm: number; depthMm: number; thicknessMm: number }) {
  const design = scene.nodes?.length ? measurePart(scene, '+z', 100) : null;
  if (!design) return { ...stock };
  const r = (v: number) => Math.round(v * 10) / 10;
  const over: string[] = [];
  if (design.x > stock.widthMm + 0.5) over.push(`${r(design.x - stock.widthMm)} mm wider`);
  if (design.y > stock.depthMm + 0.5) over.push(`${r(design.y - stock.depthMm)} mm deeper`);
  if (design.z > stock.thicknessMm + 0.05) over.push(`${r(design.z - stock.thicknessMm)} mm taller`);
  // A design of several parts is usually cut one part at a time, and the box
  // round the assembly says nothing about whether each fits. The machining
  // export does take the whole scene, so that figure stays; each part's comes
  // beside it, turned 90° on the board if that is what it takes.
  const parts = (scene.nodes?.length ?? 0) > 1
    ? scene.nodes.flatMap((n) => {
        const m = measurePart({ ...scene, nodes: [n] }, '+z', 100);
        if (!m) return [];
        const fitsPlan = (m.x <= stock.widthMm + 0.5 && m.y <= stock.depthMm + 0.5)
          || (m.y <= stock.widthMm + 0.5 && m.x <= stock.depthMm + 0.5);
        const fits = fitsPlan && m.z <= stock.thicknessMm + 0.05;
        return [{ id: n.id, sizeMm: { width: r(m.x), depth: r(m.y), height: r(m.z) }, fits }];
      })
    : [];
  const misfits = parts.filter((p) => !p.fits).map((p) => p.id);
  return {
    ...stock,
    designMm: { width: r(design.x), depth: r(design.y), height: r(design.z) },
    fits: over.length === 0,
    ...(over.length ? { note: `The design is ${over.join(', ')} than your stock.` } : {}),
    ...(parts.length ? {
      parts,
      partsNote: misfits.length
        ? `On its own, ${misfits.join(', ')} ${misfits.length === 1 ? 'does' : 'do'} not fit the stock. designMm is the whole scene, which is what physics_export_machining cuts as one piece.`
        : 'Each part fits the stock on its own. designMm is the whole scene, which is what physics_export_machining cuts as one piece.',
    } : {}),
  };
}

/**
 * Whether a scene is something being made, rather than a mechanism being
 * simulated: the stock comparison, and `parts` and `partsNote` under it, only
 * mean anything for the first. A Ferris wheel is not going to be cut from a
 * 150 mm board, and telling every mechanism which of its parts would not fit
 * the bench stock was most of the noise in its summary.
 *
 * A scene counts as fabrication when it has carve settings, is set to print
 * fidelity, or has no articulated joint anywhere (hinge, slide, ball): loose
 * parts on a bench, fixed or free. One hinge and it is a mechanism. Loose
 * parts set up as an experiment are not on a bench either: a body that
 * shatters, dents, crumples, breaks under load, is a join blob, is launched
 * with an initial velocity, runs a control script or carries an actuator says
 * the scene is there to be simulated. So is a loose body held up in the air,
 * resting on nothing: cubes about to tumble, a coin about to be flipped. Carve
 * settings and print fidelity still win over all of that.
 */
export function isFabricationScene(scene: SceneGraph, carveSettings: unknown): boolean {
  if (carveSettings) return true;
  if (scene.simFidelity === 'print') return true;
  const mechanismOrExperiment = (nodes: SceneNode[] | undefined): boolean => (nodes || []).some((n) =>
    (n.joints || []).some((j) => j.type !== 'free') || isExperimentBody(n) || mechanismOrExperiment(n.children));
  return (scene.nodes?.length ?? 0) > 0 && !mechanismOrExperiment(scene.nodes) && !dropsAnything(scene.nodes);
}

/** How far above whatever is under it a loose body may start and still count as resting there, metres. */
const RESTING_GAP_M = 0.002;

/**
 * Whether any free body starts in the air: its lowest point clear of the floor
 * and of the top of every other body under it. Parts laid out on a bench, or
 * stacked on one another, rest; a drop test does not.
 */
function dropsAnything(nodes: SceneNode[]): boolean {
  const boxes = collidingGeomBoxes(nodes);
  return nodes.some((n) => {
    if (!(n.joints || []).some((j) => j.type === 'free')) return false;
    const ids = new Set<string>();
    const collect = (b: SceneNode) => { ids.add(b.id); (b.children || []).forEach(collect); };
    collect(n);
    const own = boxes.filter((b) => ids.has(b.body));
    if (!own.length) return false;
    const minZ = Math.min(...own.map((b) => b.box.min[2]));
    if (minZ <= RESTING_GAP_M) return false;
    const lo = [Math.min(...own.map((b) => b.box.min[0])), Math.min(...own.map((b) => b.box.min[1]))];
    const hi = [Math.max(...own.map((b) => b.box.max[0])), Math.max(...own.map((b) => b.box.max[1]))];
    const restsOnSomething = boxes.some((b) => !ids.has(b.body)
      && b.box.max[2] >= minZ - RESTING_GAP_M && b.box.min[2] < minZ
      && b.box.min[0] < hi[0] && b.box.max[0] > lo[0] && b.box.min[1] < hi[1] && b.box.max[1] > lo[1]);
    return !restsOnSomething;
  });
}

/** A body (not its children) set up for a physics experiment rather than to be made. */
function isExperimentBody(n: SceneNode): boolean {
  if (n.shatterImpulseNs != null || n.loadStrength || n.joinMaterial || n.script?.trim()) return true;
  if ((n.geoms || []).some((g) => g.dentYieldNs != null)) return true;
  return (n.joints || []).some((j) => j.crumpleTorqueNm != null || !!j.actuator
    || (j.initialVelocity || []).some((v) => v !== 0));
}

// ---------------------------------------------------------------------------
// Has the model caught up with the graph?
// ---------------------------------------------------------------------------

/**
 * Everything about one body (not its children) that changes what the compiled
 * model says about it: its pose and joints, and each geom's shape, placement,
 * weight and contact. Paint, colour and names of things are left out, so a
 * stroke of paint does not make the mass look stale.
 */
export function bodyPhysicsKey(node: SceneNode): string {
  return JSON.stringify([
    node.pos ?? null, node.quat ?? null, node.euler ?? null,
    (node.joints || []).map((j) => [j.type, j.axis ?? null, j.pos ?? null]),
    node.csgMass ?? null, node.collisionMass ?? null,
    (node.geoms || []).map((g) => [
      g.type, g.size ?? null, g.pos ?? null, g.quat ?? null, g.euler ?? null, g.fromto ?? null,
      g.mass ?? null, g.density ?? null, g.role ?? null, g.contype ?? null, g.conaffinity ?? null,
      g.csg ?? null, g.csgDerived ?? null,
      g.type === 'mesh' ? meshChecksum(g) : null,
    ]),
  ]);
}

/** Bodies by id, at any depth. */
function indexBodies(nodes: SceneNode[] | undefined, into = new Map<string, SceneNode>()): Map<string, SceneNode> {
  for (const n of nodes || []) {
    into.set(n.id, n);
    indexBodies(n.children, into);
  }
  return into;
}

/**
 * Which bodies of `current` the model built from `built` does not describe:
 * new ones, and ones whose physics has changed since. Null `built` (nothing
 * has been compiled yet) makes every body stale.
 */
export function staleBodies(current: SceneGraph, built: SceneGraph | null): Set<string> {
  const now = indexBodies(current.nodes);
  if (built === current) return new Set();
  if (!built) return new Set(now.keys());
  const then = indexBodies(built.nodes);
  const stale = new Set<string>();
  for (const [id, node] of now) {
    const old = then.get(id);
    if (!old || (old !== node && bodyPhysicsKey(old) !== bodyPhysicsKey(node))) stale.add(id);
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Bodies and geoms
// ---------------------------------------------------------------------------

/** To the micron: authored numbers come back as written, float noise does not. */
const um = (v: number[] | undefined) => v?.map((x) => (typeof x === 'number' ? +x.toFixed(6) : x));

/**
 * How a body actually reaches the contact solver.
 *
 * Worth reporting on every body with a mesh, not just one someone asked about:
 * "collides as its convex hull" is the difference between a cup and a solid
 * billet, and it is not visible in a screenshot or a vertex count. An agent that
 * drops a ball into a container and watches it rest on thin air has no other way
 * to find out why.
 *
 * A body whose decomposition has not run yet still collides as its hull, but
 * only until it lands, a few seconds to minutes later. Reporting "convex hull"
 * then read as the verdict; it is reported as pending instead.
 */
export function collisionReport(node: SceneNode): Record<string, unknown> {
  const colliders = (node.geoms || []).filter(g => g.csgDerived === 'collider');
  if (collidersAreStale(node)) {
    return {
      collidesAs: colliders.length > 0
        ? `${colliders.length} convex pieces, out of date: re-decomposing`
        : 'pending: convex decomposition is still running (convex hull until it lands)',
      collisionPending: true,
    };
  }
  if (colliders.length > 0) {
    return {
      collidesAs: `${colliders.length} convex pieces`,
      ...(node.collisionSolidity !== undefined ? { solidity: node.collisionSolidity } : {}),
      // Slots and recesses a piece fills in, which the piece count hides.
      ...(node.collisionCavities?.length ? { cavitiesFilled: node.collisionCavities } : {}),
      // How much an opening is narrowed: what makes a close fit jam.
      ...(node.collisionIntrusion ? {
        openingsNarrowedMm: node.collisionIntrusion.mm,
        openingsNarrowed: intrusionSentence(node.collisionIntrusion),
      } : {}),
      ...(node.collisionWarning ? { collisionWarning: node.collisionWarning } : {}),
    };
  }
  if (solidMeshGeoms(node).length === 0) return {};
  const filled = node.collisionSolidity !== undefined && node.collisionSolidity < SOLIDITY_DECOMPOSE_BELOW;
  return {
    collidesAs: 'convex hull',
    ...(node.collisionSolidity !== undefined ? { solidity: node.collisionSolidity } : {}),
    ...(filled ? { cavityFilled: 'This body is hollow but collides as its convex hull, so its cavity is solid to contact.' } : {}),
    ...(node.collisionWarning ? { collisionWarning: node.collisionWarning } : {}),
    ...(node.collisionError ? { collisionError: node.collisionError } : {}),
  };
}

/**
 * One geom. A capsule or cylinder written with `fromto` carries it: its size
 * is then only the radius, and `{type: 'capsule', size: [0.0012]}` alone reads
 * as the stub pill the docs warn about.
 */
export const summarizeGeom = (g: SceneGeom) => ({
  name: g.name,
  type: g.type,
  ...(g.csg && g.csg !== 'union' ? { csg: g.csg } : {}),
  ...(g.csgDerived ? { generated: g.csgDerived } : {}),
  ...(g.role ? { role: g.role } : {}),
  ...(g.pos ? { pos: um(g.pos) } : {}),
  ...(g.quat ? { quat: um(g.quat) } : g.euler ? { euler: um(g.euler) } : {}),
  ...(g.type === 'mesh'
    ? {
        vertCount: (g.renderVertices || g.vertices || []).length / 3,
        faceCount: (g.faces || []).length / 3,
        bbox: geomBboxOf(g),
        ...meshIntegrity(g),
      }
    : { size: um(g.size), ...(g.fromto ? { fromto: um(g.fromto) } : {}) }),
});

/*
 * What the solver uses for a body, read back from the compiled model rather
 * than worked out from the graph: densities, hand-set masses, convex pieces
 * standing in for a concave mesh and dropped source meshes all end up here,
 * and a dynamic test was the only other way to check them. The centre of mass
 * and the principal axes are in the body's own frame.
 */
const inertialOf = (model: ModelMirror | null, node: SceneNode): Record<string, unknown> | null => {
  const bId = model?._idMaps?.body?.[node.id];
  if (bId === undefined || bId < 0 || !model?.body_mass) return null;
  const r = (v: number, d: number) => +v.toPrecision(d);
  const out: Record<string, unknown> = { massKg: r(model.body_mass[bId], 6) };
  if (model.body_ipos) out.comMm = [0, 1, 2].map(i => +(model.body_ipos![bId * 3 + i] * 1000).toFixed(3));
  if (model.body_inertia) out.principalInertiaKgM2 = [0, 1, 2].map(i => r(model.body_inertia![bId * 3 + i], 6));
  if (model.body_iquat) out.principalAxesQuat = [0, 1, 2, 3].map(i => +model.body_iquat![bId * 4 + i].toFixed(6));
  return out;
};

/**
 * The geoms worth listing one by one, and a count of the rest.
 *
 * A curve track is dozens of generated segment boxes, and a decomposed body
 * dozens of convex pieces (already counted in `collidesAs`); listing each at
 * full precision was most of a 40 KB summary. `full` lists them anyway.
 */
function geomListing(node: SceneNode, full: boolean): Record<string, unknown> {
  const geoms = node.geoms || [];
  // A split section carries dozens of exact pin and socket colliders.
  const exact = geoms.filter((g) => g.contactClass);
  const listed = geoms.filter((g) => !g.contactClass);
  const out: Record<string, unknown> = {};
  if (exact.length) {
    out.exactColliders = {
      pins: exact.filter((g) => g.contactClass === 'pin').length,
      sockets: exact.filter((g) => g.contactClass === 'socket').length,
    };
  }
  if (full) {
    out.geoms = listed.map(summarizeGeom);
    return out;
  }
  if (node.isCurve) {
    out.geoms = [];
    out.curve = {
      segments: listed.length,
      ...(node.curvePoints ? { controlPoints: node.curvePoints.length } : {}),
      ...(node.curveWidth !== undefined ? { widthMm: +(node.curveWidth * 1000).toFixed(2) } : {}),
      ...(node.curveThickness !== undefined ? { thicknessMm: +(node.curveThickness * 1000).toFixed(2) } : {}),
      ...(node.curveClosed ? { closed: true } : {}),
    };
    return out;
  }
  const colliders = listed.filter((g) => g.csgDerived === 'collider');
  out.geoms = listed.filter((g) => g.csgDerived !== 'collider').map(summarizeGeom);
  if (colliders.length) out.colliderGeoms = colliders.length;
  return out;
}

export interface SummaryContext {
  /** The compiled model, if any. */
  model: ModelMirror | null;
  /** Bodies whose `inertial` is from an older build (see staleBodies). */
  stale?: Set<string>;
  /** List generated geoms (curve segments, convex pieces) one by one. */
  full?: boolean;
  /** World positions by body id (bodyWorldPositions), given where they differ from `pos`. */
  world?: Map<string, BodyWorldPos>;
}

/**
 * A body's world position, where it is not just its `pos`: a nested body's
 * pos is in its parent's frame, and a simulated one has moved.
 */
function worldPosOf(node: SceneNode, world: Map<string, BodyWorldPos> | undefined): Record<string, unknown> {
  const w = world?.get(node.id);
  if (!w) return {};
  const p = node.pos || [0, 0, 0];
  if (w.pos.every((v, i) => Math.abs(v - (p[i] ?? 0)) < 1e-6)) return {};
  return { worldPos: um(w.pos), worldPosSource: w.source };
}

export const summarizeNode = (node: SceneNode, ctx: SummaryContext): Record<string, unknown> => {
  const inertial = inertialOf(ctx.model, node);
  const stale = ctx.stale?.has(node.id) ?? false;
  const csgPending = !!node.csgEnabled && hasBooleanOps(node) && csgHashOf(node) !== node.csgHash;
  return {
    id: node.id,
    name: node.name,
    pos: um(node.pos),
    ...worldPosOf(node, ctx.world),
    ...(inertial ? { inertial: stale ? { ...inertial, stale: true } : inertial } : {}),
    ...(node.quat ? { quat: um(node.quat) } : {}),
    ...(node.euler ? { euler: um(node.euler) } : {}),
    ...(node.scad ? { hasScad: true } : {}),
    // Joint anchors and child bodies are in the body frame, whose origin is
    // the shape's centre of mass; this is where the cage's own origin is in
    // it, in mm (utils/latticeFrame.ts).
    ...(node.isLattice && (node.latticeOrigin ?? []).some((v) => v !== 0) ? { cageOriginMm: cageOriginInBodyMm(node) } : {}),
    ...(node.csgEnabled ? {
      csg: {
        collision: collisionModeOf(node),
        ...(csgPending ? { pending: true } : {}),
        ...(node.csgVolume !== undefined ? { volumeM3: +node.csgVolume.toFixed(8) } : {}),
        /*
         * How far the drawn solid sits from the frame its shapes were written in.
         *
         * A compiled boolean is re-origined on its own centre of mass in X and Y,
         * so a plate drawn symmetric about x=0 with a hole near one edge DRAWS a
         * few millimetres off centre — 4.5 mm, for a 200 mm plate with a 60 mm
         * bore at x=60. Sizes and the distances between features are unaffected;
         * only the mapping from these coordinates to world space is.
         *
         * It was not reported anywhere, so a caller measuring the drawn part and
         * then cutting at what it measured put the cut in the wrong place. It is
         * reported here for the same reason latticeOrigin is: it is the number you
         * need to convert, and nothing else will tell you it.
         */
        ...(csgFrameOffset(node).some((v) => v !== 0) ? { originOffsetMm: csgFrameOffset(node).map(v => +(v * 1000).toFixed(3)) } : {}),
        ...(node.csgWarning ? { warning: node.csgWarning } : {}),
        ...(node.csgError ? { error: node.csgError } : {}),
      },
    } : {}),
    ...(node.csgEnabled ? {} : collisionReport(node)),
    ...(node.printPose ? { printPose: { up: node.printPose.up, spinDeg: +(node.printPose.spin * 180 / Math.PI).toFixed(2) } } : {}),
    joints: (node.joints || []).map((j) => ({ name: j.name, type: j.type })),
    ...geomListing(node, !!ctx.full),
    children: (node.children || []).map((c) => summarizeNode(c, ctx)),
  };
};
