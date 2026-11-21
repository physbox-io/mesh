import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { WebGLPathTracer, ShapedAreaLight, DenoiseMaterial } from 'three-gpu-pathtracer';
import { useStore } from '../../store/useStore';
import { useViewQuality, usePathTraceStatus, type PathTracePhase } from '../../store/viewQualityStore';
import type { BackgroundId } from '../../types/scene';
import { BACKGROUND_LIGHTING } from '../../utils/backgroundScenery';
import { buildTracedEquirectTexture } from '../../utils/backgroundTextures';
import { preToneMappedColor } from '../../utils/neutralToneMapping';
import { MeshBvhWorkerClient } from '../../utils/meshBvhWorkerClient';
import { TracedDespeckle } from '../../utils/tracedDespeckle';
import { TracedGlow } from '../../utils/tracedGlow';
import { withRgbaColors, withSceneryColorTrim } from '../../utils/tracerGeometry';

/** How long the view has to hold still before tracing starts. */
const SETTLE_MS = 350;
/**
 * Where it stops and the GPU goes idle. 256 left grit the denoiser could not
 * hide; grain falls as 1/sqrt(samples), so 512 takes twice as long for about
 * 70% of that grain, and the denoiser smooths what is left.
 */
const MAX_SAMPLES = 512;
/**
 * The denoiser's blur, in pixels, and how different two pixels' colours can be
 * (in linear light) and still be blurred together. Past the threshold the
 * filter treats the step as an edge and leaves it alone.
 */
const DENOISE_SIGMA = 4;
const DENOISE_THRESHOLD = 0.05;
/**
 * How many pieces a sample is cut into, across and down, one piece drawn per
 * frame. The tracer's default is 3, and on a 2080 Ti a ninth of a sample took a
 * fraction of a 75 Hz refresh, so the GPU idled most of every frame and a
 * render took 512 x 9 refreshes: 61-63 s. Whole samples, at 27 ms a frame,
 * took 11-13 s. So it starts whole, and a GPU that cannot draw a whole sample
 * in SLOW_FRAME_MS, SLOW_FRAMES_TO_STEP frames running, gets the next count
 * up, so the viewport stays usable while it renders.
 *
 * Not more samples per frame either: past one whole sample the GPU is full,
 * and two, four and eight a frame bought 4-19% for frames of 40-190 ms.
 */
const TILE_STEPS = [1, 2, 3];
const SLOW_FRAME_MS = 50;
const SLOW_FRAMES_TO_STEP = 5;
/**
 * Angular radius of the key light's disc, seen from the origin: about a degree
 * across, a little larger than the sun. Kept small so Render mode lights the
 * scene the way the raster view does, whose key is a directional light, a
 * point source. It was 0.1 rad (11 degrees across, a large softbox), and that
 * changed the picture rather than refined it: a pendulum's few-millimetre rods
 * swinging 200 mm up cast a penumbra ten times their width, so no core
 * shadow at all, where the raster view drew a clear one. At this size the
 * same rod's penumbra is about 4 mm.
 */
const KEY_LIGHT_ANGULAR_RADIUS = 0.01;

interface Engine {
  pathTracer: WebGLPathTracer;
  despeckle: TracedDespeckle;
  denoise: DenoiseMaterial;
  denoiseQuad: FullScreenQuad;
  glow: TracedGlow;
  glowScale: number;
  floor: THREE.Mesh;
  bvhWorker: MeshBvhWorkerClient;
}

function createEngine(gl: THREE.WebGLRenderer): Engine | null {
  try {
    const pt = new WebGLPathTracer(gl);
    pt.renderDelay = 0;
    pt.minSamples = 1;
    pt.fadeDuration = 300;
    // The raster frame underneath is the composer's, drawn already; the
    // tracer's own fallback would draw the live scene a second time, raw.
    pt.rasterizeScene = false;
    pt.bounces = 5;
    // The BVH is built in a worker (see workers/meshBvhWorker.ts): a sculpt
    // and its mould came to 600 k triangles and 3 s of frozen page.
    const bvhWorker = new MeshBvhWorkerClient();
    pt.setBVHWorker(bvhWorker);
    pt.tiles.set(TILE_STEPS[0], TILE_STEPS[0]);
    // Softens the fireflies a glossy surface throws off at low sample counts.
    pt.filterGlossyFactor = 0.5;
    // Copied to the canvas through an outlier despeckle pass + edge-preserving
    // bilateral blur rather than straight. A bilateral filter stops at big steps
    // in luminance, which preserves real edges and shadow lines — and would
    // otherwise preserve isolated 1 px fireflies or black/NaN pits even at 512
    // samples. `despeckle` clamps isolated 3x3 impulses first (ramping to full
    // strength at MAX_SAMPLES) while leaving 1 px lines and edges intact.
    const despeckle = new TracedDespeckle();
    const denoise = new DenoiseMaterial({ sigma: DENOISE_SIGMA, kSigma: 1, threshold: DENOISE_THRESHOLD });
    const denoiseQuad = new FullScreenQuad(denoise);
    const glow = new TracedGlow();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.updateMatrix();
    floor.matrixAutoUpdate = false;

    const engine: Engine = {
      pathTracer: pt,
      despeckle,
      denoise,
      denoiseQuad,
      glow,
      glowScale: 0,
      floor,
      bvhWorker,
    };

    pt.renderToCanvasCallback = (target, renderer, quad) => {
      const fade = quad.material as THREE.ShaderMaterial & { opacity: number };
      const despeckleStrength = Math.min(1, 0.45 + 0.55 * (pt.samples / MAX_SAMPLES));
      const cleaned = despeckle.filter(renderer, target.texture, target.width, target.height, despeckleStrength);
      denoise.map = cleaned;
      denoise.opacity = fade.opacity;
      denoise.blending = fade.blending;
      denoise.transparent = fade.opacity < 1;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      denoiseQuad.render(renderer);
      if (engine.glowScale > 0) {
        glow.render(renderer, cleaned, target.width, target.height, fade.opacity * engine.glowScale);
      }
      renderer.autoClear = autoClear;
    };

    return engine;
  } catch (e) {
    console.error('[PathTracedView] could not start the path tracer', e);
    return null;
  }
}

