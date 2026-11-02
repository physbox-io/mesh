/**
 * The two bodies in a MuJoCo contact. A contact with cloth has no geom on the
 * cloth's side (its geom id is -1): it names a flex and a vertex instead, and
 * the body is that vertex's. Every reader that went straight to
 * geom_bodyid[contact.geom1] indexed it at -1 and threw.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the MuJoCo wasm bindings are untyped here */
export function contactBody(model: any, contact: any, side: 0 | 1): number {
  const g = side === 0 ? contact.geom1 : contact.geom2;
  if (g >= 0) return model.geom_bodyid[g];
  const flex = contact.flex?.[side] ?? -1, vert = contact.vert?.[side] ?? -1;
  if (flex >= 0 && vert >= 0) return model.flex_vertbodyid[model.flex_vertadr[flex] + vert];
  return -1;
}
