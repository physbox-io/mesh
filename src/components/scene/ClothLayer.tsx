/**
 * Draws cloth (utils/cloth): one closed manifold slab per piece, its vertices
 * read each frame from the worker's flexvert_xpos. Mounted inside SceneLayer's
 * Z-up group, so MuJoCo's world coordinates go in as they are.
 *
 * The slab has outward CCW triangles on both faces plus boundary side walls, so
 * `THREE.FrontSide` draws both the inside and outside of the cloth cleanly while
 * culling interior back-faces.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useCapture } from '../../store/captureStore';
import type { SceneGraph, SceneNode } from '../../types/scene';
import type { ClothMaterialName } from '../../types/cloth';
import type { DataMirror, FrameFlagWindow, ModelMirror } from '../../types/sceneLayer';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';
import { CLOTH_MATERIALS } from '../../utils/cloth/clothMesh';
import { garmentSettings } from '../../utils/cloth/garments';
import { acquirePrintTexture } from './clothPrintTexture';
import { useClothSculpt } from './useClothSculpt';
import { useClothGrab } from './useClothGrab';
import { weaveTexture } from './clothWeaveTexture';
import { useClothTrims } from './clothTrims';

/** Stitched points further apart than this are still being sewn, and drawn where they are. */
const MEET = 0.03;

/** How each fabric catches the light. */
const FABRIC_LOOK: Record<ClothMaterialName, { roughness: number; clearcoat?: number; sheen?: number }> = {
  jersey: { roughness: 0.95, sheen: 0.3 },
  rib: { roughness: 0.95, sheen: 0.35 },
  spandex: { roughness: 0.45, clearcoat: 0.15, sheen: 0.4 },
  woven: { roughness: 0.85 },
  canvas: { roughness: 1 },
  ripstop: { roughness: 0.35, clearcoat: 0.12, sheen: 0.25 },
  shadeCloth: { roughness: 0.9 },
  denim: { roughness: 0.9 },
  leather: { roughness: 0.45, clearcoat: 0.5 },
  taffeta: { roughness: 0.3, sheen: 0.5 },
  velvet: { roughness: 1, sheen: 1 },
};

interface Props {
  model: ModelMirror | null;
  data: DataMirror | null;
  sceneGraph: SceneGraph | null;
}

/** Cloth bodies by name, with ancestor visibility resolved. */
function clothNodes(
  nodes: SceneNode[] | undefined,
  hidden: Set<string>,
  ancestorHidden = false,
  out = new Map<string, { node: SceneNode; hidden: boolean }>(),
) {
  for (const n of nodes ?? []) {
    const isHidden = ancestorHidden || hidden.has(n.id);
    if (n.cloth) out.set(n.name || n.id, { node: n, hidden: isHidden });
    clothNodes(n.children, hidden, isHidden, out);
  }
  return out;
}

/** Live visual rgba from `node.cloth` so colour edits never require a worker rebuild. */
function livePieceRgba(node: SceneNode | undefined, flex: FlexInfo, pieceName: string): number[] {
  if (node?.cloth?.garment) {
    const att = node.cloth.garment.attached?.find((a) => a.name === pieceName);
    if (att?.rgba) return att.rgba;
    const c = garmentSettings(node.cloth.garment).rgba;
    return pieceName.startsWith('back') ? [c[0] * 0.85, c[1] * 0.85, c[2] * 0.85, c[3] ?? 1] : c;
  }
  if (node?.cloth?.pieces?.length) {
    return node.cloth.pieces.find((p) => p.name === pieceName)?.rgba ?? flex.rgba;
  }
  return flex.rgba;
}

/** Physical half-thickness (metres) of a cloth piece from its real fabric material (`0.1 mm` ripstop .. `0.8 mm` velvet). */
// eslint-disable-next-line react-refresh/only-export-components
export function clothPieceHalfThickness(flex: Pick<FlexInfo, 'material'>, node?: SceneNode): number {
  const overrideT = node?.cloth?.materialOverrides?.thickness;
  const matT = CLOTH_MATERIALS[flex.material ?? 'jersey']?.thickness ?? 0.0008;
  return Math.max(5e-5, (overrideT ?? matT) * 0.5);
}

