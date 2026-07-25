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
  }
];

const SYSTEM_PROMPT = `
You are the VaniScript AI Chat Assistant. You are fully integrated with VaniScript via local tools.
Your goal is to help users manage, refine, style, and export their transcription/translation project.

You have access to tools that can:
- Inspect project state (chunks, subtitles, crops).
- Update and correct original/translated chunk texts.
- Toggle chunk approval.
- Customize subtitle styles (font family, size, colors, shadows, borders).
- Plan, crop, and adjust background effects (blur, gradient, solid, feathering) for vertical clips (Shorts/Reels).
- Trigger final video renders.

When the user asks you to do something (e.g. "make text color orange" or "approve segment 4"), ALWAYS invoke the corresponding tool to execute the action immediately. Once the tool executes, confirm the success of the action clearly to the user.
Keep responses concise, helpful, and professional.
`;

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
      
      // Build conversation history for Gemini API
      // Filter only user and assistant messages, and map to { role, parts }
      const history: any[] = messages
        .filter(m => m.sender !== 'system')
        .map(m => ({
          role: m.sender === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }] as any
        }));

      history.push({
        role: 'user',
        parts: [{ text: userText }] as any
      });

      let currentContents: any[] = [...history];
      let loops = 0;
      let finalReply = '';
      let executedTools: Message['toolCalls'] = [];

      while (loops < 8) {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: currentContents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: MCP_TOOL_DECLARATIONS }] as any,
            temperature: 0.1,
          }
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        finalReply = response.text || '';

        const calls = parts.filter(p => p.functionCall);
        if (calls.length === 0) {
          break; // Loop completes when no more function calls
        }

        // Push model's call to history
        currentContents.push({ role: 'model', parts } as any);

        const responseParts = [];
        for (const call of calls) {
          if (!call.functionCall) continue;
          const { name, args } = call.functionCall;
          if (!name) continue;
          setActiveToolName(name);

          // Update message log with temporary tool call state
          executedTools.push({ name, args, status: 'running' });

          try {
            const result = await executeMcpTool(name, args);
            executedTools = executedTools.map(t => 
              t.name === name ? { ...t, status: 'done' as const } : t
            );
            responseParts.push({
              functionResponse: {
                name,
                response: { output: result }
              }
            });
          } catch (err: any) {
            const errMsg = err.message || String(err);
            executedTools = executedTools.map(t => 
              t.name === name ? { ...t, status: 'error' as const, error: errMsg } : t
            );
            responseParts.push({
              functionResponse: {
                name,
                response: { error: errMsg }
              }
            });
          }
        }

        currentContents.push({ role: 'user', parts: responseParts } as any);
        loops++;
      }

      setActiveToolName(null);
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          sender: 'assistant',
          text: finalReply || 'I have completed your request.',
          timestamp: new Date(),
          toolCalls: executedTools.length > 0 ? executedTools : undefined
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
