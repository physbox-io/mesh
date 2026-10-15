import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { Printer, Settings, Zap } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { compileCsgNodes } from '../../hooks/useCsgCompile';
import { compileSCAD, isCompilerReady } from '../../utils/openscad';
import { generateScadForNode, parseScadVariables, replaceVarInCode } from '../../utils/scadSource';
import { downloadBlob } from '../../utils/downloadBlob';
import type { SceneNode } from '../../types/scene';
import { RangeInput } from '../RangeInput';
import { ConfirmModal } from '../ConfirmModal';
import { ExportScaleModal } from '../ExportScaleModal';

/**
 * The OpenSCAD editor, for a body whose shape is OpenSCAD source.
 *
 * Also gives an OpenSCAD body that has no source yet (one from a preset that
 * predates the `scad` field) the source its shape implies, and stores it, so
 * the editor has something to open on.
 */
export function ScadEditorCard({ node }: { node: SceneNode }) {
  useEffect(() => {
    if (node.scad === undefined && (node.id.includes('openscad') || node.id.includes('scad'))) {
      useStore.getState().updateNode(node.id, { scad: generateScadForNode(node) });
    }
  }, [node]);

  if (node.scad === undefined) return null;
  // One editor per body, so a slider timer, a compile in flight or a slider
  // held mid-drag cannot carry over to the next body selected.
  return <ScadEditor key={node.id} node={node} />;
}

