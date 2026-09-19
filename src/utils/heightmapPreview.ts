// ---------------------------------------------------------------------------
// A shaded preview of a heightmap, drawn straight onto a canvas.
//
// Shared by the image import dialog and the surface pattern generator, because
// both are answering the same question -- "what will this relief look like when
// it is cut?" -- and a flat greyscale of the height values does not answer it.
// Lighting the surface does: a ridge and a groove have the same height range
// and look identical in greyscale, and completely different under a light.
// ---------------------------------------------------------------------------

import type { HeightmapMeshResult } from './heightmapMesh';

/**
 * Draw `mesh` onto `canvas`, lit from the top left.
 *
 * The canvas is resized to the grid, so the element's CSS size does the
 * scaling. `maxHeightM` and `widthM` are needed because the shading has to know
 * the relief's true proportions -- the same heightmap 2 mm deep and 20 mm deep
 * are very different surfaces, and a preview that normalised that away would
 * show the same picture for both.
 *
 * `tint` gives the surface its own colour per height, so a preview of a board
 * that will be painted shows the paint rather than a grey version of it. The
 * lighting is kept and multiplied through, because a flat fill of the right
 * colours loses the relief the dialog exists to show.
 */
export function drawHeightmapPreview(
  canvas: HTMLCanvasElement,
  mesh: HeightmapMeshResult,
  maxHeightM: number,
  widthM: number,
  tint?: (h: number) => [number, number, number]
): void {
  const { cols, rows, heights } = mesh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = cols;
  canvas.height = rows;
  const img = ctx.createImageData(cols, rows);
  // Light from the top-left, at the true aspect of the relief.
  const cell = widthM / (cols - 1);
  const zScale = maxHeightM / Math.max(cell, 1e-9);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r * cols + c];
      const hl = heights[r * cols + Math.max(0, c - 1)];
      const hr = heights[r * cols + Math.min(cols - 1, c + 1)];
      const hu = heights[Math.max(0, r - 1) * cols + c];
      const hd = heights[Math.min(rows - 1, r + 1) * cols + c];
      const nx = -(hr - hl) * 0.5 * zScale;
      const ny = (hd - hu) * 0.5 * zScale;
      const len = Math.hypot(nx, ny, 1) || 1;
      // Light direction (-0.5, 0.6, 0.7), normalised.
      const lambert = Math.max(0, (nx * -0.48 + ny * 0.57 + 0.67) / len);
      const shade = Math.min(1, 0.28 + 0.55 * lambert + 0.22 * h);
      const i = (r * cols + c) * 4;
      if (tint) {
        // Lift the light a little for a tinted surface: the grey preview uses
        // brightness for both shape and tone, and a coloured one only needs it
        // for shape, so the same curve comes out muddy.
        const lit = Math.min(1, shade * 0.75 + 0.45);
        const [tr, tg, tb] = tint(h);
        img.data[i] = Math.round(Math.min(1, tr * lit) * 255);
        img.data[i + 1] = Math.round(Math.min(1, tg * lit) * 255);
        img.data[i + 2] = Math.round(Math.min(1, tb * lit) * 255);
      } else {
        const v = Math.round(shade * 255);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = Math.min(255, v + 8);
      }
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
