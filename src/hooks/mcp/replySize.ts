// ---------------------------------------------------------------------------
// A reply too big for the MCP link
// ---------------------------------------------------------------------------
//
// The MCP server takes websocket messages up to 32 MiB (WS_MAX_MESSAGE in
// physbox_mcp/server.py) and closes the socket on anything larger, so an
// oversize reply never arrives: the agent sees the server disconnect, not an
// answer. physics_get_scene on a scene with a 275k-vertex master did exactly
// that. Such a reply is replaced by an error that says what to read instead.

/** Under the server's 96 MiB UTF-8 byte limit, with room for the envelope. */
export const MCP_REPLY_LIMIT_BYTES = 90 * 1024 * 1024;

/** Backwards-compatible alias for MCP_REPLY_LIMIT_BYTES. */
export const MCP_REPLY_LIMIT_CHARS = MCP_REPLY_LIMIT_BYTES;

const utf8Encoder = new TextEncoder();

/** UTF-8 byte length of `text`, with an O(1) fast path when the worst-case (3x) already fits. */
export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function fitsByteLimit(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return true;
  return utf8ByteLength(text) <= limit;
}

function isExportReply(cmd: string, data: unknown): boolean {
  return cmd.startsWith('EXPORT_') || (data !== null && typeof data === 'object' && 'files' in (data as Record<string, unknown>));
}

function oversizeErrorText(cmd: string, data: unknown, bytes: number | null, limit: number): string {
  const mb = (n: number) => Math.max(1, Math.round(n / (1024 * 1024)));
  const sizeDesc = bytes !== null ? `${mb(bytes)} MB` : 'too large to serialize';
  const limitDesc = `${mb(limit)} MB`;
  if (isExportReply(cmd, data)) {
    return (
      `The reply to ${cmd} is ${sizeDesc}, over the ${limitDesc} the MCP link carries, so it was not sent. ` +
      'The exported file payload is too large for one WebSocket message. Reduce the reply size instead: ' +
      'pass includeFiles: false to inspect metadata without file bytes, pass separate: true or export individual bodies one at a time, ' +
      'or use a lower resolution / fidelity.'
    );
  }
  return (
    `The reply to ${cmd} is ${sizeDesc}, over the ${limitDesc} the MCP link carries, so it was not sent. ` +
    'Mesh geoms in it carry their full vertex and face arrays. Read the scene in parts instead: ' +
    'physics_get_scene_summary (sizes, bounding boxes, watertightness), physics_get_objects or physics_get_object ' +
    '(everything but the mesh arrays), physics_get_object with geom, offset and limit for one geom\'s triangles a page ' +
    'at a time, and physics_measure for distances and angles on the geometry itself.'
  );
}

/**
 * Safely serialize an ERROR envelope, capping the error message so it stays
 * within `limit` UTF-8 bytes and never throws on weird error objects or ids.
 */
export function encodeError(cmd: string, id: unknown, err: unknown, limit = MCP_REPLY_LIMIT_BYTES): string {
  let raw: string;
  try {
    raw = err instanceof Error ? (err.message || String(err)) : String(err);
  } catch {
    raw = 'Unknown error';
  }
  const safeId = (() => {
    try {
      JSON.stringify(id);
      return id;
    } catch {
      return null;
    }
  })();
  // Cap error text generously, then shrink if UTF-8 bytes still exceed `limit`.
  const maxChars = Math.min(16_384, Math.max(64, limit));
  let message = raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
  let encoded = JSON.stringify({ event: 'ERROR', cmd, id: safeId, error: message });
  if (fitsByteLimit(encoded, limit)) return encoded;

  const emptyEnvelope = JSON.stringify({ event: 'ERROR', cmd, id: safeId, error: '' });
  const emptyBytes = utf8ByteLength(emptyEnvelope);
  if (emptyBytes >= limit) return emptyEnvelope;

  // Binary search the longest prefix of `message` (plus ellipsis) that fits in `limit` UTF-8 bytes.
  let lo = 0;
  let hi = message.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = JSON.stringify({ event: 'ERROR', cmd, id: safeId, error: `${message.slice(0, mid)}...` });
    if (fitsByteLimit(candidate, limit)) lo = mid;
    else hi = mid - 1;
  }
  message = lo > 0 ? `${message.slice(0, lo)}...` : '';
  encoded = JSON.stringify({ event: 'ERROR', cmd, id: safeId, error: message });
  return fitsByteLimit(encoded, limit) ? encoded : emptyEnvelope;
}

/** The message to send for one command's reply. */
export function encodeReply(cmd: string, id: unknown, data: unknown, limit = MCP_REPLY_LIMIT_BYTES): string {
  let text: string;
  try {
    text = JSON.stringify({ event: 'RESULT', cmd, id, data });
  } catch (err) {
    if (err instanceof RangeError) {
      return encodeError(cmd, id, oversizeErrorText(cmd, data, null, limit), limit);
    }
    return encodeError(cmd, id, `Failed to serialize reply for ${cmd}: ${err instanceof Error ? err.message : String(err)}`, limit);
  }
  if (fitsByteLimit(text, limit)) return text;
  const bytes = utf8ByteLength(text);
  return encodeError(cmd, id, oversizeErrorText(cmd, data, bytes, limit), limit);
}
