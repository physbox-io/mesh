// Running a Mold tab's one-click chain from a panel. The result it shows is
// ChainRun.tsx's ChainResult.

import { useEffect, useRef, useState } from 'react';
import { MoldWorkerClient } from '../../utils/moldWorkerClient';
import { pieceLines, type ChainPiece } from '../../utils/castChain';

/** `inputs` are what the chain is run from: a result is cleared when any of them changes. */
export function useChainRun(inputs: readonly unknown[]) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  // A run started before the inputs changed or after unmount is aborted and dropped.
  const generation = useRef(0);
  const activeClient = useRef<MoldWorkerClient | null>(null);

  useEffect(() => {
    generation.current++;
    activeClient.current?.dispose();
    activeClient.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(false);
    setLines(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, inputs);

  useEffect(() => {
    const gen = generation;
    const clientRef = activeClient;
    return () => {
      gen.current++;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  /** Runs `go` on a worker of its own; `go` hands back the piece, or an error to show. */
  const run = async (go: (client: MoldWorkerClient) => Promise<{ piece: ChainPiece; extra?: string[] } | { error: string }>) => {
    generation.current++;
    activeClient.current?.dispose();
    const started = generation.current;
    const client = new MoldWorkerClient();
    activeClient.current = client;
    setBusy(true);
    setError(null);
    setLines(null);
    try {
      const out = await go(client);
      if (started !== generation.current) return;
      if ('error' in out) setError(out.error);
      else setLines([...pieceLines(out.piece), ...(out.extra ?? [])]);
    } catch (e) {
      if (started === generation.current) setError((e as Error).message);
    } finally {
      if (activeClient.current === client) activeClient.current = null;
      client.dispose();
      if (started === generation.current) setBusy(false);
    }
  };
  return { busy, error, lines, run };
}
