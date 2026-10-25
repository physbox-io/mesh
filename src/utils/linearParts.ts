// ---------------------------------------------------------------------------
// Linear motion: miniature rails, rods with linear bushings, drawer runners
//
// Each is a part whose moving piece is a body of its own on a `slide` joint,
// limited at both ends by the length of what it runs on, so a carriage pushed
// along stops where the real one would. What is fixed to the moving piece — a
// printed carriage plate, a drawer — is welded to it (see `fixToPiece`), the
// same breakable weld a screw makes.
//
// - mgn_rail: a Hiwin-pattern MGN9/12/15 rail along its own +X with an H
//   carriage. Its origin is the middle of the rail's underside, where it beds.
// - linear_rod: a ground rod along +Z with an LM-UU bushing riding it; the rod
//   is the part, so it is the rod that is seated in a frame.
// - drawer_runner: a full-extension ball-bearing runner, 45 mm high and
//   12.7 mm thick: a cabinet member, a middle member and a drawer member, the
//   last two each on a slide, so together they carry a drawer its own length
//   out. Its +X is the way the drawer comes out.
//
// The moving pieces are left out of the contact solver: they run inside or
// along what carries them, and their hulls would otherwise jam on it. The
// cabinet member, rail or rod still collides like any part until it is seated.
// ---------------------------------------------------------------------------

import type { HardwarePart, LinearPartKind, SceneGeom, SceneNode } from '../types/scene';
import { BLACK_OXIDE, BRIGHT, STEEL, boxGeom, cylinderGeom, mm, ringGeom, visual, type HardwarePartInfo } from './hardwareGeometry';

/** MGN rail and H carriage, mm: rail [width, height, hole pitch], carriage [length, width, top above the rail's underside, gap under it], bolt. */
export const MGN: Record<string, { rail: [number, number, number]; block: [number, number, number, number]; bolt: string }> = {
  MGN9: { rail: [9, 6.5, 20], block: [39.9, 20, 10, 2], bolt: 'M3' },
  MGN12: { rail: [12, 8, 25], block: [45.4, 27, 13, 3], bolt: 'M3' },
  MGN15: { rail: [15, 10, 40], block: [58.8, 32, 16, 4], bolt: 'M3' },
};

/** LM-UU linear bushings by rod diameter, mm: [outside diameter, length]. */
export const LM_UU: Record<string, [number, number]> = {
  '6': [12, 19], '8': [15, 24], '10': [19, 29], '12': [21, 30], '16': [28, 37], '20': [32, 42],
};

/** Drawer runners: the lengths they are sold in, mm. 45 mm high, 12.7 mm side space. */
export const RUNNER_LENGTHS = ['250', '300', '350', '400', '450', '500', '550', '600'] as const;
export const RUNNER_SIDE_SPACE_MM = 12.7;
const RUNNER_HEIGHT_MM = 45;

const RAIL_LENGTHS = [100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900, 1000] as const;
const ROD_LENGTHS = [100, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000] as const;

const ZINC: [number, number, number, number] = [0.66, 0.69, 0.72, 1];

/** A slide along `axis`, limited to ±`travel` m about where the piece starts. */
const slide = (name: string, axis: number[], lo: number, hi: number, damping: number) => ({
  name, type: 'slide' as const, axis, pos: [0, 0, 0], damping, limited: true, hardStop: true, range: [+lo.toFixed(6), +hi.toFixed(6)],
});

/** Out of the contact solver; see the note at the top. */
const silent = (geoms: SceneGeom[]) => geoms.map((g) => (g.role === 'visual' ? g : { ...g, contype: 0, conaffinity: 0 }));

function buildRail(node: SceneNode, p: HardwarePart, id: string) {
  const { rail: [w, h, pitch], block: [bl, bw, bh, gap] } = MGN[p.size];
  const L = p.lengthMm!;
  // Holes centred along the rail at its pitch, as a rail cut to length has them.
  const holes = Math.max(1, Math.floor((L - 2 * 4) / pitch) + 1);
  const first = -((holes - 1) * pitch) / 2;
  node.geoms = [
    boxGeom(`${id}_rail`, [mm(L / 2), mm(w / 2), mm(h / 2)], [0, 0, mm(h / 2)], BRIGHT),
    ...Array.from({ length: holes }, (_, i) => visual(cylinderGeom(`${id}_hole${i}`, mm(3), mm(0.1), mm(h), [0.1, 0.1, 0.11, 1], { pos: [mm(first + i * pitch), 0, mm(h)] }))),
  ];
  const travel = Math.max(0, (L - bl) / 2);
  const top = bh - gap;
  node.children = [{
    id: `${id}_carriage`, name: `${p.size}H carriage`, type: 'body', pos: [0, 0, 0],
    geoms: silent([
      boxGeom(`${id}_block`, [mm(bl / 2), mm(bw / 2), mm(top / 2)], [0, 0, mm(gap + top / 2)], BRIGHT),
      // The four tapped holes on top, drawn: they are where a carriage plate is screwed.
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sy], i) =>
        visual(cylinderGeom(`${id}_tap${i}`, mm(1.5), mm(0.1), mm(bh), [0.1, 0.1, 0.11, 1], { pos: [mm(sx * bl * 0.22), mm(sy * bw * 0.3), mm(bh)] }))),
    ]),
    joints: [slide(`${id}_travel`, [1, 0, 0], -mm(travel), mm(travel), 0.02)],
    children: [],
    hardwarePart: { ...p, piece: 'carriage' },
  }];
}

