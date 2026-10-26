// ---------------------------------------------------------------------------
// The last thing standing when the app throws while rendering
// ---------------------------------------------------------------------------
//
// Without this, one exception in any component unmounted the whole tree and
// left a blank page; the only way out was a reload, and a reload starts from a
// blank scene. The store survives a render error — it is a module, not a
// component — so the scene is still there to be saved, and this page offers
// exactly that before it offers the reload.
// ---------------------------------------------------------------------------

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { physicsGlobals } from '../physicsGlobals';
import { packMeshArrays } from '../utils/meshPacking';
import { exportBaseName } from '../utils/exportBaseName';

/**
 * The scene as the store holds it, with its note cards and chat. Not the
 * simulated pose: that needs MuJoCo, which may be what broke. The graph is
 * what was edited, which is what is worth keeping.
 */
function downloadScene(): void {
  const { sceneGraph, activePreset } = useStore.getState();
  const noteCards = physicsGlobals._physics_getNoteCards?.() ?? [];
  const copilotMessages = physicsGlobals._physics_getCopilotMessages?.() ?? [];
  const text = JSON.stringify(packMeshArrays({ ...sceneGraph, noteCards, copilotMessages }), null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${exportBaseName(noteCards, activePreset)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function isDark(): boolean {
  try {
    return localStorage.getItem('physics_dark_mode') === 'true';
  } catch {
    return false;
  }
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; saveFailed: boolean }> {
  state = { error: null as Error | null, saveFailed: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Mesh stopped on a render error', error, info.componentStack);
  }

  private save = () => {
    try {
      downloadScene();
    } catch (e) {
      console.error('Could not save the scene after a crash', e);
      this.setState({ saveFailed: true });
    }
  };

  render() {
    const { error, saveFailed } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`${isDark() ? 'dark' : ''} h-dvh w-screen`}>
        <div className="h-full w-full flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
          <div className="max-w-md w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400">
                <AlertTriangle size={20} />
              </div>
              <h1 className="text-lg font-semibold">Mesh hit an error</h1>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">
              Your scene is still here. Save a copy before reloading; you can open it again with Import.
            </p>
            <pre className="text-xs whitespace-pre-wrap break-words max-h-32 overflow-auto rounded-lg bg-slate-100 dark:bg-slate-800 p-2 mb-4 text-slate-700 dark:text-slate-300">
              {error.message || String(error)}
            </pre>
            {saveFailed && (
              <p className="text-sm text-red-600 dark:text-red-400 mb-3">The scene could not be saved either.</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={this.save}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white"
              >
                Save scene
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
