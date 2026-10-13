/**
 * The Dims overlay: a drawing's dimensions on the parts, in Top, Front and Side.
 *
 * What to measure comes from utils/viewDimensions, run on the parts AS DRAWN:
 * every transform, boolean and MuJoCo pose already applied, the same reasoning
 * as measureScene. This file only gathers those triangles and draws the result
 * the way a drawing does — thin extension lines out from the part, a dimension
 * line with an arrowhead at each end, the figure in mm on it.
 *
 * Drawn only while the camera is square to the view: orbit off it and the
 * figures would sit on a sheet nobody is looking at, so they go until you come
 * back. Sizes are in screen pixels (an orthographic view's scale is its zoom),
 * so the rows and arrows stay the same size as you zoom.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { isDrawingView, SQUARE_TO_VIEW, VIEW_AXES, type DrawingView } from '../../utils/cameraViews';
import { bodyViewDimensions, type BodyDimensions, type BodyMesh } from '../../utils/viewDimensions';
import { bodyOf } from '../../utils/measureScene';
import { setLiveDimensions } from '../../utils/liveDimensions';

const COLOUR = '#d97706';
/** How far out each row sits from the part, in pixels. */
const ROW_PX = [0, 22, 46];
/** The gap between the part and an extension line, and how far it runs past the dimension line. */
const GAP_PX = 3;
const OVERSHOOT_PX = 4;
const ARROW_LONG_PX = 9;
const ARROW_HALF_PX = 3;
/** The diameter leader: how far past the rim it runs, and its shoulder. */
const LEADER_PX = 26;
const SHOULDER_PX = 10;
/** How often the drawn scene is checked for change. */
const POLL_MS = 250;
/** Bigger than this is the floor or the sky, not a part. */
const MAX_PART_M = 10;

type Vec3 = [number, number, number];

interface DrawnPiece { id: string; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }

/**
 * The sphere a piece is, exactly, when it is a whole sphere drawn at an even
 * scale: centre in the document frame and radius in metres. An ellipsoid is a
 * unit sphere scaled unevenly, and is not one.
 */
function sphereOf({ geometry, matrix }: DrawnPiece): { centre: Vec3; radius: number } | null {
  if (geometry.type !== 'SphereGeometry') return null;
  const p = (geometry as THREE.SphereGeometry).parameters;
  if (Math.abs(p.phiLength - Math.PI * 2) > 1e-6 || Math.abs(p.thetaLength - Math.PI) > 1e-6) return null;
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  if (Math.abs(scale.x - scale.y) > 1e-3 * scale.x || Math.abs(scale.x - scale.z) > 1e-3 * scale.x) return null;
  const c = new THREE.Vector3().setFromMatrixPosition(matrix);
  return { centre: [c.x, -c.z, c.y], radius: p.radius * scale.x };
}

/**
 * The meshes that make up each body as drawn, and a signature per body that
 * changes when any of them moves or is rebuilt. Cheap: nothing is copied, so
 * it can be asked a few times a second.
 *
 * Only meshes that cast a shadow: that is the part's own surface, and it
 * leaves out everything drawn alongside it in the same group — the inside wall
 * of a hollow mesh, the DFM heat map, a brush cursor, cut ghosts.
 */
function drawnPieces(root: THREE.Object3D, only: string | null): Map<string, { pieces: DrawnPiece[]; signature: string }> {
  const out = new Map<string, { pieces: DrawnPiece[]; signature: string }>();
  const push = (id: string, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    let entry = out.get(id);
    if (!entry) out.set(id, (entry = { pieces: [], signature: '' }));
    entry.pieces.push({ id, geometry, matrix });
    entry.signature += `${geometry.uuid}:${geometry.getAttribute('position')?.version ?? 0}:${matrix.elements.map((e) => e.toFixed(6)).join(',')};`;
  };
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !mesh.castShadow) return;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      // Static boxes, one instance each; see measureScene's instancedCandidates.
      const ids = (instanced.userData?.nodeIds ?? []) as string[];
      for (let i = 0; i < instanced.count; i++) {
        const id = ids[i];
        if (!id || (only && id !== only)) continue;
        const m = new THREE.Matrix4();
        instanced.getMatrixAt(i, m);
        push(id, instanced.geometry, m.premultiply(instanced.matrixWorld));
      }
      return;
    }
    const id = bodyOf(mesh);
    if (!id || (only && id !== only)) return;
    push(id, mesh.geometry, mesh.matrixWorld.clone());
  });
  return out;
}

