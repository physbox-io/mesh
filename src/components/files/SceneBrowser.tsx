import { useEffect, useState } from 'react';
import { Search, X, FilePlus2, FolderOpen, Shapes, BookOpen, Grid3x3, FileJson, Clock } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { useDialogs } from '../../store/dialogStore';
import { usePanels, type SceneBrowserTab } from '../../store/panelsStore';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';
import type { PresetActions } from '../../hooks/usePresetActions';
import { EXAMPLE_SHELVES, exampleEntries, matchesQuery } from '../../utils/sceneCatalog';
import { PATTERN_GROUPS, SURFACE_PATTERNS } from '../../utils/surfacePatterns';
import {
  listUserPresetNames, cloudOnlyPresetNames, presetSizes, readUserPresets, deleteUserPreset, USER_PRESETS_CHANGED_EVENT,
} from '../../utils/userPresets';
import { listRecent, recordRecent, SCENE_META_CHANGED_EVENT } from '../../utils/sceneMeta';
import { renameScene, duplicateScene } from '../../utils/sceneFiles';
import { SavedSceneList, type SavedScene } from './SavedSceneList';
import { ExampleGrid, PatternGrid, RecentGrid, SectionHeading, type RecentItem } from './SceneCards';

/**
 * The generators: every pattern but lettering and pictures, which need
 * `prepare` (a font, a decode) before they build and go on a face instead;
 * a picture as a board is Import Image.
 */
const BOARD_PATTERNS = SURFACE_PATTERNS.filter((p) => !p.figure && !p.prepare);
const EXAMPLES = exampleEntries();

type SavedSort = 'date' | 'name';

function readSavedScenes(sort: SavedSort): SavedScene[] {
  try {
    const cloud = new Set(cloudOnlyPresetNames());
    const sizes = new Map(presetSizes().map((s) => [s.name, s.bytes]));
    const local = readUserPresets();
    const byName = (a: SavedScene, b: SavedScene) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    return listUserPresetNames()
      .map((name) => {
        const at = local[name]?.savedAt;
        const thumb = local[name]?.thumbnail;
        return {
          name, cloudOnly: cloud.has(name), bytes: sizes.get(name) ?? null,
          savedAt: typeof at === 'number' ? at : null,
          thumbnail: typeof thumb === 'string' ? thumb : null,
        };
      })
      // Newest first, and the undated (saved before dates were kept) after, by name.
      .sort(sort === 'name' ? byName : (a, b) => (b.savedAt ?? -1) - (a.savedAt ?? -1) || byName(a, b));
  } catch {
    return [];
  }
}

/** The recents that still exist, resolved to what they are. */
function readRecentItems(saved: SavedScene[]): RecentItem[] {
  const byName = new Map(saved.map((s) => [s.name, s]));
  return listRecent().flatMap((r): RecentItem[] => {
    if (r.id.startsWith('user:')) {
      const name = r.id.slice('user:'.length);
      const s = byName.get(name);
      return s ? [{ kind: 'saved', id: r.id, name, thumbnail: s.thumbnail, at: r.at }] : [];
    }
    if (r.id.startsWith('pattern:')) {
      const spec = BOARD_PATTERNS.find((p) => `pattern:${p.id}` === r.id);
      return spec ? [{ kind: 'pattern', id: r.id, spec, at: r.at }] : [];
    }
    const entry = EXAMPLES.find((e) => e.id === r.id);
    return entry ? [{ kind: 'example', id: r.id, entry, at: r.at }] : [];
  });
}

/**
 * The scene browser: the user's saved scenes, the built-in examples and the
 * pattern-board generators, with one search over all three.
 *
 * It replaces a single <select> that had grown to eighty-odd entries, where
 * the generators — which make a new board rather than load a scene — sat
 * between the examples and the user's own work.
 */
export function SceneBrowser(props: SceneBrowserProps) {
  const tab = usePanels((s) => s.sceneBrowser);
  // Mounted only while open, so each opening starts with an empty search.
  return tab ? <OpenSceneBrowser {...props} tab={tab} /> : null;
}

interface SceneBrowserProps {
  presets: PresetActions;
  hasUnsavedWork: () => boolean;
  onImportJson: () => void;
}

