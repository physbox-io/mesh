import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callLlm } from '../src/utils/llmCall';
import {
  clampMaxTokensForModel,
  modelMaxOutputTokens,
  readStorageString,
  writeStorageString,
} from '../src/utils/llmSettings';
import { mergeAndNormalizeNodes, serializeNodesCompact } from '../src/utils/sceneNodes';
import { parseAIResponse } from '../src/utils/copilotReply';
import { drawableToLlmImage, fileToLlmImage } from '../src/utils/llmImageInput';
import { geomActions } from '../src/store/geomActions';
import type { SceneNode } from '../src/types/scene';

function mockFetchResponse(body: string, ok: boolean, status: number) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  });
});

describe('Section 6A: callLlm transport safety & Gemini protocol', () => {
  it('handles non-JSON HTTP error responses cleanly instead of throwing SyntaxError', async () => {
    mockFetchResponse('<html><body>502 Bad Gateway</body></html>', false, 502);
    await expect(
      callLlm({ system: 's', user: 'u', model: 'gemini-2.5-flash', geminiKey: 'key-1' }),
    ).rejects.toThrow(/Gemini API HTTP 502/);

    mockFetchResponse('Service Unavailable', false, 503);
    await expect(
      callLlm({ system: 's', user: 'u', model: 'claude-3-5-sonnet-20241022', claudeKey: 'key-2' }),
    ).rejects.toThrow(/Claude API HTTP 503/);
  });

  it('filters out Gemini thought:true parts and falls back only if no non-thought parts exist', async () => {
    mockFetchResponse(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'internal chain of thought', thought: true },
                { text: 'Final answer' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      true,
      200,
    );
    const res = await callLlm({ system: 'sys', user: 'hi', model: 'gemini-2.5-flash', geminiKey: 'g-key' });
    expect(res.text).toBe('Final answer');

    // Fallback when all parts are marked thought:true
    mockFetchResponse(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'only thought text', thought: true }],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      true,
      200,
    );
    const fallbackRes = await callLlm({ system: 'sys', user: 'hi', model: 'gemini-2.5-flash', geminiKey: 'g-key' });
    expect(fallbackRes.text).toBe('only thought text');
  });

  it('clamps max_tokens against known model ceilings (e.g. claude-3-5-* -> 8192)', async () => {
    expect(modelMaxOutputTokens('claude-3-5-sonnet-20241022')).toBe(8192);
    expect(clampMaxTokensForModel(64000, 'claude-3-5-sonnet-20241022')).toBe(8192);

    const fn = mockFetchResponse(
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
      true,
      200,
    );
    await callLlm({
      system: 'sys',
      user: 'u',
      model: 'claude-3-5-sonnet-20241022',
      claudeKey: 'ck',
      maxTokens: 50000,
    });
    const init = (fn.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body).max_tokens).toBe(8192);
  });

  it('sends Gemini key via x-goog-api-key header, encodes model name, and uses native systemInstruction', async () => {
    const fn = mockFetchResponse(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      true,
      200,
    );
    const controller = new AbortController();
    await callLlm({
      system: 'You are a physics expert.',
      user: 'Make a box.',
      model: 'gemini-2.5/custom',
      geminiKey: 'secret-key',
      signal: controller.signal,
    });

    const [url, init] = fn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string; signal?: AbortSignal },
    ];
    expect(url).toContain(encodeURIComponent('gemini-2.5/custom'));
    expect(url).not.toContain('key=');
    expect(url).not.toContain('secret-key');
    expect(init.headers['x-goog-api-key']).toBe('secret-key');
    expect(init.signal).toBe(controller.signal);

    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.systemInstruction).toEqual({ parts: [{ text: 'You are a physics expert.' }] });
    expect(parsedBody.contents[0].parts).toEqual([{ text: 'Make a box.' }]);
  });
});

