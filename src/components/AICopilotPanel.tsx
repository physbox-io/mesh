import { useState, useEffect, useRef } from 'react';
import { X, Brain, Wand2, Loader2, AlertCircle, HelpCircle, Activity, Printer, Send, CheckCircle2, RefreshCw, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import { compileSCAD } from '../utils/openscad';
import { updateOrCreateNotecard } from '../utils/noteCards';
import { mergeAndNormalizeNodes } from '../utils/sceneNodes';
import { readMaxTokens } from '../utils/llmSettings';
import SYSTEM_INSTRUCTIONS from './systemInstructions.txt?raw';
import { pushGlobalParameter } from '../utils/llmSettings';

interface AICopilotPanelProps {
  onClose: () => void;
  messages?: ChatMessage[];
  setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

interface DiagnosticQuestion {
  id: string;
  question: string;
  options?: string[];
}

interface ProposedModification {
  id: string;
  text: string;
  selected: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  mode?: 'explain' | 'generate' | 'mutate' | 'implement';
  content: string;
  questions?: DiagnosticQuestion[];
  userAnswers?: Record<string, string>;
  userAnswersSubmitted?: boolean;
  proposedModifications?: ProposedModification[];
  nodes?: any[] | null;
  isImplemented?: boolean;
  hasError?: boolean;
  errorMsg?: string;
  timestamp: number;
}

const cleanLaTeXMath = (str: string): string => {
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

const extractJSON = (text: string): any => {
  if (!text) return null;

  // 1. Check for code blocks ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]) {
      const code = match[1].trim();
      try {
        return JSON.parse(code);
      } catch (e) {
        try {
          return JSON.parse(cleanJSONString(code));
        } catch (e2) {}
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
    } catch (e) {
      try {
        return JSON.parse(cleanJSONString(candidate));
      } catch (e2) {}
    }
  }

  // 3. Search for outermost JSON Object {...}
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    const candidate = text.substring(objStart, objEnd + 1).trim();
    try {
      return JSON.parse(candidate);
    } catch (e) {
      try {
        return JSON.parse(cleanJSONString(candidate));
      } catch (e2) {}
    }
  }

  return null;
};

// Distinguishes a bare `nodes` array from the other bare arrays a response can
// carry. Anything that identifies a body - an id/name, or any of the structural
// keys - counts, so a minimal positional tweak is accepted; question and
// modification objects are excluded by shape.
const isLikelyNodeArray = (arr: any[]): boolean =>
  arr.every(item =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    item.question === undefined && item.options === undefined && item.text === undefined &&
    (item.id !== undefined || item.name !== undefined ||
     item.geoms !== undefined || item.joints !== undefined || item.scad !== undefined ||
     item.pos !== undefined || item.euler !== undefined || item.type === 'body')
  );

const parseAIResponse = (text: string): {
  markdown: string;
  questions: DiagnosticQuestion[];
  proposedModifications: ProposedModification[];
  nodes: any[] | null;
  noteCardMarkdown: string | null;
} => {
  let questions: DiagnosticQuestion[] = [];
  let proposedModifications: ProposedModification[] = [];
  let nodes: any[] | null = null;
  let noteCardMarkdown: string | null = null;
  let markdown = cleanLaTeXMath(text);

  // Scan code blocks for questions, proposedModifications, or nodes
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match;
  const blocksToRemove: string[] = [];
  const jsonMatches: RegExpExecArray[] = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    jsonMatches.push(match);
  }

  for (const match of jsonMatches) {
    const fullMatch = match[0];
    const code = match[1].trim();
    try {
      const parsed = extractJSON(code);
      if (parsed && typeof parsed === 'object') {
        if (!noteCardMarkdown) {
          if (typeof parsed.noteCardMarkdown === 'string') noteCardMarkdown = parsed.noteCardMarkdown;
          else if (typeof parsed.noteCard === 'string') noteCardMarkdown = parsed.noteCard;
          else if (typeof parsed.notecard === 'string') noteCardMarkdown = parsed.notecard;
        }

        if (questions.length === 0 && Array.isArray(parsed.questions)) {
          questions = parsed.questions.map((q: any, idx: number) => ({
            id: q.id || `q_${idx}`,
            question: cleanLaTeXMath(q.question || ''),
            options: Array.isArray(q.options) && q.options.length > 0
              ? q.options.map((o: any) => cleanLaTeXMath(String(o)))
              : undefined
          })).filter((q: any) => q.question.trim().length > 0);
          blocksToRemove.push(fullMatch);
        }

        if (proposedModifications.length === 0 && Array.isArray(parsed.proposedModifications)) {
          proposedModifications = parsed.proposedModifications.map((m: any, idx: number) => ({
            id: m.id || `m_${idx}`,
            text: typeof m === 'string' ? cleanLaTeXMath(m) : cleanLaTeXMath(m.text || m.description || String(m)),
            selected: true
          })).filter((m: ProposedModification) => m.text.trim().length > 0);
          blocksToRemove.push(fullMatch);
        }

        if (nodes === null) {
          if (Array.isArray(parsed.nodes)) {
            nodes = parsed.nodes;
            blocksToRemove.push(fullMatch);
          // A bare array is nodes if it isn't one of the other two shapes we
          // accept (questions / proposedModifications). The old test demanded
          // geoms|joints|scad|type on the first element, which threw away the
          // most natural way to express a small mutation - [{"id": "...",
          // "pos": [0,0,0.3]}] - leaving nodes null while the chat still
          // reported the change as applied.
          } else if (Array.isArray(parsed) && parsed.length > 0 && isLikelyNodeArray(parsed)) {
            nodes = parsed;
            blocksToRemove.push(fullMatch);
          }
        }
      }
    } catch (e) {}
  }

  for (const block of blocksToRemove) {
    markdown = markdown.replace(block, '').trim();
  }

  // Fallback logic
  if (proposedModifications.length === 0) {
    const lines = text.split('\n');
    let inPropsSection = false;

    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim();
      if (trimmed.match(/^(?:#+|\*\*|\b)(propos|recommend|suggest|plan|next steps|improvement|analys|diagnos|finding|issue|stability|fix|modificat)/i)) {
        inPropsSection = true;
      } else if (trimmed.match(/^#+\s/) && !trimmed.match(/(propos|recommend|suggest|plan|next steps|improvement|analys|diagnos|finding|issue|stability|fix|modificat)/i)) {
        inPropsSection = false;
      } else if (inPropsSection && (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.match(/^\d+\.\s/))) {
        const itemText = trimmed.replace(/^[\*\-\d\.]+\s*/, '').trim();
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

  let cleanMarkdown = text.replace(/```(?:json)?\s*[\s\S]*?\s*```/gi, '').trim();
  cleanMarkdown = cleanLaTeXMath(cleanMarkdown);

  return { markdown: cleanMarkdown, questions, proposedModifications, nodes, noteCardMarkdown };
};

export default function AICopilotPanel({ onClose, messages: propsMessages, setMessages: propsSetMessages }: AICopilotPanelProps) {
  const sceneGraph = useStore(state => state.sceneGraph);
  const updateScene = useStore(state => state.updateScene);

  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [claudeApiKey, setClaudeApiKey] = useState(() => localStorage.getItem('anthropic_api_key') || '');
  const [selectedModel, setSelectedModel] = useState<string>(() => localStorage.getItem('gemini_model') || 'gemini-3.6-flash');
  const [availableModels, setAvailableModels] = useState<{ id: string; name: string }[]>([]);
  const [availableClaudeModels, setAvailableClaudeModels] = useState<{ id: string; name: string }[]>([]);

  const [prompt, setPrompt] = useState('');
  const [followupInput, setFollowupInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('AI Copilot is processing...');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'explain' | 'generate' | 'mutate'>('explain');
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);

  const messages = propsMessages !== undefined ? propsMessages : localMessages;
  const setMessages = propsSetMessages !== undefined ? propsSetMessages : setLocalMessages;

  const handleClearModeHistory = (targetMode: 'explain' | 'generate' | 'mutate') => {
    setMessages(prev => prev.filter(m => {
      if (targetMode === 'mutate') return m.mode !== 'mutate' && m.mode !== 'implement';
      if (targetMode === 'explain') return m.mode !== 'explain' && m.mode !== undefined;
      return m.mode !== targetMode;
    }));
  };

  const getModeHistoryStr = (targetMode: 'explain' | 'generate' | 'mutate') => {
    const modeMsgs = messages.filter(m => {
      if (targetMode === 'generate') return m.mode === 'generate';
      if (targetMode === 'mutate') return m.mode === 'mutate' || m.mode === 'implement';
      return m.mode === 'explain' || !m.mode;
    }).filter(m => !m.hasError && m.content);

    if (modeMsgs.length === 0) return '';
    return '\n\nPAST ' + targetMode.toUpperCase() + ' CHAT HISTORY:\n' + modeMsgs.map(m => `[${m.role.toUpperCase()}] ${m.content}`).slice(-6).join('\n');
  };

  const getExistingCardContextStr = () => {
    const getter = (window as any)._physics_getNoteCards;
    const cards = getter ? getter() : [];
    if (cards.length > 0 && cards[0].markdown) {
      return `\n\nEXISTING NOTECARD IN SCENE:\n${cards[0].markdown}`;
    }
    return '\n\nEXISTING NOTECARD IN SCENE: None';
  };

  const handleNotecardUpdate = (modeType: 'explain' | 'generate' | 'mutate', promptText?: string, assistantText?: string, noteCardMd?: string | null, targetNodes?: any[] | null) => {
    if (noteCardMd) {
      const getter = (window as any)._physics_getNoteCards;
      const setter = (window as any)._physics_setNoteCards;
      const currentCards = getter ? getter() : [];
      const existingCard = currentCards[0];
      const updatedCard = {
        id: existingCard?.id || `note_card_${Date.now()}`,
        markdown: noteCardMd,
        minimized: false,
        x: 16,
        y: 16
      };
      if (setter) setter([updatedCard, ...currentCards.slice(1)]);
    } else {
      updateOrCreateNotecard({
        mode: modeType,
        userPrompt: promptText,
        assistantMarkdown: assistantText,
        nodes: targetNodes || undefined
      });
    }
  };

  const modeMessages = messages.filter(m => {
    if (mode === 'generate') return m.mode === 'generate';
    if (mode === 'mutate') return m.mode === 'mutate' || m.mode === 'implement';
    return m.mode === 'explain' || !m.mode;
  });

  const responseContainerRef = useRef<HTMLDivElement>(null);

  const fetchAvailableModels = async (key: string) => {
    if (!key.trim()) return;
    try {
      let res = await fetch(`/api/gemini/v1beta/models?key=${key.trim()}`);
      if (!res.ok) {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key.trim()}`);
      }
      const data = await res.json();
      if (data.models && Array.isArray(data.models)) {
        const validModels = data.models
          .filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => ({
            id: m.name.replace(/^models\//, ''),
            name: m.displayName || m.name.replace(/^models\//, '')
          }));

        if (validModels.length > 0) {
          setAvailableModels(validModels);
        }
      }
    } catch (e) {
      console.warn("Failed to dynamically fetch Gemini models", e);
    }
  };

  const fetchAvailableClaudeModels = async (key: string) => {
    if (!key.trim()) return null;
    const headers = {
      'x-api-key': key.trim(),
      'anthropic-version': '2023-06-01',
    };
    try {
      let res = await fetch('/api/anthropic/v1/models', { headers });
      if (!res.ok && res.status === 404) {
        res = await fetch('https://api.anthropic.com/v1/models', {
          headers: { ...headers, 'anthropic-dangerous-direct-browser-access': 'true' }
        });
      }
      if (res.ok) {
        const data = await res.json();
        const rawModels = data.data || data.models || [];
        if (Array.isArray(rawModels) && rawModels.length > 0) {
          const formatted = rawModels.map((m: any) => ({
            id: m.id,
            name: m.display_name || m.name || m.id
          }));
          setAvailableClaudeModels(formatted);
          return formatted;
        }
      }
    } catch (e) {
      console.warn("Failed to dynamically fetch Claude models", e);
    }
    return null;
  };

  useEffect(() => {
    const handleStorageChange = () => {
      const storedGeminiKey = localStorage.getItem('gemini_api_key') || '';
      const storedClaudeKey = localStorage.getItem('anthropic_api_key') || '';
      const storedModel = localStorage.getItem('gemini_model') || 'gemini-3.6-flash';
      setGeminiApiKey(storedGeminiKey);
      setClaudeApiKey(storedClaudeKey);
      setSelectedModel(storedModel);
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  useEffect(() => {
    if (geminiApiKey) {
      fetchAvailableModels(geminiApiKey);
    }
    if (claudeApiKey) {
      fetchAvailableClaudeModels(claudeApiKey);
    }
  }, [geminiApiKey, claudeApiKey]);

  useEffect(() => {
    const handlePresetLoaded = (e: any) => {
      const detail = e.detail;
      if (detail && typeof detail === 'object') {
        const { name, prev } = detail;
        if (name && name !== prev) {
          setMessages([]);
          setError('');
          setPrompt('');
          setFollowupInput('');
        }
      }
    };
    window.addEventListener('physics:preset-loaded', handlePresetLoaded);
    return () => window.removeEventListener('physics:preset-loaded', handlePresetLoaded);
  }, []);

  useEffect(() => {
    if (responseContainerRef.current) {
      responseContainerRef.current.scrollTo({
        top: responseContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [messages, loading]);

  const saveGeminiApiKey = (key: string) => {
    setGeminiApiKey(key);
    localStorage.setItem('gemini_api_key', key);
    pushGlobalParameter('gemini_api_key', key);
    window.dispatchEvent(new Event('storage'));
    if (key.trim()) fetchAvailableModels(key.trim());
  };

  const saveClaudeApiKey = async (key: string) => {
    setClaudeApiKey(key);
    localStorage.setItem('anthropic_api_key', key);
    pushGlobalParameter('anthropic_api_key', key);
    window.dispatchEvent(new Event('storage'));
    if (key.trim()) {
      const liveModels = await fetchAvailableClaudeModels(key.trim());
      if (liveModels && liveModels.length > 0) {
        saveSelectedModel(liveModels[0].id);
      } else if (!selectedModel.startsWith('claude')) {
        saveSelectedModel('claude-opus-5');
      }
    }
  };

  const saveSelectedModel = (modelId: string) => {
    setSelectedModel(modelId);
    localStorage.setItem('gemini_model', modelId);
    pushGlobalParameter('gemini_model', modelId);
    window.dispatchEvent(new Event('storage'));
  };

  // A truncated reply is the single most common way a copilot request fails
  // without looking like a failure: the prose arrives intact and only the
  // trailing JSON is cut off, so the scene silently doesn't change. Callers
  // check `truncated` and refuse to report success.
  type LLMResult = { text: string; truncated: boolean };

  const callGemini = async (systemInstructions: string, userQuery: string): Promise<LLMResult | null> => {
    const currentModel = selectedModel || localStorage.getItem('gemini_model') || 'gemini-3.6-flash';
    const isClaude = currentModel.startsWith('claude');
    const maxTokens = readMaxTokens();

    if (isClaude) {
      const effectiveKey = claudeApiKey.trim() || localStorage.getItem('anthropic_api_key')?.trim() || '';
      if (!effectiveKey) {
        setError('Please configure your Anthropic Claude API Key in Global Settings or the setup drawer below.');
        return null;
      }
      setError('');
      setLoading(true);

      const headers = {
        'x-api-key': effectiveKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      const body = JSON.stringify({
        model: currentModel,
        max_tokens: maxTokens,
        system: systemInstructions,
        messages: [{ role: 'user', content: userQuery }],
      });

      try {
        let response = await fetch('/api/anthropic/v1/messages', { method: 'POST', headers, body });
        if (!response.ok && response.status === 404) {
          response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body });
        }

        const json = await response.json();
        if (json.error) {
          throw new Error(json.error.message || json.error.type || 'Claude API Error');
        }

        const text = Array.isArray(json.content)
          ? json.content.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text).join('\n')
          : (json.content?.[0]?.text || '');

        if (!text.trim()) {
          throw new Error(json.stop_reason === 'refusal'
            ? 'The model declined to answer this request.'
            : 'The model returned an empty response.');
        }
        return { text, truncated: json.stop_reason === 'max_tokens' };
      } catch (e: any) {
        setError(`Claude API Error (${currentModel}): ${e.message}`);
        setLoading(false);
        return null;
      }
    } else {
      const effectiveKey = geminiApiKey.trim() || localStorage.getItem('gemini_api_key')?.trim() || '';
      if (!effectiveKey) {
        setError('Please configure your Google Gemini API Key in Global Settings or the setup drawer below.');
        return null;
      }
      setError('');
      setLoading(true);

      const requestBody = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemInstructions}\n\nUser Request: ${userQuery}` }]
          }
        ],
        generationConfig: { maxOutputTokens: maxTokens },
      });

      try {
        let response = await fetch(`/api/gemini/v1beta/models/${currentModel}:generateContent?key=${effectiveKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        });
        if (!response.ok && response.status === 404) {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${effectiveKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
          });
        }

        const json = await response.json();
        if (json.error) {
          throw new Error(json.error.message);
        }

        const candidate = json.candidates?.[0];
        // Every text part, not just parts[0]: thinking models routinely split a
        // reply across parts, and taking only the first one dropped whatever
        // followed - usually the trailing JSON block the scene update needs.
        const text = Array.isArray(candidate?.content?.parts)
          ? candidate.content.parts.filter((pt: any) => typeof pt?.text === 'string' && pt.text).map((pt: any) => pt.text).join('\n')
          : '';

        if (!text.trim()) {
          const blockReason = json.promptFeedback?.blockReason || candidate?.finishReason;
          throw new Error(blockReason
            ? `The model returned no content (${blockReason}).`
            : 'The model returned an empty response.');
        }
        return { text, truncated: candidate?.finishReason === 'MAX_TOKENS' };
      } catch (e: any) {
        setError(`Gemini API Error (${currentModel}): ${e.message}`);
        setLoading(false);
        return null;
      }
    }
  };

  const describeScadFailure = (names: string[]): string =>
    `Applied, but the OpenSCAD source for ${names.join(', ')} failed to compile - ${names.length > 1 ? 'those bodies' : 'that body'} still shows its previous geometry.`;

  // Shared by every handler that expects a scene back. Turns "the model said it
  // worked but nothing happened" into a visible, retryable error.
  const describeApplyFailure = (truncated: boolean): string => truncated
    ? `The response hit the ${readMaxTokens().toLocaleString()}-token limit and was cut off before the scene JSON was complete, so nothing was applied. Raise "Copilot Max Response Tokens" in Global Settings, or ask for a smaller change.`
    : 'The response did not contain a usable scene graph, so nothing was applied.';

  const roundNum = (n: number) => Math.round(n * 1000) / 1000;

  const getSerializedNodesCompact = () => {
    const serializeNode = (node: any): any => {
      const filteredChildren = node.children
        ?.filter((child: any) => !child.name?.includes('tooth') && !child.id?.includes('cog_'))
        .map(serializeNode);

      const compactNode: any = {
        id: node.id,
        name: node.name,
        pos: node.pos?.map(roundNum),
      };

      if (node.euler && node.euler.some((e: number) => e !== 0)) compactNode.euler = node.euler.map(roundNum);
      if (node.allowCoupling) compactNode.allowCoupling = true;
      if (node.coupleTargetId) compactNode.coupleTargetId = node.coupleTargetId;
      if (node.weldTargetId) compactNode.weldTargetId = node.weldTargetId;
      if (node.scad) compactNode.scad = node.scad;
      if (node.script) compactNode.script = node.script;

      if (node.geoms && node.geoms.length > 0) {
        compactNode.geoms = node.geoms.map((g: any) => {
          const geomObj: any = {
            name: g.name,
            type: g.type,
            size: g.size?.map(roundNum),
          };
          if (g.pos && g.pos.some((p: number) => p !== 0)) geomObj.pos = g.pos.map(roundNum);
          if (g.mass) geomObj.mass = roundNum(g.mass);
          if (g.rgba) geomObj.rgba = g.rgba.map((c: number) => Math.round(c * 100) / 100);
          return geomObj;
        });
      }

      if (node.joints && node.joints.length > 0) {
        compactNode.joints = node.joints.map((j: any) => {
          const jointObj: any = {
            name: j.name,
            type: j.type,
          };
          if (j.axis) jointObj.axis = j.axis;
          if (j.damping) jointObj.damping = roundNum(j.damping);
          if (j.stiffness) jointObj.stiffness = roundNum(j.stiffness);
          if (j.actuator) jointObj.actuator = j.actuator;
          return jointObj;
        });
      }

      if (filteredChildren && filteredChildren.length > 0) {
        compactNode.children = filteredChildren;
      }

      return compactNode;
    };

    return sceneGraph.nodes.map(serializeNode);
  };

  // Returns the names of any bodies whose SCAD failed to compile. Callers must
  // surface these: updateScene has already committed the new scad source by the
  // time this runs, so a failure here leaves the stored source and the rendered
  // mesh disagreeing - the body keeps its OLD geometry while the chat reports
  // the change as applied. This used to be a console.warn and nothing else.
  const triggerScadAutoCompile = async (nodesToProcess: any[]): Promise<string[]> => {
    const scadNodes: any[] = [];
    const collectScad = (list: any[]) => {
      if (!Array.isArray(list)) return;
      for (const node of list) {
        if (node.scad) scadNodes.push(node);
        if (node.children) collectScad(node.children);
      }
    };
    collectScad(nodesToProcess);

    if (scadNodes.length === 0) return [];

    const failedNodes: string[] = [];

    for (const node of scadNodes) {
      let compiled: { vertices: number[]; faces: number[]; renderVertices: number[] } | null = null;
      let lastErr: unknown = null;

      for (let attempt = 0; attempt < 3 && !compiled; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 120));
        try {
          const result = await compileSCAD(node.scad);
          if (result && result.faces && result.faces.length > 0) {
            compiled = result;
          } else {
            lastErr = new Error('SCAD compile produced empty mesh (0 faces)');
          }
        } catch (err) {
          lastErr = err;
        }
      }

      if (compiled) {
        const storeNodes = useStore.getState().sceneGraph.nodes;
        const targetStoreNode = storeNodes.find(sn => sn.id === node.id || sn.name === node.name || sn.name === node.id || sn.id === node.name);
        const targetId = targetStoreNode ? targetStoreNode.id : node.id;

        useStore.getState().updateNodeScad(targetId, node.scad, compiled, true);
      } else {
        console.warn(`Failed to auto-compile SCAD for node ${node.id || node.name} after 3 attempts:`, lastErr);
        failedNodes.push(node.name || node.id || 'unnamed body');
      }
    }

    useStore.getState().recompile(useStore.getState().sceneGraph);
    return failedNodes;
  };

  const handlePhysicsDiagnostics = async () => {
    setMode('explain');
    setLoadingStatus('Analyzing physics scene & asking clarifying questions...');
    const compactNodes = getSerializedNodesCompact();

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      mode: 'explain',
      content: '⚡ Perform Physics Diagnostics',
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const systemInstructions = `You are "PhysBox: Mesh Copilot", an expert systems engineer and 3D physics analyst.
Analyze the active visual physics scene graph schematic in Markdown.

Your report must include:
## 1. Scene Overview
## 2. Component & Joint Analysis
## 3. Diagnostics & Design Anti-Patterns

At the very end of your response, include a structured JSON block inside \`\`\`json \`\`\` code fences containing 1 to 3 clarifying questions about the functional intent, load expectations, or usage conditions of the object(s).
CRITICAL: Do NOT output "proposedModifications" or scene "nodes" yet. The user will answer clarifying questions first.

Current scene graph topology:
Nodes: ${JSON.stringify(compactNodes)}${getModeHistoryStr('explain')}${getExistingCardContextStr()}`;

    const response = await callGemini(systemInstructions, `Perform a full system diagnostic of the active physics scene.`);
    setLoading(false);
    if (response) {
      const { markdown, questions, noteCardMarkdown } = parseAIResponse(response.text);
      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        role: 'assistant',
        mode: 'explain',
        content: markdown,
        questions: questions.length > 0 ? questions : [
          { id: 'q1', question: 'What is the primary function or load expectation of this object?' }
        ],
        userAnswers: {},
        userAnswersSubmitted: false,
        proposedModifications: [],
        nodes: null,
        isImplemented: false,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate('explain', 'Physics Diagnostics', markdown, noteCardMarkdown);
    }
  };

  const handle3DPrintDiagnostics = async () => {
    setMode('explain');
    setLoadingStatus('Analyzing 3D printability & asking clarifying questions...');
    const compactNodes = getSerializedNodesCompact();

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      mode: 'explain',
      content: '🖨️ Perform 3D Printing Diagnostics',
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const systemInstructions = `You are "PhysBox: 3D Printing Specialist", an expert in additive manufacturing and physical structural mechanics.
Analyze the active 3D scene graph topology for real-world 3D printing feasibility, physical weak points, and potential defects in Markdown.

Your report must analyze:
## 1. 🖨️ Printability & Orientation Analysis
## 2. 🔩 Structural Integrity & Weak Joints Analysis
## 3. 📐 Wall Thickness & Geometry Defects

At the end of your response, include a structured JSON block inside \`\`\`json \`\`\` code fences containing 1 to 3 clarifying questions regarding the intended printing material, functional load, or assembly constraints.
CRITICAL: Do NOT output "proposedModifications" or scene "nodes" yet. The user will answer clarifying questions first.

Current scene graph topology:
Nodes: ${JSON.stringify(compactNodes)}${getModeHistoryStr('explain')}${getExistingCardContextStr()}`;

    const response = await callGemini(systemInstructions, `Perform a full 3D printing physical defect diagnostic of the active scene graph topology.`);
    setLoading(false);
    if (response) {
      const { markdown, questions, noteCardMarkdown } = parseAIResponse(response.text);
      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        role: 'assistant',
        mode: 'explain',
        content: markdown,
        questions: questions.length > 0 ? questions : [
          { id: 'q1', question: 'What is the primary function of this 3D model?' }
        ],
        userAnswers: {},
        userAnswersSubmitted: false,
        proposedModifications: [],
        nodes: null,
        isImplemented: false,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate('explain', '3D Printing Diagnostics', markdown, noteCardMarkdown);
    }
  };

  const handleSendQuestionAnswers = async (msgId: string) => {
    const targetMsg = messages.find(m => m.id === msgId);
    if (!targetMsg) return;

    setError('');
    setLoadingStatus('Processing functional answers & generating proposed modifications...');

    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, userAnswersSubmitted: true } : m));

    const userAnswersSummary = targetMsg.userAnswers ? Object.entries(targetMsg.userAnswers)
      .map(([qId, ans]) => {
        const q = targetMsg.questions?.find(item => item.id === qId);
        return `- Question: "${q?.question}" -> User Answer: "${ans}"`;
      })
      .filter(line => !line.endsWith('""'))
      .join('\n') : '';

    const userMsg: ChatMessage = {
      id: `user_ans_${Date.now()}`,
      role: 'user',
      content: `📝 Functional Intent Answers:\n${userAnswersSummary || 'General functional enhancement requested.'}`,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const compactNodes = getSerializedNodesCompact();

    const promptWithContext = `The user has answered your clarifying questions regarding object function and loading intent.

USER FUNCTIONAL ANSWERS & CLARIFICATIONS:
${userAnswersSummary || 'General functional enhancement requested.'}

CURRENT SCENEGRAPH DEFINITION:
${JSON.stringify(compactNodes)}${getModeHistoryStr('explain')}${getExistingCardContextStr()}

Based on these functional clarifications and your physical analysis:
1. Provide a clear Markdown summary of recommended physical & structural modifications.
2. At the bottom, include a "proposedModifications" JSON block inside \`\`\`json \`\`\` code fences.`;

    const response = await callGemini(SYSTEM_INSTRUCTIONS, promptWithContext);
    setLoading(false);

    if (response) {
      const { markdown, proposedModifications, noteCardMarkdown } = parseAIResponse(response.text);
      const assistantMsg: ChatMessage = {
        id: `ast_props_${Date.now()}`,
        role: 'assistant',
        mode: 'explain',
        content: markdown || '### 🛠️ Proposed Physical Modifications\nSelect the proposed modifications you would like to apply to the active 3D schematic:',
        questions: [],
        userAnswersSubmitted: true,
        proposedModifications: proposedModifications.length > 0 ? proposedModifications : [
          { id: 'm1', text: 'Increase wall thickness to 3.0mm', selected: true },
          { id: 'm2', text: 'Add M3 heat-set insert pilot holes', selected: true }
        ],
        nodes: null,
        isImplemented: false,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate('explain', 'Functional Intent Answers', markdown, noteCardMarkdown);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description of the scene you want to generate.');
      return;
    }
    const currentPrompt = prompt;
    setPrompt('');
    setMode('generate');
    setLoadingStatus('Generating 3D scene schematic...');

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      mode: 'generate',
      content: `🪄 Generate Scene: ${currentPrompt}`,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const systemPromptWithQuestions = `${SYSTEM_INSTRUCTIONS}${getModeHistoryStr('generate')}${getExistingCardContextStr()}\n\nIn addition to the "nodes" JSON block, if there are optional design choices or follow-up options for the user, include a "questions" array JSON block at the bottom with 1-3 questions having 2-4 options each.`;

    const response = await callGemini(systemPromptWithQuestions, currentPrompt);
    setLoading(false);
    if (response) {
      const { markdown, questions, proposedModifications, nodes, noteCardMarkdown } = parseAIResponse(response.text);
      let applied = false;
      let scadFailures: string[] = [];
      let mergedNodes: any[] | null = null;
      if (nodes && Array.isArray(nodes)) {
        const merged = mergeAndNormalizeNodes(nodes, sceneGraph.nodes, true);
        if (merged.length > 0) {
          updateScene({ nodes: merged });
          scadFailures = await triggerScadAutoCompile(merged);
          applied = true;
          mergedNodes = merged;
        }
      }

      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        role: 'assistant',
        mode: 'generate',
        // Only claim success when a scene actually reached the store. The
        // fallback used to assert 'Scene Generated Successfully!' regardless,
        // which is how a request that produced no usable nodes still read as a
        // win.
        content: markdown || (applied
          ? '### ✨ Scene Generated Successfully!\nI have created your 3D physics schematic.'
          : '### ⚠️ Nothing was applied\nThe response did not include a scene graph.'),
        questions,
        proposedModifications,
        userAnswers: {},
        nodes,
        isImplemented: applied,
        hasError: !applied || scadFailures.length > 0,
        errorMsg: !applied
          ? describeApplyFailure(response.truncated)
          : (scadFailures.length > 0 ? describeScadFailure(scadFailures) : undefined),
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate('generate', currentPrompt, markdown, noteCardMarkdown, mergedNodes || nodes || undefined);
    }
  };

  const handleMutate = async () => {
    if (!prompt.trim()) {
      setError('Please enter what changes you want to apply to the scene.');
      return;
    }
    const currentPrompt = prompt;
    setPrompt('');
    setMode('mutate');
    setLoadingStatus('Mutating active 3D scene...');

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      mode: 'mutate',
      content: `🛠️ Mutate Scene: ${currentPrompt}`,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const compactNodes = getSerializedNodesCompact();
    const promptWithContext = `The user wants to modify the active physics scene graph.\n\nActive SceneGraph Nodes:\n${JSON.stringify(compactNodes)}${getModeHistoryStr('mutate')}${getExistingCardContextStr()}\n\nUser Request: ${currentPrompt}\n\nIf there are follow-up clarifying choices, append a "questions" JSON block at the bottom. Return the mutated "nodes" array in \`\`\`json \`\`\` code fences.`;

    const response = await callGemini(SYSTEM_INSTRUCTIONS, promptWithContext);
    setLoading(false);
    if (response) {
      const { markdown, questions, proposedModifications, nodes, noteCardMarkdown } = parseAIResponse(response.text);
      let applied = false;
      let scadFailures: string[] = [];
      let mergedNodes: any[] | null = null;
      if (nodes && Array.isArray(nodes)) {
        const merged = mergeAndNormalizeNodes(nodes, sceneGraph.nodes, false);
        if (merged.length > 0) {
          updateScene({ nodes: merged });
          scadFailures = await triggerScadAutoCompile(merged);
          applied = true;
          mergedNodes = merged;
        }
      }

      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        role: 'assistant',
        mode: 'mutate',
        content: markdown || (applied
          ? '### 🛠️ Scene Mutated Successfully!\nYour requested modifications have been merged into the active 3D physics schematic.'
          : '### ⚠️ Nothing was applied\nThe response did not include a mutated scene graph.'),
        questions,
        proposedModifications,
        userAnswers: {},
        nodes,
        isImplemented: applied,
        hasError: !applied || scadFailures.length > 0,
        errorMsg: !applied
          ? describeApplyFailure(response.truncated)
          : (scadFailures.length > 0 ? describeScadFailure(scadFailures) : undefined),
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate('mutate', currentPrompt, markdown, noteCardMarkdown, mergedNodes || nodes || undefined);
    }
  };

  const handleImplementMessage = async (msgId: string) => {
    const targetMsg = messages.find(m => m.id === msgId);
    if (!targetMsg) return;

    setError('');
    setLoadingStatus('Generating updated 3D scene from selected proposed modifications...');

    const userAnswersSummary = targetMsg.userAnswers ? Object.entries(targetMsg.userAnswers)
      .map(([qId, ans]) => {
        const q = targetMsg.questions?.find(item => item.id === qId);
        return `- Question: "${q?.question}" -> User Answer: "${ans}"`;
      })
      .filter(line => !line.endsWith('""'))
      .join('\n') : '';

    const selectedModsSummary = targetMsg.proposedModifications
      ? targetMsg.proposedModifications
          .filter(m => m.selected)
          .map(m => `- ${m.text}`)
          .join('\n')
      : '';

    const compactNodes = getSerializedNodesCompact();

    const promptWithContext = `You are an automated 3D scene graph mutator.
Apply the user's selected proposed physical modifications and functional answers directly into the active scene graph.

USER CLARIFICATIONS & FUNCTIONAL INTENT:
${userAnswersSummary || 'None specified.'}

SELECTED PROPOSED MODIFICATIONS TO APPLY:
${selectedModsSummary || 'Implement recommended structural, 3D printability, and parameter modifications.'}

CURRENT SCENEGRAPH DEFINITION:
${JSON.stringify(compactNodes)}${getModeHistoryStr('mutate')}${getExistingCardContextStr()}

CRITICAL INSTRUCTIONS:
1. Provide a brief 1-3 bullet point Markdown summary at the top detailing what was modified or added.
2. MANDATORY: Output ALL top-level scene nodes (preserving all existing objects such as enclosure_box and enclosure_lid) in the "nodes" array inside \`\`\`json \`\`\` code fences at the bottom.
3. For any node with OpenSCAD script, ensure the valid "scad" script string is included.`;

    const response = await callGemini(SYSTEM_INSTRUCTIONS, promptWithContext);
    setLoading(false);

    if (response) {
      const { markdown, questions, proposedModifications, nodes, noteCardMarkdown } = parseAIResponse(response.text);
      if (nodes && Array.isArray(nodes) && nodes.length > 0) {
        const merged = mergeAndNormalizeNodes(nodes, sceneGraph.nodes, false);
        if (merged.length > 0) {
          updateScene({ nodes: merged });
          const scadFailures = await triggerScadAutoCompile(merged);
          setMessages(prev => prev.map(m => m.id === msgId
            ? { ...m, isImplemented: true, hasError: scadFailures.length > 0, errorMsg: scadFailures.length > 0 ? describeScadFailure(scadFailures) : undefined }
            : m));

          const summaryHeader = '### ✨ Selected Improvements Applied Successfully!\n\n';
          const summaryContent = markdown
            ? `${summaryHeader}${markdown}`
            : `${summaryHeader}- Applied physical design modifications, 3D printability updates, and parameter changes to the active scene graph.`;

          const confirmationMsg: ChatMessage = {
            id: `ast_conf_${Date.now()}`,
            role: 'assistant',
            mode: 'implement',
            content: summaryContent,
            questions,
            proposedModifications,
            nodes: merged,
            isImplemented: true,
            hasError: scadFailures.length > 0,
            errorMsg: scadFailures.length > 0 ? describeScadFailure(scadFailures) : undefined,
            timestamp: Date.now()
          };
          setMessages(prev => [...prev, confirmationMsg]);
          handleNotecardUpdate('mutate', 'Implemented Improvements', markdown, noteCardMarkdown, merged);
          return;
        }
      }
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, hasError: true, errorMsg: describeApplyFailure(response.truncated) } : m));
    }
  };

  const handleSendFollowup = async () => {
    if (!followupInput.trim() || loading) return;
    const currentInput = followupInput;
    setFollowupInput('');
    setLoadingStatus('Processing follow-up request...');

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: currentInput,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    const compactNodes = getSerializedNodesCompact();
    const promptWithContext = `The user is having an open-ended copilot conversation to modify or analyze the active 3D scene graph.

ACTIVE SCENEGRAPH NODES:
${JSON.stringify(compactNodes)}${getModeHistoryStr(mode)}${getExistingCardContextStr()}

USER FOLLOWUP REQUEST:
${currentInput}

If modifying the 3D scene graph, include the updated "nodes" array in \`\`\`json \`\`\` code fences. If proposing optional questions/choices, include a "questions" JSON block at the bottom.`;

    const response = await callGemini(SYSTEM_INSTRUCTIONS, promptWithContext);
    setLoading(false);

    if (response) {
      const { markdown, questions, proposedModifications, nodes, noteCardMarkdown } = parseAIResponse(response.text);
      let applied = false;
      let scadFailures: string[] = [];
      let mergedNodes: any[] | null = null;
      if (nodes && Array.isArray(nodes)) {
        const merged = mergeAndNormalizeNodes(nodes, sceneGraph.nodes, false);
        if (merged.length > 0) {
          updateScene({ nodes: merged });
          scadFailures = await triggerScadAutoCompile(merged);
          applied = true;
          mergedNodes = merged;
        }
      }

      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        role: 'assistant',
        content: markdown || (applied
          ? '### 🛠️ Scene Updated\nYour requested modifications have been applied to the active physics schematic.'
          : '### ⚠️ Nothing was applied\nThe response did not include an updated scene graph.'),
        questions,
        proposedModifications,
        userAnswers: {},
        nodes,
        isImplemented: applied,
        // A follow-up is often just conversation ("why is it wobbling?"), so an
        // absent scene graph is only an error when the model was asked to change
        // something - i.e. when this turn is running in generate/mutate mode.
        hasError: (!applied && (mode === 'generate' || mode === 'mutate')) || scadFailures.length > 0,
        errorMsg: !applied
          ? describeApplyFailure(response.truncated)
          : (scadFailures.length > 0 ? describeScadFailure(scadFailures) : undefined),
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
      handleNotecardUpdate(mode || 'explain', currentInput, markdown, noteCardMarkdown, mergedNodes || undefined);
    }
  };

  const parseBoldAndCode = (str: string) => {
    const regex = /(\*\*.*?\*\*|`.*?`)/g;
    const tokens = str.split(regex);
    return tokens.map((token, i) => {
      if (token.startsWith('**') && token.endsWith('**')) {
        return <strong key={i} className="font-extrabold text-slate-800 dark:text-slate-100">{token.slice(2, -2)}</strong>;
      }
      if (token.startsWith('`') && token.endsWith('`')) {
        return <code key={i} className="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded font-mono text-[10px] text-blue-600 dark:text-blue-400 font-bold">{token.slice(1, -1)}</code>;
      }
      return token;
    });
  };

  const renderMarkdown = (text: string) => {
    if (!text) return null;
    const cleanedText = cleanLaTeXMath(text);
    const lines = cleanedText.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) {
        return <h1 key={idx} className="text-sm font-extrabold text-slate-800 dark:text-slate-100 border-b border-slate-150 dark:border-slate-800 pb-1 mt-3 mb-2 tracking-tight">{line.substring(2)}</h1>;
      }
      if (line.startsWith('## ')) {
        return <h2 key={idx} className="text-xs font-bold text-slate-850 dark:text-slate-200 mt-3 mb-1 tracking-tight">{line.substring(3)}</h2>;
      }
      if (line.startsWith('### ')) {
        return <h3 key={idx} className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-2 mb-1">{line.substring(4)}</h3>;
      }
      if (line.startsWith('* ') || line.startsWith('- ')) {
        return <li key={idx} className="ml-4 list-disc text-slate-600 dark:text-slate-350 my-0.5 leading-relaxed">{parseBoldAndCode(line.substring(2))}</li>;
      }
      if (!line.trim()) {
        return <div key={idx} className="h-1.5" />;
      }
      return <p key={idx} className="my-1.5 text-slate-600 dark:text-slate-350 leading-relaxed font-sans">{parseBoldAndCode(line)}</p>;
    });
  };

  return (
    /* `max-lg:z-[110]`: below `lg` this is an overlay like the properties
       drawer, and the two share the right-hand edge — whichever was asked for
       last has to be the one on top, not whichever happens to render later. */
    <aside className="w-full sm:w-96 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-l border-slate-200 dark:border-slate-800 flex flex-col h-full shrink-0 shadow-2xl z-40 max-lg:z-[110] absolute right-0 inset-y-0 sm:relative animate-in slide-in-from-right-8 duration-300">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/80 dark:bg-slate-950/20 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 shadow-sm animate-pulse">
            <Brain className="w-4.5 h-4.5" />
          </div>
          <div className="flex flex-col">
            <h2 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">AI Copilot Expert</h2>
            <div className="flex items-center gap-1 mt-0.5">
              <select
                value={selectedModel}
                onChange={(e) => saveSelectedModel(e.target.value)}
                className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded px-1.5 py-0.5 focus:outline-none cursor-pointer"
                title="Select Copilot Model"
              >
                <optgroup label="Google Gemini">
                  {availableModels.length > 0 ? (
                    availableModels.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))
                  ) : (
                    <>
                      <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                      <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                    </>
                  )}
                </optgroup>
                <optgroup label="Anthropic Claude">
                  {availableClaudeModels.length > 0 ? (
                    availableClaudeModels.map(m => (
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
          </div>
        </div>
        <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
      </div>

      {/* Main Panel Content */}
      <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">
        
        {/* Navigation Modes */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-955/40 rounded-xl select-none shrink-0">
          <button
            onClick={() => setMode('explain')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'explain' ? 'bg-white dark:bg-slate-800 text-blue-650 dark:text-blue-400 shadow-sm' : 'text-slate-505 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
          >
            🔍 Explain
          </button>
          <button
            onClick={() => setMode('generate')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'generate' ? 'bg-white dark:bg-slate-800 text-blue-650 dark:text-blue-400 shadow-sm' : 'text-slate-505 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
          >
            🪄 Generate
          </button>
          <button
            onClick={() => setMode('mutate')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'mutate' ? 'bg-white dark:bg-slate-800 text-blue-655 dark:text-blue-450 shadow-sm' : 'text-slate-505 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
          >
            🛠️ Mutate
          </button>
        </div>

        <div className="flex items-center justify-between px-1 select-none">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{mode} Panel</span>
          <button
            onClick={() => handleClearModeHistory(mode)}
            className="text-[10px] text-slate-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400 flex items-center gap-1 font-semibold transition-colors cursor-pointer"
            title={`Clear ${mode} chat history`}
          >
            <Trash2 className="w-3 h-3" /> Clear {mode} history
          </button>
        </div>

        {/* Action Controls */}
        {mode !== 'explain' ? (
          <div className="flex flex-col gap-2 shrink-0">
            <textarea
              placeholder={mode === 'generate' ? "Describe the physics scene you want to generate. e.g. A stack of 3 cubes falling on top of each other, or a double pendulum connected to a hinge..." : "Describe the modifications you want to apply. e.g. Add a sphere body with free joint at position [0, 0, 4], or increase joint damping..."}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs shadow-inner bg-white dark:bg-slate-955 text-slate-800 dark:text-slate-200 min-h-[75px] leading-normal placeholder-slate-400 dark:placeholder-slate-500"
            />
            <button
              onClick={mode === 'generate' ? handleGenerate : handleMutate}
              disabled={loading}
              className="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              {mode === 'generate' ? 'Generate Scene' : 'Mutate Scene'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 shrink-0 select-none">
            <button
              onClick={handlePhysicsDiagnostics}
              disabled={loading}
              className="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl text-xs font-bold shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            >
              <Activity className="w-3.5 h-3.5" />
              Physics Diagnostics
            </button>
            <button
              onClick={handle3DPrintDiagnostics}
              disabled={loading}
              className="py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-xs font-bold shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              3D Printing Diagnostics
            </button>
          </div>
        )}

        {/* API key & Model drawer */}
        {(!geminiApiKey && !claudeApiKey) && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/60 p-3.5 rounded-xl shrink-0 flex flex-col gap-2.5 shadow-inner">
            <div className="flex gap-2 items-start">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-xs font-bold text-amber-800 dark:text-amber-300 leading-normal">API Key Required</span>
                <p className="text-[10px] text-amber-650 dark:text-amber-450 leading-normal">Configure your Gemini or Claude API key below:</p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-amber-900 dark:text-amber-300">🔑 Gemini API Key:</label>
                <input 
                  type="password" 
                  placeholder="Paste AIzaSy... key here" 
                  value={geminiApiKey}
                  onChange={(e) => saveGeminiApiKey(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs border border-amber-200 dark:border-amber-900/40 rounded-lg shadow-sm focus:outline-none focus:ring-1 focus:ring-amber-550 font-mono bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-amber-900 dark:text-amber-300">🔑 Claude API Key:</label>
                <input 
                  type="password" 
                  placeholder="Paste sk-ant-... key here" 
                  value={claudeApiKey}
                  onChange={(e) => saveClaudeApiKey(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs border border-amber-200 dark:border-amber-900/40 rounded-lg shadow-sm focus:outline-none focus:ring-1 focus:ring-amber-550 font-mono bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                />
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <label className="text-[10px] font-bold text-amber-800 dark:text-amber-300">Model:</label>
                <select
                  value={selectedModel}
                  onChange={(e) => saveSelectedModel(e.target.value)}
                  className="flex-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/40 rounded-lg px-2 py-1 focus:outline-none cursor-pointer"
                >
                  <optgroup label="Google Gemini">
                    {availableModels.length > 0 ? (
                      availableModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))
                    ) : (
                      <>
                        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                        <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                        <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                      </>
                    )}
                  </optgroup>
                  <optgroup label="Anthropic Claude">
                    {availableClaudeModels.length > 0 ? (
                      availableClaudeModels.map(m => (
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
            </div>
          </div>
        )}

        {/* Error Block */}
        {error && (
          <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/60 p-3 rounded-xl shrink-0 flex items-start gap-2 shadow-inner">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span className="text-[10px] text-red-700 dark:text-red-400 font-semibold leading-normal break-all">{error}</span>
          </div>
        )}

        {/* Chat Stream Timeline */}
        <div ref={responseContainerRef} className="flex-1 border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-3 rounded-xl overflow-y-auto leading-relaxed text-xs text-slate-700 dark:text-slate-300 shadow-inner flex flex-col gap-4 min-h-[150px]">
          {modeMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-400 dark:text-slate-550 select-none py-8 text-center">
              <HelpCircle className="w-8 h-8 text-slate-350 dark:text-slate-700" />
              <p className="text-[11px] leading-normal px-4">
                {(geminiApiKey || claudeApiKey)
                  ? `No history in ${mode} mode. Ask a question or submit a request to start.`
                  : 'Configure your Gemini or Claude API key below to get started.'}
              </p>
            </div>
          ) : (
            modeMessages.map((msg) => (
              <div key={msg.id} className="flex flex-col gap-2">
                {msg.role === 'user' ? (
                  <div className="self-end bg-blue-600 text-white px-3 py-2 rounded-2xl rounded-tr-xs text-xs font-semibold max-w-[85%] shadow-sm">
                    {msg.content}
                  </div>
                ) : (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-3 rounded-2xl rounded-tl-xs shadow-sm flex flex-col gap-3">
                    <div className="prose prose-slate dark:prose-invert max-w-none text-xs font-normal">
                      {renderMarkdown(msg.content)}
                    </div>

                    {/* Phase 1: Clarifying Questions (Rendered FIRST, before proposed modifications) */}
                    {msg.questions && msg.questions.length > 0 && !msg.userAnswersSubmitted && (
                      <div className="mt-2 pt-3 border-t border-slate-150 dark:border-slate-800 flex flex-col gap-3">
                        <div className="bg-slate-100/80 dark:bg-slate-955/80 p-3 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col gap-3">
                          <span className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                            <HelpCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                            Clarifying Questions
                          </span>
                          <div className="flex flex-col gap-3 select-none">
                            {msg.questions.map((q) => {
                              const currentAnswer = msg.userAnswers?.[q.id] || '';
                              const hasOptions = Array.isArray(q.options) && q.options.length > 0;
                              return (
                                <div key={q.id} className="flex flex-col gap-2 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200/80 dark:border-slate-800 shadow-xs">
                                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 leading-snug">
                                    {q.question}
                                  </span>
                                  {hasOptions ? (
                                    <div className="flex flex-col gap-1.5 mt-1">
                                      {q.options!.map((opt) => {
                                        const isSelected = currentAnswer === opt;
                                        return (
                                          <button
                                            key={opt}
                                            onClick={() => {
                                              setMessages(prev => prev.map(m => m.id === msg.id ? {
                                                ...m,
                                                userAnswers: { ...m.userAnswers, [q.id]: opt }
                                              } : m));
                                            }}
                                            className={`w-full p-2 text-xs font-medium rounded-lg transition-all cursor-pointer text-left flex items-center justify-between gap-2 leading-snug whitespace-normal break-words ${
                                              isSelected
                                                ? 'bg-blue-600 text-white font-bold shadow-sm border border-blue-500'
                                                : 'bg-slate-50 dark:bg-slate-955 text-slate-700 dark:text-slate-300 border border-slate-200/80 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800/80'
                                            }`}
                                          >
                                            <span className="flex-1">{opt}</span>
                                            {isSelected ? (
                                              <span className="w-4 h-4 rounded-full bg-white/20 text-white flex items-center justify-center text-[10px] shrink-0 font-bold">✓</span>
                                            ) : (
                                              <span className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-700 shrink-0" />
                                            )}
                                          </button>
                                        );
                                      })}
                                      <input
                                        type="text"
                                        placeholder="Or enter custom freeform answer..."
                                        value={!q.options!.includes(currentAnswer) ? currentAnswer : ''}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setMessages(prev => prev.map(m => m.id === msg.id ? {
                                            ...m,
                                            userAnswers: { ...m.userAnswers, [q.id]: val }
                                          } : m));
                                        }}
                                        className="w-full mt-1 px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-955 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                    </div>
                                  ) : (
                                    <textarea
                                      placeholder="Type your freeform answer here..."
                                      value={currentAnswer}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setMessages(prev => prev.map(m => m.id === msg.id ? {
                                          ...m,
                                          userAnswers: { ...m.userAnswers, [q.id]: val }
                                        } : m));
                                      }}
                                      className="w-full mt-1 px-2.5 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-955 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[60px] leading-normal"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Phase 1 Action Button: Submit Answers to get proposed modifications */}
                        <button
                          onClick={() => handleSendQuestionAnswers(msg.id)}
                          disabled={loading}
                          className="w-full py-2.5 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl text-xs font-extrabold shadow-md flex items-center justify-center gap-2 transition-all cursor-pointer transform active:scale-[0.99] disabled:opacity-50"
                        >
                          <Send className="w-4 h-4" />
                          Submit Answers & Get Proposed Improvements
                        </button>
                      </div>
                    )}

                    {/* Phase 2: Proposed Modifications Checklist (Rendered SECOND, only after questions are submitted or if no questions exist) */}
                    {msg.proposedModifications && msg.proposedModifications.length > 0 && !msg.isImplemented && (msg.userAnswersSubmitted || !msg.questions || msg.questions.length === 0) && (
                      <div className="mt-2 pt-3 border-t border-slate-150 dark:border-slate-800 flex flex-col gap-2.5">
                        <div className="bg-slate-100/80 dark:bg-slate-955/80 p-3 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col gap-2.5">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                              <Wand2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                              Proposed Modifications
                            </span>
                            <span className="text-[10px] text-slate-500 font-medium">Select items to apply</span>
                          </div>
                          <div className="flex flex-col gap-2 select-none">
                            {msg.proposedModifications.map((mod) => (
                              <label
                                key={mod.id}
                                className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition-all ${
                                  mod.selected
                                    ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800/60 text-slate-800 dark:text-slate-100 font-medium shadow-xs'
                                    : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800 text-slate-500 dark:text-slate-400 opacity-60'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={mod.selected}
                                  onChange={() => {
                                    setMessages(prev => prev.map(m => m.id === msg.id ? {
                                      ...m,
                                      proposedModifications: m.proposedModifications?.map(item => item.id === mod.id ? { ...item, selected: !item.selected } : item)
                                    } : m));
                                  }}
                                  className="mt-0.5 w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-slate-300 dark:border-slate-700 cursor-pointer shrink-0"
                                />
                                <span className="flex-1 leading-snug">{mod.text}</span>
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* Phase 3 Action Button: Apply Selected Improvements */}
                        <button
                          onClick={() => handleImplementMessage(msg.id)}
                          disabled={loading}
                          className="w-full mt-2 py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-xs font-extrabold shadow-md flex items-center justify-center gap-2 transition-all cursor-pointer transform active:scale-[0.99] disabled:opacity-50"
                        >
                          <Wand2 className="w-4 h-4" />
                          Apply Selected Improvements
                        </button>
                      </div>
                    )}

                    {/* Implemented Badge */}
                    {msg.isImplemented && (
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 p-2 rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 shrink-0">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Implemented into active 3D viewport</span>
                      </div>
                    )}

                    {/* Error Retry Card */}
                    {msg.hasError && (
                      <div className="mt-2 p-2.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-xl flex items-center justify-between gap-2 text-red-700 dark:text-red-300">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                          <span>{msg.errorMsg || 'Failed to parse updated 3D scene nodes.'}</span>
                        </div>
                        <button
                          onClick={() => handleImplementMessage(msg.id)}
                          disabled={loading}
                          className="py-1.5 px-3 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1 shrink-0 shadow-sm"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Try Again
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          {/* Loading Indicator */}
          {loading && (
            <div className="flex items-center gap-2.5 p-3 bg-blue-50/80 dark:bg-slate-900/80 rounded-xl border border-blue-100 dark:border-slate-800 text-blue-600 dark:text-blue-400 select-none">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span className="text-xs font-semibold">{loadingStatus}</span>
            </div>
          )}

          {/* Open-ended Persistent Conversation Input Box */}
          <div className="mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <textarea
                placeholder="Type an open-ended follow-up request or scene edit..."
                value={followupInput}
                onChange={(e) => setFollowupInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendFollowup();
                  }
                }}
                className="flex-1 px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-955 text-slate-800 dark:text-slate-200 resize-none min-h-[44px] placeholder-slate-400 dark:placeholder-slate-500"
              />
              <button
                onClick={handleSendFollowup}
                disabled={loading || !followupInput.trim()}
                className="p-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 text-white rounded-xl transition-all cursor-pointer flex items-center justify-center shrink-0 shadow-sm"
                title="Send Request"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
