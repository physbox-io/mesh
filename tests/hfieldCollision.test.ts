import { beforeAll, describe, expect, it } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';
import {
  checkHfieldEligibility,
  rasterizeHeightfield,
  hfieldToColliderGeom,
} from '../src/utils/hfieldCollision';
import {
  bodyFrameMesh,
  collisionHashOf,
  decomposeNodeColliders,
  decompositionVerdict,
  MAX_DECOMPOSE_TRIANGLES,
} from '../src/utils/convexDecomposition';
import { compileToMJCF } from '../src/utils/mjcf';
import { MeshFileLedger } from '../src/utils/meshVfs';
import { collisionReport } from '../src/utils/sceneSummary';
import { californiaReliefPreset } from '../src/presets/californiaRelief';
import { cupMesh } from './helpers/meshes';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
}, 60_000);

/**
 * Builds a closed, outward-wound 2.5D rectangular terrain mesh in Z-up space
 * (renderVertices) and Y-up space (vertices), spanning [-hx, hx] × [-hy, hy]
 * with a flat bottom at `baseZ` and top height given by `heightFn(x, y)`.
 */
function buildReliefMesh(
  nx: number,
  ny: number,
  hx: number,
  hy: number,
  baseZ: number,
  heightFn: (x: number, y: number) => number,
): { renderVertices: number[]; vertices: number[]; faces: number[] } {
  const cols = nx + 1;
  const rows = ny + 1;
  const renderVertices: number[] = [];
  const faces: number[] = [];

  const topIdx = (c: number, r: number) => r * cols + c;
  const botStart = cols * rows;
  const botIdx = (c: number, r: number) => botStart + r * cols + c;

  // Top vertices
  for (let r = 0; r < rows; r++) {
    const y = -hy + (r / ny) * (2 * hy);
    for (let c = 0; c < cols; c++) {
      const x = -hx + (c / nx) * (2 * hx);
      renderVertices.push(x, y, heightFn(x, y));
    }
  }
  // Bottom vertices
  for (let r = 0; r < rows; r++) {
    const y = -hy + (r / ny) * (2 * hy);
    for (let c = 0; c < cols; c++) {
      const x = -hx + (c / nx) * (2 * hx);
      renderVertices.push(x, y, baseZ);
    }
  }

  // Top surface (+Z outward, CCW from above)
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const a = topIdx(c, r), b = topIdx(c + 1, r), d = topIdx(c + 1, r + 1), e = topIdx(c, r + 1);
      faces.push(a, b, d, a, d, e);
    }
  }
  // Bottom cap (-Z outward)
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const a = botIdx(c, r), b = botIdx(c + 1, r), d = botIdx(c + 1, r + 1), e = botIdx(c, r + 1);
      faces.push(a, d, b, a, e, d);
    }
  }
  // Four vertical perimeter walls
  for (let c = 0; c < nx; c++) {
    // South (-Y)
    const ta = topIdx(c, 0), tb = topIdx(c + 1, 0), ba = botIdx(c, 0), bb = botIdx(c + 1, 0);
    faces.push(ta, ba, bb, ta, bb, tb);
    // North (+Y)
    const ta2 = topIdx(c, ny), tb2 = topIdx(c + 1, ny), ba2 = botIdx(c, ny), bb2 = botIdx(c + 1, ny);
    faces.push(ta2, tb2, bb2, ta2, bb2, ba2);
  }
  for (let r = 0; r < ny; r++) {
    // West (-X)
    const ta = topIdx(0, r), tb = topIdx(0, r + 1), ba = botIdx(0, r), bb = botIdx(0, r + 1);
    faces.push(ta, tb, bb, ta, bb, ba);
    // East (+X)
    const ta2 = topIdx(nx, r), tb2 = topIdx(nx, r + 1), ba2 = botIdx(nx, r), bb2 = botIdx(nx, r + 1);
    faces.push(ta2, ba2, bb2, ta2, bb2, tb2);
  }

  // Convert Z-up [x, y, z] to Three.js Y-up [x, z, -y]
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) {
    vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  }
  return { renderVertices, vertices, faces };
}

