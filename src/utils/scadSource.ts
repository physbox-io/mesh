import type { SceneNode } from '../types/scene';

export function generateScadForNode(node: SceneNode): string {
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
      const fromtoHalf = geom.fromto && geom.fromto.length >= 6
        ? Math.hypot(geom.fromto[3] - geom.fromto[0], geom.fromto[4] - geom.fromto[1], geom.fromto[5] - geom.fromto[2]) / 2
        : undefined;
      const h = (geom.size?.[1] ?? fromtoHalf ?? 0.1) * 2;
      return `// Cylinder shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:3.0]\ncylinder(h=height, r=radius, center=true, $fn=24);`;
    }
    case 'capsule': {
      const r = geom.size?.[0] || 0.04;
      const fromtoHalf = geom.fromto && geom.fromto.length >= 6
        ? Math.hypot(geom.fromto[3] - geom.fromto[0], geom.fromto[4] - geom.fromto[1], geom.fromto[5] - geom.fromto[2]) / 2
        : undefined;
      const h = geom.size?.[1] ?? fromtoHalf ?? 0.2;
      return `// Capsule shape\nradius = ${r.toFixed(3)}; // [0.01:0.01:1.0]\nheight = ${h.toFixed(3)}; // [0.05:0.05:2.0]\nhull() {\n  translate([0, 0, -height]) sphere(r=radius, $fn=16);\n  translate([0, 0, height]) sphere(r=radius, $fn=16);\n}`;
    }
    case 'mesh': {
      return `// Mesh geometry representation\n// Note: editing this will overwrite the manual vertices\ncube([0.5, 0.5, 0.5], center=true);`;
    }
    default:
      return `// Primitive shape (${geom.type})\ncube([0.4, 0.4, 0.4], center=true);`;
  }
}

export interface ScadVariable {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  lineIndex: number;
}

const NUM_PATTERN = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const SCAD_VAR_REGEX = new RegExp(
  `^\\s*(\\$?[a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*(${NUM_PATTERN})\\s*;\\s*(?:\\/\\/\\s*\\[\\s*(${NUM_PATTERN})(?::(${NUM_PATTERN}))?:\\s*(${NUM_PATTERN})\\s*\\])?`,
);

interface ScannedLine {
  lineIndex: number;
  line: string;
  /** Line with block comments blanked out so commented-out assignments are never matched, while preserving `//` Customizer comments. */
  uncommented: string;
  braceDepthAtStart: number;
}

/**
 * Scans OpenSCAD lines while tracking `{` / `}` depth outside `//` line comments,
 * `/* ... *\/` block comments, and `"..."` string literals.
 */
function scanScadLines(code: string): ScannedLine[] {
  const lines = code.split('\n');
  const out: ScannedLine[] = [];
  let braceDepth = 0;
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const braceDepthAtStart = braceDepth;
    let uncommented = '';
    let i = 0;

    while (i < line.length) {
      if (inBlockComment) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          uncommented += '  ';
          i += 2;
        } else {
          uncommented += ' ';
          i++;
        }
        continue;
      }

      const ch = line[i];
      const next = line[i + 1];
      if (ch === '/' && next === '/') {
        // Keep trailing `// [min:step:max]` for Customizer parsing, without counting braces inside it.
        uncommented += line.slice(i);
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        uncommented += '  ';
        i += 2;
        continue;
      }
      if (ch === '"') {
        uncommented += ch;
        i++;
        while (i < line.length) {
          uncommented += line[i];
          if (line[i] === '\\' && i + 1 < line.length) {
            uncommented += line[i + 1];
            i += 2;
            continue;
          }
          if (line[i] === '"') {
            i++;
            break;
          }
          i++;
        }
        continue;
      }

      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      uncommented += ch;
      i++;
    }

    out.push({ lineIndex, line, uncommented, braceDepthAtStart });
  }

  return out;
}

export function parseScadVariables(code: string): ScadVariable[] {
  const variables: ScadVariable[] = [];
  if (!code) return variables;
  const indexByName = new Map<string, number>();

  for (const { lineIndex, uncommented, braceDepthAtStart } of scanScadLines(code)) {
    if (braceDepthAtStart !== 0) continue;
    const match = uncommented.match(SCAD_VAR_REGEX);
    if (!match) continue;

    const name = match[1];
    const value = parseFloat(match[2]);
    if (!Number.isFinite(value)) continue;

    // An OpenSCAD Customizer comment, `// [min:step:max]` or `// [min:max]`,
    // is the slider: its bounds and its step. The step alone used to be
    // taken and put inside a ±20% window round the value, so
    // `sx = 0.1; // [0.1:0.05:3.0]` got a 0.08-0.12 slider whose only
    // reachable value was 0.08 and which could not be moved.
    const declared = match[3] !== undefined && match[5] !== undefined;
    let min: number;
    let max: number;
    let step: number | undefined;
    if (declared) {
      const lo = parseFloat(match[3]);
      const hi = parseFloat(match[5]);
      // A value written outside its own range still gets a slider that shows it.
      min = Math.min(lo, hi, value);
      max = Math.max(lo, hi, value);
      step = match[4] !== undefined ? Math.abs(parseFloat(match[4])) : undefined;
      // `[3:12]` with an integer value is a count, as it is in the Customizer.
      if (step === undefined && [lo, hi, value].every(Number.isInteger)) step = 1;
    } else {
      min = value === 0 ? -0.2 : value - Math.abs(value) * 0.2;
      max = value === 0 ? 0.2 : value + Math.abs(value) * 0.2;
    }
    if (!step || step > max - min) {
      step = parseFloat(((max - min) / 100).toPrecision(2));
    }

    const entry: ScadVariable = {
      name,
      value,
      min,
      max,
      step: step || 0.01,
      lineIndex,
    };

    // In OpenSCAD, the last top-level assignment to a variable wins; keep one
    // entry per name so React keys stay unique and sliders show the active value.
    const existingIdx = indexByName.get(name);
    if (existingIdx !== undefined) {
      variables[existingIdx] = entry;
    } else {
      indexByName.set(name, variables.length);
      variables.push(entry);
    }
  }

  return variables;
}

export function replaceVarInCode(code: string, varName: string, newValue: number): string {
  if (!Number.isFinite(newValue)) return code;
  const lines = code.split('\n');
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchRegex = new RegExp(`^(\\s*${escaped}\\s*=\\s*)${NUM_PATTERN}(?=\\s*;)`);
  let targetLine = -1;

  for (const { lineIndex, uncommented, braceDepthAtStart } of scanScadLines(code)) {
    if (braceDepthAtStart === 0 && matchRegex.test(uncommented)) {
      targetLine = lineIndex;
    }
  }

  if (targetLine !== -1) {
    // Find the `=` outside leading block comments on that line and replace the literal value.
    const prefixAndNum = new RegExp(`^([\\s\\S]*?\\b${escaped}\\s*=\\s*)${NUM_PATTERN}(?=\\s*;)`);
    const dollarSafe = new RegExp(`^([\\s\\S]*?(?:^|[^a-zA-Z0-9_\\$])${escaped}\\s*=\\s*)${NUM_PATTERN}(?=\\s*;)`);
    const re = varName.startsWith('$') ? dollarSafe : prefixAndNum;
    lines[targetLine] = lines[targetLine].replace(re, (_, p1: string) => `${p1}${newValue}`);
  }

  return lines.join('\n');
}
