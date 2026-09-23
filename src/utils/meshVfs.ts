// Mesh assets as files in the physics worker's virtual filesystem.
//
// A rebuild used to hand MuJoCo every mesh as a `vertex="..."` attribute, and
// parsing that decimal text is where a rebuild's time went: on the Shatter
// preset, 42 of the 68 ms `from_xml_string` took was the XML parser working
// through six thousand vertices it had already seen on the last build. With
// no meshes at all the same model built in 5 ms.
//
// MuJoCo will instead read a mesh from a binary `.msh` file in an MjVFS, and it
// caches the processed mesh (hull, inertia) against the file for the life of
// the wasm module. A mesh already sitting in the worker's VFS therefore costs
// almost nothing on the next build: 7 ms for the whole model.
//
// The catch is getting a file IN. `MjVFS.addBuffer` marshals its bytes one at
// a time, about 0.4 us a byte, roughly twice what parsing the same mesh as text
// costs. A mesh that changes on every build — a sculpt stroke, a lattice drag —
// would be slower as a file than as text, so a mesh only becomes a file once it
// has come through a build unchanged. See `MeshFileLedger`.
//
// Pure: no store, no worker, no MuJoCo. `physicsWorkerClient` owns a ledger per
// worker and `mjcf.ts` asks it which meshes to emit as files.

/**
 * A mesh in MuJoCo's legacy binary `.msh` layout.
 *
 * Four int32 counts (vertices, normals, texcoords, faces), then the vertices
 * as float32, then the faces as int32. No normals or texcoords: MuJoCo derives
 * what it needs for collision, and the renderer never reads a mesh back out of
 * the model.
 *
 * `verts` must already be in MuJoCo's Z-up frame, exactly as they would be
 * written into `vertex="..."`.
 */
export function encodeMsh(verts: ArrayLike<number>, faces: ArrayLike<number>): Uint8Array {
  const buf = new ArrayBuffer(16 + verts.length * 4 + faces.length * 4);
  const head = new Int32Array(buf, 0, 4);
  head[0] = verts.length / 3;
  head[1] = 0;
  head[2] = 0;
  head[3] = faces.length / 3;
  new Float32Array(buf, 16, verts.length).set(verts);
  new Int32Array(buf, 16 + verts.length * 4, faces.length).set(faces);
  return new Uint8Array(buf);
}

/**
 * A content hash of an encoded mesh, as a file name.
 *
 * Content-addressed so that a mesh which changes gets a new name. MuJoCo's
 * cache is keyed by file, and reusing a name for different vertices would
 * hand back the old mesh's hull. Two independent 32-bit FNV-1a streams make
 * a 64-bit name, so a collision across the few hundred meshes a session sees
 * is not a practical concern.
 */
export function mshFileName(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0xcbf29ce4;
  // Words, not bytes: a quarter of the multiplies, and every field in a .msh
  // is 4-byte aligned anyway.
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    a = Math.imul(a ^ w, 0x01000193);
    b = Math.imul(b ^ ((w >>> 16) | (w << 16)), 0x01000193);
  }
  return `m_${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}.msh`;
}

/** What `compileToMJCF` needs to emit meshes as files. */
export interface MeshFileSink {
  /** Called once as a compile starts, so a compile that threw part way leaves nothing behind. */
  begin(): void;
  /** Whether this mesh should be a file on this build. */
  useFile(name: string, stable: boolean): boolean;
  /** The encoded bytes of every mesh this build emitted as a file, by file name. */
  files: Map<string, Uint8Array>;
  /** Whether the worker already has this file, so its bytes need not be made. */
  holds?(name: string): boolean;
}

/**
 * Which meshes the worker already holds, and which have earned a file.
 *
 * One per worker: a recycled worker starts with an empty VFS, so the client
 * that spawns it starts with an empty ledger.
 */
export class MeshFileLedger implements MeshFileSink {
  /** Every mesh the last build contained. A mesh seen here twice is stable. */
  private lastBuild = new Set<string>();
  /** Files the worker holds, with their sizes. */
  private held = new Map<string, number>();
  private heldBytes = 0;
  /** Filled by `compileToMJCF` during a build, emptied by `take`. */
  files = new Map<string, Uint8Array>();
  private thisBuild = new Set<string>();
  private emitted = new Set<string>();

  private readonly maxBytes: number;

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  begin(): void {
    this.thisBuild = new Set();
    this.emitted = new Set();
    this.files = new Map();
  }

  holds(name: string): boolean {
    return this.held.has(name);
  }

  useFile(name: string, stable: boolean): boolean {
    this.thisBuild.add(name);
    const use = stable || this.held.has(name) || this.lastBuild.has(name);
    if (use) this.emitted.add(name);
    return use;
  }

  /**
   * Close off a build: the files the worker must add before compiling it, and
   * the ones it may drop.
   *
   * Nothing is dropped while the worker is under `maxBytes`, because a mesh
   * that leaves the scene (an undo, a preset switched away and back) is often
   * wanted again. Over it, whatever this build does not use goes.
   */
  take(): { add: { name: string; bytes: Uint8Array }[]; drop: string[] } {
    const add: { name: string; bytes: Uint8Array }[] = [];
    for (const name of this.emitted) {
      if (this.held.has(name)) continue;
      const bytes = this.files.get(name);
      if (!bytes) continue;
      add.push({ name, bytes });
      this.held.set(name, bytes.byteLength);
      this.heldBytes += bytes.byteLength;
    }
    const drop: string[] = [];
    if (this.heldBytes > this.maxBytes) {
      for (const [name, size] of this.held) {
        if (this.emitted.has(name)) continue;
        drop.push(name);
        this.held.delete(name);
        this.heldBytes -= size;
      }
    }
    this.lastBuild = this.thisBuild;
    this.thisBuild = new Set();
    this.emitted = new Set();
    this.files = new Map();
    return { add, drop };
  }
}
