
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { useMuJoCoInit } from './hooks/useMuJoCo';
import { useMCPBridge } from './hooks/useMCPBridge';
import { useStore, scaleMeshGeoms, getPhysicsWorkerClient } from './store/useStore';
import type { SceneGraph, SceneNode } from './types/scene';
import { Play, Square, SlidersHorizontal, Settings, Box, Circle, X, RotateCcw, Trash2, Layers, CircleDot, Zap, Info, Triangle, Disc, Code, Menu, Shapes, Minimize2, Save, Download, Upload, Undo, Redo, FileText, ChevronDown, ChevronUp, Edit3, Printer, Scissors, Sparkles, Sun, Moon, Pyramid, Cone, Donut } from 'lucide-react';
import { useRef, useMemo, useEffect, useCallback, useState, type RefObject } from 'react';
import AICopilotPanel from './components/AICopilotPanel';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { loadCompiler, compileSCAD, isCompilerReady } from './utils/openscad';

// Simple robust markdown parser to convert basic markdown text to safe HTML
// Markdown parser for note cards
function parseNoteMarkdown(md: string): string {
  if (!md) return '';
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-xs font-bold text-slate-800 dark:text-slate-200 mt-2 mb-1 uppercase tracking-wide">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-sm font-bold text-slate-800 dark:text-slate-200 mt-3 mb-1 border-b border-slate-100 dark:border-slate-800 pb-0.5">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-base font-extrabold text-slate-900 dark:text-slate-100 mt-3 mb-2 border-b border-slate-200 dark:border-slate-800 pb-1">$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-slate-100">$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-slate-700 dark:text-slate-300">$1</em>');
  html = html.replace(/`(.*?)`/g, '<code class="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-[10px] font-mono text-pink-600 dark:text-pink-400">$1</code>');
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">$1</a>');
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li class="ml-4 list-disc text-slate-600 dark:text-slate-300 text-xs mb-0.5">$1</li>');
  html = html.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('<h') || t.startsWith('<li') || t === '') return line;
    return `<p class="text-xs text-slate-600 dark:text-slate-300 mb-1.5 leading-relaxed">${line}</p>`;
  }).join('\n');
  return html;
}

// Floating note card overlay component
function NoteCardOverlay({ card, isEditing, onToggleEdit, onToggleMinimize, onMarkdownChange, onClose, onMove }: {
  card: { id: string; markdown: string; minimized: boolean; x: number; y: number };
  isEditing: boolean;
  onToggleEdit: () => void;
  onToggleMinimize: () => void;
  onMarkdownChange: (md: string) => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleTitleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };
    const handleMouseMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      onMove(dragRef.current.origX + me.clientX - dragRef.current.startX, dragRef.current.origY + me.clientY - dragRef.current.startY);
    };
    const handleMouseUp = () => { dragRef.current = null; window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      style={{ position: 'absolute', left: card.x, top: card.y, zIndex: 25, width: 300 }}
      className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl overflow-hidden"
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-950/40 border-b border-slate-100 dark:border-slate-800 cursor-move select-none"
        onMouseDown={handleTitleMouseDown}
      >
        <div className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Note Card</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggleEdit} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={isEditing ? 'Preview' : 'Edit'}>
            <Edit3 className="w-3 h-3 text-slate-500 dark:text-slate-400" />
          </button>
          <button onClick={onToggleMinimize} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={card.minimized ? 'Expand' : 'Minimize'}>
            {card.minimized ? <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400" /> : <ChevronUp className="w-3 h-3 text-slate-500 dark:text-slate-400" />}
          </button>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 transition-colors" title="Close">
            <X className="w-3 h-3 text-slate-500 dark:text-slate-400 hover:text-red-500" />
          </button>
        </div>
      </div>

      {/* Body */}
      {!card.minimized && (
        <div className="p-3">
          {isEditing ? (
            <textarea
              autoFocus
              rows={8}
              value={card.markdown}
              onChange={(e) => onMarkdownChange(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-200 dark:border-slate-800 rounded text-xs bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 outline-none focus:border-violet-400 font-mono resize-y shadow-sm"
              placeholder="Write markdown here..."
            />
          ) : (
            <div
              className="prose-sm dark:prose-invert max-h-64 overflow-y-auto text-slate-700 dark:text-slate-300"
              dangerouslySetInnerHTML={{ __html: parseNoteMarkdown(card.markdown) }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Physics Step Hook
//
// Actual physics stepping, script execution (incl. aerodynamics), free-joint
// damping, drag-force application, and history recording now all live in the
// dedicated physics worker (src/workers/physicsWorker.ts) so that on
// unrecoverable WASM memory exhaustion the worker can be terminated and a
// fresh one spawned — a real memory reclaim. This component's only remaining
// job is forwarding keyboard state to the worker, since scripts' `isKeyPressed`
// needs it and the worker has no DOM access of its own.
const PhysicsLoop = ({ isPlaying }: { model: any, data: any, mujoco: any, isPlaying: boolean }) => {
  useFrame((_state, delta) => {
    if ((window as any).DISABLE_USEFRAME) return;
    if (!isPlaying) return;
    if (typeof SharedArrayBuffer === 'undefined') {
      getPhysicsWorkerClient().tick(delta);
    }
  });

  useEffect(() => {
    const pressedKeys = new Set<string>();
    const sync = () => getPhysicsWorkerClient().setKeys(Array.from(pressedKeys));

    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.getAttribute('contenteditable') === 'true'
      )) {
        return;
      }
      pressedKeys.add(e.key.toLowerCase());
      pressedKeys.add(e.code.toLowerCase());
      sync();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      pressedKeys.delete(e.key.toLowerCase());
      pressedKeys.delete(e.code.toLowerCase());
      sync();
    };

    const handleBlur = () => {
      pressedKeys.clear();
      sync();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  return null;
};

// AxisLegendDrawer — lives inside the R3F Canvas, reads camera every frame and draws
// MuJoCo XYZ axes onto an external HTML canvas element passed via ref.
// MuJoCo coord system: X=right (red), Y=into screen (green), Z=up (blue)
// Three.js Y-up mapping: mujoco(x,y,z) → three(x, z, -y)
const AxisLegendDrawer = ({ externalRef }: { externalRef: RefObject<HTMLCanvasElement | null> }) => {
  const { camera } = useThree();

  useFrame(() => {
    const el = externalRef.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const W = el.width;
    const H = el.height;
    const cx = W / 2;
    const cy = H / 2 + 6; // shift down to give Z arrow more headroom at top
    const len = W * 0.36;

    ctx.clearRect(0, 0, W, H);

    // Project a MuJoCo direction vector through the live camera view matrix
    const projectAxis = (dx: number, dy: number, dz: number): [number, number] => {
      // MuJoCo(x,y,z) → Three.js world direction: three(x, z, -y)
      const worldDir = new THREE.Vector3(dx, dz, -dy);
      worldDir.normalize();
      const viewDir = worldDir.clone().transformDirection(camera.matrixWorldInverse);
      // view space: x=right, y=up → screen: x=right, y=down
      return [viewDir.x * len, -viewDir.y * len];
    };

    const axes = [
      { dir: [1, 0, 0] as const, color: '#ef4444', label: 'X', shadow: '#7f1d1d' },
      { dir: [0, 1, 0] as const, color: '#22c55e', label: 'Y', shadow: '#14532d' },
      { dir: [0, 0, 1] as const, color: '#3b82f6', label: 'Z', shadow: '#1e3a8a' },
    ];

    // Compute projections and sort back-to-front
    const projected = axes.map(a => {
      const [px, py] = projectAxis(a.dir[0], a.dir[1], a.dir[2]);
      const worldDir = new THREE.Vector3(a.dir[0], a.dir[2], -a.dir[1]);
      const viewDir = worldDir.clone().transformDirection(camera.matrixWorldInverse);
      return { ...a, px, py, depth: viewDir.z };
    });
    projected.sort((a, b) => a.depth - b.depth);

    const arrowHead = (x: number, y: number, ax: number, ay: number, size: number) => {
      const angle = Math.atan2(ay, ax);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - size * Math.cos(angle - 0.4), y - size * Math.sin(angle - 0.4));
      ctx.lineTo(x - size * Math.cos(angle + 0.4), y - size * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    };

    for (const { px, py, color, label, shadow } of projected) {
      const ex = cx + px;
      const ey = cy + py;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 2;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = color;
      arrowHead(ex, ey, px, py, 8);
      ctx.restore();

      // Label: fixed 13px past the arrowhead tip, along the arrow direction.
      // Normalizing prevents the label from jumping when the axis is nearly
      // perpendicular to the screen (small projected length).
      const mag = Math.sqrt(px * px + py * py);
      if (mag > 2) {
        const nx = px / mag;
        const ny = py / mag;
        const lx = ex + nx * 13;
        const ly = ey + ny * 13;
        ctx.save();
        ctx.font = 'bold 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = shadow;
        ctx.fillText(label, lx + 0.5, ly + 0.5);
        ctx.fillStyle = color;
        ctx.fillText(label, lx, ly);
        ctx.restore();
      }
    }

    // Origin dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#64748b';
    ctx.fill();
  });

  return null;
};

// Camera Controller
const CameraController = () => {
  const { camera } = useThree();
  const cameraView = useStore(state => state.cameraView);
  const controlsRef = useRef<any>(null);
  
  useEffect(() => {
    if (cameraView === 'topDown') {
      camera.position.set(0, 15, 0);
      camera.up.set(0, 0, -1);
      camera.lookAt(0, 0, 0);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }
    } else {
      camera.position.set(5, 2, 5);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }
    }
    camera.updateProjectionMatrix();
  }, [cameraView, camera]);

  const draggedNodeId = useStore((state) => state.draggedNodeId);
  return <OrbitControls enabled={draggedNodeId === null} ref={controlsRef} makeDefault enableDamping dampingFactor={0.1} mouseButtons={{ LEFT: 99 as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }} />;
};

// Drop Handler for precise spawning
const DropHandler = ({ addComponent }: { addComponent: (type: any, pos: [number, number, number]) => void }) => {
  const { camera, gl } = useThree();
  
  useEffect(() => {
    const handler = (e: DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer?.getData('type') as any;
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
      
      x = Math.max(-20, Math.min(20, x));
      z = Math.max(-20, Math.min(20, z));
      
      addComponent(type, [x, z, 2]);
    };
    
    const dragOverHandler = (e: DragEvent) => e.preventDefault();
    
    window.addEventListener('drop', handler);
    window.addEventListener('dragover', dragOverHandler);
    return () => {
      window.removeEventListener('drop', handler);
      window.removeEventListener('dragover', dragOverHandler);
    };
  }, [camera, gl, addComponent]);
  
  return null;
};


// Custom Triangular Prism Wedge Geometry
const WedgeGeometry = ({ width = 2.0, depth = 1.0, height = 0.5 }: { width: number; depth: number; height: number }) => {
  const vertices = useMemo(() => {
    const L = Math.sqrt(width * width + height * height);
    const D = depth;
    const cosTheta = width / L;
    const H_local = height / cosTheta;
    const halfL = L / 2;
    const halfD = D / 2;

    // 6 Vertices of the pre-tilted solid wedge prism:
    // T0, T1, T2, T3 (top slanted face at z = 0)
    // B0, B1 (bottom back vertices at z = -H_local so that base becomes perfectly horizontal after -theta rotation)
    return new Float32Array([
      -halfL, -halfD, 0,          // 0: T0
       halfL, -halfD, 0,          // 1: T1
       halfL,  halfD, 0,          // 2: T2
      -halfL,  halfD, 0,          // 3: T3
      -halfL, -halfD, -H_local,   // 4: B0
      -halfL,  halfD, -H_local    // 5: B1
    ]);
  }, [width, depth, height]);

  const indices = useMemo(() => {
    return new Uint16Array([
      // Slanted Top Face (looking up)
      0, 2, 1,
      0, 3, 2,
      // Bottom Face (looking down)
      1, 5, 4,
      1, 2, 5,
      // Back Vertical Wall (looking left)
      0, 4, 5,
      0, 5, 3,
      // Front Triangle side (y = -halfD, looking front)
      0, 1, 4,
      // Back Triangle side (y = halfD, looking back)
      3, 5, 2
    ]);
  }, []);

  const geomRef = useRef<THREE.BufferGeometry>(null);
  useEffect(() => {
    if (geomRef.current) {
      geomRef.current.computeVertexNormals();
    }
  }, [vertices]);

  return (
    <bufferGeometry ref={geomRef}>
      <bufferAttribute
        attach="attributes-position"
        args={[vertices, 3]}
      />
      <bufferAttribute
        attach="index"
        args={[indices, 1]}
      />
    </bufferGeometry>
  );
};


// Dynamic Geom Renderer
const DynamicGeom = ({ nodeId, name, type, color, mujoco, model, data, selectedNodeId, setSelectedNodeId, vertices, faces, dynamic: isDynamic, providedGeomId }: any) => {
  const meshRef = useRef<THREE.Group>(null);
  const isPlaying = useStore(state => state.isPlaying);
  
  const node = useStore(state => {
    if (!nodeId) return null;
    const find = (nodes: any[]): any => {
      if (!nodes) return null;
      for (const n of nodes) {
        if (n.id === nodeId) return n;
        const c = find(n.children);
        if (c) return c;
      }
      return null;
    };
    return find(state.sceneGraph.nodes);
  });
  
  const geomId = useMemo(() => {
    if (providedGeomId !== undefined) return providedGeomId;
    if (!model || !mujoco) return -1;
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name);
    console.log(`[DynamicGeom ${name}] computed geomId:`, id);
    return id;
  }, [providedGeomId, model, mujoco, name]);

  const geometryArgs = useMemo(() => {
    if (geomId === -1 || !model) return [];
    try {
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return [];

      const r = model.geom_size[geomId * 3];
      const hl = model.geom_size[geomId * 3 + 1];
      const hz = model.geom_size[geomId * 3 + 2];
      
      if (type === 'sphere') return [r, 32, 32];
      if (type === 'box') return [r * 2, hl * 2, hz * 2];
      if (type === 'capsule') return [r, hl * 2, 4, 16];
      if (type === 'cylinder') return [r, hl];
      if (type === 'ellipsoid') return [r, hl, hz];
      return [r];
    } catch (e) {
      console.error(`[DynamicGeom ${name}] geometryArgs Error:`, e);
      return [];
    }
  }, [geomId, type, model]);

  const rotationMatrix = useMemo(() => new THREE.Matrix4(), []);
  const isSelected = selectedNodeId === nodeId;

  // Handlers for physical spring dragging, mapped from Three.js coordinates to MuJoCo coordinate space
  const dragHandlers = useMemo(() => ({
    onClick: (e: any) => {
      e.stopPropagation();
      setSelectedNodeId(nodeId);
    },
    onPointerDown: (e: any) => {
      if (isPlaying) {
        e.stopPropagation();
        useStore.getState().setDraggedNodeId(nodeId);
        useStore.getState().setDragDistance(e.distance);
        
        const pt = e.point;
        // Transform standard Three.js world coordinates (Y-up) to MuJoCo coordinate space (Z-up)
        useStore.getState().setDragTarget({ x: pt.x, y: -pt.z, z: pt.y });
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch (err) {}
      }
    },
    onPointerUp: (e: any) => {
      if (useStore.getState().draggedNodeId === nodeId) {
        e.stopPropagation();
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch (err) {}
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
      }
    },
    onPointerCancel: (e: any) => {
      if (useStore.getState().draggedNodeId === nodeId) {
        e.stopPropagation();
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch (err) {}
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
      }
    }
  }), [isPlaying, nodeId, setSelectedNodeId]);

  // For dynamic meshes, use body xpos/xmat so renderVertices (centroid-local) align correctly.
  const bodyId = useMemo(() => {
    if (!isDynamic || !model || !mujoco) return -1;
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
  }, [isDynamic, model, mujoco, nodeId]);

  // Compute initial position and rotation from the model/data
  const [initialPos, initialQuat] = useMemo(() => {
    if (!model || !data) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
    try {
      // Dynamic meshes: use body xpos/xmat (renderVertices are in body-local space)
      if (isDynamic && bodyId !== -1) {
        const px = data.xpos[bodyId * 3];
        const py = data.xpos[bodyId * 3 + 1];
        const pz = data.xpos[bodyId * 3 + 2];
        const m = data.xmat;
        const offset = bodyId * 9;
        const mat = new THREE.Matrix4().set(
          m[offset], m[offset+1], m[offset+2], 0,
          m[offset+3], m[offset+4], m[offset+5], 0,
          m[offset+6], m[offset+7], m[offset+8], 0,
          0, 0, 0, 1
        );
        const q = new THREE.Quaternion().setFromRotationMatrix(mat);
        return [[px, py, pz] as [number, number, number], [q.x, q.y, q.z, q.w] as [number, number, number, number]];
      }
      if (geomId === -1) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];

      const px = data.geom_xpos[geomId * 3];
      const py = data.geom_xpos[geomId * 3 + 1];
      const pz = data.geom_xpos[geomId * 3 + 2];

      const m = data.geom_xmat;
      const offset = geomId * 9;
      const mat = new THREE.Matrix4().set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );
      const q = new THREE.Quaternion().setFromRotationMatrix(mat);
      return [[px, py, pz] as [number, number, number], [q.x, q.y, q.z, q.w] as [number, number, number, number]];
    } catch (e) {
      return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
    }
  }, [isDynamic, bodyId, geomId, model, data]);

  useFrame(() => {
    // Safety check: ensure closure model/data match current store active ones
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;

    if ((window as any).DISABLE_USEFRAME) return;
    if (type === 'mesh' && !isDynamic) return;
    if (!meshRef.current || !model || !data) return;

    try {
      // Dynamic meshes: track body xpos/xmat (renderVertices are in body-local space)
      if (isDynamic && bodyId !== -1) {
        const px = data.xpos[bodyId * 3];
        const py = data.xpos[bodyId * 3 + 1];
        const pz = data.xpos[bodyId * 3 + 2];
        const m = data.xmat;
        const offset = bodyId * 9;
        rotationMatrix.set(
          m[offset], m[offset+1], m[offset+2], 0,
          m[offset+3], m[offset+4], m[offset+5], 0,
          m[offset+6], m[offset+7], m[offset+8], 0,
          0, 0, 0, 1
        );
        meshRef.current.position.set(px, py, pz);
        meshRef.current.quaternion.setFromRotationMatrix(rotationMatrix);
        return;
      }

      if (geomId === -1) return;
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return;

      const px = data.geom_xpos[geomId * 3];
      const py = data.geom_xpos[geomId * 3 + 1];
      const pz = data.geom_xpos[geomId * 3 + 2];

      const m = data.geom_xmat;
      const offset = geomId * 9;
      rotationMatrix.set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );

      meshRef.current.position.set(px, py, pz);
      meshRef.current.quaternion.setFromRotationMatrix(rotationMatrix);
    } catch (e) {
      // Safely ignore deleted object or transition errors
    }
  });

  // Build Three.js BufferGeometry from inline vertex/face arrays for mesh type
  const meshBufferGeometry = useMemo(() => {
    if (type !== 'mesh' || !vertices || !faces) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    geo.computeVertexNormals();
    return geo;
  }, [type, vertices, faces]);

  if (type === 'mesh') {
    if (!meshBufferGeometry) return null;
    if (isDynamic) {
      // Dynamic mesh: transform tracked from MuJoCo via geom_xpos/geom_xmat (Z-up coords, handled by parent group rotation).
      // Deliberately FrontSide (not DoubleSide): these come from OpenSCAD's
      // CSG boolean STL export (difference/union/intersection), which is
      // always a closed, watertight solid in principle — you never see its
      // inside from outside the shape. CSG boundaries commonly leave
      // imperfect/ambiguous face winding, and DoubleSide renders those
      // back-facing (inverted-normal) triangles too; since they face away
      // from the light they render solid black, and they z-fight with the
      // correctly-lit front face at the same depth — the "black flashing"
      // seen on OpenSCAD-compiled shapes. FrontSide only ever draws the
      // correctly-wound outer surface, which is all a closed solid needs.
      return (
        <group name={nodeId} ref={meshRef} position={initialPos} quaternion={new THREE.Quaternion(...initialQuat)}>
          <mesh castShadow receiveShadow geometry={meshBufferGeometry} {...dragHandlers}>
            <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} side={THREE.FrontSide} />
          </mesh>
        </group>
      );
    }
    // Static mesh: vertices baked in Three.js world space — no position/rotation applied.
    return (
      <group name={nodeId}>
        <mesh castShadow receiveShadow geometry={meshBufferGeometry} {...dragHandlers}>
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }

  if (geomId === -1 || !geometryArgs || geometryArgs.length === 0 || geometryArgs.some(arg => arg === undefined || isNaN(arg))) {
    return null;
  }

  return (
    <group
      name={nodeId}
      ref={meshRef}
      position={initialPos}
      quaternion={new THREE.Quaternion(...initialQuat)}
    >
      {node?.isWedge ? (
        <mesh castShadow receiveShadow {...dragHandlers}>
          <WedgeGeometry width={node.width || 2.0} depth={node.depth || 1.0} height={node.height || 0.5} />
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
        </mesh>
      ) : type === 'sphere' ? (
        <mesh castShadow receiveShadow {...dragHandlers}>
          <sphereGeometry args={geometryArgs as any} />
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
        </mesh>
      ) : type === 'box' ? (
        <>
          <mesh castShadow receiveShadow {...dragHandlers}>
            <boxGeometry args={geometryArgs as any} />
            <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
          </mesh>
        </>
      ) : type === 'ellipsoid' ? (
        <mesh castShadow receiveShadow scale={[geometryArgs[0], geometryArgs[1], geometryArgs[2]]} {...dragHandlers}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
        </mesh>
      ) : null}
      {type === 'capsule' && (
        <mesh castShadow receiveShadow rotation={[Math.PI / 2, 0, 0]} {...dragHandlers}>
          <capsuleGeometry args={geometryArgs as any} />
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
        </mesh>
      )}
      {type === 'cylinder' && (
        <mesh castShadow receiveShadow rotation={[Math.PI / 2, 0, 0]} {...dragHandlers}>
          <cylinderGeometry args={[geometryArgs[0], geometryArgs[0], geometryArgs[1] * 2, 32]} />
          <meshStandardMaterial color={new THREE.Color(color[0], color[1], color[2])} emissive={isSelected ? '#3b82f6' : '#000'} emissiveIntensity={isSelected ? 0.2 : 0} />
        </mesh>
      )}
    </group>
  );
};

// Dynamic glowing pulley cable/rope renderer
const PulleyRopesRenderer = ({ model, data, mujoco, sceneGraph }: any) => {
  const lineRefs = useRef<{ [ropeId: string]: any }>({});
  const bodyIdCache = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!model || !mujoco) return;
    const c: Record<string, number> = {};
    for (let b = 0; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
      if (name) c[name] = b;
    }
    bodyIdCache.current = c;
  }, [model, mujoco]);
  
  // Find all pulley rope nodes in the scene
  const pulleyRopes = useMemo(() => {
    const ropes: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyRope && n.leftTargetId && n.rightTargetId) {
          ropes.push(n);
        }
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return ropes;
  }, [sceneGraph]);

  // Helper to find wheel node radius reactively
  const findWheelNode = useCallback((wheelId: string) => {
    const traverse = (nodes: any[]): any => {
      if (!nodes) return null;
      for (const n of nodes) {
        if (n.id === wheelId) return n;
        const c = traverse(n.children);
        if (c) return c;
      }
      return null;
    };
    return traverse(sceneGraph.nodes);
  }, [sceneGraph]);

  useFrame(() => {
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;
    if ((window as any).DISABLE_USEFRAME) return;
    if (!model || !data || !mujoco) return;

    for (const rope of pulleyRopes) {
      try {
        const leftId = bodyIdCache.current[rope.leftTargetId] ?? -1;
        const rightId = bodyIdCache.current[rope.rightTargetId] ?? -1;

        if (leftId === -1 || rightId === -1) continue;

        const lx = data.xpos[leftId * 3];
        const ly = data.xpos[leftId * 3 + 1];
        const lz = data.xpos[leftId * 3 + 2];

        const rx = data.xpos[rightId * 3];
        const ry = data.xpos[rightId * 3 + 1];
        const rz = data.xpos[rightId * 3 + 2];

        const points: THREE.Vector3[] = [];

        if (rope.pulleyWheelId) {
          // Pulley wheel present: arc-over-wheel geometry
          const wheelId = bodyIdCache.current[rope.pulleyWheelId] ?? -1;
          if (wheelId === -1) {
            // Wheel not yet spawned — fall back to straight line
            points.push(new THREE.Vector3(lx, ly, lz));
            points.push(new THREE.Vector3(rx, ry, rz));
          } else {
            const wx = data.xpos[wheelId * 3];
            const wy = data.xpos[wheelId * 3 + 1];
            const wz = data.xpos[wheelId * 3 + 2];
            const wheelNode = findWheelNode(rope.pulleyWheelId);
            const rad = wheelNode?.pulleyRadius || 0.4;

            points.push(new THREE.Vector3(lx, ly, lz + 0.15));
            points.push(new THREE.Vector3(wx - rad, wy, wz));
            const segments = 12;
            for (let i = 1; i < segments; i++) {
              const phi = Math.PI - (Math.PI * i) / segments;
              points.push(new THREE.Vector3(
                wx + rad * Math.cos(phi),
                wy,
                wz + rad * Math.sin(phi)
              ));
            }
            points.push(new THREE.Vector3(wx + rad, wy, wz));
            points.push(new THREE.Vector3(rx, ry, rz + 0.15));
          }
        } else {
          // No wheel — straight rope between the two bodies
          points.push(new THREE.Vector3(lx, ly, lz));
          points.push(new THREE.Vector3(rx, ry, rz));
        }

        const line = lineRefs.current[rope.id];
        if (line) {
          line.geometry.setFromPoints(points);
        }
      } catch (e) {
        // Safe check
      }
    }
  });

  if (pulleyRopes.length === 0) return null;

  return (
    <>
      {pulleyRopes.map((rope) => (
        <line key={rope.id} ref={(el) => { lineRefs.current[rope.id] = el; }}>
          <bufferGeometry />
          <lineBasicMaterial color="#3b82f6" linewidth={3.5} transparent opacity={0.9} />
        </line>
      ))}
    </>
  );
};


