import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { OutputFormat } from '../types';
import type { TranscriptCue } from '../types';
import { Loader2, Edit3, Sparkles } from 'lucide-react';
import { activeWordIndex as getActiveWordIndex, cuesToKaraokeLines, hasInlineTimestampMarkers, parseKaraokeLines } from '../lib/karaoke';
import { replaceSelectedText } from '../lib/text-revision';

interface TextPanelProps {
  content: string;
  format: OutputFormat;
  lang: 'original' | 'translated';
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onUpdateContent: (newContent: string) => void;
  onAiReprocess: (oldText: string) => Promise<string>;
  onPolishTranslation?: (oldText: string) => Promise<string>;
  onAddToGlossary?: (selectedText: string, lang: 'original' | 'translated') => void;
  karaokeEnabled?: boolean;
  karaokeTimeSec?: number;
  karaokeStartSec?: number;
  karaokeEndSec?: number;
  // Canonical structured cues. When present and the text has no inline [mm:ss]
  // markers (e.g. a session imported from the Apple Silicon edition), the
  // karaoke lines and per-word highlighting are driven by these cues — with
  // exact word timing when `words[]` is available.
  originalCues?: TranscriptCue[];
  translatedCues?: TranscriptCue[];
}

export function TextPanel({ 
  content, 
  format, 
  lang, 
  scrollRef, 
  onScroll, 
  onUpdateContent, 
  onAiReprocess,
  onPolishTranslation,
  onAddToGlossary,
  karaokeEnabled = false,
  karaokeTimeSec = 0,
  karaokeStartSec = 0,
  karaokeEndSec = 0,
  originalCues,
  translatedCues,
}: TextPanelProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectedContextText, setSelectedContextText] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const getSelectionInfo = useCallback((): { text: string; contextText: string } | null => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || !text || !internalScrollRef.current) return null;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      (anchorNode && !internalScrollRef.current.contains(anchorNode)) ||
      (focusNode && !internalScrollRef.current.contains(focusNode))
    ) {
      return null;
    }
    const contextElement = (selection.anchorNode?.parentElement ?? null)?.closest?.('.karaoke-line, .karaoke-plain-line');
    return {
      text,
      contextText: contextElement?.textContent?.replace(/^(?:\s*\[[^\]]+\]\s*)+/, '').trim() ?? '',
    };
  }, []);

  const karaokeLines = useMemo(() => {
    // Prefer structured cues when the chunk text carries no inline [mm:ss]
    // markers (e.g. sessions imported from the Swift edition, whose `original`
    // is clean text). Cues give exact segment + word timing. When the text has
    // its own markers (Electron-native) or no cues exist, fall back to parsing
    // markers — preserving existing behavior and edit consistency.
    const cues = lang === 'translated' ? translatedCues : originalCues;
    const cueLines = cues && cues.length > 0 && !hasInlineTimestampMarkers(content)
      ? cuesToKaraokeLines(cues)
      : [];
    return cueLines.length > 0 ? cueLines : parseKaraokeLines(content, karaokeStartSec, karaokeEndSec);
  }, [content, karaokeStartSec, karaokeEndSec, lang, originalCues, translatedCues]);

  const activeLineIndex = useMemo(() => {
    if (!karaokeEnabled) return -1;
    return karaokeLines.findIndex((line) => (
      line.kind === 'timed' && karaokeTimeSec >= line.startSec && karaokeTimeSec < line.endSec
    ));
  }, [karaokeEnabled, karaokeLines, karaokeTimeSec]);

  useEffect(() => {
    if (!karaokeEnabled || activeLineIndex < 0 || !internalScrollRef.current) return;
    const active = internalScrollRef.current.querySelector<HTMLElement>(`[data-karaoke-index="${activeLineIndex}"]`);
    active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeLineIndex, karaokeEnabled]);

  useEffect(() => {
    if (!isEditing) return;
    window.setTimeout(() => {
      editTextareaRef.current?.focus();
      editTextareaRef.current?.select();
    }, 0);
  }, [isEditing]);

  // Parse text format into stylized spans for matched fragments
  const renderHighlightedText = (text: string) => {
    const parts = text.split(/(\{.*?\})/g);
    return parts.map((part, i) => {
      if (part.startsWith('{') && part.endsWith('}')) {
        return <span key={i} className="text-fragment-highlight">{part}</span>;
      }
      return part;
    });
  };

  const renderKaraokeText = () => {
    return karaokeLines.map((line, lineIndex) => {
      if (line.kind === 'plain') {
        return <div key={lineIndex} className="karaoke-plain-line">{renderHighlightedText(line.text)}</div>;
      }

      const isActiveLine = lineIndex === activeLineIndex;
      const lineState = karaokeEnabled && activeLineIndex >= 0
        ? lineIndex < activeLineIndex
          ? 'past'
          : lineIndex > activeLineIndex
            ? 'future'
            : 'active'
        : '';
      const activeWord = isActiveLine
        ? getActiveWordIndex(line.words, line.startSec, line.endSec, karaokeTimeSec, line.timedWords)
        : -1;
      let wordIndex = -1;

      return (
        <div
          key={lineIndex}
          data-karaoke-index={lineIndex}
          className={`karaoke-line ${lineState}`}
        >
          <span className="karaoke-timestamp">[{line.timestamp}]</span>
          <span className="karaoke-text">
            {line.text.split(/(\s+)/).map((token, tokenIndex) => {
              if (/^\s+$/.test(token)) return token;
              wordIndex += 1;
              return (
                <span
                  key={tokenIndex}
                  className={wordIndex === activeWord ? 'karaoke-word active' : 'karaoke-word'}
                >
                  {renderHighlightedText(token)}
                </span>
              );
            })}
          </span>
        </div>
      );
    });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isEditing || isProcessingAI) return;
    
    const selectionInfo = getSelectionInfo();
    if (selectionInfo) {
      e.preventDefault();
      setSelectedText(selectionInfo.text);
      setSelectedContextText(selectionInfo.contextText);
      setMenuPos({ x: e.clientX, y: e.clientY });
    } else {
      setMenuPos(null);
      setSelectedText('');
      setSelectedContextText('');
    }
  };

  const startEdit = (selectionInfo?: { text: string; contextText: string } | null) => {
    const nextText = selectionInfo?.text ?? selectedText;
    if (!nextText.trim()) return;
    if (selectionInfo) {
      setSelectedText(selectionInfo.text);
      setSelectedContextText(selectionInfo.contextText);
    }
    setEditValue(nextText);
    setIsEditing(true);
    setMenuPos(null);
  };

  const applyContentUpdate = (nextContent: string) => {
    if (nextContent === content) return;
    setUndoStack((stack) => [...stack.slice(-24), content]);
    onUpdateContent(nextContent);
  };

  const saveEdit = () => {
    const result = replaceSelectedText(content, {
      selectedText,
      replacementText: editValue,
      contextText: selectedContextText,
    });
    if (result.changed) {
      applyContentUpdate(result.text);
    } else {
      alert('Could not apply the edit. Try selecting a slightly larger phrase.');
    }
    setIsEditing(false);
  };

  const handleAiReprocess = async (selectionInfo?: { text: string; contextText: string } | null) => {
    const textToProcess = selectionInfo?.text ?? selectedText;
    const contextToUse = selectionInfo?.contextText ?? selectedContextText;
    if (!textToProcess.trim()) return;
    setMenuPos(null);
    setIsProcessingAI(true);
    try {
      const newText = await onAiReprocess(textToProcess);
      if (newText) {
        const result = replaceSelectedText(content, {
          selectedText: textToProcess,
          replacementText: newText,
          contextText: contextToUse,
        });
        if (result.changed) applyContentUpdate(result.text);
      }
    } catch (err) {
      console.error(err);
      alert("AI Reprocessing failed.");
    } finally {
      setIsProcessingAI(false);
    }
  };

  const handlePolishTranslation = async (selectionInfo?: { text: string; contextText: string } | null) => {
    if (!onPolishTranslation) return;
    const textToProcess = selectionInfo?.text ?? selectedText;
    const contextToUse = selectionInfo?.contextText ?? selectedContextText;
    if (!textToProcess.trim()) return;
    setMenuPos(null);
    setIsProcessingAI(true);
    try {
      const newText = await onPolishTranslation(textToProcess);
      if (newText) {
        const result = replaceSelectedText(content, {
          selectedText: textToProcess,
          replacementText: newText,
          contextText: contextToUse,
        });
        if (result.changed) applyContentUpdate(result.text);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err || 'Unknown error');
      alert(`Translation polish failed.\n\n${message}`);
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

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape' && (menuPos || isEditing)) {
        event.preventDefault();
        setMenuPos(null);
        setIsEditing(false);
        return;
      }
      if (target?.closest?.('textarea, input, select, [contenteditable="true"]')) return;
      const selectionInfo = getSelectionInfo();
      if (selectionInfo && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (event.key === 'Tab') {
          event.preventDefault();
          startEdit(selectionInfo);
          return;
        }
        if (key === 'g' && onAddToGlossary) {
          event.preventDefault();
          setMenuPos(null);
          onAddToGlossary(selectionInfo.text, lang);
          return;
        }
        if (key === 'a') {
          event.preventDefault();
          void handleAiReprocess(selectionInfo);
          return;
        }
        if (key === 'p' && lang === 'translated' && onPolishTranslation) {
          event.preventDefault();
          void handlePolishTranslation(selectionInfo);
          return;
        }
      }
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      setUndoStack((stack) => {
        const previous = stack[stack.length - 1];
        if (!previous) return stack;
        event.preventDefault();
        onUpdateContent(previous);
        return stack.slice(0, -1);
      });
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [getSelectionInfo, handleAiReprocess, handlePolishTranslation, isEditing, lang, menuPos, onAddToGlossary, onPolishTranslation, onUpdateContent]);

  return (
    <div className="text-panel">
      <div 
        ref={(node) => {
          internalScrollRef.current = node;
          (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        onScroll={onScroll}
        onContextMenu={handleContextMenu}
        className="text-panel-scroll"
      >
        {isProcessingAI && (
          <div className="text-panel-overlay">
            <div className="text-panel-processing">
               <Loader2 size={18} className="spin" />
               <span>AI is revising segment...</span>
            </div>
          </div>
        )}

        {format === 'Markdown' ? (
          <div className="text-panel-markdown">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : karaokeEnabled ? (
          <div className="text-panel-karaoke">
            {renderKaraokeText()}
          </div>
        ) : (
          renderHighlightedText(content)
        )}
      </div>

      {menuPos && !isEditing && (
        <div 
          className="text-panel-menu"
          style={{ top: Math.min(menuPos.y + 10, window.innerHeight - 100), left: Math.min(menuPos.x + 10, window.innerWidth - 200) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => startEdit()}>
            <Edit3 size={14}/> Inline Edit
          </button>
          <div className="text-panel-menu-separator" />
          <button onClick={() => handleAiReprocess()} className="accent">
            <Sparkles size={14} /> Audio-Aware Review
          </button>
          {lang === 'translated' && onPolishTranslation && (
            <button onClick={() => handlePolishTranslation()} className="accent">
              <Sparkles size={14} /> Polish Translation
            </button>
          )}
          {onAddToGlossary && (
            <>
              <div className="text-panel-menu-separator" />
              <button onClick={() => {
                setMenuPos(null);
                onAddToGlossary(selectedText, lang);
              }}>
                <Sparkles size={14} /> Add to Glossary
              </button>
            </>
          )}
        </div>
      )}

      {isEditing && (
        <div className="text-panel-edit-overlay" onMouseDown={(e)=>e.stopPropagation()}>
          <div className="text-panel-edit-box">
            <h4><Edit3 size={14}/> Edit Text Snippet</h4>
            <textarea 
              ref={editTextareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsEditing(false);
                }
              }}
              className="text-panel-edit-textarea"
            />
            <div className="text-panel-edit-actions">
              <button onClick={() => setIsEditing(false)} className="btn-ghost-sm">Cancel</button>
              <button onClick={saveEdit} className="btn-save">Save Revision</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
