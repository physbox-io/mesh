/**
 * What rides on a piece of cloth (FlexInfo.trims), drawn each frame from where
 * the cloth is: studs, buttons, buckles, beads, a zip's teeth and stitches,
 * each where it was placed between two of the cloth's points and set off
 * across its line; a zip's tape a ribbon through each of its runs and its
 * slider at the run's top; stitches and teeth turned along the line.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';

type Trim = NonNullable<FlexInfo['trims']>[number];

/** A unit trim of each kind, its base on the cloth and its height up +y (turned to the surface normal), its length along +x (along its line), scaled by the trim's size. */
const TRIM_GEOMETRY: Record<string, () => THREE.BufferGeometry> = {
  stud: () => new THREE.ConeGeometry(0.5, 0.55, 10).translate(0, 0.27, 0),
  button: () => new THREE.CylinderGeometry(0.5, 0.5, 0.15, 14).translate(0, 0.08, 0),
  buttonhole: () => new THREE.BoxGeometry(1.1, 0.07, 0.26).translate(0, 0.04, 0),
  bead: () => new THREE.SphereGeometry(0.5, 10, 8).translate(0, 0.4, 0),
  // Low, as a zip's teeth are: half their width tall, they stood through what lay over them.
  // Each side's teeth reach across the middle into the other's gaps.
  zipper: () => new THREE.BoxGeometry(0.55, 0.3, 1.5).translate(0, 0.15, 0),
  // A slider and its pull, hanging down the line: the pull's tab runs along
  // the line from the slider to its ring (across it, it read as a bar apart
  // from the slider).
  slider: () => mergeGeometries([
    new THREE.BoxGeometry(2.4, 0.5, 1.6).translate(0, 0.25, 0),
    new THREE.BoxGeometry(3.0, 0.22, 0.8).translate(-2.4, 0.55, 0),
    new THREE.TorusGeometry(0.42, 0.13, 6, 12).rotateX(Math.PI / 2).translate(-4.3, 0.55, 0),
  ])!,
  // A dash of thread, its length along the line.
  stitch: () => new THREE.BoxGeometry(1, 0.22, 0.22).translate(0, 0.11, 0),
  buckle: () => {
    const outer = new THREE.Shape();
    const w = 0.62, h = 0.46, iw = 0.40, ih = 0.27;
    outer.moveTo(-w, -h); outer.lineTo(w, -h); outer.lineTo(w, h); outer.lineTo(-w, h); outer.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-iw, -ih); hole.lineTo(iw, -ih); hole.lineTo(iw, ih); hole.lineTo(-iw, ih); hole.closePath();
    outer.holes.push(hole);
    return new THREE.ExtrudeGeometry(outer, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2 }).rotateX(-Math.PI / 2);
  },
};
/** Turned along its line rather than up the body. */
const ALONG = new Set(['zipper', 'stitch', 'slider']);
/** Rigid and wider than the cloth's spacing: raised onto the highest cloth under it. */
const RESTS_ON = new Set(['buckle']);
/** A slider is this many teeth across. */
const SLIDER_SCALE = 3;
/** A zip's tape, each side of the line, in teeth. */
const TAPE_HALF = 2.4;

interface Group { kind: string; items: Trim[]; mesh: THREE.InstancedMesh }
interface Tape { items: Trim[]; mesh: THREE.Mesh; geometry: THREE.BufferGeometry }

