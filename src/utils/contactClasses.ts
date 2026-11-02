import type { SceneGeom, SceneNode } from '../types/scene';

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
export const FLOOR_CONTACT = 0x7fffffff;
const jointBit = (group: number | undefined) => 1 << (2 + (((group ?? 0) % JOINT_BITS) + JOINT_BITS) % JOINT_BITS);

/** The contact time constant in print fidelity. See compileToMJCF. */
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
 * - Except a moving dense import (`denseColliderOf`, utils/denseMesh.ts): its
 *   visible mesh alone would take most of the engine's heap, so it is left
 *   out, as demoteDecomposedGeom (csg.ts) leaves a decomposed one out. The
 *   renderer draws a moving mesh from the body transform. A static one stays,
 *   because the renderer finds it by geom id.
 *
 * A scene with neither kind of geom comes out byte for byte as it did before
 * this existed, which the native app's golden XML depends on.
 */
export function applyContactClasses(nodes: SceneNode[], print: boolean) {
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
          const { colliderVertices, colliderFaces, denseColliderOf, ...rest } = g;
          if (!(g.dynamic && denseColliderOf)) out.push({ ...rest, role: 'visual', mass: undefined, density: undefined });
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
