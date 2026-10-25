import { describe, it, expect, vi } from 'vitest';
import type { SceneGraph } from '../src/types/scene';

/*
 * A carve asked for over MCP is cut with feeds worked out for the bit, the
 * material and the machine on the cable, as the export dialog does. It used to
 * take the defaults' wood recipe — M3 S12000, F1500 — whatever was named, which
 * is about seven times the feed a 1 mm bit can take in aluminium.
 */

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
}));

const { carveOptions, setCurrentScene } = await import('../src/utils/machineMcp');
const { webSerialManager } = await import('../src/utils/webSerialManager');
const { deriveSolidOptions, DEFAULT_SOLID_OPTIONS } = await import('../src/utils/solidMachiningExporter');

const block: SceneGraph = {
  nodes: [{ id: 'b', name: 'p', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, 0.005] } as never], joints: [], children: [] }],
} as unknown as SceneGraph;

describe('an MCP carve', () => {
  it('derives its feeds from the bit, the material and the connected machine', () => {
    setCurrentScene(block);
    const mgr = webSerialManager as unknown as { state: { motion: unknown } };
    const motion = webSerialManager.getState().motion;
    mgr.state.motion = { ...motion, spindle: { min: 5000, max: 10000 }, maxRate: { ...motion.maxRate, x: 2000, y: 1800 } };

    const { options } = carveOptions({ toolDiaMm: 1, material: 'aluminium' });
    const expected = deriveSolidOptions(
      block,
      { material: 'aluminium', roughingToolDiaMm: 1, finishingToolDiaMm: 1 },
      { min: 5000, max: 10000 },
      1800
    );
    expect(options.spindleRpm).toBe(expected.spindleRpm);
    expect(options.finishingFeedrate).toBe(expected.finishingFeedrate);
    expect(options.roughingStepdownMm).toBe(expected.roughingStepdownMm);
    expect(options.spindleRpm).toBeLessThanOrEqual(10000);
    expect(options.finishingFeedrate).toBeLessThan(DEFAULT_SOLID_OPTIONS.finishingFeedrate / 3);
    mgr.state.motion = motion;
  });
});
