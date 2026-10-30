// ---------------------------------------------------------------------------
// A reply too big for the MCP link
// ---------------------------------------------------------------------------
//
// The MCP server takes websocket messages up to 32 MiB (WS_MAX_MESSAGE in
// physbox_mcp/server.py) and closes the socket on anything larger, so an
// oversize reply never arrives: the agent sees the server disconnect, not an
// answer. physics_get_scene on a scene with a 275k-vertex master did exactly
// that. Such a reply is replaced by an error that says what to read instead.

/** Under the server's 32 MiB, with room for the envelope. */
export const MCP_REPLY_LIMIT_CHARS = 30 * 1024 * 1024;

/** The message to send for one command's reply. */
export function encodeReply(cmd: string, id: unknown, data: unknown, limit = MCP_REPLY_LIMIT_CHARS): string {
  const text = JSON.stringify({ event: 'RESULT', cmd, id, data });
  if (text.length <= limit) return text;
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return JSON.stringify({
    event: 'ERROR', cmd, id,
    error:
      `The reply to ${cmd} is ${mb(text.length)} MB, over the ${mb(limit)} MB the MCP link carries, so it was not sent. ` +
      'Mesh geoms in it carry their full vertex and face arrays. Read the scene in parts instead: ' +
      'physics_get_scene_summary (sizes, bounding boxes, watertightness), physics_get_objects or physics_get_object ' +
      '(everything but the mesh arrays), physics_get_object with geom, offset and limit for one geom\'s triangles a page ' +
      'at a time, and physics_measure for distances and angles on the geometry itself.',
  });
}
