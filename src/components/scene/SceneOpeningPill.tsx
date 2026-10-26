import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useSceneLoad } from '../../store/sceneLoadStore';

/** A load quicker than this shows nothing: a pill that blinks is worse than none. */
const SHOW_AFTER_MS = 300;

/** "Opening <scene>", beside "MCP Active", while a scene is fetched, downloaded and compiled. */
export function SceneOpeningPill() {
  const opening = useSceneLoad((s) => s.opening);
  const id = useSceneLoad((s) => s.id);
  // Which opening has lasted long enough to show.
  const [shownId, setShownId] = useState(0);

  useEffect(() => {
    if (!opening) return;
    const t = setTimeout(() => setShownId(id), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [opening, id]);

  if (!opening || shownId !== id) return null;
  return (
    <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto max-w-xs">
      <Loader2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400 animate-spin shrink-0" />
      <span className="tracking-wide truncate">Opening {opening}</span>
    </div>
  );
}
