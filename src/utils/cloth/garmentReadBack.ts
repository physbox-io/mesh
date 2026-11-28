/**
 * What an agent reads back about a garment: its draft as the builder reads it
 * (every setting its kind fills in, a collar's and lapels' numbers included),
 * and each piece as cut: its fabric, colour, flat size and how far it had to
 * stretch to lie flat. Without these, lengthening a sleeve meant knowing the
 * kind's defaults, and judging a pattern meant parsing its SVG.
 */

import type { GarmentDraft } from '../../types/cloth';
import { garmentSettings } from './garments';
import { COLLAR_DEFAULTS, LAPEL_DEFAULTS } from './garmentCollars';

const given = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<T>;

/** The draft with every setting the builder reads filled in from its kind (and a collar's and lapels' from theirs). */
export function resolvedGarmentDraft(draft: GarmentDraft): GarmentDraft {
  const s = garmentSettings(draft);
  return {
    ...s,
    ...(s.collar ? { collar: { ...COLLAR_DEFAULTS, ...given(s.collar) } } : {}),
    ...(s.lapels ? { lapels: { ...LAPEL_DEFAULTS, ...given(s.lapels) } } : {}),
  };
}

export interface PieceDetail {
  name: string;
  material?: string;
  rgba: number[];
  /** Its flat piece's width and height, mm (no seam allowance). */
  flatMm?: [number, number];
  /** How far the 95th-percentile triangle stretched to lie flat, as a fraction. */
  strain95?: number;
}

/** Each piece of a cloth as last built, from the model's flexes named `<body>__<piece>`. */
export function pieceDetails(flexes: { name: string; rgba: number[]; material?: string; flat?: { uv: number[][]; strain95: number } }[]): PieceDetail[] {
  return flexes.map((f) => {
    const name = f.name.slice(f.name.lastIndexOf('__') + 2);
    let flatMm: [number, number] | undefined;
    if (f.flat?.uv.length) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [u, v] of f.flat.uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      flatMm = [Math.round((u1 - u0) * 1000), Math.round((v1 - v0) * 1000)];
    }
    return {
      name,
      ...(f.material ? { material: f.material } : {}),
      rgba: f.rgba.map((c) => +c.toFixed(3)),
      ...(flatMm ? { flatMm } : {}),
      ...(f.flat ? { strain95: +f.flat.strain95.toFixed(4) } : {}),
    };
  });
}
