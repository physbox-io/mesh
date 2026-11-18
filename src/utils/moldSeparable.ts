// ---------------------------------------------------------------------------
// Separable open molds and self-clamping sliding clips for Rigid molds
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { manifoldToTriangles, type Triangle3D } from './moldManifold';

type Vec2 = [number, number];

function area2D(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function poly2D(wasm: ManifoldToplevel, pts: Vec2[]): CrossSection {
  const ccw = area2D(pts) >= 0 ? pts : [...pts].reverse();
  return wasm.CrossSection.ofPolygons([ccw], 'Positive');
}

function trianglesToSolid(wasm: ManifoldToplevel, tris: Triangle3D[]): Manifold | null {
  if (tris.length < 4) return null;
  const vertProperties = new Float32Array(tris.length * 9);
  const triVerts = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const o = i * 9;
    vertProperties[o] = t.a[0]; vertProperties[o + 1] = t.a[1]; vertProperties[o + 2] = t.a[2];
    vertProperties[o + 3] = t.b[0]; vertProperties[o + 4] = t.b[1]; vertProperties[o + 5] = t.b[2];
    vertProperties[o + 6] = t.c[0]; vertProperties[o + 7] = t.c[1]; vertProperties[o + 8] = t.c[2];
    triVerts[i * 3] = i * 3; triVerts[i * 3 + 1] = i * 3 + 1; triVerts[i * 3 + 2] = i * 3 + 2;
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
  mesh.merge();
  const m = new wasm.Manifold(mesh);
  if (m.status() !== 'NoError' || m.isEmpty()) {
    m.delete();
    return null;
  }
  return m;
}

function largestLump(m: Manifold): Manifold {
  const parts = m.decompose();
  if (parts.length <= 1) {
    for (const p of parts) p.delete();
    return m;
  }
  let best = 0, bestVol = -Infinity;
  parts.forEach((p, i) => {
    const v = p.volume();
    if (v > bestVol) { bestVol = v; best = i; }
  });
  parts.forEach((p, i) => { if (i !== best) p.delete(); });
  m.delete();
  return parts[best];
}

function cleanTriangles(m: Manifold): Triangle3D[] {
  const simplified = m.simplify(1e-3);
  const lump = largestLump(simplified);
  const tris = manifoldToTriangles(lump);
  lump.delete();
  return tris;
}

function uSpanAtV(cs: CrossSection, vTarget: number): [number, number] | null {
  let uMin = Infinity, uMax = -Infinity;
  for (const poly of cs.toPolygons()) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [u0, v0] = poly[i];
      const [u1, v1] = poly[(i + 1) % n];
      if (Math.abs(v0 - vTarget) <= 1e-6) {
        uMin = Math.min(uMin, u0);
        uMax = Math.max(uMax, u0);
      }
      if ((v0 < vTarget && v1 > vTarget) || (v1 < vTarget && v0 > vTarget)) {
        const u = u0 + ((vTarget - v0) / (v1 - v0)) * (u1 - u0);
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
      }
    }
  }
  return uMin <= uMax ? [uMin, uMax] : null;
}

function uSpanInBand(cs: CrossSection, vLo: number, vHi: number): [number, number] | null {
  let uMin = Infinity, uMax = -Infinity;
  for (const poly of cs.toPolygons()) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [u0, v0] = poly[i];
      const [u1, v1] = poly[(i + 1) % n];
      if (v0 >= vLo - 1e-6 && v0 <= vHi + 1e-6) {
        uMin = Math.min(uMin, u0);
        uMax = Math.max(uMax, u0);
      }
      for (const vt of [vLo, vHi]) {
        if ((v0 < vt && v1 > vt) || (v1 < vt && v0 > vt)) {
          const u = u0 + ((vt - v0) / (v1 - v0)) * (u1 - u0);
          uMin = Math.min(uMin, u);
          uMax = Math.max(uMax, u);
        }
      }
    }
  }
  return uMin <= uMax ? [uMin, uMax] : null;
}

/**
 * Extracts the outer positive perimeter contour(s) of `solid` near the print bed
 * (with interior sprue/vent through-holes filled).
 */
