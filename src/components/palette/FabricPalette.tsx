import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import type { BodyFigure, GarmentKind } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { formsIn, newFormNode, newGarmentNode, newLooseGarmentNode } from '../../utils/cloth/clothStart';
import { sheetNode } from '../../utils/cloth/clothSheet';
import { GARMENT_KINDS } from '../inspector/garmentFields';
import { addClothNode, frameForm } from './clothStartActions';

/** Where a garment goes: on a form in the scene (its id), on a new form of a figure, or on no form, cut to a figure. */
type Target = { form: string } | { newForm: BodyFigure } | { loose: BodyFigure };
const targetKey = (t: Target) => ('form' in t ? `form:${t.form}` : 'newForm' in t ? `new:${t.newForm}` : `loose:${t.loose}`);

/**
 * Fabric: a plain cloth sheet laid over what is selected (or held up in the
 * open) to drape or tie up, and garments, each kind a start to shape from its
 * Garment card. A garment goes on a dress form (the selected one, the one the
 * selected garment is on, or the first; with none, a new one) or on no form,
 * cut to a figure's measurements, to fall. Folded away until wanted, and
 * opened when a form comes into the scene (Make ▸ Dress form, a preset, an agent).
 *
 * Its own header rather than an `h3`: useCardCollapse folds those by toggling
 * a class React does not know about, and this one also opens itself.
 */
export function FabricPalette({ onPlaced }: { onPlaced?: () => void }) {
  const nodes = useStore((s) => s.sceneGraph.nodes);
  const selectedId = useStore((s) => s.selectedNodeId);
  const forms = formsIn(nodes);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string>('');
  const count = useRef(forms.length);
  useEffect(() => {
    if (forms.length > count.current) setOpen(true);
    count.current = forms.length;
  }, [forms.length]);

  const find = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) { if (n.id === selectedId) return n; const c = find(n.children ?? []); if (c) return c; }
    return undefined;
  };
  const selected = selectedId ? find(nodes) : undefined;
  const fallback = forms.find((f) => f.id === selectedId || (f.name || f.id) === selected?.cloth?.garment?.fitTo) ?? forms[0];
  const targets: { t: Target; label: string }[] = [
    ...forms.map((f) => ({ t: { form: f.id } as Target, label: f.name || f.id })),
    { t: { newForm: 'female' }, label: 'a new female form' },
    { t: { newForm: 'male' }, label: 'a new male form' },
    { t: { loose: 'female' }, label: 'no form (female sizes)' },
    { t: { loose: 'male' }, label: 'no form (male sizes)' },
  ];
  const chosen = targets.find((o) => targetKey(o.t) === pick)?.t ?? (fallback ? { form: fallback.id } : { newForm: 'female' as BodyFigure });

  const addGarment = (kind: GarmentKind) => {
    const now = () => useStore.getState().sceneGraph.nodes;
    if ('loose' in chosen) {
      const node = newLooseGarmentNode(now(), kind, chosen.loose);
      addClothNode(node);
      frameForm({ pos: node.pos });
    } else {
      let on = 'form' in chosen ? forms.find((f) => f.id === chosen.form) : undefined;
      if (!on) {
        on = newFormNode(now(), 'newForm' in chosen ? chosen.newForm : 'female');
        addClothNode(on, false);
        frameForm(on);
        setPick('');
      }
      addClothNode(newGarmentNode(now(), kind, on));
    }
    onPlaced?.();
  };

  // Over the selected body, unless that is cloth (a sheet over a sheet is laid in the open).
  const addSheet = () => {
    addClothNode(sheetNode(useStore.getState().sceneGraph.nodes, selected && !selected.cloth ? selected : null));
    onPlaced?.();
  };

  const addForm = () => {
    const figure: BodyFigure = 'newForm' in chosen ? chosen.newForm : 'loose' in chosen ? chosen.loose : 'female';
    const form = newFormNode(useStore.getState().sceneGraph.nodes, figure);
    addClothNode(form);
    frameForm(form);
    setPick('');
    onPlaced?.();
  };

  const tile = 'py-1.5 px-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:border-purple-300 hover:text-purple-700 dark:hover:text-purple-300 transition-colors cursor-pointer truncate';
  return (
    <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
      <button onClick={() => setOpen(!open)} title="Cloth: plain sheets to drape or tie up, and garments cut into pattern pieces and sewn"
        className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 cursor-pointer">
        <span>🧵 Fabrics</span>
        <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500 font-normal normal-case">{open ? '[−]' : '[+]'}</span>
      </button>
      {open && (
        <>
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            <button onClick={addSheet} title="A sheet of cloth over the selected body (or held up in the open): it drapes when the scene plays; tie its corners from its Cloth card"
              className={tile}>
              Cloth sheet
            </button>
            <button onClick={addForm} title="Add a standalone dress form to the scene to fit garments onto (switch female/male or measurements in its card)"
              className={tile}>
              Dress form
            </button>
          </div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Garments</div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
            <span className="shrink-0">On</span>
            <select value={targetKey(chosen)} onChange={(e) => setPick(e.target.value)} title="A dress form to fit it to, or none: cut to a figure's usual sizes, it falls"
              className="flex-1 min-w-0 text-[11px] border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 bg-white dark:bg-slate-800 cursor-pointer">
              {targets.map((o) => <option key={targetKey(o.t)} value={targetKey(o.t)}>{o.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {GARMENT_KINDS.map((k) => (
              <button key={k.id} onClick={() => addGarment(k.id)} title={'loose' in chosen ? `A ${k.label.toLowerCase()} on no form: it falls when the scene plays` : `A ${k.label.toLowerCase()} on the form, one layer over what it wears; shape it from its Garment card`}
                className={tile}>
                {k.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
