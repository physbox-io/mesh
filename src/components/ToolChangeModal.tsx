import React from 'react';
import { createPortal } from 'react-dom';
import { ToolChangeDialog } from '@physbox-io/ui';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { useJobPause, pauseKey } from '../store/jobPauseStore';
import { CheckpointBadge } from './CheckpointBadge';

const PLATE_KEY = 'meshTouchPlateMm';
const SHIM_KEY = 'meshZeroShimMm';

function readMm(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeMm(key: string, mm: number): number {
  try {
    localStorage.setItem(key, String(mm));
  } catch {
    // Private mode: the value holds for this session only.
  }
  return mm;
}

/**
 * A job parked at a tool change, as its own dialog: the pad to bring the new
 * bit down, both ways to take Z from its tip, and Resume — held until Z
 * describes the bit in the spindle.
 *
 * Material swaps and parks keep `JobPauseModal`; they have nothing to zero.
 * The escape hatch stays: an operator whose datum already suits the new bit
 * (a tool-length setter, a collet-stop) can say so, for this stop only.
 */
export const ToolChangeModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  const hiddenKey = useJobPause((s) => s.hiddenKey);
  const hide = useJobPause((s) => s.hide);
  const [plateMm, setPlateMm] = React.useState(() => readMm(PLATE_KEY, 12));
  const [shimMm, setShimMm] = React.useState(() => readMm(SHIM_KEY, 0));
  const [overrideFor, setOverrideFor] = React.useState<string | null>(null);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const { status, pauseMessage } = machineState;
  const key = pauseKey(status, pauseMessage);
  if (status !== 'PAUSED_TOOL' || hiddenKey === key) return null;

  const laser = webSerialManager.isLaserJob();
  // An override given at the last tool change must not stand at this one.
  const overridden = overrideFor === key;
  const blocked = !laser && machineState.needsZZero && !overridden;

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
                onMmChange: (mm) => setPlateMm(writeMm(PLATE_KEY, mm)),
                onProbe: (mm) => webSerialManager.zeroZ(mm),
              },
              byHand: {
                onZeroHere: (mm) => webSerialManager.zeroZHere(mm),
                shimMm,
                onShimMmChange: (mm) => setShimMm(writeMm(SHIM_KEY, mm)),
              },
              probeCircuit: { active: machineState.probePinActive, seen: machineState.probeCircuitSeen },
            }
      }
      resumeBlockedReason={blocked ? 'Zero Z on the new bit before resuming.' : null}
      onResume={() => webSerialManager.resumeJob({ zIsSet: overridden })}
      onStop={() => webSerialManager.cancelJob()}
      onHide={() => hide(key)}
      footerExtra={
        blocked ? (
          <button
            type="button"
            onClick={() => setOverrideFor(key)}
            title="Only if the Z datum is already right for the tool now in the spindle"
            className="px-2 py-2 text-amber-700 dark:text-amber-400 hover:underline text-xs font-semibold cursor-pointer"
          >
            Z is already set, let me resume
          </button>
        ) : undefined
      }
    >
      <CheckpointBadge feedHold={false} className="text-slate-500 dark:text-slate-400" />
      {machineState.lastError && (
        <p className="text-[11px] leading-snug text-red-600 dark:text-red-400">{machineState.lastError}</p>
      )}
    </ToolChangeDialog>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
};
