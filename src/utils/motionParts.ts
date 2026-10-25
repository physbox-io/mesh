// ---------------------------------------------------------------------------
// What pushes back and what drives: compression springs and stepper motors
//
// - spring: a compression spring standing on its own +Z, its seat at the
//   origin. Its top is a moving piece on a slide with the spring's real rate as
//   the joint's stiffness, free at its free length and stopped at solid
//   height; whatever is fixed to the top is sprung.
// - stepper: a NEMA motor, its face at the origin and its shaft up +Z. The
//   shaft is a moving piece on a hinge driven by a velocity actuator whose
//   torque is limited to the motor's holding torque, so it stalls under a load
//   a real one would stall under instead of turning anything at all.
//
// Both build like every other family: see hardwareGeometry.ts.
// ---------------------------------------------------------------------------

import type { HardwarePart, MotionPartKind, SceneNode } from '../types/scene';
import { BLACK_OXIDE, BRIGHT, boxGeom, cylinderGeom, mm, sweepMesh, circleLoop, visual, type HardwarePartInfo } from './hardwareGeometry';

/** Compression springs: [outside diameter, free length, wire, rate N/mm, solid length], mm. */
export const SPRINGS: Record<string, [number, number, number, number, number]> = {
  'Ø6×20': [6, 20, 0.6, 0.6, 7],
  'Ø8×25': [8, 25, 0.8, 0.9, 9],
  'Ø10×30': [10, 30, 1, 1.2, 11],
  'Ø12×40': [12, 40, 1.2, 1.4, 14],
  'Ø16×50': [16, 50, 1.6, 2, 18],
  'Ø20×60': [20, 60, 2, 2.6, 22],
};

/** Steppers: [frame width, body length, shaft diameter, shaft length, holding torque N·m, mass kg, rotor inertia g·cm²]. */
export const STEPPERS: Record<string, [number, number, number, number, number, number, number]> = {
  'NEMA17 40': [42.3, 40, 5, 24, 0.42, 0.28, 54],
  'NEMA17 48': [42.3, 48, 5, 24, 0.55, 0.36, 68],
  'NEMA23 56': [56.4, 56, 6.35, 21, 1.26, 0.7, 300],
};

/** The 1 ms step every model runs at (mjcf.ts). */
const TIMESTEP = 0.001;
/** How far below its set speed a stepper runs at its full holding torque, rad/s. */
const SPEED_DROOP = 0.5;

const SPRING_STEEL: [number, number, number, number] = [0.55, 0.58, 0.62, 1];

function buildSpring(node: SceneNode, p: HardwarePart, id: string) {
  const [od, free, wire, rate, solid] = SPRINGS[p.size];
  const coils = Math.max(3, Math.round((solid / wire) - 1));
  const pitch = free / coils;
  const r = (od - wire) / 2;
  // Drawn as its coils, each a ring of wire: the turns, if not the twist.
  node.geoms = [
    cylinderGeom(`${id}_seat`, mm(od / 2), mm(wire), mm(wire / 2), SPRING_STEEL),
    ...Array.from({ length: coils }, (_, i) => {
      const shape = sweepMesh(circleLoop(mm(r), 24), mm(wire / 2), 8);
      const z = mm(wire + (i + 0.5) * pitch * ((free - 2 * wire) / free));
      return visual({
        name: `${id}_coil${i}`, type: 'mesh', size: [1], rgba: [...SPRING_STEEL],
        vertices: shape.vertices.map((v, k) => (k % 3 === 1 ? +(v + z).toFixed(7) : v)),
        renderVertices: shape.renderVertices.map((v, k) => (k % 3 === 2 ? +(v + z).toFixed(7) : v)),
        faces: shape.faces,
      });
    }),
  ];
  node.children = [{
    id: `${id}_carriage`, name: `${p.size} spring top`, type: 'body', pos: [0, 0, mm(free)],
    geoms: [{ ...cylinderGeom(`${id}_top`, mm(od / 2), mm(wire), -mm(wire / 2), SPRING_STEEL), contype: 0, conaffinity: 0 }],
    // The rate is the joint's stiffness; at rest at its free length, it stops solid.
    joints: [{
      name: `${id}_compress`, type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0],
      stiffness: rate * 1000, springref: 0, damping: rate * 2,
      limited: true, hardStop: true, range: [-mm(free - solid), mm(free * 0.05)],
    }],
    children: [],
    hardwarePart: { ...p, piece: 'carriage' },
  }];
}

