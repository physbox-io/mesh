/**
 * What the cloth's specs named that is not in them, as of the last build
 * (the worker's CLOTH_STATUS), for physics_get_state. Module state, like
 * scriptStatus.ts: nothing renders from it.
 */
let latest: string[] = [];

export function noteClothWarnings(warnings: string[]): void {
  latest = warnings;
}

export function lastClothWarnings(): string[] {
  return latest;
}
