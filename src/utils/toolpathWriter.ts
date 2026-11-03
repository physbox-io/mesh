// The G-code a surface job writes, and where the tool is while it writes it.

import { getGridStats } from './meshLeveler';
import { StockModel, FLAT_PROFILE, type CutterProfile } from './stockModel';
import { f, type PathPoint } from './reliefPaths';
import type { ReliefCarveOptions, ToolpathSegment } from './reliefOptions';
import type { SurfaceJob } from './surfaceJob';

/*
 * Past this, a traverse flies at the safe height rather than hopping low.
 *
 * The low hop is measured against the stock model, which knows the stock
 * and nothing round it: not the clamps, not the screws, not a warped board's
 * high corner. A hop to the next run a few millimetres away stays over
 * ground the job has just cut; a flight across the job to the next pocket
 * passes whatever holds the work down, and that is what the safe height is
 * set for.
 */
const LONG_TRAVERSE_MM = 30;

/**
 * The program being written, the tool's position, and the material still
 * standing, shared by roughing and finishing so each move is measured against
 * what the moves before it really left.
 */
export class ToolpathWriter {
  readonly gcode: string[] = [];
  readonly segments: ToolpathSegment[] = [];
  /** Cutting travel in mm, rapids excluded. */
  cutDistance = 0;

  // Where the tool is, so a path can be built relative to it. The clock used to
  // be kept here as well, as distance over feedrate; it is now taken off the
  // finished program by `estimateGcodeTime`, which plans acceleration the way
  // the controller does instead of pretending every move runs at its feed.
  atX = 0;
  atY = 0;
  atZ: number;

  /*
   * What is really left standing, lowered by every cut as it is written, and
   * the cutter currently doing the cutting. Every traverse and every rapid
   * descent is measured against this rather than against where the material
   * would be once an operation finishes — see `StockModel` for why those differ
   * by up to a whole roughing layer.
   */
  readonly stock: StockModel;
  cutter: { radius: number; profile: CutterProfile } = { radius: 0.05, profile: FLAT_PROFILE };

  /**
   * How far over the highest thing in the way a traverse flies, in mm.
   *
   * Plus the levelling grid's full Z span when the program is warped to it:
   * warpGcode splits and warps cutting moves along their length but a rapid
   * only at its end point, so a traverse across a crowned sheet runs a straight
   * line under the crown - up to the grid's span below where it should be.
   */
  private readonly levellingSpanMm: number;
  private readonly traverseClearanceMm: number;
  /** The height the last `leadIn` traversed at, recorded for the preview. */
  lastTraverseZ: number;

  readonly leadInTan: number;

  private readonly opts: ReliefCarveOptions;

  constructor(opts: ReliefCarveOptions, bounds: SurfaceJob['bounds']) {
    this.opts = opts;
    this.atZ = opts.safeZ;
    // A quarter of the smaller cutter's radius: fine enough that the cells a
    // pass covers completely reach the passes either side of it at any normal
    // stepover, so the rim the model holds back is thin.
    this.stock = new StockModel(
      bounds,
      Math.min(1, Math.max(0.1, Math.min(opts.roughingToolDiaMm, opts.finishingToolDiaMm) / 8))
    );
    this.levellingSpanMm =
      opts.applyMeshLeveling && opts.meshLevelGrid ? getGridStats(opts.meshLevelGrid).spanZ : 0;
    this.traverseClearanceMm = 1.0 + this.levellingSpanMm;
    this.lastTraverseZ = opts.safeZ;
    this.leadInTan = Math.tan(
      (Math.max(0, Math.min(89, opts.leadInAngleDeg)) * Math.PI) / 180
    );
  }

  rapidTo(x: number, y: number, z: number) {
    this.atX = x; this.atY = y; this.atZ = z;
  }

  plungeTo(z: number) {
    this.stock.cut(this.atX, this.atY, this.atZ, this.atX, this.atY, z, this.cutter.radius, this.cutter.profile);
    this.atZ = z;
  }

  cutTo(x: number, y: number, z: number) {
    this.cutDistance += Math.hypot(x - this.atX, y - this.atY, z - this.atZ);
    this.stock.cut(this.atX, this.atY, this.atZ, x, y, z, this.cutter.radius, this.cutter.profile);
    this.atX = x; this.atY = y; this.atZ = z;
  }

