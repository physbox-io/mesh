import React, { useCallback, useEffect, useState } from 'react';
import { X, Upload, Sliders, Box, Layers, Check, AlertCircle, Code } from 'lucide-react';
import { parseSTL, type ParsedSTLResult } from '../utils/stlParser';

interface ImportStlModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportNode: (node: any) => void;
  /** File dropped onto the app window, loaded as soon as the dialog opens. */
  initialFile?: File | null;
}

export const ImportStlModal: React.FC<ImportStlModalProps> = ({
  isOpen,
  onClose,
  onImportNode,
  initialFile,
}) => {
  const [fileName, setFileName] = useState<string>('');
  const [scadCode, setScadCode] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSTLResult | null>(null);
  const [importMode, setImportMode] = useState<'scad_csg' | 'scad_parametric' | 'scad_raw' | 'mesh' | 'primitive'>('scad_csg');
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setIsProcessing(true);

    const isScad = file.name.toLowerCase().endsWith('.scad');

    if (isScad) {
      setFileName(file.name.replace(/\.scad$/i, ''));
      try {
        const text = await file.text();
        setScadCode(text);
        setParsed(null);
      } catch (err) {
        setError(`Failed to read OpenSCAD file: ${String(err)}`);
        setScadCode(null);
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError(`"${file.name}" is not an .stl or .scad file.`);
      setIsProcessing(false);
      return;
    }

    setFileName(file.name.replace(/\.stl$/i, ''));
    setScadCode(null);

    try {
      const buffer = await file.arrayBuffer();
      const result = parseSTL(buffer, { name: file.name.replace(/\.stl$/i, '') });
      setParsed(result);
    } catch (err) {
      setError(`Failed to parse STL file: ${String(err)}`);
      setParsed(null);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  // App.tsx mounts this dialog only while it is open, so component state is
  // already fresh on every open; all that is left is to pick up a file that was
  // dropped onto the app window.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading and
    // parsing the file is the async work this mount exists to kick off; the
    // synchronous part of it is just raising the "processing" flag.
    if (initialFile) void handleFile(initialFile);
  }, [initialFile, handleFile]);

  // Below every hook: React forbids a conditional hook.
  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleFile(file);
    // Clear the input so re-picking the same file fires change again.
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
    // dragleave also fires when the cursor crosses onto a child element, which
    // would flicker the highlight off while still over the zone.
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
    if (scadCode) {
      const baseName = fileName || 'imported_scad';
      const id = `scad_${Math.random().toString(36).slice(2, 7)}`;
      const node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        scad: scadCode,
        geoms: [{ type: 'mesh', size: [1], dynamic: true }],
        joints: [{ type: 'free' }],
        children: [],
      };
      onImportNode(node);
      onClose();
      return;
    }

    if (!parsed) return;

    const baseName = fileName || 'imported_stl';
    const id = `stl_${Math.random().toString(36).slice(2, 7)}`;
    let node: any = null;

    if (importMode === 'scad_csg') {
      node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        scad: parsed.scadCsg,
        geoms: [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1],
          dynamic: true,
          vertices: parsed.vertices,
          renderVertices: parsed.renderVertices,
          faces: parsed.faces,
        }],
        joints: [{ name: `${id}_free`, type: 'free' }],
        children: [],
      };
    } else if (importMode === 'scad_parametric') {
      node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        scad: parsed.scadParametric,
        geoms: [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1],
          dynamic: true,
          vertices: parsed.vertices,
          renderVertices: parsed.renderVertices,
          faces: parsed.faces,
        }],
        joints: [{ name: `${id}_free`, type: 'free' }],
        children: [],
      };
    } else if (importMode === 'scad_raw') {
      node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        scad: parsed.scadRaw,
        geoms: [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1],
          dynamic: true,
          vertices: parsed.vertices,
          renderVertices: parsed.renderVertices,
          faces: parsed.faces,
        }],
        joints: [{ name: `${id}_free`, type: 'free' }],
        children: [],
      };
    } else if (importMode === 'mesh') {
      node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        geoms: [{
          name: `${id}_geom`,
          type: 'mesh',
          rgba: [0.3, 0.6, 0.9, 1],
          vertices: parsed.vertices,
          faces: parsed.faces,
          renderVertices: parsed.renderVertices,
          dynamic: true,
        }],
        joints: [{ name: `${id}_free`, type: 'free' }],
        children: [],
      };
    } else {
      // primitive
      node = {
        id,
        name: baseName,
        pos: [0, 0, 0.2],
        geoms: [{
          name: `${id}_geom`,
          type: parsed.primitiveGeom.type,
          size: parsed.primitiveGeom.size,
          rgba: [0.3, 0.7, 0.9, 1],
        }],
        joints: [{ name: `${id}_free`, type: 'free' }],
        children: [],
      };
    }

    onImportNode(node);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-indigo-500" />
            <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base">Import 3D Model (STL / OpenSCAD)</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Dropzone / File Picker */}
          <div
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
              isDragging
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40'
                : 'border-slate-300 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 bg-slate-50 dark:bg-slate-800/40'
            }`}
          >
            <input
              type="file"
              accept=".stl,.scad"
              onChange={handleFileChange}
              className="hidden"
              id="stl-file-upload"
            />
            <label htmlFor="stl-file-upload" className="cursor-pointer flex flex-col items-center gap-2">
              <Upload className="w-8 h-8 text-slate-400 dark:text-slate-500" />
              <span className="font-medium text-sm text-slate-700 dark:text-slate-200">
                {isDragging
                  ? 'Drop to import'
                  : fileName ? `File selected: ${fileName}` : 'Click to select or drag an STL or .scad file'}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500">Supports binary/ASCII .stl and parametric .scad formats</span>
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs rounded-lg border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {isProcessing && (
            <p className="text-center text-xs text-indigo-500 animate-pulse">Reading file & processing model...</p>
          )}

          {scadCode && (
            <div className="p-4 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-xl space-y-2 text-xs">
              <div className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <Code className="w-4 h-4 text-indigo-500" />
                Parametric OpenSCAD Code Loaded
              </div>
              <p className="text-slate-600 dark:text-slate-300">
                Original parametric source code for <strong>{fileName}.scad</strong> will be imported directly into the OpenSCAD node. Interactive UI sliders will be auto-generated from your variables.
              </p>
              <pre className="p-2.5 bg-white dark:bg-slate-900 rounded-lg text-[10px] text-slate-700 dark:text-slate-300 font-mono overflow-x-auto max-h-36 border border-slate-200 dark:border-slate-800">
                {scadCode.slice(0, 600)}{scadCode.length > 600 ? '\n...' : ''}
              </pre>
            </div>
          )}

          {parsed && (
            <div className="space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                  <div className="text-slate-400">Vertices</div>
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{(parsed.vertices.length / 3).toLocaleString()}</div>
                </div>
                <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                  <div className="text-slate-400">Triangles</div>
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{(parsed.faces.length / 3).toLocaleString()}</div>
                </div>
                <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                  <div className="text-slate-400">Islands</div>
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{parsed.subComponents.length}</div>
                </div>
                <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                  <div className="text-slate-400">Size (mm)</div>
                  <div className="font-semibold text-slate-700 dark:text-slate-200">
                    {(parsed.boundingBox.size[0] * 1000).toFixed(0)}×{(parsed.boundingBox.size[1] * 1000).toFixed(0)}×{(parsed.boundingBox.size[2] * 1000).toFixed(0)}
                  </div>
                </div>
              </div>

              <div className="p-3 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-lg text-xs text-indigo-700 dark:text-indigo-300 flex items-start gap-2">
                <Sliders className="w-4 h-4 shrink-0 mt-px" />
                <span>Inferred shape: <strong>{parsed.shapeSummary}</strong></span>
              </div>

              {parsed.inferredSpacing && (
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-lg text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <Check className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Detected <strong>{parsed.inferredSpacing.count} repeated sub-parts</strong> with{' '}
                    <strong>{(parsed.inferredSpacing.delta * 1000).toFixed(1)}mm spacing</strong> along {parsed.inferredSpacing.axis.toUpperCase()} axis!
                  </span>
                </div>
              )}

              {/* Mode Selector */}
              <div className="space-y-2">
                <label className="block font-semibold text-xs text-slate-700 dark:text-slate-300">Choose Import Mode:</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${importMode === 'scad_csg' ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="importMode" value="scad_csg" checked={importMode === 'scad_csg'} onChange={() => setImportMode('scad_csg')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Sliders className="w-3.5 h-3.5 text-indigo-500" /> Parametric CSG Primitives
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Clean cube/cylinder CSG code with parameters & sliders</div>
                    </div>
                  </label>

                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${importMode === 'scad_parametric' ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="importMode" value="scad_parametric" checked={importMode === 'scad_parametric'} onChange={() => setImportMode('scad_parametric')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5 text-indigo-500" /> Scaled Mesh Polyhedron
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Scales full STL vertex polyhedron with size sliders</div>
                    </div>
                  </label>

                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${importMode === 'scad_raw' ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="importMode" value="scad_raw" checked={importMode === 'scad_raw'} onChange={() => setImportMode('scad_raw')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5 text-indigo-500" /> OpenSCAD Polyhedron
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Raw polyhedron code for CSG cutouts and booleans</div>
                    </div>
                  </label>

                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${importMode === 'mesh' ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="importMode" value="mesh" checked={importMode === 'mesh'} onChange={() => setImportMode('mesh')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Box className="w-3.5 h-3.5 text-indigo-500" /> Raw 3D Mesh
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Direct vertex/face mesh node (no OpenSCAD recompile)</div>
                    </div>
                  </label>

                  <label className={`p-3 border rounded-xl cursor-pointer transition-colors flex items-start gap-2.5 ${importMode === 'primitive' ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800'}`}>
                    <input type="radio" name="importMode" value="primitive" checked={importMode === 'primitive'} onChange={() => setImportMode('primitive')} className="mt-0.5" />
                    <div>
                      <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                        <Box className="w-3.5 h-3.5 text-indigo-500" /> Primitive Bounds
                      </div>
                      <div className="text-slate-500 text-[11px] mt-0.5">Simplified primitive box or cylinder matching bounds</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleImportClick}
            disabled={!parsed && !scadCode}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white shadow-xs transition-colors cursor-pointer"
          >
            Import to Scene
          </button>
        </div>
      </div>
    </div>
  );
};
