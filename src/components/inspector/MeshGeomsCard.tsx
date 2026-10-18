import { useCallback, useState } from 'react';
import { Code, Download, Minimize2, Scissors, Shapes, Sparkles } from 'lucide-react';
import { simplifyGeomMesh, toRenderVertices } from '../../utils/simplifyMesh';
import { patchGeom } from '../../utils/sceneTree';
import { downloadMeshGeomStl } from '../../utils/meshStlExport';
import { cloneSceneGraph, useStore } from '../../store/useStore';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { RangeInput } from '../RangeInput';

/** Mesh Properties — shown when the body or any child has a mesh geom */
export function MeshGeomsCard({ node: selectedNode }: { node: SceneNode }) {
  const [meshEditorGeom, setMeshEditorGeom] = useState<string | null>(null);
  const [meshEditorText, setMeshEditorText] = useState('');
  const [meshEditorError, setMeshEditorError] = useState<string | null>(null);
  const [meshSimplifierGeom, setMeshSimplifierGeom] = useState<string | null>(null);
  const [simplifyRatio, setSimplifyRatio] = useState(0.5);
  const [meshSimplifierError, setMeshSimplifierError] = useState<string | null>(null);

  const handleSimplifyMesh = useCallback((g: SceneGeom, ownerId: string) => {
    try {
      setMeshSimplifierError(null);
      const { vertices: uniqueVerts, faces, renderVertices: newRenderVerts } = simplifyGeomMesh(g, simplifyRatio);

      const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
      patchGeom(newScene.nodes, ownerId, g.name, {
        vertices: uniqueVerts,
        faces,
        ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}),
      });
      useStore.getState().updateScene(newScene);
      
      setMeshSimplifierGeom(null);
    } catch (err) {
      console.error('Mesh simplification failed:', err);
      setMeshSimplifierError((err as Error).message || 'Mesh simplification failed.');
    }
  }, [simplifyRatio]);

  const allGeoms: (SceneGeom & { _fromChildId: string | null })[] = [];
  const collectGeoms = (node: SceneNode) => { node.geoms?.forEach((g) => allGeoms.push({...g, _fromChildId: node.id !== selectedNode.id ? node.id : null})); node.children?.forEach(collectGeoms); };
  collectGeoms(selectedNode);
  if (!allGeoms.some((g) => g.type === 'mesh')) return null;
  return (
  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
      <Shapes className="w-3.5 h-3.5 text-violet-500" /> Body Geoms ({allGeoms.length})
    </h3>
    <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
      Static mesh geoms are <strong>visual only</strong>. Primitive geoms handle physics. Dynamic meshes simulate and collide.
    </p>
    {allGeoms.map((g) => (
      <div key={g.name} className="flex flex-col gap-1.5 p-2 bg-slate-50 rounded border border-slate-100">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            {g.name}{g._fromChildId ? <span className="text-violet-400 font-normal"> (child)</span> : null}
          </span>
          <span className="text-[10px] text-slate-400">
            {g.type === 'mesh'
              ? (g.vertices ? `mesh · ${g.vertices.length / 3} verts · ${g.faces ? g.faces.length / 3 : 0} tris${g.dynamic ? ' · dynamic' : ' · static'}` : 'mesh · no geometry')
              : `${g.type} · size [${(g.size || []).map((s: number) => (s * 1000).toFixed(1)).join(', ')}] mm`}
          </span>
        </div>
        {g.type === 'mesh' && g.vertices && g.vertices.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <button
                onClick={() => {
                  if (meshEditorGeom === g.name) { setMeshEditorGeom(null); return; }
                  // The mesh arrays, named locally: this button
                  // only exists for a geom that has them (see the
                  // condition above), which a handler cannot see.
                  const verts = g.vertices!;
                  const faces = g.faces!;
                  // Format vertices as one triplet per line, faces as one triangle per line
                  const vLines = [];
                  for (let i = 0; i < verts.length; i += 3)
                    vLines.push(`${verts[i]} ${verts[i+1]} ${verts[i+2]}`);
                  const fLines = [];
                  for (let i = 0; i < faces.length; i += 3)
                    fLines.push(`${faces[i]} ${faces[i+1]} ${faces[i+2]}`);
                  setMeshEditorText(`# vertices (x y z, one per line, Three.js Y-up space)\n${vLines.join('\n')}\n\n# faces (i j k triangle indices, one per line)\n${fLines.join('\n')}`);
                  setMeshEditorError(null);
                  setMeshEditorGeom(g.name);
                  setMeshSimplifierGeom(null); // Close simplifier if open
                }}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded text-[10px] font-semibold text-violet-700 transition-colors cursor-pointer"
              >
                <Code className="w-3 h-3" /> {meshEditorGeom === g.name ? 'Close Editor' : 'Edit Vertices'}
              </button>
              <button
                onClick={() => {
                  if (meshSimplifierGeom === g.name) { setMeshSimplifierGeom(null); return; }
                  setMeshSimplifierGeom(g.name);
                  setMeshSimplifierError(null);
                  setMeshEditorGeom(null); // Close editor if open
                }}
                className={`flex items-center justify-center gap-1 px-2.5 py-1.5 border rounded text-[10px] font-semibold transition-colors cursor-pointer ${meshSimplifierGeom === g.name ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700' : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600'}`}
                title="Simplify mesh (reduce vertex/triangle count)"
              >
                <Scissors className="w-3 h-3" /> {meshSimplifierGeom === g.name ? 'Close' : 'Simplify'}
              </button>
              <button
                onClick={() => {
                  // As above: this button is only rendered for a
                  // geom that has the mesh arrays.
                  const verts = g.vertices!;
                  const faces = g.faces!;
                  const unique = new Map<string, number>();
                  const newVerts: number[] = [], remap: number[] = [];
                  for (let i = 0; i < verts.length; i += 3) {
                    const key = `${verts[i].toFixed(4)},${verts[i+1].toFixed(4)},${verts[i+2].toFixed(4)}`;
                    if (!unique.has(key)) { unique.set(key, newVerts.length/3); newVerts.push(verts[i], verts[i+1], verts[i+2]); }
                    remap[i/3] = unique.get(key)!;
                  }
                  const filteredFaces: number[] = [];
                  for (let i = 0; i < faces.length; i += 3) {
                    const a=remap[faces[i]], b=remap[faces[i+1]], c=remap[faces[i+2]];
                    if (a!==b && b!==c && a!==c) filteredFaces.push(a,b,c);
                  }
                  const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
                  // A dynamic mesh is drawn from renderVertices, so they are
                  // renumbered with the rest or the new faces index old points.
                  patchGeom(newScene.nodes, g._fromChildId ?? selectedNode.id, g.name, {
                    vertices: newVerts,
                    faces: filteredFaces,
                    ...(g.dynamic ? { renderVertices: toRenderVertices(newVerts) } : {}),
                  });
                  useStore.getState().updateScene(newScene);
                }}
                className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded text-[10px] font-semibold text-slate-600 transition-colors cursor-pointer"
                title="Remove duplicate vertices"
              >
                <Minimize2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => downloadMeshGeomStl(g, g.name || selectedNode.name || 'mesh')}
                className="flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded text-[10px] font-semibold text-emerald-700 transition-colors cursor-pointer"
                title="Download this geom on its own as a binary STL, in millimetres. The toolbar's STL export writes the whole scene."
              >
                <Download className="w-3 h-3" /> STL
              </button>
            </div>
            {meshEditorGeom === g.name && (
              <div className="flex flex-col gap-1.5">
                <textarea
                  value={meshEditorText}
                  onChange={(e) => setMeshEditorText(e.target.value)}
                  className="w-full h-48 font-mono text-[10px] leading-relaxed p-2 bg-slate-950 text-violet-300 rounded border border-slate-700 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
                  spellCheck={false}
                />
                {meshEditorError && (
                  <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">{meshEditorError}</div>
                )}
                <button
                  onClick={() => {
                    try {
                      // Parse using the explicit # vertices / # faces section markers
                      // Everything before the blank line / # faces comment = vertices
                      // Everything after = faces
                      const newVerts: number[] = [], newFaces: number[] = [];
                      let section: 'vertices' | 'faces' = 'vertices';
                      for (const raw of meshEditorText.split('\n')) {
                        const line = raw.trim();
                        if (!line) continue;
                        if (line.startsWith('#')) {
                          if (line.toLowerCase().includes('face')) section = 'faces';
                          else if (line.toLowerCase().includes('vert')) section = 'vertices';
                          continue;
                        }
                        const nums = line.split(/[\s,]+/).map(Number);
                        if (nums.length !== 3 || nums.some(isNaN)) throw new Error(`Bad line: "${raw.trim()}": expected exactly 3 numbers`);
                        if (section === 'vertices') newVerts.push(...nums);
                        else newFaces.push(...nums);
                      }
                      if (newVerts.length < 9) throw new Error('Need at least 3 vertices');
                      if (newFaces.length < 3) throw new Error('Need at least 1 face');
                      const nv = newVerts.length / 3;
                      const badIdx = newFaces.find(i => !Number.isInteger(i) || i < 0 || i >= nv);
                      if (badIdx !== undefined) throw new Error(`Face index ${badIdx} out of range (0–${nv-1})`);
                      // If this is a dynamic mesh, recompute renderVertices from the new vertices.
                      // renderVertices = raw Z-up: Y-up (x,y,z) → Z-up (x,-z,y), no centroid subtraction.
                      // MuJoCo recenters the mesh internally; xpos tracks the recentered frame.
                      const newRenderVerts = g.dynamic ? toRenderVertices(newVerts) : undefined;
                      const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
                      patchGeom(newScene.nodes, g._fromChildId ?? selectedNode.id, g.name, {
                        vertices: newVerts,
                        faces: newFaces,
                        ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}),
                      });
                      useStore.getState().updateScene(newScene);
                      setMeshEditorError(null);
                      setMeshEditorGeom(null);
                    } catch (e) {
                      setMeshEditorError((e as Error).message);
                    }
                  }}
                  className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded text-[10px] font-semibold cursor-pointer transition-colors"
                >
                    Apply Mesh
                  </button>
                </div>
              )}
              {meshSimplifierGeom === g.name && (
                <div className="flex flex-col gap-2 p-2 bg-amber-50/50 rounded border border-amber-100 mt-1">
                  <div className="flex items-center justify-between text-[10px] font-semibold text-slate-700">
                    <span>Target Quality:</span>
                    <span className="font-mono text-amber-700 font-bold">{(simplifyRatio * 100).toFixed(0)}% vertices</span>
                  </div>
                  <RangeInput
                    min="0.05"
                    max="0.95"
                    step="0.05"
                    value={simplifyRatio}
                    onChange={(v) => setSimplifyRatio(v)}
                    className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-600 focus:outline-none"
                  />
                  <div className="flex justify-between text-[8px] text-slate-400">
                    <span>High Simplification (5% kept)</span>
                    <span>Low Simplification (95% kept)</span>
                  </div>

                  {meshSimplifierError && (
                    <div className="text-[9px] text-amber-800 bg-amber-100/60 border border-amber-200 rounded p-1.5 font-mono">
                      {meshSimplifierError}
                    </div>
                  )}

                  <div className="flex justify-end gap-1.5 mt-1">
                    <button
                      onClick={() => setMeshSimplifierGeom(null)}
                      className="px-2 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-[10px] text-slate-600 font-semibold rounded cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSimplifyMesh(g, g._fromChildId ?? selectedNode.id)}
                      className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-semibold rounded cursor-pointer shadow transition-colors flex items-center gap-1"
                    >
                      <Sparkles className="w-3 h-3" />
                      Simplify Mesh
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
    ))}
  </div>
  );
}
