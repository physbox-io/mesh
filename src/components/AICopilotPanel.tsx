import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, Brain, Wand2, Loader2, AlertCircle, HelpCircle } from 'lucide-react';
import { useStore } from '../store/useStore';
import SYSTEM_INSTRUCTIONS from './systemInstructions.txt?raw';

interface AICopilotPanelProps {
  onClose: () => void;
}

const cleanJSONString = (str: string): string => {
  return str
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
    .replace(/(?:^|[^:])\/\/.*$/gm, '') // Remove single-line comments
    .replace(/,\s*([\]}])/g, '$1'); // Remove trailing commas
};

const parseAIJSON = (text: string): any => {
  // 1. Try to find markdown json code blocks
  const codeBlockRegex = /```json\s*([\s\S]*?)\s*```/i;
  const matchBlock = text.match(codeBlockRegex);
  if (matchBlock && matchBlock[1]) {
    try {
      return JSON.parse(cleanJSONString(matchBlock[1].trim()));
    } catch (e) {
      // fallback
    }
  }

  // 2. Try generic code blocks
  const genericCodeBlockRegex = /```\s*([\s\S]*?)\s*```/;
  const matchGeneric = text.match(genericCodeBlockRegex);
  if (matchGeneric && matchGeneric[1]) {
    try {
      return JSON.parse(cleanJSONString(matchGeneric[1].trim()));
    } catch (e) {}
  }

  // 3. Fallback to extracting between first '{' and last '}'
  let index = text.indexOf('{');
  while (index !== -1) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > index) {
      const candidate = text.substring(index, lastBrace + 1);
      try {
        return JSON.parse(cleanJSONString(candidate.trim()));
      } catch (e) {
        // try next index
      }
    }
    index = text.indexOf('{', index + 1);
  }

  throw new Error("No valid JSON block could be extracted from the AI's response.");
};

