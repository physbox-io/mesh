import type { EdgeProfile, GarmentDraft, GarmentEdge } from '../../types/cloth';

/**
 * Named styles for the Garment card's Details: each only a preset over the
 * draft's general data (an edge profile, a collar, pockets, a belt, a
 * fastening). Anything else the data can say (an agent's, or edited over MCP)
 * shows as Custom and is left alone.
 */

export interface EdgeStyle {
  id: string;
  label: string;
  tip: string;
  /** Its profile at `amount` (metres: how much longer at the most; a neckline's shape ignores it). None: the plain edge. */
  profile?: (amount: number) => EdgeProfile;
  /** A neckline's: widened by this much each side, metres. */
  width?: number;
}

const round = [[0, 1], [0.3, 0.954], [0.5, 0.866], [0.7, 0.714], [0.85, 0.527], [0.95, 0.312], [1, 0]];

export const NECKLINES: EdgeStyle[] = [
  { id: 'round', label: 'Round', tip: 'A round neckline.' },
  { id: 'v', label: 'V', tip: 'Straight down to a point at the centre front.', profile: () => ({ points: [[0, 1], [1, 0]] }) },
  { id: 'square', label: 'Square', tip: 'Straight across, square at the corners.', profile: () => ({ points: [[0, 1], [0.85, 1], [0.97, 0.35], [1, 0]] }) },
  { id: 'scoop', label: 'Scoop', tip: 'Round, cut wider.', profile: () => ({ points: round }), width: 0.035 },
  { id: 'boat', label: 'Boat', tip: 'Wide and shallow, shoulder to shoulder.', profile: () => ({ points: [[0, 1], [0.6, 0.9], [0.9, 0.5], [1, 0]] }), width: 0.06 },
  { id: 'sweetheart', label: 'Sweetheart', tip: 'Two curves meeting in a dip at the centre.', profile: () => ({ points: [[0, 0.75], [0.25, 1], [0.5, 0.9], [0.8, 0.5], [1, 0]] }) },
];

/** Round the body (hem, band top): t 0 the centre front, 0.5 the back. */
export const HEMS: EdgeStyle[] = [
  { id: 'straight', label: 'Straight', tip: 'Level all round.' },
  { id: 'highlow', label: 'High-low', tip: 'Longer at the back.', profile: (a) => ({ points: [[0, 0], [0.5, a], [1, 0]] }) },
  { id: 'asymmetric', label: 'Asymmetric', tip: 'Longer down one side.', profile: (a) => ({ points: [[0, a / 2], [0.25, a], [0.5, a / 2], [0.75, 0], [1, a / 2]] }) },
  { id: 'handkerchief', label: 'Handkerchief', tip: 'Four points: front, back and sides.', profile: (a) => ({ points: [[0, a], [0.5, 0], [1, a]], repeat: 4 }) },
  { id: 'points', label: 'Points', tip: 'Cut into points all round.', profile: (a) => ({ points: [[0, 0], [0.5, a], [1, 0]], repeat: 10 }) },
  { id: 'scallops', label: 'Scallops', tip: 'Rounded scallops all round.', profile: (a) => ({ points: [[0, 0], [0.15, 0.55 * a], [0.3, 0.85 * a], [0.5, a], [0.7, 0.85 * a], [0.85, 0.55 * a], [1, 0]], repeat: 14 }) },
];

/** Round a limb (a sleeve's end, a tube's): t 0 its underside. */
export const LIMB_ENDS: EdgeStyle[] = [
  { id: 'straight', label: 'Straight', tip: 'Square to the arm.' },
  { id: 'point', label: 'Hanging point', tip: 'Drawn out underneath into a long point.', profile: (a) => ({ points: [[0, a], [0.18, 0], [0.82, 0], [1, a]] }) },
  { id: 'angled', label: 'Angled', tip: 'Longer underneath, rising to the top.', profile: (a) => ({ points: [[0, a], [0.5, 0], [1, a]] }) },
  { id: 'points', label: 'Points', tip: 'Cut into points round the end.', profile: (a) => ({ points: [[0, 0], [0.5, a], [1, 0]], repeat: 6 }) },
  { id: 'scallops', label: 'Scallops', tip: 'Rounded scallops round the end.', profile: (a) => ({ points: [[0, 0], [0.25, 0.75 * a], [0.5, a], [0.75, 0.75 * a], [1, 0]], repeat: 8 }) },
];

