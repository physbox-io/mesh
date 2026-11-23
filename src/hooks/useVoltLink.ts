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
//
// When this page goes (closed, reloaded, navigated) it tells Volt UNLINK, so
// Volt stops showing "Mesh linked" at once instead of finding out on its next
// step. Volt also watches for the window closing; this covers a reload, which
// leaves the window open.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { getPhysicsWorkerClient, useStore } from '../store/useStore';
import { useCavityStore } from '../store/cavityStore';
import {
  cavityChannels,
  envelope,
  isCoSimMessage,
  readCavityOutputs,
  validateStepForPayload,
  voltOrigins,
  type CoSimBody,
} from '../utils/coSimLink';

/** The whole catalogue: the model's channels, and every measured cavity's. */
async function catalogue() {
  const { channels, timestepMs } = await getPhysicsWorkerClient().getChannels();
  return { channels: [...channels, ...cavityChannels(useCavityStore.getState().measured)], timestepMs };
}

export function useVoltLink() {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.opener) return;
    const allowed = voltOrigins();
    let disposed = false;

    const sendCatalogueIfStillLinked = async (origin: string) => {
      const { channels, timestepMs } = await catalogue();
      if (disposed || useStore.getState().voltLink?.origin !== origin) return;
      window.opener?.postMessage(
        envelope({ type: 'CATALOGUE', channels, timestepMs, scene: document.title }),
        origin,
      );
    };

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
          try {
            await sendCatalogueIfStillLinked(evt.origin);
          } catch (e) {
            if (!disposed && useStore.getState().voltLink?.origin === evt.origin) {
              useStore.setState({ voltLink: null });
              reply({ type: 'ERROR', message: String((e as Error)?.message || e) });
            }
          }
          return;
        }
        case 'STEP_FOR': {
          const parsed = validateStepForPayload(msg as unknown as Record<string, unknown>);
          if (!parsed.ok) {
            reply({ type: 'ERROR', ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}), message: parsed.error });
            return;
          }
          if (!state.voltLink) {
            reply({ type: 'ERROR', seq: parsed.seq, message: 'Mesh is not linked. Link again from Volt.' });
            return;
          }
          try {
            const measured = readCavityOutputs(useCavityStore.getState().measured, parsed.outputs);
            const r = await getPhysicsWorkerClient().stepFor(parsed.dtMs, parsed.inputs, measured.rest);
            if (disposed) return;
            reply(r.ok
              ? { type: 'STEPPED', seq: parsed.seq, t: r.t, steps: r.steps, outputs: { ...r.outputs, ...measured.outputs }, unknown: r.unknown }
              : { type: 'ERROR', seq: parsed.seq, message: r.error });
          } catch (e) {
            if (disposed) return;
            reply({ type: 'ERROR', seq: parsed.seq, message: String((e as Error)?.message || e) });
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
    const unsubscribeCavity = useCavityStore.subscribe((s, prev) => {
      const link = useStore.getState().voltLink;
      if (!link || s.measured === prev.measured) return;
      void sendCatalogueIfStillLinked(link.origin).catch(() => {});
    });

    // A scene edit/recompile while linked: re-emit the updated channel catalogue.
    const unsubscribeStore = useStore.subscribe((s, prev) => {
      if (!s.voltLink || !s.isLoaded || s.recompileId === prev.recompileId) return;
      void sendCatalogueIfStillLinked(s.voltLink.origin).catch(() => {});
    });

    const onPageHide = () => {
      const link = useStore.getState().voltLink;
      if (!link) return;
      try { window.opener?.postMessage(envelope({ type: 'UNLINK' }), link.origin); } catch { /* Volt gone too */ }
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onPageHide);
      unsubscribeCavity();
      unsubscribeStore();
    };
  }, []);
}
