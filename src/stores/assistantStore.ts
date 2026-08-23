import { useSyncExternalStore } from 'react';

export const ASSISTANT_PROFILES = ['codex', 'grok', 'qwen'] as const;
export type AssistantProfileId = (typeof ASSISTANT_PROFILES)[number];

export const ASSISTANT_PHASES = ['idle', 'starting', 'streaming', 'done', 'error', 'cancelled'] as const;
export type AssistantPhase = (typeof ASSISTANT_PHASES)[number];

export const ASSISTANT_REASONING = ['low', 'medium', 'high'] as const;
export type AssistantReasoning = (typeof ASSISTANT_REASONING)[number];

export const ASSISTANT_SOURCES = ['transcript', 'document', 'shorts', 'editor'] as const;
export type AssistantSource = (typeof ASSISTANT_SOURCES)[number];

export const MCP_CONFIRM_CHALLENGE_CHANNEL = 'mcp:confirmChallenge' as const;

export const MAX_SELECTION_CHARS = 4000;
export const MAX_SELECTION_PREVIEW = 280;

export const DICTATION_DEFERRED =
  'Dictation backend seam is deferred: mic capture must stay in Main and call local ASR without returning filesystem paths or inventing a transcript.';

export const AGENT_STREAM_SEAM_DEFERRED =
  'Agent stream IPC seam is not exposed; inject AgentClients.start/cancel for the D4 transport.';

export const ASSISTANT_PROFILE_MODELS: Record<AssistantProfileId, readonly string[]> = {
  codex: ['gpt-5', 'gpt-5-mini', 'o3'],
  grok: ['grok-4.1', 'grok-4', 'grok-3'],
  qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
};

export const DEFAULT_ASSISTANT_PROFILES: readonly AssistantProfile[] = [
  { id: 'codex', label: 'Codex', provider: 'openai', defaultModel: 'gpt-5', requiresKey: true },
  { id: 'grok', label: 'Grok', provider: 'xai', defaultModel: 'grok-4.1', requiresKey: true },
  { id: 'qwen', label: 'Qwen', provider: 'dashscope', defaultModel: 'qwen-max', requiresKey: true },
];

export interface AssistantProfile {
  id: AssistantProfileId;
  label: string;
  provider: string;
  defaultModel: string;
  requiresKey: boolean;
}

export interface AssistantRedaction {
  kind: 'path' | 'secret';
  count: number;
}

export interface AssistantSelection {
  source: AssistantSource;
  text: string;
  preview: string;
  label?: string;
  truncated: boolean;
}

export interface AssistantAttachment {
  handle: string;
  previewLabel: string;
  previewKind: 'file' | 'screenshot';
  previewUrl?: string;
}

export interface AssistantChallenge {
  challengeId: string;
  confirmationText: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export type DictationStatus = 'idle' | 'recording' | 'transcribing' | 'deferred';

export interface AgentStreamLike {
  id?: string;
  cancel: () => unknown;
  onToken?: (listener: (token: string) => void) => unknown;
  onDone?: (listener: (value: unknown) => void) => unknown;
  onError?: (listener: (error: unknown) => void) => unknown;
  status?: () => { status?: string; state?: string; redactions?: unknown };
}

export interface AssistantStartRequest {
  input: string;
  model?: string;
  reasoning?: AssistantReasoning;
  context?: Record<string, unknown>;
}

export interface AssistantBridge {
  listProfiles?: () => readonly AssistantProfile[] | Promise<readonly AssistantProfile[]>;
  start: (profile: AssistantProfileId, request: AssistantStartRequest) => AgentStreamLike;
  confirmChallenge?: (challengeId: string) => Promise<boolean> | boolean;
  listChallenges?: () => readonly AssistantChallenge[] | Promise<readonly AssistantChallenge[]>;
  pickAttachment?: () => Promise<AssistantAttachment | null> | AssistantAttachment | null;
  pickScreenshot?: () => Promise<AssistantAttachment | null> | AssistantAttachment | null;
  startDictation?: () => Promise<void> | void;
  stopDictation?: () => Promise<string | null> | string | null;
  copyText?: (text: string) => Promise<void> | void;
}

export interface AssistantStoreSnapshot {
  profiles: readonly AssistantProfile[];
  profileId: AssistantProfileId;
  model: string;
  reasoning: AssistantReasoning;
  phase: AssistantPhase;
  draft: string;
  messages: readonly AssistantMessage[];
  streamingText: string;
  streamId: string | null;
  canCancel: boolean;
  lastError: string | null;
  lastRedactions: readonly AssistantRedaction[];
  runningTool: string | null;
  selection: AssistantSelection | null;
  attachments: readonly AssistantAttachment[];
  challenges: readonly AssistantChallenge[];
  dictationStatus: DictationStatus;
  dictationMessage: string | null;
  attachmentSeam: 'ready' | 'deferred';
  lastUserInput: string | null;
}

export interface AssistantStore {
  getState(): AssistantStoreSnapshot;
  subscribe(listener: () => void): () => void;
  refreshProfiles(): Promise<void>;
  setProfile(profileId: AssistantProfileId): void;
  setModel(model: string): void;
  setReasoning(reasoning: AssistantReasoning): void;
  setDraft(draft: string): void;
  send(): Promise<void>;
  cancel(): Promise<void>;
  copyLast(): Promise<string | null>;
  retryLast(): Promise<void>;
  queueSelection(input: { source: AssistantSource; text: string; label?: string }): AssistantSelection | null;
  clearSelection(): void;
  surfaceChallenge(challenge: AssistantChallenge): void;
  refreshChallenges(): Promise<void>;
  approveChallenge(challengeId: string): Promise<boolean>;
  noteRunningTool(name: string | null): void;
  pickAttachment(): Promise<void>;
  pickScreenshot(): Promise<void>;
  removeAttachment(handle: string): void;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
}

const PATH_LIKE = /(?:^|[^\w])(?:\/|[A-Za-z]:\\)/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const record = asRecord(error);
  if (record && typeof record.message === 'string') return record.message;
  return String(error);
}

