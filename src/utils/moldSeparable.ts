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

export interface SplitOpenMoldResult {
  bottomTris: Triangle3D[];
  pieceTriangles: [number, number];
  /** Shift applied to Half 1 (+shift) and Half 2 (-shift) to close the 6 mm plate gap before pouring. */
  closeShiftMm: [number, number];
  clips: [Triangle3D[], Triangle3D[]];
}

/**
 * Splits a 1-piece open rigid mold across the middle of its long edges into two
 * halves (spaced 6 mm apart on Z = 0) with a floor/wall labyrinth seal, tapered
 * vertical dovetail rails, and two vertical sliding C-clips laid out beside it.
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

    const footSlice = keep(local.slice(bb.min[2] + Math.min(1.0, blockH * 0.2)));
    const footPts = footSlice.toPolygons().flat();
    if (footPts.length < 3) return null;

    let uMin = Infinity, vAtMin = 0, uMax = -Infinity, vAtMax = 0;
    for (const [u, v] of footPts) {
      if (u < uMin) { uMin = u; vAtMin = v; }
      if (u > uMax) { uMax = u; vAtMax = v; }
    }
    const spanV = bb.max[1] - bb.min[1];
    const dx = uMax - uMin, dy = vAtMax - vAtMin;
    const dLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / dLen, ny = dx / dLen; // toward +v
    const cLine = uMin * nx + vAtMin * ny;

    const DOVE_H = 3.6;
    const flare = 1.8;
    const CLIP_CLEAR = 0.25;
    const taper = Math.min(0.45, Math.max(0.2, blockH * 0.007));
    const neckTop = Math.min(5.0, Math.max(3.2, spanV * 0.14));
    const neckBot = neckTop + taper;

    // Preserve the cavity by subtracting (bounding box \ local) above Z = 0.5.
    const big = Math.max(uMax - uMin, spanV) + 40;
    const cavProbe = keep(wasm.Manifold.cube([big, big, blockH + 1]).translate([-big / 2, -big / 2, bb.min[2] + 0.2]));
    const cavitySpace = keep(cavProbe.subtract(local));

    const additions: Manifold[] = [local];
    const clipsBed: Manifold[] = [];
    for (const sx of [-1, 1] as const) {
      const uOut = sx > 0 ? uMax : uMin;
      const vAt = sx > 0 ? vAtMax : vAtMin;
      const sink = Math.min(Math.max(1.5, wallMarginMm * 0.4), 4.0);
      const railTrap = (neck: number, z0: number) => {
        const cs = keep(poly2D(wasm, [
          [uOut - sx * sink, vAt - neck],
          [uOut + sx * DOVE_H, vAt - (neck + flare)],
          [uOut + sx * DOVE_H, vAt + (neck + flare)],
          [uOut - sx * sink, vAt + neck],
        ]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      additions.push(keep(wasm.Manifold.hull([railTrap(neckBot, bb.min[2]), railTrap(neckTop, bb.max[2] - 0.02)])));

      // Matching vertical sliding C-clip.
      const cFlank = CLIP_CLEAR / Math.cos(Math.atan2(flare, DOVE_H));
      const uFront = uOut + sx * 0.35;
      const dBack = DOVE_H + 0.35;
      const uBack = uOut + sx * dBack;
      const clipJaw = 3.2;
      const uSpine = uBack + sx * 3.4;
      const wNeckAt = (zRel: number) => neckBot - (taper / blockH) * zRel;
      const vPocketAt = (zRel: number, d: number) => wNeckAt(zRel) + cFlank + d * (flare / DOVE_H);

      const outerAt = (zRel: number, z0: number) => {
        const vOut = vPocketAt(zRel, dBack) + clipJaw;
        const cs = keep(poly2D(wasm, [[uFront, vAt - vOut], [uSpine, vAt - vOut], [uSpine, vAt + vOut], [uFront, vAt + vOut]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      let clipBody = keep(wasm.Manifold.hull([outerAt(0, 0), outerAt(blockH, blockH - 0.02)]));
      if (blockH >= 12) {
        const vTop = vPocketAt(blockH, dBack) + clipJaw;
        const tab0 = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vAt - vTop], [uSpine, vAt - vTop], [uSpine, vAt + vTop], [uSpine - sx * 0.4, vAt + vTop]]).extrude(0.02)).translate([0, 0, blockH - 5.2]));
        const tab1 = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vAt - vTop], [uSpine + sx * 2.4, vAt - vTop], [uSpine + sx * 2.4, vAt + vTop], [uSpine - sx * 0.4, vAt + vTop]]).extrude(2.4)).translate([0, 0, blockH - 2.4]));
        clipBody = keep(clipBody.add(keep(wasm.Manifold.hull([tab0, tab1]))));
      }
      const pocketAt = (zRel: number, z0: number) => {
        const d0 = -0.5;
        const v0 = vPocketAt(zRel, d0), v1 = vPocketAt(zRel, dBack);
        const cs = keep(poly2D(wasm, [[uOut + sx * d0, vAt - v0], [uBack, vAt - v1], [uBack, vAt + v1], [uOut + sx * d0, vAt + v0]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      const pocket = keep(wasm.Manifold.hull([pocketAt(-0.5, -0.5), pocketAt(blockH + 0.5, blockH + 0.48)]));
      const clip = keep(largestLump(clipBody.subtract(pocket)));
      const cb = clip.boundingBox();
      clipsBed.push(keep(clip.translate([-(cb.min[0] + cb.max[0]) / 2, -(cb.min[1] + cb.max[1]) / 2, -cb.min[2]])));
    }

    const withRails = keep(keep(wasm.Manifold.union(additions)).subtract(cavitySpace));

    // Floor labyrinth V-seal across the split chord inside the solid floor (45° ramps, zero overhang).
    let tongueSolid: Manifold | null = null;
    let grooveSolid: Manifold | null = null;
    if (baseFloorMm >= 4.2 && uMax - uMin > 10) {
      const zMid = Math.min(baseFloorMm * 0.5, 2.6);
      const hHalf = Math.min(1.1, zMid - 0.8);
      if (hHalf >= 0.6) {
        const chordAng = (Math.atan2(vAtMax - vAtMin, uMax - uMin) * 180) / Math.PI;
        const len = Math.max(2, dLen - 6);
        const cx = (uMin + uMax) / 2, cy = (vAtMin + vAtMax) / 2;
        const makeBar = (dOut: number, h: number) => {
          const b0 = keep(wasm.Manifold.cube([len, 0.4, 2 * h]).translate([-len / 2, -0.4, zMid - h]));
          const b1 = keep(wasm.Manifold.cube([len, 0.4 + dOut, 0.04]).translate([-len / 2, -0.4, zMid - 0.02]));
          const bar = keep(wasm.Manifold.hull([b0, b1]));
          return keep(keep(bar.rotate([0, 0, chordAng])).translate([cx, cy, bb.min[2]]));
        };
        tongueSolid = keep(makeBar(1.1, hHalf).intersect(withRails));
        grooveSolid = makeBar(1.38, hHalf + 0.25);
      }
    }

    let half1 = keep(withRails.trimByPlane([-nx, -ny, 0], -cLine));
    let half2 = keep(withRails.trimByPlane([nx, ny, 0], cLine));
    if (tongueSolid && grooveSolid) {
      half1 = keep(half1.add(tongueSolid));
      half2 = keep(half2.subtract(grooveSolid));
    }
    half1 = keep(largestLump(half1));
    half2 = keep(largestLump(half2));

    const GAP_HALF = 3; // 6 mm gap on plate so slicers never fuse the halves
    const h1Spaced = fromLocal(keep(half1.translate([-nx * GAP_HALF, -ny * GAP_HALF, -bb.min[2]])));
    const h2Spaced = fromLocal(keep(half2.translate([nx * GAP_HALF, ny * GAP_HALF, -bb.min[2]])));

    const hb1 = h1Spaced.boundingBox(), hb2 = h2Spaced.boundingBox();
    const maxMoldX = Math.max(hb1.max[0], hb2.max[0]);
    let curX = maxMoldX + 6;
    const placedClips = clipsBed.map((c) => {
      const cb = c.boundingBox();
      const w = cb.max[0] - cb.min[0];
      const placed = keep(c.translate([curX + w / 2, 0, 0]));
      curX += w + 6;
      return manifoldToTriangles(placed);
    }) as [Triangle3D[], Triangle3D[]];

    const closeLocal: [number, number] = [nx * GAP_HALF, ny * GAP_HALF];
    const closeWorld: [number, number] = turn90 ? [closeLocal[1], -closeLocal[0]] : closeLocal;
    const t1 = manifoldToTriangles(h1Spaced);
    const t2 = manifoldToTriangles(h2Spaced);

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
 * Adds 45°-printable T-slot clamping brackets near the parting face of both
 * clamshell halves, plus two horizontal-sliding wedge C-clips (stood upright on
 * Z = 0 beside the lid) that clamp the halves together without binder clips.
 */
