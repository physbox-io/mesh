import type { PhysicsState } from '../../store/useStore';

/** What a command is handed beside its message. */
export interface McpContext {
  /** The store as the command found it. */
  store: PhysicsState;
  /** A body's name made its id; see toId in the bridge. */
  toId: (v: unknown) => unknown;
}

/** One MCP command: the message in, the reply out. */
export type McpHandler = (msg: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;

export type McpCommands = Record<string, McpHandler>;