  /**
   * Puts the cutter at the head of a pass, entering along the path rather than
   * straight down into it.
   *
   * A vertical plunge asks the centre of the tool to do the cutting, and the
   * centre of an end mill is where its edges meet at zero surface speed with
   * nowhere for a chip to go. It is the move that snaps small cutters, and the
   * deeper the layer the harder it pulls. Descending at a shallow angle along
   * the pass makes the entry an ordinary cut instead.
   *
   * On an open run the ramp runs forward to the ramp length and then back to
   * the head of the pass at full depth, so the wedge of material it left behind
   * is taken off before the pass proper starts over it. Where the run is too
   * short to ramp into — or the angle is set to zero — it plunges, which is
   * what it had to do anyway.
   *
   * A closed loop has no end to turn round at, and need not: the ramp carries
   * on forward round the loop, as many times as it takes to get down, and the
   * pass starts wherever it reached full depth and goes once round from there,
   * taking off the wedge when it comes back past the head. It used to ramp
   * out, reverse to the head and reverse again into the pass — two stops, the
   * return leg cut conventional, and the ramp's stretch cut three times.
   *
   * Returns the pass to cut from where the tool now stands: the path itself,
   * or a closed loop turned to start where the ramp ended.
   *
   * `fromHere` says the tool is already at the head of the pass, down in the
   * slot an earlier pass along the same line cut. It ramps on down from where
   * it stands: no lift, no rapid, and no reading of the stock model, which
   * cannot see that the slot is clear right out to the cutter's rim.
   *
   * `entryZ` is the height the material is expected to stand at when the pass
   * begins: the stock's top face on the first layer, the level the previous
   * layer left on every one after it. Where the stock model says more is
   * standing under the head than that, the model wins — the ramp starts from
   * the real material, and the rapid down to it stops above it.
   *
   * The traverse to the head of the pass is measured against the stock model
   * too, over the cutter's whole footprint rather than under its axis. It used
   * to be handed a function for where the material would be once the operation
   * finished, sampled along the centre line: that missed everything roughing
   * had not got down to yet, and everything a cutter's edge reaches beside its
   * axis, and a 3 mm cutter rapided through up to 1.7 mm of wood.
   */
  leadIn(
    path: PathPoint[],
    expectedEntryZ: number,
    rate: number,
    returnRate = 0,
    fromHere = false
  ): PathPoint[] {
    const head = path[0];
    const here = fromHere && Math.hypot(head.x - this.atX, head.y - this.atY) < 1e-6 && this.atZ >= head.z - 1e-6;
    let entryZ = this.atZ;
    if (here) {
      this.lastTraverseZ = this.atZ;
    } else {
      const standing = this.stock.highestUnder(head.x, head.y, this.cutter.radius, this.cutter.profile);
      entryZ = Math.min(0, Math.max(expectedEntryZ, standing));
      const approachZ = Math.min(this.opts.safeZ, entryZ + 0.5);

      /*
       * Up only as far as it takes to clear what is in the way.
       *
       * Every pass used to end with a full retract to `safeZ` and every one
       * began by flying back down — a round trip of the whole retract height
       * between two raster lines a fraction of a millimetre apart. On a typical
       * relief that is some four hundred retracts and several metres of Z rapid
       * that cut nothing.
       *
       * The height is measured rather than guessed: the stock model is swept
       * along the line the tool is about to fly, as wide as the cutter, and the
       * traverse goes a millimetre over the highest thing on it. That is exact
       * where a rule like "stay low if the next pass is close" is only usually
       * right — a wall standing between two adjacent passes is precisely the case
       * such a rule gets wrong, and the cost of being wrong is the cutter driven
       * through it at rapid. The sweep samples at half a stock cell, so nothing
       * the model holds can fall between two samples.
       */
      const highest = Math.max(
        head.z,
        this.stock.highestAlong(this.atX, this.atY, head.x, head.y, this.cutter.radius)
      );
      // The safe height clears the levelling span too: it used to cap the
      // clearance and so clipped the span straight back off it.
      const lowZ = Math.min(0, highest) + this.traverseClearanceMm;
      const safeZ = this.opts.safeZ + this.levellingSpanMm;
      const traverseZ = Math.hypot(head.x - this.atX, head.y - this.atY) > LONG_TRAVERSE_MM
        ? Math.max(safeZ, lowZ)
        : Math.min(safeZ, lowZ);

      if (traverseZ > this.atZ + 1e-6) {
        this.gcode.push(`G0 Z${f(traverseZ)}`);
        this.atZ = traverseZ;
      }
      this.gcode.push(`G0 X${f(head.x)} Y${f(head.y)}`);
      this.rapidTo(head.x, head.y, this.atZ);
      if (approachZ < this.atZ - 1e-6) {
        this.gcode.push(`G0 Z${f(approachZ)}`);
        this.atZ = approachZ;
      }
      this.lastTraverseZ = traverseZ;
    }

    const plunge = () => {
      this.plungeTo(head.z);
      this.gcode.push(`G1 Z${f(head.z)} F${Math.round(rate)}`);
      return path;
    };

    const drop = Math.max(
      entryZ - head.z,
      here && path.length > 1 ? entryZ - path[1].z : 0
    );
    if (this.leadInTan <= 0 || drop <= 1e-6) return plunge();

    let pathLen = 0;
    for (let i = 1; i < path.length; i++) {
      pathLen += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    }

    const tail = path[path.length - 1];
    if (
      path.length > 2 &&
      Math.hypot(tail.x - head.x, tail.y - head.y) < 1e-6 &&
      Math.abs(tail.z - head.z) < 1e-6
    ) {
      if (pathLen < 0.1) return plunge();
      /*
       * Forward round the loop, never below the surface and never falling
       * faster than the lead-in angle, until the cut stands on the surface at
       * a point the ground ahead of does not fall away from faster than the
       * ramp could follow - so the pass proper never starts by diving.
       */
      const n = path.length - 1; // path[n] is path[0] again
      const limit = pathLen * 20 + (2 * drop) / this.leadInTan;
      let z = entryZ;
      let k = 0;
      for (let travelled = 0; travelled <= limit; ) {
        const a = path[k];
        const b = path[k + 1];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        // Where the descent meets the surface part way along, the pass starts
        // there: the ramp is not carried on at the plunge rate to the next stop.
        const closing = seg > 1e-9 ? this.leadInTan + (b.z - a.z) / seg : 0;
        if (z > a.z + 1e-6 && closing > 1e-9 && (z - a.z) / closing < seg - 1e-6) {
          const t = (z - a.z) / closing / seg;
          const p = { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
          this.cutTo(p.x, p.y, p.z);
          this.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)} F${Math.round(rate)}`);
          return [p, ...path.slice(k + 1), ...path.slice(1, k + 1), p];
        }
        z = Math.max(b.z, z - seg * this.leadInTan);
        this.cutTo(b.x, b.y, z);
        this.gcode.push(`G1 X${f(b.x)} Y${f(b.y)} Z${f(z)} F${Math.round(rate)}`);
        travelled += seg;
        k = (k + 1) % n;
        if (z > b.z + 1e-6) continue;
        const c = path[k + 1];
        if (b.z - c.z <= Math.hypot(c.x - b.x, c.y - b.y) * this.leadInTan + 1e-6) break;
      }
      return k === 0 ? path : [...path.slice(k), ...path.slice(1, k + 1)];
    }

    // Half the run, so the ramp and its return both fit inside the pass.
    /*
     * Where the ramp does not fit at its angle, it goes back and forth along
     * the whole run instead, each leg dropping no faster than the angle allows.
     * It used to be squeezed into half the run whatever that did to the angle,
     * so a short run was a plunge with a lean to it: 16.5 mm down over 3 mm,
     * about 80 degrees, on a finishing bit with no roughing ahead of it.
     */
    const fits = drop / this.leadInTan <= pathLen / 2;
    const rampLen = fits ? drop / this.leadInTan : pathLen;
    if (rampLen < 0.1) return plunge();

    // Walk the pass until the ramp length is used up, splitting the segment it
    // ends inside. Each stop keeps the pass's own Z so the return leg can cut to
    // the real surface rather than to a straight line under it.
    const walk: { x: number; y: number; pz: number; d: number }[] = [];
    let travelled = 0;
    for (let i = 1; i < path.length && travelled < rampLen; i++) {
      const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      if (seg <= 1e-9) {
        // A straight step up or down — the foot of a wall, from
        // `squareUpWalls`. It has to stay in the walk: dropped, the return leg
        // ran straight from the top of the wall to its foot, diagonally
        // through whatever the step was there to go round.
        if (Math.abs(path[i].z - path[i - 1].z) > 1e-9) {
          walk.push({ x: path[i].x, y: path[i].y, pz: path[i].z, d: travelled });
        }
        continue;
      }
      if (travelled + seg <= rampLen) {
        walk.push({ x: path[i].x, y: path[i].y, pz: path[i].z, d: travelled + seg });
      } else {
        const t = (rampLen - travelled) / seg;
        walk.push({
          x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
          y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
          pz: path[i - 1].z + (path[i].z - path[i - 1].z) * t,
          d: rampLen,
        });
      }
      travelled += seg;
    }
    if (walk.length === 0) return plunge();

    /*
     * Down the ramp, leg by leg, never below the surface the pass is tracing
     * and never falling faster than the lead-in angle between two stops.
     *
     * The second rule is the one a fixed ramp line broke: over a bump in the
     * surface the cut rides up on it, and the line was already lower on the
     * far side, so the cut dropped back to it at whatever angle that took -
     * 60 degrees off a bump on a dome. Held to the angle from wherever the cut
     * stands, a stop can be left above the surface at the end of a leg, and
     * the next leg, back the other way, takes it down further. On ground with
     * no bump the first leg reaches the surface at its far end, exactly as
     * the fixed line did.
     */
    const stops = [{ x: head.x, y: head.y, pz: head.z, d: 0 }, ...walk];
    let hasWallStep = false;
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(stops[i].d - stops[i - 1].d) <= 1e-9) {
        hasWallStep = true;
        break;
      }
    }
    let z = entryZ;
    let at = 0;
    let forward = true;
    // How far above the surface each leg left its stops, to stop when a leg
    // gains nothing on the one before it the same way.
    const left: number[] = [];
    for (let leg = 0; leg < 1000; leg++) {
      const to = forward ? stops.length - 1 : 0;
      const step = forward ? 1 : -1;
      let above = 0;
      for (let k = at + step; forward ? k <= to : k >= to; k += step) {
        const seg = Math.abs(stops[k].d - stops[k - step].d);
        z = Math.max(stops[k].pz, z - seg * this.leadInTan);
        // The foot of a straight step down cannot be reached at an angle from
        // its top, and need not be: the pass drops down it itself, at the
        // plunge rate, as `squareUpWalls` laid it out.
        if (seg > 1e-9) above += z - stops[k].pz;
        this.cutTo(stops[k].x, stops[k].y, z);
        this.gcode.push(`G1 X${f(stops[k].x)} Y${f(stops[k].y)} Z${f(z)} F${Math.round(rate)}`);
      }
      at = to;
      forward = !forward;
      left.push(above);
      if (above <= 1e-6 || (leg >= 2 && above >= left[leg - 2] - 1e-6)) break;
    }

    // Where a ramp on a short run (`!fits`) with no wall step ends at the far
    // end of the pass at full depth, reversing the pass lets the pass itself
    // clear what the ramp rode over on the way back to the head, instead of
    // retracing back to the head and cutting the whole run a third time.
    if (!fits && !hasWallStep && at === stops.length - 1 && Math.abs(z - stops[at].pz) <= 1e-6) {
      return [...path].reverse();
    }

    /*
     * Back to the head at full depth, clearing what the ramp rode over - or,
     * where the last leg ended at the head, the pass itself does that.
     *
     * At the cutting feed, not the plunge rate. GRBL holds the last F it was
     * given, so with no F word here the whole return leg inherited the ramp's
     * plunge rate — which is chosen for driving a tool downwards and is far
     * slower than the same tool wants for an ordinary cut sideways. It is
     * stated once and then held, the same way the passes themselves do it.
     */
    let stated = false;
    for (let k = at - 1; k >= 0; k--) {
      this.cutTo(stops[k].x, stops[k].y, stops[k].pz);
      const word: string = returnRate > 0 && !stated ? ` F${Math.round(returnRate)}` : '';
      stated = stated || word !== '';
      this.gcode.push(`G1 X${f(stops[k].x)} Y${f(stops[k].y)} Z${f(stops[k].pz)}${word}`);
    }
    return path;

  }
}
