import { Settings, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';
import { MIN_MAX_TOKENS, MAX_MAX_TOKENS } from '../../utils/llmSettings';
import { useLlmSettings } from '../../hooks/useLlmSettings';

/**
 * The Environment popover: view quality, gravity, wind, drag, the floor,
 * contact fidelity, and the copilot's keys, model and reply budget.
 *
 * Mounted all the time and empty while closed, so the copilot settings are
 * read (and the live model lists fetched) when the app opens, not on first
 * opening this.
 */
export function SettingsPopover() {
  const hiRes = useViewQuality(s => s.hiRes);
  const setHiRes = useViewQuality(s => s.setHiRes);
  const simFidelity = useStore((s) => s.sceneGraph.simFidelity ?? 'standard');
  const setSimFidelity = useStore((s) => s.setSimFidelity);
  const {
    isSettingsOpen, setSettingsOpen,
    gravityZ, windX, windY, density, floorFriction, floorBounce, setEnvironment,
  } = useStore(useShallow((s) => ({
    isSettingsOpen: s.isSettingsOpen, setSettingsOpen: s.setSettingsOpen,
    gravityZ: s.gravityZ, windX: s.windX, windY: s.windY, density: s.density, floorFriction: s.floorFriction, floorBounce: s.floorBounce, setEnvironment: s.setEnvironment,
  })));
  const llm = useLlmSettings();
  if (!isSettingsOpen) return null;
  return (
    /* Anchored to the settings button on a desktop. Below `lg` there is
       nothing reliable to anchor to — the header wraps, so the button
       moves — and a 16rem popover in the corner of a phone is mostly
       off-screen anyway, so it becomes a centred sheet instead. */
    <div className="absolute top-4 right-6 w-64 max-lg:inset-x-2 max-lg:right-auto max-lg:top-1/2 max-lg:-translate-y-1/2 max-lg:w-auto max-lg:max-h-[80dvh] max-lg:overflow-y-auto glass-panel rounded-lg p-4 z-30 max-lg:z-50 shadow-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100">
      <h3 className="font-semibold text-sm mb-4 flex items-center justify-between text-slate-800 dark:text-slate-100">
        <span className="flex items-center gap-2"><Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Environment</span>
        <button aria-label="Close" title="Close" onClick={() => setSettingsOpen(false)}><X className="w-4 h-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer" /></button>
      </h3>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <span id="hiResLabel" className="text-xs font-medium text-slate-500 dark:text-slate-400" title="Antialiasing, tone mapping and smoother curves. Turn off if the viewport is slow.">Hi-Res</span>
          <button
            type="button"
            role="switch"
            aria-checked={hiRes}
            aria-labelledby="hiResLabel"
            title="Antialiasing, tone mapping and smoother curves. Turn off if the viewport is slow."
            onClick={() => setHiRes(!hiRes)}
            className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${hiRes ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${hiRes ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Gravity Z <SliderValue value={gravityZ} onChange={(v) => setEnvironment({gravityZ: v})} decimals={1} unit="m/s²" min={-20} max={20} /></label>
          <RangeInput min="-20" max="20" step="0.1" value={gravityZ} onChange={(v) => setEnvironment({gravityZ: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind X <SliderValue value={windX} onChange={(v) => setEnvironment({windX: v})} decimals={1} unit="m/s" min={-10} max={10} /></label>
          <RangeInput min="-10" max="10" step="0.1" value={windX} onChange={(v) => setEnvironment({windX: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind Y <SliderValue value={windY} onChange={(v) => setEnvironment({windY: v})} decimals={1} unit="m/s" min={-10} max={10} /></label>
          <RangeInput min="-10" max="10" step="0.1" value={windY} onChange={(v) => setEnvironment({windY: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Air Density (Drag) <SliderValue value={density} onChange={(v) => setEnvironment({density: v})} decimals={2} unit="kg/m³" min={0} max={5} /></label>
          <RangeInput min="0" max="5" step="0.01" value={density} onChange={(v) => setEnvironment({density: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Friction <SliderValue value={floorFriction} onChange={(v) => setEnvironment({floorFriction: v})} decimals={2} min={0} max={2} /></label>
          <RangeInput min="0" max="2" step="0.01" value={floorFriction} onChange={(v) => setEnvironment({floorFriction: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Bounciness <SliderValue value={floorBounce ?? 0} onChange={(v) => setEnvironment({floorBounce: v})} decimals={2} min={0} max={1} /></label>
          <RangeInput min="0" max="1" step="0.01" value={floorBounce ?? 0} onChange={(v) => setEnvironment({floorBounce: v})} className="w-full accent-blue-500 cursor-pointer" />
        </div>
        {/* Contact fidelity. Print is for millimetre parts that have to
            fit: stiffer contact, and pins colliding with their holes
            exactly. A property of the scene, so it is undone and saved
            with it. */}
        <div className="flex items-center justify-between gap-2">
          <span id="fidelityLabel" className="text-xs font-medium text-slate-500 dark:text-slate-400" title="Print: contact stiff enough for millimetre clearances, and pegs and dowels that really go into their holes. For split parts and anything else that has to fit together.">Print Fidelity</span>
          <button
            type="button"
            role="switch"
            aria-checked={simFidelity === 'print'}
            aria-labelledby="fidelityLabel"
            title="Print: contact stiff enough for millimetre clearances, and pegs and dowels that really go into their holes. For split parts and anything else that has to fit together."
            onClick={() => setSimFidelity(simFidelity === 'print' ? 'standard' : 'print')}
            className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${simFidelity === 'print' ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${simFidelity === 'print' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="geminiApiKey" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
              🔑 Google Gemini API Key
            </label>
            <input 
              type="password" 
              id="geminiApiKey"
              value={llm.settingsGeminiKey} 
              onChange={(e) => llm.handleUpdateGeminiKeyInSettings(e.target.value)} 
              placeholder="Paste AIzaSy... here" 
              className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="claudeApiKey" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
              🔑 Anthropic Claude API Key
            </label>
            <input 
              type="password" 
              id="claudeApiKey"
              value={llm.settingsClaudeKey} 
              onChange={(e) => llm.handleUpdateClaudeKeyInSettings(e.target.value)} 
              placeholder="Paste sk-ant-... here" 
              className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono" 
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="geminiModel" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
              🤖 Copilot AI Model
            </label>
            <select 
              id="geminiModel"
              value={llm.settingsSelectedModel} 
              onChange={(e) => llm.selectModel(e.target.value)} 
              className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer" 
            >
              <optgroup label="Google Gemini">
                {llm.liveSettingsGeminiModels.length > 0 ? (
                  llm.liveSettingsGeminiModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))
                ) : (
                  <>
                    <option value="gemini-3.6-flash">Gemini 3.6 Flash (Recommended)</option>
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                  </>
                )}
              </optgroup>
              <optgroup label="Anthropic Claude">
                {llm.liveSettingsClaudeModels.length > 0 ? (
                  llm.liveSettingsClaudeModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))
                ) : (
                  <>
                    <option value="claude-opus-5">Claude Opus 5</option>
                    <option value="claude-sonnet-5">Claude Sonnet 5</option>
                    <option value="claude-fable-5">Claude Fable 5</option>
                    <option value="claude-3-7-sonnet-20250219">Claude 3.7 Sonnet</option>
                    <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                  </>
                )}
              </optgroup>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="copilotMaxTokens" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center justify-between gap-1">
              <span>📏 Copilot Max Response Tokens</span>
              <span className="font-mono normal-case tracking-normal text-slate-600 dark:text-slate-300">{llm.settingsMaxTokens.toLocaleString()}</span>
            </label>
            <RangeInput
              id="copilotMaxTokens"
              min={MIN_MAX_TOKENS}
              max={MAX_MAX_TOKENS}
              step={1000}
              value={llm.settingsMaxTokens}
              onChange={llm.setMaxTokens}
              className="w-full accent-blue-500 cursor-pointer"
            />
            <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-snug">
              Output budget for one copilot reply. Raise this if scene changes come back cut off; lower it to cut cost and latency.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
