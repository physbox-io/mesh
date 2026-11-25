// @vitest-environment jsdom
import React, { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activeRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = { root, container };
  activeRoots.push(entry);
  act(() => {
    root.render(element);
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      const idx = activeRoots.indexOf(entry);
      if (idx >= 0) activeRoots.splice(idx, 1);
    },
  };
}

function cleanup() {
  while (activeRoots.length > 0) {
    const entry = activeRoots.pop()!;
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
}

type FrameCallback = (state: {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  invalidate: () => void;
}) => void;

const r3fMock = vi.hoisted(() => ({
  scene: null as THREE.Scene | null,
  gl: null as { localClippingEnabled: boolean; toneMapping: number; autoClear: boolean } | null,
  invalidate: vi.fn(),
  frameCallbacks: [] as FrameCallback[],
}));

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (s: unknown) => unknown) =>
    selector({
      scene: r3fMock.scene,
      gl: r3fMock.gl,
      invalidate: r3fMock.invalidate,
      camera: new THREE.PerspectiveCamera(),
      get: () => ({
        scene: r3fMock.scene,
        gl: r3fMock.gl,
      }),
    }),
  useFrame: (cb: FrameCallback) => {
    r3fMock.frameCallbacks.push(cb);
  },
}));

import {
  normalizeSectionPlane,
  attachClippingPlane,
  detachClippingPlane,
  isSectionPart,
  SectionCut,
} from '../src/components/scene/SectionCut';
import {
  collectBodies,
  sameSignature,
  sceneSignature,
  tracedMaterial,
  SCENE_TOLERANCE,
} from '../src/components/scene/PathTracedView';
import { BODY_TONE_MAPPING_FRAGMENT_SHADER } from '../src/components/scene/BodyToneMapping';
import { StudioBackdrop } from '../src/components/scene/StudioBackdrop';
import { computeWaterBasinMeshParams } from '../src/components/scene/WaterSurface';
import { resolveReferenceTransform, ReferenceImages } from '../src/components/scene/ReferenceImages';
import { useSection } from '../src/store/sectionStore';
import { useStore } from '../src/store/useStore';

