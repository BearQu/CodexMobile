import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { readDesktopThread as defaultReadDesktopThread } from './codex-app-server.js';
import {
  readDesktopCollabActivities as defaultReadDesktopCollabActivities,
  readRawSessionActivities as defaultReadRawSessionActivities
} from './desktop-activity-parser.js';
import {
  extractProposedPlanContent,
  implementedPlanContentFromMessage,
  messagesFromDesktopThread as defaultMessagesFromDesktopThread,
  planMessageFromContent,
  planRequestMessageFromContent,
  removeFallbackActivitiesCoveredByRaw as defaultRemoveFallbackActivitiesCoveredByRaw,
  sanitizeVisibleUserMessage,
  sortDesktopActivitySteps as defaultSortDesktopActivitySteps,
  upsertDesktopActivity as defaultUpsertDesktopActivity
} from './desktop-thread-projector.js';
import {
  filterDeletedMessages as defaultFilterDeletedMessages,
  readDeletedMessageIds as defaultReadDeletedMessageIds
} from './session-local-state.js';

const ROLLOUT_CONTEXT_READ_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CODEXMOBILE_ROLLOUT_CONTEXT_READ_BYTES) || 1024 * 1024
);
const GUIDED_USER_LABEL = '已引导对话';

function guidedUserMetadata(enabled) {
  return enabled
    ? {
      guided: true,
      guideLabel: GUIDED_USER_LABEL,
      kind: 'guided_user'
    }
    : {};
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function epochSecondsFromIso(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function responseMessageText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => item?.text || item?.content || '')
    .filter(Boolean)
    .join('')
    .trim();
}

function ensureRolloutTurn(turns, sessionId, timestamp) {
  if (turns.length) {
    return turns.at(-1);
  }
  const turn = {
    id: `${sessionId}-turn-1`,
    startedAt: epochSecondsFromIso(timestamp)
  };
  turns.push(turn);
  return turn;
}

export function messagesFromRolloutJsonl(content, sessionId) {
  const messages = [];
  const turns = [];
  const implementedPlanContents = new Set();
  const userCountsByTurn = new Map();
  const lines = String(content || '').split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp || new Date().toISOString();
    if (entry.type === 'turn_context') {
      turns.push({
        id: entry.payload?.turn_id || `${sessionId}-turn-${turns.length + 1}`,
        startedAt: epochSecondsFromIso(timestamp)
      });
      continue;
    }
    if (entry.type !== 'response_item' || entry.payload?.type !== 'message') {
      continue;
    }
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    if (role === 'assistant' && entry.payload.phase === 'commentary') {
      continue;
    }
    const contentText = responseMessageText(entry.payload.content);
    if (!contentText) {
      continue;
    }
    const implementedPlanContent = role === 'user' ? implementedPlanContentFromMessage(contentText) : '';
    if (implementedPlanContent) {
      implementedPlanContents.add(implementedPlanContent.replace(/\s+/g, ' ').trim());
    }
    const turn = ensureRolloutTurn(turns, sessionId, timestamp);
    let userIndex = -1;
    if (role === 'user') {
      userIndex = userCountsByTurn.get(turn.id) || 0;
      userCountsByTurn.set(turn.id, userIndex + 1);
    }
    if (role === 'assistant') {
      const proposedPlan = extractProposedPlanContent(contentText);
      if (proposedPlan) {
        const baseId = entry.payload.id || `${turn.id}-assistant-${messages.length + 1}`;
        const planMessage = planMessageFromContent({
          id: `${baseId}-plan`,
          content: proposedPlan,
          timestamp,
          turnId: turn.id,
          sessionId
        });
        const requestMessage = planRequestMessageFromContent({
          id: `${baseId}-plan-request`,
          requestId: `implement-plan:${turn.id}`,
          content: proposedPlan,
          timestamp,
          turnId: turn.id,
          sessionId
        });
        if (planMessage) {
          messages.push(planMessage);
        }
        if (requestMessage) {
          messages.push(requestMessage);
        }
        continue;
      }
    }
    messages.push({
      id: entry.payload.id || `${turn.id}-${role}-${messages.length + 1}`,
      role,
      content: role === 'user' ? sanitizeVisibleUserMessage(contentText) : contentText,
      ...(role === 'user' ? guidedUserMetadata(userIndex > 0) : {}),
      timestamp,
      turnId: turn.id,
      sessionId
    });
  }

  const filteredMessages = implementedPlanContents.size
    ? messages.filter((message) => {
      if (message.role !== 'plan_request') {
        return true;
      }
      const planContent = String(message.planImplementation?.planContent || '').replace(/\s+/g, ' ').trim();
      return !implementedPlanContents.has(planContent);
    })
    : messages;

  return { messages: filteredMessages, turns };
}

