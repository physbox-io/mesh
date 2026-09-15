import { describe, it, expect } from 'vitest';
import {
  buildShareLink,
  encodeShareFragment,
  decodeShareFragment,
  ShareTooLargeError,
  SHARE_SOFT_LIMIT,
  SHARE_HARD_LIMIT,
  type SharedScene,
} from '../src/utils/shareLink';
import type { SceneNode } from '../src/types/scene';

const BASE = 'https://mesh.example/app/';

const bracket: SharedScene = {
  name: 'Bracket',
  nodes: [
    {
      name: 'plate',
      pos: [0, 0, 0.05],
      geoms: [
        { name: 'body', type: 'box', size: [0.06, 0.04, 0.005], rgba: [0.8, 0.8, 0.85, 1] },
        { name: 'hole', type: 'cylinder', size: [0.004, 0.01], csg: 'difference', pos: [0.02, 0, 0] },
      ],
    } as unknown as SceneNode,
  ],
};

/**
 * A sculpt or an imported STL: the geometry is stored vertex by vertex on the
 * geom, which is what actually makes a scene too big for a URL. Pseudo-random
 * because a lattice of repeated coordinates gzips to nothing and would test
 * the ceiling against a scene that has none of the problem.
 */
function sculpted(vertexCount: number, name = 'sculpt'): SharedScene {
  let seed = 1;
  const vertices: number[] = [];
  for (let i = 0; i < vertexCount * 3; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    vertices.push(Math.round((seed / 0x7fffffff) * 1e6) / 1e6);
  }
  const faces = vertices.map((_, i) => i % vertexCount);
  return {
    name: 'Sculpted head',
    nodes: [
      { name: 'plinth', geoms: [{ name: 'b', type: 'box', size: [0.1, 0.1, 0.01] }] } as unknown as SceneNode,
      { name, geoms: [{ name: 'surface', type: 'mesh', size: [1, 1, 1], vertices, faces }] } as unknown as SceneNode,
    ],
  };
}

describe('encodeShareFragment', () => {
  it('round-trips a scene', async () => {
    const back = await decodeShareFragment(await encodeShareFragment(bracket));
    expect(back?.name).toBe('Bracket');
    expect(back?.nodes).toHaveLength(1);
    expect(back?.nodes[0].geoms?.[1].csg).toBe('difference');
  });

  // Note cards are annotations written on the scene, so they belong with it.
  it('carries the note cards written on the scene', async () => {
    const withCards: SharedScene = {
      ...bracket,
      noteCards: [{ id: 'n1', markdown: 'M4 clearance', minimized: false, x: 20, y: 20 }],
    };
    const back = await decodeShareFragment(await encodeShareFragment(withCards));
    expect(back?.noteCards).toHaveLength(1);
    expect(back?.noteCards?.[0].markdown).toBe('M4 clearance');
  });
});

describe('decodeShareFragment', () => {
  it('ignores an ordinary fragment', async () => {
    expect(await decodeShareFragment('#some-anchor')).toBeNull();
    expect(await decodeShareFragment('')).toBeNull();
  });

  it('refuses a version it does not know', async () => {
    const frag = (await encodeShareFragment(bracket)).replace('v=1', 'v=2');
    await expect(decodeShareFragment(frag)).rejects.toThrow(/newer version/);
  });

  // Exactly what a chat app that shortened the link hands back. The raw
  // failure is a zlib buffer error or a JSON position; neither is an answer.
  it('calls a truncated link damaged', async () => {
    const frag = await encodeShareFragment(bracket);
    await expect(decodeShareFragment(frag.slice(0, frag.length - 40))).rejects.toThrow(/damaged/);
  });

  // Recompiling an empty scene throws inside the MJCF builder, which is why
  // the preset loader refuses one too.
  it('refuses a scene with no nodes rather than letting it reach the compiler', async () => {
    const empty = await encodeShareFragment({ name: 'nothing', nodes: [] });
    await expect(decodeShareFragment(empty)).rejects.toThrow(/damaged/);
  });
});

describe('buildShareLink', () => {
  it("drops the sender's own query and fragment", async () => {
    const link = await buildShareLink(bracket, `${BASE}?debug=1#leftover`);
    expect(link.url.startsWith(`${BASE}#`)).toBe(true);
    expect(link.url).not.toContain('debug=1');
    expect(link.url).not.toContain('leftover');
  });

  // The feature's real shape: a CSG scene is numbers and shares fine.
  it('makes a short link for a primitive scene', async () => {
    const link = await buildShareLink(bracket, BASE);
    expect(link.length).toBeLessThan(SHARE_SOFT_LIMIT);
    expect(link.travelsWell).toBe(true);
  });

  it('warns when the link is long enough for a chat app to shorten it', async () => {
    const link = await buildShareLink(sculpted(1100), BASE);
    expect(link.length).toBeGreaterThan(SHARE_SOFT_LIMIT);
    expect(link.length).toBeLessThanOrEqual(SHARE_HARD_LIMIT);
    expect(link.travelsWell).toBe(false);
    expect(link.notes.some((n) => /shorten/.test(n))).toBe(true);
  });

  // WebKit gives up around 80KB and does it silently: the link opens an empty
  // scene, which reads as "sharing is broken" rather than "too big for a URL".
  it('refuses a scene too big for a URL instead of making a link that opens nothing', async () => {
    await expect(buildShareLink(sculpted(20000), BASE)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  // "Make it smaller somehow" is not actionable; "that sculpt is the problem" is.
  it('names the mesh-heavy bodies when it refuses', async () => {
    const err = await buildShareLink(sculpted(20000, 'head'), BASE).catch((e) => e);
    expect(err).toBeInstanceOf(ShareTooLargeError);
    expect((err as ShareTooLargeError).heaviest[0]).toBe('head');
    expect((err as ShareTooLargeError).message).toMatch(/head/);
    expect((err as ShareTooLargeError).message).toMatch(/export STL/i);
  });
});
