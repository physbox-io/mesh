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

export const cloudAutosave = createCloudAutosave({
  appId: 'physics',
  storagePrefix: 'physics',
  api: { isProAccount, isProRequired, getStoredAuthToken, putCloudDocument, fetchCloudDocument, deleteCloudDocument },
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