describe('Section 6A: mergeAndNormalizeNodes full replacement isolation', () => {
  it('does not leak old body fields when isFullReplacement is true even on matching id/name', () => {
    const existing = [
      {
        id: 'body_1',
        name: 'body_1',
        pos: [5, 6, 7],
        euler: [0.5, 0.5, 0.5],
        scad: 'old_scad();',
        geoms: [
          {
            id: 'old_g',
            name: 'old_mesh',
            type: 'mesh' as const,
            size: [0.5, 0.5, 0.5],
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            faces: [0, 1, 2],
          },
        ],
      },
    ];

    const merged = mergeAndNormalizeNodes(
      [{ id: 'body_1', name: 'body_1', geoms: [{ type: 'box', size: [0.2, 0.2, 0.2] }] }],
      existing,
      true,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].pos).toEqual([0, 0, 0]);
    expect(merged[0].euler).toEqual([0, 0, 0]);
    expect(merged[0].scad).toBeUndefined();
    expect(merged[0].geoms[0].type).toBe('box');
    expect(merged[0].geoms[0].vertices).toBeUndefined();
  });
});

describe('Section 6A: serializeNodesCompact bulky-field denylist', () => {
  it('strips bulky mesh/collider arrays while preserving physics, CSG, cloth, and acoustic metadata', () => {
    const richNode = {
      id: 'plate_1',
      name: 'plate_1',
      pos: [0.123456, 0, 0.5],
      euler: [0, 0, 0],
      role: 'soundboard',
      acousticMaterial: 'spruce',
      shatterImpulseNs: 12.5,
      waterFill: { enabled: true },
      flexure: { stiffness: 40 },
      cloth: { enabled: true },
      bodyForm: { heightM: 1.7 },
      edgeRounds: [{ edges: ['top'], radiusMm: 2 }],
      loadStrength: { flexuralMPa: 50, tensileMPa: 40, modulusGPa: 10 },
      colliders: [{ vertices: [1, 2, 3] }],
      geoms: [
        {
          id: 'g1',
          name: 'plate_geom',
          type: 'capsule',
          size: [0.0256, 0.1512],
          pos: [0, 0, 0],
          fromto: [0, 0, 0, 0.3004, 0, 0],
          contype: 2,
          conaffinity: 3,
          csg: 'difference',
          density: 650,
          friction: [0.8, 0.01, 0.001],
          textures: [{ pattern: 'knurl', depthMm: 0.5 }],
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          faces: [0, 1, 2],
          renderVertices: [0, 0, 0],
          colliderVertices: [0, 0, 0],
        },
      ],
      joints: [],
      children: [],
    } as unknown as SceneNode;

    const [compact] = serializeNodesCompact([richNode]);
    expect(compact.pos).toEqual([0.123, 0, 0.5]);
    expect(compact.euler).toBeUndefined();
    expect(compact.role).toBe('soundboard');
    expect(compact.acousticMaterial).toBe('spruce');
    expect(compact.shatterImpulseNs).toBe(12.5);
    expect(compact.waterFill).toEqual({ enabled: true });
    expect(compact.flexure).toEqual({ stiffness: 40 });
    expect(compact.cloth).toEqual({ enabled: true });
    expect(compact.bodyForm).toEqual({ heightM: 1.7 });
    expect(compact.edgeRounds).toEqual([{ edges: ['top'], radiusMm: 2 }]);
    expect(compact.loadStrength).toEqual({ flexuralMPa: 50, tensileMPa: 40, modulusGPa: 10 });
    expect(compact.colliders).toBeUndefined();

    const g = compact.geoms![0];
    expect(g.fromto).toEqual([0, 0, 0, 0.3, 0, 0]);
    expect(g.contype).toBe(2);
    expect(g.conaffinity).toBe(3);
    expect(g.csg).toBe('difference');
    expect(g.density).toBe(650);
    expect(g.friction).toEqual([0.8, 0.01, 0.001]);
    expect(g.textures).toEqual([{ pattern: 'knurl', depthMm: 0.5 }]);
    expect(g.vertices).toBeUndefined();
    expect(g.faces).toBeUndefined();
    expect(g.renderVertices).toBeUndefined();
    expect(g.colliderVertices).toBeUndefined();
  });
});

