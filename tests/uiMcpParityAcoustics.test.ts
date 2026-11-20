// MCP parity for the acoustic fields: a partial payload must not crash what
// reads it later, a bad one is refused by name, `tuneTo` tunes as the body is
// built, and physics_get_object says what a body sounds like.

import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import type { RawNode } from '../src/utils/sceneNodes';
import { normalizeAcousticFields } from '../src/utils/incomingBodyCheck';
import { applyPendingTuneTo, fillBodyDefaults, parseTuneTo } from '../src/hooks/mcp/bodyDefaults';
import { objectReply } from '../src/utils/objectReply';
import { hzToNoteInfo } from '../src/utils/acousticTuning';
import { estimateBodyModes } from '../src/utils/modalAudio';
import { evaluateTautString } from '../src/utils/stringAcoustics';
import { extractBoreWaveguide } from '../src/utils/windAcoustics';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { windInstrumentsPreset } from '../src/presets/windInstruments';

const body = (extra: Record<string, unknown> = {}, geomExtra: Record<string, unknown> = {}): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0, 0, 0],
  geoms: [{ name: 'g', type: 'box', size: [0.1, 0.02, 0.01], rgba: [1, 1, 1, 1], ...geomExtra }],
  joints: [], children: [], ...extra,
} as SceneNode);

const wire = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}): RawNode => ({
  id: 'wire', name: 'wire', pos: [0, 0, 0.1],
  geoms: [{ name: 'wire_g', type: 'capsule', size: [0.001, 0.3], fromto: [0, -0.3, 0, 0, 0.3, 0] }],
  acousticString: spec, ...extra,
} as unknown as RawNode);

const clarinet = () => structuredClone(windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!);

const acousticsOf = (r: Record<string, unknown>) => r.acoustics as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
const childOf = (r: Record<string, unknown>, id: string) => (r.children as Array<Record<string, unknown>>).find((c) => c.id === id)!;

