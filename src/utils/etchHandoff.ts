// ---------------------------------------------------------------------------
// Handing a cut over to Etch
//
// Etch is the 2D end of the same bench: it takes vector artwork, assigns it to
// layers carrying feeds and powers, plans a toolpath and streams it to the
// machine. A panel cut computed here is exactly the sort of artwork it wants,
// and until now the only way across was to save an SVG and open it by hand.
//
// It travels in the URL fragment because the two apps are different origins
// with no shared storage — the same route Volt already uses to hand over a PCB
// paste stencil, and the format Etch's `svgHandoff.ts` reads. The fragment
// rather than the query string: a fragment is never sent to the server, so it
// cannot hit a request-line limit and never lands in an access log.
// ---------------------------------------------------------------------------

import { gzip, toBase64Url } from './shareLink';

/** The only format Etch understands. Bump only with the reader. */
const HANDOFF_VERSION = '1';

/**
 * Where Etch lives.
 *
 * Derived from where Mesh is running rather than configured: the two are
 * developed side by side on neighbouring ports and deployed to neighbouring
 * subdomains, so a hard-coded production URL would send every dev handoff to
 * the live site — and quietly, since it would work.
 */
export function etchBaseUrl(location: { hostname: string; protocol: string } = window.location): string {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local ? `${location.protocol}//${location.hostname}:5176/` : 'https://etch.physbox.io/';
}

/**
 * Past this, the link is more likely to be truncated than opened.
 *
 * Fragments are not subject to the server limits a query string is, but they
 * still travel through whatever the operator pastes them into. A panel cut is
 * outlines — a whole flask is a few kilobytes — so anything approaching this is
 * a sign something has gone wrong rather than a large job.
 */
export const HANDOFF_SOFT_LIMIT = 512 * 1024;

export class HandoffTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(
      `This cut encodes to ${Math.round(bytes / 1024)} KB, which is too much to carry in a link. ` +
        `Save the SVG and open it in Etch instead.`
    );
    this.name = 'HandoffTooLargeError';
    this.bytes = bytes;
  }
}

export interface EtchHandoff {
  svg: string;
  /** What to call the document at the far end. */
  name?: string;
  /** Stock thickness in mm, so Etch derives feeds for the right material. */
  thicknessMm?: number;
}

/**
 * Builds the URL that opens this cut in Etch.
 *
 * Thickness travels because Etch derives every feed, power and depth from the
 * material and how thick it is; artwork arriving without it is planned against
 * whatever the last document happened to be set to. The material *name* does
 * not, because Mesh's list and Etch's catalogue are not the same set, and an id
 * Etch does not recognise is discarded there with a note — noise in place of
 * information.
 */
export async function buildEtchHandoffUrl(
  handoff: EtchHandoff,
  baseUrl: string = etchBaseUrl()
): Promise<string> {
  const packed = await gzip(handoff.svg);
  const bytes = packed ?? new TextEncoder().encode(handoff.svg);

  const params = new URLSearchParams({
    v: HANDOFF_VERSION,
    gz: packed ? '1' : '0',
    data: toBase64Url(bytes),
  });
  if (handoff.name) params.set('name', handoff.name);
  if (handoff.thicknessMm && handoff.thicknessMm > 0) {
    params.set('thickness', String(handoff.thicknessMm));
  }

  const fragment = params.toString();
  if (fragment.length > HANDOFF_SOFT_LIMIT) throw new HandoffTooLargeError(fragment.length);
  return `${baseUrl}#${fragment}`;
}