/** One body's triangles, world space, document frame (Z-up). */
function bodyMesh(id: string, pieces: DrawnPiece[]): BodyMesh {
  const positions: number[] = [];
  const faces: number[] = [];
  const p = new THREE.Vector3();
  for (const { geometry, matrix } of pieces) {
    const position = geometry.getAttribute('position');
    if (!position) continue;
    const base = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(matrix);
      // Three's Y-up scene frame back to the document's Z-up: (x, y, z) → (x, −z, y).
      positions.push(p.x, -p.z, p.y);
    }
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i++) faces.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) faces.push(base + i);
  }
  const spheres = pieces.map(sphereOf).filter((x): x is NonNullable<typeof x> => x !== null);
  return { id, positions, faces, spheres };
}

/** The view's own document-frame axes, as Three-frame vectors. */
function threeAxes(view: DrawingView) {
  const toThree = (v: Vec3) => new THREE.Vector3(v[0], v[2], -v[1]);
  const { forward, right, up } = VIEW_AXES[view];
  return { forward: toThree(forward), right: toThree(right), up: toThree(up) };
}

interface Drawing {
  lines: Float32Array;
  arrows: Float32Array;
  labels: { key: string; at: THREE.Vector3; text: string; anchor: 'centre' | 'left' | 'right' }[];
}

/** Which way each successive ⌀ leader on a part runs, so concentric circles do not share one. */
const LEADER_DIRECTIONS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(
  ([u, v]) => [u * Math.SQRT1_2, v * Math.SQRT1_2] as [number, number]);