beforeEach(() => {
  r3fMock.scene = new THREE.Scene();
  r3fMock.gl = {
    localClippingEnabled: false,
    toneMapping: THREE.NoToneMapping,
    autoClear: true,
  };
  r3fMock.invalidate.mockClear();
  r3fMock.frameCallbacks = [];
  useSection.setState({ enabled: false, at: null, shownAt: null, cut: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Audit Item 5A — Viewport Rendering Modes', () => {
  describe('SectionCut: clipping-plane sync, normalization & restoration', () => {
    it('normalizes non-unit normals, scales constant, and rejects zero/NaN/Infinity inputs', () => {
      // Document Z-up (0, 2, 0) with offset 0.4 => unit (0, 1, 0), offset 0.2 => Three Y-up (0, 0, -1), constant -0.2
      const norm = normalizeSectionPlane([0, 2, 0], 0.4);
      expect(norm).not.toBeNull();
      expect(norm!.normal).toEqual([0, 1, 0]);
      expect(norm!.threeNormal[0]).toBeCloseTo(0);
      expect(norm!.threeNormal[1]).toBeCloseTo(0);
      expect(norm!.threeNormal[2]).toBeCloseTo(-1);
      expect(norm!.constant).toBeCloseTo(-0.2);

      // Diagonal non-unit normal
      const diag = normalizeSectionPlane([3, 4, 0], 5);
      expect(diag).not.toBeNull();
      expect(Math.hypot(...diag!.normal)).toBeCloseTo(1, 6);
      expect(Math.hypot(...diag!.threeNormal)).toBeCloseTo(1, 6);
      expect(diag!.constant).toBeCloseTo(-1, 6);

      // Degenerate & non-finite inputs
      expect(normalizeSectionPlane([0, 0, 0], 0)).toBeNull();
      expect(normalizeSectionPlane([NaN, 0, 1], 0)).toBeNull();
      expect(normalizeSectionPlane([0, 0, 1], Infinity)).toBeNull();
      expect(normalizeSectionPlane([0, 0, 1], NaN)).toBeNull();
    });

    it('attachClippingPlane and detachClippingPlane preserve other clipping planes on shared materials', () => {
      const mat = new THREE.MeshStandardMaterial();
      const otherPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
      const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5);
      mat.clippingPlanes = [otherPlane];

      expect(attachClippingPlane(mat, sectionPlane)).toBe(true);
      expect(mat.clippingPlanes).toEqual([otherPlane, sectionPlane]);
      // Duplicate attach is a no-op
      expect(attachClippingPlane(mat, sectionPlane)).toBe(false);
      expect(mat.clippingPlanes).toEqual([otherPlane, sectionPlane]);

      // Detach removes only sectionPlane and preserves otherPlane
      expect(detachClippingPlane(mat, sectionPlane)).toBe(true);
      expect(mat.clippingPlanes).toEqual([otherPlane]);

      // Detaching the last plane sets clippingPlanes back to null
      expect(detachClippingPlane(mat, otherPlane)).toBe(true);
      expect(mat.clippingPlanes).toBeNull();
      mat.dispose();
    });

    it('isSectionPart excludes meshes inside an overlay or background ancestor group', () => {
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'body_test';
      bodyGroup.userData = { nodeId: 'n1' };

      const overlayGroup = new THREE.Group();
      overlayGroup.userData = { isOverlay: true };
      const overlayMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      overlayGroup.add(overlayMesh);
      bodyGroup.add(overlayGroup);

      expect(isSectionPart(overlayMesh)).toBe(false);

      const bgGroup = new THREE.Group();
      bgGroup.userData = { isBackground: true };
      const bgMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      bgGroup.add(bgMesh);
      bodyGroup.add(bgGroup);

      expect(isSectionPart(bgMesh)).toBe(false);
    });

    it('restores prior gl.localClippingEnabled and cleans up detached materials on disable/unmount', () => {
      const scene = r3fMock.scene!;
      const gl = r3fMock.gl!;
      gl.localClippingEnabled = true; // Pre-existing caller enabled local clipping

      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'b1';
      const mat = new THREE.MeshStandardMaterial();
      const otherPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
      mat.clippingPlanes = [otherPlane];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
      bodyGroup.add(mesh);
      scene.add(bodyGroup);

      useSection.setState({
        enabled: true,
        cut: { normal: [0, 0, 2], offset: 0.2, parts: [] },
      });

      const { unmount } = render(React.createElement(SectionCut));

      // Run frame while cut is active
      expect(r3fMock.frameCallbacks.length).toBeGreaterThan(0);
      const tick = r3fMock.frameCallbacks[r3fMock.frameCallbacks.length - 1];
      tick({
        gl: gl as unknown as THREE.WebGLRenderer,
        scene,
        camera: new THREE.PerspectiveCamera(),
        invalidate: r3fMock.invalidate,
      });

      expect(gl.localClippingEnabled).toBe(true);
      expect(mat.clippingPlanes?.length).toBe(2);
      const attached = mat.clippingPlanes![1];
      expect(attached.normal.length()).toBeCloseTo(1, 6);
      expect(attached.constant).toBeCloseTo(-0.1, 6);

      // Remove mesh from scene before unmount to verify tracked-material cleanup
      scene.remove(bodyGroup);
      r3fMock.invalidate.mockClear();
      unmount();

      // Prior localClippingEnabled (true) is preserved, and detached material loses only sectionPlane
      expect(gl.localClippingEnabled).toBe(true);
      expect(mat.clippingPlanes).toEqual([otherPlane]);
      expect(r3fMock.invalidate).toHaveBeenCalled();

      mesh.geometry.dispose();
      mat.dispose();
    });
  });

  describe('PathTracedView: NaN guards, material parity & signature tracking', () => {
    it('sameSignature treats NaN and Infinity as changed rather than equal', () => {
      expect(sameSignature([1, 2, 3], [1, 2, 3], SCENE_TOLERANCE)).toBe(true);
      expect(sameSignature([1, NaN, 3], [1, 0, 3], SCENE_TOLERANCE)).toBe(false);
      expect(sameSignature([1, 0, 3], [1, NaN, 3], SCENE_TOLERANCE)).toBe(false);
      expect(sameSignature([1, NaN, 3], [1, NaN, 3], SCENE_TOLERANCE)).toBe(false);
      expect(sameSignature([1, Infinity, 3], [1, Infinity, 3], SCENE_TOLERANCE)).toBe(false);
    });

    it('collectBodies skips materials with NaN or non-positive opacity', () => {
      const scene = new THREE.Scene();
      const geo = new THREE.BoxGeometry(1, 1, 1);

      const okMat = new THREE.MeshStandardMaterial({ opacity: 0.5, transparent: true });
      const okMesh = new THREE.Mesh(geo, okMat);
      okMesh.castShadow = true;

      const nanMat = new THREE.MeshStandardMaterial({ opacity: Number.NaN, transparent: true });
      const nanMesh = new THREE.Mesh(geo, nanMat);
      nanMesh.castShadow = true;

      const zeroMat = new THREE.MeshStandardMaterial({ opacity: 0, transparent: true });
      const zeroMesh = new THREE.Mesh(geo, zeroMat);
      zeroMesh.castShadow = true;

      scene.add(okMesh, nanMesh, zeroMesh);

      const collected = collectBodies(scene);
      expect(collected).toEqual([okMesh]);

      geo.dispose();
      okMat.dispose();
      nanMat.dispose();
      zeroMat.dispose();
    });

    it('tracedMaterial clamps NaN/negative glow and out-of-range opacity without mutating live material', () => {
      const owned: THREE.Material[] = [];

      const badGlow = new THREE.MeshStandardMaterial({
        emissive: new THREE.Color('#ff0000'),
        emissiveIntensity: 1,
      });
      badGlow.userData = { glow: Number.NaN };
      const tracedGlow = tracedMaterial(badGlow, owned);
      expect(tracedGlow).not.toBe(badGlow);
      expect(tracedGlow.emissiveIntensity).toBe(0);
      expect(badGlow.emissiveIntensity).toBe(1);

      const translucent = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#224488'),
        transparent: true,
        opacity: 0.25,
        roughness: 0.5,
      });
      const tracedClear = tracedMaterial(translucent, owned) as THREE.MeshStandardMaterial & {
        transmission?: number;
        ior?: number;
      };
      expect(tracedClear.transmission).toBeCloseTo(0.75);
      expect(tracedClear.transparent).toBe(false);
      expect(tracedClear.opacity).toBe(1);
      expect(tracedClear.roughness).toBeCloseTo(0.05);
      expect(translucent.transparent).toBe(true);
      expect(translucent.opacity).toBe(0.25);

      for (const m of owned) m.dispose();
      badGlow.dispose();
      translucent.dispose();
    });

    it('sceneSignature detects vertexColors toggles', () => {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.updateMatrixWorld();

      const sigA = sceneSignature([mesh]);
      mat.vertexColors = true;
      const sigB = sceneSignature([mesh]);

      expect(sameSignature(sigA, sigB, SCENE_TOLERANCE)).toBe(false);

      geo.dispose();
      mat.dispose();
    });
  });

  describe('BodyToneMapping: negative HDR channel guard', () => {
    it('clamps negative RGB channels to zero before Khronos PBR Neutral offset math', () => {
      expect(BODY_TONE_MAPPING_FRAGMENT_SHADER).toContain('color = max(color, vec3(0.0));');
      expect(BODY_TONE_MAPPING_FRAGMENT_SHADER).toContain('depth < 1.0 ? pbrNeutral(inputColor.rgb) : inputColor.rgb');
    });
  });

  describe('StudioBackdrop: React StrictMode safety & background restoration', () => {
    it('creates a fresh texture under StrictMode and never leaves a disposed texture on scene.background', () => {
      const scene = r3fMock.scene!;
      const prevBg = new THREE.Color('#123456');
      scene.background = prevBg;

      const disposedTextures = new Set<THREE.Texture>();
      const origDispose = THREE.Texture.prototype.dispose;
      vi.spyOn(THREE.Texture.prototype, 'dispose').mockImplementation(function (this: THREE.Texture) {
        disposedTextures.add(this);
        origDispose.call(this);
      });

      // Mock 2D canvas context so CanvasTexture is constructed in jsdom
      const fakeGradient = { addColorStop: vi.fn() };
      const fakeCtx = {
        createLinearGradient: vi.fn(() => fakeGradient),
        createRadialGradient: vi.fn(() => fakeGradient),
        fillRect: vi.fn(),
        fillStyle: '',
        globalAlpha: 1,
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        fakeCtx as unknown as CanvasRenderingContext2D,
      );

      const { unmount } = render(
        React.createElement(StrictMode, null, React.createElement(StudioBackdrop, { darkMode: false })),
      );

      // Active background must be a live, undisposed CanvasTexture
      expect(scene.background).toBeInstanceOf(THREE.CanvasTexture);
      expect(disposedTextures.has(scene.background as THREE.Texture)).toBe(false);
      // StrictMode's first-pass texture was disposed cleanly
      expect(disposedTextures.size).toBe(1);

      const activeTex = scene.background as THREE.Texture;
      unmount();

      // Unmount disposes the active texture and restores prevBg
      expect(disposedTextures.has(activeTex)).toBe(true);
      expect(scene.background).toBe(prevBg);
    });

    it('does not overwrite scene.background on unmount if another component replaced it', () => {
      const scene = r3fMock.scene!;
      const { unmount } = render(React.createElement(StudioBackdrop, { darkMode: true }));

      const replacement = new THREE.Color('#abcdef');
      scene.background = replacement;

      unmount();
      expect(scene.background).toBe(replacement);
    });
  });

  describe('WaterSurface: finite bounds & meniscus cap alignment', () => {
    it('rejects basins with NaN or Infinity bounds and aligns capZ to floorZ + depthZ', () => {
      expect(
        computeWaterBasinMeshParams({
          minX: NaN, maxX: 1, minY: 0, maxY: 1, floorZ: 0, surfaceZ: 0.5,
        }),
      ).toBeNull();
      expect(
        computeWaterBasinMeshParams({
          minX: 0, maxX: Infinity, minY: 0, maxY: 1, floorZ: 0, surfaceZ: 0.5,
        }),
      ).toBeNull();

      // Shallow / inverted surfaceZ < floorZ clamps depthZ to 0.002 and aligns capZ with volume top
      const shallow = computeWaterBasinMeshParams({
        minX: -0.1, maxX: 0.1, minY: -0.1, maxY: 0.1, floorZ: 0.05, surfaceZ: 0.049,
      });
      expect(shallow).not.toBeNull();
      expect(shallow!.depthZ).toBeCloseTo(0.002);
      expect(shallow!.cz).toBeCloseTo(0.051);
      expect(shallow!.capZ).toBeCloseTo(0.052);
    });
  });

  describe('ReferenceImages: transform NaN guards & stale async load cancellation', () => {
    it('rejects invalid pos/width/aspect and clamps opacity to [0, 1]', () => {
      expect(resolveReferenceTransform({ pos: [NaN, 0, 0], width: 1, aspect: 1, opacity: 0.5 })).toBeNull();
      expect(resolveReferenceTransform({ pos: [0, 0, 0], width: 0, aspect: 1, opacity: 0.5 })).toBeNull();
      expect(resolveReferenceTransform({ pos: [0, 0, 0], width: 1, aspect: 0, opacity: 0.5 })).toBeNull();
      expect(resolveReferenceTransform({ pos: [0, 0, 0], width: 1, aspect: -2, opacity: 0.5 })).toBeNull();

      const ok = resolveReferenceTransform({ pos: [0.1, 0.2, 0.3], width: 0.4, aspect: 2, opacity: 1.8 });
      expect(ok).toEqual({
        position: [0.1, 0.2, 0.3],
        scale: [0.4, 0.2, 1],
        opacity: 1,
      });

      const nanOpacity = resolveReferenceTransform({ pos: [0, 0, 0], width: 1, aspect: 1, opacity: Number.NaN });
      expect(nanOpacity?.opacity).toBe(0.5);
    });

    it('cancels stale async TextureLoader completions after unmount and invalidates on active load', () => {
      const pendingCallbacks: Array<{
        tex: THREE.Texture;
        onLoad?: (t: THREE.Texture) => void;
      }> = [];

      vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(
        (_url: string, onLoad?: (t: THREE.Texture) => void) => {
          const tex = new THREE.Texture();
          vi.spyOn(tex, 'dispose');
          pendingCallbacks.push({ tex, onLoad });
          return tex;
        },
      );

      useStore.setState((s) => ({
        sceneGraph: {
          ...s.sceneGraph,
          referenceImages: [
            {
              id: 'ref1',
              name: 'Front',
              src: 'data:image/png;base64,AAA',
              aspect: 1.5,
              plane: 'front',
              pos: [0, 0, 0.1],
              width: 0.3,
              opacity: 0.6,
              overlay: true,
            },
          ],
        },
      }));

      const { unmount } = render(React.createElement(ReferenceImages));
      expect(pendingCallbacks.length).toBe(1);

      // Unmount before async texture load finishes
      unmount();
      r3fMock.invalidate.mockClear();

      // Stale onLoad fires after unmount: must dispose texture and NOT invalidate
      act(() => {
        pendingCallbacks[0].onLoad?.(pendingCallbacks[0].tex);
      });
      expect(pendingCallbacks[0].tex.dispose).toHaveBeenCalled();
      expect(r3fMock.invalidate).not.toHaveBeenCalled();

      // Mount again and let active onLoad finish: must set SRGBColorSpace and invalidate
      const mounted = render(React.createElement(ReferenceImages));
      expect(pendingCallbacks.length).toBe(2);
      r3fMock.invalidate.mockClear();

      act(() => {
        pendingCallbacks[1].onLoad?.(pendingCallbacks[1].tex);
      });
      expect(pendingCallbacks[1].tex.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(r3fMock.invalidate).toHaveBeenCalled();

      mounted.unmount();
    });
  });
});
