import { useState } from 'react';
import { Grid3x3, Paintbrush, Shapes } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { SCULPT_BASES, type SculptBaseId } from '../../utils/sculptBases';
import type { SceneNode } from '../../types/scene';
import { ConfirmModal } from '../ConfirmModal';

/** The lattice and sculpt entry points, and a sculpt body's base shape. */
export function ModellingTools({ node }: { node: SceneNode }) {
  const latticeNodeId = useStore((s) => s.latticeNodeId);
  const sculptNodeId = useStore((s) => s.sculptNodeId);
  const setLatticeNodeId = useStore((s) => s.setLatticeNodeId);
  const setSculptBase = useStore((s) => s.setSculptBase);
  const setSculptNodeId = useStore((s) => s.setSculptNodeId);

  const [dialogModal, setDialogModal] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    tone: 'amber';
    onConfirm: () => void;
  } | null>(null);

  /**
   * Switches a sculpt body to a different base.
   *
   * Confirmed only once there is something to lose. Asking before the first
   * stroke would be a dialog in front of the one action every new sculpt starts
   * with — trying the shapes to see which one fits.
   */
  const handleSculptBaseClick = (node: SceneNode, base: SculptBaseId, label: string) => {
    if ((node.sculptBase || 'sphere') === base) return;
    if (node.sculptEdited) {
      setDialogModal({
        title: `Start over from the ${label} base?`,
        confirmLabel: 'Discard & start over',
        tone: 'amber',
        body: <p>The sculpting on this body will be discarded. You can undo with Ctrl+Z.</p>,
        onConfirm: () => {
          setDialogModal(null);
          setSculptBase(node.id, base);
        },
      });
      return;
    }
    setSculptBase(node.id, base);
  };

  return (
    <>
      {/* Lattice: only for bodies that ARE one. Unlike sculpting,
          this cannot be opened on an arbitrary mesh — the cage is the
          document and an imported STL does not have one. */}
      {node.isLattice && (
        <button
          type="button"
          onClick={() => setLatticeNodeId(node.id)}
          disabled={latticeNodeId === node.id}
          className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-bold transition-all bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 text-white cursor-pointer disabled:cursor-default"
          title="Open the lattice tools on this cage. Pauses the simulation."
        >
          <Grid3x3 className="w-3.5 h-3.5" />
          {latticeNodeId === node.id ? 'Modelling…' : 'Edit Lattice'}
        </button>
      )}

      {/* Why the Edit Lattice button is gone. Without this the body
          simply stops offering the tools it offered a minute ago. */}
      {node.latticeBaked && !node.isLattice && (
        <p className="text-[10px] leading-snug text-slate-400 px-1">
          <strong className="text-slate-500">Lattice applied.</strong> The mesh is now edited
          directly; the cage is kept in the file but does not drive the shape.
          <span className="whitespace-nowrap"> Ctrl+Z</span> puts it back.
        </p>
      )}

      {/* Sculpt: offered for any body carrying a mesh, not only for one
          that started as clay — an imported STL or a boolean result is
          a perfectly good thing to push around by hand.

          On a LATTICE body it first applies the cage. The two tools
          cannot share a mesh: the cage rebuilds it from scratch on
          every edit, so sculpting under a live cage is work that
          disappears the next time a face moves — silently, and long
          after the decision that cost it. Baking says so up front,
          and it is an ordinary undo step. */}
      {/* Not on a boolean body: what it shows is a mesh rebuilt from
          its primitives on every change, so a stroke on it could
          only ever be thrown away by the next compile. */}
      {!node.csgEnabled && node.geoms?.some((g) => g.type === 'mesh' && !g.csgDerived && g.renderVertices?.length) && (
        <button
          type="button"
          onClick={() => {
            if (node.isLattice) {
              const targetId = node.id;
              setDialogModal({
                title: 'Apply lattice and start sculpting?',
                confirmLabel: 'Apply lattice & sculpt',
                tone: 'amber',
                body: (
                  <p>
                    Sculpting applies the lattice: this mesh stops being built from its cage,
                    and the lattice tools close on it for good. The cage stays in the file, and
                    Ctrl+Z puts it back.
                  </p>
                ),
                onConfirm: () => {
                  setDialogModal(null);
                  useStore.getState().bakeLattice(targetId);
                  setSculptNodeId(targetId);
                },
              });
              return;
            }
            setSculptNodeId(node.id);
          }}
          disabled={sculptNodeId === node.id}
          className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-bold transition-all bg-sky-600 hover:bg-sky-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 text-white cursor-pointer disabled:cursor-default"
          title={node.isLattice
            ? 'Applies the lattice first: the cage stops driving this mesh, and sculpting takes over. Undoable.'
            : 'Open the sculpting tools on this mesh. Pauses the simulation.'}
        >
          <Paintbrush className="w-3.5 h-3.5" />
          {sculptNodeId === node.id
            ? 'Sculpting…'
            : node.isLattice ? 'Apply Lattice & Sculpt' : 'Sculpt This Mesh'}
        </button>
      )}

      {/* Base shape. Only for bodies that started as clay: replacing
          the mesh of an imported STL with a humanoid would be a
          delete wearing a dropdown's clothes. */}
      {node.isSculpt && (
        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
            <Shapes className="w-3.5 h-3.5 text-sky-500" /> Base Shape
          </h3>
          <div className="grid grid-cols-3 gap-1.5">
            {SCULPT_BASES.map((base) => (
              <button
                key={base.id}
                type="button"
                onClick={() => handleSculptBaseClick(node, base.id, base.label)}
                title={base.description}
                className={`py-1.5 px-1 rounded-lg border text-[10px] font-semibold transition-all cursor-pointer truncate ${
                  (node.sculptBase || 'sphere') === base.id
                    ? 'bg-sky-50 border-sky-400 text-sky-700'
                    : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                }`}
              >
                {base.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-slate-500">
            {(SCULPT_BASES.find((b) => b.id === (node.sculptBase || 'sphere')) ?? SCULPT_BASES[0]).description}
          </p>
          {node.sculptEdited && (
            <p className="text-[10px] leading-snug text-amber-600">
              This body has been sculpted. Changing the base starts it over.
            </p>
          )}
        </div>
      )}
      {dialogModal && (
        <ConfirmModal {...dialogModal} onCancel={() => setDialogModal(null)} />
      )}
    </>
  );
}
