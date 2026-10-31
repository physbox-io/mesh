import { describe, it, expect } from 'vitest';
import {
  generateReliefCarveGcode,
  DEFAULT_RELIEF_OPTIONS,
} from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }, pos = [0, 0, 0]): SceneGraph {
  return {
    nodes: [{
      id: 'b1',
      name: 'part',
      type: 'body',
      pos,
      geoms: [{ name: 'g1', ...geom } as SceneGeom],
      joints: [],
      children: [],
    }],
  };
}

// A 100mm dome: sphere of radius 50mm centred at [0,0,0], top peak at +0.05m (50mm), base at 0.
const dome = bodyWith({ type: 'sphere', size: [0.05] }, [0, 0, 0]);

function zCutValues(gcode: string): number[] {
  return gcode
    .split('\n')
    .filter((l) => l.startsWith('G1 ') && l.includes('Z'))
    .map((l) => parseFloat(/Z(-?[\d.]+)/.exec(l)![1]));
}

describe('Relief Inversion (Cameo -> Intaglio)', () => {
  it('carves dome peak at deepest floor and base at top surface when inverted', () => {
    // Normal cameo carve
    const normalResult = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      carveDepthMm: 10,
      stockWidthMm: 120,
      stockDepthMm: 120,
      roughingEnabled: false,
      invertRelief: false,
    });
    expect(normalResult.success).toBe(true);

    // Inverted intaglio carve
    const invertedResult = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      carveDepthMm: 10,
      stockWidthMm: 120,
      stockDepthMm: 120,
      roughingEnabled: false,
      invertRelief: true,
    });
    expect(invertedResult.success).toBe(true);

    const normalZs = zCutValues(normalResult.gcode);
    const invertedZs = zCutValues(invertedResult.gcode);

    expect(normalZs.length).toBeGreaterThan(0);
    expect(invertedZs.length).toBeGreaterThan(0);

    // Both remain within the 0 to -10mm stock range
    expect(Math.min(...normalZs)).toBeGreaterThanOrEqual(-10.1);
    expect(Math.min(...invertedZs)).toBeGreaterThanOrEqual(-10.1);
    expect(Math.max(...normalZs)).toBeLessThanOrEqual(0.01);
    expect(Math.max(...invertedZs)).toBeLessThanOrEqual(0.01);

    expect(invertedResult.segments.length).toBeGreaterThan(0);

    // Background corners outside the dome footprint stay uncut at Z = 0 when inverted
    // so the surrounding stock forms the cavity walls around the intaglio impression.
    for (const seg of invertedResult.segments) {
      for (const p of seg.points) {
        if ( p.z < -0.5) {
          expect(Math.hypot(p.x - 60, p.y - 60)).toBeLessThan(60);
        }
      }
    }
  });
});

// A low box, smaller than the stock, cut as modelled: the case where a cameo
// is told to set Background to Carve to cut the board round it down.
const smallBox = bodyWith({ type: 'box', size: [0.02, 0.02, 0.003] }, [0, 0, 0.003]);

describe('Intaglio ignores the cameo-only options, and says so honestly', () => {
  it('does not advise Background: Carve, which an intaglio never reads', () => {
    const result = generateReliefCarveGcode(smallBox, {
      ...DEFAULT_RELIEF_OPTIONS,
      verticalScaleMode: 'model',
      backgroundMode: 'skip',
      stockWidthMm: 80,
      stockDepthMm: 80,
      roughingEnabled: false,
      invertRelief: true,
    });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).not.toMatch(/Set Background to Carve/);
    // Background is the stock face around the impression, whatever was asked.
    const carved = generateReliefCarveGcode(smallBox, {
      ...DEFAULT_RELIEF_OPTIONS,
      verticalScaleMode: 'model',
      backgroundMode: 'carve',
      stockWidthMm: 80,
      stockDepthMm: 80,
      roughingEnabled: false,
      invertRelief: true,
    });
    expect(carved.gcode).toBe(result.gcode);
  });

  it('does not cut an intaglio through the board, and says Cut Through was not used', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      carveDepthMm: 10,
      stockWidthMm: 120,
      stockDepthMm: 120,
      roughingEnabled: false,
      invertRelief: true,
      cutThroughMm: 0.3,
    });
    expect(result.success).toBe(true);
    const text = result.warnings.join(' ');
    expect(text).not.toMatch(/Cuts through the/);
    expect(text).toMatch(/Cut Through/);
    expect(Math.min(...zCutValues(result.gcode))).toBeGreaterThanOrEqual(-(18 - 1) - 0.01);
  });
});
