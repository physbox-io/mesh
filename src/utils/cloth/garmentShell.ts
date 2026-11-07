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

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import { bodyFormGeoms, bodyFormSection, bodyLandmarks, formSkin } from './bodyForm';
import { formLimbs, type FormLimb } from './formLimbs';
import { gridOver, meshSdf, sampleGrid } from './formSdf';
import { surfaceNet } from './surfaceNets';
import { clipSurface, collapseShortBoundaryEdges, compact, healFlatTriangles, splitAlong, splitPanels } from './garmentSurface';
import { garmentPlan, type GarmentCut, type GarmentSeam, type Part, type PartCover } from './garmentPlan';

export { boundaryLoops, splitPanels } from './garmentSurface';

export interface GarmentShell {
  /** Points of the fabric's middle surface. */
  points: number[][];
  /** Triangles, wound so their normals face away from the body. */
  tris: number[];
  /** Seams: chains of point indices, each run along the edges between them. `open`: cut and left open (a jacket's front), not sewn. */
  seams: { name: string; path: number[]; open?: boolean }[];
  /** The surface split along its seams: each panel's triangles (indices into tris / 3). */
  panels: { name: string; tris: number[] }[];
  /** Its open edges, each run named for the cut that made it: neckline, hem, waist, cuffL, armholeL, opening, top, end. */
  edges: { name: string; path: number[] }[];
  /** The same points as the garment is cut, where that differs from how it is modelled. What it is flattened from. */
  cut?: number[][];
}

/** The grid's spacing at most: about the size of a triangle of a garment round the body. */
const H_MAX = 0.025;
/** And at least, round the thinnest limb (a foot, a hand). */
const H_MIN = 0.0075;
/** How near the floor (the form stands on z = 0) cloth lies. */
const FLOOR = 0.006;
/** Over this, where parts' distances are within it of each other, their ease blends (an armpit). */
const BLEND = 0.02;