describe('normalizeAcousticFields', () => {
  it('refuses a bad wind exciter, naming the valid four', () => {
    expect(() => normalizeAcousticFields(body({ windInstrument: { exciter: 'kazoo' } }))).toThrow(/exciter.*reed, brass_lip, flute_jet, flap_valve/);
    expect(() => normalizeAcousticFields(body({ windInstrument: { breathKPa: 3 } }))).toThrow(/exciter/);
    expect(() => normalizeAcousticFields(body({ windInstrument: { exciter: 'reed', breathKPa: -1 } }))).toThrow(/breathKPa/);
    expect(() => normalizeAcousticFields(body({ windInstrument: { exciter: 'reed', embouchureHz: Number.NaN } }))).toThrow(/embouchureHz/);
    expect(() => normalizeAcousticFields(body({ windInstrument: 'reed' }))).toThrow(/must be an object/);
  });

  it('fills defaults into partial specs', () => {
    const reed = normalizeAcousticFields(body({ windInstrument: { exciter: 'reed' } })).windInstrument!;
    expect(reed).toMatchObject({ exciter: 'reed', breathKPa: 0, embouchureHz: 260 });
    const flap = normalizeAcousticFields(body({ windInstrument: { exciter: 'flap_valve', breathKPa: null } })).windInstrument!;
    expect(flap).toMatchObject({ breathKPa: 0, embouchureHz: 55 });

    const str = normalizeAcousticFields(body({ acousticString: { pluckPos: 0.9 } })).acousticString!;
    expect(str).toMatchObject({ material: 'bronze', diameterMm: 0.65, tensionN: 50, pluckPos: 0.5 });
    expect(normalizeAcousticFields(body({ acousticString: { pluckPos: 0 } })).acousticString!.pluckPos).toBe(0.03);

    const head = normalizeAcousticFields(body({ acousticMembrane: {} })).acousticMembrane!;
    expect(head.material).toBe('mylar');
    expect(head.tensionNPerM).toBeGreaterThan(0);
    expect(head.thicknessMm).toBeGreaterThan(0);
  });

  it('refuses other bad values by name', () => {
    expect(() => normalizeAcousticFields(body({ deformMaterial: 'wood' }))).toThrow(/deformMaterial.*rubber/);
    expect(() => normalizeAcousticFields(body({ deformMaterial: 'rubber' }))).not.toThrow();
    expect(() => normalizeAcousticFields(body({ deformMaterial: 'custom' }))).not.toThrow();
    expect(() => normalizeAcousticFields(body({ acousticString: { material: 'rope' } }))).toThrow(/material.*steel, bronze, nylon, gut/);
    expect(() => normalizeAcousticFields(body({ acousticString: { tensionN: 0 } }))).toThrow(/tensionN/);
    expect(() => normalizeAcousticFields(body({ acousticString: { diameterMm: 'thin' } }))).toThrow(/diameterMm/);
    expect(() => normalizeAcousticFields(body({ acousticString: { resonatorNodeId: 7 } }))).toThrow(/resonatorNodeId/);
    expect(() => normalizeAcousticFields(body({ acousticMembrane: { material: 'paper' } }))).toThrow(/material/);
    expect(() => normalizeAcousticFields(body({ acousticMembrane: { tensionNPerM: -5 } }))).toThrow(/tensionNPerM/);
    expect(() => normalizeAcousticFields(body({ resonatorTube: { endCondition: 'closed_closed' } }))).toThrow(/endCondition/);
    expect(() => normalizeAcousticFields(body({ resonatorTube: { endCondition: 'open_open' } }))).not.toThrow();
    expect(() => normalizeAcousticFields(body({ nonlinearPlate: { crashSensitivity: Infinity } }))).toThrow(/crashSensitivity/);
    expect(() => normalizeAcousticFields(body({ acousticBow: { forceScale: 0 } }))).toThrow(/forceScale/);
  });

  it('checks only the fields named when asked to', () => {
    const legacy = body({ windInstrument: { exciter: 'oboe' }, deformMaterial: 'steel' });
    expect(() => normalizeAcousticFields(legacy, ['deformMaterial'])).not.toThrow();
    expect(() => normalizeAcousticFields(legacy, ['windInstrument'])).toThrow(/exciter/);
  });

  it('stamps horsehair contact on a bow geom, only where the geom has none', () => {
    const stamped = normalizeAcousticFields(body({ acousticBow: { rosinFriction: 0.5 } }));
    expect(stamped.geoms[0]).toMatchObject({ condim: 3, friction: [0.5, 0.004, 0.0004], solref: [0.005, 1.25] });

    const plain = normalizeAcousticFields(body({ acousticBow: {} }));
    expect(plain.geoms[0].friction).toEqual([0.38, 0.004, 0.0004]);

    const own = body({ acousticBow: {} }, { friction: [1.1, 0.01, 0.001], solref: [0.02, 1] });
    const kept = normalizeAcousticFields(own);
    expect(kept.geoms[0]).toMatchObject({ condim: 3, friction: [1.1, 0.01, 0.001], solref: [0.02, 1] });

    // Never an edit of the geom the caller passed in.
    const geom = body().geoms[0];
    const input = body({ acousticBow: {} });
    input.geoms = [geom];
    normalizeAcousticFields(input);
    expect(geom.condim).toBeUndefined();

    // A visual-only or cut-out geom is not the hair.
    const visual = normalizeAcousticFields({ ...body({ acousticBow: {} }), geoms: [{ name: 'v', type: 'box', size: [1, 1, 1], rgba: [1, 1, 1, 1], role: 'visual' }, body().geoms[0]] } as SceneNode);
    expect(visual.geoms[0].condim).toBeUndefined();
    expect(visual.geoms[1].condim).toBe(3);
  });

  it('clamps the bow numbers', () => {
    const bow = normalizeAcousticFields(body({ acousticBow: { rosinFriction: 0.9, hairWidthMm: 1, rosinGrip: 5 } })).acousticBow!;
    expect(bow).toEqual({ rosinFriction: 0.65, hairWidthMm: 3, rosinGrip: 2 });
  });
});

