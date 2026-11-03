// ---------------------------------------------------------------------------
// Brickwork presets: a smoker laid in UK brick, and a castle in toy bricks
// ---------------------------------------------------------------------------
//
// The shapes, and the concrete, steel and hinges that go with them, are in
// brickPresetShapes.ts; the bricks were laid from them ahead of time (see
// scripts/gen_brick_presets.ts) and are only turned into scene bodies here.
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';
import { BRICK_STANDARDS, brickworkNodes } from '../utils/brickwork';
import { CASTLE_BRICKS, SMOKER_BRICKS } from './brickPresetData';
import { castleExtras, decodeBricks, smokerExtras, stone } from './brickPresetShapes';

export const smokerPreset: SceneGraph = {
  nodes: [
    ...brickworkNodes({ bricks: decodeBricks(SMOKER_BRICKS), standard: BRICK_STANDARDS.uk }, 'smoker'),
    ...smokerExtras(),
  ],
};

export const toyCastlePreset: SceneGraph = {
  nodes: [
    ...brickworkNodes({ bricks: decodeBricks(CASTLE_BRICKS), standard: BRICK_STANDARDS.toy }, 'castle', [0, 0, 0], stone),
    ...castleExtras(),
  ],
};
