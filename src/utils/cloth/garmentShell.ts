/**
 * A garment modelled in 3D on a body form, every kind the same way: the
 * surface standing off the parts of the form it covers by the garment's
 * ease (formSdf: distance to the form; surfaceNets: the surface at that
 * distance), then cut open (neckline, hems, cuffs, waistband, armholes) and
 * cut up at its seams into panels, which garmentFlatten lays flat.
 *
 * What to cover, how far off, where to cut and where to seam all come as
 * data (garmentPlan): this reads it and knows no kind of garment. Round the
 * legs, a little ease follows each leg (trousers) and a lot joins them (a
 * skirt); growing toward the hem it flares; under the arm, a batwing; round
 * a foot, a sock; round the head, a hat.
 *
 * Z-up, metres, in the form's frame; +x the wearer's left, -y the front.
 */

import type { BodyFormMeasurements, GarmentDraft, GarmentPlane } from '../../types/cloth';
import { bodyFormGeoms, bodyFormSection, bodyLandmarks, formSkin } from './bodyForm';
import { formLimbs, type FormLimb, type LimbName, type LimbSectionAt } from './formLimbs';
import type { LimbPath } from './limbPath';
import { gridOver, meshSdfWithin, sampleGrid } from './formSdf';
import { CLOTH_MATERIALS } from './clothMesh';
import { garmentSettings } from './garments';
import { ontoField, surfaceNet } from './surfaceNets';
import { coarsenSurface, curvatureSize } from './surfaceCoarsen';
import { boundaryLoops, clipSurface, refineNear, collapseShortBoundaryEdges, compact, healFlatTriangles, splitAlong, splitPanels } from './garmentSurface';
import { dartSlit } from './garmentDarts';
import { profileAt, turnRound } from './edgeProfile';
import { sculptDabs, sculptField } from './garmentSculpt';
import { sculptDarts } from './sculptDarts';
import { curveSlit, draftLines, surfaceCurve, trimOvershoot } from './garmentCurves';
import type { GarmentCurve } from '../../types/cloth';
import type { EdgeProfile } from '../../types/cloth';

/** The most a profile lengthens its edge anywhere (none below 0). */
const profileMax = (pr?: EdgeProfile) => (pr ? Math.max(0, ...pr.points.map((q) => q[1] ?? 0)) : 0);
import { garmentPlan, restOff, type GarmentCut, type Part, type PartCover } from './garmentPlan';

export { boundaryLoops, splitPanels } from './garmentSurface';

export interface GarmentShell {
  /** Points of the fabric's middle surface. */
  points: number[][];
  /** Triangles, wound so their normals face away from the body. */
  tris: number[];
  /** Seams: chains of point indices, each run along the edges between them. `open`: cut and left open (a jacket's front), not sewn. */
  seams: { name: string; path: number[]; open?: boolean }[];
  /** Lines only marked on it (a drawn curve of kind `line`): named runs of its points, nothing cut along them. */
  marks?: { name: string; path: number[] }[];
  /** The surface split along its seams: each panel's triangles (indices into tris / 3) and the 3D direction that runs up (+v) its flat piece. */
  panels: { name: string; tris: number[]; upAxis?: number[] }[];
  /** Its open edges, each run named for the cut that made it: neckline, hem, waist, cuffL, armholeL, opening, top, end. */
  edges: { name: string; path: number[] }[];
  /** The same points as the garment is cut, where that differs from how it is modelled. What it is flattened from. */
  cut?: number[][];
  /** Round the form under each point, metres: what the garment's ease is added to there. */
  girth?: number[];
  /** The part of the form each point is nearest: skin, armL, legR, webL, ... */
  part?: string[];
  /** How far each point was let down from where it was cut to hang on the form, metres (garmentShell's hang). */
  hang?: number[];
}

/** The grid's spacing at most: about the size of a triangle of a garment round the body. */
const H_MAX = 0.025;
/** And at least, round the thinnest limb (a foot, a hand). */
const H_MIN = 0.0075;
/** How near the floor (the form stands on z = 0) cloth lies. */
const FLOOR = 0.006;
/** Over this, where parts' distances are within it of each other, their ease blends (an armpit). */
const BLEND = 0.02;
/** Past this a part's ease no longer blends with a nearer one's (its weight under 1e-3). */
const BLEND_REACH = 7 * BLEND;
/**
 * Cloth spans a hollow in the form (between two muscles, the small of the
 * back, the crook of an arm) unless it can stretch down into it: the widest
 * ball whose dip a woven cloth spans, metres. A fabric with give follows the
 * form further in, by its give over HUG_GIVE (spandex at 60% follows it all).
 */
const BRIDGE = 0.04;
const HUG_GIVE = 0.4;

