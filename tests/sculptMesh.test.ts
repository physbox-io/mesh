import { describe, it, expect } from 'vitest';
import {
  icosphere,
  createSculptMesh,
  cloneSculptMesh,
  recomputeNormals,
  buildAdjacency,
  buildSpatialHash,
  queryRadius,
  refineInRadius,
  decimateInRadius,
  beginStroke,
  applyBrush,
  endStroke,
  applyUndo,
  raycastMesh,
  toSceneGeom,
  fromSceneGeom,
  meshBounds,
  isWatertight,
  DEFAULT_BRUSH,
  type BrushSettings,
  type SculptMesh,
} from '../src/utils/sculptMesh';

const brush = (over: Partial<BrushSettings> = {}): BrushSettings => ({
  ...DEFAULT_BRUSH,
  radius: 0.1,
  strength: 1,
  dynamicTopology: false,
  ...over,
});

/** Longest edge anywhere in the mesh. */
function longestEdge(mesh: SculptMesh): number {
  let worst = 0;
  for (let f = 0; f < mesh.faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.faces[f * 3 + e];
      const b = mesh.faces[f * 3 + ((e + 1) % 3)];
      worst = Math.max(
        worst,
        Math.hypot(
          mesh.positions[a * 3] - mesh.positions[b * 3],
          mesh.positions[a * 3 + 1] - mesh.positions[b * 3 + 1],
          mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2]
        )
      );
    }
  }
  return worst;
}

