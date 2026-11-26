import { describe, it, expect, vi, beforeAll } from 'vitest';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { compileToMJCF } from '../src/utils/mjcf';
import { HARDWARE_PARTS, hardwarePartNode, isBoughtIn } from '../src/utils/hardwareParts';
import { BUTT_HINGES, HANDLES, HASP_LATCHES, WOOD_SCREWS } from '../src/utils/hardwareSizes';
import { hardwareList, hardwareListCsv } from '../src/utils/hardwareList';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setSound() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let objectCommands: any;
let applySingleCutToBody: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ objectCommands } = await import('../src/hooks/mcp/objectCommands'));
  ({ applySingleCutToBody } = await import('../src/hooks/mcp/bodyFeatures'));
}, 30_000);

const callAddHardware = async (msg: Record<string, unknown>) => {
  const store = useStore.getState();
  return objectCommands.ADD_HARDWARE(
    { type: 'ADD_HARDWARE', id: 'req_envelope_999', ...msg },
    { store, toId: (v: unknown) => v },
  );
};

const find = (id: string): SceneNode | null => {
  const walk = (ns: SceneNode[]): SceneNode | null => {
    for (const n of ns || []) {
      if (n.id === id) return n;
      const c = walk(n.children || []);
      if (c) return c;
    }
    return null;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};

const meshesOf = (node: SceneNode): SceneGeom[] => {
  const out: SceneGeom[] = [];
  const walk = (n: SceneNode) => {
    out.push(...(n.geoms || []).filter((gm) => gm.type === 'mesh'));
    (n.children || []).forEach(walk);
  };
  walk(node);
  return out;
};

const timberPanel = (id: string, pos: [number, number, number]): SceneNode => ({
  id,
  name: id,
  type: 'body',
  pos,
  geoms: [{ name: `${id}_box`, type: 'box', size: [0.15, 0.01, 0.1], mass: 0.4, dynamic: true } as SceneGeom],
  joints: [],
  children: [],
});

describe('woodworking & cabinetry hardware geometry', () => {
  it('builds every size of butt_hinge, hasp_latch, handle, and wood_screw with valid meshes and mass', () => {
    const kinds = ['butt_hinge', 'hasp_latch', 'handle', 'wood_screw'] as const;
    for (const kind of kinds) {
      expect(HARDWARE_PARTS[kind]).toBeDefined();
      for (const size of HARDWARE_PARTS[kind].sizes) {
        const node = hardwarePartNode({ kind, size }, `wk_${kind}_${size}`);
        expect(isBoughtIn(node)).toBe(true);
        expect(node.geoms.some((gm) => (gm.mass ?? 0) > 0)).toBe(true);
        for (const gm of meshesOf(node)) {
          const a = analyzeMesh(gm.renderVertices!, gm.faces!)!;
          expect(a.closed && a.consistentlyWound && a.volume > 0, `${kind} ${size} ${gm.name}`).toBe(true);
          expect(analyzeMesh(gm.vertices!, gm.faces!)!.volume).toBeCloseTo(a.volume, 10);
        }
      }
    }
  });

  it('builds butt_hinge with fixed leaf, central knuckle pin, and hinged moving leaf', () => {
    const h = hardwarePartNode({ kind: 'butt_hinge', size: '75mm' }, 'hinge_1');
    expect(h.name).toBe('75mm butt hinge');
    expect(h.geoms.some((gm) => gm.name === 'hinge_1_leaf_a')).toBe(true);
    expect(h.geoms.some((gm) => gm.name === 'hinge_1_pin')).toBe(true);
    expect(h.children).toHaveLength(1);
    const leafB = h.children[0];
    expect(leafB.id).toBe('hinge_1_leaf_b');
    expect(leafB.hardwarePart?.piece).toBe('inner');
    expect(leafB.joints[0]).toMatchObject({ type: 'hinge', axis: [0, 0, 1], limited: true, range: [-90, 180] });
    expect(Object.keys(BUTT_HINGES)).toEqual(expect.arrayContaining(['50mm', '75mm', '100mm']));
    const xml = compileToMJCF({ nodes: [h] }, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<joint[^>]*name="hinge_1_hinge"[^>]*range="-90 180"/);
  });

  it('builds hasp_latch with mount plate, lock plate, staple loop, and swinging drop strap', () => {
    const latch = hardwarePartNode({ kind: 'hasp_latch', size: '75mm' }, 'latch_1');
    expect(latch.name).toBe('75mm hasp latch');
    expect(latch.geoms.some((gm) => gm.name === 'latch_1_lock_plate')).toBe(true);
    expect(latch.geoms.some((gm) => gm.name === 'latch_1_staple_bar')).toBe(true);
    expect(latch.children).toHaveLength(1);
    expect(latch.children[0].id).toBe('latch_1_strap');
    expect(latch.children[0].joints[0]).toMatchObject({ type: 'hinge', axis: [1, 0, 0], limited: true, range: [0, 153] });
    expect(Object.keys(HASP_LATCHES)).toEqual(expect.arrayContaining(['50mm', '75mm', '100mm']));
    const xml = compileToMJCF({ nodes: [latch] }, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<joint[^>]*name="latch_1_swing"[^>]*range="0 153"/);
  });

  it('builds handle with bases, standoffs, and grip bar', () => {
    const handle = hardwarePartNode({ kind: 'handle', size: '128mm' }, 'pull_1');
    expect(handle.name).toBe('128mm handle');
    expect(handle.geoms.some((gm) => gm.name === 'pull_1_grip')).toBe(true);
    expect(handle.geoms.some((gm) => gm.name === 'pull_1_post_l')).toBe(true);
    expect(handle.geoms.some((gm) => gm.name === 'pull_1_post_r')).toBe(true);
    expect(Object.keys(HANDLES)).toEqual(expect.arrayContaining(['96mm', '128mm', '160mm']));
  });

  it('builds wood_screw with flat countersunk head at z=0 and tapered tip for #6/#8/#10 and M4/M5', () => {
    expect(Object.keys(WOOD_SCREWS)).toEqual(expect.arrayContaining(['#6', '#8', '#10', 'M4', 'M5']));
    const ws = hardwarePartNode({ kind: 'wood_screw', size: '#8', lengthMm: 35 }, 'ws_1');
    expect(ws.name).toBe('#8×35 wood screw');
    const head = ws.geoms.find((gm) => gm.name === 'ws_1_head')!;
    expect(head.type).toBe('mesh');
    let zMax = -Infinity;
    for (let i = 2; i < head.renderVertices!.length; i += 3) zMax = Math.max(zMax, head.renderVertices![i]);
    expect(zMax).toBeCloseTo(0, 6);
    const tip = ws.geoms.find((gm) => gm.name === 'ws_1_tip')!;
    let zMin = Infinity;
    for (let i = 2; i < tip.renderVertices!.length; i += 3) zMin = Math.min(zMin, tip.renderVertices![i]);
    expect(zMin).toBeCloseTo(-0.035, 5);
  });

  it('lists woodworking hardware cleanly in hardwareList and CSV', () => {
    const scene = {
      nodes: [
        hardwarePartNode({ kind: 'butt_hinge', size: '75mm' }, 'h1'),
        hardwarePartNode({ kind: 'butt_hinge', size: '75mm' }, 'h2'),
        hardwarePartNode({ kind: 'hasp_latch', size: '75mm' }, 'l1'),
        hardwarePartNode({ kind: 'handle', size: '128mm' }, 'p1'),
        hardwarePartNode({ kind: 'wood_screw', size: '#8', lengthMm: 30 }, 's1'),
      ],
    };
    const list = hardwareList(scene);
    expect(list.rows.find((r) => r.name === '75mm butt hinge')?.count).toBe(2);
    expect(list.rows.find((r) => r.name === '75mm hasp latch')?.count).toBe(1);
    expect(list.rows.find((r) => r.name === '128mm handle')?.count).toBe(1);
    expect(list.rows.find((r) => r.name === '#8×30 wood screw')?.count).toBe(1);
    expect(hardwareListCsv(list)).toContain('75mm butt hinge');
  });
});

describe('ADD_HARDWARE user-supplied id, woodworking kinds, and timber corner_bracket', () => {
  it('honors user-supplied id (partId) when creating new hardware and falls back when omitted', async () => {
    useStore.getState().updateScene({ nodes: [] });

    const r1 = await callAddHardware({ partId: 'screw_front_tl', kind: 'screw', size: 'M4', lengthMm: 16, at: [10, 20, 30] });
    expect(r1.ok).toBe(true);
    expect(r1.id).toBe('screw_front_tl');
    const n1 = find('screw_front_tl');
    expect(n1).not.toBeNull();
    expect(n1!.geoms.some((gm) => gm.name === 'screw_front_tl_head')).toBe(true);

    // Duplicate user-supplied id deduplicates cleanly rather than clobbering.
    const rDup = await callAddHardware({ partId: 'screw_front_tl', kind: 'screw', size: 'M4', lengthMm: 16, at: [20, 20, 30] });
    expect(rDup.ok).toBe(true);
    expect(rDup.id).toBe('screw_front_tl_2');
    expect(find('screw_front_tl_2')).not.toBeNull();

    // Omitting partId falls back to generated id (never using the request envelope id).
    const rAuto = await callAddHardware({ kind: 'wood_screw', size: '#8', lengthMm: 25, at: [0, 0, 20] });
    expect(rAuto.ok).toBe(true);
    expect(rAuto.id).toMatch(/^wood_screw_/);
    expect(rAuto.id).not.toBe('req_envelope_999');
  });

  it('creates woodworking hardware via ADD_HARDWARE and supports fixTo both on creation and on existing parts', async () => {
    useStore.getState().updateScene({
      nodes: [
        timberPanel('chest_back', [0, -0.1, 0.1]),
        timberPanel('chest_lid', [0, 0, 0.21]),
        timberPanel('chest_front', [0, 0.1, 0.1]),
      ],
    });

    // Create butt_hinge with user id + size + into + fixTo in one call.
    const hinge = await callAddHardware({
      partId: 'hinge_rear_l',
      kind: 'butt_hinge',
      size: 75, // unitless numeric size should resolve to '75mm'
      into: 'chest_back',
      at: [-100, -100, 200],
      fixTo: 'chest_lid',
    });
    expect(hinge.ok).toBe(true);
    expect(hinge.id).toBe('hinge_rear_l');
    expect(hinge.size).toBe('75mm');
    expect(hinge.leafId).toBe('hinge_rear_l_leaf_b');
    expect(hinge.weldedTo).toBe('chest_back');
    expect(find('chest_lid')?.weldTargetId).toBe('hinge_rear_l_leaf_b');

    // Create hasp_latch and then fixTo on the existing part in a follow-up call.
    const latch = await callAddHardware({
      partId: 'front_hasp',
      kind: 'hasp_latch',
      size: '75mm',
      into: 'chest_front',
      at: [0, 110, 190],
    });
    expect(latch.ok).toBe(true);
    expect(latch.id).toBe('front_hasp');
    expect(latch.strapId).toBe('front_hasp_strap');

    // Follow-up fixTo on an existing part still works.
    useStore.getState().updateScene({
      nodes: [...useStore.getState().sceneGraph.nodes, timberPanel('padlock_tab', [0, 0.12, 0.14])],
    });
    const fixed = await callAddHardware({ partId: 'front_hasp', fixTo: 'padlock_tab' });
    expect(fixed.ok).toBe(true);
    expect(fixed.id).toBe('front_hasp');
    expect(fixed.pieceId).toBe('front_hasp_strap');
    expect(find('padlock_tab')?.weldTargetId).toBe('front_hasp_strap');

    // Handle & wood_screw via ADD_HARDWARE.
    const handle = await callAddHardware({ partId: 'side_handle', kind: 'handle', size: '128mm', into: 'chest_front', at: [0, 110, 100] });
    expect(handle.ok).toBe(true);
    expect(handle.id).toBe('side_handle');
    expect(handle.size).toBe('128mm');

    const ws = await callAddHardware({ partId: 'lid_screw_1', kind: 'wood_screw', size: 'M4', lengthMm: 20, into: 'chest_front', at: [50, 110, 150] });
    expect(ws.ok).toBe(true);
    expect(ws.id).toBe('lid_screw_1');
    expect(ws.size).toBe('M4');
    expect(ws.lengthMm).toBe(20);

    // Whole scene compiles to valid MJCF.
    const xml = compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toContain('hinge_rear_l');
    expect(xml).toContain('front_hasp');
    expect(xml).toContain('side_handle');
    expect(xml).toContain('lid_screw_1');
  });

  it('allows corner_bracket standalone at pos, mounted on a timber panel, or between timber panels', async () => {
    useStore.getState().updateScene({
      nodes: [
        timberPanel('panel_left', [-0.15, 0, 0.1]),
        timberPanel('panel_back', [0, -0.15, 0.1]),
      ],
    });

    // 1. Standalone at [x, y, z] without `between`.
    const standalone = await callAddHardware({ partId: 'bracket_free', kind: 'corner_bracket', size: '20', at: [50, 40, 30] });
    expect(standalone.ok).toBe(true);
    expect(standalone.id).toBe('bracket_free');
    expect(standalone.size).toBe('20');
    expect(standalone.posMm).toEqual([50, 40, 30]);

    // 2. Mounted directly onto a timber panel via `into` + `at`.
    const mounted = await callAddHardware({ partId: 'bracket_panel', kind: 'corner_bracket', size: '30', into: 'panel_left', at: [-140, -140, 100] });
    expect(mounted.ok).toBe(true);
    expect(mounted.id).toBe('bracket_panel');
    expect(mounted.size).toBe('30');
    expect(mounted.weldedTo).toBe('panel_left');

    // 3. Given `between` two timber panels (non-extrusions): succeeds without extrusion error,
    // mounts rigidly to panel_left (joints: []) and welds to panel_back.
    const betweenTimber = await callAddHardware({
      partId: 'bracket_corner',
      kind: 'corner_bracket',
      size: '20',
      between: ['panel_left', 'panel_back'],
    });
    expect(betweenTimber.ok).toBe(true);
    expect(betweenTimber.id).toBe('bracket_corner');
    expect(betweenTimber.mountedTo).toBe('panel_left');
    expect(betweenTimber.weldedTo).toBe('panel_back');
    expect(betweenTimber.between).toEqual(['panel_left', 'panel_back']);
    expect(betweenTimber.posMm).toEqual([-75, -75, 100]);
    const bracketNode = find('bracket_corner')!;
    expect(bracketNode.joints).toEqual([]);
    expect(bracketNode.weldTargetId).toBe('panel_back');
    expect(find('panel_left')!.children.some((c) => c.id === 'bracket_corner')).toBe(true);
  });

  it('places timber corner_bracket with between:[bodyA, bodyB] at the shared AABB seam (not mid-air) and welds both bodies', async () => {
    const makeRail = (id: string, posMm: [number, number, number], sizeMm: [number, number, number]): SceneNode => ({
      id,
      name: id,
      type: 'body',
      pos: [posMm[0] / 1000, posMm[1] / 1000, posMm[2] / 1000],
      geoms: [{ name: `${id}_box`, type: 'box', size: [sizeMm[0] / 2000, sizeMm[1] / 2000, sizeMm[2] / 2000], mass: 0.5, dynamic: true } as SceneGeom],
      joints: [],
      children: [],
    });
    useStore.getState().updateScene({
      nodes: [
        makeRail('plinth_front', [0, -160.5, 22.5], [740, 19, 45]),
        makeRail('plinth_left', [-360.5, 0, 22.5], [19, 302, 45]),
      ],
    });

    const res = await callAddHardware({
      partId: 'plinth_bracket_fl',
      kind: 'corner_bracket',
      size: '20',
      between: ['plinth_front', 'plinth_left'],
    });
    expect(res.ok).toBe(true);
    // Exact butt-joint seam between plinth_front and plinth_left (NOT body-center midpoint [-180.25, -80.25, 22.5]).
    expect(res.posMm[0]).toBeCloseTo(-360.5, 2);
    expect(res.posMm[1]).toBeCloseTo(-151, 2);
    expect(res.posMm[2]).toBeCloseTo(22.5, 2);
    expect(res.mountedTo).toBe('plinth_front');
    expect(res.weldedTo).toBe('plinth_left');

    const bracket = find('plinth_bracket_fl')!;
    expect(bracket.joints).toEqual([]);
    expect(bracket.weldTargetId).toBe('plinth_left');
    expect(bracket.weldRigid).toBe(true);
    expect(find('plinth_front')!.children.some((c) => c.id === 'plinth_bracket_fl')).toBe(true);

    const xml = compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<weld[^>]*body1="20 corner bracket"[^>]*body2="plinth_left"/);
  });

  it('wires butt_hinge and hasp_latch with between:[fixedBody, movingBody] onto the shared seam and welds both bodies', async () => {
    const makePanel = (id: string, posMm: [number, number, number], sizeMm: [number, number, number]): SceneNode => ({
      id,
      name: id,
      type: 'body',
      pos: [posMm[0] / 1000, posMm[1] / 1000, posMm[2] / 1000],
      geoms: [{ name: `${id}_box`, type: 'box', size: [sizeMm[0] / 2000, sizeMm[1] / 2000, sizeMm[2] / 2000], mass: 1.0, dynamic: true } as SceneGeom],
      joints: [],
      children: [],
    });
    useStore.getState().updateScene({
      nodes: [
        makePanel('back_panel', [0, 190.5, 220], [800, 19, 350]),
        makePanel('front_panel', [0, -190.5, 220], [800, 19, 350]),
        makePanel('lid_panel', [0, 0, 404.5], [812, 412, 19]),
      ],
    });

    // 1. butt_hinge without `at`: auto-computes shared seam [0, 190.5, 395].
    const hinge1 = await callAddHardware({
      partId: 'rear_hinge_l',
      kind: 'butt_hinge',
      size: '75mm',
      between: ['back_panel', 'lid_panel'],
    });
    expect(hinge1.ok).toBe(true);
    expect(hinge1.mountedTo).toBe('back_panel');
    expect(hinge1.fixedTo).toBe('lid_panel');
    expect(hinge1.between).toEqual(['back_panel', 'lid_panel']);
    expect(hinge1.posMm[0]).toBeCloseTo(0, 2);
    expect(hinge1.posMm[1]).toBeCloseTo(190.5, 2);
    expect(hinge1.posMm[2]).toBeCloseTo(395, 2);

    const h1Node = find('rear_hinge_l')!;
    expect(h1Node.joints).toEqual([]);
    expect(find('back_panel')!.children.some((c) => c.id === 'rear_hinge_l')).toBe(true);
    const h1Leaf = find('rear_hinge_l_leaf_b')!;
    expect(h1Leaf.weldTargetId).toBe('lid_panel');
    expect(h1Leaf.weldRigid).toBe(true);

    // 2. Second butt_hinge on the same lid with explicit `at` does not conflict.
    const hinge2 = await callAddHardware({
      partId: 'rear_hinge_r',
      kind: 'butt_hinge',
      size: '75mm',
      between: ['back_panel', 'lid_panel'],
      at: [250, 190.5, 395],
    });
    expect(hinge2.ok).toBe(true);
    expect(hinge2.posMm[0]).toBeCloseTo(250, 2);
    expect(find('rear_hinge_r_leaf_b')?.weldTargetId).toBe('lid_panel');

    // 3. hasp_latch with between:[front_panel, lid_panel] without `at`: auto seam [0, -190.5, 395].
    const hasp = await callAddHardware({
      partId: 'chest_hasp',
      kind: 'hasp_latch',
      size: '75mm',
      between: ['front_panel', 'lid_panel'],
    });
    expect(hasp.ok).toBe(true);
    expect(hasp.mountedTo).toBe('front_panel');
    expect(hasp.fixedTo).toBe('lid_panel');
    expect(hasp.posMm[0]).toBeCloseTo(0, 2);
    expect(hasp.posMm[1]).toBeCloseTo(-190.5, 2);
    expect(hasp.posMm[2]).toBeCloseTo(395, 2);
    expect(find('chest_hasp')!.joints).toEqual([]);
    expect(find('front_panel')!.children.some((c) => c.id === 'chest_hasp')).toBe(true);
    expect(find('chest_hasp_strap')!.weldTargetId).toBe('lid_panel');
    expect(find('chest_hasp_strap')!.weldRigid).toBe(true);

    const xml = compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<weld[^>]*body1="75mm butt hinge moving leaf"[^>]*body2="lid_panel"/);
    expect(xml).toMatch(/<weld[^>]*body1="75mm butt hinge moving leaf_2"[^>]*body2="lid_panel"/);
    expect(xml).toMatch(/<weld[^>]*body1="75mm hasp latch drop strap"[^>]*body2="lid_panel"/);
  });

  it('seats wood_screw and screw into countersink cut groups with contacts disabled', async () => {
    const panel: SceneNode = {
      id: 'cs_panel',
      name: 'cs_panel',
      type: 'body',
      pos: [0, 0, 0.05],
      geoms: [{ name: 'cs_panel_box', type: 'box', size: [0.06, 0.04, 0.01], mass: 0.3, dynamic: true } as SceneGeom],
      joints: [],
      children: [],
    };
    useStore.getState().updateScene({ nodes: [panel] });

    const cs1 = applySingleCutToBody('cs_panel', { shape: 'countersink', size: 'M4', at: [0, 0, 10], normal: [0, 0, 1] });
    expect(cs1.ok).toBe(true);
    expect(cs1.group).toBe('countersink1');

    const cs2 = applySingleCutToBody('cs_panel', { shape: 'countersink', size: 'M4', at: [25, 0, 10], normal: [0, 0, 1] });
    expect(cs2.ok).toBe(true);
    expect(cs2.group).toBe('countersink2');

    // Seat a wood_screw with explicit size and lengthMm into countersink1.
    const wsRes = await callAddHardware({
      partId: 'ws_cs_1',
      kind: 'wood_screw',
      size: '#8',
      lengthMm: 25,
      into: 'cs_panel',
      group: 'countersink1',
    });
    expect(wsRes.ok).toBe(true);
    expect(wsRes.id).toBe('ws_cs_1');
    expect(wsRes.size).toBe('#8');
    expect(wsRes.lengthMm).toBe(25);
    expect(wsRes.seatedIn).toBe('countersink1');

    const wsNode = find('ws_cs_1')!;
    expect(wsNode).not.toBeNull();
    expect(wsNode.joints).toEqual([]);
    expect(wsNode.pos[0]).toBeCloseTo(0, 4);
    expect(wsNode.pos[1]).toBeCloseTo(0, 4);
    expect(wsNode.pos[2]).toBeCloseTo(0.01, 4);
    for (const gm of wsNode.geoms.filter((g) => g.role !== 'visual')) {
      expect([gm.contype, gm.conaffinity]).toEqual([0, 0]);
    }

    // Seat a cap screw (inferred M4 size) into countersink2.
    const capRes = await callAddHardware({
      partId: 'cap_cs_2',
      kind: 'screw',
      into: 'cs_panel',
      group: 'countersink2',
    });
    expect(capRes.ok).toBe(true);
    expect(capRes.id).toBe('cap_cs_2');
    expect(capRes.size).toBe('M4');
    expect(capRes.seatedIn).toBe('countersink2');

    const capNode = find('cap_cs_2')!;
    expect(capNode).not.toBeNull();
    expect(capNode.joints).toEqual([]);
    expect(capNode.pos[0]).toBeCloseTo(0.025, 4);
    expect(capNode.pos[2]).toBeCloseTo(0.01, 4);
    for (const gm of capNode.geoms.filter((g) => g.role !== 'visual')) {
      expect([gm.contype, gm.conaffinity]).toEqual([0, 0]);
    }

    // Non-screw hardware must still be rejected by countersink cuts.
    const badRes = await callAddHardware({
      kind: 'bearing',
      into: 'cs_panel',
      group: 'countersink1',
    });
    expect(badRes.ok).toBe(false);

    // Compiled MJCF keeps contacts off on seated screws.
    const xml = compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/name="ws_cs_1_head"[^>]*contype="0"[^>]*conaffinity="0"/);
    expect(xml).toMatch(/name="cap_cs_2_head"[^>]*contype="0"[^>]*conaffinity="0"/);
  });
});
