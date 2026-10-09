import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Pause, Play } from 'lucide-react';
import type { Mat3, PrintPose, Vec3 } from '../../utils/printPlate';
import { poseMatrix } from '../../utils/printPlate';
import type { StageFrame, StageSpec } from '../../utils/printAssembly';

export interface PreviewSection {
  /** Body frame, Z-up, metres. */
  positions: Float32Array;
  faces: Uint32Array;
  /** Which way it moves when the assembly is pulled apart. */
  explode: Vec3;
  colour: number[];
  pose: PrintPose;
}

export interface PreviewStage {
  stage: StageSpec;
  frames: StageFrame[];
}

/**
 * Which stages to play, in order. Everything an earlier stage put together is
 * already in place when `from` starts; everything a later stage brings is not
 * there yet.
 */
export interface PreviewReplay {
  stages: PreviewStage[];
  from: number;
  to: number;
}

/** How long the swing from print pose into the starting position takes, s. */
const PRELUDE_S = 1.0;
/** The simulation is a tenth of a second of falling: shown at a tenth of real speed. */
const PLAYBACK_RATE = 0.1;
/** How long a stage stays on screen once its parts have come to rest, s. */
const HOLD_S = 0.4;
/** Closer to its final place than this, a part has arrived, m. */
const ARRIVED_M = 2e-5;

/**
 * The time a stage's parts last moved. The test runs on until they are quite
 * still, which can be most of a second of nothing — ten seconds of nothing at
 * replay speed — so the replay stops watching once they have arrived.
 */
function activeUntil(frames: StageFrame[]): number {
  const last = frames[frames.length - 1];
  for (let i = frames.length - 1; i >= 0; i--) {
    const moved = frames[i].poses.some((p, k) => {
      const q = last.poses[k];
      const dq = Math.abs(p[3] * q[3] + p[4] * q[4] + p[5] * q[5] + p[6] * q[6]);
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > ARRIVED_M || dq < 1 - 1e-8;
    });
    if (moved) return frames[Math.min(i + 1, frames.length - 1)].t;
  }
  return frames[0].t;
}

function matrixOf(R: Mat3, t: ArrayLike<number> = [0, 0, 0]): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    R[0], R[1], R[2], t[0],
    R[3], R[4], R[5], t[1],
    R[6], R[7], R[8], t[2],
    0, 0, 0, 1,
  );
}

/** A section's surface, flat shaded: its corners are shared, and smoothing across a cut edge looks like a bevel. */
function geometryOf(positions: Float32Array, faces: Uint32Array): THREE.BufferGeometry {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(faces, 1));
  const geo = indexed.toNonIndexed();
  indexed.dispose();
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const materialOf = (colour: number[]) => new THREE.MeshStandardMaterial({
  color: new THREE.Color(colour[0], colour[1], colour[2]),
  metalness: 0.05,
  roughness: 0.7,
});

function disposeChildren(group: THREE.Object3D) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    child.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    group.remove(child);
  }
}

/**
 * Split for Print's viewport: the sections pulled apart along their cuts with
 * the pins marked, or — once an assembly test has run — one stage of it
 * replayed, with a scrubber.
 *
 * A replayed join opens with the incoming part swinging from the way it is
 * printed to where the test dropped it from. That swing is drawn, not
 * simulated, and it says so while it plays.
 */
