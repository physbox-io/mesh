// ---------------------------------------------------------------------------
// A pipe frame, made from its cut list
// ---------------------------------------------------------------------------
//
// The Pipes dialog hands over a cut list, and the cut list is not the model.
// This makes the frame from it, the way the shop would: every tube cut to its
// listed length and pushed home in its start hub, against the shoulder the hub
// puts the pipe stop at. What is left between its far end and the far hub's
// shoulder is the gap at that joint, short or long; tubes whose ends run into
// each other inside a hub are a clash.

import type { PipeFrameBreakdownResult } from './tubeAndWireExporter';
import { enclosedVolume } from './simulationMesh';
import type { StockTransform } from './reliefCarveExporter';
import type { AddSimulationRequest } from '../hooks/useAddSimulation';

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

/** Any unit vector square to unit `d`. */
const across = (d: V3): V3 => norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));

export interface TubeSimMesh {
  /** mm, Z up, in the model's frame. */
  positions: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
}

/** Closed pieces into one mesh, each turned outward by its own volume. */
class Pieces {
  positions: number[] = [];
  faces: number[] = [];
  push(pts: V3[], tris: number[]) {
    const base = this.positions.length / 3;
    const v = enclosedVolume(pts.flat(), tris);
    for (const p of pts) this.positions.push(p[0], p[1], p[2]);
    for (let i = 0; i < tris.length; i += 3) {
      if (v >= 0) this.faces.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
      else this.faces.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    }
  }
  mesh(): TubeSimMesh {
    const positions = new Float32Array(this.positions);
    const faces = new Uint32Array(this.faces);
    return { positions, faces, volumeMm3: enclosedVolume(positions, faces) };
  }
}

/**
 * A tube between rings: `outer[k]` and `inner[k]` are the k-th ring's corners
 * round the outside and the inside, the same count each, walked the same way.
 * Its ends are the first and last rings. With no inside it is a solid rod.
 */
function ringTube(outer: V3[][], inner: V3[][] | null): { pts: V3[]; tris: number[] } {
  const n = outer[0].length;
  const rings = outer.length;
  const pts: V3[] = [...outer.flat(), ...(inner ? inner.flat() : [])];
  const o = (k: number, i: number) => k * n + (i % n);
  const q = (k: number, i: number) => rings * n + k * n + (i % n);
  const tris: number[] = [];
  for (let k = 0; k + 1 < rings; k++) {
    for (let i = 0; i < n; i++) {
      tris.push(o(k, i), o(k, i + 1), o(k + 1, i + 1), o(k, i), o(k + 1, i + 1), o(k + 1, i));
      if (inner) tris.push(q(k, i), q(k + 1, i + 1), q(k, i + 1), q(k, i), q(k + 1, i), q(k + 1, i + 1));
    }
  }
  const last = rings - 1;
  if (inner) {
    for (let i = 0; i < n; i++) {
      tris.push(o(0, i), q(0, i), q(0, i + 1), o(0, i), q(0, i + 1), o(0, i + 1));
      tris.push(o(last, i), o(last, i + 1), q(last, i + 1), o(last, i), q(last, i + 1), q(last, i));
    }
  } else {
    // Fans from each end's centre.
    const c0 = pts.length, c1 = pts.length + 1;
    const mid = (ring: V3[]) => scale(ring.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / ring.length);
    pts.push(mid(outer[0]), mid(outer[last]));
    for (let i = 0; i < n; i++) {
      tris.push(c0, o(0, i + 1), o(0, i));
      tris.push(c1, o(last, i), o(last, i + 1));
    }
  }
  return { pts, tris };
}

const ring = (centre: V3, u: V3, v: V3, r: number, n: number, phase = 0): V3[] =>
  Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return add(centre, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
  });

/** A straight tube, or a rod when `innerR` is 0, from `start` along unit `dir`. */
function straightTube(pieces: Pieces, start: V3, dir: V3, length: number, outerR: number, innerR: number, n = 32) {
  const u = across(dir), v = cross(dir, u);
  const end = add(start, scale(dir, length));
  const { pts, tris } = ringTube(
    [ring(start, u, v, outerR, n), ring(end, u, v, outerR, n)],
    innerR > 0 ? [ring(start, u, v, innerR, n), ring(end, u, v, innerR, n)] : null
  );
  pieces.push(pts, tris);
}

// ---------------------------------------------------------------------------
// The pipe frame
// ---------------------------------------------------------------------------

export interface PipeJointGap {
  strutId: string;
  name: string;
  /** Far end of the tube to the far hub's shoulder, mm: positive is short, negative is long. */
  gapMm: number;
}

export interface PipeHubClash {
  hubId: string;
  name: string;
  /** How far two tubes' ends run into each other inside the hub, mm. */
  overlapMm: number;
  struts: [string, string];
}

export interface PipeFrameSimulation extends TubeSimMesh {
  tubes: number;
  gaps: PipeJointGap[];
  /** The largest gap at any joint, either way, mm. */
  maxGapMm: number;
  clashes: PipeHubClash[];
}

