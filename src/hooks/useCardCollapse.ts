import { useEffect } from 'react';
import { useStore } from '../store/useStore';

/**
 * Click a card's h3 to fold it away. Both side panels get this: the palette
 * on the left and the properties inspector on the right are each an
 * `aside.glass-panel`, and the CSS in index.css is written against that
 * selector for both.
 *
 * This used to reach for `querySelector`, which returns only the first match
 * in document order — the left sidebar. The inspector's cards were never
 * wired up at all, so none of its thirty headers folded despite being styled
 * for it.
 *
 * Indicators are injected rather than rendered because the cards are plain
 * JSX all through the inspector. A MutationObserver picks up the ones that
 * mount later (a card revealed by a checkbox, a body selected after this
 * effect ran) — a single timeout only ever caught whatever existed 100ms in.
 *
 * Call it from the component that renders both panels: the effect looks them
 * up once it runs, so they have to be in the DOM by then. It looks again
 * whenever the selection changes.
 */
export function useCardCollapse() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  useEffect(() => {
    const panels = Array.from(document.querySelectorAll('aside.glass-panel'));
    if (panels.length === 0) return;

    const decorate = () => {
      for (const panel of panels) {
        panel.querySelectorAll('div > h3').forEach((h) => {
          if (h.querySelector('.collapse-indicator')) return;
          const indicator = document.createElement('span');
          indicator.className = 'collapse-indicator text-[9px] font-mono text-slate-400 dark:text-slate-500 font-normal normal-case';
          indicator.style.userSelect = 'none';
          // Mirrors the card's current state: a header that mounts inside an
          // already-folded card has to say [+], not [-].
          indicator.textContent = h.parentElement?.classList.contains('is-collapsed') ? ' [+]' : ' [−]';
          // Taken out of the header's flow rather than appended into it. These
          // headers are flex rows, several of them `justify-between` with a
          // docs (i) as the last child, so an extra child stops being a
          // trailing mark and becomes a third column — which shunts the (i)
          // from the right-hand edge into the middle of the header.
          const hHtml = h as HTMLElement;
          indicator.style.position = 'absolute';
          indicator.style.right = '0';
          indicator.style.top = '50%';
          indicator.style.transform = 'translateY(-50%)';
          hHtml.style.position = 'relative';
          hHtml.style.paddingRight = '1.1rem';
          h.appendChild(indicator);
          hHtml.style.cursor = 'pointer';
        });
      }
    };

    // Coalesced to one pass per frame: the inspector rewrites a lot of DOM
    // while a slider is being dragged, and every write lands here.
    let queued = 0;
    const schedule = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; decorate(); });
    };

    decorate();
    const observer = new MutationObserver(schedule);
    for (const panel of panels) observer.observe(panel, { childList: true, subtree: true });

    const handleHeaderClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const header = target.closest('h3');
      if (!header) return;
      if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('select')) return;

      const card = header.parentElement;
      if (!card) return;

      card.classList.toggle('is-collapsed');

      const indicator = header.querySelector('.collapse-indicator');
      if (indicator) {
        indicator.textContent = card.classList.contains('is-collapsed') ? ' [+]' : ' [−]';
      }
    };

    for (const panel of panels) panel.addEventListener('click', handleHeaderClick);

    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
      for (const panel of panels) panel.removeEventListener('click', handleHeaderClick);
    };
  }, [selectedNodeId]);
}