const peak = (pr: EdgeProfile) => Math.max(...pr.points.map((q) => Math.abs(q[1] ?? 0)), 1e-9);
const same = (a: EdgeProfile, b: EdgeProfile) => {
  if ((a.repeat ?? 1) !== (b.repeat ?? 1) || a.points.length !== b.points.length) return false;
  const pa = peak(a), pb = peak(b);
  return a.points.every((q, i) => Math.abs(q[0] - b.points[i][0]) < 1e-6 && Math.abs(q[1] / pa - b.points[i][1] / pb) < 1e-6);
};

/** Which style an edge is in, and its amount; 'custom' if none of them says it. */
export function edgeStyle(styles: EdgeStyle[], edge: GarmentEdge | undefined): { id: string; amount: number } {
  if (!edge) return { id: styles[0].id, amount: 0 };
  const amount = peak(edge.profile);
  for (const st of styles) if (st.profile && same(edge.profile, st.profile(amount)) && (st.width ?? 0) === (edge.width ?? 0)) return { id: st.id, amount };
  return { id: 'custom', amount };
}

/** The draft with one edge set to a style (or the plain edge), every other edge kept. */
export function withEdge(draft: GarmentDraft, along: GarmentEdge['along'], style: EdgeStyle | undefined, amount: number): GarmentDraft {
  const others = (draft.edges ?? []).filter((e) => !(e.along === along && (along !== 'neckline' || (e.side ?? 'front') === 'front')));
  const edge: GarmentEdge | null = style?.profile ? { along, profile: style.profile(amount), ...(style.width ? { width: style.width } : {}) } : null;
  const edges = edge ? [...others, edge] : others;
  return { ...draft, edges: edges.length ? edges : undefined };
}

export interface ChoiceStyle {
  id: string;
  label: string;
  tip: string;
  /** The draft with this choice made. */
  apply: (d: GarmentDraft) => GarmentDraft;
  /** Whether the draft is in it now. */
  is: (d: GarmentDraft) => boolean;
}

export const COLLARS: ChoiceStyle[] = [
  { id: 'none', label: 'None', tip: 'No collar.', apply: (d) => ({ ...d, collar: undefined, lapels: undefined }), is: (d) => !d.collar && !d.lapels },
  { id: 'shirt', label: 'Shirt', tip: 'A band round the neck with a collar folded over it.', apply: (d) => ({ ...d, collar: { stand: 0.03, fall: 0.042, point: -0.012, separateStand: true }, lapels: undefined }), is: (d) => !!d.collar && !d.lapels && (d.collar.fall ?? 0.045) > 0 },
  { id: 'mandarin', label: 'Mandarin', tip: 'A band standing up round the neck, nothing folded over.', apply: (d) => ({ ...d, collar: { stand: 0.032, fall: 0 }, lapels: undefined }), is: (d) => !!d.collar && !d.lapels && d.collar.fall === 0 },
  { id: 'notch', label: 'Notch lapels', tip: 'The fronts turned back into lapels, a collar meeting them in a notch. Opens the front.', apply: (d) => ({ ...d, opening: true, lapels: { break: 0.24, width: 0.075, peak: 0.01 }, collar: { stand: 0.03, standFront: 0.01, fall: 0.045, separateStand: true } }), is: (d) => !!d.lapels && !d.lapels.shawl },
  { id: 'shawl', label: 'Shawl', tip: 'Lapels and collar in one rolled piece. Opens the front.', apply: (d) => ({ ...d, opening: true, lapels: { break: 0.24, width: 0.07, peak: 0, shawl: true }, collar: { stand: 0.015, standFront: 0.005, fall: 0.06 } }), is: (d) => !!d.lapels?.shawl },
];

const closes = (d: GarmentDraft) => (d.trims ?? []).filter((t) => t.along === 'opening' && (t.kind === 'button' || (t.kind === 'zipper' && t.fastened !== false)));
const withoutClosure = (d: GarmentDraft) => (d.trims ?? []).filter((t) => !(t.along === 'opening' && (t.kind === 'button' || t.kind === 'zipper')));
export const FASTENINGS: ChoiceStyle[] = [
  { id: 'open', label: 'Open', tip: 'Left open.', apply: (d) => ({ ...d, trims: withoutClosure(d) }), is: (d) => closes(d).length === 0 },
  { id: 'buttons', label: 'Buttons', tip: 'Buttoned, on a stand lapping over the other front.', apply: (d) => ({ ...d, trims: [...withoutClosure(d), { kind: 'button', along: 'opening', spacing: 0.08 }] }), is: (d) => closes(d).some((t) => t.kind === 'button') },
  { id: 'zip', label: 'Zip', tip: 'Zipped up the front.', apply: (d) => ({ ...d, trims: [...withoutClosure(d), { kind: 'zipper', along: 'opening', fastened: true }] }), is: (d) => closes(d).some((t) => t.kind === 'zipper' && t.fastened !== false) },
];
