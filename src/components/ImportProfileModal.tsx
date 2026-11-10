// The profile importer: an SVG, or the outline of a part traced from a photo
// or a logo, made into a flat part of some thickness. The work is in
// utils/profileImport.ts; this picks the file and shows what will be made.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Shapes, AlertCircle, Info } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import {
  svgProfile,
  traceProfile,
  profileNode,
  PROFILE_DEFAULTS,
  type Profile,
  type ProfileDetail,
  type ProfileSubject,
  type TraceResult,
} from '../utils/profileImport';
import { decodeImageFile, type DecodedImage } from '../utils/decodeImage';
import { useSettled } from '../hooks/useSettled';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import type { SceneNode } from '../types/scene';

/** Tracing is per pixel; past this a photo only adds time. */
const MAX_TRACE_PX = 1000;

type Source =
  | { kind: 'svg'; name: string; text: string }
  | { kind: 'image'; name: string; image: DecodedImage };

/** Which dimension the user typed. The other follows from the outline's shape. */
type Size = { axis: 'width' | 'height'; mm: number } | null;

const inputClass =
  'w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-emerald-500';

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block space-y-1" title={hint}>
    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    {children}
  </label>
);

/** A caption over a group of buttons: a <div>, since a <label> would press the first button when the caption is clicked. */
const Group: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="space-y-1" title={hint}>
    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    {children}
  </div>
);

