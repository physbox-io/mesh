import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useSettled } from '../../hooks/useSettled';
import { AddSimulationButton } from '../MachineJobControls';
import { MoldWorkerClient, addPourToScene, pourPlugNote, pourSideLabel, pourUndercutWarning } from '../../utils/moldWorkerClient';
import { POUR_DIRECTIONS, type PourDirection } from '../../utils/pourCast';
import { isSiliconeMold, pourBoxIn } from '../../utils/pourTarget';
import type { MoldCastSimulationResult } from '../../utils/moldCastSimulation';
import type { SceneNode } from '../../types/scene';
import { PanelBody, PanelFooter } from './CastDialogFrame';
import { castMaterialWarnings, castWeightG, mixGrams, type CastMaterialId } from '../../utils/castMaterials';
import { tabMaterials } from '../../utils/moldTabs';

const SIDE_NAMES: Record<PourDirection, string> = {
  '+z': 'Top', '-z': 'Underneath', '+x': '+X side', '-x': '-X side', '+y': '+Y side', '-y': '-Y side',
};

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none';

interface PourPanelProps {
  onClose: () => void;
  /** The mold: the selected bodies that touch the one clicked, grouped. */
  moldNode: SceneNode;
  /** Selected bodies left out because they touch nothing in the mold. */
  apart: SceneNode[];
  /** What is poured. */
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  /** Over to the Mold dialog, to make a mold of the selection instead. */
  onMakeMold: () => void;
}

/**
 * Pours into a mold that is already in the scene — a master and its pour
 * sleeve, a silicone mold simulated from them, or a mold made elsewhere — and
 * adds what sets in it. A selection that holds nothing says so, rather than
 * turning into something else.
 */
