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
import { footprintGroups } from '../utils/footprintGroups';

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

  const baseName = useCallback(() => exportBaseName(noteCards, activePreset, useStore.getState().sceneGraph.name), [noteCards, activePreset]);

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
    const { sceneGraph: graph, hiddenNodeIds } = useStore.getState();
    const hidden = new Set(hiddenNodeIds);
    let posed = 0;
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (hidden.has(n.id)) continue;
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
    const { sceneGraph: graph, printBed, hiddenNodeIds } = useStore.getState();
    const hidden = new Set(hiddenNodeIds);
    let posed = 0;
    // Generated molds lie in the scene as they close and pour, each insert in
    // its holder. To print, every holder, insert and insert piece is an object
    // of its own, laid out on the bed.
    const molds: SceneNode[] = [];
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        if (hidden.has(n.id)) continue;
        if (n.printPose) posed++;
        if (n.simulation?.kind === 'mold' && (n.geoms?.length ?? 0) > 0) molds.push(n);
        walk(n.children || []);
      }
    };
    walk(graph.nodes);
    if (molds.length) {
      const pieces = molds.reduce((sum, n) => sum + (n.geoms?.length ?? 0), 0);
      openDialog({
        title: `Lay out the mold's ${pieces} printed parts on the print bed?`,
        confirmLabel: 'Lay out on bed',
        cancelLabel: 'Export scene as-is',
        body: (
          <>
            <p>
              Each holder, insert and insert piece of {molds.length === 1 ? (molds[0].name || 'the mold') : `the ${molds.length} molds`} becomes
              an object of its own, standing the way it prints, arranged across the <strong>{printBed.widthMm} × {printBed.depthMm} mm</strong> bed.
              The part the mold was made from is left out.
            </p>
            <p>Choose “Export scene as-is” to export the whole scene as it is placed instead.</p>
          </>
        ),
        onConfirm: () => {
          closeDialog();
          const result = exportPrintFiles(graph, { format: '3mf', plate: true, bed: printBed, ids: molds.map((n) => n.id), moldParts: true });
          const file = result.files[0];
          if (!file) {
            showNotice('Nothing to export', 'The mold has no printable parts to export.');
            return;
          }
          downloadBlob(new Blob([file.bytes.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${baseName()}_mold_plate.3mf`);
        },
        onCancel: () => {
          closeDialog();
          exportWholeScene3mf();
        },
      });
      return;
    }
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
    // wrapper <group name={nodeId}>): it names each exported mesh, and bought
    // hardware is left out by it.
    // The lattice and sculpt tools draw a body under a group of their own,
    // named for the tool and tagged with the body (`userData.bodyId`); its mesh
    // is named for the geom. Read by name alone, an export with either tool
    // open named the part after its geom, and a per-body export found nothing.
    const findNodeId = (obj: THREE.Object3D): string | null => {
      for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) {
        if (typeof cur.userData?.bodyId === 'string') return cur.userData.bodyId;
      }
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (cur.name) return cur.name;
        cur = cur.parent;
      }
      return null;
    };

    const exportGroup = new THREE.Group();
    const meshBoxes: THREE.Box3[] = [];
    let ungroupedIdx = 0;
    const ownedByOnly = (obj: THREE.Object3D) => {
      for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) {
        if (only!.has(cur.name) || (typeof cur.userData?.bodyId === 'string' && only!.has(cur.userData.bodyId))) return true;
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
    const isBackgroundObj = (obj: THREE.Object3D): boolean => {
      for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) {
        if (cur.userData?.isBackground) return true;
      }
      return false;
    };
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      if (isBackgroundObj(obj)) return;
      // An instanced mesh is owned instance by instance; see below.
      if (only && !(obj as THREE.InstancedMesh).isInstancedMesh && !ownedByOnly(obj)) return;
      const owner = findNodeId(obj);
      if (owner && bought.has(owner)) return;
      const mesh = obj as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const standard = mats.find(m => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) as THREE.MeshStandardMaterial | undefined;
      // Only lit surfaces are the model. The brush ring, the CSG ghosts and the
      // shadow catcher are all basic/shadow materials and stay out of the file.
      if (!standard) return;
      // Nor is a surface drawn only from behind: the lattice and sculpt tools'
      // shading of a body's inside, so a hole in it reads as one. Exported, it
      // was every triangle of the body a second time.
      if (standard.side === THREE.BackSide) return;
      mesh.updateWorldMatrix(true, false);
      /*
       * Static boxes are drawn as one InstancedMesh: a unit cube, placed per
       * instance. Taken as an ordinary mesh it went out as that unit cube - one
       * metre on a side at the origin, every real box missing, and the size
       * prompt scaling the parts against it. So each instance goes out as a
       * box of its own, owned by its body and in its colour. A hidden one is
       * drawn at zero scale and stays out.
       */
      const instanced = mesh as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) {
        const owners = (instanced.userData?.nodeIds ?? []) as (string | undefined)[];
        const placed = new THREE.Matrix4();
        for (let i = 0; i < instanced.count; i++) {
          instanced.getMatrixAt(i, placed);
          if (Math.abs(placed.determinant()) < 1e-18) continue;
          const instanceOwner = owners[i];
          if (instanceOwner && bought.has(instanceOwner)) continue;
          if (only && !(instanceOwner && only.has(instanceOwner))) continue;
          const geo = instanced.geometry.clone().applyMatrix4(placed.premultiply(instanced.matrixWorld));
          const material = standard.clone();
          material.wireframe = false;
          if (instanced.instanceColor) instanced.getColorAt(i, material.color);
          const exported = new THREE.Mesh(geo, material);
          exported.name = instanceOwner ?? `part_${ungroupedIdx++}`;
          exportGroup.add(exported);
          meshBoxes.push(new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute));
        }
        return;
      }
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // The material is cloned so that turning the viewport to wireframe does
      // not export a wireframe — that is a way of looking at the model, not a
      // property of it.
      const material = standard.clone();
      material.wireframe = false;
      const exported = new THREE.Mesh(geo, material);
      exported.name = findNodeId(mesh) ?? mesh.name ?? `part_${ungroupedIdx++}`;
      exportGroup.add(exported);
      meshBoxes.push(new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute));
    });

    if (exportGroup.children.length === 0) {
      showNotice('Nothing to export', only
        ? 'Nothing is drawn for this part yet, so there is nothing to export.'
        : 'There are no visible 3D parts in the scene to export.');
      return;
    }

    // Normalize: fit the LONGEST SINGLE PART's longest side to a user-specified
    // target in mm (not the combined bounding box of everything visible), centered
    // at origin. A part is what prints as one piece: meshes whose footprints
    // overlap, by the rule the 3MF writer groups its objects with. Not a body,
    // which can hold pieces laid side by side (a mold's two halves), nor a
    // mesh, which can be a liner nested inside its shell. Also convert from Three.js Y-up (the scene's convention) to the
    // Z-up convention STL/slicers expect - otherwise the export comes out on its
    // side even though the on-screen render (Y-up, handled natively by Three.js)
    // looks correct.
    const bbox = new THREE.Box3().setFromObject(exportGroup);
    // Three.js is Y-up here, so the bed is X and Z; 10 µm, in metres, as the 3MF writer's 0.01 mm.
    const pieceOf = footprintGroups(
      meshBoxes.map((b) => ({ min: b.min.toArray(), max: b.max.toArray() })),
      { axes: [0, 2], minOverlap: 1e-5 },
    );
    const pieceBoxes = new Map<number, THREE.Box3>();
    meshBoxes.forEach((box, i) => {
      const piece = pieceBoxes.get(pieceOf[i]);
      if (piece) piece.union(box);
      else pieceBoxes.set(pieceOf[i], box.clone());
    });
    let longestPartDim = 0;
    for (const pieceBox of pieceBoxes.values()) {
      const size = pieceBox.getSize(new THREE.Vector3());
      longestPartDim = Math.max(longestPartDim, size.x, size.y, size.z);
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
