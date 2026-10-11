import { describe, it, expect } from 'vitest';
import { collectSceneTriangles } from '../src/utils/contourSliceExporter';
import { compileToMJCF } from '../src/utils/mjcf';
import { texturedSurfaceOf } from '../src/utils/geomSurface';
import { requestTexturedSurface } from '../src/utils/textureClient';
import type { SceneGeom, SceneGraph } from '../src/types/scene';
import type { SurfaceTexture } from '../src/utils/surfaceTexture';

/*
 * The split a surface pattern rests on: everything that draws or makes the
 * part sees the pattern, and the physics does not. If the exporters stop
 * seeing it, a fluted box machines flat with no error. If the MJCF starts
 * seeing it, every rebuild hands MuJoCo a quarter of a million triangles to
 * hull, and the native app's golden XML drifts.
 */

const flutes: SurfaceTexture = {
  pattern: 'fluted',
  depthM: -0.002,
  cellM: 0.001,
  seedAt: [0, 0, 0.01],
  seedNormal: [0, 0, 1],
};

function plateScene(textures?: SurfaceTexture[]): SceneGraph {
  const geom: SceneGeom = { name: 'plate_geom', type: 'box', size: [0.03, 0.02, 0.01], ...(textures ? { textures } : {}) };
  return { nodes: [{ id: 'plate', name: 'plate', pos: [0, 0, 0.05], geoms: [geom], children: [] }] } as unknown as SceneGraph;
}

const zRange = (tris: number[]) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < tris.length; i += 3) {
    lo = Math.min(lo, tris[i]);
    hi = Math.max(hi, tris[i]);
  }
  return [lo, hi];
};

describe('a patterned geom', () => {
  it('is what the exporters collect', () => {
    const plain = collectSceneTriangles(plateScene()).tris;
    const patterned = collectSceneTriangles(plateScene([flutes])).tris;
    expect(patterned.length).toBeGreaterThan(plain.length * 100);
    // Same outside: the pattern is sunk into the top, not stood on it.
    const [lo, hi] = zRange(patterned), [plo, phi] = zRange(plain);
    expect(lo).toBeCloseTo(plo, 6);
    expect(hi).toBeCloseTo(phi, 6);
    // And the top really has grooves in it, 2 mm deep, in the body's place.
    const top = 0.06;
    let deepest = Infinity;
    for (let i = 0; i < patterned.length; i += 3) {
      const x = patterned[i], y = patterned[i + 1], z = patterned[i + 2];
      if (Math.abs(x) < 0.025 && Math.abs(y) < 0.015 && z > top - 0.0025) deepest = Math.min(deepest, z);
    }
    expect(deepest).toBeCloseTo(top - 0.002, 4);
  });

  it('leaves the physics model exactly as it was', () => {
    const plain = compileToMJCF(plateScene(), -9.81, 1, 0, 0, 0, 0);
    const patterned = compileToMJCF(plateScene([flutes]), -9.81, 1, 0, 0, 0, 0);
    expect(patterned).toBe(plain);
  });

  it('is built once and then found', () => {
    const geom = plateScene([flutes]).nodes[0].geoms[0];
    const first = texturedSurfaceOf(geom);
    expect(first).not.toBeNull();
    // A copy of the geom, as the store makes on every edit, finds the same build.
    expect(texturedSurfaceOf({ ...geom })).toBe(first);
  });

  it('is built off the main thread where there is one, inline where there is not', async () => {
    const geom = plateScene([{ ...flutes, pattern: 'kumiko' }]).nodes[0].geoms[0];
    const surface = await requestTexturedSurface(geom);
    expect(surface?.regions[0].applied).toBe(true);
    expect(texturedSurfaceOf(geom)).toBe(surface);
  });

  it('wraps a cylinder that runs along its own +Z', () => {
    const geom: SceneGeom = {
      name: 'rod', type: 'cylinder', size: [0.01, 0.03],
      textures: [{ pattern: 'scales', depthM: -0.0005, cellM: 0.001, seedAt: [0.01, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 40 }],
    };
    const surface = texturedSurfaceOf(geom)!;
    expect(surface.regions[0].applied).toBe(true);
    expect(surface.regions[0].normal[0]).toBeCloseTo(1, 2);
  });
});
