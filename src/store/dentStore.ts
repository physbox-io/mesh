// Dents, kept deliberately outside the scene graph.
//
// A dent cannot go through `updateNodeGeom`. That action classifies `vertices`
// as a STRUCTURAL edit, which means an undebounced rebuild of the MuJoCo model
// that DISCARDS the simulation state — so the first dent would reset the very
// drop that caused it. And `cloneGeom` deliberately SHARES vertex arrays by
// reference between clones, on the documented contract that mesh edits replace
// arrays wholesale rather than mutating them, so writing into one in place
// would corrupt every undo snapshot that shares it.
//
// So deformation lives here instead, in its own tiny store keyed by geom. Two
// consequences worth being plain about:
//
//   * DENTS ARE COSMETIC. MuJoCo keeps colliding the undented mesh. Feeding a
//     deformed mesh back to the solver means rebuilding the model, and that
//     cannot happen at the rate contacts arrive. The plate looks dented and
//     collides flat.
//   * They are transient, like every other kind of damage here. Reset clears
//     them, and the saved scene never knew about them.
//
// A store of its own rather than a slice of useStore, because an impact can
// land at contact rate and every write here would otherwise wake every
// component subscribed to the scene.

import { create } from 'zustand';
import { createSculptMesh, recomputeNormals, type SculptMesh } from '../utils/sculptMesh';
import { dentFalloff, type DentProfile } from '../utils/dentMesh';

/** `${nodeId}/${geomName}` — stable across rebuilds, unlike any index. */
export type DentKey = string;

export const dentKey = (nodeId: string, geomName: string): DentKey => `${nodeId}/${geomName}`;

export interface DentedMesh {
  mesh: SculptMesh;
  /** Bumped on every dent, so the renderer can tell it has work to do. */
  version: number;
  /** How many blows this surface has taken. */
  count: number;
  /** The deepest single dent, in metres, for the readout. */
  deepest: number;
  /** How many times it has been holed clean through. */
  holes?: number;
}

interface DentState {
  dents: Record<DentKey, DentedMesh>;
  /**
   * Push a crater into a surface at a point, in the geom's own vertex space.
   *
   * `sourceVertices`/`faces` are the pristine geometry, used only the first
   * time a given surface is hit; after that the accumulated mesh is dented
   * again, so a plate struck twice in the same place gets deeper rather than
   * resetting.
   */
  dent: (
    key: DentKey,
    sourceVertices: ArrayLike<number>,
    faces: ArrayLike<number>,
    point: [number, number, number],
    normal: [number, number, number],
    depth: number,
    radius: number,
    /** The shape of the thing that hit it. See utils/dentMesh.ts. */
    profile?: DentProfile,
  ) => void;
  /**
   * Punch a hole clean through, where a dent would only have creased it.
   *
   * The material under the striker is REMOVED rather than pushed aside, which
   * is the honest difference between a dent and a pierce: a dent conserves the
   * surface and a hole does not. The rim is pulled in a little on the way, so
   * the edge reads as torn rather than as cut with a punch.
   *
   * Cosmetic like everything else here. MuJoCo goes on colliding the whole
   * plate, so something can be thrown at the hole and still bounce off it.
   */
  pierce: (
    key: DentKey,
    sourceVertices: ArrayLike<number>,
    faces: ArrayLike<number>,
    point: [number, number, number],
    normal: [number, number, number],
    radius: number,
  ) => void;
  clear: () => void;
  clearOne: (key: DentKey) => void;
}