/** Every vertex's distance from the origin. */
function radii(mesh: SculptMesh): number[] {
  const out: number[] = [];
  for (let i = 0; i < mesh.vertexCount; i++) {
    out.push(Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
  }
  return out;
}

describe('icosphere', () => {
  it('is a closed surface at every subdivision level', () => {
    for (const level of [0, 1, 2, 3]) {
      const mesh = icosphere(0.3, level);
      expect(isWatertight(mesh), `level ${level}`).toBe(true);
      expect(mesh.faceCount).toBe(20 * 4 ** level);
    }
  });

  it('puts every vertex on the sphere', () => {
    const mesh = icosphere(0.3, 2);
    for (const r of radii(mesh)) expect(r).toBeCloseTo(0.3, 6);
  });

  it('has triangles of nearly one size, unlike a UV sphere', () => {
    const mesh = icosphere(0.3, 3);
    const lengths: number[] = [];
    for (let f = 0; f < mesh.faceCount; f++) {
      const a = mesh.faces[f * 3];
      const b = mesh.faces[f * 3 + 1];
      lengths.push(
        Math.hypot(
          mesh.positions[a * 3] - mesh.positions[b * 3],
          mesh.positions[a * 3 + 1] - mesh.positions[b * 3 + 1],
          mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2]
        )
      );
    }
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.5);
  });

  it('points its normals outward', () => {
    const mesh = icosphere(0.3, 2);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const dot =
        mesh.positions[i * 3] * mesh.normals[i * 3] +
        mesh.positions[i * 3 + 1] * mesh.normals[i * 3 + 1] +
        mesh.positions[i * 3 + 2] * mesh.normals[i * 3 + 2];
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('adjacency', () => {
  it('lists each neighbour once, however many faces share it', () => {
    const mesh = icosphere(0.3, 1);
    const { offsets, neighbours } = buildAdjacency(mesh);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const slice = Array.from(neighbours.subarray(offsets[v], offsets[v + 1]));
      expect(new Set(slice).size).toBe(slice.length);
      // An icosphere is valence 5 or 6 everywhere.
      expect(slice.length === 5 || slice.length === 6).toBe(true);
    }
  });

  it('is symmetric', () => {
    const mesh = icosphere(0.3, 1);
    const { offsets, neighbours } = buildAdjacency(mesh);
    const has = (a: number, b: number) =>
      Array.from(neighbours.subarray(offsets[a], offsets[a + 1])).includes(b);
    for (let v = 0; v < mesh.vertexCount; v++) {
      for (const n of neighbours.subarray(offsets[v], offsets[v + 1])) {
        expect(has(n, v)).toBe(true);
      }
    }
  });
});

describe('spatial hash', () => {
  it('finds exactly the vertices a brute-force scan finds', () => {
    const mesh = icosphere(0.3, 3);
    const hash = buildSpatialHash(mesh, 0.05);
    const [x, y, z] = [0.3, 0, 0];
    const radius = 0.12;

    const fast = new Set(queryRadius(mesh, hash, x, y, z, radius));
    const slow = new Set<number>();
    for (let i = 0; i < mesh.vertexCount; i++) {
      const d = Math.hypot(
        mesh.positions[i * 3] - x,
        mesh.positions[i * 3 + 1] - y,
        mesh.positions[i * 3 + 2] - z
      );
      if (d <= radius) slow.add(i);
    }
    expect(fast).toEqual(slow);
    expect(slow.size).toBeGreaterThan(0);
  });

  it('returns nothing for a point far off the mesh', () => {
    const mesh = icosphere(0.3, 2);
    const hash = buildSpatialHash(mesh, 0.05);
    expect(queryRadius(mesh, hash, 10, 10, 10, 0.1)).toHaveLength(0);
  });
});

describe('dynamic topology', () => {
  it('refines under the brush and leaves the rest of the mesh alone', () => {
    const mesh = icosphere(0.3, 1);
    const before = mesh.faceCount;
    refineInRadius(mesh, 0.3, 0, 0, 0.1, 0.05);
    expect(mesh.faceCount).toBeGreaterThan(before);

    // Far side untouched: still a coarse triangle out there.
    const farEdges: number[] = [];
    for (let f = 0; f < mesh.faceCount; f++) {
      const a = mesh.faces[f * 3];
      if (mesh.positions[a * 3] > -0.2) continue;
      const b = mesh.faces[f * 3 + 1];
      farEdges.push(
        Math.hypot(
          mesh.positions[a * 3] - mesh.positions[b * 3],
          mesh.positions[a * 3 + 1] - mesh.positions[b * 3 + 1],
          mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2]
        )
      );
    }
    expect(Math.max(...farEdges)).toBeGreaterThan(0.05);
  });

  it('stays watertight through refinement — no T-junctions', () => {
    const mesh = icosphere(0.3, 1);
    for (let i = 0; i < 4; i++) refineInRadius(mesh, 0.3, 0, 0, 0.12, 0.03);
    expect(isWatertight(mesh)).toBe(true);
  });

  it('drives the edge length down to the target', () => {
    const mesh = icosphere(0.3, 1);
    // Refine the whole sphere: a radius that covers it and a small target.
    for (let i = 0; i < 6; i++) refineInRadius(mesh, 0, 0, 0, 1, 0.06);
    expect(longestEdge(mesh)).toBeLessThanOrEqual(0.06 * 1.01);
  });

  it('reports doing nothing when everything is already fine enough', () => {
    const mesh = icosphere(0.3, 2);
    expect(refineInRadius(mesh, 0.3, 0, 0, 0.1, 1)).toBe(0);
  });

  it('collapses short edges and stays watertight', () => {
    const mesh = icosphere(0.3, 3);
    const before = mesh.faceCount;
    let collapsed = 0;
    for (let i = 0; i < 5; i++) collapsed += decimateInRadius(mesh, 0, 0, 0, 1, 0.08);
    expect(collapsed).toBeGreaterThan(0);
    expect(mesh.faceCount).toBeLessThan(before);
    expect(isWatertight(mesh)).toBe(true);
  });

  it('leaves no vertex unreferenced after a collapse', () => {
    const mesh = icosphere(0.3, 3);
    decimateInRadius(mesh, 0, 0, 0, 1, 0.08);
    const used = new Set<number>();
    for (let i = 0; i < mesh.faceCount * 3; i++) used.add(mesh.faces[i]);
    expect(used.size).toBe(mesh.vertexCount);
    for (const index of used) expect(index).toBeLessThan(mesh.vertexCount);
  });

  it('survives refine and decimate alternating, which is what a stroke does', () => {
    const mesh = icosphere(0.3, 2);
    for (let i = 0; i < 6; i++) {
      refineInRadius(mesh, 0.3, 0, 0, 0.1, 0.04);
      decimateInRadius(mesh, 0.3, 0, 0, 0.1, 0.012);
      expect(isWatertight(mesh)).toBe(true);
    }
  });
});

describe('brushes', () => {
  it('draw pushes the surface out along the brush normal', () => {
    const mesh = icosphere(0.3, 3);
    const session = beginStroke(mesh, brush());
    for (let i = 0; i < 8; i++) {
      applyBrush(session, brush(), { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    }
    endStroke(session);
    // The pole moved out; the far side did not move at all.
    const hit = raycastMesh(mesh, 1, 0, 0, -1, 0, 0);
    expect(hit!.x).toBeGreaterThan(0.31);
    const back = raycastMesh(mesh, -1, 0, 0, 1, 0, 0);
    expect(back!.x).toBeCloseTo(-0.3, 2);
  });

  it('draw inverted pulls it in', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ invert: true });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 8; i++) {
      applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    }
    endStroke(session);
    expect(raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x).toBeLessThan(0.29);
  });

  it('smooth reduces the roughness it is run over', () => {
    const mesh = icosphere(0.3, 3);
    // Rough the pole up first.
    const noisy = brush({ type: 'inflate', strength: 1 });
    const rough = beginStroke(mesh, noisy);
    for (let i = 0; i < mesh.vertexCount; i++) {
      if (mesh.positions[i * 3] > 0.2) mesh.positions[i * 3 + 1] += (i % 2 ? 1 : -1) * 0.01;
    }
    endStroke(rough);
    recomputeNormals(mesh);

    const spread = (m: SculptMesh) => {
      const ys: number[] = [];
      for (let i = 0; i < m.vertexCount; i++) if (m.positions[i * 3] > 0.25) ys.push(m.positions[i * 3 + 1]);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      return Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
    };
    const before = spread(mesh);

    const settings = brush({ type: 'smooth', strength: 1, radius: 0.15 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 10; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);

    expect(spread(mesh)).toBeLessThan(before);
  });

  it('grab holds the vertices it caught, so the lump travels with the cursor', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ type: 'grab', radius: 0.12 });
    const session = beginStroke(mesh, settings);

    for (let i = 0; i < 10; i++) {
      applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0, dx: 0, dy: 0.005, dz: 0 });
    }
    endStroke(session);

    // The pole was dragged in +Y, so the mesh now reaches further that way.
    const bounds = meshBounds(mesh);
    expect(bounds.max[1]).toBeGreaterThan(0.3);
    // And it did it without changing the topology.
    expect(isWatertight(mesh)).toBe(true);
  });

  it('flatten pulls a bump back towards its own local plane', () => {
    const mesh = icosphere(0.3, 3);
    const draw = brush({ type: 'draw', radius: 0.12 });
    const bump = beginStroke(mesh, draw);
    for (let i = 0; i < 10; i++) applyBrush(bump, draw, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(bump);
    const peak = raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x;

    const settings = brush({ type: 'flatten', radius: 0.15, strength: 1 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 10; i++) applyBrush(session, settings, { x: peak, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);

    expect(raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x).toBeLessThan(peak);
  });

  it('pinch draws material in towards the brush axis', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ type: 'pinch', radius: 0.12, strength: 1 });
    // Averaged over the vertices the brush actually covers. Taking the widest
    // vertex instead would read the rim of the cap, which sits outside the
    // brush and is supposed to stay exactly where it is.
    const spread = () => {
      let total = 0;
      let n = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        const d = Math.hypot(
          mesh.positions[i * 3] - 0.3,
          mesh.positions[i * 3 + 1],
          mesh.positions[i * 3 + 2]
        );
        if (d > 0.12) continue;
        total += Math.hypot(mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
        n++;
      }
      return total / Math.max(1, n);
    };
    const before = spread();
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 6; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);
    expect(spread()).toBeLessThan(before);
  });

  it('mirrors the stroke when symmetry is on', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ symmetryX: true, radius: 0.12 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 8; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);

    const right = raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x;
    const left = raycastMesh(mesh, -1, 0, 0, 1, 0, 0)!.x;
    expect(right).toBeGreaterThan(0.31);
    expect(-left).toBeCloseTo(right, 5);
  });

  it('does not mirror when symmetry is off', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ symmetryX: false, radius: 0.12 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 8; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);
    expect(raycastMesh(mesh, -1, 0, 0, 1, 0, 0)!.x).toBeCloseTo(-0.3, 3);
  });

  it('leaves the surface closed after a dynamic-topology stroke', () => {
    const mesh = icosphere(0.3, 2);
    const settings = brush({ dynamicTopology: true, radius: 0.1, detail: 0.25 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 0.5;
      applyBrush(session, settings, {
        x: 0.3 * Math.cos(a), y: 0.3 * Math.sin(a), z: 0,
        nx: Math.cos(a), ny: Math.sin(a), nz: 0,
      });
    }
    endStroke(session);
    expect(isWatertight(mesh)).toBe(true);
    expect(mesh.faceCount).toBeGreaterThan(icosphere(0.3, 2).faceCount);
  });

  it('adds detail where the brush went and nowhere else', () => {
    const mesh = icosphere(0.3, 2);
    const settings = brush({ dynamicTopology: true, radius: 0.1, detail: 0.2 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 6; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);

    const density = (minX: number, maxX: number) => {
      let n = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (mesh.positions[i * 3] >= minX && mesh.positions[i * 3] <= maxX) n++;
      }
      return n;
    };
    // The brushed cap holds far more vertices than the equivalent cap opposite.
    expect(density(0.2, 1)).toBeGreaterThan(density(-1, -0.2) * 2);
  });
});

