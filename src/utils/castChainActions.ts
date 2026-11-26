// A finished chain into the scene: the piece, and for silicone the mold it
// came out of. The chains themselves are castChain.ts, pure, on the worker.

import { addSimulationToScene, sceneStockTransform } from '../hooks/useAddSimulation';
import { castMaterial } from './castMaterials';
import { pieceLines, type ChainPiece, type MetalChain, type SiliconeChain } from './castChain';

export interface AddedChain {
  piece: { id: string; name: string };
  siliconeMold?: { id: string; name: string };
  /** What the same chain made for the same part before, which these replaced. */
  replaced: { id: string; name: string }[];
}

/** The key a chain's output is kept under: the same chain for the same part replaces it. */
const chainSource = (chain: string, partIds: readonly string[], what: string) => `chain:${chain}:${[...partIds].sort().join(',')}:${what}`;

/** Beside-placement transform resting cleanly on z = 0 (not inheriting any sub-floor pour base offset). */
function besideFloorTransform() {
  const t = sceneStockTransform();
  return { ...t, modelMinMm: [t.modelMinMm[0], t.modelMinMm[1], 0] as [number, number, number] };
}

/** The finished piece beside the model, as the master stands; selected unless told otherwise. */
async function addPiece(piece: ChainPiece, label: string, lines: string[], select: boolean, source: string) {
  return addSimulationToScene({
    source,
    mesh: piece.mesh,
    transform: besideFloorTransform(),
    kind: 'cast',
    label,
    placement: 'beside',
    details: [...pieceLines(piece), ...lines],
    material: piece.material,
    select,
  });
}

/**
 * The silicone chain's piece, then its silicone mold, turned over and vented,
 * which is left selected: Cast pours into it again.
 */
export async function addSiliconeChain(r: { piece: ChainPiece; warnings: string[] } & SiliconeChain, partIds: readonly string[]): Promise<AddedChain> {
  const piece = await addPiece(r.piece, `${castMaterial(r.piece.material).label} from silicone mold`, r.warnings, false, chainSource('silicone', partIds, 'piece'));
  const mold = await addSimulationToScene({
    source: chainSource('silicone', partIds, 'mold'),
    mesh: r.siliconeMold,
    transform: besideFloorTransform(),
    kind: 'mold',
    label: 'Silicone mold',
    placement: 'beside',
    details: [
      `${r.silicone.grams} g of ${r.silicone.name.toLowerCase()} (${r.silicone.aG} g A + ${r.silicone.bG} g B), turned over to pour into`,
      r.vents.length ? `${r.vents.length} vent${r.vents.length === 1 ? '' : 's'} cut where air would be trapped` : 'No vents needed: no air is trapped',
    ],
    material: r.silicone.id,
  });
  return { piece, siliconeMold: mold, replaced: [...(piece.replaced ?? []), ...(mold.replaced ?? [])] };
}

/** The metal chain's piece, cut off its gating. */
export async function addMetalChain(r: { piece: ChainPiece; warnings: string[] } & MetalChain, method: 'sand' | 'lost-pla', partIds: readonly string[]): Promise<AddedChain> {
  const [w, d, h] = r.flask.sizeMm;
  const flask = r.flask.shape === 'box' ? `${w} × ${d} × ${h} mm` : `⌀${w} × ${h} mm`;
  const piece = await addPiece(r.piece, `${castMaterial(r.piece.material).label} casting`, [
    method === 'sand'
      ? `Sand flask ~${flask}, ${(r.fillG / 1000).toFixed(1)} kg sand`
      : `Flask ~${flask}, ${r.fillG} g investment powder`,
    ...r.warnings,
  ], true, chainSource(method, partIds, 'piece'));
  return { piece, replaced: piece.replaced ?? [] };
}
