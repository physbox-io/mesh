// Note card updates driven by the MCP bridge.
//
// updateOrCreateNotecard serves two very different callers: the copilot, which
// passes real conversation turns (userPrompt / assistantMarkdown), and the MCP
// bridge, which passes none of that - just mode:'mcp' and the new scene graph.
// Conflating the two produced a card reading
//
//   # Pentacle Pendant (35mm)
//   Physics scene configured for: MCP UPDATE_OBJECT (pentacle_pendant)
//
// after a single-geom edit, having thrown away everything the card previously
// said. These tests pin both halves of that: MCP edits never invent prose from
// an internal command label, and they never destroy prose that is already there.

import { describe, it, expect, beforeEach } from 'vitest';
import { updateOrCreateNotecard, extractConciseSummary } from '../src/utils/noteCards';

type Card = { id: string; markdown: string; minimized: boolean; x: number; y: number };

let cards: Card[] = [];

const card = (markdown: string): Card => ({ id: 'c1', markdown, minimized: false, x: 16, y: 16 });

// updateOrCreateNotecard reaches the React state through window globals rather
// than importing the store (it is called from the MCP bridge, outside render).
beforeEach(() => {
  cards = [];
  (globalThis as any).window = {
    _physics_getNoteCards: () => cards,
    _physics_setNoteCards: (next: Card[]) => { cards = next; },
  };
});

const PENDANT = [{
  id: 'pentacle_pendant',
  name: 'Pentacle Pendant (35mm)',
  geoms: [{ name: 'pentacle_mesh', type: 'mesh', vertices: [0, 0, 0, 0.0175, 0.02295, 0.0015] }],
}];

const AUTHORED = [
  '# Pentacle Pendant (35mm)',
  '',
  'A 35mm parametric pentacle pendant with a five-pointed star motif.',
  '',
  '## Design Decisions',
  '- 5-point rotational symmetry with 36 degree sector offsets',
  '- Outer rim doubles as structural support for the star arms',
  '',
  '## Component Bounding Boxes',
  '- **Pentacle Pendant (35mm)**: 35mm x 35mm x 3mm',
].join('\n');

describe('updateOrCreateNotecard, mode: mcp', () => {
  it('does not turn an internal command label into card prose', () => {
    cards = [card(AUTHORED)];

    // What the bridge used to pass for UPDATE_OBJECT. Even if a caller still
    // supplies one, mcp mode must not render it as a summary.
    updateOrCreateNotecard({
      mode: 'mcp',
      userPrompt: 'MCP UPDATE_OBJECT (pentacle_pendant)',
      nodes: PENDANT,
    });

    expect(cards[0].markdown).not.toContain('Physics scene configured for');
    expect(cards[0].markdown).not.toContain('MCP UPDATE_OBJECT');
  });

  it('preserves authored sections through a programmatic edit', () => {
    cards = [card(AUTHORED)];

    updateOrCreateNotecard({ mode: 'mcp', nodes: PENDANT });

    const md = cards[0].markdown;
    expect(md).toContain('# Pentacle Pendant (35mm)');
    expect(md).toContain('## Design Decisions');
    expect(md).toContain('36 degree sector offsets');
    // Derived data is still refreshed from the new scene graph.
    expect(md).toContain('## Component Bounding Boxes');
  });

  it('still replaces a Blank Scene placeholder', () => {
    cards = [card('# Blank Scene\n\nAn empty world with just the ground plane.')];

    updateOrCreateNotecard({ mode: 'mcp', nodes: PENDANT });

    expect(cards[0].markdown).toContain('# Pentacle Pendant (35mm)');
    expect(cards[0].markdown).not.toContain('Blank Scene');
  });

  it('creates a neutral card when the scene has none', () => {
    updateOrCreateNotecard({ mode: 'mcp', nodes: PENDANT });

    expect(cards).toHaveLength(1);
    expect(cards[0].markdown).toContain('# Pentacle Pendant (35mm)');
    expect(cards[0].markdown).not.toContain('Physics scene configured for');
  });

  it('leaves the copilot path alone - a real user prompt still becomes a summary', () => {
    // The guard is scoped to mode:'mcp'; generate/mutate/explain still describe
    // what the user asked for.
    expect(extractConciseSummary(undefined, 'Build a pentacle pendant'))
      .toContain('Physics scene configured for: Build a pentacle pendant');
  });
});
