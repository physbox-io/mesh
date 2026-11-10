// Pictures for the copilot's model: decoded in the browser, cut down to the
// size the providers read at anyway (a 12 MP photo costs upload time and
// tokens and adds nothing past ~1.5k px), and re-encoded as JPEG on white so a
// transparent PNG does not arrive as a black square.

import type { LlmImage } from './llmCall';

/** Long side, px. Anthropic downsamples past 1568; Gemini tiles at 768. */
export const LLM_IMAGE_MAX_PX = 1568;

function canvasToImage(canvas: HTMLCanvasElement, quality = 0.88): LlmImage {
  const url = canvas.toDataURL('image/jpeg', quality);
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

/** The picture drawn on white at most `maxPx` on its long side. */
export function drawableToLlmImage(src: CanvasImageSource, width: number, height: number, maxPx = LLM_IMAGE_MAX_PX): LlmImage {
  const k = Math.min(1, maxPx / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * k));
  canvas.height = Math.max(1, Math.round(height * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The browser has no 2D canvas to prepare the picture with.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvasToImage(canvas);
}

export async function fileToLlmImage(file: Blob, maxPx = LLM_IMAGE_MAX_PX): Promise<LlmImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The browser could not decode this picture.'));
      img.src = url;
    });
    return drawableToLlmImage(img, img.naturalWidth, img.naturalHeight, maxPx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A data URL, for showing the picture back in the chat. */
export const llmImageUrl = (im: LlmImage): string => `data:${im.mediaType};base64,${im.data}`;
