/**
 * Draws cloth (utils/cloth): one mesh per piece, its vertices read each frame
 * from the worker's flexvert_xpos. Mounted inside SceneLayer's Z-up group, so
 * MuJoCo's world coordinates go in as they are.
 *
 * Two-sided on purpose. Cloth has an inside and an outside that are both
 * seen, unlike a solid, whose back faces must stay culled (CLAUDE.md, face
 * winding).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneGraph, SceneNode } from '../../types/scene';
import type { ClothMaterialName } from '../../types/cloth';
import type { DataMirror, FrameFlagWindow, ModelMirror } from '../../types/sceneLayer';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';
import { CLOTH_THICKNESS } from '../../utils/cloth/xpbd';

/** A unit trim of each kind, its base on the cloth and its height up +y (turned to the surface normal), scaled by the trim's size. */
const TRIM_GEOMETRY = {
  stud: () => new THREE.ConeGeometry(0.5, 0.55, 10).translate(0, 0.27, 0),
  button: () => new THREE.CylinderGeometry(0.5, 0.5, 0.15, 14).translate(0, 0.08, 0),
  bead: () => new THREE.SphereGeometry(0.5, 10, 8).translate(0, 0.4, 0),
  zipper: () => new THREE.BoxGeometry(0.9, 0.5, 0.9).translate(0, 0.25, 0),
};

/** Stitched points further apart than this are still being sewn, and drawn where they are. */
const MEET = 0.03;

