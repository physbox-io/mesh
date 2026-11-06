// How much mortar a laid set of bricks takes.
//
// Each brick carries its bed, its perpend, the collar joint it shares with a
// leaf beside it, and what goes into its frog or cores. The last is what the
// joints alone leave out: they come to a third of a litre a brick, and premix
// makers say 20 to 25 bricks to the 25 kg bag, about half a litre.

import type { BrickStandard, PlacedBrick } from './brickwork';

/** Wet mortar from a 25 kg bag of premix, litres. */
export const MORTAR_BAG_LITRES = 12.5;

/** What gets dropped or scraped off. */
const WASTE = 1.1;

const SAMPLES = 5;

/** Collar joints, mm³: each brick's long sides that have a parallel brick a joint away. */
function collarJoints(bricks: PlacedBrick[], H: number, j: number): number {
  const reach = Math.max(1, ...bricks.map((b) => Math.max(b.lengthMm, b.depthMm)));
  const cellOf = (x: number) => Math.floor(x / reach);
  const key = (course: number, i: number, k: number) => `${course}:${i}:${k}`;
  const cells = new Map<string, PlacedBrick[]>();
  for (const b of bricks) {
    const at = key(b.course, cellOf(b.x), cellOf(b.y));
    const list = cells.get(at);
    if (list) list.push(b);
    else cells.set(at, [b]);
  }
  const within = (b: PlacedBrick, x: number, y: number) => {
    const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) };
    const dx = x - b.x, dy = y - b.y;
    return Math.abs(dx * u.x + dy * u.y) <= b.lengthMm / 2 && Math.abs(-dx * u.y + dy * u.x) <= b.depthMm / 2;
  };
  let mm3 = 0;
  for (const b of bricks) {
    const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) }, n = { x: -u.y, y: u.x };
    for (const side of [1, -1]) {
      let hits = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const along = b.lengthMm * ((k + 0.5) / SAMPLES - 0.5), out = side * (b.depthMm / 2 + 1.5 * j);
        const x = b.x + u.x * along + n.x * out, y = b.y + u.y * along + n.y * out;
        const i0 = cellOf(x), k0 = cellOf(y);
        search: for (let i = i0 - 1; i <= i0 + 1; i++) {
          for (let m = k0 - 1; m <= k0 + 1; m++) {
            for (const o of cells.get(key(b.course, i, m)) ?? []) {
              // Square to it is the end of a return wall: that is its perpend, counted already.
              if (o !== b && Math.abs(Math.cos(o.angle - b.angle)) > 0.9 && within(o, x, y)) { hits++; break search; }
            }
          }
        }
      }
      // Half: the brick on the other side counts the same joint.
      mm3 += (hits / SAMPLES) * b.lengthMm * H * j / 2;
    }
  }
  return mm3;
}

/** Litres of wet mortar to lay `bricks`, waste included. */
export function mortarLitresFor(bricks: PlacedBrick[], std: Pick<BrickStandard, 'heightMm' | 'frogFill'>, j: number): number {
  const H = std.heightMm, fill = std.frogFill ?? 0;
  const joints = bricks.reduce((sum, b) => sum + (b.lengthMm * j + H * j + j * j) * b.depthMm, 0);
  const frogs = bricks.reduce((sum, b) => sum + b.lengthMm * b.depthMm * H * fill, 0);
  return (joints + frogs + collarJoints(bricks, H, j)) * WASTE / 1e6;
}
