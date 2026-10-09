// ---------------------------------------------------------------------------
// Answering a Volt page that opened this one to drive it
//
// Volt opens Mesh with `window.open` and says HELLO until it is answered. The
// answer is the scene's channel catalogue, and from then on Volt owns the
// clock: each STEP_FOR moves the scene exactly the slice it names, and nothing
// else moves it. Only the window that opened this one, from one of Volt's
// origins, is listened to.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { getPhysicsWorkerClient, useStore } from '../store/useStore';
import { envelope, isCoSimMessage, voltOrigins, type CoSimBody } from '../utils/coSimLink';

export function useVoltLink() {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.opener) return;
    const allowed = voltOrigins();

    const onMessage = async (evt: MessageEvent) => {
      if (evt.source !== window.opener || !allowed.includes(evt.origin) || !isCoSimMessage(evt.data)) return;
      const msg = evt.data;
      const reply = (body: CoSimBody) => window.opener?.postMessage(envelope(body), evt.origin);
      const state = useStore.getState();

      switch (msg.type) {
        case 'HELLO': {
          // Not built yet: stay quiet, and Volt asks again.
          if (!state.isLoaded) return;
          if (state.isPlaying) state.togglePlay();
          useStore.setState({ voltLink: { origin: evt.origin } });
          const { channels, timestepMs } = await getPhysicsWorkerClient().getChannels();
          reply({ type: 'CATALOGUE', channels, timestepMs, scene: document.title });
          return;
        }
        case 'STEP_FOR': {
          if (!state.voltLink) {
            reply({ type: 'ERROR', seq: msg.seq, message: 'Mesh is not linked. Link again from Volt.' });
            return;
          }
          try {
            const r = await getPhysicsWorkerClient().stepFor(msg.dtMs, msg.inputs, msg.outputs);
            reply(r.ok
              ? { type: 'STEPPED', seq: msg.seq, t: r.t, steps: r.steps, outputs: r.outputs, unknown: r.unknown }
              : { type: 'ERROR', seq: msg.seq, message: r.error });
          } catch (e) {
            reply({ type: 'ERROR', seq: msg.seq, message: String((e as Error)?.message || e) });
          }
          return;
        }
        case 'UNLINK':
          useStore.setState({ voltLink: null });
          return;
        default:
          return;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}
