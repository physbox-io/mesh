/**
 * Which meshes print as one piece, judged by their footprints on the bed.
 *
 * A slicer drops each object onto the bed on its own, so meshes keep their
 * places relative to each other only when their footprints overlap: a liner
 * nested in its shell is one piece, the two halves of a mold laid side by
 * side are two. The 3MF writer groups its objects this way, and the export
 * size prompt measures "the longest part" over the same groups, so the size it
 * offers is the size of something that actually comes off the printer.
 */

export interface Box {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}

export interface FootprintOptions {
  /** The two axes that lie on the bed: [0, 1] for Z-up, [0, 2] for Y-up. */
  axes: readonly [number, number];
  /** Footprints must overlap by more than this, in the boxes' units; boxes that only touch stay apart. */
  minOverlap: number;
  /** Groups of indices that are one piece whatever their footprints. */
  joined?: Iterable<readonly number[]>;
}

/**
 * The group of each box, as the lowest index in its group, so a group keeps its
 * first member's place and name. Overlap is transitive: two boxes clear of each
 * other are one group when a third overlaps both.
 */
export function footprintGroups(boxes: readonly Box[], options: FootprintOptions): number[] {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const group of options.joined ?? []) {
    for (let i = 1; i < group.length; i++) join(group[0], group[i]);
  }
  const overlaps = (a: number, b: number, k: number) =>
    Math.min(boxes[a].max[k], boxes[b].max[k]) - Math.max(boxes[a].min[k], boxes[b].min[k]) > options.minOverlap;
  const [u, v] = options.axes;
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      if (overlaps(a, b, u) && overlaps(a, b, v)) join(a, b);
    }
  }
  return boxes.map((_, i) => find(i));
}
