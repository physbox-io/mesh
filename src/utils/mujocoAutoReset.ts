/**
 * Counting MuJoCo's silent auto-resets.
 *
 * When `mj_step` finds a huge or non-finite qpos, qvel or qacc, it calls
 * `mj_resetData` (back to qpos0, zero velocity, time 0) and carries on with the
 * step, so the step "succeeds" and `data.time` comes out at one timestep. Later
 * in a run that shows up as the clock going backwards. On the very first step
 * it does not: a normal step from t = 0 also ends at one timestep, so the clock
 * alone cannot tell a reset from a good step, and a scene whose initial
 * velocities blew it up ran on from rest as if nothing had happened.
 *
 * What does give it away is the warning MuJoCo raises with the reset:
 * mjWARN_BADQPOS / BADQVEL / BADQACC. `mj_resetData` clears every warning
 * counter and the check then sets its own to 1, so after a reset the sum of
 * these three changes from whatever it was before - compare for change, not
 * for growth.
 */

/** mjtWarning indices of the three checks that reset the state (MuJoCo 3.x). */
export const MJ_WARN_BADQPOS = 3;
export const MJ_WARN_BADQVEL = 4;
export const MJ_WARN_BADQACC = 5;

interface WarningStat { number: number; lastinfo: number; delete?: () => void }
interface WarningVec { size(): number; get(i: number): WarningStat | undefined }

/**
 * The summed BADQPOS/BADQVEL/BADQACC counters on an MjData. Read it before and
 * after a step: any change means MuJoCo reset the state during that step.
 */
export const autoResetCount = (d: { warning: unknown }): number => {
  let total = 0;
  try {
    // A view onto the MjData's own array: never delete() it (see the worker's
    // collectMujocoWarnings). The elements are copies and are released.
    const stats = d.warning as WarningVec;
    const n = stats.size();
    for (const i of [MJ_WARN_BADQPOS, MJ_WARN_BADQVEL, MJ_WARN_BADQACC]) {
      if (i >= n) continue;
      const stat = stats.get(i);
      if (!stat) continue;
      total += stat.number;
      stat.delete?.();
    }
  } catch { /* diagnostics only; the clock check still stands */ }
  return total;
};

/**
 * The sentence that says what a reset on the first step threw away. Empty when
 * no initial velocities were set.
 */
export const wipedInitialVelocityNote = (joints: readonly string[]): string => {
  if (!joints.length) return '';
  const shown = joints.slice(0, 8).join(', ') + (joints.length > 8 ? ` and ${joints.length - 8} more` : '');
  return ` The reset also zeroed the initial velocities set on ${joints.length === 1 ? 'joint' : 'joints'} ${shown}, ` +
    'so nothing after it ran from the starting state the scene describes.';
};
