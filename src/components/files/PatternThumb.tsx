import { useEffect, useRef, useState } from 'react';
import { drawHeightmapPreview } from '../../utils/heightmapPreview';
import {
  buildPatternPlank, PANEL_BASE_MM, RELIEF_FLOOR_MM, DEFAULT_DEPTH_FRACTION, MIN_SENSIBLE_DEPTH_MM,
  type PatternSpec,
} from '../../utils/surfacePatterns';
import type { StockSize } from '../../utils/stockSettings';

/** Coarse: a card is a couple of hundred pixels wide, and thirty of them are drawn. */
const THUMB_COLS = 72;

/** Drawn thumbnails, by pattern and stock, kept for the session as data URLs. */
const drawn = new Map<string, string>();

/*
 * One at a time, in idle time. Building a plank is milliseconds for most
 * patterns and a good part of a second for reaction-diffusion; thirty of them
 * in one frame froze the dialog as it opened.
 */
const queue: (() => void)[] = [];
let running = false;
function pump() {
  const job = queue.shift();
  if (!job) { running = false; return; }
  running = true;
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  (idle ?? ((cb: () => void) => setTimeout(cb, 16)))(() => { job(); pump(); });
}
function enqueue(job: () => void) {
  queue.push(job);
  if (!running) pump();
}

function render(spec: PatternSpec, stock: StockSize): string {
  const room = stock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM;
  const depth = Math.min(room, Math.max(MIN_SENSIBLE_DEPTH_MM, stock.thicknessMm * (spec.depthFraction ?? DEFAULT_DEPTH_FRACTION)));
  const plank = buildPatternPlank(spec, { ...spec.defaults }, stock, depth, THUMB_COLS);
  const canvas = document.createElement('canvas');
  drawHeightmapPreview(
    canvas, plank.mesh,
    (spec.throughCut ? stock.thicknessMm : depth) / 1000,
    stock.widthMm / 1000,
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
  const url = drawn.get(key) ?? null;
  const failed = failedKey === key;

  useEffect(() => {
    const el = ref.current;
    if (!el || drawn.has(key)) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      enqueue(() => {
        if (cancelled) return;
        try {
          if (!drawn.has(key)) drawn.set(key, render(spec, stock));
          setDrawnTick((t) => t + 1);
        } catch {
          setFailedKey(key);
        }
      });
    });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [key, spec, stock]);

  return (
    <div ref={ref} className="aspect-[4/3] w-full rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
      {url
        ? <img src={url} alt="" className="w-full h-full object-cover [image-rendering:auto]" draggable={false} />
        : <span className="text-[10px] text-slate-400">{failed ? 'No preview' : ''}</span>}
    </div>
  );
}
