// While a Volt page drives this scene, say so: the play button and the clock
// belong to Volt, and a scene that will not play on its own looks broken.

import { Cable } from 'lucide-react';
import { endVoltLink, useStore } from '../store/useStore';

export function VoltLinkBanner() {
  const link = useStore((s) => s.voltLink);
  if (!link) return null;
  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-amber-50/95 dark:bg-amber-950/90 border border-amber-400 dark:border-amber-700 px-3.5 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-100 shadow-md backdrop-blur-md">
      <Cable className="w-3.5 h-3.5" />
      <span>Driven by Volt — the circuit sets the time</span>
      <button
        type="button"
        onClick={endVoltLink}
        className="ml-1 rounded-full border border-amber-400 dark:border-amber-600 px-2 py-0.5 text-[11px] hover:bg-amber-100 dark:hover:bg-amber-900"
      >
        Unlink
      </button>
    </div>
  );
}
