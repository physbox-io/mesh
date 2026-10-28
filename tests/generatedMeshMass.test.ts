import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { generatedMeshMass } from '../src/utils/generatedMeshMass';
import type { RawNode } from '../src/utils/sceneNodes';

describe('generatedMeshMass', () => {
  it('says nothing by default, so MuJoCo weighs the mesh by its volume', () => {
    expect(generatedMeshMass({})).toEqual({});
    expect(generatedMeshMass(undefined)).toEqual({});
  });

  it('passes a density on, and lets a stated mass win over it', () => {
    expect(generatedMeshMass({ density: 700 })).toEqual({ density: 700 });
    expect(generatedMeshMass({ mass: 0.2, density: 700 })).toEqual({ mass: 0.2 });
  });

  it('ignores nonsense', () => {
    expect(generatedMeshMass({ mass: 0, density: -3 })).toEqual({});
    expect(generatedMeshMass({ mass: '1' })).toEqual({});
  });
});

describe('sculpt and lattice bodies built over MCP', () => {
  const geomOf = (b: RawNode) => fillBodyDefaults(b).geoms[0];

  it('no longer weigh a flat kilogram whatever their size', () => {
    const sculpt = geomOf({ name: 'horse', sculpt: { base: 'sphere', sizeMm: 40 } } as RawNode);
    const lattice = geomOf({ name: 'bracket', lattice: { sizeMm: 40 } } as RawNode);
    expect(sculpt.mass).toBeUndefined();
    expect(lattice.mass).toBeUndefined();
  });

  it('honour density and mass given on the body', () => {
    expect(geomOf({ name: 'oak', density: 700, sculpt: { sizeMm: 40 } } as RawNode).density).toBe(700);
    expect(geomOf({ name: 'lead', mass: 0.5, lattice: { sizeMm: 40 } } as RawNode).mass).toBe(0.5);
  });
});