/**
 * Render mode: path traces the scene whenever the view is still.
 *
 * Mounted only while the Render button is on. Each frame it checks whether the
 * camera or any body has moved; if so it drops back to the raster view and
 * waits for SETTLE_MS of quiet, then rebuilds a scene of its own and accumulates
 * samples, fading the traced image in over the raster one until MAX_SAMPLES,
 * where it stops asking for frames. The raster composer keeps drawing
 * underneath at priority 1, so a frame drawn for any other reason still gets
 * the traced image put back on top.
 *
 * The traced scene is a copy, not the live one: the bodies only (meshes that
 * cast shadows with a standard material), drawn with their own geometry and
 * materials at their world transforms; a real floor in place of the grid and
 * shadow catcher, which a path tracer cannot draw; and a disc-shaped area light
 * standing in for the key light. A directional light is a true point to a path
 * tracer; a small disc casts the shadows the raster view does, in the same
 * places and the same shape, with an edge that softens a little with height.
 * The studio environment is the live one.
 */
export function PathTracedView({ background }: { background: string }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const backgroundPreset = useStore((s) => s.background);

  const state = useRef({
    sceneSig: [] as number[],
    cameraSig: [] as number[],
    lastChange: 0,
    sceneDirty: true,
    cameraDirty: true,
    showing: false,
    phase: null as PathTracePhase | null,
    reportedSamples: -1,
    traced: null as THREE.Scene | null,
    /**
     * Set for one frame before a build starts, so 'preparing scene' is on
     * screen before the main-thread part of it (merging every body into one
     * geometry) holds the page.
     */
    buildArmed: false,
    /** A BVH is building in the worker; the tracer has nothing to draw yet. */
    building: false,
    instanceMaterials: [] as THREE.Material[],
    ownedTextures: [] as THREE.Texture[],
    ownedGeometries: [] as THREE.BufferGeometry[],
    /** Index into TILE_STEPS; it only ever goes up, for as long as Render mode is on. */
    tileStep: 0,
    /** When the last sample was drawn, if it was drawn in the frame before this one. */
    lastSampleAt: 0,
    slowFrames: 0,
    /** When the tracer's shader was first seen compiling, for the console. */
    compileStarted: 0,
  });

  // The tracer, its denoiser and the floor are made in an effect and held in a
  // ref, not returned from a hook: the frame callback reconfigures them as it
  // goes, and a value returned from a hook is not ours to modify.
  const engineRef = useRef<Engine | null>(null);
  useEffect(() => {
    const engine = createEngine(gl);
    if (!engine) {
      useViewQuality.getState().setPathTrace(false);
      return;
    }
    engineRef.current = engine;
    const s = state.current;
    return () => {
      engineRef.current = null;
      engine.bvhWorker.dispose();
      engine.pathTracer.dispose();
      engine.despeckle.dispose();
      engine.denoiseQuad.dispose();
      engine.denoise.dispose();
      engine.glow.dispose();
      engine.floor.geometry.dispose();
      (engine.floor.material as THREE.Material).dispose();
      for (const m of s.instanceMaterials) m.dispose();
      s.instanceMaterials = [];
      for (const t of s.ownedTextures) t.dispose();
      s.ownedTextures = [];
      for (const g of s.ownedGeometries) g.dispose();
      s.ownedGeometries = [];
      s.sceneDirty = true;
      s.buildArmed = false;
      s.building = false;
    };
  }, [gl]);

  // A new backdrop colour, realistic background preset, or Render-mode tuning update is a new scene to trace.
  const tuningKey =
    backgroundPreset !== 'studio' ? JSON.stringify(BACKGROUND_LIGHTING[backgroundPreset].traced ?? null) : '';
  useEffect(() => {
    state.current.sceneDirty = true;
    state.current.lastChange = performance.now();
    invalidate();
  }, [background, backgroundPreset, tuningKey, invalidate]);

  // gl, scene and camera from the frame's own state rather than from render,
  // the same way GridFadeFollowsCamera reads them: this writes to the renderer.
  useFrame(({ gl, scene, camera, invalidate }) => {
    const s = state.current;
    const engine = engineRef.current;
    if (!engine) return;
    const { pathTracer, floor } = engine;
    const now = performance.now();
    // Only consecutive frames that both drew a sample measure what one costs.
    const lastSampleAt = s.lastSampleAt;
    s.lastSampleAt = 0;

    const report = (phase: PathTracePhase, samples: number) => {
      const rounded = Math.floor(samples);
      // The count only while rendering, and only every few samples.
      if (phase === s.phase && (phase !== 'rendering' || rounded - s.reportedSamples < 8)) return;
      s.phase = phase;
      s.reportedSamples = rounded;
      usePathTraceStatus.getState().set({ phase, samples: rounded });
    };
    const holdBack = () => {
      if (s.showing) pathTracer.reset();
      s.showing = false;
      s.lastChange = now;
    };

    if (useStore.getState().isPlaying) {
      holdBack();
      s.sceneDirty = true;
      report('waiting', 0);
      return;
    }

    const bodies = collectBodies(scene);
    const sceneSig = sceneSignature(bodies);
    if (!sameSignature(sceneSig, s.sceneSig, SCENE_TOLERANCE)) {
      s.sceneSig = sceneSig;
      s.sceneDirty = true;
      holdBack();
    }
    const cameraSig = cameraSignature(camera);
    if (!sameSignature(cameraSig, s.cameraSig, CAMERA_TOLERANCE)) {
      s.cameraSig = cameraSig;
      s.cameraDirty = true;
      holdBack();
    }

    const quietFor = now - s.lastChange;
    if (quietFor < SETTLE_MS) {
      report('waiting', 0);
      // Every frame, not a timer: the orbit controls' damping only advances
      // when a frame is drawn, and they stop asking for frames long before
      // the camera stops creeping. On a timer's few frames a second, the
      // creep after a drag took twenty seconds to die away; at full rate it
      // is gone in under one.
      invalidate();
      return;
    }

    if (s.building) {
      report('building', 0);
      return;
    }
    if (s.sceneDirty) {
      report('building', 0);
      if (!s.buildArmed) {
        s.buildArmed = true;
        invalidate();
        return;
      }
      s.buildArmed = false;
      const nextMaterials: THREE.Material[] = [];
      const nextTextures: THREE.Texture[] = [];
      const nextGeometries: THREE.BufferGeometry[] = [];
      const disposeBatch = (
        materials: THREE.Material[],
        textures: THREE.Texture[],
        geometries: THREE.BufferGeometry[],
      ) => {
        for (const m of materials) m.dispose();
        for (const t of textures) t.dispose();
        for (const g of geometries) g.dispose();
      };
      const fail = (e: unknown) => {
        // A geometry the tracer cannot take would otherwise throw on every
        // frame from here on.
        console.error('[PathTracedView] could not build the scene to trace', e);
        useViewQuality.getState().setPathTrace(false);
      };
      try {
        const activePreset = useStore.getState().background;
        const presetGlowScale =
          activePreset !== 'studio' ? (BACKGROUND_LIGHTING[activePreset].traced?.glowScale ?? 0) : 0;
        const nextHasGlow = bodies.some(
          (m) => ((m.material as THREE.MeshStandardMaterial).userData?.glow ?? 0) > 0,
        );
        const nextGlowScale = Math.max(nextHasGlow ? 1 : 0, presetGlowScale);
        s.traced = buildTracedScene(
          scene,
          bodies,
          floor,
          background,
          activePreset,
          nextMaterials,
          nextTextures,
          nextGeometries,
        );
        const started = performance.now();
        s.building = true;
        pathTracer.setSceneAsync(s.traced, camera).then(
          () => {
            if (engineRef.current !== engine) {
              disposeBatch(nextMaterials, nextTextures, nextGeometries);
              return;
            }
            // Only dispose the previous scene's materials, equirect textures & baked geometries
            // AFTER setSceneAsync has bound the new backgroundMap / envMapInfo / BVH on the GPU.
            disposeBatch(s.instanceMaterials, s.ownedTextures, s.ownedGeometries);
            s.instanceMaterials = nextMaterials;
            s.ownedTextures = nextTextures;
            s.ownedGeometries = nextGeometries;
            engine.glowScale = nextGlowScale;
            console.info(`[PathTracedView] scene built in ${Math.round(performance.now() - started)} ms`);
            s.building = false;
            invalidate();
          },
          (e) => {
            disposeBatch(nextMaterials, nextTextures, nextGeometries);
            if (engineRef.current === engine) fail(e);
          },
        );
      } catch (e) {
        disposeBatch(nextMaterials, nextTextures, nextGeometries);
        s.building = false;
        fail(e);
        return;
      }
      s.sceneDirty = false;
      s.cameraDirty = false;
      return;
    } else if (s.cameraDirty) {
      pathTracer.updateCamera();
      s.cameraDirty = false;
    }
    s.showing = true;

    // The shader compiles on the GPU driver's own threads; the tracer draws
    // nothing until it has, so say so rather than look stuck.
    // isCompiling is the tracer's own getter, left out of its type declarations.
    if ((pathTracer as WebGLPathTracer & { isCompiling: boolean }).isCompiling) {
      if (!s.compileStarted) s.compileStarted = now;
      report('compiling', 0);
      pathTracer.renderSample();
      invalidate();
      return;
    }
    if (s.compileStarted) {
      console.info(`[PathTracedView] tracer compiled in ${Math.round(now - s.compileStarted)} ms`);
      s.compileStarted = 0;
    }

    const converged = pathTracer.samples >= MAX_SAMPLES;
    // Once converged, a frame drawn for some other reason (the pointer crossing
    // the viewport) only puts the finished image back over the raster one.
    pathTracer.pausePathTracing = converged;
    if (!converged) {
      stepTilesIfSlow(s, pathTracer, lastSampleAt ? now - lastSampleAt : 0);
      s.lastSampleAt = now;
    }
    // The quad that copies the traced image to the canvas tone maps when the
    // renderer says to, and the composer has the renderer set to none. Same
    // curve as the raster view's BodyToneMapping.
    const toneMapping = gl.toneMapping;
    gl.toneMapping = THREE.NeutralToneMapping;
    pathTracer.renderSample();
    gl.toneMapping = toneMapping;

    if (converged) {
      report('done', pathTracer.samples);
    } else {
      report('rendering', pathTracer.samples);
      invalidate();
    }
  }, 2);

  return null;
}

