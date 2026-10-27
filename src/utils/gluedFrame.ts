// A frame of rod too thin for fittings, as the physics should see it: every
// strut a free body that breaks under load like what it is made of, and a
// blob of whatever such rod is joined with at every joint — putty for pasta,
// wood glue for dowel. It stands, or not, on its joints, exactly as the real
// thing would. See utils/breakModel.ts for how the blobs hold.
//
// PURE. Millimetres in, a scene's metres out.

import type { SceneNode } from '../types/scene';
import { deformMaterial } from './deformMaterials';
import { joinMaterial, type JoinMaterialId } from './joinMaterials';
import type { PipeStandardSpec } from './tubeAndWireExporter';

type V3 = [number, number, number];

/** What each stock material is, as a Deformation material, and what it is joined with. */
const GLUED_STOCK: Record<PipeStandardSpec['material'], { material: string; join: JoinMaterialId; blobPerOd: number }> = {
  pasta: { material: 'pasta', join: 'putty', blobPerOd: 2.8 },
  wood: { material: 'hardwood', join: 'pva', blobPerOd: 1.5 },
  aluminium: { material: 'softMetal', join: 'epoxy', blobPerOd: 1.5 },
  pvc: { material: 'plastic', join: 'epoxy', blobPerOd: 1.5 },
  emt: { material: 'steel', join: 'epoxy', blobPerOd: 1.5 },
};

/**
 * The struts made free and breakable, and a blob at every joint they meet
 * at. A frame that would start with its lowest blobs in the floor is lifted
 * clear of it.
 */
export function gluedFrame(struts: SceneNode[], spec: PipeStandardSpec, joints: V3[], idPrefix: string): SceneNode[] {
  const stock = GLUED_STOCK[spec.material];
  const m = deformMaterial(stock.material)!;
  const join = joinMaterial(stock.join)!;
  const r = Math.max(3, spec.odMm * stock.blobPerOd) / 1000;
  const lowest = Math.min(...joints.map((p) => p[2] / 1000));
  const lift = lowest < r ? r - lowest : 0;
  const up = (n: SceneNode): SceneNode => (lift ? { ...n, pos: [n.pos[0], n.pos[1], n.pos[2] + lift] } : n);
  const rods = struts.map((s) => up({
    ...s,
    joints: [{ name: `${s.id}_free`, type: 'free' }],
    geoms: s.geoms.map((g) => ({ ...g, density: m.density, mass: undefined })),
    deformMaterial: m.id,
    loadStrength: { ...m.strength },
  }));
  const blobs = joints.map((p, i): SceneNode => up({
    id: `${idPrefix}_joint_${i + 1}`,
    name: `${join.label} ${i + 1}`,
    type: 'body',
    pos: [p[0] / 1000, p[1] / 1000, p[2] / 1000],
    joints: [{ name: `${idPrefix}_joint_${i + 1}_free`, type: 'free' }],
    geoms: [{ name: `${idPrefix}_joint_${i + 1}_g`, type: 'ellipsoid', size: [r, r, r], rgba: [...join.rgba], density: join.density }],
    children: [],
    joinMaterial: join.id,
  }));
  return [...rods, ...blobs];
}