describe('fillBodyDefaults with partial acoustic specs', () => {
  it('a partial windInstrument still gives a finite bore waveguide', () => {
    const node = fillBodyDefaults({ ...clarinet(), windInstrument: { exciter: 'reed' } } as unknown as RawNode);
    expect(node.windInstrument).toMatchObject({ exciter: 'reed', breathKPa: 0, embouchureHz: 260 });
    const bore = extractBoreWaveguide(node)!;
    expect(bore).not.toBeNull();
    expect(Number.isFinite(bore.lengthM)).toBe(true);
    expect(bore.resonantModesHz.every(Number.isFinite)).toBe(true);
  });

  it('a partial acousticString still evaluates to a finite pitch', () => {
    const node = fillBodyDefaults(wire({ pluckPos: 0.2 }));
    expect(node.acousticString).toMatchObject({ material: 'bronze', diameterMm: 0.65, tensionN: 50, pluckPos: 0.2 });
    const ev = evaluateTautString(node)!;
    expect(Number.isFinite(ev.fundamentalHz)).toBe(true);
    expect(ev.fundamentalHz).toBeGreaterThan(20);
  });

  it('refuses a bad exciter instead of storing it', () => {
    expect(() => fillBodyDefaults({ ...clarinet(), windInstrument: { exciter: 'kazoo' } } as unknown as RawNode)).toThrow(/exciter/);
  });

  it('still reads a null as unset', () => {
    const node = fillBodyDefaults({ id: 'n', pos: null, deformMaterial: null, acousticString: null, geoms: [{ type: 'box', size: [0.1, 0.1, 0.1] }] } as unknown as RawNode);
    expect(node.pos).toBeDefined();
    expect('deformMaterial' in node).toBe(false);
    expect('acousticString' in node).toBe(false);
  });

  it('fills a bow in a body and stamps its geom', () => {
    const node = fillBodyDefaults({ id: 'bow', geoms: [{ type: 'capsule', size: [0.005, 0.3] }], acousticBow: { rosinFriction: 0.3 } } as unknown as RawNode);
    expect(node.geoms[0]).toMatchObject({ condim: 3, friction: [0.3, 0.004, 0.0004] });
  });
});

describe('tuneTo', () => {
  it('parses a note, a number, a numeric string and an object', () => {
    expect(parseTuneTo('A4').hz).toBeCloseTo(440, 2);
    expect(parseTuneTo('F#3').hz).toBeCloseTo(184.997, 2);
    expect(parseTuneTo(330).hz).toBe(330);
    expect(parseTuneTo('262.5').hz).toBe(262.5);
    expect(parseTuneTo({ note: 'C5', drillNodalHole: true })).toMatchObject({ drillNodalHole: true });
    expect(parseTuneTo('A4', true).drillNodalHole).toBe(true);
    expect(() => parseTuneTo('H9')).toThrow(/tuneTo/);
    expect(() => parseTuneTo(-3)).toThrow(/tuneTo/);
    expect(() => parseTuneTo(undefined)).toThrow(/tuneTo/);
  });

  it('tunes a string to the note and is not stored', () => {
    const node = fillBodyDefaults(wire({}, { tuneTo: 'A3' }));
    expect('tuneTo' in node).toBe(false);
    expect(node.tunedPitchHz).toBeCloseTo(220, 1);
    const note = hzToNoteInfo(evaluateTautString(node)!.fundamentalHz);
    expect(note.note).toBe('A3');
    expect(Math.abs(note.cents)).toBeLessThan(15);
    // A pluckable string: not left on the default free joint.
    expect(node.joints.some((j) => j.type === 'slide')).toBe(true);
  });

  it('tunes a wind bore, and a bar by its dimensions', () => {
    const wind = fillBodyDefaults({ ...clarinet(), tuneTo: 330 } as unknown as RawNode);
    expect(wind.tunedPitchHz).toBeCloseTo(330, 1);
    expect('tuneTo' in wind).toBe(false);

    const bar = fillBodyDefaults({
      id: 'bar', deformMaterial: 'hardwood', tuneTo: 'C5',
      geoms: [{ type: 'box', size: [0.15, 0.025, 0.01] }],
    } as unknown as RawNode);
    expect(bar.tunedPitchHz).toBeCloseTo(523.25, 1);
    const hz = estimateBodyModes(bar).fundamentalHz;
    expect(Math.abs(hz - 523.25) / 523.25).toBeLessThan(0.06);
  });

  it('tunes a head by its tension', () => {
    const node = fillBodyDefaults({
      id: 'head', acousticMembrane: { material: 'mylar' }, tuneTo: 'D3',
      geoms: [{ type: 'cylinder', size: [0.18, 0.002] }],
    } as unknown as RawNode);
    expect(node.tunedPitchHz).toBeCloseTo(146.83, 1);
    expect(node.acousticMembrane!.tensionNPerM).toBeGreaterThan(0);
  });

  it('retunes a string against the scene it was built into', () => {
    const raw = { ...wire({}, { tuneTo: 'E3' }), id: 'lone' } as unknown as RawNode;
    const alone = fillBodyDefaults(raw);
    const tree = applyPendingTuneTo([alone]);
    expect(tree).toHaveLength(1);
    expect(tree[0].tunedPitchHz).toBeCloseTo(164.81, 1);
    // Applied once: the second pass has nothing pending.
    expect(applyPendingTuneTo(tree)).toBe(tree);
  });
});

