// ---------------------------------------------------------------------------
// A scene, shared as a link
//
// Mesh has no server of its own for scenes — the app runs in the tab — so a
// share link cannot be a short id pointing at a row somewhere. The scene
// travels inside the link.
//
// In the *fragment*, not the query string. A fragment is never sent to the
// server, so it cannot hit nginx's request-line limit and it never appears in
// an access log; browsers allow far more room there than any server would.
// Base64url'd because `+` comes back out of `URLSearchParams` as a space, and
// gzipped because a scene graph is JSON, which is mostly punctuation and
// repeated key names — the one thing gzip is best at.
//
// The codec is kept apart from the three lines that touch the address bar so
// that it can be tested: the tests in this project run in plain node,
// deliberately, and a function reaching for `window.location` cannot run there.
//
// The size ceiling is not a detail here, it is the shape of the feature. A
// primitive or CSG scene is a few kilobytes of numbers and shares fine. A
// sculpt, a lattice or an imported STL carries its vertices and faces inline
// (`SceneGeom.vertices`), which is megabytes, and no amount of compression
// puts that in a URL. So the refusal names what is big rather than saying no.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import type { UserPreset } from './userPresets';
import { createShare, fetchSharedDocument, getStoredUser } from './apiClient';

/** The only share format understood so far. */
const SHARE_VERSION = '1';

/**
 * Past this the link is long enough that it is worth saying so.
 *
 * Nothing breaks at this length; it is where chat apps and link previewers
 * start rewriting a URL, and a rewritten link is a link with no fragment,
 * which is a link to an empty scene.
 */
export const SHARE_SOFT_LIMIT = 16 * 1024;

/**
 * Past this the link does not work, so it is not offered.
 *
 * Chromium will carry a couple of megabytes in an address bar and Firefox
 * more, but WebKit gives up around 80KB and does it silently — the link simply
 * opens an empty scene, which reads as "sharing is broken" rather than "that
 * scene is too big to put in a URL". 64KB keeps a margin under the lowest
 * ceiling.
 */
export const SHARE_HARD_LIMIT = 64 * 1024;

/** What travels: the scene and the notes written on it. */
export interface SharedScene {
  name: string;
  nodes: SceneNode[];
  noteCards?: UserPreset['noteCards'];
}

export interface ShareLink {
  url: string;
  /**
   * Set when the scene was left with the account rather than put in the link.
   *
   * It is what "stop sharing" needs, and it is how the panel knows there is
   * something to stop: a link with the scene inside it cannot be recalled, and
   * offering to turn one off would be a lie.
   */
  token?: string;
  /** Length of the whole URL in characters — what the limits above are about. */
  length: number;
  /**
   * Short enough to hand to the operating system's share sheet.
   *
   * The share sheet is the one route where the link leaves without anyone
   * seeing it, so a link a chat app would shorten is offered only as text to
   * copy, where the warning beside it is actually read.
   */
  travelsWell: boolean;
  notes: string[];
}

/** Thrown when the scene cannot be put in a URL at all. */
export class ShareTooLargeError extends Error {
  readonly length: number;
  /** The nodes that account for it, largest first — what to say to the user. */
  readonly heaviest: string[];

  constructor(length: number, heaviest: string[]) {
    super(
      `This scene needs ${Math.round(length / 1024)}KB of link and browsers stop reading at about ` +
        `${SHARE_HARD_LIMIT / 1024}KB. ` +
        (heaviest.length
          ? `${heaviest.join(', ')} ${heaviest.length === 1 ? 'carries' : 'carry'} the vertices and ` +
            `faces of a mesh, which is what makes a scene too big for a URL. `
          : '') +
        `Save the scene, or export STL, and send that instead.`
    );
    this.name = 'ShareTooLargeError';
    this.length = length;
    this.heaviest = heaviest;
  }
}

/**
 * The nodes whose geometry is stored vertex by vertex.
 *
 * Named in the refusal so it points at the sculpt or the imported STL rather
 * than at the scene in general — the difference between "make this smaller
 * somehow" and "that mesh is the problem".
 */