function buildStepper(node: SceneNode, p: HardwarePart, id: string) {
  const [w, len, shaftD, shaftL, torque, mass, inertia] = STEPPERS[p.size];
  // The rotor, inside the body: a disc of the maker's inertia. Without it the
  // shaft is grams on a needle, and no speed control holds it steady.
  const rotorR = mm(w * 0.28);
  const rotorI = inertia * 1e-7; // g·cm² to kg·m²
  const rotorMass = (2 * rotorI) / (rotorR * rotorR);
  const body = boxGeom(`${id}_body`, [mm(w / 2), mm(w / 2), mm(len / 2)], [0, 0, -mm(len / 2)], BLACK_OXIDE);
  body.mass = mass;
  node.geoms = [
    body,
    // The aluminium end caps and the pilot boss, drawn.
    visual(boxGeom(`${id}_cap`, [mm(w / 2 + 0.1), mm(w / 2 + 0.1), mm(4)], [0, 0, -mm(4)], BRIGHT)),
    visual(cylinderGeom(`${id}_pilot`, mm(11), mm(2), mm(1), BRIGHT)),
  ];
  node.children = [{
    id: `${id}_shaft`, name: `${p.size} shaft`, type: 'body', pos: [0, 0, 0],
    geoms: [
      { ...cylinderGeom(`${id}_shaft_g`, mm(shaftD / 2), mm(shaftL), mm(2 + shaftL / 2), BRIGHT), contype: 0, conaffinity: 0 },
      { ...cylinderGeom(`${id}_rotor`, rotorR, mm(len * 0.6), -mm(len / 2), BLACK_OXIDE), mass: +rotorMass.toFixed(6), contype: 0, conaffinity: 0, rgba: [0, 0, 0, 0] },
    ],
    joints: [{
      name: `${id}_spin`, type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.0005,
      // Driven at the speed asked for, with no more than its holding torque to do it.
      // Stiff enough to hold its speed to within half a rad/s at full holding
      // torque. A gain that stiff only stays steady once the torque limit is
      // reached if the rotor carries more inertia than a step can overturn —
      // so the joint carries that much as armature: inertia without mass,
      // which also limits how hard it can accelerate, as a real stepper's is.
      armature: +(Math.max(rotorI, 1.5 * (torque / SPEED_DROOP) * TIMESTEP)).toFixed(7),
      actuator: { type: 'velocity', kv: +(torque / SPEED_DROOP).toFixed(4), ctrlValue: 0, forceLimit: torque },
    }],
    children: [],
    hardwarePart: { ...p, piece: 'inner' },
  }];
}

export const MOTION_PARTS: Record<MotionPartKind, HardwarePartInfo> = {
  spring: {
    label: 'Spring', sizes: Object.keys(SPRINGS), defaultSize: 'Ø10×30',
    hint: 'A compression spring at its real rate: fix a part to its top and that part is sprung, down to solid height.',
    name: (p) => `${p.size} spring`,
    build: buildSpring,
  },
  stepper: {
    label: 'Stepper', sizes: Object.keys(STEPPERS), defaultSize: 'NEMA17 40',
    hint: 'A stepper motor. Its shaft turns at the speed set on its joint, with no more than its holding torque.',
    name: (p) => `${p.size} stepper`,
    build: buildStepper,
  },
};
