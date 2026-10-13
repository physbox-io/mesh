// ---------------------------------------------------------------------------
// The knife (K): a line drawn across the selected part divides its faces
// ---------------------------------------------------------------------------
//
// Drag a line across the part on screen. The cut is the plane through that
// line, looking straight in, and by default it leaves a SEAM: the part stays
// one solid, but the faces the line was drawn over become two faces each, and
// a pattern, its hover and its overlap check stop at the seam as they stop at
// a sharp edge (SceneGeom.faceSplits, utils/surfaceTexture). Halving a sphere
// is one drag through its middle, and then each half takes its own pattern.
//
// C, before the drag or during it, cuts right through instead (and back): the
// part becomes separate
// closed bodies with flat faces at the cut (cutAlongPlane, put in the scene by
// splitBodyForPrint as a plain cut).
//
// The line snaps to 15° steps and through the middle of the part; Alt holds
// it free. With the knife out, a seam under the pointer lights up and a click
// on it takes it off.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { findNodeById } from '../../utils/sceneTree';
import { splitSeams, type FaceSplit } from '../../utils/surfaceTexture';
import { patternHit, patternSurfaces } from '../../utils/facePatternPick';
import { cutAlongPlaneOffThread, partSoups } from '../../utils/printSplitClient';
import { bodyParent, bodyToParent, rayInBody } from './bodyRay';

interface Drag {
  x0: number; y0: number; x1: number; y1: number;
  /** Cut right through into pieces, rather than leave a seam. */
  separate: boolean;
  free: boolean;
}

/** A seam on the part, and which geom's list it is in. */
interface Seam {
  geomName: string;
  index: number;
  /** Body frame. */
  segments: Float32Array;
}

/** Below this many pixels a press is a click, not a line. */
const CLICK_PX = 5;
/** How near the pointer a seam lights up, pixels. */
const SEAM_REACH_PX = 7;
/** The line passes through the middle of the part when it comes this near, pixels. */
const CENTRE_SNAP_PX = 12;
const ANGLE_STEP = Math.PI / 12;
const ANGLE_SNAP = (5 * Math.PI) / 180;

const idleStatus = (separate: boolean) => separate
  ? 'Knife · drag across the part to cut it into pieces · C for a seam instead · Esc to stop'
  : 'Knife · drag across the part to split its face · C to cut right through · Esc to stop';

/*
 * Each line twice: bright where it can be seen, faint where the part is in
 * front of it. Lines lying on a surface fight it for depth; the faint pass
 * keeps them from flickering out, and shows the far side of a cut.
 */
const lineMaterial = (color: number, behind: boolean) => new THREE.LineBasicMaterial({
  color, transparent: true, opacity: behind ? 0.3 : 0.95, depthWrite: false, depthTest: !behind,
});
const MATERIALS = {
  seam: [lineMaterial(0xd946ef, false), lineMaterial(0xd946ef, true)],
  hot: [lineMaterial(0xfdf4ff, false), lineMaterial(0xfdf4ff, true)],
  cut: [lineMaterial(0xef4444, false), lineMaterial(0xef4444, true)],
} as const;

/** Where a plane crosses a surface's triangles, as segments in the surface's frame. */
function planeSection(positions: ArrayLike<number>, faces: ArrayLike<number>, at: THREE.Vector3, n: THREE.Vector3): number[] {
  const out: number[] = [];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const d = [0, 0, 0];
  for (let f = 0; f + 2 < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      p[k].fromArray(positions as number[], 3 * faces[f + k]);
      d[k] = n.dot(p[k]) - n.dot(at);
    }
    const hits: THREE.Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const a = d[k], b = d[(k + 1) % 3];
      if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) hits.push(p[k].clone().lerp(p[(k + 1) % 3], a / (a - b)));
    }
    if (hits.length === 2) out.push(...hits[0].toArray(), ...hits[1].toArray());
  }
  return out;
}

