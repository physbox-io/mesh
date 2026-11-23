import { useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const LEGEND_AXES = [
  { dx: 1, dy: 0, dz: 0, color: '#ef4444', label: 'X', shadow: '#7f1d1d' },
  { dx: 0, dy: 1, dz: 0, color: '#22c55e', label: 'Y', shadow: '#14532d' },
  { dx: 0, dy: 0, dz: 1, color: '#3b82f6', label: 'Z', shadow: '#1e3a8a' },
] as const;

interface ProjectedAxis {
  color: string;
  label: string;
  shadow: string;
  px: number;
  py: number;
  depth: number;
}

// AxisLegendDrawer — lives inside the R3F Canvas, reads camera every frame and draws
// MuJoCo XYZ axes onto an external HTML canvas element passed via ref.
// MuJoCo coord system: X=right (red), Y=into screen (green), Z=up (blue)
// Three.js Y-up mapping: mujoco(x,y,z) → three(x, z, -y)
export const AxisLegendDrawer = ({ externalRef }: { externalRef: RefObject<HTMLCanvasElement | null> }) => {
  // The legend depends on nothing but the camera's orientation, so a frame
  // where that has not turned (every frame of a simulation watched from a
  // still camera) leaves the drawing as it is.
  const drawn = useRef<{ el: HTMLCanvasElement | null; quaternion: THREE.Quaternion; width: number; height: number; valid: boolean }>({
    el: null,
    quaternion: new THREE.Quaternion(),
    width: 0,
    height: 0,
    valid: false,
  });
  const tmpDir = useRef(new THREE.Vector3());
  const projectedRef = useRef<ProjectedAxis[]>([
    { color: LEGEND_AXES[0].color, label: LEGEND_AXES[0].label, shadow: LEGEND_AXES[0].shadow, px: 0, py: 0, depth: 0 },
    { color: LEGEND_AXES[1].color, label: LEGEND_AXES[1].label, shadow: LEGEND_AXES[1].shadow, px: 0, py: 0, depth: 0 },
    { color: LEGEND_AXES[2].color, label: LEGEND_AXES[2].label, shadow: LEGEND_AXES[2].shadow, px: 0, py: 0, depth: 0 },
  ]);

  useFrame(({ camera }) => {
    const el = externalRef.current;
    if (!el) return;
    const last = drawn.current;
    if (last.valid && last.el === el && last.width === el.width && last.height === el.height && last.quaternion.equals(camera.quaternion)) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    last.el = el;
    last.quaternion.copy(camera.quaternion);
    last.width = el.width;
    last.height = el.height;
    last.valid = true;

    const W = el.width;
    const H = el.height;
    const cx = W / 2;
    const cy = H / 2 + 6; // shift down to give Z arrow more headroom at top
    const len = W * 0.36;

    ctx.clearRect(0, 0, W, H);

    // Compute projections into preallocated scratch structs and sort back-to-front
    const dir = tmpDir.current;
    const projected = projectedRef.current;
    for (let i = 0; i < 3; i++) {
      const a = LEGEND_AXES[i];
      // MuJoCo(x,y,z) → Three.js world direction: three(x, z, -y)
      dir.set(a.dx, a.dz, -a.dy).transformDirection(camera.matrixWorldInverse);
      const slot = projected[i];
      slot.color = a.color;
      slot.label = a.label;
      slot.shadow = a.shadow;
      slot.px = dir.x * len;
      slot.py = -dir.y * len;
      slot.depth = dir.z;
    }
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