export function addClamshellSlidingClips(
  wasm: ManifoldToplevel,
  platedBottomTris: Triangle3D[],
  platedTopTris: Triangle3D[],
  bottomPartingZ: number,
  topPartingZ: number,
): ClamshellClipsResult | null {
  if (bottomPartingZ < 7.2 || topPartingZ < 7.2) return null;
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
    let bot = keep(rawBot.translate([-botCx, 0, -bbB.min[2]]));
    let top = keep(rawTop.translate([-topCx, 0, -bbT.min[2]]));

    const b0 = bot.boundingBox();
    const spanX = b0.max[0] - b0.min[0], spanY = b0.max[1] - b0.min[1];
    const turn90 = spanX > spanY + 1e-6;
    if (turn90) {
      bot = keep(bot.rotate([0, 0, 90]));
      top = keep(top.rotate([0, 0, 90]));
    }
    const fromLocal = (m: Manifold) => (turn90 ? keep(m.rotate([0, 0, -90])) : m);

    const lb = bot.boundingBox();
    const spanV = lb.max[1] - lb.min[1];
    const railLen = Math.min(24, Math.max(12, spanV * 0.4));

    const sliceBot = keep(bot.slice(bottomPartingZ - 0.5));
    const pts = sliceBot.toPolygons().flat();
    let uMin = Infinity, uMax = -Infinity;
    for (const [u, v] of pts) {
      if (Math.abs(v) <= railLen * 0.6) {
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
      }
    }
    if (!Number.isFinite(uMin) || !Number.isFinite(uMax)) {
      uMin = lb.min[0];
      uMax = lb.max[0];
    }

    const BRACKET_OUT = 4.6;
    const TIP_H = 2.6;
    const SLOT_DEPTH = 2.1;
    const TAPER = 0.35;

    const addBrackets = (half: Manifold, zTop: number): Manifold => {
      const big = Math.max(uMax - uMin, spanV) + 40;
      const probe = keep(wasm.Manifold.cube([big, big, zTop + 1]).translate([-big / 2, -big / 2, 0.2]));
      const cav = keep(probe.subtract(half));

      const brackets: Manifold[] = [half];
      const slots: Manifold[] = [];
      for (const sx of [-1, 1] as const) {
        const uOut = sx > 0 ? uMax : uMin;
        const sink = 2.0;
        const profileAt = (tipH: number, v0: number) => {
          const zUnderRoot = zTop - tipH - (BRACKET_OUT + sink);
          const cs = keep(poly2D(wasm, [
            [uOut - sx * sink, Math.max(0.2, zUnderRoot)],
            [uOut + sx * BRACKET_OUT, zTop - tipH],
            [uOut + sx * BRACKET_OUT, zTop],
            [uOut - sx * sink, zTop],
          ]));
          const s = keep(keep(cs.extrude(0.02)).rotate([90, 0, 0]));
          return keep(s.translate([0, v0 + 0.02, 0]));
        };
        const bNeg = profileAt(TIP_H, -railLen / 2);
        const bPos = profileAt(TIP_H + TAPER, railLen / 2 - 0.02);
        brackets.push(keep(wasm.Manifold.hull([bNeg, bPos])));

        // Upward-facing T-slot cut down from zTop (0° overhang!).
        const uSlot0 = sx > 0 ? uOut + 1.1 : uOut - 2.7;
        const uSlot1 = sx > 0 ? uOut + 2.7 : uOut - 1.1;
        slots.push(keep(wasm.Manifold.cube([uSlot1 - uSlot0, railLen + 2, SLOT_DEPTH + 0.5])
          .translate([uSlot0, -railLen / 2 - 1, zTop - SLOT_DEPTH])));
      }
      const joined = keep(wasm.Manifold.union(brackets));
      const slotted = keep(joined.subtract(keep(wasm.Manifold.union(slots))));
      return keep(largestLump(slotted.subtract(cav)));
    };

    const botWithRails = fromLocal(addBrackets(bot, bottomPartingZ));
    const topWithRails = fromLocal(addBrackets(top, topPartingZ));

    // Build the matching horizontal-sliding C-clip, stood upright on Z = 0 (extruded along Z = railLen).
    const CLEAR = 0.28;
    const jawWall = 3.0;
    const spineW = 3.2;
    const xJawTip = BRACKET_OUT - 3.2;
    const xOuter = BRACKET_OUT + CLEAR;
    const xSpine = xOuter + spineW;
    const tHalf = SLOT_DEPTH - 0.35;
    const xTongueIn = 1.45;
    const hMax = TIP_H + TAPER + CLEAR + (xOuter - xJawTip);

    const outerCs = keep(poly2D(wasm, [
      [xJawTip, -hMax - jawWall],
      [xSpine, -hMax * 0.55 - jawWall],
      [xSpine, hMax * 0.55 + jawWall],
      [xJawTip, hMax + jawWall],
    ]));
    const clipOuter = keep(outerCs.extrude(railLen));

    const bracketPocket = (signY: -1 | 1) => {
      const slabAt = (tipH: number, z0: number) => {
        const hTip = tipH + CLEAR;
        const xIn = xJawTip - 2.0;
        const hIn = hTip + (xOuter - xIn);
        const cs = keep(poly2D(wasm, [
          [xIn, signY * tHalf],
          [xOuter, signY * tHalf],
          [xOuter, signY * hTip],
          [xIn, signY * hIn],
        ]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, z0]));
      };
      const slope = TAPER / railLen;
      return keep(wasm.Manifold.hull([
        slabAt(TIP_H + TAPER + slope * 0.5, -0.5),
        slabAt(TIP_H - slope * 0.5, railLen + 0.48),
      ]));
    };
    const rootClear = keep(wasm.Manifold.cube([xTongueIn - (xJawTip - 2.5), 2 * (tHalf + 0.05), railLen + 2])
      .translate([xJawTip - 2.5, -(tHalf + 0.05), -1]));
    const clipRaw = keep(largestLump(clipOuter.subtract(bracketPocket(1)).subtract(bracketPocket(-1)).subtract(rootClear)));
    const cb = clipRaw.boundingBox();
    const clipCentred = keep(clipRaw.translate([-(cb.min[0] + cb.max[0]) / 2, -(cb.min[1] + cb.max[1]) / 2, -cb.min[2]]));

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
      bottomTris: manifoldToTriangles(platedBot),
      topTris: manifoldToTriangles(platedTop),
      clips: [manifoldToTriangles(clip1), manifoldToTriangles(clip2)],
    };
  } finally {
    for (const x of new Set(trash)) {
      try { x.delete(); } catch { /* already freed */ }
    }
  }
}
