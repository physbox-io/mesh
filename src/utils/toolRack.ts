/**
 * The shared tool rack: the bits in the drawer, the same list in Etch, Volt
 * and here.
 *
 * Mesh used to ask for a bare diameter at every export and remember nothing,
 * so the 3.175 mm end mill that was T2 in Etch had to be typed again for a
 * relief, and a bit retired in Etch was still the number someone typed here.
 * The rack lives in the account under the app-agnostic `global` scope; this is
 * Mesh's handle on it, kept in this browser's storage and settled against the
 * account on sign-in (`cloudSync.pullCloudState`), newer copy winning either
 * way — see `ToolRackStore` in `@physbox-io/machining`.
 *
 * Mesh reads it only to offer diameters. It does not number tool changes from
 * it: a relief's roughing and finishing bits are the program's T1 and T2
 * whatever the rack calls them, and the rack is a picker, never a requirement —
 * free entry stays, because the bit on the bench is not always in the drawer.
 */

import { useSyncExternalStore } from 'react';
import {
  TOOL_RACK_PARAMETER,
  TOOL_RACK_STORAGE_KEY,
  ToolRackStore,
  availableTools,
  type RackTool,
  type ToolRack,
  type ToolShape,
} from '@physbox-io/machining';

export const toolRackStore = new ToolRackStore({
  load: () => {
    try {
      return localStorage.getItem(TOOL_RACK_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  save: (text) => {
    try {
      localStorage.setItem(TOOL_RACK_STORAGE_KEY, text);
      return true;
    } catch {
      // Private mode or full storage: the rack holds for this session only,
      // and the dialog says so.
      return false;
    }
  },
  // Lazily, as the other account mirrors here are: apiClient pulls in the
  // whole network layer, which a store read at import time has no need of.
  push: (rack) => {
    void import('./apiClient').then(({ syncCloudParameters }) => {
      void syncCloudParameters('global', { [TOOL_RACK_PARAMETER]: rack });
    });
  },
});

/**
 * Settles this browser's rack against the account's copy, from a sign-in pull.
 * True when the account's was newer and replaced ours.
 *
 * Reloaded first, so a rack edited in another tab since this one started is
 * what is compared — not this tab's stale copy, which would otherwise be pushed
 * back over it.
 */
export function settleToolRack(accountValue: unknown): boolean {
  toolRackStore.reload();
  return toolRackStore.adoptRemote(accountValue);
}

/** The rack, re-rendering on an edit here or a newer copy from the account. */
export function useToolRack(): ToolRack {
  return useSyncExternalStore(
    (onChange) => {
      const off = toolRackStore.subscribe(onChange);
      return () => {
        off();
      };
    },
    () => toolRackStore.get()
  );
}

/** The bits in the drawer that can do a job wanting one of these shapes. */
export function rackToolsFor(rack: ToolRack, shapes: ToolShape[]): RackTool[] {
  return availableTools(rack, shapes);
}

/** How a rack tool reads in a picker: its T number, its size and its name. */
export function rackToolLabel(tool: RackTool): string {
  const size = `${Number(tool.diameterMm.toFixed(3))} mm`;
  return tool.name.includes(size) ? `T${tool.toolNumber} · ${tool.name}` : `T${tool.toolNumber} · ${size} ${tool.name}`;
}
