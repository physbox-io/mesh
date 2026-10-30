import { useCallback, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { useStore, applyShatterPieces } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import { useDialogs } from '../../store/dialogStore';
import { useViewQuality } from '../../store/viewQualityStore';
import { physicsGlobals } from '../../physicsGlobals';
import type { WeakSpot } from '../../utils/printAnalysis';
import { DEFAULT_EYE } from '../../utils/frameScene';
import { DropHandler } from '../DropHandler';
import { AxisLegendDrawer } from '../AxisLegendDrawer';
import { PhysicsLoop } from './PhysicsLoop';
import { RenderOnChange } from './RenderOnChange';
import { GridFadeFollowsCamera } from './GridFadeFollowsCamera';
import { GroundGrid } from './GroundGrid';
import { OriginGlow } from './OriginGlow';
import { KeyLight } from './KeyLight';
import { BodyToneMapping } from './BodyToneMapping';
import { StudioBackdrop } from './StudioBackdrop';
import { SelectionOutline } from './SelectionOutline';
import { PathTracedView } from './PathTracedView';
import { MarqueeSelect } from './MarqueeSelect';
import { PulleyRopeMarkers } from './PulleyRopes';
import { ObjectGestureController } from './ObjectGestures';
import { TransformGizmo } from './TransformGizmo';
import { isGizmoBusy } from './gizmoBusy';
import { MeasureTool } from './MeasureTool';
import { DimensionOverlay } from './DimensionOverlay';
import { SectionCut } from './SectionCut';
import { EdgeRoundTool } from './EdgeRoundTool';
import { ReferenceImages } from './ReferenceImages';
import {
  PaintStrokeController, CameraController, DragInteractionController,
  SceneCapture, SceneVisuals,
  LatticeEditorLayer,
} from './SceneLayer';
import { installMeshBvh } from '../../utils/meshBvh';

installMeshBvh();

/**
 * The pose the app opens in, before any scene has been framed. 45° of vertical
 * FOV at DEFAULT_EYE puts about 250 mm of world across the window — the size of
 * the parts made here — where it used to put 660 mm and draw everything at
 * roughly two fifths the size. See utils/frameScene.
 */
const CAMERA_CONFIG = { position: DEFAULT_EYE, fov: 45, near: 0.01, far: 1000 };

/**
 * The R3F canvas: lights, floor, the physics loop, the bodies, every viewport
 * tool and the post-processing. `threeSceneRef` is handed the three.js scene
 * for the mesh exports; `axisCanvasRef` is the HTML overlay the axis legend
 * draws into.
 */
export function SceneCanvas({ threeSceneRef, axisCanvasRef, darkMode, onImportSceneJson }: {
  threeSceneRef: RefObject<THREE.Scene | null>;
  axisCanvasRef: RefObject<HTMLCanvasElement | null>;
  darkMode: boolean;
  onImportSceneJson: (text: string, fileName: string, dropped: boolean) => void;
}) {
  const hiRes = useViewQuality(s => s.hiRes);
  const pathTrace = useViewQuality(s => s.pathTrace);
  // The EffectComposer instance, so a screenshot can render through the same
  // post-processing pipeline the viewport uses (AO included) instead of a raw
  // gl.render() that would silently skip every effect — see SCREENSHOT in
  // useMCPBridge.
  const composerRef = useRef<ComponentRef<typeof EffectComposer> | null>(null);
  const openStlImport = usePanels((s) => s.openStlImport);
  const openImageImport = usePanels((s) => s.openImageImport);
  const showNotice = useDialogs((s) => s.showNotice);
  const {
    model, data, mujoco, recompileId, isPlaying, paintMode, gridCellSizeMm,
    sceneGraph, selectedNodeId, setSelectedNodeId, addComponent,
  } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, recompileId: s.recompileId,
    isPlaying: s.isPlaying, paintMode: s.paintMode, gridCellSizeMm: s.gridCellSizeMm,
    sceneGraph: s.sceneGraph, selectedNodeId: s.selectedNodeId, setSelectedNodeId: s.setSelectedNodeId,
    addComponent: s.addComponent,
  })));
  // While anything is in pieces the scene on screen is the document with the
  // broken bodies swapped for their shards. See `shatterPieces` in the store.
  const shatteredBodies = useStore((s) => s.visibleShatteredBodies);
  // While a loaded scene is being built, the one the current model was built
  // from. See `outgoingSceneGraph` in the store.
  const outgoingGraph = useStore((s) => s.outgoingSceneGraph);
  // Exactly what the solver was handed, so the picture and the physics cannot
  // disagree about which bodies exist.
  const effectiveGraph = useMemo(
    () => applyShatterPieces(outgoingGraph ?? sceneGraph, shatteredBodies),
    [outgoingGraph, sceneGraph, shatteredBodies],
  );
  const [activeWeakSpot, setActiveWeakSpot] = useState<WeakSpot | null>(null);

  /*
   * A click on a gizmo handle is a click on a mesh with no R3F handlers, so R3F
   * reports it as a miss — and clearing the selection here would take the gizmo
   * away underneath the drag that is using it.
   */
  const handlePointerMissed = useCallback(() => {
    if (isGizmoBusy()) return;
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // A part dropped on the canvas goes under the selected body, like a clicked
  // one. Read at drop time rather than bound to the selection, so the drop
  // listeners are not torn down and re-added on every selection change.
  const addComponentUnderSelection = useCallback(
    (type: Parameters<typeof addComponent>[0], pos: [number, number, number]) => {
      addComponent(type, pos, useStore.getState().selectedNodeId);
    },
    [addComponent],
  );

  return (
    <Canvas
      camera={CAMERA_CONFIG}
      // Every frame while the simulation runs, and only when asked while
      // it is stopped — see RenderOnChange.
      frameloop={isPlaying ? 'always' : 'demand'}
      // Plain PCF: 'soft' asks for PCFSoftShadowMap, which three r184 has
      // deprecated and quietly swaps for PCF anyway, with a warning.
      shadows="percentage"
      // Capped at 1.5: on a 2x display every pass below (shadow, scene,
      // ambient occlusion) ran at four times the pixels of a 1x one.
      dpr={[1, 1.5]}
      onPointerMissed={handlePointerMissed}
      style={paintMode ? { cursor: 'crosshair' } : undefined}
      // antialias off: the scene is drawn into the composer's own target,
      // which is not multisampled, so the canvas's MSAA only ever smoothed
      // the one full-screen quad the composer copies out. No
      // preserveDrawingBuffer either: its one reader, the MCP screenshot,
      // draws a frame immediately before reading the canvas.
      gl={{ antialias: false, logarithmicDepthBuffer: true }}
      onCreated={(state) => {
        physicsGlobals._physics_gl = state.gl;
        // The scene and camera as well as the renderer, so a screenshot
        // can draw a frame rather than read whatever the canvas last
        // happened to hold — see SCREENSHOT in useMCPBridge.
        physicsGlobals._physics_scene = state.scene;
        physicsGlobals._physics_camera = state.camera;
        const canvas = state.gl.domElement;
        // Without this, a lost WebGL context (GPU driver hiccup, memory
        // pressure, etc.) leaves the canvas permanently blank with no way
        // to recover in-app — preventDefault() tells the browser to try
        // restoring the context instead of abandoning it.
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          console.error('[Physics] WebGL context lost — attempting recovery');
        });
        canvas.addEventListener('webglcontextrestored', () => {
          console.warn('[Physics] WebGL context restored — forcing scene recompile to redraw');
          useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
        });
      }}
    >
      <SceneCapture sceneRef={threeSceneRef} />
      <RenderOnChange />
      <DropHandler addComponent={addComponentUnderSelection} onImportFile={openStlImport} onImportImageFile={openImageImport} onImportSceneJson={onImportSceneJson} onUnsupportedDrop={(msg) => showNotice('Unsupported file', msg, 'amber')} />
      <StudioBackdrop darkMode={darkMode} />
      {/* A photo studio, built here rather than loaded: a broad softbox
          overhead, two strip lights either side and a dim grey room. It
          is where the shading comes from now — the diffuse light that
          wraps a body and the highlights that show a curved face is
          curved — so it runs well above the 0.12 the apartment HDR was
          held at. That HDR was also fetched from a CDN on every load.
          The ambient light under it was most of what the scene used to
          be lit by, and ambient lights every face the same, which is why
          a box read as three flat tints. It is kept only as a floor so
          nothing in a crevice goes fully black.
          background={false}: the room lights the bodies but is never
          drawn; the flat <color> above stays the backdrop. frames={1}
          (the default) renders the cube map once, not every frame. */}
      <Environment background={false} resolution={256} environmentIntensity={darkMode ? 0.7 : 0.8}>
        <color attach="background" args={['#3a3d42']} />
        <Lightformer form="rect" intensity={2.5} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[8, 8, 1]} />
        <Lightformer form="rect" intensity={1.6} position={[-5, 1.5, 1]} rotation-y={Math.PI / 2} scale={[8, 2.5, 1]} />
        <Lightformer form="rect" intensity={1.0} position={[5, 1, -1]} rotation-y={-Math.PI / 2} scale={[8, 2.5, 1]} />
        <Lightformer form="rect" intensity={0.6} position={[0, 1, -5]} scale={[8, 2, 1]} />
      </Environment>
      <ambientLight intensity={0.08} />
      <KeyLight darkMode={darkMode} hiRes={hiRes} nodes={sceneGraph.nodes} />
      {/* Double-sided: drei's Grid defaults to BackSide, so the graph
          paper vanished the moment the camera dropped below the floor —
          which it does whenever you orbit under a part to look at its
          underside, and losing the ground is losing the only reference
          for where the part is. */}
      {/* Fades at 1.6 m, which is where the rest of this scene already
          stops at bench scale: the shadow camera is +/-0.8 m and the catcher a
          1.6 m plane, so past that there is ground drawn but nothing
          grounded on it. The floor is also the main thing the eye judges
          a part's size against — a horizon six windows away is what made
          a 35 mm part read as a dot on an airfield — so it ends a few
          part-widths out and no further.

          Still `infiniteGrid`: it is the fade that is pulled in, not the
          plane, so there is no visible edge to the world.

          fadeDistance here is only the value the first frame is drawn
          with: GridFadeFollowsCamera takes it over and keeps it at a
          fixed multiple of the orbit distance, so the fade is the same
          at every zoom instead of being absent on a 40mm part and heavy
          on a half-metre one.

          fadeStrength is the shape of that falloff, not its reach: drei
          draws the grid at pow(1 - dist/fadeDistance, fadeStrength). At 1
          the fade starts at the camera and the graph paper is already
          half washed out where the part is standing, which reads as haze
          over the model rather than as ground running out. 0.8 keeps the
          grid mostly solid around the part and spends the rest of the
          fade further out, where it is doing the job of hiding the
          horizon — see GRID_FADE_RATIO for the pair of them. */}
      {/* Stands up behind the part in the Front and Side views. See GroundGrid. */}
      <GroundGrid cellSizeMm={gridCellSizeMm} darkMode={darkMode} />
      <GridFadeFollowsCamera />
      <OriginGlow darkMode={darkMode} cellSizeMm={gridCellSizeMm} />

  
      {model && data && mujoco && (
        <PhysicsLoop 
          key={`loop-${recompileId}`} 
          model={model} 
          data={data} 
          mujoco={mujoco} 
          isPlaying={isPlaying} 
        />
      )}
      {/* Outside the compile-keyed visuals on purpose: a lattice edit
          recompiles, and the editor must outlive its own commits. */}
      <LatticeEditorLayer model={model} data={data} mujoco={mujoco} />
      {model && data && mujoco && (
        /* Not keyed on recompileId any more. Remounting on every
           rebuild threw away and rebuilt every geometry in the scene —
           each mesh's buffers and normals — for a colour change, and
           tore the sculpt tools down after each of their own strokes.
           The geoms re-read their ids and poses from the new model. */
        <SceneVisuals 
          model={model} 
          data={data} 
          mujoco={mujoco} 
          sceneGraph={effectiveGraph} 
          selectedNodeId={selectedNodeId}
          setSelectedNodeId={setSelectedNodeId}
          activeWeakSpot={activeWeakSpot}
          setActiveWeakSpot={setActiveWeakSpot}
        />
      )}
  
      {/* Rope markers rendered in raw world space (no coordinate system rotation) */}
      <PulleyRopeMarkers
        sceneGraph={sceneGraph}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
      />
  
      <ReferenceImages />

      <AxisLegendDrawer externalRef={axisCanvasRef} />
      <CameraController />
      <DragInteractionController />
      <PaintStrokeController />
      <ObjectGestureController />
      <TransformGizmo />
      <MeasureTool />
      <DimensionOverlay />
      <SectionCut />
      <EdgeRoundTool />

      {/* Subtle contact-shadow AO — reads as "more depth", not a style
          change. The composer takes over the render loop from r3f, so a
          screenshot has to render through it too (see composerRef,
          _physics_composer, and SCREENSHOT in useMCPBridge) or it would
          silently capture a frame with no AO applied. */}
      <EffectComposer
        ref={(instance) => {
          composerRef.current = instance;
          physicsGlobals._physics_composer = instance;
        }}
        // MSAA on the composer's own target, which is where the scene is
        // drawn — the canvas's antialias flag only ever smoothed the
        // copy-out quad, so with this at 0 nothing in the viewport was
        // antialiased at all. The main cost of the Hi-Res switch.
        multisampling={hiRes ? 4 : 0}
        // The outline draws its selection mask between the composer's
        // passes and needs the renderer to leave the buffers alone;
        // the render pass still clears its own target.
        autoClear={false}
      >
        {/* No enableNormalPass. It drew the whole scene a second time
            every frame, and at full resolution N8AO never reads it: the
            shader samples `sceneNormal` only under HALFRES, and binds it
            to null otherwise (n8ao/dist/N8AO.js, the sceneNormal uniform),
            reconstructing normals from depth instead. A translucent halo
            on a curved body is a mesh drawn inside out, not missing
            normals — see "face winding" in CLAUDE.md. */}
        <N8AO
          aoRadius={0.35}
          intensity={0.8}
          distanceFalloff={1}
          color="black"
        />
        {/* Tone maps the bodies only, not the backdrop, grid or floor
            shadow — see BodyToneMapping. Last in the chain so it sees
            AO's output in linear light. Hi-Res only. */}
        {hiRes && <BodyToneMapping />}
        {/* After the tone mapping, so the outline is the blue asked for. */}
        {hiRes && <SelectionOutline />}
      </EffectComposer>
      {/* Draws over the composer's frame, so it comes after it. */}
      {pathTrace && <PathTracedView background={darkMode ? '#0b0f19' : '#f8fafc'} />}
      <MarqueeSelect />
    </Canvas>
  );
}