/** The cloth's trims as meshes, and how to place them from the cloth's points `p` and normals `n` (3 per point) at half-thickness `h`. */
export function useClothTrims(flex: FlexInfo) {
  const built = useMemo(() => {
    const groups: Group[] = [], tapes: Tape[] = [];
    const byKind = new Map<string, Trim[]>();
    for (const t of flex.trims ?? []) {
      (byKind.get(t.kind) ?? byKind.set(t.kind, []).get(t.kind)!).push(t);
      if (t.end) (byKind.get('slider') ?? byKind.set('slider', []).get('slider')!).push(t);
    }
    for (const [kind, items] of byKind) {
      const geom = (TRIM_GEOMETRY[kind] ?? TRIM_GEOMETRY.stud)();
      const c = items[0].rgba;
      const matte = kind === 'button' || kind === 'buttonhole' || kind === 'stitch';
      const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c[0], c[1], c[2]), metalness: matte ? 0 : 0.9, roughness: matte ? 0.6 : 0.3 });
      const mesh = new THREE.InstancedMesh(geom, mat, items.length);
      mesh.frustumCulled = false; mesh.castShadow = kind !== 'stitch';
      // Hidden until placed: a new InstancedMesh is all identity matrices, which
      // draws every trim at full unit size at the origin, a metre-wide box.
      mesh.visible = false;
      groups.push({ kind, items, mesh });
    }
    // A zip's tape through each run of its teeth: the cloth's own colour, darker.
    const runs = new Map<number, Trim[]>();
    for (const t of flex.trims ?? []) if (t.kind === 'zipper' && t.run !== undefined) (runs.get(t.run) ?? runs.set(t.run, []).get(t.run)!).push(t);
    for (const items of runs.values()) {
      if (items.length < 2) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * items.length), 3));
      const index: number[] = [];
      for (let k = 1; k < items.length; k++) { const a = 2 * (k - 1), b = 2 * k; index.push(a, a + 1, b, b, a + 1, b + 1); }
      geometry.setIndex(index);
      const c = flex.rgba;
      const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c[0] * 0.45, c[1] * 0.45, c[2] * 0.45), roughness: 0.85, side: THREE.DoubleSide }));
      mesh.frustumCulled = false; mesh.visible = false;
      tapes.push({ items, mesh, geometry });
    }
    return { groups, tapes };
  }, [flex]);
  useEffect(() => () => {
    for (const { mesh } of built.groups) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    for (const { mesh, geometry } of built.tapes) { geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }, [built]);

  const objects = useMemo(() => [...built.groups.map((g) => g.mesh), ...built.tapes.map((t) => t.mesh)], [built]);

  const place = (p: ArrayLike<number>, n: ArrayLike<number>, h: number) => {
    const at = new THREE.Vector3(), nv = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3();
    // Where a trim is on the cloth, its normal and the way its line runs.
    const frame = (t: Trim) => {
      const a = 3 * t.particle, b = t.toward !== undefined ? 3 * t.toward : a, u = t.t ?? 0;
      at.set(p[a] + (p[b] - p[a]) * u, p[a + 1] + (p[b + 1] - p[a + 1]) * u, p[a + 2] + (p[b + 2] - p[a + 2]) * u);
      nv.set(n[a] + (n[b] - n[a]) * u, n[a + 1] + (n[b + 1] - n[a + 1]) * u, n[a + 2] + (n[b + 2] - n[a + 2]) * u);
      if (nv.lengthSq() < 1e-12) nv.set(0, 0, 1);
      nv.normalize();
      if (t.flip) nv.negate();
      tan.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
      tan.addScaledVector(nv, -tan.dot(nv));
      if (tan.lengthSq() < 1e-14) tan.set(0, 0, 1).addScaledVector(nv, -nv.z);
      if (tan.lengthSq() < 1e-14) tan.set(1, 0, 0);
      tan.normalize();
      side.crossVectors(nv, tan);
      at.addScaledVector(nv, h).addScaledVector(side, t.offset ?? 0);
    };
    const dummy = new THREE.Object3D(), tx = new THREE.Vector3(), tz = new THREE.Vector3(), basis = new THREE.Matrix4();
    for (const { kind, items, mesh } of built.groups) {
      items.forEach((t, i) => {
        frame(t);
        if (ALONG.has(kind)) {
          // Local +x along the line; a slider's pull (its -x) hangs down it,
          // whichever way the line's run goes.
          tx.copy(tan);
          if (kind === 'slider' && tx.z < 0) tx.negate();
          tz.crossVectors(tx, nv);
        } else {
          // Local +z up the body, local +x across it.
          tz.set(0, 0, 1).addScaledVector(nv, -nv.z);
          if (tz.lengthSq() < 1e-6) tz.set(0, 1, 0).addScaledVector(nv, -nv.y);
          tz.normalize();
          tx.crossVectors(nv, tz).normalize();
        }
        basis.makeBasis(tx, nv, tz);
        // Rigid hardware wider than the cloth's spacing rests on the highest
        // cloth under it, not at its one point (the cloth round a clasp stood
        // over it and hid it).
        if (RESTS_ON.has(kind)) {
          const reach2 = (t.size * 0.7) ** 2;
          let lift = 0;
          for (let i = 0; i < p.length; i += 3) {
            const dx = p[i] - at.x, dy = p[i + 1] - at.y, dz = p[i + 2] - at.z, up = dx * nv.x + dy * nv.y + dz * nv.z;
            if (dx * dx + dy * dy + dz * dz - up * up < reach2 && up + h > lift) lift = up + h;
          }
          at.addScaledVector(nv, lift);
        }
        dummy.position.copy(at);
        dummy.quaternion.setFromRotationMatrix(basis);
        dummy.scale.setScalar(kind === 'slider' ? t.size * SLIDER_SCALE : t.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = true;
    }
    // The piece's middle, for which side of its edge its cloth is on.
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
    const np = Math.max(1, p.length / 3);
    cx /= np; cy /= np; cz /= np;
    for (const { items, mesh, geometry } of built.tapes) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      // Each side's tape under its own edge, on the cloth's inner face, from
      // just past the teeth into its cloth: laid both ways about the line,
      // half of it stood in the air once the zip was undone, and laid on the
      // outer face a puffed cloth curving away from it showed it in tatters.
      let into = 0;
      for (const t of items) { frame(t); into += side.x * (cx - at.x) + side.y * (cy - at.y) + side.z * (cz - at.z); }
      const s = into >= 0 ? 1 : -1;
      items.forEach((t, k) => {
        frame(t);
        const w = t.size * TAPE_HALF, out = -0.4 * w * s, inn = 0.8 * w * s;
        at.addScaledVector(nv, -2 * h);
        pos.setXYZ(2 * k, at.x + side.x * inn, at.y + side.y * inn, at.z + side.z * inn);
        pos.setXYZ(2 * k + 1, at.x + side.x * out, at.y + side.y * out, at.z + side.z * out);
      });
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      mesh.visible = true;
    }
  };
  return { objects, place };
}
