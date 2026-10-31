import { useCallback, type RefObject } from 'react';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { isBoughtIn } from '../utils/boughtIn';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { SceneNode } from '../types/scene';
import type { NoteCard } from '../utils/noteCards';
import { exportThreeMf, type ThreeMfMesh } from '../utils/threeMfExporter';
import { exportPrintFiles } from '../utils/printExport';
import { zipStore } from '../utils/zipStore';
import { downloadBlob } from '../utils/downloadBlob';
import { exportBaseName } from '../utils/exportBaseName';

/**
 * STL and 3MF, made from what the viewport draws. `threeSceneRef` is the
 * three.js scene, captured inside the Canvas by SceneCapture.
 */
export function useMeshExport(threeSceneRef: RefObject<THREE.Scene | null>, noteCards: NoteCard[]) {
  const activePreset = useStore((s) => s.activePreset);
  const showNotice = useDialogs((s) => s.showNotice);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);
  const withExportGroup = useExportGroup(threeSceneRef);

  const baseName = useCallback(() => exportBaseName(noteCards, activePreset), [noteCards, activePreset]);

  const exportWholeSceneStl = useCallback(() => {
    withExportGroup('Export STL', (exportGroup) => {
      const exporter = new STLExporter();
      const result = exporter.parse(exportGroup, { binary: true }) as DataView;
      downloadBlob(new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' }), `${baseName()}.stl`);
    });
  }, [withExportGroup, baseName]);

  // An STL is one soup: the split sections in it stand assembled, as big as the
  // part that did not fit, and the size prompt scales them all by one section.
  // So sections go out as a file each, stood the way they print, at true size.
  const exportStl = useCallback(() => {
    const { sceneGraph: graph } = useStore.getState();
    let posed = 0;
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (n.printPose) posed++;
        walk(n.children || []);
      }
    };
    walk(graph.nodes);
    if (!posed) { exportWholeSceneStl(); return; }
    openDialog({
      title: `Export ${posed} split section${posed === 1 ? '' : 's'} as STLs to print?`,
      confirmLabel: 'One STL each',
      cancelLabel: 'Export scene as-is',
      body: (
        <>
          <p>Each part goes in a file of its own, at true size, and each split section is stood the way it prints. They come in one zip.</p>
          <p>Choose “Export scene as-is” for the whole scene in one STL, in its current pose.</p>
        </>
      ),
      onConfirm: () => {
        closeDialog();
        const result = exportPrintFiles(graph, { format: 'stl', separate: true });
        if (!result.files.length) {
          showNotice('Nothing to export', 'There are no printable parts in the scene to export.');
          return;
        }
        const zip = zipStore(result.files.map((f) => ({ path: f.name, data: f.bytes })));
        downloadBlob(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }), `${baseName()}_stl.zip`);
      },
      onCancel: () => {
        closeDialog();
        exportWholeSceneStl();
      },
    });
  }, [exportWholeSceneStl, baseName, openDialog, closeDialog, showNotice]);

  /**
   * The same model, in the format that can carry what it looks like.
   *
   * Both halves of the colour go in — per-corner colour for anything that
   * renders the file, and a filament slot per triangle for a slicer that
   * prints it. See utils/threeMfExporter.
   */
  const exportWholeScene3mf = useCallback(() => {
    withExportGroup('Export 3MF', (exportGroup) => {
      const meshes: ThreeMfMesh[] = [];
      exportGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        const position = mesh.geometry.getAttribute('position');
        if (!position) return;
        const color = mesh.geometry.getAttribute('color');
        meshes.push({
          name: mesh.name || 'part',
          positions: position.array as Float32Array,
          indices: (mesh.geometry.getIndex()?.array as Uint32Array | undefined) ?? null,
          // Present exactly when the body carries paint: the painted material is
          // white and holds the body's own colour in the attribute instead.
          colors: material.vertexColors && color ? (color.array as Float32Array) : null,
          baseColor: [material.color.r, material.color.g, material.color.b],
        });
      });

      if (!meshes.length) {
        showNotice('Nothing to export', 'There are no visible 3D parts in the scene to export.');
        return;
      }

      const result = exportThreeMf(meshes);
      downloadBlob(new Blob([result.data.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${baseName()}.3mf`);

      // Said out loud because it is the one thing about the file a user cannot
      // see by looking at it: how many filaments the paint was reduced to.
      const slots = result.palette.filter(p => p.triangles > 0);
      if (slots.length > 1) {
        console.info(`[Export] 3MF written with ${slots.length} filament slots:`,
          slots.map(p => `${p.extruder}: ${p.hex} (${p.triangles} triangles)`).join(', '));
      }
    });
  }, [withExportGroup, baseName, showNotice]);

  const export3mf = useCallback(() => {
    // Sections made by Split for Print know which way up they print. When
    // there are some, offer the print job — each section stood that way, the
    // rest of the scene as it stands, all laid out on the bed — rather than the
    // scene as it is placed. No size prompt for those: they were cut to fit
    // this bed, and rescaling would undo that. The plate is built from the
    // graph (utils/printExport), the same file physics_export_print writes, so
    // paint and every part's volumes go with it.
    const { sceneGraph: graph, printBed } = useStore.getState();
    let posed = 0;
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (n.printPose) posed++;
        walk(n.children || []);
      }
    };
    walk(graph.nodes);
    if (posed) {
      openDialog({
        title: `Lay out ${posed} split section${posed === 1 ? '' : 's'} on the print bed?`,
        confirmLabel: 'Lay out on bed',
        cancelLabel: 'Export scene as-is',
        body: (
          <>
            <p>
              Each split section will be stood the way it prints and, with the scene's other parts,
              arranged across the <strong>{printBed.widthMm} × {printBed.depthMm} mm</strong> bed.
            </p>
            <p>Choose “Export scene as-is” to export the whole scene in its current pose instead.</p>
          </>
        ),
        onConfirm: () => {
          closeDialog();
          const result = exportPrintFiles(graph, { format: '3mf', plate: true, bed: printBed });
          const file = result.files[0];
          if (!file) {
            showNotice('Nothing to export', 'There are no printable parts in the scene to export.');
            return;
          }
          downloadBlob(new Blob([file.bytes.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${baseName()}_plate.3mf`);
        },
        onCancel: () => {
          closeDialog();
          exportWholeScene3mf();
        },
      });
      return;
    }

    exportWholeScene3mf();
  }, [exportWholeScene3mf, baseName, openDialog, closeDialog, showNotice]);

  return { exportStl, export3mf };
}

