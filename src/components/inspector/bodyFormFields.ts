// The dress form's measurements as the Measurements card lays them out:
// which field each slider sets, its label and what a tape measures there.
// Ranges are BODY_FORM_LIMITS (utils/cloth/bodyForm.ts), shared with MCP.

import type { BodyFormMeasurements } from '../../types/cloth';
import type { BODY_FORM_LIMITS } from '../../utils/cloth/bodyForm';
import { formHeightMeasurements, proportions } from '../../utils/cloth/formProportions';
import { defaultLimbGirths } from '../../utils/cloth/formLimbs';

export type FormField = keyof typeof BODY_FORM_LIMITS;

export interface FormFieldSpec {
  field: FormField;
  /** One label, or [male, female] where they differ. */
  label: string | [string, string];
  tip: string;
  /** Shown only for this figure. */
  figure?: 'male' | 'female';
  /** Shown only on a form with legs. */
  legs?: boolean;
}

export const FORM_SECTIONS: { title: string; unit: 'mm' | '°'; fields: FormFieldSpec[] }[] = [
  {
    title: 'Girths', unit: 'mm', fields: [
      { field: 'neck', label: 'Neck', tip: 'Round the base of the neck' },
      { field: 'chest', label: ['Chest', 'Bust'], tip: 'Round the fullest part of the chest, level all round' },
      { field: 'underbust', label: 'Underbust', tip: 'Round the ribcage just under the bust', figure: 'female' },
      { field: 'waist', label: 'Waist', tip: 'Round the natural waist, the narrowest part' },
      { field: 'hip', label: 'Hip', tip: 'Round the fullest part of the hips and seat' },
      { field: 'upperArm', label: 'Upper arm', tip: 'Round the fullest part of the upper arm' },
      { field: 'wrist', label: 'Wrist', tip: 'Round the wrist bone' },
      { field: 'thigh', label: 'Thigh', tip: 'Round the thigh, about halfway from crotch to knee', legs: true },
      { field: 'knee', label: 'Knee', tip: 'Round the knee', legs: true },
      { field: 'calf', label: 'Calf', tip: 'Round the fullest part of the calf', legs: true },
      { field: 'ankle', label: 'Ankle', tip: 'Round the narrowest part above the ankle bone', legs: true },
    ],
  },
  {
    title: 'Lengths', unit: 'mm', fields: [
      { field: 'height', label: 'Height', tip: 'Floor to the top of the head' },
      { field: 'backLength', label: 'Back length', tip: 'Nape to waist down the centre back (nape taken at the top of the shoulders)' },
      { field: 'shoulderToBust', label: ['Shoulder to chest', 'Shoulder to bust'], tip: 'From the top of the shoulder at the neck straight down to bust point level' },
      { field: 'waistToHip', label: 'Waist to hip', tip: 'From the waist straight down to the fullest part of the hips' },
      { field: 'rise', label: 'Rise', tip: 'Crotch depth: from the crotch straight up to the waist' },
      { field: 'inseam', label: 'Inseam', tip: 'Crotch to floor, down the inside leg' },
      { field: 'armLength', label: 'Arm length', tip: 'Shoulder point to wrist, over the elbow' },
    ],
  },
  {
    title: 'Widths', unit: 'mm', fields: [
      { field: 'shoulderWidth', label: 'Shoulder width', tip: 'Shoulder point to shoulder point, across the back' },
      { field: 'bustSpan', label: 'Bust span', tip: 'Bust point to bust point', figure: 'female' },
    ],
  },
  {
    title: 'Pose', unit: '°', fields: [
      { field: 'armAngle', label: 'Arms down', tip: 'From horizontal: 90° hangs straight, 45° is an A-pose' },
      { field: 'elbowBend', label: 'Elbow bend', tip: 'Forearm turned forward at the elbow: 0° is straight' },
    ],
  },
];

/**
 * Every measurement as the form has it: those set, and those left to the
 * usual proportions worked out from the rest. Plus the outseam, which is the
 * inseam and the rise and not a measurement of its own.
 */
export function formMeasurementsShown(m: BodyFormMeasurements): Record<FormField, number> & { outseam: number } {
  const heights = formHeightMeasurements(m), girths = defaultLimbGirths(m);
  return {
    ...girths,
    bustSpan: proportions(m).bustSpan,
    // Those set, as set.
    ...m,
    // Heights as placed, set or not: a set one is kept in order with the rest.
    ...heights,
  } as Record<FormField, number> & { outseam: number };
}
