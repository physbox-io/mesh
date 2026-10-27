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
  // A run started before the inputs changed is not shown when it lands.
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, inputs);
  /** Runs `go` on a worker of its own; `go` hands back the piece, or an error to show. */
  const run = async (go: (client: MoldWorkerClient) => Promise<{ piece: ChainPiece; extra?: string[] } | { error: string }>) => {
    setBusy(true);
    setError(null);
    setLines(null);
    const started = generation.current;
    const client = new MoldWorkerClient();
    try {
      const out = await go(client);
      if (started !== generation.current) return;
      if ('error' in out) setError(out.error);
      else setLines([...pieceLines(out.piece), ...(out.extra ?? [])]);
    } catch (e) {
      if (started === generation.current) setError((e as Error).message);
    } finally {
      client.dispose();
      setBusy(false);
    }
  };
  return { busy, error, lines, run };
}
