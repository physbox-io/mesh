// physics_repair_mesh with a weld tolerance as big as the part.
//
// Welding merges every pair of vertices closer than the tolerance, so a 20 mm
// cube welded at 20 mm came back as a tetrahedron and at 25 mm as nothing, and
// both replies said ok and wrote the wreck over the part. The tolerance is now
// held to the part's own scale, and the result is checked before it is kept.

import { describe, it, expect, vi } from 'vitest';
import { boxMesh } from './helpers/meshes';
import {
  checkRepairOutcome,
  repairMesh,
  runMcpRepairMesh,
  weldToleranceLimit,
} from '../src/utils/meshRepair';
import type { SceneNode } from '../src/types/scene';

/** A 20 mm cube, as a scene body holding one mesh geom (Z-up renderVertices). */
const cubeNode = (verts = boxMesh([0, 0, 0], [0.01, 0.01, 0.01]).verts, faces = boxMesh().faces): SceneNode => ({
  id: 'cube',
  name: 'cube',
  pos: [0, 0, 0],
  geoms: [{ name: 'shell', type: 'mesh', renderVertices: verts, faces }],
  children: [],
} as unknown as SceneNode);

const run = async (node: SceneNode, msg: Record<string, unknown>) => {
  const updateNode = vi.fn();
  const compileCsgNodes = vi.fn(async () => undefined);
  const reply = await runMcpRepairMesh({
    msg: { targetId: node.id, ...msg },
    toId: (s) => s,
    nodes: [node],
    findNodeInScene: (nodes, id) => nodes.find((n) => n.id === id) ?? null,
    updateNode,
    compileCsgNodes,
  });
  return { reply, updateNode };
};

describe('weldToleranceLimit', () => {
  it('is half the shortest real edge, capped at 1% of the part', () => {
    const cube = boxMesh([0, 0, 0], [0.01, 0.01, 0.01]);
    const limit = weldToleranceLimit(cube.verts, cube.faces);
    expect(limit.shortestEdge).toBeCloseTo(0.02, 9);
    expect(limit.diagonal).toBeCloseTo(Math.sqrt(3) * 0.02, 9);
    expect(limit.maxTolerance).toBeCloseTo(Math.sqrt(3) * 0.02 * 0.01, 9);

    // A thin plate: the 0.4 mm edge, not the size, sets it.
    const plate = boxMesh([0, 0, 0], [0.05, 0.05, 0.0002]);
    expect(weldToleranceLimit(plate.verts, plate.faces).maxTolerance).toBeCloseTo(0.0002, 9);
  });
});

describe('checkRepairOutcome', () => {
  it('flags a cube welded into something else', () => {
    const cube = boxMesh([0, 0, 0], [0.01, 0.01, 0.01]);
    for (const tol of [0.02, 0.025]) {
      const report = repairMesh(cube.verts, cube.faces, { weldTolerance: tol });
      expect(checkRepairOutcome(cube.verts, report)).not.toBeNull();
    }
  });

  it('passes a repair that only closed a seam', () => {
    const box = boxMesh([0, 0, 0], [0.01, 0.01, 0.01]);
    const verts = [...box.verts];
    const start = verts.length / 3;
    for (let i = 4; i < 8; i++) verts.push(box.verts[i * 3] + 2e-6, box.verts[i * 3 + 1], box.verts[i * 3 + 2]);
    const faces = box.faces.map((f, i) => (i < 6 ? f - 4 + start : f));
    const report = repairMesh(verts, faces, { weldTolerance: 1e-5 });
    expect(report.after.closed).toBe(true);
    expect(checkRepairOutcome(verts, report)).toBeNull();
  });
});

describe('physics_repair_mesh weld tolerance', () => {
  it('refuses a tolerance that would merge the part\'s corners, and changes nothing', async () => {
    for (const weldToleranceMm of [20, 25, 1]) {
      const node = cubeNode();
      const { reply, updateNode } = await run(node, { weldToleranceMm });
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/too large for this part/);
      expect(String(reply.error)).toMatch(/Nothing was changed/);
      expect(updateNode).not.toHaveBeenCalled();
    }
  });

  it('refuses a result that destroyed the part even at the default tolerance', async () => {
    // The default 0.01 mm is never refused up front, so on a part smaller than
    // it only the outcome check stands between the weld and the part.
    const tiny = boxMesh([0, 0, 0], [4e-6, 4e-6, 4e-6]);
    const node = cubeNode(tiny.verts, tiny.faces);
    const { reply, updateNode } = await run(node, {});
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/not applied/);
    expect(updateNode).not.toHaveBeenCalled();
  });

  it('still repairs at the default tolerance and at a sensible one', async () => {
    for (const msg of [{}, { weldToleranceMm: 0.1 }]) {
      const node = cubeNode();
      const { reply, updateNode } = await run(node, msg);
      expect(reply.ok).toBe(true);
      expect(updateNode).toHaveBeenCalledTimes(1);
      const geoms = updateNode.mock.calls[0][1].geoms;
      expect(geoms[0].faces).toHaveLength(36);
    }
  });
});
