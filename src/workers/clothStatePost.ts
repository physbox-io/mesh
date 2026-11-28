/**
 * How the physics worker hands the cloth's whole state to the main thread,
 * which keeps it only to seed a worker that replaces this one. It is up to
 * 735 KB, so a frame carries it about once a second (and only once the cloth
 * has moved), its buffers transferred rather than cloned; a planned recycle
 * asks for the current one (GET_CLOTH_STATE).
 */

import type { ClothStateSnapshot } from './physicsWorkerProtocol';

/** Wall-clock ms between the cloth states frames carry. */
export const CLOTH_STATE_EVERY_MS = 1000;

/** A cloth state's buffers, to hand over: `state()` makes fresh copies, so nothing is left sharing them. */
export const clothStateTransfer = (s: ClothStateSnapshot): Transferable[] =>
  [s.x, s.v, s.floatUntil, s.boardsQ, s.stitchSew, s.stitchGap, s.stitchOn, s.stitchClose]
    .filter((a): a is NonNullable<typeof a> => !!a && a.byteLength > 0)
    .map((a) => a.buffer as ArrayBuffer);

/** Whether this frame should carry the cloth's state: `now` wall-clock ms, `simTime` the cloth's own time. */
export function clothStateThrottle(everyMs = CLOTH_STATE_EVERY_MS) {
  let last = -Infinity, lastTime = NaN;
  return (now: number, simTime: number): boolean => {
    if (now - last < everyMs || simTime === lastTime) return false;
    last = now; lastTime = simTime;
    return true;
  };
}