export const FaceKnife = () => {
  const { scene, camera, gl, invalidate } = useThree();
  const setGestureStatus = useStore((s) => s.setGestureStatus);
  const armed = useRef(false);
  const drag = useRef<Drag | null>(null);
  const hot = useRef<Seam | null>(null);
  /** C: the next line cuts right through. Set before the drag or during it. */
  const separate = useRef(false);
  const busy = useRef(false);
  const layer = useRef<THREE.Group | null>(null);
  const overlay = useRef<{ svg: SVGSVGElement; line: SVGLineElement; dot: SVGCircleElement } | null>(null);
  const frame = useRef(0);

  const selected = useCallback((): { node: SceneNode; parent: THREE.Object3D } | null => {
    const store = useStore.getState();
    if (!store.selectedNodeId) return null;
    const node = findNodeById(store.sceneGraph.nodes, store.selectedNodeId);
    const parent = node ? bodyParent(scene, node.id) : null;
    return node && parent ? { node, parent } : null;
  }, [scene]);

  /** Body frame to client pixels. */
  const toScreen = useCallback((node: SceneNode, parent: THREE.Object3D) => {
    const toWorld = new THREE.Matrix4().multiplyMatrices(parent.matrixWorld, bodyToParent(node, parent));
    const rect = gl.domElement.getBoundingClientRect();
    return (p: THREE.Vector3) => {
      const v = p.clone().applyMatrix4(toWorld).project(camera);
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, front: v.z < 1 };
    };
  }, [camera, gl]);

  /** Every seam on the part, body frame. */
  const seamsOf = useCallback((node: SceneNode): Seam[] => patternSurfaces(node).flatMap(({ geom, base, toBody }) => {
    const splits = geom.faceSplits ?? [];
    return splitSeams(base.positions, base.faces, splits).map((segments, index) => {
      const out = segments.slice();
      const v = new THREE.Vector3();
      for (let i = 0; i < out.length; i += 3) {
        v.set(out[i], out[i + 1], out[i + 2]).applyMatrix4(toBody);
        out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
      }
      return { geomName: geom.name, index, segments: out };
    });
  }), []);

  /** The middle of the part's bounding box, body frame. */
  const centreOf = useCallback((node: SceneNode) => {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const { base, toBody } of patternSurfaces(node)) {
      for (let i = 0; i < base.positions.length; i += 3) box.expandByPoint(v.fromArray(base.positions, i).applyMatrix4(toBody));
    }
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  }, []);

  /**
   * The line as it will cut: turned to the nearest 15° step and moved through
   * the middle of the part when it is close to either, unless held free.
   */
  const snapped = useCallback((d: Drag, node: SceneNode, parent: THREE.Object3D) => {
    let { x0, y0, x1, y1 } = d;
    let throughCentre = false;
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (!d.free && length >= CLICK_PX) {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const step = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
      if (Math.abs(angle - step) < ANGLE_SNAP) {
        x1 = x0 + Math.cos(step) * length;
        y1 = y0 + Math.sin(step) * length;
      }
      const centre = centreOf(node);
      if (centre) {
        const c = toScreen(node, parent)(centre);
        const ux = (x1 - x0) / length, uy = (y1 - y0) / length;
        const off = (c.x - x0) * -uy + (c.y - y0) * ux;
        if (Math.abs(off) < CENTRE_SNAP_PX) {
          x0 += -uy * off; y0 += ux * off; x1 += -uy * off; y1 += ux * off;
          throughCentre = true;
        }
      }
    }
    return { x0, y0, x1, y1, throughCentre };
  }, [centreOf, toScreen]);

  /** The cut a line makes: its plane in the body frame, and the points on the part it was drawn over, by geom. */
  const cutOf = useCallback((line: { x0: number; y0: number; x1: number; y1: number }, node: SceneNode, parent: THREE.Object3D) => {
    const a = rayInBody(node, parent, camera, gl.domElement, line.x0, line.y0);
    const b = rayInBody(node, parent, camera, gl.domElement, line.x1, line.y1);
    const o1 = new THREE.Vector3().fromArray(a.origin), d1 = new THREE.Vector3().fromArray(a.direction);
    const o2 = new THREE.Vector3().fromArray(b.origin), d2 = new THREE.Vector3().fromArray(b.direction);
    // Through both rays: d1 × d2 for a perspective eye, d × (o2 − o1) for an orthographic one.
    const normal = d1.clone().cross(o2.clone().add(d2).sub(o1));
    if (normal.lengthSq() < 1e-18) return null;
    normal.normalize();
    const centre = centreOf(node) ?? o1;
    const at = centre.clone().addScaledVector(normal, -normal.dot(centre.clone().sub(o1)));
    const seeds = new Map<string, number[][]>();
    const SAMPLES = 40;
    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const ray = rayInBody(node, parent, camera, gl.domElement, line.x0 + (line.x1 - line.x0) * t, line.y0 + (line.y1 - line.y0) * t);
      const hit = patternHit(node, ray.origin, ray.direction);
      if (hit) seeds.set(hit.geom.name, [...(seeds.get(hit.geom.name) ?? []), hit.at]);
    }
    return { at, normal, seeds };
  }, [camera, centreOf, gl]);

  /** A geom's seam for a cut, in its own frame. */
  const splitFor = (toBody: THREE.Matrix4, at: THREE.Vector3, normal: THREE.Vector3, seeds: number[][]): FaceSplit => {
    const toGeom = toBody.clone().invert();
    const round = (v: THREE.Vector3) => v.toArray().map((x) => +x.toFixed(7));
    return {
      at: round(at.clone().applyMatrix4(toGeom)),
      normal: round(normal.clone().transformDirection(toGeom)),
      seeds: seeds.map((s) => s.map((x) => +x.toFixed(7))),
    };
  };

  const ensureOverlay = useCallback(() => {
    if (overlay.current) return overlay.current;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:40;display:none');
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '6 4');
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('r', '4');
    svg.append(line, dot);
    document.body.appendChild(svg);
    overlay.current = { svg, line, dot };
    return overlay.current;
  }, []);

  /** Draws everything the knife shows: the part's seams, the one under the pointer, and the cut being drawn. */
  const redraw = useCallback(() => {
    if (layer.current) {
      layer.current.removeFromParent();
      layer.current.traverse((o) => { if (o instanceof THREE.LineSegments) o.geometry.dispose(); });
      layer.current = null;
    }
    const ui = ensureOverlay();
    ui.svg.style.display = 'none';
    const at = armed.current ? selected() : null;
    if (!at) { invalidate(); return; }
    const { node, parent } = at;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(bodyToParent(node, parent));
    group.renderOrder = 11;
    const add = (segments: ArrayLike<number>, kind: keyof typeof MATERIALS) => {
      if (!segments.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(segments), 3));
      for (const material of MATERIALS[kind]) group.add(new THREE.LineSegments(geometry, material));
    };
    for (const seam of seamsOf(node)) {
      const isHot = !drag.current && hot.current?.geomName === seam.geomName && hot.current.index === seam.index;
      add(seam.segments, isHot ? 'hot' : 'seam');
    }

    const d = drag.current;
    if (d && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= CLICK_PX) {
      const line = snapped(d, node, parent);
      const colour = d.separate ? '#ef4444' : '#d946ef';
      ui.svg.style.display = 'block';
      ui.line.setAttribute('x1', `${line.x0}`); ui.line.setAttribute('y1', `${line.y0}`);
      ui.line.setAttribute('x2', `${line.x1}`); ui.line.setAttribute('y2', `${line.y1}`);
      ui.line.setAttribute('stroke', colour);
      ui.dot.setAttribute('fill', colour);
      ui.dot.style.display = line.throughCentre ? '' : 'none';
      if (line.throughCentre) {
        const c = centreOf(node);
        if (c) {
          const s = toScreen(node, parent)(c);
          ui.dot.setAttribute('cx', `${s.x}`); ui.dot.setAttribute('cy', `${s.y}`);
        }
      }
      const cut = cutOf(line, node, parent);
      let faces = 0;
      if (cut) {
        for (const { geom, base, toBody } of patternSurfaces(node)) {
          const toGeom = toBody.clone().invert();
          let segments: ArrayLike<number> = [];
          if (d.separate) {
            segments = planeSection(base.positions, base.faces, cut.at.clone().applyMatrix4(toGeom), cut.normal.clone().transformDirection(toGeom));
          } else {
            const seeds = cut.seeds.get(geom.name);
            if (!seeds) continue;
            [segments] = splitSeams(base.positions, base.faces, [splitFor(toBody, cut.at, cut.normal, seeds)]);
            if (segments.length) faces++;
          }
          if (!segments.length) continue;
          const out = Array.from(segments);
          const v = new THREE.Vector3();
          for (let i = 0; i < out.length; i += 3) {
            v.set(out[i], out[i + 1], out[i + 2]).applyMatrix4(toBody);
            out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
          }
          add(out, d.separate ? 'cut' : 'seam');
        }
      }
      const middle = line.throughCentre ? ' · through the middle' : '';
      setGestureStatus(d.separate
        ? `Knife · cut into pieces${middle} · C for a seam instead`
        : faces ? `Knife · seam${middle} · C to cut right through` : 'Knife · draw the line across the part');
    } else {
      setGestureStatus(hot.current ? 'Knife · click to remove this seam' : idleStatus(separate.current));
    }
    parent.add(group);
    layer.current = group;
    invalidate();
  }, [centreOf, cutOf, ensureOverlay, invalidate, seamsOf, selected, setGestureStatus, snapped, toScreen]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      redraw();
    });
  }, [redraw]);

  /** The seam nearest the pointer on screen, if one is near enough. */
  const seamAt = useCallback((x: number, y: number): Seam | null => {
    const at = selected();
    if (!at) return null;
    const project = toScreen(at.node, at.parent);
    let best: Seam | null = null;
    let bestDist = SEAM_REACH_PX;
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const seam of seamsOf(at.node)) {
      const s = seam.segments;
      for (let i = 0; i + 5 < s.length; i += 6) {
        const a = project(p.set(s[i], s[i + 1], s[i + 2])), b = project(q.set(s[i + 3], s[i + 4], s[i + 5]));
        if (!a.front || !b.front) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
        const dist = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
        if (dist < bestDist) { bestDist = dist; best = seam; }
      }
    }
    return best;
  }, [seamsOf, selected, toScreen]);

  const arm = useCallback(() => {
    const store = useStore.getState();
    if (store.isPlaying || !selected()) return;
    armed.current = true;
    separate.current = false;
    drag.current = null;
    hot.current = null;
    redraw();
  }, [redraw, selected]);

  const disarm = useCallback(() => {
    if (!armed.current) return;
    armed.current = false;
    drag.current = null;
    hot.current = null;
    setGestureStatus(null);
    redraw();
  }, [redraw, setGestureStatus]);

  const flash = useCallback((text: string) => {
    setGestureStatus(text);
    window.setTimeout(() => {
      if (useStore.getState().gestureStatus === text) setGestureStatus(armed.current ? idleStatus(separate.current) : null);
    }, 3500);
  }, [setGestureStatus]);

  /** The line let go: a seam on the faces it crossed, or the part cut into pieces. */
  const finish = useCallback(async (d: Drag) => {
    const at = selected();
    if (!at) return;
    const { node, parent } = at;
    const store = useStore.getState();
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < CLICK_PX) {
      // A click: on a seam, it comes off.
      const seam = seamAt(d.x1, d.y1);
      const geom = seam && node.geoms?.find((g) => g.name === seam.geomName);
      if (seam && geom) {
        store.setGeomFaceSplits(node.id, geom.name, (geom.faceSplits ?? []).filter((_, i) => i !== seam.index));
        hot.current = null;
      }
      return;
    }
    const cut = cutOf(snapped(d, node, parent), node, parent);
    if (!cut) return;
    if (d.separate) {
      busy.current = true;
      setGestureStatus('Knife · cutting…');
      const { soups, absorbed } = partSoups(node);
      const result = await cutAlongPlaneOffThread(soups, cut.at.toArray(), cut.normal.toArray());
      busy.current = false;
      if (!result.ok) { flash(result.error); return; }
      useStore.getState().splitBodyForPrint(node.id, result.sections, absorbed, { plain: true });
      flash(`Cut into ${result.sections.length} pieces`);
      return;
    }
    let made = 0;
    for (const { geom, base, toBody } of patternSurfaces(node)) {
      const seeds = cut.seeds.get(geom.name);
      if (!seeds) continue;
      const split = splitFor(toBody, cut.at, cut.normal, seeds);
      // Kept only if it divides something: a line along an edge leaves no seam.
      if (!splitSeams(base.positions, base.faces, [split])[0].length) continue;
      // The geom as the scene graph has it, which is where the list is kept.
      const own = node.geoms?.find((g) => g.name === geom.name);
      if (!own) continue;
      store.setGeomFaceSplits(node.id, geom.name, [...(own.faceSplits ?? []), split]);
      made++;
    }
    if (!made) flash('Draw the line across the part to split its face');
  }, [cutOf, flash, seamAt, selected, setGestureStatus, snapped]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (armed.current) {
        if (key === 'escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (drag.current) { drag.current = null; schedule(); } else disarm();
        } else if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          // Held down, the key repeats: one press is one switch.
          if (event.repeat) return;
          separate.current = !separate.current;
          if (drag.current) drag.current.separate = separate.current;
          schedule();
        } else if (key === 'alt' && drag.current) {
          drag.current.free = true;
          schedule();
        }
        return;
      }
      if (key !== 'k' || event.metaKey || event.ctrlKey || event.altKey) return;
      const store = useStore.getState();
      if (store.isPlaying || store.latticeNodeId || store.sculptNodeId || store.paintMode || store.measureMode || store.gestureStatus) return;
      if (!store.selectedNodeId) return;
      event.preventDefault();
      arm();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt' && drag.current) { drag.current.free = false; schedule(); }
    };
    // The mode menu's "Knife", and every other choice there puts it away.
    const onAsked = (event: Event) => {
      const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
      if (kind === 'knife') arm();
      else disarm();
    };
    const down = (event: PointerEvent) => {
      if (!armed.current || busy.current || event.button !== 0 || event.target !== gl.domElement) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = { x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY, separate: separate.current, free: event.altKey };
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (!armed.current) return;
      const d = drag.current;
      if (d) {
        d.x1 = event.clientX;
        d.y1 = event.clientY;
        d.free = event.altKey;
        schedule();
        return;
      }
      const next = event.target === gl.domElement ? seamAt(event.clientX, event.clientY) : null;
      const same = next?.geomName === hot.current?.geomName && next?.index === hot.current?.index;
      if (!same) { hot.current = next; schedule(); }
    };
    const up = (event: PointerEvent) => {
      const d = drag.current;
      if (!armed.current || !d || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = null;
      void finish(d).then(schedule);
    };
    // A click that is the end of a line is not a selection.
    const swallowClick = (event: MouseEvent) => {
      if (armed.current && event.target === gl.domElement) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('physbox:gesture', onAsked);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('click', swallowClick, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('physbox:gesture', onAsked);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('click', swallowClick, true);
    };
  }, [arm, disarm, finish, gl, schedule, seamAt]);

  // Put away when the part it is cutting stops being the selection, or the
  // simulation starts; redrawn when the part changes under it (a seam added
  // or taken off, an undo).
  useEffect(() => useStore.subscribe((state, prev) => {
    if (!armed.current) return;
    if (state.selectedNodeId !== prev.selectedNodeId || (state.isPlaying && !prev.isPlaying)) disarm();
    else if (state.sceneGraph !== prev.sceneGraph) schedule();
  }), [disarm, schedule]);

  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    layer.current?.removeFromParent();
    overlay.current?.svg.remove();
    overlay.current = null;
  }, []);

  return null;
};
