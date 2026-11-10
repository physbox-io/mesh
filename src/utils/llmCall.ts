// One request to the copilot's model, Gemini or Claude, with pictures if any.
//
// Shared by the copilot panel and the picture-to-part loop, so both read the
// keys, the model and the reply budget the same way, and both get the same
// answer to "was the reply cut off?". Errors are thrown with the provider's own
// message; the caller decides how to show them.

import { anthropicUrl, geminiUrl } from './llmEndpoints';
import { readMaxTokens, ANTHROPIC_KEY, GEMINI_KEY, MODEL_KEY } from './llmSettings';

/** A picture for the model: base64 bytes and their media type. */
export interface LlmImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string;
}

export interface LlmResult {
  text: string;
  /** The reply hit the token budget: any JSON at its end is incomplete. */
  truncated: boolean;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Shown to the model before the text, in order. */
  images?: LlmImage[];
  /** Defaults to the saved model, keys and budget. */
  model?: string;
  geminiKey?: string;
  claudeKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export const DEFAULT_MODEL = 'gemini-3.6-flash';

const stored = (key: string): string => {
  try {
    return localStorage.getItem(key)?.trim() || '';
  } catch {
    return '';
  }
};

export const savedModel = (): string => stored(MODEL_KEY) || DEFAULT_MODEL;
export const isClaudeModel = (model: string): boolean => model.startsWith('claude');

/** The key the request needs, or a sentence saying which one is missing. */
export function keyFor(model: string, geminiKey?: string, claudeKey?: string): { key: string } | { missing: string } {
  if (isClaudeModel(model)) {
    const key = claudeKey?.trim() || stored(ANTHROPIC_KEY);
    return key ? { key } : { missing: 'Please configure your Anthropic Claude API Key in Global Settings or the setup drawer below.' };
  }
  const key = geminiKey?.trim() || stored(GEMINI_KEY);
  return key ? { key } : { missing: 'Please configure your Google Gemini API Key in Global Settings or the setup drawer below.' };
}

export async function callLlm(req: LlmRequest): Promise<LlmResult> {
  const model = req.model || savedModel();
  const found = keyFor(model, req.geminiKey, req.claudeKey);
  if ('missing' in found) throw new Error(found.missing);
  const maxTokens = req.maxTokens ?? readMaxTokens();
  const images = req.images ?? [];

  if (isClaudeModel(model)) {
    const content = images.length
      ? [
          ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
          { type: 'text', text: req.user },
        ]
      : req.user;
    const response = await fetch(anthropicUrl('/v1/messages'), {
      method: 'POST',
      signal: req.signal,
      headers: {
        'x-api-key': found.key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: req.system, messages: [{ role: 'user', content }] }),
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || json.error.type || 'Claude API Error');
    const text = Array.isArray(json.content)
      ? (json.content as { type: string; text?: string }[]).filter((b) => b.type === 'text' && !!b.text).map((b) => b.text).join('\n')
      : '';
    if (!text.trim()) {
      throw new Error(json.stop_reason === 'refusal' ? 'The model declined to answer this request.' : 'The model returned an empty response.');
    }
    return { text, truncated: json.stop_reason === 'max_tokens' };
  }

  const parts = [
    ...images.map((im) => ({ inline_data: { mime_type: im.mediaType, data: im.data } })),
    { text: `${req.system}\n\nUser Request: ${req.user}` },
  ];
  const response = await fetch(geminiUrl(`/v1beta/models/${model}:generateContent?key=${found.key}`), {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens } }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  const candidate = json.candidates?.[0];
  // Every text part, not just parts[0]: thinking models routinely split a
  // reply across parts, and taking only the first one dropped whatever
  // followed - usually the trailing JSON block the scene update needs.
  const text = Array.isArray(candidate?.content?.parts)
    ? (candidate.content.parts as { text?: string }[]).filter((pt) => typeof pt?.text === 'string' && !!pt.text).map((pt) => pt.text).join('\n')
    : '';
  if (!text.trim()) {
    const blockReason = json.promptFeedback?.blockReason || candidate?.finishReason;
    throw new Error(blockReason ? `The model returned no content (${blockReason}).` : 'The model returned an empty response.');
  }
  return { text, truncated: candidate?.finishReason === 'MAX_TOKENS' };
}