/** How each fabric catches the light. */
const FABRIC_LOOK: Record<ClothMaterialName, { roughness: number; clearcoat?: number; sheen?: number }> = {
  jersey: { roughness: 0.95, sheen: 0.3 },
  woven: { roughness: 0.85 },
  canvas: { roughness: 1 },
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

/** Cloth bodies by name, so a flex `<body>__<piece>` finds the node it belongs to. */
function clothNodes(nodes: SceneNode[] | undefined, out = new Map<string, SceneNode>()) {
  for (const n of nodes ?? []) {
    if (n.cloth) out.set(n.name || n.id, n);
    clothNodes(n.children, out);
  }
  return out;
}

function ClothPiece({ flex, node, selected, data, partners }: { flex: FlexInfo; node: SceneNode | undefined; selected: boolean; data: DataMirror; partners: Map<number, number[]> }) {
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
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
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
  }, [flex, N]);
  const scratch = useMemo(() => ({ p: new Float32Array(3 * N), n: new Float32Array(3 * N) }), [N]);
  // Trims ride on the cloth: one instanced mesh per kind, placed on their
  // vertices along the surface normal every time the cloth is drawn.
  const trimMeshes = useMemo(() => {
    const out: { items: NonNullable<FlexInfo['trims']>; mesh: THREE.InstancedMesh }[] = [];
    const byKind = new Map<string, NonNullable<FlexInfo['trims']>>();
    for (const t of flex.trims ?? []) (byKind.get(t.kind) ?? byKind.set(t.kind, []).get(t.kind)!).push(t);
    for (const [kind, items] of byKind) {
      const geom = TRIM_GEOMETRY[kind as keyof typeof TRIM_GEOMETRY]();
      const c = items[0].rgba;
      const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c[0], c[1], c[2]), metalness: kind === 'button' ? 0 : 0.9, roughness: kind === 'button' ? 0.5 : 0.3 });
      const mesh = new THREE.InstancedMesh(geom, mat, items.length);
      mesh.frustumCulled = false; mesh.castShadow = true;
      out.push({ items, mesh });
    }
    return out;
  }, [flex]);
  useEffect(() => () => { for (const { mesh } of trimMeshes) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } }, [trimMeshes]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // The fabric's look: leather and taffeta take a shine, velvet and knits a
  // soft sheen; one matte shading for all made a leather jacket a sweater.
  const material = useMemo(() => {
    const look = FABRIC_LOOK[flex.material ?? 'jersey'];
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(flex.rgba[0], flex.rgba[1], flex.rgba[2]),
      roughness: look.roughness,
      clearcoat: look.clearcoat ?? 0,
      clearcoatRoughness: 0.35,
      sheen: look.sheen ?? 0,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(1, 1, 1),
      side: THREE.DoubleSide,
    });
  }, [flex]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.emissive.set(selected ? 0x223355 : 0x000000);
  }, [material, selected]);

  // Positions before the first frame too, so a paused scene shows its cloth.
  // Read from the store, not the prop: after a rebuild this mounts with the
  // new layout before the prop catches up with the new buffers, and filled
  // from the old ones it drew nothing until the next render.
  const filled = useRef(false);
  const sync = () => {
    const src = (useStore.getState().data as DataMirror | null)?.flexvert_xpos ?? data.flexvert_xpos;
    if (!src || src.length < 3 * (flex.vertadr + N)) return;
    filled.current = true;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array, { p, n } = scratch;
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
    n.fill(0);
    for (let t = 0; t < flex.elems.length; t += 3) {
      const a = 3 * flex.elems[t], b = 3 * flex.elems[t + 1], c = 3 * flex.elems[t + 2];
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
    }
    const h = CLOTH_THICKNESS / 2;
    for (let i = 0; i < N; i++) {
      const l = Math.hypot(n[3 * i], n[3 * i + 1], n[3 * i + 2]) || 1;
      for (let k = 0; k < 3; k++) { const d = (n[3 * i + k] / l) * h; arr[3 * i + k] = p[3 * i + k] + d; arr[3 * (i + N) + k] = p[3 * i + k] - d; }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const dummy = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
    for (const { items, mesh } of trimMeshes) {
      items.forEach((t, i) => {
        const j = 3 * t.particle, l = Math.hypot(n[j], n[j + 1], n[j + 2]) || 1;
        nv.set(n[j] / l, n[j + 1] / l, n[j + 2] / l);
        dummy.position.set(p[j] + nv.x * h, p[j + 1] + nv.y * h, p[j + 2] + nv.z * h);
        dummy.quaternion.setFromUnitVectors(up, nv);
        dummy.scale.setScalar(t.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  };
  // And a frame asked for once filled: on demand, the frame after a rebuild
  // drew the new geometry empty, before this effect, and nothing asked for
  // another (the cloth vanished until the next pointer event).
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { sync(); if (filled.current) invalidate(); }); // eslint-disable-line react-hooks/exhaustive-deps -- every render, on purpose
  const lastTime = useRef(-1);
  useFrame(() => {
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;
    // Only when the cloth has moved (normals over thousands of triangles are
    // not free), or while it has never been drawn.
    if (filled.current && data.time === lastTime.current) return;
    lastTime.current = data.time ?? -1;
    sync();
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!node) return;
    e.stopPropagation();
    if (useStore.getState().paintMode) return;
    useStore.getState().setSelectedNodeId(node.id);
  };
  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} castShadow receiveShadow onClick={onClick} />
      {trimMeshes.map(({ mesh }, i) => <primitive key={i} object={mesh} />)}
    </>
  );
}

export function ClothLayer({ model, data, sceneGraph }: Props) {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const hiddenNodeIds = useStore((s) => s.hiddenNodeIds);
  const byName = useMemo(() => clothNodes(sceneGraph?.nodes), [sceneGraph]);
  const stitches = model?.clothStitches;
  const partners = useMemo(() => {
    const m = new Map<number, number[]>();
    const add = (a: number, b: number) => { const l = m.get(a); if (l) l.push(b); else m.set(a, [b]); };
    for (let i = 0; i + 1 < (stitches?.length ?? 0); i += 2) { add(stitches![i], stitches![i + 1]); add(stitches![i + 1], stitches![i]); }
    return m;
  }, [stitches]);
  const flexes = model?.flexes;
  if (!flexes?.length || !data) return null;
  const hidden = new Set(hiddenNodeIds);
  return (
    <>
      {flexes.map((flex) => {
        const node = byName.get(flex.name.slice(0, flex.name.lastIndexOf('__')));
        if (node && hidden.has(node.id)) return null;
        return <ClothPiece key={flex.name} flex={flex} node={node} selected={!!node && node.id === selectedNodeId} data={data} partners={partners} />;
      })}
    </>
  );
}