function errorCode(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : '';
}

export function supportsReasoning(profileId: AssistantProfileId): boolean {
  return profileId !== 'grok';
}

export function modelsForProfile(profile: AssistantProfile): string[] {
  const catalog = ASSISTANT_PROFILE_MODELS[profile.id] || [];
  return catalog.includes(profile.defaultModel) ? [...catalog] : [profile.defaultModel, ...catalog];
}

export function looksLikeFsPath(value: string): boolean {
  return PATH_LIKE.test(value) || value.includes('\\') || value.startsWith('/');
}

export function isOpaqueAttachment(item: AssistantAttachment): boolean {
  if (!item || typeof item.handle !== 'string' || item.handle.length === 0) return false;
  if (typeof item.previewLabel !== 'string' || item.previewLabel.length === 0) return false;
  if (item.previewKind !== 'file' && item.previewKind !== 'screenshot') return false;
  if (looksLikeFsPath(item.handle)) return false;
  if (item.previewUrl && looksLikeFsPath(item.previewUrl) && !item.previewUrl.startsWith('data:')) return false;
  return true;
}

export function shapeSendToAssistant(input: {
  source: AssistantSource;
  text: string;
  label?: string;
}): AssistantSelection | null {
  if (!ASSISTANT_SOURCES.includes(input.source)) return null;
  const text = String(input.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const bounded = text.slice(0, MAX_SELECTION_CHARS);
  return {
    source: input.source,
    text: bounded,
    preview: bounded.slice(0, MAX_SELECTION_PREVIEW),
    label: input.label,
    truncated: text.length > MAX_SELECTION_CHARS,
  };
}

export function composeAssistantInput(
  draft: string,
  selection: AssistantSelection | null,
  attachments: readonly AssistantAttachment[],
): string {
  const parts: string[] = [];
  if (selection) {
    const heading = selection.label ? `${selection.source} · ${selection.label}` : selection.source;
    parts.push(`[${heading}]\n${selection.text}`);
  }
  if (attachments.length > 0) {
    parts.push(attachments.map((item) => `[attachment:${item.handle} ${item.previewKind} ${item.previewLabel}]`).join('\n'));
  }
  const prompt = draft.trim();
  if (prompt) parts.push(prompt);
  return parts.join('\n\n');
}

export function redactionsFromPayload(value: unknown): AssistantRedaction[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const kind = record.kind === 'secret' ? 'secret' : record.kind === 'path' ? 'path' : null;
      const count = typeof record.count === 'number' ? record.count : 0;
      return kind && count > 0 ? [{ kind, count }] : [];
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  const out: AssistantRedaction[] = [];
  if (typeof record.path === 'number' && record.path > 0) out.push({ kind: 'path', count: record.path });
  if (typeof record.secret === 'number' && record.secret > 0) out.push({ kind: 'secret', count: record.secret });
  return out;
}

function challengeFromUnknown(value: unknown): AssistantChallenge | null {
  const record = asRecord(value);
  const details = asRecord(record?.details) || record;
  if (!details) return null;
  if (typeof details.challengeId !== 'string' || details.challengeId.length === 0) return null;
  if (typeof details.confirmationText !== 'string' || details.confirmationText.length === 0) return null;
  return { challengeId: details.challengeId, confirmationText: details.confirmationText };
}

function asProfiles(value: unknown): AssistantProfile[] {
  if (!Array.isArray(value)) return [...DEFAULT_ASSISTANT_PROFILES];
  const mapped = value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || !ASSISTANT_PROFILES.includes(record.id as AssistantProfileId)) return [];
    return [{
      id: record.id as AssistantProfileId,
      label: typeof record.label === 'string' ? record.label : String(record.id),
      provider: typeof record.provider === 'string' ? record.provider : String(record.id),
      defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel : ASSISTANT_PROFILE_MODELS[record.id as AssistantProfileId][0],
      requiresKey: record.requiresKey !== false,
    }];
  });
  return mapped.length > 0 ? mapped : [...DEFAULT_ASSISTANT_PROFILES];
}

