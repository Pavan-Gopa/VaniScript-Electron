import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, X, Send, Play, CheckCircle } from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import { AppSettings } from '../types';

interface ChatSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  executeMcpTool: (name: string, args: any) => Promise<any>;
  settings: AppSettings;
  chatRoute?: 'mcp' | 'api' | 'qwen';
  chatGrokModel?: string;
  chatQwenModel?: string;
  onChatConfigChange?: (patch: { chatRoute?: 'mcp' | 'api' | 'qwen'; chatGrokModel?: string; chatQwenModel?: string }) => void;
}

interface Message {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
  toolCalls?: Array<{ name: string; args: any; status: 'running' | 'done' | 'error'; error?: string }>;
}
type GeminiHistoryEntry = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};
const MCP_TOOL_DECLARATIONS = [
  {
    name: 'get_project_state',
    description: 'Get the active VaniScript project state (session, settings, screen, shorts plans, styles)',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'update_chunk_text',
    description: 'Update the transcription or translation text of a segment',
    parameters: {
      type: 'OBJECT',
      properties: {
        chunkIndex: { type: 'NUMBER', description: 'Index of the segment (0-based)' },
        original: { type: 'STRING', description: 'New original transcript text (optional)' },
        translated: { type: 'STRING', description: 'New translation text (optional)' }
      },
      required: ['chunkIndex']
    }
  },
  {
    name: 'approve_chunk',
    description: 'Approve or revoke approval for a specific segment',
    parameters: {
      type: 'OBJECT',
      properties: {
        chunkIndex: { type: 'NUMBER', description: 'Index of the segment (0-based)' },
        approved: { type: 'BOOLEAN', description: 'True to approve, false to revoke' }
      },
      required: ['chunkIndex', 'approved']
    }
  },
  {
    name: 'get_subtitle_style',
    description: 'Get active subtitle style settings',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'update_subtitle_style',
    description: 'Update the style properties for video subtitles',
    parameters: {
      type: 'OBJECT',
      properties: {
        stylePatch: {
          type: 'OBJECT',
          description: 'Partial patch for subtitle style parameters (textColor, fontSize, fontFamily, bold, outline, shadow, etc.)'
        }
      },
      required: ['stylePatch']
    }
  },
  {
    name: 'get_shorts_plans',
    description: 'List all vertical shorts clip plans planned in timeline',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'create_shorts_plan',
    description: 'Create a new vertical shorts plan segment in timeline',
    parameters: {
      type: 'OBJECT',
      properties: {
        plan: {
          type: 'OBJECT',
          description: 'Plan properties like title, start (MM:SS), end (MM:SS), hook, summary, etc.'
        }
      },
      required: ['plan']
    }
  },
  {
    name: 'set_background_settings',
    description: 'Update background settings for active shorts plan (solid color, blur, linear/radial gradient, feathering)',
    parameters: {
      type: 'OBJECT',
      properties: {
        settings: {
          type: 'OBJECT',
          description: 'Partial background configuration properties (e.g. solidEnabled, blurEnabled, featherTop, etc.)'
        }
      },
      required: ['settings']
    }
  },
  {
    name: 'trigger_render',
    description: 'Trigger rendering and export for a shorts plan index',
    parameters: {
      type: 'OBJECT',
      properties: {
        planIndex: { type: 'NUMBER', description: 'Index of the shorts plan to export' }
      },
      required: ['planIndex']
    }
  },
  {
    name: 'list_help_topics',
    description: 'List built-in VaniScript help topics for feature discovery.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: 'Optional exact help category.' },
        language: { type: 'STRING', description: 'Help language: canonical en or ru.' },
      },
    },
  },
  {
    name: 'get_help_topic',
    description: 'Read one built-in help topic with requirements, instructions, troubleshooting, and related topics.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topicId: { type: 'STRING', description: 'Topic ID returned by search_help or list_help_topics.' },
        language: { type: 'STRING', description: 'Help language: canonical en or ru.' },
      },
      required: ['topicId'],
    },
  },
  {
    name: 'search_help',
    description: 'Search built-in help topics by a non-empty question or feature name.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Non-empty help question or feature name.' },
        language: { type: 'STRING', description: 'Help language: canonical en or ru.' },
        limit: { type: 'NUMBER', description: 'Maximum 10 results.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_contextual_help',
    description: 'Read exact next actions for the current screen and project state.',
    parameters: {
      type: 'OBJECT',
      properties: {
        language: { type: 'STRING', description: 'Help language: canonical en or ru.' },
      },
    },
  },
  {
    name: 'get_onboarding_checklist',
    description: 'Read the complete first-project workflow checklist.',
    parameters: {
      type: 'OBJECT',
      properties: {
        language: { type: 'STRING', description: 'Help language: canonical en or ru.' },
      },
    },
  },
];

