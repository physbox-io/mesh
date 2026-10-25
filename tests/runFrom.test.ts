import { describe, it, expect } from 'vitest';
import { clampRunFromLine, describeStoppedJob, runFromGate } from '../src/utils/runFrom';
import type { ResumePoint } from '../src/utils/webSerialManager';

const offer = (over: Partial<ResumePoint> = {}): ResumePoint => ({
  fromLine: 4140,
  stoppedAtLine: 4210,
  totalLines: 9000,
  reason: 'alarm',
  ...over,
});

describe('what the run area says about a stopped job', () => {
  /*
   * A refused line is stood down as an 'alarm' too, and the banner used to
   * say "a limit switch" for an error:22 — the wrong failure to go and fix.
   */
  it('leads with the words the job stopped with, not a guess at them', () => {
    const s = describeStoppedJob(offer({ message: 'The machine refused line 4210 of the program (error:22).' }));
    expect(s.why).toMatch(/refused line 4210/);
    expect(s.why).not.toMatch(/limit switch/);
    // Not said twice.
    expect(s.detail).toBeNull();
  });

  it('falls back to the reason when nothing was said', () => {
    expect(describeStoppedJob(offer()).why).toMatch(/alarmed/);
    expect(describeStoppedJob(offer({ reason: 'disconnected' })).why).toMatch(/connection/);
    expect(describeStoppedJob(offer({ reason: 'cancelled' })).why).toMatch(/stopped/);
  });

  it('keeps the tool-change explanation, with the controller\'s words under it', () => {
    const s = describeStoppedJob(offer({
      message: 'Hard limit triggered.',
      pendingPause: { kind: 'tool-change', message: 'Tool change: fit the ball nose.' },
    }));
    expect(s.why).toMatch(/tool change/);
    expect(s.detail).toBe('Hard limit triggered.');
  });

  it('gives the line it stopped at and the line it suggests, and how far apart', () => {
    const s = describeStoppedJob(offer());
    expect(s.stoppedAtLine).toBe(4210);
    expect(s.suggestedLine).toBe(4140);
    expect(s.windBack).toBe(70);
  });

  it('treats an offer with no stop line, or a park, as stopping where it suggests', () => {
    const s = describeStoppedJob(offer({ stoppedAtLine: undefined }));
    expect(s.stoppedAtLine).toBe(4140);
    expect(s.windBack).toBe(0);
  });

  it('keeps a typed line inside the program', () => {
    expect(clampRunFromLine(-3, 100)).toBe(0);
    expect(clampRunFromLine(250, 100)).toBe(100);
    expect(clampRunFromLine(41.6, 100)).toBe(42);
  });
});

describe('whether Run From can be pressed', () => {
  it('needs a machine', () => {
    expect(runFromGate({ connected: false }, null)).toEqual({ disabled: true, title: 'Connect to the machine first' });
  });

  it('is shut for the reason the manager would refuse with', () => {
    const why = 'The machine lost its position … Home it, or jog back to the origin and zero X and Y again, before running.';
    expect(runFromGate({ connected: true }, why)).toEqual({ disabled: true, title: why });
  });

  it('opens once nothing stands in the way', () => {
    expect(runFromGate({ connected: true }, null).disabled).toBe(false);
  });
});
