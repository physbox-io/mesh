// What a Mold tab's one-click chain came to (the run itself is useChainRun.ts).

/** What the finished piece came to, under the panel's settings. */
export function ChainResult({ title, lines }: { title: string; lines: string[] | null }) {
  if (!lines) return null;
  return (
    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-2.5 py-2 text-[11px] leading-snug text-emerald-900 dark:text-emerald-200 space-y-0.5">
      <div className="font-semibold">{title}</div>
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}
