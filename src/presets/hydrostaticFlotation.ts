import type { SceneGraph, SceneNode } from '../types/scene';
import { balanceBody } from '../utils/balancePart';

/**
 * True Waterline Hydrostatics & Inverse Auto-Float ("Make It Float") Showcase:
 * Set in a 145 mm freshwater test tank (`environment.waterLevel = 0.145`):
 *   1. Unbalanced Red Buoy (left): top-heavy mast + lantern (`CoM` above `CoB`) -> capsizes!
 *      (Select it -> Physics -> Stand / Spin / Float -> Float -> Balance Part to fix it!)
 *   2. Auto-Balanced Green Channel Buoy (center-left): identical outer silhouette processed
 *      through `balanceBody(..., 'float')` (seats bought-in steel hex-nut ballast deep in the
 *      keel) -> snaps upright from a 45° knockdown heel and holds its beacon dry above water!
 *   3. Open-Hull Cedar Skiff (center-right): floats high on displaced interior hull air.
 *   4. Porcelain Cup + Brass Rim Weight (right): 2350 kg/m³ ceramic floats upright on its
 *      trapped air pocket until the brass weight tips its rim underwater, flooding & sinking it!
 */
export const hydrostaticFlotationPreset: SceneGraph = (() => {
  const WATER_Z = 0.145;

  const makeRawChannelBuoy = (
    id: string,
    name: string,
    x: number,
    hullRgba: [number, number, number, number],
  ): SceneNode => ({
    id,
    name,
    type: 'body',
    pos: [x, 0, WATER_Z - 0.012],
    density: 380,
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [
      // Buoyant closed-cell foam float + deep lower keel skirt (~640 cm³ displacement)
      {
        name: `${id}_hull`,
        type: 'cylinder',
        size: [0.042, 0.044],
        pos: [0, 0, 0.004],
        density: 360,
        rgba: hullRgba,
      },
      {
        name: `${id}_keel_skirt`,
        type: 'cylinder',
        size: [0.026, 0.018],
        pos: [0, 0, -0.048],
        density: 380,
        rgba: [0.22, 0.25, 0.30, 1],
      },
      // Crisp white daymark band
      {
        name: `${id}_collar`,
        type: 'cylinder',
        size: [0.043, 0.006],
        pos: [0, 0, 0.028],
        rgba: [0.95, 0.96, 0.98, 1],
        role: 'visual',
      },
      // Tall mast + heavy top lantern head (pulls CoM high above CoB so raw buoy capsizes!)
      {
        name: `${id}_mast`,
        type: 'cylinder',
        size: [0.009, 0.036],
        pos: [0, 0, 0.082],
        density: 1100,
        rgba: [0.88, 0.90, 0.94, 1],
      },
      {
        name: `${id}_lantern`,
        type: 'cylinder',
        size: [0.019, 0.015],
        pos: [0, 0, 0.128],
        density: 1650,
        rgba: [0.98, 0.78, 0.18, 1],
      },
    ],
    children: [],
  });

  // 1. Unbalanced top-heavy red buoy (tilted 20° -> capsizes upside-down on Run!)
  const unbalancedBuoy: SceneNode = {
    ...makeRawChannelBuoy('unbalanced_buoy', 'Unbalanced Red Buoy (Capsizes)', -0.185, [0.86, 0.24, 0.22, 1]),
    euler: [20, 0, 0],
  };

  // 2. Identical silhouette solved by `balanceBody(..., 'float')`, knocked over to 45° so it self-rights!
  const balancedRaw = balanceBody(
    makeRawChannelBuoy('balanced_spar_buoy', 'Auto-Balanced Buoy (Self-Righting)', -0.062, [0.14, 0.68, 0.46, 1]),
    'float',
    { waterLevel: WATER_Z, minWallMm: 2.6 },
  ).node;
  const balancedBuoy: SceneNode = {
    ...balancedRaw,
    euler: [45, 0, 0],
  };

  // 3. Open-Hull Cedar Skiff (5-plank open vessel: solidity < 0.88 -> displaces interior air until swamped!)
  const openHullSkiff: SceneNode = {
    id: 'open_hull_skiff',
    name: 'Open-Hull Cedar Skiff',
    type: 'body',
    pos: [0.068, 0, WATER_Z + 0.005],
    euler: [0, 14, 0],
    deformMaterial: 'softwood',
    density: 540,
    joints: [{ name: 'skiff_free', type: 'free' }],
    geoms: [
      { name: 'skiff_sole', type: 'box', size: [0.036, 0.068, 0.004], pos: [0, 0, -0.018], density: 620, rgba: [0.72, 0.48, 0.28, 1] },
      { name: 'skiff_keel', type: 'box', size: [0.004, 0.060, 0.005], pos: [0, 0, -0.025], density: 4200, rgba: [0.32, 0.35, 0.40, 1] },
      { name: 'skiff_port', type: 'box', size: [0.004, 0.068, 0.018], pos: [-0.034, 0, 0.002], density: 500, rgba: [0.80, 0.56, 0.34, 1] },
      { name: 'skiff_stbd', type: 'box', size: [0.004, 0.068, 0.018], pos: [0.034, 0, 0.002], density: 500, rgba: [0.80, 0.56, 0.34, 1] },
      { name: 'skiff_bow', type: 'box', size: [0.030, 0.004, 0.018], pos: [0, 0.064, 0.002], density: 500, rgba: [0.76, 0.52, 0.30, 1] },
      { name: 'skiff_stern', type: 'box', size: [0.030, 0.004, 0.018], pos: [0, -0.064, 0.002], density: 500, rgba: [0.76, 0.52, 0.30, 1] },
      { name: 'skiff_thwart', type: 'box', size: [0.030, 0.011, 0.0025], pos: [0, 0, 0.006], rgba: [0.86, 0.65, 0.40, 1], role: 'visual' },
    ],
    children: [],
  };

  // 4. Open Glazed Porcelain Cup (`rho = 2350 kg/m³` > freshwater! Floats upright on trapped air,
  //    then floods over the rim & sinks when the brass weight drops into its front corner!)
  const floodingCup: SceneNode = {
    id: 'flooding_porcelain_cup',
    name: 'Porcelain Cup (Floods When Rim Dips)',
    type: 'body',
    pos: [0.195, 0, WATER_Z + 0.002],
    deformMaterial: 'ceramic',
    density: 2350,
    joints: [{ name: 'cup_free', type: 'free' }],
    geoms: [
      { name: 'cup_base', type: 'box', size: [0.034, 0.034, 0.004], pos: [0, 0, -0.024], density: 2350, rgba: [0.93, 0.95, 0.98, 1] },
      { name: 'cup_wall_w', type: 'box', size: [0.0035, 0.034, 0.024], pos: [-0.0305, 0, 0.002], density: 2350, rgba: [0.93, 0.95, 0.98, 1] },
      { name: 'cup_wall_e', type: 'box', size: [0.0035, 0.034, 0.024], pos: [0.0305, 0, 0.002], density: 2350, rgba: [0.93, 0.95, 0.98, 1] },
      { name: 'cup_wall_n', type: 'box', size: [0.027, 0.0035, 0.024], pos: [0, 0.0305, 0.002], density: 2350, rgba: [0.93, 0.95, 0.98, 1] },
      { name: 'cup_wall_s', type: 'box', size: [0.027, 0.0035, 0.024], pos: [0, -0.0305, 0.002], density: 2350, rgba: [0.93, 0.95, 0.98, 1] },
      { name: 'cup_foot_ring', type: 'box', size: [0.026, 0.026, 0.0025], pos: [0, 0, -0.029], rgba: [0.18, 0.38, 0.78, 1], role: 'visual' },
    ],
    children: [],
  };

  // Off-center brass weight dropped into the inside front edge of the cup so it heels the rim underwater & rides down with it!
  const rimWeight: SceneNode = {
    id: 'rim_brass_pebble',
    name: 'Brass Rim Weight',
    type: 'body',
    pos: [0.195, -0.021, WATER_Z + 0.068],
    deformMaterial: 'softMetal',
    joints: [{ name: 'pebble_free', type: 'free' }],
    geoms: [
      {
        name: 'brass_pebble_sphere',
        type: 'sphere',
        size: [0.0115],
        density: 8500,
        rgba: [0.90, 0.72, 0.24, 1],
      },
    ],
    children: [],
  };

  // Clear glass & slate hydrostatics test-tank frame with cyan waterline markers at z = WATER_Z
  const tankFrame: SceneNode = {
    id: 'hydro_test_tank',
    name: 'Glass Hydrostatics Tank',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'glass',
    joints: [],
    geoms: [
      // Four slim slate corner posts + cyan waterline rings at z = 0.145 m so water depth is unmistakable!
      { name: 'post_fl', type: 'box', size: [0.005, 0.005, 0.090], pos: [-0.285, -0.135, 0.090], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
      { name: 'post_fr', type: 'box', size: [0.005, 0.005, 0.090], pos: [0.285, -0.135, 0.090], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
      { name: 'post_bl', type: 'box', size: [0.005, 0.005, 0.090], pos: [-0.285, 0.135, 0.090], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
      { name: 'post_br', type: 'box', size: [0.005, 0.005, 0.090], pos: [0.285, 0.135, 0.090], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
      // Cyan waterline reference rails right at z = WATER_Z
      { name: 'wl_front', type: 'box', size: [0.285, 0.002, 0.002], pos: [0, -0.135, WATER_Z], rgba: [0.06, 0.68, 0.92, 0.85], contype: 0, conaffinity: 0 },
      { name: 'wl_back', type: 'box', size: [0.285, 0.002, 0.002], pos: [0, 0.135, WATER_Z], rgba: [0.06, 0.68, 0.92, 0.85], contype: 0, conaffinity: 0 },
      { name: 'wl_left', type: 'box', size: [0.002, 0.135, 0.002], pos: [-0.285, 0, WATER_Z], rgba: [0.06, 0.68, 0.92, 0.85], contype: 0, conaffinity: 0 },
      { name: 'wl_right', type: 'box', size: [0.002, 0.135, 0.002], pos: [0.285, 0, WATER_Z], rgba: [0.06, 0.68, 0.92, 0.85], contype: 0, conaffinity: 0 },
      // Bottom perimeter curbing
      { name: 'base_front', type: 'box', size: [0.285, 0.004, 0.004], pos: [0, -0.135, 0.004], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
      { name: 'base_back', type: 'box', size: [0.285, 0.004, 0.004], pos: [0, 0.135, 0.004], rgba: [0.22, 0.26, 0.32, 1], contype: 0, conaffinity: 0 },
    ],
    children: [],
  };

  return {
    nodes: [tankFrame, unbalancedBuoy, balancedBuoy, openHullSkiff, floodingCup, rimWeight],
  };
})();