/** Synced cloth slab geometry from `src` (`flexvert_xpos`), returning `true` only when vertex positions changed. */
// eslint-disable-next-line react-refresh/only-export-components
export function syncClothSlabGeometry(
  g: THREE.BufferGeometry,
  flex: FlexInfo,
  src: ArrayLike<number>,
  sewn: [number, number[]][],
  scratch: { p: Float32Array; n: Float32Array; maxH?: Float32Array },
  halfThickness = clothPieceHalfThickness(flex),
): boolean {
  const N = flex.vertnum;
  if (src.length < 3 * (flex.vertadr + N)) return false;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const { p, n } = scratch;
  if (scratch.maxH?.length !== N) scratch.maxH = new Float32Array(N);
  const maxH = scratch.maxH;
  const o = 3 * flex.vertadr;
  for (let i = 0; i < 3 * N; i++) p[i] = src[o + i];
  // A stitched vertex is drawn where it and its partners meet, once they
  // nearly have: before (pieces laid out apart, still being sewn) each is
  // drawn where it is, or every seam edge was dragged to the midpoint.
  const meet2 = MEET * MEET;
  for (let si = 0; si < sewn.length; si++) {
    const entry = sewn[si], v = entry[0], ps = entry[1], v3 = 3 * v;
    const vx = src[o + v3], vy = src[o + v3 + 1], vz = src[o + v3 + 2];
    let far = false;
    for (let pi = 0; pi < ps.length; pi++) {
      const q3 = 3 * ps[pi];
      const dx = src[q3] - vx, dy = src[q3 + 1] - vy, dz = src[q3 + 2] - vz;
      if (dx * dx + dy * dy + dz * dz > meet2) { far = true; break; }
    }
    if (far) continue;
    let sx = vx, sy = vy, sz = vz;
    for (let pi = 0; pi < ps.length; pi++) {
      const q3 = 3 * ps[pi];
      sx += src[q3]; sy += src[q3 + 1]; sz += src[q3 + 2];
    }
    const inv = 1 / (ps.length + 1);
    p[v3] = sx * inv; p[v3 + 1] = sy * inv; p[v3 + 2] = sz * inv;
  }
  // Area-weighted normals of the middle surface; the two faces half the thickness along them.
  const prevNormal = g.attributes.normal as THREE.BufferAttribute | undefined;
  n.fill(0);
  const elems = flex.elems, nElems = elems.length;
  for (let t = 0; t < nElems; t += 3) {
    const a = 3 * elems[t], b = 3 * elems[t + 1], c = 3 * elems[t + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  // Normalize middle-surface vertex normals in place and clamp `h_i` across curved folds so
  // `(p_j - p_i + (h_j n_j - h_i n_i)) · n_face` never lets the bottom slab face cross the top face.
  for (let i = 0; i < N; i++) {
    const i3 = 3 * i, nx = n[i3], ny = n[i3 + 1], nz = n[i3 + 2];
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const invL = 1 / l;
    n[i3] = nx * invL;
    n[i3 + 1] = ny * invL;
    n[i3 + 2] = nz * invL;
    maxH[i] = halfThickness;
  }
  for (let t = 0; t < nElems; t += 3) {
    const ia = elems[t], ib = elems[t + 1], ic = elems[t + 2];
    const a3 = 3 * ia, b3 = 3 * ib, c3 = 3 * ic;
    // Edge (ia, ib)
    if (n[a3] * n[b3] + n[a3 + 1] * n[b3 + 1] + n[a3 + 2] * n[b3 + 2] < 0.995) {
      const dx = p[b3] - p[a3], dy = p[b3 + 1] - p[a3 + 1], dz = p[b3 + 2] - p[a3 + 2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 > 1e-10) {
        const pinch = Math.abs(dx * (n[b3] - n[a3]) + dy * (n[b3 + 1] - n[a3 + 1]) + dz * (n[b3 + 2] - n[a3 + 2]));
        if (pinch > 1e-6) {
          const safeH = Math.max(2e-5, (0.35 * len2) / pinch);
          if (safeH < maxH[ia]) maxH[ia] = safeH;
          if (safeH < maxH[ib]) maxH[ib] = safeH;
        }
      }
    }
    // Edge (ib, ic)
    if (n[b3] * n[c3] + n[b3 + 1] * n[c3 + 1] + n[b3 + 2] * n[c3 + 2] < 0.995) {
      const dx = p[c3] - p[b3], dy = p[c3 + 1] - p[b3 + 1], dz = p[c3 + 2] - p[b3 + 2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 > 1e-10) {
        const pinch = Math.abs(dx * (n[c3] - n[b3]) + dy * (n[c3 + 1] - n[b3 + 1]) + dz * (n[c3 + 2] - n[b3 + 2]));
        if (pinch > 1e-6) {
          const safeH = Math.max(2e-5, (0.35 * len2) / pinch);
          if (safeH < maxH[ib]) maxH[ib] = safeH;
          if (safeH < maxH[ic]) maxH[ic] = safeH;
        }
      }
    }
    // Edge (ic, ia)
    if (n[c3] * n[a3] + n[c3 + 1] * n[a3 + 1] + n[c3 + 2] * n[a3 + 2] < 0.995) {
      const dx = p[a3] - p[c3], dy = p[a3 + 1] - p[c3 + 1], dz = p[a3 + 2] - p[c3 + 2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 > 1e-10) {
        const pinch = Math.abs(dx * (n[a3] - n[c3]) + dy * (n[a3 + 1] - n[c3 + 1]) + dz * (n[a3 + 2] - n[c3 + 2]));
        if (pinch > 1e-6) {
          const safeH = Math.max(2e-5, (0.35 * len2) / pinch);
          if (safeH < maxH[ic]) maxH[ic] = safeH;
          if (safeH < maxH[ia]) maxH[ia] = safeH;
        }
      }
    }
  }
  let moved = !prevNormal;
  const N3 = 3 * N;
  for (let i = 0; i < N; i++) {
    const hi = maxH[i], i3 = 3 * i, b3 = i3 + N3;
    const dx = n[i3] * hi, dy = n[i3 + 1] * hi, dz = n[i3 + 2] * hi;
    const tx = Math.fround(p[i3] + dx), ty = Math.fround(p[i3 + 1] + dy), tz = Math.fround(p[i3 + 2] + dz);
    const bx = Math.fround(p[i3] - dx), by = Math.fround(p[i3 + 1] - dy), bz = Math.fround(p[i3 + 2] - dz);
    if (arr[i3] !== tx || arr[i3 + 1] !== ty || arr[i3 + 2] !== tz || arr[b3] !== bx || arr[b3 + 1] !== by || arr[b3 + 2] !== bz) moved = true;
    arr[i3] = tx; arr[i3 + 1] = ty; arr[i3 + 2] = tz;
    arr[b3] = bx; arr[b3 + 1] = by; arr[b3 + 2] = bz;
  }
  if (!moved) return false;
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return true;
}

function applyMaterialAlpha(mat: THREE.MeshPhysicalMaterial, alpha: number): void {
  const translucent = alpha < 1;
  const toggled = mat.transparent !== translucent;
  mat.opacity = alpha;
  mat.transparent = translucent;
  mat.depthWrite = !translucent;
  if (toggled) mat.needsUpdate = true;
}

const ClothPiece = memo(function ClothPiece({ flex, node, selected, data, partners }: { flex: FlexInfo; node: SceneNode | undefined; selected: boolean; data: DataMirror; partners: Map<number, number[]> }) {
  const sep = flex.name.lastIndexOf('__');
  const pieceName = sep >= 0 ? flex.name.slice(sep + 2) : flex.name;
  // This piece's stitched vertices: local index, and every vertex it is sewn to.
  const sewn = useMemo(() => {
    const out: [number, number[]][] = [];
    for (let v = 0; v < flex.vertnum; v++) {
      const p = partners.get(flex.vertadr + v);
      if (p) out.push([v, p]);
    }
    return out;
  }, [flex, partners]);
  // Drawn as a slab the sim's thickness: the surface each side of the
  // particles, closed with walls along its open edges, so a hem or a cuff
  // shows an edge. As one surface, cloth read as paper.
  const N = flex.vertnum;
  const rgba = livePieceRgba(node, flex, pieceName);
  const pieceSpec = node?.cloth?.pieces?.find((p) => p.name === pieceName);
  const pattern = node?.cloth
    ? (pieceSpec?.pattern ?? (node.cloth.garment ? node.cloth.garment.pattern : node.cloth.pattern))
    : flex.pattern;
  const patSvg = pattern?.svg ?? '';
  const patTile = pattern?.tile !== false;
  const patScale = pattern?.scale;
  const patAngle = pattern?.angle;
  // Memoize slab BufferGeometry on [flex, N] alone so pattern scale/rotation/tile slider edits
  // update UVs in place without destroying and reallocating GPU position/normal/index buffers.
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(4 * N), 2));
    // The flat pattern in metres, both faces: where the fabric's weave lies (clothWeaveTexture).
    const metres = new Float32Array(4 * N);
    const flatUv = flex.flat?.uv;
    if (flatUv && flatUv.length === N) for (let i = 0; i < N; i++) { metres[2 * i] = metres[2 * (i + N)] = flatUv[i][0]; metres[2 * i + 1] = metres[2 * (i + N) + 1] = flatUv[i][1]; }
    g.setAttribute('uv1', new THREE.BufferAttribute(metres, 2));
    const seen = new Map<number, number>();
    const elems = flex.elems;
    for (let t = 0; t < elems.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = elems[t + e], b = elems[t + ((e + 1) % 3)], k = a < b ? a * N + b : b * N + a;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const index: number[] = [...elems];
    for (let t = 0; t < elems.length; t += 3) index.push(elems[t] + N, elems[t + 2] + N, elems[t + 1] + N);
    for (let t = 0; t < elems.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = elems[t + e], b = elems[t + ((e + 1) % 3)];
      if ((seen.get(a < b ? a * N + b : b * N + a) ?? 0) !== 1) continue;
      index.push(a, b + N, b, a, a + N, b + N);
    }
    g.setIndex(index);
    return g;
  }, [flex, N]);
  const invalidate = useThree((s) => s.invalidate);
  // Mutable work buffers and the mesh as drawn, reached through refs: what
  // useMemo returns is not to be written to after render.
  const scratch = useRef<{ p: Float32Array; n: Float32Array } | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  useLayoutEffect(() => {
    const flatUv = flex.flat?.uv;
    const g = meshRef.current?.geometry;
    if (!flatUv || flatUv.length !== N || !g) return;
    const uvBuf = g.attributes.uv as THREE.BufferAttribute | undefined;
    if (!uvBuf) return;
    const uvAttr = uvBuf.array as Float32Array;
    const tile = patTile;
    const scale = Math.max(0.01, patScale ?? (tile ? 0.25 : 1));
    const ang = ((patAngle ?? 0) * Math.PI) / 180;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < N; i++) {
      const u = flatUv[i][0], v = flatUv[i][1];
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const span = Math.max(1e-4, u1 - u0, v1 - v0) * scale;
    const uMid = 0.5 * (u0 + u1), vMid = 0.5 * (v0 + v1);
    const invDiv = tile ? 1 / scale : 1 / span;
    let uvChanged = false;
    for (let i = 0; i < N; i++) {
      const du = flatUv[i][0] - uMid, dv = flatUv[i][1] - vMid;
      const tu = Math.fround((ca * du - sa * dv) * invDiv + 0.5);
      const tv = Math.fround((sa * du + ca * dv) * invDiv + 0.5);
      const o0 = 2 * i, o1 = 2 * (i + N);
      if (uvAttr[o0] !== tu || uvAttr[o0 + 1] !== tv) uvChanged = true;
      uvAttr[o0] = tu; uvAttr[o0 + 1] = tv;
      uvAttr[o1] = tu; uvAttr[o1 + 1] = tv;
    }
    if (uvChanged) {
      uvBuf.needsUpdate = true;
      invalidate();
    }
  }, [geometry, flex, N, patTile, patScale, patAngle, invalidate]);
  // Trims ride on the cloth (clothTrims), placed from it each time it is drawn.
  const trims = useClothTrims(flex, rgba);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const r = rgba[0], gCol = rgba[1], b = rgba[2], alpha = rgba[3] ?? 1;
  // The fabric's look: leather and taffeta take a shine, velvet and knits a
  // soft sheen; one matte shading for all made a leather jacket a sweater.
  // Memoized on [flex] alone so opacity edits update in place without shader teardown/recreation.
  const material = useMemo(() => {
    const look = FABRIC_LOOK[flex.material ?? 'jersey'] ?? FABRIC_LOOK.jersey;
    const initAlpha = flex.rgba[3] ?? 1;
    const translucent = initAlpha < 1;
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(flex.rgba[0], flex.rgba[1], flex.rgba[2]),
      roughness: look.roughness,
      clearcoat: look.clearcoat ?? 0,
      clearcoatRoughness: 0.35,
      sheen: look.sheen ?? 0,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(1, 1, 1),
      side: THREE.FrontSide,
      transparent: translucent,
      opacity: initAlpha,
      depthWrite: !translucent,
      // Its weave, where the piece has a flat pattern to lay it by.
      ...(flex.flat?.uv ? { normalMap: weaveTexture(flex.material ?? 'jersey'), normalScale: new THREE.Vector2(0.6, 0.6) } : {}),
    });
  }, [flex]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    const mat = meshRef.current?.material as THREE.MeshPhysicalMaterial | undefined;
    if (!mat) return;
    applyMaterialAlpha(mat, alpha);
    invalidate();
  }, [material, alpha, invalidate]);
  useEffect(() => {
    material.emissive.set(selected ? 0x223355 : 0x000000);
  }, [material, selected]);
  // Live colour updates when no SVG print overrides `material.color`.
  useEffect(() => {
    if (!patSvg) {
      material.color.setRGB(r, gCol, b);
      invalidate();
    }
  }, [material, r, gCol, b, patSvg, invalidate]);
  // A print: one texture per print and colour, shared by every panel wearing it.
  useEffect(() => {
    if (!patSvg || typeof document === 'undefined') return;
    const baseColor = [r, gCol, b, alpha];
    const release = acquirePrintTexture({ svg: patSvg, tile: patTile }, baseColor, (tex) => {
      material.map = tex;
      material.color.set(0xffffff);
      material.needsUpdate = true;
      invalidate();
    });
    return () => {
      release();
      material.map = null;
      material.color.setRGB(r, gCol, b);
      material.needsUpdate = true;
      invalidate();
    };
  }, [patSvg, patTile, r, gCol, b, alpha, material, invalidate]);

  // Positions before the first frame too, so a paused scene shows its cloth.
  // Read from the store, not the prop: after a rebuild this mounts with the
  // new layout before the prop catches up with the new buffers, and filled
  // from the old ones it drew nothing until the next render.
  const filled = useRef(false);
  const lastSyncRef = useRef<{
    geometry: THREE.BufferGeometry;
    trimsKey: unknown;
    flex: FlexInfo;
    sewn: [number, number[]][];
    src: ArrayLike<number>;
    time: number;
    zips: DataMirror['clothZips'];
  } | null>(null);
  const sync = (): boolean => {
    const liveData = (useStore.getState().data as DataMirror | null) ?? data;
    const src = liveData?.flexvert_xpos ?? data.flexvert_xpos;
    if (!src || src.length < 3 * (flex.vertadr + N)) return false;
    const g = meshRef.current?.geometry;
    if (!g) return false;
    const time = liveData?.time ?? data.time ?? -1;
    const zips = liveData?.clothZips ?? data.clothZips;
    const prev = lastSyncRef.current;
    // Fast O(1) short-circuit when re-rendering a paused scene whose buffers,
    // geometry, trims, and timestamp are identical to the last synced commit.
    if (
      filled.current &&
      prev &&
      prev.geometry === g &&
      prev.trimsKey === trims.objects &&
      prev.flex === flex &&
      prev.sewn === sewn &&
      prev.src === src &&
      prev.time === time &&
      prev.zips === zips
    ) {
      return false;
    }
    filled.current = true;
    if (scratch.current?.p.length !== 3 * N) scratch.current = { p: new Float32Array(3 * N), n: new Float32Array(3 * N) };
    const { p, n } = scratch.current;
    const halfThickness = clothPieceHalfThickness(flex, node);
    const geomChanged = syncClothSlabGeometry(g, flex, src, sewn, scratch.current, halfThickness);
    const trimsChanged = trims.place(p, n, halfThickness, zips);
    lastSyncRef.current = {
      geometry: g,
      trimsKey: trims.objects,
      flex,
      sewn,
      src,
      time,
      zips,
    };
    return geomChanged || trimsChanged;
  };
  // A layout effect, so the new geometry is filled in the commit that made it.
  // Any rebuild hands this a new flex, and from a passive effect a frame could
  // land first: the cloth gone and its trims a box round the legs.
  // And a frame asked for only when geometry or trims actually changed: while
  // paused, unrelated React re-renders must leave buffer versions untouched so
  // PathTracedView does not treat them as body movement and restart settling.
  useLayoutEffect(() => {
    if (sync()) invalidate();
  });
  const lastTime = useRef(-1);
  useFrame(() => {
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    // Only when the cloth has moved (normals over thousands of triangles are
    // not free), or while it has never been drawn.
    if (filled.current && data.time === lastTime.current) return;
    lastTime.current = data.time ?? -1;
    sync();
  });

  const sculpt = useClothSculpt(node, flex);
  const grab = useClothGrab(node?.id, flex);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!node) return;
    e.stopPropagation();
    if (useStore.getState().paintMode) return;
    useStore.getState().setSelectedNodeId(node.id);
  };
  return (
    <>
      <mesh
        ref={meshRef}
        name={pieceName}
        userData={{
          geomName: pieceName,
          clothVertCount: N,
          clothTriCount: flex.elems.length / 3,
          ...(node ? { bodyId: node.id } : {}),
        }}
        geometry={geometry}
        material={material}
        frustumCulled={false}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerDown={grab.onPointerDown}
        {...sculpt.handlers}
      />
      {sculpt.overlay}
      {trims.objects.map((o, i) => <primitive key={i} object={o} />)}
    </>
  );
});

