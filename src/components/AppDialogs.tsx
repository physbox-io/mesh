import { ConfirmModal } from './ConfirmModal';
import { ExportScaleModal } from './ExportScaleModal';
import { useDialogs } from '../store/dialogStore';

/** The app-level dialog and the export-size prompt, from `useDialogs`. */
export function AppDialogs() {
  const dialog = useDialogs((s) => s.dialog);
  const closeDialog = useDialogs((s) => s.closeDialog);
  const scalePrompt = useDialogs((s) => s.scalePrompt);
  const closeScalePrompt = useDialogs((s) => s.closeScalePrompt);
  return (
    <>
      {dialog && (
        <ConfirmModal
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          cancelLabel={dialog.cancelLabel}
          hideCancel={dialog.hideCancel}
          tone={dialog.tone}
          onCancel={dialog.onCancel ?? closeDialog}
          onConfirm={dialog.onConfirm}
        />
      )}

      {scalePrompt && (
        <ExportScaleModal
          title={scalePrompt.title}
          initialMm={scalePrompt.value}
          onCancel={closeScalePrompt}
          onConfirm={(targetMm) => {
            const cb = scalePrompt.onConfirm;
            closeScalePrompt();
            cb(targetMm);
          }}
        />
      )}
    </>
  );
}
