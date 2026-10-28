// ---------------------------------------------------------------------------
// Moving, turning and scaling mesh geoms
//
// A mesh geom's shape is its vertices, so a body's move, turn or scale has to
// be carried into them; and a static mesh made movable has to become a
// dynamic one (drawn from renderVertices at the body's transform).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom } from '../types/scene';
import type { WorkingNode } from './sceneClone';

// Returns true if every geom on a node is a mesh (so pos/euler are meaningless for rendering)
export const isAllMeshNode = (node: SceneNode) =>
  node.geoms?.length > 0 && node.geoms.every((g: SceneGeom) => g.type === 'mesh');

// Type predicates so that what they check — that the mesh arrays are there —
// is known to the code that then reads them, rather than re-asserted at
// every use.
export const isDynamicMesh = (g: SceneGeom): g is SceneGeom & { renderVertices: number[] } =>
  g.type === 'mesh' && !!g.dynamic && !!g.renderVertices;

export const isStaticMesh = (g: SceneGeom): g is SceneGeom & { vertices: number[] } =>
  g.type === 'mesh' && !g.dynamic && !!g.vertices;

// A mesh geom authored (by hand, by a preset file, or over MCP) without an
// explicit dynamic:true sits in the static render path forever, even once a
// joint makes the body actually move: static meshes render from vertices
// baked once into world space and never re-read data.xpos/data.xmat, so the
// body can drag and simulate correctly while looking frozen in place. Any
// path that gives a node its first joint should flip its mesh geoms over to
// the dynamic path here, deriving renderVertices from vertices (a plain
// Y-up-to-MuJoCo-Z-up swap, (x,y,z)->(x,-z,y)) rather than requiring the
// caller to have supplied it — see californiaRelief.ts / megaBustStudio.ts,
// both of which hit exactly this before this function existed.
export const toRenderVertices = (vertices: number[]): number[] => {
  const out = new Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i];
    out[i + 1] = -vertices[i + 2];
    out[i + 2] = vertices[i + 1];
  }
  return out;
};

export const promoteMeshGeomsToDynamic = (node: SceneNode) => {
  for (const g of node.geoms || []) {
    if (g.type !== 'mesh' || g.dynamic) continue;
    g.dynamic = true;
    if (!g.renderVertices && Array.isArray(g.vertices)) {
      g.renderVertices = toRenderVertices(g.vertices);
    }
  }
};

// The other half of the same moment: a body that has just been made movable
// has to be able to touch the world.
//
// Scenery is routinely authored with contype:0/conaffinity:0 — a tree, a
// cartpole rail, a windmill tower. That is correct while the body is welded in
// place, and it costs nothing to collide against something that cannot move.
// Give that same body a joint and it can now only do one thing: accelerate
// through the floor forever, which is what the oak tree preset did the first
// time anyone switched it to 6-DOF.
//
// Only when NOTHING in the body collides, and only at the moment a joint
// arrives. A body with a collider already (a trunk cylinder under visual-only
// meshes, say) has been given one deliberately, and so has a body that ships
// jointed and ghosted — which is most of a mechanism: gear teeth that mesh by
// engine rather than by contact, a Newton's cradle rod, a rotor blade. Those
// pass through here untouched, because they never make this transition.
export const restoreCollisionWhenMadeMovable = (node: SceneNode) => {
  const geoms = node.geoms || [];
  const collides = (g: SceneGeom) =>
    g.role !== 'visual' && !(g.contype === 0 && g.conaffinity === 0);
  if (geoms.length === 0 || geoms.some(collides)) return;
  for (const g of geoms) {
    if (g.role === 'visual') continue;
    delete g.contype;
    delete g.conaffinity;
  }
};

// The three call sites above (properties panel, MCP UPDATE_OBJECT, MCP
// build/update-scene) all catch the trap at the moment a joint is *added* to
// a node — but a hand-authored preset file can also just ship a body that is
// ALREADY jointed with a mesh geom missing dynamic:true, with no "joint was
// added" event for any of those to hook. Loading a scene graph sweeps for
// that case once, up front, covering every entry point at once instead of
// requiring yet another call site to remember this.
export const promoteJointedMeshGeomsDeep = (nodes: SceneNode[], ancestorJointed = false) => {
  if (!nodes) return;
  for (const node of nodes) {
    const jointed = ancestorJointed || (node.joints && node.joints.length > 0);
    if (jointed) promoteMeshGeomsToDynamic(node);
    promoteJointedMeshGeomsDeep(node.children, jointed);
  }
};

// Apply a function to flat vertex array in-place
export const mapVerts = (v: number[], fn: (x: number, y: number, z: number) => [number,number,number]) => {
  for (let i = 0; i < v.length; i += 3) {
    const [nx, ny, nz] = fn(v[i], v[i+1], v[i+2]);
    v[i] = nx; v[i+1] = ny; v[i+2] = nz;
  }
  return v;
};

// Translate static mesh geom vertices (Y-up world space)
export const translateMeshGeoms = (node: SceneNode, dx: number, dy: number, dz: number) => {
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      g.vertices = mapVerts([...g.vertices], (x,y,z) => [x+dx, y+dy, z+dz]);
    }
    // Dynamic meshes are positioned via body pos — no vertex transform needed
  }
};

