// ---- Impacts --------------------------------------------------------------
//
// What counts as "hit hard" is IMPULSE, not force. Contact force in a hard
// solver is a spike whose height depends on the timestep as much as on the
// collision, so a force threshold is a number that changes meaning when the
// timestep does. Momentum does not: 0.2 kg arriving at 5 m/s and stopping dead
// is 1 N*s whatever the solver was doing, and it is a quantity somebody can
// reason about without knowing anything about MuJoCo.
//
// The cheap signal is `qfrc_constraint` — the net constraint force on each
// degree of freedom, a plain view with no heap copy behind it, summed over a
// short sliding window. Resting on a table barely registers: a 1 kg body at
// rest accumulates 0.05 N*s over the window and stays there. Being struck
// clears a whole newton-second in a few milliseconds.
//
// Only once that trips does the expensive read happen. `dat.contact` copies the
// entire contact array onto the wasm heap every time it is touched — the leak
// that used to hit the 2 GB ceiling — so it is read once, on the step of the
// impact, purely to find out WHERE the body was hit. Never per step.
//
// Out of physicsWorker.ts so the live loop, the headless run and the tests
// (which cannot load the worker) all detect a blow with the same code. Pure:
// it reads the model and data it is handed and returns what it found.

import type load_mujoco from '@mujoco/mujoco';
import type { SceneNode } from '../types/scene';
import type { ImpactEvent } from './physicsWorkerProtocol';
import { shatterFloor } from '../utils/breakThresholds';
import { bodyAngularVelocity, bodyPointVelocity } from './bodyKinematics';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjData = InstanceType<Mujoco['MjData']>;

/** Degrees of freedom per joint type: free, ball, slide, hinge. */
const JOINT_NV = [6, 3, 1, 1];

/** Sliding window for the impulse sum, in steps (1 ms each). */
const IMPACT_WINDOW_STEPS = 5;
/** Steps to wait before a body may report another impact. */
const IMPACT_COOLDOWN_STEPS = 250;

interface ImpactWatch {
  nodeId: string;
  bodyId: number;
  dofadr: number;
  /**
   * How many of this joint's degrees of freedom are translational.
   *
   * Six for a free joint, of which the first three are the linear ones. For a
   * hinge there is exactly one, and reading three would walk straight off the
   * end of it into whatever joint MuJoCo laid out next — so a swinging arm
   * would be reporting some other body's constraint force as its own.
   */
  dofCount: number;
  /** The lowest threshold anything on this body cares about, in N*s. */
  triggerNs: number;
  ring: Float64Array;
  cursor: number;
  cooldown: number;
  /**
   * The load this body carries when nothing is happening to it.
   *
   * Without this a heavy body cannot be watched at all: a 60 kg plate lying on
   * the ground shows a steady 590 N of constraint force just holding itself up,
   * which fills a 5 ms window with 3 N*s of perfectly uneventful resting
   * contact. Only the EXCESS over what it normally carries is a blow, so the
   * baseline is tracked slowly and subtracted. A long time constant on purpose:
   * it has to be far slower than any impact, or it would learn the impact.
   */
  baseline: number;
  /**
   * Whether the baseline has seen anything yet.
   *
   * Starting it at zero makes a body's own resting weight look like a blow on
   * the very first step, so every dentable thing in the scene got dented the
   * instant it loaded. The first reading IS the baseline.
   */
  primed: boolean;
  /**
   * A blow in progress, waiting for its peak.
   *
   * The running impulse is reported when it crosses the LOWEST threshold
   * anything in the scene cares about — which is not the same as how hard the
   * blow was. Reporting at that instant meant a steel slug and a rubber one
   * both arrived as "just over the smallest number in the scene", and a plate
   * that yields higher up was never told about either. So the crossing starts a
   * short watch instead, and what gets reported is the largest the impulse
   * reaches over the rest of the window: five milliseconds later, and the
   * difference between a hard blow and a soft one intact.
   */
  pending: { stepsLeft: number; maxImpulseNs: number; point: number[]; normal: number[]; otherBodyId: number } | null;
}

/** ~500 steps, so the baseline follows a body settling but never an impact. */
const IMPACT_BASELINE_ALPHA = 0.002;

/** Every watched body of one model, and who owns each body id. */
export interface ImpactWatches {
  watches: ImpactWatch[];
  /** Body id -> node id, for naming the other party to a collision. */
  bodyIdToNodeId: Record<number, string>;
}

/**
 * Which bodies are worth watching, and how hard they have to be hit.
 *
 * A body with neither a shatter threshold nor a dentable geom is not watched at
 * all, so a scene that uses none of this pays for one `length === 0` test per
 * step.
 */