/**
 * Cuts each sample into more pieces once frames have run slow for
 * SLOW_FRAMES_TO_STEP in a row (see TILE_STEPS). In a row, so the one long
 * frame in which the shader compiles does not count. Only between samples,
 * because the tracer keeps its place in the current one by tile number.
 */
function stepTilesIfSlow(
  s: { tileStep: number; slowFrames: number },
  pathTracer: WebGLPathTracer,
  frameMs: number,
) {
  if (frameMs === 0) return;
  s.slowFrames = frameMs > SLOW_FRAME_MS ? s.slowFrames + 1 : 0;
  if (s.slowFrames < SLOW_FRAMES_TO_STEP || s.tileStep >= TILE_STEPS.length - 1) return;
  if (!Number.isInteger(pathTracer.samples)) return;
  s.tileStep++;
  s.slowFrames = 0;
  const n = TILE_STEPS[s.tileStep];
  pathTracer.tiles.set(n, n);
}

/** Refraction of what a translucent geom is drawn as: low, so its two faces mirror the studio by 1% and not the 8% of real acrylic. */
const CLEAR_IOR = 1.2;

/** Light a geom at full glow gives off traced: enough at any glow worth seeing to clear TracedGlow's threshold. */
const TRACED_GLOW = 2.2;

/**
 * What a live material becomes in the traced scene, cloned into `owned` if it
 * has to change.
 *
 * Nothing in a scene is a lamp, unless it asks to be. Emissive is the raster
 * view's selection tint (and a rope's glow); traced, it would be light, and the
 * selected body would come out blue and cast blue on everything near it. A geom
 * with `glow` is meant as light, so it keeps it, and lights what is near it.
 *
 * Alpha is not how light goes through a thing. The tracer reads opacity as the
 * chance a ray passes, so each face of a pane at 6% still shades 6% of its rays
 * and mirrors the white studio at full strength: a haze over all that is behind
 * it. So a translucent geom is drawn as what it stands for, a clear material
 * that lets through 1 - alpha, and its tint fades with it.
 */