export function garmentShell(draft: GarmentDraft, form: BodyFormMeasurements, layer = 0): GarmentShell {
  const plan = garmentPlan(draft, form, layer);
  const L = bodyLandmarks(form);
  const rawLimbs = formLimbs(form);
  const covers = new Map<Part, PartCover>(plan.covers.map((c) => [c.part, c]));
  const limbs = { ...rawLimbs };
  for (const c of plan.covers) {
    if (c.part === 'skin' || c.part === 'webL' || c.part === 'webR') continue;
    const l = rawLimbs[c.part];
    if (l.path.joints.some((j) => j.bend > 0)) {
      limbs[c.part] = { ...l, path: l.path.refillet(l.path.joints.map((j) => { const sec = l.section(j.at); return Math.max(sec.w, sec.h) + c.off + H_MAX; })) };
    }
  }
  // The plan measures along the form's own limbs; carry its distances onto
  // the rounder lines the shell follows (past a bent elbow the two differ by
  // a centimetre or more, and a sleeve ended short of its length).
  const onShellLimb = (limb: LimbName, sAlong: number) => (limbs[limb] === rawLimbs[limb] ? sAlong : limbs[limb].path.closest(rawLimbs[limb].path.at(sAlong), limbs[limb].length + 0.2).s);
  for (const c of plan.cuts) if (c.kind === 'limbEnd' || c.kind === 'limbStart') c.s = onShellLimb(c.limb, c.s);
  for (const sm of plan.seams) if (sm.kind === 'limbRing') sm.s = onShellLimb(sm.limb, sm.s);
  for (const c of plan.covers) {
    if (c.taper && c.part !== 'skin' && c.part !== 'webL' && c.part !== 'webR') c.taper.len = onShellLimb(c.part, c.taper.len);
  }
  const parts = plan.covers.map((c) => c.part);
  const limbOf = (part: Part): FormLimb | null => (part === 'skin' || part === 'webL' || part === 'webR' ? null : limbs[part]);
  const alongLimb = (part: Part, p: number[]) => { const limb = limbOf(part); return limb ? limb.path.closest(p, limb.length + 0.2).s : 0; };
  // The grid fine enough that the thinnest limb the garment covers, stood off
  // by its ease, is a few cells across: at a body's spacing a foot was a cell
  // across, and a sock came out a centimetre inside it.
  let across = Infinity;
  for (const c of plan.covers) {
    const limb = limbOf(c.part);
    if (!limb) continue;
    let s0 = 0, s1 = limb.length, zMin = -Infinity;
    for (const ct of plan.cuts) {
      if (ct.kind === 'limbStart' && ct.limb === limb.name) s0 = Math.max(s0, ct.s - profileMax(ct.profile));
      if (ct.kind === 'limbEnd' && ct.limb === limb.name) s1 = Math.min(s1, ct.s);
      if (ct.kind === 'hem' && ct.on.includes(c.part)) zMin = Math.max(zMin, ct.z - ct.train - profileMax(ct.profile));
    }
    for (let k = 0; k <= 24; k++) {
      const sec = limb.section(s0 + ((s1 - s0) * k) / 24);
      if (sec.c[2] < zMin) continue;
      across = Math.min(across, Math.min(sec.w, sec.h) + c.off);
    }
    across = Math.min(across, Math.max(0.02, s1 - s0));
  }
  let H = Math.min(H_MAX, Math.max(H_MIN, across / 2));
  // The silhouette as sculpted: stand-off added round points, any shape.
  const sculpt = sculptField(draft.sculpt);
  const sculptReach = 1.25 * sculpt.most;


  // The middle of the body front to back at a height, to a tenth of a
  // millimetre: asked of every cell of the grid, and a section is slow.
  const centres = new Map<number, number>();
  const centreY = (z: number) => {
    const key = Math.round(Math.min(L.hpsZ, Math.max(L.hipZ, z)) * 1e4);
    let cy = centres.get(key);
    if (cy === undefined) { cy = bodyFormSection(form, key / 1e4).centreY; centres.set(key, cy); }
    return cy;
  };

  // ---- How far off each part, at a point.
  const flareAt = (c: PartCover, z: number) => (c.flare ? c.flare.add * Math.max(0, (c.flare.z0 - z) / Math.max(1e-3, c.flare.z0 - c.flare.z1)) : 0);
  const partOff = (c: PartCover, p: number[], flare = true): number => {
    let v = c.off + (flare ? flareAt(c, p[2]) : 0);
    if (c.snug) {
      const dz = Math.max(0, c.snug.z - p[2]);
      const cy = c.snug.r !== undefined ? centreY(p[2]) : 0;
      const dr = c.snug.r !== undefined ? Math.max(0, Math.hypot(p[0], p[1] - cy) - c.snug.r) : 0;
      const u = Math.min(1, Math.hypot(dz, dr) / c.snug.over);
      const t = u * u * (3 - 2 * u);
      v = c.snug.off + (v - c.snug.off) * t;
    }
    // Full at the root, easing to the end.
    if (c.taper) v += (c.taper.end - c.off) * Math.min(1, alongLimb(c.part, p) / c.taper.len);
    return v;
  };

  // ---- The parts' surfaces, as signed distance on a grid round what it covers.
  const meshes: Record<string, { points: number[][]; tris: number[] }> = {};
  for (const g of bodyFormGeoms(form, 'form')) {
    if (g.type !== 'mesh' || !g.vertices || !g.faces) continue;
    const raw = g.name.replace(/^form_/, ''), name = raw === 'headSkin' ? 'head' : raw;
    const pts: number[][] = [];
    for (let i = 0; i < g.vertices.length; i += 3) pts.push([g.vertices[i], -g.vertices[i + 2], g.vertices[i + 1]]);
    meshes[name] = { points: pts, tris: Array.from(g.faces) };
  }
  const skin = covers.get('skin');
  if (skin) meshes.skin = formSkin(form, skin.skin?.hangFrom, skin.skin?.downTo);
  for (const c of plan.covers) if (c.web) meshes[c.part] = webSheet(limbs[c.web.limb], c.web.along, c.web.depth, (z) => { const sec = bodyFormSection(form, z); return [Math.sign(limbs[c.web!.limb].path.at(0)[0]) * sec.radii[limbs[c.web!.limb].path.at(0)[0] > 0 ? 0 : sec.radii.length / 2], sec.centreY, z]; });
  // Each part's box: the part, out as far as the cloth stands off it (more
  // at a flared hem, less above it) and its ease blends with its
  // neighbours'; down to the lowest cut that ends it (what lies on the floor
  // included). The grid is the boxes together.
  const lowestOn = (part: Part) => plan.cuts.reduce((z, c) => (c.kind === 'hem' && (!c.on || c.on.includes(part)) ? Math.min(z, c.z - c.train - profileMax(c.profile)) : z), Infinity);
  let reach = 0;
  const boxes = new Map<Part, { lo: number[]; hi: number[] }>();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of plan.covers) {
    const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
    for (const p of meshes[c.part].points) for (let a = 0; a < 3; a++) { bl[a] = Math.min(bl[a], p[a]); bh[a] = Math.max(bh[a], p[a]); }
    const hem = lowestOn(c.part), base = Math.max(c.off, c.snug?.off ?? 0) + (c.taper ? Math.max(0, c.taper.end - c.off) : 0) + sculptReach;
    const down = base + flareAt(c, Math.min(hem, bl[2])) + 3 * H, up = base + flareAt(c, bh[2]) + 3 * H;
    reach = Math.max(reach, down);
    // Every part whole inside its box: inside and out are told by flooding in
    // from its edge, and a part cut off by the edge let the flood inside it
    // (a second surface grew inside the body).
    const box = {
      lo: [bl[0] - down - BLEND_REACH, bl[1] - down - BLEND_REACH, Math.min(bl[2] - 3 * H, Math.max(bl[2] - down - BLEND_REACH, hem < Infinity ? hem - 2 * H : -Infinity))],
      hi: [bh[0] + down + BLEND_REACH, bh[1] + down + BLEND_REACH, bh[2] + up + BLEND_REACH],
    };
    boxes.set(c.part, box);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], box.lo[a]); hi[a] = Math.max(hi[a], box.hi[a]); }
  }
  // Symmetric about the middle, as the form is.
  const halfX = Math.max(-lo[0], hi[0]);
  lo[0] = -halfX; hi[0] = halfX;
  // Bound total voxel count on full-span flared/trained garments (e.g. ballgown)
  // while keeping wrists/cuffs several cells across.
  const gridVol = Math.max(0, (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]));
  if (gridVol > 1_800_000 * H * H * H) H = Math.min(H_MAX, Math.cbrt(gridVol / 1_800_000));
  const grid = gridOver(lo, hi, H);
  const sdf = new Map<Part, Float32Array>();
  // Each part as the cloth meets it: its hollows spanned as far as the fabric
  // cannot stretch into them. Part by part, so the gap between an arm and the
  // side it hangs by stays open.
  const bridge = BRIDGE * Math.max(0, 1 - CLOTH_MATERIALS[garmentSettings(draft).material ?? 'jersey'].give / HUG_GIVE);
  for (const part of parts) sdf.set(part, meshSdfWithin(grid, meshes[part].points, meshes[part].tris, boxes.get(part)!.lo, boxes.get(part)!.hi, bridge));

  // ---- Which part a point is nearest.
  const nearest = (p: number[]) => {
    let best: Part = parts[0], bd = Infinity;
    for (const part of parts) { const v = sampleGrid(grid, sdf.get(part)!, p); if (v < bd) { bd = v; best = part; } }
    return best;
  };
  const on = (list: Part[] | undefined, p: number[]) => !list || list.includes(nearest(p));

  // ---- Where a point over a posed leg would be with that leg hung straight
  // from the hip (FormLimb.straight): the same distance along it, the same
  // offset round it. The plan's heights and planes (a hem, the side seams'
  // front and back) are drawn on the form standing, so a trouser leg is cut
  // as it hangs and worn as the leg is posed; anywhere else, the point itself.
  const posedLegs = new Map<Part, FormLimb>();
  for (const part of parts) { const l = part === 'skin' || part === 'webL' || part === 'webR' ? undefined : rawLimbs[part]; if (l?.straight && l.straight !== l.path) posedLegs.set(part, l); }
  const frameAt = (path: LimbPath, s: number) => {
    const t = path.tangent(s), k = t[0], side = [1 - k * t[0], -k * t[1], -k * t[2]], l = Math.hypot(side[0], side[1], side[2]) || 1;
    const sd = side.map((v) => v / l);
    return { t, sd, up: [t[1] * sd[2] - t[2] * sd[1], t[2] * sd[0] - t[0] * sd[2], t[0] * sd[1] - t[1] * sd[0]] };
  };
  const straightOn = (l: FormLimb, p: number[]) => {
    const cl = l.path.closest(p, l.length + 0.2), a = frameAt(l.path, cl.s), b = frameAt(l.straight!, cl.s), c = l.straight!.at(cl.s);
    const v = [p[0] - cl.p[0], p[1] - cl.p[1], p[2] - cl.p[2]];
    const u = [a.sd, a.up, a.t].map((e) => e[0] * v[0] + e[1] * v[1] + e[2] * v[2]);
    return [0, 1, 2].map((q) => c[q] + b.sd[q] * u[0] + b.up[q] * u[1] + b.t[q] * u[2]);
  };
  const straightened = (p: number[]) => { if (!posedLegs.size) return p; const l = posedLegs.get(nearest(p)); return l ? straightOn(l, p) : p; };

  // ---- The garment's surface: where the distance to what it covers is its ease.
  const rest = restOff(layer);
  const field = new Float32Array(grid.dims[0] * grid.dims[1] * grid.dims[2]);
  const sinkGrid = new Float32Array(field.length);
  const [nx, ny, nz] = grid.dims;
  const nCovers = plan.covers.length;
  const partSdfs = plan.covers.map((c) => sdf.get(c.part)!);
  // Precompute height-dependent stand-off upper bound per z-slice so far-field voxels
  // (e.g. wide flare padding around the upper torso/arms) skip blend/sink/sampleGrid work.
  // Include maxSink because lifting up = (x, y, z + sink) can reduce SDF by up to maxSink.
  const maxSink = plan.covers.reduce((m, c) => Math.max(m, Math.max(c.off, c.snug?.off ?? 0) + (c.taper ? Math.max(0, c.taper.end - c.off) : 0) - rest), 0);
  const reachByK = new Float64Array(nz);
  for (let k = 0; k < nz; k++) {
    const z = grid.min[2] + k * H;
    let rMax = 0;
    for (const c of plan.covers) {
      const base = Math.max(c.off, c.snug?.off ?? 0) + (c.taper ? Math.max(0, c.taper.end - c.off) : 0) + sculptReach;
      rMax = Math.max(rMax, base + Math.max(flareAt(c, z), flareAt(c, z + maxSink)));
    }
    reachByK[k] = rMax + maxSink + 2 * H;
  }
  const weights = new Float64Array(nCovers);
  const dArr = new Float64Array(nCovers);
  const p = [0, 0, 0], at = [0, 0, 0], up = [0, 0, 0];
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const zk = grid.min[2] + k * H, rk = reachByK[k];
    for (let j = 0; j < ny; j++) {
      const yj = grid.min[1] + j * H;
      for (let i = 0; i < nx; i++, idx++) {
        let dmin = Infinity;
        for (let ci = 0; ci < nCovers; ci++) {
          const v = partSdfs[ci][idx];
          if (v < dmin) dmin = v;
        }
        if (dmin > rk) { field[idx] = dmin; continue; }
        p[0] = grid.min[0] + i * H; p[1] = yj; p[2] = zk;
        // Hung from what it rests on: its girth ease below it, not round it. The
        // surface is the form's moved down by the ease there (a sleeve on an arm,
        // slack underneath; a bodice's shoulder seam on the shoulder), so a girth
        // is kept and what faces up is at the rest clearance. One move at a point
        // for every part, blended as the ease is: moved apart, an arm's root
        // stood up through a body moved further down. A flare is length, not
        // girth, and is not moved.
        // The move is the ease where it is read from, the lifted point (a snug
        // band's eases off above it): found in a few steps, as it varies slowly.
        let w0 = 0;
        for (let ci = 0; ci < nCovers; ci++) {
          const w = Math.exp(-(partSdfs[ci][idx] - dmin) / BLEND);
          const wc = w < 1e-3 ? 0 : w;
          weights[ci] = wc;
          w0 += wc;
        }
        let sink = 0;
        at[0] = p[0]; at[1] = p[1];
        for (let it = 0; it < 3; it++) {
          at[2] = zk + sink;
          let next = 0;
          for (let ci = 0; ci < nCovers; ci++) {
            if (weights[ci]) next += weights[ci] * Math.max(0, partOff(plan.covers[ci], at, false) - rest);
          }
          sink = next / w0;
        }
        sinkGrid[idx] = sink;
        // The surface as the form has it, at the height it hangs from: each
        // part's distance and stand-off (a flare by height, a snug band) read there.
        up[0] = p[0]; up[1] = p[1]; up[2] = zk + sink;
        let hung = Infinity;
        for (let ci = 0; ci < nCovers; ci++) {
          const v = sink > 0 ? sampleGrid(grid, partSdfs[ci], up) : partSdfs[ci][idx];
          dArr[ci] = v;
          if (v < hung) hung = v;
        }
        let wsum = 0, esum = 0;
        for (let ci = 0; ci < nCovers; ci++) {
          const w = Math.exp(-(dArr[ci] - hung) / BLEND);
          if (w < 1e-3) continue;
          wsum += w;
          esum += w * partOff(plan.covers[ci], up);
        }
        // Sculpted out, or in no closer than resting on what it covers.
        const off = esum / wsum, more = sculpt.at(p);
        field[idx] = hung - (more >= 0 ? off + more : Math.max(off + more, Math.min(off, rest)));
      }
    }
  }
  // Off the grid as fine as its thinnest part needs; then each part's
  // triangles as large as its own curvature allows.
  const net = surfaceNet(grid, field);
  const fieldAt = (p: number[]) => sampleGrid(grid, field, p);
  const fine = { points: net.points, tris: largestPieces(net.points.length, net.tris) };
  // On sweeping flared/trained garments (surface area >> 2.5 m^2), let low-curvature
  // regions coarsen toward cloth spacing (~36 mm) while keeping curved regions fine.
  let fineArea = 0;
  for (let t = 0; t < fine.tris.length; t += 3) {
    const a = fine.points[fine.tris[t]], b = fine.points[fine.tris[t + 1]], c = fine.points[fine.tris[t + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    fineArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
  }
  const maxEdge = fineArea > 2.5 ? Math.min(0.036, H_MAX * Math.sqrt(fineArea / 2.5)) : H_MAX;
  const want = fine.points.map((p) => curvatureSize(fieldAt, p, H, H, maxEdge));
  {
    const nbr: number[][] = fine.points.map(() => []);
    for (let t = 0; t < fine.tris.length; t += 3) for (let e = 0; e < 3; e++) nbr[fine.tris[t + e]].push(fine.tris[t + ((e + 1) % 3)]);
    for (let it = 0; it < 3; it++) {
      const next = want.map((w, i) => nbr[i].reduce((m, j) => Math.min(m, want[j] * 1.25), w));
      for (let i = 0; i < want.length; i++) want[i] = next[i];
    }
  }
  const coarse = coarsenSurface(fine.points, fine.tris, want, ontoField(grid, field));
  const points = coarse.points;
  let tris = coarse.tris;
  // Cut and seamed where the form says (a waist at the waist), so a girth
  // cut is the form's there with its ease: on the surface lifted back up by
  // what it hangs, and let down again once cut (below). Cut where it hangs,
  // the waist seam was the form's girth from higher up, loose, and slid down
  // the hips (7 cm under a gathered skirt). Lifting only by how far a point
  // stands off past resting (so a shoulder is cut where it lies) put the
  // back of a waist at another height from its front: measured worse.
  const sinkAt = (p: number[]) => Math.max(0, sampleGrid(grid, sinkGrid, p));
  for (const p of points) p[2] += sinkAt(p);

  // ---- Openings.
  // A draft's plane, and where on the garment it applies.
  const planeDist = (pl: GarmentPlane, p: number[]) => ((p[0] - pl.point[0]) * pl.normal[0] + (p[1] - pl.point[1]) * pl.normal[1] + (p[2] - pl.point[2]) * pl.normal[2]) / (Math.hypot(pl.normal[0], pl.normal[1], pl.normal[2]) || 1);
  // `p` as the plan draws it (straightened), `at` where it is (whose part it is on).
  const inPlaneMask = (pl: GarmentPlane, p: number[], isFront: boolean, at = p) => (!pl.on || (pl.on as Part[]).includes(nearest(at)))
    && (pl.front === undefined || isFront === pl.front)
    && (!pl.z || (p[2] >= pl.z[0] && p[2] <= pl.z[1]))
    && (!pl.x || (p[0] >= pl.x[0] && p[0] <= pl.x[1]));
  // Where round a part a point is, for an edge profile (GarmentEdge): round
  // the body from the centre front toward the wearer's left (+x); round a
  // limb from its underside toward the front.
  const bodyTurn = (dx: number, dy: number) => turnRound(dx, dy, 0, [0, -1, 0], [1, 0, 0]);
  const limbTurn = (limb: LimbName, p: number[]) => {
    const path = limbs[limb].path, cl = path.closest(p, limbs[limb].length + 0.2), T = path.tangent(cl.s);
    const flat = (v: number[]) => { const k = v[0] * T[0] + v[1] * T[1] + v[2] * T[2]; return [v[0] - k * T[0], v[1] - k * T[1], v[2] - k * T[2]]; };
    const unitV = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    // A limb near upright (the head) has no underside to start from: round
    // it from the front toward the wearer's left, as round the body.
    const fd = flat([0, 0, -1]);
    if (Math.hypot(fd[0], fd[1], fd[2]) < 0.5) return turnRound(p[0] - cl.p[0], p[1] - cl.p[1], p[2] - cl.p[2], unitV(flat([0, -1, 0])), unitV(flat([1, 0, 0])));
    const down = unitV(fd);
    const fwd = unitV([T[1] * down[2] - T[2] * down[1], T[2] * down[0] - T[0] * down[2], T[0] * down[1] - T[1] * down[0]]);
    // Toward the front (-y) whichever way the limb runs.
    const f = fwd[1] > 0 ? fwd.map((v) => -v) : fwd;
    return turnRound(p[0] - cl.p[0], p[1] - cl.p[1], p[2] - cl.p[2], down, f);
  };
  const cutValue = (c: GarmentCut, p: number[]): number => {
    const [x, y, z] = p;
    switch (c.kind) {
      case 'neckline': if (c.shapeFront || c.shapeBack) {
        // Shaped: the edge drops depth x profile(t) at t = |x| / half across,
        // front and back blended round the neck as the depths are.
        const cy = centreY(z), s = form.height / 1.75;
        const r = Math.hypot(x, y - cy), u = r > 1e-6 ? 0.5 * (1 + (y - cy) / r) : 0.5;
        const sm = u * u * (3 - 2 * u), t = Math.min(1, Math.abs(x) / c.half);
        const round = Math.sqrt(Math.max(0, 1 - t * t));
        const dropF = c.front * (c.shapeFront ? profileAt(c.shapeFront, t) : round), dropB = c.back * (c.shapeBack ? profileAt(c.shapeBack, t) : round);
        const zTop = L.hpsZ - 0.015 * s * Math.min(1, Math.abs(x) / c.half) * (1 - Math.abs(2 * u - 1));
        let v = Math.max(zTop - z - (dropF + (dropB - dropF) * sm), Math.abs(x) - c.half);
        if (z > L.hpsZ - 0.01 * s) v = Math.min(v, r - c.half);
        return v;
      } else {
        // An ellipse down from the shoulder line round the neck, blending
        // smoothly between front and back depths so the shoulder seam has no step.
        const cy = centreY(z), s = form.height / 1.75;
        const r = Math.hypot(x, y - cy), u = r > 1e-6 ? 0.5 * (1 + (y - cy) / r) : 0.5;
        const sm = u * u * (3 - 2 * u);
        const depth = c.front + (c.back - c.front) * sm;
        const zTop = L.hpsZ - 0.015 * s * Math.min(1, Math.abs(x) / c.half) * (1 - Math.abs(2 * u - 1));
        let v = (Math.hypot(x / c.half, Math.max(0, zTop - z) / depth) - 1) * c.half;
        if (z > L.hpsZ - 0.01 * s) v = Math.min(v, r - c.half);
        return v;
      }
      case 'armhole': {
        const arm = limbs[c.limb], cl = arm.path.closest(p, arm.path.jointAt);
        return Math.hypot(x - cl.p[0], y - cl.p[1], z - cl.p[2]) - (arm.section(Math.max(0, cl.s)).w + c.extra);
      }
      case 'hem': {
        if (!on(c.on, p)) return 1;
        const [hx, hy, hz] = straightened(p);
        const cy = centreY(hz), back = Math.max(0, (hy - cy) / Math.max(1e-6, Math.hypot(hx, hy - cy)));
        return hz - (c.z - c.train * back * back - (c.profile ? profileAt(c.profile, bodyTurn(hx, hy - cy)) : 0));
      }
      case 'waist': return on(c.on, p) ? c.z + (c.profile ? profileAt(c.profile, bodyTurn(x, y - centreY(z))) : 0) - z : 1;
      case 'limbEnd': return on(c.on, p) ? c.s + (c.profile ? profileAt(c.profile, limbTurn(c.limb, p)) : 0) - alongLimb(c.limb, p) : 1;
      case 'limbStart': return on(c.on, p) ? alongLimb(c.limb, p) - c.s + (c.profile ? profileAt(c.profile, limbTurn(c.limb, p)) : 0) : 1;
      case 'plane': { const q = straightened(p); return inPlaneMask(c, q, q[1] < centreY(q[2]), p) ? -planeDist(c, q) : 1; }
    }
  };
  // A shaped edge (GarmentEdge) cut across triangles a quarter the size, so
  // its corners keep their points (a V's tip came out 2 cm short).
  const shaped = plan.cuts.filter((c) => ('profile' in c && c.profile) || (c.kind === 'neckline' && (c.shapeFront || c.shapeBack)));
  if (shaped.length) {
    // Midpoints stay on the chords: the points are lifted by their sink here,
    // off the field, and a chord of a 2 cm edge strays well under a millimetre.
    tris = refineNear(points, tris, (p) => shaped.reduce((v, c) => Math.min(v, cutValue(c, p)), 1));
  }
  // The size of the triangles round each point (a cut point, the edge it cut):
  // a short edge where a cut crossed is short for the triangles there.
  const size = new Float64Array(points.length);
  {
    const count = new Uint16Array(points.length);
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], l = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
      size[a] += l; size[b] += l; count[a] += 2; count[b] += 2;
    }
    for (let i = 0; i < points.length; i++) size[i] = count[i] ? size[i] / count[i] : H;
  }
  const clipped = clipSurface(points, tris, (p) => plan.cuts.reduce((v, c) => Math.min(v, cutValue(c, p)), 1));
  tris = clipped.tris;
  const sizeAt = Array.from(size);
  for (const [k, id] of clipped.crossing) { const [a, b] = k.split(',').map(Number); sizeAt[id] = (size[a] + size[b]) / 2; }
  {
    const remap = collapseShortBoundaryEdges(points, tris, (a, b) => 0.35 * Math.min(sizeAt[a] ?? H, sizeAt[b] ?? H));
    const kept: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = remap[tris[t]], b = remap[tris[t + 1]], c = remap[tris[t + 2]];
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    tris = largestPieces(points.length, kept);
  }

  // ---- The open edges, named for the cut each lies on (before anything moves).
  const cutName = (c: GarmentCut): string => {
    switch (c.kind) {
      case 'neckline': return 'neckline';
      case 'hem': return 'hem';
      case 'waist': return 'waist';
      case 'armhole': return `armhole${c.limb.slice(3)}`;
      case 'limbEnd': return c.limb.startsWith('arm') ? `cuff${c.limb.slice(3)}` : 'end';
      case 'limbStart': return 'top';
      case 'plane': return c.name ?? 'cut';
    }
  };
  let edges: GarmentShell['edges'] = [];
  {
    const n = points.length, seen = new Set<number>();
    const once = new Map<number, [number, number]>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], k = a < b ? a * n + b : b * n + a;
      if (seen.has(k)) once.delete(k); else { seen.add(k); once.set(k, [a, b]); }
    }
    for (const [a, b] of once.values()) {
      let best = 'edge', bd = 0.5 * H;
      for (const c of plan.cuts) { const d = Math.max(Math.abs(cutValue(c, points[a])), Math.abs(cutValue(c, points[b]))); if (d < bd) { bd = d; best = cutName(c); } }
      edges.push({ name: best, path: [a, b] });
    }
  }

  // ---- Lines drawn on it (GarmentCurve), laid where it is cut: on the surface lifted as it is here.
  const liftCurve = (line: GarmentCurve): GarmentCurve => ({ ...line, points: line.points.map((p) => [p[0], p[1], p[2] + sinkAt(p)] as [number, number, number]) });
  // Drawn cuts, with the openings: the smaller part each cuts off taken away,
  // its edge named for it. One that cuts nothing off is left as a slit.
  const slits: { name: string; path: [number, number] }[] = [];
  for (const line of draftLines(draft.curves)) {
    if (line.kind !== 'cut') continue;
    const curve = surfaceCurve(liftCurve(line), points, tris);
    if (!curve) continue;
    const slit = curveSlit(curve);
    const locked = new Set<number>(edges.flatMap((e) => e.path));
    const r = splitAlong(points, tris, slit.f, (c, corners) => slit.where(c, corners), locked);
    tris = r.tris;
    edges = carryThrough(edges, r.split);
    const parts = splitPanels(points.length, tris, r.edges);
    const n = points.length, key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
    const onLine = new Set(r.edges.map(([a, b]) => key(a, b)));
    const area = (t: number) => { const [a, b, c] = [0, 1, 2].map((k) => points[tris[3 * t + k]]); const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };
    const touching = parts.filter((p) => p.some((t) => [0, 1, 2].some((e) => onLine.has(key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)])))));
    if (touching.length < 2) { for (const e of r.edges) slits.push({ name: line.name, path: e }); continue; }
    const sized = touching.map((p) => ({ p, a: p.reduce((acc, t) => acc + area(t), 0) })).sort((x, y) => y.a - x.a);
    const gone = new Set(sized.slice(1).flatMap((x) => x.p));
    const kept: number[] = [];
    for (let t = 0; t < tris.length / 3; t++) if (!gone.has(t)) kept.push(tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]);
    tris = kept;
    // The open edges as they are now: the old ones still on the cloth, and the line's.
    const uses = new Map<number, number>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) { const k = key(tris[t + e], tris[t + ((e + 1) % 3)]); uses.set(k, (uses.get(k) ?? 0) + 1); }
    edges = edges.filter((e) => uses.get(key(e.path[0], e.path[1])) === 1);
    for (const e of r.edges) if (uses.get(key(e[0], e[1])) === 1) edges.push({ name: line.name, path: e });
  }

  // ---- Seams.
  const front = (p: number[]) => p[1] - centreY(p[2]);
  // The surface between front and back: the body's front plane, and along
  // an arm the vertical plane through its line, blended between parts by
  // nearness as the ease is. The body's plane alone left a forearm turned
  // forward of it a closed tube.
  // Negative to the front, on either arm: the plane's normal turns with the
  // arm's own side (left as the tangent gave it, the right arm's was the
  // left's reversed, and the blend closed a loop round that sleeve).
  const limbPlane = (limb: FormLimb, p: number[]) => { const c = limb.path.closest(p, limb.length + 0.2), t = limb.path.tangent(c.s), l = Math.hypot(t[0], t[1]), side = Math.sign(limb.path.at(0)[0]) || 1; return l < 0.2 ? front(p) : (side * ((p[0] - c.p[0]) * -t[1] + (p[1] - c.p[1]) * t[0])) / l; };
  const frontOf = (c: PartCover, p: number[]) => { const limb = limbOf(c.part), leg = posedLegs.get(c.part); return limb && limb.name.startsWith('arm') ? limbPlane(limb, p) : front(leg ? straightOn(leg, p) : p); };
  const frontBlend = (p: number[]) => {
    let dmin = Infinity;
    const ds = plan.covers.map((c) => { const v = sampleGrid(grid, sdf.get(c.part)!, p); dmin = Math.min(dmin, v); return v; });
    let ws = 0, fs = 0;
    plan.covers.forEach((c, i) => { const w = Math.exp(-(ds[i] - dmin) / BLEND); if (w < 1e-3) return; ws += w; fs += w * frontOf(c, p); });
    return fs / ws;
  };
  // Darts for what the sculpting made that cannot lie flat (sculptDarts), after the plan's own.
  const sculpted = new Map<string, number>();
  if (sculpt.most > 0) {
    const reach = Math.max(...sculptDabs(draft.sculpt).map((d) => d.radius));
    const taken = plan.seams.flatMap((sm) => (sm.kind === 'dart' ? [sm.apex.point] : []));
    const live = (p: number[]) => sculpt.at([p[0], p[1], p[2] - sinkAt(p)]) > 0.25 * sculpt.most;
    const symmetric = (draft.sculpt ?? []).every((d) => d.mirror !== false);
    for (const line of sculptDarts(points, tris, live, reach, taken, symmetric)) { plan.seams.push({ kind: 'dart', ...line }); sculpted.set(line.name, reach); }
  }
  let seams: GarmentShell['seams'] = slits.map((e) => ({ ...e, open: true }));
  for (const sm of plan.seams) {
    // Topological panel membership from seams already cut: once a boundary seam
    // (such as an armhole) partitions the mesh into discrete components, subsequent
    // seams restrict themselves to their target component(s) topologically rather
    // than re-querying continuous SDFs near seam junctions.
    const curPanels = splitPanels(points.length, tris, seams.map((s) => s.path));
    const triPart: Part[] = new Array(tris.length / 3);
    const triFront: boolean[] = new Array(tris.length / 3);
    for (const p of curPanels) {
      const votes = new Map<Part, number>();
      const c = [0, 0, 0];
      for (const t of p) for (let q = 0; q < 3; q++) { const pt = points[tris[3 * t + q]]; for (let k = 0; k < 3; k++) c[k] += pt[k] / (3 * p.length); }
      const step = Math.max(1, Math.floor(p.length / 60));
      for (let i = 0; i < p.length; i += step) {
        const t = p[i];
        const pt = [0, 1, 2].map((k) => (points[tris[3 * t]][k] + points[tris[3 * t + 1]][k] + points[tris[3 * t + 2]][k]) / 3);
        const part = nearest(pt);
        votes.set(part, (votes.get(part) ?? 0) + 1);
      }
      const part = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? parts[0];
      const leg = posedLegs.get(part), sc = leg ? straightOn(leg, c) : c, isFront = sc[1] < centreY(sc[2]);
      for (const t of p) { triPart[t] = part; triFront[t] = isFront; }
    }
    const inParts = (list: Part[], t: number) => list.includes(triPart[t]);

    const locked = new Set<number>();
    for (const s of seams) { locked.add(s.path[0]); locked.add(s.path[1]); }
    for (const e of edges) { locked.add(e.path[0]); locked.add(e.path[1]); }

    const runSeam = (name: string, f: (p: number[]) => number, where: (c: number[], corners: number[][], t: number) => boolean, open?: boolean) => {
      const r = splitAlong(points, tris, f, where, locked);
      tris = r.tris;
      seams = carryThrough(seams, r.split);
      edges = carryThrough(edges, r.split);
      for (const e of r.edges) seams.push({ name, path: e, ...(open ? { open: true } : {}) });
    };

    switch (sm.kind) {
      case 'frontBack':
        runSeam('side', frontBlend, (_, __, t) => inParts(sm.on, t));
        break;
      case 'centre':
        runSeam('centre', (p) => p[0], () => true);
        break;
      case 'frontOpening': {
        const limb = sm.on.length === 1 ? limbOf(sm.on[0]) : null;
        runSeam(
          'opening',
          (p) => (limb ? p[0] - limb.section(Math.min(limb.length, Math.max(0, alongLimb(sm.on[0], p)))).c[0] : p[0]),
          (c, _, t) => inParts(sm.on, t) && (triFront[t] || c[1] < (limb ? limb.section(Math.min(limb.length, Math.max(0, alongLimb(sm.on[0], c)))).c[1] : centreY(c[2]))),
          true,
        );
        break;
      }
      case 'partBoundary': {
        const limb = limbs[sm.b], side = Math.sign(limb.path.at(0)[0]);
        runSeam(sm.name, (p) => sampleGrid(grid, sdf.get(sm.a)!, p) - sampleGrid(grid, sdf.get(sm.b)!, p), (p) => Math.sign(p[0]) === side && alongLimb(sm.b, p) < sm.within * limb.length);
        break;
      }
      case 'alongLimb': {
        const limb = limbs[sm.limb];
        runSeam(sm.name, (p) => limbPlane(limb, p), (c, _, t) => triPart[t] === sm.limb && (sm.over || c[2] < limb.path.closest(c, limb.length + 0.2).p[2]));
        break;
      }
      case 'roundLimb': {
        // Evenly round the garment's opening (a hat's band), by length along
        // it, not by angle: a head reaches further in front of its axis than
        // behind, and by angle the front gores were half as wide again as the
        // back ones at the band. Each seam is a half plane out from the axis,
        // all meeting there: points evenly along an edge that is not round are
        // not opposite each other.
        const limb = limbs[sm.limb];
        const at = (p: number[]) => limb.section(Math.min(limb.length, Math.max(0, alongLimb(sm.limb, p))));
        const comp = (p: number[], sec: LimbSectionAt, a: number, b: number) => [0, 1, 2].reduce((acc, q) => acc + (p[q] - sec.c[q]) * (a * sec.side[q] + b * sec.up[q]), 0);
        const angOf = (p: number[]) => { const sec = at(p), a = Math.atan2(comp(p, sec, 0, 1), comp(p, sec, 1, 0)); return a < 0 ? a + 2 * Math.PI : a; };
        // The opening: the longest edge round it (a hole cut in it, a strap's, is shorter).
        let ring: number[][] = [];
        for (const loop of boundaryLoops(points.length, tris)) {
          const pts = loop.map((i) => points[i]);
          const len = pts.reduce((acc, q, k) => acc + Math.hypot(...[0, 1, 2].map((c) => q[c] - pts[(k + 1) % pts.length][c]) as [number, number, number]), 0);
          const best = ring.reduce((acc, q, k) => acc + Math.hypot(...[0, 1, 2].map((c) => q[c] - ring[(k + 1) % ring.length][c]) as [number, number, number]), 0);
          if (len > best) ring = pts;
        }
        // Without one (a closed tube), a section of the limb halfway along.
        if (ring.length < 8) {
          const sec = limb.section(limb.length / 2);
          ring = Array.from({ length: 96 }, (_, i) => { const a = (2 * Math.PI * i) / 96, q = sec.shape ? sec.shape(a) : [Math.cos(a) * sec.w, Math.sin(a) * sec.h]; return [0, 1, 2].map((c) => sec.c[c] + q[0] * sec.side[c] + q[1] * sec.up[c]); });
        }
        // Run it the way the angle grows, from where it crosses angle 0 (the limb's side).
        const angs = ring.map(angOf);
        let turn = 0;
        for (let k = 0; k < angs.length; k++) { let d = angs[(k + 1) % angs.length] - angs[k]; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; turn += d; }
        if (turn < 0) { ring.reverse(); angs.reverse(); }
        let start = 0;
        for (let k = 0; k < angs.length; k++) if (angs[k] - angs[(k + 1) % angs.length] > Math.PI) { start = (k + 1) % angs.length; break; }
        const m = ring.length, order = Array.from({ length: m + 1 }, (_, k) => ring[(start + k) % m]);
        const arc = [0];
        for (let k = 1; k <= m; k++) arc.push(arc[k - 1] + Math.hypot(...[0, 1, 2].map((c) => order[k][c] - order[k - 1][c]) as [number, number, number]));
        for (let k = 0; k < sm.n; k++) {
          const want = (arc[m] * k) / sm.n;
          let i = 1;
          while (i < m && arc[i] < want) i++;
          const f = (want - arc[i - 1]) / Math.max(1e-12, arc[i] - arc[i - 1]);
          const ang = angOf([0, 1, 2].map((c) => order[i - 1][c] + f * (order[i][c] - order[i - 1][c])));
          runSeam(`seam${k + 1}`, (p) => comp(p, at(p), -Math.sin(ang), Math.cos(ang)), (c) => comp(c, at(c), Math.cos(ang), Math.sin(ang)) > 0);
        }
        break;
      }
      case 'limbRing':
        runSeam(sm.name, (p) => alongLimb(sm.limb, p) - sm.s, (_, __, t) => triPart[t] === sm.limb);
        break;
      case 'plane':
        runSeam(sm.name, (p) => planeDist(sm, straightened(p)), (c, _, t) => inPlaneMask(sm, straightened(c), triFront[t], c), sm.open);
        break;
      case 'curve': {
        const lines = [...seams, ...edges];
        const curve = surfaceCurve(liftCurve(sm.line), points, tris, lines.flatMap((x) => x.path.map((i) => points[i])));
        if (!curve) break;
        const slit = curveSlit(curve);
        runSeam(sm.line.name, slit.f, (c, corners) => slit.where(c, corners), sm.line.kind === 'open');
        // What ran on past a seam it was drawn to, off again.
        const anchored = new Set<number>();
        for (const x of seams) if (x.name !== sm.line.name) for (const i of x.path) anchored.add(i);
        for (const x of edges) for (const i of x.path) anchored.add(i);
        const drop = trimOvershoot(seams.filter((x) => x.name === sm.line.name).map((x) => x.path as [number, number]), anchored, points);
        if (drop.size) seams = seams.filter((x) => x.name !== sm.line.name || !drop.has(x.path[0] < x.path[1] ? `${x.path[0]},${x.path[1]}` : `${x.path[1]},${x.path[0]}`));
        break;
      }
      case 'dart': {
        // A sculpted dome's dart, not where a seam already runs within its
        // reach: the seam takes the shaping up, as a hat's gores do (a cap's
        // front cut each front gore in three for 1% less strain).
        const reachOf = sculpted.get(sm.name);
        if (reachOf !== undefined) {
          const a = sm.apex.point, r2 = reachOf * reachOf;
          if (seams.some((x) => x.path.some((i) => { const q = points[i]; return (q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2 + (q[2] - a[2]) ** 2 < r2; }))) break;
        }
        // Slit from its apex along its line, through the panel it lies in.
        const slit = dartSlit(sm, points, tris, curPanels, [...seams, ...edges].map((x) => x.path));
        if (slit) runSeam(sm.name, slit.f, (_, __, t) => slit.tris.has(t));
        break;
      }
    }
  }

  // Cuts leave flat triangles at T-junctions; none may reach the flattening.
  {
    let meanArea = 0;
    for (let t = 0; t < tris.length; t += 3) { const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => points[i]); const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; meanArea += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; }
    meanArea /= tris.length / 3;
    const r = healFlatTriangles(points, tris, 1e-4 * meanArea);
    tris = r.tris;
    const remapped = (list: GarmentShell['seams']) => carryThrough(list, r.split).map((sm) => ({ ...sm, path: sm.path.map((i) => r.remap[i]) })).filter((sm) => sm.path[0] !== sm.path[1]);
    seams = remapped(seams);
    edges = remapped(edges);
  }
  // Lines drawn only to mark (GarmentCurve kind 'line'): kept by name, not seams to part the panels at.
  const markNames = new Set(draftLines(draft.curves).filter((l) => l.kind === 'line').map((l) => l.name));
  const marks = seams.filter((sm) => markNames.has(sm.name)).map(({ name, path }) => ({ name, path }));
  seams = seams.filter((sm) => !markNames.has(sm.name));

  // ---- Panels, named for where they are, as the part they cover says:
  // front and back (and which side), a sleeve (upper and lower past a ring), gores.
  const rings = new Map<Part, number>();
  for (const sm of plan.seams) if (sm.kind === 'limbRing') rings.set(sm.limb, sm.s);
  let panelTris = splitPanels(points.length, tris, seams.map((sm) => sm.path));
  // Absorb corner slivers across non-open seam edges: where seams cross near
  // a point (a crotch, four panels meeting) they can box in a scrap. A
  // scrap by area, under 1% of the largest panel: triangles are sized by
  // curvature, so a count says nothing of size.
  const triArea = (t: number) => {
    const a = points[tris[3 * t]], b = points[tris[3 * t + 1]], c = points[tris[3 * t + 2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  };
  const panelArea = panelTris.map((p) => p.reduce((acc, t) => acc + triArea(t), 0));
  const scrapUnder = 0.01 * Math.max(...panelArea);
  const scrap = panelArea.map((a) => a < scrapUnder);
  if (scrap.some(Boolean)) {
    const triPanel = new Int32Array(tris.length / 3);
    panelTris.forEach((p, idx) => p.forEach((t) => { triPanel[t] = idx; }));
    const edgeTris = new Map<string, number[]>();
    for (let t = 0; t < tris.length / 3; t++) {
      for (let e = 0; e < 3; e++) {
        const a = tris[3 * t + e], b = tris[3 * t + ((e + 1) % 3)];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        let list = edgeTris.get(k);
        if (!list) { list = []; edgeTris.set(k, list); }
        list.push(t);
      }
    }
    const dissolve = new Set<string>();
    // A speck a cut left touching nothing is not a panel: it goes.
    const specks = new Set<number>();
    for (let idx = 0; idx < panelTris.length; idx++) {
      if (!scrap[idx]) continue;
      // Find the single best neighbouring large panel to absorb this sliver into,
      // so we never dissolve edges to two different large panels and merge them.
      const byNeighbour = new Map<number, string[]>();
      for (const t of panelTris[idx]) {
        for (let e = 0; e < 3; e++) {
          const a = tris[3 * t + e], b = tris[3 * t + ((e + 1) % 3)];
          const k = a < b ? `${a},${b}` : `${b},${a}`;
          for (const ot of edgeTris.get(k) ?? []) {
            const np = triPanel[ot];
            if (np !== idx && !scrap[np]) {
              let list = byNeighbour.get(np);
              if (!list) { list = []; byNeighbour.set(np, list); }
              list.push(k);
            }
          }
        }
      }
      const best = [...byNeighbour.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (best) for (const k of best[1]) dissolve.add(k);
      else if (panelTris[idx].every((t) => [0, 1, 2].every((e) => {
        const a = tris[3 * t + e], b = tris[3 * t + ((e + 1) % 3)];
        return (edgeTris.get(a < b ? `${a},${b}` : `${b},${a}`) ?? []).every((ot) => triPanel[ot] === idx);
      })) && panelTris.length > 1) panelTris[idx].forEach((t) => specks.add(t));
    }
    if (specks.size > 0) {
      const kept: number[] = [];
      for (let t = 0; t < tris.length / 3; t++) if (!specks.has(t)) kept.push(tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]);
      tris = kept;
    }
    if (dissolve.size > 0 || specks.size > 0) {
      // Each seam without its dissolved edges, in the runs that are left.
      seams = seams.flatMap((sm) => {
        if (sm.open) return [sm];
        const runs: number[][] = [[sm.path[0]]];
        for (let k = 1; k < sm.path.length; k++) {
          const a = sm.path[k - 1], b = sm.path[k];
          if (dissolve.has(a < b ? `${a},${b}` : `${b},${a}`)) runs.push([b]);
          else runs[runs.length - 1].push(b);
        }
        return runs.filter((r) => r.length > 1).map((path) => ({ ...sm, path }));
      });
      panelTris = splitPanels(points.length, tris, seams.map((sm) => sm.path));
    }
  }
  // Each panel named for what it covers; panels that would share a name (a
  // front split by an opening, a centre seam, princess lines) by their side,
  // the one across the middle keeping the name; any still alike, numbered.
  const named = panelTris.map((p) => {
    const c = [0, 0, 0], votes = new Map<Part, number>();
    for (const t of p) for (let q = 0; q < 3; q++) { const pt = points[tris[3 * t + q]]; for (let k = 0; k < 3; k++) c[k] += pt[k] / (3 * p.length); }
    for (let i = 0; i < p.length; i += Math.max(1, Math.floor(p.length / 40))) { const part = nearest(points[tris[3 * p[i]]]); votes.set(part, (votes.get(part) ?? 0) + 1); }
    const part = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    const cover = covers.get(part)!, tag = part.slice(-1);
    const leg = posedLegs.get(part), sc = leg ? straightOn(leg, c) : c, fb = sc[1] < centreY(sc[2]) ? 'front' : 'back';
    const ring = rings.get(part);
    const base = cover.names === 'gore' ? 'gore'
      : cover.names === 'sleeve' ? `sleeve${tag}${ring !== undefined ? (alongLimb(part, c) < ring ? 'Upper' : 'Lower') : ''}`
        : cover.names === 'frontBackSide' ? `${fb}${c[0] > 0 ? 'L' : 'R'}` : fb;
    const limb = limbOf(part);
    const t = limb ? limb.path.tangent(alongLimb(part, c)) : null;
    const upAxis = t ? (t[2] <= 0 ? [-t[0], -t[1], -t[2]] : t) : [0, 0, 1];
    return { base, cx: c[0], gore: cover.names === 'gore', tris: p, upAxis };
  });
  const count = (key: string, list: string[]) => list.filter((n) => n === key).length;
  const bases = named.map((q) => q.base);
  // Told apart by side only where they lie either side (a sleeve, already
  // named for its side, cut in two by a dart is numbered, not sided again).
  const bothSides = (base: string) => { const xs = named.filter((q) => q.base === base && Math.abs(q.cx) >= 0.02).map((q) => q.cx > 0); return xs.includes(true) && xs.includes(false); };
  const sided = named.map((q) => (q.gore || count(q.base, bases) < 2 || Math.abs(q.cx) < 0.02 || !bothSides(q.base) ? q.base : `${q.base}${q.cx > 0 ? 'L' : 'R'}`));
  // Numbered from the middle out (a centre back before a side back), gores round.
  const rank = named.map((_, k) => k).sort((a, b) => (named[a].gore ? a - b : Math.abs(named[a].cx) - Math.abs(named[b].cx)));
  const used = new Map<string, number>(), number = new Array<number>(named.length);
  for (const k of rank) { const n = (used.get(sided[k]) ?? 0) + 1; used.set(sided[k], n); number[k] = n; }
  const panels = named.map((q, k) => ({ name: q.gore || count(sided[k], sided) > 1 ? `${sided[k]}${number[k]}` : sided[k], tris: q.tris, upAxis: q.upAxis }));
  // What reaches below the floor lies on it, out from the body: a floor-length
  // hem pools, a train spreads out behind; flattened from the unpooled cut.
  // Let down to where it hangs: each point to where it was lifted from (a
  // point a cut made, found as the lift there gives it).
  const lifted = points.map((p) => p.slice());
  for (const p of points) {
    let z = p[2] - sinkAt(p);
    for (let it = 0; it < 4; it++) z = p[2] - sinkAt([p[0], p[1], z]);
    p[2] = z;
  }
  const cut = points.map((p) => p.slice());
  for (const p of points) {
    if (p[2] >= FLOOR) continue;
    const cy = centreY(L.hipZ), dx = p[0], dy = p[1] - cy, l = Math.hypot(dx, dy) || 1;
    p[0] += (dx / l) * (FLOOR - p[2]); p[1] += (dy / l) * (FLOOR - p[2]); p[2] = FLOOR;
  }
  const shell: GarmentShell = compact({ points, cut, tris, seams, panels, edges, ...(marks.length ? { marks } : {}) });
  // Round the form under each point, where it is cut from: what an ease of
  // circumference is measured against.
  const perimeter = (radii: number[]) => radii.reduce((acc, r, i) => {
    const r2 = radii[(i + 1) % radii.length], a = (2 * Math.PI) / radii.length;
    return acc + Math.sqrt(r * r + r2 * r2 - 2 * r * r2 * Math.cos(a));
  }, 0);
  // Measured where it was cut, against the form there.
  const liftedOf = new Map<number[], number[]>();
  points.forEach((p, i) => liftedOf.set(p, lifted[i]));
  const asCut = shell.points.map((p) => liftedOf.get(p) ?? p);
  shell.part = asCut.map((p) => nearest(p));
  shell.hang = asCut.map((p, i) => p[2] - (shell.cut ?? shell.points)[i][2]);
  shell.girth = asCut.map((p, i) => {
    const part = shell.part![i] as Part, limb = limbOf(part);
    if (!limb) return perimeter(bodyFormSection(form, Math.min(L.hpsZ, p[2])).radii);
    const sec = limb.section(Math.min(limb.length, Math.max(0, alongLimb(part, p))));
    return Math.PI * (3 * (sec.w + sec.h) - Math.sqrt((3 * sec.w + sec.h) * (sec.w + 3 * sec.h)));
  });
  return shell;
}

/** Runs of two points, each split in two through the point let into its edge, if one was. */
function carryThrough<T extends { path: number[] }>(list: T[], split: Map<string, number>): T[] {
  return list.flatMap((sm) => {
    const [a, b] = sm.path, c = split.get(a < b ? `${a},${b}` : `${b},${a}`);
    return c === undefined ? [sm] : [{ ...sm, path: [a, c] }, { ...sm, path: [c, b] }];
  });
}

/**
 * A web: a sheet from the underside of a limb, `along` it from its root, to
 * the body's side (`sideAt`: the side point at a height) `depth` down from
 * the root, closed with a little thickness so it has an inside. Under a
 * batwing sleeve, the cloth stands off it as off any part.
 */
function webSheet(limb: FormLimb, along: number, depth: number, sideAt: (z: number) => number[]): { points: number[][]; tris: number[] } {
  const n = Math.max(2, Math.ceil(along / 0.03)), zTop = limb.path.at(0)[2], z0 = zTop - limb.section(0).h, z1 = Math.min(z0 - 0.02, zTop - depth);
  const a: number[][] = [], b: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const s = (along * i) / n, sec = limb.section(s);
    a.push([sec.c[0], sec.c[1], sec.c[2] - sec.h]);
    b.push(sideAt(z0 + ((z1 - z0) * i) / n));
  }
  // Each pair of points' normal, from the strip's surface there.
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const unit = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
  const normals: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const j = Math.min(n - 1, i), along3 = a[j + 1].map((v, k) => v - a[j][k]), across = b[i].map((v, k) => v - a[i][k]);
    normals.push(unit(cross(across, along3)));
  }
  const THK = 0.01;
  const points: number[][] = [];
  for (let i = 0; i <= n; i++) for (const q of [a[i], b[i]]) for (const sgn of [1, -1]) points.push(q.map((v, k) => v + sgn * THK * normals[i][k]));
  // Point (i, side 0 = limb / 1 = body, face 0 = +normal / 1 = -normal).
  const id = (i: number, side: number, face: number) => i * 4 + side * 2 + face;
  const tris: number[] = [];
  const quad = (p: number, q: number, r: number, t: number) => tris.push(p, q, r, p, r, t);
  for (let i = 0; i < n; i++) {
    quad(id(i, 0, 0), id(i, 1, 0), id(i + 1, 1, 0), id(i + 1, 0, 0));
    quad(id(i, 0, 1), id(i + 1, 0, 1), id(i + 1, 1, 1), id(i, 1, 1));
    quad(id(i, 0, 0), id(i + 1, 0, 0), id(i + 1, 0, 1), id(i, 0, 1));
    quad(id(i, 1, 0), id(i, 1, 1), id(i + 1, 1, 1), id(i + 1, 1, 0));
  }
  quad(id(0, 0, 0), id(0, 0, 1), id(0, 1, 1), id(0, 1, 0));
  quad(id(n, 0, 0), id(n, 1, 0), id(n, 1, 1), id(n, 0, 1));
  return { points, tris };
}

/** The triangles of the connected pieces that make up most of the surface (no specks). */
function largestPieces(nPoints: number, tris: number[]): number[] {
  const parent = Array.from({ length: nPoints }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < tris.length; t += 3) { const a = find(tris[t]); parent[find(tris[t + 1])] = a; parent[find(tris[t + 2])] = a; }
  const size = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) { const r = find(tris[t]); size.set(r, (size.get(r) ?? 0) + 1); }
  const biggest = Math.max(0, ...size.values());
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3) if ((size.get(find(tris[t])) ?? 0) >= 0.05 * biggest) out.push(tris[t], tris[t + 1], tris[t + 2]);
  return out;
}
