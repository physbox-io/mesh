import { describe, it, expect } from 'vitest';
import { generateScadForNode, parseScadVariables, replaceVarInCode } from '../src/utils/scadSource';
import type { SceneNode } from '../src/types/scene';

/** Whether a range input with these bounds and step can hold the value at all. */
function reachable(v: { min: number; max: number; step: number }, value: number): boolean {
  const k = (value - v.min) / v.step;
  return value >= v.min - 1e-9 && value <= v.max + 1e-9 && Math.abs(k - Math.round(k)) < 1e-6;
}

describe('parseScadVariables', () => {
  it('takes bounds and step from a [min:step:max] comment', () => {
    const [v] = parseScadVariables('thickness = 2.0; // [0.5:0.5:10]');
    expect(v).toMatchObject({ name: 'thickness', value: 2, min: 0.5, max: 10, step: 0.5, lineIndex: 0 });
  });

  it('gives a generated box a slider that can move', () => {
    // It used to be 0.08..0.12 with a 0.05 step: 0.08 was the only value on it.
    const node = { id: 'box_scad', pos: [0, 0, 0], geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }] } as unknown as SceneNode;
    const vars = parseScadVariables(generateScadForNode(node));
    expect(vars.map((v) => v.name)).toEqual(['sx', 'sy', 'sz']);
    for (const v of vars) {
      expect(reachable(v, v.value)).toBe(true);
      expect(reachable(v, v.value + v.step)).toBe(true);
    }
  });

  it('steps an integer [min:max] range by one', () => {
    const [v] = parseScadVariables('tooth_count = 6; // [3:12]');
    expect(v).toMatchObject({ min: 3, max: 12, step: 1 });
  });

  it('divides a fractional [min:max] range into a hundred steps', () => {
    const [v] = parseScadVariables('gear_radius = 0.4; // [0.1:1.0]');
    expect(v.min).toBe(0.1);
    expect(v.max).toBe(1);
    expect(v.step).toBeCloseTo(0.009, 6);
  });

  it('widens a declared range to take in a value written outside it', () => {
    const [v] = parseScadVariables('w = 20; // [0:1:10]');
    expect(v).toMatchObject({ min: 0, max: 20, step: 1 });
  });

  it('keeps a ±20% window when there is no comment', () => {
    const [v] = parseScadVariables('r = 5;');
    expect(v.min).toBeCloseTo(4);
    expect(v.max).toBeCloseTo(6);
    expect(v.step).toBeCloseTo(0.02);
  });

  it('shrinks a step too large for its range', () => {
    const [v] = parseScadVariables('h = 0.3; // [0.2:5:0.4]');
    expect(v.step).toBeLessThanOrEqual(v.max - v.min);
    expect(reachable(v, v.value)).toBe(true);
  });

  it('ignores assignments inside blocks', () => {
    const vars = parseScadVariables('a = 1;\nmodule m() {\n  b = 2;\n}\nc = 3;');
    expect(vars.map((v) => v.name)).toEqual(['a', 'c']);
  });
});

describe('replaceVarInCode', () => {
  it('rewrites the top-level value and keeps the comment', () => {
    expect(replaceVarInCode('sx = 0.100; // [0.1:0.05:3.0]\ncube(sx);', 'sx', 0.15)).toBe('sx = 0.15; // [0.1:0.05:3.0]\ncube(sx);');
  });

  it('keeps a millimetre value written in metres', () => {
    expect(replaceVarInCode('t = 0.004;', 't', 0.005)).toBe('t = 0.005;');
  });

  it('leaves a same-named variable inside a block alone', () => {
    expect(replaceVarInCode('module m() {\n  a = 1;\n}\na = 2;', 'a', 9)).toBe('module m() {\n  a = 1;\n}\na = 9;');
  });
});
