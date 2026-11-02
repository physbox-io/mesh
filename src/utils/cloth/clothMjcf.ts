/**
 * MJCF for cloth bodies: one <flexcomp> per piece, a <connect> per stitch and
 * per tied point, and <numeric>s telling the physics worker what to do with
 * them as it steps (workers/clothForces.ts):
 *
 *  - `clothsew_<equality>` = [x y z seconds]: wind this connect's body2 anchor
 *    from where it starts to (x, y, z) over that many seconds. A connect is
 *    compiled as already satisfied, so a seam starts at the pieces' gap and
 *    closes to nothing; an anchored tie closes onto its anchor.
 *  - `clothflex_<flex>` = [float seconds, wind drag coefficient]: hold the
 *    flex weightless that long, and push it with the wind.
 *
 * A flex vertex is a body named `<flex>_<index>`, its index in the point list.
 */

import type { SceneNode } from '../../types/scene';
import { clothMaterial, DEFAULT_SEW_TIME, meshCloth, pieceArea, stableYoung } from './clothMesh';

export const CLOTH_SEW_PREFIX = 'clothsew_';
export const CLOTH_FLEX_PREFIX = 'clothflex_';

/** What the scene's <option> must be once it holds cloth. */
export const CLOTH_OPTION = {
  // MuJoCo will not integrate flex elasticity under implicit or implicitfast.
  integrator: 'discrete',
  // Cloth is the costliest thing in the scene by far, and a 4 ms step drapes
  // as well as 1 ms at a quarter of the cost (spike/cloth bench).
  timestep: 0.004,
  extra: 'solver="CG" iterations="20" tolerance="1e-5"',
};

/**
 * Constraint impedance. A tie holds near-rigidly (0.99-0.9999): at MuJoCo's
 * default (0.9-0.95) a tensioned sail's corner stopped short of its post.
 * Stitches sit between: at the default a garment's seams stayed ~3 cm open,
 * and as rigid as a tie, hundreds of them closing at once flung the whole
 * garment off the form (tests/garments.test.ts).
 */
const STIFF_TIE = 'solimp="0.99 0.9999 0.001 0.5 2"';
const STITCH = 'solimp="0.95 0.99 0.001 0.5 2"';

export const flexName = (body: string, piece: string) => `${body}__${piece}`;
export const flexVertexBody = (body: string, piece: string, i: number) => `${flexName(body, piece)}_${i}`;
export const clothTieName = (body: string, tie: number, k: number) => `cloth_${body}_tie${tie}_${k}`;

export function hasCloth(nodes: SceneNode[]): boolean {
  return nodes.some((n) => !!n.cloth || (n.children ? hasCloth(n.children) : false));
}

const f = (x: number) => +x.toFixed(5);

export interface ClothXml {
  /** Goes inside the cloth's <body>. */
  body: string;
  equality: string[];
  /** Contact exclusions: a tied point does not collide with what holds it. */
  excludes: [string, string][];
  numerics: { name: string; data: number[] }[];
}

export function clothXml(node: SceneNode, bodyName: string, xmlAttr: (s: string) => string): ClothXml {
  const spec = node.cloth!;
  const mesh = meshCloth(spec);
  const mat = clothMaterial(spec);
  const sewTime = spec.sewTime ?? DEFAULT_SEW_TIME;
  const numerics: ClothXml['numerics'] = [];
  const body = spec.pieces.map((p) => {
    const m = mesh.pieces[p.name];
    const name = flexName(bodyName, p.name);
    const mass = Math.max(1e-3, mat.arealDensity * pieceArea(m));
    const rgba = (p.rgba ?? [0.25, 0.5, 0.85, 1]).join(' ');
    numerics.push({ name: CLOTH_FLEX_PREFIX + name, data: [sewTime, mat.windCd] });
    const radius = Math.min(0.004, mesh.spacing * 0.15);
    return `
    <flexcomp name="${xmlAttr(name)}" type="direct" dim="2" radius="${f(radius)}" mass="${f(mass)}" rgba="${rgba}"
      point="${m.pts.map((q) => q.map(f).join(' ')).join('  ')}"
      element="${m.tris.join(' ')}">
      <edge damping="0.002"/>
      <elasticity young="${+stableYoung(mat, mesh.spacing * (p.spacingScale ?? 1), p.stiffnessScale ?? 1).toPrecision(4)}" poisson="${mat.poisson}" thickness="${mat.thickness}" damping="${mat.damping}" elastic2d="${mat.bending ? 'both' : 'stretch'}"/>
      <contact contype="2" conaffinity="1" condim="3" friction="${mat.friction}" solref="0.008 1" selfcollide="${spec.selfCollide ? 'auto' : 'none'}" margin="${f(radius)}"/>
    </flexcomp>`;
  }).join('');

  const equality: string[] = [];
  const excludes: [string, string][] = [];
  mesh.stitches.forEach((s, i) => {
    const eq = `cloth_${bodyName}_stitch${i}`;
    const a = flexVertexBody(bodyName, s.a[0], s.a[1]);
    const b = flexVertexBody(bodyName, s.b[0], s.b[1]);
    equality.push(`<connect name="${xmlAttr(eq)}" body1="${xmlAttr(a)}" body2="${xmlAttr(b)}" anchor="0 0 0" solref="0.008 1" ${STITCH}/>`);
    numerics.push({ name: CLOTH_SEW_PREFIX + eq, data: [0, 0, 0, sewTime] });
  });
  for (const t of mesh.ties) {
    const tie = spec.ties![t.tie];
    t.verts.forEach((v, k) => {
      const eq = clothTieName(bodyName, t.tie, k);
      const a = flexVertexBody(bodyName, t.piece, v);
      const to = tie.to ? ` body2="${xmlAttr(tie.to)}"` : '';
      equality.push(`<connect name="${xmlAttr(eq)}" body1="${xmlAttr(a)}"${to} anchor="0 0 0" solref="0.008 1" ${STIFF_TIE}/>`);
      if (tie.to) excludes.push([a, tie.to]);
      if (tie.anchor && t.verts.length === 1) numerics.push({ name: CLOTH_SEW_PREFIX + eq, data: [...tie.anchor.slice(0, 3), sewTime] });
    });
  }
  return { body, equality, excludes, numerics };
}
