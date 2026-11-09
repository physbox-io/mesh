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

import type { MaterialId } from './feedsAndSpeeds';
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

/** The window name every send to Etch targets, so a re-send lands in the same tab. */
export const ETCH_TAB_NAME = 'physbox-etch';

/**
 * Opens a handoff URL in Etch, reusing the Etch tab an earlier send opened.
 *
 * A named target rather than '_blank': the second send navigates the first
 * tab, and because only the fragment differs Etch takes it without a reload
 * (it listens for `hashchange`). The opener is kept on purpose — the browser
 * only lets this window find the tab again by name while it is the tab's
 * opener, and the other end is our own app. A tab of Etch the person opened
 * themselves cannot be reached this way; the first send opens one alongside it.
 *
 * Takes the URL as a promise-maker and opens the tab *before* building it: a
 * build gzips, and often lays the parts out first, and a window opened after an
 * await is no longer plainly the click's. Chrome lets that slide for a few
 * seconds, Safari and Firefox do not, so a slow layout or another browser
 * refused the first send. An empty URL leaves an existing Etch tab where it is
 * until the new one is ready (as Volt does); a fresh tab says what it is
 * waiting for, and is closed again if the build fails.
 */
export async function openInEtch(buildUrl: () => Promise<string>): Promise<void> {
  const tab = window.open('', ETCH_TAB_NAME);
  if (!tab) throw new Error('The browser blocked the Etch tab: allow pop-ups for this site, then try again.');
  // A tab opened just now is a blank page of this origin, so readable; an
  // Etch tab from an earlier send is cross-origin and throws.
  let fresh = false;
  try {
    fresh = tab.location.href === 'about:blank';
  } catch {
    /* Etch's own tab */
  }
  if (fresh) {
    try {
      tab.document.title = 'Etch';
      tab.document.body.style.cssText =
        'margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
        'font:14px system-ui,sans-serif;color:#64748b;background:#0f172a';
      tab.document.body.textContent = 'Opening in Etch…';
    } catch {
      /* cosmetic only */
    }
  }
  try {
    tab.location.href = await buildUrl();
    tab.focus();
  } catch (e) {
    if (fresh) tab.close();
    throw e;
  }
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
  /** What the bench is set to, by the id Mesh and Etch share. */
  material?: MaterialId;
}

/**
 * Builds the URL that opens this cut in Etch.
 *
 * Material and thickness travel because Etch derives every feed, power and depth
 * from them; artwork arriving without them is planned against whatever the last
 * design happened to be set to.
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
  if (handoff.material) params.set('material', handoff.material);

  const fragment = params.toString();
  if (fragment.length > HANDOFF_SOFT_LIMIT) throw new HandoffTooLargeError(fragment.length);
  return `${baseUrl}#${fragment}`;
}
