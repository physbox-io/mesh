import { useState } from 'react';
import { parseInches, nearestFraction } from '../../utils/inches';

const MM_PER_INCH = 25.4;

// Imperial sizes that come up at the machine: cutter shanks and stock thickness.
const INCH_SIZES = [
  { label: '1"', inch: 1 },
  { label: '1/2"', inch: 1 / 2 },
  { label: '1/4"', inch: 1 / 4 },
  { label: '1/8"', inch: 1 / 8 },
  { label: '1/16"', inch: 1 / 16 },
  { label: '1/32"', inch: 1 / 32 },
];

// Diametral clearance (hole minus shaft) for FDM parts. Printers differ by
// a tenth either way, so these are starting points for a test print.
const PRINT_FITS = [
  { fit: 'Press', clearance: '0 – 0.1', use: 'Pins, bearings pressed into a pocket' },
  { fit: 'Snug / sliding', clearance: '0.2', use: 'Lids, parts that slide by hand' },
  { fit: 'Free running', clearance: '0.3 – 0.4', use: 'Hinges, axles that spin freely' },
  { fit: 'Loose', clearance: '0.5+', use: 'Print-in-place joints, rough alignment' },
];

// Metric coarse thread. Clearance is ISO 273 medium; heat-set holes are
// typical for tapered brass inserts (ruthex / CNC Kitchen sizes).
const SCREW_HOLES = [
  { size: 'M2', tap: 1.6, clearance: 2.4, insert: 3.2 },
  { size: 'M2.5', tap: 2.05, clearance: 2.9, insert: 3.6 },
  { size: 'M3', tap: 2.5, clearance: 3.4, insert: 4.0 },
  { size: 'M4', tap: 3.3, clearance: 4.5, insert: 5.6 },
  { size: 'M5', tap: 4.2, clearance: 5.5, insert: 6.4 },
  { size: 'M6', tap: 5.0, clearance: 6.6, insert: 8.0 },
];

const trim = (n: number, places: number) => n.toFixed(places).replace(/\.?0+$/, '');

function Converter() {
  const [inchText, setInchText] = useState('1/4');
  const [mmText, setMmText] = useState('6.35');
  const inch = parseInches(inchText);
  const mmNum = Number(mmText);
  const mmInch = mmText.trim() !== '' && Number.isFinite(mmNum) ? mmNum / MM_PER_INCH : null;

  const inputCls = 'w-28 px-2.5 py-1.5 text-sm font-mono rounded-lg border border-slate-200 focus:outline-none focus:border-blue-400';
  return (
    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3 text-sm">
      <label className="flex items-center gap-2 flex-wrap">
        <input
          className={inputCls}
          value={inchText}
          onChange={(e) => {
            setInchText(e.target.value);
            const v = parseInches(e.target.value);
            if (v !== null) setMmText(trim(v * MM_PER_INCH, 4));
          }}
          aria-label="Inches"
        />
        <span className="text-slate-500">in</span>
        <span className="text-slate-400">=</span>
        <span className="font-mono text-slate-800">{inch === null ? '—' : trim(inch * MM_PER_INCH, 4)}</span>
        <span className="text-slate-500">mm</span>
      </label>
      <label className="flex items-center gap-2 flex-wrap">
        <input
          className={inputCls}
          value={mmText}
          onChange={(e) => {
            setMmText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v)) setInchText(trim(v / MM_PER_INCH, 4));
          }}
          aria-label="Millimetres"
        />
        <span className="text-slate-500">mm</span>
        <span className="text-slate-400">=</span>
        <span className="font-mono text-slate-800">{mmInch === null ? '—' : trim(mmInch, 4)}</span>
        <span className="text-slate-500">in</span>
        {mmInch !== null && mmInch > 0 && (
          <span className="text-xs text-slate-400">≈ {nearestFraction(mmInch)}</span>
        )}
      </label>
      <p className="text-[11px] text-slate-400">Inches accept decimals or fractions: <code>0.3</code>, <code>3/16</code>, <code>1 1/2</code>.</p>
    </div>
  );
}

const th = 'px-3 py-2 font-semibold';
const td = 'px-3 py-1.5';

export function QuickReference() {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-slate-800 text-lg">📏 Inch ↔ mm</h3>
        <Converter />
        <table className="text-sm border border-slate-200 rounded-xl overflow-hidden w-full max-w-xs">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr><th className={`${th} text-left`}>Inch</th><th className={`${th} text-right`}>mm</th></tr>
          </thead>
          <tbody>
            {INCH_SIZES.map(({ label, inch }) => (
              <tr key={label} className="border-t border-slate-150">
                <td className={`${td} font-semibold text-slate-700`}>{label}</td>
                <td className={`${td} text-right font-mono text-slate-800`}>{trim(inch * MM_PER_INCH, 5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-slate-800 text-lg">🧩 Clearance fits (3D printing)</h3>
        <p className="text-xs text-slate-500">Hole diameter minus shaft diameter, in mm. Printers vary, so print a test piece before a final part.</p>
        <div className="overflow-x-auto">
          <table className="text-sm border border-slate-200 rounded-xl overflow-hidden w-full">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr><th className={`${th} text-left`}>Fit</th><th className={`${th} text-right`}>Clearance</th><th className={`${th} text-left`}>Use for</th></tr>
            </thead>
            <tbody>
              {PRINT_FITS.map(({ fit, clearance, use }) => (
                <tr key={fit} className="border-t border-slate-150">
                  <td className={`${td} font-semibold text-slate-700 whitespace-nowrap`}>{fit}</td>
                  <td className={`${td} text-right font-mono text-slate-800 whitespace-nowrap`}>{clearance}</td>
                  <td className={`${td} text-xs text-slate-500`}>{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-slate-800 text-lg">🔩 Screw hole sizes</h3>
        <p className="text-xs text-slate-500">
          Diameters in mm. <strong>Tap</strong> drills for cutting a thread; <strong>clearance</strong> for the screw to pass through;
          <strong> heat-set</strong> for typical tapered brass inserts (check your insert’s datasheet). Printed holes come out
          slightly small, so add about 0.1 to 0.2 mm when you model them.
        </p>
        <div className="overflow-x-auto">
          <table className="text-sm border border-slate-200 rounded-xl overflow-hidden w-full max-w-md">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className={`${th} text-left`}>Screw</th>
                <th className={`${th} text-right`}>Tap</th>
                <th className={`${th} text-right`}>Clearance</th>
                <th className={`${th} text-right`}>Heat-set</th>
              </tr>
            </thead>
            <tbody>
              {SCREW_HOLES.map(({ size, tap, clearance, insert }) => (
                <tr key={size} className="border-t border-slate-150">
                  <td className={`${td} font-semibold text-slate-700`}>{size}</td>
                  <td className={`${td} text-right font-mono text-slate-800`}>{trim(tap, 2)}</td>
                  <td className={`${td} text-right font-mono text-slate-800`}>{trim(clearance, 2)}</td>
                  <td className={`${td} text-right font-mono text-slate-800`}>{trim(insert, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
