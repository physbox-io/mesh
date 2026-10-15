import type React from 'react';

/**
 * The colour fragments of a tile: hover border, icon chip, hover label.
 * Written out in full per colour because Tailwind only generates classes it
 * can read whole in the source; `hover:border-${c}-300` would style nothing.
 */
const TILE_COLORS = {
  amber: { border: 'hover:border-amber-300 dark:hover:border-amber-800/80', chip: 'from-amber-50 to-amber-100/70 dark:from-amber-950/40 dark:to-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-800/40', label: 'group-hover:text-amber-600 dark:group-hover:text-amber-400' },
  blue: { border: 'hover:border-blue-300 dark:hover:border-blue-800/80', chip: 'from-blue-50 to-blue-100/70 dark:from-blue-950/40 dark:to-blue-900/20 ring-1 ring-blue-200/60 dark:ring-blue-800/40', label: 'group-hover:text-blue-600 dark:group-hover:text-blue-400' },
  cyan: { border: 'hover:border-cyan-300 dark:hover:border-cyan-800/80', chip: 'from-cyan-50 to-cyan-100/70 dark:from-cyan-950/40 dark:to-cyan-900/20 ring-1 ring-cyan-200/60 dark:ring-cyan-800/40', label: 'group-hover:text-cyan-600 dark:group-hover:text-cyan-400' },
  emerald: { border: 'hover:border-emerald-300 dark:hover:border-emerald-800/80', chip: 'from-emerald-50 to-emerald-100/70 dark:from-emerald-950/40 dark:to-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/40', label: 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400' },
  indigo: { border: 'hover:border-indigo-300 dark:hover:border-indigo-800/80', chip: 'from-indigo-50 to-indigo-100/70 dark:from-indigo-950/40 dark:to-indigo-900/20 ring-1 ring-indigo-200/60 dark:ring-indigo-800/40', label: 'group-hover:text-indigo-600 dark:group-hover:text-indigo-400' },
  orange: { border: 'hover:border-orange-300 dark:hover:border-orange-800/80', chip: 'from-orange-50 to-orange-100/70 dark:from-orange-950/40 dark:to-orange-900/20 ring-1 ring-orange-200/60 dark:ring-orange-800/40', label: 'group-hover:text-orange-600 dark:group-hover:text-orange-400' },
  purple: { border: 'hover:border-purple-300 dark:hover:border-purple-800/80', chip: 'from-purple-50 to-purple-100/70 dark:from-purple-950/40 dark:to-purple-900/20 ring-1 ring-purple-200/60 dark:ring-purple-800/40', label: 'group-hover:text-purple-600 dark:group-hover:text-purple-400' },
  rose: { border: 'hover:border-rose-300 dark:hover:border-rose-800/80', chip: 'from-rose-50 to-rose-100/70 dark:from-rose-950/40 dark:to-rose-900/20 ring-1 ring-rose-200/60 dark:ring-rose-800/40', label: 'group-hover:text-rose-600 dark:group-hover:text-rose-400' },
  sky: { border: 'hover:border-sky-300 dark:hover:border-sky-800/80', chip: 'from-sky-50 to-sky-100/70 dark:from-sky-950/40 dark:to-sky-900/20 ring-1 ring-sky-200/60 dark:ring-sky-800/40', label: 'group-hover:text-sky-600 dark:group-hover:text-sky-400' },
  // Steel, for the gear: a shade darker than the tinted tiles, so it reads as metal.
  slate: { border: 'hover:border-slate-400 dark:hover:border-slate-600', chip: 'from-slate-100 to-slate-200/80 dark:from-slate-800 dark:to-slate-900 ring-1 ring-slate-300/70 dark:ring-slate-700/60', label: 'group-hover:text-slate-900 dark:group-hover:text-white' },
  violet: { border: 'hover:border-violet-300 dark:hover:border-violet-800/80', chip: 'from-violet-50 to-violet-100/70 dark:from-violet-950/40 dark:to-violet-900/20 ring-1 ring-violet-200/60 dark:ring-violet-800/40', label: 'group-hover:text-violet-600 dark:group-hover:text-violet-400' },
} as const;

export type TileColor = keyof typeof TILE_COLORS;

/** How a tile's icon turns on hover. Literal classes, for the same reason as the colours. */
export type TileSpin =
  | 'group-hover:rotate-3' | 'group-hover:-rotate-3'
  | 'group-hover:rotate-6' | 'group-hover:-rotate-6'
  | 'group-hover:rotate-45';

export interface PaletteTileProps {
  label: string;
  title?: string;
  color: TileColor;
  spin: TileSpin;
  /** A slower turn, for the round things that spin a full 45°. */
  slow?: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  /** Set for a part that can also be dragged onto the canvas: what the drop adds. */
  dragType?: string;
  onDragStart?: (e: React.DragEvent, type: string) => void;
  /**
   * Set (true or false) for a tile that is sometimes unavailable — a hardware
   * cut with no part selected. It renders as a button that can be disabled
   * and carries the disabled styling; leave it unset for one that never is.
   */
  disabled?: boolean;
  /** A real <button> rather than a draggable div; hardware tiles are buttons. */
  button?: boolean;
}

export function PaletteTile({ label, title, color, spin, slow, icon, onClick, dragType, onDragStart, disabled, button }: PaletteTileProps) {
  const c = TILE_COLORS[color];
  const className = `p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md ${c.border} active:translate-y-0 active:scale-[0.97] transition-all duration-150 group${
    disabled !== undefined ? ' disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-xs' : ''
  }`;
  const content = (
    <>
      <div className={`p-1.5 bg-gradient-to-br ${c.chip} rounded-lg mb-1 group-hover:scale-110 ${spin} transition-transform ${slow ? 'duration-300' : 'duration-200'}`}>
        {icon}
      </div>
      <span className={`text-[10px] font-bold text-slate-700 dark:text-slate-200 ${c.label} transition-colors`}>
        {label}
      </span>
    </>
  );
  if (button) {
    return <button onClick={onClick} disabled={disabled} title={title} className={className}>{content}</button>;
  }
  return (
    <div
      draggable={dragType ? true : undefined}
      onDragStart={dragType && onDragStart ? (e) => onDragStart(e, dragType) : undefined}
      onClick={onClick}
      className={className}
      title={title}
    >
      {content}
    </div>
  );
}