function tracedMaterial(live: THREE.MeshStandardMaterial, owned: THREE.Material[]): THREE.MeshStandardMaterial {
  const glow: number = live.userData.glow ?? 0;
  const lit = live.emissiveIntensity > 0 && live.emissive.getHex() !== 0;
  const clear = live.transparent && live.opacity < 1;
  if (!clear && !lit) return live;
  const material = live.clone();
  owned.push(material);
  if (lit) material.emissiveIntensity = glow * TRACED_GLOW;
  if (clear) {
    const alpha = live.opacity;
    material.color.lerp(_white, 1 - alpha);
    Object.assign(material, { transmission: 1 - alpha, ior: CLEAR_IOR, opacity: 1, transparent: false, roughness: Math.min(live.roughness, 0.05), depthWrite: true });
  }
  return material;
}

/** The bodies, cloth trims, and realistic background scenery: visible standard-material meshes that cast shadows or mark `tracedScenery` / `tracedTrim`. */
// eslint-disable-next-line react-refresh/only-export-components
export function collectBodies(scene: THREE.Scene): THREE.Mesh[] {
  const bodies: THREE.Mesh[] = [];
  scene.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (!mesh.castShadow && !mesh.userData?.tracedScenery && !mesh.userData?.tracedTrim)) return;
    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh && instanced.count <= 0) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(mesh.material) || !material.isMeshStandardMaterial) return;
    if (material.wireframe || material.opacity <= 0) return;
    bodies.push(mesh);
  });
  return bodies;
}

/**
 * A number for each material, so a body switched to another material changes
 * the signature. three gives every material an `id` at runtime, but its type
 * declarations leave it out.
 */
const materialKeys = new WeakMap<THREE.Material, number>();
let nextMaterialKey = 1;
function materialKey(material: THREE.Material): number {
  let key = materialKeys.get(material);
  if (key === undefined) {
    key = nextMaterialKey++;
    materialKeys.set(material, key);
  }
  return key;
}

/**
 * Everything about the bodies that changes the picture, as numbers: where each
 * one is, which geometry and material it draws with, and their versions.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sceneSignature(bodies: THREE.Mesh[]): number[] {
  const sig: number[] = [];
  for (const mesh of bodies) {
    sig.push(...mesh.matrixWorld.elements);
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    sig.push(mesh.geometry.id, position ? (position as THREE.BufferAttribute).version : -1, color ? color.version : -1);
    const material = mesh.material as THREE.MeshStandardMaterial;
    const mapKey = material.map ? material.map.version : -1;
    const normalKey = material.normalMap ? material.normalMap.version : -1;
    sig.push(
      materialKey(material),
      material.version,
      mapKey,
      normalKey,
      material.color.r,
      material.color.g,
      material.color.b,
      material.opacity,
      material.emissiveIntensity,
    );
    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      sig.push(instanced.count, instanced.instanceMatrix.version, instanced.instanceColor?.version ?? -1);
    }
  }
  return sig;
}

function cameraSignature(camera: THREE.Camera): number[] {
  return [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
}

/**
 * How far a body or the camera can move and still count as still: a micron
 * for a body, ten for the camera (a tenth of a pixel at the default framing,
 * and the camera only ever creeps this little in the tail of a drag).
 *
 * Not exact equality, because the orbit controls' damping never ends. Each
 * update scales what is left of the last drag by 0.9, so the camera keeps
 * creeping by ever smaller amounts for hundreds of frames after it looks still,
 * and the controls only stop asking for frames because they ignore moves below
 * their own epsilon. Compared exactly, every frame the settle timer woke found
 * the camera moved and started the wait over. The ids and versions in a
 * signature are integers, so a change in one is never inside the tolerance.
 */
export const SCENE_TOLERANCE = 1e-6;
const CAMERA_TOLERANCE = 1e-5;

// eslint-disable-next-line react-refresh/only-export-components
export function sameSignature(a: number[], b: number[], tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
  return true;
}

const _white = new THREE.Color(1, 1, 1);
const _instanceMatrix = new THREE.Matrix4();
const _instanceColor = new THREE.Color();
const _keyPosition = new THREE.Vector3();
const _keyTarget = new THREE.Vector3();

/**
 * Cloth meshes bind their metre-scaled weave `normalMap` to `channel = 1` (`uv1`),
 * whereas `three-gpu-pathtracer` samples `normalMap` exclusively on `ATTR_UV` (`uv`).
 * When a material has no `map` using `uv` (or when `uv1` carries the real weave
 * layout for an unprinted cloth panel), promote `uv1` onto a zero-copy-shared
 * `BufferGeometry`'s `uv` attribute so weave normals trace at true scale instead
 * of stretching a single 12 mm knit/twill tile across an entire garment panel.
 */
function withTracedUvChannel(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardMaterial,
  ownedGeometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (!material.map && material.normalMap && material.normalMap.channel === 1) {
    const uv1 = geometry.getAttribute('uv1');
    if (uv1) {
      const g = new THREE.BufferGeometry();
      g.setIndex(geometry.index);
      for (const [name, attr] of Object.entries(geometry.attributes)) {
        if (name !== 'uv') g.setAttribute(name, attr);
      }
      g.setAttribute('uv', uv1);
      for (const group of geometry.groups) g.addGroup(group.start, group.count, group.materialIndex);
      g.boundingBox = geometry.boundingBox ? geometry.boundingBox.clone() : null;
      g.boundingSphere = geometry.boundingSphere ? geometry.boundingSphere.clone() : null;
      ownedGeometries.push(g);
      return g;
    }
  }
  return geometry;
}