function outerFootprint(
  wasm: ManifoldToplevel,
  solid: Manifold,
  zSlice: number,
  keep: <T extends Manifold | CrossSection>(x: T) => T,
): CrossSection | null {
  const sl = keep(solid.slice(zSlice));
  const outerPolys = sl.toPolygons().filter((c) => area2D(c) > 0);
  if (outerPolys.length === 0) return null;
  return keep(wasm.CrossSection.ofPolygons(outerPolys, 'Positive'));
}

/**
 * Builds the interior cavity/channel/socket void inside `half` without including
 * exterior air outside the mold block, so subtracting it preserves internal
 * cavities while keeping 100% of exterior rails and clamping flanges.
 */
function interiorCavityOf(
  wasm: ManifoldToplevel,
  half: Manifold,
  zBase: number,
  zTop: number,
  keep: <T extends Manifold | CrossSection>(x: T) => T,
): Manifold | null {
  const h = zTop - zBase;
  if (h <= 0.2) return null;
  const outerCs = outerFootprint(wasm, half, zBase + Math.min(0.1, h * 0.2), keep);
  if (!outerCs) return null;
  // Inset by 0.05 mm so float32 jitter on vertical outer walls never leaves skin
  // slivers across the root of exterior rails/flanges.
  const innerEnvCs = keep(outerCs.offset(-0.05, 'Miter', 2));
  if (innerEnvCs.isEmpty()) return null;
  const moldEnvelope = keep(keep(innerEnvCs.extrude(h - 0.05)).translate([0, 0, zBase + 0.05]));
  return keep(moldEnvelope.subtract(half));
}

export interface SplitOpenMoldResult {
  bottomTris: Triangle3D[];
  pieceTriangles: [number, number];
  /** Shift applied to Half 1 (+shift) and Half 2 (-shift) to close the 6 mm plate gap before pouring. */
  closeShiftMm: [number, number];
  clips: [Triangle3D[], Triangle3D[]];
}

/**
 * Splits a 1-piece open rigid mold orthogonally across the middle of its long
 * edges into two halves (spaced 6 mm apart on Z = 0) with a floor labyrinth seal,
 * tapered vertical dovetail rails, and two vertical sliding C-clips laid out beside it.
 */
