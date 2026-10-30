/**
 * MCP bridge for Physics Sim.
 * Uses the Zustand store directly (getState/setState) from outside React.
 */

import { useEffect } from 'react';
import { getStoredAuthToken } from '../utils/apiClient';
import { tabSession } from '../utils/tabSession';
import { useStore } from '../store/useStore';
import { createMeshMachineHandlers, setCurrentScene } from '../utils/machineMcp';
import type { SceneNode } from '../types/scene';
import { findNodeInScene } from './mcp/bridgeUtils';
import { encodeReply } from './mcp/replySize';
import type { McpCommands } from './mcp/types';
import { sculptCommands } from './mcp/sculptCommands';
import { latticeCommands } from './mcp/latticeCommands';
import { breakageCommands } from './mcp/breakageCommands';
import { castCommands } from './mcp/castCommands';
import { partBuildCommands } from './mcp/partBuildCommands';
import { machiningCommands } from './mcp/machiningCommands';
import { viewCommands } from './mcp/viewCommands';
import { objectCommands } from './mcp/objectCommands';
import { sceneCommands } from './mcp/sceneCommands';

// Moved into ./mcp, and still imported from here.
export { type LatticeOpSpec, runLatticeOps } from './mcp/latticeState';
export { fillGeomDefaults, resolveUpdatedGeoms, fillBodyDefaults } from './mcp/bodyDefaults';
export {
  applySingleCutToBody, applyRoundEdgesToBody, applySinglePatternToBody, applyPaintStrokeToBody,
} from './mcp/bodyFeatures';

/*
 * Commands that change a sculpt's clay run one after another, in the order
 * they arrived. Each reads the mesh, works on it (a cut or a carve in a
 * worker, for a while), and writes it back; two at once read the same mesh,
 * and the second to finish found the body changed under it and was refused
 * ("The body changed while it was being cut"), so an agent sending a face's
 * features together lost half of them. One queue for all bodies, not one per
 * body: a body named one way and id'd another would otherwise get two.
 */
const SERIAL_SCULPT_COMMANDS = new Set(['SCULPT', 'SCULPT_CUT', 'SCULPT_CARVE', 'UNDO_SCULPT', 'RESIZE_SCULPT', 'SET_SCULPT_BASE']);
let sculptQueue: Promise<unknown> = Promise.resolve();

function tabIdentity(): { sessionId: string; label: string; href: string; startedAt: number } {
  const { id, startedAt } = tabSession();
  const href = typeof location !== 'undefined' ? location.href : '';
  const port = typeof location !== 'undefined' ? location.port : '';
  return { sessionId: id, label: `Mesh :${port} ${id.slice(4)}`, href, startedAt };
}

/** Every command but the machine ones, by name; the modules under ./mcp each add a family. */
const COMMANDS: McpCommands = {
  ...sceneCommands,
  ...objectCommands,
  ...viewCommands,
  ...machiningCommands,
  ...partBuildCommands,
  ...castCommands,
  ...breakageCommands,
  ...latticeCommands,
  ...sculptCommands,
};

