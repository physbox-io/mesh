/**
 * Keeping a running job recoverable across a reload, a sleep, or the power
 * going off.
 *
 * The store itself is `createJobCheckpoint` in `@physbox-io/machining`, shared
 * with Etch and Volt; the design notes live there. What is here is Mesh's
 * instance — its storage keys and document ids, unchanged from when this file
 * held the implementation, so a job checkpointed before the move is still found
 * after it — and the function names the rest of Mesh calls.
 *
 * Mesh does not attach the store to its machine (`attachCheckpoint`): its
 * resume, park and restore are its own (`machineRecovery.ts`), and they record
 * progress through the functions below.
 */

import {
  createJobCheckpoint,
  type CheckpointProgram,
  type CheckpointReason,
  type CheckpointStatus,
  type PendingPause,
  type RemoteJob,
  type RestorableCheckpoint,
} from '@physbox-io/machining';
import {
  isProAccount,
  getStoredAuthToken,
  putCloudDocument,
  fetchCloudDocument,
  fetchCloudDocuments,
  deleteCloudDocument,
} from './apiClient';
import { tabSession } from './tabSession';

export {
  CHECKPOINT_LIMITS,
  formatBytes,
  type CheckpointProgram,
  type CheckpointProgress,
  type CheckpointReason,
  type CheckpointStatus,
  type PendingPause,
  type RemoteJob,
  type RestorableCheckpoint,
} from '@physbox-io/machining';

const checkpoint = createJobCheckpoint({
  storagePrefix: 'physics',
  docPrefix: 'mesh',
  // Not `physics`, which is the scene: the checkpoint is bookkeeping, and every
  // listing of the account's documents is filtered by app id.
  appId: 'physics-job',
  runProgramAppId: 'physics-run-program',
  tabId: () => tabSession().id,
  cloud: {
    available: () => !!getStoredAuthToken() && isProAccount(),
    put: (doc) => putCloudDocument(doc),
    fetch: (id) => fetchCloudDocument(id),
    list: (appId) => fetchCloudDocuments(appId),
    remove: (id) => deleteCloudDocument(id),
  },
});

export function beginCheckpoint(input: {
  gcode: string;
  totalLines: number;
  jobName?: string | null;
  settings?: Record<string, unknown> | null;
  documentId?: string | null;
}): CheckpointStatus {
  return checkpoint.begin(input);
}

export function recordProgress(
  fromLine: number,
  reason: CheckpointReason = 'streaming',
  force = false,
  pendingPause?: PendingPause
): void {
  checkpoint.recordProgress(fromLine, reason, force, pendingPause);
}

export function noteCheckpointPosition(mpos: { x: number; y: number; z: number }): void {
  checkpoint.notePosition(mpos);
}

export function clearCheckpoint(): void {
  checkpoint.clear();
}

export function loadCheckpoint(): Promise<RestorableCheckpoint | null> {
  return checkpoint.load();
}

export function adoptCheckpoint(program: CheckpointProgram): void {
  checkpoint.adopt(program);
}

/** The archived program document of the job last started here, for telemetry to name. */
export function getRunProgramDocumentId(): string | null {
  return checkpoint.runProgramDocumentId();
}

export function getCheckpointStatus(): CheckpointStatus {
  return checkpoint.getStatus();
}

export function subscribeCheckpoint(fn: (s: CheckpointStatus) => void): () => void {
  return checkpoint.subscribe(fn);
}

export function subscribeRemoteJob(fn: (j: RemoteJob | null) => void): () => void {
  return checkpoint.subscribeRemoteJob(fn);
}