async function readRolloutThreadFromFile(filePath, sessionId) {
  if (!filePath) {
    return null;
  }
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = messagesFromRolloutJsonl(content, sessionId);
  return {
    id: sessionId,
    path: filePath,
    turns: parsed.turns,
    messages: parsed.messages
  };
}

function desktopThreadHasMessages(thread) {
  if (Array.isArray(thread?.messages) && thread.messages.length > 0) {
    return true;
  }
  return (Array.isArray(thread?.turns) ? thread.turns : []).some((turn) =>
    Array.isArray(turn?.items) && turn.items.length > 0
  );
}

function canFallbackToRollout(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.statusCode === 404 || message.includes('thread not loaded') || message.includes('desktop thread not found');
}

export function publicContextState(state = {}, configContext = {}) {
  const contextWindow = state.contextWindow || configContext.modelContextWindow || null;
  const inputTokens = state.inputTokens || null;
  const autoCompactLimit = configContext.autoCompactTokenLimit || null;
  const percent =
    inputTokens && contextWindow
      ? Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 1000) / 10))
      : null;
  const compactDetected = Boolean(state.autoCompactDetected);
  return {
    sessionId: state.sessionId || null,
    model: state.model || null,
    inputTokens,
    totalTokens: state.totalTokens || null,
    contextWindow,
    percent,
    lastTokenUsage: state.lastTokenUsage || null,
    totalTokenUsage: state.totalTokenUsage || null,
    updatedAt: state.updatedAt || null,
    autoCompact: {
      enabled: Boolean(autoCompactLimit || configContext.autoCompactEnabled),
      tokenLimit: autoCompactLimit,
      detected: compactDetected,
      status: compactDetected ? 'detected' : (autoCompactLimit || configContext.autoCompactEnabled) ? 'watching' : 'unknown',
      lastCompactedAt: state.autoCompactLastAt || null,
      reason: state.autoCompactReason || ''
    }
  };
}

export function publicRuntimeState(runtime = null, sessionId = '') {
  if (runtime?.status !== 'running') {
    return null;
  }
  return {
    status: 'running',
    source: runtime.source || 'desktop-thread',
    sessionId: runtime.sessionId || sessionId || null,
    turnId: runtime.turnId || null,
    startedAt: runtime.startedAt || null,
    updatedAt: runtime.updatedAt || null,
    steerable: runtime.steerable === true
  };
}

function tokenUsageFromPayload(payload) {
  const info = payload?.info && typeof payload.info === 'object' ? payload.info : {};
  const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
  const total = info.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage : {};
  return {
    inputTokens: positiveNumber(last.input_tokens ?? total.input_tokens),
    totalTokens: positiveNumber(total.total_tokens ?? last.total_tokens),
    contextWindow: positiveNumber(info.model_context_window ?? payload?.model_context_window),
    lastTokenUsage: last,
    totalTokenUsage: total
  };
}

function isoFromEpochValue(value, fallback = null) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return fallback;
}

function markRuntimeRunning(state, { turnId, timestamp, startedAt = null } = {}) {
  const id = String(turnId || '').trim();
  if (!id) {
    return;
  }
  const startedAtIso = isoFromEpochValue(startedAt, timestamp || new Date().toISOString());
  state.runtime = {
    status: 'running',
    source: 'desktop-thread',
    sessionId: state.sessionId || null,
    turnId: id,
    startedAt: startedAtIso,
    updatedAt: timestamp || startedAtIso || new Date().toISOString(),
    steerable: false
  };
}

function clearRuntimeForTurn(state, turnId) {
  if (!state.runtime) {
    return;
  }
  const id = String(turnId || '').trim();
  if (!id || state.runtime.turnId === id) {
    state.runtime = null;
  }
}