export function useMCPBridge() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let dead = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (dead) return;
      const params = new URLSearchParams(location.search);
      const wsPort = params.get('mcpPort') || '3142';
      ws = new WebSocket(`ws://localhost:${wsPort}`);

      ws.onopen = () =>
        /*
         * The handshake also offers this tab's session, as a fallback
         * credential for the MCP server's cloud tools — the ones that read the
         * run archive over HTTPS rather than driving this tab. It means an
         * agent can answer a question about last month's job with no setup at
         * all, as long as the app is open.
         *
         * The server treats it as a last resort behind PHYSBOX_API_TOKEN and its
         * config file, because this socket has no origin check. It is localhost
         * only, and the server binds loopback.
         */
        ws!.send(JSON.stringify({
          event: 'HELLO',
          app: 'physics',
          port: location.port,
          token: getStoredAuthToken() ?? undefined,
          // Which TAB this is. Several tabs of the same app all connect to the
          // one hub, and without a name for each the hub could only shout: every
          // command went to all of them and whichever answered first won. That
          // is not a race you can win by retrying — a body created in one tab is
          // invisible to the next command if a different tab answers it, and a
          // preset saved by a stale tab overwrites a good one, because
          // localStorage is shared across tabs of an origin and the last write
          // stands. With an id per tab the hub can address exactly one.
          ...tabIdentity(),
        }));

      ws.onmessage = (evt) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        const cmd = typeof msg.cmd === 'string' ? msg.cmd : undefined;
        const id = msg.id;
        if (!cmd) return;

        useStore.getState().incrementMcpActive();
        // The counter drives the "MCP Active" badge, so this command's
        // increment has to be paid back exactly once no matter which way the
        // handler ends — including the synchronous-throw path below, which
        // would otherwise double-decrement and hide a genuinely running
        // command's badge.
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          useStore.getState().decrementMcpActive();
        };

        let result: unknown;
        try {
          result = guardedHandle(cmd, msg);
        } catch (e) {
          ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) }));
          done();
          return;
        }
        Promise.resolve(result)
          .then(data => ws?.send(encodeReply(cmd, id, data)))
          .catch(e  => ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) })))
          .finally(done);
      };

      ws.onclose = () => { if (!dead) retryTimer = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };

    /*
     * The machine commands, shared with Volt and Etch.
     *
     * Everything that can move an axis goes through the arming gate: a person
     * clicks "Allow Claude to move this machine" in the app, once, and the
     * agent works inside that window. Reading state, trimming a running cut,
     * pausing, cancelling and e-stopping are all ungated — refusing a stop
     * would be worse than having no gate at all.
     */
    const machineHandlers = createMeshMachineHandlers();

    /*
     * With draft baked in by Prepare for Casting, the store turns body edits
     * away (see the guard in useStore). A handler that went on to report
     * success would be telling the agent something that did not happen, so a
     * command during which an edit was refused fails instead, and says how to
     * get past it. The guard's modal is for a person; an agent has its answer,
     * so the modal is closed again.
     */
    const guardedHandle = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      if (SERIAL_SCULPT_COMMANDS.has(cmd)) {
        const run = sculptQueue.then(() => guardedNow(cmd, msg));
        sculptQueue = run.catch(() => undefined);
        return run;
      }
      return guardedNow(cmd, msg);
    };

    const guardedNow = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      const blockedBefore = useStore.getState().castPrepBlocked;
      const data = await handle(cmd, msg);
      if (useStore.getState().castPrepBlocked === blockedBefore) return data;
      useStore.getState().closeCastPrepGuard();
      return {
        ok: false,
        error: 'The scene is prepared for casting with draft baked in, so that edit was not made. '
          + 'Call physics_set_cast_prep with off=true to restore the original shapes, or bake=true to keep the drafted ones, then retry.',
      };
    };

    const handle = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      // Access Zustand store directly — works outside React render
      const store = useStore.getState();

      // The machine handlers outlive any one render, so they are pointed at the
      // scene this call is answering about rather than closing over a stale one.
      setCurrentScene(store.sceneGraph, store.stock);

      const machineHandler = machineHandlers[cmd];
      if (machineHandler) {
        try {
          return await machineHandler((msg ?? {}) as Record<string, unknown>);
        } catch (e) {
          // Returned rather than thrown: a refusal is an answer the agent has to
          // read and act on — arm the machine, use a smaller tool, re-zero — and
          // an exception here would surface as a bridge fault instead.
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      /*
       * A body given by name becomes its id, once, here.
       *
       * Every handler finds bodies by id or name (findNodeInScene), but the store
       * edits, deletes and keys history by id alone. So sculpt, combine, delete
       * and the lattice undo stack given a name found the body, reported ok, and
       * changed nothing - or pushed history under a key undo never read. An
       * exact id wins over a name, so a body named like another's id is safe.
       */
      const toId = (v: unknown): unknown => {
        if (typeof v !== 'string') return v;
        const byId = (nodes: SceneNode[] = []): boolean =>
          nodes.some((n) => n.id === v || byId(n.children));
        if (byId(store.sceneGraph.nodes)) return v;
        return findNodeInScene(store.sceneGraph.nodes, v)?.id ?? v;
      };
      if (msg && typeof msg.targetId === 'string') msg = { ...msg, targetId: toId(msg.targetId) };
      if (msg && Array.isArray(msg.withIds)) msg = { ...msg, withIds: msg.withIds.map(toId) };

      if (Object.hasOwn(COMMANDS, cmd)) return COMMANDS[cmd](msg, { store, toId });
      return { error: `Unknown command: ${cmd}` };
    };

    connect();
    return () => {
      dead = true;
      clearTimeout(retryTimer);
      ws?.close();
      // Nothing can reply for a command once the bridge is gone, so don't leave
      // its badge behind (a dev-time remount would otherwise strand it).
      useStore.getState().resetMcpActive();
    };
  }, []);
}
