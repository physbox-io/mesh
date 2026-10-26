import { Save } from 'lucide-react';

/** Names the scene and saves it as a user preset. */
export function SavePresetModal({ isOpen, name, setName, close, confirm }: {
  isOpen: boolean;
  name: string;
  setName: (name: string) => void;
  close: () => void;
  confirm: () => void;
}) {
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={close}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center text-blue-600 dark:text-blue-400">
            <Save className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">Save Scene Preset</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Saved in this browser, and to your account when signed in</p>
          </div>
        </div>
        <input
          autoFocus
          type="text"
          placeholder="e.g. Double Pendulum Wave"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') close();
          }}
          className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={close}
            className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!name.trim()}
            className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
