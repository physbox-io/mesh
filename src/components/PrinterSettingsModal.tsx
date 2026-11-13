// ---------------------------------------------------------------------------
// The printer on the bench: FDM or resin, and the nozzle and layer it prints at.
//
// Opened from the wrench beside "Export only", as the CNC and laser open their
// machine setup. The app never drives a printer, so there is nothing to
// connect: what it needs is the thinnest wall and skin the printer makes, which
// molds hold every liner and shell to.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { MAX_LAYER_MM, MAX_XY_MM, MIN_LAYER_MM, MIN_XY_MM, NOZZLE_CHOICES_MM, printLimits } from '../utils/printerSettings';

const fieldClass =
  'px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-xs';

export function PrinterSettingsModal({ onClose }: { onClose: () => void }) {
  const printer = useStore((s) => s.printer);
  const setPrinter = useStore((s) => s.setPrinter);
  const limits = printLimits(printer);
  const resin = printer.process === 'resin';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Printer"
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-sm w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
            <Printer className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base flex-1">Printer</h2>
          <button type="button" onClick={onClose} title="Close" className="p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs text-slate-600 dark:text-slate-300">
          <label htmlFor="printer-process">Type</label>
          <select
            id="printer-process"
            value={printer.process}
            onChange={(e) => setPrinter({ process: e.target.value === 'resin' ? 'resin' : 'fdm' })}
            className={fieldClass}
          >
            <option value="fdm">Filament (FDM)</option>
            <option value="resin">Resin (SLA / MSLA)</option>
          </select>

          {!resin && (
            <>
              <label htmlFor="printer-nozzle">Nozzle</label>
              <select
                id="printer-nozzle"
                value={printer.nozzleMm}
                onChange={(e) => setPrinter({ nozzleMm: Number(e.target.value) })}
                className={fieldClass}
              >
                {NOZZLE_CHOICES_MM.map((d) => (
                  <option key={d} value={d}>{d} mm</option>
                ))}
              </select>
            </>
          )}

          <label htmlFor="printer-layer">Layer height</label>
          <span className="flex items-center gap-1">
            <NumberInput
              id="printer-layer"
              min={MIN_LAYER_MM}
              max={MAX_LAYER_MM}
              step={0.01}
              fallbackOnBlur={printer.layerMm}
              value={printer.layerMm}
              onChange={(v) => { if (v !== undefined && Number.isFinite(v)) setPrinter({ layerMm: v }); }}
              className={`w-20 ${fieldClass}`}
              title="The layer height you print at, mm"
            />
            <span className="text-slate-400">mm</span>
          </span>

          {resin && (
            <>
              <label htmlFor="printer-xy">XY resolution</label>
              <span className="flex items-center gap-1">
                <NumberInput
                  id="printer-xy"
                  min={MIN_XY_MM}
                  max={MAX_XY_MM}
                  step={0.005}
                  fallbackOnBlur={printer.xyMm}
                  value={printer.xyMm}
                  onChange={(v) => { if (v !== undefined && Number.isFinite(v)) setPrinter({ xyMm: v }); }}
                  className={`w-20 ${fieldClass}`}
                  title="The screen's pixel pitch, mm"
                />
                <span className="text-slate-400">mm</span>
              </span>
            </>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-3">
          Thinnest skin <strong className="text-slate-700 dark:text-slate-200">{limits.minSkinMm.toFixed(2)} mm</strong>, thinnest wall{' '}
          <strong className="text-slate-700 dark:text-slate-200">{limits.minWallMm.toFixed(2)} mm</strong>. Molds check every liner against these.
        </p>
      </div>
    </div>,
    document.body,
  );
}
