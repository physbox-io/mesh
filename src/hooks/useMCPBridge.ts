/**
 * MCP bridge for Physics Sim.
 * Uses the Zustand store directly (getState/setState) from outside React.
 */

import { useEffect } from 'react';
import { getStoredAuthToken, hubToken } from '../utils/apiClient';
import { tabSession } from '../utils/tabSession';
import { useStore } from '../store/useStore';
import { createMeshMachineHandlers, setCurrentScene } from '../utils/machineMcp';
import type { SceneNode } from '../types/scene';
import { findNodeInScene } from './mcp/bridgeUtils';
import { encodeError, encodeReply } from './mcp/replySize';
import type { McpCommands } from './mcp/types';
import { sculptCommands } from './mcp/sculptCommands';
import { latticeCommands } from './mcp/latticeCommands';
import { breakageCommands } from './mcp/breakageCommands';
import { castCommands } from './mcp/castCommands';
import { slipCommands } from './mcp/slipCommands';
import { partBuildCommands } from './mcp/partBuildCommands';
import { brickCommands } from './mcp/brickCommands';
import { machiningCommands } from './mcp/machiningCommands';
import { cutCommands } from './mcp/cutCommands';
import { dfmCommands } from './mcp/dfmCommands';
import { sectionCommands } from './mcp/sectionCommands';
import { viewCommands } from './mcp/viewCommands';
import { objectCommands } from './mcp/objectCommands';
import { sceneCommands } from './mcp/sceneCommands';
import { profileCommands } from './mcp/profileCommands';

// Moved into ./mcp, and still imported from here.
export { type LatticeOpSpec, runLatticeOps } from './mcp/latticeState';
export { fillGeomDefaults, resolveUpdatedGeoms, fillBodyDefaults } from './mcp/bodyDefaults';
export {
  applySingleCutToBody, applyRoundEdgesToBody, applySinglePatternToBody, applyPaintStrokeToBody,
} from './mcp/bodyFeatures';

/*
 * Read-only and non-body control commands never modify sceneGraph.nodes: they
 * must never be falsely failed by a concurrent castPrepBlocked increment, nor
 * blocked behind a slow scene mutation.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  return (
    cmd.startsWith('GET_') ||
    cmd.startsWith('LIST_') ||
    cmd.startsWith('CHECK_') ||
    cmd.startsWith('EXPORT_') ||
    cmd === 'SCREENSHOT' ||
    cmd === 'MEASURE' ||
    cmd === 'SECTION' ||
    cmd === 'VALIDATE_SCAD' ||
    cmd === 'PROBE_SCULPT' ||
    cmd === 'RUN_HEADLESS'
  );
}

const NON_BODY_CONTROL_COMMANDS = new Set([
  'PLAY', 'STOP', 'TOGGLE_PLAY', 'SET_CAMERA', 'SET_VIEW', 'RESET_CAMERA', 'SET_DISPLAY',
]);

/*
 * Commands that mutate scene bodies (sculpts, lattices, creates, edits, cuts,
 * imports, scene swaps) run one after another in arrival order. Two concurrent
 * mutations otherwise race on sceneGraph snapshots, waitForNewNode, and the
 * global castPrepBlocked guard counter.
 */
export function shouldSerializeCommand(cmd: string): boolean {
  return !isReadOnlyCommand(cmd) && !NON_BODY_CONTROL_COMMANDS.has(cmd);
}

let mutationQueue: Promise<unknown> = Promise.resolve();

/**
 * Guard one command against the Cast-prep edit refusal without letting
 * unrelated read-only commands fail when another edit increments castPrepBlocked.
 */
export async function runGuardedCommand(
  cmd: string,
  run: () => Promise<unknown>,
  isMachineCmd = false,
): Promise<unknown> {
  if (isMachineCmd || !shouldSerializeCommand(cmd)) {
    return run();
  }
  const queued = mutationQueue.then(async () => {
    const blockedBefore = useStore.getState().castPrepBlocked;
    const data = await run();
    if (useStore.getState().castPrepBlocked === blockedBefore) return data;
    useStore.getState().closeCastPrepGuard();
    return {
      ok: false,
      error: 'The scene is prepared for casting with draft baked in, so that edit was not made. '
        + 'Call physics_set_cast_prep with off=true to restore the original shapes, or bake=true to keep the drafted ones, then retry.',
    };
  });
  mutationQueue = queued.catch(() => undefined);
  return queued;
}

/** How often a running command tells the hub it is still at work (the hub gives up after 10 s without word). */
const WORKING_EVERY_MS = 2000;

function tabIdentity(): { sessionId: string; label: string; href: string; startedAt: number } {
  const { id, startedAt } = tabSession();
  const href = typeof location !== 'undefined' ? location.href : '';
  const port = typeof location !== 'undefined' ? location.port : '';
  return { sessionId: id, label: `Mesh :${port} ${id.slice(4)}`, href, startedAt };
}

/** Every command but the machine ones, by name; the modules under ./mcp each add a family. */
const COMMANDS: McpCommands = {
  ...sceneCommands,
  ...profileCommands,
  ...objectCommands,
  ...viewCommands,
  ...machiningCommands,
  ...cutCommands,
  ...dfmCommands,
  ...sectionCommands,
  ...partBuildCommands,
  ...brickCommands,
  ...castCommands,
  ...slipCommands,
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
      const socket = new WebSocket(`ws://localhost:${wsPort}`);
      ws = socket;

      const safeSend = (payload: string) => {
        if (!dead && socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      };

      socket.onopen = () =>
        /*
         * The handshake also offers this tab's API token, if it has one, as a
         * fallback credential for the MCP server's cloud tools: the ones that
         * read the run archive over HTTPS rather than driving this tab.
         *
         * The server treats it as a last resort behind PHYSBOX_API_TOKEN and its
         * config file, because this socket has no origin check, which is also
         * why the session token is never sent. It is localhost only, and the
         * server binds loopback.
         */
        safeSend(JSON.stringify({
          event: 'HELLO',
          app: 'physics',
          port: location.port,
          token: hubToken(getStoredAuthToken()),
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

      socket.onmessage = (evt) => {
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
          safeSend(encodeError(cmd, id, e));
          done();
          return;
        }
        // Still on it: the hub waits as long as these keep coming, so a long
        // command (a scene of cloth loading, an export) is not reported as
        // timed out while it runs, and a tab that has died still is, quickly.
        const working = result instanceof Promise
          ? setInterval(() => safeSend(JSON.stringify({ event: 'WORKING', cmd, id })), WORKING_EVERY_MS)
          : undefined;
        Promise.resolve(result)
          .then(data => safeSend(encodeReply(cmd, id, data)))
          .catch(e  => safeSend(encodeError(cmd, id, e)))
          .finally(() => { clearInterval(working); done(); });
      };

      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (!dead) retryTimer = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
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
    const guardedHandle = (cmd: string, msg: Record<string, unknown>): Promise<unknown> =>
      runGuardedCommand(cmd, () => handle(cmd, msg), Object.hasOwn(machineHandlers, cmd));

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
      // What send_command can say here: every command, the machine ones too.
      if (cmd === 'LIST_COMMANDS') {
        return { ok: true, commands: [...new Set([...Object.keys(COMMANDS), ...Object.keys(machineHandlers), 'LIST_COMMANDS'])].sort() };
      }
      return { error: `Unknown command: ${cmd}. LIST_COMMANDS names every command this app takes.` };
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