function meshHeavyNodes(nodes: SceneNode[]): string[] {
  const weights: Array<{ name: string; bytes: number }> = [];
  const walk = (list: SceneNode[]) => {
    for (const node of list) {
      let bytes = 0;
      for (const geom of node.geoms ?? []) {
        bytes += (geom.vertices?.length ?? 0) + (geom.faces?.length ?? 0);
      }
      if (bytes > 0) weights.push({ name: node.name || 'an unnamed body', bytes });
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return weights
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((w) => w.name);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a large array into an argument list overflows the stack,
  // and every scene worth sharing is large by that standard.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The writer's own promises are swallowed deliberately. A truncated payload —
// which is what a chat app that shortened a link hands back — fails at both
// ends of the stream at once, and the write side rejecting with nobody waiting
// on it is an unhandled rejection on top of the error the reader already
// reports. The reader is the one that answers.
const ignore = () => {};

async function gzip(text: string): Promise<Uint8Array | null> {
  // Everywhere current, but a browser without it should produce a bigger link
  // rather than no link at all.
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(text)).catch(ignore);
  writer.close().catch(ignore);

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read a compressed link.');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes as unknown as BufferSource).catch(ignore);
  writer.close().catch(ignore);

  const reader = ds.readable.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** The fragment a scene travels in, without the URL around it. */
export async function encodeShareFragment(scene: SharedScene): Promise<string> {
  const json = JSON.stringify(scene);
  const packed = await gzip(json);
  return new URLSearchParams({
    v: SHARE_VERSION,
    gz: packed ? '1' : '0',
    scene: toBase64Url(packed ?? new TextEncoder().encode(json)),
  }).toString();
}

export async function decodeShareFragment(raw: string): Promise<SharedScene | null> {
  const body = raw.replace(/^#/, '');
  if (!body || !body.includes('scene=')) return null;

  const params = new URLSearchParams(body);
  const data = params.get('scene');
  if (!data) return null;

  if (params.get('v') !== SHARE_VERSION) {
    throw new Error('That link was made by a newer version of Mesh.');
  }

  // A truncated link — which is exactly what a chat app that shortened it
  // hands back — fails somewhere in here with a message about zlib buffers or
  // JSON position 4711. Neither is an answer to "why did my link not work".
  let scene: SharedScene;
  try {
    const bytes = fromBase64Url(data);
    const json = params.get('gz') === '1' ? await gunzip(bytes) : new TextDecoder().decode(bytes);
    scene = JSON.parse(json) as SharedScene;
  } catch {
    throw new Error('That link is damaged — it may have been shortened or cut off in transit.');
  }
  // A scene with no nodes is a half-written or truncated payload rather than an
  // empty scene: recompiling one throws inside the MJCF builder, which is the
  // same reason the preset loader refuses one.
  if (!scene || !Array.isArray(scene.nodes) || scene.nodes.length === 0) {
    throw new Error('That link is damaged — it may have been shortened or cut off in transit.');
  }
  return scene;
}

/**
 * Builds a link that opens this scene in a fresh tab of this app.
 *
 * `base` defaults to where the app is running, with any query and fragment
 * dropped: a share link should not carry the sender's leftover query, and it
 * certainly should not carry the fragment it was itself opened from.
 */
export async function buildShareLink(
  scene: SharedScene,
  base: string = window.location.href
): Promise<ShareLink> {
  const url = new URL(base);
  url.search = '';
  url.hash = '';

  const full = `${url.toString()}#${await encodeShareFragment(scene)}`;
  if (full.length > SHARE_HARD_LIMIT) {
    throw new ShareTooLargeError(full.length, meshHeavyNodes(scene.nodes));
  }

  const notes: string[] = [];
  if (full.length > SHARE_SOFT_LIMIT) {
    notes.push(
      `The link is ${Math.round(full.length / 1024)}KB long. Some chat apps shorten a link that ` +
        `long, and a shortened link loses the part of it the scene is in — paste it somewhere that ` +
        `keeps it whole, or save the scene and send that.`
    );
  }
  notes.push(
    'The scene travels inside the link — nothing is uploaded, and there is nothing to expire.'
  );
  if (scene.noteCards?.length) {
    notes.push(
      `The ${scene.noteCards.length} note card${scene.noteCards.length === 1 ? '' : 's'} on the ` +
        'scene travel with it. The copilot conversation does not.'
    );
  }

  return { url: full, length: full.length, travelsWell: full.length <= SHARE_SOFT_LIMIT, notes };
}

// ---------------------------------------------------------------------------
// The other kind of link: a token, with the scene left in the account
//
// Everything above puts the scene in the URL, which needs no server and no
// account and is right for anything that fits. A sculpt does not fit and never
// will. So the scene is left with the account and the link carries a token.
//
// In the *query string*, not the fragment, which is the opposite of the choice
// made above and for the reason this path exists at all: a link that a chat app
// rewrites is exactly what the fragment could not survive, and a rewrite keeps
// the query and drops the fragment. The cost is that the token appears in an
// access log, which is why it is 128 bits of randomness and why it can be
// revoked.
//
// What is stored is a snapshot and the server will not let it be edited
// afterwards. Somebody who vouches for a link is vouching for what they sent,
// and a link whose contents could change under them would make that worthless.
// Changing the scene means making a new link.
// ---------------------------------------------------------------------------

/**
 * The query parameter a token-shared document arrives in.
 *
 * The same name in every Physbox app, rather than one word per app. A token is
 * opaque and says nothing about where it belongs, so the app that receives one
 * asks the server what it is and sends you to the right app if it is not this
 * one — which only works if all three look in the same place for it.
 */
const SHARE_TOKEN_PARAM = 'share';

/** What to call a sibling app when a link turns out to belong to it. */
const APP_NAMES: Record<string, string> = { etch: 'Etch', volt: 'Volt', mesh: 'Mesh' };

/** Whether there is an account to leave a scene with at all. */
export function canShareViaAccount(): boolean {
  return Boolean(getStoredUser());
}

/**
 * Leaves the scene with the account and returns the short link for it.
 *
 * No size ceiling of our own here: the server holds the one that matters and
 * says so in its refusal, and a second number kept in the app would be the one
 * that drifted.
 */
export async function buildAccountShareLink(
  scene: SharedScene,
  base: string = window.location.href
): Promise<ShareLink> {
  const { token } = await createShare({ appId: 'mesh', name: scene.name, data: scene });

  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set(SHARE_TOKEN_PARAM, token);
  const full = url.toString();

  return {
    url: full,
    length: full.length,
    travelsWell: true,
    token,
    notes: [
      'The scene is stored with your account and the link points at it, so the link stays short.',
      'What it holds cannot be changed afterwards — edit the scene and share again for a new link.',
      'Anyone with the link can open it, with or without an account. You can turn it off at any time.',
      // Said at the moment somebody is deciding to rely on it, rather than
      // buried in terms nobody opens. PhysBox Cloud is early and might not
      // continue; a link is a convenience, not an archive.
      'PhysBox Cloud is early — accounts and links here may be withdrawn at any time. Keep your own copy of anything that matters.',
    ],
  };
}

/** The token in the address bar, if this page was opened from an account link. */
export function shareTokenInUrl(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get(SHARE_TOKEN_PARAM);
}

/**
 * Fetches the scene a token stands for.
 *
 * The shape is checked on arrival for the same reason the fragment decoder
 * checks it: a scene with no nodes throws inside the MJCF builder, and an
 * answer from a newer version of this app is not necessarily one this build
 * can open.
 */
export async function readAccountShareLink(token: string): Promise<SharedScene> {
  const share = await fetchSharedDocument(token);
  /*
   * A token carries no hint of which app made it, so a Mesh link pasted into
   * Etch would otherwise be answered with "that link is damaged" — which sends
   * somebody looking for a fault in a link that is perfectly good.
   */
  if (share.appId && share.appId !== 'mesh') {
    throw new Error(
      `That link is a ${APP_NAMES[share.appId] ?? share.appId} document, not a Mesh scene. Open it in ${APP_NAMES[share.appId] ?? share.appId}.`
    );
  }
  const scene = share.data as SharedScene | null;
  if (!scene || !Array.isArray(scene.nodes) || scene.nodes.length === 0) {
    throw new Error('That shared scene could not be read — it may have been made by a newer version of Mesh.');
  }
  return { ...scene, name: scene.name || share.name || 'Shared scene' };
}

/** Takes an opened token back out of the address bar. See `clearShareFragment`. */
export function clearShareToken(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(SHARE_TOKEN_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Reads a shared scene out of the address bar. */
export function readShareLink(): Promise<SharedScene | null> {
  return decodeShareFragment(window.location.hash);
}

/**
 * Takes an opened scene back out of the address bar.
 *
 * `replaceState` rather than assigning to `location.hash`, which would push a
 * history entry and add a navigation. Leaving it there would re-open the link
 * over whatever had been built since, on the next reload.
 */
export function clearShareFragment(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