// These declarations describe the tools available to the embedded MCP routes.
// Never pass them to, or claim their execution from, the direct Gemini route.
const MCP_SYSTEM_PROMPT = `
You are the VaniScript AI Chat Assistant on an MCP-capable route. You are fully integrated with VaniScript via local tools.
Your goal is to help users manage, refine, style, and export their transcription/translation project.

You have access to tools that can:
- Inspect project state (chunks, subtitles, crops).
- Update and correct original/translated chunk texts.
- Toggle chunk approval.
- Customize subtitle styles (font family, size, colors, shadows, borders).
- Plan, crop, and adjust background effects (blur, gradient, solid, feathering) for vertical clips (Shorts/Reels).
- Trigger final video renders.

For how-to questions about VaniScript screens, features, controls, settings, or workflows, call search_help before answering in the language of the latest user message. If the answer depends on the current screen or project state, also call get_contextual_help. If a beginner asks where to start, call get_onboarding_checklist. Use exact English button and screen labels returned by the tools while explaining the steps in the user's language. Pass only canonical help language values en or ru; help language never changes source or target translation language or transcript content.

When the user asks you to do something (for example, make text color orange or approve segment 4), ALWAYS invoke the corresponding mutation tool to execute the action immediately. Once the tool executes, confirm the success of the action clearly to the user.
Keep responses concise, helpful, and professional.
`;

const DIRECT_API_SYSTEM_PROMPT = `
You are the VaniScript AI Chat Assistant on the direct API route. Answer using the conversation provided.
This route has no VaniScript MCP tool loop and no tool execution capability. Never claim that you called, ran, or completed an MCP tool. If the user needs screen-specific instructions, direct them to the Help Center or local catalog; do not invent current project state or mutation results.
Keep responses concise, helpful, and professional.
`;

/*
 * Kept as a declaration mirror for the embedded MCP route. The API route
 * intentionally uses DIRECT_API_SYSTEM_PROMPT and never receives this list.
 */
const SYSTEM_PROMPT = MCP_SYSTEM_PROMPT;

