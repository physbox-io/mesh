import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { fillBodyDefaults } from '../src/hooks/useMCPBridge';

const fill = (b: Record<string, unknown>) => () => fillBodyDefaults(b as never);

describe('bodies from an agent are checked before MuJoCo sees them', () => {
  it('names a geom type that is not one, and what to use', () => {
    expect(fill({ name: 'a', geoms: [{ type: 'cube', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/Body 'a' geom 'a_geom_0' has type "cube", which is not a geom type\. Use one of box, sphere/);
  });

  it('still takes the shapes that become meshes', () => {
    expect(fill({ name: 'c', geoms: [{ type: 'cone', size: [0.02, 0.05] }] })).not.toThrow();
  });

  it('names a coordinate that is not a number', () => {
    expect(fill({ name: 'a', pos: [0, 0, 'x'], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/Body 'a': pos\[2\] is "x", not a finite number/);
    expect(fill({ name: 'a', pos: [0, 0, null], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/pos\[2\] is null/);
    expect(fill({ name: 'a', pos: [0, 0], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/pos has 2 numbers, not 3/);
    expect(fill({ name: 'a', geoms: [{ type: 'box', size: [0.01, NaN, 0.01] }] }))
      .toThrow(/geom 'a_geom_0': size\[1\] is NaN/);
    expect(fill({ name: 'a', geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }], joints: [{ type: 'hinge', axis: [0, 'y', 0] }] }))
      .toThrow(/joint 'a_joint_0': axis\[1\]/);
  });

  it('refuses a moving body too small to weigh, in millimetres', () => {
    expect(fill({ name: 'grain', geoms: [{ type: 'sphere', size: [0.0001] }] }))
      .toThrow(/Body 'grain' is 0\.2 mm across at most, too small/);
  });

  it('lets a small body that does not move, or a 2 mm one that does, through', () => {
    expect(fill({ name: 'pin', static: true, geoms: [{ type: 'sphere', size: [0.0001] }] })).not.toThrow();
    expect(fill({ name: 'bead', geoms: [{ type: 'sphere', size: [0.001] }] })).not.toThrow();
  });

  it('checks nested bodies too', () => {
    expect(fill({ name: 'frame', geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }], children: [{ name: 'arm', pos: [0, NaN, 0] }] }))
      .toThrow(/Body 'arm': pos\[1\] is NaN/);
  });
});
