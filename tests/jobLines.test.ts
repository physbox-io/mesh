import { describe, it, expect } from 'vitest';
import { prepareJobLines, classifyJobLine } from '../src/utils/webSerialManager';
import { generateReliefCarveGcode } from '../src/utils/reliefCarveExporter';
import { californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS } from '../src/presets/californiaRelief';

describe('prepareJobLines', () => {
  it('strips comments but keeps them for the operator', () => {
    const out = prepareJobLines(
      '; header\nM3 S12000 ; spindle on\n\n  G0 Z5.000  \nT2 M6 ; fit the 3.175 mm ball-nose mill and re-zero Z\n'
    );
    expect(out.map((l) => l.code)).toEqual(['M3 S12000', 'G0 Z5.000', 'T2 M6']);
    expect(out[0].note).toBe('spindle on');
    expect(out[1].note).toBe('');
    expect(out[2].note).toBe('fit the 3.175 mm ball-nose mill and re-zero Z');
  });

  it('drops whole-line comments rather than sending them', () => {
    const out = prepareJobLines('; --- OP 2: finishing raster ---\nG1 X1 Y2');
    expect(out).toHaveLength(1);
  });
});

describe('classifyJobLine', () => {
  it('finds the deliberate stops', () => {
    expect(classifyJobLine('T2 M6')).toBe('tool-change');
    expect(classifyJobLine('M06')).toBe('tool-change');
    expect(classifyJobLine('M0')).toBe('stop');
    expect(classifyJobLine('M1')).toBe('stop');
  });

  it('does not mistake the spindle or the end of the program for a stop', () => {
    // The bug this guards: a substring match on 'M0' or 'M6' pauses the job on
    // M30 at the very end, and the operator is asked to change a tool on a
    // carving that has already finished.
    expect(classifyJobLine('M30')).toBe('motion');
    expect(classifyJobLine('M3 S12000')).toBe('motion');
    expect(classifyJobLine('M03 S12000')).toBe('motion');
    expect(classifyJobLine('M5')).toBe('motion');
    expect(classifyJobLine('G1 X10.600 Y-6.000 Z-1.000')).toBe('motion');
  });
});

describe('a real relief carve program', () => {
  const gcode = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS).gcode;
  const lines = prepareJobLines(gcode);

  it('pauses exactly once, at the tool change between roughing and finishing', () => {
    const stops = lines.filter((l) => classifyJobLine(l.code) !== 'motion');
    expect(stops).toHaveLength(1);
    expect(classifyJobLine(stops[0].code)).toBe('tool-change');
    // The prompt is built from the exporter's own comment, so it has to survive.
    expect(stops[0].note).toContain('ball-nose');
  });

  it('sends no comment text to the controller', () => {
    expect(lines.every((l) => !l.code.includes(';'))).toBe(true);
  });

  it('reaches its own end rather than stopping on M30', () => {
    expect(classifyJobLine(lines[lines.length - 1].code)).toBe('motion');
    expect(lines[lines.length - 1].code).toBe('M30');
  });
});
