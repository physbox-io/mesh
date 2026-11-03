// One roughing layer cleared adaptively: each pocket's contours walked inward,
// at the depth and feed each ring's real engagement earns.

import {
  clearingRings,
  feedForEngagement,
  stepdownForEngagement,
  type ClearingRegion,
} from './adaptiveClearing';
import { f, roughSimplifyMm, simplifyPass, startLoopAt, type PathPoint } from './reliefPaths';
import type { ReliefCarveOptions } from './reliefOptions';
import type { ToolpathWriter } from './toolpathWriter';

/** The roughing pass's settings and grid, as every layer of it shares them. */
export interface RoughingLayout {
  opts: ReliefCarveOptions;
  /** Pitch the surface was sampled at, mm. */
  res: number;
  allowance: number;
  roughRad: number;
  roughStepover: number;
  baseStepdown: number;
  minRoughCut: number;
  /** Where the tool's centre may sit at a given layer, as a grid. */
  layerRegion: (layerTop: number) => ClearingRegion;
  /** Where a slab's cut runs at a point. */
  slabZ: (x: number, y: number, floorZ: number, topZ: number) => number;
  /** A point held inside the window the roughing tool's centre may occupy. */
  safeX: (x: number) => number;
  safeY: (y: number) => number;
}

/** Whether a point lies inside a closed loop (even-odd). */
const insideLoop = (pt: { x: number; y: number }, loop: { x: number; y: number }[]) => {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/** A closed loop turned to start at the vertex nearest a point. */
const startNearest = <T extends { x: number; y: number }>(loop: T[], x: number, y: number): T[] => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i].x - x) ** 2 + (loop[i].y - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best === 0 ? loop : [...loop.slice(best), ...loop.slice(0, best)];
};

/** Squared distance from a point to a loop's nearest vertex. */
const loopDistance = (loop: { x: number; y: number }[], x: number, y: number) => {
  let best = Infinity;
  for (const p of loop) best = Math.min(best, (p.x - x) ** 2 + (p.y - y) ** 2);
  return best;
};

/**
 * One slab cleared by walking each pocket's contours inward.
 *
 * Pocket by pocket, nearest first. The rings used to go out ring-major across
 * the whole stock - the outermost ring of every pocket, then the next ring of
 * every pocket - in the order marching squares happened to find them, which
 * is row by row. On a relief with a dozen separate deep spots that is a rapid
 * across the work between every ring of every one of them. Now each ring is
 * hung under the ring outside it that contains it, every pocket is taken
 * from its outer ring to its last before the tool leaves it, and the next
 * pocket is whichever is closest to where the tool stands.
 */
