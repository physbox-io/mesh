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
  if (entries.length > 0xffff) {
    throw new RangeError(`ZIP32 supports at most 65535 entries (got ${entries.length}).`);
  }

  interface PreparedEntry {
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
    size: number;
    localOffset: number;
  }

  const prepared: PreparedEntry[] = new Array(entries.length);
  let offset = 0;
  let centralSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = utf8(entry.path);
    if (name.length > 0xffff) {
      throw new RangeError(`ZIP entry path exceeds 65535 UTF-8 bytes: ${entry.path.slice(0, 80)}`);
    }
    const size = entry.data.byteLength;
    if (size > 0xffffffff) {
      throw new RangeError(`ZIP32 entry "${entry.path}" exceeds 4 GiB limit (${size} bytes).`);
    }
    const crc = crc32(entry.data);
    prepared[i] = { name, data: entry.data, crc, size, localOffset: offset };
    offset += 30 + name.length + size;
    centralSize += 46 + name.length;
  }

  const total = offset + centralSize + 22;
  if (offset > 0xffffffff || centralSize > 0xffffffff || total > 0xffffffff) {
    throw new RangeError(`ZIP32 archive exceeds 4 GiB limit (${total} bytes).`);
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;

  for (const { name, data, crc, size } of prepared) {
    view.setUint32(cursor, 0x04034b50, true);       // local file header
    view.setUint16(cursor + 4, 20, true);           // version needed
    view.setUint16(cursor + 6, 0x0800, true);       // flags: UTF-8 names
    view.setUint16(cursor + 8, 0, true);            // method: stored
    view.setUint16(cursor + 10, DOS_TIME, true);
    view.setUint16(cursor + 12, DOS_DATE, true);
    view.setUint32(cursor + 14, crc, true);
    view.setUint32(cursor + 18, size, true);        // compressed
    view.setUint32(cursor + 22, size, true);        // uncompressed
    view.setUint16(cursor + 26, name.length, true);
    view.setUint16(cursor + 28, 0, true);           // extra field length
    out.set(name, cursor + 30);
    out.set(data, cursor + 30 + name.length);
    cursor += 30 + name.length + size;
  }

  for (const { name, crc, size, localOffset } of prepared) {
    view.setUint32(cursor, 0x02014b50, true);       // central directory header
    view.setUint16(cursor + 4, 20, true);           // version made by
    view.setUint16(cursor + 6, 20, true);           // version needed
    view.setUint16(cursor + 8, 0x0800, true);
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, DOS_TIME, true);
    view.setUint16(cursor + 14, DOS_DATE, true);
    view.setUint32(cursor + 16, crc, true);
    view.setUint32(cursor + 20, size, true);
    view.setUint32(cursor + 24, size, true);
    view.setUint16(cursor + 28, name.length, true);
    view.setUint32(cursor + 42, localOffset, true); // offset of the local header
    out.set(name, cursor + 46);
    cursor += 46 + name.length;
  }

  view.setUint32(cursor, 0x06054b50, true);         // end of central directory
  view.setUint16(cursor + 8, entries.length, true); // entries on this disk
  view.setUint16(cursor + 10, entries.length, true);// entries total
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, offset, true);        // where the directory starts

  return out;
}
