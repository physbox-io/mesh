import { useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

export interface StudioBackdropProps {
  darkMode: boolean;
}

export interface CycloramaPalette {
  top: string;
  horizon: string;
  bottom: string;
  spotCenter: string;
  spotInner: string;
  spotEdge: string;
  spotCorner: string;
}

export function getCycloramaPalette(darkMode: boolean): CycloramaPalette {
  if (darkMode) {
    return {
      top: '#070b14',
      horizon: '#111b2e',
      bottom: '#060911',
      spotCenter: '#213252',
      spotInner: '#152038',
      spotEdge: '#090e1a',
      spotCorner: '#03060c',
    };
  }

  return {
    top: '#eaeff6',
    horizon: '#fafbfd',
    bottom: '#e4ebf4',
    spotCenter: '#fffdfa',
    spotInner: '#f8fafd',
    spotEdge: '#e8eef6',
    spotCorner: '#d8e2ef',
  };
}

function buildCycloramaTexture(darkMode: boolean): THREE.Texture | THREE.Color {
  const palette = getCycloramaPalette(darkMode);
  if (typeof document === 'undefined') {
    return new THREE.Color(palette.spotInner);
  }
  const canvas = document.createElement('canvas');
  const size = 512;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.Color(palette.spotInner);
  }

  // 1. Vertical studio cyclorama sweep: deeper at the top ceiling & bottom lip,
  // brighter across the bench horizon curve.
  const linear = ctx.createLinearGradient(0, 0, 0, size);
  linear.addColorStop(0, palette.top);
  linear.addColorStop(0.46, palette.horizon);
  linear.addColorStop(1, palette.bottom);
  ctx.fillStyle = linear;
  ctx.fillRect(0, 0, size, size);

  // 2. Radial photo-booth spotlight centered where the 3D part sits on the bench.
  // Note: distance from center to viewport top/bottom/side edges is 0.46–0.54 * size,
  // and to corners is ~0.72 * size, so stops are placed so the edge deepening is
  // clearly visible around the perimeter while the center stays warm and bright.
  const cx = size * 0.5;
  const cy = size * 0.46;
  const radial = ctx.createRadialGradient(cx, cy, size * 0.02, cx, cy, size * 0.72);
  radial.addColorStop(0, palette.spotCenter);
  radial.addColorStop(0.32, palette.spotInner);
  radial.addColorStop(0.68, palette.spotEdge);
  radial.addColorStop(1, palette.spotCorner);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Studio cyclorama backdrop for the 3D viewport.
 *
 * Replaces the flat single-hex canvas clear with a soft radial studio gradient
 * (warm ivory center to cool-slate edge vignette in light mode; luminous
 * slate-navy center to deep obsidian edges in dark mode). Because this attaches
 * to `scene.background`, Three.js draws it at depth 1.0 before any geometry, so
 * floor shadows, the infinite grid, N8AO, and BodyToneMapping composite over it
 * naturally — and MCP viewport screenshots capture it too.
 */
export function StudioBackdrop({ darkMode }: StudioBackdropProps) {
  const invalidate = useThree((s) => s.invalidate);

  const background = useMemo(
    () => buildCycloramaTexture(darkMode),
    [darkMode],
  );

  useLayoutEffect(() => {
    invalidate();
    return () => {
      if (background instanceof THREE.Texture) {
        background.dispose();
      }
    };
  }, [background, invalidate]);

  return <primitive object={background} attach="background" />;
}