describe('undo', () => {
  it('puts a plain stroke back exactly, storing only what moved', () => {
    const mesh = icosphere(0.3, 3);
    const original = cloneSculptMesh(mesh);
    const settings = brush({ radius: 0.1 });

    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 5; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    const entry = endStroke(session)!;

    // A delta, not a snapshot: it holds a fraction of the mesh's vertices.
    expect(entry.mesh).toBeNull();
    expect(entry.indices!.length).toBeGreaterThan(0);
    expect(entry.indices!.length).toBeLessThan(mesh.vertexCount);

    applyUndo(mesh, entry);
    for (let i = 0; i < original.vertexCount * 3; i++) {
      expect(mesh.positions[i]).toBeCloseTo(original.positions[i], 6);
    }
  });

  it('redoes what it undid', () => {
    const mesh = icosphere(0.3, 3);
    const settings = brush({ radius: 0.1 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 5; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    const entry = endStroke(session)!;

    const sculpted = cloneSculptMesh(mesh);
    const redo = applyUndo(mesh, entry);
    applyUndo(mesh, redo);
    for (let i = 0; i < sculpted.vertexCount * 3; i++) {
      expect(mesh.positions[i]).toBeCloseTo(sculpted.positions[i], 6);
    }
  });

  it('falls back to a snapshot when the stroke changed the topology', () => {
    const mesh = icosphere(0.3, 2);
    const original = cloneSculptMesh(mesh);
    const settings = brush({ dynamicTopology: true, radius: 0.1, detail: 0.25 });

    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 5; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    const entry = endStroke(session)!;

    expect(entry.mesh).not.toBeNull();
    applyUndo(mesh, entry);
    expect(mesh.vertexCount).toBe(original.vertexCount);
    expect(mesh.faceCount).toBe(original.faceCount);
    for (let i = 0; i < original.vertexCount * 3; i++) {
      expect(mesh.positions[i]).toBeCloseTo(original.positions[i], 6);
    }
  });

  it('does not snapshot the mesh for a brush that cannot change topology', () => {
    const mesh = icosphere(0.3, 3);
    // The snapshot is several megabytes on a dense sculpt and is taken on every
    // pointer-down, so a brush that only moves vertices must not pay for one.
    expect(beginStroke(mesh, brush({ dynamicTopology: false })).before).toBeNull();
    expect(beginStroke(mesh, brush({ type: 'grab', dynamicTopology: false })).before).toBeNull();
    expect(beginStroke(mesh, brush({ dynamicTopology: true })).before).not.toBeNull();
    // Grab refines the span it drags now — that is what makes a pulled limb a
    // limb rather than a fin — so it changes topology like any other brush and
    // has to be undoable like one.
    expect(beginStroke(mesh, brush({ type: 'grab', dynamicTopology: true })).before).not.toBeNull();
  });

  it('returns nothing for a stroke that touched nothing', () => {
    const mesh = icosphere(0.3, 2);
    const settings = brush({ radius: 0.05 });
    const session = beginStroke(mesh, settings);
    applyBrush(session, settings, { x: 5, y: 5, z: 5, nx: 1, ny: 0, nz: 0 });
    expect(endStroke(session)).toBeNull();
  });
});

describe('raycast', () => {
  it('hits the near side of the sphere, not the far one', () => {
    const mesh = icosphere(0.3, 3);
    const hit = raycastMesh(mesh, 2, 0, 0, -1, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeGreaterThan(0);
    expect(hit!.x).toBeCloseTo(0.3, 1);
    expect(hit!.distance).toBeCloseTo(2 - hit!.x, 5);
  });

  it('returns the outward normal at the hit', () => {
    const mesh = icosphere(0.3, 3);
    const hit = raycastMesh(mesh, 2, 0, 0, -1, 0, 0)!;
    expect(hit.nx).toBeGreaterThan(0.9);
  });

  it('misses when the ray misses', () => {
    const mesh = icosphere(0.3, 2);
    expect(raycastMesh(mesh, 2, 5, 0, -1, 0, 0)).toBeNull();
  });

  it('ignores geometry behind the ray origin', () => {
    const mesh = icosphere(0.3, 2);
    // Origin inside the sphere, pointing out: the only hit is ahead.
    const hit = raycastMesh(mesh, 0, 0, 0, 1, 0, 0)!;
    expect(hit.x).toBeGreaterThan(0);
  });
});

describe('scene geom round trip', () => {
  it('emits the Y-up copy the renderer wants alongside the Z-up original', () => {
    const mesh = createSculptMesh([1, 2, 3], []);
    const { vertices, renderVertices } = toSceneGeom(mesh);
    expect(renderVertices).toEqual([1, 2, 3]);
    // Y-up is (x, z, -y).
    expect(vertices).toEqual([1, 3, -2]);
  });

  it('survives a round trip through SceneGeom unchanged', () => {
    const mesh = icosphere(0.3, 2);
    const geom = toSceneGeom(mesh);
    const back = fromSceneGeom(geom.renderVertices, geom.faces);

    expect(back.vertexCount).toBe(mesh.vertexCount);
    expect(back.faceCount).toBe(mesh.faceCount);
    for (let i = 0; i < mesh.vertexCount * 3; i++) {
      expect(back.positions[i]).toBeCloseTo(mesh.positions[i], 6);
    }
    expect(isWatertight(back)).toBe(true);
  });

  it('reports its bounds', () => {
    const bounds = meshBounds(icosphere(0.3, 2));
    expect(bounds.min[0]).toBeCloseTo(-0.3, 2);
    expect(bounds.max[0]).toBeCloseTo(0.3, 2);
  });
});

describe('watertightness check', () => {
  it('catches an open surface', () => {
    // A single triangle: three edges, each used once.
    expect(isWatertight(createSculptMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBe(false);
  });

  it('accepts a closed one', () => {
    expect(isWatertight(icosphere(0.3, 1))).toBe(true);
  });
});

describe('limits and caching', () => {
  it('stops refining once the vertex budget is reached', () => {
    const mesh = icosphere(0.3, 2);
    const settings = brush({ dynamicTopology: true, radius: 0.2, detail: 0.08, maxVertices: mesh.vertexCount + 50 });
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 20; i++) {
      applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    }
    endStroke(session);

    expect(session.hitVertexBudget).toBe(true);
    // It stops adding; it does not stop working, and it does not break the mesh.
    expect(isWatertight(mesh)).toBe(true);
    // One refine pass can overshoot the cap — what matters is that it is not
    // still doubling twenty dabs later.
    expect(mesh.vertexCount).toBeLessThan(settings.maxVertices * 4);
  });

  it('keeps sculpting after the budget, it just gets no finer', () => {
    const mesh = icosphere(0.3, 2);
    const settings = brush({ dynamicTopology: true, radius: 0.15, maxVertices: 1 });
    const before = raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x;
    const session = beginStroke(mesh, settings);
    for (let i = 0; i < 8; i++) applyBrush(session, settings, { x: 0.3, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
    endStroke(session);
    expect(raycastMesh(mesh, 1, 0, 0, -1, 0, 0)!.x).toBeGreaterThan(before);
  });

  it('accepts a prebuilt adjacency and agrees with building its own', () => {
    const withCache = icosphere(0.3, 3);
    const withoutCache = icosphere(0.3, 3);
    const cached = buildAdjacency(withCache);

    const a = decimateInRadius(withCache, 0, 0, 0, 1, 0.08, cached);
    const b = decimateInRadius(withoutCache, 0, 0, 0, 1, 0.08);
    expect(a).toBe(b);
    expect(withCache.vertexCount).toBe(withoutCache.vertexCount);
    expect(withCache.faceCount).toBe(withoutCache.faceCount);
  });

  it('ignores an adjacency built for a different topology', () => {
    const mesh = icosphere(0.3, 3);
    const stale = buildAdjacency(mesh);
    // Change the topology out from under the cached list.
    refineInRadius(mesh, 0.3, 0, 0, 0.2, 0.02);
    expect(stale.topologyRevision).not.toBe(mesh.topologyRevision);

    // Rebuilt internally rather than read as if it still applied, so the mesh
    // survives — a stale neighbour list would collapse across the wrong pairs.
    decimateInRadius(mesh, 0.3, 0, 0, 0.2, 0.01, stale);
    expect(isWatertight(mesh)).toBe(true);
  });
});