function applyContextEntry(state, entry, sessionId) {
  const payload = entry?.payload || {};
  const timestamp = entry?.timestamp || new Date().toISOString();
  const type = payload.type || '';

  if (entry.type === 'turn_context') {
    markRuntimeRunning(state, { turnId: payload.turn_id, timestamp });
    const summary = String(payload.summary || '').trim();
    if (summary && summary !== 'none') {
      state.autoCompactDetected = true;
      state.autoCompactLastAt = timestamp;
      state.autoCompactReason = '会话已带摘要继续';
    }
    if (payload.model) {
      state.model = payload.model;
    }
    state.updatedAt = timestamp;
    return;
  }

  if (
    entry.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'assistant' &&
    payload.phase !== 'commentary'
  ) {
    clearRuntimeForTurn(state, state.runtime?.turnId);
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type === 'compacted') {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文已自动压缩';
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type !== 'event_msg') {
    return;
  }

  if (type === 'task_started') {
    markRuntimeRunning(state, {
      turnId: payload.turn_id,
      timestamp,
      startedAt: payload.started_at
    });
    state.contextWindow = positiveNumber(payload.model_context_window) || state.contextWindow || null;
    state.updatedAt = timestamp;
    return;
  }

  if (/^task_(complete|failed|aborted|cancelled|canceled)$/.test(type) || /^turn_(complete|failed|aborted|cancelled|canceled)$/.test(type)) {
    clearRuntimeForTurn(state, payload.turn_id);
    state.updatedAt = timestamp;
    return;
  }

  if (type !== 'token_count') {
    return;
  }

  const usage = tokenUsageFromPayload(payload);
  const previousInputTokens = state.inputTokens;
  state.sessionId = sessionId;
  state.inputTokens = usage.inputTokens || state.inputTokens || null;
  state.totalTokens = usage.totalTokens || state.totalTokens || null;
  state.contextWindow = usage.contextWindow || state.contextWindow || null;
  state.lastTokenUsage = usage.lastTokenUsage;
  state.totalTokenUsage = usage.totalTokenUsage;
  state.updatedAt = timestamp;

  if (
    previousInputTokens &&
    usage.inputTokens &&
    previousInputTokens > 20000 &&
    usage.inputTokens < previousInputTokens * 0.62
  ) {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文用量回落';
  }
}

export async function readRolloutContextState(filePath, sessionId) {
  const state = { sessionId, runtime: null };
  if (!filePath) {
    return state;
  }

  let start = 0;
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > ROLLOUT_CONTEXT_READ_BYTES) {
      start = stats.size - ROLLOUT_CONTEXT_READ_BYTES;
    }
  } catch {
    return state;
  }

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      try {
        applyContextEntry(state, JSON.parse(line), sessionId);
      } catch {
        // Skip malformed or partial JSONL rows.
      }
    }
  } catch {
    return state;
  }
  return state;
}

export function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

function messageTimestampValue(message) {
  const value = Date.parse(message?.timestamp || '');
  return Number.isFinite(value) ? value : 0;
}

function sortMessagesByConversationOrder(messages) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTurnId = left.message?.turnId || '';
      const rightTurnId = right.message?.turnId || '';
      if (leftTurnId && leftTurnId === rightTurnId) {
        return left.index - right.index;
      }
      const timestampDelta = messageTimestampValue(left.message) - messageTimestampValue(right.message);
      return timestampDelta || left.index - right.index;
    })
    .map((item) => item.message);
}

function normalizeVisibleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function latestAgentActivityMessage(activityMessage) {
  const activities = Array.isArray(activityMessage?.activities) ? activityMessage.activities : [];
  return activities
    .filter((activity) => activity?.kind === 'agent_message' && normalizeVisibleText(activity.label || activity.content || activity.detail))
    .sort((left, right) => messageTimestampValue(left) - messageTimestampValue(right))
    .at(-1) || null;
}

function addVisibleAgentActivitySummaries(messages) {
  const result = [...messages];
  const assistantByTurn = new Map();
  for (const message of result) {
    if (message?.role !== 'assistant' || !message.turnId) {
      continue;
    }
    const existing = assistantByTurn.get(message.turnId) || [];
    existing.push(normalizeVisibleText(message.content));
    assistantByTurn.set(message.turnId, existing);
  }

  for (const message of messages) {
    if (message?.role !== 'activity' || !message.turnId || message.status === 'running') {
      continue;
    }
    const latest = latestAgentActivityMessage(message);
    if (!latest) {
      continue;
    }
    const content = normalizeVisibleText(latest.label || latest.content || latest.detail);
    if (!content) {
      continue;
    }
    const existingAssistantTexts = assistantByTurn.get(message.turnId) || [];
    if (existingAssistantTexts.length > 0) {
      continue;
    }
    const id = `${latest.id || message.id}-visible`;
    if (result.some((item) => item.id === id)) {
      continue;
    }
    result.push({
      id,
      role: 'assistant',
      content,
      kind: 'activity_summary',
      timestamp: latest.timestamp || message.completedAt || message.timestamp || new Date().toISOString(),
      turnId: message.turnId,
      sessionId: message.sessionId
    });
    assistantByTurn.set(message.turnId, [...existingAssistantTexts, content]);
  }
  return result;
}

function cacheKeyForMessages(sessionId, includeActivity) {
  return `${sessionId}:${includeActivity ? 'activity' : 'plain'}`;
}

