import { AlertTriangle } from 'lucide-react';
import { useClothStatus, clothWarningsOf } from '../../store/clothStatus';

/**
 * What the last build said about this cloth: a name in its draft that matches
 * nothing (a pocket on a panel a drawn seam renamed, a trim along a line it does
 * not have), or why it could not be built. The same words MCP's reply carries.
 */
export function ClothWarnings({ name }: { name: string }) {
  const all = useClothStatus((s) => s.warnings);
  const mine = clothWarningsOf(all, name);
  if (!mine.length) return null;
  return (
    <div role="status" className="flex flex-col gap-1 p-2 rounded-md border border-amber-300/70 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30">
      {mine.map((w) => (
        <div key={w} className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}
