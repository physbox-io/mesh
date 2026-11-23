// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { DfmReport } from '../src/utils/dfm';
import type { DfmRequest, DfmResponse } from '../src/workers/dfmProtocol';
import {
  applyLivePosesToScene,
  dfmReportFor,
  getLivePosedScene,
  requestDfmReportUi,
  resetDfmWorkerClientForTests,
  setDfmWorkerFactory,
  useDfmReport,
  type DfmWorkerLike,
} from '../src/utils/dfmWorkerClient';
import { buildHeatGeometry, HEAT_NORMAL_OFFSET_M } from '../src/utils/dfmHeatGeometry';
import { getNodeWorldTransform } from '../src/utils/laserCutExporter';
import { bodyOf } from '../src/utils/measureScene';

class FakeDfmWorker implements DfmWorkerLike {
  sent: DfmRequest[] = [];
  onmessage: ((evt: MessageEvent<DfmResponse>) => void) | null = null;
  onerror: ((evt?: unknown) => void) | null = null;
  onmessageerror: ((evt?: unknown) => void) | null = null;
  terminated = false;
  throwOnPost = false;

  postMessage(msg: DfmRequest) {
    if (this.throwOnPost) throw new Error('DataCloneError');
    this.sent.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  replyDone(id: number, report: DfmReport) {
    this.onmessage?.({ data: { type: 'DFM_DONE', id, report } } as MessageEvent<DfmResponse>);
  }

  replyFailed(id: number, error = 'boom') {
    this.onmessage?.({ data: { type: 'FAILED', id, error } } as MessageEvent<DfmResponse>);
  }
}

function fakeReport(summary: string, score = 100): DfmReport {
  return {
    process: 'print',
    findings: [],
    heat: new Float32Array(0),
    tris: new Float64Array(0),
    legend: '',
    score,
    summary,
    warnings: [],
  };
}

const makeScene = (name = 's'): SceneGraph => ({
  nodes: [
    {
      id: name,
      name,
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [],
    } as SceneNode,
  ],
} as SceneGraph);

describe('dfmWorkerClient concurrency, recovery, and staleness', () => {
  let workers: FakeDfmWorker[] = [];

  beforeEach(() => {
    workers = [];
    resetDfmWorkerClientForTests({ timeoutMs: 5_000 });
    setDfmWorkerFactory(() => {
      const w = new FakeDfmWorker();
      workers.push(w);
      return w;
    });
  });

  afterEach(() => {
    setDfmWorkerFactory(null);
    resetDfmWorkerClientForTests();
  });

  it('never lets UI polling evict imperative dfmReportFor calls (and coalesces only UI slots)', async () => {
    const s1 = makeScene('s1');
    const s2 = makeScene('s2');
    const s3 = makeScene('s3');
    const mcpScene = makeScene('mcp_subset');

    // First UI job begins running on worker immediately.
    const ui1 = requestDfmReportUi(s1, 'print', { nodeId: 'a' });
    // Imperative MCP/mold check arrives with a synthetic SceneGraph.
    const imp = dfmReportFor(mcpScene, 'cast', { castMaterial: 'epoxy' });
    // Two rapid UI edits arrive while ui1 is still running.
    const ui2 = requestDfmReportUi(s2, 'print', { nodeId: 'a' });
    const ui3 = requestDfmReportUi(s3, 'print', { nodeId: 'a' });

    expect(workers).toHaveLength(1);
    const w = workers[0];
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].id).toBe(1);

    // ui2 was superseded by ui3 -> settled with null immediately.
    await expect(ui2).resolves.toBeNull();

    // Finish ui1 -> imperative job runs next (NOT evicted by ui2/ui3!).
    w.replyDone(1, fakeReport('ui1'));
    await expect(ui1).resolves.toMatchObject({ summary: 'ui1' });

    expect(w.sent).toHaveLength(2);
    expect(w.sent[1].type).toBe('DFM');
    expect(w.sent[1].scene).toBe(mcpScene);

    // Finish imperative job -> latest UI job (ui3) runs next.
    w.replyDone(w.sent[1].id, fakeReport('mcp_ok', 92));
    await expect(imp).resolves.toMatchObject({ summary: 'mcp_ok', score: 92 });

    expect(w.sent).toHaveLength(3);
    expect(w.sent[2].scene).toBe(s3);
    w.replyDone(w.sent[2].id, fakeReport('ui3', 88));
    await expect(ui3).resolves.toMatchObject({ summary: 'ui3', score: 88 });
  });

