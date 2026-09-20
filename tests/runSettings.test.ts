/**
 * What a run is filed under in the archive.
 *
 * The job history list reads one key — `material` — out of a settings blob that
 * has no schema across the apps, and shows nothing at all when it is absent.
 */
import { describe, it, expect } from 'vitest';
import { runSettings } from '../src/utils/runSettings';

describe('runSettings', () => {
  it('always carries the material and the kind of machine', () => {
    const s = runSettings({ material: 'Hardwood (oak, maple, walnut)', machine: 'cnc' });
    expect(s.material).toBe('Hardwood (oak, maple, walnut)');
    expect(s.machine).toBe('cnc');
  });

  it('leaves out what this job has no answer for', () => {
    const laser = runSettings({
      material: 'Plywood',
      machine: 'laser',
      stockThicknessMm: 3,
      laserPower: 850,
      passes: 2,
      cutFeedrate: 1200,
    });
    expect(laser).toEqual({
      material: 'Plywood',
      machine: 'laser',
      stockThickness: 3,
      power: 850,
      passes: 2,
      cutFeedrate: 1200,
    });
    expect('spindleRpm' in laser).toBe(false);
  });

  it('keeps a zero rather than treating it as nothing to say', () => {
    const s = runSettings({ material: 'Acrylic', machine: 'cnc', depthMm: 0 });
    expect(s.depthMm).toBe(0);
  });

  it('records both bits on a job that changes tools', () => {
    const s = runSettings({
      material: 'Aluminium',
      machine: 'cnc',
      tool: '6mm flat, 2 flute',
      secondTool: '2mm ball nose, 2 flute',
      spindleRpm: 14000,
    });
    expect(s.tool).toBe('6mm flat, 2 flute');
    expect(s.secondTool).toBe('2mm ball nose, 2 flute');
  });
});
