// Reading a copilot reply: the prose, and the JSON blocks it carries (nodes,
// questions, proposed modifications, the note card). Shared by the copilot
// panel and the picture-to-part loop.

import type { RawNode } from './sceneNodes';

export interface DiagnosticQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface ProposedModification {
  id: string;
  text: string;
  selected: boolean;
}

export const cleanLaTeXMath = (str: string): string => {
  if (!str) return '';
  return str
    .replace(/\\text\s*\{\s*([^}]+)\s*\}/g, '$1')
    .replace(/\\mathrm\s*\{\s*([^}]+)\s*\}/g, '$1')
    .replace(/\\mathbf\s*\{\s*([^}]+)\s*\}/g, '$1')
    .replace(/\\mathit\s*\{\s*([^}]+)\s*\}/g, '$1')
    .replace(/\$\s*([^$]+?)\s*\$/g, '$1')
    .replace(/\\\(\s*([\s\S]+?)\s*\\\)/g, '$1')
    .replace(/\\sim\s*/g, '~')
    .replace(/\\times\s*/g, '×')
    .replace(/\\pm\s*/g, '±')
    .replace(/\\degree\s*/g, '°');
};

const cleanJSONString = (str: string): string => {
  return str.replace(/,\s*([\]}])/g, '$1'); // Only remove trailing commas before ] or }
};

export const extractJSON = (text: string): unknown => {
  if (!text) return null;

  // 1. Check for code blocks ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]) {
      const code = match[1].trim();
      try {
        return JSON.parse(code);
      } catch {
        try {
          return JSON.parse(cleanJSONString(code));
        } catch {
          // ignore
        }
      }
    }
  }

  // 2. Search for outermost JSON Array [...]
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    const candidate = text.substring(arrayStart, arrayEnd + 1).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(cleanJSONString(candidate));
      } catch {
        // ignore
      }
    }
  }

  // 3. Search for outermost JSON Object {...}
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    const candidate = text.substring(objStart, objEnd + 1).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(cleanJSONString(candidate));
      } catch {
        // ignore
      }
    }
  }

  return null;
};

// Distinguishes a bare `nodes` array from the other bare arrays a response can
// carry. Anything that identifies a body - an id/name, or any of the structural
// keys - counts, so a minimal positional tweak is accepted; question and
// modification objects are excluded by shape.
const isLikelyNodeArray = (arr: unknown[]): boolean =>
  arr.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const obj = item as Record<string, unknown>;
    return obj.question === undefined && obj.options === undefined && obj.text === undefined &&
      (obj.id !== undefined || obj.name !== undefined ||
       obj.geoms !== undefined || obj.joints !== undefined || obj.scad !== undefined ||
       obj.pos !== undefined || obj.euler !== undefined || obj.type === 'body');
  });

export interface ParseAIResponseOptions {
  /**
   * When true, fall back to scraping bullet lists under proposal/recommendation
   * headings if no structured `proposedModifications` JSON block was returned.
   * Only enable for turns that explicitly ask for proposed modifications.
   */
  extractBulletModifications?: boolean;
}

