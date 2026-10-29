// Loop-closure pins (connectTargetId) hold rigid, whatever the links weigh.
// At MuJoCo's default impedance a pin was only as stiff as the lighter body it
// held. A scissor lift (two 0.2 kg arms, a 2 kg platform, a 10 g slot block)
// opened its pins 7.4 mm on a 1 kg slider, and on a 50 g one held by a
// kv 20000 servo folded through flat: 35 mm pin gaps, the platform 101 mm
// under the floor.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildFourBarLinkage } from '../src/utils/mechanismParts';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/**
 * Z-up, hinges about +Y. Arm A from a floor pivot to (173.2, 100) mm; arm B
 * hinged at A's middle, its foot pinned to the slider; the platform hinged at
 * B's top, its slot block sliding under A's top and pinned to it.
 */
const lift = (sliderKg: number): SceneNode[] => {
  const hingeY = { type: 'hinge' as const, axis: [0, 1, 0], pos: [0, 0, 0] };
  const platform: SceneNode = {
    id: 'platform', name: 'platform', type: 'body', pos: [-0.0866, 0, 0.05], children: [],
    joints: [{ name: 'plat_hinge', ...hingeY }],
    geoms: [{ name: 'plat_g', type: 'box', size: [0.1, 0.03, 0.005], pos: [0.0866, 0, 0], mass: 2, contype: 0, conaffinity: 0 }],
  };
  platform.children.push({
    id: 'slotblock', name: 'slotblock', type: 'body', pos: [0.1732, 0, 0], children: [],
    joints: [{ name: 'slot_slide', type: 'slide', axis: [1, 0, 0], pos: [0, 0, 0] }],
    geoms: [{ name: 'slot_g', type: 'box', size: [0.005, 0.005, 0.005], mass: 0.01, contype: 0, conaffinity: 0 }],
    connectTargetId: 'armA', connectAnchor: [0.1732, 0, 0.12],
  });
  const armB: SceneNode = {
    id: 'armB', name: 'armB', type: 'body', pos: [0.0866, 0, 0.05], children: [platform],
    joints: [{ name: 'b_hinge', ...hingeY }],
    geoms: [{ name: 'b_g', type: 'capsule', size: [0.005], fromto: [0.0866, 0, -0.05, -0.0866, 0, 0.05], mass: 0.2, contype: 0, conaffinity: 0 }],
    connectTargetId: 'slider', connectAnchor: [0.1732, 0, 0.02],
  };
  const armA: SceneNode = {
    id: 'armA', name: 'armA', type: 'body', pos: [0, 0, 0.02], children: [armB],
    joints: [{ name: 'a_hinge', ...hingeY }],
    geoms: [{ name: 'a_g', type: 'capsule', size: [0.005], fromto: [0, 0, 0, 0.1732, 0, 0.1], mass: 0.2, contype: 0, conaffinity: 0 }],
  };
  const slider: SceneNode = {
    id: 'slider', name: 'slider', type: 'body', pos: [0.1732, 0.012, 0.02], children: [],
    joints: [{ name: 'slider_slide', type: 'slide', axis: [1, 0, 0], pos: [0, 0, 0], limited: true, range: [-0.12, 0.05], actuator: { type: 'velocity', kv: 20000, ctrlValue: 0 } }],
    geoms: [{ name: 'slider_g', type: 'box', size: [0.01, 0.005, 0.005], mass: sliderKg, contype: 0, conaffinity: 0 }],
  };
  return [armA, slider];
};

/** Two seconds of it: the widest pin gap, the platform's height and tilt. */
const run = (nodes: SceneNode[]) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    let worst = 0;
    const plat = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'platform');
    for (let i = 0; i < 2000; i++) {
      mj.mj_step(m, d);
      for (let r = 0; r < d.nefc; r++) if (d.efc_type[r] === 0) worst = Math.max(worst, Math.abs(d.efc_pos[r]));
    }
    return {
      worstPinMm: worst * 1000,
      platZmm: d.xpos[plat * 3 + 2] * 1000,
      tiltDeg: (Math.asin(d.xmat[plat * 9 + 6]) * 180) / Math.PI,
    };
  } finally {
    d.delete(); m.delete();
  }
};

describe('closed-loop pins', () => {
  it('a scissor lift on a 50 g slider stands, its pins closed', () => {
    const r = run(lift(0.05));
    // Was 35 mm of pin gap and the platform 101 mm under the floor; now 0.001 mm, 112.5 mm up.
    expect(r.worstPinMm).toBeLessThan(0.01);
    expect(r.platZmm).toBeGreaterThan(110);
    expect(Math.abs(r.tiltDeg)).toBeLessThan(0.1);
  });

  it('and on a 1 kg one, its 10 g slot block holds the 2 kg platform level', () => {
    const r = run(lift(1));
    // Was 7.4 mm and 2.2 degrees of tilt.
    expect(r.worstPinMm).toBeLessThan(0.01);
    expect(Math.abs(r.tiltDeg)).toBeLessThan(0.1);
  });

  it('a four-bar (100/30/90/80) stays closed while its crank turns for 20 s', () => {
    const fb = buildFourBarLinkage({ groundMm: 100, crankMm: 30, couplerMm: 90, rockerMm: 80 });
    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: fb.nodes }, -9.81, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      const speed = fb.nodes.flatMap((n) => [n, ...n.children]).flatMap((n) => n.joints).find((j) => j.actuator)!.actuator!.ctrlValue!;
      d.ctrl[0] = speed;
      let settled = 0;
      for (let i = 0; i < 20000; i++) {
        mj.mj_step(m, d);
        if (i < 1000) continue;
        for (let k = 0; k < d.nefc; k++) if (d.efc_type[k] === 0) settled = Math.max(settled, Math.abs(d.efc_pos[k]));
      }
      expect(Math.abs(d.qpos[0])).toBeGreaterThan(20);
      // Was 0.07-0.28 mm over 60 s.
      expect(settled * 1000).toBeLessThan(0.01);
    } finally {
      d.delete(); m.delete();
    }
  });
});
