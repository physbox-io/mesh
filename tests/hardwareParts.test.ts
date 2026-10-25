// Bought hardware: bearings, cap screws, nuts and shafts. These check that each
// part is the size its table says, that its meshes are closed and wound
// outward, that it lands in the cut made for it, and that a screw fastens what
// it reaches into — and lets go when it is taken out.

import { describe, it, expect } from 'vitest';
import {
  HARDWARE_PARTS, fasten, hardwarePartNode, isBoughtIn, rebuildPart, releaseFastenings,
  reseatHardware, ringMesh, screwFit, seatFor, seatPart,
} from '../src/utils/hardwareParts';
import { BEARINGS, CAP_SCREW_HEADS, HEX_NUTS, SCREW_LENGTHS } from '../src/utils/hardwareSizes';
import { hardwareCutGeoms, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { compileToMJCF } from '../src/utils/mjcf';
import type { HardwarePartKind, SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/** A block 40 × 40 × `thick` mm, its top face at z = thick/2. */
const block = (id: string, thickMm = 20, pos = [0, 0, 0]): SceneNode => ({
  id, name: id, pos, csgEnabled: true, joints: [], children: [],
  geoms: [{ name: `${id}_b`, type: 'box', size: [0.02, 0.02, thickMm / 2000] } as SceneGeom],
} as SceneNode);

/** What the store's writeHardwareGroup does: the pieces, each placed by cutGeometry in turn. */
function cut(node: SceneNode, over: Partial<HardwareCutSpec>): string {
  const spec: HardwareCutSpec = { group: 'g1', kind: 'bearing', size: '', at: [0, 0, 0.01], normal: [0, 0, 1], ...over };
  for (const piece of hardwareCutGeoms(spec, node.id)) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return spec.group;
}

const meshesOf = (node: SceneNode): SceneGeom[] => {
  const out: SceneGeom[] = [];
  const walk = (n: SceneNode) => { out.push(...n.geoms.filter((g) => g.type === 'mesh')); n.children.forEach(walk); };
  walk(node);
  return out;
};

describe('ringMesh', () => {
  it('is closed and wound outward, round or hex', () => {
    for (const outside of [() => 0.011, (t: number) => 0.004 / Math.cos(((t % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6)]) {
      const m = ringMesh(outside, 0.002, 0.003, 12);
      const a = analyzeMesh(m.renderVertices, m.faces)!;
      expect(a.closed).toBe(true);
      expect(a.consistentlyWound).toBe(true);
      expect(a.volume).toBeGreaterThan(0);
      // And the Y-up copy is the same solid turned, not mirrored.
      expect(analyzeMesh(m.vertices, m.faces)!.volume).toBeCloseTo(a.volume, 12);
    }
  });
});

describe('hardwarePartNode', () => {
  it('builds every size of every part, every mesh closed and outward', () => {
    for (const kind of Object.keys(HARDWARE_PARTS) as HardwarePartKind[]) {
      for (const size of HARDWARE_PARTS[kind].sizes) {
        const node = hardwarePartNode({ kind, size, washer: true }, `p_${kind}_${size}`);
        expect(isBoughtIn(node)).toBe(true);
        for (const g of meshesOf(node)) {
          const a = analyzeMesh(g.renderVertices!, g.faces!)!;
          expect(a.closed && a.consistentlyWound && a.volume > 0, `${kind} ${size} ${g.name}`).toBe(true);
        }
        // Every body that can move has mass to move with.
        expect(node.geoms.some((g) => (g.mass ?? 0) > 0)).toBe(true);
      }
    }
  });

  it('makes a 608 22 mm across and 7 wide, its inner race a body on a hinge along its axis', () => {
    const b = hardwarePartNode({ kind: 'bearing', size: '608' }, 'b');
    const outer = b.geoms[0].renderVertices!;
    let r = 0, zmax = -Infinity;
    for (let i = 0; i < outer.length; i += 3) { r = Math.max(r, Math.hypot(outer[i], outer[i + 1])); zmax = Math.max(zmax, outer[i + 2]); }
    expect(r).toBeCloseTo(BEARINGS['608'][0] / 2000, 6);
    expect(zmax).toBeCloseTo(BEARINGS['608'][2] / 2000, 6);
    const inner = b.children[0];
    expect(inner.hardwarePart?.piece).toBe('inner');
    expect(inner.joints[0]).toMatchObject({ type: 'hinge', axis: [0, 0, 1] });
    let bore = Infinity;
    const iv = inner.geoms[0].renderVertices!;
    for (let i = 0; i < iv.length; i += 3) bore = Math.min(bore, Math.hypot(iv[i], iv[i + 1]));
    expect(bore).toBeCloseTo(0.004, 6);
  });

  it('gives a cap screw its table head over the length under it', () => {
    const s = hardwarePartNode({ kind: 'screw', size: 'M5', lengthMm: 20 }, 's');
    const head = s.geoms.find((g) => g.name === 's_head')!;
    const shank = s.geoms.find((g) => g.name === 's_shank')!;
    expect(head.size![0] * 2000).toBeCloseTo(CAP_SCREW_HEADS.M5[0], 4);
    expect(head.size![1] * 2000).toBeCloseTo(CAP_SCREW_HEADS.M5[1], 4);
    expect(shank.size![1] * 2000).toBeCloseTo(20, 4);
    expect(shank.pos![2]).toBeCloseTo(-0.01, 7);
    expect(s.name).toBe('M5×20 cap screw');
  });

  it('makes a nut a hexagon its table size across the flats', () => {
    const n = hardwarePartNode({ kind: 'nut', size: 'M8' }, 'n');
    const v = n.geoms[0].renderVertices!;
    let flatsX = 0;
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 1]) < 1e-9) flatsX = Math.max(flatsX, v[i]);
    // A corner on +X: across the corners there, flats/cos 30°.
    expect(flatsX * 2000).toBeCloseTo(HEX_NUTS.M8[0] / Math.cos(Math.PI / 6), 3);
  });
});

describe('seatFor', () => {
  it('sits a bearing flush in its pocket', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '625' });
    const seat = seatFor(host, group)!;
    // The top face is at 10 mm; a 625 is 5 wide, so its centre is 2.5 below.
    expect(seat.pos[2]).toBeCloseTo(0.0075, 6);
    expect(seat.part).toMatchObject({ kind: 'bearing', size: '625' });
  });

  it('drops a nut to the floor of its trap', () => {
    const host = block('h');
    const group = cut(host, { kind: 'nut_trap', size: 'M4', fitMm: 0.2 });
    const seat = seatFor(host, group)!;
    // 3.2 + 0.2 deep, a 3.2 mm nut sitting on the floor.
    expect(seat.pos[2]).toBeCloseTo(0.01 - 0.0034 + 0.0016, 6);
  });

  it('bears a screw on the counterbore floor and measures the rest of the part', () => {
    const host = block('h', 20);
    const group = cut(host, { kind: 'counterbore', size: 'M3' });
    const seat = seatFor(host, group, 'screw')!;
    expect(seat.pos[2]).toBeCloseTo(0.01 - 0.0034, 6);
    expect(seat.gripM!).toBeCloseTo(0.02 - 0.0034, 5);
  });

  it('offers nothing a cut cannot hold', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '608' });
    expect(seatFor(host, group, 'screw')).toBeNull();
    expect(seatFor(host, 'nope')).toBeNull();
  });

  it('works in the compiled frame, so the part moves with the centroid', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '608' });
    host.csgCentroid = [0.003, -0.002, 0];
    const seat = seatFor(host, group)!;
    expect(seat.pos[0]).toBeCloseTo(-0.003, 7);
    expect(seat.pos[1]).toBeCloseTo(0.002, 7);
  });
});