export function emitAdaptiveLayer(w: ToolpathWriter, layout: RoughingLayout, layerZ: number, layerTop: number): void {
  const { opts, res, allowance, roughRad, roughStepover, baseStepdown, minRoughCut, layerRegion, slabZ, safeX, safeY } = layout;
  const rings = clearingRings(layerRegion(layerTop), roughStepover, opts.roughingToolDiaMm);

  interface RingLoop {
    loop: { x: number; y: number }[];
    ring: (typeof rings)[number];
    island: boolean;
    children: RingLoop[];
  }
  const roots: RingLoop[] = [];
  let previous: RingLoop[] = [];
  for (const ring of rings) {
    const current: RingLoop[] = [];
    ring.loops.forEach((loop, i) => {
      if (loop.length < 2) return;
      const island = ring.islands[i];
      const node: RingLoop = { loop, ring, island, children: [] };
      // A ring inset from a pocket's outer boundary lies inside the ring
      // before it. One round an island grows outward instead, so it lies
      // round the island ring before it, and is hung under that one: it
      // must not be cut until the ring between it and the island is. One
      // with neither is a pocket of its own.
      const parent = island
        ? previous.find((p) => p.island && insideLoop(p.loop[0], loop))
        : previous.find((p) => !p.island && insideLoop(loop[0], p.loop));
      (parent ? parent.children : roots).push(node);
      current.push(node);
    });
    previous = current;
  }

  const emitLoop = (node: RingLoop) => {
    const { ring } = node;

    // Marching squares puts a vertex on every grid cell the contour
    // crosses, so a ring round a 200 mm region arrives as a couple of
    // thousand moves of a third of a millimetre each. GRBL swallows a few
    // hundred lines a second, and a job that streams slower than it cuts
    // stalls the spindle in the cut — the same reason the finishing
    // raster is thinned, and far more pressing here, since a roughing
    // ring is mostly long gentle curves that a handful of points describe
    // to well inside the machine's own resolution.
    //
    // Each point sits on the surface where that stands above the slab's
    // floor, so the simplifier holds the height as well as the plan shape.
    // Smooth Z across adjacent marching-squares staircase vertices so a
    // ring on a 45-degree slope does not bob up and down in Z on every
    // grid cell while keeping its full XY radius on convex islands.
    const loop = startNearest(node.loop, w.atX, w.atY);
    const rawSurface = loop.map((p) => {
      const x = safeX(p.x);
      const y = safeY(p.y);
      return { x, y, z: slabZ(x, y, layerZ, layerTop) };
    });
    const maxStairSeg = res * 1.8;
    const onSurface = rawSurface.map((p, idx) => {
      if (allowance <= 0) return p;
      const prev = rawSurface[(idx + rawSurface.length - 1) % rawSurface.length];
      const next = rawSurface[(idx + 1) % rawSurface.length];
      const dPrev = Math.hypot(p.x - prev.x, p.y - prev.y);
      const dNext = Math.hypot(next.x - p.x, next.y - p.y);
      if (dPrev <= maxStairSeg && dNext <= maxStairSeg) {
        const sz = 0.25 * prev.z + 0.5 * p.z + 0.25 * next.z;
        if (Math.abs(sz - p.z) <= allowance * 0.5) {
          return { x: p.x, y: p.y, z: Math.min(layerTop, Math.max(layerZ, sz)) };
        }
      }
      return p;
    });

    /*
     * What this ring will really be cutting, read off the stock model
     * before it is cut, rather than what the ring's place in the order
     * promises.
     *
     * The promise is that every ring after the first has open air on its
     * outer side, which is what buys the boosted depth and feed. That holds
     * in a flat-bottomed pocket. Here each ring follows the surface down to
     * the slab's floor, so on a slope the ring inside sits lower than the
     * ring outside it, and the material between the two heights is solid
     * on both sides of the cutter: a full-width slot. On a 100 mm dome that
     * was a 4.8 mm slot in one bite at 115% of the roughing feed, on every
     * ring down every flank.
     *
     * So each flank is read most of the way out to the cutter's rim, and
     * the lower of the two is how deep the slot is. The ring's depth is
     * measured the same way - from the highest material under it, not from
     * the top of the slab - so a ring riding high on a slope is not cut
     * three times over in the air at three bite heights that all clamp to
     * the same surface.
     */
    const plan = simplifyPass([...onSurface, onSurface[0]], roughSimplifyMm(allowance, res));
    if (plan.length < 2) return;

    // Along the path as it will be cut, every half cell or so, each flank
    // read square to the move.
    const flank = roughRad * 0.8;
    const flankRad = roughRad * 0.2;
    const coreRad = Math.max(0, roughRad - w.stock.cell * 1.5);
    let slot = 0;
    let standing = -Infinity;
    let bottom = Infinity;
    for (let i = 1; i < plan.length; i++) {
      const a = plan[i - 1];
      const b = plan[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = len > 1e-9 ? -(b.y - a.y) / len : 0;
      const ny = len > 1e-9 ? (b.x - a.x) / len : 0;
      const steps = Math.max(1, Math.ceil(len / (w.stock.cell / 2)));
      for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const z = a.z + (b.z - a.z) * t;
        standing = Math.max(standing, w.stock.highestUnder(x, y, coreRad));
        bottom = Math.min(bottom, z);
        if (len <= 1e-9) continue;
        const left = w.stock.highestUnder(x + nx * flank, y + ny * flank, flankRad);
        const right = w.stock.highestUnder(x - nx * flank, y - ny * flank, flankRad);
        slot = Math.max(slot, Math.min(left, right) - z);
      }
    }
    const ringTop = Math.min(layerTop, standing);
    const span = ringTop - bottom;
    // Nothing left standing in this ring's way: the rings outside it took
    // it all.
    if (!(span > Math.max(1e-3, minRoughCut))) return;

    const slotting = slot > Math.max(0.1, baseStepdown * 0.1);
    // A slot is fed for the chip it is actually taking rather than the one
    // the stepover implies.
    const feed = feedForEngagement(opts.roughingFeedrate, slotting ? 1 : ring.engagement);

    /*
     * ...and cut at the depth its engagement earns, not the layer's.
     *
     * The layer stepdown is boosted well past the baseline — with a 6.35 mm
     * cutter at a 20% stepover, `(0.45/0.2)^1.5` is a 3.4x gain — and that
     * boost is bought entirely by the small radial bite. The first ring of
     * a slab does not have one, and nor does a ring stepping down a slope.
     *
     * Bites are equal slices of the ring's own depth. Where the slot is no
     * deeper than the full-width stepdown, no bite can slot deeper than the
     * slot itself, so the boosted depth stands; where it is deeper, every
     * bite is held to the full-width stepdown.
     */
    const effectiveEngagement =
      slot > baseStepdown + 1e-6
        ? Math.max(ring.engagement, Math.min(1, slot / Math.max(0.1, baseStepdown)))
        : ring.engagement;
    const ringStep = stepdownForEngagement(opts.roughingToolDiaMm, effectiveEngagement, baseStepdown);
    const bites = Math.max(1, Math.ceil((span - 1e-6) / ringStep));

    for (let bite = 1; bite <= bites; bite++) {
      const biteFloor = bite === bites ? layerZ : ringTop - (span * bite) / bites;
      const above = ringTop - (span * (bite - 1)) / bites;
      let loop = plan.map((p) => ({ ...p, z: Math.max(biteFloor, p.z) }));
      /*
       * Every bite after the first starts where the one before it ended,
       * which is on this same ring, in the slot it has just cut: the ring
       * is turned to start there and the tool ramps on down. It used to
       * lift out to wherever the stock model's rim of uncounted cells put
       * the material - the stock's face, on the first layer - and ramp the
       * whole way back down through the slot.
       */
      let turned = bite > 1 ? startLoopAt(loop, w.atX, w.atY) : null;
      const prePath: PathPoint[] = [];
      if (turned) {
        loop = turned;
        if (loop[0].z >= w.atZ - 1e-6 && loop.some((p) => p.z < w.atZ - 1e-6)) {
          let m = 0;
          while (m + 1 < loop.length - 1 && loop[m + 1].z >= w.atZ - 1e-6) m++;
          let preFeedStated = false;
          for (let i = 1; i <= m; i++) {
            const z = Math.abs(loop[i].z - w.atZ) > 1e-6 ? ` Z${f(loop[i].z)}` : '';
            w.cutTo(loop[i].x, loop[i].y, loop[i].z);
            w.gcode.push(`G1 X${f(loop[i].x)} Y${f(loop[i].y)}${z}${preFeedStated ? '' : ` F${Math.round(feed)}`}`);
            preFeedStated = true;
            prePath.push(loop[i]);
          }
          if (m > 0) {
            loop = [...loop.slice(m, loop.length - 1), ...loop.slice(0, m), loop[m]];
          }
        }
      } else if (
        bite === 1 &&
        bites === 1 &&
        ring.engagement < 1 &&
        Math.hypot(loop[0].x - w.atX, loop[0].y - w.atY) <= roughStepover * 2.5 &&
        w.atZ <= layerTop + 1e-6
      ) {
        // An inner ring of a pocket whose outer ring has just been cleared:
        // step tangentially onto a point a few stepovers ahead along the
        // ring instead of lifting out, rapiding 0.8 mm and ramping back down
        // through air on every stepover ring.
        let linkIdx = -1;
        let walked = 0;
        for (let i = 1; i < loop.length - 1; i++) {
          walked += Math.hypot(loop[i].x - loop[i - 1].x, loop[i].y - loop[i - 1].y);
          if (walked < roughStepover * 1.5) continue;
          if (walked > roughStepover * 5) break;
          const target = loop[i];
          const d = Math.hypot(target.x - w.atX, target.y - w.atY);
          if (d < roughStepover * 1.2 || d > roughStepover * 4.5) continue;
          if (target.z > w.atZ + 1e-6) continue;
          if (w.atZ - target.z > 1e-6 && (w.leadInTan <= 0 || (w.atZ - target.z) / d > w.leadInTan)) continue;
          const ux = (target.x - w.atX) / d;
          const uy = (target.y - w.atY) / d;
          const steps = Math.max(1, Math.ceil(d / (w.stock.cell / 2)));
          let linkSlot = 0;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const px = w.atX + (target.x - w.atX) * t;
            const py = w.atY + (target.y - w.atY) * t;
            const pz = w.atZ + (target.z - w.atZ) * t;
            const left = w.stock.highestUnder(px - uy * flank, py + ux * flank, flankRad);
            const right = w.stock.highestUnder(px + uy * flank, py - ux * flank, flankRad);
            linkSlot = Math.max(linkSlot, Math.min(left, right) - pz);
          }
          if (linkSlot <= Math.max(0.1, baseStepdown * 0.1)) {
            linkIdx = i;
            break;
          }
        }
        if (linkIdx > 0) {
          const entry = loop[linkIdx];
          const linkFeed = entry.z < w.atZ - 1e-6 ? opts.roughingPlungeRate : feed;
          const z = Math.abs(entry.z - w.atZ) > 1e-6 ? ` Z${f(entry.z)}` : '';
          prePath.push({ x: w.atX, y: w.atY, z: w.atZ });
          w.cutTo(entry.x, entry.y, entry.z);
          w.gcode.push(`G1 X${f(entry.x)} Y${f(entry.y)}${z} F${Math.round(linkFeed)}`);
          w.lastTraverseZ = w.atZ;
          loop = [...loop.slice(linkIdx, loop.length - 1), ...loop.slice(0, linkIdx), entry];
          turned = loop;
        }
      }

      // Ramp in along the ring rather than plunging: the centre of an end
      // mill cuts at zero surface speed, and a deep layer pulls hard on it.
      const path =
        turned !== null && Math.hypot(loop[0].x - w.atX, loop[0].y - w.atY) < 1e-6 && Math.abs(loop[0].z - w.atZ) < 1e-6
          ? loop
          : w.leadIn(loop, above, opts.roughingPlungeRate, feed, turned !== null);

      let lastZ = w.atZ;
      let passFeedStated = false;
      for (let i = 1; i < path.length; i++) {
        w.cutTo(path[i].x, path[i].y, path[i].z);
        const z = Math.abs(path[i].z - lastZ) > 1e-6 ? ` Z${f(path[i].z)}` : '';
        lastZ = path[i].z;
        w.gcode.push(`G1 X${f(path[i].x)} Y${f(path[i].y)}${z}${passFeedStated ? '' : ` F${Math.round(feed)}`}`);
        passFeedStated = true;
      }

      // No retract here: the next `leadIn` lifts only as far as it needs
      // to clear what stands between this ring and the one inside it, and
      // the final retract at the end of the program covers the last one.
      w.segments.push({
        type: 'roughing',
        points: prePath.length > 0 ? [...prePath, ...path] : path,
        traverseZ: w.lastTraverseZ,
      });
    }
  };

  // Depth first through each pocket, the nearest unvisited one next. On an
  // explicit stack: a big pocket nests a ring per stepover, and recursing
  // once a ring overflowed the call stack on a part a few metres across.
  const emitPocket = (root: RingLoop) => {
    emitLoop(root);
    const stack = [[...root.children]];
    while (stack.length > 0) {
      const pending = stack[stack.length - 1];
      if (pending.length === 0) {
        stack.pop();
        continue;
      }
      let best = 0;
      for (let i = 1; i < pending.length; i++) {
        if (loopDistance(pending[i].loop, w.atX, w.atY) < loopDistance(pending[best].loop, w.atX, w.atY)) best = i;
      }
      const node = pending.splice(best, 1)[0];
      emitLoop(node);
      stack.push([...node.children]);
    }
  };
  const pockets = [...roots];
  while (pockets.length > 0) {
    let best = 0;
    for (let i = 1; i < pockets.length; i++) {
      if (loopDistance(pockets[i].loop, w.atX, w.atY) < loopDistance(pockets[best].loop, w.atX, w.atY)) best = i;
    }
    emitPocket(pockets.splice(best, 1)[0]);
  }
}