// Rotate static mesh geom vertices around axis (degrees) about their centroid (or origin)
// Dynamic mesh renderVertices are centroid-local
export const rotateMeshGeomsAbsolute = (node: WorkingNode, euler: [number, number, number], rotateAroundCOM = true) => {
  const [rx, ry, rz] = euler;
  const radX = (rx * Math.PI) / 180;
  const radY = (ry * Math.PI) / 180;
  const radZ = (rz * Math.PI) / 180;

  // Z-up rotation matrix (Euler order: Z * Y * X) for renderVertices and node.pos
  const matXz = new THREE.Matrix4().makeRotationX(radX);
  const matYz = new THREE.Matrix4().makeRotationY(radY);
  const matZz = new THREE.Matrix4().makeRotationZ(radZ);
  const rotMatZup = new THREE.Matrix4().multiplyMatrices(matZz, new THREE.Matrix4().multiplyMatrices(matYz, matXz));

  // Equivalent rotation in Three.js Y-up space where (x, y, z) maps to Z-up (x, -z, y):
  // T^-1 * Rz(radZ) * Ry(radY) * Rx(radX) * T = Ry(radZ) * Rz(-radY) * Rx(radX)
  const matXy = new THREE.Matrix4().makeRotationX(radX);
  const matYy = new THREE.Matrix4().makeRotationZ(-radY);
  const matZy = new THREE.Matrix4().makeRotationY(radZ);
  const rotMatYup = new THREE.Matrix4().multiplyMatrices(matZy, new THREE.Matrix4().multiplyMatrices(matYy, matXy));

  const v = new THREE.Vector3();

  for (const g of node.geoms) {
    if (g.type === 'mesh' && Array.isArray(g.vertices) && g.vertices.length > 0) {
      if (!g.baseVertices) {
        g.baseVertices = [...g.vertices];
      }
      const baseVerts = g.baseVertices as number[];
      const n = baseVerts.length / 3;

      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < baseVerts.length; i += 3) {
        cx += baseVerts[i];
        cy += baseVerts[i + 1];
        cz += baseVerts[i + 2];
      }
      cx /= n; cy /= n; cz /= n;

      const newVerts = new Array(baseVerts.length);

      for (let i = 0; i < baseVerts.length; i += 3) {
        if (rotateAroundCOM || g.dynamic) {
          v.set(baseVerts[i] - cx, baseVerts[i + 1] - cy, baseVerts[i + 2] - cz);
          v.applyMatrix4(rotMatYup);
          newVerts[i] = v.x + cx;
          newVerts[i + 1] = v.y + cy;
          newVerts[i + 2] = v.z + cz;
        } else {
          v.set(baseVerts[i], baseVerts[i + 1], baseVerts[i + 2]);
          v.applyMatrix4(rotMatYup);
          newVerts[i] = v.x;
          newVerts[i + 1] = v.y;
          newVerts[i + 2] = v.z;
        }
      }
      g.vertices = newVerts;
    }

    if (isDynamicMesh(g)) {
      if (!g.baseRenderVertices) {
        g.baseRenderVertices = [...g.renderVertices];
      }
      const baseRender = g.baseRenderVertices as number[];

      const newRender = new Array(baseRender.length);
      for (let i = 0; i < baseRender.length; i += 3) {
        v.set(baseRender[i], baseRender[i + 1], baseRender[i + 2]);
        v.applyMatrix4(rotMatZup);
        newRender[i] = v.x;
        newRender[i + 1] = v.y;
        newRender[i + 2] = v.z;
      }
      g.renderVertices = newRender;
    }
  }

  if (node.geoms.some(isDynamicMesh) && node.pos) {
    if (!node.basePos) node.basePos = [...node.pos];
    if (!rotateAroundCOM) {
      const bp = node.basePos;
      v.set(bp[0], bp[1], bp[2]).applyMatrix4(rotMatZup);
      node.pos = [v.x, v.y, v.z];
    } else {
      node.pos = [...node.basePos];
    }
  }
};

// Scale mesh geoms about their centroid (uniformly or per-axis).
//
// The factors are world (Z-up) axes, the ones the inspector's position and
// rotation rows use. renderVertices are already in that space; the collision
// vertices are Y-up, where (x, y, z) maps to Z-up (x, -z, y), so their factors
// have to be permuted to match. Uniform scaling never noticed the difference,
// and per-axis scaling would silently stretch collision and render geometry
// along different axes without it.
export const scaleMeshGeoms = (node: Pick<SceneNode, 'geoms'>, sx: number, sy: number = sx, sz: number = sx) => {
  const scaleAboutCentroid = (vertices: number[], fx: number, fy: number, fz: number) => {
    const v = [...vertices];
    let cx = 0, cy = 0, cz = 0;
    const n = v.length / 3;
    for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i+1]; cz += v[i+2]; }
    cx /= n; cy /= n; cz /= n;
    return mapVerts(v, (x,y,z) => [cx+(x-cx)*fx, cy+(y-cy)*fy, cz+(z-cz)*fz]);
  };
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      g.vertices = scaleAboutCentroid(g.vertices as number[], sx, sz, sy);
    }
    if (isDynamicMesh(g)) {
      // renderVertices are raw Z-up — scale about origin
      g.renderVertices = mapVerts([...g.renderVertices], (x,y,z) => [x*sx, y*sy, z*sz]);
      // Also scale the MuJoCo collision vertices (Y-up world space) about their centroid
      if (g.vertices) g.vertices = scaleAboutCentroid(g.vertices as number[], sx, sz, sy);
    }
  }
};
