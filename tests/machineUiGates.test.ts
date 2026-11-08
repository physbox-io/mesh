import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobPreflight, JobResumeBanner } from '../src/components/MachineJobControls';
import { canStartProgram, settingsReadable, stopControl, unlockAllowed } from '../src/utils/machineGates';
import { readTouchPlateMm, setTouchPlateMm } from '@physbox-io/ui';
import { hubToken } from '../src/utils/apiClient';
import { toolStopKey } from '../src/store/jobPauseStore';
import { webSerialManager, type MachineState } from '../src/utils/webSerialManager';
import { prepareJobLines } from '../src/utils/machineJobLines';

/*
 * What the panels decide from machine state, without a DOM: when the stop shows,
 * when Unlock and Refresh are live, when Start is, and what a banner offers.
 */

const state = (patch: Partial<MachineState>): MachineState => ({
  ...webSerialManager.getState(),
  connected: true,
  status: 'IDLE',
  grblState: 'Idle',
  spindleSpeed: 0,
  guideSpot: false,
  ...patch,
});

describe('H3/H4: the stop control', () => {
  it('is the job’s while a job holds the machine', () => {
    expect(stopControl(state({ status: 'RUNNING', grblState: 'Run' }))).toBe('job');
    expect(stopControl(state({ status: 'PAUSED_TOOL' }))).toBe('job');
    expect(stopControl(state({ status: 'PAUSED_PARKED' }))).toBe('job');
  });

  it.each(['Run', 'Jog', 'Home', 'Hold:0', 'Door:0'])('is the machine’s on %s with no job', (word) => {
    expect(stopControl(state({ grblState: word }))).toBe('machine');
  });

  it('shows for a spindle left on in Idle, and in Alarm', () => {
    expect(stopControl(state({ spindleSpeed: 12000 }))).toBe('machine');
    expect(stopControl(state({ status: 'ALARM', grblState: 'Alarm', spindleSpeed: 12000 }))).toBe('machine');
  });

  it('stays away from a still machine, and a guide spot, which has its own off', () => {
    expect(stopControl(state({}))).toBeNull();
    expect(stopControl(state({ status: 'ALARM', grblState: 'Alarm' }))).toBeNull();
    expect(stopControl(state({ spindleSpeed: 10, guideSpot: true }))).toBeNull();
    expect(stopControl(state({ connected: false, status: 'DISCONNECTED', grblState: 'Run' }))).toBeNull();
  });
});

describe('C2 and the settings refresh', () => {
  it('Unlock is live in an alarm and on a stopped controller', () => {
    expect(unlockAllowed(state({ status: 'ALARM', grblState: 'Alarm' }))).toBe(true);
    expect(unlockAllowed(state({}))).toBe(true);
  });

  it('Unlock is shut while a job or a move holds the machine', () => {
    for (const status of ['RUNNING', 'PAUSED_OPERATOR', 'PAUSED_TOOL', 'PAUSED_MATERIAL', 'PAUSED_PARKED'] as const) {
      expect(unlockAllowed(state({ status }))).toBe(false);
    }
    expect(unlockAllowed(state({ grblState: 'Jog' }))).toBe(false);
  });

  it('Refresh is shut while a job holds the machine, but not at a tool change', () => {
    expect(settingsReadable(state({ status: 'RUNNING' }))).toBe(false);
    expect(settingsReadable(state({ status: 'PAUSED_OPERATOR' }))).toBe(false);
    expect(settingsReadable(state({ status: 'PAUSED_TOOL' }))).toBe(true);
    expect(settingsReadable(state({}))).toBe(true);
  });
});

