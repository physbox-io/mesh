// ---------------------------------------------------------------------------
// The top of every Mold tab: what it is cast in, and the draft
// ---------------------------------------------------------------------------
//
// Most people look at nothing else, so it is the same two fields on every
// tab. Everything a tab can do beyond them sits under its Advanced, closed.

import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { inputClass, Field } from '../CarveFields';
import { tabMaterials, type MoldTab } from '../../utils/moldTabs';
import type { CastMaterialId } from '../../utils/castMaterials';

export function CastTopFields({
  tab, material, onMaterial, draftDeg, onDraft, draftLocked, draftFixedReason, draftHint,
}: {
  tab: MoldTab;
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  draftDeg: number;
  onDraft: (deg: number) => void;
  /** The model carries draft from Prepare for Casting, so this shows it and adds none. */
  draftLocked: boolean;
  /** Draft that this tab cannot use, and why: the field shows 0 and says so. */
  draftFixedReason?: string;
  draftHint: string;
}) {
  const materials = tabMaterials(tab);
  const hint = draftLocked && draftFixedReason
    ? `The master carries ${draftDeg}° of draft from Prepare for Casting, which the silicone copies. ${draftFixedReason}`
    : draftLocked
    ? `The model already carries ${draftDeg}° of draft from Prepare for Casting, so none is added here. Switch prep off (Sand or Lost PLA, Advanced) to change it.`
    : draftFixedReason ?? draftHint;
  return (
    <div className="grid grid-cols-2 gap-3 min-w-0">
      <Field label="Material" hint="What the piece is cast in. It sets the weight, the warnings and, for metal, the shrink.">
        <select
          value={material}
          onChange={(e) => onMaterial(e.target.value as CastMaterialId)}
          className={inputClass}
        >
          {materials.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </Field>
      <Field label={draftLocked ? 'Draft (°, in model)' : 'Draft (°)'} hint={hint} hintAlign="end">
        <NumberInput
          min={0}
          max={10}
          step={0.5}
          value={draftFixedReason && !draftLocked ? 0 : draftDeg}
          onChange={(v) => onDraft(v ?? 0)}
          disabled={draftLocked || Boolean(draftFixedReason)}
          className={inputClass}
        />
      </Field>
    </div>
  );
}

/** A closed section holding the rest of a tab's settings, stacked for a narrow column. */
export function AdvancedBlock({ defaultOpen = false, children }: { defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-purple-600 dark:hover:text-purple-400 cursor-pointer transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>Advanced</span>
      </button>
      {open && children}
    </div>
  );
}

/** Notes that came with the material: one line each. */
export function MaterialNotes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="space-y-1 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
      {notes.map((n) => <li key={n}>{n}</li>)}
    </ul>
  );
}