describe('Section 6A: parseAIResponse fence removal & bullet-list fallback scope', () => {
  it('removes only consumed JSON blocks and preserves non-JSON code fences like ```scad', () => {
    const reply = [
      'Here is the OpenSCAD snippet:',
      '```scad',
      'cube([10, 10, 10]);',
      '```',
      '',
      '```json',
      '{"nodes": [{"id": "box1", "pos": [0, 0, 0.1]}]}',
      '```',
    ].join('\n');

    const parsed = parseAIResponse(reply);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes![0].id).toBe('box1');
    expect(parsed.markdown).toContain('```scad');
    expect(parsed.markdown).toContain('cube([10, 10, 10]);');
    expect(parsed.markdown).not.toContain('"box1"');
  });

  it('does not scrape bullet lists into proposedModifications unless extractBulletModifications is enabled', () => {
    const explainReply = [
      '## Analysis & Recommendations',
      '- Increase the damping coefficient to stabilize oscillation',
      '- Add fillets along the base edges to reduce stress',
    ].join('\n');

    const defaultParsed = parseAIResponse(explainReply);
    expect(defaultParsed.proposedModifications).toHaveLength(0);

    const explicitParsed = parseAIResponse(explainReply, { extractBulletModifications: true });
    expect(explicitParsed.proposedModifications).toHaveLength(2);
    expect(explicitParsed.proposedModifications[0].text).toContain('damping');
  });
});

describe('Section 6A: safe localStorage wrappers', () => {
  it('survives throwing localStorage without crashing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    });
    expect(readStorageString('gemini_api_key', 'fallback')).toBe('fallback');
    expect(() => writeStorageString('gemini_api_key', 'abc')).not.toThrow();
  });
});

describe('Section 6A: llmImageInput 0x0 image guard', () => {
  it('throws on 0x0 dimensions in drawableToLlmImage and fileToLlmImage', async () => {
    expect(() => drawableToLlmImage({} as CanvasImageSource, 0, 100)).toThrow(/0×0|invalid/i);
    expect(() => drawableToLlmImage({} as CanvasImageSource, 100, 0)).toThrow(/0×0|invalid/i);

    const revoke = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: revoke,
    });
    class FakeImage {
      decoding = '';
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);

    await expect(fileToLlmImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow(/0×0/);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});

describe('Section 6A: geomActions.updateNodeScad skipHistory flag', () => {
  it('skips recording undo history when skipHistory is true and records it otherwise', () => {
    const recordInteraction = vi.fn();
    const recompile = vi.fn();
    let state = {
      sceneGraph: {
        nodes: [
          {
            id: 'parent',
            name: 'parent',
            pos: [0, 0, 0],
            euler: [0, 0, 0],
            geoms: [],
            joints: [],
            children: [
              {
                id: 'nested_scad',
                name: 'nested_scad',
                pos: [0, 0, 0],
                euler: [0, 0, 0],
                scad: 'cube(1);',
                geoms: [{ id: 'g1', name: 'm', type: 'mesh', size: [1], pos: [0, 0, 0], rgba: [1, 1, 1, 1], mass: 1, dynamic: true }],
                joints: [],
                children: [],
              },
            ],
          },
        ],
      },
      recordInteraction,
      recompile,
    };

    const set = (partial: unknown) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    const get = () => state as never;

    const actions = geomActions({ set: set as never, get });
    const compiled = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2], renderVertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] };

    actions.updateNodeScad('nested_scad', 'cube(2);', compiled, true, true);
    expect(recordInteraction).not.toHaveBeenCalled();
    expect(recompile).not.toHaveBeenCalled();
    expect(state.sceneGraph.nodes[0].children[0].scad).toBe('cube(2);');
    expect(state.sceneGraph.nodes[0].children[0].geoms[0].faces).toEqual([0, 1, 2]);

    actions.updateNodeScad('nested_scad', 'cube(3);', compiled, true, false);
    expect(recordInteraction).toHaveBeenCalledWith('node-scad');
  });
});