function ScadEditor({ node }: { node: SceneNode }) {
  const [scadText, setScadText] = useState(node.scad ?? '');
  const [scadError, setScadError] = useState<string | null>(null);
  const [isScadCompiling, setIsScadCompiling] = useState(false);
  const [isCompilerLoading, setIsCompilerLoading] = useState(false);
  const [exportScale, setExportScale] = useState<{
    title: string;
    value: string;
    onConfirm: (targetMm: number) => void;
  } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // The editor follows the stored source: a compile, an undo or the MCP
  // bridge can each change it underneath the textarea. Only the source — an
  // edit anywhere else on the body leaves an unsaved draft alone.
  const [shownScad, setShownScad] = useState(node.scad);
  if (node.scad !== shownScad) {
    setShownScad(node.scad);
    setScadText(node.scad ?? '');
    setScadError(null);
  }

  const scadVars = useMemo(() => parseScadVariables(scadText), [scadText]);

  // OpenSCAD Slider Debouncing State
  const [slidingValues, setSlidingValues] = useState<Record<string, number>>({});

  const scadTextRef = useRef(scadText);
  useEffect(() => {
    scadTextRef.current = scadText;
  }, [scadText]);

  const slidingValuesRef = useRef(slidingValues);
  useEffect(() => {
    slidingValuesRef.current = slidingValues;
  }, [slidingValues]);

  const updateCodeTimeoutRef = useRef<number | null>(null);
  const nodeId = node.id;

  // Writes the slider values into the source and compiles it, for this body.
  const commitSlide = useCallback(async () => {
    updateCodeTimeoutRef.current = null;
    let updated = scadTextRef.current;
    for (const [name, value] of Object.entries(slidingValuesRef.current)) {
      updated = replaceVarInCode(updated, name, value);
    }
    setScadText(updated);

    setIsScadCompiling(true);
    setScadError(null);
    try {
      const compiled = await compileSCAD(updated);
      useStore.getState().updateNodeScad(nodeId, updated, compiled);
    } catch (e) {
      console.error('OpenSCAD Auto-Compilation Error:', e);
      setScadError((e as Error).message || 'Auto-compilation failed.');
    } finally {
      setIsScadCompiling(false);
      setSlidingValues({});
    }
  }, [nodeId]);

  const debouncedUpdateCode = useCallback(() => {
    if (updateCodeTimeoutRef.current) {
      window.clearTimeout(updateCodeTimeoutRef.current);
    }
    updateCodeTimeoutRef.current = window.setTimeout(commitSlide, 300);
  }, [commitSlide]);

  // A slide still waiting when the editor goes (another body selected) is
  // saved now, to the body it was made on, rather than dropped.
  useEffect(() => {
    return () => {
      if (updateCodeTimeoutRef.current) {
        window.clearTimeout(updateCodeTimeoutRef.current);
        void commitSlide();
      }
    };
  }, [commitSlide]);

  const handleCompileScad = useCallback(async () => {
    setIsScadCompiling(true);
    setScadError(null);
    try {
      const compiled = await compileSCAD(scadText);
      useStore.getState().updateNodeScad(node.id, scadText, compiled);
      // A part with a cut or a rounding is a boolean over this mesh: build it
      // now rather than leave it to the debounced auto-compiler, which does
      // not reliably pick up a source change (see compileCsgNodes).
      if (node.csgEnabled) await compileCsgNodes();
    } catch (e) {
      console.error('OpenSCAD Compilation Error:', e);
      setScadError((e as Error).message || 'Compilation failed.');
    } finally {
      setIsScadCompiling(false);
    }
  }, [node, scadText]);

  return (
    <>
      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-slate-800">
            <Settings className="w-4 h-4 text-violet-500" />
            OpenSCAD CAD Code
          </span>
          <div className="flex items-center gap-1.5">
            {isScadCompiling ? (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-100 animate-pulse">
                Compiling...
              </span>
            ) : (
              <span className="text-[10px] font-medium text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100">
                CAD Shape
              </span>
            )}
          </div>
        </h3>

        <p className="text-[10px] text-slate-400 -mt-1 leading-tight">
          Write constructive solid geometry code to generate custom physics structures.
        </p>

        {!isCompilerReady() && (
          <div className="text-[9px] text-violet-600 font-semibold bg-violet-50 border border-violet-100/60 p-1.5 rounded text-center leading-snug animate-pulse">
            🌐 Loading CAD engine in background...
          </div>
        )}

        {/* Templates Selector */}
        <div className="flex items-center justify-between text-xs text-slate-500 gap-1.5 bg-slate-50 p-1.5 rounded-md border border-slate-100">
          <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Templates:</span>
          <select
            onChange={(e) => {
              const templateVal = e.target.value;
              if (templateVal === 'hollow_cube') {
                setScadText(`// Hollow Cube\nsize = 0.6; // [0.2:0.05:1.2]\nhole_d = 0.75; // [0.3:0.05:1.5]\ndifference() {\n  cube([size, size, size], center=true);\n  sphere(d=hole_d, $fn=24);\n}`);
              } else if (templateVal === 'wheel') {
                setScadText(`// Wheel with Hole\nheight = 0.15; // [0.05:0.05:0.5]\nouter_r = 0.35; // [0.1:0.05:1.0]\ninner_r = 0.08; // [0.02:0.02:0.5]\ndifference() {\n  cylinder(h=height, r=outer_r, center=true, $fn=30);\n  cylinder(h=height*1.5, r=inner_r, center=true, $fn=16);\n}`);
              } else if (templateVal === 'wedge') {
                setScadText(`// Wedge with multiple holes\nwidth = 1.0; // [0.5:0.1:2.0]\nheight = 0.5; // [0.2:0.1:1.5]\nthickness = 0.4; // [0.1:0.1:1.0]\nhole_r = 0.08; // [0.02:0.01:0.2]\ndifference() {\n  // Base wedge block\n  linear_extrude(height=thickness, center=true)\n    polygon([[0,0], [width,0], [0,height]]);\n  \n  // Cylindrical holes\n  translate([width*0.2, height*0.2, 0])\n    cylinder(h=thickness*1.5, r=hole_r, center=true, $fn=16);\n  translate([width*0.5, height*0.3, 0])\n    cylinder(h=thickness*1.5, r=hole_r, center=true, $fn=16);\n}`);
              } else if (templateVal === 'funnel') {
                setScadText(`// Funnel / Bowl\nheight = 0.4; // [0.2:0.05:1.0]\nbase_r = 0.15; // [0.05:0.05:0.5]\ntop_r = 0.4; // [0.2:0.05:1.0]\npassage_r = 0.05; // [0.02:0.01:0.2]\ndifference() {\n  cylinder(h=height, r1=base_r, r2=top_r, center=true, $fn=24);\n  translate([0, 0, height*0.125])\n    cylinder(h=height, r1=base_r*0.66, r2=top_r*0.95, center=true, $fn=24);\n  // vertical passage hole\n  cylinder(h=height*1.5, r=passage_r, center=true, $fn=16);\n}`);
              } else if (templateVal === 'clear') {
                setScadText('');
              }
              e.target.value = ''; // Reset selection
            }}
            className="text-xs bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
          >
            <option value="">-- Select Template --</option>
            <option value="hollow_cube">Hollow Cube</option>
            <option value="wheel">Wheel with Hole</option>
            <option value="wedge">Wedge with Holes</option>
            <option value="funnel">Funnel / Bowl</option>
            <option value="clear">Clear Editor</option>
          </select>
        </div>

        {/* Procedural parameters sliders */}
        {scadVars.length > 0 && (
          <div className="flex flex-col gap-2 p-2 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-100 dark:border-slate-800 mb-1">
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
              Procedural Parameters
            </span>
            <div className="grid grid-cols-1 gap-2">
              {scadVars.map((v) => (
                <div key={v.name} className="flex flex-col gap-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{v.name}</span>
                    <span className="font-mono text-violet-600 dark:text-violet-400 font-bold bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded border border-violet-100 dark:border-violet-900/50">
                      {Number((slidingValues[v.name] ?? v.value).toPrecision(4))}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-400 font-mono w-8 text-right">{Number(v.min.toPrecision(3))}</span>
                    <RangeInput
                      min={v.min}
                      max={v.max}
                      step={v.step}
                      value={slidingValues[v.name] ?? v.value}
                      onChange={(next) => {
                        // Only the float noise off the step comes off: two decimals would turn
                        // a 5 mm value, written in metres, into 10 mm.
                        const val = Number(next.toPrecision(10));
                        setSlidingValues(prev => ({ ...prev, [v.name]: val }));
                        debouncedUpdateCode();
                      }}
                      className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-600"
                    />
                    <span className="text-[9px] text-slate-400 font-mono w-8">{Number(v.max.toPrecision(3))}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Text Area Code Editor */}
        <div className="relative">
          <textarea
            value={scadText}
            onChange={(e) => setScadText(e.target.value)}
            placeholder="// Write OpenSCAD here... e.g. cube(10);"
            className="w-full h-44 font-mono text-[11px] leading-relaxed p-2.5 bg-slate-950 text-violet-300 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-y shadow-inner"
            spellCheck={false}
          />
          <div className="absolute right-2.5 bottom-2.5 text-[8px] font-mono text-slate-600 bg-slate-900/50 px-1 rounded pointer-events-none select-none border border-slate-800">
            SCAD
          </div>
        </div>

        {/* Compilation Error Display */}
        {scadError && (
          <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[10px] flex gap-1.5 items-start leading-tight">
            <span className="font-bold shrink-0">⚠️ Error:</span>
            <span className="font-mono text-slate-700 break-all">{scadError}</span>
          </div>
        )}

        {/* Action Buttons Row */}
        <div className="flex gap-2 items-center justify-between">
          <button
            onClick={async () => {
              setIsCompilerLoading(true);
              try {
                const compiled = await compileSCAD(scadText);
                if (!compiled.vertices || compiled.vertices.length === 0) {
                  throw new Error('Compilation produced no vertices.');
                }

                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(compiled.vertices), 3));
                geo.setIndex(new THREE.BufferAttribute(new Uint32Array(compiled.faces), 1));
                geo.computeVertexNormals();

                const mesh = new THREE.Mesh(geo);
                const bbox = new THREE.Box3().setFromObject(mesh);
                const size = bbox.getSize(new THREE.Vector3());
                const longestSide = Math.max(size.x, size.y, size.z);

                let defaultPrompt = '150';
                if (longestSide > 0) {
                  defaultPrompt = Math.round(longestSide * 1000).toString();
                }

                const filename = `${node.name || 'openscad_shape'}.stl`;
                setExportScale({
                  title: 'Export OpenSCAD STL',
                  value: defaultPrompt,
                  onConfirm: (targetMm) => {
                    const scale = targetMm / longestSide;
                    const center = bbox.getCenter(new THREE.Vector3());
                    const transform = new THREE.Matrix4()
                      .makeRotationX(Math.PI / 2)
                      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
                      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

                    geo.applyMatrix4(transform);

                    const exportGroup = new THREE.Group();
                    exportGroup.add(mesh);

                    const exporter = new STLExporter();
                    const result = exporter.parse(exportGroup, { binary: true }) as DataView;
                    const blob = new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' });
                    downloadBlob(blob, filename);
                  },
                });
              } catch (e) {
                setExportError('Failed to export OpenSCAD STL: ' + (e as Error).message);
              } finally {
                setIsCompilerLoading(false);
              }
            }}
            disabled={isCompilerLoading || isScadCompiling}
            className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-400 transition-colors flex items-center gap-1 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            Export STL (3D Print)
          </button>

          <button
            onClick={handleCompileScad}
            disabled={isScadCompiling || isCompilerLoading}
            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-400 active:bg-violet-800 text-white rounded-lg text-[11px] font-semibold shadow transition-colors flex items-center gap-1 cursor-pointer"
          >
            <Zap className="w-3.5 h-3.5" />
            {isScadCompiling ? 'Compiling...' : 'Compile & Update'}
          </button>
        </div>
      </div>
      {exportScale && (
        <ExportScaleModal
          title={exportScale.title}
          initialMm={exportScale.value}
          onCancel={() => setExportScale(null)}
          onConfirm={(targetMm) => {
            const cb = exportScale.onConfirm;
            setExportScale(null);
            cb(targetMm);
          }}
        />
      )}

      {exportError && (
        <ConfirmModal
          title="OpenSCAD export failed"
          body={<p>{exportError}</p>}
          confirmLabel="OK"
          hideCancel
          tone="red"
          onConfirm={() => setExportError(null)}
          onCancel={() => setExportError(null)}
        />
      )}
    </>
  );
}
