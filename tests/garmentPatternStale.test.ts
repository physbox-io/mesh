import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import type { ModelMirror } from '../src/types/sceneLayer';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';
import { noteModelBuilt } from '../src/store/modelProvenance';
import { clothNodeSummary } from '../src/utils/cloth/clothSummary';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const dress = garmentNode('dress', 'dress', { garment: 'dress' }, form);
// What a compile of an earlier draft left in the model: one small square piece.
const oldFlexes = [{
  name: 'dress__oldpiece', vertadr: 0, vertnum: 4, elems: [0, 1, 2, 0, 2, 3], rgba: [1, 1, 1, 1],
  flat: { uv: [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]] as [number, number][], outline: [0, 1, 2, 3], strain95: 0 },
}];

async function exportWith(builtFrom: SceneNode[]) {
  const prev = useStore.getState();
  const graph = { ...prev.sceneGraph, nodes: [form, dress] };
  useStore.setState({ sceneGraph: graph, model: { flexes: oldFlexes } as unknown as ModelMirror });
  noteModelBuilt(builtFrom === graph.nodes ? graph : { ...graph, nodes: builtFrom });
  try {
    return (await cutCommands.EXPORT_CUT({ kind: 'unfold' } as never, { store: useStore.getState() } as never)) as Record<string, unknown>;
  } finally {
    useStore.setState({ sceneGraph: prev.sceneGraph, model: prev.model });
  }
}

describe('the pattern export never reads a stale compiled pattern', () => {
  it('uses the compiled pieces while they describe the garment as it stands', async () => {
    const graphNodes = [form, dress];
    const prev = useStore.getState();
    const graph = { ...prev.sceneGraph, nodes: graphNodes };
    useStore.setState({ sceneGraph: graph, model: { flexes: oldFlexes } as unknown as ModelMirror });
    noteModelBuilt(graph);
    try {
      const r = (await cutCommands.EXPORT_CUT({ kind: 'unfold' } as never, { store: useStore.getState() } as never)) as Record<string, unknown>;
      expect((r.summary as Record<string, unknown>).pieceNames).toEqual(['oldpiece']);
    } finally {
      useStore.setState({ sceneGraph: prev.sceneGraph, model: prev.model });
    }
  });

  it('builds from the graph once the garment has changed since the compile', async () => {
    const before = garmentNode('dress', 'dress', { garment: 'dress', length: 0.3 }, form);
    const r = await exportWith([form, before]);
    expect(r.ok).toBe(true);
    const names = (r.summary as Record<string, unknown>).pieceNames as string[];
    expect(names).not.toContain('oldpiece');
    expect(names).toEqual(expect.arrayContaining(['front', 'back']));
  }, 120_000);

  it('and once its form has changed', async () => {
    const formBefore = bodyFormNode('form', 'form', { figure: 'female', waist: 0.8 });
    const r = await exportWith([formBefore, dress]);
    expect((r.summary as Record<string, unknown>).pieceNames).not.toContain('oldpiece');
  }, 120_000);
});

describe('a garment summary built from the graph is placed where it is worn', () => {
  it('on its form, wherever the form stands', () => {
    const away = bodyFormNode('form2', 'form2', { figure: 'female' }, [1, 0, 0]);
    const g = garmentNode('g2', 'g2', { garment: 'dress' }, away);
    g.pos = [0, 0, 0]; // its own pos left behind
    const s = clothNodeSummary(g, { scene: [away, g] })!;
    const cx = (s.bboxMm!.min[0] + s.bboxMm!.max[0]) / 2;
    expect(cx).toBeGreaterThan(900);
    expect(cx).toBeLessThan(1100);
  }, 120_000);
});
