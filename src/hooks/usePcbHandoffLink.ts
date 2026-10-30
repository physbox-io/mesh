import { useEffect } from 'react';
import { usePanels } from '../store/panelsStore';
import { clearShareFragment } from '../utils/shareLink';

/**
 * The PCB handoff in an address-bar fragment, if there is one.
 *
 * Volt's "Send to Mesh" opens this app on `#v=1&pcb=<base64url>&name=...`
 * (see decodePcbHandoff). Returned whole, because the importer's handoff
 * field takes the fragment as it is.
 */
export function pcbHandoffFromHash(hash: string): string | null {
  const body = hash.replace(/^#/, '');
  if (!body) return null;
  return new URLSearchParams(body).get('pcb') ? `#${body}` : null;
}

/**
 * Opens the PCB importer on a board sent from Volt, once, on load, and takes
 * the fragment back out of the address bar so a reload does not open it again.
 * Decoding is left to the importer, which shows what is wrong with a bad one.
 */
export function usePcbHandoffLink(): void {
  useEffect(() => {
    const handoff = pcbHandoffFromHash(window.location.hash);
    if (!handoff) return;
    clearShareFragment();
    usePanels.getState().openPcbHandoff(handoff);
  }, []);
}
