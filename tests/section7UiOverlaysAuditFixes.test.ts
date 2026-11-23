// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// Mock heavy browser/worker dependencies that aren't needed in Node/jsdom unit tests.
vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null;
    onBreak = null;
    onImpact = null;
    onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {}
    setSound() {}
    setPlaying() {}
    setQpos() {}
    setCtrl() {}
    resume() {}
    tick() {}
    terminate() {}
    updateScript() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

const mockR3fState = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(50, 1, 0.1, 100),
  gl: {
    domElement: null as unknown as HTMLCanvasElement,
    localClippingEnabled: false,
    toneMapping: THREE.NoToneMapping,
    getDrawingBufferSize: (t: THREE.Vector2) => t.set(800, 600),
  },
  invalidate: vi.fn(),
};

vi.mock('@react-three/fiber', () => ({
  useThree: (selector?: (s: typeof mockR3fState) => unknown) =>
    selector ? selector(mockR3fState) : mockR3fState,
  useFrame: vi.fn(),
}));

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Line: () => null,
}));

const mockSimplifyGeomMesh = vi.fn();
vi.mock('../src/utils/simplifyMesh', async (orig) => {
  const actual = await orig<typeof import('../src/utils/simplifyMesh')>();
  return {
    ...actual,
    simplifyGeomMesh: (...args: unknown[]) => mockSimplifyGeomMesh(...args),
  };
});

// Helper to dispatch a React-compatible input value change in jsdom.
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function blurEl(el: HTMLElement) {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

function focusEl(el: HTMLElement) {
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

function makeBoxNode(id: string, overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    name: overrides.name ?? id,
    pos: [0, 0, 0.1],
    children: [],
    joints: [],
    geoms: [{ name: `${id}_box`, type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.5, 0.5, 0.5, 1] }],
    ...overrides,
  } as SceneNode;
}

function makeMeshNode(id: string, overrides: Partial<SceneNode> = {}, geomOverrides: Partial<SceneGeom> = {}): SceneNode {
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const faces = [0, 1, 2];
  return {
    id,
    name: overrides.name ?? id,
    pos: [0, 0, 0],
    children: [],
    joints: [],
    geoms: [
      {
        name: `${id}_mesh`,
        type: 'mesh',
        size: [],
        vertices: verts,
        faces,
        rgba: [0.5, 0.5, 0.5, 1],
        ...geomOverrides,
      },
    ],
    ...overrides,
  } as SceneNode;
}

