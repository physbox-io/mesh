import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * An agent's carve is planned on the export worker, as the export tools plan
 * it, and only once the machine is free to take it: planning a solid takes up
 * to half a minute, and on the page it froze the tab for all of it, even when
 * the job was then refused because another was running.
 */

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  fetchMachineDevices: vi.fn().mockResolvedValue([]),
}));

const { ExportWorkerClient } = await import('../src/utils/exportWorkerClient');
const { createMeshMachineHandlers, machineArming, setCurrentScene } = await import('../src/utils/machineMcp');
const { webSerialManager } = await import('../src/utils/webSerialManager');

function cube(): SceneGraph {
  const s = 0.01;
  const pts = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  const geom = { name: 'g', type: 'mesh', size: [1], renderVertices: pts.flat(), vertices: pts.flatMap(([x, y, z]) => [x, z, -y]), faces };
  return { nodes: [{ id: 'b', name: 'part', type: 'body', pos: [0, 0, 0], geoms: [geom as SceneGeom], joints: [], children: [] }] } as SceneGraph;
}

const mgr = webSerialManager as unknown as {
  state: Record<string, unknown>;
  runJob: typeof webSerialManager.runJob;
  isRunning: () => boolean;
  isJobPaused: () => boolean;
};

describe('carving from MCP', () => {
  const saved = { connected: mgr.state.connected, status: mgr.state.status, runJob: mgr.runJob };
  afterEach(() => {
    vi.restoreAllMocks();
    machineArming.disarm();
    mgr.state.connected = saved.connected;
    mgr.state.status = saved.status;
    mgr.runJob = saved.runJob;
    setCurrentScene(null);
  });

  it('plans the carve on the export worker, not on the page', async () => {
    setCurrentScene(cube());
    mgr.state.connected = true;
    mgr.state.status = 'IDLE';
    mgr.runJob = (async () => ({ delivered: true, message: 'ok' })) as unknown as typeof webSerialManager.runJob;
    const onWorker = vi.spyOn(ExportWorkerClient.prototype, 'run');
    machineArming.arm(60_000);
    const reply = (await createMeshMachineHandlers().CARVE_SCENE({ toolDiaMm: 3, material: 'softwood' })) as { summary: string };
    expect(reply.summary).toContain('Cutting side A');
    expect(onWorker).toHaveBeenCalledWith('solid', expect.anything(), expect.anything());
  });

  it('refuses a carve while a job holds the machine before planning anything', async () => {
    setCurrentScene(cube());
    mgr.state.connected = true;
    mgr.state.status = 'IDLE';
    // A job that started after the shared handler's own check and before the
    // carve got to it: the carve still refuses before it plans.
    let calls = 0;
    vi.spyOn(webSerialManager, 'isRunning').mockImplementation(() => ++calls > 1);
    const onWorker = vi.spyOn(ExportWorkerClient.prototype, 'run');
    machineArming.arm(60_000);
    await expect(createMeshMachineHandlers().CARVE_SCENE({ toolDiaMm: 3, material: 'softwood' })).rejects.toThrow(/already running/);
    expect(onWorker).not.toHaveBeenCalled();
  });
});
