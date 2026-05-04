import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { OutputFormat } from '../types';
import { Loader2, Edit3, Sparkles } from 'lucide-react';

interface TextPanelProps {
  content: string;
  format: OutputFormat;
  lang: 'original' | 'translated';
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onUpdateContent: (newContent: string) => void;
  onAiReprocess: (oldText: string) => Promise<string>;
}

export function TextPanel({ 
  content, 
  format, 
  lang, 
  scrollRef, 
  onScroll, 
  onUpdateContent, 
  onAiReprocess 
}: TextPanelProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isProcessingAI, setIsProcessingAI] = useState(false);

  // Parse text format into stylized spans for matched fragments
  const renderHighlightedText = (text: string) => {
    const parts = text.split(/(\{.*?\})/g);
    return parts.map((part, i) => {
      if (part.startsWith('{') && part.endsWith('}')) {
        return <span key={i} className="bg-amber-500/20 text-orange-400 px-1 rounded font-bold">{part}</span>;
      }
      return part;
    });
  };

  // Substitute {fragments} with span tags for Markdown rendering
  const processMarkdownFragments = (text: string) => {
    return text.replace(/(\{.*?\})/g, '<span class="bg-amber-500/20 text-orange-400 px-1 rounded font-bold">$1</span>');
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isEditing || isProcessingAI) return;
    
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text && text.length > 0) {
      e.preventDefault();
      setSelectedText(text);
      setMenuPos({ x: e.clientX, y: e.clientY });
    } else {
      setMenuPos(null);
      setSelectedText('');
    }
  };

  const startEdit = () => {
    setEditValue(selectedText);
    setIsEditing(true);
    setMenuPos(null);
  };

  const saveEdit = () => {
    const newContent = content.replace(selectedText, editValue);
    if (newContent !== content) {
      onUpdateContent(newContent);
    }
    setIsEditing(false);
  };

  const handleAiReprocess = async () => {
    setMenuPos(null);
    setIsProcessingAI(true);
    try {
      const newText = await onAiReprocess(selectedText);
      if (newText) {
        const newContent = content.replace(selectedText, newText);
        onUpdateContent(newContent);
      }
    } catch (err) {
      console.error(err);
      alert("AI Reprocessing failed.");
    } finally {
      setIsProcessingAI(false);
    }
  };

  // Close context menu if clicking outside
  useEffect(() => {
    const clickHandler = () => {
      if (menuPos) setMenuPos(null);
    };
    window.addEventListener('mousedown', clickHandler);
    return () => window.removeEventListener('mousedown', clickHandler);
  }, [menuPos]);

  return (
    <div className="relative h-full w-full flex flex-col min-h-0 bg-slate-900 border border-slate-800 rounded-2xl shadow-inner overflow-hidden isolate">
      <div 
        ref={scrollRef as any}
        onScroll={onScroll}
        onContextMenu={handleContextMenu}
        className="flex-1 overflow-y-auto p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap selection:bg-amber-500/30"
      >
        {isProcessingAI && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
            <div className="flex bg-slate-900 border border-amber-500/50 p-4 rounded-xl items-center gap-3 shadow-xl">
               <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
               <span className="text-amber-500 text-sm font-bold">✨ AI is re-processing segment...</span>
            </div>
          </div>
        )}

        {format === 'Markdown' ? (
          <div className="prose prose-invert prose-amber max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeRaw]}>{processMarkdownFragments(content)}</ReactMarkdown>
          </div>
        ) : (
          renderHighlightedText(content)
        )}
      </div>

      {menuPos && !isEditing && (
        <div 
          className="fixed z-50 bg-slate-800 border border-slate-600 shadow-2xl rounded-lg p-1.5 flex flex-col w-48"
          style={{ top: Math.min(menuPos.y + 10, window.innerHeight - 100), left: Math.min(menuPos.x + 10, window.innerWidth - 200) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={startEdit} className="text-left px-3 py-2 hover:bg-slate-700 rounded text-sm text-slate-200 transition-colors flex items-center gap-2">
            <Edit3 className="w-4 h-4"/> Inline Edit
          </button>
          <div className="h-px bg-slate-700 my-1 mx-2" />
          <button onClick={handleAiReprocess} className="text-left px-3 py-2 hover:bg-slate-700 rounded text-sm text-amber-500 transition-colors flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> AI Re-process
          </button>
        </div>
      )}

      {isEditing && (
        <div className="absolute inset-0 z-40 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-6" onMouseDown={(e)=>e.stopPropagation()}>
          <div className="bg-slate-900 border border-slate-700 p-5 rounded-2xl w-full max-w-lg shadow-2xl">
            <h4 className="text-sm font-bold text-slate-300 mb-3 flex items-center gap-2"><Edit3 className="w-4 h-4"/> Edit Text Snippet</h4>
            <textarea 
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="w-full h-40 bg-slate-950 border border-slate-700 rounded-xl p-4 text-sm text-slate-300 focus:border-amber-500 outline-none resize-none mb-4 shadow-inner"
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsEditing(false)} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-400 hover:bg-slate-800 transition-colors">Cancel</button>
              <button onClick={saveEdit} className="px-5 py-2.5 rounded-xl text-sm bg-amber-500 text-slate-950 font-bold hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20">Save Revision</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
