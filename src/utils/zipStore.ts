// ---------------------------------------------------------------------------
// A ZIP writer, stored entries only
// ---------------------------------------------------------------------------
//
// Exists because a .3mf is a ZIP — an OPC package of XML parts — and this app
// had no way to make one. Deflate is deliberately not implemented: the parts
// going in are a few hundred kilobytes of XML, every reader accepts stored
// entries, and a compressor is a great deal of code to own for a file nobody
// transmits over a modem.
//
// Written to be deterministic: no timestamp of the moment, no ordering
// surprises, so the same scene exports byte-identical twice and a test can say
// what the bytes are.
// ---------------------------------------------------------------------------

/** One file in the archive. Paths use forward slashes and no leading slash. */
export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/**
 * A fixed MS-DOS timestamp — 1980-01-01, the earliest the format can express.
 *
 * The alternative is the clock, which would make every export of an unchanged
 * scene a different file and rule out comparing two of them.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Packs entries into a ZIP archive with no compression. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + name.length + size);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);  // local file header
    localView.setUint16(4, 20, true);          // version needed
    localView.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    localView.setUint16(8, 0, true);           // method: stored
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);       // compressed
    localView.setUint32(22, size, true);       // uncompressed
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);          // extra field length
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); // central directory header
    centralView.setUint16(4, 20, true);         // version made by
    centralView.setUint16(6, 20, true);         // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, DOS_TIME, true);
    centralView.setUint16(14, DOS_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);    // offset of the local header
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);       // end of central directory
  endView.setUint16(8, entries.length, true);   // entries on this disk
  endView.setUint16(10, entries.length, true);  // entries total
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);          // where the directory starts

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
