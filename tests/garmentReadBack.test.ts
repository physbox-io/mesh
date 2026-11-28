// An agent could not read back what it made: physics_get_object returned a
// garment's draft as written, with no resolved length, sleeve or neckline and
// no piece's flat size or strain; and a form's measurements only as set, though
// the docs said every one came back.

import { describe, expect, it } from 'vitest';
import { objectReply } from '../src/utils/objectReply';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { GARMENT_DEFAULTS } from '../src/utils/cloth/garments';
import { LAPEL_DEFAULTS } from '../src/utils/cloth/garmentCollars';
import type { ModelMirror } from '../src/types/sceneLayer';

describe('physics_get_object on a garment and its form', () => {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  const tee = garmentNode('tee', 'tee', { garment: 'tshirt', lapels: { width: 0.09 } }, form);

  it('returns the draft as the builder reads it', () => {
    const r = objectReply(tee, { scene: [form, tee] }) as { clothSummary: { draftResolved: Record<string, unknown> } };
    const d = r.clothSummary.draftResolved;
    expect(d.sleeve).toBe(GARMENT_DEFAULTS.tshirt.sleeve);
    expect(d.length).toBe(GARMENT_DEFAULTS.tshirt.length);
    expect(d.neckline).toBe(GARMENT_DEFAULTS.tshirt.neckline);
    expect(d.lapels).toEqual({ ...LAPEL_DEFAULTS, width: 0.09 });
  }, 120_000);

  it('returns each piece\'s fabric, colour, flat size and strain, from the built model', () => {
    const model = { flexes: [{ name: 'tee__front', vertadr: 0, vertnum: 3, elems: [0, 1, 2], rgba: [1, 0, 0, 1], material: 'jersey', flat: { uv: [[0, 0], [0.5, 0], [0.25, 0.7]], outline: [0, 1, 2], strain95: 0.0123 } }] } as unknown as ModelMirror;
    const r = objectReply(tee, { scene: [form, tee], model }) as { clothSummary: { pieceDetails: unknown[] } };
    expect(r.clothSummary.pieceDetails).toEqual([{ name: 'front', material: 'jersey', rgba: [1, 0, 0, 1], flatMm: [500, 700], strain95: 0.0123 }]);
  });

  it('returns every form measurement as built, unset ones filled', () => {
    const r = objectReply(form, { scene: [form] }) as { bodyFormAsBuilt: Record<string, number> };
    for (const k of ['inseam', 'rise', 'thigh', 'wrist', 'backLength', 'bustSpan', 'chest', 'waist', 'hip']) {
      expect(typeof r.bodyFormAsBuilt[k], k).toBe('number');
    }
  });
});