function buildRod(node: SceneNode, p: HardwarePart, id: string) {
  const d = Number(p.size);
  const [od, bl] = LM_UU[p.size];
  const L = p.lengthMm!;
  node.geoms = [cylinderGeom(`${id}_rod`, mm(d / 2), mm(L), 0, BRIGHT)];
  const travel = Math.max(0, (L - bl) / 2);
  node.children = [{
    id: `${id}_carriage`, name: `LM${p.size}UU bushing`, type: 'body', pos: [0, 0, 0],
    geoms: silent([ringGeom(`${id}_bush`, mm(od / 2), mm(d / 2 + 0.5), mm(bl), 0, ZINC)]),
    joints: [slide(`${id}_travel`, [0, 0, 1], -mm(travel), mm(travel), 0.02)],
    children: [],
    hardwarePart: { ...p, piece: 'carriage' },
  }];
}

function buildRunner(node: SceneNode, p: HardwarePart, id: string) {
  const L = Number(p.size);
  const H = RUNNER_HEIGHT_MM;
  const t = RUNNER_SIDE_SPACE_MM;
  // Three channels nested side by side across the 12.7 mm: cabinet, middle, drawer.
  const third = t / 3;
  const member = (name: string, across: number, height: number, rgba: number[]) =>
    boxGeom(name, [mm(L / 2), mm(third / 2), mm(height / 2)], [mm(L / 2), mm(across), 0], rgba, STEEL * 0.35);
  node.geoms = [member(`${id}_cabinet`, -third, H, ZINC)];
  // Each moving member goes out about half its length: together, the full length.
  const half = L / 2;
  node.children = [{
    id: `${id}_middle`, name: `${L} mm runner, middle member`, type: 'body', pos: [0, 0, 0],
    geoms: silent([member(`${id}_mid`, 0, H * 0.82, BRIGHT)]),
    joints: [slide(`${id}_out1`, [1, 0, 0], 0, mm(half), 0.5)],
    hardwarePart: { ...p, piece: 'middle' },
    children: [{
      id: `${id}_carriage`, name: `${L} mm runner, drawer member`, type: 'body', pos: [0, 0, 0],
      geoms: silent([member(`${id}_drawer`, third, H * 0.66, BLACK_OXIDE)]),
      joints: [slide(`${id}_out2`, [1, 0, 0], 0, mm(L - half), 0.5)],
      children: [],
      hardwarePart: { ...p, piece: 'carriage' },
    }],
  }];
}

export const LINEAR_PARTS: Record<LinearPartKind, HardwarePartInfo> = {
  mgn_rail: {
    label: 'Linear rail', sizes: Object.keys(MGN), defaultSize: 'MGN12', lengths: RAIL_LENGTHS, defaultLengthMm: 300,
    hint: 'A miniature linear rail with its carriage, which slides along it and stops at the ends.',
    name: (p) => `${p.size} rail, ${p.lengthMm} mm`,
    build: buildRail,
  },
  linear_rod: {
    label: 'Rod + bushing', sizes: Object.keys(LM_UU), defaultSize: '8', lengths: ROD_LENGTHS, defaultLengthMm: 300,
    hint: 'A ground rod with an LM-UU linear bushing that slides along it and stops at its ends.',
    name: (p) => `Ø${p.size}×${p.lengthMm} rod, LM${p.size}UU`,
    build: buildRod,
  },
  drawer_runner: {
    label: 'Drawer runner', sizes: RUNNER_LENGTHS, defaultSize: '400',
    hint: 'A full-extension ball-bearing drawer runner, 45 mm high, taking 12.7 mm each side of the drawer.',
    name: (p) => `${p.size} mm drawer runner`,
    build: buildRunner,
  },
};