const Segmented = <T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; hint: string }[]; onChange: (v: T) => void;
}) => (
  <div className="flex gap-1">
    {options.map((o) => (
      <button key={o.value} title={o.hint} onClick={() => onChange(o.value)}
        className={`flex-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${
          value === o.value
            ? 'bg-emerald-600 border-emerald-600 text-white'
            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}>
        {o.label}
      </button>
    ))}
  </div>
);

/** The shapes as an SVG path, y flipped back to screen-down. */
function previewPath(p: Profile): string {
  const ring = (l: { x: number; y: number }[]) =>
    'M' + l.map((q) => `${q.x.toFixed(2)},${(-q.y).toFixed(2)}`).join('L') + 'Z';
  return p.shapes.map((s) => [s.outline, ...s.holes].map(ring).join('')).join('');
}

export const ImportProfileModal: React.FC<{
  onClose: () => void;
  onImportNode: (node: SceneNode) => void;
  initialFile?: File | null;
}> = ({ onClose, onImportNode, initialFile }) => {
  useEscapeToClose(true, onClose);
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [size, setSize] = useState<Size>(null);
  const [thicknessMm, setThicknessMm] = useState(PROFILE_DEFAULTS.thicknessMm);
  const [subject, setSubject] = useState<ProfileSubject>(PROFILE_DEFAULTS.subject);
  const [detail, setDetail] = useState<ProfileDetail>(PROFILE_DEFAULTS.detail);
  /** null: the threshold the picture picks for itself. */
  const [threshold, setThreshold] = useState<number | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setLoading(true);
    setSize(null);
    setThreshold(null);
    const name = file.name.replace(/\.[^.]+$/, '');
    try {
      if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') {
        setSource({ kind: 'svg', name, text: await file.text() });
      } else if (file.type.startsWith('image/')) {
        setSource({ kind: 'image', name, image: await decodeImageFile(file, MAX_TRACE_PX) });
      } else {
        setSource(null);
        setError(`"${file.name}" is neither an SVG nor a picture.`);
      }
    } catch (e) {
      setSource(null);
      setError(`Could not read "${file.name}": ${(e as Error)?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Reading the dropped file is what this mount exists to start.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialFile) void handleFile(initialFile);
  }, [initialFile, handleFile]);

  // Held still while a slider moves: a trace is a pass over every pixel.
  const live = useMemo(() => ({ size, subject, detail, threshold }), [size, subject, detail, threshold]);
  const settled = useSettled(live, 200);
  const pending = settled !== live;

  const result = useMemo((): { profile: Profile | null; error: string | null } => {
    if (!source) return { profile: null, error: null };
    const sized = settled.size ? { [settled.size.axis === 'width' ? 'widthMm' : 'heightMm']: settled.size.mm } : {};
    try {
      if (source.kind === 'svg') return { profile: svgProfile(source.text, sized), error: null };
      const { image } = source;
      return {
        profile: traceProfile(image.data, image.width, image.height, {
          ...sized,
          subject: settled.subject,
          detail: settled.detail,
          ...(settled.threshold !== null ? { threshold: settled.threshold } : {}),
        }),
        error: null,
      };
    } catch (e) {
      return { profile: null, error: (e as Error)?.message || String(e) };
    }
  }, [source, settled]);
  const profile = result.profile;
  const traced = source?.kind === 'image' ? (profile as TraceResult | null) : null;

  const viewBox = useMemo(() => {
    if (!profile) return '0 0 1 1';
    const pad = Math.max(profile.widthMm, profile.heightMm) * 0.04;
    return `${-profile.widthMm / 2 - pad} ${-profile.heightMm / 2 - pad} ${profile.widthMm + 2 * pad} ${profile.heightMm + 2 * pad}`;
  }, [profile]);

  const handleImport = () => {
    if (!profile || !source) return;
    onImportNode(profileNode(profile, { name: source.name, thicknessMm }));
    onClose();
  };

  const stop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Shapes className="w-5 h-5 text-emerald-500" />
            <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base">Import Profile</h3>
          </div>
          <button aria-label="Close" title="Close" onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          <div
            onDragEnter={(e) => { stop(e); setIsDragging(true); }}
            onDragOver={(e) => { stop(e); e.dataTransfer.dropEffect = 'copy'; setIsDragging(true); }}
            onDragLeave={(e) => { stop(e); if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragging(false); }}
            onDrop={(e) => { stop(e); setIsDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
            className={`border-2 border-dashed rounded-xl p-5 text-center transition-colors ${
              isDragging
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                : 'border-slate-300 dark:border-slate-700 hover:border-emerald-500 bg-slate-50 dark:bg-slate-800/40'
            }`}
          >
            <input type="file" accept=".svg,image/*" id="profile-file-upload" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
            <label htmlFor="profile-file-upload" className="cursor-pointer flex flex-col items-center gap-1.5">
              <Shapes className="w-7 h-7 text-slate-400 dark:text-slate-500" />
              <span className="font-medium text-sm text-slate-700 dark:text-slate-200">
                {isDragging ? 'Drop to import' : source ? source.name : 'Click to select or drag an SVG, a logo or a photo'}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500">
                An SVG keeps its shapes. A picture is traced: the part against its background.
              </span>
            </label>
          </div>

          {(error || result.error) && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs rounded-lg border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error || result.error}</span>
            </div>
          )}
          {loading && <p className="text-center text-xs text-emerald-500 animate-pulse">Reading…</p>}

          {source && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 flex items-center justify-center p-2 min-h-48">
                {profile ? (
                  <svg viewBox={viewBox} className={`w-full max-h-64 transition-opacity ${pending ? 'opacity-40' : ''}`}>
                    <path d={previewPath(profile)} fillRule="evenodd" className="fill-emerald-500/70 stroke-emerald-700 dark:stroke-emerald-300"
                      strokeWidth={Math.max(profile.widthMm, profile.heightMm) / 300} />
                  </svg>
                ) : (
                  <span className="text-xs text-slate-400">No outline</span>
                )}
              </div>

              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width (mm)" hint="The part's real width. The height follows.">
                    <NumberInput step={1} min={1} max={4000} aria-label="Profile width in mm" className={inputClass}
                      value={profile ? Number(profile.widthMm.toFixed(1)) : 0}
                      onChange={(v) => v !== undefined && v > 0 && setSize({ axis: 'width', mm: v })} />
                  </Field>
                  <Field label="Height (mm)" hint="Or give the height, and the width follows.">
                    <NumberInput step={1} min={1} max={4000} aria-label="Profile height in mm" className={inputClass}
                      value={profile ? Number(profile.heightMm.toFixed(1)) : 0}
                      onChange={(v) => v !== undefined && v > 0 && setSize({ axis: 'height', mm: v })} />
                  </Field>
                  <Field label="Thickness (mm)" hint="How far the outline is extruded. A slider on the part afterwards.">
                    <NumberInput step={0.5} min={0.4} max={500} aria-label="Profile thickness in mm" className={inputClass}
                      value={thicknessMm} onChange={(v) => v !== undefined && v > 0 && setThicknessMm(v)} />
                  </Field>
                </div>

                {source.kind === 'image' && (
                  <div className="space-y-2.5">
                    <Group label="The part is" hint="Auto: whatever does not touch the edge of the picture.">
                      <Segmented value={subject} onChange={setSubject} options={[
                        { value: 'auto', label: 'Auto', hint: 'The background is what touches the edge of the picture' },
                        { value: 'dark', label: 'Dark', hint: 'The dark tone is the part' },
                        { value: 'light', label: 'Light', hint: 'The light tone is the part' },
                      ]} />
                    </Group>
                    <Group label="Detail" hint="Fine follows every bump; coarse smooths shadows and paper texture.">
                      <Segmented value={detail} onChange={setDetail} options={[
                        { value: 'fine', label: 'Fine', hint: 'Every bump of the outline' },
                        { value: 'normal', label: 'Normal', hint: 'A little smoothing' },
                        { value: 'coarse', label: 'Coarse', hint: 'Smooths shadows, texture and noise' },
                      ]} />
                    </Group>
                    <Field label={`Threshold${threshold === null ? ' (auto)' : ''}`} hint="Where part and background divide. Starts where the picture's two tones split.">
                      <div className="flex items-center gap-2">
                        <input type="range" min={2} max={98} step={1} aria-label="Trace threshold"
                          value={Math.round((threshold ?? traced?.threshold ?? 0.5) * 100)}
                          onChange={(e) => setThreshold(Number(e.target.value) / 100)}
                          className="flex-1 accent-emerald-600" />
                        {threshold !== null && (
                          <button onClick={() => setThreshold(null)} className="text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">Auto</button>
                        )}
                      </div>
                    </Field>
                  </div>
                )}

                {profile && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {profile.shapes.length} shape{profile.shapes.length === 1 ? '' : 's'},{' '}
                    {(() => { const h = profile.shapes.reduce((n, s) => n + s.holes.length, 0); return `${h} hole${h === 1 ? '' : 's'}.`; })()}
                    {traced?.byAlpha && ' Traced by transparency.'}
                    {' '}To cut it into a part: overlap them, select the part, Shift-click this, and Combine → Subtract.
                  </p>
                )}
                {profile?.notes.map((n) => (
                  <p key={n} className="flex gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-px" />{n}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            Cancel
          </button>
          <button onClick={handleImport} disabled={!profile || pending}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white shadow-xs transition-colors cursor-pointer">
            Import to Scene
          </button>
        </div>
      </div>
    </div>
  );
};
