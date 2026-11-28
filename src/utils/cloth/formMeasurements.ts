/**
 * Every measurement of a dress form as it is built: those set, and those left
 * to the usual proportions worked out from the rest. What the Measurements
 * card shows and physics_get_object returns, from one place.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import type { BODY_FORM_LIMITS } from './bodyForm';
import { formHeightMeasurements, proportions } from './formProportions';
import { defaultLimbGirths } from './formLimbs';

export type FormField = keyof typeof BODY_FORM_LIMITS;

/** Plus the outseam, which is the inseam and the rise and not a measurement of its own. */
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