describe('seatPart and reseatHardware', () => {
  it('makes a seated part rigid to its host and silent to the contact solver', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '608' });
    const part = hardwarePartNode({ kind: 'bearing', size: '625' }, 'b');
    host.children.push(part);
    expect(seatPart(part, host, group)).toBe(true);
    // The cut's size wins: it is a 608 pocket.
    expect(part.hardwarePart).toMatchObject({ size: '608', seat: group });
    expect(part.joints).toEqual([]);
    for (const body of [part, part.children[0]]) {
      for (const g of body.geoms.filter((g) => g.role !== 'visual')) expect([g.contype, g.conaffinity]).toEqual([0, 0]);
    }
    // The inner race keeps its hinge.
    expect(part.children[0].joints[0].type).toBe('hinge');
  });

  it('follows its cut when the cut is moved', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '608' });
    const part = hardwarePartNode({ kind: 'bearing', size: '608' }, 'b');
    host.children.push(part);
    seatPart(part, host, group);
    host.geoms = host.geoms.filter((g) => !g.hardware);
    cut(host, { kind: 'bearing', size: '608', at: [0.008, 0, 0.01] });
    reseatHardware(host);
    expect(part.pos[0]).toBeCloseTo(0.008, 6);
  });

  it('keeps what is fixed to an inner race through a size change', () => {
    const part = hardwarePartNode({ kind: 'bearing', size: '608' }, 'b');
    const wheel = { id: 'w', name: 'w', pos: [0, 0, 0], geoms: [], joints: [], children: [] } as SceneNode;
    part.children[0].children.push(wheel);
    rebuildPart(part, { kind: 'bearing', size: '6001' });
    expect(part.children[0].children).toContain(wheel);
    expect(part.name).toBe('6001 bearing');
  });
});