function OpenSceneBrowser({ presets, hasUnsavedWork, onImportJson, tab }: SceneBrowserProps & { tab: SceneBrowserTab }) {
  const setTab = usePanels((s) => s.openSceneBrowser);
  const close = usePanels((s) => s.closeSceneBrowser);
  useEscapeToClose(true, close);

  const activePreset = useStore((s) => s.activePreset);
  const stock = useStore((s) => s.stock);
  const openPatternGenerator = useStore((s) => s.openPatternGenerator);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);
  const showNotice = useDialogs((s) => s.showNotice);

  const [query, setQuery] = useState('');
  // Storage is read on render; this asks for one after anything changes it.
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(USER_PRESETS_CHANGED_EVENT, bump);
    window.addEventListener(SCENE_META_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(USER_PRESETS_CHANGED_EVENT, bump);
      window.removeEventListener(SCENE_META_CHANGED_EVENT, bump);
    };
  }, []);
  const [sort, setSort] = useState<SavedSort>('date');
  const saved = readSavedScenes(sort);
  const recent = readRecentItems(saved);

  const activeUser = activePreset?.startsWith('user:') ? activePreset.slice('user:'.length) : null;
  const activeExample = activePreset && !activeUser ? activePreset : null;

  const q = query.trim();
  const foundSaved = saved.filter((s) => matchesQuery(q, s.name));
  const foundExamples = EXAMPLES.filter((e) => matchesQuery(q, e.name, e.shelf, e.id.replace(/_/g, ' ')));
  const foundPatterns = BOARD_PATTERNS.filter((p) => matchesQuery(q, p.label, p.group, p.blurb));

  /** Loads, asking first when the work on screen would be lost. The browser stays open until it happens. */
  const load = (id: string) => {
    const go = () => {
      close();
      if (id.startsWith('user:')) void presets.loadUserPresetWithCard(id);
      else presets.loadPresetWithCard(id);
    };
    if (!hasUnsavedWork()) { go(); return; }
    openDialog({
      title: 'Replace the current scene?',
      confirmLabel: 'Replace scene',
      tone: 'amber',
      body: <p>Its unsaved changes, note cards and copilot chat will be lost.</p>,
      onCancel: () => closeDialog(),
      onConfirm: () => { closeDialog(); go(); },
    });
  };

  const pickPattern = (id: string) => {
    recordRecent(`pattern:${id}`);
    close();
    openPatternGenerator(id);
  };

  const rename = async (from: string, to: string): Promise<boolean> => {
    const result = await renameScene(from, to);
    setVersion((v) => v + 1);
    if (!result.ok) { showNotice('Could not rename', result.message, 'red'); return false; }
    if (activeUser === from) useStore.getState().setActivePreset(`user:${result.name}`);
    return true;
  };

  const duplicate = async (name: string) => {
    const result = await duplicateScene(name);
    setVersion((v) => v + 1);
    if (!result.ok) showNotice('Could not copy', result.message, 'red');
  };

  const remove = (name: string) => {
    openDialog({
      title: `Delete “${name}”?`,
      confirmLabel: 'Delete',
      tone: 'red',
      body: <p>The saved scene is removed{activeUser === name ? '; the copy on screen stays open' : ''}.</p>,
      onCancel: () => closeDialog(),
      onConfirm: () => {
        closeDialog();
        if (deleteUserPreset(name)) {
          if (activeUser === name) useStore.getState().setActivePreset(undefined);
        } else {
          showNotice('Could not delete', `Could not delete “${name}”: this browser would not write the scene list.`, 'red');
        }
        setVersion((v) => v + 1);
      },
    });
  };

  /** Enter in the search box opens the first thing it found. */
  const openFirst = () => {
    if (foundSaved[0]) load(`user:${foundSaved[0].name}`);
    else if (foundExamples[0]) load(foundExamples[0].id);
    else if (foundPatterns[0]) pickPattern(foundPatterns[0].id);
  };

  const tabs: { id: SceneBrowserTab; label: string; Icon: typeof FolderOpen; count: number }[] = [
    { id: 'recent', label: 'Recent', Icon: Clock, count: recent.length },
    { id: 'mine', label: 'My scenes', Icon: FolderOpen, count: foundSaved.length },
    { id: 'examples', label: 'Examples', Icon: BookOpen, count: foundExamples.length },
    { id: 'patterns', label: 'Pattern boards', Icon: Grid3x3, count: foundPatterns.length },
  ];

  const savedSection = (
    foundSaved.length > 0 ? (
      <>
      {!q && foundSaved.length > 1 && (
        <div className="flex justify-end gap-1 mb-2 text-[10px]">
          <span className="text-slate-400 mr-1 self-center">Sort by</span>
          {(['date', 'name'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={`px-2 py-0.5 rounded cursor-pointer ${sort === k
                ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            >
              {k === 'date' ? 'Date' : 'Name'}
            </button>
          ))}
        </div>
      )}
      <SavedSceneList
        scenes={foundSaved}
        activeName={activeUser}
        onOpen={(name) => load(`user:${name}`)}
        onRename={rename}
        onDuplicate={(name) => void duplicate(name)}
        onDelete={remove}
      />
      </>
    ) : (
      <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
        {q ? 'No saved scene matches.' : <>Nothing saved yet. <kbd className="px-1 rounded bg-slate-100 dark:bg-slate-800">Ctrl+S</kbd> saves the scene on screen.</>}
      </div>
    )
  );

  const examplesSection = EXAMPLE_SHELVES.map((shelf) => {
    const onShelf = foundExamples.filter((e) => e.shelf === shelf);
    if (onShelf.length === 0) return null;
    return (
      <div key={shelf}>
        <SectionHeading>{shelf}</SectionHeading>
        <ExampleGrid entries={onShelf} activeId={activeExample} onOpen={load} />
      </div>
    );
  });

  const patternsSection = (
    <>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
        Each makes a new board the size of your stock ({stock.widthMm} × {stock.depthMm} × {stock.thicknessMm} mm),
        with the pattern as its top face, ready to carve.
      </p>
      {PATTERN_GROUPS.map((group) => {
        const inGroup = foundPatterns.filter((p) => (p.group ?? 'Nature') === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group}>
            <SectionHeading>{group}</SectionHeading>
            <PatternGrid specs={inGroup} stock={stock} onPick={pickPattern} />
          </div>
        );
      })}
    </>
  );

  const nothing = q && foundSaved.length + foundExamples.length + foundPatterns.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center sm:p-4 bg-slate-900/60 backdrop-blur-xs"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-full max-w-5xl h-full sm:h-[85dvh] bg-white dark:bg-slate-900 sm:rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
        {/* Search and the two things that are not opening a file */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 focus-within:ring-2 ring-blue-400">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') openFirst(); }}
              placeholder="Search scenes, examples and patterns"
              className="flex-1 min-w-0 bg-transparent outline-none text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              aria-label="Search scenes"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-slate-400 hover:text-slate-600 cursor-pointer" title="Clear">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => load('empty')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer shrink-0"
            title="Start an empty scene"
          >
            <FilePlus2 className="w-4 h-4" />
            <span className="hidden sm:inline">New blank</span>
          </button>
          <button onClick={close} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" title="Close (Esc)">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0 max-sm:flex-col">
          {/* Where to look. A column at desktop width, a strip of pills on a phone. */}
          <nav className="sm:w-48 shrink-0 sm:border-r border-b sm:border-b-0 border-slate-200 dark:border-slate-800 p-2 flex sm:flex-col gap-1 overflow-x-auto">
            {tabs.map(({ id, label, Icon, count }) => {
              const on = !q && tab === id;
              return (
                <button
                  key={id}
                  onClick={() => { setQuery(''); setTab(id); }}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer ${
                    on
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{label}</span>
                  <span className="text-[10px] text-slate-400 tabular-nums">{count}</span>
                </button>
              );
            })}
            <div className="hidden sm:block flex-1" />
            <button
              onClick={() => { close(); onImportJson(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
              title="Open a scene saved as a .json file"
            >
              <FileJson className="w-4 h-4 shrink-0" />
              <span>Open file…</span>
            </button>
          </nav>

          <div className="flex-1 overflow-y-auto p-4">
            {nothing ? (
              <div className="h-full flex flex-col items-center justify-center text-sm text-slate-400 gap-2">
                <Shapes className="w-8 h-8" />
                Nothing matches “{q}”.
              </div>
            ) : q ? (
              <>
                {foundSaved.length > 0 && <><SectionHeading>My scenes</SectionHeading>{savedSection}</>}
                {foundExamples.length > 0 && examplesSection}
                {foundPatterns.length > 0 && <><SectionHeading>Pattern boards</SectionHeading>{patternsSection}</>}
              </>
            ) : tab === 'recent' ? (
              recent.length > 0 ? (
                <RecentGrid
                  items={recent}
                  stock={stock}
                  activeId={activePreset ?? null}
                  onOpen={(item) => (item.kind === 'pattern' ? pickPattern(item.spec.id) : load(item.id))}
                />
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                  Scenes you open show up here.
                </div>
              )
            ) : tab === 'mine' ? savedSection : tab === 'examples' ? examplesSection : patternsSection}
          </div>
        </div>
      </div>
    </div>
  );
}
