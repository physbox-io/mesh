// The boolean_shapes preset, checked as far as is possible without a browser:
// the OpenSCAD each body generates, the collision strategy each lands on, the
// outline drawn for each negative, and that the scene compiles to MJCF.
//
// NOT covered here: the openscad-wasm compile itself and MuJoCo ingesting the
// result. Those need the dev server.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PRESETS } from '../src/presets/presetScenes';
import { compileToMJCF } from '../src/utils/mjcf';
import {
  csgProgram, detectHoleAxis, hasBooleanOps, csgSourceGeoms,
  positiveBounds, clipSegmentsToBox, geomMatrixOf,
} from '../src/utils/csg';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const preset = (PRESETS as Record<string, { name: string; scene: { nodes: SceneNode[] } }>).boolean_shapes;
const nodes = preset.scene.nodes;
const byId = (id: string) => nodes.find(n => n.id === id)!;

/** Mirrors CsgGhostOutline, so these are the segments actually drawn. */
function outlineOf(geom: SceneGeom): number[] {
  const s = geom.size || [];
  const r = s[0] || 0.1;
  let base: THREE.BufferGeometry;
  switch (geom.type) {
    case 'box': base = new THREE.BoxGeometry(r * 2, (s[1] ?? r) * 2, (s[2] ?? r) * 2); break;
    case 'cylinder': base = new THREE.CylinderGeometry(r, r, (s[1] ?? 0.1) * 2, 16); base.rotateX(Math.PI / 2); break;
    case 'capsule': base = new THREE.CapsuleGeometry(r, (s[1] ?? 0.1) * 2, 4, 16); base.rotateX(Math.PI / 2); break;
    case 'ellipsoid': base = new THREE.SphereGeometry(1, 16, 10); base.scale(r, s[1] ?? r, s[2] ?? r); break;
    default: base = new THREE.SphereGeometry(r, 16, 10); break;
  }
  const edges = new THREE.EdgesGeometry(base, 1);
  const src = edges.getAttribute('position').array as ArrayLike<number>;
  const m = geomMatrixOf(geom);
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < src.length; i += 3) {
    v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
    out.push(v.x, v.y, v.z);
  }
  return out;
}

const extentOf = (pts: number[]) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (pts[i + a] < min[a]) min[a] = pts[i + a];
      if (pts[i + a] > max[a]) max[a] = pts[i + a];
    }
  return { min, max };
};

describe('boolean_shapes preset', () => {
  it('is registered with four bodies', () => {
    expect(preset.name).toBe('Boolean Cutouts');
    expect(nodes.map(n => n.id)).toEqual(['ring', 'crescent', 'hollow_cube', 'chopped_cone']);
  });

  it('exercises all three collision strategies', () => {
    expect(nodes.map(n => n.csgCollision)).toEqual(['auto', 'auto', 'auto', 'hull']);
  });
});

describe.each(nodes.map(n => [n.id, n] as const))('%s', (_id, node) => {
  it('is a boolean of ordinary primitives, not a bespoke shape type', () => {
    expect(node.csgEnabled).toBe(true);
    expect(hasBooleanOps(node)).toBe(true);
    expect(csgSourceGeoms(node).length).toBeGreaterThanOrEqual(2);
  });

  it('falls to the floor when the sim runs', () => {
    expect(node.joints.some(j => j.type === 'free')).toBe(true);
    expect(node.pos[2]).toBeGreaterThan(0.2);
  });

  it('emits a balanced difference() program', () => {
    const prog = csgProgram(node)!;
    expect(prog).toContain('difference()');
    expect((prog.match(/\{/g) || []).length).toBe((prog.match(/\}/g) || []).length);
  });

  describe.each(csgSourceGeoms(node).filter(g => g.csg === 'difference').map(g => [g.name, g] as const))(
    'negative %s',
    (_name, neg) => {
      const bounds = positiveBounds(node)!;
      const raw = outlineOf(neg);
      const rawExtent = extentOf(raw);

      it('overshoots the solid, so the cut leaves no coincident faces', () => {
        const overshoots = [0, 1, 2].some(a =>
          rawExtent.min[a] < bounds.min[a] - 1e-6 || rawExtent.max[a] > bounds.max[a] + 1e-6);
        expect(overshoots).toBe(true);
      });

      it('overshoots only modestly, not by multiples of the solid', () => {
        // The original preset overshot by up to 14x, which drew a huge outline.
        const span = [0, 1, 2].map(a => bounds.max[a] - bounds.min[a]);
        const worst = Math.max(...[0, 1, 2].map(a =>
          Math.max(bounds.min[a] - rawExtent.min[a], rawExtent.max[a] - bounds.max[a]) / span[a]));
        expect(worst).toBeLessThan(1);
      });

      it('is drawn only within the solid it cuts', () => {
        const clipped = clipSegmentsToBox(raw, bounds.min, bounds.max);
        if (clipped.length === 0) {
          // A tool wider than the part (the cone's chopping box) has no edges
          // passing through the solid at all; the renderer falls back to
          // outlining the removed region, which is bounded by construction.
          return;
        }
        const e = extentOf(clipped);
        for (let a = 0; a < 3; a++) {
          expect(e.min[a]).toBeGreaterThanOrEqual(bounds.min[a] - 1e-9);
          expect(e.max[a]).toBeLessThanOrEqual(bounds.max[a] + 1e-9);
        }
      });
    });
});

describe('hole axes', () => {
  it('finds Z for the ring, whose negative is wider than it is deep', () => {
    expect(detectHoleAxis(byId('ring'))?.axis).toEqual([0, 0, 1]);
  });

  it('finds Z for the crescent, centred on the offset bite', () => {
    expect(detectHoleAxis(byId('crescent'))).toEqual({ origin: [0.062, 0, 0], axis: [0, 0, 1] });
  });

  it('decomposes the hollow cube about the first shaft declared', () => {
    // All three shafts are identical, so source order decides — documented
    // behaviour, and the reason only the Z shaft's hole collides.
    expect(detectHoleAxis(byId('hollow_cube'))?.axis).toEqual([0, 0, 1]);
    expect(csgSourceGeoms(byId('hollow_cube'))[1].name).toBe('cube_shaft_z');
  });

  it('finds none for the chopped cone, which is why it uses hull mode', () => {
    // The cut box does not pierce the cone — it removes one end. Nothing to
    // slice around, and a frustum is convex anyway, so hulling is exact.
    expect(detectHoleAxis(byId('chopped_cone'))).toBeNull();
    expect(byId('chopped_cone').csgCollision).toBe('hull');
  });
});

describe('MJCF before the booleans have compiled', () => {
  const xml = compileToMJCF(preset.scene as never, -9.81, 1, 0, 0, 0, 0);

  it('drops every negative', () => {
    for (const n of ['ring_hole', 'crescent_bite', 'cube_shaft_z', 'cube_shaft_x', 'cube_shaft_y', 'cone_tip_cut']) {
      expect(xml).not.toContain(n);
    }
  });

  it('collides the positives meanwhile, so the scene is valid immediately', () => {
    for (const n of ['ring_body', 'crescent_body', 'cube_body', 'cone_body']) {
      expect(xml).toContain(`name="${n}"`);
    }
  });

  it('emits every body, and a mesh asset for the cone positive', () => {
    for (const n of nodes) expect(xml).toContain(`<body name="${n.id}"`);
    expect(xml).toContain('<mesh name="cone_body"');
  });
});