export default function AICopilotPanel({ onClose }: AICopilotPanelProps) {
  const sceneGraph = useStore(state => state.sceneGraph);
  const updateScene = useStore(state => state.updateScene);

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'explain' | 'generate' | 'mutate'>('explain');
  const [aiResponse, setAiResponse] = useState('');
  const responseContainerRef = useRef<HTMLDivElement>(null);

  // Sync API Key from local storage when it changes externally
  useEffect(() => {
    const handleStorageChange = () => {
      const storedKey = localStorage.getItem('gemini_api_key') || '';
      setApiKey(storedKey);
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  useEffect(() => {
    if (responseContainerRef.current) {
      responseContainerRef.current.scrollTo({
        top: responseContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [aiResponse]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
    window.dispatchEvent(new Event('storage'));
  };

  const callGemini = async (systemInstructions: string, userQuery: string) => {
    const effectiveKey = apiKey.trim() || localStorage.getItem('gemini_api_key')?.trim() || '';
    if (!effectiveKey) {
      setError('Please configure your Gemini API Key in Global Settings or the panel input below.');
      return null;
    }
    if (effectiveKey !== apiKey) setApiKey(effectiveKey);
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${effectiveKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemInstructions}\n\nUser Request: ${userQuery}` }]
            }
          ]
        })
      });

      const json = await response.json();
      if (json.error) {
        throw new Error(json.error.message);
      }

      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return text;
    } catch (e: any) {
      setError(`API Error: ${e.message}`);
      return null;
    } finally {
      setLoading(false);
    }
  };

  // 1. Explain simulation current state and diagnostics
  const handleExplain = async () => {
    setMode('explain');

    const serializedNodes = sceneGraph.nodes.map((n: any) => {
      const serializeNode = (node: any): any => ({
        id: node.id,
        name: node.name,
        pos: node.pos,
        euler: node.euler,
        allowCoupling: node.allowCoupling,
        coupleTargetId: node.coupleTargetId,
        weldTargetId: node.weldTargetId,
        isAerodynamic: node.isAerodynamic,
        hasScript: !!node.script,
        geoms: node.geoms?.map((g: any) => ({
          name: g.name,
          type: g.type,
          size: g.size,
          pos: g.pos,
          rgba: g.rgba,
          mass: g.mass,
        })),
        joints: node.joints?.map((j: any) => ({
          name: j.name,
          type: j.type,
          axis: j.axis,
          damping: j.damping,
          stiffness: j.stiffness,
          actuator: j.actuator,
        })),
        children: node.children?.map(serializeNode)
      });
      return serializeNode(n);
    });

    const systemInstructions = `You are "PhysBox: Mesh Copilot", an expert systems engineer and 3D physics analyst.
Analyze the active visual physics scene graph schematic and produce a comprehensive professional diagnostic report in Markdown.

Your report must include:
## 1. Scene Overview
What kind of physical system is this? What is its primary configuration (e.g. double pendulum, gear system, stacked cubes)?

## 2. Component & Joint Analysis
Briefly walk through the physical bodies, hierarchy, and joint structures. Are joints properly configured?

## 3. Diagnostics & Design Anti-Patterns
- Floating pegs or bodies without support?
- Unstable joint settings (e.g., massive bodies with zero damping)?
- Actuators configured incorrectly or causing potential physics blow-ups (NaN detection)?

## 4. Suggested Improvements
Give 3-5 specific, actionable recommendations (e.g., "Add joint damping to the hinge joint to prevent chaotic spin", "Adjust the body position to prevent interpenetration at startup").

Do NOT output JSON. Output the Markdown report only.

Current scene graph topology:
Nodes: ${JSON.stringify(serializedNodes)}`;

    const response = await callGemini(systemInstructions, 'Perform a full system diagnostic of the active physics scene.');
    if (response) setAiResponse(response);
  };

  // 2. Generate a completely new canvas simulation from prompt
  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description of the scene you want to generate.');
      return;
    }
    setMode('generate');

    const response = await callGemini(SYSTEM_INSTRUCTIONS, prompt);
    if (response) {
      try {
        const parsed = parseAIJSON(response);
        if (parsed.nodes) {
          if (!Array.isArray(parsed.nodes)) {
            throw new Error('JSON "nodes" must be an array');
          }
          updateScene(parsed);
          setAiResponse('### ✨ Scene Generated Successfully!\nI have created your physics schematic. Press **Simulate** in the toolbar to run the physics loop.');
        } else {
          throw new Error('JSON missing "nodes" key');
        }
      } catch (e: any) {
        setError(`Failed to parse AI response: ${e.message}. Raw reply printed below.`);
        setAiResponse(response);
      }
    }
  };

  // 3. Mutate/Add elements to the current canvas dynamically
  const handleMutate = async () => {
    if (!prompt.trim()) {
      setError('Please enter what changes you want to apply to the scene.');
      return;
    }
    setMode('mutate');

    const promptWithContext = `The user wants to modify the active physics scene graph.\n\nActive SceneGraph Nodes:\n${JSON.stringify(sceneGraph.nodes)}\n\nUser Request: ${prompt}`;

    const response = await callGemini(SYSTEM_INSTRUCTIONS, promptWithContext);
    if (response) {
      try {
        const parsed = parseAIJSON(response);
        if (parsed.nodes) {
          if (!Array.isArray(parsed.nodes)) {
            throw new Error('JSON "nodes" must be an array');
          }
          updateScene(parsed);
          setAiResponse('### 🛠️ Scene Mutated Successfully!\nYour requested modifications have been merged into the active physics viewport.');
        } else {
          throw new Error('JSON missing "nodes" key');
        }
      } catch (e: any) {
        setError(`Failed to parse AI mutation response: ${e.message}. Raw response below.`);
        setAiResponse(response);
      }
    }
  };

  const parseBoldAndCode = (str: string) => {
    const regex = /(\*\*.*?\*\*|`.*?`)/g;
    const tokens = str.split(regex);
    return tokens.map((token, i) => {
      if (token.startsWith('**') && token.endsWith('**')) {
        return <strong key={i} className="font-extrabold text-slate-800">{token.slice(2, -2)}</strong>;
      }
      if (token.startsWith('`') && token.endsWith('`')) {
        return <code key={i} className="bg-slate-100 px-1 py-0.5 rounded font-mono text-[10px] text-blue-650 font-bold">{token.slice(1, -1)}</code>;
      }
      return token;
    });
  };

  const renderMarkdown = (text: string) => {
    if (!text) return null;
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) {
        return <h1 key={idx} className="text-sm font-extrabold text-slate-800 border-b border-slate-150 pb-1 mt-3 mb-2 tracking-tight">{line.substring(2)}</h1>;
      }
      if (line.startsWith('## ')) {
        return <h2 key={idx} className="text-xs font-bold text-slate-850 mt-3 mb-1 tracking-tight">{line.substring(3)}</h2>;
      }
      if (line.startsWith('### ')) {
        return <h3 key={idx} className="text-xs font-semibold text-slate-700 mt-2 mb-1">{line.substring(4)}</h3>;
      }
      if (line.startsWith('* ') || line.startsWith('- ')) {
        return <li key={idx} className="ml-4 list-disc text-slate-600 my-0.5 leading-relaxed">{parseBoldAndCode(line.substring(2))}</li>;
      }
      if (!line.trim()) {
        return <div key={idx} className="h-1.5" />;
      }
      return <p key={idx} className="my-1.5 text-slate-600 leading-relaxed font-sans">{parseBoldAndCode(line)}</p>;
    });
  };

  return (
    <aside className="w-full sm:w-96 bg-white/95 backdrop-blur-md border-l border-slate-200 flex flex-col h-full shrink-0 shadow-2xl z-40 absolute right-0 inset-y-0 sm:relative animate-in slide-in-from-right-8 duration-300">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/80 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 shadow-sm animate-pulse">
            <Brain className="w-4.5 h-4.5" />
          </div>
          <div>
            <h2 className="font-extrabold text-slate-800 text-sm">AI Copilot Expert</h2>
            <p className="text-[10px] text-slate-400 font-medium">Gemini 3.5 Flash</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
      </div>

      {/* Main Panel Content */}
      <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">
        
        {/* Navigation Modes */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl select-none">
          <button
            onClick={() => setMode('explain')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'explain' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            🔍 Explain
          </button>
          <button
            onClick={() => setMode('generate')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'generate' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            🪄 Generate
          </button>
          <button
            onClick={() => setMode('mutate')}
            className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${mode === 'mutate' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            🛠️ Mutate
          </button>
        </div>

        {/* Action Prompt Form */}
        {mode !== 'explain' ? (
          <div className="flex flex-col gap-2 shrink-0">
            <textarea
              placeholder={mode === 'generate' ? "Describe the physics scene you want to generate. e.g. A stack of 3 cubes falling on top of each other, or a double pendulum connected to a hinge..." : "Describe the modifications you want to apply. e.g. Add a sphere body with free joint at position [0, 0, 4], or increase joint damping..."}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs shadow-inner min-h-[90px] leading-normal"
            />
            <button
              onClick={mode === 'generate' ? handleGenerate : handleMutate}
              disabled={loading}
              className="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-md shadow-blue-150 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              {mode === 'generate' ? 'Generate Scene' : 'Mutate Scene'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 shrink-0 select-none">
            <button
              onClick={handleExplain}
              disabled={loading}
              className="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-md shadow-blue-150 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Perform Diagnostics
            </button>
          </div>
        )}

        {/* API key configuration drawer inline */}
        {!apiKey && (
          <div className="bg-amber-50 border border-amber-200 p-3.5 rounded-xl shrink-0 flex flex-col gap-2 shadow-inner">
            <div className="flex gap-2 items-start">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-xs font-bold text-amber-800 leading-normal">API Key Required</span>
                <p className="text-[10px] text-amber-600 leading-normal">AI Copilot needs a Gemini API Key to run. Configure it below:</p>
              </div>
            </div>
            <input 
              type="password" 
              placeholder="Paste AIzaSy... here" 
              onChange={(e) => saveApiKey(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border border-amber-200 rounded-lg shadow-sm focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
            />
          </div>
        )}

        {/* Error Block */}
        {error && (
          <div className="bg-red-50 border border-red-200 p-3 rounded-xl shrink-0 flex items-start gap-2 shadow-inner">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span className="text-[10px] text-red-700 font-semibold leading-normal break-all">{error}</span>
          </div>
        )}

        {/* Response Area */}
        <div ref={responseContainerRef} className="flex-1 border border-slate-100 bg-slate-50/50 p-4 rounded-xl overflow-y-auto leading-relaxed text-xs text-slate-700 shadow-inner min-h-[150px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-8 text-slate-400 select-none">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              <span className="text-xs font-semibold">AI Copilot is processing scene...</span>
            </div>
          ) : aiResponse ? (
            <div className="prose prose-slate max-w-none text-xs font-normal">
              {renderMarkdown(aiResponse)}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-400 select-none py-8 text-center">
              <HelpCircle className="w-8 h-8 text-slate-350" />
              <p className="text-[11px] leading-normal px-4">
                {apiKey ? 'Click an action above to analyze or mutate your scene.' : 'Configure your Gemini API key below, then click an action above.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