export function ChatSidebar({ isOpen, onClose, executeMcpTool, settings, chatRoute = 'api', chatGrokModel = 'grok-4.5', chatQwenModel = 'qwen3.8-max-preview', onChatConfigChange }: ChatSidebarProps) {
  const route = chatRoute;
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: 'Hare Krsna! I am your VaniScript AI Assistant. How can I help you edit your transcription, style your captions, or prepare your shorts today?',
      timestamp: new Date()
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, activeToolName]);

  const handleSend = async () => {
    if (!inputText.trim() || isLoading) return;
    const userText = inputText.trim();
    setInputText('');

    const userMsgId = Math.random().toString(36).substring(2, 9);
    const userMessage: Message = {
      id: userMsgId,
      sender: 'user',
      text: userText,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);

    if (route === 'mcp') {
      await handleSendGrok(userText, userMessage);
      return;
    }

    if (route === 'qwen') {
      await handleSendQwen(userText, userMessage);
      return;
    }

    if (!settings.geminiKey) {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: 'Error: Gemini API Key is missing. Please configure it in Settings first.',
          timestamp: new Date()
        }
      ]);
      setIsLoading(false);
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: settings.geminiKey });

      const history: GeminiHistoryEntry[] = messages
        .filter(m => m.sender !== 'system')
        .map(m => ({
          role: m.sender === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }]
        }));

      history.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: history,
        config: {
          systemInstruction: DIRECT_API_SYSTEM_PROMPT,
          temperature: 0.1,
        }
      });

      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'assistant',
          text: response.text || 'I can help explain VaniScript, but I cannot execute MCP tools on this route.',
          timestamp: new Date()
        }
      ]);
    } catch (error: any) {
      console.error('Chat Assistant Error:', error);
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: `Error calling AI assistant: ${error.message || String(error)}`,
          timestamp: new Date()
        }
      ]);
    } finally {
      setIsLoading(false);
      setActiveToolName(null);
    }
  };

  const handleSendGrok = async (userText: string, userMessage: Message) => {
    const api = window.electronAPI;
    if (!api?.grokChat) {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: 'Embedded Grok chat is not available in this build.',
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      return;
    }

    const assistantId = Math.random().toString(36).substring(2, 9);
    setMessages(prev => [
      ...prev,
      { id: assistantId, sender: 'assistant', text: '', timestamp: new Date() },
    ]);

    const history = [
      ...messages
        .filter(m => m.sender !== 'system')
        .map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', text: m.text })),
      { role: 'user', text: userText },
    ];

    const unsubChunk = api.onGrokChunk?.(({ text }) => {
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, text: m.text + text } : m)));
    }) ?? (() => {});

    const unsubError = api.onGrokError?.(({ error, message }) => {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: `Grok error (${error}): ${message || ''}`.trim(),
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }) ?? (() => {});

    const unsubDone = api.onGrokDone?.(() => {
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }) ?? (() => {});

    try {
      await api.grokChat({ messages: history, systemPrompt: SYSTEM_PROMPT, model: chatGrokModel });
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: `Grok error: ${err?.message || String(err)}`,
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }
  };

  // Embedded Qwen route: mirrors handleSendGrok via the qwen:* IPC bridge.
  const handleSendQwen = async (userText: string, _userMessage: Message) => {
    const api = window.electronAPI;
    if (!api?.qwenChat) {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: 'Embedded Qwen chat is not available in this build.',
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      return;
    }

    const assistantId = Math.random().toString(36).substring(2, 9);
    setMessages(prev => [
      ...prev,
      { id: assistantId, sender: 'assistant', text: '', timestamp: new Date() },
    ]);

    const history = [
      ...messages
        .filter(m => m.sender !== 'system')
        .map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', text: m.text })),
      { role: 'user', text: userText },
    ];

    const unsubChunk = api.onQwenChunk?.(({ text }) => {
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, text: m.text + text } : m)));
    }) ?? (() => {});

    const unsubError = api.onQwenError?.(({ error, message }) => {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: `Qwen error (${error}): ${message || ''}`.trim(),
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }) ?? (() => {});

    const unsubDone = api.onQwenDone?.(() => {
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }) ?? (() => {});

    try {
      await api.qwenChat({ messages: history, systemPrompt: SYSTEM_PROMPT, model: chatQwenModel });
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'system',
          text: `Qwen error: ${err?.message || String(err)}`,
          timestamp: new Date(),
        },
      ]);
      setIsLoading(false);
      unsubChunk();
      unsubError();
      unsubDone();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="chat-sidebar-backdrop" onClick={onClose} />

      {/* Drawer */}
      <div className="chat-sidebar-drawer">
        {/* Header */}
        <div className="chat-sidebar-header">
          <div className="chat-sidebar-title">
            <Sparkles className="sparkles-icon" size={16} />
            <span>AI Assistant</span>
          </div>
          <select
            className="chat-route-select"
            value={route}
            title="Chat route"
            onChange={(e) => onChatConfigChange?.({ chatRoute: e.target.value as 'mcp' | 'api' | 'qwen' })}
          >
            <option value="api">API · Gemini</option>
            <option value="mcp">MCP · Grok</option>
            <option value="qwen">MCP · Qwen</option>
          </select>
          <button className="chat-sidebar-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Messages */}
        <div className="chat-sidebar-messages">
          {messages.map(msg => (
            <div key={msg.id} className={`chat-message-row ${msg.sender}`}>
              <div className="chat-message-bubble">
                <p className="chat-message-text">{msg.text}</p>
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="chat-message-tools">
                    {msg.toolCalls.map((tool, idx) => (
                      <div key={idx} className={`chat-tool-pill ${tool.status}`}>
                        {tool.status === 'running' && <div className="tool-spinner" />}
                        {tool.status === 'done' && <CheckCircle size={12} className="tool-icon-done" />}
                        <span>{tool.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="chat-message-row assistant loading">
              <div className="chat-message-bubble">
                <div className="chat-loading-dots">
                  <span />
                  <span />
                  <span />
                </div>
                {activeToolName && (
                  <div className="chat-active-tool">
                    <span>Running tool: <strong>{activeToolName}</strong>...</span>
                  </div>
                )}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="chat-sidebar-input-area">
          <div className="chat-input-wrapper">
            <textarea
              className="chat-textarea"
              placeholder="Ask AI to style subtitles, crop clips, approve segments..."
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyPress}
              rows={2}
            />
            <button 
              className="chat-send-btn"
              onClick={handleSend}
              disabled={!inputText.trim() || isLoading}
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