// Drag interaction controller that handles window-level mouse/pointer movements
const DragInteractionController = () => {
  const { camera, raycaster, gl } = useThree();
  
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const { draggedNodeId, dragDistance } = useStore.getState();
      if (!draggedNodeId) return;

      // Project mouse screen coordinates relative to canvas bounding client rect
      const rect = gl.domElement.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const ndcX = (x / rect.width) * 2 - 1;
      const ndcY = -(y / rect.height) * 2 + 1;

      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      
      const targetPt = new THREE.Vector3();
      raycaster.ray.at(dragDistance, targetPt);

      // Transform standard Three.js world coordinates (Y-up) to MuJoCo coordinate space (Z-up)
      useStore.getState().setDragTarget({
        x: targetPt.x,
        y: -targetPt.z,
        z: targetPt.y
      });
    };

    const handlePointerUp = () => {
      const { draggedNodeId } = useStore.getState();
      if (draggedNodeId) {
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [camera, raycaster, gl]);

  return null;
};


// Real-time mouse drag physical spring force line renderer
const MouseDragForceRenderer = ({ model, data, mujoco }: any) => {
  const draggedNodeId = useStore((state) => state.draggedNodeId);
  const dragTarget = useStore((state) => state.dragTarget);
  const lineRef = useRef<any>(null);
  const bodyIdCache = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!model || !mujoco) return;
    const c: Record<string, number> = {};
    for (let b = 0; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
      if (name) c[name] = b;
    }
    bodyIdCache.current = c;
  }, [model, mujoco]);

  useFrame(() => {
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;
    if ((window as any).DISABLE_USEFRAME) return;
    if (!model || !data || !mujoco || !draggedNodeId || !dragTarget || !lineRef.current) return;

    try {
      const bId = bodyIdCache.current[draggedNodeId] ?? -1;
      if (bId === -1) return;

      const px = data.xpos[bId * 3];
      const py = data.xpos[bId * 3 + 1];
      const pz = data.xpos[bId * 3 + 2];

      const points = [
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(dragTarget.x, dragTarget.y, dragTarget.z)
      ];
      lineRef.current.geometry.setFromPoints(points);
    } catch (e) {
      // Safe check
    }
  });

  if (!draggedNodeId || !dragTarget) return null;

  return (
    <line ref={lineRef}>
      <bufferGeometry />
      <lineBasicMaterial color="#f43f5e" linewidth={4} transparent opacity={0.9} />
    </line>
  );
};

// Rope node placeholder marker – renders a glowing ring for each pulley_rope scene node
const PulleyRopeMarkers = ({ sceneGraph, selectedNodeId, setSelectedNodeId }: any) => {
  const isPlaying = useStore(state => state.isPlaying);

  const ropeNodes = useMemo(() => {
    const ropes: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyRope) ropes.push(n);
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return ropes;
  }, [sceneGraph]);

  if (ropeNodes.length === 0) return null;

  return (
    <>
      {ropeNodes.map((rope) => {
        // pos is [x, y_mujoco, z_mujoco] in scene graph space.
        // The SceneVisuals group is rotated [-PI/2, 0, 0], so we skip that rotation
        // and place markers in raw world space (no group rotation wrapper here).
        // MuJoCo X→Three.js X, MuJoCo Y→Three.js -Z, MuJoCo Z→Three.js Y
        const [mx, my, mz] = rope.pos;
        const threePos: [number, number, number] = [mx, mz, -my];
        const isSelected = selectedNodeId === rope.id;

        return (
          <group key={rope.id} position={threePos}>
            {/* Outer glowing torus ring */}
            <mesh
              rotation={[Math.PI / 2, 0, 0]}
              onClick={(e: any) => { e.stopPropagation(); setSelectedNodeId(rope.id); }}
              onPointerDown={(e: any) => {
                if (isPlaying) {
                  e.stopPropagation();
                  useStore.getState().setDraggedNodeId(rope.id);
                  useStore.getState().setDragDistance(e.distance);
                  const pt = e.point;
                  useStore.getState().setDragTarget({ x: pt.x, y: -pt.z, z: pt.y });
                }
              }}
              onPointerUp={(e: any) => {
                if (useStore.getState().draggedNodeId === rope.id) {
                  e.stopPropagation();
                  useStore.getState().setDraggedNodeId(null);
                  useStore.getState().setDragTarget(null);
                }
              }}
            >
              <torusGeometry args={[0.18, 0.035, 12, 40]} />
              <meshStandardMaterial
                color={isSelected ? '#60a5fa' : '#10b981'}
                emissive={isSelected ? '#3b82f6' : '#047857'}
                emissiveIntensity={isSelected ? 0.8 : 0.4}
                transparent
                opacity={0.92}
              />
            </mesh>
            {/* Small inner dot */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.07, 0.025, 8, 24]} />
              <meshStandardMaterial
                color={isSelected ? '#93c5fd' : '#6ee7b7'}
                emissive={isSelected ? '#93c5fd' : '#6ee7b7'}
                emissiveIntensity={0.5}
                transparent
                opacity={0.85}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
};


const SceneCapture = ({ sceneRef }: { sceneRef: React.MutableRefObject<THREE.Scene | null> }) => {
  const { scene } = useThree();
  useEffect(() => { sceneRef.current = scene; }, [scene, sceneRef]);
  return null;
};

const SceneVisuals = ({ model, data, mujoco, sceneGraph, selectedNodeId, setSelectedNodeId }: any) => {
  const geoms = useMemo(() => {
    if (!sceneGraph) return [];
    const list: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.geoms) {
          for (const geom of node.geoms) {
            list.push({ nodeId: node.id, ...geom });
          }
        }
        traverse(node.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  if (!model || !data || !mujoco) return null;
  
  const primitiveGeoms = geoms.filter(g => g.type !== 'mesh');
  const staticMeshGeoms = geoms.filter(g => g.type === 'mesh' && !g.dynamic);
  const dynamicMeshGeoms = geoms.filter(g => g.type === 'mesh' && g.dynamic);

  const implicitGeoms = useMemo(() => {
    if (!model || !mujoco || !model.geom_type) return [];
    const list: any[] = [];
    const ngeom = model.ngeom;
    const explicitNames = new Set(geoms.map(g => g.name));
    for (let i = 0; i < ngeom; i++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, i);
      if (name && !explicitNames.has(name) && name !== 'floor') {
        const typeId = model.geom_type[i];
        let typeStr = 'sphere';
        if (typeId === 2) typeStr = 'sphere';
        else if (typeId === 3) typeStr = 'capsule';
        else if (typeId === 4) typeStr = 'ellipsoid';
        else if (typeId === 5) typeStr = 'cylinder';
        else if (typeId === 6) typeStr = 'box';
        else if (typeId === 7) typeStr = 'mesh';
        
        const offset = i * 4;
        const color = model.geom_rgba 
          ? Array.from(model.geom_rgba.slice(offset, offset + 4)) 
          : [0.6, 0.4, 0.8, 1];

        list.push({
          providedGeomId: i,
          name,
          type: typeStr,
          rgba: color,
        });
      }
    }
    return list;
  }, [model, mujoco, geoms]);

  return (
    <>
      {/* Primitive geoms and dynamic meshes live in a Z-up→Y-up rotated group */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        {primitiveGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            nodeId={g.nodeId}
            name={g.name}
            type={g.type}
            color={g.rgba || [0.8,0.8,0.8,1]}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
          />
        ))}
        {implicitGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            providedGeomId={g.providedGeomId}
            name={g.name}
            type={g.type}
            color={g.rgba}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
          />
        ))}
        {dynamicMeshGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            nodeId={g.nodeId}
            name={g.name}
            type={g.type}
            color={g.rgba || [0.8,0.8,0.8,1]}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            vertices={g.renderVertices}
            faces={g.faces}
            dynamic={true}
          />
        ))}
        <PulleyRopesRenderer model={model} data={data} mujoco={mujoco} sceneGraph={sceneGraph} />
        <MouseDragForceRenderer model={model} data={data} mujoco={mujoco} />
      </group>
      {/* Static mesh geoms: vertices already in Three.js Y-up space, no rotation needed */}
      {staticMeshGeoms.map(g => (
        <DynamicGeom
          key={g.name}
          nodeId={g.nodeId}
          name={g.name}
          type={g.type}
          color={g.rgba || [0.8,0.8,0.8,1]}
          mujoco={mujoco}
          model={model}
          data={data}
          selectedNodeId={selectedNodeId}
          setSelectedNodeId={setSelectedNodeId}
          vertices={g.vertices}
          faces={g.faces}
        />
      ))}
    </>
  );
};

const CAMERA_CONFIG = { position: [5, 2, 5] as [number, number, number], fov: 50 };

const getSyncedSceneGraph = (
  scene: SceneGraph,
  model: any,
  data: any,
  mujoco: any
): SceneGraph => {
  if (!model || !data || !mujoco) return scene;

  const sceneCopy = JSON.parse(JSON.stringify(scene)) as SceneGraph;

  const syncNode = (
    node: SceneNode,
    parentWorldPos: THREE.Vector3,
    parentWorldQuat: THREE.Quaternion
  ) => {
    if (node.isPulleyRope) {
      if (node.children) {
        for (const child of node.children) {
          syncNode(child, parentWorldPos, parentWorldQuat);
        }
      }
      return;
    }

    const bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name);
    
    let currentWorldPos = parentWorldPos.clone();
    let currentWorldQuat = parentWorldQuat.clone();

    if (bodyId !== -1) {
      const px = data.xpos[bodyId * 3];
      const py = data.xpos[bodyId * 3 + 1];
      const pz = data.xpos[bodyId * 3 + 2];
      currentWorldPos.set(px, py, pz);

      const m = data.xmat;
      const offset = bodyId * 9;
      const rotationMatrix = new THREE.Matrix4().set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );
      currentWorldQuat.setFromRotationMatrix(rotationMatrix);

      const parentQuatInv = parentWorldQuat.clone().invert();
      const localPos = currentWorldPos.clone().sub(parentWorldPos).applyQuaternion(parentQuatInv);
      const localQuat = parentQuatInv.clone().multiply(currentWorldQuat);

      node.pos = [localPos.x, localPos.y, localPos.z];
      node.quat = [localQuat.w, localQuat.x, localQuat.y, localQuat.z];
      
      if (node.euler) {
        delete node.euler;
      }
    }

    if (node.children) {
      for (const child of node.children) {
        syncNode(child, currentWorldPos, currentWorldQuat);
      }
    }
  };

  const identityQuat = new THREE.Quaternion(0, 0, 0, 1);
  const zeroPos = new THREE.Vector3(0, 0, 0);

  for (const node of sceneCopy.nodes) {
    syncNode(node, zeroPos, identityQuat);
  }

  return sceneCopy;
};

