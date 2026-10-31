import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { WebGLPathTracer, ShapedAreaLight, DenoiseMaterial } from 'three-gpu-pathtracer';
import { useStore } from '../../store/useStore';
import { useViewQuality, usePathTraceStatus, type PathTracePhase } from '../../store/viewQualityStore';
import { preToneMappedColor } from '../../utils/neutralToneMapping';
import { MeshBvhWorkerClient } from '../../utils/meshBvhWorkerClient';
import { withRgbaColors } from '../../utils/tracerGeometry';

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
  denoise: DenoiseMaterial;
  denoiseQuad: FullScreenQuad;
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
    // Copied to the canvas through an edge-preserving blur rather than
    // straight. Path-tracing grain falls only as 1/sqrt(samples), so halving
    // it by brute force costs four times the samples; a bilateral filter
    // smooths it out of the flat and gently curved surfaces that make up
    // most of a part, and stops at any step in colour, which is where its
    // edges and shadow lines are. The tracer's own quad still carries the
    // fade-in, so its opacity and blending are copied across each frame.
    const denoise = new DenoiseMaterial({ sigma: DENOISE_SIGMA, kSigma: 1, threshold: DENOISE_THRESHOLD });
    const denoiseQuad = new FullScreenQuad(denoise);
    pt.renderToCanvasCallback = (target, renderer, quad) => {
      const fade = quad.material as THREE.ShaderMaterial & { opacity: number };
      denoise.map = target.texture;
      denoise.opacity = fade.opacity;
      denoise.blending = fade.blending;
      denoise.transparent = fade.opacity < 1;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      denoiseQuad.render(renderer);
      renderer.autoClear = autoClear;
    };

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.updateMatrix();
    floor.matrixAutoUpdate = false;

    return { pathTracer: pt, denoise, denoiseQuad, floor, bvhWorker };
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
      engine.denoiseQuad.dispose();
      engine.denoise.dispose();
      engine.floor.geometry.dispose();
      (engine.floor.material as THREE.Material).dispose();
      for (const m of s.instanceMaterials) m.dispose();
      s.instanceMaterials = [];
      s.sceneDirty = true;
      s.buildArmed = false;
      s.building = false;
    };
  }, [gl]);

  // A new backdrop colour is a new scene to trace.
  useEffect(() => {
    state.current.sceneDirty = true;
    state.current.lastChange = performance.now();
    invalidate();
  }, [background, invalidate]);

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
      for (const m of s.instanceMaterials) m.dispose();
      s.instanceMaterials = [];
      const fail = (e: unknown) => {
        // A geometry the tracer cannot take would otherwise throw on every
        // frame from here on.
        console.error('[PathTracedView] could not build the scene to trace', e);
        useViewQuality.getState().setPathTrace(false);
      };
      try {
        s.traced = buildTracedScene(scene, bodies, floor, background, s.instanceMaterials);
        const started = performance.now();
        s.building = true;
        pathTracer.setSceneAsync(s.traced, camera).then(
          () => {
            if (engineRef.current !== engine) return;
            console.info(`[PathTracedView] scene built in ${Math.round(performance.now() - started)} ms`);
            s.building = false;
            invalidate();
          },
          (e) => {
            if (engineRef.current === engine) fail(e);
          },
        );
      } catch (e) {
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

/** The bodies: visible meshes that cast shadows and draw with a standard material. */
function collectBodies(scene: THREE.Scene): THREE.Mesh[] {
  const bodies: THREE.Mesh[] = [];
  scene.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
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
function sceneSignature(bodies: THREE.Mesh[]): number[] {
  const sig: number[] = [];
  for (const mesh of bodies) {
    sig.push(...mesh.matrixWorld.elements);
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    sig.push(mesh.geometry.id, position ? (position as THREE.BufferAttribute).version : -1, color ? color.version : -1);
    const material = mesh.material as THREE.MeshStandardMaterial;
    sig.push(materialKey(material), material.version, material.color.r, material.color.g, material.color.b, material.opacity);
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
const SCENE_TOLERANCE = 1e-6;
const CAMERA_TOLERANCE = 1e-5;

function sameSignature(a: number[], b: number[], tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
  return true;
}

const _instanceMatrix = new THREE.Matrix4();
const _instanceColor = new THREE.Color();
const _keyPosition = new THREE.Vector3();
const _keyTarget = new THREE.Vector3();

function buildTracedScene(
  live: THREE.Scene,
  bodies: THREE.Mesh[],
  floor: THREE.Mesh,
  background: string,
  instanceMaterials: THREE.Material[],
): THREE.Scene {
  const traced = new THREE.Scene();
  // The sky is only ever seen directly, never composited over, so it can be
  // drawn bright enough to come out of the tone mapping as the page colour.
  traced.background = preToneMappedColor(background);
  traced.environment = live.environment;
  traced.environmentIntensity = live.environmentIntensity;
  traced.environmentRotation.copy(live.environmentRotation);

  const place = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4) => {
    const proxy = new THREE.Mesh(geometry, material);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(matrix);
    traced.add(proxy);
  };

  for (const mesh of bodies) {
    const material = mesh.material as THREE.MeshStandardMaterial;
    const instanced = mesh as THREE.InstancedMesh;
    if (!instanced.isInstancedMesh) {
      place(withRgbaColors(mesh.geometry), material, mesh.matrixWorld);
      continue;
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
      place(withRgbaColors(mesh.geometry), instanceMaterial, _instanceMatrix);
    }
  }

  (floor.material as THREE.MeshStandardMaterial).color.set(background);
  traced.add(floor);

  // The key light, as a disc that subtends the same irradiance: a directional
  // light of intensity E lights a face like a source of radiance E / Ω, where Ω
  // is the solid angle the disc covers.
  const k = findKeyLight(live);
  if (k) {
    k.getWorldPosition(_keyPosition);
    k.target.getWorldPosition(_keyTarget);
    const distance = _keyPosition.distanceTo(_keyTarget);
    const radius = distance * Math.tan(KEY_LIGHT_ANGULAR_RADIUS);
    const solidAngle = (Math.PI * radius * radius) / (distance * distance);
    const disc = new ShapedAreaLight(k.color, k.intensity / solidAngle, radius * 2, radius * 2);
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
