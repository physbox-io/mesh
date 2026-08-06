import { describe, it } from 'vitest';
import { writeFileSync } from 'fs';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { birdhousePreset } from '../src/presets/presetScenes';

describe('fit', () => {
  it('300x300 max 1 sheet', () => {
    const full = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS, sheetWidth: 0.6, sheetHeight: 0.4,
    });
    const fit = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS, sheetWidth: 0.3, sheetHeight: 0.3, autoScale: true, maxSheets: 1,
    });
    writeFileSync(`${process.env.SCRATCH}/fit_300.svg`, fit.svg!);
    writeFileSync(`${process.env.SCRATCH}/fit_600.svg`, full.svg!);

    console.log(`full: sheets=${full.sheetCount} scale=${full.scaleFactor}`);
    console.log(`fit : sheets=${fit.sheetCount} scale=${fit.scaleFactor}`);

    let maxX = 0, maxY = 0;
    for (const p of fit.panels!) {
      maxX = Math.max(maxX, p.placedPos2D!.x + p.width2D!);
      maxY = Math.max(maxY, p.placedPos2D!.y + p.height2D!);
    }
    console.log(`fit extents: ${maxX.toFixed(1)} x ${maxY.toFixed(1)} mm inside a 300 x 300 sheet`);

    console.log('panel                 100%            70%        ratio');
    for (const a of full.panels!) {
      const b = fit.panels!.find(x => x.name === a.name)!;
      console.log(
        `  ${a.name.padEnd(20)} ${a.width2D!.toFixed(1)}x${a.height2D!.toFixed(1)}`.padEnd(42) +
        `${b.width2D!.toFixed(1)}x${b.height2D!.toFixed(1)}`.padEnd(15) +
        `${(b.width2D! / a.width2D!).toFixed(3)} / ${(b.height2D! / a.height2D!).toFixed(3)}`
      );
    }

    // Joint pitch: does the finger layout stay in proportion, or hold its size?
    for (const [tag, r] of [['100%', full], ['70%', fit]] as const) {
      const q = r.panels!.find(x => x.name === 'floor_panel')!;
      const minY = Math.min(...q.outerPolygon2D.map(p => p.y));
      const xs = q.outerPolygon2D.filter(p => Math.abs(p.y - minY) < 0.01).map(p => p.x).sort((c, d) => c - d);
      const w: string[] = [];
      for (let i = 1; i < xs.length; i += 2) w.push((xs[i] - xs[i - 1]).toFixed(2));
      console.log(`${tag} floor teeth: ${w.join(' ')}  (tab depth = stock thickness, fixed at 3.0)`);
    }
  });
});