const PRESET_NOTE_CARDS: Record<string, string> = {
  empty: `# Blank Scene\n\nAn empty world with just the ground plane.\n\n## Getting started\n- Drag components from the left sidebar into the scene\n- Select a body to edit its mass, size, and material\n- Press **Play** to start the simulation`,

  pendulum: `# Double Pendulum\n\nTwo rigid rods connected by **hinge joints**, exhibiting chaotic motion.\n\n## Physics\n- **Hinge joints** constrain each rod to 1-DOF rotation\n- Small changes in initial angle lead to wildly different trajectories — a hallmark of **deterministic chaos**\n- Energy is conserved (no damping by default)\n\n## Try it\n- Change the initial angle of either bob to see chaos emerge\n- Add joint damping to watch energy decay`,

  cubes: `# Stacked Cubes\n\nRigid-body stacking with contact forces and friction.\n\n## Physics\n- **Free joints** give each cube 6 degrees of freedom\n- Resting contact is resolved by the **constraint solver** (PGS)\n- Stack height is limited by friction and the solver's penetration tolerance\n\n## Try it\n- Reduce floor friction to watch the stack slide\n- Change cube masses to shift the centre of mass`,

  gears: `# Gear System\n\nTwo meshing spur gears coupled by **proximity-aware equality constraints**.\n\n## Physics\n- Direct gear-tooth collision causes jitter; instead, angular velocities are linked via a **joint equality constraint** when gears are within meshing distance\n- Gear ratio is determined by the ratio of tooth counts\n- Uncheck *Allow Mechanical Coupling* to test raw contact\n\n## Key settings\n- **Teeth count** controls gear ratio\n- **Damping** prevents runaway spin`,

  machine: `# Gear Train Machine\n\nA multi-stage gear train demonstrating **torque multiplication**.\n\n## Physics\n- Each meshing pair is proximity-coupled; a driving hinge torque propagates through the chain\n- Output speed = input speed × (product of driver teeth / product of driven teeth)\n- Larger driven gears turn slower but with more torque\n\n## Try it\n- Apply a control script torque to the first gear via \`api.applyJointForce()\`\n- Observe speed reduction at each stage`,

  rack_pinion: `# Rack and Pinion\n\nConverts **rotary motion** (pinion gear) to **linear motion** (rack).\n\n## Physics\n- Pinion hinge rotation is coupled to rack slide translation via a **joint equality constraint** when the bodies are within 0.5 m\n- Linear displacement = pinion angle × pinion pitch radius\n\n## Try it\n- Drive the pinion with a script: \`api.applyJointForce('pinion_hinge', 5)\`\n- Add a load mass to the rack to see force requirements increase`,

  inclined_plane: `# Inclined Plane\n\nClassic mechanics: a block sliding down a ramp under gravity.\n\n## Physics\n- Net force along the plane: *F = mg sin θ − μmg cos θ*\n- **Static friction** prevents motion when *tan θ < μ*\n- Once sliding, **kinetic friction** is lower than static\n\n## Try it\n- Adjust the wedge angle to find the critical slip angle\n- Change the block's friction coefficient in the properties panel`,

  pulley_system: `# Pulley System\n\nA compound pulley demonstrating **mechanical advantage**.\n\n## Physics\n- The rope is simulated as a length-constrained rigid segment via **joint equality**\n- A compound pulley with N rope segments reduces the required force by ×N\n- Rope tension is transferred through the pulley wheel hinge\n\n## Key concepts\n- Ideal mechanical advantage = number of rope segments supporting the load\n- Energy is conserved: you pull further but with less force`,

  cartpole: `# Cartpole\n\nA cart-pole balancing system controlled by an **LQR controller**.\n\n## Physics\n- The cart slides on a frictionless track (slide joint)\n- The pole pivots on a hinge — an **inverted pendulum**, inherently unstable\n- A **Linear Quadratic Regulator (LQR)** applies horizontal force to keep the pole upright\n\n## Control law\n*F = −(k_x·x + k_v·ẋ + k_θ·θ + k_ω·θ̇)*\n\n| Gain | Value | Role |\n|------|-------|------|\n| k_x | 22.0 | Position centering |\n| k_θ | 80.0 | Vertical catch |\n\n## Try it\n- Increase the pole's mass to stress-test the controller\n- Modify gains in the control script`,

  newtons_cradle: `# Newton's Cradle\n\nConservation of **momentum and energy** in elastic collisions.\n\n## Physics\n- Each ball is a pendulum on a hinge joint\n- Collisions are nearly elastic (high restitution)\n- Momentum is transferred through the stationary balls — only the end ball swings out\n- *n* balls swung in → *n* balls swing out (momentum + energy conservation)\n\n## Try it\n- Pull back 2 balls instead of 1 and observe the output`,

  suspension_bridge: `# Suspension Bridge\n\nA cable-stayed bridge demonstrating **static equilibrium** and structural load paths.\n\n## Physics\n- The deck is supported by angled cables under tension\n- Load is transferred: deck → cables → towers → ground\n- Cables can only pull, not push (tension-only members)\n\n## Try it\n- Drop a heavy object onto the deck\n- Remove a cable to see redistribution of load`,

  paper_plane: `# Paper Plane\n\nAerodynamic flight with **lift, drag, and pitch stability**.\n\n## Physics\n- The plane is an **aerodynamic body** (isAerodynamic = true)\n- Lift: *L = ½ ρ v² C_L A sin(α)* where α is angle of attack\n- Drag: *D = ½ ρ v² C_D A*\n- Forces are applied each timestep via the control script\n\n## Key concepts\n- Too steep an angle of attack → stall (lift collapses)\n- Trim angle sets the glide ratio\n\n## Try it\n- Adjust launch velocity and angle in the joint initial velocity\n- Change wind speed in Environment settings`,

  monkey_head: `# Monkey Head\n\nA physics-active body built from **compound primitive geoms** — no mesh required.\n\n## Physics\n- A **free joint** gives the head full 6-DOF motion — it falls, bounces, and rolls\n- The shape is approximated by ~15 ellipsoids, spheres, and boxes (skull, snout, cheeks, eyes, ears…)\n- MuJoCo computes the **composite inertia tensor** automatically from all geoms\n- Collision is handled per-geom — each primitive has its own contact normal\n\n## Key concepts\n- Complex shapes are best approximated by multiple primitives, not a single mesh\n- Compound bodies share one free joint on the root geom\n\n## Try it\n- Increase restitution (bounciness) in the geom friction settings\n- Drop it from different heights via Launch Velocity`,

  golden_gate: `# Golden Gate Bridge (Primitive)\n\nA suspension bridge built from **primitive geoms** (boxes and capsules).\n\n## Physics\n- All structural members are static bodies (no joints = welded to world)\n- The bridge is a rigid visual reference — drop objects onto it!\n- Primitive collision hulls are exact for simple shapes\n\n## Try it\n- Add a free sphere above the deck and watch it roll off\n- Toggle solid/ephemeral collision on bridge members`,

  golden_gate_mesh: `# Golden Gate Bridge (Mesh)\n\nThe same bridge reconstructed with **custom mesh geoms**.\n\n## Physics\n- Deck, towers, and cables are static mesh bodies\n- Mesh collision uses MuJoCo's **convex hull** approximation\n- Concave shapes require decomposition into multiple convex pieces\n\n## Key concepts\n- Mesh vertices authored in Three.js Y-up; Y↔Z swap is automatic\n- Face winding must be outward-facing (CCW viewed from outside)`,

  mesh_collision: `# Mesh Collision Demo\n\nShows a **dynamic convex mesh** (pyramid) interacting with a static ramp.\n\n## Physics\n- The pyramid is a **dynamic mesh** (dynamic: true) with a free joint\n- MuJoCo takes the **convex hull** of the mesh for collision\n- renderVertices are in raw Z-up space for Three.js rendering alignment\n\n## Key concepts\n- Body position tracks the mesh's **volume centroid** (not the base)\n- Set body_pos.z to centroid height to sit flush with the ground`,

  coin_flip: `# Coin Flip\n\nA probabilistic physics experiment demonstrating **initial condition sensitivity**.\n\n## Physics\n- The coin has a free joint (6-DOF)\n- A control script randomises angular velocity at *t = 0* using \`api.setAngularVelocity()\`\n- Heads/tails outcome is determined by which face is up when it lands\n\n## Key concepts\n- Coin toss is deterministic given exact initial conditions\n- Randomness comes from the random seed applied in the script\n\n## Try it\n- Run headless 1000× via MCP to measure heads/tails ratio`,

  windmill: `# Wind Turbine (Aerodynamic)\n\nA three-blade turbine driven by **aerodynamic lift on the blades**.\n\n## Physics\n- Each blade is marked isAerodynamic = true\n- Lift is computed from relative wind velocity and angle of attack\n- The hub hinge converts blade lift torque to rotational speed\n- Wind is set globally via Environment → Wind X\n\n## Key equations\n*L = ½ ρ v_rel² C_L A sin(α)*\n*T = L × arm_length*\n\n## Try it\n- Increase wind speed to raise RPM\n- Change blade pitch angle to find optimal attack angle`,

  physics_only_windmill: `# Wind Turbine (No Aerodynamics)\n\nThe same turbine geometry driven by a **direct script torque** instead of aerodynamics.\n\n## Physics\n- Aerodynamic forces are disabled; a fixed torque is applied via control script\n- Useful for isolating mechanical behaviour from aerodynamic complexity\n- Hinge damping limits maximum RPM\n\n## Try it\n- Compare RPM with the aerodynamic version at the same wind speed\n- Vary damping to tune the speed`,

  traditional_windmill: `# Traditional Windmill (4-Blade)\n\nA classic four-sail Dutch windmill driven by wind pressure.\n\n## Physics\n- Four flat sails create drag-driven rotation (not lift-driven)\n- Each sail is an aerodynamic flat plate; drag dominates at low tip-speed ratios\n- The main shaft hinge connects sail rotation to a milling load\n\n## Try it\n- Adjust sail area (size) to change torque at a given wind speed`,

  drone: `# Quadcopter Drone\n\nA quadrotor UAV with **PD attitude control** and per-rotor thrust.\n\n## Physics\n- Four rotors apply upward thrust and reaction torques\n- **PD controller** compares current orientation to target and commands differential thrust\n- Aerodynamic drag is applied to the frame body\n\n## Control law\n*τ = k_p × error + k_d × error_rate*\n\n## Try it\n- Use arrow keys / WASD to command pitch and roll\n- Adjust k_p and k_d gains in the control script to tune stability\n- Increase rotor drag coefficient to simulate thicker air`,

  bouncy_balls: `# Bouncy Balls\n\n20 multicolored spheres with **high restitution** colliding under gravity.\n\n## Physics\n- Each ball has a **free joint** (6-DOF) and a unique radius (0.18–0.27 m)\n- Uses MuJoCo's **spring-damper contact model**: \`solref=[timeconst, dampingRatio]\`\n- \`solref=[0.04, 0.2]\` = 40 ms contact spring, 20% damping → lively bounce\n- \`dampingRatio < 1\` = underdamped = bouncy; \`= 1\` = critically damped = no bounce\n\n## Try it\n- Use the **Bounciness slider** in the properties panel to tune each ball\n- Change gravity in Environment settings to see low-gravity chaos`,
};

function makePresetNoteCard(presetKey: string): { id: string; markdown: string; minimized: boolean; x: number; y: number } | null {
  const md = PRESET_NOTE_CARDS[presetKey];
  if (!md) return null;
  return { id: `preset_note_${presetKey}`, markdown: md, minimized: false, x: 16, y: 16 };
}

function generateScadForNode(node: any): string {
  const geom = node.geoms?.[0];
  if (!geom) return '// No geometry found';
  
  if (node.isWedge) {
    const w = node.width || 2.0;
    const h = node.height || 0.5;
    const d = node.depth || 1.0;
    return `// Wedge shape\nwidth = ${w.toFixed(3)}; // [0.1:0.05:3.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ndepth = ${d.toFixed(3)}; // [0.1:0.05:2.0]\nlinear_extrude(height=depth, center=true)\n  polygon([[0,0], [width,0], [0,height]]);`;
  }
  
  if (node.isPyramid) {
    const w = node.width || 0.5;
    const d = node.depth || 0.5;
    const h = node.height || 0.5;
    return `// Pyramid shape\nwidth = ${w.toFixed(3)}; // [0.1:0.05:2.0]\ndepth = ${d.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\nlinear_extrude(height=height, scale=0)\n  square([width, depth], center=true);`;
  }
  
  if (node.isCone) {
    const r = node.radius || 0.3;
    const h = node.height || 0.6;
    return `// Cone shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ncylinder(h=height, r1=radius, r2=0, center=false, $fn=24);`;
  }

  if (node.isTorus) {
    const R = node.majorRadius || 0.4;
    const r = node.tubeRadius || 0.1;
    return `// Torus shape\nmajor_r = ${R.toFixed(3)}; // [0.1:0.05:2.0]\ntube_r = ${r.toFixed(3)}; // [0.02:0.01:1.0]\nrotate_extrude($fn=24) translate([major_r, 0, 0]) circle(r=tube_r, $fn=16);`;
  }

  if (node.isTube) {
    const r1 = node.innerRadius || 0.2;
    const r2 = node.outerRadius || 0.3;
    const h = node.height || 0.5;
    return `// Tube shape\ninner_r = ${r1.toFixed(3)}; // [0.05:0.05:2.0]\nouter_r = ${r2.toFixed(3)}; // [0.1:0.05:2.5]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ndifference() {\n  cylinder(h=height, r=outer_r, center=true, $fn=24);\n  cylinder(h=height + 0.02, r=inner_r, center=true, $fn=24);\n}`;
  }
  
  if (node.id.includes('gear')) {
    const r = geom.size?.[0] || 0.5;
    return `// Gear shape\nradius = ${r}; // [0.1:0.05:2.0]\ndifference() {\n  cylinder(h=0.08, r=radius, center=true, $fn=30);\n  cylinder(h=0.12, r=0.08, center=true, $fn=16);\n}`;
  }

  switch (geom.type) {
    case 'ellipsoid': {
      const rx = geom.size?.[0] || 0.3;
      const ry = geom.size?.[1] || 0.2;
      const rz = geom.size?.[2] || 0.15;
      return `// Ellipsoid shape\nrx = ${rx.toFixed(3)}; // [0.05:0.05:2.0]\nry = ${ry.toFixed(3)}; // [0.05:0.05:2.0]\nrz = ${rz.toFixed(3)}; // [0.05:0.05:2.0]\nscale([rx, ry, rz]) sphere(r=1, $fn=24);`;
    }
    case 'box': {
      const sx = (geom.size?.[0] || 0.2) * 2;
      const sy = (geom.size?.[1] || 0.2) * 2;
      const sz = (geom.size?.[2] || 0.2) * 2;
      return `// Box shape\nsx = ${sx.toFixed(3)}; // [0.1:0.05:3.0]\nsy = ${sy.toFixed(3)}; // [0.1:0.05:3.0]\nsz = ${sz.toFixed(3)}; // [0.1:0.05:3.0]\ncube([sx, sy, sz], center=true);`;
    }
    case 'sphere': {
      const r = geom.size?.[0] || 0.2;
      return `// Sphere shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nsphere(r=radius, $fn=24);`;
    }
    case 'cylinder': {
      const r = geom.size?.[0] || 0.2;
      const h = (geom.size?.[1] || 0.1) * 2;
      return `// Cylinder shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:3.0]\ncylinder(h=height, r=radius, center=true, $fn=24);`;
    }
    case 'capsule': {
      const r = geom.size?.[0] || 0.04;
      const h = geom.size?.[1] || 0.2;
      return `// Capsule shape\nradius = ${r.toFixed(3)}; // [0.01:0.01:1.0]\nheight = ${h.toFixed(3)}; // [0.05:0.05:2.0]\nhull() {\n  translate([0, 0, -height]) sphere(r=radius, $fn=16);\n  translate([0, 0, height]) sphere(r=radius, $fn=16);\n}`;
    }
    case 'mesh': {
      return `// Mesh geometry representation\n// Note: editing this will overwrite the manual vertices\ncube([0.5, 0.5, 0.5], center=true);`;
    }
    default:
      return `// Primitive shape (${geom.type})\ncube([0.4, 0.4, 0.4], center=true);`;
  }
}

interface ScadVariable {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  lineIndex: number;
}

function parseScadVariables(code: string): ScadVariable[] {
  const variables: ScadVariable[] = [];
  if (!code) return variables;
  const lines = code.split('\n');
  let braceDepth = 0;

  const varRegex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*(?:\/\/\s*\[\s*(-?\d+(?:\.\d+)?)(?::(-?\d+(?:\.\d+)?))?:\s*(-?\d+(?:\.\d+)?)\s*\])?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;

    if (braceDepth === 0) {
      const match = line.match(varRegex);
      if (match) {
        const name = match[1];
        const value = parseFloat(match[2]);
        const parsedStep = match[4] ? parseFloat(match[4]) : undefined;

        const min = value === 0 ? -0.2 : value - Math.abs(value) * 0.2;
        const max = value === 0 ? 0.2 : value + Math.abs(value) * 0.2;
        let step = parsedStep;
        if (step === undefined) {
          const range = max - min;
          step = parseFloat((range / 100).toPrecision(2));
        }

        variables.push({
          name,
          value,
          min,
          max,
          step: step || 0.01,
          lineIndex: i
        });
      }
    }

    braceDepth += openBraces - closeBraces;
  }

  return variables;
}

function replaceVarInCode(code: string, varName: string, newValue: number): string {
  const lines = code.split('\n');
  let braceDepth = 0;
  const varRegex = new RegExp(`^(\\s*${varName}\\s*=\\s*)-?\\d+(?:\\.\\d+)?`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    if (braceDepth === 0) {
      const match = line.match(varRegex);
      if (match) {
        lines[i] = line.replace(varRegex, `$1${newValue}`);
        break;
      }
    }
    braceDepth += openBraces - closeBraces;
  }
  return lines.join('\n');
}