  it('promotes a queued UI job when an imperative dfmReportFor asks for the same (scene, key)', async () => {
    const s1 = makeScene('s1');
    const s2 = makeScene('s2');
    const s3 = makeScene('s3');

    const busy = requestDfmReportUi(s1, 'print', { nodeId: 'p' });
    const queuedUi = requestDfmReportUi(s2, 'print', { nodeId: 'p' });
    // Imperative caller asks for the exact same (s2, print, p) while it sits in uiQueue.
    const impSame = dfmReportFor(s2, 'print', { nodeId: 'p' });
    // Another UI edit arrives on s3 -> must NOT evict the promoted s2 job!
    const newerUi = requestDfmReportUi(s3, 'print', { nodeId: 'p' });

    const w = workers[0];
    w.replyDone(w.sent[0].id, fakeReport('busy'));
    await expect(busy).resolves.toMatchObject({ summary: 'busy' });

    // Promoted s2 runs next and resolves both promises.
    expect(w.sent[1].scene).toBe(s2);
    w.replyDone(w.sent[1].id, fakeReport('shared_s2'));
    await expect(impSame).resolves.toMatchObject({ summary: 'shared_s2' });
    await expect(queuedUi).resolves.toMatchObject({ summary: 'shared_s2' });

    // Newer UI edit runs after.
    expect(w.sent[2].scene).toBe(s3);
    w.replyDone(w.sent[2].id, fakeReport('s3'));
    await expect(newerUi).resolves.toMatchObject({ summary: 's3' });
  });

  it('omits scene on subsequent lenses for the same SceneGraph and caches results', async () => {
    const s = makeScene('cached');
    const p1 = dfmReportFor(s, 'print', {});
    const p2 = dfmReportFor(s, 'cast', {});

    const w = workers[0];
    expect(w.sent[0].scene).toBe(s);
    w.replyDone(w.sent[0].id, fakeReport('print_res'));
    await expect(p1).resolves.toMatchObject({ summary: 'print_res' });

    expect(w.sent[1].scene).toBeUndefined();
    w.replyDone(w.sent[1].id, fakeReport('cast_res'));
    await expect(p2).resolves.toMatchObject({ summary: 'cast_res' });

    // Cached hit sends zero additional worker messages.
    const hit = await dfmReportFor(s, 'print', {});
    expect(hit?.summary).toBe('print_res');
    expect(w.sent).toHaveLength(2);
  });

