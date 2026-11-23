/**
 * What rides on a piece of cloth (FlexInfo.trims), drawn each frame from where
 * the cloth is: studs, buttons, buckles, beads, a zip's teeth and stitches,
 * each where it was placed between two of the cloth's points and set off
 * across its line; a zip's tape a ribbon through each of its runs and its
 * slider at the run's top; stitches and teeth turned along the line.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';
import { useStore } from '../../store/useStore';
import type { DataMirror } from '../../types/sceneLayer';

type Trim = NonNullable<FlexInfo['trims']>[number];

/** A unit trim of each kind, its base on the cloth and its height up +y (turned to the surface normal), its length along +x (along its line), scaled by the trim's size. */
const TRIM_GEOMETRY: Record<string, () => THREE.BufferGeometry> = {
  stud: () => new THREE.ConeGeometry(0.5, 0.55, 10).translate(0, 0.27, 0),
  // A low dome on a thin rim, as a button is, its rim reaching a little down
  // into the cloth: flat on its base, a cap's button stood on top of the
  // point its gores meet in, and their tips showed under it all round. Below
  // the cloth on a shirt, its rim is out of sight.
  button: () => {
    const prof = [new THREE.Vector2(0, -0.25), new THREE.Vector2(0.5, -0.25), new THREE.Vector2(0.5, 0.07)];
    for (let k = 1; k <= 6; k++) { const a = (k / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(0.5 * Math.cos(a), 0.07 + 0.25 * Math.sin(a))); }
    return new THREE.LatheGeometry(prof, 16);
  },
  buttonhole: () => new THREE.BoxGeometry(1.1, 0.07, 0.26).translate(0, 0.04, 0),
  bead: () => new THREE.SphereGeometry(0.5, 10, 8).translate(0, 0.4, 0),
  // Low, as a zip's teeth are: half their width tall, they stood through what lay over them.
  // Each side's teeth reach across the middle into the other's gaps.
  zipper: () => new THREE.BoxGeometry(0.55, 0.3, 1.5).translate(0, 0.15, 0),
  // A slider and its pull, hanging down the line: the pull's tab runs along
  // the line from the slider to its ring (across it, it read as a bar apart
  // from the slider).
  slider: () => {
    const parts = [
      new THREE.BoxGeometry(2.4, 0.5, 1.6).translate(0, 0.25, 0),
      new THREE.BoxGeometry(3.0, 0.22, 0.8).translate(-2.4, 0.55, 0),
      new THREE.TorusGeometry(0.42, 0.13, 6, 12).rotateX(Math.PI / 2).translate(-4.3, 0.55, 0),
    ];
    const merged = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    return merged;
  },
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
/** Rigid and wider than the cloth's spacing: raised onto the highest cloth under it (a cap's button onto the tips of its gores, not among them). */
const RESTS_ON = new Set(['buckle', 'button']);
/** A slider is this many teeth across. */
const SLIDER_SCALE = 3;
/** A zip's tape, each side of the line, in teeth. */
const TAPE_HALF = 2.4;

/** Marked for upload, and shown: the trims' meshes are built once and placed each frame, after render. */
const changed = (a: { needsUpdate: boolean }) => { a.needsUpdate = true; };
const shown = (o: THREE.Object3D) => { o.visible = true; };

interface Group { kind: string; items: Trim[]; mesh: THREE.InstancedMesh }
interface Tape { items: Trim[]; mesh: THREE.Mesh; geometry: THREE.BufferGeometry }

export interface BuiltClothTrims {
  groups: Group[];
  tapes: Tape[];
  runTeeth: Map<number, Trim[]>;
}

const trimTemplateCache = new Map<string, THREE.BufferGeometry>();
function cloneTrimGeometry(kind: string): THREE.BufferGeometry {
  const key = kind in TRIM_GEOMETRY ? kind : 'stud';
  let tpl = trimTemplateCache.get(key);
  if (!tpl) {
    tpl = TRIM_GEOMETRY[key]();
    trimTemplateCache.set(key, tpl);
  }
  return tpl.clone();
}

export function buildClothTrims(flex: FlexInfo): BuiltClothTrims {
  const groups: Group[] = [], tapes: Tape[] = [];
  const byKind = new Map<string, Trim[]>();
  for (const t of flex.trims ?? []) {
    (byKind.get(t.kind) ?? byKind.set(t.kind, []).get(t.kind)!).push(t);
    if (t.end) (byKind.get('slider') ?? byKind.set('slider', []).get('slider')!).push(t);
  }
  for (const [kind, items] of byKind) {
    if (items.length === 0) continue;
    const geom = cloneTrimGeometry(kind);
    const c = items[0].rgba;
    const matte = kind === 'button' || kind === 'buttonhole' || kind === 'stitch';
    const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c[0], c[1], c[2]), metalness: matte ? 0 : 0.9, roughness: matte ? 0.6 : 0.3 });
    const mesh = new THREE.InstancedMesh(geom, mat, items.length);
    mesh.frustumCulled = false; mesh.castShadow = kind !== 'stitch';
    // Decorative stitches/teeth/buttons are skipped in STL/3MF exports so
    // exporting a scene or garment doesn't emit hundreds of tiny `part_N` meshes.
    mesh.userData = { skipExport: true, ...(kind === 'stitch' ? { tracedTrim: true } : {}) };
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
    mesh.userData = { skipExport: true, tracedTrim: true };
    tapes.push({ items, mesh, geometry });
  }
  // A zip's slider rides its run as it is done up and undone (the frame's
  // clothZips): to the top tooth done up, or the bottom one when undone.
  const runTeeth = new Map<number, Trim[]>();
  for (const t of flex.trims ?? []) if (t.kind === 'zipper' && t.zip && t.run !== undefined) (runTeeth.get(t.run) ?? runTeeth.set(t.run, []).get(t.run)!).push(t);
  for (const list of runTeeth.values()) list.sort((a, b) => a.zip!.at - b.zip!.at);
  return { groups, tapes, runTeeth };
}

