import React, { useState } from 'react';
import { X, Check, ArrowUpToLine, Crosshair, RefreshCw, Play } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { SolidSetupResult } from '../utils/solidSetups';
import { setupDiagramSvg, hiddenFaces } from '../utils/setupDiagram';
import { describeTurn, FACE_NAME, faceUpLabel, setupFrame, type BlockFace, type StockSize } from '../utils/orient';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { JogPad } from './JogPad';

/**
 * Turning the block for the next setup, one step at a time.
 *
 * The setups after the first are where a multi-face part is won or lost: the
 * block has to go down the right way round, and its zero has to be found
 * again on faces the machine has never seen. So this walks through it in the
 * order it is done at the bench, each step with the button that does it, and
 * Start only lights once every step is ticked. There is deliberately no "Z is
 * already set" shortcut: after a turn it never is.
 */
export function SetupChangeDialog({
  setup,
  firstStock,
  carved,
  pins,
  toolDiaMm,
  toolLabel,
  stickoutMm,
  clearanceMm,
  safeZMm,
  machineState,
  onStart,
  onClose,
}: {
  setup: SolidSetupResult;
  firstStock: StockSize;
  carved: BlockFace[];
  pins: { x: number; y: number }[];
  toolDiaMm: number;
  toolLabel: string;
  stickoutMm: number;
  clearanceMm: number;
  safeZMm: number;
  machineState: MachineState;
  onStart: (pinsSeated: boolean) => void;
  onClose: () => void;
}) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | null>(null);
  const [paperMm, setPaperMm] = useState(0.1);
  const mark = (k: string, v = true) => setDone((d) => ({ ...d, [k]: v }));
  const frame = setupFrame(setup.upFace, firstStock);
  const r = toolDiaMm / 2;
  const onPins = setup.locate === 'pins';
  /*
   * Where X and Y are set, from the setup's own datum: a face, or the wall of
   * the datum notch an earlier setup cut, some way in from the face. The bit
   * fitted here touches it from outside, so its middle is a radius short.
   * Never assumed to be the face: on a notch that put the part a notch out.
   */
  const touch = (axis: 'x' | 'y') => {
    const t = setup.datum?.touches.find((d) => d.axis === axis);
    return { at: (t?.wallMm ?? 0) - r, face: t?.face };
  };
  const tx = touch('x'), ty = touch('y');
  const onNotch = (tx.face ?? '').startsWith('datum notch');
  const connected = machineState.connected && machineState.status === 'IDLE';

  const act = async (key: string, run: () => Promise<{ success: boolean; message: string } | void>) => {
    try {
      const out = await run();
      if (out && !out.success) {
        setNote(out.message);
        return;
      }
      setNote(out ? out.message : null);
      mark(key);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const need = setup.standingHeightMm + stickoutMm;
  const fits = clearanceMm > 0 ? need <= clearanceMm : null;

  const steps: { key: string; title: string; body: React.ReactNode }[] = [
    {
      key: 'park',
      title: 'Lift the spindle out of the way',
      body: (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!connected} onClick={() => act('park', () => webSerialManager.parkHigh())} className={btn}>
            <ArrowUpToLine className="w-3.5 h-3.5" /> Park high
          </button>
          <Tick k="park" label="Done by hand" done={done} mark={mark} />
        </div>
      ),
    },
    {
      key: 'room',
      title: 'Check there is room under the spindle',
      body: (
        <div className="space-y-1">
          <p>
            Stood like this the block is {setup.standingHeightMm.toFixed(0)} mm tall, and with the bit hanging{' '}
            {stickoutMm > 0 ? `${stickoutMm.toFixed(0)} mm` : 'its length'} below the collet it needs{' '}
            {stickoutMm > 0 ? `${need.toFixed(0)} mm` : 'that much plus the bit'} from the bed to the collet.
            {fits === false && <span className="text-red-600 dark:text-red-400 font-semibold"> That is more than the {clearanceMm.toFixed(0)} mm there is.</span>}
            {fits === true && <span className="text-emerald-700 dark:text-emerald-300"> You have {clearanceMm.toFixed(0)} mm: it fits.</span>}
          </p>
          <Tick k="room" label="It fits, with room to spare" done={done} mark={mark} />
        </div>
      ),
    },
    {
      key: 'stand',
      title: 'Stand the block as pictured',
      body: (
        <div className="flex flex-wrap items-start gap-3">
          <div
            className="text-slate-700 dark:text-slate-200"
            // Built here from numbers, never from user text.
            dangerouslySetInnerHTML={{
              __html: setupDiagramSvg({
                upFace: setup.upFace, firstStock, carved, locate: setup.locate, widthPx: 260,
                pins: onPins && setup.upFace === '-z' ? pins.map((p) => ({ x: firstStock.widthMm - p.x, y: p.y })) : undefined,
                window: setup.upFace === '+z' || setup.upFace === '-z' ? undefined : setup.windowBounds,
              }),
            }}
          />
          <div className="flex-1 min-w-[180px] space-y-1.5">
            <p className="font-semibold">{describeTurn(frame)}</p>
            <p className="text-slate-500 dark:text-slate-400">{hiddenFaces(setup.upFace, firstStock)}</p>
            <p>Clamp it on the two faces either side, not on the top or on anything already cut.</p>
            <Tick k="stand" label="It is standing like that, and clamped" done={done} mark={mark} />
          </div>
        </div>
      ),
    },
    {
      key: 'bit',
      title: 'Fit the bit',
      body: <Tick k="bit" label={`The ${toolLabel} is in the collet`} done={done} mark={mark} />,
    },
    onPins
      ? {
          key: 'locate',
          title: 'Seat it on the pins and set Z',
          body: (
            <div className="space-y-2">
              <Tick k="seated" label="The block is down on both pins, flat" done={done} mark={mark} />
              <ZTouch paperMm={paperMm} setPaperMm={setPaperMm} connected={connected}
                onSet={() => act('z', () => webSerialManager.setWorkPosition({ z: 0 }, paperMm))} done={!!done.z} />
            </div>
          ),
        }
      : {
          key: 'locate',
          title: 'Find the block again: touch off X, Y and Z',
          body: (
            <div className="space-y-2">
              <p>
                {onNotch
                  ? <>Touch off X and Y on the inner walls of the near-left corner notch ({toolDiaMm} mm bit, {r.toFixed(2)} mm radius offset).</>
                  : <>Without dowel pins, re-zero X and Y on the flipped stock corner ({toolDiaMm} mm bit, {r.toFixed(2)} mm radius offset).</>}
              </p>
              <JogPad disabled={!connected} />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!connected} className={btn}
                  onClick={() => act('x', () => webSerialManager.setWorkPosition({ x: tx.at }, paperMm))}>
                  <Crosshair className="w-3.5 h-3.5" /> Set X on the {onNotch ? 'notch wall facing left' : `${FACE_NAME[frame.faceAt.left]} (left)`} {done.x && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                </button>
                <button type="button" disabled={!connected} className={btn}
                  onClick={() => act('y', () => webSerialManager.setWorkPosition({ y: ty.at }, paperMm))}>
                  <Crosshair className="w-3.5 h-3.5" /> Set Y on the {onNotch ? 'notch wall facing you' : `${FACE_NAME[frame.faceAt.near]} (towards you)`} {done.y && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                </button>
              </div>
              <ZTouch paperMm={paperMm} setPaperMm={setPaperMm} connected={connected}
                onSet={() => act('z', () => webSerialManager.setWorkPosition({ z: 0 }, paperMm))} done={!!done.z} />
            </div>
          ),
        },
    {
      key: 'trace',
      title: onPins ? 'Trace the edge of the top' : 'Trace the edge of the top, to check the zero',
      body: (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!connected} className={btn}
            onClick={() => act('trace', () => webSerialManager.frameJob(
              { minX: 0, minY: 0, maxX: frame.stock.widthMm, maxY: frame.stock.depthMm }, 0, { laserMode: false, safeZMm }))}>
            <RefreshCw className="w-3.5 h-3.5" /> Trace the block
          </button>
          <span className="text-slate-500 dark:text-slate-400">The bit should follow the block's edges, above them.</span>
          <Tick k="trace" label="It did" done={done} mark={mark} />
        </div>
      ),
    },
    {
      key: 'frame',
      title: 'Frame where it will cut',
      body: (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!connected} className={btn}
            onClick={() => act('frame', () => webSerialManager.frameJob(setup.windowBounds, 0, { laserMode: false, safeZMm }))}>
            <RefreshCw className="w-3.5 h-3.5" /> Frame the cut
          </button>
          <Tick k="frame" label="Clamps are clear of it" done={done} mark={mark} />
        </div>
      ),
    },
  ];

  const located = onPins ? !!done.seated && !!done.z : !!done.x && !!done.y && !!done.z;
  const complete = (k: string) => (k === 'locate' ? located : !!done[k]);
  const ready = steps.every((s) => complete(s.key)) && fits !== false;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl max-h-[95dvh] flex flex-col overflow-hidden text-xs text-slate-700 dark:text-slate-200">
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div>
            <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
              Setup {setup.index} of {setup.of}: {faceUpLabel(setup.upFace)}
            </h2>
            <p className="text-slate-500 dark:text-slate-400">Turn the block and find it again. Each step has to be ticked before the cut can start.</p>
          </div>
          <button aria-label="Close" title="Close" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <ol className="flex-1 overflow-y-auto p-4 space-y-3">
          {steps.map((s, i) => (
            <li key={s.key} className="flex gap-3">
              <span className={`mt-0.5 w-5 h-5 flex-shrink-0 rounded-full text-[11px] font-bold flex items-center justify-center ${
                complete(s.key) ? 'bg-emerald-500 text-white' : 'bg-slate-200 dark:bg-slate-800'
              }`}>
                {complete(s.key) ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </span>
              <div className="flex-1 space-y-1.5 min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.title}</p>
                {s.body}
              </div>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-3 px-4 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <span className="flex-1 text-slate-500 dark:text-slate-400">{note ?? (ready ? 'Ready.' : 'Tick every step to start.')}</span>
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg font-semibold hover:bg-slate-200 dark:hover:bg-slate-700">Not now</button>
          <button type="button" disabled={!ready || !connected} onClick={() => onStart(!!done.seated)}
            className="px-4 py-1.5 rounded-lg font-bold bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-slate-950 flex items-center gap-1.5 cursor-pointer">
            <Play className="w-3.5 h-3.5" /> Cut setup {setup.index}
          </button>
        </div>
      </div>
    </div>
  );
}

const btn =
  'py-1 px-2 rounded-lg font-semibold flex items-center gap-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 ' +
  'dark:hover:bg-slate-700 disabled:opacity-40 text-slate-700 dark:text-slate-200 cursor-pointer';

function Tick({ k, label, done, mark }: { k: string; label: string; done: Record<string, boolean>; mark: (k: string, v?: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer">
      <input type="checkbox" checked={!!done[k]} onChange={(e) => mark(k, e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ZTouch({ paperMm, setPaperMm, connected, onSet, done }: {
  paperMm: number; setPaperMm: (v: number) => void; connected: boolean; onSet: () => void; done: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={!connected} onClick={onSet} className={btn}>
        <Crosshair className="w-3.5 h-3.5" /> Set Z on the top {done && <Check className="w-3.5 h-3.5 text-emerald-500" />}
      </button>
      <span>paper</span>
      <NumberInput step={0.01} min={0} max={1} value={paperMm} onChange={(v) => v !== undefined && setPaperMm(v)}
        className="w-16 px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950" />
      <span>mm</span>
    </div>
  );
}
