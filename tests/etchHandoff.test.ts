import { describe, it, expect } from 'vitest';
import { buildEtchHandoffUrl, etchBaseUrl, HandoffTooLargeError } from '../src/utils/etchHandoff';

/**
 * The link that carries a panel cut over to Etch.
 *
 * The format is not ours to choose: Etch's `svgHandoff.ts` reads it, and a
 * field renamed here is artwork that silently arrives without its stock.
 */

const fragment = (url: string) => new URLSearchParams(url.slice(url.indexOf('#') + 1));

const fromBase64Url = (data: string) => {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const gunzip = async (bytes: Uint8Array) => {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  void w.write(bytes);
  void w.close();
  const out = await new Response(ds.readable).text();
  return out;
};

describe('the Etch handoff link', () => {
  it('carries the drawing where Etch looks for it', async () => {
    const url = await buildEtchHandoffUrl({ svg: '<svg/>' }, 'http://localhost:5176/');
    const p = fragment(url);
    // Etch checks the version first and refuses anything it does not know.
    expect(p.get('v')).toBe('1');
    expect(p.get('data')).toBeTruthy();
    expect(url.startsWith('http://localhost:5176/#')).toBe(true);
  });

  it('puts it in the fragment, never the query string', async () => {
    // A fragment is not sent to the server: no request-line limit, no access log.
    const url = await buildEtchHandoffUrl({ svg: '<svg/>' }, 'http://localhost:5176/');
    expect(url.indexOf('?')).toBe(-1);
    expect(url.indexOf('#')).toBeGreaterThan(0);
  });

  it('round-trips the drawing intact', async () => {
    const svg = '<svg width="600mm"><path d="M 0 0 L 300 0"/></svg>';
    const p = fragment(await buildEtchHandoffUrl({ svg }, 'http://x/'));
    expect(p.get('gz')).toBe('1');
    expect(await gunzip(fromBase64Url(p.get('data')!))).toBe(svg);
  });

  it('sends the stock thickness, because Etch derives every feed from it', async () => {
    const p = fragment(await buildEtchHandoffUrl({ svg: '<svg/>', thicknessMm: 60 }, 'http://x/'));
    expect(p.get('thickness')).toBe('60');
  });

  it('leaves thickness out rather than sending a nonsense one', async () => {
    const p = fragment(await buildEtchHandoffUrl({ svg: '<svg/>', thicknessMm: 0 }, 'http://x/'));
    expect(p.get('thickness')).toBeNull();
  });

  it('names the document so it does not arrive as "untitled"', async () => {
    const p = fragment(await buildEtchHandoffUrl({ svg: '<svg/>', name: 'finger cut' }, 'http://x/'));
    expect(p.get('name')).toBe('finger cut');
  });

  it('refuses a drawing too big to survive being pasted', async () => {
    // Incompressible, so gzip cannot rescue it.
    const noise = Array.from({ length: 900_000 }, () => Math.random().toString(36)[2]).join('');
    await expect(buildEtchHandoffUrl({ svg: noise }, 'http://x/')).rejects.toBeInstanceOf(HandoffTooLargeError);
  });

  it('points at the Etch beside it in development, not at the live site', async () => {
    // A hard-coded production URL would send every dev hand-over to the real
    // site, and would work, so nobody would notice.
    expect(etchBaseUrl({ hostname: 'localhost', protocol: 'http:' })).toBe('http://localhost:5176/');
    expect(etchBaseUrl({ hostname: 'mesh.physbox.io', protocol: 'https:' })).toBe('https://etch.physbox.io/');
  });
});
