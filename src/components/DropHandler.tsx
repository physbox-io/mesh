import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { useStore } from '../store/useStore';

type StoreState = ReturnType<typeof useStore.getState>;
type AddComponentType = Parameters<StoreState['addComponent']>[0];

// Drop Handler for precise spawning & external file imports (.scad, .stl, .json)
export const DropHandler = ({ addComponent, onImportFile, onImportImageFile, onImportSceneJson }: {
  addComponent: (type: AddComponentType, pos: [number, number, number]) => void;
  onImportFile: (file: File) => void;
  onImportImageFile: (file: File) => void;
  onImportSceneJson: (text: string, fileName: string, dropped: boolean) => void;
}) => {
  const { camera, gl } = useThree();
  
  useEffect(() => {
    const handler = async (e: DragEvent) => {
      e.preventDefault();
      
      // 1. External files dropped (e.g. from desktop or file explorer)
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileName = file.name;
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

          if (ext === '.json') {
            // The same path as the Import button, so a dropped scene is checked,
            // reported and set up the same way rather than swapped in silently.
            onImportSceneJson(await file.text(), fileName, true);
            break;
          } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|avif)$/.test(ext)) {
            // An image can only mean the heightmap importer — it is the one
            // path that turns 2D pixels into a body.
            onImportImageFile(file);
            break;
          } else if (ext === '.scad' || ext === '.stl') {
            // Hand the file to the import dialog rather than guessing: how an
            // STL should come in (CSG primitives, polyhedron, raw mesh) is the
            // whole point of that dialog, and a silent default import was
            // indistinguishable from the drop having done nothing.
            onImportFile(file);
            break;
          }
        }
        return;
      }

      // 2. Sidebar component drag
      const type = e.dataTransfer?.getData('type') as AddComponentType | undefined;
      if (!type) return;
      
      const rect = gl.domElement.getBoundingClientRect();
      const xLocal = e.clientX - rect.left;
      const yLocal = e.clientY - rect.top;

      const vec = new THREE.Vector3(
        (xLocal / rect.width) * 2 - 1,
        -(yLocal / rect.height) * 2 + 1,
        0.5
      );
      vec.unproject(camera);
      const dir = vec.sub(camera.position).normalize();
      
      // Intersect with Canvas Y=0 plane (which maps to MuJoCo Z=0)
      if (Math.abs(dir.y) < 0.001) return;
      const distance = -camera.position.y / dir.y; 
      if (distance < 0) return;
      
      const pos = camera.position.clone().add(dir.multiplyScalar(distance));
      
      let x = pos.x;
      let z = -pos.z;
      
      if (isNaN(x) || isNaN(z)) return;
      
      x = Math.max(-0.45, Math.min(0.45, x));
      z = Math.max(-0.45, Math.min(0.45, z));
      
      addComponent(type, [x, z, 0.2]);
    };
    
    const dragOverHandler = (e: DragEvent) => e.preventDefault();
    
    window.addEventListener('drop', handler);
    window.addEventListener('dragover', dragOverHandler);
    return () => {
      window.removeEventListener('drop', handler);
      window.removeEventListener('dragover', dragOverHandler);
    };
  }, [camera, gl, addComponent, onImportFile, onImportImageFile, onImportSceneJson]);
  
  return null;
};
