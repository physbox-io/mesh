import { Info } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { DocsTabId } from '../../utils/docsTabs';

/**
 * Small reusable (i) affordance that deep-links a sidebar panel to its docs
 * tab. It reaches for the opener itself rather than taking one as a prop:
 * these sit in property cards all over the inspector, and every one of them
 * would otherwise have to be handed the same callback.
 */
export const DocsInfoButton = ({ tab, className = '', size = 'w-3.5 h-3.5' }: {
  tab: DocsTabId;
  className?: string;
  size?: string;
}) => {
  const openDocs = useStore((s) => s.openDocs);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openDocs(tab); }}
      className={`text-slate-400 hover:text-blue-600 transition-colors cursor-pointer shrink-0 ${className}`}
      title="Click for documentation"
    >
      <Info className={size} />
    </button>
  );
};
