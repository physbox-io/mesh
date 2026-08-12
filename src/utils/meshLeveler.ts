/**
 * Auto Grid Mesh Leveling Engine
 *
 * Provides bilinear heightmap interpolation and dynamic G-code trajectory
 * warping to compensate for warped material or bed tilt during CNC routing,
 * relief carving, and PCB milling.
 */

export interface ProbePoint {
  x: number;
  y: number;
  z: number; // Measured Z offset (mm) relative to reference Z0
}

export interface ProbeGrid {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  gridX: number; // Number of sample points along X axis (>= 2)
  gridY: number; // Number of sample points along Y axis (>= 2)
  /** 2D array of probed points: points[row_y][col_x] */
  points: ProbePoint[][];
}

export interface GridStats {
  minZ: number;
  maxZ: number;
  spanZ: number;
  avgZ: number;
}

/**
 * Creates an initial unprobed grid spanning the given bounds with zeroed Z offsets.
 */
export function createEmptyGrid(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  gridX: number = 3,
  gridY: number = 3
): ProbeGrid {
  const gx = Math.max(2, Math.round(gridX));
  const gy = Math.max(2, Math.round(gridY));

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  const stepX = gx > 1 ? width / (gx - 1) : 0;
  const stepY = gy > 1 ? height / (gy - 1) : 0;

  const points: ProbePoint[][] = [];

  for (let row = 0; row < gy; row++) {
    const rowPoints: ProbePoint[] = [];
    const y = bounds.minY + row * stepY;

    for (let col = 0; col < gx; col++) {
      const x = bounds.minX + col * stepX;
      rowPoints.push({ x, y, z: 0 });
    }
    points.push(rowPoints);
  }

  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    gridX: gx,
    gridY: gy,
    points,
  };
}

/**
 * Computes min, max, span, and average Z values across the grid.
 */
export function getGridStats(grid: ProbeGrid): GridStats {
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumZ = 0;
  let count = 0;

  for (let r = 0; r < grid.gridY; r++) {
    for (let c = 0; c < grid.gridX; c++) {
      const z = grid.points[r][c].z;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      sumZ += z;
      count++;
    }
  }

  if (count === 0) {
    return { minZ: 0, maxZ: 0, spanZ: 0, avgZ: 0 };
  }

  return {
    minZ,
    maxZ,
    spanZ: maxZ - minZ,
    avgZ: sumZ / count,
  };
}

/**
 * Evaluates bilinear heightmap Z-offset at coordinates (x, y).
 * Clamps to grid boundaries if (x,y) lies outside grid bounds.
 */
export function interpolateGridZ(grid: ProbeGrid, x: number, y: number): number {
  if (!grid || !grid.points || grid.gridX < 2 || grid.gridY < 2) return 0;

  // Clamp coordinates to grid bounds
  const clampedX = Math.max(grid.minX, Math.min(grid.maxX, x));
  const clampedY = Math.max(grid.minY, Math.min(grid.maxY, y));

  const width = grid.maxX - grid.minX;
  const height = grid.maxY - grid.minY;

  if (width <= 1e-6 || height <= 1e-6) {
    return grid.points[0][0].z;
  }

  // Normalized coordinates in grid index space [0, gridX - 1]
  const normX = ((clampedX - grid.minX) / width) * (grid.gridX - 1);
  const normY = ((clampedY - grid.minY) / height) * (grid.gridY - 1);

  const col0 = Math.min(Math.floor(normX), grid.gridX - 2);
  const row0 = Math.min(Math.floor(normY), grid.gridY - 2);

  const col1 = col0 + 1;
  const row1 = row0 + 1;

  const tx = normX - col0;
  const ty = normY - row0;

  const z00 = grid.points[row0][col0].z;
  const z10 = grid.points[row0][col1].z;
  const z01 = grid.points[row1][col0].z;
  const z11 = grid.points[row1][col1].z;

  // Bilinear interpolation
  const top = z00 * (1 - tx) + z10 * tx;
  const bottom = z01 * (1 - tx) + z11 * tx;

  return top * (1 - ty) + bottom * ty;
}

/**
 * Formats a coordinate number to 3 decimal places.
 */
function f(num: number): string {
  return num.toFixed(3);
}

/**
 * Warps G-code string by subdividing linear moves and applying
 * heightmap compensation (Z_actual = Z_commanded + Z_offset(x,y)).
 */
export function warpGcode(
  gcode: string,
  grid: ProbeGrid,
  maxSegmentLenMm = 1.0
): string {
  if (!gcode || !grid) return gcode;

  const lines = gcode.split('\n');
  const result: string[] = [];

  let curX = 0;
  let curY = 0;
  let curZ = 0;
  let absoluteMode = true;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const trimmed = rawLine.trim();

    // Preserve comments and blank lines
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) {
      result.push(rawLine);
      continue;
    }

    // Check positioning mode
    if (trimmed.includes('G90')) absoluteMode = true;
    if (trimmed.includes('G91')) absoluteMode = false;

    // Parse motion command
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toUpperCase();

    // We only warp absolute cutting motions (G1, G0).
    if (absoluteMode && (cmd === 'G0' || cmd === 'G1')) {
      let targetX = curX;
      let targetY = curY;
      let targetZ = curZ;
      let hasX = false;
      let hasY = false;
      let hasZ = false;
      let feedrateStr = '';

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p.startsWith('X') || p.startsWith('x')) {
          targetX = parseFloat(p.slice(1));
          hasX = true;
        } else if (p.startsWith('Y') || p.startsWith('y')) {
          targetY = parseFloat(p.slice(1));
          hasY = true;
        } else if (p.startsWith('Z') || p.startsWith('z')) {
          targetZ = parseFloat(p.slice(1));
          hasZ = true;
        } else if (p.startsWith('F') || p.startsWith('f')) {
          feedrateStr = ` ${p}`;
        }
      }

      const distXY = Math.hypot(targetX - curX, targetY - curY);

      // Subdivide cutting moves (G1) when traveling across the bed
      if (cmd === 'G1' && distXY > maxSegmentLenMm && (hasX || hasY)) {
        const steps = Math.ceil(distXY / maxSegmentLenMm);

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const px = curX + (targetX - curX) * t;
          const py = curY + (targetY - curY) * t;
          const pzNominal = curZ + (targetZ - curZ) * t;

          const zOffset = interpolateGridZ(grid, px, py);
          const pzWarped = pzNominal + zOffset;

          const fParam = s === 1 ? feedrateStr : '';
          result.push(`G1 X${f(px)} Y${f(py)} Z${f(pzWarped)}${fParam}`);
        }
      } else {
        // Single move or G0 rapid move
        const zOffset = interpolateGridZ(grid, targetX, targetY);
        const warpedZ = targetZ + zOffset;

        let newLine = cmd;
        if (hasX) newLine += ` X${f(targetX)}`;
        if (hasY) newLine += ` Y${f(targetY)}`;
        if (hasZ || hasX || hasY) newLine += ` Z${f(warpedZ)}`;
        newLine += feedrateStr;

        result.push(newLine);
      }

      curX = targetX;
      curY = targetY;
      curZ = targetZ;
    } else {
      result.push(rawLine);
    }
  }

  return result.join('\n');
}