/** Lay the dimensions out on the sheet at this many metres per pixel. */
function layOut(found: BodyDimensions[], view: DrawingView, mpp: number): Drawing {
  const { forward, right, up } = threeAxes(view);
  const lines: number[] = [];
  const arrows: number[] = [];
  const labels: Drawing['labels'] = [];
  const px = (n: number) => n * mpp;
  /*
   * Figures already placed, as screen rectangles (pixels on the sheet). A figure
   * that would land on one moves up the sheet until it is clear: approximate
   * widths are enough to keep two numbers from printing over each other.
   */
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const place = (u: number, v: number, text: string, anchor: 'centre' | 'left' | 'right'): [number, number] => {
    const w = text.length * 6.5 + 8;
    const h = 14;
    let x = u / mpp;
    let y = v / mpp;
    const x0 = anchor === 'left' ? x : anchor === 'right' ? x - w : x - w / 2;
    for (let tries = 0; tries < 6; tries++) {
      const box = { x0, x1: x0 + w, y0: y - h / 2, y1: y + h / 2 };
      if (!placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) {
        placed.push(box);
        break;
      }
      y += h + 2;
    }
    x *= mpp;
    return [x, y * mpp];
  };

  for (const body of found) {
    // On the face nearest the camera, a touch in front of it.
    const w = body.near - px(2);
    const at = (u: number, v: number) =>
      right.clone().multiplyScalar(u).addScaledVector(up, v).addScaledVector(forward, w);
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
    /** An arrowhead with its tip at `tip`, pointing along the sheet direction (du, dv). */
    const arrow = (tipU: number, tipV: number, du: number, dv: number) => {
      const tip = at(tipU, tipV);
      const back = at(tipU - du * px(ARROW_LONG_PX), tipV - dv * px(ARROW_LONG_PX));
      const side = right.clone().multiplyScalar(-dv).addScaledVector(up, du).multiplyScalar(px(ARROW_HALF_PX));
      const l = back.clone().add(side);
      const r = back.clone().sub(side);
      arrows.push(tip.x, tip.y, tip.z, l.x, l.y, l.z, r.x, r.y, r.z);
    };
    let diameterCount = 0;
    const hasChain = { u: false, v: false };
    for (const d of body.dims) if (d.kind === 'linear' && d.row === 1) hasChain[d.axis] = true;

    body.dims.forEach((d, i) => {
      const key = `${body.id}:${i}`;
      if (d.kind === 'linear') {
        const row = d.row === 2 && !hasChain[d.axis] ? 1 : d.row;
        const line = d.edge - px(ROW_PX[row]);
        const spanPx = (d.b - d.a) / mpp;
        // Too short to hold its figure between the arrows: the figure goes past
        // an end — the near one when this is the first of its chain, where
        // nothing else is drawn, and otherwise the far one.
        const outside = spanPx < 34;
        const first = d.a <= (d.axis === 'u' ? body.bounds.u[0] : body.bounds.v[0]) + 1e-9;
        if (d.axis === 'u') {
          seg(at(d.a, d.anchorA - px(GAP_PX)), at(d.a, line - px(OVERSHOOT_PX)));
          seg(at(d.b, d.anchorB - px(GAP_PX)), at(d.b, line - px(OVERSHOOT_PX)));
          seg(at(d.a, line), at(d.b, line));
          arrow(d.a, line, -1, 0);
          arrow(d.b, line, 1, 0);
          const anchor = outside && !first ? 'left' as const : 'centre' as const;
          const [lu, lv] = !outside ? [(d.a + d.b) / 2, line] : first ? [d.a - px(16), line] : [d.b + px(6), line];
          labels.push({ key, at: at(...place(lu, lv, d.label, anchor)), text: d.label, anchor });
        } else {
          seg(at(d.anchorA - px(GAP_PX), d.a), at(line - px(OVERSHOOT_PX), d.a));
          seg(at(d.anchorB - px(GAP_PX), d.b), at(line - px(OVERSHOOT_PX), d.b));
          seg(at(line, d.a), at(line, d.b));
          arrow(line, d.a, 0, -1);
          arrow(line, d.b, 0, 1);
          const [lu, lv] = !outside ? [line, (d.a + d.b) / 2] : first ? [line, d.a - px(10)] : [line, d.b + px(10)];
          labels.push({ key, at: at(...place(lu, lv, d.label, 'centre')), text: d.label, anchor: 'centre' });
        }
      } else {
        // Across the circle at 45°, out past the rim to a short shoulder. Each
        // further ⌀ on the part turns a quarter, so a counterbore's two circles
        // are not labelled up the same line.
        const [ku, kv] = LEADER_DIRECTIONS[diameterCount++ % LEADER_DIRECTIONS.length];
        const [cu, cv] = d.centre;
        const near: [number, number] = [cu - ku * d.radius, cv - kv * d.radius];
        const far: [number, number] = [cu + ku * d.radius, cv + kv * d.radius];
        const out: [number, number] = [far[0] + ku * px(LEADER_PX), far[1] + kv * px(LEADER_PX)];
        const side = Math.sign(ku);
        seg(at(...near), at(...out));
        seg(at(...out), at(out[0] + side * px(SHOULDER_PX), out[1]));
        arrow(near[0], near[1], -ku, -kv);
        arrow(far[0], far[1], ku, kv);
        const anchor = side > 0 ? 'left' as const : 'right' as const;
        const spot = place(out[0] + side * px(SHOULDER_PX + 3), out[1], d.label, anchor);
        labels.push({ key, at: at(...spot), text: d.label, anchor });
      }
    });
  }
  return { lines: new Float32Array(lines), arrows: new Float32Array(arrows), labels };
}

