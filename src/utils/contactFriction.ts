/**
 * Low and zero sliding friction, compiled so that it behaves.
 *
 * MuJoCo's default friction cone is pyramidal: each contact becomes edges
 * along normal ± mu * tangent. At mu = 0 the edges coincide and the solver is
 * handed a degenerate cone; a 1 kg box on a 20° ramp with friction [0, ...] was
 * thrown 1.8 m up spinning at 115 rad/s. Small mu is barely better: a lever's
 * load was launched hundreds of metres with mu 0.01 on its plank and stop, and
 * still flew at 0.05.
 *
 * So a scene with any contact below LOW_SLIDE_FRICTION uses the elliptic cone,
 * the exact friction cone, which has no edges to collapse. Scenes without one
 * keep the pyramid, so nothing else changes.
 *
 * And sliding friction is never written below MIN_SLIDE_FRICTION. Exactly no
 * friction is still unstable in the exact cone, and in condim 1 (MuJoCo's
 * frictionless contact) as well: a hinged plank held against a stop by both
 * was kicked from rest to 13 rad/s every half second, where 0.001 held it
 * still. 0.001 is a well-lubricated bearing; on a 20° ramp it slows the
 * slide by 0.3% (3.355 m/s² against g sin 20° = 3.362), which is "icy".
 */
import type { SceneGeom, SceneNode } from '../types/scene';

/** The least sliding friction a contact is compiled with. */
export const MIN_SLIDE_FRICTION = 0.001;
/** Below this the pyramidal cone misbehaves; measured flying at 0.05, sound at 0.2, 0.1 the presets' lowest. */
export const LOW_SLIDE_FRICTION = 0.1;

/** Sliding friction as compiled: at least MIN_SLIDE_FRICTION. */
export const compiledSlide = (slide: number): number =>
  Number.isFinite(slide) && slide >= MIN_SLIDE_FRICTION ? slide : MIN_SLIDE_FRICTION;

/** A geom's friction as compiled, or undefined when it sets none. */
export function geomFriction(geom: SceneGeom): number[] | undefined {
  const f = geom.friction;
  if (!Array.isArray(f) || typeof f[0] !== 'number') return undefined;
  return [compiledSlide(f[0]), ...f.slice(1)];
}

const touches = (geom: SceneGeom) =>
  geom.role !== 'visual' && !(geom.contype === 0 && geom.conaffinity === 0) && geom.condim !== 1;

/** True when some contact in the scene, the floor included, has a low sliding friction. */
export function needsEllipticCone(nodes: SceneNode[], floorFriction: number): boolean {
  if (!(floorFriction >= LOW_SLIDE_FRICTION)) return true;
  const walk = (list: SceneNode[] | undefined): boolean =>
    (list || []).some((n) =>
      (n.geoms || []).some((g) => {
        const f = geomFriction(g);
        return !!f && f[0] < LOW_SLIDE_FRICTION && touches(g);
      }) || walk(n.children));
  return walk(nodes);
}
