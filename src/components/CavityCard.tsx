// "Measure cavity": the air inside a watertight body, for a speaker in Volt.
//
// Shown for any body with a mesh. The measurement is kept in the cavity store,
// which a linked Volt reads as output channels; unlinked, it can open Volt
// with the numbers in the link instead.

import { useState } from 'react';
import { Box } from 'lucide-react';
import type { SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import { useCavityStore } from '../store/cavityStore';
import { bodyMesh, measureBodyCavity } from '../utils/cavity';
import { buildVoltCavityUrl } from '../utils/voltHandoff';

const fmt = (v: number, digits = 3) => Number(v.toPrecision(digits)).toString();

export function CavityCard({ node }: { node: SceneNode }) {
  const linked = useStore((s) => !!s.voltLink);
  const measured = useCavityStore((s) => s.measured[node.name]);
  const setCavity = useCavityStore((s) => s.setCavity);
  const [error, setError] = useState<string | null>(null);
  if (!bodyMesh(node)) return null;

  const measure = () => {
    const r = measureBodyCavity(node);
    if (!r.ok) {
      setError(r.reason);
      return;
    }
    setError(null);
    setCavity(node.name, {
      volume: r.cavity.volume,
      ...(r.cavity.port ? { portLength: r.cavity.port.length, portRadius: r.cavity.port.radius } : {}),
    });
  };

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Box className="w-3.5 h-3.5 text-emerald-500" /> Cavity
      </h3>
      <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
        The air inside a watertight body, and its port if it cuts one as a cylinder: a speaker box for Volt.
      </p>
      <button
        type="button"
        onClick={measure}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded text-[10px] font-semibold text-emerald-700 transition-colors cursor-pointer"
      >
        Measure cavity
      </button>
      {error && <div className="text-[10px] text-red-600 leading-snug">{error}</div>}
      {measured && (
        <div className="text-[11px] text-slate-600 leading-snug">
          <div>Volume <b>{fmt(measured.volume * 1000)} L</b> ({fmt(measured.volume)} m³)</div>
          {measured.portLength !== undefined && measured.portRadius !== undefined && (
            <div>Port {fmt(measured.portLength * 1000)} mm long, {fmt(measured.portRadius * 1000)} mm radius</div>
          )}
          {linked ? (
            <div className="text-[10px] text-slate-400 mt-1">
              Published to Volt as body:{node.name}.cavityVolume{measured.portLength !== undefined ? ', .portLength, .portRadius' : ''}.
            </div>
          ) : (
            <a
              href={buildVoltCavityUrl(node.name, measured, document.title)}
              target="_blank"
              rel="noopener"
              className="inline-block mt-1 text-[10px] font-semibold text-emerald-700 underline"
            >
              Open in Volt
            </a>
          )}
        </div>
      )}
    </div>
  );
}
