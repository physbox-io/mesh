/**
 * The union sectionSlice needs to merge a part's overlapping pieces on a cut,
 * from Manifold's CrossSection (Clipper2 underneath). Manifold arrives as
 * wasm, loaded once and asynchronously; the section is measured on every
 * poll, synchronously, so this hands back the merge once it is loaded and
 * null until then.
 */
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from './sculptCut';
import type { Flat, Merge } from './sectionSlice';

/** Clipper works in fixed point: millimetres keep a cut's corners well inside its precision. */
const SCALE = 1000;

let wasm: ManifoldToplevel | null = null;

/** Starts loading Manifold, and resolves once the merge is ready. */
export function loadSectionMerge(): Promise<void> {
  return loadManifold().then((loaded) => { wasm = loaded; });
}

/** The merge, or null while Manifold is still loading. */
export function sectionMerge(): Merge | null {
  const m = wasm;
  if (!m) return null;
  return (pieces: Flat[][]): Flat[] => {
    // Each piece by parity, so its own holes stay holes; then the pieces' union.
    const sections = pieces.map((loops) =>
      new m.CrossSection(loops.map((loop) => loop.map(([x, y]) => [x * SCALE, y * SCALE] as [number, number])), 'EvenOdd'));
    const all = m.CrossSection.union(sections);
    try {
      return all.toPolygons().map((loop) => loop.map(([x, y]) => [x / SCALE, y / SCALE] as [number, number]));
    } finally {
      all.delete();
      for (const s of sections) s.delete();
    }
  };
}