describe('fastening', () => {
  /** A 10 mm plate on top of a 20 mm one, the lower one with a plain M3 clearance hole through it. */
  const stack = () => {
    const top = block('top', 10, [0, 0, 0.015]);
    const group = cut(top, { kind: 'counterbore', size: 'M3', at: [0, 0, 0.005] });
    const base = block('base', 20, [0, 0, 0]);
    base.joints = [{ name: 'base_free', type: 'free' }];
    const hole = { name: 'base_hole', type: 'cylinder', size: [0.0016, 0], csg: 'difference', cutAt: [0, 0, 0.01], cutNormal: [0, 0, 1], cutDepth: 0 } as SceneGeom;
    base.geoms.push(hole);
    Object.assign(hole, cutGeometry(base, hole));
    const screw = hardwarePartNode({ kind: 'screw', size: 'M3' }, 's');
    top.children.push(screw);
    seatPart(screw, top, group);
    const scene = { nodes: [top, base] } as SceneGraph;
    return { scene, top, base, screw, grip: seatFor(top, group, 'screw')!.gripM! };
  };

  it('finds the hole below, sizes the screw into it and welds the two plates', () => {
    const { scene, top, base, screw, grip } = stack();
    const fit = screwFit(scene, top, screw, grip);
    expect(fit.target?.id).toBe('base');
    // 6.6 mm of grip left under a 3.4 mm counterbore, plus 2.5 × 3 mm into the base.
    expect(fit.lengthMm).toBe(Math.max(...SCREW_LENGTHS.filter((l) => l <= 6.6 + 7.5 + 1e-6)));
    expect(fasten(screw, top, base)).toBe(true);
    expect(base.weldTargetId).toBe('top');
    expect(screw.hardwarePart?.fastens).toBe('base');
  });

  it('reaches into nothing past its grip when there is nothing below', () => {
    const { scene, top, screw, grip } = stack();
    scene.nodes = [top];
    const fit = screwFit(scene, top, screw, grip);
    expect(fit.target).toBeNull();
    expect(fit.lengthMm).toBe(10); // 6.6 + 4.5 = 11.1, sold as 10
  });

  it('will not overwrite a weld it did not make', () => {
    const { top, base, screw } = stack();
    base.weldTargetId = 'elsewhere';
    expect(fasten(screw, top, base)).toBe(false);
    expect(base.weldTargetId).toBe('elsewhere');
  });

  it('takes its weld away with it, unless another screw still holds', () => {
    const { scene, top, base, screw } = stack();
    fasten(screw, top, base);
    const second = hardwarePartNode({ kind: 'screw', size: 'M3' }, 's2');
    top.children.push(second);
    fasten(second, top, base);
    releaseFastenings(scene, new Set(['s']));
    expect(base.weldTargetId).toBe('top');
    releaseFastenings(scene, new Set(['s', 's2']));
    expect(base.weldTargetId).toBeUndefined();
  });
});

describe('in the model', () => {
  it('compiles a seated bearing to a hinge on its axis with its contacts off', () => {
    const host = block('h');
    const group = cut(host, { kind: 'bearing', size: '608' });
    const part = hardwarePartNode({ kind: 'bearing', size: '608' }, 'b');
    host.children.push(part);
    seatPart(part, host, group);
    const xml = compileToMJCF({ nodes: [host] } as SceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<joint[^>]*name="b_spin"[^>]*type="hinge"/);
    expect(xml).toMatch(/name="b_outer"[^>]*contype="0"/);
  });
});