export function buildImpactWatches(
  mdl: MjModel | null,
  nodes: SceneNode[],
  bodyIdOf: Record<string, number>,
  jointIdOf: Record<string, number>,
): ImpactWatches {
  const out: ImpactWatches = { watches: [], bodyIdToNodeId: {} };
  if (!mdl) return out;

  /*
   * The softest thing in the scene, if anything is dentable at all.
   *
   * A body resting on the ground is a poor witness to being hit: squeezed
   * between the blow above and the ground below, its NET constraint force
   * barely moves, because the ground reaction rises to meet the load. The
   * hammer is the honest witness — a falling weight carries no constraint force
   * at all until the moment it arrives, so what shows up on it IS the
   * collision. So anything that can move is watched when the scene contains
   * something dentable, and a blow is attributed to both parties.
   */
  let minDentNs = Infinity;
  const scanDentable = (list: SceneNode[]) => {
    for (const node of list || []) {
      for (const g of node.geoms || []) {
        if (typeof g.dentYieldNs === 'number' && g.dentYieldNs > 0) minDentNs = Math.min(minDentNs, g.dentYieldNs);
        // A surface that can only be pierced is still worth watching for.
        if (typeof g.pierceImpulseNs === 'number' && g.pierceImpulseNs > 0) minDentNs = Math.min(minDentNs, g.pierceImpulseNs);
      }
      scanDentable(node.children || []);
    }
  };
  scanDentable(nodes);

  const collect = (list: SceneNode[]) => {
    if (!list) return;
    for (const node of list) {
      const thresholds: number[] = [];
      if (typeof node.shatterImpulseNs === 'number' && node.shatterImpulseNs > 0) {
        // The weakest wall anywhere on it: only the main thread can tell
        // where the blow landed, and so how thick the body is there.
        thresholds.push(shatterFloor(node));
      }
      for (const g of node.geoms || []) {
        if (typeof g.dentYieldNs === 'number' && g.dentYieldNs > 0) thresholds.push(g.dentYieldNs);
        if (typeof g.pierceImpulseNs === 'number' && g.pierceImpulseNs > 0) thresholds.push(g.pierceImpulseNs);
      }
      if (Number.isFinite(minDentNs)) thresholds.push(minDentNs);
      const bodyId = bodyIdOf[node.id];
      if (bodyId !== undefined) out.bodyIdToNodeId[bodyId] = node.id;
      // Needs a joint of its own: a body welded into the scenery has no degrees
      // of freedom for a constraint force to show up on.
      const jointName = node.joints?.[0]?.name;
      const jointId = jointName !== undefined ? jointIdOf[jointName] : undefined;
      if (thresholds.length > 0 && bodyId !== undefined && jointId !== undefined) {
        const jointType = mdl.jnt_type[jointId];
        out.watches.push({
          nodeId: node.id,
          bodyId,
          dofadr: mdl.jnt_dofadr[jointId],
          dofCount: Math.min(3, JOINT_NV[jointType] ?? 1),
          triggerNs: Math.min(...thresholds),
          ring: new Float64Array(IMPACT_WINDOW_STEPS),
          cursor: 0,
          cooldown: 0,
          baseline: 0,
          primed: false,
          pending: null,
        });
      }
      collect(node.children || []);
    }
  };
  collect(nodes);
  return out;
}

/**
 * Where on the body the blow landed, in the body's own frame.
 *
 * The one place `dat.contact` is read outside history sampling, and it is read
 * once per impact rather than once per step. Read-once/delete-in-finally, the
 * same discipline buildHistoryEntry documents.
 */
function impactSiteOf(
  mdl: MjModel,
  dat: MjData,
  bodyId: number,
  againstBodyId?: number,
): { point: number[]; normal: number[]; otherBodyId: number } | null {
  let best: { point: number[]; normal: number[]; otherBodyId: number } | null = null;
  const contactVec = dat.contact;
  try {
    const ncon = contactVec.size();
    for (let c = 0; c < ncon; c++) {
      const contact = contactVec.get(c);
      if (!contact) continue;
      try {
        const b1 = mdl.geom_bodyid[contact.geom1];
        const b2 = mdl.geom_bodyid[contact.geom2];
        if (b1 !== bodyId && b2 !== bodyId) continue;
        // When we already know who hit whom, take THAT contact. A plate lying
        // on the ground is in contact with the ground at every step, and the
        // first contact found for it is usually one of those — which would put
        // the dent on its underside rather than where it was struck.
        if (againstBodyId !== undefined && b1 !== againstBodyId && b2 !== againstBodyId) continue;
        const pos = contact.pos;
        const frame = contact.frame;
        // contact.frame's first row is the normal, pointing from geom1 to geom2.
        const sign = b1 === bodyId ? 1 : -1;
        best = {
          point: [pos[0], pos[1], pos[2]],
          normal: [frame[0] * sign, frame[1] * sign, frame[2] * sign],
          otherBodyId: b1 === bodyId ? b2 : b1,
        };
      } finally {
        contact.delete();
      }
      if (best) break;
    }
  } finally {
    contactVec.delete();
  }
  if (!best) return null;

  // World -> body local: R^T (p - xpos). xmat is row-major, so its transpose is
  // a column read.
  const px = best.point[0] - dat.xpos[bodyId * 3];
  const py = best.point[1] - dat.xpos[bodyId * 3 + 1];
  const pz = best.point[2] - dat.xpos[bodyId * 3 + 2];
  const m = bodyId * 9;
  const local = (x: number, y: number, z: number): number[] => [
    dat.xmat[m] * x + dat.xmat[m + 3] * y + dat.xmat[m + 6] * z,
    dat.xmat[m + 1] * x + dat.xmat[m + 4] * y + dat.xmat[m + 7] * z,
    dat.xmat[m + 2] * x + dat.xmat[m + 5] * y + dat.xmat[m + 8] * z,
  ];
  return {
    point: local(px, py, pz),
    normal: local(best.normal[0], best.normal[1], best.normal[2]),
    otherBodyId: best.otherBodyId,
  };
}