export function garmentShell(draft: GarmentDraft, form: BodyFormMeasurements, layer = 0): GarmentShell {
  const plan = garmentPlan(draft, form, layer);
  const L = bodyLandmarks(form);
  const limbs = formLimbs(form);
  const covers = new Map<Part, PartCover>(plan.covers.map((c) => [c.part, c]));
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
      if (ct.kind === 'limbStart' && ct.limb === limb.name) s0 = Math.max(s0, ct.s);
      if (ct.kind === 'limbEnd' && ct.limb === limb.name) s1 = Math.min(s1, ct.s);
      if (ct.kind === 'hem' && ct.on.includes(c.part)) zMin = Math.max(zMin, ct.z - ct.train);
    }
    for (let k = 0; k <= 24; k++) {
      const sec = limb.section(s0 + ((s1 - s0) * k) / 24);
      if (sec.c[2] < zMin) continue;
      across = Math.min(across, Math.min(sec.w, sec.h) + c.off);
    }
  }
  const H = Math.min(H_MAX, Math.max(H_MIN, across / 2));


  // ---- How far off each part, at a point.
  const flareAt = (c: PartCover, z: number) => (c.flare ? c.flare.add * Math.max(0, (c.flare.z0 - z) / Math.max(1e-3, c.flare.z0 - c.flare.z1)) : 0);
  const partOff = (c: PartCover, p: number[]): number => {
    let v = c.off + flareAt(c, p[2]);
    if (c.snug) {
      const dz = Math.max(0, c.snug.z - p[2]);
      const cy = c.snug.r !== undefined ? bodyFormSection(form, Math.min(L.hpsZ, Math.max(L.hipZ, p[2]))).centreY : 0;
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
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (const p of meshes[part].points) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  // The grid reaches down to the lowest cut (what lies on the floor included),
  // and out as far as the cloth stands off anywhere.
  let lowest = Infinity;
  for (const c of plan.cuts) if (c.kind === 'hem') lowest = Math.min(lowest, Math.min(c.z, 0) - c.train);
  let reach = 0;
  for (const c of plan.covers) reach = Math.max(reach, c.off + flareAt(c, lowest) + (c.taper ? Math.max(0, c.taper.end - c.off) : 0));
  reach += 3 * H;
  // Every part whole inside the grid: inside and out are told by flooding in
  // from its edge, and a part cut off by the edge let the flood inside it
  // (a second surface grew inside the body).
  for (let a = 0; a < 3; a++) { lo[a] -= reach; hi[a] += reach; }
  if (lowest < Infinity) lo[2] = Math.min(lo[2], lowest - 2 * H);
  const grid = gridOver(lo, hi, H);
  const sdf = new Map<Part, Float32Array>();
  for (const part of parts) sdf.set(part, meshSdf(grid, meshes[part].points, meshes[part].tris));

  // ---- Which part a point is nearest.
  const nearest = (p: number[]) => {
    let best: Part = parts[0], bd = Infinity;
    for (const part of parts) { const v = sampleGrid(grid, sdf.get(part)!, p); if (v < bd) { bd = v; best = part; } }
    return best;
  };
  const on = (list: Part[] | undefined, p: number[]) => !list || list.includes(nearest(p));

  // ---- The garment's surface: where the distance to what it covers is its ease.
  const field = new Float32Array(grid.dims[0] * grid.dims[1] * grid.dims[2]);
  const [nx, ny] = grid.dims;
  for (let idx = 0; idx < field.length; idx++) {
    const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    const p = [grid.min[0] + i * H, grid.min[1] + j * H, grid.min[2] + k * H];
    let dmin = Infinity;
    for (const part of parts) dmin = Math.min(dmin, sdf.get(part)![idx]);
    if (dmin > reach + H) { field[idx] = dmin; continue; }
    let wsum = 0, esum = 0;
    for (const c of plan.covers) {
      const w = Math.exp(-(sdf.get(c.part)![idx] - dmin) / BLEND);
      if (w < 1e-3) continue;
      wsum += w;
      esum += w * partOff(c, p);
    }
    field[idx] = dmin - esum / wsum;
  }
  const net = surfaceNet(grid, field);
  const points = net.points;
  let tris = largestPieces(points.length, net.tris);

  // ---- Openings.
  const centreY = (z: number) => bodyFormSection(form, Math.min(L.hpsZ, Math.max(L.hipZ, z))).centreY;
  const cutValue = (c: GarmentCut, p: number[]): number => {
    const [x, y, z] = p;
    switch (c.kind) {
      case 'neckline': {
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
        const cy = centreY(z), back = Math.max(0, (y - cy) / Math.max(1e-6, Math.hypot(x, y - cy)));
        return z - (c.z - c.train * back * back);
      }
      case 'waist': return on(c.on, p) ? c.z - z : 1;
      case 'limbEnd': return on(c.on, p) ? c.s - alongLimb(c.limb, p) : 1;
      case 'limbStart': return on(c.on, p) ? alongLimb(c.limb, p) - c.s : 1;
    }
  };
  tris = clipSurface(points, tris, (p) => plan.cuts.reduce((v, c) => Math.min(v, cutValue(c, p)), 1)).tris;
  {
    const remap = collapseShortBoundaryEdges(points, tris, 0.35 * H);
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

  // ---- Seams.
  const front = (p: number[]) => p[1] - centreY(p[2]);
  // The surface between front and back: the body's front plane, and along
  // an arm the vertical plane through its line, blended between parts by
  // nearness as the ease is. The body's plane alone left a forearm turned
  // forward of it a closed tube.
  // Negative to the front, on either arm: the plane's normal turns with the
  // arm's own side (left as the tangent gave it, the right arm's was the
  // left's reversed, and the blend closed a loop round that sleeve).
  const limbPlane = (limb: FormLimb, p: number[]) => front(limb.path.straighten(p));
  const frontOf = (c: PartCover, p: number[]) => { const limb = limbOf(c.part) ?? (c.web ? limbs[c.web.limb] : null); return limb && limb.name.startsWith('arm') ? limbPlane(limb, p) : front(p); };
  const frontBlend = (p: number[]) => {
    let dmin = Infinity;
    const ds = plan.covers.map((c) => { const v = sampleGrid(grid, sdf.get(c.part)!, p); dmin = Math.min(dmin, v); return v; });
    let ws = 0, fs = 0;
    plan.covers.forEach((c, i) => { const w = Math.exp(-(ds[i] - dmin) / BLEND); if (w < 1e-3) return; ws += w; fs += w * frontOf(c, p); });
    return fs / ws;
  };
  let seams: GarmentShell['seams'] = [];
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
      const isFront = c[1] < centreY(c[2]);
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
      case 'frontOpening':
        runSeam('opening', (p) => p[0], (c, _, t) => inParts(sm.on, t) && (triFront[t] || c[1] < centreY(c[2])), true);
        break;
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
        const limb = limbs[sm.limb];
        for (let k = 0; k < sm.n / 2; k++) {
          const ang = (Math.PI * k) / (sm.n / 2);
          runSeam(`seam${k + 1}`, (p) => { const sec = limb.section(Math.min(limb.length, Math.max(0, alongLimb(sm.limb, p)))); return [0, 1, 2].reduce((acc, q) => acc + (p[q] - sec.c[q]) * (-Math.sin(ang) * sec.side[q] + Math.cos(ang) * sec.up[q]), 0); }, () => true);
        }
        break;
      }
      case 'limbRing':
        runSeam(sm.name, (p) => alongLimb(sm.limb, p) - sm.s, (_, __, t) => triPart[t] === sm.limb);
        break;
      case 'gores': {
        break;
      }
      case 'dart':
        runSeam(
          sm.name,
          sm.axis === 'z' ? (p) => p[2] - sm.at : (p) => sm.side * p[0] - sm.at,
          (p) => nearest(p) === sm.on
            && (sm.front === undefined || (front(p) < 0) === sm.front)
            && (sm.xBeyond === undefined || sm.side * p[0] > sm.xBeyond)
            && (sm.zRange === undefined || (p[2] > sm.zRange[0] && p[2] < sm.zRange[1])),
        );
        break;
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

  // ---- Panels, named for where they are, as the part they cover says:
  // front and back (and which side), a sleeve (upper and lower past a ring), gores.
  const rings = new Map<Part, number>();
  for (const sm of plan.seams) if (sm.kind === 'limbRing') rings.set(sm.limb, sm.s);
  let panelTris = splitPanels(points.length, tris, seams.map((sm) => sm.path));
  // Absorb any microscopic corner slivers (< 6 triangles) across non-open seam edges.
  if (panelTris.some((p) => p.length < 6)) {
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
      if (panelTris[idx].length >= 6) continue;
      // Find the single best neighbouring large panel to absorb this sliver into,
      // so we never dissolve edges to two different large panels and merge them.
      const byNeighbour = new Map<number, string[]>();
      for (const t of panelTris[idx]) {
        for (let e = 0; e < 3; e++) {
          const a = tris[3 * t + e], b = tris[3 * t + ((e + 1) % 3)];
          const k = a < b ? `${a},${b}` : `${b},${a}`;
          for (const ot of edgeTris.get(k) ?? []) {
            const np = triPanel[ot];
            if (np !== idx && panelTris[np].length >= 6) {
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
      seams = seams.filter((sm) => sm.open || !dissolve.has(sm.path[0] < sm.path[1] ? `${sm.path[0]},${sm.path[1]}` : `${sm.path[1]},${sm.path[0]}`));
      panelTris = splitPanels(points.length, tris, seams.map((sm) => sm.path));
    }
  }
  // Fair interior vertices of each smooth seam and cut-edge chain (Taubin
  // lambda/mu filter projected back onto the garment surface), then relax
  // adjacent interior mesh vertices tangentially so cut boundaries have even,
  // wobble-free triangles before flattening.
  {
    const curveNbr = new Map<number, { to: number; tag: string }[]>();
    const addSeg = (a: number, b: number, tag: string) => {
      let la = curveNbr.get(a); if (!la) { la = []; curveNbr.set(a, la); }
      if (!la.some((x) => x.to === b)) la.push({ to: b, tag });
      let lb = curveNbr.get(b); if (!lb) { lb = []; curveNbr.set(b, lb); }
      if (!lb.some((x) => x.to === a)) lb.push({ to: a, tag });
    };
    for (const sm of seams) addSeg(sm.path[0], sm.path[1], `s:${sm.name}`);
    for (const ed of edges) addSeg(ed.path[0], ed.path[1], `e:${ed.name}`);
    const smoothCurveVtx = new Map<number, [number, number]>();
    for (const [v, list] of curveNbr) {
      if (list.length !== 2 || list[0].tag !== list[1].tag) continue;
      const a = points[list[0].to], p = points[v], b = points[list[1].to];
      const u1 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], u2 = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
      const l1 = Math.hypot(u1[0], u1[1], u1[2]) || 1, l2 = Math.hypot(u2[0], u2[1], u2[2]) || 1;
      if ((u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]) / (l1 * l2) > 0.75) {
        smoothCurveVtx.set(v, [list[0].to, list[1].to]);
      }
    }
    const gradField = (p: number[]) => {
      const e = H * 0.5;
      return [0, 1, 2].map((ax) => {
        const a = p.slice(), b = p.slice(); a[ax] += e; b[ax] -= e;
        return (sampleGrid(grid, field, a) - sampleGrid(grid, field, b)) / (2 * e);
      });
    };
    const projectField = (p: number[]) => {
      if (p[2] <= FLOOR + 0.01) return;
      for (let it = 0; it < 2; it++) {
        const val = sampleGrid(grid, field, p), n = gradField(p), l2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        if (l2 < 1e-12) return;
        for (let k = 0; k < 3; k++) p[k] -= (val * n[k]) / l2;
      }
    };
    for (let pass = 0; pass < 4; pass++) {
      for (const w of [0.40, -0.41]) {
        const next = new Map<number, number[]>();
        for (const [v, [a, b]] of smoothCurveVtx) {
          const pa = points[a], pv = points[v], pb = points[b];
          const cx = pb[0] - pa[0], cy = pb[1] - pa[1], cz = pb[2] - pa[2];
          const c2 = cx * cx + cy * cy + cz * cz;
          if (c2 < 1e-12) continue;
          const t = ((pv[0] - pa[0]) * cx + (pv[1] - pa[1]) * cy + (pv[2] - pa[2]) * cz) / c2;
          const q = [
            pv[0] + w * (pa[0] + t * cx - pv[0]),
            pv[1] + w * (pa[1] + t * cy - pv[1]),
            pv[2] + w * (pa[2] + t * cz - pv[2]),
          ];
          projectField(q);
          next.set(v, q);
        }
        for (const [v, q] of next) points[v] = q;
      }
    }
  }
  const used = new Map<string, number>();
  const panels = panelTris.map((p) => {
    const c = [0, 0, 0], votes = new Map<Part, number>();
    for (const t of p) for (let q = 0; q < 3; q++) { const pt = points[tris[3 * t + q]]; for (let k = 0; k < 3; k++) c[k] += pt[k] / (3 * p.length); }
    for (let i = 0; i < p.length; i += Math.max(1, Math.floor(p.length / 40))) { const part = nearest(points[tris[3 * p[i]]]); votes.set(part, (votes.get(part) ?? 0) + 1); }
    const part = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    const cover = covers.get(part)!, tag = part.slice(-1);
    const fb = c[1] < centreY(c[2]) ? 'front' : 'back';
    const ring = rings.get(part);
    const opened = fb === 'front' && plan.seams.some((o) => o.kind === 'frontOpening');
    const name = cover.names === 'gore' ? 'gore'
      : cover.names === 'sleeve' ? `sleeve${tag}${ring !== undefined ? (alongLimb(part, c) < ring ? 'Upper' : 'Lower') : ''}`
        : cover.names === 'frontBackSide' || opened ? `${fb}${c[0] > 0 ? 'L' : 'R'}` : fb;
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    return { name: cover.names === 'gore' || n > 1 ? `${name}${n}` : name, tris: p };
  });
  // What reaches below the floor lies on it, out from the body: a floor-length
  // hem pools, a train spreads out behind; flattened from the unpooled cut,
  // with bent limbs straightened as a pattern is cut.
  const cut = points.map((p) => {
    const part = nearest(p), limb = limbOf(part) ?? (covers.get(part)?.web ? limbs[covers.get(part)!.web!.limb] : null);
    return limb && limb.path.bend > 0 ? limb.path.straighten(p) : p.slice();
  });
  for (const p of points) {
    if (p[2] >= FLOOR) continue;
    const cy = centreY(L.hipZ), dx = p[0], dy = p[1] - cy, l = Math.hypot(dx, dy) || 1;
    p[0] += (dx / l) * (FLOOR - p[2]); p[1] += (dy / l) * (FLOOR - p[2]); p[2] = FLOOR;
  }
  return compact({ points, cut, tris, seams, panels, edges });
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
  const n = Math.max(2, Math.ceil(along / 0.03)), z0 = limb.path.at(0)[2];
  const a: number[][] = [], b: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const s = (along * i) / n, sec = limb.section(s);
    a.push([sec.c[0], sec.c[1], sec.c[2] - sec.h]);
    b.push(sideAt(z0 - (depth * i) / n));
  }
  // Each pair of points' normal, from the strip's surface there.
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const unit = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
  const normals: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const j = Math.min(n - 1, i), along3 = a[j + 1].map((v, k) => v - a[j][k]), across = b[i].map((v, k) => v - a[i][k]);
    normals.push(unit(cross(along3, across)));
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
