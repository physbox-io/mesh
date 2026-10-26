// Mesh arrays as binary inside a saved scene.
//
// A scene is saved as JSON, and JSON writes a vertex coordinate as decimal
// text: `-0.052999200000000004,` is twenty-one bytes for a number a float
// holds in four. Three 270k-vertex meshes (a candle master, its cast and the
// finished candle) came to 108 MB that way, over three times what the account
// takes and twenty times what localStorage does.
//
// So every place a scene leaves the app — a preset, the cloud document, an
// exported file, a share link — packs its big mesh arrays first, and every
// place one comes back unpacks them:
//
//   - Vertex arrays go as little-endian float32 in base64: 5.3 characters a
//     coordinate. float32 is what STL stores and what the GPU draws; at the
//     4 m an object here may reach it resolves a quarter of a micron.
//   - Index arrays go as the difference from the previous index, zigzagged and
//     written as a varint, in base64. Neighbouring triangles share vertices
//     with nearby numbers, so most differences fit a byte or two where the
//     decimal index was six or seven characters.
//
// The packed form is an object, `{ $packed, n, b64 }`, so a document holding
// it is still plain JSON and anything that only reads names or note cards out
// of it carries on as before. Unpacking passes plain arrays through, which is
// what lets every scene saved before this keep loading.

/** A mesh array as it is saved. */
export interface PackedArray {
  $packed: 'f32' | 'idx';
  /** How many numbers it holds. */
  n: number;
  b64: string;
}

const FLOAT_KEYS = new Set(['vertices', 'renderVertices', 'baseVertices', 'baseRenderVertices', 'colliderVertices']);
const INDEX_KEYS = new Set(['faces', 'colliderFaces']);

/** Below this a mesh array is a box or a collider piece, and the text is small enough. */
const MIN_PACKED = 96;

function isPacked(v: unknown): v is PackedArray {
  return typeof v === 'object' && v !== null && typeof (v as PackedArray).$packed === 'string';
}

// btoa and atob take one character per byte, so the bytes go through in
// chunks: a 30 MB argument list would overflow the stack.
const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function packFloats(values: number[]): PackedArray | null {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // NaN would come back as NaN where JSON wrote null; leave such an array as it was.
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    view.setFloat32(i * 4, v, true);
  }
  return { $packed: 'f32', n: values.length, b64: toBase64(new Uint8Array(view.buffer)) };
}

function packIndices(values: number[]): PackedArray | null {
  // Five bytes is the longest varint a 32-bit zigzagged difference needs.
  let bytes = new Uint8Array(values.length * 2 + 16);
  let at = 0;
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return null;
    const d = v - prev;
    prev = v;
    // Zigzag, so a step back is a small number rather than a huge one.
    let z = d >= 0 ? d * 2 : -d * 2 - 1;
    if (at + 5 > bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    // Arithmetic rather than shifts: a zigzagged difference can pass 2^31.
    while (z >= 0x80) {
      bytes[at++] = (z % 0x80) | 0x80;
      z = Math.floor(z / 0x80);
    }
    bytes[at++] = z;
  }
  return { $packed: 'idx', n: values.length, b64: toBase64(bytes.subarray(0, at)) };
}

function unpackArray(p: PackedArray): number[] {
  // Its bytes are in the account's blob store (meshBlobs.ts) and were not fetched.
  if (typeof p.b64 !== 'string') throw new Error('A mesh in this scene is kept in your account and could not be fetched. Check the connection and open it again.');
  const bytes = fromBase64(p.b64);
  const out = new Array<number>(p.n);
  if (p.$packed === 'f32') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < p.n; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  if (p.$packed === 'idx') {
    let at = 0;
    let prev = 0;
    for (let i = 0; i < p.n; i++) {
      let z = 0;
      let scale = 1;
      let b: number;
      do {
        b = bytes[at++];
        z += (b & 0x7f) * scale;
        scale *= 0x80;
      } while (b & 0x80);
      prev += z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      out[i] = prev;
    }
    return out;
  }
  throw new Error(`This scene was saved by a newer version of Mesh (mesh data "${String(p.$packed)}"). Reload the page.`);
}

/**
 * The value with its big mesh arrays packed. Never mutates what it is given:
 * it is usually the live scene graph. Objects on the way to a packed array are
 * copied; everything else is shared.
 */
export function packMeshArrays<T>(value: T): T {
  return pack(value) as T;
}

function pack(value: unknown): unknown {
  if (Array.isArray(value)) {
    // An array of numbers is a leaf: no mesh array sits inside one.
    if (value.length === 0 || typeof value[0] === 'number') return value;
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = pack(value[i]);
      if (next !== value[i]) (out ??= value.slice())[i] = next;
    }
    return out ?? value;
  }
  if (typeof value !== 'object' || value === null || isPacked(value)) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, v] of Object.entries(value)) {
    let next: unknown = v;
    if (Array.isArray(v) && v.length >= MIN_PACKED && typeof v[0] === 'number') {
      if (FLOAT_KEYS.has(key)) next = packFloats(v) ?? v;
      else if (INDEX_KEYS.has(key)) next = packIndices(v) ?? v;
    } else {
      next = pack(v);
    }
    if (next !== v) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
  }
  return out ?? value;
}

/**
 * The value with every packed array turned back into numbers. Plain arrays
 * pass through, so a scene saved before packing loads as it always did; a
 * value with nothing packed comes back as the same object.
 */
export function unpackMeshArrays<T>(value: T): T {
  return unpack(value) as T;
}

function unpack(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] === 'number') return value;
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = unpack(value[i]);
      if (next !== value[i]) (out ??= value.slice())[i] = next;
    }
    return out ?? value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (isPacked(value)) return unpackArray(value);
  let out: Record<string, unknown> | null = null;
  for (const [key, v] of Object.entries(value)) {
    const next = unpack(v);
    if (next !== v) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
  }
  return out ?? value;
}
