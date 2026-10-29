// ---------------------------------------------------------------------------
// A torque-limited velocity motor, as a slip clutch.
//
// A velocity actuator with a force limit is clamped explicitly: once the
// clamp is reached implicitfast has no gain to integrate, and a full step of
// limit torque on a light joint overshoots the speed band the servo works in.
// The joint then chatters between the two limits (a stepper's bare rotor,
// 6.8 g·cm², flipped between 0 and 81 rad/s every step at 12 rad/s asked).
// The old cure was armature of 1.5·kv·dt on the joint, which for a NEMA17 at
// kv 1.1 was 240 times its real rotor and capped its acceleration at
// 330 rad/s².
//
// So the motor is built the way a stepper behaves instead: a hidden driver
// dof turns at the set speed under an UNclamped velocity servo (implicit, so
// stable at any inertia), and drags the real joint through dry friction
// equal to the torque limit: a fixed tendon (joint − driver) with that
// frictionloss. Friction is a constraint, solved inside the step, so the
// limit holds at any inertia without overshoot. Below the limit the joint
// follows the driver exactly, at kv's droop; above it the clutch slips at the
// limit torque, which is a stalled motor.
//
// The driver is a sibling body in the same frame, and its joint carries the
// actuator under the joint's own actuator name, so ctrl, the Volt link and
// every lookup by name are as they were. Its inertia, 1.5·kv·dt, is the
// floor that keeps the clutch's friction row well conditioned; it is behind
// the clutch, so the real joint never carries it.
// ---------------------------------------------------------------------------

import type { SceneJoint } from '../types/scene';

const TIMESTEP = 0.001;

/** Whether this joint's motor is emitted as a clutch: a velocity motor with a force limit on a hinge or slide. */
export function isClutchedMotor(j: SceneJoint): boolean {
  return j.actuator?.type === 'velocity' && j.actuator.forceLimit !== undefined
    && (j.type === 'hinge' || j.type === 'slide');
}

export const clutchDriverJointName = (jointName: string) => `${jointName}__drive`;

/** The driver's inertia (kg·m², or kg on a slide). */
export const clutchDriverInertia = (kv: number) => Math.max(1e-7, +(1.5 * kv * TIMESTEP).toPrecision(6));

/**
 * The driver body for a clutched joint: same frame as the joint's body
 * (`frameAttrs` is that body's pos/quat), same axis and anchor.
 */
export function clutchDriverBodyXml(bodyName: string, frameAttrs: string, j: SceneJoint, xmlAttr: (s: string) => string): string {
  const kv = j.actuator!.kv ?? 1;
  const pos = j.pos ? ` pos="${j.pos.join(' ')}"` : '';
  const axis = j.axis ? ` axis="${j.axis.join(' ')}"` : '';
  const joint = `<joint name="${xmlAttr(clutchDriverJointName(j.name))}" type="${j.type}"${pos}${axis} armature="${clutchDriverInertia(kv)}" limited="false" />`;
  // A speck: it must have a mass to own a dof, and must touch nothing.
  const geom = `<geom name="${xmlAttr(`${bodyName}__drive_g`)}" type="sphere" size="0.0005" mass="1e-6" contype="0" conaffinity="0" rgba="0 0 0 0" />`;
  return `<body name="${xmlAttr(`${bodyName}__drive`)}"${frameAttrs}>${joint}${geom}</body>`;
}

/** The clutch itself: dry friction on (joint − driver) at the motor's limit, held nearly rigid below it. */
export function clutchTendonXml(j: SceneJoint, xmlAttr: (s: string) => string): string {
  const act = j.actuator!;
  const limit = Math.abs(act.forceLimit!) * Math.abs(act.gear ?? 1);
  return `    <fixed name="${xmlAttr(`${j.name}__clutch`)}" frictionloss="${+limit.toPrecision(6)}" solreffriction="0.002 1" solimpfriction="0.9999 0.9999 0.001 0.5 2">`
    + `<joint joint="${xmlAttr(j.name)}" coef="1" /><joint joint="${xmlAttr(clutchDriverJointName(j.name))}" coef="-1" /></fixed>`;
}
