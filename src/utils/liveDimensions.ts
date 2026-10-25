/**
 * What the Dims overlay is drawing, for physics_get_camera.
 *
 * The overlay works its dimensions out from the drawn scene, which the MCP
 * bridge has no other way to see; it leaves the list here each time it changes,
 * the same arrangement as liveCamera.ts. Empty whenever nothing is drawn.
 */
export interface LiveDimension {
  body: string;
  /**
   * 'linear', 'diameter' and 'radius' are the part's own sizes, along its own axes;
   * 'angle' is how far it is turned in the view; 'location' is where its
   * origin sits from its parent's.
   */
  kind: 'linear' | 'diameter' | 'radius' | 'angle' | 'location';
  /** Linear: 'width' runs across the part, 'height' up it. Location: across the sheet or up it. */
  direction?: 'width' | 'height';
  /** Linear only: 'chain' between face edges, or 'overall'. */
  row?: 'chain' | 'overall';
  /**
   * Diameter and radius: how many equal holes or arcs the label stands for.
   * Linear: how many equal steps a chain link "3× 42" stands for (valueMm is one).
   */
  count?: number;
  /**
   * Other bodies with this same figure at the same place on the sheet (two
   * walls whose faces line up): drawn, and listed, once.
   */
  sharedWith?: string[];
  /** Location only: the body it is measured from, or 'origin'. */
  from?: string;
  label: string;
  /** Every kind but angle. */
  valueMm?: number;
  /** Angle only. */
  valueDeg?: number;
}

let live: LiveDimension[] = [];

export function setLiveDimensions(next: LiveDimension[]) {
  live = next;
}

export function getLiveDimensions(): LiveDimension[] {
  return live;
}
