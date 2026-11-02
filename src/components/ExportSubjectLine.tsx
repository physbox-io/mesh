/**
 * What an export dialog is working on, under its title: the selected parts,
 * or the whole scene when nothing is selected (utils/moldSubject.ts). The
 * Mold dialog says "Molding: …"; the rest say it the same way.
 */
export function ExportSubjectLine({ verb, label }: { verb: string; label?: string }) {
  if (!label) return null;
  return (
    <p className="text-xs font-medium text-slate-600 dark:text-slate-300 truncate max-w-[60vw]" title={label}>
      {verb}: {label}
    </p>
  );
}
