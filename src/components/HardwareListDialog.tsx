import { useDialogs } from '../store/dialogStore';
import { useStore } from '../store/useStore';
import { downloadBlob } from '../utils/downloadBlob';
import { hardwareList, hardwareListCsv } from '../utils/hardwareList';

/**
 * What to buy for the scene: every bought part counted, and bar stock packed
 * onto the lengths it is sold in. Download gives it as CSV.
 */
export function openHardwareList(baseName = 'hardware') {
  const list = hardwareList(useStore.getState().sceneGraph);
  const { openDialog, closeDialog } = useDialogs.getState();
  openDialog({
    title: 'Hardware to buy',
    confirmLabel: 'Download CSV',
    cancelLabel: 'Close',
    tone: 'blue',
    body: (
      <div className="text-xs text-slate-600 dark:text-slate-300 space-y-2">
        <table className="w-full">
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.name} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-0.5 pr-2">{r.name}</td>
                <td className="py-0.5 text-right font-semibold tabular-nums">× {r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.bars.map((b) => (
          <div key={`${b.kind}${b.size}`}>
            <div className="font-semibold">{b.size}: {b.bars.length} bar{b.bars.length === 1 ? '' : 's'}</div>
            {b.bars.map((bar, i) => (
              <div key={i} className="text-[11px] text-slate-500 dark:text-slate-400">
                {bar.lengthMm} mm → {bar.cutsMm.join(' + ')} mm
              </div>
            ))}
            {b.tooLongMm.length > 0 && (
              <div className="text-[11px] text-rose-600 dark:text-rose-400">
                Longer than any bar sold: {b.tooLongMm.join(', ')} mm.
              </div>
            )}
          </div>
        ))}
      </div>
    ),
    onConfirm: () => {
      downloadBlob(new Blob([hardwareListCsv(list)], { type: 'text/csv' }), `${baseName}_hardware.csv`);
      closeDialog();
    },
    onCancel: closeDialog,
  });
}