export function ClothLayer({ model, data, sceneGraph }: Props) {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const hiddenNodeIds = useStore((s) => s.hiddenNodeIds);
  const cleanCapture = useCapture((s) => s.clean);
  const byName = useMemo(
    () => clothNodes(sceneGraph?.nodes, new Set(hiddenNodeIds)),
    [sceneGraph, hiddenNodeIds],
  );
  const stitches = model?.clothStitches;
  const partners = useMemo(() => {
    const m = new Map<number, number[]>();
    const add = (a: number, b: number) => { const l = m.get(a); if (l) l.push(b); else m.set(a, [b]); };
    for (let i = 0; i + 1 < (stitches?.length ?? 0); i += 2) { add(stitches![i], stitches![i + 1]); add(stitches![i + 1], stitches![i]); }
    return m;
  }, [stitches]);
  const flexes = model?.flexes;
  const selectedIds = useMemo(
    () => new Set([...(selectedNodeId ? [selectedNodeId] : []), ...extraSelectedIds]),
    [selectedNodeId, extraSelectedIds],
  );
  // Group pieces under `<group name={node.id}>` so per-node STL export,
  // Hi-Res SelectionOutline, and TransformGizmo find every cloth body cleanly.
  const groupedEntries = useMemo(() => {
    if (!flexes?.length) return [];
    const grouped = new Map<string, { node?: SceneNode; items: FlexInfo[] }>();
    for (const flex of flexes) {
      const entry = byName.get(flex.name.slice(0, flex.name.lastIndexOf('__')));
      if (entry?.hidden) continue;
      const key = entry?.node.id ?? `__loose__:${flex.name}`;
      let g = grouped.get(key);
      if (!g) {
        g = { node: entry?.node, items: [] };
        grouped.set(key, g);
      }
      g.items.push(flex);
    }
    return [...grouped.entries()];
  }, [flexes, byName]);
  if (!groupedEntries.length || !data) return null;
  return (
    <>
      {groupedEntries.map(([key, { node, items }]) => {
        const selected = !cleanCapture && !!node && selectedIds.has(node.id);
        const children = items.map((flex) => (
          <ClothPiece key={flex.name} flex={flex} node={node} selected={selected} data={data} partners={partners} />
        ));
        return node ? (
          <group key={node.id} name={node.id} userData={{ bodyId: node.id }}>
            {children}
          </group>
        ) : (
          <group key={key}>{children}</group>
        );
      })}
    </>
  );
}
