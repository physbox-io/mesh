// ---------------------------------------------------------------------------
// Answering a Volt page that opened this one to drive it
//
// Volt opens Mesh with `window.open` and says HELLO until it is answered. The
// answer is the scene's channel catalogue, and from then on Volt owns the
// clock: each STEP_FOR moves the scene exactly the slice it names, and nothing
// else moves it. Only the window that opened this one, from one of Volt's
// origins, is listened to.
//
// Measured cavities are channels too, but of the scene graph rather than the
// model: they are answered here and never reach the physics worker, and a new
// measurement while linked re-sends the catalogue so Volt can bind it.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { getPhysicsWorkerClient, useStore } from '../store/useStore';
import { useCavityStore } from '../store/cavityStore';
import { cavityChannels, envelope, isCoSimMessage, readCavityOutputs, voltOrigins, type CoSimBody } from '../utils/coSimLink';

/** The whole catalogue: the model's channels, and every measured cavity's. */
async function catalogue() {
  const { channels, timestepMs } = await getPhysicsWorkerClient().getChannels();
  return { channels: [...channels, ...cavityChannels(useCavityStore.getState().measured)], timestepMs };
}

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
          const { channels, timestepMs } = await catalogue();
          reply({ type: 'CATALOGUE', channels, timestepMs, scene: document.title });
          return;
        }
        case 'STEP_FOR': {
          if (!state.voltLink) {
            reply({ type: 'ERROR', seq: msg.seq, message: 'Mesh is not linked. Link again from Volt.' });
            return;
          }
          try {
            const measured = readCavityOutputs(useCavityStore.getState().measured, msg.outputs ?? []);
            const r = await getPhysicsWorkerClient().stepFor(msg.dtMs, msg.inputs, measured.rest);
            reply(r.ok
              ? { type: 'STEPPED', seq: msg.seq, t: r.t, steps: r.steps, outputs: { ...r.outputs, ...measured.outputs }, unknown: r.unknown }
              : { type: 'ERROR', seq: msg.seq, message: r.error });
          } catch (e) {
            reply({ type: 'ERROR', seq: msg.seq, message: String((e as Error)?.message || e) });
          }
          return;
        }
        case 'UNLINK':
          useStore.setState({ voltLink: null });
          // A step that names no inputs takes off the rotor inertia and
          // bearing friction Volt added, without moving anything.
          void getPhysicsWorkerClient().stepFor(0, {}, []).catch(() => {});
          return;
        default:
          return;
      }
    };

    // A cavity measured while linked: tell Volt, so its picker lists it.
    const unsubscribe = useCavityStore.subscribe((s, prev) => {
      const link = useStore.getState().voltLink;
      if (!link || s.measured === prev.measured) return;
      void catalogue().then(({ channels, timestepMs }) => {
        window.opener?.postMessage(envelope({ type: 'CATALOGUE', channels, timestepMs, scene: document.title }), link.origin);
      }).catch(() => {});
    });

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribe();
    };
  }, []);
}
