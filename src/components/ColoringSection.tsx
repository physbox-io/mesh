// ---------------------------------------------------------------------------
// Coloring
// ---------------------------------------------------------------------------
//
// Paint, in the sense the sculpt tools mean it: pick a colour, then drag across
// the model. Colour lands where the brush touches rather than on the whole
// body, and going over the same place again puts more down — so a pip is a
// couple of dabs, and a solid mark is a few more.
//
// A geom's colour has never reached the physics or any exporter, so nothing
// here can change what the simulation does or what a machine cuts. That is the
// whole licence for how loose this is: the worst outcome of a wrong stroke is
// an ugly scene, and Ctrl+Z is right there.
// ---------------------------------------------------------------------------

import { Palette, Pipette, Eraser } from 'lucide-react';
import { useStore } from '../store/useStore';

/**
 * The palette.
 *
 * Chosen to be legible against both viewport backgrounds and against each other
 * once the light hits them — the shaded material darkens everything a shade, so
 * the swatches sit brighter than the colours they produce. Two neutrals at the
 * end because most of a scene wants to stay quiet while one part shouts.
 */
const SWATCHES: { hex: string; name: string }[] = [
  { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },
  { hex: '#f59e0b', name: 'Amber' },
  { hex: '#facc15', name: 'Yellow' },
  { hex: '#84cc16', name: 'Lime' },
  { hex: '#22c55e', name: 'Green' },
  { hex: '#14b8a6', name: 'Teal' },
  { hex: '#06b6d4', name: 'Cyan' },
  { hex: '#3b82f6', name: 'Blue' },
  { hex: '#6366f1', name: 'Indigo' },
  { hex: '#a855f7', name: 'Violet' },
  { hex: '#ec4899', name: 'Pink' },
  { hex: '#f5d0a9', name: 'Sand' },
  { hex: '#a16207', name: 'Wood' },
  { hex: '#94a3b8', name: 'Steel' },
  { hex: '#1e293b', name: 'Charcoal' },
];

/** '#rrggbb' -> the 0..1 triple a geom's rgba is written in. */
function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** The 0..1 triple back to '#rrggbb', for the swatch and the colour input. */
function rgbToHex(rgb: [number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export interface ColoringSectionProps {
  /**
   * Called when the brush is armed.
   *
   * Below `md` the sidebar is an overlay sitting on top of the model, so arming
   * a brush and leaving the drawer open hands the user a brush and hides the
   * thing they were about to paint.
   */
  onArmed?: () => void;
}

export function ColoringSection({ onArmed }: ColoringSectionProps) {
  const paintMode = useStore((s) => s.paintMode);
  const paintColor = useStore((s) => s.paintColor);
  const paintRadius = useStore((s) => s.paintRadius);
  const paintFlow = useStore((s) => s.paintFlow);
  const togglePaintMode = useStore((s) => s.togglePaintMode);
  const setPaintColor = useStore((s) => s.setPaintColor);
  const setPaintBrush = useStore((s) => s.setPaintBrush);
  const clearAllPaint = useStore((s) => s.clearAllPaint);

  const currentHex = rgbToHex(paintColor);

  /**
   * Picking a colour arms the brush.
   *
   * Reaching for a colour is already the decision to paint with it; making that
   * two steps means every first stroke of a session lands on a body as a
   * selection instead, and the user learns to distrust the click.
   */
  const choose = (hex: string) => {
    setPaintColor(hexToRgb(hex));
    if (!useStore.getState().paintMode) {
      useStore.getState().togglePaintMode();
      onArmed?.();
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <span>🎨 Coloring</span>
      </h3>

      <button
        onClick={() => {
          togglePaintMode();
          if (!paintMode) onArmed?.();
        }}
        title={
          paintMode
            ? 'Put the brush down. Clicking a body selects it again.'
            : 'Pick up the brush. Drag across bodies in the viewport to colour them.'
        }
        className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
          paintMode
            ? 'bg-fuchsia-500 border-fuchsia-500 text-white shadow-xs'
            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-fuchsia-400 dark:hover:border-fuchsia-800'
        }`}
      >
        <Palette className="w-3.5 h-3.5" />
        {paintMode ? 'Painting — click to stop' : 'Paint'}
      </button>

      <div className="grid grid-cols-8 gap-1 mt-2.5">
        {SWATCHES.map(({ hex, name }) => (
          <button
            key={hex}
            onClick={() => choose(hex)}
            title={`${name} — picking a colour picks up the brush`}
            style={{ backgroundColor: hex }}
            className={`aspect-square rounded-md border transition-transform cursor-pointer hover:scale-110 ${
              paintMode && currentHex.toLowerCase() === hex.toLowerCase()
                ? 'border-slate-900 dark:border-white ring-2 ring-fuchsia-400 ring-offset-1 ring-offset-white dark:ring-offset-slate-900'
                : 'border-black/10 dark:border-white/20'
            }`}
          />
        ))}
      </div>

      <label
        className="flex items-center gap-2 mt-2.5 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-pointer"
        title="Any colour you like. Alt-click a body in the viewport to load its colour into the brush instead."
      >
        <input
          type="color"
          value={currentHex}
          onChange={(e) => choose(e.target.value)}
          className="w-6 h-6 p-0 border-0 bg-transparent cursor-pointer"
        />
        <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300">Custom</span>
        <span className="ml-auto text-[10px] font-mono text-slate-400 dark:text-slate-500 uppercase">
          {currentHex}
        </span>
      </label>

      {/* The two numbers that decide what a stroke looks like. Kept visible
          rather than behind a disclosure: brush size is the difference between
          a pip and a painted face, and it changes constantly. */}
      <div className="mt-2.5 space-y-2">
        <label className="block" title="How wide the brush is. A pip on a 20 mm die wants about 3 mm.">
          <div className="flex items-baseline justify-between mb-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Size</span>
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">{(paintRadius * 1000).toFixed(1)} mm</span>
          </div>
          <input
            type="range"
            min={0.0005}
            max={0.06}
            step={0.0005}
            value={paintRadius}
            onChange={(e) => setPaintBrush({ radius: parseFloat(e.target.value) })}
            className="w-full accent-fuchsia-500 cursor-pointer"
          />
        </label>

        <label className="block" title="How much colour one pass lays down. Low and repeated gives you control over how strong a mark ends up; full covers in a single stroke.">
          <div className="flex items-baseline justify-between mb-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Flow</span>
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">{Math.round(paintFlow * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={paintFlow}
            onChange={(e) => setPaintBrush({ flow: parseFloat(e.target.value) })}
            className="w-full accent-fuchsia-500 cursor-pointer"
          />
        </label>
      </div>

      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 mt-2 flex items-start gap-1">
        <Pipette className="w-3 h-3 mt-px shrink-0" />
        <span>
          {paintMode
            ? 'Drag on a body to paint · go over it again to build up · Ctrl erases · Alt picks a colour up · Ctrl+Z undoes a stroke'
            : 'Colour is looks only — it changes nothing about the physics or what gets exported.'}
        </span>
      </p>

      <button
        onClick={() => {
          if (window.confirm('Take the paint off every body in the scene? The bodies keep their own colours.')) {
            clearAllPaint();
          }
        }}
        className="w-full mt-2 flex items-center justify-center gap-1.5 py-1 rounded-lg text-[10px] font-bold text-slate-500 dark:text-slate-400 border border-dashed border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
        title="Strips every brush stroke in the scene. Each body keeps the colour it was given in its properties."
      >
        <Eraser className="w-3 h-3" /> Clear all paint
      </button>
    </div>
  );
}

export default ColoringSection;
