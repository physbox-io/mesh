/**
 * Printed-fabric textures, shared: one per print, colour and wrap, however many
 * panels wear it (a garment's fronts share one, its backs, shaded, another).
 * Counted, and disposed when the last panel lets go.
 */
import * as THREE from 'three';
import type { ClothPatternPrint } from '../../types/cloth';

interface Entry { tex: THREE.CanvasTexture | null; refs: number; waiting: ((t: THREE.CanvasTexture) => void)[] }
const cache = new Map<string, Entry>();

const SIZE = 512;

function svgUrl(svg: string): { url: string; revoke: () => void } {
  const raw = svg.trim();
  if (raw.startsWith('data:')) return { url: raw, revoke: () => {} };
  let text = raw.includes('xmlns=') ? raw : raw.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/<svg[^>]*\bwidth\s*=/.test(text)) text = text.replace('<svg', `<svg width="${SIZE}" height="${SIZE}"`);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/**
 * The texture for `print` over a ground of `rgba`, handed to `ready` once
 * drawn (at once if it already is). Returns the release.
 */
export function acquirePrintTexture(print: ClothPatternPrint, rgba: number[], ready: (t: THREE.CanvasTexture) => void): () => void {
  const tile = print.tile !== false;
  const key = `${tile ? 't' : 'f'}|${rgba.slice(0, 3).map((c) => c.toFixed(3)).join(',')}|${print.svg}`;
  let e = cache.get(key);
  if (!e) {
    const entry: Entry = { tex: null, refs: 0, waiting: [] };
    e = entry;
    cache.set(key, entry);
    const { url, revoke } = svgUrl(print.svg);
    const img = new Image();
    img.onload = () => {
      revoke();
      if (cache.get(key) !== entry) return;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = `rgb(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = tile ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      entry.tex = tex;
      for (const w of entry.waiting.splice(0)) w(tex);
    };
    img.onerror = revoke;
    img.src = url;
  }
  const entry = e;
  entry.refs++;
  let live = true;
  const cb = (t: THREE.CanvasTexture) => { if (live) ready(t); };
  if (entry.tex) cb(entry.tex); else entry.waiting.push(cb);
  return () => {
    if (!live) return;
    live = false;
    entry.waiting = entry.waiting.filter((w) => w !== cb);
    if (--entry.refs > 0) return;
    entry.tex?.dispose();
    cache.delete(key);
  };
}