function mapStreamPhase(raw: string | undefined): AssistantPhase | null {
  if (raw === 'connecting' || raw === 'starting') return 'starting';
  if (raw === 'streaming' || raw === 'done' || raw === 'error' || raw === 'cancelled') return raw;
  return null;
}

function windowBridge(): AssistantBridge {
  const api = typeof window === 'undefined' ? null : asRecord((window as unknown as { electronAPI?: unknown }).electronAPI);
  return {
    listProfiles: () => {
      const list = api?.listAgentProfiles;
      return typeof list === 'function' ? (list as () => AssistantProfile[])() : DEFAULT_ASSISTANT_PROFILES;
    },
    start: (profile, request) => {
      const start = api?.startAgentStream;
      if (typeof start !== 'function') throw new Error(AGENT_STREAM_SEAM_DEFERRED);
      return (start as AssistantBridge['start'])(profile, request);
    },
    confirmChallenge: (challengeId) => {
      const confirm = api?.confirmMcpChallenge;
      if (typeof confirm === 'function') return (confirm as (id: string) => Promise<boolean>)(challengeId);
      const invoke = api?.invoke;
      if (typeof invoke === 'function') {
        return Promise.resolve((invoke as (channel: string, payload: unknown) => Promise<{ approved?: boolean }>)(
          MCP_CONFIRM_CHALLENGE_CHANNEL,
          { challengeId },
        )).then((result) => Boolean(asRecord(result)?.approved));
      }
      throw new Error(`${MCP_CONFIRM_CHALLENGE_CHANNEL} is not exposed to the renderer.`);
    },
    listChallenges: () => {
      const list = api?.listMcpChallenges;
      return typeof list === 'function' ? (list as () => AssistantChallenge[])() : [];
    },
    pickAttachment: () => {
      const pick = api?.pickAssistantAttachment;
      return typeof pick === 'function' ? (pick as () => Promise<AssistantAttachment | null>)() : null;
    },
    pickScreenshot: () => {
      const pick = api?.pickAssistantScreenshot;
      return typeof pick === 'function' ? (pick as () => Promise<AssistantAttachment | null>)() : null;
    },
    startDictation: api && typeof api.startAssistantDictation === 'function'
      ? () => (api.startAssistantDictation as () => void)()
      : undefined,
    stopDictation: api && typeof api.stopAssistantDictation === 'function'
      ? () => (api.stopAssistantDictation as () => string | null)()
      : undefined,
    copyText: (text) => {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard && typeof clipboard.writeText === 'function') return clipboard.writeText(text);
    },
  };
}

const INITIAL_STATE: AssistantStoreSnapshot = {
  profiles: DEFAULT_ASSISTANT_PROFILES,
  profileId: 'codex',
  model: 'gpt-5',
  reasoning: 'medium',
  phase: 'idle',
  draft: '',
  messages: [],
  streamingText: '',
  streamId: null,
  canCancel: false,
  lastError: null,
  lastRedactions: [],
  runningTool: null,
  selection: null,
  attachments: [],
  challenges: [],
  dictationStatus: 'idle',
  dictationMessage: null,
  attachmentSeam: 'ready',
  lastUserInput: null,
};

