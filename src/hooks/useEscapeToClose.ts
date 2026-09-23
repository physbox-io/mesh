import { useEffect, useRef } from 'react';
import { webSerialManager } from '../utils/webSerialManager';

/**
 * Closes a dialog on Escape, the way every dialog on the web does.
 *
 * Only four of the app's dialogs answered it; the export, import and machine
 * dialogs could only be left by finding their X. Registered in the bubble
 * phase and skipped when something already took the key (`defaultPrevented`),
 * so a field or a tool that uses Escape itself keeps it.
 *
 * Never while a machine job is streaming or paused: the export dialogs host
 * the job's Pause and E-Stop, and Escape is exactly the key someone reaches
 * for when a cut goes wrong. Hiding those controls then would be the worst
 * possible answer to it.
 */
export function useEscapeToClose(isOpen: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (webSerialManager.isRunning() || webSerialManager.isJobPaused()) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);
}