export function splitOpenRigidMold(
  wasm: ManifoldToplevel,
  openTris: Triangle3D[],
  baseFloorMm: number,
  wallMarginMm: number,
): SplitOpenMoldResult | null {
  const raw = trianglesToSolid(wasm, openTris);
  if (!raw) return null;
  const trash: (Manifold | CrossSection)[] = [];
  const keep = <T extends Manifold | CrossSection>(x: T) => (trash.push(x), x);
  keep(raw);
  try {
    const bb0 = raw.boundingBox();
    const turn90 = (bb0.max[0] - bb0.min[0]) > (bb0.max[1] - bb0.min[1]) + 1e-6;
    const local = turn90 ? keep(raw.rotate([0, 0, 90])) : raw;
    const fromLocal = (m: Manifold) => (turn90 ? keep(m.rotate([0, 0, -90])) : m);

    const bb = local.boundingBox();
    const blockH = bb.max[2] - bb.min[2];
    if (blockH < 5) return null;

    const footCs = outerFootprint(wasm, local, bb.min[2] + Math.min(0.1, blockH * 0.2), keep);
    if (!footCs) return null;

    const spanV = bb.max[1] - bb.min[1];
    const vMid = Math.round(((bb.min[1] + bb.max[1]) / 2) * 16) / 16;

    const DOVE_H = 3.6;
    const flare = 1.8;
    const CLIP_CLEAR = 0.25;
    const taper = Math.min(0.45, Math.max(0.2, blockH * 0.007));
    const neckTop = Math.min(5.0, Math.max(3.2, spanV * 0.14));
    const neckBot = neckTop + taper;
    const cFlank = CLIP_CLEAR / Math.cos(Math.atan2(flare, DOVE_H));
    const dBack = DOVE_H + 0.35;
    const clipJaw = 3.2;
    const clipBandHalfV = neckBot + cFlank + dBack * (flare / DOVE_H) + clipJaw + 0.5;

    const midSpan = uSpanAtV(footCs, vMid) ?? [bb.min[0], bb.max[0]];
    const bandSpan = uSpanInBand(footCs, vMid - clipBandHalfV, vMid + clipBandHalfV) ?? midSpan;
    const uOutNeg = Math.min(midSpan[0], bandSpan[0]);
    const uOutPos = Math.max(midSpan[1], bandSpan[1]);

    // Sample wall span across the rail footprint so curved 'fit' walls anchor cleanly.
    let uWallNeg = uOutNeg, uWallPos = uOutPos;
    const padHalfV = neckBot + 0.8;
    for (let k = 0; k <= 12; k++) {
      const vk = vMid - padHalfV + (2 * padHalfV * k) / 12;
      const sp = uSpanAtV(footCs, vk);
      if (sp) {
        uWallNeg = Math.max(uWallNeg, sp[0]);
        uWallPos = Math.min(uWallPos, sp[1]);
      }
    }

    const interiorCavity = interiorCavityOf(wasm, local, bb.min[2], bb.max[2], keep);

    const railAdditions: Manifold[] = [];
    const clipsBed: Manifold[] = [];
    for (const sx of [-1, 1] as const) {
      const uOut = sx > 0 ? uOutPos : uOutNeg;
      const uWallIn = sx > 0 ? uWallPos : uOutNeg === uWallNeg ? uOutNeg : uWallNeg;
      const sinkBase = Math.min(Math.max(1.8, wallMarginMm * 0.4), 4.0);
      const uIn = uWallIn - sx * sinkBase;

      if (sx * (uOut - uWallIn) > 0.05) {
        const padCs = keep(poly2D(wasm, [
          [uIn, vMid - padHalfV],
          [uOut, vMid - padHalfV],
          [uOut, vMid + padHalfV],
          [uIn, vMid + padHalfV],
        ]));
        railAdditions.push(keep(keep(padCs.extrude(blockH)).translate([0, 0, bb.min[2]])));
      }

      const anchorCs = keep(poly2D(wasm, [
        [uIn, vMid - neckTop],
        [uOut, vMid - neckTop],
        [uOut, vMid + neckTop],
        [uIn, vMid + neckTop],
      ]));
      railAdditions.push(keep(keep(anchorCs.extrude(blockH)).translate([0, 0, bb.min[2]])));

      const dIn = 0.5;
      const wInDelta = dIn * (flare / DOVE_H);
      const railTrap = (neck: number, z0: number) => {
        const cs = keep(poly2D(wasm, [
          [uOut - sx * dIn, vMid - (neck - wInDelta)],
          [uOut + sx * DOVE_H, vMid - (neck + flare)],
          [uOut + sx * DOVE_H, vMid + (neck + flare)],
          [uOut - sx * dIn, vMid + (neck - wInDelta)],
        ]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      railAdditions.push(keep(wasm.Manifold.hull([railTrap(neckBot, bb.min[2]), railTrap(neckTop, bb.max[2] - 0.02)])));

      // Matching vertical sliding C-clip centered at v = vMid.
      const uFront = uOut + sx * 0.35;
      const uBack = uOut + sx * dBack;
      const uSpine = uBack + sx * 3.4;
      const wNeckAt = (zRel: number) => neckBot - (taper / blockH) * zRel;
      const vPocketAt = (zRel: number, d: number) => wNeckAt(zRel) + cFlank + d * (flare / DOVE_H);

      const outerAt = (zRel: number, z0: number) => {
        const vOut = vPocketAt(zRel, dBack) + clipJaw;
        const cs = keep(poly2D(wasm, [[uFront, vMid - vOut], [uSpine, vMid - vOut], [uSpine, vMid + vOut], [uFront, vMid + vOut]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      let clipBody = keep(wasm.Manifold.hull([outerAt(0, 0), outerAt(blockH, blockH - 0.02)]));
      if (blockH >= 12) {
        const vTop = vPocketAt(blockH, dBack) + clipJaw;
        const tab0 = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vMid - vTop], [uSpine, vMid - vTop], [uSpine, vMid + vTop], [uSpine - sx * 0.4, vMid + vTop]]).extrude(0.02)).translate([0, 0, blockH - 5.2]));
        const tab1 = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vMid - vTop], [uSpine + sx * 2.4, vMid - vTop], [uSpine + sx * 2.4, vMid + vTop], [uSpine - sx * 0.4, vMid + vTop]]).extrude(2.4)).translate([0, 0, blockH - 2.4]));
        clipBody = keep(clipBody.add(keep(wasm.Manifold.hull([tab0, tab1]))));
      }
      const pocketAt = (zRel: number, z0: number) => {
        const d0 = -0.5;
        const v0 = vPocketAt(zRel, d0), v1 = vPocketAt(zRel, dBack);
        const cs = keep(poly2D(wasm, [[uOut + sx * d0, vMid - v0], [uBack, vMid - v1], [uBack, vMid + v1], [uOut + sx * d0, vMid + v0]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      const pocket = keep(wasm.Manifold.hull([pocketAt(-0.5, -0.5), pocketAt(blockH + 0.5, blockH + 0.48)]));
      const clip = keep(largestLump(clipBody.subtract(pocket)));
      const cb = clip.boundingBox();
      clipsBed.push(keep(clip.translate([-(cb.min[0] + cb.max[0]) / 2, -(cb.min[1] + cb.max[1]) / 2, -cb.min[2]])));
    }

    let railsOnly = keep(wasm.Manifold.union(railAdditions));
    if (interiorCavity) {
      railsOnly = keep(railsOnly.subtract(interiorCavity));
    }
    const withRails = keep(local.add(railsOnly));

    // Floor labyrinth V-seal orthogonally along v = vMid inside the solid floor (<= 45° ramps, zero overhang).
    let tongueSolid: Manifold | null = null;
    let grooveSolid: Manifold | null = null;
    const uSpanMid = midSpan[1] - midSpan[0];
    if (baseFloorMm >= 4.2 && uSpanMid > 10) {
      const zMid = Math.min(baseFloorMm * 0.5, 2.6);
      const hHalf = Math.min(1.1, zMid - 0.8);
      if (hHalf >= 0.6) {
        const len = Math.max(2, uSpanMid - 6);
        const cx = 0.5 * (midSpan[0] + midSpan[1]);
        const makeBar = (barLen: number, dOut: number, h: number) => {
          const b0 = keep(wasm.Manifold.cube([barLen, 0.4, 2 * h]).translate([-barLen / 2, -0.4, zMid - h]));
          const b1 = keep(wasm.Manifold.cube([barLen, 0.4 + dOut, 0.04]).translate([-barLen / 2, -0.4, zMid - 0.02]));
          const bar = keep(wasm.Manifold.hull([b0, b1]));
          return keep(bar.translate([cx, vMid, bb.min[2]]));
        };
        tongueSolid = keep(makeBar(len, hHalf, hHalf).intersect(withRails));
        if (interiorCavity) tongueSolid = keep(tongueSolid.subtract(interiorCavity));
        grooveSolid = makeBar(len + 0.6, hHalf + 0.28, hHalf + 0.28);
      }
    }

    let half1 = keep(withRails.trimByPlane([0, -1, 0], -vMid));
    let half2 = keep(withRails.trimByPlane([0, 1, 0], vMid));
    if (tongueSolid && grooveSolid) {
      half1 = keep(half1.add(tongueSolid));
      half2 = keep(half2.subtract(grooveSolid));
    }
    half1 = keep(largestLump(half1));
    half2 = keep(largestLump(half2));

    const GAP_HALF = 3; // 6 mm gap on plate so slicers never fuse the halves
    const h1Spaced = fromLocal(keep(half1.translate([0, -GAP_HALF, -bb.min[2]])));
    const h2Spaced = fromLocal(keep(half2.translate([0, GAP_HALF, -bb.min[2]])));

    const hb1 = h1Spaced.boundingBox(), hb2 = h2Spaced.boundingBox();
    const maxMoldX = Math.max(hb1.max[0], hb2.max[0]);
    let curX = maxMoldX + 6;
    const placedClips = clipsBed.map((c) => {
      const cb = c.boundingBox();
      const w = cb.max[0] - cb.min[0];
      const placed = keep(c.translate([curX + w / 2, 0, 0]));
      curX += w + 6;
      return cleanTriangles(placed);
    }) as [Triangle3D[], Triangle3D[]];

    const closeWorld: [number, number] = turn90 ? [GAP_HALF, 0] : [0, GAP_HALF];
    const t1 = cleanTriangles(h1Spaced);
    const t2 = cleanTriangles(h2Spaced);

    return {
      bottomTris: [...t1, ...t2],
      pieceTriangles: [t1.length, t2.length],
      closeShiftMm: closeWorld,
      clips: placedClips,
    };
  } finally {
    for (const x of new Set(trash)) {
      try { x.delete(); } catch { /* already freed */ }
    }
  }
}

export interface ClamshellClipsResult {
  bottomTris: Triangle3D[];
  topTris: Triangle3D[];
  clips: [Triangle3D[], Triangle3D[]];
}

/**
 * Adds symmetric 45°-supported external clamping flanges flush with the parting
 * face of both clamshell halves, plus two support-free horizontal-sliding wedge
 * C-clips (stood upright on Z = 0 beside the lid). When `topHalf` flips 180°
 * about X onto `bottomHalf`, the two flanges form a double-45° hexagonal clamping
 * rail gripped cleanly by the C-clips with zero seam collision.
 */
export function addClamshellSlidingClips(
  wasm: ManifoldToplevel,
  platedBottomTris: Triangle3D[],
  platedTopTris: Triangle3D[],
  bottomPartingZ: number,
  topPartingZ: number,
): ClamshellClipsResult | null {
  if (bottomPartingZ < 6.8 || topPartingZ < 6.8) return null;
  const rawBot = trianglesToSolid(wasm, platedBottomTris);
  const rawTop = trianglesToSolid(wasm, platedTopTris);
  if (!rawBot || !rawTop) {
    rawBot?.delete();
    rawTop?.delete();
    return null;
  }
  const trash: (Manifold | CrossSection)[] = [];
  const keep = <T extends Manifold | CrossSection>(x: T) => (trash.push(x), x);
  keep(rawBot);
  keep(rawTop);
  try {
    const bbB = rawBot.boundingBox(), bbT = rawTop.boundingBox();
    const botCx = (bbB.min[0] + bbB.max[0]) / 2;
    const topCx = (bbT.min[0] + bbT.max[0]) / 2;
    const bot0 = keep(rawBot.translate([-botCx, 0, -bbB.min[2]]));
    const top0 = keep(rawTop.translate([-topCx, 0, -bbT.min[2]]));

    // Map top0 into closed-mold XY coordinates (x_closed = x_top, y_closed = -y_top)
    // while keeping its print-bed Z orientation (z = 0 on bed, z = topPartingZ at seam).
    // Anything built in this frame matches bottomHalf after flipping topHalf 180° about X!
    const topClosedXY = keep(top0.mirror([0, 1, 0]));

    const b0 = bot0.boundingBox();
    const spanX = b0.max[0] - b0.min[0], spanY = b0.max[1] - b0.min[1];
    const turn90 = spanX > spanY + 1e-6;
    const botL = turn90 ? keep(bot0.rotate([0, 0, 90])) : bot0;
    const topL = turn90 ? keep(topClosedXY.rotate([0, 0, 90])) : topClosedXY;
    const fromLocal = (m: Manifold) => (turn90 ? keep(m.rotate([0, 0, -90])) : m);

    const lb = botL.boundingBox();
    const spanV = lb.max[1] - lb.min[1];
    const vMid = Math.round(((lb.min[1] + lb.max[1]) / 2) * 16) / 16;
    const railLen = Math.min(22, Math.max(12, spanV * 0.34));

    const csBot = outerFootprint(wasm, botL, 0.1, keep);
    const csTop = outerFootprint(wasm, topL, 0.1, keep);
    if (!csBot || !csTop) return null;
    const closedCs = keep(wasm.CrossSection.union([csBot, csTop]));

    const vNeg = vMid - railLen / 2;
    const vPos = vMid + railLen / 2;
    const bandSpan = uSpanInBand(closedCs, vNeg - 0.5, vPos + 0.5) ?? [lb.min[0], lb.max[0]];
    let uOutNeg = bandSpan[0];
    let uOutPos = bandSpan[1];
    let uWallNeg = uOutNeg;
    let uWallPos = uOutPos;
    for (let k = 0; k <= 16; k++) {
      const vk = vNeg + (railLen * k) / 16;
      const sp = uSpanAtV(closedCs, vk);
      if (sp) {
        uWallNeg = Math.max(uWallNeg, sp[0]);
        uWallPos = Math.min(uWallPos, sp[1]);
      }
    }

    const FLANGE_W = 3.6;
    const H_FLANGE = 2.2;
    const TAPER = 0.35;
    const BEVEL_SLOPE = 1.02; // 44.4° (< 45°) overhang on print bed
    const CLEAR = 0.25;
    const dJawTip = 1.0;
    const minPartingZ = Math.min(bottomPartingZ, topPartingZ);

    // Keep +/-u symmetric when `!turn90` whenever zTop has room for the 45° bevel,
    // so (minX + maxX) / 2 stays at 0 even on asymmetric 'fit' molds.
    if (Math.abs(uOutPos + uOutNeg) > 1e-3) {
      const symU = Math.max(Math.abs(uOutPos), Math.abs(uOutNeg));
      const worstBridge = Math.max(symU - uWallPos, symU + uWallNeg);
      const zNeed = H_FLANGE + TAPER + BEVEL_SLOPE * (FLANGE_W + worstBridge + 1.0);
      if (minPartingZ - zNeed >= 0.25) {
        uOutPos = symU;
        uOutNeg = -symU;
      }
    }

    // Choose wedge taper direction so the C-clip slides off toward whichever end
    // of the mold does not widen past the clip jaws (defaults to sliding toward -v).
    const negTail = uSpanInBand(closedCs, lb.min[1] - 1, vNeg) ?? [uOutNeg, uOutPos];
    const posTail = uSpanInBand(closedCs, vPos, lb.max[1] + 1) ?? [uOutNeg, uOutPos];
    const negInterfere = Math.max(0, (uOutNeg - (dJawTip - 0.2)) - negTail[0], negTail[1] - (uOutPos + (dJawTip - 0.2)));
    const posInterfere = Math.max(0, (uOutNeg - (dJawTip - 0.2)) - posTail[0], posTail[1] - (uOutPos + (dJawTip - 0.2)));
    const taperSign: 1 | -1 = negInterfere > 0 && posInterfere < negInterfere ? -1 : 1;

    const hNeg = taperSign > 0 ? H_FLANGE : H_FLANGE + TAPER;
    const hPos = taperSign > 0 ? H_FLANGE + TAPER : H_FLANGE;

    // Fit flange protrusion inside minPartingZ so zRoot never clamps or exceeds 45°.
    const maxWallBridge = Math.max(uOutPos - uWallPos, uWallNeg - uOutNeg);
    const sink = Math.min(1.5, Math.max(0.8, (minPartingZ - (H_FLANGE + TAPER) - 0.3) / BEVEL_SLOPE - FLANGE_W - maxWallBridge));
    const flangeW = Math.min(
      FLANGE_W,
      Math.max(2.2, (minPartingZ - (H_FLANGE + TAPER) - 0.25) / BEVEL_SLOPE - maxWallBridge - sink),
    );
    if (flangeW < 2.2) return null;

    const addFlanges = (half: Manifold, zTop: number): Manifold => {
      const cav = interiorCavityOf(wasm, half, 0, zTop, keep);
      const flangeParts: Manifold[] = [];
      for (const sx of [-1, 1] as const) {
        const uOut = sx > 0 ? uOutPos : uOutNeg;
        const uWallIn = sx > 0 ? uWallPos : uWallNeg;
        const uIn = uWallIn - sx * sink;
        const bridge = Math.abs(uOut - uIn);
        const profileAt = (hFlange: number, v0: number) => {
          const zRoot = zTop - hFlange - BEVEL_SLOPE * (flangeW + bridge);
          const cs = keep(poly2D(wasm, [
            [uIn, zRoot],
            [uOut + sx * flangeW, zTop - hFlange],
            [uOut + sx * flangeW, zTop],
            [uIn, zTop],
          ]));
          const s = keep(keep(cs.extrude(0.02)).rotate([90, 0, 0]));
          return keep(s.translate([0, v0 + 0.02, 0]));
        };
        flangeParts.push(keep(wasm.Manifold.hull([
          profileAt(hNeg, vNeg),
          profileAt(hPos, vPos - 0.02),
        ])));
      }
      let flangesOnly = keep(wasm.Manifold.union(flangeParts));
      if (cav) flangesOnly = keep(flangesOnly.subtract(cav));
      return keep(largestLump(half.add(flangesOnly)));
    };

    const botWithRails = fromLocal(addFlanges(botL, bottomPartingZ));
    const topWithRails = keep(fromLocal(addFlanges(topL, topPartingZ)).mirror([0, 1, 0]));

    // Build the support-free C-clip directly in its 3D seated pose on the +u rail,
    // then rotate it upright onto Z = 0 (wide mouth down on the print bed).
    const dBack = flangeW + CLEAR;
    const jawWall = 2.8;
    const spineW = 3.2;
    const dSpine = dBack + spineW;
    const perpShift = CLEAR * Math.hypot(1, BEVEL_SLOPE);
    const tipUse = Math.min(dJawTip, flangeW - 1.4);

    const outerSlabAt = (h: number, v0: number) => {
      const uJaw = uOutPos + tipUse;
      const uSpine = uOutPos + dSpine;
      const dzJaw = h + BEVEL_SLOPE * (flangeW - tipUse) + perpShift + jawWall;
      const dzSpine = h - BEVEL_SLOPE * CLEAR + perpShift + jawWall;
      const cs = keep(poly2D(wasm, [
        [uJaw, bottomPartingZ - dzJaw],
        [uSpine, bottomPartingZ - dzSpine],
        [uSpine, bottomPartingZ + dzSpine],
        [uJaw, bottomPartingZ + dzJaw],
      ]));
      const s = keep(keep(cs.extrude(0.02)).rotate([90, 0, 0]));
      return keep(s.translate([0, v0 + 0.02, 0]));
    };
    const clipOuter = keep(wasm.Manifold.hull([
      outerSlabAt(hNeg, vNeg),
      outerSlabAt(hPos, vPos - 0.02),
    ]));

    const slopeV = (hPos - hNeg) / railLen;
    const pocketSlabAt = (h: number, v0: number) => {
      const uCut = uOutPos;
      const uBack = uOutPos + dBack;
      const pzCut = h + BEVEL_SLOPE * flangeW + perpShift;
      const pzBack = h - BEVEL_SLOPE * CLEAR + perpShift;
      const cs = keep(poly2D(wasm, [
        [uCut, bottomPartingZ - pzCut],
        [uBack, bottomPartingZ - pzBack],
        [uBack, bottomPartingZ + pzBack],
        [uCut, bottomPartingZ + pzCut],
      ]));
      const s = keep(keep(cs.extrude(0.02)).rotate([90, 0, 0]));
      return keep(s.translate([0, v0 + 0.02, 0]));
    };
    const clipPocket = keep(wasm.Manifold.hull([
      pocketSlabAt(hNeg - slopeV * 0.5, vNeg - 0.5),
      pocketSlabAt(hPos + slopeV * 0.5, vPos + 0.48),
    ]));

    const seatedPosLocal = keep(largestLump(clipOuter.subtract(clipPocket)));
    // Rotate upright so the wide mouth rests flat on Z = 0 (extruded vertically to Z = railLen).
    const uprightClip = keep(seatedPosLocal.rotate([taperSign > 0 ? -90 : 90, 0, 0]));
    const cb = uprightClip.boundingBox();
    const clipCentred = keep(uprightClip.translate([-(cb.min[0] + cb.max[0]) / 2, -(cb.min[1] + cb.max[1]) / 2, -cb.min[2]]));

    // Space bottomHalf, topHalf, and both clips on Z = 0 with >= 6 mm gaps.
    const bbBotOut = botWithRails.boundingBox(), bbTopOut = topWithRails.boundingBox();
    const halfSpan = Math.max(bbBotOut.max[0] - bbBotOut.min[0], bbTopOut.max[0] - bbTopOut.min[0]) / 2;
    const gap = 6;
    const off = halfSpan + gap / 2;
    const platedBot = keep(botWithRails.translate([-off, 0, 0]));
    const platedTop = keep(topWithRails.translate([off, 0, 0]));

    const clipW = cb.max[0] - cb.min[0];
    const clipD = cb.max[1] - cb.min[1];
    const clipX = off + halfSpan + gap + clipW / 2;
    const clip1 = keep(clipCentred.translate([clipX, -(clipD / 2 + gap / 2), 0]));
    const clip2 = keep(clipCentred.translate([clipX, clipD / 2 + gap / 2, 0]));

    return {
      bottomTris: cleanTriangles(platedBot),
      topTris: cleanTriangles(platedTop),
      clips: [cleanTriangles(clip1), cleanTriangles(clip2)],
    };
  } finally {
    for (const x of new Set(trash)) {
      try { x.delete(); } catch { /* already freed */ }
    }
  }
}
