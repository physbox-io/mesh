import React, { useState } from 'react';
import { ToolRackModal } from '@physbox-io/ui';
import { DEFAULT_TOOL_RACK, RACK_PRESETS, cuttingDefaults, defaultToolRack } from '@physbox-io/machining';
import { toolRackStore, useToolRack } from '../utils/toolRack';

/**
 * The tool rack, as the dialog every app shares.
 *
 * It edits the rack's own entries whole, so a field Mesh has no use for — the
 * "best for" Etch fills in with its layer operations, an RPM set in Volt — is
 * carried through an edit made here rather than flattened by it. No `uses`
 * list is passed for the same reason: Mesh has no vocabulary of its own for
 * what a bit is for, and the section is hidden rather than offering Etch's.
 */
export const ToolRackDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const rack = useToolRack();
  // A rack that only reached memory is one the next reload does not have.
  const [unsaved, setUnsaved] = useState(false);
  const write = (tools: typeof rack.tools) => {
    toolRackStore.set(tools);
    setUnsaved(!toolRackStore.lastSaveSucceeded());
  };

  return (
    <ToolRackModal
      open={open}
      onClose={onClose}
      tools={rack.tools}
      onChange={write}
      onReset={() => write(defaultToolRack().tools)}
      defaultCount={DEFAULT_TOOL_RACK.length}
      presets={RACK_PRESETS}
      cuttingDefaults={cuttingDefaults}
      unsaved={unsaved}
      note="This rack is shared with Etch and Volt through your account: an edit here is the rack they offer too. The export dialogs offer its bits beside every cutter size."
    />
  );
};
