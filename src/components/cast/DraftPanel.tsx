import React, { useState } from 'react';
import { NumberInput } from '@physbox-io/ui';
import { applyAddDraft, MAX_ADD_DRAFT_DEG } from '../../utils/addDraftAction';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { inputClass, Field } from '../CarveFields';
import { PanelBody, PanelFooter } from './CastDialogFrame';

interface DraftPanelProps {
  onClose: () => void;
  /** The part: the bodies to draft. */
  ids: string[];
  /** Draft Prepare for Casting already put in, degrees; 0 for none. */
  bakedDraftDeg: number;
}

/**
 * Add Draft: tapers the part, as it stands, to pull straight up. Turn the part
 * first to choose the direction. It is baked into the part, one undo step.
 */
export const DraftPanel: React.FC<DraftPanelProps> = ({ onClose, ids, bakedDraftDeg }) => {
  const [deg, setDeg] = useState(DEFAULT_TAB_DRAFT.draft);
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [failure, setFailure] = useState<string | null>(null);

  const apply = () => {
    const r = applyAddDraft(ids, deg, mode);
    if (r.error) setFailure(r.error);
    else onClose();
  };

  return (
    <>
      <PanelBody>
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Tapers every wall so the part pulls straight up out of a mold, the way it stands in the scene, from its lowest point.
          To pull another way, turn the part first.
        </p>
        <div className="grid grid-cols-2 gap-3 min-w-0">
          <Field label="Draft (°)" hint="How far each wall leans from vertical. 1–3° is usual.">
            <NumberInput min={0.1} max={MAX_ADD_DRAFT_DEG} step={0.5} value={deg} onChange={(v) => v !== undefined && setDeg(v)} className={inputClass} />
          </Field>
          <Field label="Keep" hint="Which end keeps its modelled size. Keeping the top grows the walls toward the base; keeping the base narrows them toward the top." hintAlign="end">
            <select value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'remove')} className={inputClass}>
              <option value="add">The top (add material)</option>
              <option value="remove">The base (remove material)</option>
            </select>
          </Field>
        </div>
        {bakedDraftDeg > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Prepare for Casting has already drafted the part {bakedDraftDeg}°. Switch it off first (Sand or Lost PLA, Advanced).
          </p>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The part becomes a mesh with the draft in it. Undo takes it back.
        </p>
        {failure && <p className="text-xs text-red-600 dark:text-red-400">{failure}</p>}
      </PanelBody>
      <PanelFooter>
        <span />
        <button type="button" disabled={!(deg > 0) || bakedDraftDeg > 0} onClick={apply}
          className="px-3 py-2 text-xs font-semibold rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 cursor-pointer">
          Add Draft
        </button>
      </PanelFooter>
    </>
  );
};