describe('Section 7 Viewport Overlays, Hierarchy & Inspector Audit Fixes', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    g.IS_REACT_ACT_ENVIRONMENT = true;

    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    });
    mockR3fState.gl.domElement = canvas;
    mockR3fState.scene = new THREE.Scene();
    mockR3fState.camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100);
    mockR3fState.camera.position.set(0, 0, 5);
    mockR3fState.camera.lookAt(0, 0, 0);
    mockR3fState.camera.updateMatrixWorld();
    mockR3fState.camera.updateProjectionMatrix();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockSimplifyGeomMesh.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  // -------------------------------------------------------------------------
  // #9: useCommitted originating closure capture & undo cancellation + keyed InspectorCards
  // -------------------------------------------------------------------------
  describe('#9 useCommitted & InspectorPanel key isolation', () => {
    it('commits debounced edits to the originating target closure when target changes mid-debounce', async () => {
      vi.useFakeTimers();
      const { useCommitted } = await import('../src/hooks/useSettled');
      const commits: Array<{ target: string; v: number }> = [];

      let triggerEdit!: (v: number) => void;
      function Harness({ target, value }: { target: string; value: number }) {
        const [draft, setDraft] = useCommitted(value, (v) => commits.push({ target, v }), 200);
        triggerEdit = setDraft;
        return React.createElement('span', { 'data-draft': String(draft) });
      }

      await act(async () => {
        root.render(React.createElement(Harness, { target: 'bodyA:geom0', value: 1 }));
      });
      await act(async () => {
        triggerEdit(42);
      });
      // Switch target mid-debounce (e.g. activeGeomIndex or selectedNodeId changes)
      await act(async () => {
        root.render(React.createElement(Harness, { target: 'bodyB:geom1', value: 9 }));
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      expect(commits).toEqual([{ target: 'bodyA:geom0', v: 42 }]);
    });

    it('cancels pending debounced edits when Undo runs so redoStack is never overwritten', async () => {
      vi.useFakeTimers();
      const { useStore } = await import('../src/store/useStore');
      const { useCommitted } = await import('../src/hooks/useSettled');

      const nodeA = makeBoxNode('box_a');
      useStore.setState({
        sceneGraph: { nodes: [nodeA] },
        undoStack: [{
          sceneGraph: { nodes: [makeBoxNode('box_a', { pos: [0, 0, 0.5] })] },
          gravityZ: -9.81, windX: 0, windY: 0, density: 1.225,
          floorFriction: 0.8, floorBounce: 0.1, selectedNodeId: 'box_a', latticeNodeId: null,
        }],
        redoStack: [],
        tempUndoState: null,
        lastInteractionType: null,
      });

      const commitSpy = vi.fn();
      let setDraftFn!: (v: number) => void;
      function Harness() {
        const [draft, setDraft] = useCommitted(10, commitSpy, 200);
        setDraftFn = setDraft;
        return React.createElement('span', null, String(draft));
      }

      await act(async () => {
        root.render(React.createElement(Harness));
      });
      await act(async () => {
        setDraftFn(99);
      });
      expect(container.textContent).toBe('99');

      // Press Ctrl+Z -> undo() runs before the 200 ms debounce timer fires
      await act(async () => {
        useStore.getState().undo();
      });
      expect(useStore.getState().redoStack.length).toBe(1);

      // Advance past debounce timer — must NOT commit stale 99 or wipe redoStack
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(commitSpy).not.toHaveBeenCalled();
      expect(useStore.getState().redoStack.length).toBe(1);
      expect(container.textContent).toBe('10');
    });

    it('keys InspectorCards by selectedNode.id so MeshGeomsCard vertex editor never bleeds across bodies', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { usePanels } = await import('../src/store/panelsStore');
      const { InspectorPanel } = await import('../src/components/inspector/InspectorPanel');

      const meshA = makeMeshNode('mesh_a');
      const meshB = makeMeshNode('mesh_b');
      usePanels.setState({ inspectorTab: 'shape', isPropertiesOpen: true });
      useStore.setState({
        sceneGraph: { nodes: [meshA, meshB] },
        selectedNodeId: 'mesh_a',
        isPlaying: false,
      });

      const sceneRef = { current: null };
      await act(async () => {
        root.render(React.createElement(InspectorPanel, { threeSceneRef: sceneRef }));
      });

      // Open vertex editor on mesh_a
      const editBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Edit Vertices'),
      )!;
      expect(editBtn).toBeTruthy();
      await act(async () => { editBtn.click(); });
      expect(container.querySelector('textarea')).not.toBeNull();

      // Switch to mesh_b — InspectorCards remounts cleanly so editor is closed
      await act(async () => {
        useStore.setState({ selectedNodeId: 'mesh_b' });
      });
      expect(container.querySelector('textarea')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #10: Legacy gear gating in GearCard & ResizeCard
  // -------------------------------------------------------------------------
  describe('#10 GearCard & ResizeCard legacy gear gating', () => {
    it('isLegacyGear only matches cylinder-hub primitive gears, never mesh/SCAD/toothForm/box bodies', async () => {
      const { isLegacyGear, GearCard } = await import('../src/components/inspector/GearCard');
      const { ResizeCard } = await import('../src/components/inspector/ResizeCard');

      const legacyCog: SceneNode = {
        id: 'gear_1', name: 'gear_1', pos: [0, 0, 0], children: [], joints: [],
        geoms: [
          { name: 'gear_1_hub', type: 'cylinder', size: [0.2, 0.05] },
          { name: 'gear_1_tooth_0', type: 'box', size: [0.04, 0.04, 0.05] },
        ],
      } as SceneNode;
      const stlGear = makeMeshNode('gear_stl');
      const landingGear = makeBoxNode('landing_gear');
      const scadGear: SceneNode = { ...legacyCog, id: 'gear_scad', scad: 'cylinder(r=0.2, h=0.1);' };
      const involuteGear: SceneNode = { ...legacyCog, id: 'gear_inv', toothForm: 'involute' as never };
      const unnamedPegGear: SceneNode = {
        ...legacyCog,
        geoms: [
          { name: undefined as unknown as string, type: 'cylinder', size: [0.2, 0.05] },
          { name: undefined as unknown as string, type: 'box', size: [0.04, 0.04, 0.05] },
        ],
      };

      expect(isLegacyGear(legacyCog)).toBe(true);
      expect(isLegacyGear(unnamedPegGear)).toBe(true);
      expect(isLegacyGear(stlGear)).toBe(false);
      expect(isLegacyGear(landingGear)).toBe(false);
      expect(isLegacyGear(scadGear)).toBe(false);
      expect(isLegacyGear(involuteGear)).toBe(false);

      // GearCard must not crash on STL mesh, empty geoms, or unnamed geoms
      await act(async () => { root.render(React.createElement(GearCard, { node: stlGear })); });
      expect(container.textContent).toBe('');
      await act(async () => { root.render(React.createElement(GearCard, { node: unnamedPegGear })); });
      expect(container.textContent).toContain('Gear Properties');

      // ResizeCard must stay visible for landing_gear and gear_stl, hidden for legacyCog
      await act(async () => { root.render(React.createElement(ResizeCard, { node: landingGear })); });
      expect(container.textContent).toContain('Resize Component');
      await act(async () => { root.render(React.createElement(ResizeCard, { node: legacyCog })); });
      expect(container.textContent).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // #11 & #30: MeasureTool & SectionCut InstancedMesh, visibility & hotkey fixes
  // -------------------------------------------------------------------------
  describe('#11 & #30 MeasureTool & SectionCut', () => {
    it('MeasureTool recognizes InstancedMesh static boxes, composes instanceMatrix, and skips hidden/zero-scale objects', async () => {
      const { isBodyGeometry, isMeasurableHit, hitWorldMatrix, triangleOf, analyticCentres } =
        await import('../src/components/scene/MeasureTool');

      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ opacity: 1 }),
        2,
      );
      inst.userData = { nodeIds: ['floor_box', 'hidden_box'] };
      inst.position.set(1, 0, 0);
      inst.updateMatrixWorld(true);

      // Instance 0: placed at local (2, 0, 0) with scale (2, 2, 2) -> world centre (3, 0, 0)
      const m0 = new THREE.Matrix4().compose(
        new THREE.Vector3(2, 0, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(2, 2, 2),
      );
      inst.setMatrixAt(0, m0);
      // Instance 1: zero-scale hidden slot
      inst.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));

      expect(isBodyGeometry(inst)).toBe(true);
      expect(isMeasurableHit({ object: inst, instanceId: 0 })).toBe(true);
      expect(isMeasurableHit({ object: inst, instanceId: 1 })).toBe(false);

      const world0 = hitWorldMatrix(inst, 0);
      const tri = triangleOf(inst, 0, world0);
      expect(tri.length).toBe(3);
      // BoxGeometry half-extents 0.5 scaled by 2 -> +/-1 around world centre (3, 0, 0), so x in [2, 4]
      for (const [x] of tri) {
        expect(x).toBeGreaterThanOrEqual(1.99);
        expect(x).toBeLessThanOrEqual(4.01);
      }

      // Cylinder analyticCentres composed with world matrix
      const cylInst = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.1, 0.1, 1),
        new THREE.MeshStandardMaterial(),
        1,
      );
      cylInst.userData = { nodeIds: ['cyl_1'] };
      cylInst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(5, 0, 0));
      cylInst.updateMatrixWorld(true);
      const centres = analyticCentres(cylInst, hitWorldMatrix(cylInst, 0));
      expect(centres.some((c) => Math.abs(c.point[0] - 5) < 1e-6)).toBe(true);

      // Hidden ancestor and opacity 0 / invisible materials are excluded
      const hiddenGroup = new THREE.Group();
      hiddenGroup.name = 'body_hidden';
      hiddenGroup.visible = false;
      const hiddenMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      hiddenGroup.add(hiddenMesh);
      expect(isBodyGeometry(hiddenMesh)).toBe(false);

      const visGroup = new THREE.Group();
      visGroup.name = 'body_vis';
      const zeroAlphaMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 }),
      );
      const matHiddenMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ visible: false }),
      );
      visGroup.add(zeroAlphaMesh, matHiddenMesh);
      expect(isBodyGeometry(zeroAlphaMesh)).toBe(false);
      expect(isBodyGeometry(matHiddenMesh)).toBe(false);
    });

    it('MeasureTool allows D/A hotkeys to toggle off & switch modes despite its own gestureStatus, and exits on isPlaying', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { MeasureTool } = await import('../src/components/scene/MeasureTool');

      useStore.setState({
        measureMode: null,
        gestureStatus: null,
        draggedNodeId: null,
        sculptNodeId: null,
        paintMode: false,
        isPlaying: false,
      });

      await act(async () => {
        root.render(React.createElement(MeasureTool));
      });

      // Press D -> enters distance mode and sets gestureStatus
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'd' }));
      });
      expect(useStore.getState().measureMode).toBe('distance');
      expect(useStore.getState().gestureStatus).toContain('Measure');

      // Press A while active -> switches to angle mode (previously blocked by gestureStatus!)
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
      });
      expect(useStore.getState().measureMode).toBe('angle');

      // Press A again -> toggles off cleanly
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
      });
      expect(useStore.getState().measureMode).toBeNull();

      // Enter distance mode, then start playing -> exits measureMode automatically
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'd' }));
      });
      expect(useStore.getState().measureMode).toBe('distance');
      await act(async () => {
        useStore.setState({ isPlaying: true });
      });
      expect(useStore.getState().measureMode).toBeNull();
    });

    it('SectionCut partMaterials includes InstancedMesh static boxes and excludes overlays/background', async () => {
      const { partMaterials } = await import('../src/components/scene/SectionCut');

      const scene = new THREE.Scene();
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'body_1';
      const bodyMat = new THREE.MeshStandardMaterial();
      bodyGroup.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bodyMat));

      const instMat = new THREE.MeshStandardMaterial();
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), instMat, 1);
      inst.userData = { nodeIds: ['static_floor'] };

      const overlayMat = new THREE.MeshBasicMaterial();
      const overlay = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), overlayMat);
      overlay.userData = { isOverlay: true };

      const bgMat = new THREE.MeshStandardMaterial();
      const bgInst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bgMat, 1);
      bgInst.userData = { isBackground: true, nodeIds: ['bg'] };

      scene.add(bodyGroup, inst, overlay, bgInst);
      const mats = partMaterials(scene);
      expect(mats).toContain(bodyMat);
      expect(mats).toContain(instMat);
      expect(mats).not.toContain(overlayMat);
      expect(mats).not.toContain(bgMat);
    });
  });

  // -------------------------------------------------------------------------
  // #25: MarqueeSelect off-canvas swallowClick, pointercancel/blur, bounds isolation
  // -------------------------------------------------------------------------
  describe('#25 MarqueeSelect', () => {
    it('computes parent Box3 from its own visible meshes only and skips hidden & zero-scale instances', async () => {
      const { collectVisibleBodyBounds } = await import('../src/components/scene/MarqueeSelect');

      const scene = new THREE.Scene();
      const parent = new THREE.Group();
      parent.name = 'parent';
      const parentMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      parent.add(parentMesh);

      // Child body far away at x = 100 — must NOT skew parent's centre!
      const child = new THREE.Group();
      child.name = 'child';
      child.position.set(100, 0, 0);
      child.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
      parent.add(child);

      // Hidden body
      const hidden = new THREE.Group();
      hidden.name = 'hidden';
      hidden.visible = false;
      hidden.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));

      // InstancedMesh with one live box and one zero-scale hidden slot
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 2);
      inst.userData = { nodeIds: ['inst_live', 'inst_zero'] };
      inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(5, 0, 0));
      inst.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));

      scene.add(parent, hidden, inst);
      const bounds = collectVisibleBodyBounds(scene, new Set(['parent', 'child', 'hidden', 'inst_live', 'inst_zero']));

      const parentCenter = bounds.get('parent')!.getCenter(new THREE.Vector3());
      const childCenter = bounds.get('child')!.getCenter(new THREE.Vector3());
      expect(parentCenter.x).toBeCloseTo(0, 5);
      expect(childCenter.x).toBeCloseTo(100, 5);
      expect(bounds.has('hidden')).toBe(false);
      expect(bounds.has('inst_live')).toBe(true);
      expect(bounds.has('inst_zero')).toBe(false);
    });

    it('clears swallowClick after off-canvas pointerup and cleans up marquee div on pointercancel/blur', async () => {
      vi.useFakeTimers();
      const { useStore } = await import('../src/store/useStore');
      const { MarqueeSelect } = await import('../src/components/scene/MarqueeSelect');

      useStore.setState({ multiSelectMode: true, sceneGraph: { nodes: [] } });
      const canvas = mockR3fState.gl.domElement;
      document.body.appendChild(canvas);

      await act(async () => {
        root.render(React.createElement(MarqueeSelect));
      });

      // Start drag on canvas, move past DRAG_PX, release off-canvas
      canvas.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 80, clientY: 80 }));
      window.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 80, clientY: 80 }));

      // No browser click fired after off-canvas pointerup; advance 0ms macrotask
      vi.advanceTimersByTime(1);

      // Next real click anywhere on page must NOT be swallowed
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      const btnClick = vi.fn();
      btn.addEventListener('click', btnClick);
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(btnClick).toHaveBeenCalledTimes(1);

      // Start another drag and verify window blur removes the green marquee div
      const divsBefore = document.body.querySelectorAll('div').length;
      canvas.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 60, clientY: 60 }));
      expect(document.body.querySelectorAll('div').length).toBe(divsBefore + 1);

      window.dispatchEvent(new window.Event('blur'));
      expect(document.body.querySelectorAll('div').length).toBe(divsBefore);

      btn.remove();
      canvas.remove();
    });
  });

  // -------------------------------------------------------------------------
  // #26 & #27: SettledNumberInput min/max, crumpleRangeDeg ordering, Tube bounds
  // -------------------------------------------------------------------------
  describe('#26 & #27 SettledNumberInput, JointSettingsCard, ShapeParamFields', () => {
    it('SettledNumberInput defers out-of-range values during typing and clamps on blur/Enter', async () => {
      vi.useFakeTimers();
      const { SettledNumberInput } = await import('../src/components/SettledInputs');
      const onChange = vi.fn();

      await act(async () => {
        root.render(React.createElement(SettledNumberInput, { value: 10, min: 0, max: 50, onChange }));
      });
      const input = container.querySelector('input')!;

      // Type negative value below min=0 -> never committed on debounce timer
      await act(async () => { setInputValue(input, '-5'); });
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(onChange).not.toHaveBeenCalled();
      expect(input.value).toBe('-5');

      // Blur clamps to min=0 and commits 0
      await act(async () => {
        blurEl(input);
      });
      expect(onChange).toHaveBeenCalledWith(0);
      expect(input.value).toBe('0');

      // Type above max=50 and press Enter -> clamps to 50
      onChange.mockClear();
      await act(async () => { setInputValue(input, '999'); });
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith(50);
      expect(input.value).toBe('50');
    });

    it('JointSettingsCard enforces crumpleRangeDeg[0] <= crumpleRangeDeg[1]', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { JointSettingsCard } = await import('../src/components/inspector/JointSettingsCard');

      const updateJointSpy = vi.fn();
      useStore.setState({ updateNodeJoint: updateJointSpy });

      const node = makeBoxNode('hinge_body', {
        joints: [{
          name: 'h1', type: 'hinge', axis: [0, 1, 0],
          crumpleTorqueNm: 10, crumpleRangeDeg: [-80, 0], crumpleDampingAfter: 5,
        }],
      });

      await act(async () => {
        root.render(React.createElement(JointSettingsCard, { node }));
      });

      const numInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
      // Find the two Folds to inputs (values -80 and 0)
      const loInput = numInputs.find((i) => i.value === '-80')!;
      const hiInput = numInputs.find((i) => i.value === '0' && i.min === '-80')!;
      expect(loInput.max).toBe('0');
      expect(hiInput.min).toBe('-80');

      // Attempt to set low bound > high bound (20 > 0) -> clamped to 0 on Enter
      await act(async () => { setInputValue(loInput, '20'); });
      await act(async () => {
        loInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(updateJointSpy).toHaveBeenCalledWith('hinge_body', { crumpleRangeDeg: [0, 0] }, 0);
    });

    it('ShapeParamFields enforces Tube innerRadius < outerRadius via SliderValue bounds', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { ShapeParamFields } = await import('../src/components/inspector/ShapeParamFields');

      const updateTubeSpy = vi.fn();
      useStore.setState({ updateTubeParams: updateTubeSpy });

      const tubeNode = makeMeshNode('tube_1', {
        isTube: true, innerRadius: 0.2, outerRadius: 0.3, height: 0.5,
      });

      await act(async () => {
        root.render(React.createElement(ShapeParamFields, { node: tubeNode, geom: tubeNode.geoms[0] }));
      });

      const textInputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
      // Inner radius SliderValue is first (shown in mm: 200.0)
      const innerInput = textInputs[0];
      await act(async () => {
        focusEl(innerInput);
      });
      await act(async () => {
        setInputValue(innerInput, '500'); // 0.5 m > outerRadius 0.3 m
      });
      await act(async () => {
        blurEl(innerInput);
      });
      expect(updateTubeSpy).toHaveBeenCalled();
      const [idArg, patchArg] = updateTubeSpy.mock.calls[0];
      expect(idArg).toBe('tube_1');
      expect(patchArg.innerRadius).toBeCloseTo(0.295, 5);
    });
  });

  // -------------------------------------------------------------------------
  // #28 & #29: ContainerWaterCard undo recording & PositionCard empty renderVertices
  // -------------------------------------------------------------------------
  describe('#28 & #29 ContainerWaterCard & PositionCard', () => {
    it('ContainerWaterCard calls updateNode without skipRecompile so undo history & editGuard run', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { ContainerWaterCard } = await import('../src/components/inspector/ContainerWaterCard');

      const updateNodeSpy = vi.fn();
      useStore.setState({ updateNode: updateNodeSpy });

      // Build an open-top container (floor + 4 walls) that measureContainerBasin recognizes
      const tankNode: SceneNode = {
        id: 'tank', name: 'tank', pos: [0, 0, 0], children: [], joints: [],
        geoms: [
          { name: 'floor', type: 'box', pos: [0, 0, 0.01], size: [0.2, 0.2, 0.01] },
          { name: 'w1', type: 'box', pos: [0.19, 0, 0.11], size: [0.01, 0.2, 0.1] },
          { name: 'w2', type: 'box', pos: [-0.19, 0, 0.11], size: [0.01, 0.2, 0.1] },
          { name: 'w3', type: 'box', pos: [0, 0.19, 0.11], size: [0.2, 0.01, 0.1] },
          { name: 'w4', type: 'box', pos: [0, -0.19, 0.11], size: [0.2, 0.01, 0.1] },
        ],
      } as SceneNode;

      await act(async () => {
        root.render(React.createElement(ContainerWaterCard, { node: tankNode }));
      });
      const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      await act(async () => { toggle.click(); });

      expect(updateNodeSpy).toHaveBeenCalledWith('tank', { waterFill: 0.8 });
    });

    it('PositionCard guards empty renderVertices so centroidZ is 0 (never -Infinity)', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { PositionCard } = await import('../src/components/inspector/PositionCard');

      const updatePosSpy = vi.fn();
      useStore.setState({ updateNodePos: updatePosSpy });

      const emptyDynMesh = makeMeshNode(
        'dyn_empty',
        { pos: [0, 0, 0.25] },
        { dynamic: true, renderVertices: [] },
      );

      await act(async () => {
        root.render(React.createElement(PositionCard, { node: emptyDynMesh }));
      });

      expect(container.textContent).not.toContain('Infinity');
      const zRange = Array.from(container.querySelectorAll('input[type="range"]'))[2] as HTMLInputElement;
      expect(Number(zRange.value)).toBeCloseTo(0.25, 4);
    });
  });

  // -------------------------------------------------------------------------
  // #31 & #70: HierarchyTree multi-select, sub-geom delete, collapsedIds & InspectorPanel cleanup
  // -------------------------------------------------------------------------
  describe('#31 & #70 HierarchyTree & InspectorPanel listener cleanup', () => {
    it('HierarchyTree highlights extraSelectedIds, Shift-clicks to toggle multi-select, and preserves selected activeGeomIndex when deleting unselected sub-geom', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { HierarchyTree } = await import('../src/components/HierarchyTree');

      const bodyA = makeBoxNode('body_a', {
        geoms: [
          { name: 'a0', type: 'box', size: [0.1, 0.1, 0.1] },
          { name: 'a1', type: 'box', size: [0.1, 0.1, 0.1] },
        ],
      });
      const bodyB = makeBoxNode('body_b', {
        geoms: [
          { name: 'b0', type: 'box', size: [0.1, 0.1, 0.1] },
          { name: 'b1', type: 'box', size: [0.1, 0.1, 0.1] },
        ],
      });
      const deleteGeomSpy = vi.fn();
      useStore.setState({
        sceneGraph: { nodes: [bodyA, bodyB] },
        selectedNodeId: 'body_a',
        extraSelectedIds: [],
        activeGeomIndex: 1,
        geomFocused: true,
        deleteNodeGeom: deleteGeomSpy,
      });

      await act(async () => {
        root.render(React.createElement(HierarchyTree));
      });

      // Shift-click body_b -> adds body_b to extraSelectedIds
      const bodyBRow = Array.from(container.querySelectorAll('div')).find(
        (d) => d.textContent?.includes('body_b') && d.className.includes('cursor-pointer'),
      )!;
      await act(async () => {
        bodyBRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
      });
      expect(useStore.getState().extraSelectedIds).toContain('body_b');
      expect(bodyBRow.className).toContain('bg-blue-50');

      // Delete sub-geom b1 on unselected body_b -> must NOT reset body_a's activeGeomIndex (1)
      const delB1 = Array.from(container.querySelectorAll('button')).find(
        (b) => b.title.includes('Delete shape "b1"'),
      )!;
      await act(async () => { delB1.click(); });
      expect(deleteGeomSpy).toHaveBeenCalledWith('body_b', 1);
      expect(useStore.getState().activeGeomIndex).toBe(1);
    });

    it('InspectorPanel removes window resize listeners on blur and unmount', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { usePanels } = await import('../src/store/panelsStore');
      const { InspectorPanel } = await import('../src/components/inspector/InspectorPanel');

      const box = makeBoxNode('box_resize');
      usePanels.setState({ inspectorTab: 'main', isPropertiesOpen: true });
      useStore.setState({ sceneGraph: { nodes: [box] }, selectedNodeId: 'box_resize', isPlaying: false });

      const removeSpy = vi.spyOn(window, 'removeEventListener');
      await act(async () => {
        root.render(React.createElement(InspectorPanel, { threeSceneRef: { current: null } }));
      });

      const handle = container.querySelector('[title="Drag to resize panel"]') as HTMLElement;
      await act(async () => {
        handle.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      });
      await act(async () => {
        root.unmount();
      });

      expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));
      // Recreate root for afterEach cleanup
      root = createRoot(container);
    });
  });

  // -------------------------------------------------------------------------
  // #50–#54, #67–#69: Inspector cards & PathTracedView fixes
  // -------------------------------------------------------------------------
  describe('#50–#54, #67–#69 Inspector Cards & PathTracedView', () => {
    it('#50 MaterialCard preserves custom solimp on damping change, handles <3 friction, and applies preset in 1 updateNode call', async () => {
      vi.useFakeTimers();
      const { useStore } = await import('../src/store/useStore');
      const { MaterialCard } = await import('../src/components/inspector/MaterialCard');

      const updateNodeSpy = vi.fn();
      const updateGeomSpy = vi.fn();
      useStore.setState({ updateNode: updateNodeSpy, updateNodeGeom: updateGeomSpy });

      const customSolimp = [0.85, 0.95, 0.002, 0.5, 2];
      const node = makeBoxNode('mat_box', {
        geoms: [{
          name: 'mat_box_g', type: 'box', size: [0.1, 0.1, 0.1],
          solref: [0.02, 0.8],
          solimp: customSolimp,
          friction: [0.5], // < 3 elements!
        }],
      });

      await act(async () => {
        root.render(React.createElement(MaterialCard, { node, geom: node.geoms[0], activeIndex: 0 }));
      });

      // Pick Steel preset -> single atomic updateNode call with both node & geoms
      const select = container.querySelector('select') as HTMLSelectElement;
      await act(async () => { setSelectValue(select, 'steel'); });
      expect(updateNodeSpy).toHaveBeenCalledTimes(1);
      expect(updateGeomSpy).not.toHaveBeenCalled();
      expect(updateNodeSpy.mock.calls[0][1].deformMaterial).toBe('steel');
      expect(updateNodeSpy.mock.calls[0][1].geoms[0].density).toBe(7850);

      // Adjust Damping Ratio slider -> must NOT overwrite custom solimp!
      const ranges = Array.from(container.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
      const dampingSlider = ranges[1];
      await act(async () => { setInputValue(dampingSlider, '0.3'); });
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(updateGeomSpy).toHaveBeenCalledTimes(1);
      expect(updateGeomSpy.mock.calls[0][1]).toEqual({ solref: [0.02, 0.3] });
    });

    it('#50 JoinCard applies material preset in 1 updateNode call', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { JoinCard } = await import('../src/components/inspector/JoinCard');

      const updateNodeSpy = vi.fn();
      const updateGeomSpy = vi.fn();
      useStore.setState({ updateNode: updateNodeSpy, updateNodeGeom: updateGeomSpy });

      const node = makeBoxNode('join_blob', {
        joinMaterial: 'hotGlue',
        geoms: [{ name: 'blob', type: 'sphere', size: [0.01] }],
      });

      await act(async () => {
        root.render(React.createElement(JoinCard, { node }));
      });
      const select = container.querySelector('select') as HTMLSelectElement;
      await act(async () => { setSelectValue(select, 'putty'); });

      expect(updateNodeSpy).toHaveBeenCalledTimes(1);
      expect(updateGeomSpy).not.toHaveBeenCalled();
      expect(updateNodeSpy.mock.calls[0][1].joinMaterial).toBe('putty');
      expect(updateNodeSpy.mock.calls[0][1].geoms).toHaveLength(1);
    });

    it('#51 MeshGeomsCard guards missing faces, rejects Infinity, clears paint/colliders, and guards async simplify against isPlaying', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { MeshGeomsCard } = await import('../src/components/inspector/MeshGeomsCard');

      const noFacesNode = makeMeshNode('mesh_nofaces', {}, { faces: undefined });
      useStore.setState({ sceneGraph: { nodes: [noFacesNode] }, isPlaying: false });

      // Must render and open vertex editor without throwing even when faces is undefined
      await act(async () => {
        root.render(React.createElement(MeshGeomsCard, { node: noFacesNode }));
      });
      const editBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Edit Vertices'),
      )!;
      await act(async () => { editBtn.click(); });
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();

      // Reject Infinity vertices
      await act(async () => {
        setInputValue(textarea, '# vertices\nInfinity 0 0\n1 0 0\n0 1 0\n# faces\n0 1 2');
      });
      const applyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Apply Mesh'),
      )!;
      await act(async () => { applyBtn.click(); });
      expect(container.textContent).toContain('finite');

      // Apply valid vertices clears paint, stale colliders, collisionHash & collisionDecomposed
      const paintedNode: SceneNode = {
        ...makeMeshNode('mesh_painted', {
          collisionHash: 'old_hash',
          collisionDecomposed: true,
        }, {
          paint: { res: [1, 1, 1], entries: [] } as never,
        }),
        geoms: [
          makeMeshNode('mesh_painted').geoms[0],
          { name: 'col_0', type: 'mesh', size: [], csgDerived: 'collider', vertices: [0, 0, 0], faces: [0, 0, 0] },
        ],
      };
      (paintedNode.geoms[0] as SceneGeom).paint = { res: [1, 1, 1], entries: [] } as never;
      useStore.setState({ sceneGraph: { nodes: [paintedNode] }, isPlaying: false });
      await act(async () => {
        root.render(React.createElement(MeshGeomsCard, { node: paintedNode }));
      });
      const weldBtn = container.querySelector('button[title="Remove duplicate vertices"]') as HTMLButtonElement;
      await act(async () => { weldBtn.click(); });

      const updated = useStore.getState().sceneGraph.nodes[0];
      expect(updated.collisionHash).toBeUndefined();
      expect(updated.collisionDecomposed).toBeUndefined();
      expect(updated.geoms.some((g) => g.csgDerived === 'collider')).toBe(false);
      expect(updated.geoms[0].paint).toBeUndefined();

      // Async simplify aborts if simulation starts playing while awaiting
      let resolveSimplify!: (v: unknown) => void;
      mockSimplifyGeomMesh.mockImplementationOnce(
        () => new Promise((res) => { resolveSimplify = res; }),
      );
      const updateSceneSpy = vi.fn();
      useStore.setState({ sceneGraph: { nodes: [makeMeshNode('mesh_async')] }, isPlaying: false, updateScene: updateSceneSpy });
      await act(async () => {
        root.render(React.createElement(MeshGeomsCard, { node: useStore.getState().sceneGraph.nodes[0] }));
      });
      const openSimp = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Simplify'),
      )!;
      await act(async () => { openSimp.click(); });
      const runSimp = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Simplify Mesh'),
      )!;
      await act(async () => { runSimp.click(); });
      useStore.setState({ isPlaying: true });
      await act(async () => {
        resolveSimplify({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] });
        await Promise.resolve();
      });
      expect(updateSceneSpy).not.toHaveBeenCalled();
    });

    it('#52 CsgCard disables deleting the last positive shape when a difference cutter exists', async () => {
      const { CsgCard } = await import('../src/components/inspector/CsgCard');

      const csgNode = makeBoxNode('csg_part', {
        csgEnabled: true,
        geoms: [
          { name: 'base_box', type: 'box', size: [0.2, 0.2, 0.2], csg: 'union' },
          { name: 'hole_cyl', type: 'cylinder', size: [0.05, 0.3], csg: 'difference' },
        ],
      });

      await act(async () => {
        root.render(React.createElement(CsgCard, { node: csgNode }));
      });

      const deleteButtons = Array.from(container.querySelectorAll('button')).filter(
        (b) => b.title.includes('shape'),
      ) as HTMLButtonElement[];
      expect(deleteButtons).toHaveLength(2);
      // First row is sole positive shape -> MUST be disabled!
      expect(deleteButtons[0].disabled).toBe(true);
      // Second row is difference cutter -> deletable!
      expect(deleteButtons[1].disabled).toBe(false);
    });

    it('#53 CurveFields handles + Add Point on empty curvePoints and allows typing "-" without snapping back', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { CurveFields } = await import('../src/components/inspector/CurveFields');

      const updateCurveSpy = vi.fn();
      useStore.setState({ updateCurveParams: updateCurveSpy });

      const emptyCurve = makeBoxNode('curve_empty', { isCurve: true, curvePoints: [] });
      await act(async () => {
        root.render(React.createElement(CurveFields, { node: emptyCurve }));
      });
      const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Add Point'),
      )!;
      await act(async () => { addBtn.click(); });
      expect(updateCurveSpy).toHaveBeenCalledWith('curve_empty', { points: [[0, 0, 0]] });

      const populatedCurve = makeBoxNode('curve_1', {
        isCurve: true,
        curvePoints: [[0, 0, 0], [1, 0, 0]],
      });
      await act(async () => {
        root.render(React.createElement(CurveFields, { node: populatedCurve }));
      });
      const coordInput = container.querySelector('input[type="number"]') as HTMLInputElement;
      // Clearing the input while typing stays empty (previously snapped straight back to "0")
      await act(async () => { setInputValue(coordInput, ''); });
      expect(coordInput.value).toBe('');
      await act(async () => { setInputValue(coordInput, '-50'); });
      expect(coordInput.value).toBe('-50');
    });

    it('#54 PathTracedView skips invisible materials, tracks PBR/glow/emissive/side/visible in sceneSignature, and guards zero-distance key light', async () => {
      const { collectBodies, sceneSignature, sameSignature, SCENE_TOLERANCE, buildTracedScene } =
        await import('../src/components/scene/PathTracedView');

      const scene = new THREE.Scene();
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1, color: 0xffffff });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh.castShadow = true;
      const invisibleMatMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ visible: false }),
      );
      invisibleMatMesh.castShadow = true;
      scene.add(mesh, invisibleMatMesh);

      const bodies = collectBodies(scene);
      expect(bodies).toEqual([mesh]);

      const sigBase = sceneSignature(bodies);
      mat.roughness = 0.2;
      expect(sameSignature(sigBase, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      const sigRough = sceneSignature(bodies);
      mat.metalness = 0.9;
      expect(sameSignature(sigRough, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      const sigMetal = sceneSignature(bodies);
      mat.emissive.setRGB(1, 0.2, 0.1);
      expect(sameSignature(sigMetal, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      const sigEmissive = sceneSignature(bodies);
      mat.userData.glow = 0.8;
      expect(sameSignature(sigEmissive, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      const sigGlow = sceneSignature(bodies);
      mat.transparent = true;
      expect(sameSignature(sigGlow, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      const sigTrans = sceneSignature(bodies);
      mat.side = THREE.DoubleSide;
      expect(sameSignature(sigTrans, sceneSignature(bodies), SCENE_TOLERANCE)).toBe(false);

      // Coincident key light & target (distance === 0) must NOT produce NaN intensity light
      const key = new THREE.DirectionalLight(0xffffff, 2);
      key.castShadow = true;
      key.position.set(0, 0, 0);
      key.target.position.set(0, 0, 0);
      scene.add(key, key.target);
      scene.updateMatrixWorld(true);

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial());
      const traced = buildTracedScene(scene, bodies, floor, '#ffffff', 'studio', [], [], []);
      traced.traverse((o) => {
        const light = o as THREE.Light;
        if (light.isLight) expect(Number.isFinite(light.intensity)).toBe(true);
      });
    });

    it('#67 JointTypeCard rejects empty/whitespace-only joint names', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { JointTypeCard } = await import('../src/components/inspector/JointTypeCard');

      const updateJointSpy = vi.fn();
      useStore.setState({ updateNodeJoint: updateJointSpy });

      const node = makeBoxNode('j_body', {
        joints: [{ name: 'hinge_1', type: 'hinge', axis: [0, 1, 0] }],
      });

      await act(async () => {
        root.render(React.createElement(JointTypeCard, { node }));
      });
      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      await act(async () => { setInputValue(input, '   '); });
      await act(async () => {
        blurEl(input);
      });
      expect(updateJointSpy).not.toHaveBeenCalled();
      expect(input.value).toBe('hinge_1');
    });

    it('#68 GeomPropertiesCard enforces min mass on dynamic bodies, clamps RGB hex, and filters collision geoms in SubGeomSelector', async () => {
      vi.useFakeTimers();
      const { useStore } = await import('../src/store/useStore');
      const { GeomPropertiesCard, SubGeomSelector } = await import('../src/components/inspector/GeomPropertiesCard');

      const updateGeomSpy = vi.fn();
      useStore.setState({ updateNodeGeom: updateGeomSpy, activeGeomIndex: 0 });

      // Clamps out-of-range rgba [-0.5, 1.5, 0.5, 1] -> #00ff80
      const hdrColorNode = makeBoxNode('hdr_box', {
        joints: [{ name: 'free_j', type: 'free' }],
        geoms: [{ name: 'g0', type: 'box', size: [0.1, 0.1, 0.1], rgba: [-0.5, 1.5, 0.5, 1], mass: 1 }],
      });
      await act(async () => {
        root.render(React.createElement(GeomPropertiesCard, { node: hdrColorNode, part: 'main' }));
      });
      const colorInput = container.querySelector('input[type="color"]') as HTMLInputElement;
      expect(colorInput.value).toBe('#00ff80');

      // Dynamic body Mass enforces min=0.001
      await act(async () => {
        root.render(React.createElement(GeomPropertiesCard, { node: hdrColorNode, part: 'physics' }));
      });
      const massRange = container.querySelector('input[type="range"]') as HTMLInputElement;
      expect(massRange.min).toBe('0.001');

      // SubGeomSelector hides role === 'collision' geoms
      const withCollider = makeBoxNode('with_col', {
        geoms: [
          { name: 'vis_box', type: 'box', size: [0.1, 0.1, 0.1] },
          { name: 'col_proxy', type: 'box', size: [0.1, 0.1, 0.1], role: 'collision' },
        ],
      });
      await act(async () => {
        root.render(React.createElement(SubGeomSelector, { node: withCollider }));
      });
      // Only 1 editable geom remains after filtering out collision proxy -> selector does not render
      expect(container.querySelector('select')).toBeNull();
    });

    it('#69 ScadEditorCard displays legacy SCAD code locally without mutating the store on selection', async () => {
      const { useStore } = await import('../src/store/useStore');
      const { ScadEditorCard } = await import('../src/components/inspector/ScadEditorCard');

      const updateNodeSpy = vi.fn();
      useStore.setState({ updateNode: updateNodeSpy });

      const legacyScadNode = makeBoxNode('openscad_legacy_1', { scad: undefined });
      await act(async () => {
        root.render(React.createElement(ScadEditorCard, { node: legacyScadNode }));
      });

      expect(updateNodeSpy).not.toHaveBeenCalled();
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value.length).toBeGreaterThan(0);
    });
  });
});
