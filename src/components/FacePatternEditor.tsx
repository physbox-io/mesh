import React, { useEffect, useState } from 'react';
import { X, AlertCircle, Sparkles, Trash2 } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { findNodeById } from '../utils/sceneTree';
import { PATTERN_GROUPS, SURFACE_PATTERNS, patternById, type PatternOptions } from '../utils/surfacePatterns';
import {
  DEFAULT_TEXTURE_BORDER_M,
  DEFAULT_TEXTURE_CELL_M,
  type SurfaceTexture,
  type TextureProjection,
  type TextureRegionReport,
  type TexturedSurface,
} from '../utils/surfaceTexture';
import { geomHalfLen } from '../utils/geomSurface';
import { requestTexturedSurface } from '../utils/textureClient';
import type { FacePatternGlowEvent, FacePatternTarget } from '../utils/facePatternPick';
import { Field, PatternFields, inputClass } from './PatternFields';
import { hexToRgb, rgbToHex } from '../utils/hexColor';

/**
 * One of the Generators patterns, put on a face of a part that is already in
 * the scene (T, "Pattern a face" in the mode menu or the Texture tab).
 *
 * It sits in the inspector's Texture tab rather than over the model, because
 * the preview IS the part: Apply writes the pattern to the scene, the viewport
 * rebuilds the patterned surface in a worker, and the editor stays open to
 * change it and apply again.
 * Done applies and closes; Cancel puts back what was there. Until something is
 * applied the face picked is lit up, so it is plain which face it is. The
 * physics never sees any of it (see utils/geomSurface).
 */

/** Patterns that can go on a face: a through-cut needs a whole board to cut through. */
const FACE_PATTERNS = SURFACE_PATTERNS.filter((p) => !p.throughCut);

const DEFAULT_DEPTH_MM = 1.5;
/** Lettering wants finer triangles than a texture: a letter's stroke is a millimetre or two. A picture's detail is a pixel. */
const FIGURE_CELL_M = 0.00025;
const fineCell = (spec: { figure?: boolean; wraps?: boolean }) => !!(spec.figure || spec.wraps);
const FIGURE_DEPTH_MM = 1;

const mm = (m: number) => Math.round(m * 1e5) / 100;

function newTexture(target: FacePatternTarget): SurfaceTexture {
  // The first texture, unless the pick asked for one (Text on a face).
  const spec = (target.pattern && patternById(target.pattern)) || FACE_PATTERNS.find((p) => !p.figure) || FACE_PATTERNS[0];
  return {
    pattern: spec.id,
    options: { ...spec.defaults },
    depthM: -(spec.figure ? FIGURE_DEPTH_MM : DEFAULT_DEPTH_MM) / 1000,
    borderM: DEFAULT_TEXTURE_BORDER_M,
    cellM: fineCell(spec) ? FIGURE_CELL_M : DEFAULT_TEXTURE_CELL_M,
    seedAt: target.seedAt,
    seedNormal: target.seedNormal,
  };
}

const LAYOUT_NAMES = { planar: 'Projected flat', cylindrical: 'Unrolled round the cylinder', unwrap: 'Unwrapped' } as const;

/** One line or two on how the face was laid out, when that is worth knowing. */
function layoutNotes(region: TextureRegionReport): string[] {
  const notes: string[] = [];
  const how = region.projection ? LAYOUT_NAMES[region.projection] : null;
  if (region.wrap && !region.wrap.blended && Math.abs(region.wrap.scaled - 1) >= 0.005) {
    const pct = Math.round(Math.abs(region.wrap.scaled - 1) * 1000) / 10;
    notes.push(`${how}: the pattern is ${pct} % ${region.wrap.scaled > 1 ? 'larger' : 'smaller'} so it meets itself all the way round.`);
  } else if (region.wrap?.blended) {
    notes.push(`${how}: the pattern does not repeat, so it is blended where it meets itself.`);
  } else if (region.capped) {
    notes.push('This part has no edges to stop at, so the pattern covers the side facing where you clicked.');
  } else if (region.seam) {
    notes.push(`${how}: it had to be cut open to lie flat, and the cut, on the far side, is left plain.`);
  } else if (region.projection && region.projection !== 'planar') {
    notes.push(`${how}.`);
  }
  return notes;
}

