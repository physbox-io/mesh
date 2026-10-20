/**
 * Frames: which way the model and the block face the spindle.
 *
 * Two different turns live here. `orient` puts the *model* on the block for
 * the first setup (which model axis points at the spindle). `setupFrame` turns
 * the *block* between setups, from setup 1's work frame to the frame of a
 * setup that machines another face. Every matrix here is a proper rotation
 * (determinant +1), so the part that comes off the machine is the part, not
 * its reflection.
 */

/** Which way up the model goes in the first setup. */
export type UpAxis = '+z' | '-z' | '+x' | '-x' | '+y' | '-y';

/** `orient` as a row-major matrix. */
export const ORIENT_MATRIX: Record<UpAxis, number[]> = {
  '+z': [1, 0, 0, 0, 1, 0, 0, 0, 1],
  '-z': [1, 0, 0, 0, -1, 0, 0, 0, -1],
  '+x': [0, 0, -1, 0, 1, 0, 1, 0, 0],
  '-x': [0, 0, 1, 0, 1, 0, -1, 0, 0],
  '+y': [1, 0, 0, 0, 0, -1, 0, 1, 0],
  '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
};

/** Turns the model so the chosen axis points at the spindle. */
export function orient(up: UpAxis, x: number, y: number, z: number): [number, number, number] {
  switch (up) {
    case '+z': return [x, y, z];
    case '-z': return [x, -y, -z];
    case '+x': return [-z, y, x];
    case '-x': return [z, y, -x];
    case '+y': return [x, -z, y];
    case '-y': return [x, z, -y];
  }
}

/**
 * A face of the block, named in setup 1's work frame: +Z is the top, -Y the
 * front (towards the operator), -X the left end.
 */
export type BlockFace = '+z' | '-z' | '+x' | '-x' | '+y' | '-y';

export const BLOCK_FACES: BlockFace[] = ['+z', '-z', '+x', '-x', '+y', '-y'];

/** What the operator calls each face of the block as it stood for setup 1. */
export const FACE_NAME: Record<BlockFace, string> = {
  '+z': 'top',
  '-z': 'underside',
  '+x': 'right end',
  '-x': 'left end',
  '+y': 'back',
  '-y': 'front',
};

/** "Right end up", "Top up". */
export const faceUpLabel = (f: BlockFace) => `${FACE_NAME[f][0].toUpperCase()}${FACE_NAME[f].slice(1)} up`;

const NORMAL: Record<BlockFace, [number, number, number]> = {
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
};

/**
 * Setup 1's frame turned so `face` points up, row-major.
 *
 * The yaw about the new vertical is chosen so setup 1's top and front, which
 * are the faces the operator zeroed on first and the ones most likely still
 * square, stay where they can be found again: on a turn onto an end, the edge
 * they share stands at the new near-left corner; on the flip (-Z) the block
 * turns over left to right, as side B always has.
 */
const SETUP_MATRIX: Record<BlockFace, number[]> = {
  '+z': [1, 0, 0, 0, 1, 0, 0, 0, 1],
  // Over left to right, about Y: the front stays the front.
  '-z': [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  // Onto the left end: the old top on the left, the old front towards the operator.
  '+x': [0, 0, -1, 0, 1, 0, 1, 0, 0],
  // Onto the right end: the old top towards the operator, the old front on the left.
  '-x': [0, 1, 0, 0, 0, -1, -1, 0, 0],
  // Onto the front: the old top faces the operator, the old left is on the left.
  '+y': [1, 0, 0, 0, 0, -1, 0, 1, 0],
  // Onto the back: the old top on the left, the old left end faces the operator.
  '-y': [0, 0, -1, 1, 0, 0, 0, -1, 0],
};

export interface StockSize {
  widthMm: number;
  depthMm: number;
  thicknessMm: number;
}

export interface SetupFrame {
  /** The face that points at the spindle, named in setup 1's frame. */
  face: BlockFace;
  /** Setup 1's work frame to this one: `work_k = R · work_1 + t`. Row-major. */
  rotation: number[];
  translation: [number, number, number];
  /** The block as it stands in this setup: width along X, depth along Y, height. */
  stock: StockSize;
  /** A point in setup 1's work frame, in this setup's. */
  toSetup(p: [number, number, number]): [number, number, number];
  /** A point in this setup's work frame, back in setup 1's. */
  toFirst(p: [number, number, number]): [number, number, number];
  /** Which of setup 1's faces now faces each way. */
  faceAt: { up: BlockFace; down: BlockFace; near: BlockFace; far: BlockFace; left: BlockFace; right: BlockFace };
}

const apply = (m: number[], v: [number, number, number]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const transpose = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export function determinant(m: number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/**
 * The frame of a setup that machines `face`, for a block that stood
 * `stock` in setup 1 (origin at its near-left top corner, the block below
 * Z0). The new frame has the same convention: the block runs +X, +Y from its
 * near-left corner and down from Z0.
 */
export function setupFrame(face: BlockFace, stock: StockSize): SetupFrame {
  const R = SETUP_MATRIX[face];
  const Rt = transpose(R);
  const { widthMm: W, depthMm: D, thicknessMm: T } = stock;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [0, W]) for (const y of [0, D]) for (const z of [-T, 0]) {
    const p = apply(R, [x, y, z]);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
  }
  // `+ 0` turns a -0 into 0, so a frame prints and compares cleanly.
  const t: [number, number, number] = [-lo[0] + 0, -lo[1] + 0, -hi[2] + 0];
  const which = (dir: [number, number, number]): BlockFace => {
    const back = apply(Rt, dir);
    return BLOCK_FACES.find((f) => NORMAL[f].every((n, a) => Math.abs(n - back[a]) < 1e-9))!;
  };
  return {
    face,
    rotation: [...R],
    translation: t,
    stock: { widthMm: hi[0] - lo[0], depthMm: hi[1] - lo[1], thicknessMm: hi[2] - lo[2] },
    toSetup: (p) => {
      const q = apply(R, p);
      return [q[0] + t[0], q[1] + t[1], q[2] + t[2]];
    },
    toFirst: (p) => apply(Rt, [p[0] - t[0], p[1] - t[1], p[2] - t[2]]),
    faceAt: {
      up: which([0, 0, 1]),
      down: which([0, 0, -1]),
      near: which([0, -1, 0]),
      far: which([0, 1, 0]),
      left: which([-1, 0, 0]),
      right: which([1, 0, 0]),
    },
  };
}

/**
 * How to stand the block for a setup, in words that name two faces so it
 * cannot be put down mirrored: which face goes down on the bed, and which
 * one faces the operator.
 */
export function describeTurn(frame: SetupFrame): string {
  const { up, down, near } = frame.faceAt;
  if (up === '+z') return 'Block as it started: top up, front towards you.';
  if (up === '-z') {
    return 'Flip the block over left to right (about the Y axis): underside up, front still towards you.';
  }
  return (
    `Stand the block on its ${FACE_NAME[down]}, ${FACE_NAME[up]} up, ` +
    `with the ${FACE_NAME[near]} towards you.`
  );
}
