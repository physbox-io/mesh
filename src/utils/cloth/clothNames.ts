/**
 * The names a garment's draft refers to (its lines, panels and pieces), and
 * which of them match nothing in the garment as modelled. A name that
 * matched nothing used to be ignored without a word: a trim, a pleat or a
 * pull simply did not appear, and an agent could not tell a typo from a
 * design that does not show.
 */

import type { ClothSpec, GarmentDraft } from '../../types/cloth';

/** A line `along` picks: itself, it with an L or R after it (both of a pair), and `top`/`waist` for each other. */
export const linePicks = (name: string, along: string) =>
  name === along
  || (name.length === along.length + 1 && name.startsWith(along))
  || (along === 'top' && (name === 'waist' || name === 'neckline'))
  || (along === 'waist' && name === 'top');

/** A panel `want` picks: itself, or it with an L or R after it (both of a pair). */
const piecePicks = (name: string, want: string) =>
  name === want || (name.length === want.length + 1 && name.startsWith(want) && /[LR]$/.test(name));

/** A piece `want` picks, as pieceFabrics names one: a panel (and its L and R), or a piece sewn on by its name or the name it is numbered from (`pocket` takes pocket_frontL). */
export const pieceNamePicks = (name: string, want: string) => piecePicks(name, want) || name.startsWith(`${want}_`);

const listed = (names: Iterable<string>) => [...new Set(names)].sort().join(', ');

/**
 * What in `draft` (and the cloth's arrange and fasten) names nothing:
 * `lines` every line of the modelled garment, `seams` those sewn between
 * panels, `panels` its panels and `pieces` every piece it was cut into, add-ons
 * included.
 */
export function garmentNameWarnings(draft: Pick<GarmentDraft, 'trims' | 'rods' | 'elastics' | 'attached' | 'fullness' | 'pockets' | 'pieceFabrics'>, spec: Pick<ClothSpec, 'arrange' | 'fasten'>, lines: string[], seams: string[], panels: string[], pieces: string[]): string[] {
  const out: string[] = [];
  const line = (where: string, along: string | undefined) => {
    if (along === undefined || lines.some((l) => linePicks(l, along))) return;
    out.push(`${where} '${along}' names no line of this garment (its lines: ${listed(lines)}).`);
  };
  (draft.trims ?? []).forEach((t, i) => line(`trims[${i}].along`, t.along));
  (draft.rods ?? []).forEach((r, i) => line(`rods[${i}].along`, r.along));
  (draft.elastics ?? []).forEach((e, i) => line(`elastics[${i}].along`, e.along));
  (draft.attached ?? []).forEach((a, i) => line(`attached[${i}].along`, a.along));
  (draft.fullness ?? []).forEach((f, i) => {
    if (seams.some((s) => linePicks(s, f.along))) return;
    out.push(lines.some((l) => linePicks(l, f.along))
      ? `fullness[${i}].along '${f.along}' is an edge, not a seam between panels: add a seam where it goes in (its seams: ${listed(seams) || 'none'}).`
      : `fullness[${i}].along '${f.along}' names no seam of this garment (its seams: ${listed(seams) || 'none'}).`);
    for (const p of f.panels ?? []) if (!panels.some((q) => piecePicks(q, p))) out.push(`fullness[${i}].panels '${p}' names no panel (its panels: ${listed(panels)}).`);
  });
  (draft.pockets ?? []).forEach((p, i) => { if (!panels.some((q) => piecePicks(q, p.panel))) out.push(`pockets[${i}].panel '${p.panel}' names no panel (its panels: ${listed(panels)}).`); });
  // A point on a piece (a pull, a fastening) is found on that piece by its exact name; a turn takes a numbered copy's base name too.
  const piece = (where: string, name: string, exact: boolean) => {
    if (pieces.some((q) => q === name || (!exact && q.startsWith(`${name}_`)))) return;
    out.push(`${where} '${name}' names no piece (its pieces: ${listed(pieces)}).`);
  };
  (draft.pieceFabrics ?? []).forEach((f, i) => { if (!pieces.some((q) => pieceNamePicks(q, f.piece))) out.push(`pieceFabrics[${i}].piece '${f.piece}' names no piece (its pieces: ${listed(pieces)}).`); });
  (spec.arrange ?? []).forEach((a, i) => piece(`arrange[${i}].piece`, a.piece, 'at' in a));
  (spec.fasten ?? []).forEach((f, i) => { piece(`fasten[${i}].a.piece`, f.a.piece, true); piece(`fasten[${i}].b.piece`, f.b.piece, true); });
  return out;
}
