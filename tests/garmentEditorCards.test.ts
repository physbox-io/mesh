// The garment editor's cards, each tab rendered once with every list filled:
// collar and lapel numbers, darts, gathers and pleats, per-piece fabric and
// colour, fastenings, per-side sleeves and the build's warnings. Static
// markup only (no DOM): it proves each renders what the draft says.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true });
  }
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InspectorCards } from '../src/components/inspector/InspectorCards';
import { usePanels } from '../src/store/panelsStore';
import { useStore } from '../src/store/useStore';
import { useClothStatus } from '../src/store/clothStatus';

// Server rendering reads a store's initial state, so the state is written there.
const seed = (st: { getInitialState: () => object }, patch: object) => Object.assign(st.getInitialState(), patch);
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import type { InspectorTab } from '../src/store/panelsStore';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const jacket = garmentNode('jacket', 'jacket', {
  garment: 'jacket', sleeveL: 0.3, collar: { stand: 0.025 }, lapels: { width: 0.08 }, opening: true,
  darts: [{ name: 'waistDart', apex: { z: 'waist', dz: 0.05, x: 0.08 }, direction: [0, 0, -1], length: 0.1, mirror: true }],
  fullness: [{ along: 'waist', kind: 'knife', ratio: 2.5, stitched: 0.04 }],
  pieceFabrics: [{ piece: 'frontL', rgba: [1, 0, 0, 1], material: 'leather' }, { piece: 'pocket', rgba: [0, 0, 1, 1] }],
}, form);
jacket.cloth!.fasten = [{ a: { piece: 'frontL', at: [0.01, 0.2] }, b: { piece: 'frontR', at: [0.3, 0.2] }, trim: { kind: 'button' } }];
const flex = (piece: string) => ({ name: `jacket__${piece}`, vertadr: 0, vertnum: 3, elems: [0, 1, 2], rgba: [0.5, 0.5, 0.5, 1], tint: 1, material: 'woven', flat: { uv: [[0, 0], [0.4, 0], [0.2, 0.6]], outline: [0, 1, 2], strain95: 0.02 } });

const render = (tab: InspectorTab) => {
  seed(usePanels, { inspectorTab: tab });
  return renderToStaticMarkup(React.createElement(InspectorCards, { node: jacket, threeSceneRef: { current: null } }));
};

describe('the garment editor', () => {
  beforeEach(() => {
    seed(useStore, { sceneGraph: { nodes: [form, jacket] }, model: { flexes: ['back', 'frontL', 'frontR'].map(flex) } });
    seed(useClothStatus, { warnings: ["jacket: pockets[0].panel 'frnt' names no panel (its panels: back, frontL, frontR)."] });
  });

  it('Main: per-side sleeves with cuff and armhole, and the build\'s warning', () => {
    const html = render('main');
    expect(html).toContain('Left sleeve');
    expect(html).toContain('Right sleeve');
    expect(html).toContain('Cuff');
    expect(html).toContain('Armhole drop');
    expect(html).toContain('Each sleeve');
    expect(html).toContain('names no panel');
  });

  it('Shape: collar and lapel numbers, darts, pleats', () => {
    const html = render('shape');
    for (const s of ['Stand at front', 'Corner round', 'Separate stand', 'Lapel break', 'Lapel width', 'Notch', 'Roll line at', 'Shawl', 'Darts', 'waistDart', 'Other end', 'Gathers and pleats', 'Knife pleats', 'Stitched down', 'Sleeve ends']) expect(html, s).toContain(s);
  });

  it('Texture: each piece with its own fabric and colour, and a group entry', () => {
    const html = render('texture');
    expect(html).toContain('frontL');
    expect(html).toContain('400×600');
    expect(html).toContain('pocket (all)');
    expect(html).toMatch(/value="leather" selected=""/);
  });

  it('Physics: arrange and fastenings', () => {
    const html = render('physics');
    expect(html).toContain('Arrange');
    expect(html).toContain('Fastenings');
    expect(html).toContain('Add fastening');
  });
});
