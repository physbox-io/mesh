import { describe, it, expect } from 'vitest';
import { encodeReply } from '../src/hooks/mcp/replySize';

describe('MCP reply size', () => {
  it('sends a reply that fits as it is', () => {
    const msg = JSON.parse(encodeReply('GET_SCENE', 7, { nodes: [] }, 1000));
    expect(msg).toEqual({ event: 'RESULT', cmd: 'GET_SCENE', id: 7, data: { nodes: [] } });
  });

  it('turns a reply over the link limit into an error naming the lighter reads', () => {
    const big = { vertices: new Array(5000).fill(0.123456) };
    const text = encodeReply('GET_SCENE', 'a1', big, 10_000);
    expect(text.length).toBeLessThan(10_000);
    const msg = JSON.parse(text);
    expect(msg.event).toBe('ERROR');
    expect(msg.id).toBe('a1');
    expect(msg.error).toContain('GET_SCENE');
    expect(msg.error).toContain('physics_get_scene_summary');
  });
});
