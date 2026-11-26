import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { hardwareCutGeoms } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { screwFit, seatFor } from '../src/utils/hardwareParts';
import { CAP_SCREW_HEADS, COUNTERBORES, HEX_NUTS, WASHERS } from '../src/utils/hardwareSizes';
import { findNodeById } from '../src/utils/sceneTree';
import type { SceneNode } from '../src/types/scene';

function makeBoxNode(
  id: string,
  pos: [number, number, number],
  halfSize: [number, number, number],
): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos,
    quat: [1, 0, 0, 0],
    geoms: [{
      name: `${id}_box`,
      type: 'box',
      size: halfSize,
      pos: [0, 0, 0],
      rgba: [0.6, 0.65, 0.72, 1],
    }],
    joints: [],
    children: [],
  };
}

function attachHardwareCut(
  node: SceneNode,
  spec: Parameters<typeof hardwareCutGeoms>[0],
): void {
  const pieces = hardwareCutGeoms(spec, node.id, node);
  expect(pieces.length).toBeGreaterThan(0);
  for (const piece of pieces) {
    node.geoms.push(piece);
    const derived = cutGeometry(node, piece);
    expect(derived).not.toBeNull();
    Object.assign(piece, derived);
  }
  node.csgEnabled = true;
}

describe('Hardware counterbore washer & nut-trap screw reach fixes', () => {
  beforeEach(() => {
    useStore.setState({
      sceneGraph: { nodes: [] },
      selectedNodeId: null,
    });
  });

  it('deepens and widens the counterbore by washer dimensions so head + washer do not protrude', () => {
    const lid = makeBoxNode('lid', [0, 0, 0.006], [0.025, 0.025, 0.006]);
    attachHardwareCut(lid, {
      group: 'counterbore1',
      kind: 'counterbore',
      size: 'M4',
      bore: 'clearance',
      at: [0, 0, 0.006],
      normal: [0, 0, 1],
      fitMm: 0.2,
    });
    useStore.setState({ sceneGraph: { nodes: [lid] } });

    const screwId = useStore.getState().seatHardwarePart('lid', 'counterbore1', 'screw');
    expect(screwId).toBeTruthy();

    useStore.getState().setHardwarePart(screwId!, { washer: true });

    const afterLid = findNodeById(useStore.getState().sceneGraph.nodes, 'lid')!;
    const afterScrew = findNodeById(useStore.getState().sceneGraph.nodes, screwId!)!;
    const headCut = afterLid.geoms.find((g) => g.hardware?.group === 'counterbore1' && g.hardware.part === 'head')!;

    const [baseDia, baseDepth] = COUNTERBORES.M4;
    const [, washerOd, washerThick] = WASHERS.M4;
    const [, headH] = CAP_SCREW_HEADS.M4;

    expect(afterScrew.hardwarePart?.washer).toBe(true);
    expect(headCut.hardware?.washer).toBe(true);
    expect((headCut.cutDepth ?? 0) * 1000).toBeCloseTo(baseDepth + washerThick, 3);
    expect((headCut.size?.[0] ?? 0) * 2000).toBeGreaterThanOrEqual(Math.max(baseDia, washerOd));

    const topOfHeadM = afterScrew.pos[2] + (washerThick + headH) / 1000;
    expect(topOfHeadM).toBeLessThan(0.006);
    expect((0.006 - topOfHeadM) * 1000).toBeCloseTo(baseDepth - headH, 2);

    useStore.getState().setHardwarePart(screwId!, { washer: false });
    const revertedLid = findNodeById(useStore.getState().sceneGraph.nodes, 'lid')!;
    const revertedHead = revertedLid.geoms.find((g) => g.hardware?.group === 'counterbore1' && g.hardware.part === 'head')!;
    const revertedScrew = findNodeById(useStore.getState().sceneGraph.nodes, screwId!)!;
    expect(revertedScrew.hardwarePart?.washer).toBeFalsy();
    expect((revertedHead.cutDepth ?? 0) * 1000).toBeCloseTo(baseDepth, 3);
  });

  it('picks a standard screw length that reaches completely through a mating M3 nut_trap', () => {
    const flange = makeBoxNode('flange', [0, 0, 0.005], [0.02, 0.02, 0.005]);
    attachHardwareCut(flange, {
      group: 'nut_trap1',
      kind: 'nut_trap',
      size: 'M3',
      at: [0, 0, -0.005],
      normal: [0, 0, -1],
      fitMm: 0.25,
    });

    const lid = makeBoxNode('lid', [0, 0, 0.013], [0.02, 0.02, 0.003]);
    attachHardwareCut(lid, {
      group: 'counterbore1',
      kind: 'counterbore',
      size: 'M3',
      bore: 'clearance',
      at: [0, 0, 0.003],
      normal: [0, 0, 1],
      fitMm: 0.2,
    });

    useStore.setState({ sceneGraph: { nodes: [flange, lid] } });
    const screwId = useStore.getState().seatHardwarePart('lid', 'counterbore1', 'screw');
    expect(screwId).toBeTruthy();

    const scene = useStore.getState().sceneGraph;
    const screw = findNodeById(scene.nodes, screwId!)!;
    const seatedLid = findNodeById(scene.nodes, 'lid')!;
    const seat = seatFor(seatedLid, 'counterbore1', 'screw')!;
    const fit = screwFit(scene, seatedLid, screw, seat.gripM!);

    const bearingWorldZMm = (seatedLid.pos[2] + screw.pos[2]) * 1000;
    const nutBottomZMm = 0.25;
    const nutTopZMm = HEX_NUTS.M3[1] + 0.25;
    const screwTipZMm = bearingWorldZMm - (screw.hardwarePart!.lengthMm ?? 0);

    expect(fit.target?.id).toBe('flange');
    expect(screw.hardwarePart!.lengthMm).toBeGreaterThanOrEqual(16);
    expect(screwTipZMm).toBeLessThan(nutTopZMm);
    expect(screwTipZMm).toBeLessThanOrEqual(nutBottomZMm);
  });
});