export function createAssistantStore(providedBridge?: AssistantBridge): AssistantStore {
  const bridge = providedBridge ?? windowBridge();
  let state: AssistantStoreSnapshot = { ...INITIAL_STATE, profiles: asProfiles(undefined) };
  const listeners = new Set<() => void>();
  let runId = 0;
  let seq = 0;
  let activeStream: AgentStreamLike | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const update = (patch: Partial<AssistantStoreSnapshot>) => {
    state = { ...state, ...patch };
    emit();
  };
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const refreshProfiles = async (): Promise<void> => {
    if (typeof bridge.listProfiles !== 'function') return;
    const listed = await bridge.listProfiles();
    const profiles = asProfiles(listed);
    const current = profiles.find((profile) => profile.id === state.profileId) || profiles[0];
    update({
      profiles,
      profileId: current.id,
      model: profiles.some((profile) => profile.id === state.profileId)
        ? state.model
        : current.defaultModel,
    });
  };

  void refreshProfiles();

  const setProfile = (profileId: AssistantProfileId) => {
    const profile = state.profiles.find((item) => item.id === profileId) || DEFAULT_ASSISTANT_PROFILES.find((item) => item.id === profileId);
    if (!profile) return;
    update({
      profileId: profile.id,
      model: profile.defaultModel,
      reasoning: supportsReasoning(profile.id) ? state.reasoning : 'medium',
    });
  };

  const sendInput = async (input: string): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || state.canCancel) return;
    const id = ++runId;
    const userMessage: AssistantMessage = { id: nextId('user'), role: 'user', text: trimmed };
    update({
      phase: 'starting',
      canCancel: true,
      lastError: null,
      streamingText: '',
      lastUserInput: trimmed,
      draft: '',
      messages: [...state.messages, userMessage],
    });
    try {
      const stream = bridge.start(state.profileId, {
        input: trimmed,
        model: state.model,
        reasoning: supportsReasoning(state.profileId) ? state.reasoning : undefined,
        context: {
          projectId: 'default',
          source: state.selection?.source,
          attachmentHandles: state.attachments.map((item) => item.handle),
        },
      });
      activeStream = stream;
      update({
        streamId: typeof stream.id === 'string' ? stream.id : nextId('stream'),
        phase: mapStreamPhase(stream.status?.().state || stream.status?.().status) || 'starting',
      });
      const onToken = (token: string) => {
        if (id !== runId) return;
        update({
          phase: 'streaming',
          streamingText: `${state.streamingText}${token}`,
        });
      };
      const onDone = (value: unknown) => {
        if (id !== runId) return;
        activeStream = null;
        const record = asRecord(value);
        const text = state.streamingText || (typeof record?.output === 'string' ? record.output : '');
        update({
          phase: 'done',
          canCancel: false,
          streamId: null,
          streamingText: '',
          runningTool: null,
          lastRedactions: redactionsFromPayload(record?.redactions),
          messages: text
            ? [...state.messages, { id: nextId('assistant'), role: 'assistant', text }]
            : state.messages,
        });
      };
      const onError = (error: unknown) => {
        if (id !== runId) return;
        activeStream = null;
        const challenge = challengeFromUnknown(error);
        const cancelled = errorCode(error) === 'CANCELLED';
        update({
          phase: cancelled ? 'cancelled' : 'error',
          canCancel: false,
          streamId: null,
          lastError: cancelled ? null : errorText(error),
          lastRedactions: redactionsFromPayload(asRecord(error)?.details && asRecord(asRecord(error)?.details)?.redactions) || redactionsFromPayload(asRecord(error)?.redactions),
          challenges: challenge
            ? [...state.challenges.filter((item) => item.challengeId !== challenge.challengeId), challenge]
            : state.challenges,
          messages: state.streamingText
            ? [...state.messages, { id: nextId('assistant'), role: 'assistant', text: state.streamingText }]
            : state.messages,
          streamingText: '',
        });
      };
      stream.onToken?.(onToken);
      stream.onDone?.(onDone);
      stream.onError?.(onError);
    } catch (error) {
      if (id !== runId) return;
      activeStream = null;
      update({
        phase: 'error',
        canCancel: false,
        streamId: null,
        lastError: errorText(error),
      });
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refreshProfiles,
    setProfile,
    setModel: (model) => {
      if (typeof model === 'string' && model.length > 0) update({ model });
    },
    setReasoning: (reasoning) => {
      if (ASSISTANT_REASONING.includes(reasoning)) update({ reasoning });
    },
    setDraft: (draft) => update({ draft }),
    send: () => sendInput(composeAssistantInput(state.draft, state.selection, state.attachments)),
    cancel: async () => {
      const stream = activeStream;
      runId += 1;
      activeStream = null;
      update({
        phase: 'cancelled',
        canCancel: false,
        streamId: null,
        runningTool: null,
      });
      if (stream && typeof stream.cancel === 'function') await stream.cancel();
    },
    copyLast: async () => {
      const last = [...state.messages].reverse().find((message) => message.role === 'assistant' && message.text);
      const text = last?.text || state.streamingText;
      if (!text) return null;
      if (typeof bridge.copyText === 'function') await bridge.copyText(text);
      else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      return text;
    },
    retryLast: () => {
      if (!state.lastUserInput || state.canCancel) return Promise.resolve();
      return sendInput(state.lastUserInput);
    },
    queueSelection: (input) => {
      const selection = shapeSendToAssistant(input);
      if (!selection) return null;
      update({ selection });
      return selection;
    },
    clearSelection: () => update({ selection: null }),
    surfaceChallenge: (challenge) => {
      if (!challenge?.challengeId || !challenge.confirmationText) return;
      update({
        challenges: [...state.challenges.filter((item) => item.challengeId !== challenge.challengeId), challenge],
      });
    },
    refreshChallenges: async () => {
      if (typeof bridge.listChallenges !== 'function') return;
      const listed = await bridge.listChallenges();
      if (Array.isArray(listed)) update({ challenges: listed.filter((item) => item?.challengeId && item.confirmationText) });
    },
    approveChallenge: async (challengeId) => {
      if (typeof challengeId !== 'string' || challengeId.length === 0) return false;
      if (typeof bridge.confirmChallenge !== 'function') {
        update({ lastError: `${MCP_CONFIRM_CHALLENGE_CHANNEL} is not exposed to the renderer.` });
        return false;
      }
      const approved = Boolean(await bridge.confirmChallenge(challengeId));
      if (approved) {
        update({
          challenges: state.challenges.filter((item) => item.challengeId !== challengeId),
          runningTool: null,
        });
      }
      return approved;
    },
    noteRunningTool: (name) => update({ runningTool: name && name.length > 0 ? name : null }),
    pickAttachment: async () => {
      if (typeof bridge.pickAttachment !== 'function') {
        update({ attachmentSeam: 'deferred' });
        return;
      }
      const item = await bridge.pickAttachment();
      if (!item) {
        update({ attachmentSeam: 'deferred' });
        return;
      }
      if (!isOpaqueAttachment(item)) {
        update({ lastError: 'Attachment path must stay in Main; renderer accepts an opaque handle and preview only.' });
        return;
      }
      update({ attachments: [...state.attachments, item], attachmentSeam: 'ready' });
    },
    pickScreenshot: async () => {
      if (typeof bridge.pickScreenshot !== 'function') {
        update({ attachmentSeam: 'deferred' });
        return;
      }
      const item = await bridge.pickScreenshot();
      if (!item) {
        update({ attachmentSeam: 'deferred' });
        return;
      }
      if (!isOpaqueAttachment(item)) {
        update({ lastError: 'Screenshot path must stay in Main; renderer accepts an opaque handle and preview only.' });
        return;
      }
      update({ attachments: [...state.attachments, { ...item, previewKind: 'screenshot' }], attachmentSeam: 'ready' });
    },
    removeAttachment: (handle) => update({ attachments: state.attachments.filter((item) => item.handle !== handle) }),
    startDictation: async () => {
      if (typeof bridge.startDictation !== 'function') {
        update({ dictationStatus: 'deferred', dictationMessage: DICTATION_DEFERRED });
        return;
      }
      update({ dictationStatus: 'recording', dictationMessage: null });
      await bridge.startDictation();
    },
    stopDictation: async () => {
      if (typeof bridge.stopDictation !== 'function') {
        update({ dictationStatus: 'deferred', dictationMessage: DICTATION_DEFERRED });
        return;
      }
      update({ dictationStatus: 'transcribing' });
      const text = await bridge.stopDictation();
      if (typeof text === 'string' && text.trim()) {
        update({ draft: `${state.draft}${state.draft ? ' ' : ''}${text.trim()}`, dictationStatus: 'idle', dictationMessage: null });
        return;
      }
      update({ dictationStatus: 'idle', dictationMessage: null });
    },
  };
}

export const assistantStore = createAssistantStore();

export function useAssistantStore(store: AssistantStore = assistantStore): AssistantStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