function App() {
  if (typeof window !== 'undefined') {
    (window as any).useStore = useStore;
  }
  useMuJoCoInit();
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('physics_dark_mode') === 'true';
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('physics_dark_mode', 'true');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('physics_dark_mode', 'false');
    }
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode(prev => !prev);

  const [isDocsOpen, setIsDocsOpen] = useState(false);
  const [showAICopilot, setShowAICopilot] = useState(false);
  const [docsTab, setDocsTab] = useState<'gravity' | 'coupling' | 'collision' | 'friction' | 'scripting'>('gravity');
  const [scriptText, setScriptText] = useState('');
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [meshEditorGeom, setMeshEditorGeom] = useState<string | null>(null);
  const [meshEditorText, setMeshEditorText] = useState('');
  const [meshEditorError, setMeshEditorError] = useState<string | null>(null);
  const [meshSimplifierGeom, setMeshSimplifierGeom] = useState<string | null>(null);
  const [simplifyRatio, setSimplifyRatio] = useState(0.5);
  const [meshSimplifierError, setMeshSimplifierError] = useState<string | null>(null);
  const [showApiRef, setShowApiRef] = useState(false);
  const [propertiesWidth, setPropertiesWidth] = useState(380);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [activeGeomIndex, setActiveGeomIndex] = useState(0);
  const [noteCards, setNoteCards] = useState<{ id: string; markdown: string; minimized: boolean; x: number; y: number }[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [scadText, setScadText] = useState('');
  const [scadError, setScadError] = useState<string | null>(null);
  const [isScadCompiling, setIsScadCompiling] = useState(false);
  const [isCompilerLoading, setIsCompilerLoading] = useState(false);
  const axisCanvasRef = useRef<HTMLCanvasElement>(null);

  const scadVars = useMemo(() => parseScadVariables(scadText), [scadText]);
  const compileTimeoutRef = useRef<number | null>(null);

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

  const debouncedUpdateCode = useCallback(() => {
    if (updateCodeTimeoutRef.current) {
      window.clearTimeout(updateCodeTimeoutRef.current);
    }
    updateCodeTimeoutRef.current = window.setTimeout(async () => {
      let updated = scadTextRef.current;
      for (const [name, value] of Object.entries(slidingValuesRef.current)) {
        updated = replaceVarInCode(updated, name, value);
      }
      setScadText(updated);

      const selectedNodeId = useStore.getState().selectedNodeId;
      if (!selectedNodeId) return;
      setIsScadCompiling(true);
      setScadError(null);
      try {
        const compiled = await compileSCAD(updated);
        useStore.getState().updateNodeScad(selectedNodeId, updated, compiled);
      } catch (e: any) {
        console.error('OpenSCAD Auto-Compilation Error:', e);
        setScadError(e.message || 'Auto-compilation failed.');
      } finally {
        setIsScadCompiling(false);
        setSlidingValues({});
      }
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (compileTimeoutRef.current) {
        window.clearTimeout(compileTimeoutRef.current);
      }
      if (updateCodeTimeoutRef.current) {
        window.clearTimeout(updateCodeTimeoutRef.current);
      }
    };
  }, []);

  // Expose noteCards state to MCP bridge
  useEffect(() => {
    (window as any)._physics_getNoteCards = () => noteCards;
    (window as any)._physics_setNoteCards = (cards: typeof noteCards) => setNoteCards(cards);
  }, [noteCards]);



  // Pre-load the OpenSCAD compiler in the background after app initialization
  useEffect(() => {
    const timer = setTimeout(() => {
      loadCompiler().catch(err => console.warn('Failed to pre-load OpenSCAD compiler in background:', err));
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = window.innerWidth - moveEvent.clientX;
      if (newWidth >= 280 && newWidth <= 800) {
        setPropertiesWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const { 
    model, data, mujoco, recompileId, activePreset,
    isPlaying, togglePlay, isLoaded, 
    mcpActiveCount, scadCompileCount,
    isSettingsOpen, setSettingsOpen, 
    gravityZ, windX, windY, density, floorFriction, floorBounce, setEnvironment,
    cameraView, setCameraView,
    sceneGraph, selectedNodeId, setSelectedNodeId,
    updateNodeGeom, updateNodeJoint, updateGearTeeth, addComponent, loadPreset, updateScene,
    resetSimulation, updateNodePos,
    updateNodeJointsList, deleteNode, renameNode,
    addPusherPeg, deletePusherPeg, updatePusherPeg, updateNodeRotation,
    updateWedgeParams, updatePyramidParams, updateConeParams, updateTorusParams, updateTubeParams, updatePulleyParams, updateRopeParams,
    parentUnderSelected, setParentUnderSelected, updateNodeScript, updateNode,
    undo, redo, undoStack, redoStack
  } = useStore();

  // Collapsible properties cards drawer listener
  useEffect(() => {
    let active = true;
    
    const setupCollapse = () => {
      const aside = document.querySelector('aside.glass-panel');
      if (!aside || !active) return;

      // Inject indicator spans
      const headers = aside.querySelectorAll('div > h3');
      headers.forEach(h => {
        if (!h.querySelector('.collapse-indicator') && !h.closest('aside.glass-panel > h2')) {
          const indicator = document.createElement('span');
          indicator.className = 'collapse-indicator text-[9px] font-mono text-slate-400 dark:text-slate-500 ml-1.5 float-right font-normal normal-case';
          indicator.style.userSelect = 'none';
          indicator.textContent = ' [−]';
          h.appendChild(indicator);
          const hHtml = h as HTMLElement;
          hHtml.style.cursor = 'pointer';
        }
      });
    };

    const timer = setTimeout(setupCollapse, 100);

    const handleHeaderClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const header = target.closest('h3');
      if (!header) return;
      if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('select')) return;
      
      const card = header.parentElement;
      if (!card) return;
      
      card.classList.toggle('is-collapsed');
      
      const indicator = header.querySelector('.collapse-indicator');
      if (indicator) {
        indicator.textContent = card.classList.contains('is-collapsed') ? ' [+]' : ' [−]';
      }
    };

    const asideContainer = document.querySelector('aside.glass-panel');
    if (asideContainer) {
      asideContainer.addEventListener('click', handleHeaderClick);
    }

    return () => {
      active = false;
      clearTimeout(timer);
      if (asideContainer) {
        asideContainer.removeEventListener('click', handleHeaderClick);
      }
    };
  }, [selectedNodeId]);

  // Show the note card for whichever preset is active on first load
  useEffect(() => {
    if (activePreset && !activePreset.startsWith('user:')) {
      const card = makePresetNoteCard(activePreset);
      setNoteCards(card ? [card] : []);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally only on mount

  const handleSavePresetClick = useCallback(() => {
    setPresetNameInput('');
    setIsSaveModalOpen(true);
  }, []);

  const handleConfirmSavePreset = useCallback(() => {
    const name = presetNameInput.trim();
    if (!name) return;
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const userPresets = JSON.parse(localStorage.getItem('physics_user_presets') || '{}');
      userPresets[name] = { ...syncedScene, noteCards };
      localStorage.setItem('physics_user_presets', JSON.stringify(userPresets));
      loadPreset(`user:${name}`);
    } catch (e) {
      console.error('Failed to save user preset', e);
    }
    setIsSaveModalOpen(false);
    setPresetNameInput('');
  }, [presetNameInput, sceneGraph, model, data, mujoco, loadPreset, noteCards]);

  const exportJson = useCallback(() => {
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const dataStr = JSON.stringify({ ...syncedScene, noteCards }, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'physics_physbox_scene.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export JSON', e);
      alert('Failed to export JSON');
    }
  }, [sceneGraph, model, data, mujoco, noteCards]);

  const threeSceneRef = useRef<THREE.Scene | null>(null);

  const exportStl = useCallback(() => {
    const scene = threeSceneRef.current;
    if (!scene) { alert('Scene not ready'); return; }

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
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!mats.some(m => (m as any).isMeshStandardMaterial)) return;
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      exportGroup.add(new THREE.Mesh(geo));

      const partKey = findNodeId(mesh) ?? `__ungrouped_${ungroupedIdx++}`;
      const meshBbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
      const existing = partBboxes.get(partKey);
      if (existing) existing.union(meshBbox);
      else partBboxes.set(partKey, meshBbox);
    });

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
      const targetStr = window.prompt("Longest part's longest side (mm):", '150');
      if (targetStr === null) return;
      const targetMm = parseFloat(targetStr);
      if (isNaN(targetMm) || targetMm <= 0) { alert('Invalid size'); return; }
      const scale = targetMm / longestPartDim;
      const center = bbox.getCenter(new THREE.Vector3());
      const transform = new THREE.Matrix4()
        .makeRotationX(Math.PI / 2)
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
      for (const child of exportGroup.children) {
        (child as THREE.Mesh).geometry.applyMatrix4(transform);
      }
    }

    const exporter = new STLExporter();
    const result = exporter.parse(exportGroup, { binary: true }) as DataView;
    const blob = new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'physics_scene.stl';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importJson = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          if (parsed && Array.isArray(parsed.nodes)) {
            if (isPlaying) togglePlay();
            updateScene(parsed);
            if (Array.isArray(parsed.noteCards)) setNoteCards(parsed.noteCards);
          } else {
            alert('Invalid scene JSON format. Must contain a "nodes" array.');
          }
        } catch (err) {
          alert('Failed to parse JSON file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [isPlaying, togglePlay, updateScene]);

  // Load a preset and replace the note card with the preset's built-in card (if any)
  const loadPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    const builtinKey = name.startsWith('user:') ? null : name;
    const presetCard = builtinKey ? makePresetNoteCard(builtinKey) : null;
    setNoteCards(presetCard ? [presetCard] : []);
    setEditingCardId(null);
  }, [loadPreset]);

  // Also load note cards from user presets (stored alongside the scene)
  const loadUserPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    try {
      const userPresets = JSON.parse(localStorage.getItem('physics_user_presets') || '{}');
      const key = name.replace('user:', '');
      const saved = userPresets[key];
      if (saved && Array.isArray(saved.noteCards)) {
        setNoteCards(saved.noteCards);
      } else {
        setNoteCards([]);
      }
    } catch { setNoteCards([]); }
    setEditingCardId(null);
  }, [loadPreset]);

  // Helper to find a node by ID in hierarchy
  const findNodeById = useCallback((nodes: any[], targetId: string): any | null => {
    for (const node of nodes) {
      if (node.id === targetId) return node;
      if (node.children) {
        const res = findNodeById(node.children, targetId);
        if (res) return res;
      }
    }
    return null;
  }, []);

  // Helper to get recursive world position of a node
  const getNodeWorldPos = useCallback((nodes: any[], targetId: string, currentOffset: [number, number, number] = [0, 0, 0]): [number, number, number] | null => {
    for (const node of nodes) {
      const nodeWorld: [number, number, number] = [
        currentOffset[0] + node.pos[0],
        currentOffset[1] + node.pos[1],
        currentOffset[2] + node.pos[2]
      ];
      if (node.id === targetId) return nodeWorld;
      if (node.children) {
        const childResult = getNodeWorldPos(node.children, targetId, nodeWorld);
        if (childResult) return childResult;
      }
    }
    return null;
  }, []);

  const allPulleyWheels = useMemo(() => {
    const list: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyWheel) list.push(n);
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  const allJointedNodes = useMemo(() => {
    const list: any[] = [];
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.joints && n.joints.length > 0 && !n.isPulleyWheel) {
          list.push(n);
        }
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  const handlePointerMissed = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  console.log("App rendering, selectedNodeId:", selectedNodeId);

  const handleDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('type', type);
  };

  // Find selected node details
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    let found = null;
    const traverse = (nodes: any[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.id === selectedNodeId) found = node;
        traverse(node.children);
      }
    };
    traverse(sceneGraph.nodes);
    console.log("evaluated selectedNode:", found);
    return found as any;
  }, [selectedNodeId, sceneGraph]);

  // Sync selected node's script and scad code into local text state
  useEffect(() => {
    if (selectedNode) {
      setScriptText(selectedNode.script || '');
      setScriptError(null);
      
      let currentScad = selectedNode.scad;
      if (currentScad === undefined && (selectedNode.id.includes('openscad') || selectedNode.id.includes('scad'))) {
        currentScad = generateScadForNode(selectedNode);
        // Persist the generated scad field to the node in store
        useStore.getState().updateNode(selectedNode.id, { scad: currentScad });
      }
      
      setScadText(currentScad || '');
      setScadError(null);
    } else {
      setScriptText('');
      setScriptError(null);
      setScadText('');
      setScadError(null);
    }
    setActiveGeomIndex(0);
  }, [selectedNodeId, selectedNode?.id, selectedNode?.scad, selectedNode?.script]);

  const handleSaveScript = useCallback(() => {
    if (!selectedNode) return;
    try {
      if (scriptText.trim() !== '') {
        // Syntax compilation check
        new Function('api', scriptText);
      }
      setScriptError(null);
      updateNodeScript(selectedNode.id, scriptText);
    } catch (e: any) {
      setScriptError(e.message || 'Compilation Error');
    }
  }, [selectedNode, scriptText, updateNodeScript]);

  const handleCompileScad = useCallback(async () => {
    if (!selectedNode) return;
    setIsScadCompiling(true);
    setScadError(null);
    try {
      const compiled = await compileSCAD(scadText);
      useStore.getState().updateNodeScad(selectedNode.id, scadText, compiled);
    } catch (e: any) {
      console.error('OpenSCAD Compilation Error:', e);
      setScadError(e.message || 'Compilation failed.');
    } finally {
      setIsScadCompiling(false);
    }
  }, [selectedNode, scadText]);

  const handleSimplifyMesh = useCallback((g: any) => {
    try {
      setMeshSimplifierError(null);
      if (!g.vertices || g.vertices.length < 9) {
        throw new Error('Not enough vertices to simplify (need at least 3 triangles / 9 coordinates).');
      }

      // 1. Weld/deduplicate vertices first so that the edge collapse algorithm works properly on a connected mesh
      const uniqueInputVerts: number[] = [];
      const inputFaces: number[] = [];
      const inputVertMap = new Map<string, number>();

      for (let i = 0; i < g.vertices.length; i += 3) {
        const x = g.vertices[i];
        const y = g.vertices[i + 1];
        const z = g.vertices[i + 2];
        const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
        let idx = inputVertMap.get(key);
        if (idx === undefined) {
          idx = uniqueInputVerts.length / 3;
          uniqueInputVerts.push(x, y, z);
          inputVertMap.set(key, idx);
        }
      }

      if (g.faces && g.faces.length > 0) {
        for (let i = 0; i < g.faces.length; i++) {
          const oldIdx = g.faces[i];
          const vx = g.vertices[oldIdx * 3];
          const vy = g.vertices[oldIdx * 3 + 1];
          const vz = g.vertices[oldIdx * 3 + 2];
          const key = `${vx.toFixed(5)},${vy.toFixed(5)},${vz.toFixed(5)}`;
          inputFaces.push(inputVertMap.get(key)!);
        }
      } else {
        // If not indexed, build faces sequentially
        for (let i = 0; i < g.vertices.length; i += 3) {
          const x = g.vertices[i];
          const y = g.vertices[i + 1];
          const z = g.vertices[i + 2];
          const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
          inputFaces.push(inputVertMap.get(key)!);
        }
      }

      // 2. Create a THREE.BufferGeometry from the welded geometry
      const geometry = new THREE.BufferGeometry();
      const positionArray = new Float32Array(uniqueInputVerts);
      geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
      geometry.setIndex(inputFaces);

      // 3. Compute the number of vertices to remove
      const originalVertexCount = uniqueInputVerts.length / 3;
      const targetCount = Math.max(4, Math.floor(originalVertexCount * simplifyRatio));
      const countToRemove = originalVertexCount - targetCount;

      if (countToRemove <= 0) {
        throw new Error('Already at or below target vertex count. Try a lower quality/ratio.');
      }

      // 4. Apply the SimplifyModifier
      const modifier = new SimplifyModifier();
      const simplifiedGeometry = modifier.modify(geometry, countToRemove);
      
      const simplifiedPositions = simplifiedGeometry.attributes.position.array;
      const simplifiedIndex = simplifiedGeometry.index ? simplifiedGeometry.index.array : null;
      if (!simplifiedPositions || simplifiedPositions.length === 0) {
        throw new Error('Simplification produced an empty geometry.');
      }

      // 5. Extract the resulting vertices and faces using the index array from SimplifyModifier
      const uniqueVerts: number[] = [];
      const faces: number[] = [];
      const vertMap = new Map<number, number>();

      if (simplifiedIndex) {
        for (let i = 0; i < simplifiedIndex.length; i++) {
          const oldIdx = simplifiedIndex[i];
          let newIdx = vertMap.get(oldIdx);
          if (newIdx === undefined) {
            newIdx = uniqueVerts.length / 3;
            const vx = simplifiedPositions[oldIdx * 3];
            const vy = simplifiedPositions[oldIdx * 3 + 1];
            const vz = simplifiedPositions[oldIdx * 3 + 2];
            uniqueVerts.push(
              Number(vx.toFixed(5)),
              Number(vy.toFixed(5)),
              Number(vz.toFixed(5))
            );
            vertMap.set(oldIdx, newIdx);
          }
          faces.push(newIdx);
        }
      } else {
        // Fallback for non-indexed output
        const vertMapStr = new Map<string, number>();
        for (let i = 0; i < simplifiedPositions.length; i += 3) {
          const x = simplifiedPositions[i];
          const y = simplifiedPositions[i + 1];
          const z = simplifiedPositions[i + 2];
          const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
          let idx = vertMapStr.get(key);
          if (idx === undefined) {
            idx = uniqueVerts.length / 3;
            uniqueVerts.push(
              Number(x.toFixed(5)),
              Number(y.toFixed(5)),
              Number(z.toFixed(5))
            );
            vertMapStr.set(key, idx);
          }
          faces.push(idx);
        }
      }

      if (uniqueVerts.length < 9) {
        throw new Error('Simplification reduced geometry below minimum visible threshold.');
      }

      // 6. Swap Y/Z coordinates for renderVertices if this is a dynamic mesh (MuJoCo space swap)
      let newRenderVerts: number[] | undefined;
      if (g.dynamic) {
        newRenderVerts = [];
        for (let i = 0; i < uniqueVerts.length; i += 3) {
          const x = uniqueVerts[i], y = uniqueVerts[i+1], z = uniqueVerts[i+2];
          newRenderVerts.push(+x.toFixed(5), +(-z).toFixed(5), +y.toFixed(5));
        }
      }

      // 7. Update the sceneGraph with the new simplified vertices/faces
      const newScene = JSON.parse(JSON.stringify(useStore.getState().sceneGraph));
      const traverse = (nodes: any[]): boolean => {
        for (const node of nodes) {
          const idx = node.geoms?.findIndex((ng: any) => ng.name === g.name);
          if (idx >= 0) {
            node.geoms[idx] = {
              ...node.geoms[idx],
              vertices: uniqueVerts,
              faces,
              ...(newRenderVerts ? { renderVertices: newRenderVerts } : {})
            };
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      useStore.getState().updateScene(newScene);
      
      setMeshSimplifierGeom(null);
    } catch (err: any) {
      console.error('Mesh simplification failed:', err);
      setMeshSimplifierError(err.message || 'Mesh simplification failed.');
    }
  }, [simplifyRatio]);

  // Utility to handle moving free bodies
  const handleMove = (axis: 0 | 1 | 2, val: number) => {
    if (!selectedNode) return;
    const cleanVal = isNaN(val) ? 0 : val;

    // Always update the scene-graph initial position (persists on reset/restart)
    const currentPos = [...selectedNode.pos] as [number, number, number];
    currentPos[axis] = cleanVal;
    updateNodePos(selectedNode.id, currentPos);

    // Also directly move the body in the live sim (via the physics worker) so
    // only THIS body moves, regardless of whether playing or paused. This
    // avoids the full forceReset recompile (from updateNodePos alone) which
    // was snapping all other bodies back to their initial positions.
    const freeJoint = selectedNode.joints?.find((j: any) => j.type === 'free');
    if (freeJoint) {
      getPhysicsWorkerClient().setQpos(freeJoint.name, axis, cleanVal);
    }
  };

  const handleAddComponentClick = (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid') => {
    if (selectedNodeId) {
      const parentNode = findNodeById(sceneGraph.nodes, selectedNodeId);
      if (parentNode) {
        const worldPos = getNodeWorldPos(sceneGraph.nodes, selectedNodeId) || [0, 0, 0];
        const offset = (type === 'capsule' || type === 'bob') ? [0, 0, -0.6] : [0.5, 0, 0];
        addComponent(type, [worldPos[0] + offset[0], worldPos[1] + offset[1], worldPos[2] + offset[2]]);
        setIsLeftSidebarOpen(false);
        return;
      }
    }
    addComponent(type, [0, 0, 1.2]); // Spawn slightly above floor
    setIsLeftSidebarOpen(false);
  };

  const renderHierarchyNode = useCallback((node: any, depth: number = 0): React.ReactNode => {
    const isSelected = selectedNodeId === node.id;
    
    // Choose pretty visual emoji
    let emoji = '📦';
    if (node.id.includes('coin')) emoji = '🪙';
    else if (node.id.includes('gear')) emoji = '⚙️';
    else if (node.id.includes('pole') || node.id.includes('capsule')) emoji = '🥢';
    else if (node.id.includes('bob')) emoji = '🔵';
    else if (node.id.includes('cylinder')) emoji = '🛢️';
    else if (node.id.includes('sphere')) emoji = '🟢';
    else if (node.id.includes('wedge')) emoji = '📐';
    else if (node.id.includes('pyramid')) emoji = '🔺';
    else if (node.id.includes('cone')) emoji = '🍦';
    else if (node.id.includes('torus')) emoji = '🍩';
    else if (node.id.includes('tube')) emoji = '🛢️';
    else if (node.id.includes('ellipsoid')) emoji = '🥚';
    else if (node.id.includes('pulley_wheel')) emoji = '🛞';
    else if (node.isPulleyRope) emoji = '🧵';

    return (
      <div key={node.id} className="flex flex-col">
        <div 
          onClick={() => {
            setSelectedNodeId(node.id);
            setActiveGeomIndex(0);
            setIsLeftSidebarOpen(false);
          }} 
          style={{ paddingLeft: `${depth === 0 ? 8 : 4}px` }}
          className={`flex items-center px-2 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm mb-1 ${
            isSelected && activeGeomIndex === 0 
              ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-semibold' 
              : isSelected 
                ? 'bg-blue-50/40 border-blue-100/50 text-blue-500 dark:bg-blue-950/20 dark:border-blue-900/50 dark:text-blue-400 font-semibold' 
                : 'bg-white dark:bg-slate-900/90 border-transparent dark:border-slate-800/40 hover:bg-slate-100/70 dark:hover:bg-slate-800/70 text-slate-650 dark:text-slate-300'
          }`}
        >
          <span className="text-xs flex items-center gap-1.5 font-medium truncate">
            <span>{emoji}</span> <span className="truncate">{node.name}</span>
          </span>
        </div>
        
        {/* Render sub-geoms nested under body if there are multiple geoms */}
        {node.geoms && node.geoms.length > 1 && (
          <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5 mb-1">
            {node.geoms.map((g: any, idx: number) => {
              const isGeomSelected = isSelected && activeGeomIndex === idx;
              let subEmoji = '🔹';
              if (g.type === 'cylinder') subEmoji = '🛢️';
              else if (g.type === 'box') subEmoji = '📦';
              else if (g.type === 'sphere') subEmoji = '🟢';
              else if (g.type === 'ellipsoid') subEmoji = '🥚';
              else if (g.type === 'mesh') {
                if (node.isPyramid) subEmoji = '🔺';
                else if (node.isCone) subEmoji = '🍦';
                else if (node.isTorus) subEmoji = '🍩';
                else if (node.isTube) subEmoji = '🛢️';
                else subEmoji = '📐';
              }
              
              return (
                <div 
                  key={`${node.id}-geom-${idx}`}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    setActiveGeomIndex(idx);
                    setIsLeftSidebarOpen(false);
                  }}
                  className={`flex items-center px-2 py-1 rounded-md border cursor-pointer transition-colors shadow-sm text-xs ${
                    isGeomSelected 
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-650 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400 font-semibold' 
                      : 'bg-white/80 dark:bg-slate-900/50 border-transparent dark:border-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium truncate">
                    <span>{subEmoji}</span> <span className="truncate">{g.name || `Geom ${idx + 1}`}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {node.children && node.children.length > 0 && (
          <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5">
            {node.children.map((child: any) => renderHierarchyNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [selectedNodeId, setSelectedNodeId, findNodeById, setIsLeftSidebarOpen, activeGeomIndex, setActiveGeomIndex]);

  useMCPBridge();

  return (
    <div className={`flex flex-col h-screen w-screen transition-colors duration-200 ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 md:px-6 py-2 flex items-center justify-between shadow-xs z-10 transition-colors">
        {/* Left: Logo, Title & Preset Selector */}
        <div className="flex items-center gap-2 md:gap-4">
          {/* Mobile Sidebar Toggle */}
          <button
            onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
            className="p-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 transition-colors md:hidden focus:outline-none cursor-pointer flex-shrink-0"
            title="Toggle Sidebar"
          >
            {isLeftSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          {/* Logo & Title */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 p-1.5">
              <svg viewBox="0 0 512 512" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="logo-cyan-blue" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00f2fe" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                  <linearGradient id="logo-blue-purple" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#7c3aed" />
                  </linearGradient>
                  <linearGradient id="logo-face-top" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00f2fe" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.15" />
                  </linearGradient>
                  <linearGradient id="logo-face-left" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.25" />
                  </linearGradient>
                  <linearGradient id="logo-face-right" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.20" />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.20" />
                  </linearGradient>
                </defs>
                <polygon points="256,60 426,158 256,256 86,158" fill="url(#logo-face-top)" />
                <polygon points="86,158 256,256 256,452 86,354" fill="url(#logo-face-left)" />
                <polygon points="256,256 426,158 426,354 256,452" fill="url(#logo-face-right)" />
                
                <g stroke="url(#logo-cyan-blue)" strokeWidth="10" strokeOpacity="0.75" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="256" y1="60" x2="256" y2="256" />
                  <line x1="86" y1="158" x2="426" y2="158" />
                  <line x1="86" y1="158" x2="256" y2="452" />
                  <line x1="256" y1="256" x2="86" y2="354" />
                  <line x1="256" y1="256" x2="426" y2="354" />
                  <line x1="426" y1="158" x2="256" y2="452" />
                </g>
                
                <polygon points="256,60 426,158 426,354 256,452 86,354 86,158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="256" y1="256" x2="256" y2="452" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="256" y1="256" x2="86" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="256" y1="256" x2="426" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                
                <g fill="#ffffff">
                  <circle cx="256" cy="60" r="18" stroke="#7c3aed" strokeWidth="8" />
                  <circle cx="86" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="426" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="256" cy="256" r="20" stroke="#3b82f6" strokeWidth="9" />
                  <circle cx="86" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="426" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="256" cy="452" r="18" stroke="#7c3aed" strokeWidth="8" />
                </g>
              </svg>
            </div>
            <h1 className="font-bold text-sm tracking-tight hidden sm:block text-slate-800 dark:text-slate-100">
              PhysBox<span className="text-blue-500">: Mesh</span>
            </h1>
          </div>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />

          {/* Preset Select Segmented Group */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
            <select 
              value={activePreset || ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('user:')) loadUserPresetWithCard(v);
                else loadPresetWithCard(v);
              }}
              className="bg-transparent text-slate-700 dark:text-slate-100 text-xs rounded-md block px-2 py-1 outline-none font-medium cursor-pointer border-none"
            >
              <optgroup label="⬜ Built-in Presets" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
                <option value="empty">🫙 Blank (Empty)</option>
                <option value="pendulum">Double Pendulum</option>
                <option value="cubes">Stacked Cubes</option>
                <option value="gears">Gear System</option>
                <option value="machine">Gear Train Machine</option>
                <option value="rack_pinion">Rack &amp; Pinion</option>
                <option value="inclined_plane">Inclined Plane</option>
                <option value="pulley_system">Pulley Stand</option>
                <option value="cartpole">Cartpole</option>
                <option value="newtons_cradle">Newton's Cradle</option>
                <option value="suspension_bridge">Suspension Bridge</option>
                <option value="paper_plane">✈ Paper Plane</option>
                <option value="monkey_head">🐵 Monkey Head</option>
                <option value="golden_gate">🌉 Golden Gate Bridge</option>
                <option value="golden_gate_mesh">🌉 Golden Gate (Mesh)</option>
                <option value="mesh_collision">🔺 Mesh Collision Demo</option>
                <option value="coin_flip">🪙 Coin Flip</option>
                <option value="windmill">💨 Wind Turbine</option>
                <option value="physics_only_windmill">💨 Wind Turbine (No Aero)</option>
                <option value="traditional_windmill">💨 Traditional Windmill (4-Blade)</option>
                <option value="drone">🛸 Quadcopter Drone</option>
                <option value="bouncy_balls">🎱 Bouncy Balls</option>
                <option value="openscad_demo">🛠️ OpenSCAD Showcase</option>
                <option value="rope_bridge">🎗️ Interactive Rope Bridge</option>
              </optgroup>

              {/* User Presets */}
              {(() => {
                try {
                  const userPresets = JSON.parse(localStorage.getItem('physics_user_presets') || '{}');
                  const keys = Object.keys(userPresets);
                  if (keys.length === 0) return null;
                  return (
                    <optgroup label="📁 Saved Presets" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
                      {keys.sort().map(k => (
                        <option key={`user:${k}`} value={`user:${k}`}>💾 {k}</option>
                      ))}
                    </optgroup>
                  );
                } catch {
                  return null;
                }
              })()}
            </select>

            {activePreset && activePreset.startsWith('user:') && (
              <button
                onClick={() => {
                  const presetName = activePreset.replace('user:', '');
                  if (window.confirm(`Are you sure you want to delete the preset "${presetName}"?`)) {
                    try {
                      const userPresets = JSON.parse(localStorage.getItem('physics_user_presets') || '{}');
                      delete userPresets[presetName];
                      localStorage.setItem('physics_user_presets', JSON.stringify(userPresets));
                      loadPresetWithCard('empty');
                    } catch (e) {
                      console.error('Failed to delete preset', e);
                    }
                  }
                }}
                className="flex items-center justify-center p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors focus:outline-none cursor-pointer"
                title={`Delete preset "${activePreset.replace('user:', '')}"`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Center/Right: Simulation Toolbar & Files */}
        <div className="flex items-center gap-2 md:gap-3">
          {/* Simulation Controller Block */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
            {/* Simulate / Stop */}
            <button 
              onClick={togglePlay}
              disabled={!isLoaded}
              className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs transition-all disabled:opacity-50 flex-shrink-0 cursor-pointer ${
                isPlaying
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-xs'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100'
              }`}
              title={isPlaying ? "Stop Simulation" : "Start Simulation"}
            >
              {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />}
              <span className="hidden md:inline">{isPlaying ? 'Stop' : 'Run'}</span>
            </button>

            {/* Reset */}
            <button 
              onClick={resetSimulation}
              disabled={!isLoaded}
              className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-50 flex-shrink-0 cursor-pointer"
              title="Reset Simulation"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden md:inline">Reset</span>
            </button>
          </div>

          {/* Files Segmented Group */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
            <button 
              onClick={handleSavePresetClick}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Save scene preset"
            >
              <Save className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={exportJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Export JSON"
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={exportStl}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Export STL (3D print)"
            >
              <Printer className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={importJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Import JSON"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Undo"
            >
              <Undo className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Redo"
            >
              <Redo className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800 mx-0.5 hidden sm:block" />

          {/* Right Utilities (Dark Mode, Docs, Settings, Copilot, GitHub) */}
          <div className="flex items-center gap-1.5">
            {/* Dark Mode Toggle - immediately left of Docs button */}
            <button
              onClick={toggleDarkMode}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
            </button>

            {/* Docs (Info) */}
            <button
              onClick={() => setIsDocsOpen(true)}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="Documentation"
            >
              <Info className="w-4 h-4" />
            </button>

            {/* Settings */}
            <button 
              onClick={() => setSettingsOpen(!isSettingsOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                isSettingsOpen 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              title="Global Settings"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* AI Copilot */}
            <button
              onClick={() => setShowAICopilot(!showAICopilot)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                showAICopilot 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
              }`}
              title="AI Copilot Expert"
            >
              <Sparkles className="w-4 h-4" />
            </button>

            {/* GitHub */}
            <a
              href="https://github.com/physbox-io/physicssim"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="View on GitHub"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            </a>
          </div>
        </div>
      </header>


      <div className="flex flex-1 overflow-hidden relative">
        {/* Global Settings */}
        {isSettingsOpen && (
          <div className="absolute top-4 right-6 w-64 glass-panel rounded-lg p-4 z-30 shadow-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100">
            <h3 className="font-semibold text-sm mb-4 flex items-center justify-between text-slate-800 dark:text-slate-100">
              <span className="flex items-center gap-2"><Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Environment</span>
              <button onClick={() => setSettingsOpen(false)}><X className="w-4 h-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer" /></button>
            </h3>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Gravity Z <span>{gravityZ.toFixed(1)} m/s²</span></label>
                <input type="range" min="-20" max="20" step="0.1" value={gravityZ} onChange={(e) => setEnvironment({gravityZ: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind X <span>{windX.toFixed(1)} m/s</span></label>
                <input type="range" min="-10" max="10" step="0.1" value={windX} onChange={(e) => setEnvironment({windX: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind Y <span>{windY.toFixed(1)} m/s</span></label>
                <input type="range" min="-10" max="10" step="0.1" value={windY} onChange={(e) => setEnvironment({windY: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Air Density (Drag) <span>{density.toFixed(2)} kg/m³</span></label>
                <input type="range" min="0" max="5" step="0.01" value={density} onChange={(e) => setEnvironment({density: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Friction <span>{floorFriction.toFixed(2)}</span></label>
                <input type="range" min="0" max="2" step="0.01" value={floorFriction} onChange={(e) => setEnvironment({floorFriction: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Bounciness <span>{(floorBounce ?? 0).toFixed(2)}</span></label>
                <input type="range" min="0" max="1" step="0.01" value={floorBounce ?? 0} onChange={(e) => setEnvironment({floorBounce: parseFloat(e.target.value)})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-1">
                <label htmlFor="geminiApiKey" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                  🔑 Gemini API Key
                </label>
                <input 
                  type="password" 
                  id="geminiApiKey"
                  value={localStorage.getItem('gemini_api_key') || ''} 
                  onChange={(e) => {
                    localStorage.setItem('gemini_api_key', e.target.value);
                    window.dispatchEvent(new Event('storage'));
                  }} 
                  placeholder="Paste AIzaSy... here" 
                  className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" 
                />
              </div>
            </div>
          </div>
        )}

        {/* Mobile Sidebar Backdrop Scrim */}
        {isLeftSidebarOpen && (
          <div 
            onClick={() => setIsLeftSidebarOpen(false)}
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs z-10 md:hidden"
          />
        )}

        {/* Left Sidebar */}
        <aside className={`w-64 md:w-56 shrink-0 glass-panel border-r border-slate-200 dark:border-slate-800 flex flex-col p-4 bg-white/90 dark:bg-slate-900/90 overflow-y-auto transition-transform duration-200 ease-in-out fixed md:relative inset-y-14 md:inset-auto left-0 z-20 shadow-2xl md:shadow-none ${
          isLeftSidebarOpen ? 'flex translate-x-0' : 'hidden md:flex -translate-x-full md:translate-x-0'
        }`}>
          <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2.5">Hierarchy</h2>
          <div className="flex flex-col gap-1.5 mb-6">
            <div 
              className={`px-3 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm flex items-center gap-1.5 ${
                !selectedNodeId 
                  ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-bold' 
                  : 'bg-white dark:bg-slate-900 border-transparent dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
              onClick={() => {
                setSelectedNodeId(null);
                setIsLeftSidebarOpen(false);
              }}
            >
              <span>🌍</span> <span className="text-xs font-semibold">Worldbody</span>
            </div>
            <div className="flex flex-col mt-1">
              {sceneGraph.nodes.map(node => renderHierarchyNode(node, 0))}
            </div>
          </div>

          <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Components</h2>
          
          <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mb-2.5 bg-slate-50 dark:bg-slate-950/40 px-2 py-1.5 rounded-lg border border-slate-200/50 dark:border-slate-800/50">
            Adding to: <span className="text-blue-600 dark:text-blue-400 font-semibold truncate block">{selectedNode && parentUnderSelected ? selectedNode.name : '🌍 Worldbody'}</span>
          </div>

          {selectedNode && (
            <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-400 flex items-center gap-2 mb-3 bg-slate-50 dark:bg-slate-950/40 border border-slate-200/60 dark:border-slate-800/60 p-2 rounded-lg cursor-pointer select-none hover:bg-slate-100/50 dark:hover:bg-slate-800/50 transition-colors shadow-sm">
              <input 
                type="checkbox" 
                checked={parentUnderSelected} 
                onChange={(e) => setParentUnderSelected(e.target.checked)} 
                className="w-3.5 h-3.5 rounded text-blue-600 border-slate-300 dark:border-slate-700 focus:ring-blue-400 dark:focus:ring-blue-900 accent-blue-500 cursor-pointer"
              />
              <span>Nest under selected</span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-2">
            {/* Cube (Box) */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'box')} 
              onClick={() => handleAddComponentClick('box')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cube (Box geom)"
            >
              <div className="p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Box className="w-4 h-4 text-rose-500 dark:text-rose-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cube</span>
            </div>

            {/* Sphere */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'sphere')} 
              onClick={() => handleAddComponentClick('sphere')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Sphere (Ball geom)"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Circle className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Sphere</span>
            </div>

            {/* Cylinder */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'cylinder')} 
              onClick={() => handleAddComponentClick('cylinder')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cylinder block"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Layers className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cylinder</span>
            </div>

            {/* Pole (Capsule) */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'capsule')} 
              onClick={() => handleAddComponentClick('capsule')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Capsule rod (Pole)"
            >
              <div className="p-1.5 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Zap className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pole</span>
            </div>

            {/* Gear */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'gear')} 
              onClick={() => handleAddComponentClick('gear')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Gear cog"
            >
              <div className="p-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg mb-1 group-hover:rotate-45 transition-transform duration-300">
                <Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Gear</span>
            </div>

            {/* Wedge */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'wedge')} 
              onClick={() => handleAddComponentClick('wedge')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Wedge (Inclined plane)"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/20 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Triangle className="w-4 h-4 text-amber-600 dark:text-amber-500 rotate-90" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Wedge</span>
            </div>

            {/* Pyramid */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pyramid')} 
              onClick={() => handleAddComponentClick('pyramid')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Pyramid (Convex mesh)"
            >
              <div className="p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Pyramid className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pyramid</span>
            </div>

            {/* Cone */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'cone')} 
              onClick={() => handleAddComponentClick('cone')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cone (Convex mesh)"
            >
              <div className="p-1.5 bg-sky-50 dark:bg-sky-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Cone className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cone</span>
            </div>

            {/* Torus */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'torus')} 
              onClick={() => handleAddComponentClick('torus')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Torus (Ring mesh)"
            >
              <div className="p-1.5 bg-violet-50 dark:bg-violet-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Donut className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Torus</span>
            </div>

            {/* Tube */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'tube')} 
              onClick={() => handleAddComponentClick('tube')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Tube (Hollow cylinder)"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <CircleDot className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Tube</span>
            </div>

            {/* Ellipsoid */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'ellipsoid')} 
              onClick={() => handleAddComponentClick('ellipsoid')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Ellipsoid primitive"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Circle className="w-4 h-4 text-amber-600 dark:text-amber-400 scale-x-125 scale-y-75" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Ellipsoid</span>
            </div>

            {/* Pulley Wheel */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pulley_wheel')} 
              onClick={() => handleAddComponentClick('pulley_wheel')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Pulley Stand system disk"
            >
              <div className="p-1.5 bg-cyan-50 dark:bg-cyan-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Disc className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pulley</span>
            </div>

            {/* Rope */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pulley_rope')} 
              onClick={() => handleAddComponentClick('pulley_rope')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Coupler Rope"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <CircleDot className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Rope</span>
            </div>

            {/* Mesh */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'mesh')} 
              onClick={() => handleAddComponentClick('mesh')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Custom static Mesh"
            >
              <div className="p-1.5 bg-violet-50 dark:bg-violet-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Shapes className="w-4 h-4 text-violet-500 dark:text-violet-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Mesh</span>
            </div>

            {/* OpenSCAD */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'openscad')} 
              onClick={() => handleAddComponentClick('openscad')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Procedural OpenSCAD shape"
            >
              <div className="p-1.5 bg-blue-50 dark:bg-blue-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Code className="w-4 h-4 text-blue-500 dark:text-blue-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">SCAD</span>
            </div>

            {/* Note Card - spans 2 cols */}
            <div
              onClick={() => {
                const id = `card_${Date.now()}`;
                setNoteCards(prev => [...prev, { id, markdown: '# Note\n\nWrite your notes here.', minimized: false, x: 80, y: 80 }]);
                setEditingCardId(id);
                setIsLeftSidebarOpen(false);
              }}
              className="col-span-2 p-2 border border-dashed border-violet-305 dark:border-violet-850 rounded-lg bg-violet-50/20 dark:bg-violet-955/10 flex items-center justify-center gap-2 cursor-pointer hover:border-violet-400 dark:hover:border-violet-700 hover:bg-violet-50/40 dark:hover:bg-violet-950/30 transition-all group select-none mt-1"
            >
              <FileText className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 group-hover:scale-105 transition-transform" />
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Add Note Card</span>
            </div>
          </div>
        </aside>

        {/* Viewport */}
        <main className="flex-1 relative min-w-0">
          {!isLoaded && (
            <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none bg-slate-50/50 backdrop-blur-sm">
              <div className="text-slate-500 flex flex-col items-center gap-4 font-medium">
                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                Initializing MuJoCo...
              </div>
            </div>
          )}

          {/* Floating Status Indicators */}
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 flex flex-col gap-2 pointer-events-none items-center">
            {scadCompileCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-405 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </div>
                <Code className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                <span className="tracking-wide">SCAD Compiling</span>
              </div>
            )}
            {mcpActiveCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-405 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </div>
                <Zap className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="tracking-wide">MCP Active</span>
              </div>
            )}
          </div>

          {/* Axis Legend — HTML overlay, drawn to from inside the R3F Canvas via shared ref */}
          <div
            style={{
              position: 'absolute',
              top: '0.75rem',
              right: '0.75rem',
              zIndex: 15,
              pointerEvents: 'none',
              borderRadius: '10px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
              padding: '3px',
            }}
            className="bg-slate-50/85 dark:bg-slate-900/85 backdrop-blur-md border border-slate-200/70 dark:border-slate-800/70"
          >
            <canvas ref={axisCanvasRef} width={76} height={76} style={{ display: 'block', borderRadius: '7px' }} />
          </div>
          
          <Canvas
            camera={CAMERA_CONFIG}
            shadows
            onPointerMissed={handlePointerMissed}
            gl={{ preserveDrawingBuffer: true }}
            onCreated={(state) => {
              (window as any)._physics_gl = state.gl;
              const canvas = state.gl.domElement;
              // Without this, a lost WebGL context (GPU driver hiccup, memory
              // pressure, etc.) leaves the canvas permanently blank with no way
              // to recover in-app — preventDefault() tells the browser to try
              // restoring the context instead of abandoning it.
              canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                console.error('[Physics] WebGL context lost — attempting recovery');
              });
              canvas.addEventListener('webglcontextrestored', () => {
                console.warn('[Physics] WebGL context restored — forcing scene recompile to redraw');
                useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
              });
            }}
          >
            <SceneCapture sceneRef={threeSceneRef} />
            <DropHandler addComponent={addComponent} />
            <color attach="background" args={[darkMode ? '#0b0f19' : '#f8fafc']} />
            <ambientLight intensity={darkMode ? 0.35 : 0.6} />
            <directionalLight position={[5, 10, 5]} intensity={darkMode ? 1.4 : 1.2} castShadow />
            <Grid 
              infiniteGrid 
              fadeDistance={20} 
              cellColor={darkMode ? '#1e293b' : '#e2e8f0'} 
              sectionColor={darkMode ? '#334155' : '#cbd5e1'} 
              position={[0, -0.01, 0]} 
            />
            
            {model && data && mujoco && (
              <PhysicsLoop 
                key={`loop-${recompileId}`} 
                model={model} 
                data={data} 
                mujoco={mujoco} 
                isPlaying={isPlaying} 
              />
            )}
            {model && data && mujoco && (
              <SceneVisuals 
                key={`visuals-${recompileId}`}
                model={model} 
                data={data} 
                mujoco={mujoco} 
                sceneGraph={sceneGraph} 
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
              />
            )}
            
            {/* Rope markers rendered in raw world space (no coordinate system rotation) */}
            <PulleyRopeMarkers
              sceneGraph={sceneGraph}
              selectedNodeId={selectedNodeId}
              setSelectedNodeId={setSelectedNodeId}
            />
            
            <AxisLegendDrawer externalRef={axisCanvasRef} />
            <CameraController />
            <DragInteractionController />
          </Canvas>

          {/* Floating Viewport Camera Controls */}
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 p-1 rounded-lg shadow-sm">
            <button
              onClick={() => setCameraView('perspective')}
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                cameraView === 'perspective'
                  ? 'bg-blue-500 text-white shadow-xs'
                  : 'text-slate-650 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Perspective
            </button>
            <button
              onClick={() => setCameraView('topDown')}
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                cameraView === 'topDown'
                  ? 'bg-blue-500 text-white shadow-xs'
                  : 'text-slate-655 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Top Down
            </button>
          </div>

          {/* Floating Note Card Overlays */}
          {noteCards.map(card => (
            <NoteCardOverlay
              key={card.id}
              card={card}
              isEditing={editingCardId === card.id}
              onToggleEdit={() => setEditingCardId(prev => prev === card.id ? null : card.id)}
              onToggleMinimize={() => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, minimized: !c.minimized } : c))}
              onMarkdownChange={(md) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, markdown: md } : c))}
              onClose={() => { setNoteCards(prev => prev.filter(c => c.id !== card.id)); if (editingCardId === card.id) setEditingCardId(null); }}
              onMove={(x, y) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, x, y } : c))}
            />
          ))}
        </main>

        {/* Contextual Properties Sidebar */}
        {selectedNode && (
          <aside 
            style={{ width: `${propertiesWidth}px` }} 
            className="shrink-0 glass-panel border-l border-slate-200 dark:border-slate-800 flex flex-col p-4 z-20 bg-white/55 dark:bg-slate-900/55 overflow-y-auto relative"
          >
            {/* Elegant Resize Handle */}
            <div
              onMouseDown={handleMouseDown}
              className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/20 active:bg-blue-500/40 transition-colors z-20 group hidden md:flex items-center justify-center"
              title="Drag to resize panel"
            >
              <div className="w-[2px] h-8 bg-slate-300 dark:bg-slate-700 group-hover:bg-blue-500 group-active:bg-blue-600 rounded transition-colors" />
            </div>

            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2"><SlidersHorizontal className="w-4 h-4" /> Properties</span>
              <button onClick={() => setSelectedNodeId(null)}><X className="w-4 h-4 text-slate-400 hover:text-slate-600" /></button>
            </h2>
            
            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
                  <div>
                    <div className="text-xs font-semibold text-slate-700">Aerodynamics</div>
                    <div className="text-[10px] text-slate-500">Apply lift and drag automatically</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={selectedNode.isAerodynamic || false}
                      onChange={(e) => updateNode(selectedNode.id, { isAerodynamic: e.target.checked })}
                    />
                    <div className="w-8 h-4 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500"></div>
                  </label>
                </div>

                <div className="flex flex-col gap-1.5 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Component Name</label>
                  <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Body API Reference Name. Click to select/copy.">
                    api.getPosition('{selectedNode.name || selectedNode.id}')
                  </span>
                </div>
                <input 
                  type="text" 
                  value={selectedNode.name || ''} 
                  onChange={(e) => renameNode(selectedNode.id, e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-800 outline-none focus:border-blue-500 shadow-sm"
                  placeholder="Rename component..."
                />
                <span className="text-[9px] font-mono text-slate-400 mt-0.5">ID: {selectedNode.id}</span>
              </div>

              {/* Position Coordinates (Applicable to all nodes!) */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2">Position Offset</h3>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">X Position
                      <span>{selectedNode.pos[0].toFixed(2)} m</span>
                    </label>
                    <input 
                      type="range" 
                      min="-10" 
                      max="10" 
                      step="0.05" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.pos[0]} 
                      onChange={(e) => handleMove(0, parseFloat(e.target.value))} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Y Position
                      <span>{selectedNode.pos[1].toFixed(2)} m</span>
                    </label>
                    <input 
                      type="range" 
                      min="-10" 
                      max="10" 
                      step="0.05" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.pos[1]} 
                      onChange={(e) => handleMove(1, parseFloat(e.target.value))} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(() => {
                      // For dynamic mesh bodies, pos[2] = centroid Z, not base Z.
                      // Compute centroid offset from renderVertices so slider 0 = base on ground.
                      const dynMesh = selectedNode.geoms?.find((g: any) => g.dynamic && g.renderVertices);
                      const centroidZ = dynMesh
                        ? -Math.min(...(dynMesh.renderVertices as number[]).filter((_: number, i: number) => i % 3 === 2))
                        : 0;
                      const displayZ = selectedNode.pos[2] - centroidZ;
                      return (<>
                        <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Z Position (Height)
                          <span>{displayZ.toFixed(2)} m{centroidZ > 0 ? <span className="text-slate-300 ml-1">(+{centroidZ.toFixed(3)} centroid)</span> : null}</span>
                        </label>
                        <input
                          type="range"
                          min="0"
                          max="10"
                          step="0.05"
                          className="w-full accent-blue-500 cursor-pointer"
                          value={displayZ}
                          onChange={(e) => handleMove(2, parseFloat(e.target.value) + centroidZ)}
                        />
                      </>);
                    })()}
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">X Rotation
                      <span>{(selectedNode.euler ? selectedNode.euler[0] : 0).toFixed(0)}°</span>
                    </label>
                    <input 
                      type="range" 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[0] : 0} 
                      onChange={(e) => updateNodeRotation(selectedNode.id, 0, parseFloat(e.target.value))} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Y Rotation
                      <span>{(selectedNode.euler ? selectedNode.euler[1] : 0).toFixed(0)}°</span>
                    </label>
                    <input 
                      type="range" 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[1] : 0} 
                      onChange={(e) => updateNodeRotation(selectedNode.id, 1, parseFloat(e.target.value))} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Z Rotation
                      <span>{(selectedNode.euler ? selectedNode.euler[2] : 0).toFixed(0)}°</span>
                    </label>
                    <input 
                      type="range" 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[2] : 0} 
                      onChange={(e) => updateNodeRotation(selectedNode.id, 2, parseFloat(e.target.value))} 
                    />
                  </div>
                </div>
              </div>

              {/* Joint Type Configuration */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1">🔗 Joint Type</span>
                  <button 
                    onClick={() => {
                      setDocsTab('gravity');
                      setIsDocsOpen(true);
                    }} 
                    className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" 
                    title="Click for documentation"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>
                </h3>
                <select 
                  value={selectedNode.joints?.length > 0 ? selectedNode.joints[0].type : 'fixed'}
                  onChange={(e) => {
                    const jointType = e.target.value;
                    let newJoints: any[] = [];
                    if (jointType !== 'fixed') {
                      const name = `${selectedNode.id}_joint`;
                      if (jointType === 'free') {
                        newJoints = [{ name, type: 'free' }];
                      } else if (jointType === 'hinge') {
                        newJoints = [{ name, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }];
                      } else if (jointType === 'slide') {
                        newJoints = [{ name, type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.5 }];
                      } else if (jointType === 'ball') {
                        newJoints = [{ name, type: 'ball', pos: [0, 0, 0], damping: 0.5 }];
                      }
                    }
                    updateNodeJointsList(selectedNode.id, newJoints);
                  }}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="fixed">Fixed / Welded to Parent</option>
                  <option value="free">Free (6-DOF Movable)</option>
                  <option value="hinge">Hinge (Rotational Joint)</option>
                  <option value="slide">Slider (Prismatic Joint)</option>
                  <option value="ball">Ball Joint (Spherical)</option>
                </select>

                {selectedNode.joints?.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5 p-2 bg-slate-50 rounded-lg border border-slate-150">
                    <div className="flex justify-between items-center">
                      <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider">Joint Name (for API)</label>
                      <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Joint API Reference. Click to select/copy.">
                        api.getJointPosition('{selectedNode.joints[0].name}')
                      </span>
                    </div>
                    <input 
                      type="text" 
                      value={selectedNode.joints[0].name || ''} 
                      onChange={(e) => {
                        const cleanName = e.target.value.replace(/[^a-zA-Z0-9_]/g, '_');
                        updateNodeJoint(selectedNode.id, { name: cleanName });
                      }}
                      className="w-full px-2 py-1 border border-slate-200 rounded text-xs font-mono bg-white text-slate-800 outline-none focus:border-blue-500 shadow-sm"
                      placeholder="e.g. cart_slide"
                    />
                  </div>
                )}
                
                {/* Free Joint Launch Velocity */}
                {selectedNode.joints?.length > 0 && selectedNode.joints[0].type === 'free' && (
                  <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-slate-100">
                    <h3 className="text-xs font-semibold text-slate-600 mb-1">Launch Velocity (m/s)</h3>
                    {['X (Forward)', 'Y (Side)', 'Z (Up)'].map((label, i) => (
                      <div key={label} className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          {label} <span>{selectedNode.joints[0].initialVelocity?.[i] || 0}</span>
                        </label>
                        <input
                          type="range"
                          min="-20"
                          max="20"
                          step="0.5"
                          value={selectedNode.joints[0].initialVelocity?.[i] || 0}
                          onChange={(e) => {
                            const vel = [...(selectedNode.joints[0].initialVelocity || [0,0,0,0,0,0])];
                            vel[i] = parseFloat(e.target.value);
                            updateNodeJoint(selectedNode.id, { ...selectedNode.joints[0], initialVelocity: vel });
                          }}
                          className="w-full accent-blue-500 cursor-pointer"
                        />
                      </div>
                    ))}

                    <h3 className="text-xs font-semibold text-slate-600 mt-2 mb-1 pt-2 border-t border-slate-100">Launch Spin / Angular Velocity (rad/s)</h3>
                    {['X (Roll)', 'Y (Pitch)', 'Z (Yaw)'].map((label, i) => {
                      const idx = i + 3;
                      return (
                        <div key={label} className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            {label} <span>{selectedNode.joints[0].initialVelocity?.[idx] || 0}</span>
                          </label>
                          <input
                            type="range"
                            min="-50"
                            max="50"
                            step="0.5"
                            value={selectedNode.joints[0].initialVelocity?.[idx] || 0}
                            onChange={(e) => {
                              const vel = [...(selectedNode.joints[0].initialVelocity || [0,0,0,0,0,0])];
                              vel[idx] = parseFloat(e.target.value);
                              updateNodeJoint(selectedNode.id, { ...selectedNode.joints[0], initialVelocity: vel });
                            }}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Motor Actuator Option for Hinge/Slide joints */}
              {selectedNode.joints?.length > 0 && (selectedNode.joints[0].type === 'hinge' || selectedNode.joints[0].type === 'slide') && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚡ Joint Actuator / Motor</h3>
                  <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                    <input 
                      type="checkbox" 
                      checked={!!selectedNode.joints[0].actuator}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        const updatedJoint = {
                          ...selectedNode.joints[0],
                          actuator: enabled ? { type: 'velocity', kv: 10, ctrlValue: 0 } : undefined
                        };
                        updateNodeJoint(selectedNode.id, updatedJoint);
                      }}
                      className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                    />
                    Enable Motor Drive
                  </label>

                  {selectedNode.joints[0].actuator && (
                    <div className="flex flex-col gap-2.5 mt-1 pt-2 border-t border-slate-100">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Actuator Type</label>
                        <select
                          value={selectedNode.joints[0].actuator.type}
                          onChange={(e) => {
                            const type = e.target.value as 'velocity' | 'motor';
                            updateNodeJoint(selectedNode.id, {
                              ...selectedNode.joints[0],
                              actuator: { ...selectedNode.joints[0].actuator, type, kv: type === 'velocity' ? 10 : undefined }
                            });
                          }}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white font-medium text-slate-700 outline-none cursor-pointer focus:border-blue-500"
                        >
                          <option value="velocity">Velocity Drive (Target Speed)</option>
                          <option value="motor">Torque Drive (Direct Force)</option>
                        </select>
                      </div>

                      {selectedNode.joints[0].actuator.type === 'velocity' && (
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            Velocity Gain (kv) <span>{selectedNode.joints[0].actuator.kv || 10}</span>
                          </label>
                          <input
                            type="range"
                            min="0.5"
                            max="100"
                            step="0.5"
                            value={selectedNode.joints[0].actuator.kv || 10}
                            onChange={(e) => {
                              updateNodeJoint(selectedNode.id, {
                                ...selectedNode.joints[0],
                                actuator: { ...selectedNode.joints[0].actuator, kv: parseFloat(e.target.value) }
                              });
                            }}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}



              {/* Gear Config */}
              {selectedNode.id.includes('gear') && selectedNode.geoms && (() => {
                const pegGeom = selectedNode.geoms.find((g: any) => g.name.includes('peg'));
                const gearRadius = selectedNode.geoms[0].size[0];
                return (
                  <div className="flex flex-col gap-4">
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚙️ Gear Properties</h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">
                        Teeth Count <span>{selectedNode.geoms.length - (pegGeom ? 2 : 1)}</span>
                      </label>
                      <input 
                        type="range" 
                        min="4" 
                        max="24" 
                        step="1" 
                        value={selectedNode.geoms.length - (pegGeom ? 2 : 1)} 
                        onChange={(e) => {
                          const teethVal = parseInt(e.target.value);
                          updateGearTeeth(selectedNode.id, teethVal);
                        }} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                      <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                        Gear Radius <span>{gearRadius.toFixed(2)} m</span>
                      </label>
                      <input 
                        type="range" 
                        min="0.05" 
                        max="5.0" 
                        step="0.01" 
                        value={gearRadius} 
                        onChange={(e) => {
                          const r = parseFloat(e.target.value);
                          updateNodeGeom(selectedNode.id, { size: [r, selectedNode.geoms[0].size[1]] });
                        }} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>

                    {pegGeom ? (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">📍 Pusher Peg Properties</h3>
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          Peg Offset (Radius) <span>{pegGeom.pos[0].toFixed(2)} m</span>
                        </label>
                        <input 
                          type="range" 
                          min="0.01" 
                          max="5.0" 
                          step="0.01" 
                          value={pegGeom.pos[0]} 
                          onChange={(e) => {
                            const offsetVal = parseFloat(e.target.value);
                            updatePusherPeg(selectedNode.id, { offset: offsetVal });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                          Peg Thickness <span>{pegGeom.size[0].toFixed(3)} m</span>
                        </label>
                        <input 
                          type="range" 
                          min="0.005" 
                          max="0.5" 
                          step="0.005" 
                          value={pegGeom.size[0]} 
                          onChange={(e) => {
                            const rVal = parseFloat(e.target.value);
                            updatePusherPeg(selectedNode.id, { size: [rVal, pegGeom.size[1]] });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                          Peg Length <span>{pegGeom.size[1].toFixed(2)} m</span>
                        </label>
                        <input 
                          type="range" 
                          min="0.01" 
                          max="1.0" 
                          step="0.01" 
                          value={pegGeom.size[1]} 
                          onChange={(e) => {
                            const hVal = parseFloat(e.target.value);
                            updatePusherPeg(selectedNode.id, { size: [pegGeom.size[0], hVal] });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <button
                          onClick={() => deletePusherPeg(selectedNode.id)}
                          className="mt-2 w-full py-1.5 px-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-xs font-medium transition duration-150 shadow-sm border border-red-100"
                        >
                          🗑️ Remove Pusher Peg
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => addPusherPeg(selectedNode.id)}
                        className="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-xs font-semibold transition duration-150 border border-blue-100 flex items-center justify-center gap-1.5 shadow-sm"
                      >
                        ➕ Add Pusher Peg
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Damping, Limits, and Actuator Target Speed properties */}
              {selectedNode.joints?.map((joint: any, i: number) => (
                <div key={`joint-${i}`} className="flex flex-col gap-4">
                  {(joint.damping !== undefined || joint.type === 'free') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span>🔗 Joint Damping</span>
                      </h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">Damping <span>{(joint.damping !== undefined ? joint.damping : 0.0).toFixed(2)}</span></label>
                      <input 
                        type="range" 
                        min="0" 
                        max={joint.type === 'free' ? "5.0" : "500"} 
                        step={joint.type === 'free' ? "0.01" : "0.1"} 
                        value={joint.damping !== undefined ? joint.damping : 0.0} 
                        onChange={(e) => updateNodeJoint(selectedNode.id, {damping: parseFloat(e.target.value)})} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>
                  )}

                  {(joint.type === 'hinge' || joint.type === 'slide' || joint.type === 'ball') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span>🌸 Joint Springs</span>
                      </h3>
                      
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          Spring Stiffness (K) <span>{(joint.stiffness || 0).toFixed(0)} N/m</span>
                        </label>
                        <input 
                          type="range" 
                          min="0" 
                          max="5000" 
                          step="10" 
                          value={joint.stiffness || 0} 
                          onChange={(e) => updateNodeJoint(selectedNode.id, { stiffness: parseFloat(e.target.value) })}
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                      </div>

                      {(joint.stiffness || 0) > 0 && (joint.type === 'hinge' || joint.type === 'slide') && (
                        <div className="flex flex-col gap-1 mt-1 border-t border-slate-50 pt-2">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            Spring Rest Position <span>{(joint.springref || 0).toFixed(joint.type === 'slide' ? 2 : 0)}{joint.type === 'slide' ? ' m' : '°'}</span>
                          </label>
                          <input 
                            type="range" 
                            min={joint.type === 'slide' ? -20.0 : -360} 
                            max={joint.type === 'slide' ? 20.0 : 360} 
                            step={joint.type === 'slide' ? 0.05 : 1} 
                            value={joint.springref || 0} 
                            onChange={(e) => updateNodeJoint(selectedNode.id, { springref: parseFloat(e.target.value) })}
                            className="w-full accent-blue-500 cursor-pointer" 
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {(joint.type === 'hinge' || joint.type === 'slide') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span>🔒 Joint Limits</span>
                      </h3>
                      
                      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                        <input 
                          type="checkbox" 
                          checked={joint.limited === true || joint.limited === 'true'}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            const defaultRange = joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90];
                            updateNodeJoint(selectedNode.id, { 
                              limited: enabled,
                              range: enabled ? (joint.range || defaultRange) : undefined
                            });
                          }}
                          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                        />
                        Enable Range Limits
                      </label>

                      {(joint.limited === true || joint.limited === 'true') && (() => {
                        const range = joint.range || (joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90]);
                        const isSlide = joint.type === 'slide';
                        const minVal = range[0];
                        const maxVal = range[1];
                        
                        return (
                          <div className="flex flex-col gap-3 mt-1 border-t border-slate-50 pt-2">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">
                                Minimum Limit <span>{minVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                              </label>
                              <input 
                                type="range" 
                                min={isSlide ? -20.0 : -360}
                                max={isSlide ? 20.0 : 360}
                                step={isSlide ? 0.05 : 1}
                                value={minVal}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  const newMin = Math.min(val, maxVal);
                                  updateNodeJoint(selectedNode.id, { range: [newMin, maxVal] });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>

                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">
                                Maximum Limit <span>{maxVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                              </label>
                              <input 
                                type="range" 
                                min={isSlide ? -20.0 : -360}
                                max={isSlide ? 20.0 : 360}
                                step={isSlide ? 0.05 : 1}
                                value={maxVal}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  const newMax = Math.max(val, minVal);
                                  updateNodeJoint(selectedNode.id, { range: [minVal, newMax] });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {joint.actuator && (() => {
                    const isTorque = joint.actuator.type === 'motor';
                    
                    return (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">
                          {isTorque ? '💪 Target Torque/Force' : '⚡ Target Velocity'}
                        </h3>
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          {isTorque ? 'Control Force' : 'Control Speed'}
                          <span>{joint.actuator.ctrlValue || 0}</span>
                        </label>
                        <input 
                          type="range" 
                          min={isTorque ? "-1000" : "-100"} 
                          max={isTorque ? "1000" : "100"} 
                          step={isTorque ? "1" : "0.1"} 
                          value={joint.actuator.ctrlValue || 0} 
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (isPlaying) {
                              getPhysicsWorkerClient().setCtrl(`${joint.name}_actuator`, val);
                            }
                            updateNodeJoint(selectedNode.id, { actuator: { ...joint.actuator, ctrlValue: val } });
                          }}
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                      </div>
                    );
                  })()}
                </div>
              ))}

              {/* Dimensions Resizing and Color Properties */}
              {(() => {
                if (!selectedNode.geoms || selectedNode.geoms.length === 0) return null;
                const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
                const geom = selectedNode.geoms[activeIndex];
                if (!geom) return null;
                const hasMeshGeom = selectedNode.geoms?.some((g: any) => g.type === 'mesh');
                return (
                  <div key="geom-properties" className="flex flex-col gap-4">
                    {/* Sub-Geometry dropdown selector if there are multiple geoms */}
                    {selectedNode.geoms.length > 1 && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <label className="text-xs font-semibold text-slate-600">Select Sub-Geometry</label>
                        <select
                          value={activeIndex}
                          onChange={(e) => setActiveGeomIndex(parseInt(e.target.value))}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                        >
                          {selectedNode.geoms.map((g: any, idx: number) => (
                            <option key={idx} value={idx}>
                              {g.name || `Geom ${idx + 1}`} ({g.type})
                            </option>
                          ))}
                        </select>
                        <div className="text-[10px] text-slate-400 font-semibold px-0.5 flex justify-between uppercase tracking-wider">
                          <span>Type: {geom.type}</span>
                          {geom.name && <span>Name: {geom.name}</span>}
                        </div>
                      </div>
                    )}

                    {!selectedNode.id.includes('gear') && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2">📏 Resize Component</h3>

                        {hasMeshGeom && (
                          <div className="flex flex-col gap-2">
                            <label className="text-xs font-medium text-slate-500 flex justify-between">
                              Uniform Scale <span>scales all sub-geoms together</span>
                            </label>
                            <input
                              type="range"
                              min="0.1"
                              max="3.0"
                              step="0.05"
                              defaultValue="1.0"
                              onMouseUp={(e) => {
                                const scale = parseFloat((e.target as HTMLInputElement).value);
                                (e.target as HTMLInputElement).value = '1.0';
                                const newScene = JSON.parse(JSON.stringify(useStore.getState().sceneGraph));
                                const find = (nodes: any[]): any => {
                                  for (const n of nodes) {
                                    if (n.id === selectedNode.id) return n;
                                    const c = find(n.children);
                                    if (c) return c;
                                  }
                                  return null;
                                };
                                const node = find(newScene.nodes);
                                if (!node) return;
                                // Scale this node and all children recursively
                                const scaleNode = (n: any) => {
                                  scaleMeshGeoms(n, scale);
                                  for (const g of n.geoms) {
                                    if (g.type === 'mesh') continue;
                                    if (g.size) g.size = g.size.map((s: number) => s * scale);
                                    if (g.pos) g.pos = g.pos.map((p: number) => p * scale);
                                    if (g.fromto) g.fromto = g.fromto.map((f: number) => f * scale);
                                  }
                                  // Scale child body pos offsets too
                                  for (const child of (n.children || [])) {
                                    if (child.pos) child.pos = child.pos.map((p: number) => p * scale);
                                    scaleNode(child);
                                  }
                                };
                                scaleNode(node);
                                useStore.getState().updateScene(newScene);
                              }}
                              className="w-full accent-violet-500 cursor-pointer"
                            />
                            <p className="text-[10px] text-slate-400">Slider resets to 1× after release — each drag applies multiplicative scale to all sub-geoms.</p>
                          </div>
                        )}
                        
                        {geom.type === 'sphere' && (
                          <div className="flex flex-col gap-2">
                            <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <span>{geom.size[0].toFixed(2)} m</span></label>
                            <input 
                              type="range" 
                              min="0.05" 
                              max="2.0" 
                              step="0.01" 
                              value={geom.size[0]} 
                              onChange={(e) => {
                                const r = parseFloat(e.target.value);
                                updateNodeGeom(selectedNode.id, { size: [r] }, activeIndex);
                              }}
                              className="w-full accent-blue-500 cursor-pointer" 
                            />
                          </div>
                        )}

                        {geom.type === 'box' && selectedNode.isWedge && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <span>{(selectedNode.width || 2.0).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.5" 
                                max="5.0" 
                                step="0.05" 
                                value={selectedNode.width || 2.0} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateWedgeParams(selectedNode.id, { width: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <span>{(selectedNode.depth || 1.0).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.2" 
                                max="4.0" 
                                step="0.05" 
                                value={selectedNode.depth || 1.0} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateWedgeParams(selectedNode.id, { depth: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <span>{(selectedNode.height || 0.5).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.05" 
                                value={selectedNode.height || 0.5} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateWedgeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1 border-t border-slate-100 pt-2">
                              <label className="text-xs font-medium text-slate-600 flex justify-between">Wedge Angle <span>{(selectedNode.wedgeAngle !== undefined ? selectedNode.wedgeAngle : 14.036).toFixed(1)}°</span></label>
                              <input 
                                type="range" 
                                min="2" 
                                max="85" 
                                step="1" 
                                value={selectedNode.wedgeAngle !== undefined ? selectedNode.wedgeAngle : 14.036} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateWedgeParams(selectedNode.id, { wedgeAngle: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isPyramid && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <span>{(selectedNode.width || 0.5).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.width || 0.5} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updatePyramidParams(selectedNode.id, { width: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Depth (Y) <span>{(selectedNode.depth || 0.5).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.depth || 0.5} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updatePyramidParams(selectedNode.id, { depth: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <span>{(selectedNode.height || 0.5).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.height || 0.5} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updatePyramidParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isCone && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <span>{(selectedNode.radius || 0.3).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={selectedNode.radius || 0.3} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateConeParams(selectedNode.id, { radius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height <span>{(selectedNode.height || 0.6).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.height || 0.6} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateConeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isTorus && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Major Radius (Ring) <span>{(selectedNode.majorRadius || 0.4).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.majorRadius || 0.4} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTorusParams(selectedNode.id, { majorRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Tube Radius <span>{(selectedNode.tubeRadius || 0.1).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.02" 
                                max="1.0" 
                                step="0.01" 
                                value={selectedNode.tubeRadius || 0.1} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTorusParams(selectedNode.id, { tubeRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isTube && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Inner Radius <span>{(selectedNode.innerRadius || 0.2).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.02" 
                                max={selectedNode.outerRadius ? selectedNode.outerRadius - 0.01 : 0.29} 
                                step="0.01" 
                                value={selectedNode.innerRadius || 0.2} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTubeParams(selectedNode.id, { innerRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Outer Radius <span>{(selectedNode.outerRadius || 0.3).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min={selectedNode.innerRadius ? selectedNode.innerRadius + 0.01 : 0.21} 
                                max="2.0" 
                                step="0.01" 
                                value={selectedNode.outerRadius || 0.3} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTubeParams(selectedNode.id, { outerRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <span>{(selectedNode.height || 0.5).toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
                                value={selectedNode.height || 0.5} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTubeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {geom.type === 'ellipsoid' && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius X <span>{geom.size[0].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[0]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Y <span>{geom.size[1].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[1]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Z <span>{geom.size[2].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[2]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {geom.type === 'box' && !selectedNode.isWedge && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Width (X) <span>{geom.size[0].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[0]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <span>{geom.size[1].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[1]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <span>{geom.size[2].toFixed(2)} m</span></label>
                              <input 
                                type="range" 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
                                value={geom.size[2]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {(geom.type === 'capsule' || geom.type === 'cylinder') && !selectedNode.isPulleyWheel && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <span>{geom.size[0].toFixed(3)} m</span></label>
                              <input 
                                type="range" 
                                min="0.01" 
                                max="0.8" 
                                step="0.005" 
                                value={geom.size[0]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { 
                                    size: geom.size[1] !== undefined ? [val, geom.size[1]] : [val] 
                                  }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            {geom.size[1] !== undefined && (
                              <div className="flex flex-col gap-1">
                                <label className="text-xs font-medium text-slate-500 flex justify-between">Length (Half-Height) <span>{geom.size[1].toFixed(2)} m</span></label>
                                <input 
                                  type="range" 
                                  min="0.05" 
                                  max="3.0" 
                                  step="0.01" 
                                  value={geom.size[1]} 
                                  onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val] }, activeIndex);
                                  }}
                                  className="w-full accent-blue-500 cursor-pointer" 
                                />
                              </div>
                            )}
                            {geom.fromto !== undefined && (() => {
                              const dirX = geom.fromto[3] - geom.fromto[0];
                              const dirY = geom.fromto[4] - geom.fromto[1];
                              const dirZ = geom.fromto[5] - geom.fromto[2];
                              const currentLength = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ) || 1.0;
                              
                              return (
                                <div className="flex flex-col gap-1">
                                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                                    Length (Segment) <span>{currentLength.toFixed(2)} m</span>
                                  </label>
                                  <input 
                                    type="range" 
                                    min="0.1" 
                                    max="5.0" 
                                    step="0.05" 
                                    value={currentLength} 
                                    onChange={(e) => {
                                      const newVal = parseFloat(e.target.value);
                                      const scale = newVal / currentLength;
                                      const newFromto = [
                                        geom.fromto[0],
                                        geom.fromto[1],
                                        geom.fromto[2],
                                        geom.fromto[0] + dirX * scale,
                                        geom.fromto[1] + dirY * scale,
                                        geom.fromto[2] + dirZ * scale
                                      ];
                                      updateNodeGeom(selectedNode.id, { fromto: newFromto }, activeIndex);
                                    }}
                                    className="w-full accent-blue-500 cursor-pointer" 
                                  />
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Position Offset Control for Sub-Geom */}
                    {(() => {
                      const pos = geom.pos || [0, 0, 0];
                      return (
                        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2">📍 Geom Position Offset</h3>
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">X Offset <span>{pos[0].toFixed(3)} m</span></label>
                              <input 
                                type="range" 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
                                value={pos[0]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Y Offset <span>{pos[1].toFixed(3)} m</span></label>
                              <input 
                                type="range" 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
                                value={pos[1]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], val, pos[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Z Offset <span>{pos[2].toFixed(3)} m</span></label>
                              <input 
                                type="range" 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
                                value={pos[2]} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], pos[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">Mass</h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">Value <span>{geom.mass} kg</span></label>
                      <input type="range" min="0" max="50" step="0.01" value={geom.mass} onChange={(e) => updateNodeGeom(selectedNode.id, {mass: parseFloat(e.target.value)}, activeIndex)} className="w-full accent-blue-500 cursor-pointer" />
                    </div>

                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">💥 Collision Physics</span>
                        <button 
                          onClick={() => {
                            setDocsTab('collision');
                            setIsDocsOpen(true);
                          }} 
                          className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" 
                          title="Click for documentation"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </h3>
                      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                        <input 
                          type="checkbox" 
                          checked={geom.contype !== 0 && geom.conaffinity !== 0}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            updateNodeGeom(selectedNode.id, {
                              contype: enabled ? 1 : 0,
                              conaffinity: enabled ? 1 : 0
                            }, activeIndex);
                          }}
                          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                        />
                        Enable Collisions
                      </label>
                    </div>

                    {/* Material Properties Card */}
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">🧪 Physical Material</span>
                        <button 
                          onClick={() => {
                            setDocsTab('friction');
                            setIsDocsOpen(true);
                          }} 
                          className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" 
                          title="Click for documentation"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </h3>

                      {/* Contact spring timeconst — solref[0] */}
                      {(() => {
                        const val = geom.solref ? Math.max(0.001, geom.solref[0]) : 0.02;
                        return (
                          <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Contact Stiffness <span className="text-[10px] font-normal text-slate-400">solref[0]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(3)}s</span>
                            </label>
                            <input type="range" min="0.001" max="0.1" step="0.001" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(e) => {
                                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                                sr[0] = parseFloat(e.target.value);
                                updateNodeGeom(selectedNode.id, { solref: sr as [number,number] }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">Time constant of the contact spring. Lower = stiffer contact. Keep ≥ 5× timestep (0.005s) to avoid instability.</span>
                          </div>
                        );
                      })()}

                      {/* Damping ratio — solref[1] */}
                      {(() => {
                        const val = geom.solref ? Math.max(0, Math.min(1, geom.solref[1])) : 1.0;
                        return (
                          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Damping Ratio (Bounciness) <span className="text-[10px] font-normal text-slate-400">solref[1]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(2)}</span>
                            </label>
                            <input type="range" min="0.0" max="1.0" step="0.01" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(e) => {
                                const dr = parseFloat(e.target.value);
                                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                                sr[1] = dr;
                                updateNodeGeom(selectedNode.id, {
                                  solref: sr as [number,number],
                                  solimp: [0.99, 0.9999, 0.0001, 0.5, 2]
                                }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">0 = max bounce (underdamped). 1 = no bounce (critically damped). ~0.2 gives lively bouncing.</span>
                          </div>
                        );
                      })()}

                      {/* Contact impedance — solimp[0] */}
                      {(() => {
                        const val = geom.solimp ? geom.solimp[0] : 0.99;
                        return (
                          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Contact Impedance <span className="text-[10px] font-normal text-slate-400">solimp[0]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(3)}</span>
                            </label>
                            <input type="range" min="0.8" max="0.9999" step="0.001" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(e) => {
                                const si = geom.solimp ? [...geom.solimp] : [0.99, 0.9999, 0.0001, 0.5, 2];
                                si[0] = parseFloat(e.target.value);
                                updateNodeGeom(selectedNode.id, { solimp: si as any }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">Controls how much the contact force can deviate from ideal. Higher = harder, less penetration.</span>
                          </div>
                        );
                      })()}

                      {/* Friction Sliders */}
                      {(() => {
                        const fr = geom.friction ?? [0.7, 0.005, 0.0001];
                        return (
                          <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
                            {[
                              { label: 'Sliding Friction', key: 0, min: 0, max: 2, step: 0.01, hint: 'Tangential friction. High = rubbery, low = icy.' },
                              { label: 'Torsional Friction', key: 1, min: 0, max: 0.05, step: 0.001, hint: 'Spin friction around the contact normal.' },
                              { label: 'Rolling Friction', key: 2, min: 0, max: 0.01, step: 0.0001, hint: 'Resistance to rolling. Keeps balls from rolling forever.' },
                            ].map(({ label, key, min, max, step, hint }) => (
                              <div key={key} className="flex flex-col gap-1.5">
                                <label className="text-xs font-semibold text-slate-500 flex justify-between">
                                  {label} <span className="text-[10px] font-normal text-slate-400">friction[{key}]</span>
                                  <span className="text-blue-600 font-bold">{fr[key].toFixed(key === 2 ? 4 : 3)}</span>
                                </label>
                                <input type="range" min={min} max={max} step={step} className="w-full accent-blue-500 cursor-pointer"
                                  value={fr[key]}
                                  onChange={(e) => {
                                    const newFr = [...fr] as [number,number,number];
                                    newFr[key] = parseFloat(e.target.value);
                                    updateNodeGeom(selectedNode.id, { friction: newFr }, activeIndex);
                                  }}
                                />
                                <span className="text-[10px] text-slate-400 leading-tight">{hint}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Joint Mechanical Coupling Configuration */}
                    {selectedNode.joints && selectedNode.joints.length > 0 && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-1">⚙️ Mechanical Coupling</span>
                          <button 
                            onClick={() => {
                              setDocsTab('coupling');
                              setIsDocsOpen(true);
                            }} 
                            className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" 
                            title="Click for documentation"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                        </h3>

                        <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                          <input 
                            type="checkbox" 
                            checked={selectedNode.allowCoupling !== false}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              const newScene = JSON.parse(JSON.stringify(sceneGraph));
                              const traverse = (nodes: any[]) => {
                                if (!nodes) return false;
                                for (const node of nodes) {
                                  if (node.id === selectedNode.id) {
                                    node.allowCoupling = enabled;
                                    return true;
                                  }
                                  if (traverse(node.children)) return true;
                                }
                                return false;
                              };
                              traverse(newScene.nodes);
                              updateScene(newScene);
                            }}
                            className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                          />
                          Enable Coupling
                        </label>

                        {selectedNode.allowCoupling !== false && (() => {
                          // Gather list of other jointed nodes in the scene
                          const list: SceneNode[] = [];
                          const traverse = (items: SceneNode[]) => {
                            for (const item of items) {
                              if (item.id !== selectedNode.id && item.joints && item.joints.length > 0) {
                                list.push(item);
                              }
                              if (item.children) {
                                traverse(item.children);
                              }
                            }
                          };
                          traverse(sceneGraph.nodes);

                          return (
                            <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Couple Target Component</span>
                                <select
                                  value={selectedNode.coupleTargetId || ''}
                                  onChange={(e) => {
                                    const val = e.target.value || undefined;
                                    const newScene = JSON.parse(JSON.stringify(sceneGraph));
                                    const traverse2 = (nodes: any[]) => {
                                      if (!nodes) return false;
                                      for (const node of nodes) {
                                        if (node.id === selectedNode.id) {
                                          node.coupleTargetId = val;
                                          // Default ratio depending on type if target selected and no custom ratio set
                                          if (val && node.coupleRatio === undefined) {
                                            node.coupleRatio = val.includes('rack') || selectedNode.id.includes('rack') ? 0.2 : -1.0;
                                          }
                                          return true;
                                        }
                                        if (traverse2(node.children)) return true;
                                      }
                                      return false;
                                    };
                                    traverse2(newScene.nodes);
                                    updateScene(newScene);
                                  }}
                                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                                >
                                  <option value="">[Auto Proximity Fallback]</option>
                                  {list.map(node => (
                                    <option key={node.id} value={node.id}>
                                      {node.name || node.id} ({node.joints[0].type})
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {selectedNode.coupleTargetId && (
                                <div className="flex flex-col gap-1">
                                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Coupling Ratio</span>
                                  <div className="flex gap-1.5 items-center">
                                    <select
                                      value={
                                        selectedNode.coupleRatio === -1.0 ? 'gear' :
                                        selectedNode.coupleRatio === 0.2 ? 'pinion_rack' :
                                        selectedNode.coupleRatio === 1.0 ? 'direct' :
                                        'custom'
                                      }
                                      onChange={(e) => {
                                        const type = e.target.value;
                                        let ratio = -1.0;
                                        if (type === 'gear') ratio = -1.0;
                                        else if (type === 'pinion_rack') ratio = 0.2;
                                        else if (type === 'direct') ratio = 1.0;
                                        else ratio = selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0;

                                        const newScene = JSON.parse(JSON.stringify(sceneGraph));
                                        const traverse2 = (nodes: any[]) => {
                                          if (!nodes) return false;
                                          for (const node of nodes) {
                                            if (node.id === selectedNode.id) {
                                              node.coupleRatio = ratio;
                                              return true;
                                            }
                                            if (traverse2(node.children)) return true;
                                          }
                                          return false;
                                        };
                                        traverse2(newScene.nodes);
                                        updateScene(newScene);
                                      }}
                                      className="px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer flex-1"
                                    >
                                      <option value="gear">Gears meshing (-1.0)</option>
                                      <option value="pinion_rack">Rack & Pinion (0.2)</option>
                                      <option value="direct">Direct link (1.0)</option>
                                      <option value="custom">Custom Ratio...</option>
                                    </select>

                                    <input
                                      type="number"
                                      step="0.05"
                                      value={selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0}
                                      onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        if (isNaN(val)) return;
                                        const newScene = JSON.parse(JSON.stringify(sceneGraph));
                                        const traverse2 = (nodes: any[]) => {
                                          if (!nodes) return false;
                                          for (const node of nodes) {
                                            if (node.id === selectedNode.id) {
                                              node.coupleRatio = val;
                                              return true;
                                            }
                                            if (traverse2(node.children)) return true;
                                          }
                                          return false;
                                        };
                                        traverse2(newScene.nodes);
                                        updateScene(newScene);
                                      }}
                                      className="w-16 px-1.5 py-1.5 border border-slate-200 rounded text-xs text-center font-mono outline-none focus:border-blue-500"
                                      title="Custom gear coupling ratio"
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">Appearance</h3>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">Color (RGB)</span>
                        <input type="color" value={`#${Math.floor(geom.rgba[0]*255).toString(16).padStart(2,'0')}${Math.floor(geom.rgba[1]*255).toString(16).padStart(2,'0')}${Math.floor(geom.rgba[2]*255).toString(16).padStart(2,'0')}`} 
                          onChange={(e) => {
                            const hex = e.target.value;
                            const r = parseInt(hex.slice(1,3), 16)/255;
                            const g = parseInt(hex.slice(3,5), 16)/255;
                            const b = parseInt(hex.slice(5,7), 16)/255;
                            updateNodeGeom(selectedNode.id, {rgba: [r,g,b,1]}, activeIndex);
                          }} 
                          className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm" 
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Mesh Properties — shown when the body or any child has a mesh geom */}
              {(() => {
                const allGeoms: any[] = [];
                const collectGeoms = (node: any) => { node.geoms?.forEach((g: any) => allGeoms.push({...g, _fromChildId: node.id !== selectedNode.id ? node.id : null})); node.children?.forEach(collectGeoms); };
                collectGeoms(selectedNode);
                if (!allGeoms.some((g: any) => g.type === 'mesh')) return null;
                return (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                    <Shapes className="w-3.5 h-3.5 text-violet-500" /> Body Geoms ({allGeoms.length})
                  </h3>
                  <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
                    Static mesh geoms are <strong>visual only</strong>. Primitive geoms handle physics. Dynamic meshes simulate and collide.
                  </p>
                  {allGeoms.map((g: any) => (
                    <div key={g.name} className="flex flex-col gap-1.5 p-2 bg-slate-50 rounded border border-slate-100">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                          {g.name}{g._fromChildId ? <span className="text-violet-400 font-normal"> (child)</span> : null}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {g.type === 'mesh'
                            ? (g.vertices ? `mesh · ${g.vertices.length / 3} verts · ${g.faces ? g.faces.length / 3 : 0} tris${g.dynamic ? ' · dynamic' : ' · static'}` : 'mesh · no geometry')
                            : `${g.type} · size [${(g.size || []).map((s: number) => s.toFixed(2)).join(', ')}]`}
                        </span>
                      </div>
                      {g.type === 'mesh' && g.vertices && g.vertices.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => {
                                if (meshEditorGeom === g.name) { setMeshEditorGeom(null); return; }
                                // Format vertices as one triplet per line, faces as one triangle per line
                                const vLines = [];
                                for (let i = 0; i < g.vertices.length; i += 3)
                                  vLines.push(`${g.vertices[i]} ${g.vertices[i+1]} ${g.vertices[i+2]}`);
                                const fLines = [];
                                for (let i = 0; i < g.faces.length; i += 3)
                                  fLines.push(`${g.faces[i]} ${g.faces[i+1]} ${g.faces[i+2]}`);
                                setMeshEditorText(`# vertices (x y z, one per line — Three.js Y-up space)\n${vLines.join('\n')}\n\n# faces (i j k triangle indices, one per line)\n${fLines.join('\n')}`);
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
                                const unique = new Map<string, number>();
                                const newVerts: number[] = [], remap: number[] = [];
                                for (let i = 0; i < g.vertices.length; i += 3) {
                                  const key = `${g.vertices[i].toFixed(4)},${g.vertices[i+1].toFixed(4)},${g.vertices[i+2].toFixed(4)}`;
                                  if (!unique.has(key)) { unique.set(key, newVerts.length/3); newVerts.push(g.vertices[i], g.vertices[i+1], g.vertices[i+2]); }
                                  remap[i/3] = unique.get(key)!;
                                }
                                const filteredFaces: number[] = [];
                                for (let i = 0; i < g.faces.length; i += 3) {
                                  const a=remap[g.faces[i]], b=remap[g.faces[i+1]], c=remap[g.faces[i+2]];
                                  if (a!==b && b!==c && a!==c) filteredFaces.push(a,b,c);
                                }
                                const newScene = JSON.parse(JSON.stringify(useStore.getState().sceneGraph));
                                const traverse = (nodes: any[]): boolean => { for (const node of nodes) { const idx = node.geoms?.findIndex((ng: any) => ng.name === g.name); if (idx >= 0) { node.geoms[idx] = {...node.geoms[idx], vertices: newVerts, faces: filteredFaces}; return true; } if (traverse(node.children)) return true; } return false; };
                                traverse(newScene.nodes);
                                useStore.getState().updateScene(newScene);
                              }}
                              className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded text-[10px] font-semibold text-slate-600 transition-colors cursor-pointer"
                              title="Remove duplicate vertices"
                            >
                              <Minimize2 className="w-3 h-3" />
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
                                      if (nums.length !== 3 || nums.some(isNaN)) throw new Error(`Bad line: "${raw.trim()}" — expected exactly 3 numbers`);
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
                                    let newRenderVerts: number[] | undefined;
                                    if (g.dynamic) {
                                      newRenderVerts = [];
                                      for (let i = 0; i < newVerts.length; i += 3) {
                                        const x = newVerts[i], y = newVerts[i+1], z = newVerts[i+2];
                                        newRenderVerts.push(+x.toFixed(5), +(-z).toFixed(5), +y.toFixed(5));
                                      }
                                    }
                                    const newScene = JSON.parse(JSON.stringify(useStore.getState().sceneGraph));
                                    const traverse = (nodes: any[]): boolean => {
                                      for (const node of nodes) {
                                        const idx = node.geoms?.findIndex((ng: any) => ng.name === g.name);
                                        if (idx >= 0) {
                                          node.geoms[idx] = {...node.geoms[idx], vertices: newVerts, faces: newFaces, ...(newRenderVerts ? {renderVertices: newRenderVerts} : {})};
                                          return true;
                                        }
                                        if (traverse(node.children)) return true;
                                      }
                                      return false;
                                    };
                                    traverse(newScene.nodes);
                                    useStore.getState().updateScene(newScene);
                                    setMeshEditorError(null);
                                    setMeshEditorGeom(null);
                                  } catch (e: any) {
                                    setMeshEditorError(e.message);
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
                                <input
                                  type="range"
                                  min="0.05"
                                  max="0.95"
                                  step="0.05"
                                  value={simplifyRatio}
                                  onChange={(e) => setSimplifyRatio(parseFloat(e.target.value))}
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
                                    onClick={() => handleSimplifyMesh(g)}
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
              })()}

              {selectedNode.isPulleyWheel && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">🛞 Pulley Properties</h3>
                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                    Pulley Radius <span>{(selectedNode.pulleyRadius || 0.4).toFixed(2)} m</span>
                  </label>
                  <input 
                    type="range" 
                    min="0.15" 
                    max="1.5" 
                    step="0.01" 
                    value={selectedNode.pulleyRadius || 0.4} 
                    onChange={(e) => {
                      const radVal = parseFloat(e.target.value);
                      updatePulleyParams(selectedNode.id, { pulleyRadius: radVal });
                    }} 
                    className="w-full accent-blue-500 cursor-pointer" 
                  />
                </div>
              )}

              {selectedNode.isPulleyRope && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                    <span>🧵 Rope Properties</span>
                  </h3>

                  <p className="text-[10px] text-slate-400 leading-snug -mt-1">
                    Connect two bodies directly, or optionally route through a Pulley Wheel for an Atwood-style coupling.
                  </p>
                  
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Body A <span className="font-normal text-rose-400">required</span>
                    </label>
                    <select
                      value={selectedNode.leftTargetId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { leftTargetId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- Select Body A --</option>
                      {allJointedNodes.map(n => (
                        <option key={n.id} value={n.id}>{n.id}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Body B <span className="font-normal text-rose-400">required</span>
                    </label>
                    <select
                      value={selectedNode.rightTargetId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { rightTargetId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- Select Body B --</option>
                      {allJointedNodes.map(n => (
                        <option key={n.id} value={n.id}>{n.id}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Pulley Wheel <span className="font-normal text-slate-400">optional</span>
                    </label>
                    <select
                      value={selectedNode.pulleyWheelId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { pulleyWheelId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- None (direct coupling) --</option>
                      {allPulleyWheels.map(wheel => (
                        <option key={wheel.id} value={wheel.id}>
                          {wheel.id} (r={( wheel.pulleyRadius || 0.4).toFixed(2)}m)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* OpenSCAD Editor Card */}
              {selectedNode.scad !== undefined && (
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
                                {Number((slidingValues[v.name] ?? v.value).toFixed(4))}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-400 font-mono w-8 text-right">{v.min}</span>
                              <input
                                type="range"
                                min={v.min}
                                max={v.max}
                                step={v.step}
                                value={slidingValues[v.name] ?? v.value}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setSlidingValues(prev => ({ ...prev, [v.name]: val }));
                                  debouncedUpdateCode();
                                }}
                                className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-600"
                              />
                              <span className="text-[9px] text-slate-400 font-mono w-8">{v.max}</span>
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

                          const targetStr = window.prompt("Longest part's longest side (mm):", defaultPrompt);
                          if (targetStr === null) return;
                          const targetMm = parseFloat(targetStr);
                          if (isNaN(targetMm) || targetMm <= 0) { alert('Invalid size'); return; }

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
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${selectedNode.name || 'openscad_shape'}.stl`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch (e: any) {
                          alert('Failed to export OpenSCAD STL: ' + e.message);
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
              )}

              {/* Component Control Script Card */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <Code className="w-4 h-4 text-blue-500" />
                    Component Script
                  </span>
                  <div className="flex items-center gap-1.5">
                    {selectedNode.script ? (
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-100 animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100">
                        Disabled
                      </span>
                    )}
                  </div>
                </h3>

                <p className="text-[10px] text-slate-400 -mt-1 leading-tight">
                  Write custom real-time JavaScript to control this component at 1000Hz.
                </p>

                {/* Templates Selector */}
                <div className="flex items-center justify-between text-xs text-slate-500 gap-1.5 bg-slate-50 p-1.5 rounded-md border border-slate-100">
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Templates:</span>
                  <select
                    onChange={(e) => {
                      const templateVal = e.target.value;
                      if (templateVal === 'lqr') {
                        setScriptText(`// Cartpole LQR Balancing Controller
const x = api.getJointPosition('cart_slide');
const v = api.getJointVelocity('cart_slide');
const theta = api.getJointPosition('pole_hinge');
const omega = api.getJointVelocity('pole_hinge');

// State-feedback LQR controller gains
const kx = 22.0;      // Cart position gain
const kv = 15.0;      // Cart velocity damping
const kTheta = 80.0;  // Pole angle gain (robust tracking)
const kOmega = 20.0;  // Pole angular velocity damping

// Compute the balancing force
const force = (kx * x) + (kv * v) + (kTheta * theta) + (kOmega * omega);

// Apply force directly to the cart slide joint
api.applyJointForce('cart_slide', force);
`);
                      } else if (templateVal === 'sine') {
                        setScriptText(`// Sinusoidal Driver
const forceX = Math.sin(api.getTime() * 5.0) * 8.0;
api.applyForce([forceX, 0, 0]);
`);
                      } else if (templateVal === 'spring') {
                        setScriptText(`// PD Harmonic Spring / Return-to-Center
const pos = api.getPosition();
const dist = 0.0 - pos[0];
const vel = api.getVelocity()[0];

// PD coefficients
const kp = 25.0; // Spring constant
const kd = 5.0;  // Damping

const force = (kp * dist) - (kd * vel);
api.applyForce([force, 0, 0]);
`);
                      } else if (templateVal === 'clear') {
                        setScriptText('');
                      }
                      e.target.value = ''; // Reset selection
                    }}
                    className="text-xs bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                  >
                    <option value="">-- Select Template --</option>
                    <option value="lqr">LQR Cartpole Balancer</option>
                    <option value="sine">Sinusoidal Driver</option>
                    <option value="spring">PD Harmonic Spring</option>
                    <option value="clear">Clear Script</option>
                  </select>
                </div>

                {/* Text Area Code Editor */}
                <div className="relative">
                  <textarea
                    value={scriptText}
                    onChange={(e) => setScriptText(e.target.value)}
                    placeholder="// Write control logic here... e.g. api.applyForce([10, 0, 0])"
                    className="w-full h-40 font-mono text-[11px] leading-relaxed p-2.5 bg-slate-950 text-emerald-400 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y shadow-inner"
                    spellCheck={false}
                  />
                  <div className="absolute right-2.5 bottom-2.5 text-[8px] font-mono text-slate-600 bg-slate-900/50 px-1 rounded pointer-events-none select-none border border-slate-800">
                    JS
                  </div>
                </div>

                {/* Compilation Error Display */}
                {scriptError && (
                  <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[10px] flex gap-1.5 items-start leading-tight">
                    <span className="font-bold shrink-0">⚠️ Error:</span>
                    <span className="font-mono text-slate-700 break-all">{scriptError}</span>
                  </div>
                )}

                {/* Control Actions Row */}
                <div className="flex gap-2 items-center justify-between">
                  <button
                    onClick={() => setShowApiRef(!showApiRef)}
                    className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Info className="w-3.5 h-3.5" />
                    {showApiRef ? 'Hide API Reference' : 'Show API Reference'}
                  </button>

                  <button
                    onClick={handleSaveScript}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-[11px] font-semibold shadow transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Save & Execute
                  </button>
                </div>

                {/* API Reference Collapsible */}
                {showApiRef && (
                  <div className="text-[10px] bg-slate-50 border border-slate-150 rounded-lg p-2.5 flex flex-col gap-2 font-sans text-slate-600 max-h-48 overflow-y-auto">
                    <div className="font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-1">Available API Methods:</div>
                    <div className="flex flex-col gap-1.5">
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getPosition(bodyName?)</code>
                        <p className="text-slate-500 mt-0.5">Returns array <code className="font-mono">[x, y, z]</code> of body position.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getVelocity(bodyName?)</code>
                        <p className="text-slate-500 mt-0.5">Returns array <code className="font-mono">[vx, vy, vz]</code> of body velocity.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getAngularVelocity(bodyName?)</code>
                        <p className="text-slate-500 mt-0.5">Returns array <code className="font-mono">[wx, wy, wz]</code> of body angular velocity.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getMass(bodyName?)</code>
                        <p className="text-slate-500 mt-0.5">Returns body mass in kg.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getJointPosition(jointName)</code>
                        <p className="text-slate-500 mt-0.5">Returns joint position (m for slide, rad for hinge).</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getJointVelocity(jointName)</code>
                        <p className="text-slate-500 mt-0.5">Returns joint velocity (m/s for slide, rad/s for hinge).</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.applyForce(forceVec, bodyName?)</code>
                        <p className="text-slate-500 mt-0.5">Applies external force <code className="font-mono">[fx, fy, fz]</code> to a body.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.applyJointForce(jointName, forceVal)</code>
                        <p className="text-slate-500 mt-0.5">Applies joint-aligned torque or force.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.setActuatorControl(actuatorName, ctrlVal)</code>
                        <p className="text-slate-500 mt-0.5">Sets input control value on an actuator.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.getTime()</code>
                        <p className="text-slate-500 mt-0.5">Returns elapsed simulation time in seconds.</p>
                      </div>
                      <div>
                        <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api.log(msg)</code>
                        <p className="text-slate-500 mt-0.5">Logs message to browser developer console.</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Delete Component Button */}
              <button 
                onClick={() => deleteNode(selectedNode.id)}
                className="mt-2 flex items-center justify-center gap-2 w-full py-2 border border-red-200 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 hover:border-red-300 transition-colors shadow-sm cursor-pointer"
              >
                <Trash2 className="w-4 h-4" /> Delete Component
              </button>
            </div>
          </aside>
        )}

        {showAICopilot && (
          <AICopilotPanel onClose={() => setShowAICopilot(false)} />
        )}
      </div>

      {isDocsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-150 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-blue-500" />
                <h2 className="font-bold text-slate-800 text-base">PhysBox: Mesh Reference Guide</h2>
              </div>
              <button 
                onClick={() => setIsDocsOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content Split */}
            <div className="flex flex-1 overflow-hidden min-h-0">
              {/* Tab Navigation */}
              <div className="w-48 bg-slate-50 border-r border-slate-150 p-3 flex flex-col gap-1.5 shrink-0 overflow-y-auto">
                <button 
                  onClick={() => setDocsTab('gravity')}
                  className={`px-3 py-2 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === 'gravity' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  🪐 Gravity & Inertia
                </button>
                <button 
                  onClick={() => setDocsTab('coupling')}
                  className={`px-3 py-2 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === 'coupling' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  ⚙️ Joint Coupling
                </button>
                <button 
                  onClick={() => setDocsTab('collision')}
                  className={`px-3 py-2 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === 'collision' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  💥 Collision Physics
                </button>
                <button 
                  onClick={() => setDocsTab('friction')}
                  className={`px-3 py-2 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === 'friction' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  🛷 Friction Controls
                </button>
                <button 
                  onClick={() => setDocsTab('scripting')}
                  className={`px-3 py-2 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === 'scripting' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  💻 Control Scripting
                </button>
              </div>

              {/* Tab Panel */}
              <div className="flex-1 p-6 overflow-y-auto">
                {docsTab === 'gravity' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🪐 Gravity, Active Joints & Inertia</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      In the physics solver (powered by MuJoCo), gravity exerts a continuous force vector downward along the Z-axis. However, how components react depends entirely on their <strong>Degrees of Freedom (joints)</strong> and <strong>Inertia</strong>:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🌍 Static Elements (No Joints)</strong>
                        <p className="text-slate-500 mt-1">Shelves, pegs, and support structures have no joints. The solver treats them as having infinite mass welded directly to the world body, so gravity never moves them.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚙️ Hinge Gears (Rotational Hinge Joints)</strong>
                        <p className="text-slate-500 mt-1">Gears are locked to a single pivot point. Because gravity acts straight down through the pivot, it produces zero torque around the rotation axis. Symmetrical shapes also have their center of mass balanced perfectly at the pivot, preventing gravity from inducing rotation.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📦 Unconstrained Bodies (Free Joints)</strong>
                        <p className="text-slate-500 mt-1">A floating box (like the gold cube) has a free joint, allowing full 3D physics simulation to pull it down naturally.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'coupling' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⚙️ Mechanical Joint Coupling vs Collision</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Why does this application use mathematical joint coupling rather than direct tooth-on-tooth rigid collisions?
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">⚡ The Jitter & Penetration Problem</strong>
                        <p className="text-slate-500 mt-1">In discrete time-step simulators, rigid teeth can slightly overlap between steps. Resolving these penetrations produces massive outward impulses, causing gears to lock up, vibrate, or explode.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔗 Mathematical Coupling</strong>
                        <p className="text-slate-500 mt-1">By applying a mathematical joint relationship (bilateral constraint), the system simulates perfectly smooth, 100% stable, and silent transmission of energy at all speeds.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🎯 Dynamic Proximity Engine</strong>
                        <p className="text-slate-500 mt-1">To ensure realistic spatial mechanics, the coupling is proximity-aware! Gears and pinion-racks only couple when they are touching. You can toggle this constraint using the "Allow Mechanical Coupling" checkbox in the sidebar.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'collision' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💥 Collision Physics & Solid vs Ephemeral</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      You can toggle whether components behave as solid, physical obstacles or ephemeral visual guides:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🛑 Solid Mode (Collision Enabled)</strong>
                        <p className="text-slate-500 mt-1">The body participates in the contact solver. It blocks other objects, pushes them, and participates fully in normal physics collisions.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">👻 Ephemeral Mode (Collision Disabled)</strong>
                        <p className="text-slate-500 mt-1">Sets <code>contype="0"</code> and <code>conaffinity="0"</code>. The body becomes completely non-solid. Other items can pass straight through it. Excellent for creating decorative supports or visual-only guides!</p>
                      </div>
                    </div>
                  </div>
                )}

                 {docsTab === 'friction' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🛷 Dynamic Friction Tuning</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Friction coefficients dictate how easily objects slide against each other:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🌍 Floor Friction</strong>
                        <p className="text-slate-500 mt-1">Adjusts the grip of the ground plane. Setting it to 0.0 makes the ground an frictionless ice-sheet. Increased values yield high-traction surfaces.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📦 Component Friction</strong>
                        <p className="text-slate-500 mt-1">Sets the sliding friction coefficient of the selected object. Lower values allow materials to slip easily past support shelves and guide Rails, while high values prevent slipping.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'scripting' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💻 Control Scripting & Joint Names</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Custom JavaScript control scripts run inside the physics solver loop on every physics time-step. To query state or apply forces, you pass string-based <strong>body names</strong> or <strong>joint names</strong> to the API.
                    </p>
                    
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4">
                      <div className="text-xs">
                        <strong className="text-slate-800 font-semibold flex items-center gap-1">🏷️ Where do joint & body names come from?</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          All names map directly to the values you configure in the <strong>Properties Panel</strong> when a component is selected:
                        </p>
                        <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                          <li><strong>Body Names:</strong> Equal to the <strong>Component Name</strong> at the top of the properties panel (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole"</code>).</li>
                          <li><strong>Joint Names:</strong> Configured in the <strong>Joint Name (for API)</strong> text input under the <strong>🔗 Joint Type</strong> card (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole_hinge"</code>).</li>
                          <li><strong>Actuator/Motor Names:</strong> If you select "Enable Motor Drive", the actuator is automatically named by appending <code className="font-mono">_actuator</code> to the joint name (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide_actuator"</code>).</li>
                        </ul>
                      </div>

                       <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">🔄 Retrieving Sensor Data & Key Inputs</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Use the following API methods in your script:
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// 1. Get positions & velocities of components in world space
const [x, y, z] = api.getPosition('cart');
const [vx, vy, vz] = api.getVelocity('cart');

// 2. Get joint-aligned values (highly recommended for controls)
const position = api.getJointPosition('cart_slide'); // Slider: meters, Hinge: radians
const velocity = api.getJointVelocity('cart_slide'); // Slider: m/s, Hinge: rad/s

// 3. Check if keyboard key is active (excluding editor inputs)
const isSpacePressed = api.isKeyPressed('space'); // Supports: 'space', 'w', 'arrowup', etc.`}
                        </pre>
                      </div>
 
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">⚡ Applying Forces & Modifying State</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Apply forces directly, command motors, or override position/velocity state:
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Apply torque or force aligned to the joint
api.applyJointForce('cart_slide', 15.5); // Applies linear force

// Command actuator motor velocity target
api.setActuatorControl('cart_slide_actuator', 1.0); // Drive cart at 1.0 m/s

// Directly set physical state (useful for resets or active launches)
api.setPosition([0, 0, 0.5], 'cart'); // Sets joint positions
api.setVelocity([0, 0, 5.0], 'cart'); // Sets linear velocities
api.setAngularVelocity([0, 15.0, 0], 'cart'); // Sets angular velocities`}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isSaveModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                <Save className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800 text-base">Save Scene Preset</h2>
                <p className="text-xs text-slate-500">Give your scene a name to save it locally</p>
              </div>
            </div>
            <input
              autoFocus
              type="text"
              placeholder="e.g. Double Pendulum Wave"
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSavePreset();
                if (e.key === 'Escape') setIsSaveModalOpen(false);
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setIsSaveModalOpen(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSavePreset}
                disabled={!presetNameInput.trim()}
                className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
