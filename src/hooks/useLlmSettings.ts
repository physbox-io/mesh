import { useEffect, useRef, useState } from 'react';
import {
  readMaxTokens,
  writeMaxTokens,
  pushGlobalParameter,
  readStorageString,
  writeStorageString,
  GEMINI_KEY,
  ANTHROPIC_KEY,
  MODEL_KEY,
} from '../utils/llmSettings';
import { anthropicUrl, geminiUrl } from '../utils/llmEndpoints';
import { DEFAULT_MODEL } from '../utils/llmCall';

type GeminiModelInfo = { name: string; displayName?: string; supportedGenerationMethods?: string[] };
export type LlmModelOption = { id: string; name: string };

const KEY_FETCH_DEBOUNCE_MS = 400;

const isAbortError = (e: unknown): boolean =>
  e instanceof DOMException
    ? e.name === 'AbortError'
    : typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';

/**
 * The copilot's keys, model and reply budget, as the settings popover edits
 * them. Each lives in localStorage; a write fires a `storage` event so the
 * copilot panel, which reads them too, picks it up. When `enabled` is true and
 * a key is present, the model list is fetched live (debounced) from that
 * provider.
 */
export function useLlmSettings(enabled = true) {
  const [settingsGeminiKey, setSettingsGeminiKey] = useState(() => readStorageString(GEMINI_KEY));
  const [settingsClaudeKey, setSettingsClaudeKey] = useState(() => readStorageString(ANTHROPIC_KEY));
  const [settingsSelectedModel, setSettingsSelectedModel] = useState(() => readStorageString(MODEL_KEY, DEFAULT_MODEL) || DEFAULT_MODEL);
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(() => readMaxTokens());
  const [liveSettingsClaudeModels, setLiveSettingsClaudeModels] = useState<LlmModelOption[]>([]);
  const [liveSettingsGeminiModels, setLiveSettingsGeminiModels] = useState<LlmModelOption[]>([]);

  const lastFetchedGeminiKeyRef = useRef<string>('');
  const lastFetchedClaudeKeyRef = useRef<string>('');
  const claudeKeyEditedRef = useRef<boolean>(false);

  const fetchSettingsClaudeModels = async (key: string, signal?: AbortSignal) => {
    if (!key.trim()) return null;
    const headers = {
      'x-api-key': key.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    try {
      const res = await fetch(anthropicUrl('/v1/models'), { headers, signal });
      if (!res.ok) return null;
      const data = await res.json();
      const rawModels = data.data || data.models || [];
      if (Array.isArray(rawModels) && rawModels.length > 0) {
        const formatted = rawModels.map((m: { id: string; name?: string; display_name?: string }) => ({
          id: m.id,
          name: m.display_name || m.name || m.id
        }));
        if (!signal?.aborted) {
          setLiveSettingsClaudeModels(formatted);
        }
        return formatted;
      }
    } catch (e) {
      if (!isAbortError(e)) {
        console.warn("Failed to fetch Claude models in settings", e);
      }
    }
    return null;
  };

  const fetchSettingsGeminiModels = async (key: string, signal?: AbortSignal) => {
    if (!key.trim()) return null;
    try {
      const res = await fetch(geminiUrl('/v1beta/models'), {
        headers: { 'x-goog-api-key': key.trim() },
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.models && Array.isArray(data.models)) {
        const validModels = data.models
          .filter((m: GeminiModelInfo) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m: GeminiModelInfo) => ({
            id: m.name.replace(/^models\//, ''),
            name: m.displayName || m.name.replace(/^models\//, '')
          }));
        if (validModels.length > 0) {
          if (!signal?.aborted) {
            setLiveSettingsGeminiModels(validModels);
          }
          return validModels;
        }
      }
    } catch (e) {
      if (!isAbortError(e)) {
        console.warn("Failed to fetch Gemini models in settings", e);
      }
    }
    return null;
  };

  useEffect(() => {
    // Sync localStorage state only; model fetching is handled by the debounced
    // key effects below so slider drags and model changes never re-fetch.
    const syncSettingsState = () => {
      const gk = readStorageString(GEMINI_KEY);
      const ck = readStorageString(ANTHROPIC_KEY);
      const m = readStorageString(MODEL_KEY, DEFAULT_MODEL) || DEFAULT_MODEL;
      setSettingsGeminiKey(gk);
      setSettingsClaudeKey(ck);
      setSettingsSelectedModel(m);
      setSettingsMaxTokens(readMaxTokens());
    };

    syncSettingsState();
    window.addEventListener('storage', syncSettingsState);
    return () => window.removeEventListener('storage', syncSettingsState);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const trimmed = settingsGeminiKey.trim();
    if (!trimmed) {
      lastFetchedGeminiKeyRef.current = '';
      return;
    }
    if (trimmed === lastFetchedGeminiKeyRef.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchSettingsGeminiModels(trimmed, controller.signal).then((live) => {
        if (!controller.signal.aborted && live && live.length > 0) {
          lastFetchedGeminiKeyRef.current = trimmed;
        }
      });
    }, KEY_FETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, settingsGeminiKey]);

  useEffect(() => {
    if (!enabled) return;
    const trimmed = settingsClaudeKey.trim();
    if (!trimmed) {
      lastFetchedClaudeKeyRef.current = '';
      return;
    }
    if (trimmed === lastFetchedClaudeKeyRef.current) return;
    const shouldSelectTop = claudeKeyEditedRef.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchSettingsClaudeModels(trimmed, controller.signal).then((live) => {
        if (controller.signal.aborted) return;
        if (live && live.length > 0) {
          lastFetchedClaudeKeyRef.current = trimmed;
          claudeKeyEditedRef.current = false;
          if (shouldSelectTop) {
            const topModel = live[0].id;
            setSettingsSelectedModel(topModel);
            writeStorageString(MODEL_KEY, topModel);
            pushGlobalParameter(MODEL_KEY, topModel);
            window.dispatchEvent(new Event('storage'));
          }
        }
      });
    }, KEY_FETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, settingsClaudeKey]);

  const handleUpdateClaudeKeyInSettings = (newKey: string) => {
    claudeKeyEditedRef.current = true;
    setSettingsClaudeKey(newKey);
    writeStorageString(ANTHROPIC_KEY, newKey);
    pushGlobalParameter(ANTHROPIC_KEY, newKey);
    window.dispatchEvent(new Event('storage'));
  };

  const handleUpdateGeminiKeyInSettings = (newKey: string) => {
    setSettingsGeminiKey(newKey);
    writeStorageString(GEMINI_KEY, newKey);
    pushGlobalParameter(GEMINI_KEY, newKey);
    window.dispatchEvent(new Event('storage'));
  };

  const selectModel = (modelId: string) => {
    setSettingsSelectedModel(modelId);
    writeStorageString(MODEL_KEY, modelId);
    pushGlobalParameter(MODEL_KEY, modelId);
    window.dispatchEvent(new Event('storage'));
  };

  const setMaxTokens = (v: number) => {
    const next = writeMaxTokens(Math.round(v));
    setSettingsMaxTokens(next);
    window.dispatchEvent(new Event('storage'));
  };

  return {
    settingsGeminiKey, settingsClaudeKey, settingsSelectedModel, settingsMaxTokens,
    liveSettingsClaudeModels, liveSettingsGeminiModels,
    handleUpdateClaudeKeyInSettings, handleUpdateGeminiKeyInSettings, selectModel, setMaxTokens,
  };
}