describe('physics_get_object acoustics', () => {
  it('a hollow soundbox and its string (lyre)', () => {
    const [box] = soundboxLyrePreset.nodes;
    const reply = objectReply(box, { scene: soundboxLyrePreset.nodes });
    const a = acousticsOf(reply)!;
    expect(a.soundbox.helmholtzHz).toBeGreaterThan(80);
    expect(a.soundbox.helmholtzHz).toBeLessThan(260);
    expect(a.soundbox.cavityVolumeLitres).toBeGreaterThan(0);
    expect(a.soundbox.portCount).toBeGreaterThanOrEqual(1);
    expect(a.soundbox.topPlateHz).toBeGreaterThan(0);
    expect(typeof a.fundamentalHz).toBe('number');
    expect(typeof a.note).toBe('string');
    expect(typeof a.regime).toBe('string');

    const stringChild = box.children.find((c) => c.acousticString)!;
    const s = acousticsOf(childOf(reply, stringChild.id))!;
    expect(s.note).toBe('C4');
    expect(s.string.fundamentalHz).toBeCloseTo(s.fundamentalHz, 2);
    expect(s.string.stressRatio).toBeGreaterThan(0);
    expect(s.string.stressRatio).toBeLessThan(1);
    expect(s.string.lengthM).toBeGreaterThan(0);
    expect(s.string.warnings).toEqual([]);
    expect(s.string.bridgeCoupling).toBeGreaterThan(0);
  });

  it('a wind instrument (clarinet)', () => {
    const node = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const a = acousticsOf(objectReply(node, { scene: windInstrumentsPreset.nodes }))!;
    expect(a.wind.boreShape).toBe('cylindrical');
    expect(a.wind.lengthM).toBeGreaterThan(0.3);
    expect(a.wind.resonantModesHz.length).toBeGreaterThan(0);
    expect(a.wind.resonantModesHz.length).toBeLessThanOrEqual(4);
    expect(a.wind.muteFactor).toBeGreaterThanOrEqual(0);
    expect(a.wind.breachFactor).toBeGreaterThanOrEqual(0);
    expect(a.fundamentalHz).toBeGreaterThan(60);
    expect(a.note).toMatch(/^[A-G]#?\d$/);
    // Rounded to a millimetre and a tenth of a hertz.
    expect(a.wind.lengthM).toBe(+a.wind.lengthM.toFixed(3));
    expect(a.wind.resonantModesHz[0]).toBe(+a.wind.resonantModesHz[0].toFixed(1));
  });

  it('a bowed cello: the box, four strings in tune, and a bow with no pitch of its own', () => {
    const [cello] = bowedCelloPreset.nodes;
    const reply = objectReply(cello, { scene: bowedCelloPreset.nodes });
    expect(acousticsOf(reply)!.soundbox.cavityVolumeLitres).toBeGreaterThan(14);
    const notes = (reply.children as Array<Record<string, unknown>>)
      .filter((c) => acousticsOf(c)?.string)
      .map((c) => acousticsOf(c)!.note);
    expect(notes).toEqual(['C2', 'G2', 'D3', 'A3']);
    expect(acousticsOf(reply)!.material).toEqual(expect.any(String));
  });

  it('a body with no acoustic field has no acoustics, and the reply stays small', () => {
    const plain = body({ rgba: [1, 0, 0, 1] });
    expect(acousticsOf(objectReply(plain))).toBeUndefined();
    const [cello] = bowedCelloPreset.nodes;
    expect(JSON.stringify(objectReply(cello, { scene: bowedCelloPreset.nodes })).length).toBeLessThan(400_000);
  });

  it('a deformMaterial body: pitch, regime and material label, rounded', () => {
    const node = fillBodyDefaults({ id: 'k', deformMaterial: 'rubber', geoms: [{ type: 'box', size: [0.1, 0.02, 0.01] }] } as unknown as RawNode);
    const a = acousticsOf(objectReply(node))!;
    expect(a.fundamentalHz).toBe(+a.fundamentalHz.toFixed(3));
    expect(a.material).toEqual(expect.any(String));
    expect(['bar', 'arched_bar', 'tube', 'plate', 'block']).toContain(a.regime);
  });
});
