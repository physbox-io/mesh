/**
 * What the Dims overlay is drawing, for physics_get_camera.
 *
 * The overlay works its dimensions out from the drawn scene, which the MCP
 * bridge has no other way to see; it leaves the list here each time it changes,
 * the same arrangement as liveCamera.ts. Empty whenever nothing is drawn.
 */
export interface LiveDimension {
  body: string;
  kind: 'linear' | 'diameter';
  /** Linear only: 'width' runs across the sheet, 'height' up it. */
  direction?: 'width' | 'height';
  /** Linear only: 'chain' between face edges, or 'overall'. */
  row?: 'chain' | 'overall';
  /** Diameter only: how many equal holes the label stands for. */
  count?: number;
  label: string;
  valueMm: number;
}

let live: LiveDimension[] = [];

export function setLiveDimensions(next: LiveDimension[]) {
  live = next;
}

export function getLiveDimensions(): LiveDimension[] {
  return live;
}