export const parseAIResponse = (text: string, options?: ParseAIResponseOptions): {
  markdown: string;
  questions: DiagnosticQuestion[];
  proposedModifications: ProposedModification[];
  nodes: RawNode[] | null;
  noteCardMarkdown: string | null;
} => {
  let questions: DiagnosticQuestion[] = [];
  let proposedModifications: ProposedModification[] = [];
  let nodes: RawNode[] | null = null;
  let noteCardMarkdown: string | null = null;

  // Scan fenced code blocks. Only attempt JSON parsing on unlabeled or `json`
  // fences so non-JSON fences (e.g. ```scad) are preserved verbatim.
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const rangesToRemove: Array<[number, number]> = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    if (lang !== '' && lang !== 'json') continue;
    const code = (match[2] || '').trim();
    if (!code) continue;
    const start = match.index;
    const end = match.index + match[0].length;
    try {
      const parsed = extractJSON(code);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>;
        let matchedStructuredBlock = false;

        if (!noteCardMarkdown) {
          if (typeof p.noteCardMarkdown === 'string') {
            noteCardMarkdown = p.noteCardMarkdown;
            matchedStructuredBlock = true;
          } else if (typeof p.noteCard === 'string') {
            noteCardMarkdown = p.noteCard;
            matchedStructuredBlock = true;
          } else if (typeof p.notecard === 'string') {
            noteCardMarkdown = p.notecard;
            matchedStructuredBlock = true;
          }
        }

        if (questions.length === 0 && Array.isArray(p.questions)) {
          questions = (p.questions as Record<string, unknown>[]).map((q, idx: number) => ({
            id: (typeof q.id === 'string' ? q.id : '') || `q_${idx}`,
            question: cleanLaTeXMath(typeof q.question === 'string' ? q.question : ''),
            options: Array.isArray(q.options) && q.options.length > 0
              ? q.options.map((o: unknown) => cleanLaTeXMath(String(o)))
              : undefined
          })).filter((q) => q.question.trim().length > 0);
          matchedStructuredBlock = true;
        }

        if (proposedModifications.length === 0 && Array.isArray(p.proposedModifications)) {
          proposedModifications = (p.proposedModifications as (Record<string, unknown> | string)[]).map((m, idx: number) => ({
            id: (typeof m === 'object' && m && typeof m.id === 'string' ? m.id : '') || `m_${idx}`,
            text: typeof m === 'string' ? cleanLaTeXMath(m) : cleanLaTeXMath(String(m.text || m.description || m)),
            selected: true
          })).filter((m: ProposedModification) => m.text.trim().length > 0);
          matchedStructuredBlock = true;
        }

        if (nodes === null) {
          if (Array.isArray(p.nodes)) {
            nodes = p.nodes as RawNode[];
            matchedStructuredBlock = true;
          // A bare array is nodes if it isn't one of the other two shapes we
          // accept (questions / proposedModifications). The old test demanded
          // geoms|joints|scad|type on the first element, which threw away the
          // most natural way to express a small mutation - [{"id": "...",
          // "pos": [0,0,0.3]}] - leaving nodes null while the chat still
          // reported the change as applied.
          } else if (Array.isArray(parsed) && parsed.length > 0 && isLikelyNodeArray(parsed)) {
            nodes = parsed as RawNode[];
            matchedStructuredBlock = true;
          }
        }

        if (matchedStructuredBlock) {
          rangesToRemove.push([start, end]);
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Remove only structured JSON blocks that were consumed, from back to front,
  // before running cleanLaTeXMath (so non-JSON blocks like ```scad survive and
  // LaTeX cleanup never alters indices).
  let stripped = text;
  for (let i = rangesToRemove.length - 1; i >= 0; i--) {
    const [start, end] = rangesToRemove[i];
    stripped = stripped.slice(0, start) + stripped.slice(end);
  }

  // Fallback logic: only run when caller explicitly expects proposed modifications.
  if (options?.extractBulletModifications && proposedModifications.length === 0) {
    const lines = stripped.split('\n');
    let inPropsSection = false;

    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim();
      if (trimmed.match(/^(?:#+\s*|\*\*\s*|\b)(propos|recommend|suggest|plan|next steps|improvement|analys|diagnos|finding|issue|stability|fix|modificat)/i)) {
        inPropsSection = true;
      } else if (trimmed.match(/^#+\s/) && !trimmed.match(/(propos|recommend|suggest|plan|next steps|improvement|analys|diagnos|finding|issue|stability|fix|modificat)/i)) {
        inPropsSection = false;
      } else if (inPropsSection && (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.match(/^\d+\.\s/))) {
        const itemText = trimmed.replace(/^[*\-\d.]+\s*/, '').trim();
        if (itemText.length > 5) {
          proposedModifications.push({
            id: `mod_${lineIdx}`,
            text: cleanLaTeXMath(itemText),
            selected: true
          });
        }
      }
    });
  }

  const cleanMarkdown = cleanLaTeXMath(stripped.trim());

  return { markdown: cleanMarkdown, questions, proposedModifications, nodes, noteCardMarkdown };
};
