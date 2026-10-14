import { describe, expect, it } from 'vitest';
import { getCycloramaPalette } from '../src/utils/cycloramaPalette';

describe('getCycloramaPalette', () => {
  it('returns distinct center and edge studio cyclorama stops for light and dark mode', () => {
    const light = getCycloramaPalette(false);
    const dark = getCycloramaPalette(true);

    expect(light.spotCenter).toBe('#fffdfa');
    expect(light.spotCorner).toBe('#d8e2ef');
    expect(light.spotCenter).not.toBe(light.spotEdge);

    expect(dark.spotCenter).toBe('#213252');
    expect(dark.spotCorner).toBe('#03060c');
    expect(dark.spotCenter).not.toBe(dark.spotEdge);
  });
});