/** Has anything been hit hard enough to care about this step? Call after mj_step. */
export function checkImpacts(w: ImpactWatches, mdl: MjModel | null, dat: MjData | null, dt: number): ImpactEvent[] {
  if (w.watches.length === 0 || !mdl || !dat) return [];
  const events: ImpactEvent[] = [];

  for (const watch of w.watches) {
    if (watch.cooldown > 0) { watch.cooldown--; continue; }

    let sum = 0;
    for (let i = 0; i < watch.dofCount; i++) {
      const c = dat.qfrc_constraint[watch.dofadr + i];
      sum += c * c;
    }
    const force = Math.sqrt(sum);

    // Only what this body is NOT normally carrying counts as a blow.
    if (!watch.primed) { watch.baseline = force; watch.primed = true; }
    const excess = Math.max(0, force - watch.baseline);
    watch.baseline += (force - watch.baseline) * IMPACT_BASELINE_ALPHA;

    watch.ring[watch.cursor] = excess * dt;
    watch.cursor = (watch.cursor + 1) % IMPACT_WINDOW_STEPS;

    let impulseNs = 0;
    for (let i = 0; i < IMPACT_WINDOW_STEPS; i++) impulseNs += watch.ring[i];

    if (watch.pending) {
      // Still measuring. The site was taken at first contact, while there
      // certainly was one; only the size of the blow is still in question.
      if (impulseNs > watch.pending.maxImpulseNs) watch.pending.maxImpulseNs = impulseNs;
      if (--watch.pending.stepsLeft > 0) continue;

      const { maxImpulseNs, point, normal, otherBodyId } = watch.pending;
      watch.pending = null;
      watch.cooldown = IMPACT_COOLDOWN_STEPS;
      watch.ring.fill(0);

      // The same blow in the other body's frame, so a dent lands where the
      // thing was actually struck rather than at its origin.
      const otherNodeId = otherBodyId >= 0 ? w.bodyIdToNodeId[otherBodyId] : undefined;
      const otherSite = otherBodyId >= 0 ? impactSiteOf(mdl, dat, otherBodyId, watch.bodyId) : null;
      const b = watch.bodyId;
      const views = { cvel: dat.cvel, xpos: dat.xpos, subtreeCom: dat.subtree_com, rootId: mdl.body_rootid };

      events.push({
        nodeId: watch.nodeId,
        otherNodeId,
        otherLocalPoint: otherSite?.point,
        otherLocalNormal: otherSite?.normal,
        time: dat.time,
        impulseNs: maxImpulseNs,
        localPoint: point,
        localNormal: normal,
        pos: [dat.xpos[b * 3], dat.xpos[b * 3 + 1], dat.xpos[b * 3 + 2]],
        xmat: Array.from({ length: 9 }, (_, i) => dat.xmat[b * 9 + i]),
        // The origin's velocity (runtimeShatter adds ω × r from `pos`), not cvel's tree-COM point.
        vel: bodyPointVelocity(views, b),
        angvel: bodyAngularVelocity(views, b),
      });
      continue;
    }

    if (impulseNs < watch.triggerNs) continue;

    const site = impactSiteOf(mdl, dat, watch.bodyId);
    watch.pending = {
      stepsLeft: IMPACT_WINDOW_STEPS,
      maxImpulseNs: impulseNs,
      point: site?.point ?? [0, 0, 0],
      normal: site?.normal ?? [0, 0, 1],
      otherBodyId: site?.otherBodyId ?? -1,
    };
  }
  return events;
}
