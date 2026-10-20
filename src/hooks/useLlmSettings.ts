import { useEffect, useRef, useState } from 'react';
import { readMaxTokens, writeMaxTokens, pushGlobalParameter } from '../utils/llmSettings';
import { anthropicUrl, geminiUrl } from '../utils/llmEndpoints';

type GeminiModelInfo = { name: string; displayName?: string; supportedGenerationMethods?: string[] };
export type LlmModelOption = { id: string; name: string };

const KEY_FETCH_DEBOUNCE_MS = 400;

/**
 * The copilot's keys, model and reply budget, as the settings popover edits
 * them. Each lives in localStorage; a write fires a `storage` event so the
 * copilot panel, which reads them too, picks it up. When `enabled` is true and
 * a key is present, the model list is fetched live (debounced) from that
 * provider.
 */
export function useLlmSettings(enabled = true) {
  const [settingsGeminiKey, setSettingsGeminiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [settingsClaudeKey, setSettingsClaudeKey] = useState(() => localStorage.getItem('anthropic_api_key') || '');
  const [settingsSelectedModel, setSettingsSelectedModel] = useState(() => localStorage.getItem('gemini_model') || 'gemini-3.6-flash');
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(() => readMaxTokens());
  const [liveSettingsClaudeModels, setLiveSettingsClaudeModels] = useState<LlmModelOption[]>([]);
  const [liveSettingsGeminiModels, setLiveSettingsGeminiModels] = useState<LlmModelOption[]>([]);

  const lastFetchedGeminiKeyRef = useRef<string>('');
  const lastFetchedClaudeKeyRef = useRef<string>('');
  const claudeKeyEditedRef = useRef<boolean>(false);

  const fetchSettingsClaudeModels = async (key: string) => {
    if (!key.trim()) return null;
    const headers = {
      'x-api-key': key.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    try {
      const res = await fetch(anthropicUrl('/v1/models'), { headers });
      if (res.ok) {
        const data = await res.json();
        const rawModels = data.data || data.models || [];
        if (Array.isArray(rawModels) && rawModels.length > 0) {
          const formatted = rawModels.map((m: { id: string; name?: string; display_name?: string }) => ({
            id: m.id,
            name: m.display_name || m.name || m.id
          }));
          setLiveSettingsClaudeModels(formatted);
          return formatted;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Claude models in settings", e);
    }
    return null;
  };

  const fetchSettingsGeminiModels = async (key: string) => {
    if (!key.trim()) return null;
    try {
      const res = await fetch(geminiUrl(`/v1beta/models?key=${key.trim()}`));
      const data = await res.json();
      if (data.models && Array.isArray(data.models)) {
        const validModels = data.models
          .filter((m: GeminiModelInfo) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m: GeminiModelInfo) => ({
            id: m.name.replace(/^models\//, ''),
            name: m.displayName || m.name.replace(/^models\//, '')
          }));
        if (validModels.length > 0) {
          setLiveSettingsGeminiModels(validModels);
          return validModels;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Gemini models in settings", e);
    }
    return null;
  };

  useEffect(() => {
    // Sync localStorage state only; model fetching is handled by the debounced
    // key effects below so slider drags and model changes never re-fetch.
    const syncSettingsState = () => {
      const gk = localStorage.getItem('gemini_api_key') || '';
      const ck = localStorage.getItem('anthropic_api_key') || '';
      const m = localStorage.getItem('gemini_model') || 'gemini-3.6-flash';
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
    if (!trimmed || trimmed === lastFetchedGeminiKeyRef.current) return;
    const timer = setTimeout(() => {
      lastFetchedGeminiKeyRef.current = trimmed;
      void fetchSettingsGeminiModels(trimmed);
    }, KEY_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, settingsGeminiKey]);

  useEffect(() => {
    if (!enabled) return;
    const trimmed = settingsClaudeKey.trim();
    if (!trimmed || trimmed === lastFetchedClaudeKeyRef.current) return;
    const shouldSelectTop = claudeKeyEditedRef.current;
    const timer = setTimeout(() => {
      lastFetchedClaudeKeyRef.current = trimmed;
      claudeKeyEditedRef.current = false;
      void fetchSettingsClaudeModels(trimmed).then((live) => {
        if (shouldSelectTop && live && live.length > 0) {
          const topModel = live[0].id;
          setSettingsSelectedModel(topModel);
          localStorage.setItem('gemini_model', topModel);
          pushGlobalParameter('gemini_model', topModel);
          window.dispatchEvent(new Event('storage'));
        }
      });
    }, KEY_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, settingsClaudeKey]);

  const handleUpdateClaudeKeyInSettings = (newKey: string) => {
    claudeKeyEditedRef.current = true;
    setSettingsClaudeKey(newKey);
    localStorage.setItem('anthropic_api_key', newKey);
    pushGlobalParameter('anthropic_api_key', newKey);
    window.dispatchEvent(new Event('storage'));
  };

  const handleUpdateGeminiKeyInSettings = (newKey: string) => {
    setSettingsGeminiKey(newKey);
    localStorage.setItem('gemini_api_key', newKey);
    pushGlobalParameter('gemini_api_key', newKey);
    window.dispatchEvent(new Event('storage'));
  };

  const selectModel = (modelId: string) => {
    setSettingsSelectedModel(modelId);
    localStorage.setItem('gemini_model', modelId);
    pushGlobalParameter('gemini_model', modelId);
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