function makeNode(
  mesh: { renderVertices: number[]; vertices: number[]; faces: number[] },
  overrides: Partial<SceneNode> = {},
): SceneNode {
  const geom: SceneGeom = {
    name: 'relief_mesh',
    type: 'mesh',
    size: [1],
    vertices: mesh.vertices,
    renderVertices: mesh.renderVertices,
    faces: mesh.faces,
    dynamic: true,
    rgba: [0.7, 0.65, 0.55, 1],
  };
  return {
    id: 'relief_1',
    name: 'relief_1',
    pos: [0, 0, 0],
    geoms: [geom],
    joints: [],
    children: [],
    ...overrides,
  };
}

describe('checkHfieldEligibility', () => {
  const valleyFn = (x: number, y: number) => {
    const r = Math.hypot(x, y);
    return r < 0.08 ? 0.02 : 0.12;
  };
  const rectRelief = buildReliefMesh(16, 16, 0.15, 0.15, 0.0, valleyFn);

  it('accepts a static rectangular relief even when elevated', () => {
    const res = checkHfieldEligibility(rectRelief.renderVertices, rectRelief.faces, {
      isStatic: true,
      worldPos: [0, 0, 0.5],
    });
    expect(res.eligible).toBe(true);
    expect(res.reason).toBe('eligible-rectangular');
    expect(res.xyCoverage).toBeGreaterThanOrEqual(0.99);
  });

  it('accepts grounded irregular relief (california_relief)', () => {
    const caNode = californiaReliefPreset.nodes[0];
    const framed = bodyFrameMesh(caNode.geoms[0]);
    const res = checkHfieldEligibility(framed.verts, framed.faces, {
      isStatic: true,
      worldPos: caNode.pos,
    });
    expect(res.eligible).toBe(true);
    expect(res.reason).toBe('eligible-grounded');
    expect(Math.abs(res.worldMinZ)).toBeLessThanOrEqual(0.005);
  });

  it('rejects dynamic bodies', () => {
    const res = checkHfieldEligibility(rectRelief.renderVertices, rectRelief.faces, {
      isStatic: false,
      worldPos: [0, 0, 0],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('not-static');
  });

  it('rejects elevated irregular shapes (floating shelf outside silhouette)', () => {
    const caNode = californiaReliefPreset.nodes[0];
    const framed = bodyFrameMesh(caNode.geoms[0]);
    const res = checkHfieldEligibility(framed.verts, framed.faces, {
      isStatic: true,
      worldPos: [0, 0, 0.25],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('elevated-irregular');
  });

  it('rejects overhangs / downward-facing triangles above bottom cap', () => {
    const verts = [...rectRelief.renderVertices];
    const faces = [...rectRelief.faces];
    // Add a downward-facing overhang triangle floating at z = 0.08
    const base = verts.length / 3;
    verts.push(
      -0.02, -0.02, 0.08,
      -0.02, 0.02, 0.08,
      0.02, -0.02, 0.08,
    );
    faces.push(base, base + 1, base + 2); // normal points -Z
    const res = checkHfieldEligibility(verts, faces, { isStatic: true, worldPos: [0, 0, 0] });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('overhang');
  });

  it('rejects coarse meshes (< 200 triangles) automatically', () => {
    const coarse = buildReliefMesh(4, 4, 0.15, 0.15, 0.0, valleyFn);
    const res = checkHfieldEligibility(coarse.renderVertices, coarse.faces, { isStatic: true });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('too-coarse');
  });

  it('rejects straight-walled cylindrical cups (flat-stepped containers stay on sector/V-HACD)', () => {
    const cup = cupMesh({ outerR: 0.05, innerR: 0.044, height: 0.08, baseThickness: 0.005 });
    const res = checkHfieldEligibility(cup.verts, cup.faces, { isStatic: true, worldPos: [0, 0, 0] });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('flat-stepped');
  });

  it('allows large reliefs (> MAX_DECOMPOSE_TRIANGLES) to select hfield in decompositionVerdict', () => {
    const node = makeNode(rectRelief);
    const verdict = decompositionVerdict(node, {
      volume: 0.005,
      hullVolume: 0.01,
      triangles: MAX_DECOMPOSE_TRIANGLES + 50_000,
      hfieldEligible: true,
    });
    expect(verdict.strategy).toBe('hfield');
    expect(verdict.reason).toBe('hfield');
    expect(verdict.warning).toBeUndefined();
  });
});

describe('rasterizeHeightfield', () => {
  it('preserves exact MuJoCo row/col orientation and quadrant heights', () => {
    // 4 distinct plateaus:
    // (-X, -Y) => 0.02, (+X, -Y) => 0.05, (-X, +Y) => 0.08, (+X, +Y) => 0.12
    const quadFn = (x: number, y: number) => {
      if (y < 0) return x < 0 ? 0.02 : 0.05;
      return x < 0 ? 0.08 : 0.12;
    };
    const mesh = buildReliefMesh(24, 24, 0.2, 0.1, 0.0, quadFn);
    const raster = rasterizeHeightfield(mesh.renderVertices, mesh.faces, { maxDim: 64 })!;
    expect(raster).not.toBeNull();
    expect(raster.hasMultiLayerOverlap).toBe(false);
    // Aspect ratio 2:1 (dx=0.4, dy=0.2) => ncol=64, nrow=32
    expect(raster.ncol).toBe(64);
    expect(raster.nrow).toBe(32);

    const zAt = (r: number, c: number) => raster.pos[2] + raster.data[r * raster.ncol + c] * raster.size[2];
    // Sample deep inside each quadrant
    const rLow = Math.floor(raster.nrow * 0.2);
    const rHigh = Math.floor(raster.nrow * 0.8);
    const cLow = Math.floor(raster.ncol * 0.2);
    const cHigh = Math.floor(raster.ncol * 0.8);

    expect(zAt(rLow, cLow)).toBeCloseTo(0.02, 3);   // (-X, -Y)
    expect(zAt(rLow, cHigh)).toBeCloseTo(0.05, 3);  // (+X, -Y)
    expect(zAt(rHigh, cLow)).toBeCloseTo(0.08, 3);  // (-X, +Y)
    expect(zAt(rHigh, cHigh)).toBeCloseTo(0.12, 3); // (+X, +Y)
    // Base extends down to mesh bottom (z = 0.0)
    expect(raster.pos[2] - raster.size[3]).toBeCloseTo(0.0, 3);
  });

  it('detects multi-layer overlapping upward-facing triangles', () => {
    const mesh = buildReliefMesh(10, 10, 0.1, 0.1, 0.0, () => 0.02);
    // Add a second upward-facing shelf above at z = 0.08
    const verts = [...mesh.renderVertices];
    const faces = [...mesh.faces];
    const base = verts.length / 3;
    verts.push(
      -0.05, -0.05, 0.08,
      0.05, -0.05, 0.08,
      0.05, 0.05, 0.08,
      -0.05, 0.05, 0.08,
    );
    faces.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const raster = rasterizeHeightfield(verts, faces, { maxDim: 32 })!;
    expect(raster.hasMultiLayerOverlap).toBe(true);
  });
});

describe('MJCF emission, explicit override, and scene summary', () => {
  const valleyFn = (x: number, y: number) => (Math.hypot(x, y) < 0.08 ? 0.02 : 0.12);
  const rectRelief = buildReliefMesh(16, 16, 0.15, 0.15, 0.0, valleyFn);

  it('emits inline <hfield> and binary VFS <hfield>, demoting visual mesh to contype=0', async () => {
    const node = makeNode(rectRelief);
    const result = await decomposeNodeColliders(node);
    expect(result).not.toBeNull();
    expect(result!.verdict.strategy).toBe('hfield');
    expect(result!.geoms).toHaveLength(1);
    expect(result!.geoms[0].type).toBe('hfield');
    expect(result!.warning).toBeUndefined();

    const settledNode: SceneNode = {
      ...node,
      geoms: [...node.geoms, ...result!.geoms],
      collisionHash: result!.hash,
      collisionDecomposed: true,
      collisionSolidity: +result!.verdict.solidity.toFixed(4),
    };

    // Scene summary report
    const report = collisionReport(settledNode);
    expect(report.collidesAs).toBe(`heightfield (${result!.geoms[0].hfield!.nrow}x${result!.geoms[0].hfield!.ncol})`);
    expect(report.collisionWarning).toBeUndefined();
    expect(report.cavitiesFilled).toBeUndefined();

    // Inline MJCF (dynamic: true visual mesh is omitted from physics, drawn from body transform)
    const xmlInline = compileToMJCF({ nodes: [settledNode] });
    expect(xmlInline).toContain('<hfield name="relief_1_hfield_0"');
    expect(xmlInline).toContain('elevation="');
    expect(xmlInline).toContain('type="hfield" hfield="relief_1_hfield_0"');
    expect(xmlInline).not.toContain('name="relief_mesh"');

    // Static visual mesh (dynamic: false, like california_relief) stays in MJCF with contype=0 conaffinity=0
    const staticSettled: SceneNode = {
      ...settledNode,
      geoms: settledNode.geoms.map((g) => (g.name === 'relief_mesh' ? { ...g, dynamic: false } : g)),
    };
    const xmlStatic = compileToMJCF({ nodes: [staticSettled] });
    expect(xmlStatic).toMatch(/name="relief_mesh"[^>]*contype="0" conaffinity="0"/);

    // Binary VFS MJCF
    const ledger = new MeshFileLedger();
    const xmlBin = compileToMJCF({ nodes: [settledNode] }, -9.81, 1.0, 0, 0, 0, 0, { meshFiles: ledger });
    const { add } = ledger.take();
    expect(xmlBin).toMatch(/<hfield name="relief_1_hfield_0"[^>]*file="hf_[0-9a-f]{16}\.bin"/);
    expect(add.some((f) => f.name.startsWith('hf_') && f.name.endsWith('.bin'))).toBe(true);
  });

  it('supports explicit collision: "hfield" override and rejects dynamic bodies cleanly', async () => {
    const coarse = buildReliefMesh(4, 4, 0.15, 0.15, 0.0, valleyFn);
    const forcedStatic = makeNode(coarse, { collision: 'hfield' });
    const resStatic = await decomposeNodeColliders(forcedStatic);
    expect(resStatic!.verdict.strategy).toBe('hfield');
    expect(resStatic!.geoms[0].type).toBe('hfield');

    const forcedDynamic = makeNode(coarse, {
      collision: 'hfield',
      joints: [{ name: 'free', type: 'free' }],
    });
    const resDyn = await decomposeNodeColliders(forcedDynamic);
    expect(resDyn!.verdict.strategy).toBe('hull');
    expect(resDyn!.geoms).toHaveLength(0);
    expect(resDyn!.warning).toMatch(/static bodies/i);
  });

  it('invalidates collisionHash when a static body gains a joint', () => {
    const staticNode = makeNode(rectRelief);
    const dynamicNode = makeNode(rectRelief, { joints: [{ name: 'free', type: 'free' }] });
    expect(collisionHashOf(staticNode)).not.toBe(collisionHashOf(dynamicNode));
  });
});

describe('Real MuJoCo physics: ball drops into concave valley', () => {
  it('ball lands inside a rectangular relief valley (below rim) in both inline and binary VFS modes', async () => {
    // Valley floor at z = 0.02, high rim at z = 0.12
    const valleyFn = (x: number, y: number) => (Math.hypot(x, y) < 0.09 ? 0.02 : 0.12);
    const mesh = buildReliefMesh(20, 20, 0.18, 0.18, 0.0, valleyFn);
    const terrain = makeNode(mesh, { id: 'valley', name: 'valley' });
    const result = await decomposeNodeColliders(terrain);
    expect(result!.verdict.strategy).toBe('hfield');

    const ball: SceneNode = {
      id: 'ball',
      name: 'ball',
      pos: [0, 0, 0.25],
      geoms: [{ name: 'ball_geom', type: 'sphere', size: [0.015], mass: 0.1 }],
      joints: [{ name: 'ball_free', type: 'free' }],
      children: [],
    };
    const scene: SceneGraph = {
      nodes: [
        { ...terrain, geoms: [...terrain.geoms, ...result!.geoms], collisionHash: result!.hash, collisionDecomposed: true },
        ball,
      ],
    };

    // 1. Inline XML
    const xmlInline = compileToMJCF(scene);
    const m1 = mj.MjModel.from_xml_string(xmlInline);
    const d1 = new mj.MjData(m1);
    for (let i = 0; i < 600; i++) mj.mj_step(m1, d1);
    const zInline = d1.qpos[2];
    m1.delete();
    d1.delete();
    // Valley floor is 0.02 + ball radius 0.015 = 0.035; rim is 0.12 (hull lid would stop ball at 0.135)
    expect(zInline).toBeGreaterThan(0.025);
    expect(zInline).toBeLessThan(0.055);

    // 2. Binary VFS XML
    const ledger = new MeshFileLedger();
    const xmlBin = compileToMJCF(scene, -9.81, 1.0, 0, 0, 0, 0, { meshFiles: ledger });
    const { add } = ledger.take();
    const vfs = new mj.MjVFS();
    for (const f of add) vfs.addBuffer(f.name, f.bytes);
    const m2 = mj.MjModel.from_xml_string(xmlBin, vfs);
    const d2 = new mj.MjData(m2);
    for (let i = 0; i < 600; i++) mj.mj_step(m2, d2);
    const zBin = d2.qpos[2];
    m2.delete();
    d2.delete();
    vfs.delete();
    expect(zBin).toBeCloseTo(zInline, 3);
  });

  it('california_relief selects hfield quickly and collides accurately in MuJoCo', async () => {
    const caNode = californiaReliefPreset.nodes[0];
    const t0 = performance.now();
    const result = await decomposeNodeColliders(caNode);
    const elapsedMs = performance.now() - t0;

    expect(result).not.toBeNull();
    expect(result!.verdict.strategy).toBe('hfield');
    expect(result!.geoms).toHaveLength(1);
    expect(result!.geoms[0].type).toBe('hfield');
    expect(result!.warning).toBeUndefined();
    expect(result!.cavities).toBeUndefined();
    expect(elapsedMs).toBeLessThan(3000);

    // Drop a tiny 1 mm ball into California's Central Valley (near x = -0.002, y = 0.002),
    // where terrain elevation is near 0..0.003 m while Sierra peaks reach ~0.018 m.
    const hf = result!.geoms[0];
    const ball: SceneNode = {
      id: 'probe_ball',
      name: 'probe_ball',
      pos: [-0.002, 0.002, 0.03],
      geoms: [{ name: 'probe_ball_geom', type: 'sphere', size: [0.001], mass: 0.001 }],
      joints: [{ name: 'probe_free', type: 'free' }],
      children: [],
    };
    const scene: SceneGraph = {
      nodes: [
        { ...caNode, geoms: [...caNode.geoms, hf], collisionHash: result!.hash, collisionDecomposed: true },
        ball,
      ],
    };

    const ledger = new MeshFileLedger();
    const xml = compileToMJCF(scene, -9.81, 1.0, 0, 0, 0, 0, { meshFiles: ledger });
    const { add } = ledger.take();
    const vfs = new mj.MjVFS();
    for (const f of add) vfs.addBuffer(f.name, f.bytes);
    const m = mj.MjModel.from_xml_string(xml, vfs);
    const d = new mj.MjData(m);
    for (let i = 0; i < 600; i++) mj.mj_step(m, d);
    const finalZ = d.qpos[2];
    m.delete();
    d.delete();
    vfs.delete();

    // Convex hull lid over Central Valley sits around 0.009..0.014 m;
    // real valley floor is near 0.0005..0.003 m (+ 0.001 m ball radius).
    expect(finalZ).toBeGreaterThan(-0.002);
    expect(finalZ).toBeLessThan(0.005);
  });
});

// Keep hfieldToColliderGeom imported/verified directly
describe('hfieldToColliderGeom', () => {
  it('sets required collider metadata and clears mesh fields', () => {
    const geom = hfieldToColliderGeom(
      { nrow: 4, ncol: 4, data: new Array(16).fill(0), pos: [0, 0, 0], size: [0.1, 0.1, 0.02, 0.002], hasMultiLayerOverlap: false },
      'hf_col',
      'src_mesh',
      { friction: [0.8, 0.005, 0.0001] },
    );
    expect(geom.type).toBe('hfield');
    expect(geom.role).toBe('collision');
    expect(geom.csgDerived).toBe('collider');
    expect(geom.colliderOf).toBe('src_mesh');
    expect(geom.friction).toEqual([0.8, 0.005, 0.0001]);
  });
});