export const useDentStore = create<DentState>((set, get) => ({
  dents: {},

  dent: (key, sourceVertices, faces, point, normal, depth, radius, profile = 'dish') => {
    if (!(depth > 0) || !(radius > 0)) return;

    const existing = get().dents[key];
    const mesh = existing ? existing.mesh : createSculptMesh(sourceVertices, faces);

    /*
     * The displacement, written directly rather than through the sculpt brush.
     *
     * `applyBrush` would do the job, but only ever with its own smoothstep
     * falloff — and the shape of the crater is most of what makes a dent read
     * as something having landed rather than as a blemish. A flat-ended slug
     * leaves a flat floor with a rim; a ball leaves a cap. It is also less
     * machinery: no stroke session, no undo journal, no dynamic topology to
     * turn off, and no amplitude constant to work backwards through.
     *
     * Measured in the plane of the surface, not in space: distance is taken
     * ACROSS the normal, so an oblique blow still leaves a round crater rather
     * than a foreshortened one that fades out on the far side.
     */
    const [nx, ny, nz] = normal;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;
    const r2 = radius * radius;

    const pos = mesh.positions;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const dx = pos[i * 3] - point[0];
      const dy = pos[i * 3 + 1] - point[1];
      const dz = pos[i * 3 + 2] - point[2];
      const along = dx * ux + dy * uy + dz * uz;
      const ax = dx - along * ux, ay = dy - along * uy, az = dz - along * uz;
      const across2 = ax * ax + ay * ay + az * az;
      if (across2 >= r2) continue;
      // Only the side that was struck moves. Without this the far face of a
      // thin plate is pulled up as the near one is pushed in, and the plate
      // migrates instead of denting.
      if (along < -radius) continue;
      const fall = dentFalloff(Math.sqrt(across2) / radius, profile);
      if (fall <= 0) continue;
      const d = depth * fall;
      pos[i * 3] -= ux * d;
      pos[i * 3 + 1] -= uy * d;
      pos[i * 3 + 2] -= uz * d;
    }
    mesh.revision++;
    recomputeNormals(mesh);

    set((state) => ({
      dents: {
        ...state.dents,
        [key]: {
          mesh,
          version: (existing?.version ?? 0) + 1,
          count: (existing?.count ?? 0) + 1,
          deepest: Math.max(existing?.deepest ?? 0, depth),
          holes: existing?.holes ?? 0,
        },
      },
    }));
  },

  pierce: (key, sourceVertices, faces, point, normal, radius) => {
    if (!(radius > 0)) return;

    const existing = get().dents[key];
    const mesh = existing ? existing.mesh : createSculptMesh(sourceVertices, faces);

    const [nx, ny, nz] = normal;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;

    /** How far a point sits from the line the striker went in along. */
    const acrossAxis = (x: number, y: number, z: number): number => {
      const dx = x - point[0], dy = y - point[1], dz = z - point[2];
      const along = dx * ux + dy * uy + dz * uz;
      const ax = dx - along * ux, ay = dy - along * uy, az = dz - along * uz;
      return Math.hypot(ax, ay, az);
    };

    // Draw the rim in first, while the triangles that form it are still there.
    const rim = radius * 1.6;
    const pos = mesh.positions;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const d = acrossAxis(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (d >= rim || d < radius) continue;
      const t = (d - radius) / (rim - radius);
      const pull = radius * 0.25 * (1 - t) * (1 - t);
      pos[i * 3] -= ux * pull;
      pos[i * 3 + 1] -= uy * pull;
      pos[i * 3 + 2] -= uz * pull;
    }

    /*
     * Then drop every triangle whose middle lies inside the bore — on BOTH
     * faces of the sheet, and all the way through, because a hole that only
     * goes through the side that was struck is a dimple with a lid.
     *
     * By centroid rather than by vertex: dropping a triangle if ANY corner is
     * inside eats a ring of extra material and the hole comes out noticeably
     * wider than the thing that made it.
     */
    const kept: number[] = [];
    for (let f = 0; f < mesh.faceCount; f++) {
      const a = mesh.faces[f * 3] * 3, b = mesh.faces[f * 3 + 1] * 3, c = mesh.faces[f * 3 + 2] * 3;
      const mx = (pos[a] + pos[b] + pos[c]) / 3;
      const my = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      const mz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
      if (acrossAxis(mx, my, mz) < radius) continue;
      kept.push(mesh.faces[f * 3], mesh.faces[f * 3 + 1], mesh.faces[f * 3 + 2]);
    }
    // A blow that would remove the whole surface is refused rather than obeyed:
    // a body that vanishes reads as a bug, not as a hole.
    if (kept.length >= 12 && kept.length < mesh.faceCount * 3) {
      mesh.faces.set(kept);
      mesh.faceCount = kept.length / 3;
      mesh.topologyRevision++;
    }
    mesh.revision++;
    recomputeNormals(mesh);

    set((state) => ({
      dents: {
        ...state.dents,
        [key]: {
          mesh,
          version: (existing?.version ?? 0) + 1,
          count: (existing?.count ?? 0) + 1,
          deepest: Math.max(existing?.deepest ?? 0, radius),
          holes: (existing?.holes ?? 0) + 1,
        },
      },
    }));
  },

  clear: () => set({ dents: {} }),
  clearOne: (key) => set((state) => {
    if (!state.dents[key]) return state;
    const next = { ...state.dents };
    delete next[key];
    return { dents: next };
  }),
}));

/**
 * The deformed surface as a scene geom would carry it.
 *
 * Z-up `renderVertices` is what the mesh is kept in, matching the geom it came
 * from; the Y-up `vertices` the MJCF builder reads are derived from it.
 */
export function deformedGeometry(key: DentKey): { vertices: number[]; renderVertices: number[]; faces: number[] } | null {
  const entry = useDentStore.getState().dents[key];
  if (!entry) return null;
  const { mesh } = entry;
  const renderVertices = Array.from(mesh.positions.subarray(0, mesh.vertexCount * 3));
  const vertices = new Array(renderVertices.length);
  for (let i = 0; i < renderVertices.length; i += 3) {
    vertices[i] = renderVertices[i];
    vertices[i + 1] = renderVertices[i + 2];
    vertices[i + 2] = -renderVertices[i + 1];
  }
  return { vertices, renderVertices, faces: Array.from(mesh.faces.subarray(0, mesh.faceCount * 3)) };
}

/** Read without subscribing — for the render loop, which polls by version. */
export const dentedMesh = (key: DentKey): DentedMesh | undefined => useDentStore.getState().dents[key];