export function AssemblyPreview({
  sections,
  pins,
  explodeMm,
  replay,
  dowel,
}: {
  sections: PreviewSection[];
  pins: Vec3[];
  explodeMm: number;
  replay: PreviewReplay | null;
  /** Dowel radius and length, m, for drawing a dowels stage. */
  dowel?: { radius: number; length: number };
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const explodedRef = useRef<THREE.Group | null>(null);
  const replayRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const framedRef = useRef<string>('');
  const [t, setT] = useState(0);
  const centres = useMemo(() => sections.map((sec) => {
    const c = new THREE.Vector3();
    const n = sec.positions.length / 3;
    for (let i = 0; i < sec.positions.length; i += 3) c.add(new THREE.Vector3(sec.positions[i], sec.positions[i + 1], sec.positions[i + 2]));
    return n ? c.divideScalar(n) : c;
  }), [sections]);
  const [playing, setPlaying] = useState(false);
  // How far apart, handed to the render loop, which places the pieces.
  const explodeRef = useRef(explodeMm);
  useEffect(() => { explodeRef.current = explodeMm; }, [explodeMm]);
  // A new replay starts from the top. Reset while rendering, not in an effect,
  // which is React's way to reset state when a prop changes.
  const [shownReplay, setShownReplay] = useState(replay);
  if (shownReplay !== replay) {
    setShownReplay(replay);
    setT(0);
    setPlaying(!!replay);
  }

  // The timeline: each stage played gets its swing-in (joins only) and then
  // its simulation, slowed down.
  const segments = useMemo(() => {
    if (!replay) return [];
    const out: { k: number; start: number; prelude: number; sim: number }[] = [];
    let at = 0;
    for (let k = replay.from; k <= replay.to; k++) {
      const { stage, frames } = replay.stages[k];
      const prelude = stage.kind === 'join' ? PRELUDE_S : 0;
      const sim = frames.length ? (activeUntil(frames) - frames[0].t) / PLAYBACK_RATE + HOLD_S : 0;
      out.push({ k, start: at, prelude, sim });
      at += prelude + sim;
    }
    return out;
  }, [replay]);
  const total = segments.length ? segments[segments.length - 1].start + segments[segments.length - 1].prelude + segments[segments.length - 1].sim : 0;
  const segmentAt = useCallback((time: number) => {
    let seg = segments[0];
    for (const g of segments) if (g.start <= time) seg = g;
    return seg;
  }, [segments]);

  // The renderer, once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 100);
    camera.up.set(0, 0, 1);
    camera.position.set(0.5, -0.8, 0.55);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controlsRef.current = controls;
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-1.2, 1.6, 2.2);
    scene.add(key);
    const exploded = new THREE.Group();
    const replayGroup = new THREE.Group();
    scene.add(exploded, replayGroup);
    explodedRef.current = exploded;
    replayRef.current = replayGroup;

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 320;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const apart = explodeRef.current / 1000;
      for (const child of exploded.children) {
        const e = child.userData.explode as Vec3 | undefined;
        if (e) child.position.set(e[0] * apart, e[1] * apart, e[2] * apart);
        // Pins sit on the faces, which separate; pulled apart, they float between.
        if (child.userData.pin) child.visible = apart === 0;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      disposeChildren(exploded);
      disposeChildren(replayGroup);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const frameView = (obj: THREE.Object3D, key: string) => {
    if (framedRef.current === key || !cameraRef.current || !controlsRef.current) return;
    framedRef.current = key;
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 0.1;
    const dist = radius * 2.4;
    cameraRef.current.position.set(centre.x + dist * 0.55, centre.y - dist * 0.9, centre.z + dist * 0.6);
    cameraRef.current.near = radius / 200;
    cameraRef.current.far = radius * 50;
    cameraRef.current.updateProjectionMatrix();
    controlsRef.current.target.copy(centre);
    controlsRef.current.update();
  };

  // The exploded view.
  useEffect(() => {
    const group = explodedRef.current;
    if (!group) return;
    disposeChildren(group);
    sections.forEach((s) => {
      const mesh = new THREE.Mesh(geometryOf(s.positions, s.faces), materialOf(s.colour));
      mesh.userData.explode = s.explode;
      group.add(mesh);
    });
    if (pins.length) {
      const r = Math.max(0.001, (group.children[0] as THREE.Mesh | undefined)?.geometry.boundingSphere?.radius ?? 0.1) / 60;
      const pinGeo = new THREE.SphereGeometry(r, 12, 8);
      const pinMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e });
      for (const p of pins) {
        const m = new THREE.Mesh(pinGeo, pinMat);
        m.position.set(p[0], p[1], p[2]);
        m.userData.pin = true;
        group.add(m);
      }
    }
    frameView(group, `exploded:${sections.length}:${sections[0]?.positions.length ?? 0}`);
  }, [sections, pins]);


  // The replay's scene: every section, in the part's own frame, in its own
  // colour, and every dowel. Built once per replay; the clock only moves them.
  const replayObjects = useRef<{ sections: THREE.Object3D[]; dowels: { stage: number; index: number; obj: THREE.Object3D }[] }>({ sections: [], dowels: [] });
  useEffect(() => {
    const group = replayRef.current;
    const exploded = explodedRef.current;
    if (!group || !exploded) return;
    disposeChildren(group);
    replayObjects.current = { sections: [], dowels: [] };
    exploded.visible = !replay;
    if (!replay) return;
    replayObjects.current.sections = sections.map((sec) => {
      const mesh = new THREE.Mesh(geometryOf(sec.positions, sec.faces), materialOf(sec.colour));
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      return mesh;
    });
    if (dowel) {
      replay.stages.forEach(({ stage }, k) => {
        if (stage.kind !== 'dowels') return;
        stage.moving.forEach((_, index) => {
          const holder = new THREE.Group();
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(dowel.radius, dowel.radius, dowel.length, 24), materialOf([0.85, 0.7, 0.45]));
          cyl.rotation.x = Math.PI / 2; // three's cylinder runs along Y; MuJoCo's along Z
          holder.add(cyl);
          holder.matrixAutoUpdate = false;
          group.add(holder);
          replayObjects.current.dowels.push({ stage: k, index, obj: holder });
        });
      });
    }
    // Framed on the whole part, assembled, so the view holds still across stages.
    const box = new THREE.Box3();
    for (const m of replayObjects.current.sections) {
      (m as THREE.Mesh).geometry.computeBoundingBox();
      box.union((m as THREE.Mesh).geometry.boundingBox!);
    }
    const holder = new THREE.Object3D();
    const helper = new THREE.Mesh(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray()));
    helper.position.copy(box.getCenter(new THREE.Vector3()));
    holder.add(helper);
    frameView(holder, `replay:${sections.length}:${replay.stages.length}`);
    helper.geometry.dispose();
  }, [replay, sections, dowel]);

  // Where everything is at time t.
  useEffect(() => {
    if (!replay || !segments.length) return;
    const objs = replayObjects.current;
    const seg = segmentAt(t);
    const k = seg.k;
    const { stage, frames } = replay.stages[k];
    // A stage's world is the part turned so its cut points up; seen from the
    // part's own frame, that turn is undone.
    const toPart = matrixOf(stage.worldRotation, stage.worldOffset).invert();
    const poseAt = (body: number, simT: number) => {
      if (!frames.length) return new THREE.Matrix4();
      const t0 = frames[0].t;
      let i = 0;
      while (i + 1 < frames.length && frames[i + 1].t - t0 <= simT) i++;
      const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
      const span = b.t - a.t;
      const f = span > 0 ? Math.min(1, Math.max(0, (simT - (a.t - t0)) / span)) : 0;
      const pa = a.poses[body], pb = b.poses[body];
      const pos = new THREE.Vector3(pa[0], pa[1], pa[2]).lerp(new THREE.Vector3(pb[0], pb[1], pb[2]), f);
      const q = new THREE.Quaternion(pa[4], pa[5], pa[6], pa[3]).slerp(new THREE.Quaternion(pb[4], pb[5], pb[6], pb[3]), f);
      return new THREE.Matrix4().multiplyMatrices(toPart, new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
    };

    // Which sections are in by this stage: everything any stage up to and
    // including this one has handled, plus everything stages before the
    // replay began put together.
    const inBy = new Set<number>();
    replay.stages.forEach(({ stage: st }, j) => {
      if (j > k) return;
      st.fixed.sections.forEach((s) => inBy.add(s));
      st.moving.forEach((m) => m.sections.forEach((s) => inBy.add(s)));
    });
    const movingHere = new Map<number, number>();
    stage.moving.forEach((m, body) => m.sections.forEach((s) => movingHere.set(s, body)));

    const local = t - seg.start;
    const simT = Math.max(0, local - seg.prelude) * PLAYBACK_RATE;
    objs.sections.forEach((obj, s) => {
      obj.visible = inBy.has(s);
      const body = movingHere.get(s);
      if (body === undefined) { obj.matrix.identity(); return; }
      if (local >= seg.prelude) { obj.matrix.copy(poseAt(body, simT)); return; }
      // Not physics: swung over from the way it is printed, about its own middle.
      const start = poseAt(body, 0);
      const startPos = new THREE.Vector3(), startQ = new THREE.Quaternion();
      start.decompose(startPos, startQ, new THREE.Vector3());
      const firstSection = stage.moving[body].sections[0];
      const printed = new THREE.Quaternion().setFromRotationMatrix(matrixOf(poseMatrix(sections[firstSection].pose)));
      const f = local / seg.prelude;
      const ease = f * f * (3 - 2 * f);
      const q = printed.clone().slerp(startQ, ease);
      const c = centres[firstSection] ?? new THREE.Vector3();
      const settledCentre = c.clone().applyMatrix4(start);
      const aside = new THREE.Vector3(...sections[firstSection].explode).normalize().multiplyScalar(Math.max(0.05, stage.spanM * 1.3));
      if (aside.lengthSq() === 0) aside.set(Math.max(0.05, stage.spanM * 1.3), 0, 0);
      const centreNow = settledCentre.clone().add(aside.multiplyScalar(1 - ease));
      // Turn about the section's middle, then put that middle where it belongs.
      const turned = c.clone().applyQuaternion(q);
      obj.matrix.compose(centreNow.sub(turned), q, new THREE.Vector3(1, 1, 1));
    });
    objs.dowels.forEach(({ stage: ds, index, obj }) => {
      if (ds > k) { obj.visible = false; return; }
      obj.visible = true;
      const dst = replay.stages[ds];
      if (ds < k) {
        // Seated in its hole, so it goes wherever the section with that hole
        // goes — including when that section is the one swinging in.
        const d = dst.stage.moving[index];
        const seated = new THREE.Matrix4().multiplyMatrices(
          matrixOf(dst.stage.worldRotation, dst.stage.worldOffset).invert(),
          new THREE.Matrix4().compose(new THREE.Vector3(...d.designedPos), new THREE.Quaternion(d.designedQuat[1], d.designedQuat[2], d.designedQuat[3], d.designedQuat[0]), new THREE.Vector3(1, 1, 1)),
        );
        const host = d.host !== undefined ? objs.sections[d.host] : undefined;
        obj.matrix.multiplyMatrices(host ? host.matrix : new THREE.Matrix4(), seated);
      } else {
        obj.matrix.copy(poseAt(index, simT));
      }
    });
  }, [t, replay, segments, segmentAt, sections, centres]);

  // Playback.
  useEffect(() => {
    if (!playing || !replay) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= total) { setPlaying(false); return total; }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, replay, total]);

  // Which sections the replay has brought in so far, and which are moving now.
  const legendState = (() => {
    if (!replay || !segments.length) return null;
    const k = segmentAt(t).k;
    const inBy = new Set<number>();
    replay.stages.forEach(({ stage: st }, j) => {
      if (j > k) return;
      st.fixed.sections.forEach((s) => inBy.add(s));
      st.moving.forEach((m) => m.sections.forEach((s) => inBy.add(s)));
    });
    const moving = new Set(replay.stages[k].stage.moving.flatMap((m) => m.sections));
    return { inBy, moving };
  })();

  const caption = (() => {
    if (!replay || !segments.length) return 'Drag to orbit · scroll to zoom';
    const seg = segmentAt(t);
    const label = replay.stages[seg.k].stage.label;
    if (t - seg.start < seg.prelude) return `${label} · bringing it over — drawn, not simulated`;
    return `${label} · MuJoCo, ${((t - seg.start - seg.prelude) * PLAYBACK_RATE * 1000).toFixed(0)} ms, at a tenth of real speed`;
  })();

  return (
    <div className="space-y-2">
      <div className="relative w-full h-72 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden">
        <div className="absolute inset-0" ref={mountRef} />
        {!sections.length && (
          <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-slate-400 pointer-events-none">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Finding the cuts…
            </span>
          </div>
        )}
        <div className="absolute bottom-2 left-2 bg-slate-900/80 backdrop-blur-md px-2 py-1 rounded text-[10px] text-slate-300 border border-slate-700 pointer-events-none">
          {caption}
        </div>
        {/* Which colour is which section: the numbers the stage labels, the
            warnings and the applied bodies (_part2, _part3…) use. */}
        {sections.length > 1 && (
          <div className="absolute top-2 right-2 max-w-[60%] flex flex-wrap justify-end gap-1 pointer-events-none">
            {sections.map((sec, i) => {
              const dim = legendState && !legendState.inBy.has(i);
              const active = legendState?.moving.has(i);
              return (
                <span
                  key={i}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900/80 backdrop-blur-md border text-[10px] font-mono transition-opacity ${
                    active ? 'border-emerald-400 text-white' : 'border-slate-700 text-slate-300'
                  } ${dim ? 'opacity-35' : ''}`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    // Through three's colour management, as the material is, so
                    // the swatch matches the section rather than looking darker.
                    style={{ background: new THREE.Color(sec.colour[0], sec.colour[1], sec.colour[2]).getStyle() }}
                  />
                  {i + 1}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {replay && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { if (t >= total) setT(0); setPlaying(!playing); }}
            className="p-1.5 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer"
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={total || 1}
            step={0.01}
            value={t}
            onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
            className="flex-1 accent-emerald-500"
            aria-label="Replay position"
          />
        </div>
      )}
    </div>
  );
}
