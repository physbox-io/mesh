import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// AxisLegendDrawer — lives inside the R3F Canvas, reads camera every frame and draws
// MuJoCo XYZ axes onto an external HTML canvas element passed via ref.
// MuJoCo coord system: X=right (red), Y=into screen (green), Z=up (blue)
// Three.js Y-up mapping: mujoco(x,y,z) → three(x, z, -y)
export const AxisLegendDrawer = ({ externalRef }: { externalRef: RefObject<HTMLCanvasElement | null> }) => {
  const { camera } = useThree();
  // The legend depends on nothing but the camera's orientation, so a frame
  // where that has not turned (every frame of a simulation watched from a
  // still camera) leaves the drawing as it is.
  const drawn = useRef<{ el: HTMLCanvasElement; quaternion: THREE.Quaternion; width: number; height: number } | null>(null);

  useFrame(() => {
    const el = externalRef.current;
    if (!el) return;
    const last = drawn.current;
    if (last && last.el === el && last.width === el.width && last.height === el.height && last.quaternion.equals(camera.quaternion)) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    drawn.current = { el, quaternion: camera.quaternion.clone(), width: el.width, height: el.height };

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
