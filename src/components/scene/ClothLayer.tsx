/**
 * Draws cloth (utils/cloth): one mesh per piece, its vertices read each frame
 * from the worker's flexvert_xpos. Mounted inside SceneLayer's Z-up group, so
 * MuJoCo's world coordinates go in as they are.
 *
 * Two-sided on purpose. Cloth has an inside and an outside that are both
 * seen, unlike a solid, whose back faces must stay culled (CLAUDE.md, face
 * winding).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useCapture } from '../../store/captureStore';
import type { SceneGraph, SceneNode } from '../../types/scene';
import type { ClothMaterialName } from '../../types/cloth';
import type { DataMirror, FrameFlagWindow, ModelMirror } from '../../types/sceneLayer';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';
import { CLOTH_THICKNESS } from '../../utils/cloth/xpbd';
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

/** Synced cloth slab geometry from `src` (`flexvert_xpos`), returning `true` only when vertex positions changed. */
// eslint-disable-next-line react-refresh/only-export-components
export function syncClothSlabGeometry(
  g: THREE.BufferGeometry,
  flex: FlexInfo,
  src: ArrayLike<number>,
  sewn: [number, number[]][],
  scratch: { p: Float32Array; n: Float32Array },
): boolean {
  const N = flex.vertnum;
  if (src.length < 3 * (flex.vertadr + N)) return false;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const { p, n } = scratch;
  const o = 3 * flex.vertadr;
  for (let i = 0; i < 3 * N; i++) p[i] = src[o + i];
  // A stitched vertex is drawn where it and its partners meet, once they
  // nearly have: before (pieces laid out apart, still being sewn) each is
  // drawn where it is, or every seam edge was dragged to the midpoint.
  for (const [v, ps] of sewn) {
    const vx = src[o + 3 * v], vy = src[o + 3 * v + 1], vz = src[o + 3 * v + 2];
    if (ps.some((q) => Math.hypot(src[3 * q] - vx, src[3 * q + 1] - vy, src[3 * q + 2] - vz) > MEET)) continue;
    for (let k = 0; k < 3; k++) {
      let sum = src[o + 3 * v + k];
      for (const q of ps) sum += src[3 * q + k];
      p[3 * v + k] = sum / (ps.length + 1);
    }
  }
  // Area-weighted normals of the middle surface; the two faces half the thickness along them.
  const prevNormal = g.attributes.normal as THREE.BufferAttribute | undefined;
  n.fill(0);
  for (let t = 0; t < flex.elems.length; t += 3) {
    const a = 3 * flex.elems[t], b = 3 * flex.elems[t + 1], c = 3 * flex.elems[t + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  const h = CLOTH_THICKNESS / 2;
  let moved = !prevNormal;
  for (let i = 0; i < N; i++) {
    const l = Math.hypot(n[3 * i], n[3 * i + 1], n[3 * i + 2]) || 1;
    for (let k = 0; k < 3; k++) {
      const d = (n[3 * i + k] / l) * h;
      const top = Math.fround(p[3 * i + k] + d);
      const bot = Math.fround(p[3 * i + k] - d);
      if (arr[3 * i + k] !== top || arr[3 * (i + N) + k] !== bot) moved = true;
      arr[3 * i + k] = top;
      arr[3 * (i + N) + k] = bot;
    }
  }
  if (!moved) return false;
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return true;
}

function ClothPiece({ flex, node, selected, data, partners }: { flex: FlexInfo; node: SceneNode | undefined; selected: boolean; data: DataMirror; partners: Map<number, number[]> }) {
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
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
    const uvAttr = new Float32Array(4 * N);
    const flatUv = flex.flat?.uv;
    if (flatUv && flatUv.length === N) {
      const tile = patTile;
      const scale = Math.max(0.01, patScale ?? (tile ? 0.25 : 1));
      const ang = ((patAngle ?? 0) * Math.PI) / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [u, v] of flatUv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const span = Math.max(1e-4, u1 - u0, v1 - v0) * scale;
      const uMid = (u0 + u1) / 2, vMid = (v0 + v1) / 2;
      for (let i = 0; i < N; i++) {
        const du = flatUv[i][0] - uMid, dv = flatUv[i][1] - vMid;
        const ru = ca * du - sa * dv, rv = sa * du + ca * dv;
        const tu = tile ? ru / scale + 0.5 : ru / span + 0.5;
        const tv = tile ? rv / scale + 0.5 : rv / span + 0.5;
        uvAttr[2 * i] = tu; uvAttr[2 * i + 1] = tv;
        uvAttr[2 * (i + N)] = tu; uvAttr[2 * (i + N) + 1] = tv;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uvAttr, 2));
    // The flat pattern in metres, both faces: where the fabric's weave lies (clothWeaveTexture).
    const metres = new Float32Array(4 * N);
    if (flatUv && flatUv.length === N) for (let i = 0; i < N; i++) { metres[2 * i] = metres[2 * (i + N)] = flatUv[i][0]; metres[2 * i + 1] = metres[2 * (i + N) + 1] = flatUv[i][1]; }
    g.setAttribute('uv1', new THREE.BufferAttribute(metres, 2));
    const seen = new Map<string, number>();
    for (let t = 0; t < flex.elems.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = flex.elems[t + e], b = flex.elems[t + ((e + 1) % 3)], k = a < b ? `${a},${b}` : `${b},${a}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const index: number[] = [...flex.elems];
    for (let t = 0; t < flex.elems.length; t += 3) index.push(flex.elems[t] + N, flex.elems[t + 2] + N, flex.elems[t + 1] + N);
    for (let t = 0; t < flex.elems.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = flex.elems[t + e], b = flex.elems[t + ((e + 1) % 3)];
      if ((seen.get(a < b ? `${a},${b}` : `${b},${a}`) ?? 0) !== 1) continue;
      index.push(a, b + N, b, a, a + N, b + N);
    }
    g.setIndex(index);
    return g;
  }, [flex, N, patTile, patScale, patAngle]);
  // Mutable work buffers and the mesh as drawn, reached through refs: what
  // useMemo returns is not to be written to after render.
  const scratch = useRef<{ p: Float32Array; n: Float32Array } | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  // Trims ride on the cloth (clothTrims), placed from it each time it is drawn.
  const trims = useClothTrims(flex, rgba);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const r = rgba[0], gCol = rgba[1], b = rgba[2], alpha = rgba[3] ?? 1;
  // The fabric's look: leather and taffeta take a shine, velvet and knits a
  // soft sheen; one matte shading for all made a leather jacket a sweater.
  const material = useMemo(() => {
    const look = FABRIC_LOOK[flex.material ?? 'jersey'] ?? FABRIC_LOOK.jersey;
    const translucent = alpha < 1;
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(flex.rgba[0], flex.rgba[1], flex.rgba[2]),
      roughness: look.roughness,
      clearcoat: look.clearcoat ?? 0,
      clearcoatRoughness: 0.35,
      sheen: look.sheen ?? 0,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(1, 1, 1),
      side: THREE.DoubleSide,
      transparent: translucent,
      opacity: alpha,
      depthWrite: !translucent,
      // Its weave, where the piece has a flat pattern to lay it by.
      ...(flex.flat?.uv ? { normalMap: weaveTexture(flex.material ?? 'jersey'), normalScale: new THREE.Vector2(0.6, 0.6) } : {}),
    });
  }, [flex, alpha]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.emissive.set(selected ? 0x223355 : 0x000000);
  }, [material, selected]);
  const invalidate = useThree((s) => s.invalidate);
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
    const geomChanged = syncClothSlabGeometry(g, flex, src, sewn, scratch.current);
    const trimsChanged = trims.place(p, n, CLOTH_THICKNESS / 2, zips);
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
        userData={{ geomName: pieceName, ...(node ? { bodyId: node.id } : {}) }}
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
}

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
  if (!flexes?.length || !data) return null;
  const selectedIds = new Set([
    ...(selectedNodeId ? [selectedNodeId] : []),
    ...extraSelectedIds,
  ]);
  // Group pieces under `<group name={node.id}>` so per-node STL export,
  // Hi-Res SelectionOutline, and TransformGizmo find every cloth body cleanly.
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
  return (
    <>
      {[...grouped.entries()].map(([key, { node, items }]) => {
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
