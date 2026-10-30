// Gears an agent extrudes from a tooth outline are proximity-coupled at the
// ratio of their teeth. A 10T/30T module-2 pair 40.5 mm apart was coupled at
// -2.667, the ratio of its tip radii (32/12), not -3; on the tester's build
// it was not coupled at all, and driven by contact it jammed after 3.4 s.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { countTeeth } from '../src/utils/gearMeshing';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** A crude spur outline: N trapezoid teeth, module m, tips at (N+2)m/2, roots 1.25m below pitch. */
const outline = (n: number, m: number): number[][] => {
  const rp = (n * m) / 2, tip = rp + m, root = rp - 1.25 * m;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, w = (2 * Math.PI) / n;
    for (const [f, r] of [[0, root], [0.2, root], [0.35, tip], [0.65, tip], [0.8, root]] as const) {
      pts.push([r * Math.cos(a + f * w), r * Math.sin(a + f * w)]);
    }
  }
  return pts;
};

const gear = (id: string, n: number, x: number, extra: object = {}) => fillBodyDefaults({
  id, name: id, pos: [x, 0, 0.1],
  joints: [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1], damping: 0.0005 }],
  geoms: [{ name: `${id}_g`, type: 'extrude', polygon: outline(n, 0.002), height: 0.008, mass: n / 1000 }],
  ...extra,
} as any) as SceneNode;

describe('toothed mesh gears', () => {
  it('counts teeth on an outline, and not on a hexagon', () => {
    const pts = (p: number[][]) => p.map(([x, y]) => ({ angle: Math.atan2(y, x), r: Math.hypot(x, y) }));
    expect(countTeeth(pts(outline(10, 0.002)))).toBe(10);
    expect(countTeeth(pts(outline(30, 0.002)))).toBe(30);
    expect(countTeeth(pts(outline(80, 0.001)))).toBe(80);
    const hex = [0, 1, 2, 3, 4, 5].map((i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)]);
    expect(countTeeth(pts(hex))).toBeUndefined();
  });

  it('couples a 10T and a 30T extruded pair at -3, the ratio of their teeth', () => {
    const nodes = [
      gear('gear_a', 10, 0, { joints: [{ name: 'gear_a_hinge', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 0.05, ctrlValue: 3 } }] }),
      gear('gear_b', 30, 0.0405, { euler: [0, 0, 6] }),
    ];
    const xml = compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0);
    // Was coef 2.666679 (tip radii).
    expect(xml).toContain('<fixed name="gear_coupling_1"><joint joint="gear_a_hinge" coef="1" /><joint joint="gear_b_hinge" coef="3" /></fixed>');
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      d.ctrl[0] = 3;
      const vel = (n: string) => d.qvel[m.jnt_dofadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, n)]] as number;
      // Past the 3.4 s at which contact alone jammed.
      for (let i = 0; i < 5000; i++) mj.mj_step(m, d);
      expect(vel('gear_a_hinge')).toBeCloseTo(3, 1);
      expect(vel('gear_b_hinge')).toBeCloseTo(-1, 1);
    } finally { d.delete(); m.delete(); }
  });
});