/**
 * The scene, as meshes ready to be written to a file.
 *
 * Shared by every mesh export rather than copied per format: they all want
 * the same thing — world-space geometry, scaled to a real size, Z-up — and
 * the only difference between them is what gets written afterwards. Materials
 * come along, because two of the three formats can carry colour and the one
 * that cannot simply ignores them.
 *
 * Prompts with the in-app export size modal when parts have positive size.
 * With `only`, just the meshes drawn for those bodies go in.
 */
function useExportGroup(threeSceneRef: RefObject<THREE.Scene | null>) {
  const showNotice = useDialogs((s) => s.showNotice);
  const promptScale = useDialogs((s) => s.promptScale);

  return useCallback((title: string, onReady: (exportGroup: THREE.Group) => void, only?: ReadonlySet<string>) => {
    const scene = threeSceneRef.current;
    if (!scene) {
      showNotice('Scene not ready', 'Wait for the 3D scene to finish loading before exporting.');
      return;
    }

    // Find the nearest ancestor tagged with a body's nodeId (set on DynamicGeom's
    // wrapper <group name={nodeId}>), so multi-part scenes (e.g. an enclosure's
    // box + lid sitting side by side) can be scaled by a single part's size
    // rather than the combined footprint of everything visible.
    const findNodeId = (obj: THREE.Object3D): string | null => {
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (cur.name) return cur.name;
        cur = cur.parent;
      }
      return null;
    };

    const exportGroup = new THREE.Group();
    const partBboxes = new Map<string, THREE.Box3>();
    let ungroupedIdx = 0;
    const ownedByOnly = (obj: THREE.Object3D) => {
      for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) {
        if (only!.has(cur.name)) return true;
      }
      return false;
    };
    // Bought, not made: a bearing or a screw in the part is drawn, but not printed.
    const bought = new Set<string>();
    const collectBought = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (isBoughtIn(n)) bought.add(n.id);
        collectBought(n.children || []);
      }
    };
    collectBought(useStore.getState().sceneGraph.nodes);
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      if (only && !ownedByOnly(obj)) return;
      const owner = findNodeId(obj);
      if (owner && bought.has(owner)) return;
      const mesh = obj as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const standard = mats.find(m => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) as THREE.MeshStandardMaterial | undefined;
      // Only lit surfaces are the model. The brush ring, the CSG ghosts and the
      // shadow catcher are all basic/shadow materials and stay out of the file.
      if (!standard) return;
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // The material is cloned so that turning the viewport to wireframe does
      // not export a wireframe — that is a way of looking at the model, not a
      // property of it.
      const material = standard.clone();
      material.wireframe = false;
      const exported = new THREE.Mesh(geo, material);
      exported.name = findNodeId(mesh) ?? mesh.name ?? `part_${ungroupedIdx}`;
      exportGroup.add(exported);

      const partKey = findNodeId(mesh) ?? `__ungrouped_${ungroupedIdx++}`;
      const meshBbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
      const existing = partBboxes.get(partKey);
      if (existing) existing.union(meshBbox);
      else partBboxes.set(partKey, meshBbox);
    });

    if (exportGroup.children.length === 0) {
      showNotice('Nothing to export', only
        ? 'Nothing is drawn for this part yet, so there is nothing to export.'
        : 'There are no visible 3D parts in the scene to export.');
      return;
    }

    // Normalize: fit the LONGEST SINGLE PART's longest side to a user-specified
    // target in mm (not the combined bounding box of everything visible), centered
    // at origin. Also convert from Three.js Y-up (the scene's convention) to the
    // Z-up convention STL/slicers expect - otherwise the export comes out on its
    // side even though the on-screen render (Y-up, handled natively by Three.js)
    // looks correct.
    const bbox = new THREE.Box3().setFromObject(exportGroup);
    let longestPartDim = 0;
    for (const partBbox of partBboxes.values()) {
      const partSize = partBbox.getSize(new THREE.Vector3());
      longestPartDim = Math.max(longestPartDim, partSize.x, partSize.y, partSize.z);
    }
    if (longestPartDim > 0) {
      const defaultMm = Math.round(longestPartDim * 1000).toString();
      promptScale({
        title,
        value: defaultMm,
        onConfirm: (targetMm) => {
          const scale = targetMm / longestPartDim;
          const center = bbox.getCenter(new THREE.Vector3());
          const transform = new THREE.Matrix4()
            .makeRotationX(Math.PI / 2)
            .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
            .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
          for (const child of exportGroup.children) {
            (child as THREE.Mesh).geometry.applyMatrix4(transform);
          }
          onReady(exportGroup);
        },
      });
      return;
    }

    onReady(exportGroup);
  }, [threeSceneRef, showNotice, promptScale]);
}

/**
 * STL of one body, and every body below it in the tree, as the viewport draws
 * it — for the inspector's Export STL. Named after the body.
 */
export function useNodeStlExport(threeSceneRef: RefObject<THREE.Scene | null>) {
  const withExportGroup = useExportGroup(threeSceneRef);
  return useCallback((node: SceneNode) => {
    const ids = new Set<string>();
    const walk = (n: SceneNode) => { ids.add(n.id); (n.children || []).forEach(walk); };
    walk(node);
    withExportGroup(`Export ${node.name || node.id} as STL`, (exportGroup) => {
      const exporter = new STLExporter();
      const result = exporter.parse(exportGroup, { binary: true }) as DataView;
      downloadBlob(new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' }), `${node.name || node.id}.stl`);
    }, ids);
  }, [withExportGroup]);
}