  it('recovers cleanly from FAILED, onmessageerror, onerror, and postMessage throw', async () => {
    const s1 = makeScene('e1');
    const s2 = makeScene('e2');
    const s3 = makeScene('e3');
    const s4 = makeScene('e4');

    // 1. FAILED response settles null and pumps next job on same worker.
    const f1 = dfmReportFor(s1, 'print', {});
    const f2 = dfmReportFor(s2, 'print', {});
    workers[0].replyFailed(workers[0].sent[0].id, 'bad mesh');
    await expect(f1).resolves.toBeNull();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toHaveLength(2);

    // 2. onmessageerror terminates wedged worker, settles running null, and runs queued job on a fresh worker.
    const f3 = dfmReportFor(s3, 'print', {});
    workers[0].onmessageerror?.();
    await expect(f2).resolves.toBeNull();
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    // Fresh worker must receive full scene payload again.
    expect(workers[1].sent[0].scene).toBe(s3);
    workers[1].replyDone(workers[1].sent[0].id, fakeReport('after_msgerr'));
    await expect(f3).resolves.toMatchObject({ summary: 'after_msgerr' });

    // 3. onerror fails running + queued and respawns on next request.
    const f4 = dfmReportFor(s4, 'print', {});
    workers[1].onerror?.();
    await expect(f4).resolves.toBeNull();
    expect(workers[1].terminated).toBe(true);

    const f5 = dfmReportFor(s4, 'cast', {});
    expect(workers).toHaveLength(3);
    workers[2].replyDone(workers[2].sent[0].id, fakeReport('respawned'));
    await expect(f5).resolves.toMatchObject({ summary: 'respawned' });

    // 4. postMessage throw settles null without wedging subsequent jobs.
    workers[2].throwOnPost = true;
    const f6 = dfmReportFor(s4, 'cnc', {});
    await expect(f6).resolves.toBeNull();
    workers[2].throwOnPost = false;
    const f7 = dfmReportFor(s1, 'cnc', {});
    workers[2].replyDone(workers[2].sent[workers[2].sent.length - 1].id, fakeReport('recovered'));
    await expect(f7).resolves.toMatchObject({ summary: 'recovered' });
  });

  it('recovers from a hung worker via per-job watchdog timeout', async () => {
    resetDfmWorkerClientForTests({ timeoutMs: 25 });
    const s1 = makeScene('hung');
    const s2 = makeScene('next');

    const hung = dfmReportFor(s1, 'print', {});
    const next = dfmReportFor(s2, 'print', {});

    expect(workers).toHaveLength(1);
    // Never reply to workers[0]: watchdog should fire, terminate it, settle null, and spawn workers[1].
    await expect(hung).resolves.toBeNull();
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent).toHaveLength(1);
    expect(workers[1].sent[0].scene).toBe(s2);

    workers[1].replyDone(workers[1].sent[0].id, fakeReport('after_timeout'));
    await expect(next).resolves.toMatchObject({ summary: 'after_timeout' });
  });

  it('clears stale report immediately when selection or lens changes in useDfmReport, but keeps last report across same-part edits', async () => {
    const s1 = makeScene('edit1');
    const s2 = makeScene('edit2');
    const observed: (string | null)[] = [];

    function Probe({
      scene,
      process,
      nodeId,
    }: {
      scene: SceneGraph | null;
      process: 'print' | 'cast' | null;
      nodeId: string | null;
    }) {
      const report = useDfmReport(scene, process, { nodeId });
      observed.push(report ? report.summary : null);
      return React.createElement('div', null, report?.summary ?? 'null');
    }

    const container = document.createElement('div');
    const root = createRoot(container);

    // Mount on Part A (print).
    await act(async () => {
      root.render(React.createElement(Probe, { scene: s1, process: 'print', nodeId: 'partA' }));
    });
    expect(container.textContent).toBe('null');
    await act(async () => {
      workers[0].replyDone(workers[0].sent[0].id, fakeReport('partA_print_v1'));
    });
    expect(container.textContent).toBe('partA_print_v1');

    // Edit scene on SAME Part A & SAME lens: keeps v1 standing while v2 computes (no blank flash).
    await act(async () => {
      root.render(React.createElement(Probe, { scene: s2, process: 'print', nodeId: 'partA' }));
    });
    expect(container.textContent).toBe('partA_print_v1');
    await act(async () => {
      workers[0].replyDone(workers[0].sent[1].id, fakeReport('partA_print_v2'));
    });
    expect(container.textContent).toBe('partA_print_v2');

    // Switch selection to Part B: IMMEDIATELY clears Part A instead of flashing Part A under Part B!
    await act(async () => {
      root.render(React.createElement(Probe, { scene: s2, process: 'print', nodeId: 'partB' }));
    });
    expect(container.textContent).toBe('null');
    await act(async () => {
      workers[0].replyDone(workers[0].sent[2].id, fakeReport('partB_print'));
    });
    expect(container.textContent).toBe('partB_print');

    // Toggle lens to Cast on Part B: IMMEDIATELY clears Print instead of flashing Print under Cast!
    await act(async () => {
      root.render(React.createElement(Probe, { scene: s2, process: 'cast', nodeId: 'partB' }));
    });
    expect(container.textContent).toBe('null');
    await act(async () => {
      workers[0].replyDone(workers[0].sent[3].id, fakeReport('partB_cast'));
    });
    expect(container.textContent).toBe('partB_cast');

    await act(async () => {
      root.unmount();
    });
  });
});

