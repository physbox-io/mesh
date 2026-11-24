// Copilot LLM output budget, shared by the Global Settings panel (which writes
// it) and AICopilotPanel (which reads it on every request).
//
// This is a user-visible setting because the failure it controls is silent and
// expensive: when a scene's JSON doesn't fit in the reply, the response is
// truncated mid-structure, the nodes block fails to parse, and the copilot used
// to report success anyway. A large SCAD scene can need far more than the old
// hard-coded 16384.

export const MAX_TOKENS_STORAGE_KEY = 'copilot_max_tokens';

export const DEFAULT_MAX_TOKENS = 16384;
export const MIN_MAX_TOKENS = 2000;
export const MAX_MAX_TOKENS = 100000;

export const clampMaxTokens = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
};

/** Known per-model output token ceilings so requests never fail on model caps. */
export const modelMaxOutputTokens = (model: string): number => {
  const m = (model || '').toLowerCase();
  if (/^claude-3-5-/.test(m)) return 8192;
  if (/^claude-3-(opus|sonnet|haiku)/.test(m)) return 4096;
  if (/^claude-3-7-/.test(m)) return 64000;
  if (/^claude-/.test(m)) return 64000;
  if (/^gemini-(1\.5|2\.0)-/.test(m)) return 8192;
  return MAX_MAX_TOKENS;
};

/** Clamps `value` to both the global budget range and the target model's ceiling. */
export const clampMaxTokensForModel = (value: number, model: string): number => {
  const base = clampMaxTokens(value);
  return Math.min(base, modelMaxOutputTokens(model));
};

/** Safe localStorage read that returns `fallback` in sandboxed/private contexts. */
export const readStorageString = (key: string, fallback = ''): string => {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? raw : fallback;
  } catch {
    return fallback;
  }
};

/** Safe localStorage write that ignores storage errors in sandboxed/private contexts. */
export const writeStorageString = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
};

/** Reads the configured budget, falling back to the default on absent/garbage values. */
export const readMaxTokens = (): number => {
  try {
    const raw = localStorage.getItem(MAX_TOKENS_STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_MAX_TOKENS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
    return clampMaxTokens(parsed);
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts.
    return DEFAULT_MAX_TOKENS;
  }
};

export const writeMaxTokens = (value: number): number => {
  const clamped = clampMaxTokens(value);
  try {
    localStorage.setItem(MAX_TOKENS_STORAGE_KEY, String(clamped));
    pushGlobalParameter(MAX_TOKENS_STORAGE_KEY, clamped);
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
  return clamped;
};

// --- Cloud sync -------------------------------------------------------------

export const GEMINI_KEY = 'gemini_api_key';
export const ANTHROPIC_KEY = 'anthropic_api_key';
export const MODEL_KEY = 'gemini_model';

/**
 * The copilot settings that follow the account, under the `global` app id.
 *
 * An allowlist rather than "whatever is in localStorage", for two reasons: what
 * comes back from the server is only ever written to these keys, never to
 * whatever key name the response happens to carry; and it keeps the decision
 * about what leaves the machine in one visible place.
 *
 * The names are identical to the ones `etch` syncs, deliberately — `global` is
 * a single shared namespace, so the copilot keys set in one app are the ones
 * the other finds. Changing a name here silently unpairs the two.
 */
export const SYNCED_LLM_PARAMETER_KEYS: readonly string[] = [
  GEMINI_KEY,
  ANTHROPIC_KEY,
  MODEL_KEY,
  MAX_TOKENS_STORAGE_KEY,
];

const pendingParamPushes = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Mirrors one copilot setting to the account.
 *
 * Fire-and-forget, debounced per key so typing an API key or dragging the
 * token-budget slider coalesces into a single cloud write, and a no-op when
 * signed out: the local write has already happened by the time this is called,
 * and a failed upload must never be the reason a setting does not stick.
 */
export const pushGlobalParameter = (key: string, value: string | number): void => {
  const prev = pendingParamPushes.get(key);
  if (prev !== undefined) clearTimeout(prev);
  pendingParamPushes.set(
    key,
    setTimeout(() => {
      pendingParamPushes.delete(key);
      void import('./apiClient').then(({ syncCloudParameters }) => {
        void syncCloudParameters('global', { [key]: value });
      });
    }, 400),
  );
};
