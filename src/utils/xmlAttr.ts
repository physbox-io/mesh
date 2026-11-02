/**
 * A name as an attribute value. Names are whatever someone typed, and a body
 * called `Lid & base` or `6" pipe` made the XML unreadable and the build fail.
 * MuJoCo's parser decodes the entities again, so the model holds the name as
 * typed and the viewport's lookups by name still find it.
 */
export function xmlAttr(name: string): string {
  return String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
