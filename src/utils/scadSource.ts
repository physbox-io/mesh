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

export interface ScadVariable {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  lineIndex: number;
}

export function parseScadVariables(code: string): ScadVariable[] {
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

export function replaceVarInCode(code: string, varName: string, newValue: number): string {
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
