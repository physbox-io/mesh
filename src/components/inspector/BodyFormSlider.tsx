import { RotateCcw } from 'lucide-react';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';

/**
 * One measurement: label, typeable value and slider. A measurement that may
 * be left to the usual proportions shows "auto" while it is, and a reset
 * once it is set.
 */
export function BodyFormSlider({ label, tip, value, min, max, unit, isSet, onChange, onReset }: {
  label: string;
  tip: string;
  value: number;
  min: number;
  max: number;
  unit: 'mm' | '°';
  /** Undefined for a measurement every form states; else whether this one is set. */
  isSet?: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  const angle = unit === '°';
  return (
    <div className="flex flex-col gap-1" title={tip}>
      <div className="flex items-center justify-between gap-1">
        <label className="text-xs text-slate-500 font-medium truncate">{label}</label>
        <span className="flex items-center gap-1 min-w-0">
          {isSet === false && <span className="text-[10px] text-slate-400" title="From the usual proportions for this height; move it to set it">auto</span>}
          {isSet && (
            <button onClick={onReset} title="Back to the usual proportion for this height"
              className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 cursor-pointer">
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          <SliderValue value={value} onChange={onChange} decimals={0} unit={unit} scale={angle ? 1 : 1000} min={min} max={max} className="text-xs text-slate-500" />
        </span>
      </div>
      <RangeInput min={min} max={max} step={angle ? 1 : 0.005} value={value} onChange={onChange}
        className={`w-full cursor-pointer ${isSet === false ? 'accent-slate-400' : 'accent-purple-600'}`} />
    </div>
  );
}