async function rolloutFileSignature(filePath) {
  if (!filePath) {
    return '';
  }
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return '';
    }
    return `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`;
  } catch {
    return '';
  }
}

export function isoFromEpochSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

export function createSessionMessageReader({
  readDeletedMessageIds = defaultReadDeletedMessageIds,
  readDesktopThread = defaultReadDesktopThread,
  messagesFromDesktopThread = defaultMessagesFromDesktopThread,
  readRawSessionActivities = defaultReadRawSessionActivities,
  readDesktopCollabActivities = defaultReadDesktopCollabActivities,
  removeFallbackActivitiesCoveredByRaw = defaultRemoveFallbackActivitiesCoveredByRaw,
  upsertDesktopActivity = defaultUpsertDesktopActivity,
  sortDesktopActivitySteps = defaultSortDesktopActivitySteps,
  filterDeletedMessages = defaultFilterDeletedMessages,
  readRolloutContextState: readRolloutContextStateImpl = readRolloutContextState,
  resolveSessionThread = async () => null,
  getConfigContext = () => ({})
} = {}) {
  const messageCache = new Map();

  async function readThread(sessionId) {
    try {
      const response = await readDesktopThread(sessionId, { includeTurns: true });
      if (response?.thread) {
        if (!desktopThreadHasMessages(response.thread)) {
          const session = await resolveSessionThread(sessionId);
          const filePath = session?.filePath || session?.path || response.thread.path || '';
          const fallbackThread = await readRolloutThreadFromFile(filePath, sessionId).catch(() => null);
          if (fallbackThread && desktopThreadHasMessages(fallbackThread)) {
            return fallbackThread;
          }
        }
        return response.thread;
      }
    } catch (error) {
      if (!canFallbackToRollout(error)) {
        throw error;
      }
    }

    const session = await resolveSessionThread(sessionId);
    const filePath = session?.filePath || session?.path || '';
    const thread = await readRolloutThreadFromFile(filePath, sessionId).catch(() => null);
    if (thread) {
      return thread;
    }
    const error = new Error('Desktop thread not found');
    error.statusCode = 404;
    throw error;
  }

  async function readSessionMessages(
    sessionId,
    { limit = 120, offset = null, latest = true, includeActivity = false } = {}
  ) {
    const deletedIds = await readDeletedMessageIds(sessionId);
    const session = await resolveSessionThread(sessionId).catch(() => null);
    const sessionFilePath = session?.filePath || session?.path || '';
    const sessionSignature = await rolloutFileSignature(sessionFilePath);
    const cacheKey = cacheKeyForMessages(sessionId, includeActivity);
    const cached = sessionSignature ? messageCache.get(cacheKey) : null;
    if (cached?.signature === sessionSignature) {
      return {
        ...paginateMessages(filterDeletedMessages(cached.messages, deletedIds), { limit, offset, latest }),
        context: publicContextState(cached.contextState, getConfigContext() || {}),
        cached: true,
        revision: cached.signature
      };
    }

    const thread = await readThread(sessionId);

    const messages = Array.isArray(thread.messages)
      ? thread.messages.map((message) => ({ ...message }))
      : messagesFromDesktopThread(thread, { includeActivity });
    if (includeActivity) {
      const rawActivities = await readRawSessionActivities(thread.path, thread.turns || []);
      removeFallbackActivitiesCoveredByRaw(messages, rawActivities);
      for (const item of rawActivities) {
        upsertDesktopActivity(messages, item.turnId, item.activity, item.segmentIndex);
      }
      const collabActivities = await readDesktopCollabActivities(thread.path);
      for (const item of collabActivities) {
        upsertDesktopActivity(messages, item.turnId, item.activity, item.segmentIndex);
      }
      sortDesktopActivitySteps(messages);
      messages.splice(0, messages.length, ...addVisibleAgentActivitySummaries(messages));
    }
    const orderedMessages = sortMessagesByConversationOrder(messages);

    const contextState = await readRolloutContextStateImpl(thread.path, sessionId);
    const threadSignature = await rolloutFileSignature(thread.path);
    if (threadSignature) {
      messageCache.set(cacheKey, {
        signature: threadSignature,
        messages: orderedMessages,
        contextState
      });
    } else {
      messageCache.delete(cacheKey);
    }
    return {
      ...paginateMessages(filterDeletedMessages(orderedMessages, deletedIds), { limit, offset, latest }),
      context: publicContextState(contextState, getConfigContext() || {}),
      cached: false,
      revision: threadSignature || sessionSignature || ''
    };
  }

  return { readSessionMessages };
}
