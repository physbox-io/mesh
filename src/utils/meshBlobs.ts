// Big meshes kept in the account's blob store instead of inside the document.
//
// meshPacking.ts makes a mesh array a few megabytes of base64. Inline, three of
// them still nearly filled a cloud document, and every autosave re-sent them all.
// So before a document goes to the account, each packed array over BLOB_ABOVE is
// replaced by its SHA-256 — `{ $packed, n, $blob, size }` — and its bytes go
// straight to the bucket through a URL the API signs (physbox_api routes/blobs.ts).
// A mesh already there is not sent again. Coming back, the API hands out read
// URLs with the document and `resolveMeshBlobs` puts the bytes back in, from this
// browser's IndexedDB copy when it has one.
//
// Only the account's copies go through here. localStorage presets and Export JSON
// stay self-contained.

import { requestBlobUploads } from './apiClient';
import { fromBase64, toBase64, type PackedArray } from './meshPacking';

/** A packed array this long (base64 characters, ~190 kB of mesh) or longer goes to the blob store. */
const BLOB_ABOVE = 256 * 1024;

/** A packed array whose bytes are in the blob store. */
export interface BlobRef {
  $packed: PackedArray['$packed'];
  n: number;
  $blob: string;
  /** Bytes. */
  size: number;
}

function isBig(v: unknown): v is PackedArray {
  return typeof v === 'object' && v !== null && typeof (v as PackedArray).$packed === 'string'
    && typeof (v as PackedArray).b64 === 'string' && (v as PackedArray).b64.length >= BLOB_ABOVE;
}

function isRef(v: unknown): v is BlobRef {
  return typeof v === 'object' && v !== null && typeof (v as BlobRef).$blob === 'string';
}

/** Copy-on-write walk replacing what `test` picks with what `swap` returns for it. */
function replaceAll(value: unknown, test: (v: unknown) => boolean, swap: (v: unknown) => unknown): unknown {
  if (test(value)) return swap(value);
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] === 'number') return value;
    let out: unknown[] | null = null;
    value.forEach((x, i) => {
      const next = replaceAll(x, test, swap);
      if (next !== x) (out ??= value.slice())[i] = next;
    });
    return out ?? value;
  }
  if (typeof value !== 'object' || value === null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(value)) {
    const next = replaceAll(x, test, swap);
    if (next !== x) (out ??= { ...(value as Record<string, unknown>) })[k] = next;
  }
  return out ?? value;
}

function collect<T>(value: unknown, test: (v: unknown) => v is T): T[] {
  const found: T[] = [];
  replaceAll(value, test, (v) => {
    found.push(v as T);
    return v;
  });
  return found;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How many characters of the document go to the blob store rather than in it,
 * so the size gate can measure what is actually sent.
 */
export function externalizableChars(doc: unknown): number {
  return collect(doc, isBig).reduce((n, p) => n + p.b64.length, 0);
}

/** Blobs this session has uploaded; asking about them again would be a wasted round trip. */
const uploaded = new Set<string>();

/** After the server said a blob is missing: ask about everything again next time. */
export function forgetUploadedBlobs(): void {
  uploaded.clear();
}

/** Uploads at once, so one large mesh does not hold up the rest. */
const PARALLEL_UPLOADS = 3;

/**
 * The document with its big meshes moved to the blob store, uploading the ones
 * the account does not have. Throws when the store cannot be reached; callers
 * then send the document as it was.
 */
export async function externalizeMeshes<T>(doc: T): Promise<T> {
  const big = collect(doc, isBig);
  if (big.length === 0) return doc;

  const parts = new Map<PackedArray, { sha: string; bytes: Uint8Array }>();
  for (const p of big) {
    const bytes = fromBase64(p.b64);
    parts.set(p, { sha: await sha256Hex(bytes), bytes });
  }

  const unsent = new Map<string, Uint8Array>();
  for (const { sha, bytes } of parts.values()) if (!uploaded.has(sha)) unsent.set(sha, bytes);
  if (unsent.size > 0) {
    const { uploads } = await requestBlobUploads([...unsent].map(([sha256, b]) => ({ sha256, size: b.length })));
    const queue = [...uploads];
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const bytes = unsent.get(u.sha256)!;
        const res = await fetch(u.url, { method: 'PUT', headers: u.headers, body: bytes as unknown as BodyInit });
        if (!res.ok) throw new Error(`Uploading a mesh failed (${res.status}).`);
        void cachePut(u.sha256, bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, worker));
    for (const sha of unsent.keys()) uploaded.add(sha);
  }

  return replaceAll(doc, (v) => isBig(v) && parts.has(v as PackedArray), (v) => {
    const p = v as PackedArray;
    const { sha, bytes } = parts.get(p)!;
    const ref: BlobRef = { $packed: p.$packed, n: p.n, $blob: sha, size: bytes.length };
    return ref;
  }) as T;
}

/**
 * The document with every blob reference turned back into an inline packed
 * array, ready for `unpackMeshArrays`. Fetches through the read URLs the API
 * sent with the document, or reads this browser's copy.
 */
export async function resolveMeshBlobs<T>(doc: T, urls: Record<string, string> | undefined): Promise<T> {
  const refs = collect(doc, isRef);
  if (refs.length === 0) return doc;
  const bytesFor = new Map<string, Uint8Array>();
  await Promise.all(
    [...new Set(refs.map((r) => r.$blob))].map(async (sha) => {
      let bytes = await cacheGet(sha);
      if (!bytes) {
        const url = urls?.[sha];
        if (!url) return;
        const res = await fetch(url);
        if (!res.ok) return;
        const got = new Uint8Array(await res.arrayBuffer());
        if ((await sha256Hex(got)) !== sha) return;
        bytes = got;
        void cachePut(sha, bytes);
      }
      bytesFor.set(sha, bytes);
    })
  );
  // A ref with no bytes is left as it is; unpacking it says so in words.
  return replaceAll(doc, (v) => isRef(v) && bytesFor.has((v as BlobRef).$blob), (v) => {
    const r = v as BlobRef;
    const packed: PackedArray = { $packed: r.$packed, n: r.n, b64: toBase64(bytesFor.get(r.$blob)!) };
    return packed;
  }) as T;
}

// This browser's copy of each blob, by hash. Content-addressed, so an entry is
// never stale; it saves downloading a scene's meshes every time it is opened.
// Everything is best-effort: no IndexedDB just means fetching.

const DB_NAME = 'physbox-mesh-blobs';
const STORE = 'blobs';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function cacheGet(sha: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(sha);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(sha: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes, sha);
  } catch {
    // Full or unavailable: the next open fetches it instead.
  }
}
