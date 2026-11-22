// ---------------------------------------------------------------------------
// Deep-link URL query parameters (`?preset=...&machine=...&open=...&tab=...`)
// ---------------------------------------------------------------------------
//
// Lets tutorials, craft cards on physbox.io, and shared docs open Mesh directly
// on a built-in example scene, with the bench machine and an optional craft
// dialog already open. Pure parser so tests run in plain Node without a DOM.

import { PRESETS } from '../presets/presetScenes';
import type { MachineTarget } from '../store/useStore';
import { isMoldTab, type MoldTab } from './moldTabs';
import type { SheetUnfoldMode } from './sheetUnfoldExporter';

export const START_TOUR_EVENT = 'physbox:start-tour';

export type DeepLinkModal =
  | 'mold'
  | 'unfold'
  | 'unwrap'
  | 'contour'
  | 'relief'
  | 'solid'
  | 'joinery'
  | 'pipes'
  | 'brick';

const VALID_MODALS = new Set<DeepLinkModal>([
  'mold',
  'unfold',
  'unwrap',
  'contour',
  'relief',
  'solid',
  'joinery',
  'pipes',
  'brick',
]);

const VALID_MACHINES = new Set<MachineTarget>(['fdm', 'laser', 'cnc']);
const VALID_UNFOLD_MODES = new Set<SheetUnfoldMode>(['papercraft', 'sheet_metal', 'soft_goods']);

export interface MeshDeepLink {
  preset?: string;
  machine?: MachineTarget;
  open?: DeepLinkModal;
  moldTab?: MoldTab;
  unfoldMode?: SheetUnfoldMode;
  run?: boolean;
  tour?: boolean;
}

export function parseMeshDeepLink(search: string): MeshDeepLink | null {
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);

  const rawPreset = params.get('preset')?.trim();
  const preset = rawPreset && Object.hasOwn(PRESETS, rawPreset) ? rawPreset : undefined;

  const rawMachine = params.get('machine')?.trim() as MachineTarget | undefined;
  const machine = rawMachine && VALID_MACHINES.has(rawMachine) ? rawMachine : undefined;

  const rawOpen = (params.get('open') ?? params.get('modal'))?.trim() as DeepLinkModal | undefined;
  const open = rawOpen && VALID_MODALS.has(rawOpen) ? rawOpen : undefined;

  const rawTab = params.get('tab')?.trim();
  const moldTab = rawTab && isMoldTab(rawTab) ? rawTab : undefined;

  const rawUnfold = params.get('mode')?.trim() as SheetUnfoldMode | undefined;
  const unfoldMode = rawUnfold && VALID_UNFOLD_MODES.has(rawUnfold) ? rawUnfold : undefined;

  const run = params.get('run') === '1' || params.get('run') === 'true';
  const tour = params.get('tour') === '1' || params.get('tour') === 'true';

  if (!preset && !machine && !open && !moldTab && !unfoldMode && !run && !tour) return null;
  return {
    ...(preset ? { preset } : {}),
    ...(machine ? { machine } : {}),
    ...(open ? { open } : {}),
    ...(moldTab ? { moldTab } : {}),
    ...(unfoldMode ? { unfoldMode } : {}),
    ...(run ? { run: true } : {}),
    ...(tour ? { tour: true } : {}),
  };
}

/** Strips consumed deep-link query params while preserving unrelated params (`?s=`, `?mcp=`) and hash. */
export function stripMeshDeepLinkSearch(href: string): string {
  const url = new URL(href, 'https://mesh.physbox.io');
  for (const key of ['preset', 'machine', 'open', 'modal', 'tab', 'mode', 'run', 'tour']) {
    url.searchParams.delete(key);
  }
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`;
}