export function simulatePipeFrame(b: Pick<PipeFrameBreakdownResult, 'pipeSpec' | 'struts' | 'hubs' | 'sticks'>): PipeFrameSimulation {
  const ro = b.pipeSpec.odMm / 2, ri = b.pipeSpec.idMm / 2;
  const hubs = new Map(b.hubs.map((h) => [h.id, h]));
  // What the cut list says to cut for each strut: every piece of it on every stick, end to end.
  const cut = new Map<string, number>();
  for (const stick of b.sticks) {
    for (const c of stick.cuts) cut.set(c.strutId, (cut.get(c.strutId) ?? 0) + c.cutLengthMm);
  }

  const pieces = new Pieces();
  const gaps: PipeJointGap[] = [];
  for (const s of b.struts) {
    const h0 = hubs.get(s.startHubId), h1 = hubs.get(s.endHubId);
    const p0 = h0?.ports.find((p) => p.strutId === s.id), p1 = h1?.ports.find((p) => p.strutId === s.id);
    const length = cut.get(s.id);
    if (!h0 || !h1 || !p0 || !p1 || !length) continue;
    // Pushed home against the start hub's shoulder.
    const start = add(h0.centerMm, scale(p0.dir, p0.shoulderOffsetMm));
    const end = add(start, scale(p0.dir, length));
    const stop = add(h1.centerMm, scale(p1.dir, p1.shoulderOffsetMm));
    // Along the far port, back towards the hub: how far the end is short of its stop.
    gaps.push({ strutId: s.id, name: s.name, gapMm: dot(sub(end, stop), p1.dir) });
    straightTube(pieces, start, p0.dir, length, ro, ri);
  }

  // Two tubes' ends in one hub: the near rims of the end faces, a shoulder
  // out along each port, are clear of each other when the shoulder is at
  // least (OD / 2) / tan(half the angle between them).
  const clashes: PipeHubClash[] = [];
  for (const h of b.hubs) {
    for (let i = 0; i < h.ports.length; i++) {
      for (let j = i + 1; j < h.ports.length; j++) {
        const a = h.ports[i], c = h.ports[j];
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(a.dir, c.dir))));
        if (angle > Math.PI - 1e-6) continue;
        const half = angle / 2;
        // Each end face's near rim, from the hub centre, along the bisector and across it.
        const shoulder = Math.min(a.shoulderOffsetMm, c.shoulderOffsetMm);
        const clear = shoulder * Math.sin(half) - ro * Math.cos(half);
        if (clear < -0.05) clashes.push({ hubId: h.id, name: h.name, overlapMm: -clear * 2, struts: [a.strutId, c.strutId] });
      }
    }
  }

  return {
    ...pieces.mesh(),
    tubes: gaps.length,
    gaps,
    maxGapMm: gaps.reduce((m, g) => Math.max(m, Math.abs(g.gapMm)), 0),
    clashes,
  };
}

const mmText = (v: number) => `${v.toFixed(2)} mm`;

/**
 * Add Simulation for the pipe frame, shared by the dialog and the MCP bridge.
 * `transform` is the scene's own place (`sceneStockTransform`): the frame is
 * made in the model's millimetres, so it lies over the model as it is.
 */
export function pipeFrameSimulationRequest(
  b: PipeFrameBreakdownResult,
  transform: StockTransform
): {
  figures: Record<string, unknown>;
  request: Omit<AddSimulationRequest, 'placement'>;
} {
  const sim = simulatePipeFrame(b);
  const worst = sim.gaps.reduce<PipeJointGap | null>((w, g) => (!w || Math.abs(g.gapMm) > Math.abs(w.gapMm) ? g : w), null);
  const deepest = sim.clashes.reduce<PipeHubClash | null>((w, c) => (!w || c.overlapMm > w.overlapMm ? c : w), null);
  return {
    figures: {
      tubes: sim.tubes,
      maxGapMm: +sim.maxGapMm.toFixed(3),
      worstJoint: worst ? { strut: worst.name, gapMm: +worst.gapMm.toFixed(3) } : null,
      clashes: sim.clashes.map((c) => ({ hub: c.name, overlapMm: +c.overlapMm.toFixed(2), struts: c.struts })),
    },
    request: {
      mesh: sim,
      transform,
      kind: 'tube',
      label: 'Pipe frame',
      details: [
        `${sim.tubes} lengths of ${b.pipeSpec.label}, cut as listed and pushed home at each start hub`,
        sim.maxGapMm < 0.05
          ? 'Every tube reaches the shoulder of the hub at its far end'
          : `**${worst!.name} ends ${mmText(Math.abs(worst!.gapMm))} ${worst!.gapMm > 0 ? 'short of' : 'past'} its far hub's shoulder**`,
        ...(deepest
          ? [`**${sim.clashes.length} hub${sim.clashes.length === 1 ? '' : 's'} where tubes run into each other**, ${mmText(deepest.overlapMm)} at ${deepest.name}`]
          : []),
        'Hubs not drawn: the dialog adds the printable ones to the scene',
      ],
    },
  };
}
