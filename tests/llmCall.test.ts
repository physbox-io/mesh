import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callLlm, keyFor } from '../src/utils/llmCall';

const img = { mediaType: 'image/jpeg' as const, data: 'AAAA' };

function mockFetch(reply: unknown) {
  const f = vi.fn(async () => ({ json: async () => reply }));
  vi.stubGlobal('fetch', f);
  return f;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  });
});

describe('callLlm', () => {
  it('sends Claude the pictures as image blocks before the text', async () => {
    const f = mockFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const r = await callLlm({ system: 'sys', user: 'build it', images: [img], model: 'claude-x', claudeKey: 'k' });
    expect(r).toEqual({ text: 'ok', truncated: false });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.system).toBe('sys');
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'build it' },
    ]);
  });

  it('keeps a plain string for Claude with no pictures', async () => {
    const f = mockFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'max_tokens' });
    const r = await callLlm({ system: 's', user: 'u', model: 'claude-x', claudeKey: 'k' });
    expect(r.truncated).toBe(true);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.messages[0].content).toBe('u');
  });

  it('sends Gemini the pictures as inline_data parts', async () => {
    const f = mockFetch({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'STOP' }] });
    const r = await callLlm({ system: 's', user: 'u', images: [img], model: 'gemini-x', geminiKey: 'g' });
    expect(r.text).toBe('a\nb');
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
    expect(body.contents[0].parts[1].text).toContain('User Request: u');
  });

  it('throws the provider error and refuses without a key', async () => {
    mockFetch({ error: { message: 'bad key' } });
    await expect(callLlm({ system: 's', user: 'u', model: 'gemini-x', geminiKey: 'g' })).rejects.toThrow('bad key');
    await expect(callLlm({ system: 's', user: 'u', model: 'claude-x' })).rejects.toThrow(/Claude API Key/);
    expect('missing' in keyFor('gemini-x')).toBe(true);
  });
});