describe('H6: Start waits for the program on screen', () => {
  const ready = { ready: true, busy: false, pending: false, failure: null };
  it('while it is being rebuilt, or failed to be', () => {
    expect(canStartProgram(state({}), ready)).toBe(true);
    expect(canStartProgram(state({}), { ...ready, busy: true })).toBe(false);
    expect(canStartProgram(state({}), { ...ready, pending: true })).toBe(false);
    expect(canStartProgram(state({}), { ...ready, failure: 'worker stopped' })).toBe(false);
    expect(canStartProgram(state({}), { ...ready, ready: false })).toBe(false);
    expect(canStartProgram(state({ status: 'RUNNING' }), ready)).toBe(false);
    expect(canStartProgram(state({ connected: false }), ready)).toBe(false);
  });
});

describe('C8: the preflight', () => {
  it('tells them to switch the spindle on, not just to set it', () => {
    const html = renderToStaticMarkup(
      React.createElement(JobPreflight, { machineState: state({}), rpm: 12000, origin: 'the corner' })
    );
    expect(html).toContain('Switch the spindle on at');
    expect(html).not.toContain('Set the spindle to');
  });
});

describe('H13: a resume banner goes by the job', () => {
  const mgr = webSerialManager as unknown as { program: unknown; state: Record<string, unknown> };
  afterEach(() => {
    mgr.program = [];
  });

  const offer = { fromLine: 3, totalLines: 7, reason: 'interrupted' as const, jobName: null, restored: true };

  it('gives a restored laser job no depth talk, whatever the modal thinks', () => {
    mgr.program = prepareJobLines('G21\nG90\nG0 X1\nM4 S500\nG1 X10 F1000\nM5\nM30');
    const html = renderToStaticMarkup(
      React.createElement(JobResumeBanner, { machineState: state({ resume: offer, needsZZero: true }) })
    );
    expect(html).not.toContain('going back down into the cut');
    expect(html).not.toMatch(/disabled=""[^>]*>[^<]*<svg[^>]*>.*Run From/);
  });

  it('gives a restored router job its depth talk even in a laser modal', () => {
    mgr.program = prepareJobLines('G21\nG90\nG0 Z5\nM3 S1000\nG1 Z-1 F100\nM5\nM30');
    const html = renderToStaticMarkup(
      React.createElement(JobResumeBanner, {
        machineState: state({ resume: offer, needsZZero: true }),
        showZTools: false,
      })
    );
    expect(html).toContain('Resuming will move over the stopping point');
  });
});

describe('H14: the touch plate', () => {
  const store = new Map<string, string>();
  const cookies = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    cookies.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('document', {
      get cookie() {
        return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      },
      set cookie(line: string) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        if (/Max-Age=0\b/.test(line)) cookies.delete(name);
        else cookies.set(name, pair.slice(eq + 1));
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is one figure shared by the suite, adopting the key Mesh used before', () => {
    expect(readTouchPlateMm()).toBe(12);
    store.set('meshTouchPlateMm', '19.05');
    expect(readTouchPlateMm()).toBe(19.05);
    expect(cookies.get('physbox_touch_plate_mm')).toBe('19.05');
    setTouchPlateMm(6.35);
    expect(readTouchPlateMm()).toBe(6.35);
    cookies.set('physbox_touch_plate_mm', 'junk');
    expect(readTouchPlateMm()).toBe(12);
  });
});

describe('H22: what the hub is offered', () => {
  it('is an API token, never the session', () => {
    expect(hubToken('pbx_abc123')).toBe('pbx_abc123');
    expect(hubToken('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBeUndefined();
    expect(hubToken(null)).toBeUndefined();
  });
});

describe('Skip Z zero', () => {
  it('belongs to the one stop, not the next with the same words', () => {
    expect(toolStopKey('PAUSED_TOOL|Tool change: 3 mm.', 40)).not.toBe(toolStopKey('PAUSED_TOOL|Tool change: 3 mm.', 90));
    expect(toolStopKey('PAUSED_TOOL|Tool change: 3 mm.', 40)).toBe(toolStopKey('PAUSED_TOOL|Tool change: 3 mm.', 40));
  });
});