// Module-level scratch vectors & tape cache reused across frames (zero per-frame allocations).
const _at = new THREE.Vector3();
const _nv = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _side = new THREE.Vector3();
const _tx = new THREE.Vector3();
const _tz = new THREE.Vector3();
let _tapeScratch = new Float64Array(0);

function evalTrimFrame(t: Trim, p: ArrayLike<number>, n: ArrayLike<number>, h: number) {
  const a = 3 * t.particle, b = t.toward !== undefined ? 3 * t.toward : a, u = t.t ?? 0;
  _at.set(p[a] + (p[b] - p[a]) * u, p[a + 1] + (p[b + 1] - p[a + 1]) * u, p[a + 2] + (p[b + 2] - p[a + 2]) * u);
  _nv.set(n[a] + (n[b] - n[a]) * u, n[a + 1] + (n[b + 1] - n[a + 1]) * u, n[a + 2] + (n[b + 2] - n[a + 2]) * u);
  if (_nv.lengthSq() < 1e-12) _nv.set(0, 0, 1);
  _nv.normalize();
  if (t.flip) _nv.negate();
  _tan.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  _tan.addScaledVector(_nv, -_tan.dot(_nv));
  if (_tan.lengthSq() < 1e-14) _tan.set(0, 0, 1).addScaledVector(_nv, -_nv.z);
  if (_tan.lengthSq() < 1e-14) _tan.set(1, 0, 0);
  _tan.normalize();
  _side.crossVectors(_nv, _tan);
  _at.addScaledVector(_nv, h).addScaledVector(_side, t.offset ?? 0);
}

