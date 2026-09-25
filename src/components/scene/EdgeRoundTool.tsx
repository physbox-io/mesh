// ---------------------------------------------------------------------------
// Round edges: the viewport half
// ---------------------------------------------------------------------------
//
// Hover an edge and it lights up; click it to add it or take it away. Click a
// flat face and all of its edges go in at once. Every edge the part offers is
// drawn faintly while the tool is up, so there is never any guessing which
// lines are clickable. The size and the Round/Bevel choice live in the panel
// (EdgeRoundPanel); this file is only about which edges.
//
// Edges are picked on the part as modelled, before any rounding — see
// utils/edgeRoundBase.ts. That solid is never drawn; an invisible copy of it
// is what the pointer is cast against, so aiming at where an edge WAS still
// finds it once the preview has rounded it away.
//
// Left-click is taken in the capture phase while the tool is up, the same as
// the measure tool, so a click on an edge does not also select or drag the
// body. The viewport orbits on the right button, so nothing is lost.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useBodyEdges } from '../../hooks/useBodyEdges';
import { findNodeById } from '../../utils/sceneTree';
import { csgFrameOffset } from '../../utils/csg';
import { nodeWorldMatrix } from '../../utils/combineBodies';
import { edgesOfSurface, maxSizeFor, sameEdge, suggestedSize, type EdgeCandidate } from '../../utils/featureEdges';

/** How near the pointer an edge must be, on screen, to be the one meant. */
const PICK_PIXELS = 10;

/** The document is Z-up; three is Y-up. Bodies are drawn through this turn. */
const DOC_TO_THREE = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
);

type Hover = { edge: number } | { surface: number } | null;

/**
 * Opens the tool on the selected part. A part that cannot be rounded still
 * opens it: the panel then says why, which beats a key that does nothing.
 */
function startRoundingSelected(): boolean {
  const state = useStore.getState();
  const id = state.selectedNodeId;
  if (!id || state.isPlaying || state.latticeNodeId || state.sculptNodeId) return false;
  state.startEdgeRound(id);
  return true;
}

