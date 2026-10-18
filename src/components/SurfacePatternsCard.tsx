import React, { useEffect, useState } from 'react';
import { AlertCircle, Sparkles, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { SceneGeom, SceneNode } from '../types/scene';
import { patternById } from '../utils/surfacePatterns';
import { geomHalfLen } from '../utils/geomSurface';
import { requestTexturedSurface } from '../utils/textureClient';
import type { TexturedSurface } from '../utils/surfaceTexture';

/**
 * The inspector card for the Generators patterns laid on a part's faces (T).
 *
 * Each pattern is listed as the thing a person made — "Wood grain, engraved
 * 1.5 mm" — with Edit, which reopens the pattern dialog on it, and Remove.
 * A pattern that no longer fits its face (the face moved, or it overlaps
 * another) says so here, since nothing is drawn to show it. Shown only when the
 * part has a pattern; the card's <h3> is a direct child of its outer div, which
 * is the contract the inspector's fold-away headers are wired to.
 */
export const SurfacePatternsCard: React.FC<{ node: SceneNode }> = ({ node }) => {
  const playing = useStore((s) => s.isPlaying);
  const editing = useStore((s) => s.facePatternTarget?.nodeId === node.id);
  const geoms = (node.geoms ?? []).filter((g) => g.textures?.length);
  if (!geoms.length) return null;

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" /> Surface patterns
      </h3>
      {geoms.map((geom) => (
        <GeomPatterns key={geom.name} node={node} geom={geom} named={geoms.length > 1} disabled={editing || playing} />
      ))}
      <p className="text-[10px] text-slate-400 leading-snug">Or press T over a face to add one, or over a pattern to change it.</p>
    </div>
  );
};

const GeomPatterns: React.FC<{ node: SceneNode; geom: SceneGeom; named: boolean; disabled: boolean }> = ({ node, geom, named, disabled }) => {
  // The same build the viewport draws, for which patterns actually went on.
  const [surface, setSurface] = useState<TexturedSurface | null>(null);
  useEffect(() => {
    let live = true;
    void requestTexturedSurface(geom, geomHalfLen(geom)).then((s) => { if (live) setSurface(s); });
    return () => { live = false; };
  }, [geom]);

  const store = useStore.getState();
  const textures = geom.textures ?? [];
  const remove = (i: number) => {
    const list = textures.filter((_, k) => k !== i);
    store.setGeomTextures(node.id, geom.name, list.length ? list : undefined);
  };

  return (
    <>
      {textures.map((t, i) => {
        const report = surface?.regions.find((r) => r.index === i);
        const label = patternById(t.pattern)?.label ?? t.pattern;
        const how = `${t.depthM > 0 ? 'embossed' : 'engraved'} ${(Math.abs(t.depthM) * 1000).toFixed(1)} mm`;
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="flex-1 text-slate-600 truncate" title={named ? `On ${geom.name}` : undefined}>
                <span className="font-semibold">{label}</span>, {how}{named ? ` · ${geom.name}` : ''}
              </span>
              <button
                type="button"
                onClick={() => store.openFacePattern({ nodeId: node.id, geomName: geom.name, seedAt: t.seedAt, seedNormal: t.seedNormal ?? [0, 0, 1], index: i })}
                disabled={disabled}
                className="px-1.5 py-0.5 rounded text-[10px] text-slate-500 hover:bg-slate-100 cursor-pointer disabled:opacity-40"
                title="Change this pattern"
              >
                Edit…
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 cursor-pointer disabled:opacity-40"
                title="Take this pattern off"
                aria-label="Remove pattern"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {report && !report.applied ? (
              <p className="flex items-start gap-1 text-[10px] leading-snug text-amber-700 bg-amber-50 rounded-md px-2 py-1">
                <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                Not on the part: {report.reason}
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
};

export default SurfacePatternsCard;
