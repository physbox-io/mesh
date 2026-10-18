/**
 * opentype.js ships no types. Only `parse` is used, and its result is read
 * through the narrow FontLike interface in utils/textOutline.ts.
 */
declare module 'opentype.js' {
  export function parse(buffer: ArrayBuffer): unknown;
}
