import React, { useEffect, useState } from 'react';
import { Cpu, Home, ShieldAlert, X, Gauge, Wifi, WifiOff } from 'lucide-react';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { MachineWorkOriginPanel } from './MachineWorkOriginPanel';
import { JobOverrides } from './MachineJobControls';
import { describeMotionProfile } from '../utils/motionProfile';

/**
 * The machine itself, in one place.
 *
 * All of this used to be repeated inside each of the four export modals: the
 * connect button, the status light, the position readout, homing, unlocking,
 * the work-origin walkthrough. Four copies of one panel meant four chances to
 * drift, and they had — the same three buttons appeared in a different order
 * with different labels depending on which export you had opened, and the
 * origin panel was reachable from three of them but not the fourth.
 *
 * It also said something untrue about the app. There is one machine on the
 * bench. Connecting it is not part of exporting a relief carve any more than
 * it is part of exporting a laser cut, and putting it inside both implies you
 * might connect to one machine for one and a different machine for the other.
 *
 * What stays with the export is what genuinely belongs to that job: the
 * pre-flight list of which tools it wants, framing its outline on the stock,
 * and the button that starts it. Those need the job to exist. Nothing here
 * does.
 */
export const MachineConfigModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  /** Deep-links to the zeroing walkthrough in the app's Reference Guide. */
  onOpenDocs?: () => void;
  /** A laser has no touch plate and no Z datum, so it gets no probe section. */
  machineTarget: 'laser' | 'cnc';
}> = ({ isOpen, onClose, onOpenDocs, machineTarget }) => {
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());

  /*
   * How to reach the machine, remembered between sessions.
   *
   * The address is worth keeping because it is the one thing here nobody can
   * guess: a Tekno Box on the bench has whatever address the router gave it,
   * and retyping it before every job is exactly the friction that sends people
   * back to the USB cable.
   */
  const [link, setLink] = useState<'usb' | 'teknobox'>(
    () => (localStorage.getItem('physbox.machineLink') as 'usb' | 'teknobox') || 'usb'
  );
  const [host, setHost] = useState(() => localStorage.getItem('physbox.teknoboxHost') || '');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => webSerialManager.addListener(setMachineState), []);

  if (!isOpen) return null;

  const handleConnect = async () => {
    if (machineState.connected) {
      await webSerialManager.disconnect();
      return;
    }
    setConnecting(true);
    try {
      localStorage.setItem('physbox.machineLink', link);
      if (link === 'teknobox') localStorage.setItem('physbox.teknoboxHost', host.trim());
      await webSerialManager.connect(
        link === 'teknobox' ? { kind: 'teknobox', host: host.trim() } : { kind: 'usb' }
      );
    } finally {
      setConnecting(false);
    }
  };

  const canConnect =
    machineState.connected ||
    (link === 'teknobox' ? host.trim().length > 0 : webSerialManager.isSupported());

  const statusClass =
    machineState.status === 'RUNNING'
      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
      : machineState.status.startsWith('PAUSED')
        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse'
        : machineState.connected
          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
          : 'bg-slate-800 text-slate-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-blue-500/10">
              <Cpu className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">Machine Setup</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Connect the machine, home it, and set the work origin. Shared by every export.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Close machine setup"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-slate-700 dark:text-slate-300">
          {/* Connection */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {machineState.connected ? (
                  <Wifi className="w-4 h-4 text-emerald-500" />
                ) : (
                  <WifiOff className="w-4 h-4 text-slate-400" />
                )}
                <div>
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    <span>{link === 'teknobox' ? 'WiFi — Tekno Box' : 'USB Serial'}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${statusClass}`}>
                      {machineState.status}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {machineState.connected
                      ? `Connected (${machineState.portName})`
                      : link === 'teknobox'
                        ? 'The box plugs into the controller and relays GRBL over your network'
                        : webSerialManager.isSupported()
                          ? 'Connect a GRBL / Marlin / FluidNC controller to run jobs from the browser'
                          : 'WebSerial is not available in this browser — use Chrome, Edge, or Opera, or go over WiFi'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleConnect}
                disabled={!canConnect || connecting}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors ${
                  machineState.connected
                    ? 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                    : 'bg-blue-500 hover:bg-blue-600 text-slate-950'
                }`}
              >
                {link === 'teknobox' ? <Wifi className="w-3.5 h-3.5" /> : <Cpu className="w-3.5 h-3.5" />}
                <span>
                  {machineState.connected
                    ? 'Disconnect'
                    : connecting
                      ? 'Connecting…'
                      : link === 'teknobox'
                        ? 'Connect over WiFi'
                        : 'Connect USB Machine'}
                </span>
              </button>
            </div>

            {/* Which wire. Locked while a link is up: swapping the radio under a
                live connection would leave the button describing one transport
                and the machine on another. */}
            {!machineState.connected && (
              <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="flex bg-slate-200 dark:bg-slate-800 p-0.5 rounded-lg">
                  {(
                    [
                      ['usb', 'USB cable'],
                      ['teknobox', 'WiFi'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setLink(value)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                        link === value
                          ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {link === 'teknobox' && (
                  <>
                    <input
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="192.168.1.42"
                      spellCheck={false}
                      aria-label="Tekno Box address"
                      title="The address shown on the box's own screen. Just the host — no http:// and no path."
                      className="flex-1 min-w-[10rem] px-2 py-1 text-xs font-mono rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 basis-full">
                      The address on the box's own screen. This page has to be served over http, not
                      https — a secure page is not allowed to open a plain connection to the box.
                    </span>
                  </>
                )}
              </div>
            )}

            {machineState.connected && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2 bg-white dark:bg-slate-950 p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-mono">
                  <span className="text-slate-500">MPos:</span>
                  <span>
                    X:{machineState.mpos.x.toFixed(1)} Y:{machineState.mpos.y.toFixed(1)} Z:
                    {machineState.mpos.z.toFixed(1)}
                  </span>
                </div>
                <button
                  onClick={() => webSerialManager.homeMachine()}
                  className="py-1.5 px-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Home className="w-3.5 h-3.5 text-blue-500" />
                  <span>Home ($H)</span>
                </button>
                <button
                  onClick={() => webSerialManager.unlockAlarm()}
                  className="py-1.5 px-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 cursor-pointer"
                >
                  <ShieldAlert className="w-3.5 h-3.5 text-red-500" />
                  <span>Unlock ($X)</span>
                </button>
              </div>
            )}
          </div>

          {/* What the controller says it can do. Every feed, speed and run-time
              estimate in the app is derived from these, so it is worth being
              able to see whether they were read off the machine or assumed. */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
              <Gauge className="w-3.5 h-3.5 text-amber-500" />
              <span>Motion Limits</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                  machineState.motion.source === 'machine'
                    ? 'bg-emerald-500/20 text-emerald-500'
                    : 'bg-amber-500/20 text-amber-500'
                }`}
              >
                {machineState.motion.source === 'machine' ? 'from $$' : 'assumed'}
              </span>
            </h3>
            <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {describeMotionProfile(machineState.motion)}
            </p>
          </div>

          {machineState.connected && (
            <>
              <JobOverrides machineState={machineState} />
              <MachineWorkOriginPanel
                machineState={machineState}
                showZProbe={machineTarget === 'cnc'}
                onOpenDocs={onOpenDocs}
              />
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
