import { useState } from 'react';
import { Printer } from 'lucide-react';

/**
 * Asks for the size to print at: the longest side of the longest part, in mm.
 * `onConfirm` gets a positive number; anything else is refused in place.
 */
export function ExportScaleModal({
  title,
  initialMm,
  onConfirm,
  onCancel,
}: {
  title: string;
  initialMm: string;
  onConfirm: (targetMm: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialMm);
  const [error, setError] = useState<string | undefined>(undefined);

  const confirm = () => {
    const targetMm = parseFloat(value);
    if (isNaN(targetMm) || targetMm <= 0) {
      setError('Enter a valid size greater than 0 mm.');
      return;
    }
    onConfirm(targetMm);
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[120] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center text-blue-600 dark:text-blue-400">
            <Printer className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">{title}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Longest part&apos;s longest side (mm)</p>
          </div>
        </div>
        <input
          autoFocus
          type="number"
          min="0.1"
          step="any"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(undefined); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono"
        />
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400 -mt-2">{error}</p>
        )}
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors cursor-pointer"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