const targetKey = (t: FacePatternTarget | null) =>
  t ? `${t.nodeId}|${t.geomName}|${t.index ?? 'new'}|${t.seedAt.join(',')}` : null;

export const FacePatternEditor: React.FC = () => {
  const target = useStore((s) => s.facePatternTarget);
  const closeFacePattern = useStore((s) => s.closeFacePattern);
  const setGeomTextures = useStore((s) => s.setGeomTextures);
  const geom = useStore((s) => {
    if (!s.facePatternTarget) return null;
    const node = findNodeById(s.sceneGraph.nodes, s.facePatternTarget.nodeId);
    return node?.geoms?.find((g) => g.name === s.facePatternTarget!.geomName) ?? null;
  });

  // What the geom had when the dialog opened, which Cancel puts back, and
  // where in its list the pattern being edited sits.
  const [before, setBefore] = useState<SurfaceTexture[] | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<SurfaceTexture | null>(null);
  // What is in the scene now: the pattern as last applied, or null for none yet.
  const [applied, setApplied] = useState<SurfaceTexture | null>(null);
  const [report, setReport] = useState<TexturedSurface | null>(null);
  // Fetching a font and laying the text out, before Apply can write it.
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);

  /*
   * Seeded when the dialog opens on a face, folded in during render as the
   * board generator does, so the first frame never shows another face's
   * pattern.
   */
  const [synced, setSynced] = useState<string | null>(null);
  const key = targetKey(target);
  if (key !== synced) {
    setSynced(key);
    if (target && geom) {
      const existing = geom.textures ?? [];
      const editing = target.index !== undefined && existing[target.index] ? target.index : undefined;
      setBefore(geom.textures);
      setIndex(editing ?? existing.length);
      setDraft(editing !== undefined ? existing[editing] : newTexture(target));
      setApplied(editing !== undefined ? existing[editing] : null);
      setReport(null);
      setPrepError(null);
    } else {
      setDraft(null);
    }
  }

  // The face lit up until there is a pattern on it to show where it is.
  const glowAt: FacePatternGlowEvent = target && !applied && synced === key ? target : null;
  useEffect(() => {
    if (!glowAt) return;
    const send = (detail: FacePatternGlowEvent) => { window.dispatchEvent(new CustomEvent('physbox:pattern-glow', { detail })); };
    send(glowAt);
    return () => send(null);
  }, [glowAt]);

  // The same build the viewport draws, for its numbers and its warnings.
  useEffect(() => {
    if (!geom?.textures?.length) return;
    let live = true;
    void requestTexturedSurface(geom, geomHalfLen(geom)).then((surface) => { if (live) setReport(surface); });
    return () => { live = false; };
  }, [geom]);

  const cancel = () => {
    if (target) setGeomTextures(target.nodeId, target.geomName, before);
    closeFacePattern();
  };
  useEscapeToClose(!!target, cancel);

  if (!target || !draft) return null;
  const spec = patternById(draft.pattern) ?? FACE_PATTERNS[0];
  const options: PatternOptions = { ...spec.defaults, ...(draft.options ?? {}) };
  const editingExisting = !!before && index < before.length;

  const patch = (p: Partial<SurfaceTexture>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const setOption = (k: string, v: number | string | undefined) => {
    if (v === undefined) return;
    patch({ options: { ...options, [k]: v } });
  };
  const choosePattern = (id: string) => {
    const next = patternById(id);
    if (!next) return;
    // Lettering's finer default, only while the detail is still a default.
    const cell = draft.cellM ?? DEFAULT_TEXTURE_CELL_M;
    const stock = cell === DEFAULT_TEXTURE_CELL_M || cell === FIGURE_CELL_M;
    patch({
      pattern: id,
      options: { ...next.defaults },
      ...(stock ? { cellM: fineCell(next) ? FIGURE_CELL_M : DEFAULT_TEXTURE_CELL_M } : {}),
    });
    setPrepError(null);
  };

  const emboss = draft.depthM > 0;
  const depthMm = Math.abs(draft.depthM) * 1000;
  const region = report?.regions[index];
  const pending = !region || synced !== key;
  const warnings = (report?.warnings ?? []).filter((w) => w.startsWith(`Pattern ${index + 1}:`) || !w.startsWith('Pattern '));
  const notes = !applied || pending || !region.applied ? [] : layoutNotes(region);

  const apply = async (): Promise<boolean> => {
    let ready = draft;
    if (spec.prepare) {
      setPreparing(true);
      setPrepError(null);
      try {
        ready = { ...draft, options: await spec.prepare(options) };
      } catch (e) {
        setPrepError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setPreparing(false);
      }
    }
    const list = [...(before ?? [])];
    list[index] = ready;
    setGeomTextures(target.nodeId, target.geomName, list);
    setDraft(ready);
    setApplied(ready);
    // The numbers shown were the last build's; these say building until this one is in.
    setReport(null);
    return true;
  };
  const done = async () => {
    if (draft !== applied && !(await apply())) return;
    closeFacePattern();
  };

  const remove = () => {
    const list = (before ?? []).filter((_, i) => i !== index);
    setGeomTextures(target.nodeId, target.geomName, list.length ? list : undefined);
    closeFacePattern();
  };

  return (
    // No <h3> for the title: the inspector folds any card whose h3 is clicked,
    // and folding this one would hide its Apply and Done.
    <div className="flex flex-col bg-white dark:bg-slate-900 rounded-lg shadow-sm border border-fuchsia-200 dark:border-fuchsia-900/60">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-fuchsia-500" />
          <span className="font-bold text-slate-800 dark:text-slate-100 text-sm">{spec.figure ? 'Text on a face' : 'Pattern on a face'}</span>
        </div>
        <button
          onClick={cancel}
          className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <Field label="Pattern" hint={spec.blurb}>
          <select value={spec.id} onChange={(e) => choosePattern(e.target.value)} className={`${inputClass} cursor-pointer`}>
            {PATTERN_GROUPS.map((group) => {
              const inGroup = FACE_PATTERNS.filter((p) => (p.group ?? 'Nature') === group);
              return inGroup.length === 0 ? null : (
                <optgroup key={group} label={group}>
                  {inGroup.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>
              );
            })}
          </select>
        </Field>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{spec.blurb}</p>

        <PatternFields spec={spec} options={options} onChange={setOption} />

        <div className="pt-1 border-t border-slate-200 dark:border-slate-800" />

        <div className="grid grid-cols-2 gap-2">
          <Field label="Into the face" hint={spec.figure
            ? 'Engrave cuts the letters into the face (intaglio). Emboss raises them from it.'
            : 'Engrave sinks the pattern into the face. Emboss stands it proud of it.'}>
            <select
              value={emboss ? 'emboss' : 'engrave'}
              onChange={(e) => patch({ depthM: (e.target.value === 'emboss' ? 1 : -1) * Math.abs(draft.depthM) })}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="engrave">{spec.figure ? 'Engrave (cut in)' : 'Engrave'}</option>
              <option value="emboss">{spec.figure ? 'Emboss (raised)' : 'Emboss'}</option>
            </select>
          </Field>
          <Field label={emboss ? 'Height (mm)' : 'Depth (mm)'} hint="How far the deepest point sits below the face, or the highest above it.">
            <NumberInput
              min={0.1} max={20} step={0.1} fallbackOnBlur={DEFAULT_DEPTH_MM}
              value={depthMm}
              onChange={(v) => { if (v !== undefined && v > 0) patch({ depthM: (emboss ? 1 : -1) * v / 1000 }); }}
              className={inputClass}
            />
          </Field>
          <Field label="Border (mm)" hint="A plain rim this wide is left round the edge of the face.">
            <NumberInput
              min={0} max={100} step={0.5} fallbackOnBlur={mm(DEFAULT_TEXTURE_BORDER_M)}
              value={mm(draft.borderM ?? DEFAULT_TEXTURE_BORDER_M)}
              onChange={(v) => { if (v !== undefined) patch({ borderM: v / 1000 }); }}
              className={inputClass}
            />
          </Field>
          <Field label="Detail (mm)" hint="The size of the triangles the pattern is built from. Smaller is crisper and slower.">
            <NumberInput
              min={0.15} max={5} step={0.05} fallbackOnBlur={mm(DEFAULT_TEXTURE_CELL_M)}
              value={mm(draft.cellM ?? DEFAULT_TEXTURE_CELL_M)}
              onChange={(v) => { if (v !== undefined && v > 0) patch({ cellM: v / 1000 }); }}
              className={inputClass}
            />
          </Field>
          <Field label="Rotate (°)" hint="Turns the pattern on the face.">
            <NumberInput
              min={-360} max={360} step={15} fallbackOnBlur={0}
              value={draft.twistDeg ?? 0}
              onChange={(v) => { if (v !== undefined) patch({ twistDeg: v }); }}
              className={inputClass}
            />
          </Field>
          <Field label="Scale (×)" hint="Draws every feature of the pattern this much bigger.">
            <NumberInput
              min={0.1} max={10} step={0.1} fallbackOnBlur={1}
              value={draft.scale ?? 1}
              onChange={(v) => { if (v !== undefined && v > 0) patch({ scale: v }); }}
              className={inputClass}
            />
          </Field>
          <Field label="Lay out" hint="How a curved face is flattened for the pattern. Auto picks: flat faces are projected, a cylinder is unrolled, anything else is unwrapped so the pattern's cells stay square.">
            <select
              value={draft.projection ?? 'auto'}
              onChange={(e) => patch({ projection: e.target.value === 'auto' ? undefined : (e.target.value as TextureProjection) })}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="auto">Auto</option>
              <option value="planar">Flat</option>
              <option value="cylindrical">Wrap round</option>
              <option value="unwrap">Unwrap</option>
            </select>
          </Field>
        </div>

        <Field label="Colour" hint={`Paints ${spec.figure ? 'the letters' : emboss ? 'what stands proud' : 'what is sunk'} in a colour of its own. It is drawn that way and goes into the 3MF as a second filament.`}>
          <div className="flex items-center gap-2">
            <select
              value={draft.color ? 'own' : 'body'}
              onChange={(e) => patch({ color: e.target.value === 'own' ? [...useStore.getState().paintColor] : undefined })}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="body">{spec.palette ? 'The pattern\'s own' : 'The body\'s'}</option>
              <option value="own">{spec.figure ? 'Colour the letters' : 'Colour the pattern'}</option>
            </select>
            {draft.color && (
              <input
                type="color"
                value={rgbToHex(draft.color)}
                onChange={(e) => patch({ color: hexToRgb(e.target.value) })}
                className="w-8 h-7 p-0 border-0 bg-transparent cursor-pointer shrink-0"
                aria-label="Pattern colour"
              />
            )}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-lg">
            <div className="text-slate-400">Face</div>
            <div className="font-semibold text-slate-700 dark:text-slate-200">
              {!applied || pending || !region.applied ? '—' : `${mm(region.extentM[0])} × ${mm(region.extentM[1])} mm`}
            </div>
          </div>
          <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-lg">
            <div className="text-slate-400">Triangles</div>
            <div className="font-semibold text-slate-700 dark:text-slate-200">
              {!applied ? '—' : pending ? 'building…' : region.triangles.toLocaleString()}
            </div>
          </div>
        </div>

        {prepError && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60">
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-rose-700 dark:text-rose-300 leading-relaxed">{prepError}</p>
          </div>
        )}

        {notes.map((n) => (
          <p key={n} className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{n}</p>
        ))}

        {!applied && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            The lit face is where it goes. Apply to see it on the part.
          </p>
        )}

        {(!applied ? [] : region && !region.applied ? [region.reason ?? 'It could not be put on that face.'] : warnings).map((w) => (
          <div key={w} className="flex items-start gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{w.replace(/^Pattern \d+: /, '')}</p>
          </div>
        ))}

        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
          Drawn and exported with the pattern; simulated as the plain shape.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-slate-200 dark:border-slate-800">
        {editingExisting ? (
          <button
            onClick={remove}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remove
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <button
            onClick={cancel}
            className="px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={() => void apply()}
            disabled={draft === applied || preparing}
            className="px-3 py-1.5 text-xs font-semibold text-fuchsia-700 dark:text-fuchsia-300 border border-fuchsia-300 dark:border-fuchsia-800 hover:bg-fuchsia-50 dark:hover:bg-fuchsia-950/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default rounded-lg transition-colors cursor-pointer"
          >
            {preparing ? (spec.figure ? 'Loading font…' : 'Reading picture…') : 'Apply'}
          </button>
          <button
            onClick={() => void done()}
            disabled={preparing}
            className="px-4 py-1.5 text-xs font-bold text-white bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
