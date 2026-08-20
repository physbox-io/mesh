import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Image as ImageIcon, AlertCircle, Mountain, Waves, Triangle, Sparkles } from 'lucide-react';
import { NumberInput } from './NumberInput';
import {
  imageToHeightmapMesh,
  sampleLuminanceGrid,
  bimodality,
  detectLevels,
  DEFAULT_HEIGHTMAP_OPTIONS,
  type HeightmapMeshResult,
  type HeightMapping,
  type HeightProfile,
  type SlopeStyle,
} from '../utils/heightmapMesh';

interface ImportImageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportNode: (node: any) => void;
  /** File dropped onto the app window, loaded as soon as the dialog opens. */
  initialFile?: File | null;
}

/** Cap the decode size: a 6000px photo costs seconds to sample and buys nothing. */
const MAX_DECODE_PX = 1400;

interface LoadedImage {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function decodeImage(file: File): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Browser could not decode this image.'));
      img.src = url;
    });
    const scale = Math.min(1, MAX_DECODE_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not open a 2D canvas to read the image.');
    ctx.drawImage(img, 0, 0, w, h);
    return {
      name: file.name.replace(/\.[^.]+$/, ''),
      width: w,
      height: h,
      data: ctx.getImageData(0, 0, w, h).data,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Hillshade the sampled height grid so the preview reads as relief, not as a photo. */
function drawPreview(canvas: HTMLCanvasElement, mesh: HeightmapMeshResult, maxHeightM: number, widthM: number) {
  const { cols, rows, heights } = mesh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = cols;
  canvas.height = rows;
  const img = ctx.createImageData(cols, rows);
  // Light from the top-left, at the true aspect of the relief.
  const cell = widthM / (cols - 1);
  const zScale = maxHeightM / Math.max(cell, 1e-9);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r * cols + c];
      const hl = heights[r * cols + Math.max(0, c - 1)];
      const hr = heights[r * cols + Math.min(cols - 1, c + 1)];
      const hu = heights[Math.max(0, r - 1) * cols + c];
      const hd = heights[Math.min(rows - 1, r + 1) * cols + c];
      const nx = -(hr - hl) * 0.5 * zScale;
      const ny = (hd - hu) * 0.5 * zScale;
      const len = Math.hypot(nx, ny, 1) || 1;
      // Light direction (-0.5, 0.6, 0.7), normalised.
      const lambert = Math.max(0, (nx * -0.48 + ny * 0.57 + 0.67) / len);
      const shade = 0.28 + 0.55 * lambert + 0.22 * h;
      const v = Math.round(Math.min(1, shade) * 255);
      const i = (r * cols + c) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = Math.min(255, v + 8);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const inputClass =
  'w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-fuchsia-500';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block space-y-1">
    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    {children}
  </label>
);

export const ImportImageModal: React.FC<ImportImageModalProps> = ({
  isOpen,
  onClose,
  onImportNode,
  initialFile,
}) => {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [widthMm, setWidthMm] = useState(100);
  const [maxHeightMm, setMaxHeightMm] = useState(15);
  const [baseMm, setBaseMm] = useState(3);
  const [mapping, setMapping] = useState<HeightMapping>('white-high');
  const [gridCols, setGridCols] = useState(DEFAULT_HEIGHTMAP_OPTIONS.gridCols);
  const [smoothPasses, setSmoothPasses] = useState(1);
  const [floorPct, setFloorPct] = useState(0);
  const [profile, setProfile] = useState<HeightProfile>('grayscale');
  const [thresholdPct, setThresholdPct] = useState(50);
  const [slopeLevels, setSlopeLevels] = useState(2);
  const [slopeWidthMm, setSlopeWidthMm] = useState(4);
  const [slopeStyle, setSlopeStyle] = useState<SlopeStyle>('centred');

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setIsProcessing(true);
    if (!file.type.startsWith('image/')) {
      setError(`"${file.name}" is not an image file.`);
      setImage(null);
      setIsProcessing(false);
      return;
    }
    try {
      setImage(await decodeImage(file));
    } catch (err) {
      setError(`Failed to read image: ${String(err)}`);
      setImage(null);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  useEffect(() => {
    // Decoding the dropped file is the async work this mount exists to kick
    // off; the synchronous part is just raising the "processing" flag.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialFile) void handleFile(initialFile);
  }, [initialFile, handleFile]);

  const mesh = useMemo(() => {
    if (!image) return null;
    try {
      return imageToHeightmapMesh(image.data, image.width, image.height, {
        widthM: widthMm / 1000,
        maxHeightM: maxHeightMm / 1000,
        baseThicknessM: baseMm / 1000,
        mapping,
        gridCols,
        smoothPasses,
        floor: floorPct / 100,
        profile,
        threshold: thresholdPct / 100,
        slopeLevels,
        slopeWidthM: slopeWidthMm / 1000,
        slopeStyle,
      });
    } catch {
      return null;
    }
  }, [image, widthMm, maxHeightMm, baseMm, mapping, gridCols, smoothPasses, floorPct,
      profile, thresholdPct, slopeLevels, slopeWidthMm, slopeStyle]);

  /**
   * How two-tone the source is, sampled coarsely — a logo or stencil is where
   * the sloped profile earns its keep, and grayscale gives it vertical cliffs.
   */
  const toneStats = useMemo(() => {
    if (!image) return null;
    const lum = sampleLuminanceGrid(image.data, image.width, image.height, 96, 96);
    return { flat: bimodality(lum) > 0.9, levels: detectLevels(lum) };
  }, [image]);

  useEffect(() => {
    if (mesh && canvasRef.current) drawPreview(canvasRef.current, mesh, maxHeightMm / 1000, widthMm / 1000);
  }, [mesh, maxHeightMm, widthMm]);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleFile(file);
    e.target.value = '';
  };

  // Stop the drop here: App.tsx has a window-level handler that would
  // otherwise also see it and re-open this dialog on top of itself.
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  };

  const handleImportClick = () => {
    if (!mesh || !image) return;
    const id = `img_${Math.random().toString(36).slice(2, 7)}`;
    onImportNode({
      id,
      name: image.name || 'heightmap',
      pos: [0, 0, mesh.sizeM[2] / 2 + 0.05],
      geoms: [{
        name: `${id}_geom`,
        type: 'mesh',
        rgba: [0.75, 0.72, 0.68, 1],
        vertices: mesh.vertices,
        renderVertices: mesh.renderVertices,
        faces: mesh.faces,
        dynamic: true,
      }],
      joints: [{ name: `${id}_free`, type: 'free' }],
      children: [],
    });
    onClose();
  };

  const aspectNote = mesh
    ? `${(mesh.sizeM[0] * 1000).toFixed(0)} × ${(mesh.sizeM[1] * 1000).toFixed(0)} × ${(mesh.sizeM[2] * 1000).toFixed(1)} mm`
    : '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-fuchsia-500" />
            <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base">Import Image as 3D Relief</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          <div
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
              isDragging
                ? 'border-fuchsia-500 bg-fuchsia-50 dark:bg-fuchsia-950/40'
                : 'border-slate-300 dark:border-slate-700 hover:border-fuchsia-500 dark:hover:border-fuchsia-400 bg-slate-50 dark:bg-slate-800/40'
            }`}
          >
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
              id="heightmap-file-upload"
            />
            <label htmlFor="heightmap-file-upload" className="cursor-pointer flex flex-col items-center gap-2">
              <ImageIcon className="w-8 h-8 text-slate-400 dark:text-slate-500" />
              <span className="font-medium text-sm text-slate-700 dark:text-slate-200">
                {isDragging
                  ? 'Drop to import'
                  : image ? `${image.name} — ${image.width}×${image.height}px` : 'Click to select or drag a PNG / JPG / WebP'}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500">Grayscale brightness becomes height</span>
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs rounded-lg border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {isProcessing && (
            <p className="text-center text-xs text-fuchsia-500 animate-pulse">Decoding image…</p>
          )}

          {mesh && (
            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 flex items-center justify-center p-2">
                  <canvas
                    ref={canvasRef}
                    className="max-w-full max-h-56 rounded-md"
                    style={{ imageRendering: 'auto' }}
                  />
                </div>

                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                      <div className="text-slate-400">Grid</div>
                      <div className="font-semibold text-slate-700 dark:text-slate-200">{mesh.cols} × {mesh.rows}</div>
                    </div>
                    <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                      <div className="text-slate-400">Triangles</div>
                      <div className="font-semibold text-slate-700 dark:text-slate-200">{mesh.triangleCount.toLocaleString()}</div>
                    </div>
                  </div>
                  <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                    <div className="text-slate-400">Finished size</div>
                    <div className="font-semibold text-slate-700 dark:text-slate-200">{aspectNote}</div>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    The plaque is a watertight solid: relief on top, flat bottom, closed sides — ready for
                    3D print, relief carving or contour slicing.
                  </p>
                </div>
              </div>

              {/* Height mapping direction */}
              <div className="space-y-2">
                <label className="block font-semibold text-xs text-slate-700 dark:text-slate-300">Grayscale → Height:</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${mapping === 'white-high' ? 'border-fuchsia-500 bg-fuchsia-50/50 dark:bg-fuchsia-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="heightMapping" checked={mapping === 'white-high'} onChange={() => setMapping('white-high')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Mountain className="w-3.5 h-3.5 text-fuchsia-500" /> White is tallest
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Bright areas rise to z = max, black sits on the base</div>
                    </div>
                  </label>
                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${mapping === 'white-low' ? 'border-fuchsia-500 bg-fuchsia-50/50 dark:bg-fuchsia-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="heightMapping" checked={mapping === 'white-low'} onChange={() => setMapping('white-low')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Waves className="w-3.5 h-3.5 text-fuchsia-500" /> White is z = 0
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Dark areas rise — engraved look, and what a backlit lithophane wants</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Height profile */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-semibold text-xs text-slate-700 dark:text-slate-300">Height Profile:</label>
                  {toneStats?.flat && profile === 'grayscale' && (
                    <button
                      onClick={() => {
                        setProfile('sloped');
                        setSlopeLevels(toneStats.levels);
                      }}
                      className="flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:underline cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" />
                      {toneStats && toneStats.levels > 2
                        ? `${toneStats.levels}-tone image — try sloped edges`
                        : 'Two-tone image — try sloped edges'}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${profile === 'grayscale' ? 'border-fuchsia-500 bg-fuchsia-50/50 dark:bg-fuchsia-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="heightProfile" checked={profile === 'grayscale'} onChange={() => setProfile('grayscale')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <ImageIcon className="w-3.5 h-3.5 text-fuchsia-500" /> Grayscale tones
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Every tone is its own height — for photos and gradients</div>
                    </div>
                  </label>
                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${profile === 'sloped' ? 'border-fuchsia-500 bg-fuchsia-50/50 dark:bg-fuchsia-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="heightProfile" checked={profile === 'sloped'} onChange={() => setProfile('sloped')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Triangle className="w-3.5 h-3.5 text-fuchsia-500" /> Sloped edges
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Cut at a threshold, then ramp between top and bottom — for line art and logos</div>
                    </div>
                  </label>
                </div>
              </div>

              {profile === 'sloped' && (
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Levels">
                      <NumberInput step="1" min={2} max={16} integer value={slopeLevels} onChange={setSlopeLevels} className={inputClass} aria-label="Number of flat levels" />
                    </Field>
                    <Field label="Slope run (mm)">
                      <NumberInput step="0.5" min={0} max={200} value={slopeWidthMm} onChange={setSlopeWidthMm} className={inputClass} aria-label="Horizontal run of the slope in mm" />
                    </Field>
                    {/* Above two levels the cuts are evenly spaced, so a single
                        threshold has nothing left to say. */}
                    {slopeLevels === 2 && (
                      <Field label="Threshold (%)">
                        <NumberInput step="5" min={1} max={99} value={thresholdPct} onChange={setThresholdPct} className={inputClass} aria-label="Black/white cut threshold percent" />
                      </Field>
                    )}
                    {toneStats && toneStats.levels !== slopeLevels && (
                      <div className="flex items-end">
                        <button
                          onClick={() => setSlopeLevels(toneStats.levels)}
                          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                        >
                          Detected {toneStats.levels} tones — use
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {(['centred', 'inward', 'outward'] as SlopeStyle[]).map((style) => (
                      <button
                        key={style}
                        onClick={() => setSlopeStyle(style)}
                        className={`px-2.5 py-1 rounded-lg font-semibold capitalize transition-colors cursor-pointer border ${
                          slopeStyle === style
                            ? 'bg-fuchsia-600 border-fuchsia-600 text-white'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        {style}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {slopeStyle === 'centred' && 'Half the ramp each side of the outline — the shape keeps its original size.'}
                    {slopeStyle === 'inward' && 'Ramp is carved out of the shape — the footprint stays, the flat top shrinks.'}
                    {slopeStyle === 'outward' && 'Shape keeps its flat top and the ramp spreads into the background.'}
                    {slopeWidthMm > 0 && ` Draft angle ≈ ${(Math.atan2(maxHeightMm / (slopeLevels - 1), slopeWidthMm) * 180 / Math.PI).toFixed(0)}° from horizontal.`}
                    {slopeLevels > 2 && ` ${slopeLevels} flat treads, each riser climbing ${(maxHeightMm / (slopeLevels - 1)).toFixed(1)}mm.`}
                  </p>
                </div>
              )}

              {/* Dimensions */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Field label="Width (mm)">
                  <NumberInput step="5" min={1} max={5000} value={widthMm} onChange={setWidthMm} className={inputClass} aria-label="Plaque width in mm" />
                </Field>
                <Field label="Relief height (mm)">
                  <NumberInput step="1" min={0} max={500} value={maxHeightMm} onChange={setMaxHeightMm} className={inputClass} aria-label="Relief height in mm" />
                </Field>
                <Field label="Base thickness (mm)">
                  <NumberInput step="0.5" min={0.2} max={200} value={baseMm} onChange={setBaseMm} className={inputClass} aria-label="Base thickness in mm" />
                </Field>
                <Field label="Resolution (columns)">
                  <NumberInput step="20" min={2} max={400} integer value={gridCols} onChange={setGridCols} className={inputClass} aria-label="Sample columns" />
                </Field>
                <Field label="Smoothing passes">
                  <NumberInput step="1" min={0} max={8} integer value={smoothPasses} onChange={setSmoothPasses} className={inputClass} aria-label="Smoothing passes" />
                </Field>
                <Field label="Height floor (%)">
                  <NumberInput step="5" min={0} max={99} value={floorPct} onChange={setFloorPct} className={inputClass} aria-label="Height floor percent" />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleImportClick}
            disabled={!mesh}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white shadow-xs transition-colors cursor-pointer"
          >
            Import to Scene
          </button>
        </div>
      </div>
    </div>
  );
};
