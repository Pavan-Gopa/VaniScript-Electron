import React, { useEffect, useRef } from 'react';
import { CheckCircle, Copy, Image, Mic, Paperclip, RotateCcw, Send, Sparkles, Square, X } from 'lucide-react';
import {
  ASSISTANT_REASONING,
  assistantStore,
  modelsForProfile,
  supportsReasoning,
  useAssistantStore,
  type AssistantStore,
} from '../stores/assistantStore';

export interface AssistantSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  store?: AssistantStore;
}

const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  color: 'var(--text-0, #fff)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 11,
};

const iconButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-0, #fff)',
  borderRadius: 8,
  padding: '6px 8px',
  cursor: 'pointer',
};

export function AssistantSidebar({ isOpen, onClose, store = assistantStore }: AssistantSidebarProps): React.ReactElement | null {
  const state = useAssistantStore(store);
  const profile = state.profiles.find((item) => item.id === state.profileId) || state.profiles[0];
  const models = profile ? modelsForProfile(profile) : [];
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const live = state.canCancel;

  useEffect(() => {
    if (isOpen) {
      void store.refreshProfiles();
      void store.refreshChallenges();
    }
  }, [isOpen, store]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, state.streamingText, state.phase]);

  if (!isOpen) return null;

  return (
    <>
      <div className="chat-sidebar-backdrop" onClick={onClose} />
      <div className="chat-sidebar-drawer" data-testid="assistant-sidebar" aria-label="Assistant">
        <div className="chat-sidebar-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="chat-sidebar-title">
            <Sparkles className="sparkles-icon" size={16} />
            <span>Assistant</span>
          </div>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'var(--text-2)' }}>
            Profile
            <select
              data-testid="assistant-profile"
              aria-label="Assistant profile"
              className="chat-route-select"
              style={selectStyle}
              value={state.profileId}
              disabled={live}
              onChange={(event) => store.setProfile(event.currentTarget.value as typeof state.profileId)}
            >
              {state.profiles.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'var(--text-2)' }}>
            Model
            <select
              data-testid="assistant-model"
              aria-label="Assistant model"
              className="chat-route-select"
              style={selectStyle}
              value={state.model}
              disabled={live}
              onChange={(event) => store.setModel(event.currentTarget.value)}
            >
              {models.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
              {!models.includes(state.model) && <option value={state.model}>{state.model}</option>}
            </select>
          </label>
          {profile && supportsReasoning(profile.id) && (
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'var(--text-2)' }}>
              Reasoning
              <select
                data-testid="assistant-reasoning"
                aria-label="Assistant reasoning"
                className="chat-route-select"
                style={selectStyle}
                value={state.reasoning}
                disabled={live}
                onChange={(event) => store.setReasoning(event.currentTarget.value as typeof state.reasoning)}
              >
                {ASSISTANT_REASONING.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="chat-sidebar-close" onClick={onClose} aria-label="Close assistant">
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 16px', fontSize: 11 }}>
          <span data-testid="assistant-phase" aria-live="polite">State: {state.phase}</span>
          {state.runningTool && (
            <span data-testid="assistant-running-tool" className="chat-active-tool">
              Running tool: <strong>{state.runningTool}</strong>
            </span>
          )}
          {state.lastRedactions.length > 0 && (
            <span data-testid="assistant-redactions">
              Redactions: {state.lastRedactions.map((item) => `${item.kind} ×${item.count}`).join(', ')}
            </span>
          )}
          {state.lastError && <span role="alert">{state.lastError}</span>}
        </div>

        {state.selection && (
          <div data-testid="assistant-selection-preview" style={{ margin: '0 16px 8px', padding: 10, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong>Send to Assistant · {state.selection.source}</strong>
              <button type="button" onClick={() => store.clearSelection()} style={iconButtonStyle}>Clear</button>
            </div>
            {state.selection.label && <div style={{ opacity: 0.7 }}>{state.selection.label}</div>}
            <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{state.selection.preview}</p>
          </div>
        )}

        {state.attachments.length > 0 && (
          <div style={{ display: 'grid', gap: 8, padding: '0 16px 8px' }}>
            {state.attachments.map((item) => (
              <div key={item.handle} data-testid="assistant-attachment-preview" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                {item.previewUrl?.startsWith('data:') ? (
                  <img src={item.previewUrl} alt={item.previewLabel} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} />
                ) : (
                  <Paperclip size={14} />
                )}
                <span>{item.previewLabel} · {item.previewKind}</span>
                <button type="button" onClick={() => store.removeAttachment(item.handle)} style={iconButtonStyle} aria-label={`Remove ${item.previewLabel}`}>Remove</button>
              </div>
            ))}
          </div>
        )}

        {state.challenges.map((challenge) => (
          <div key={challenge.challengeId} data-testid="assistant-challenge" style={{ margin: '0 16px 8px', padding: 10, border: '1px solid var(--accent, #ffaa19)', borderRadius: 10, fontSize: 12 }}>
            <div>{challenge.confirmationText}</div>
            <button
              type="button"
              data-testid="assistant-approve"
              style={{ ...iconButtonStyle, marginTop: 8, color: 'var(--accent)' }}
              onClick={() => { void store.approveChallenge(challenge.challengeId); }}
            >
              <CheckCircle size={14} /> Approve
            </button>
          </div>
        ))}

        <div className="chat-sidebar-messages">
          {state.messages.map((message) => (
            <div key={message.id} className={`chat-message-row ${message.role === 'assistant' ? 'assistant' : message.role}`}>
              <div className="chat-message-bubble">
                <p className="chat-message-text">{message.text}</p>
              </div>
            </div>
          ))}
          {state.streamingText && (
            <div className="chat-message-row assistant">
              <div className="chat-message-bubble">
                <p className="chat-message-text">{state.streamingText}</p>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-sidebar-input-area">
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button type="button" data-testid="assistant-copy" style={iconButtonStyle} onClick={() => { void store.copyLast(); }} aria-label="Copy last reply">
              <Copy size={14} /> Copy
            </button>
            <button type="button" data-testid="assistant-retry" style={iconButtonStyle} onClick={() => { void store.retryLast(); }} disabled={live || !state.lastUserInput} aria-label="Retry last prompt">
              <RotateCcw size={14} /> Retry
            </button>
            <button type="button" data-testid="assistant-dictate" style={iconButtonStyle} onClick={() => { void (state.dictationStatus === 'recording' ? store.stopDictation() : store.startDictation()); }} aria-label="Dictate">
              <Mic size={14} /> {state.dictationStatus === 'recording' ? 'Stop' : 'Dictate'}
            </button>
            <button type="button" data-testid="assistant-attach" style={iconButtonStyle} onClick={() => { void store.pickAttachment(); }} aria-label="Attach file">
              <Paperclip size={14} /> Attach
            </button>
            <button type="button" data-testid="assistant-screenshot" style={iconButtonStyle} onClick={() => { void store.pickScreenshot(); }} aria-label="Attach screenshot">
              <Image size={14} /> Screenshot
            </button>
          </div>
          <div data-testid="assistant-dictation-status" style={{ fontSize: 11, marginBottom: 8, color: 'var(--text-2)' }}>
            Dictation: {state.dictationStatus}
            {state.dictationMessage ? ` — ${state.dictationMessage}` : ''}
            {state.attachmentSeam === 'deferred' ? ' Attachment picker stays in Main.' : ''}
          </div>
          <div className="chat-input-wrapper">
            <textarea
              data-testid="assistant-draft"
              className="chat-textarea"
              placeholder="Ask the assistant about the selected transcript, document, shorts, or editor range…"
              value={state.draft}
              onChange={(event) => store.setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (live) void store.cancel();
                  else void store.send();
                }
              }}
              rows={2}
            />
            {live ? (
              <button type="button" data-testid="assistant-cancel" className="chat-send-btn" onClick={() => { void store.cancel(); }} aria-label="Stop assistant">
                <Square size={14} />
              </button>
            ) : (
              <button
                type="button"
                data-testid="assistant-send"
                className="chat-send-btn"
                onClick={() => { void store.send(); }}
                disabled={!state.draft.trim() && !state.selection && state.attachments.length === 0}
                aria-label="Send to assistant"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
