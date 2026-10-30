// ---------------------------------------------------------------------------
// The store's parametric shapes: wedge, pyramid, cone, torus, tube, curve,
// pulley, rope, gear teeth and pusher pegs
//
// Each regenerates the shape's mesh from its parameters and rebuilds.
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom } from '../types/scene';
import { generateGearGeoms } from '../presets/presetScenes';
import {
  generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData,
  generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS,
  DEFAULT_CURVE_SEGMENTS,
} from '../utils/geom';
import { cloneSceneGraph } from './sceneClone';
import type { SliceDeps } from './sliceDeps';

export interface ShapeParamActions {
  updateWedgeParams: (id: string, params: { width?: number; depth?: number; height?: number; wedgeAngle?: number }) => void;
  updatePyramidParams: (id: string, params: { width?: number; depth?: number; height?: number }) => void;
  updateConeParams: (id: string, params: { radius?: number; height?: number }) => void;
  updateTorusParams: (id: string, params: { majorRadius?: number; tubeRadius?: number }) => void;
  updateTubeParams: (id: string, params: { innerRadius?: number; outerRadius?: number; height?: number }) => void;
  updateCurveParams: (id: string, params: { points?: number[][]; width?: number; thickness?: number; segments?: number; closed?: boolean; bank?: number }) => void;
  updatePulleyParams: (id: string, params: { leftTargetId?: string; rightTargetId?: string; pulleyRadius?: number }) => void;
  updateRopeParams: (id: string, params: { pulleyWheelId?: string; leftTargetId?: string; rightTargetId?: string; leftStrands?: number; rightStrands?: number }) => void;
  updateNodeComposite: (id: string, params: Partial<SceneNode>) => void;
  updateGearTeeth: (id: string, teeth: number) => void;
  addPusherPeg: (gearId: string) => void;
  deletePusherPeg: (gearId: string) => void;
  updatePusherPeg: (gearId: string, updates: { offset?: number, size?: [number, number] }) => void;
}

