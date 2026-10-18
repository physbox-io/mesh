import { describe, it, expect, vi, afterEach } from 'vitest';

/*
 * What these defend: Google answers a family or weight it does not have with
 * a 400 that carries no CORS header, and a browser reports that only as a
 * thrown "Failed to fetch". Text defaults to bold, and most display and
 * script families (Pacifico, Lobster, Bebas Neue) have no bold, so every one
 * of them failed in the browser while the same code passed here, where a 400
 * is an ordinary response. The fetch below answers the way a browser does.
 */

const CATALOGUE = [
  { family: 'Pacifico', category: 'handwriting', weights: [400] },
  { family: 'Roboto', category: 'sans-serif', weights: [100, 300, 400, 500, 700, 900] },
];

/** Google's real answers for these families, as a browser sees them. */
function browserFetch(requests: string[], { blocked = false } = {}) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://api.fontsource.org/')) return new Response(JSON.stringify(CATALOGUE));
    if (blocked) throw new TypeError('Failed to fetch');
    if (url.startsWith('https://fonts.googleapis.com/css2')) {
      const q = new URL(url).searchParams.get('family') ?? '';
      const [family, axis] = q.split(':');
      const entry = CATALOGUE.find((f) => f.family === family);
      const weight = axis ? Number(axis.replace('wght@', '')) : 400;
      // The 400 without CORS: unreadable, so the browser throws.
      if (!entry || !entry.weights.includes(weight)) throw new TypeError('Failed to fetch');
      return new Response(`@font-face { font-family: '${family}'; src: url(https://fonts.gstatic.com/s/x/${weight}.woff2) format('woff2'); unicode-range: U+0000-00FF; }`);
    }
    // The font file itself is not what these tests are about.
    return new Response('not a font', { status: 404 });
  });
}

async function freshLibrary() {
  vi.resetModules();
  return import('../src/utils/fontLibrary');
}

afterEach(() => vi.unstubAllGlobals());

describe('loading a Google font', () => {
  it('asks only for a weight the family has, so a family with no bold still loads', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', browserFetch(requests));
    const { loadFont } = await freshLibrary();
    // The file is a stub, so this fails on the file -- but not on the stylesheet.
    const err = await loadFont('Pacifico', 700, 'Hi').catch((e: Error) => e);
    const css = requests.filter((u) => u.includes('fonts.googleapis.com'));
    expect(css).toEqual(['https://fonts.googleapis.com/css2?family=Pacifico:wght@400']);
    expect(String(err)).toMatch(/font file/);
  });

  it('keeps the weight asked for when the family has it', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', browserFetch(requests));
    const { loadFont } = await freshLibrary();
    await loadFont('Roboto', 700, 'Hi').catch(() => undefined);
    expect(requests.filter((u) => u.includes('googleapis'))).toEqual(['https://fonts.googleapis.com/css2?family=Roboto:wght@700']);
  });

  it('says a family is not in the library without asking Google', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', browserFetch(requests));
    const { loadFont } = await freshLibrary();
    await expect(loadFont('Not A Real Font', 400)).rejects.toThrow(/not in the Google Fonts library/);
    expect(requests.some((u) => u.includes('googleapis'))).toBe(false);
  });

  it('names the host when Google cannot be reached at all', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', browserFetch(requests, { blocked: true }));
    const { loadFont } = await freshLibrary();
    await expect(loadFont('Roboto', 700)).rejects.toThrow(/Could not reach fonts\.googleapis\.com/);
  });

  it('picks the nearest weight', async () => {
    const { weightToAsk } = await freshLibrary();
    expect(weightToAsk([400], 700)).toBe(400);
    expect(weightToAsk([100, 300, 400, 900], 700)).toBe(900);
    expect(weightToAsk(undefined, 700)).toBe(700);
  });
});
