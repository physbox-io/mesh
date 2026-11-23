import { useEffect, useRef, useState } from 'react';
import { drawHeightmapPreview } from '../../utils/heightmapPreview';
import {
  buildPatternPlank, PANEL_BASE_MM, RELIEF_FLOOR_MM, DEFAULT_DEPTH_FRACTION, MIN_SENSIBLE_DEPTH_MM,
  type PatternSpec,
} from '../../utils/surfacePatterns';
import type { StockSize } from '../../utils/stockSettings';

/** Coarse: a card is a couple of hundred pixels wide, and thirty of them are drawn. */
const THUMB_COLS = 72;

/** LRU ceiling on cached thumbnail data URLs so changing stock never grows memory unboundedly. */
export const MAX_DRAWN_THUMB_CACHE = 96;

/** Drawn thumbnails, by pattern and stock, kept for the session as data URLs. */
const drawn = new Map<string, string>();

function getCachedThumb(key: string): string | null {
  const url = drawn.get(key);
  if (url === undefined) return null;
  drawn.delete(key);
  drawn.set(key, url);
  return url;
}

function setCachedThumb(key: string, url: string): void {
  if (drawn.has(key)) drawn.delete(key);
  drawn.set(key, url);
  while (drawn.size > MAX_DRAWN_THUMB_CACHE) {
    const oldest = drawn.keys().next().value;
    if (oldest === undefined) break;
    drawn.delete(oldest);
  }
}

/*
 * One at a time, in idle time. Building a plank is milliseconds for most
 * patterns and a good part of a second for reaction-diffusion; thirty of them
 * in one frame froze the dialog as it opened.
 */
interface ThumbJob {
  run: () => void;
  cancelled: boolean;
}
const queue: ThumbJob[] = [];
let running = false;
function pump() {
  let job = queue.shift();
  while (job && job.cancelled) job = queue.shift();
  if (!job) { running = false; return; }
  running = true;
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  (idle ?? ((cb: () => void) => setTimeout(cb, 16)))(() => {
    if (!job.cancelled) job.run();
    pump();
  });
}
function enqueue(job: ThumbJob) {
  queue.push(job);
  if (!running) pump();
}

/**
 * Computes a preview stock thickness and carve depth that always satisfy
 * `buildPatternPlank`'s minimum base + floor constraints, even on thin laser stock (<= 3 mm).
 */
export function previewStockForThumb(spec: PatternSpec, stock: StockSize): { stock: StockSize; depthMm: number } {
  const minThicknessMm = PANEL_BASE_MM + RELIEF_FLOOR_MM + MIN_SENSIBLE_DEPTH_MM;
  const previewStock: StockSize = spec.throughCut || stock.thicknessMm >= minThicknessMm
    ? stock
    : { ...stock, thicknessMm: minThicknessMm };
  const room = Math.max(MIN_SENSIBLE_DEPTH_MM, previewStock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM);
  const depthMm = Math.min(
    room,
    Math.max(MIN_SENSIBLE_DEPTH_MM, previewStock.thicknessMm * (spec.depthFraction ?? DEFAULT_DEPTH_FRACTION)),
  );
  return { stock: previewStock, depthMm };
}

function render(spec: PatternSpec, stock: StockSize): string {
  const { stock: previewStock, depthMm: depth } = previewStockForThumb(spec, stock);
  const plank = buildPatternPlank(spec, { ...spec.defaults }, previewStock, depth, THUMB_COLS);
  const canvas = document.createElement('canvas');
  drawHeightmapPreview(
    canvas, plank.mesh,
    (spec.throughCut ? previewStock.thicknessMm : depth) / 1000,
    previewStock.widthMm / 1000,
    spec.palette ? (h) => spec.palette!(h, spec.defaults) : undefined,
  );
  return canvas.toDataURL();
}

/** A pattern's default look on the stock on the bench, drawn once it scrolls into view. */
export function PatternThumb({ spec, stock }: { spec: PatternSpec; stock: StockSize }) {
  const key = `${spec.id}:${stock.widthMm}x${stock.depthMm}x${stock.thicknessMm}`;
  // The cache is the state; this only asks for a render once a thumbnail lands in it.
  const [, setDrawnTick] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const url = getCachedThumb(key);
  const failed = failedKey === key;

  useEffect(() => {
    const el = ref.current;
    if (!el || drawn.has(key)) return;
    let job: ThumbJob | null = null;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      job = {
        cancelled: false,
        run: () => {
          try {
            if (!drawn.has(key)) setCachedThumb(key, render(spec, stock));
            setDrawnTick((t) => t + 1);
          } catch {
            setFailedKey(key);
          }
        },
      };
      enqueue(job);
    });
    io.observe(el);
    return () => {
      if (job) job.cancelled = true;
      io.disconnect();
    };
  }, [key, spec, stock]);

  return (
    <div ref={ref} className="aspect-[4/3] w-full rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
      {url
        ? <img src={url} alt="" className="w-full h-full object-cover [image-rendering:auto]" draggable={false} />
        : <span className="text-[10px] text-slate-400">{failed ? 'No preview' : ''}</span>}
    </div>
  );
}
