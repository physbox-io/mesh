import { describe, it, expect } from 'vitest';
import { runExportJob } from '../src/utils/exportJobs';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import { PRESETS } from '../src/presets/presetScenes';

// Sheet G-code runs on the export worker now; the job must be the exporter, unchanged.
describe('the laserGcode export job', () => {
  it('writes the program the exporter writes, for the router and the laser', () => {
    const layout = exportLaserCutSvg(PRESETS.birdhouse.scene, { ...DEFAULT_LASER_OPTIONS, cornerRelief: 'dogbone' });
    expect(layout.success).toBe(true);
    for (const machineMode of ['cnc', 'laser'] as const) {
      const gcodeOptions = { ...DEFAULT_GCODE_OPTIONS, machineMode, cutDepthZ: 3, zStepdown: 3 };
      const direct = generateLaserCutGcode(layout.panels!, gcodeOptions);
      const job = runExportJob('laserGcode', { nodes: [] }, { panels: layout.panels!, gcodeOptions });
      expect(job.success).toBe(true);
      // The header's date is the only line that may differ.
      const undated = (g: string) => g.replace(/^; Date: .*$/m, '');
      expect(undated(job.gcode!)).toBe(undated(direct.gcode!));
    }
  });
});
