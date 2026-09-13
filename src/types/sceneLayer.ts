/**
 * Types for what the scene layer reads out of the physics store.
 *
 * `mujoco`, `model` and `data` in the store are plain-JS mirrors of the worker's
 * MuJoCo objects (see MUJOCO_SHIM, buildModelMirror and buildDataMirror in
 * src/store/useStore.ts). These interfaces name the fields the renderers read.
 */
import type { SceneGeom } from './scene';

export interface MujocoObjType { value: string }

/** The subset of the MuJoCo API the main thread still calls, as the shim provides it. */
export interface MujocoShim {
  mjtObj: {
    mjOBJ_BODY: MujocoObjType;
    mjOBJ_JOINT: MujocoObjType;
    mjOBJ_GEOM: MujocoObjType;
    mjOBJ_ACTUATOR: MujocoObjType;
  };
  mj_name2id: (model: ModelMirror, typeVal: string, name: string) => number;
  mj_id2name: (model: ModelMirror, typeVal: string, id: number) => string | null;
}

/** The compiled model's sizes and per-geom/body constants. */
export interface ModelMirror {
  nq: number; nv: number; nu: number; ngeom: number; nbody: number;
  opt: { timestep?: number };
  geom_size: ArrayLike<number>;
  geom_type?: ArrayLike<number>;
  geom_rgba?: number[];
  body_mass?: ArrayLike<number>;
  body_inertia?: ArrayLike<number>;
  body_dofnum?: ArrayLike<number>;
  body_parentid?: ArrayLike<number>;
  jnt_qposadr?: ArrayLike<number>;
  jnt_dofadr?: ArrayLike<number>;
}

/** The per-frame state, mutated in place by the worker's FRAME messages. */
export interface DataMirror {
  time?: number;
  qpos: Float64Array; qvel: Float64Array; ctrl: Float64Array;
  xfrc_applied: Float64Array; qfrc_applied: Float64Array;
  xpos: Float64Array; xmat: Float64Array; cvel: Float64Array;
  geom_xpos: Float64Array; geom_xmat: Float64Array;
}

/** The test hook that freezes per-frame updates. */
export type FrameFlagWindow = Window & { DISABLE_USEFRAME?: boolean };

/** A geom as SceneVisuals lists it for drawing: the geom plus which body owns it. */
export type RenderGeom = SceneGeom & {
  nodeId: string;
  staticBody: boolean;
  customRender: boolean;
};