/** Place `cur` trims on cloth vertices `p` / normals `n`, returning `true` only when any matrix or vertex changed. */
export function placeClothTrims(
  cur: BuiltClothTrims,
  flexName: string,
  p: ArrayLike<number>,
  n: ArrayLike<number>,
  h: number,
  zips?: DataMirror['clothZips'],
): boolean {
  if (cur.groups.length === 0 && cur.tapes.length === 0) return false;
  let anyChanged = false;
  const cloth = flexName.slice(0, flexName.lastIndexOf('__'));
  for (let gi = 0; gi < cur.groups.length; gi++) {
    const { kind, items, mesh } = cur.groups[gi];
    if (mesh.count === 0 || items.length === 0) continue;
    const matArr = mesh.instanceMatrix.array as Float32Array;
    let groupMoved = !mesh.visible;
    const isAlong = ALONG.has(kind);
    const isRestsOn = RESTS_ON.has(kind);
    const isSlider = kind === 'slider';
    for (let i = 0; i < items.length; i++) {
      let t = items[i];
      if (isSlider && t.run !== undefined && t.zip && zips) {
        const teeth = cur.runTeeth.get(t.run);
        if (teeth?.length) {
          let z: NonNullable<DataMirror['clothZips']>[number] | undefined;
          for (let zi = 0; zi < zips.length; zi++) {
            if (zips[zi].cloth === cloth && zips[zi].trim === t.zip.trim) { z = zips[zi]; break; }
          }
          if (z) {
            let atTooth = teeth[0];
            const lim = z.fastened + 1e-9;
            for (let ti = 0; ti < teeth.length; ti++) if (teeth[ti].zip!.at <= lim) atTooth = teeth[ti];
            t = atTooth;
          }
        }
      }
      evalTrimFrame(t, p, n, h);
      if (isAlong) {
        // Local +x along the line; a slider's pull (its -x) hangs down it,
        // whichever way the line's run goes.
        _tx.copy(_tan);
        if (isSlider && _tx.z < 0) _tx.negate();
        _tz.crossVectors(_tx, _nv);
      } else {
        // Local +z up the body, local +x across it.
        _tz.set(0, 0, 1).addScaledVector(_nv, -_nv.z);
        if (_tz.lengthSq() < 1e-6) _tz.set(0, 1, 0).addScaledVector(_nv, -_nv.y);
        _tz.normalize();
        _tx.crossVectors(_nv, _tz).normalize();
      }
      // Rigid hardware wider than the cloth's spacing rests on the highest
      // cloth under it, not at its one point (the cloth round a clasp stood
      // over it and hid it).
      if (isRestsOn) {
        const reach2 = (t.size * 0.7) ** 2;
        const ax = _at.x, ay = _at.y, az = _at.z;
        const nx = _nv.x, ny = _nv.y, nz = _nv.z;
        let lift = 0;
        for (let j = 0; j < p.length; j += 3) {
          const dx = p[j] - ax, dy = p[j + 1] - ay, dz = p[j + 2] - az, up = dx * nx + dy * ny + dz * nz;
          if (dx * dx + dy * dy + dz * dz - up * up < reach2 && up + h > lift) lift = up + h;
        }
        _at.addScaledVector(_nv, lift);
      }
      // Write column-major scaled orthonormal basis + translation directly (skips Quaternion round-trip).
      const sc = isSlider ? t.size * SLIDER_SCALE : t.size;
      const base = i * 16;
      const e0 = Math.fround(_tx.x * sc), e1 = Math.fround(_tx.y * sc), e2 = Math.fround(_tx.z * sc);
      const e4 = Math.fround(_nv.x * sc), e5 = Math.fround(_nv.y * sc), e6 = Math.fround(_nv.z * sc);
      const e8 = Math.fround(_tz.x * sc), e9 = Math.fround(_tz.y * sc), e10 = Math.fround(_tz.z * sc);
      const e12 = Math.fround(_at.x), e13 = Math.fround(_at.y), e14 = Math.fround(_at.z);
      if (
        matArr[base] !== e0 || matArr[base + 1] !== e1 || matArr[base + 2] !== e2 || matArr[base + 3] !== 0 ||
        matArr[base + 4] !== e4 || matArr[base + 5] !== e5 || matArr[base + 6] !== e6 || matArr[base + 7] !== 0 ||
        matArr[base + 8] !== e8 || matArr[base + 9] !== e9 || matArr[base + 10] !== e10 || matArr[base + 11] !== 0 ||
        matArr[base + 12] !== e12 || matArr[base + 13] !== e13 || matArr[base + 14] !== e14 || matArr[base + 15] !== 1
      ) {
        matArr[base] = e0; matArr[base + 1] = e1; matArr[base + 2] = e2; matArr[base + 3] = 0;
        matArr[base + 4] = e4; matArr[base + 5] = e5; matArr[base + 6] = e6; matArr[base + 7] = 0;
        matArr[base + 8] = e8; matArr[base + 9] = e9; matArr[base + 10] = e10; matArr[base + 11] = 0;
        matArr[base + 12] = e12; matArr[base + 13] = e13; matArr[base + 14] = e14; matArr[base + 15] = 1;
        groupMoved = true;
      }
    }
    if (groupMoved) {
      changed(mesh.instanceMatrix);
      shown(mesh);
      anyChanged = true;
    }
  }
  if (cur.tapes.length > 0) {
    // The piece's middle, for which side of its edge its cloth is on.
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
    const np = Math.max(1, p.length / 3);
    cx /= np; cy /= np; cz /= np;
    for (let ti = 0; ti < cur.tapes.length; ti++) {
      const { items, mesh, geometry } = cur.tapes[ti];
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      let tapeMoved = !mesh.visible;
      const need = items.length * 9;
      if (_tapeScratch.length < need) _tapeScratch = new Float64Array(need);
      // Single frame evaluation per tooth (caches at, nv, side for both sign test and vertex write).
      let into = 0;
      for (let k = 0; k < items.length; k++) {
        evalTrimFrame(items[k], p, n, h);
        into += _side.x * (cx - _at.x) + _side.y * (cy - _at.y) + _side.z * (cz - _at.z);
        const o = 9 * k;
        _tapeScratch[o] = _at.x - 2 * h * _nv.x;
        _tapeScratch[o + 1] = _at.y - 2 * h * _nv.y;
        _tapeScratch[o + 2] = _at.z - 2 * h * _nv.z;
        _tapeScratch[o + 3] = _side.x;
        _tapeScratch[o + 4] = _side.y;
        _tapeScratch[o + 5] = _side.z;
      }
      const s = into >= 0 ? 1 : -1;
      for (let k = 0; k < items.length; k++) {
        const w = items[k].size * TAPE_HALF, out = -0.4 * w * s, inn = 0.8 * w * s;
        const o = 9 * k;
        const ax = _tapeScratch[o], ay = _tapeScratch[o + 1], az = _tapeScratch[o + 2];
        const sx = _tapeScratch[o + 3], sy = _tapeScratch[o + 4], sz = _tapeScratch[o + 5];
        const x0 = Math.fround(ax + sx * inn), y0 = Math.fround(ay + sy * inn), z0 = Math.fround(az + sz * inn);
        const x1 = Math.fround(ax + sx * out), y1 = Math.fround(ay + sy * out), z1 = Math.fround(az + sz * out);
        const o0 = 6 * k, o1 = 6 * k + 3;
        if (arr[o0] !== x0 || arr[o0 + 1] !== y0 || arr[o0 + 2] !== z0 || arr[o1] !== x1 || arr[o1 + 1] !== y1 || arr[o1 + 2] !== z1) {
          tapeMoved = true;
        }
        arr[o0] = x0; arr[o0 + 1] = y0; arr[o0 + 2] = z0;
        arr[o1] = x1; arr[o1 + 1] = y1; arr[o1 + 2] = z1;
      }
      if (tapeMoved) {
        changed(pos);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        shown(mesh);
        anyChanged = true;
      }
    }
  }
  return anyChanged;
}

