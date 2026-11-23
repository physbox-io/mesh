/**
 * Mesh's cloud autosave: the shared engine (`@physbox-io/ui/cloud`), given
 * Mesh's API client, the storage keys this browser has always used for it, and
 * the blob store that keeps big meshes out of the document.
 *
 * The engine — debouncing, conflicts, the size gate, the unsaved-work offer,
 * never writing a document nobody touched — lives in the ui package, because
 * Etch, Volt and Mesh each had a copy and fixes had to be made three times.
 */

import { createCloudAutosave } from '@physbox-io/ui/cloud';
import {
  isProAccount,
  isProRequired,
  getStoredAuthToken,
  putCloudDocument,
  fetchCloudDocument,
  deleteCloudDocument,
} from './apiClient';
import { externalizableChars, externalizeMeshes, forgetUploadedBlobs, resolveMeshBlobs } from './meshBlobs';
import { unpackMeshArrays } from './meshPacking';

export type { AutosaveState, AutosaveStatus, CloudDraft } from '@physbox-io/ui/cloud';

// Track unload so flushOnUnload's PUT uses `keepalive` for small documents.
let unloading = false;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    unloading = true;
    setTimeout(() => { unloading = false; }, 0);
  });
  window.addEventListener('pageshow', () => { unloading = false; });
}

// Track document IDs whose remote revision has already been primed in this session.
const primedDocIds = new Set<string>();
let skipPrimeForNewExplicitDoc = false;

const trackedFetchCloudDocument: typeof fetchCloudDocument = async (id) => {
  const doc = await fetchCloudDocument(id);
  primedDocIds.add(id);
  return doc;
};

const guardedPutCloudDocument: typeof putCloudDocument = async (input) => {
  let baseRevision = input.baseRevision;
  if (
    baseRevision === undefined &&
    input.label !== undefined &&
    !skipPrimeForNewExplicitDoc &&
    !primedDocIds.has(input.id)
  ) {
    try {
      const remote = await fetchCloudDocument(input.id);
      primedDocIds.add(input.id);
      if (typeof remote.revision === 'number') {
        baseRevision = remote.revision;
      }
    } catch (err) {
      // A 404 confirms the document doesn't exist remotely yet; anything else
      // (network/5xx) leaves it unprimed so a retry still checks.
      if (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404) {
        primedDocIds.add(input.id);
      }
    }
  }
  const res = await putCloudDocument({
    ...input,
    baseRevision,
    ...(unloading ? { keepalive: true } : {}),
  });
  primedDocIds.add(input.id);
  return res;
};

export const cloudAutosave = createCloudAutosave({
  appId: 'physics',
  storagePrefix: 'physics',
  api: {
    isProAccount,
    isProRequired,
    getStoredAuthToken,
    putCloudDocument: guardedPutCloudDocument,
    fetchCloudDocument: trackedFetchCloudDocument,
    deleteCloudDocument,
  },
  // Big meshes go to the blob store and are named by hash (meshBlobs.ts), so
  // the size gate measures the document without them.
  externalizableChars,
  toCloud: externalizeMeshes,
  fromCloud: async (doc) => unpackMeshArrays(await resolveMeshBlobs(doc.data, doc.blobUrls)),
  recoverable: (err) => {
    if (err.code !== 'blobs_missing') return false;
    // A mesh this session took for uploaded is not there: ask about every one
    // afresh on the retry.
    forgetUploadedBlobs();
    return true;
  },
});

// Ensure first explicit save (`Ctrl+S`) on an existing stored document primes the
// remote revision before writing so it never omits `base_revision` and overwrites
// another device's newer revision.
const rawSaveExplicit = cloudAutosave.saveExplicit.bind(cloudAutosave);
cloudAutosave.saveExplicit = async (name: string, data: unknown, label: string): Promise<void> => {
  const status = cloudAutosave.getStatus();
  const hasStoredDoc = Boolean(status.documentId);
  skipPrimeForNewExplicitDoc = !hasStoredDoc;
  try {
    return await rawSaveExplicit(name, data, label);
  } finally {
    skipPrimeForNewExplicitDoc = false;
  }
};