/**
 * Curved PN-Triangle middle-surface refinement for cloth slabs in Render mode.
 *
 * `ClothLayer` draws each cloth piece as a closed two-sided slab (`2 * N` vertices:
 * `0 .. N-1` top face, `N .. 2N-1` bottom face, plus boundary wall quads) over the
 * physics solver's coarse triangles (e.g. `40 mm` spacing on `flag_in_wind`).
 * Tracing that raw twin-face slab directly in `three-gpu-pathtracer` causes two
 * severe ray-tracing artifacts:
 *   1. Twin-slab self-shadowing / poke-through diamonds where curved `40 mm` chords
 *      cross or trap shadow rays between the two close parallel sheets.
 *   2. Sawtooth shadow-terminator stair-steps across every `40 mm` triangle edge,
 *      because `three-gpu-pathtracer` intersects flat geometric triangles with no
 *      shadow-terminator offset while shading smooth vertex normals.
 *
 * Extracting the exact single-sheet middle surface `m_i = 0.5 * (p_top + p_bot)` with
 * area-weighted vertex normals `n_i`, and tessellating each triangle `S = 4` (`1 -> 16`
 * curved sub-triangles, welded along shared edges) onto its Cubic PN-Triangle patch
 * eliminates 100% of twin-slab crossings and aligns geometric facets with shading
 * normals (< 3 ms at BVH build time, zero runtime physics cost).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildRefinedClothTracedGeometry(
  slabGeo: THREE.BufferGeometry,
  N: number,
  triCount: number,
  subdiv = 4,
): THREE.BufferGeometry | null {
  const posAttr = slabGeo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const idxAttr = slabGeo.getIndex();
  if (!posAttr || !idxAttr || N <= 0 || triCount <= 0) return null;
  if (posAttr.count < 2 * N || idxAttr.count < 3 * triCount) return null;

  const posArr = posAttr.array as ArrayLike<number>;
  const idxArr = idxAttr.array as ArrayLike<number>;
  const uvAttr = slabGeo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const uv1Attr = slabGeo.getAttribute('uv1') as THREE.BufferAttribute | undefined;

  // 1. Recover exact middle-surface positions `midP` and area-weighted smooth normals `midN`.
  const midP = new Float32Array(3 * N);
  const midN = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    const oTop = 3 * i;
    const oBot = 3 * (i + N);
    midP[oTop] = 0.5 * (posArr[oTop] + posArr[oBot]);
    midP[oTop + 1] = 0.5 * (posArr[oTop + 1] + posArr[oBot + 1]);
    midP[oTop + 2] = 0.5 * (posArr[oTop + 2] + posArr[oBot + 2]);
  }
  for (let t = 0; t < triCount; t++) {
    const ia = idxArr[3 * t], ib = idxArr[3 * t + 1], ic = idxArr[3 * t + 2];
    const a = 3 * ia, b = 3 * ib, c = 3 * ic;
    const e01x = midP[b] - midP[a], e01y = midP[b + 1] - midP[a + 1], e01z = midP[b + 2] - midP[a + 2];
    const e12x = midP[c] - midP[b], e12y = midP[c + 1] - midP[b + 1], e12z = midP[c + 2] - midP[b + 2];
    const e20x = midP[a] - midP[c], e20y = midP[a + 1] - midP[c + 1], e20z = midP[a + 2] - midP[c + 2];
    // Max-inscribed-sphere / inverse-edge-length^2 weights (`|e_a|^2 |e_b|^2`, Max 1999)
    // yield exact unbiased surface normals independent of quad diagonal valence!
    const nx = e01y * -e20z - e01z * -e20y;
    const ny = e01z * -e20x - e01x * -e20z;
    const nz = e01x * -e20y - e01y * -e20x;
    const l01 = e01x * e01x + e01y * e01y + e01z * e01z || 1;
    const l12 = e12x * e12x + e12y * e12y + e12z * e12z || 1;
    const l20 = e20x * e20x + e20y * e20y + e20z * e20z || 1;
    const wA = 1 / (l01 * l20);
    const wB = 1 / (l01 * l12);
    const wC = 1 / (l12 * l20);
    midN[a] += nx * wA; midN[a + 1] += ny * wA; midN[a + 2] += nz * wA;
    midN[b] += nx * wB; midN[b + 1] += ny * wB; midN[b + 2] += nz * wB;
    midN[c] += nx * wC; midN[c + 1] += ny * wC; midN[c + 2] += nz * wC;
  }
  for (let i = 0; i < N; i++) {
    const o = 3 * i;
    const l = Math.hypot(midN[o], midN[o + 1], midN[o + 2]) || 1;
    midN[o] /= l;
    midN[o + 1] /= l;
    midN[o + 2] /= l;
  }

  const S = Math.max(1, subdiv | 0);
  // Estimate upper bound on welded vertices: N corners + 3*triCount*(S-1) edge + triCount*(S-1)*(S-2)/2 interior.
  const maxVerts = N + 3 * triCount * Math.max(0, S - 1) + triCount * Math.max(0, ((S - 1) * (S - 2)) >> 1);
  const outPos = new Float32Array(3 * maxVerts);
  const outUv = uvAttr ? new Float32Array(2 * maxVerts) : null;
  const outUv1 = uv1Attr ? new Float32Array(2 * maxVerts) : null;
  const subTris = triCount * S * S;
  const outIdx = maxVerts > 65535 ? new Uint32Array(3 * subTris) : new Uint16Array(3 * subTris);

  // Seed original N corner vertices at indices `0 .. N - 1`.
  outPos.set(midP);
  if (outUv && uvAttr) {
    for (let i = 0; i < N; i++) {
      outUv[2 * i] = uvAttr.getX(i);
      outUv[2 * i + 1] = uvAttr.getY(i);
    }
  }
  if (outUv1 && uv1Attr) {
    for (let i = 0; i < N; i++) {
      outUv1[2 * i] = uv1Attr.getX(i);
      outUv1[2 * i + 1] = uv1Attr.getY(i);
    }
  }

  let nextVert = N;
  // Shared edge cache keyed by canonical `(min(u, v) * N + max(u, v)) * S + stepFromMin` so adjacent
  // triangles share exact welded edge vertices (watertight C0/G1 patch, smooth vertex normals across seams!).
  const edgeCache = new Map<number, number>();
  const getEdgeVert = (u: number, v: number, stepFromU: number): number => {
    if (stepFromU <= 0) return u;
    if (stepFromU >= S) return v;
    const lo = u < v ? u : v;
    const hi = u < v ? v : u;
    const stepLo = u < v ? stepFromU : S - stepFromU;
    const key = (lo * N + hi) * S + stepLo;
    const hit = edgeCache.get(key);
    if (hit !== undefined) return hit;

    const idx = nextVert++;
    const t = stepLo / S;
    const om = 1 - t;
    // Cubic PN-Triangle edge curve between `lo` (wLo = om) and `hi` (wHi = t) — symmetric & intrinsic to edge `(lo, hi)`!
    const pLoX = midP[3 * lo], pLoY = midP[3 * lo + 1], pLoZ = midP[3 * lo + 2];
    const pHiX = midP[3 * hi], pHiY = midP[3 * hi + 1], pHiZ = midP[3 * hi + 2];
    const nLoX = midN[3 * lo], nLoY = midN[3 * lo + 1], nLoZ = midN[3 * lo + 2];
    const nHiX = midN[3 * hi], nHiY = midN[3 * hi + 1], nHiZ = midN[3 * hi + 2];

    const dx = pHiX - pLoX, dy = pHiY - pLoY, dz = pHiZ - pLoZ;
    const dLo = dx * nLoX + dy * nLoY + dz * nLoZ;
    const b210x = (2 * pLoX + pHiX - dLo * nLoX) / 3;
    const b210y = (2 * pLoY + pHiY - dLo * nLoY) / 3;
    const b210z = (2 * pLoZ + pHiZ - dLo * nLoZ) / 3;

    const dHi = -dx * nHiX - dy * nHiY - dz * nHiZ;
    const b120x = (2 * pHiX + pLoX - dHi * nHiX) / 3;
    const b120y = (2 * pHiY + pLoY - dHi * nHiY) / 3;
    const b120z = (2 * pHiZ + pLoZ - dHi * nHiZ) / 3;

    const w30 = om * om * om;
    const w21 = 3 * om * om * t;
    const w12 = 3 * om * t * t;
    const w03 = t * t * t;
    outPos[3 * idx] = w30 * pLoX + w21 * b210x + w12 * b120x + w03 * pHiX;
    outPos[3 * idx + 1] = w30 * pLoY + w21 * b210y + w12 * b120y + w03 * pHiY;
    outPos[3 * idx + 2] = w30 * pLoZ + w21 * b210z + w12 * b120z + w03 * pHiZ;

    if (outUv && uvAttr) {
      outUv[2 * idx] = om * uvAttr.getX(lo) + t * uvAttr.getX(hi);
      outUv[2 * idx + 1] = om * uvAttr.getY(lo) + t * uvAttr.getY(hi);
    }
    if (outUv1 && uv1Attr) {
      outUv1[2 * idx] = om * uv1Attr.getX(lo) + t * uv1Attr.getX(hi);
      outUv1[2 * idx + 1] = om * uv1Attr.getY(lo) + t * uv1Attr.getY(hi);
    }
    edgeCache.set(key, idx);
    return idx;
  };

  // Scratch triangle grid `(S + 1) x (S + 1)` vertex indices (`row i = 0..S`, `col j = 0..S - i`).
  const grid = new Int32Array((S + 1) * (S + 1));
  let outTriOffset = 0;

  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr[3 * t];
    const i1 = idxArr[3 * t + 1];
    const i2 = idxArr[3 * t + 2];

    const p0x = midP[3 * i0], p0y = midP[3 * i0 + 1], p0z = midP[3 * i0 + 2];
    const p1x = midP[3 * i1], p1y = midP[3 * i1 + 1], p1z = midP[3 * i1 + 2];
    const p2x = midP[3 * i2], p2y = midP[3 * i2 + 1], p2z = midP[3 * i2 + 2];

    const n0x = midN[3 * i0], n0y = midN[3 * i0 + 1], n0z = midN[3 * i0 + 2];
    const n1x = midN[3 * i1], n1y = midN[3 * i1 + 1], n1z = midN[3 * i1 + 2];
    const n2x = midN[3 * i2], n2y = midN[3 * i2 + 1], n2z = midN[3 * i2 + 2];

    // Cubic PN-Triangle Bézier control points (Vlachos et al. 2001):
    const d01 = (p1x - p0x) * n0x + (p1y - p0y) * n0y + (p1z - p0z) * n0z;
    const b210x = (2 * p0x + p1x - d01 * n0x) / 3, b210y = (2 * p0y + p1y - d01 * n0y) / 3, b210z = (2 * p0z + p1z - d01 * n0z) / 3;
    const d10 = (p0x - p1x) * n1x + (p0y - p1y) * n1y + (p0z - p1z) * n1z;
    const b120x = (2 * p1x + p0x - d10 * n1x) / 3, b120y = (2 * p1y + p0y - d10 * n1y) / 3, b120z = (2 * p1z + p0z - d10 * n1z) / 3;

    const d12 = (p2x - p1x) * n1x + (p2y - p1y) * n1y + (p2z - p1z) * n1z;
    const b021x = (2 * p1x + p2x - d12 * n1x) / 3, b021y = (2 * p1y + p2y - d12 * n1y) / 3, b021z = (2 * p1z + p2z - d12 * n1z) / 3;
    const d21 = (p1x - p2x) * n2x + (p1y - p2y) * n2y + (p1z - p2z) * n2z;
    const b012x = (2 * p2x + p1x - d21 * n2x) / 3, b012y = (2 * p2y + p1y - d21 * n2y) / 3, b012z = (2 * p2z + p1z - d21 * n2z) / 3;

    const d20 = (p0x - p2x) * n2x + (p0y - p2y) * n2y + (p0z - p2z) * n2z;
    const b102x = (2 * p2x + p0x - d20 * n2x) / 3, b102y = (2 * p2y + p0y - d20 * n2y) / 3, b102z = (2 * p2z + p0z - d20 * n2z) / 3;
    const d02 = (p2x - p0x) * n0x + (p2y - p0y) * n0y + (p2z - p0z) * n0z;
    const b201x = (2 * p0x + p2x - d02 * n0x) / 3, b201y = (2 * p0y + p2y - d02 * n0y) / 3, b201z = (2 * p0z + p2z - d02 * n0z) / 3;

    const ex = (b210x + b120x + b021x + b012x + b102x + b201x) / 6;
    const ey = (b210y + b120y + b021y + b012y + b102y + b201y) / 6;
    const ez = (b210z + b120z + b021z + b012z + b102z + b201z) / 6;
    const vx = (p0x + p1x + p2x) / 3, vy = (p0y + p1y + p2y) / 3, vz = (p0z + p1z + p2z) / 3;
    const b111x = ex + (ex - vx) * 0.5, b111y = ey + (ey - vy) * 0.5, b111z = ez + (ez - vz) * 0.5;

    // Populate `(i, j)` lattice (`w0 = (S - i - j)/S`, `w1 = i/S`, `w2 = j/S`).
    for (let i = 0; i <= S; i++) {
      for (let j = 0; j <= S - i; j++) {
        const k = S - i - j;
        let vIdx: number;
        if (j === 0) {
          vIdx = getEdgeVert(i0, i1, i);
        } else if (i === 0) {
          vIdx = getEdgeVert(i0, i2, j);
        } else if (k === 0) {
          vIdx = getEdgeVert(i1, i2, j);
        } else {
          vIdx = nextVert++;
          const w0 = k / S, w1 = i / S, w2 = j / S;
          const w02 = w0 * w0, w12 = w1 * w1, w22 = w2 * w2;
          outPos[3 * vIdx] =
            p0x * w02 * w0 + p1x * w12 * w1 + p2x * w22 * w2 +
            3 * (b210x * w02 * w1 + b120x * w0 * w12 + b201x * w02 * w2 + b021x * w12 * w2 + b102x * w0 * w22 + b012x * w1 * w22) +
            6 * b111x * w0 * w1 * w2;
          outPos[3 * vIdx + 1] =
            p0y * w02 * w0 + p1y * w12 * w1 + p2y * w22 * w2 +
            3 * (b210y * w02 * w1 + b120y * w0 * w12 + b201y * w02 * w2 + b021y * w12 * w2 + b102y * w0 * w22 + b012y * w1 * w22) +
            6 * b111y * w0 * w1 * w2;
          outPos[3 * vIdx + 2] =
            p0z * w02 * w0 + p1z * w12 * w1 + p2z * w22 * w2 +
            3 * (b210z * w02 * w1 + b120z * w0 * w12 + b201z * w02 * w2 + b021z * w12 * w2 + b102z * w0 * w22 + b012z * w1 * w22) +
            6 * b111z * w0 * w1 * w2;
          if (outUv && uvAttr) {
            outUv[2 * vIdx] = w0 * uvAttr.getX(i0) + w1 * uvAttr.getX(i1) + w2 * uvAttr.getX(i2);
            outUv[2 * vIdx + 1] = w0 * uvAttr.getY(i0) + w1 * uvAttr.getY(i1) + w2 * uvAttr.getY(i2);
          }
          if (outUv1 && uv1Attr) {
            outUv1[2 * vIdx] = w0 * uv1Attr.getX(i0) + w1 * uv1Attr.getX(i1) + w2 * uv1Attr.getX(i2);
            outUv1[2 * vIdx + 1] = w0 * uv1Attr.getY(i0) + w1 * uv1Attr.getY(i1) + w2 * uv1Attr.getY(i2);
          }
        }
        grid[i * (S + 1) + j] = vIdx;
      }
    }

    // Emit `S^2` sub-triangles preserving `(i0, i1, i2)` CCW winding.
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S - i; j++) {
        const a = grid[i * (S + 1) + j];
        const b = grid[(i + 1) * (S + 1) + j];
        const c = grid[i * (S + 1) + (j + 1)];
        outIdx[outTriOffset++] = a;
        outIdx[outTriOffset++] = b;
        outIdx[outTriOffset++] = c;
        if (i + j + 1 < S) {
          const d = grid[(i + 1) * (S + 1) + (j + 1)];
          outIdx[outTriOffset++] = b;
          outIdx[outTriOffset++] = d;
          outIdx[outTriOffset++] = c;
        }
      }
    }
  }

  const refined = new THREE.BufferGeometry();
  refined.setAttribute('position', new THREE.BufferAttribute(outPos.subarray(0, 3 * nextVert), 3));
  if (outUv) refined.setAttribute('uv', new THREE.BufferAttribute(outUv.subarray(0, 2 * nextVert), 2));
  if (outUv1) refined.setAttribute('uv1', new THREE.BufferAttribute(outUv1.subarray(0, 2 * nextVert), 2));
  refined.setIndex(new THREE.BufferAttribute(outIdx, 1));
  refined.computeVertexNormals();
  refined.computeBoundingBox();
  refined.computeBoundingSphere();
  return refined;
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildTracedScene(
  live: THREE.Scene,
  bodies: THREE.Mesh[],
  floor: THREE.Mesh,
  background: string,
  backgroundPreset: BackgroundId,
  instanceMaterials: THREE.Material[],
  ownedTextures: THREE.Texture[],
  ownedGeometries: THREE.BufferGeometry[] = [],
): THREE.Scene {
  const traced = new THREE.Scene();
  const realisticBackdrop = backgroundPreset !== 'studio';
  const tuning = realisticBackdrop ? BACKGROUND_LIGHTING[backgroundPreset].traced : undefined;
  // Studio mode uses the pre-tone-mapped flat backdrop colour + synthetic floor;
  // realistic background presets already carry an equirectangular skybox on
  // `live.background` and their own 3D ground/tabletop in `bodies`.
  if (realisticBackdrop && live.background) {
    const liveDataBg = live.background as THREE.DataTexture;
    if (tuning && liveDataBg.isDataTexture && liveDataBg.image?.data instanceof Uint16Array) {
      const trimmedBg = buildTracedEquirectTexture(liveDataBg, {
        desaturate: tuning.skyboxDesaturate,
        scale: tuning.skyboxScale,
      });
      ownedTextures.push(trimmedBg);
      traced.background = trimmedBg;
    } else {
      traced.background = live.background;
    }
  } else {
    traced.background = preToneMappedColor(background);
  }

  const liveDataEnv = live.environment as THREE.DataTexture | null;
  if (tuning && liveDataEnv?.isDataTexture && liveDataEnv.image?.data instanceof Uint16Array) {
    const trimmedEnv = buildTracedEquirectTexture(liveDataEnv, {
      desaturate: tuning.envDesaturate,
      scale: 1,
      hotspotClamp: tuning.envHotspotClamp,
    });
    ownedTextures.push(trimmedEnv);
    traced.environment = trimmedEnv;
  } else {
    traced.environment = live.environment;
  }
  traced.environmentIntensity = live.environmentIntensity * (tuning?.envScale ?? 1);
  traced.environmentRotation.copy(live.environmentRotation);

  const place = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4) => {
    const proxy = new THREE.Mesh(geometry, material);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(matrix);
    traced.add(proxy);
  };

  for (const mesh of bodies) {
    let material = tracedMaterial(mesh.material as THREE.MeshStandardMaterial, instanceMaterials);
    // Decorative stitch runs carry `castShadow = false` on the live mesh; propagate that onto
    // the traced material (`sample 14 .g`) so hundreds of thread dashes render with crisp PBR
    // shading without casting noisy micro-shadows.
    if (!mesh.castShadow && (material as THREE.MeshStandardMaterial & { castShadow?: boolean }).castShadow !== false) {
      const own = material.clone();
      (own as THREE.MeshStandardMaterial & { castShadow?: boolean }).castShadow = false;
      instanceMaterials.push(own);
      material = own;
    }
    const isScenery = Boolean(mesh.userData?.tracedScenery);
    if (isScenery && tuning) {
      const own = material.clone();
      own.color.multiplyScalar(tuning.sceneryAlbedoScale);
      if (backgroundPreset === 'meadow' && own.map) {
        // Counter-trim the green bias baked into the Meadow turf detail map slightly in Render mode.
        own.color.r *= 1.05;
        own.color.g *= 0.93;
        own.color.b *= 1.08;
      }
      instanceMaterials.push(own);
      material = own;
    }
    // When an SVG print `map` occupies `uv` while a metre-scaled weave `normalMap` asks for `uv1`
    // (`channel === 1`), `three-gpu-pathtracer` only samples `ATTR_UV`, which would stretch one
    // tiny weave tile across the whole print motif; drop `normalMap` on the traced clone in that case.
    if (material.map && material.normalMap && material.normalMap.channel === 1) {
      const own = material.clone();
      own.normalMap = null;
      instanceMaterials.push(own);
      material = own;
    }
    const clothVertCount = typeof mesh.userData?.clothVertCount === 'number' ? mesh.userData.clothVertCount : 0;
    const clothTriCount = typeof mesh.userData?.clothTriCount === 'number' ? mesh.userData.clothTriCount : 0;
    let rawGeo: THREE.BufferGeometry = mesh.geometry;
    if (clothVertCount > 0 && clothTriCount > 0) {
      const refined = buildRefinedClothTracedGeometry(mesh.geometry, clothVertCount, clothTriCount, 4);
      if (refined) {
        ownedGeometries.push(refined);
        rawGeo = refined;
        // Single-sheet middle surface must trace two-sided (`DoubleSide`) even though
        // the live closed manifold slab draws with `FrontSide`.
        if (material.side !== THREE.DoubleSide) {
          const own = material.clone();
          own.side = THREE.DoubleSide;
          instanceMaterials.push(own);
          material = own;
        }
      }
    }
    const baseGeo =
      isScenery && tuning
        ? withSceneryColorTrim(rawGeo, tuning.sceneryDesaturate)
        : withRgbaColors(rawGeo);
    const tracedGeo = withTracedUvChannel(baseGeo, material, ownedGeometries);

    const instanced = mesh as THREE.InstancedMesh;
    if (!instanced.isInstancedMesh) {
      place(tracedGeo, material, mesh.matrixWorld);
      continue;
    }
    // Uncoloured InstancedMeshes with many uniform instances (zipper teeth, decorative stitch runs,
    // studs) merge cleanly into a single static BufferGeometry so StaticGeometryGenerator doesn't
    // pay O(N) per-mesh sort/diff/merge overhead on hundreds of tiny trims.
    if (!instanced.instanceColor && instanced.count > 8) {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, _instanceMatrix);
        const clone = tracedGeo.clone();
        clone.applyMatrix4(_instanceMatrix);
        parts.push(clone);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (merged) {
        ownedGeometries.push(merged);
        place(merged, material, instanced.matrixWorld);
        continue;
      }
    }
    // The tracer reads plain meshes only, so each instance becomes one, with
    // its instance colour folded into a material of its own.
    for (let i = 0; i < instanced.count; i++) {
      instanced.getMatrixAt(i, _instanceMatrix);
      _instanceMatrix.premultiply(instanced.matrixWorld);
      let instanceMaterial: THREE.Material = material;
      if (instanced.instanceColor) {
        instanced.getColorAt(i, _instanceColor);
        const own = material.clone();
        own.color.multiply(_instanceColor);
        instanceMaterials.push(own);
        instanceMaterial = own;
      }
      place(tracedGeo, instanceMaterial, _instanceMatrix);
    }
  }

  if (!realisticBackdrop) {
    (floor.material as THREE.MeshStandardMaterial).color.set(background);
    traced.add(floor);
  }

  // The key light, as a disc that subtends the same irradiance: a directional
  // light of intensity E lights a face like a source of radiance E / Ω, where Ω
  // is the solid angle the disc covers. Indoor presets use a wider angular
  // radius (overhead LED strip / sunlit living-room window) for soft penumbras.
  const k = findKeyLight(live);
  if (k) {
    k.getWorldPosition(_keyPosition);
    k.target.getWorldPosition(_keyTarget);
    const distance = _keyPosition.distanceTo(_keyTarget);
    const angularRadius =
      backgroundPreset !== 'studio'
        ? BACKGROUND_LIGHTING[backgroundPreset].keyLightAngularRadius
        : KEY_LIGHT_ANGULAR_RADIUS;
    const radius = distance * Math.tan(angularRadius);
    const solidAngle = (Math.PI * radius * radius) / (distance * distance);
    const keyIntensity = k.intensity * (tuning?.keyScale ?? 1);
    const disc = new ShapedAreaLight(k.color, keyIntensity / solidAngle, radius * 2, radius * 2);
    disc.isCircular = true;
    disc.position.copy(_keyPosition);
    disc.lookAt(_keyTarget);
    traced.add(disc);
  }

  return traced;
}

/** The shadow-casting directional light: the raster view's key light. */
function findKeyLight(scene: THREE.Scene): THREE.DirectionalLight | null {
  let key: THREE.DirectionalLight | null = null;
  scene.traverseVisible((o) => {
    const light = o as THREE.DirectionalLight;
    if (!key && light.isDirectionalLight && light.castShadow) key = light;
  });
  return key;
}
