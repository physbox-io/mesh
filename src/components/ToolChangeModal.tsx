import React from 'react';
import { createPortal } from 'react-dom';
import { ToolChangeDialog, setShimMm, setTouchPlateMm, useShimMm, useTouchPlateMm } from '@physbox-io/ui';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { useJobPause, pauseKey } from '../store/jobPauseStore';
import { CheckpointBadge } from './CheckpointBadge';

/**
 * A job parked at a tool change, as its own dialog: the pad to bring the new
 * bit down, both ways to take Z from its tip, and Resume — held until Z
 * describes the bit in the spindle.
 *
 * Material swaps and parks keep `JobPauseModal`; they have nothing to zero.
 * No override: the bit Z was zeroed with is not asked about again (the
 * package keeps that datum), and a different bit always takes a re-zero.
 */
export const ToolChangeModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  const hiddenKey = useJobPause((s) => s.hiddenKey);
  const hide = useJobPause((s) => s.hide);
  const plateMm = useTouchPlateMm();
  const shimMm = useShimMm();

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const { status, pauseMessage } = machineState;
  const key = pauseKey(status, pauseMessage);
  if (status !== 'PAUSED_TOOL' || hiddenKey === key) return null;

  const laser = webSerialManager.isLaserJob();
  const blocked = !laser && machineState.needsZZero;

  const dialog = (
    <ToolChangeDialog
      machine={laser ? 'laser' : 'cnc'}
      message={pauseMessage ?? 'Fit the next tool.'}
      progress={{ line: machineState.currentLine, total: machineState.totalLines }}
      position={machineState.wpos}
      connected={machineState.connected}
      onJog={(delta, feed) => webSerialManager.jog(delta, feed)}
      onJogStop={() => webSerialManager.jogCancel()}
      zero={
        laser
          ? undefined
          : {
              zeroed: !machineState.needsZZero,
              plate: {
                mm: plateMm,
                onMmChange: (mm) => void setTouchPlateMm(mm),
                onProbe: (mm) => webSerialManager.zeroZ(mm),
              },
              byHand: {
                onZeroHere: (mm) => webSerialManager.zeroZHere(mm),
                shimMm,
                onShimMmChange: (mm) => void setShimMm(mm),
              },
              probeCircuit: { active: machineState.probePinActive, seen: machineState.probeCircuitSeen },
            }
      }
      resumeBlockedReason={blocked ? 'Zero Z on the new bit before resuming.' : null}
      onResume={() => webSerialManager.resumeJob()}
      onStop={() => webSerialManager.cancelJob()}
      onHide={() => hide(key)}
    >
      <CheckpointBadge feedHold={false} className="text-slate-500 dark:text-slate-400" />
      {machineState.lastError && (
        <p className="text-[11px] leading-snug text-red-600 dark:text-red-400">{machineState.lastError}</p>
      )}
    </ToolChangeDialog>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
};
