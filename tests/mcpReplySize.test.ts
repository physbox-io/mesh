import { describe, it, expect } from 'vitest';
import {
  encodeReply,
  encodeError,
  utf8ByteLength,
  MCP_REPLY_LIMIT_BYTES,
  MCP_REPLY_LIMIT_CHARS,
} from '../src/hooks/mcp/replySize';

describe('MCP reply size', () => {
  it('exports MCP_REPLY_LIMIT_CHARS as an alias for MCP_REPLY_LIMIT_BYTES', () => {
    expect(MCP_REPLY_LIMIT_BYTES).toBe(90 * 1024 * 1024);
    expect(MCP_REPLY_LIMIT_CHARS).toBe(MCP_REPLY_LIMIT_BYTES);
  });

  it('sends a reply that fits as it is', () => {
    const msg = JSON.parse(encodeReply('GET_SCENE', 7, { nodes: [] }, 1000));
    expect(msg).toEqual({ event: 'RESULT', cmd: 'GET_SCENE', id: 7, data: { nodes: [] } });
  });

  it('turns a reply over the link limit into an error naming the lighter reads', () => {
    const big = { vertices: new Array(5000).fill(0.123456) };
    const text = encodeReply('GET_SCENE', 'a1', big, 10_000);
    expect(utf8ByteLength(text)).toBeLessThan(10_000);
    const msg = JSON.parse(text);
    expect(msg.event).toBe('ERROR');
    expect(msg.id).toBe('a1');
    expect(msg.error).toContain('GET_SCENE');
    expect(msg.error).toContain('physics_get_scene_summary');
  });

  it('enforces UTF-8 byte length rather than UTF-16 code units for multi-byte characters', () => {
    // '—' is 1 UTF-16 code unit (length = 1) but 3 UTF-8 bytes.
    // 400 em-dashes -> ~450 UTF-16 chars, ~1250 UTF-8 bytes.
    const multiByte = { note: '—'.repeat(400) };
    const raw = JSON.stringify({ event: 'RESULT', cmd: 'GET_STATE', id: 2, data: multiByte });
    expect(raw.length).toBeLessThan(1000);
    expect(utf8ByteLength(raw)).toBeGreaterThan(1000);

    const encoded = encodeReply('GET_STATE', 2, multiByte, 1000);
    expect(utf8ByteLength(encoded)).toBeLessThanOrEqual(1000);
    const parsed = JSON.parse(encoded);
    expect(parsed.event).toBe('ERROR');
    expect(parsed.cmd).toBe('GET_STATE');
    expect(parsed.id).toBe(2);
  });

  it('gives export-specific guidance for oversize EXPORT_* and file payloads', () => {
    const bigFiles = { files: [{ name: 'part.stl', base64: 'A'.repeat(20_000) }] };
    const encodedExport = encodeReply('EXPORT_STL', 3, bigFiles, 10_000);
    const parsedExport = JSON.parse(encodedExport);
    expect(parsedExport.event).toBe('ERROR');
    expect(parsedExport.error).toContain('includeFiles: false');
    expect(parsedExport.error).toContain('separate: true');
    expect(parsedExport.error).not.toContain('physics_get_scene_summary');

    const encodedSim = encodeReply('ADD_SIMULATION', 4, bigFiles, 10_000);
    const parsedSim = JSON.parse(encodedSim);
    expect(parsedSim.event).toBe('ERROR');
    expect(parsedSim.error).toContain('includeFiles: false');
  });

  it('handles JSON.stringify RangeError and TypeError (circular / BigInt) safely', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circOut = JSON.parse(encodeReply('GET_SCENE', 5, circular, 2000));
    expect(circOut.event).toBe('ERROR');
    expect(circOut.id).toBe(5);
    expect(circOut.error).toContain('Failed to serialize reply');

    const bigIntOut = JSON.parse(encodeReply('GET_SCENE', 6, { n: BigInt(42) }, 2000));
    expect(bigIntOut.event).toBe('ERROR');
    expect(bigIntOut.error).toContain('Failed to serialize reply');

    const rangeObj = {
      toJSON() {
        throw new RangeError('Invalid string length');
      },
    };
    const rangeOut = JSON.parse(encodeReply('GET_SCENE', 7, rangeObj, 2000));
    expect(rangeOut.event).toBe('ERROR');
    expect(rangeOut.error).toContain('too large to serialize');
    expect(rangeOut.error).toContain('physics_get_scene_summary');
  });

  it('caps oversize error strings in encodeError to fit the UTF-8 byte limit', () => {
    const hugeErr = new Error('🔥'.repeat(5000));
    const encoded = encodeError('BUILD_SCENE', 'e1', hugeErr, 512);
    expect(utf8ByteLength(encoded)).toBeLessThanOrEqual(512);
    const parsed = JSON.parse(encoded);
    expect(parsed.event).toBe('ERROR');
    expect(parsed.cmd).toBe('BUILD_SCENE');
    expect(parsed.id).toBe('e1');
    expect(parsed.error.endsWith('...')).toBe(true);
  });
});
