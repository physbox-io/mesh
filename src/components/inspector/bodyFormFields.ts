// The dress form's measurements as the Measurements card lays them out:
// which field each slider sets, its label and what a tape measures there.
// Ranges are BODY_FORM_LIMITS (utils/cloth/bodyForm.ts), shared with MCP.

import type { FormField } from '../../utils/cloth/formMeasurements';

export type { FormField };
export { formMeasurementsShown } from '../../utils/cloth/formMeasurements';

export interface FormFieldSpec {
  field: FormField;
  /** One label, or [male, female] where they differ. */
  label: string | [string, string];
  tip: string;
  /** Shown only for this figure. */
  figure?: 'male' | 'female';
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
      { field: 'thigh', label: 'Thigh', tip: 'Round the thigh, about halfway from crotch to knee' },
      { field: 'knee', label: 'Knee', tip: 'Round the knee' },
      { field: 'calf', label: 'Calf', tip: 'Round the fullest part of the calf' },
      { field: 'ankle', label: 'Ankle', tip: 'Round the narrowest part above the ankle bone' },
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
      { field: 'stance', label: 'Feet placement', tip: 'Narrow to wide: each leg out from the hip, feet on the floor; 0° stands feet under the hips' },
      { field: 'kneeBend', label: 'Knee bend', tip: 'Locked to a crouch: the hips come down, feet planted, torso upright; 0° is locked' },
    ],
  },
];