export const EdgeRoundTool = () => {
  const { camera, gl } = useThree();
  const session = useStore((s) => s.edgeRoundSession);
  const node = useStore((s) => (s.edgeRoundSession ? findNodeById(s.sceneGraph.nodes, s.edgeRoundSession.nodeId) : null));
  const { edges: body } = useBodyEdges(session ? node : null);
  const [hover, setHover] = useState<Hover>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const frameRef = useRef<THREE.Group>(null);

  // The body's frame in three's world, less the shift a compiled boolean is
  // drawn with (csgFrameOffset), so points written in the source frame land
  // where the part is drawn.
  const frame = useMemo(() => {
    if (!session || !node) return null;
    const docMatrix = nodeWorldMatrix(useStore.getState().sceneGraph.nodes, session.nodeId);
    if (!docMatrix) return null;
    const offset = csgFrameOffset(node);
    return DOC_TO_THREE.clone().multiply(docMatrix).multiply(new THREE.Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]));
  }, [session, node]);

  useFrame(() => {
    const group = frameRef.current;
    if (!group || !frame) return;
    group.matrixAutoUpdate = false;
    group.matrix.copy(frame);
    group.matrixWorldNeedsUpdate = true;
  });

  // An invisible copy of the unrounded solid, for the pointer to hit.
  const pickMesh = useMemo(() => {
    if (!body) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(body.positions, 3));
    geometry.setIndex(body.faces);
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  }, [body]);
  useEffect(() => () => pickMesh?.geometry.dispose(), [pickMesh]);

  // First open: a suggested size, and — on a part with no roundings yet —
  // every edge, so the very first thing seen is the whole part softened.
  const initialised = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !body || !node) return;
    const key = `${session.nodeId}:${session.editIndex}`;
    if (initialised.current === key) return;
    initialised.current = key;
    if (session.size > 0) return;
    const fresh = session.editIndex === null && !(node.edgeRounds?.length);
    const picked = fresh ? body.edges.map((e) => e.edge) : session.picked;
    const fitsAll = maxSizeFor(fresh ? body.edges : body.edges.filter((c) => picked.some((p) => sameEdge(p, c.edge))), session.mode);
    useStore.getState().updateEdgeRoundDraft({
      picked,
      size: suggestedSize(body.smallestDimension, fitsAll || maxSizeFor(body.edges, session.mode)),
    });
  }, [session, body, node]);
  useEffect(() => { if (!session) initialised.current = null; }, [session]);

  const project = useCallback((p: THREE.Vector3) => {
    const rect = gl.domElement.getBoundingClientRect();
    const v = p.clone().project(camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, behind: v.z > 1 };
  }, [camera, gl]);

  /** What the pointer is on: an edge near it, else the face under it. */
  const hoverNow = useCallback((): Hover => {
    if (!body || !pickMesh || !frame) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const caster = new THREE.Raycaster();
    caster.setFromCamera(
      new THREE.Vector2(((pointer.current.x - rect.left) / rect.width) * 2 - 1, -(((pointer.current.y - rect.top) / rect.height) * 2 - 1)),
      camera,
    );
    pickMesh.matrixWorld.copy(frame);
    const hit = caster.intersectObject(pickMesh, false)[0];

    // Nearest edge on screen. Only edges on the near side count: one is on the
    // near side if it borders the face under the pointer, or if it is about as
    // far from the camera as the point the pointer hit.
    const hitSurface = hit?.faceIndex != null ? body.triangleSurface[hit.faceIndex] : -1;
    const hitDepth = hit ? hit.distance : Infinity;
    let best: { id: number; px: number } | null = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const candidate of body.edges) {
      const pts = candidate.points;
      const count = candidate.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < count; i++) {
        a.set(...pts[i]).applyMatrix4(frame);
        b.set(...pts[(i + 1) % pts.length]).applyMatrix4(frame);
        const pa = project(a);
        const pb = project(b);
        if (pa.behind || pb.behind) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((pointer.current.x - pa.x) * dx + (pointer.current.y - pa.y) * dy) / len2)) : 0;
        const px = Math.hypot(pointer.current.x - (pa.x + t * dx), pointer.current.y - (pa.y + t * dy));
        if (px > PICK_PIXELS || (best && px >= best.px)) continue;
        const near = candidate.surfaces.includes(hitSurface) ||
          (Number.isFinite(hitDepth) && camera.position.distanceTo(a.clone().lerp(b, t)) <= hitDepth * 1.02) ||
          !hit;
        if (near) best = { id: candidate.id, px };
      }
    }
    if (best) return { edge: best.id };
    if (hitSurface >= 0 && edgesOfSurface(body.edges, hitSurface).length > 0) return { surface: hitSurface };
    return null;
  }, [body, camera, frame, gl, pickMesh, project]);

  const toggle = useCallback((what: Hover) => {
    const state = useStore.getState();
    const current = state.edgeRoundSession;
    if (!current || !body || !what) return;
    const group: EdgeCandidate[] = 'edge' in what
      ? body.edges.filter((e) => e.id === what.edge)
      : edgesOfSurface(body.edges, what.surface);
    const has = (c: EdgeCandidate) => current.picked.some((p) => sameEdge(p, c.edge));
    // A face whose edges are all in already comes out; otherwise the rest go in.
    const removing = group.every(has);
    const picked = removing
      ? current.picked.filter((p) => !group.some((c) => sameEdge(p, c.edge)))
      : [...current.picked, ...group.filter((c) => !has(c)).map((c) => c.edge)];
    state.updateEdgeRoundDraft({ picked });
  }, [body]);

  // Pointer: hover on move, toggle on a left click on the canvas.
  useEffect(() => {
    if (!session) return;
    let queued = 0;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        setHover(hoverNow());
      });
    };
    const onCanvas = (event: PointerEvent) => event.target === gl.domElement;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !onCanvas(event)) return;
      event.preventDefault();
      event.stopPropagation();
      pointer.current = { x: event.clientX, y: event.clientY };
      toggle(hoverNow());
    };
    const swallow = (event: PointerEvent) => {
      if (event.button !== 0 || !onCanvas(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('click', swallow as EventListener, true);
    return () => {
      if (queued) cancelAnimationFrame(queued);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('click', swallow as EventListener, true);
      setHover(null);
    };
  }, [gl, hoverNow, session, toggle]);

  // E opens the tool on the selected part; Enter keeps the result, Esc puts it back.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const state = useStore.getState();
      if (state.edgeRoundSession) {
        if (key === 'escape') { event.stopImmediatePropagation(); state.cancelEdgeRound(); }
        else if (key === 'enter') { event.stopImmediatePropagation(); state.applyEdgeRound(); }
        else if (key === 'e') { event.stopImmediatePropagation(); state.applyEdgeRound(); }
        return;
      }
      if (key !== 'e') return;
      if (state.gestureStatus || state.draggedNodeId || state.paintMode || state.measureMode) return;
      if (startRoundingSelected()) event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Asked for from the mode menu; any other mode there keeps what is on screen.
  useEffect(() => {
    const onAsked = (event: Event) => {
      const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
      if (kind === 'round-edges') startRoundingSelected();
      else useStore.getState().applyEdgeRound();
    };
    window.addEventListener('physbox:gesture', onAsked);
    return () => window.removeEventListener('physbox:gesture', onAsked);
  }, []);

  // Selecting another part, or starting the simulation, keeps the result.
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const playing = useStore((s) => s.isPlaying);
  useEffect(() => {
    const open = useStore.getState().edgeRoundSession;
    if (open && (playing || (selectedNodeId && selectedNodeId !== open.nodeId))) useStore.getState().applyEdgeRound();
  }, [playing, selectedNodeId]);
  // The part deleted out from under the tool: nothing to keep.
  useEffect(() => {
    if (session && !node) useStore.setState({ edgeRoundSession: null });
  }, [node, session]);

  // The prompt in the status bar, like every other modal tool.
  useEffect(() => {
    if (!session) return;
    const n = session.picked.length;
    const hoverText = hover && 'edge' in hover ? ' · click to add or remove this edge'
      : hover && 'surface' in hover ? ' · click to take all of this face’s edges' : '';
    useStore.getState().setGestureStatus(
      body ? `Round edges · ${n} picked${hoverText}` : 'Round edges · finding edges…',
    );
    return () => useStore.getState().setGestureStatus(null);
  }, [body, hover, session]);

  if (!session || !body) return null;

  const pickedIds = new Set(body.edges.filter((c) => session.picked.some((p) => sameEdge(p, c.edge))).map((c) => c.id));
  const otherIds = new Set(
    body.edges
      .filter((c) => !pickedIds.has(c.id) && (session.base ?? []).some((f, i) => i !== session.editIndex && f.edges.some((e) => sameEdge(e, c.edge))))
      .map((c) => c.id),
  );
  const hoverIds = new Set(
    !hover ? [] : 'edge' in hover ? [hover.edge] : edgesOfSurface(body.edges, hover.surface).map((c) => c.id),
  );

  return (
    <group ref={frameRef}>
      {body.edges.map((candidate) => {
        const points = candidate.closed ? [...candidate.points, candidate.points[0]] : candidate.points;
        const hovered = hoverIds.has(candidate.id);
        const picked = pickedIds.has(candidate.id);
        const colour = hovered ? '#6366f1' : picked ? '#f59e0b' : otherIds.has(candidate.id) ? '#10b981' : '#64748b';
        return (
          <Line
            key={candidate.id}
            points={points}
            color={colour}
            lineWidth={hovered ? 4 : picked ? 3.5 : 1.5}
            transparent
            opacity={hovered || picked ? 1 : 0.55}
            renderOrder={hovered || picked ? 998 : 997}
          />
        );
      })}
    </group>
  );
};

export default EdgeRoundTool;
