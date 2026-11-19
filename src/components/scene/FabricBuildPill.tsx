import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFabricBuild } from '../../store/fabricBuildStore';

/** A build quicker than this shows nothing: a pill that blinks is worse than none. */
const SHOW_AFTER_MS = 300;

/** "Fabric rendering", beside "MCP Active", while the worker models and settles a scene's cloth. */
export function FabricBuildPill() {
  const busy = useFabricBuild((s) => s.count > 0);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    // Hidden again once the build is over, ready to wait out the next one.
    return () => { clearTimeout(t); setShown(false); };
  }, [busy]);

  if (!busy || !shown) return null;
  return (
    <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
      <Loader2 className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400 animate-spin shrink-0" />
      <span className="tracking-wide">Fabric rendering</span>
    </div>
  );
}