export function shapeParamActions({ get }: SliceDeps): ShapeParamActions {
  return {
    updateWedgeParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.width !== undefined) {
              node.width = params.width;
              // Recalculate wedgeAngle
              const h = node.height || 0.5;
              node.wedgeAngle = Math.atan(h / node.width) * 180 / Math.PI;
            }
            if (params.height !== undefined) {
              node.height = params.height;
              // Recalculate wedgeAngle
              const w = node.width || 2.0;
              node.wedgeAngle = Math.atan(node.height / w) * 180 / Math.PI;
            }
            if (params.depth !== undefined) {
              node.depth = params.depth;
            }
            if (params.wedgeAngle !== undefined) {
              node.wedgeAngle = params.wedgeAngle;
              // Recalculate height
              const w = node.width || 2.0;
              node.height = w * Math.tan(node.wedgeAngle * Math.PI / 180);
            }
          
            // Update first geom size
            if (node.geoms && node.geoms.length > 0) {
              const w = node.width || 2.0;
              const h = node.height || 0.5;
              const L = Math.sqrt(w * w + h * h);
              const d = node.depth || 1.0;
              node.geoms[0].size = [L / 2, d / 2, 0.025];
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updatePyramidParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.width !== undefined) node.width = params.width;
            if (params.depth !== undefined) node.depth = params.depth;
            if (params.height !== undefined) node.height = params.height;
          
            if (node.geoms && node.geoms.length > 0) {
              const w = node.width || 0.5;
              const d = node.depth || 0.5;
              const h = node.height || 0.5;
              const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
              node.geoms[0].vertices = vertices;
              node.geoms[0].faces = faces;
              node.geoms[0].renderVertices = renderVertices;
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updateConeParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.radius !== undefined) node.radius = params.radius;
            if (params.height !== undefined) node.height = params.height;
          
            if (node.geoms && node.geoms.length > 0) {
              const r = node.radius || 0.3;
              const h = node.height || 0.6;
              const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
              node.geoms[0].vertices = vertices;
              node.geoms[0].faces = faces;
              node.geoms[0].renderVertices = renderVertices;
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updateTorusParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.majorRadius !== undefined) node.majorRadius = params.majorRadius;
            if (params.tubeRadius !== undefined) node.tubeRadius = params.tubeRadius;
          
            if (node.geoms && node.geoms.length > 0) {
              const R = node.majorRadius || 0.4;
              const r = node.tubeRadius || 0.1;
              const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
              node.geoms[0].vertices = vertices;
              node.geoms[0].faces = faces;
              node.geoms[0].renderVertices = renderVertices;
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updateTubeParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.innerRadius !== undefined) node.innerRadius = params.innerRadius;
            if (params.outerRadius !== undefined) node.outerRadius = params.outerRadius;
            if (params.height !== undefined) node.height = params.height;
          
            if (node.geoms && node.geoms.length > 0) {
              const r1 = node.innerRadius || 0.2;
              const r2 = node.outerRadius || 0.3;
              const h = node.height || 0.5;
              const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
              node.geoms[0].vertices = vertices;
              node.geoms[0].faces = faces;
              node.geoms[0].renderVertices = renderVertices;
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updateCurveParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.points !== undefined) node.curvePoints = params.points.map((p: number[]) => [...p]);
            if (params.width !== undefined) node.curveWidth = params.width;
            if (params.thickness !== undefined) node.curveThickness = params.thickness;
            if (params.segments !== undefined) node.curveSegments = Math.round(params.segments);
            if (params.closed !== undefined) node.curveClosed = params.closed;
            if (params.bank !== undefined) node.curveBank = params.bank;

            const rgba = node.geoms?.[0]?.rgba || [0.85, 0.45, 0.15, 1];
            node.geoms = generateCurveGeoms(
              node.id,
              node.curvePoints || DEFAULT_CURVE_POINTS,
              node.curveWidth || DEFAULT_CURVE_WIDTH,
              node.curveThickness || DEFAULT_CURVE_THICKNESS,
              node.curveSegments || DEFAULT_CURVE_SEGMENTS,
              rgba,
              node.curveClosed === true,
              node.curveBank || 0
            );
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updatePulleyParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
            if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
            if (params.pulleyRadius !== undefined) {
              node.pulleyRadius = params.pulleyRadius;
              if (node.geoms && node.geoms.length === 3) {
                node.geoms[0].size[0] = params.pulleyRadius * 0.8;
                node.geoms[1].size[0] = params.pulleyRadius;
                node.geoms[2].size[0] = params.pulleyRadius;
              } else if (node.geoms && node.geoms.length > 0) {
                node.geoms[0].size[0] = params.pulleyRadius;
              }
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene);
    },

    updateRopeParams: (id, params) => {
      get().recordInteraction('node-params');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            if (params.pulleyWheelId !== undefined) node.pulleyWheelId = params.pulleyWheelId;
            if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
            if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
            if (params.leftStrands !== undefined) node.leftStrands = params.leftStrands;
            if (params.rightStrands !== undefined) node.rightStrands = params.rightStrands;
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      get().recompile(newScene, get().selectedNodeId);
    },

    updateNodeComposite: (id, params) => {
      get().recordInteraction('node-composite');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const findAndMutate = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const n of nodes) {
          if (n.id === id) {
            Object.assign(n, params);
            return true;
          }
          if (n.children && findAndMutate(n.children)) return true;
        }
        return false;
      };
      findAndMutate(newScene.nodes);
      get().recompile(newScene, id, false, true);
    },

    updateGearTeeth: (id, teeth) => {
      get().recordInteraction('gear-teeth');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id && node.geoms?.length > 0) {
            const centerGeom = node.geoms[0];
            const radius = centerGeom.size[0];
            const color = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
            const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
            const isSecondGear = gearNum % 2 === 0;
            const contype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
            const conaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
          
            node.geoms = generateGearGeoms(id, radius, teeth, color, isSecondGear, contype, conaffinity);
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        get().recompile(newScene, id);
      }
    },

    addPusherPeg: (gearId) => {
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === gearId && node.geoms?.length > 0) {
            const hasPeg = node.geoms.some((g: SceneGeom) => g.name.includes('peg'));
            if (!hasPeg) {
              const radius = node.geoms[0].size[0];
              node.geoms.push({
                name: `${gearId}_pusher_peg`,
                type: 'cylinder',
                size: [0.03, 0.08], // radius, half-height
                pos: [radius * 0.8, 0, 0.09], // relative offset
                rgba: [0.9, 0.2, 0.2, 1], // red color
                mass: 0.05,
                condim: 3
              });
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        get().recompile(newScene, gearId);
      }
    },

    deletePusherPeg: (gearId) => {
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === gearId && node.geoms?.length > 1) {
            node.geoms = node.geoms.filter((g: SceneGeom) => !g.name.includes('peg'));
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        get().recompile(newScene, gearId);
      }
    },

    updatePusherPeg: (gearId, updates) => {
      get().recordInteraction('pusher-peg');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === gearId && node.geoms?.length > 1) {
            const peg = node.geoms.find((g: SceneGeom) => g.name.includes('peg'));
            // generateGearGeoms always places the peg, so `pos` is there.
            if (peg && peg.pos) {
              if (updates.offset !== undefined) {
                peg.pos = [updates.offset, 0, peg.pos[2]];
              }
              if (updates.size !== undefined) {
                peg.size = updates.size; // [radius, half_height]
                peg.pos = [peg.pos[0], 0, updates.size[1] + 0.01]; // adjust Z pos dynamically so bottom touches the disc
              }
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        get().recompile(newScene, gearId);
      }
    },
  };
}
