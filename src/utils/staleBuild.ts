// ---------------------------------------------------------------------------
// Is this tab running a build that has since been replaced?
// ---------------------------------------------------------------------------
//
// Every build names its workers and lazy chunks by content hash, and a deploy
// replaces the whole set. A tab opened before the deploy still asks for the old
// names, the server has none of them, and the worker dies on load — which the
// clients used to report as "The export worker stopped.", sending everyone
// looking for a bug in the export. The job was fine; the tab was out of date.
//
// So when a worker dies, ask the server which build it serves now. The build
// stamp is written by vite.config.ts (`__MESH_BUILD__` here, `/version.json`
// beside index.html). If the two differ, say so — in the error the caller
// shows, and in a banner over the app — and offer a reload. Never reload on
// our own: there is no autosave, and a reload throws the scene away.

import { create } from 'zustand';

declare const __MESH_BUILD__: string | undefined;

/** The build this tab is running. 'dev' under the dev server and the tests. */
export const RUNNING_BUILD = typeof __MESH_BUILD__ === 'string' ? __MESH_BUILD__ : 'dev';

export const UPDATED_MESSAGE =
  'Mesh was updated after this tab was opened, and this tab can no longer load its tools. Save your scene, then reload the page.';

/** Whether a newer build is known to be live. The banner reads it. */
export const useUpdateNotice = create<{ stale: boolean; dismissed: boolean; dismiss: () => void }>((set) => ({
  stale: false,
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
}));

let inFlight: Promise<boolean> | null = null;

/**
 * Asks the server which build it serves. False under the dev server, and when
 * the question cannot be answered: a dead worker on a current build is a real
 * failure, and must keep its own message.
 */
export function isStaleBuild(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (RUNNING_BUILD === 'dev') return Promise.resolve(false);
  if (useUpdateNotice.getState().stale) return Promise.resolve(true);
  inFlight ??= (async () => {
    try {
      const res = await fetchImpl('/version.json', { cache: 'no-store' });
      if (!res.ok) return false;
      const { build } = (await res.json()) as { build?: unknown };
      const stale = typeof build === 'string' && build !== RUNNING_BUILD;
      if (stale) useUpdateNotice.setState({ stale: true });
      return stale;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The error for a worker that died: the update, if that is why, else `fallback`. */
export async function workerStoppedError(fallback: string, fetchImpl?: typeof fetch): Promise<Error> {
  return new Error((await isStaleBuild(fetchImpl)) ? UPDATED_MESSAGE : fallback);
}

/** For the clients that report a dead worker their own way: raise the banner if it was a deploy. */
export function noteWorkerStopped(): void {
  void isStaleBuild();
}

// What each browser says when a lazy chunk will not load: Chrome, Firefox, Safari.
const CHUNK_LOAD_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/**
 * A failed `import()` rewritten as something a person (or an agent reading
 * collisionError) can act on. The raw message names a hashed asset URL and
 * reads like a bug in the feature; nearly always the tab predates a deploy.
 * Any other message comes back unchanged.
 */
export async function describeLoadFailure(message: string, fetchImpl?: typeof fetch): Promise<string> {
  if (!CHUNK_LOAD_FAILURE.test(message)) return message;
  return (await isStaleBuild(fetchImpl))
    ? UPDATED_MESSAGE
    : `Part of Mesh did not download (${message}). Reload the page to try again.`;
}