export const PourPanel: React.FC<PourPanelProps> = ({ onClose, moldNode, apart, material, onMaterial, onMakeMold }) => {
  const [cast, setCast] = useState<MoldCastSimulationResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(true);
  // A master in its pour box fills to the box's fill line, from the top.
  const [box] = useState(() => pourBoxIn(moldNode));
  // Silicone sticks to a mold that was poured in silicone, so none is offered.
  const [siliconeMold] = useState(() => isSiliconeMold(moldNode));
  const [direction, setDirection] = useState<PourDirection | 'auto'>(box ? '+z' : 'auto');
  /** Fill depth in mm; null fills to the rim. */
  const [fill, setFill] = useState<number | null>(box ? box.pourDepthMm : null);
  // Memoised: a fresh literal each render restarted the settle timer on every
  // render, so each pour's own busy flag set off the next — the dialog re-poured
  // about once a second and Simulate Cast blinked disabled with it.
  const pourOptions = useMemo(() => ({ direction, fill }), [direction, fill]);
  const settled = useSettled(pourOptions, 300);
  // One worker for the dialog's life, not one per change of side or depth.
  const clientRef = useRef<MoldWorkerClient | null>(null);
  useEffect(() => {
    const client = new MoldWorkerClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    let live = true;
    setBusy(true);
    client
      .castNode(moldNode, { pour: { direction: settled.direction, ...(settled.fill ? { fillMm: settled.fill } : {}) } })
      .then((res) => {
        if (!live) return;
        if (res.success) {
          setCast(res);
          setFailure(null);
        } else {
          setCast(null);
          setFailure(res.error ?? 'Nothing poured.');
        }
      })
      .catch((e: Error) => {
        if (live) setFailure(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [moldNode, settled]);

  const handleAdd = async () => {
    if (!cast) return;
    setAdding(true);
    try {
      await addPourToScene(moldNode, cast, 'beside', material);
      onClose();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const pour = cast?.pour;
  const grams = cast ? castWeightG(material, cast.castVolumeMm3) : 0;
  const mix = cast ? mixGrams(material, grams) : null;
  const notes = cast ? castMaterialWarnings(material, cast.castVolumeMm3 / 1000, { pla: false }) : [];
  const undercut = pour ? pourUndercutWarning(pour) : null;
  const plug = pour ? pourPlugNote(pour) : null;
  return (
    <>
      <PanelBody>
        {apart.length > 0 && (
          <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              Left out {apart.map((n) => n.name).join(', ')}: {apart.length === 1 ? 'it does' : 'they do'} not touch {moldNode.name}, so {apart.length === 1 ? 'it holds' : 'they hold'} nothing with it.
            </span>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs col-span-2">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Material</span>
            <select value={material} onChange={(e) => onMaterial(e.target.value as CastMaterialId)} className={inputClass}>
              {tabMaterials(siliconeMold ? 'silicone' : 'rigid').map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Pour from</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as PourDirection | 'auto')}
              className={inputClass}
            >
              <option value="auto">Best side</option>
              {POUR_DIRECTIONS.map((d) => (
                <option key={d} value={d}>{SIDE_NAMES[d]}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-semibold text-slate-600 dark:text-slate-300">
              Fill depth (mm){' '}
              {fill !== null && (
                <button type="button" onClick={() => setFill(null)} className="font-normal underline cursor-pointer">
                  to rim
                </button>
              )}
              {box && fill !== box.pourDepthMm && (
                <button type="button" onClick={() => setFill(box.pourDepthMm)} className="font-normal underline cursor-pointer ml-1">
                  to fill line
                </button>
              )}
            </span>
            <NumberInput
              min={0.5}
              max={pour?.depthMm}
              step={1}
              value={fill ?? pour?.depthMm ?? 0}
              onChange={(v) => {
                if (v !== undefined) setFill(pour && v >= pour.depthMm ? null : v);
              }}
              className={inputClass}
            />
          </label>
        </div>
        {failure ? (
          <p className="text-red-600 dark:text-red-400">{failure}</p>
        ) : !cast ? (
          <p className="text-slate-500 dark:text-slate-400">Pouring…</p>
        ) : (
          <>
            <p className={`text-slate-600 dark:text-slate-300 ${busy ? 'opacity-50' : ''}`}>
              {box && fill === box.pourDepthMm ? 'To the pour box\'s fill line: ' : ''}
              Poured {pour ? pourSideLabel(pour.direction) : ''}
              {pour && pour.filledMm < pour.depthMm ? `, ${pour.filledMm} of ${pour.depthMm} mm deep` : ', to the rim'}.
            </p>
            <dl className={`grid grid-cols-2 gap-y-1 text-xs ${busy ? 'opacity-50' : ''}`}>
              <dt className="text-slate-500 dark:text-slate-400">Volume</dt>
              <dd className="font-mono">{Math.round(cast.castVolumeMm3).toLocaleString()} mm³</dd>
              <dt className="text-slate-500 dark:text-slate-400">Weight</dt>
              <dd className="font-mono">
                {Math.round(grams).toLocaleString()} g
                {mix ? ` (${Math.round(mix.a)} g ${mix.aLabel} + ${Math.round(mix.b)} g ${mix.bLabel})` : ''}
              </dd>
              <dt className="text-slate-500 dark:text-slate-400">Size</dt>
              <dd className="font-mono">{cast.sizeMm.width} × {cast.sizeMm.depth} × {cast.sizeMm.height} mm</dd>
            </dl>
            {notes.map((n) => (
              <p key={n} className="text-xs text-amber-700 dark:text-amber-400">{n}</p>
            ))}
            {plug && <p className="text-xs text-slate-600 dark:text-slate-300">{plug}</p>}
            {undercut && (
              <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{undercut}</span>
              </p>
            )}
          </>
        )}
      </PanelBody>

      <PanelFooter>
        <button
          type="button"
          onClick={onMakeMold}
          className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
        >
          Make a mold of it instead
        </button>
        <AddSimulationButton
          disabled={!cast || adding || busy}
          onSimulate={() => void handleAdd()}
          progress={adding ? 0.5 : null}
          label="Simulate Cast"
          besideOnly
        />
      </PanelFooter>
    </>
  );
};
