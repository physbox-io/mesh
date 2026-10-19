import { describe, it, expect } from 'vitest';
import { setupDiagramSvg, hiddenFaces } from '../src/utils/setupDiagram';
import { BLOCK_FACES, FACE_NAME, setupFrame } from '../src/utils/orient';

const stock = { widthMm: 150, depthMm: 150, thicknessMm: 20 };

describe('the setup diagram', () => {
  for (const face of BLOCK_FACES) {
    it(`names the faces it shows as the block stood for setup 1 (${face} up)`, () => {
      const svg = setupDiagramSvg({ upFace: face, firstStock: stock, locate: 'knownSpot' });
      const f = setupFrame(face, stock).faceAt;
      expect(svg).toContain(`${FACE_NAME[face]} (cut now)`);
      expect(svg).toContain(`>${FACE_NAME[f.near]} (towards you)<`);
      expect(svg).toContain(`>${FACE_NAME[f.right]}<`);
      expect(svg).toContain('zero here');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(hiddenFaces(face, stock)).toContain(FACE_NAME[f.down]);
    });
  }

  it('marks faces earlier setups cut, and the pins when it sits on them', () => {
    const svg = setupDiagramSvg({
      upFace: '-z', firstStock: stock, carved: ['+z'], locate: 'pins', pins: [{ x: 7.5, y: 75 }, { x: 142.5, y: 75 }],
    });
    expect(svg).toContain('on the pins');
    expect((svg.match(/<circle/g) ?? []).length).toBe(2);
    expect(svg).not.toContain('zero here');
  });

  it('stands a tall block up without running off the drawing', () => {
    const svg = setupDiagramSvg({ upFace: '+x', firstStock: stock, locate: 'knownSpot', widthPx: 240 });
    const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.map(Number);
    expect(w).toBe(240);
    expect(h).toBeGreaterThan(150);
    for (const m of svg.matchAll(/points="([^"]+)"/g)) {
      for (const pt of m[1].split(' ')) {
        const [x, y] = pt.split(',').map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(w);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(h);
      }
    }
  });
});
