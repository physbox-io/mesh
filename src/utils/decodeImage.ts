// Decoding a picture to RGBA pixels in the browser: for the image-to-relief
// import (ImportImageModal) and the image surface pattern (imagePattern.ts).
// Needs a DOM; the pixels go to the workers as plain arrays.

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The picture at `src` (an object URL, a data URL or an http(s) URL),
 * scaled down so neither side is over `maxPx`.
 */
export async function decodeImageUrl(src: string, maxPx: number): Promise<DecodedImage> {
  const img = new Image();
  img.decoding = 'async';
  // An image from another site taints the canvas unless it is asked for this way.
  if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The browser could not load or decode this image.'));
    img.src = src;
  });
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not open a 2D canvas to read the image.');
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** A picked file, decoded the same way. */
export async function decodeImageFile(file: File, maxPx: number): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  try {
    return await decodeImageUrl(url, maxPx);
  } finally {
    URL.revokeObjectURL(url);
  }
}
