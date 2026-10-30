import { describe, it, expect } from 'vitest';
import { pcbHandoffFromHash } from '../src/hooks/usePcbHandoffLink';
import { decodePcbHandoff } from '../src/utils/pcbEnclosureSync';

// The fragment exactly as Volt's "Send to Mesh" writes it (volt/src/utils/meshPcbHandoff.ts).
function voltFragment(spec: object, name: string): string {
  const json = JSON.stringify(spec);
  const b64 = Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#${new URLSearchParams({ v: '1', pcb: b64, name }).toString()}`;
}

const VOLT_BOARD = {
  name: 'Volt board 60x40',
  widthMm: 60,
  depthMm: 40,
  thicknessMm: 1.6,
  cornerRadiusMm: 0.75,
  color: 'green',
  mountingHoles: [{ id: 'mh1', xMm: 26, yMm: -16, drillMm: 3.2, padDiameterMm: 5.6, fastener: 'M3' }],
  components: [
    { id: 'rv1', ref: 'RV1', kind: 'potentiometer', xMm: 10, yMm: 0, widthMm: 10, depthMm: 12, heightMm: 15,
      panelMount: { face: 'top', cutoutShape: 'd_shaft', diameterMm: 7.2 } },
    { id: 'c1', ref: 'C1', kind: 'capacitor', xMm: -5, yMm: 4, side: 'bottom', widthMm: 3, depthMm: 2, heightMm: 0.8 },
  ],
};

describe('a board sent from Volt in the address bar', () => {
  it('is picked out of the fragment, and nothing else is', () => {
    const hash = voltFragment(VOLT_BOARD, VOLT_BOARD.name);
    expect(pcbHandoffFromHash(hash)).toBe(hash);
    expect(pcbHandoffFromHash('')).toBeNull();
    expect(pcbHandoffFromHash('#v=1&scene=abc')).toBeNull();
  });

  it('decodes to the board Volt sent', () => {
    const spec = decodePcbHandoff(pcbHandoffFromHash(voltFragment(VOLT_BOARD, VOLT_BOARD.name))!);
    expect(spec.widthMm).toBe(60);
    expect(spec.mountingHoles[0]).toMatchObject({ xMm: 26, yMm: -16, fastener: 'M3' });
    expect(spec.components[0].panelMount?.cutoutShape).toBe('d_shaft');
    expect(spec.components[1].side).toBe('bottom');
  });
});