describe('applyLivePosesToScene & getLivePosedScene', () => {
  it('aligns root, child, and baked-rotation mesh bodies to their live world matrices and caches by pose', () => {
    const child: SceneNode = {
      id: 'child',
      name: 'child',
      type: 'body',
      pos: [0.1, 0, 0],
      joints: [],
      children: [],
      geoms: [{ name: 'c_mesh', type: 'mesh', size: [1], vertices: [0, 0, 0], baseVertices: [0, 0, 0], faces: [] } as never],
    };
    const rootNode: SceneNode = {
      id: 'root',
      name: 'root',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [child],
      geoms: [],
    };
    const scene: SceneGraph = { nodes: [rootNode] } as SceneGraph;

    const rootLive = new THREE.Matrix4()
      .makeRotationFromQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
      .setPosition(0.3, -0.2, 0.05);
    const childLive = new THREE.Matrix4()
      .makeRotationFromQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3))
      .setPosition(0.3, -0.1, 0.12);

    const poses = new Map<string, THREE.Matrix4>([
      ['root', rootLive],
      ['child', childLive],
    ]);

    const posed = applyLivePosesToScene(scene, poses);
    const computedRoot = getNodeWorldTransform(posed.nodes[0]);
    const computedChild = getNodeWorldTransform(posed.nodes[0].children![0], computedRoot);

    for (let i = 0; i < 16; i++) {
      expect(computedRoot.elements[i]).toBeCloseTo(rootLive.elements[i], 5);
      expect(computedChild.elements[i]).toBeCloseTo(childLive.elements[i], 5);
    }

    // Shared cache returns identical object reference for same scene + poses.
    const cached1 = getLivePosedScene(scene, poses);
    const cached2 = getLivePosedScene(scene, new Map(poses));
    expect(cached1).toBe(cached2);
    expect(getLivePosedScene(scene, null)).toBe(scene);
  });
});

describe('buildHeatGeometry normal offset & overlay bodyOf guard', () => {
  it('offsets each hot triangle outward along its geometric normal without building unused vertex normals', () => {
    // One upward-facing (+Z) triangle in the z=0 plane (CCW winding in XY).
    const report: DfmReport = {
      process: 'print',
      findings: [],
      tris: new Float64Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]),
      heat: new Float32Array([1.0]),
      legend: '',
      score: 50,
      summary: '',
      warnings: [],
    };
    const geom = buildHeatGeometry(report)!;
    expect(geom).not.toBeNull();
    expect(geom.getAttribute('normal')).toBeUndefined();
    const pos = geom.getAttribute('position').array as Float32Array;
    // All 3 vertices shifted +HEAT_NORMAL_OFFSET_M along +Z.
    expect(pos[2]).toBeCloseTo(HEAT_NORMAL_OFFSET_M, 7);
    expect(pos[5]).toBeCloseTo(HEAT_NORMAL_OFFSET_M, 7);
    expect(pos[8]).toBeCloseTo(HEAT_NORMAL_OFFSET_M, 7);
    geom.dispose();
  });

  it('excludes userData.isOverlay subtrees from measureScene.bodyOf even if nested under a named Group', () => {
    const namedGroup = new THREE.Group();
    namedGroup.name = 'body_1';
    const overlayGroup = new THREE.Group();
    overlayGroup.userData = { isOverlay: true, skipExport: true };
    const mesh = new THREE.Mesh();
    overlayGroup.add(mesh);
    namedGroup.add(overlayGroup);

    expect(bodyOf(mesh)).toBeNull();
  });
});
