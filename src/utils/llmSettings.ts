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
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
  return clamped;
};
