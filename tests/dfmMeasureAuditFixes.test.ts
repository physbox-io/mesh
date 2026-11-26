import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { analyseDfm, narrowestAirGap, PRINT_MIN_AIR_GAP_MM } from '../src/utils/dfm';
import { dfmCommands } from '../src/hooks/mcp/dfmCommands';
import { useStore } from '../src/store/useStore';
import { hardwareCutGeoms } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { measureInScene, toThree } from '../src/utils/measureScene';
import type { SceneGraph, SceneNode } from '../src/types/scene';

function makeBoxNode(
  id: string,
  pos: [number, number, number],
  halfSize: [number, number, number],
): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos,
    quat: [1, 0, 0, 0],
    geoms: [{
      name: `${id}_box`,
      type: 'box',
      size: halfSize,
      pos: [0, 0, 0],
      rgba: [0.6, 0.65, 0.72, 1],
    }],
    joints: [],
    children: [],
  };
}

function attachHardwareCut(
  node: SceneNode,
  spec: Parameters<typeof hardwareCutGeoms>[0],
): void {
  const pieces = hardwareCutGeoms(spec, node.id, node);
  expect(pieces.length).toBeGreaterThan(0);
  for (const piece of pieces) {
    node.geoms.push(piece);
    const derived = cutGeometry(node, piece);
    expect(derived).not.toBeNull();
    Object.assign(piece, derived);
  }
  node.csgEnabled = true;
}

function extrudeXZPolygon(poly: [number, number][], depthY: number): { verts: number[]; faces: number[] } {
  const n = poly.length;
  const hy = depthY / 2;
  const verts: number[] = [];
  const faces: number[] = [];
  for (const [x, z] of poly) verts.push(x, -hy, z);
  for (const [x, z] of poly) verts.push(x, hy, z);
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [a, b, c] of tris) {
    faces.push(a, b, c);
    faces.push(n + a, n + c, n + b);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const f0 = i, f1 = j, b0 = n + i, b1 = n + j;
    faces.push(f0, b0, b1, f0, b1, f1);
  }
  return { verts, faces };
}

function meshToFlatTris(mesh: { verts: number[]; faces: number[] }): Float64Array {
  const out = new Float64Array(mesh.faces.length * 3);
  for (let i = 0; i < mesh.faces.length; i++) {
    const vi = mesh.faces[i] * 3;
    out[i * 3] = mesh.verts[vi];
    out[i * 3 + 1] = mesh.verts[vi + 1];
    out[i * 3 + 2] = mesh.verts[vi + 2];
  }
  return out;
}

