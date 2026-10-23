import { physicsGlobals } from '../physicsGlobals';

/**
 * Draws a frame of the viewport now and returns its canvas, or null before
 * the renderer is up.
 *
 * Read the canvas in the same task: the renderer does not keep its drawing
 * buffer, so what was drawn is only there until the browser composites. And
 * through the composer when there is one, or the picture has no ambient
 * occlusion and disagrees with the screen.
 */
export function renderViewportNow(): HTMLCanvasElement | null {
  const { _physics_gl: gl, _physics_scene: scene, _physics_camera: camera, _physics_composer: composer } = physicsGlobals;
  if (!gl?.domElement) return null;
  if (composer) {
    try { composer.render(); } catch { /* the raw render below */ }
  } else if (scene && camera) {
    try { gl.render(scene, camera); } catch { /* a lost context: the read fails honestly */ }
  }
  return gl.domElement;
}

/** A small 4:3 JPEG of the viewport, cropped from its middle, for the scene browser. */
export function captureViewportThumb(width = 240): string | null {
  const src = renderViewportNow();
  if (!src || !src.width || !src.height) return null;
  const height = Math.round(width * 3 / 4);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  const scale = Math.min(src.width / width, src.height / height);
  const sw = width * scale;
  const sh = height * scale;
  try {
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, width, height);
    return out.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
