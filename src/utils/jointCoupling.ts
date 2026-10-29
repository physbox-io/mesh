// ---------------------------------------------------------------------------
// A joint coupling (gear teeth, a leadscrew's thread, a rack on its pinion),
// as a fixed tendon held at zero length: joint1 − ratio·joint2 = 0.
//
// Not MuJoCo's joint equality, which says the same thing but softens itself
// by the two joints' inverse inertias ADDED, with no regard for the ratio.
// Between a 6e-7 kg·m² screw and a 0.37 kg nut at 1.3 mm/rad that guess was
// 30 times the real figure, so the coupling held like a 395 N/m spring and
// the nut sat 9 mm down its screw under a 0.35 kg carriage. A tendon's
// softness comes from the tendon's own inverse inertia, J·M⁻¹·Jᵀ, which
// counts the ratio; held at MuJoCo's 0.9999 impedance ceiling the same nut
// sits a few microns off. tests/rigidCoupling.test.ts.
// ---------------------------------------------------------------------------

/**
 * How a coupling is held: a 4 ms time constant at the 0.9999 impedance
 * ceiling. At the default impedance (0.9-0.95) a 20 N·m load on a 256:1 train
 * left its output 4.2 rad off its ratio for good.
 */
export const RIGID_COUPLING = 'solref="0.004 1" solimp="0.9999 0.9999 0.001 0.5 2"';

export interface CouplingXml {
  /** For `<tendon>`. */
  tendon: string;
  /** For `<equality>`. */
  equality: string;
}

/** joint1 = ratio · joint2, both measured from the model's rest pose. */
export function jointCouplingXml(name: string, joint1: string, joint2: string, ratio: number | string, xmlAttr: (s: string) => string): CouplingXml {
  const r = typeof ratio === 'number' ? ratio : Number(ratio);
  const n = xmlAttr(name);
  return {
    tendon: `    <fixed name="${n}"><joint joint="${xmlAttr(joint1)}" coef="1" /><joint joint="${xmlAttr(joint2)}" coef="${+(-r).toPrecision(10)}" /></fixed>`,
    equality: `    <tendon name="${n}" tendon1="${n}" polycoef="0 0 0 0 0" ${RIGID_COUPLING} />`,
  };
}