describe('DFM & Measure audit fixes', () => {
  beforeEach(() => {
    useStore.setState({
      sceneGraph: { nodes: [] },
      selectedNodeId: null,
    });
  });

  describe('CHECK_DFM with master_id sees mating parts for O-ring seal check', () => {
    function buildVesselAndLid(includeLid: boolean): SceneGraph {
      const vessel = makeBoxNode('vessel', [0, 0, 0.01], [0.03, 0.03, 0.01]);
      attachHardwareCut(vessel, {
        group: 'oring1',
        kind: 'oring',
        size: '20×2',
        seal: 'face',
        at: [0, 0, 0.01],
        normal: [0, 0, 1],
      });
      if (!includeLid) return { nodes: [vessel] };
      const lid = makeBoxNode('lid', [0, 0, 0.024], [0.03, 0.03, 0.004]);
      return { nodes: [vessel, lid] };
    }

    it('does not flag "nothing presses on it" when master_id scopes to vessel with flush lid in scene', async () => {
      const fullScene = buildVesselAndLid(true);
      useStore.setState({ sceneGraph: fullScene });

      const res = await dfmCommands.CHECK_DFM(
        { masterId: 'vessel', process: 'print' },
        { store: useStore.getState() },
      );
      expect(res.ok).toBe(true);
      const findings = (res.findings as Array<{ id: string; title: string }>) ?? [];
      expect(findings.find((f) => f.title.includes('nothing presses on it'))).toBeUndefined();
    });

    it('still flags "nothing presses on it" when the lid is genuinely absent from the scene', async () => {
      const openScene = buildVesselAndLid(false);
      useStore.setState({ sceneGraph: openScene });

      const res = await dfmCommands.CHECK_DFM(
        { masterId: 'vessel', process: 'print' },
        { store: useStore.getState() },
      );
      expect(res.ok).toBe(true);
      const findings = (res.findings as Array<{ id: string; title: string }>) ?? [];
      expect(findings.find((f) => f.title.includes('nothing presses on it'))).toBeDefined();
    });

    it('analyseDfm with wholeScene keeps findings scoped to subject while resolving mating bodies', () => {
      const fullScene = buildVesselAndLid(true);
      attachHardwareCut(fullScene.nodes[1], {
        group: 'lid_oring1',
        kind: 'oring',
        size: '20×2',
        seal: 'face',
        at: [0, 0, 0.004],
        normal: [0, 0, 1],
      });
      const vesselOnly: SceneGraph = { nodes: [fullScene.nodes[0]] };
      const report = analyseDfm(vesselOnly, 'print', { checkAllAsPlate: true }, fullScene);
      expect(report.findings.find((f) => f.id.includes('lid_oring1'))).toBeUndefined();
      expect(report.findings.find((f) => f.title.includes('nothing presses on it'))).toBeUndefined();
    });
  });

  describe('print_narrow_gap ignores monolithic concave seams while keeping real gaps', () => {
    it('does not flag a 0.03 mm concave boot-to-pedestal crease at z = 0.3 mm on a large monolithic solid', () => {
      const bootPedestalPoly: [number, number][] = [
        [-0.057, 0.000],
        [0.057, 0.000],
        [0.057, 0.0003],
        [0.025, 0.0003],
        [0.0254, 0.00033],
        [0.0265, 0.00034],
        [0.032, 0.004],
        [0.022, 0.184],
        [-0.022, 0.184],
        [-0.032, 0.004],
        [-0.0265, 0.00034],
        [-0.0254, 0.00033],
        [-0.025, 0.0003],
        [-0.057, 0.0003],
      ];
      const mesh = extrudeXZPolygon(bootPedestalPoly, 0.108);
      const tris = meshToFlatTris(mesh);
      expect(narrowestAirGap(tris, PRINT_MIN_AIR_GAP_MM)).toBeNull();

      const node: SceneNode = {
        id: 'monolith_sculpt',
        name: 'monolith_sculpt',
        type: 'body',
        pos: [0, 0, 0],
        quat: [1, 0, 0, 0],
        isSculpt: true,
        geoms: [{
          name: 'monolith_mesh',
          type: 'mesh',
          size: [1],
          vertices: mesh.verts,
          renderVertices: mesh.verts,
          faces: mesh.faces,
          dynamic: true,
        }],
        joints: [],
        children: [],
      };
      const report = analyseDfm({ nodes: [node] }, 'print', { asPlaced: true });
      expect(report.findings.find((f) => f.id === 'print_narrow_gap')).toBeUndefined();
    });

    it('still flags a genuine single-body 0.15 mm parallel-wall U-slot as critical print_narrow_gap', () => {
      const uSlotPoly: [number, number][] = [
        [-0.006075, 0.000],
        [0.006075, 0.000],
        [0.006075, 0.020],
        [0.000075, 0.020],
        [0.000075, 0.004],
        [-0.000075, 0.004],
        [-0.000075, 0.020],
        [-0.006075, 0.020],
      ];
      const uMesh = extrudeXZPolygon(uSlotPoly, 0.015);
      const gap = narrowestAirGap(meshToFlatTris(uMesh), PRINT_MIN_AIR_GAP_MM);
      expect(gap).not.toBeNull();
      expect(gap!.mm).toBeCloseTo(0.15, 1);
    });

    it('still flags two separate bodies with a 0.10 mm air gap as critical print_narrow_gap', () => {
      const a = makeBoxNode('plate_a', [0, 0, 0.005], [0.015, 0.015, 0.005]);
      const b = makeBoxNode('plate_b', [0, 0, 0.0151], [0.015, 0.015, 0.005]);
      const report = analyseDfm({ nodes: [a, b] }, 'print', { checkAllAsPlate: true });
      const gapFinding = report.findings.find((f) => f.id === 'print_narrow_gap');
      expect(gapFinding).toBeDefined();
      expect(gapFinding!.severity).toBe('critical');
    });
  });

  describe('measureInScene reports snapped=true when feature matched with movedByMm === 0', () => {
    it('sets snapped: true for exact feature coordinates (movedByMm === 0) and false when unmatched/disabled', () => {
      const root = new THREE.Scene();
      const group = new THREE.Group();
      group.name = 'block1';
      const p = toThree([0.01, 0.01, 0.01]);
      group.position.set(p[0], p[1], p[2]);
      group.add(new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.02, 0.02),
        new THREE.MeshStandardMaterial(),
      ));
      root.add(group);
      root.updateMatrixWorld(true);

      const exact = measureInScene(root, [0, 0, 0], [0.02, 0.02, 0.02], { withinMm: 3 });
      expect(exact.from.movedByMm).toBe(0);
      expect(exact.to.movedByMm).toBe(0);
      expect(exact.from.snappedTo).toContain('block1');
      expect(exact.snapped).toBe(true);

      const missed = measureInScene(root, [1, 1, 1], [2, 2, 2], { withinMm: 3 });
      expect(missed.snapped).toBe(false);

      const disabled = measureInScene(root, [0, 0, 0], [0.02, 0.02, 0.02], { snap: false });
      expect(disabled.snapped).toBe(false);
    });
  });

  describe('cast_undercut fix text mentions concrete and Jesmonite', () => {
    it('includes concrete and Jesmonite in cast_undercut fix text for cast_material="concrete"', () => {
      const spoolPoly: [number, number][] = [
        [-0.025, 0.000],
        [0.025, 0.000],
        [0.025, 0.008],
        [0.010, 0.015],
        [0.025, 0.022],
        [0.025, 0.030],
        [-0.025, 0.030],
        [-0.025, 0.022],
        [-0.010, 0.015],
        [-0.025, 0.008],
      ];
      const mesh = extrudeXZPolygon(spoolPoly, 0.030);
      const node: SceneNode = {
        id: 'undercut_block',
        name: 'undercut_block',
        type: 'body',
        pos: [0, 0, 0],
        quat: [1, 0, 0, 0],
        geoms: [{
          name: 'undercut_mesh',
          type: 'mesh',
          size: [1],
          vertices: mesh.verts,
          renderVertices: mesh.verts,
          faces: mesh.faces,
          dynamic: true,
        }],
        joints: [],
        children: [],
      };
      const report = analyseDfm({ nodes: [node] }, 'cast', { castMaterial: 'concrete', asPlaced: true });
      const undercut = report.findings.find((f) => f.id === 'cast_undercut');
      expect(undercut).toBeDefined();
      expect(undercut!.fix.toLowerCase()).toContain('concrete');
      expect(undercut!.fix.toLowerCase()).toContain('jesmonite');
      expect(undercut!.fix.toLowerCase()).toContain('resin');
      expect(undercut!.fix.toLowerCase()).toContain('plaster');
    });
  });
});
