import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { fillBodyDefaults } from '../src/hooks/useMCPBridge';

describe('fillBodyDefaults pos', () => {
  it('drops a top-level body from a metre up but sits a child at its parent', () => {
    const node = fillBodyDefaults({
      name: 'frame',
      geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }],
      children: [{ name: 'arm', geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }],
    });
    expect(node.pos).toEqual([0, 0, 1]);
    expect(node.children[0].pos).toEqual([0, 0, 0]);
  });

  it('sits a body added under a parent at the parent origin', () => {
    const node = fillBodyDefaults({ name: 'bolt', geoms: [{ type: 'cylinder', size: [0.002, 0.01] }] }, false);
    expect(node.pos).toEqual([0, 0, 0]);
  });
});
