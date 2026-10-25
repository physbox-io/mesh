import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobResumeBanner, JobTransport } from '../src/components/MachineJobControls';
import { webSerialManager, type MachineState } from '../src/utils/webSerialManager';

/*
 * A laser never sets a Z datum, so `needsZZero` stays true all session. The
 * resume buttons were gated on it directly, which on a laser held every one of
 * them shut for good.
 */
const laserState = (patch: Partial<MachineState>): MachineState => ({
  ...webSerialManager.getState(),
  connected: true,
  needsZZero: true,
  ...patch,
});

/** Whether the button whose label contains `label` is rendered disabled. */
function disabled(html: string, label: string): boolean {
  const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
  const button = buttons.find((b) => b.includes(label));
  expect(button, `a "${label}" button`).toBeDefined();
  return /\sdisabled=""/.test(button!.match(/<button[^>]*>/)![0]);
}

const transport = (state: MachineState, requiresZZero: boolean) =>
  renderToStaticMarkup(
    React.createElement(JobTransport, {
      machineState: state, canStart: true, onStart: () => {}, startLabel: 'Start', requiresZZero,
    })
  );

describe('resume buttons on a laser, whose Z datum is never set', () => {
  it('lets a parked laser job resume', () => {
    const state = laserState({ status: 'PAUSED_PARKED' });
    expect(disabled(transport(state, false), 'Resume Here')).toBe(false);
    expect(disabled(transport(state, true), 'Resume Here')).toBe(true);
  });

  it('lets a laser job paused for a sheet swap resume', () => {
    const state = laserState({ status: 'PAUSED_MATERIAL' });
    expect(disabled(transport(state, false), 'Resume')).toBe(false);
    expect(disabled(transport(state, true), 'Resume')).toBe(true);
  });

  it('lets a stopped laser job be picked up from its line', () => {
    const state = laserState({
      status: 'IDLE',
      resume: { fromLine: 120, totalLines: 400, reason: 'disconnected', jobName: null },
    });
    const banner = (showZTools: boolean) =>
      renderToStaticMarkup(React.createElement(JobResumeBanner, { machineState: state, showZTools }));
    expect(disabled(banner(false), 'Run From')).toBe(false);
    expect(disabled(banner(true), 'Run From')).toBe(true);
  });
});
