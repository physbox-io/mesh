// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
 * A paused job must never be lost behind a closed dialog. Hide a tool change,
 * let another window come and go, and the status bar has to offer an obvious
 * way back to the dialog — with the re-zero and Resume in it — without the job
 * having been touched by any of it.
 */

type Listener = (s: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
let state: Record<string, unknown> = {};
const base = {
  connected: true, status: 'PAUSED_TOOL', currentLine: 990, totalLines: 3000, progressPercent: 33,
  elapsedSeconds: 600, remainingSeconds: 1200,
  wpos: { x: 1, y: 2, z: 3 }, mpos: { x: 0, y: 0, z: 0 }, pauseMessage: 'Fit T2: 3 mm ball nose',
  needsZZero: true, probePinActive: false, probeCircuitSeen: true,
};
const machine = new Proxy(
  {
    getState: () => state,
    addListener: (l: Listener) => { listeners.add(l); return () => listeners.delete(l); },
    resumeJob: vi.fn().mockResolvedValue(undefined),
    resumeFromPark: vi.fn().mockResolvedValue(true),
    cancelJob: vi.fn(), pauseJob: vi.fn(), eStop: vi.fn(),
    isLaserJob: () => false,
    jog: vi.fn().mockResolvedValue(undefined), jogCancel: vi.fn(),
    zeroZ: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    zeroZHere: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  } as Record<string, unknown>,
  // Anything else a component asks of the machine is a no-op here.
  { get: (t, k: string) => (k in t ? t[k] : () => undefined) },
);
vi.mock('../src/utils/webSerialManager', () => ({ webSerialManager: machine }));

const { BottomStatusBar } = await import('../src/components/BottomStatusBar');
const { JobPauseModal } = await import('../src/components/JobPauseModal');
const { ToolChangeModal } = await import('../src/components/ToolChangeModal');
const { jobPause } = await import('../src/utils/jobPause');

let root: Root;
let host: HTMLDivElement;
const set = (patch: Record<string, unknown>) => {
  state = { ...state, ...patch };
  act(() => listeners.forEach((l) => l(state)));
};
const button = (text: string | RegExp) =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    typeof text === 'string' ? b.textContent?.includes(text) : text.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector('[role="dialog"]');
const click = (b: HTMLButtonElement | undefined) => {
  expect(b).toBeTruthy();
  act(() => b!.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  jobPause.show();
  state = { ...base };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <BottomStatusBar onOpenMachineConfig={() => {}} exports={new Proxy({}, { get: () => () => {} }) as never} />
        <JobPauseModal />
        <ToolChangeModal />
      </>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('getting back to a hidden tool change', () => {
  it('hides, and comes back from the status bar with the re-zero and Resume', () => {
    expect(dialog()?.textContent).toContain('Tool change');
    click(button('Hide'));
    expect(dialog()).toBeNull();
    expect(machine.resumeJob).not.toHaveBeenCalled();
    expect(machine.cancelJob).not.toHaveBeenCalled();

    set({ wpos: { x: 5, y: 2, z: 3 } });
    expect(dialog()).toBeNull();

    click(button('Tool change: zero Z'));
    expect(dialog()?.textContent).toContain('Zero Z on the new bit');
    expect(button(/Probe Z zero/)).toBeTruthy();
    expect(button('Set Z zero here')).toBeTruthy();
    expect(button('Resume job')!.disabled).toBe(true);

    set({ needsZZero: false });
    click(button('Resume job'));
    expect(machine.resumeJob).toHaveBeenCalled();
  });

  it('opens the next tool change by itself', () => {
    click(button('Hide'));
    set({ currentLine: 2100, pauseMessage: 'Fit T3: 1 mm end mill' });
    expect(dialog()?.textContent).toContain('Fit T3');
  });

  it('does the same for a feed hold and a park', () => {
    set({ status: 'PAUSED_OPERATOR', pauseMessage: undefined, needsZZero: false });
    expect(dialog()?.textContent).toContain('Paused');
    click(button('Hide'));
    set({ currentLine: 993 });
    expect(dialog()).toBeNull();
    click(button('Paused: resume'));
    click(button('Resume job'));
    expect(machine.resumeJob).toHaveBeenCalled();

    set({ status: 'PAUSED_PARKED', pauseMessage: 'Parked' });
    click(button('Hide'));
    click(button('Parked: resume'));
    click(button('Resume job'));
    expect(machine.resumeFromPark).toHaveBeenCalled();
  });
});
