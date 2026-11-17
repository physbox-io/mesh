import type { SceneGraph, SceneNode } from '../types/scene';
import { balanceBody } from '../utils/balancePart';

/**
 * True Waterline Hydrostatics & Inverse Auto-Float ("Make It Float") Showcase:
 * Set in a 135 mm freshwater basin (`environment.waterLevel = 0.135`):
 *   1. Unbalanced Red Buoy (left): top-heavy solid polymer + heavy lantern -> capsizes!
 *      (Select it -> Physics -> Stand / Spin / Float -> Float -> Balance Part to fix it!)
 *   2. Auto-Balanced Green Channel Buoy (center-left): identical outer silhouette processed
 *      through `balanceBody(..., 'float')` (internal upper void + bought-in steel hex-nut
 *      keel ballast) -> snaps upright from a 42° knockdown heel!
 *   3. Open-Hull Cedar Skiff (center-right): floats high on displaced interior hull air.
 *   4. Porcelain Cup + Brass Rim Pebble (right): 2350 kg/m³ ceramic floats upright on its
 *      trapped air pocket until the pebble tips its rim under water, flooding & sinking it!
 */
export const hydrostaticFlotationPreset: SceneGraph = (() => {
  const WATER_Z = 0.135;

  const makeRawChannelBuoy = (
    id: string,
    name: string,
    x: number,
    hullRgba: [number, number, number, number],
  ): SceneNode => ({
    id,
    name,
    type: 'body',
    pos: [x, 0, WATER_Z - 0.006],
    density: 620,
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [
      // Generous cylindrical buoy float (~500 cm³ displacement, light 580 kg/m³ shell)
      {
        name: `${id}_hull`,
        type: 'cylinder',
        size: [0.042, 0.045],
        pos: [0, 0, 0],
        density: 580,
        rgba: hullRgba,
      },
      // White daymark collar
      {
        name: `${id}_collar`,
        type: 'cylinder',
        size: [0.043, 0.006],
        pos: [0, 0, 0.024],
        rgba: [0.95, 0.96, 0.98, 1],
        role: 'visual',
      },
      // Tall mast + heavy top lantern head (pulls CoM high above CoB so it capsizes unless counter-ballasted!)
      {
        name: `${id}_mast`,
        type: 'cylinder',
        size: [0.011, 0.038],
        pos: [0, 0, 0.080],
        density: 1150,
        rgba: [0.88, 0.90, 0.94, 1],
      },
      {
        name: `${id}_lantern`,
        type: 'cylinder',
        size: [0.022, 0.017],
        pos: [0, 0, 0.130],
        density: 2800,
        rgba: [0.98, 0.78, 0.18, 1],
      },
    ],
    children: [],
  });

  // 1. Unbalanced top-heavy red buoy (tilted 18° -> capsizes upside-down on Run!)
  const unbalancedBuoy: SceneNode = {
    ...makeRawChannelBuoy('unbalanced_buoy', 'Unbalanced Red Buoy (Capsizes)', -0.18, [0.86, 0.24, 0.22, 1]),
    euler: [18, 0, 0],
  };

  // 2. Identical silhouette solved by `balanceBody(..., 'float')`, knocked over to 42° so it self-rights!
  const balancedRaw = balanceBody(
    makeRawChannelBuoy('balanced_spar_buoy', 'Auto-Balanced Buoy (Self-Righting)', -0.06, [0.16, 0.68, 0.46, 1]),
    'float',
    { waterLevel: WATER_Z, minWallMm: 2.6 },
  ).node;
  const balancedBuoy: SceneNode = {
    ...balancedRaw,
    euler: [42, 0, 0],
  };

  // 3. Open-Hull Cedar Skiff (5-plank open vessel: solidity < 0.88 -> displaces interior air until swamped!)
  const openHullSkiff: SceneNode = {
    id: 'open_hull_skiff',
    name: 'Open-Hull Cedar Skiff',
    type: 'body',
    pos: [0.07, 0, WATER_Z + 0.004],
    euler: [0, 11, 0],
    deformMaterial: 'softwood',
    density: 540,
    joints: [{ name: 'skiff_free', type: 'free' }],
    geoms: [
      // Flat bottom sole + brass keel strip for crisp roll stability
      { name: 'skiff_sole', type: 'box', size: [0.036, 0.068, 0.004], pos: [0, 0, -0.018], density: 620, rgba: [0.72, 0.48, 0.28, 1] },
      { name: 'skiff_keel', type: 'box', size: [0.004, 0.060, 0.005], pos: [0, 0, -0.025], density: 4200, rgba: [0.32, 0.35, 0.40, 1] },
      // Port & starboard gunwale planks
      { name: 'skiff_port', type: 'box', size: [0.004, 0.068, 0.018], pos: [-0.034, 0, 0.002], density: 500, rgba: [0.80, 0.56, 0.34, 1] },
      { name: 'skiff_stbd', type: 'box', size: [0.004, 0.068, 0.018], pos: [0.034, 0, 0.002], density: 500, rgba: [0.80, 0.56, 0.34, 1] },
      // Bow & stern transoms + center rowing thwart
      { name: 'skiff_bow', type: 'box', size: [0.030, 0.004, 0.018], pos: [0, 0.064, 0.002], density: 500, rgba: [0.76, 0.52, 0.30, 1] },
      { name: 'skiff_stern', type: 'box', size: [0.030, 0.004, 0.018], pos: [0, -0.064, 0.002], density: 500, rgba: [0.76, 0.52, 0.30, 1] },
      { name: 'skiff_thwart', type: 'box', size: [0.030, 0.011, 0.0025], pos: [0, 0, 0.006], rgba: [0.86, 0.65, 0.40, 1], role: 'visual' },
    ],
    children: [],
  };

  // 4. Open Glazed Porcelain Cup (`rho = 2350 kg/m³` > freshwater! Floats upright on trapped air,
  //    then floods over the rim & sinks when the falling brass pebble tips its lip underwater!)
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

  // Brass weight dropped onto the front rim of the porcelain cup to heel its gunwale below `waterLevel`
  const rimWeight: SceneNode = {
    id: 'rim_brass_pebble',
    name: 'Brass Rim Weight',
    type: 'body',
    pos: [0.195, -0.029, WATER_Z + 0.072],
    deformMaterial: 'softMetal',
    joints: [{ name: 'pebble_free', type: 'free' }],
    geoms: [
      {
        name: 'brass_pebble_sphere',
        type: 'sphere',
        size: [0.0105],
        density: 8400,
        rgba: [0.90, 0.72, 0.24, 1],
      },
    ],
    children: [],
  };

  return {
    nodes: [unbalancedBuoy, balancedBuoy, openHullSkiff, floodingCup, rimWeight],
  };
})();