/** The cloth's trims as meshes, and how to place them from the cloth's points `p` and normals `n` (3 per point) at half-thickness `h`. */
export function useClothTrims(flex: FlexInfo, liveRgba?: number[]) {
  const built = useMemo(() => buildClothTrims(flex), [flex]);
  useEffect(() => {
    const c = liveRgba ?? flex.rgba;
    for (const { mesh } of built.tapes) {
      (mesh.material as THREE.MeshPhysicalMaterial).color.setRGB(c[0] * 0.45, c[1] * 0.45, c[2] * 0.45);
    }
  }, [built, liveRgba, flex.rgba]);
  useEffect(() => () => {
    for (const { mesh } of built.groups) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    for (const { mesh, geometry } of built.tapes) { geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }, [built]);

  const objects = useMemo(() => [...built.groups.map((g) => g.mesh), ...built.tapes.map((t) => t.mesh)], [built]);

  // The meshes as built, reached through a ref when placed (after render):
  // what useMemo returns is not to be written to after render. Set in a
  // layout effect, so a rebuild's are in place before the cloth's own layout
  // effect places them.
  const builtRef = useRef(built);
  useLayoutEffect(() => { builtRef.current = built; }, [built]);

  const place = (p: ArrayLike<number>, n: ArrayLike<number>, h: number, zips?: DataMirror['clothZips']): boolean => {
    const resolvedZips = zips ?? (useStore.getState().data as DataMirror | null)?.clothZips;
    return placeClothTrims(builtRef.current, flex.name, p, n, h, resolvedZips);
  };
  return { objects, place };
}
