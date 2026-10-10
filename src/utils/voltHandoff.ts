// ---------------------------------------------------------------------------
// Handing a measured cavity over to Volt
//
// A speaker in Volt models its box from the box's volume and its port, and
// those are exactly what "Measure cavity" finds. Linked, they travel as output
// channels (see cavityChannels in coSimLink.ts). Unlinked, they go the way a
// cut goes to Etch: in the URL fragment of a Volt tab, since the two apps are
// different origins with no shared storage, and a fragment never reaches a
// server. Volt's src/utils/meshCavity.ts reads it; bump the version with it.
// ---------------------------------------------------------------------------

import type { MeasuredCavity } from './coSimLink';

const HANDOFF_VERSION = '1';

/**
 * Where Volt lives: beside Mesh on 5174 in development, else the deployed
 * app. Derived from where Mesh is running, as etchBaseUrl is, so a dev
 * handoff never lands on the live site.
 */
export function voltBaseUrl(location: { hostname: string; protocol: string } = window.location): string {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local ? `${location.protocol}//${location.hostname}:5174/` : 'https://volt.physbox.io/';
}

/** The Volt URL that offers this cavity to a speaker. Volume in m³, port in m. */
export function buildVoltCavityUrl(body: string, cavity: MeasuredCavity, scene?: string, baseUrl: string = voltBaseUrl()): string {
  const params = new URLSearchParams({ v: HANDOFF_VERSION, cavity: String(cavity.volume), body });
  if (scene) params.set('scene', scene);
  if (cavity.portLength !== undefined && cavity.portRadius !== undefined) {
    params.set('portLength', String(cavity.portLength));
    params.set('portRadius', String(cavity.portRadius));
  }
  return `${baseUrl}#${params.toString()}`;
}