export function DimensionOverlay() {
  const cameraView = useStore((s) => s.cameraView);
  const dimsEnabled = useStore((s) => s.dimsEnabled);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const scene = useThree((s) => s.scene);
  const view = isDrawingView(cameraView) ? cameraView : null;
  const on = dimsEnabled && view !== null;

  const [found, setFound] = useState<BodyDimensions[]>([]);
  const [mpp, setMpp] = useState(0);
  const [square, setSquare] = useState(false);
  const cache = useRef(new Map<string, { signature: string; dims: BodyDimensions | null }>());
  const lastSignature = useRef('');
  const lastPoll = useRef(0);
  const forward = useMemo(() => new THREE.Vector3(), []);

  // A new view or a new selection measures from scratch.
  useEffect(() => {
    cache.current.clear();
    lastSignature.current = '';
    lastPoll.current = 0;
    if (!on) {
      setFound([]);
      setLiveDimensions([]);
    }
  }, [on, view, selectedNodeId]);

  useFrame(({ camera, size }) => {
    if (!on || !view) return;
    const ortho = camera as THREE.OrthographicCamera;
    if (!ortho.isOrthographicCamera) {
      if (square) setSquare(false);
      return;
    }
    camera.getWorldDirection(forward);
    const isSquare = forward.dot(threeAxes(view).forward) >= SQUARE_TO_VIEW;
    if (isSquare !== square) setSquare(isSquare);

    const perPixel = (ortho.top - ortho.bottom) / (ortho.zoom * Math.max(1, size.height));
    if (!(mpp > 0) || Math.abs(perPixel / mpp - 1) > 0.01) setMpp(perPixel);

    const now = performance.now();
    if (now - lastPoll.current < POLL_MS) return;
    lastPoll.current = now;
    const pieces = drawnPieces(scene, selectedNodeId);
    let signature = '';
    for (const [id, entry] of pieces) signature += `${id}=${entry.signature.length}:${hashOf(entry.signature)}|`;
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;

    // Per body, so a sim moving one part re-measures that part alone.
    const next: BodyDimensions[] = [];
    for (const [id, entry] of pieces) {
      let hit = cache.current.get(id);
      if (!hit || hit.signature !== entry.signature) {
        hit = { signature: entry.signature, dims: bodyViewDimensions(bodyMesh(id, entry.pieces), view) };
        cache.current.set(id, hit);
      }
      const d = hit.dims;
      if (!d) continue;
      if (d.bounds.u[1] - d.bounds.u[0] > MAX_PART_M || d.bounds.v[1] - d.bounds.v[0] > MAX_PART_M) continue;
      next.push(d);
    }
    setFound(next);
    setLiveDimensions(next.flatMap((b) => b.dims.map((d) => d.kind === 'linear'
      ? {
          body: b.id, kind: d.kind, direction: d.axis === 'u' ? 'width' as const : 'height' as const,
          row: d.row === 1 ? 'chain' as const : 'overall' as const, label: d.label, valueMm: d.valueMm,
        }
      : { body: b.id, kind: d.kind, count: d.count, label: d.label, valueMm: d.valueMm })));
  });

  const drawing = useMemo(
    () => (on && view && square && mpp > 0 ? layOut(found, view, mpp) : null),
    [on, view, square, mpp, found],
  );
  const lineGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    if (drawing) g.setAttribute('position', new THREE.BufferAttribute(drawing.lines, 3));
    return g;
  }, [drawing]);
  const arrowGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    if (drawing) g.setAttribute('position', new THREE.BufferAttribute(drawing.arrows, 3));
    return g;
  }, [drawing]);
  useEffect(() => () => lineGeometry.dispose(), [lineGeometry]);
  useEffect(() => () => arrowGeometry.dispose(), [arrowGeometry]);
  useEffect(() => () => setLiveDimensions([]), []);

  if (!drawing) return null;
  return (
    <group>
      <lineSegments geometry={lineGeometry} raycast={() => null} renderOrder={997}>
        <lineBasicMaterial color={COLOUR} depthTest={false} transparent toneMapped={false} />
      </lineSegments>
      <mesh geometry={arrowGeometry} raycast={() => null} renderOrder={998}>
        <meshBasicMaterial color={COLOUR} depthTest={false} side={THREE.DoubleSide} transparent toneMapped={false} />
      </mesh>
      {drawing.labels.map((label) => (
        <Html
          key={label.key}
          position={label.at}
          // drei's `center` is a transform on the same element `style` styles,
          // so a label anchored at one edge sets its own instead.
          center={label.anchor === 'centre'}
          // Under the viewport's floating panels (z-10), not over them.
          zIndexRange={[9, 1]}
          style={label.anchor === 'left'
            ? { pointerEvents: 'none', transform: 'translate(0, -50%)' }
            : label.anchor === 'right'
              ? { pointerEvents: 'none', transform: 'translate(-100%, -50%)' }
              : { pointerEvents: 'none' }}
        >
          <span className="px-1 rounded-sm bg-white/90 dark:bg-slate-900/90 text-amber-700 dark:text-amber-400 text-[10px] font-mono font-semibold tabular-nums whitespace-nowrap shadow-xs">
            {label.text}
          </span>
        </Html>
      ))}
    </group>
  );
}

/** A short fingerprint of a long signature. */
function hashOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
