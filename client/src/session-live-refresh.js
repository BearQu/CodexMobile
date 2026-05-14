import { sameUserMessageContent } from './chat/message-identity.js';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isPendingLocalMessage(message) {
  const id = String(message?.id || '');
  if (id.startsWith('local-')) {
    return true;
  }
  return message?.role === 'activity' && ['running', 'queued'].includes(String(message?.status || ''));
}

function messageRunKeys(message) {
  return [message?.turnId, message?.sessionId, message?.previousSessionId].filter(Boolean).map(String);
}

function isRunningStatus(value) {
  return ['running', 'queued'].includes(String(value || ''));
}

function isTransientActivityMessage(message) {
  return message?.role === 'activity' && Boolean(message?.transient);
}

function loadedHasAssistantForActivity(loaded, activity) {
  const keys = new Set(messageRunKeys(activity));
  if (!keys.size) {
    return false;
  }
  return loaded.some((item) => item?.role === 'assistant' && messageMatchesRunKeys(item, keys) && normalizeText(item.content));
}

function isDesktopRuntimeSource(value) {
  return value === 'desktop-thread' || value === 'desktop-ipc' || value === 'headless-local';
}

function messageMatchesRunKeys(message, keys) {
  if (!keys.size) {
    return false;
  }
  return messageRunKeys(message).some((key) => keys.has(key));
}

function completeLocalActivityMessage(message, loaded = []) {
  const keys = new Set(messageRunKeys(message));
  const assistant = loaded.find((item) => item?.role === 'assistant' && messageMatchesRunKeys(item, keys) && normalizeText(item.content));
  if (!assistant && !['running', 'queued'].includes(String(message?.status || ''))) {
    return message;
  }
  return {
    ...message,
    status: message.status === 'failed' ? 'failed' : 'completed',
    label: message.status === 'failed' ? message.label : '过程已同步',
    content: message.status === 'failed' ? message.content : '过程已同步',
    completedAt: message.completedAt || assistant?.timestamp || new Date().toISOString(),
    activities: Array.isArray(message.activities)
      ? message.activities.map((activity) =>
        ['running', 'queued'].includes(String(activity?.status || ''))
          ? { ...activity, status: 'completed' }
          : activity
      )
      : message.activities
  };
}

function sameMessageIdentity(left, right) {
  const leftId = String(left?.id || '');
  const rightId = String(right?.id || '');
  if (leftId && rightId && leftId === rightId) {
    return true;
  }
  if (left?.role === 'user' && right?.role === 'user') {
    return sameUserMessageContent(left.content, right.content);
  }
  return false;
}

function activityAnchorMessage(current, activity) {
  const activityId = String(activity?.id || '');
  const index = current.findIndex((message) => String(message?.id || '') === activityId);
  if (index < 0) {
    return null;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = current[cursor];
    if (message?.role === 'user') {
      return message;
    }
  }
  return null;
}

function activityInsertIndex(loaded, activity, current = []) {
  const keys = new Set(messageRunKeys(activity));
  const index = loaded.findIndex((message) => message?.role === 'assistant' && messageMatchesRunKeys(message, keys));
  if (index >= 0) {
    return index;
  }
  const anchor = activityAnchorMessage(current, activity);
  if (anchor) {
    const anchorIndex = loaded.findIndex((message) => sameMessageIdentity(anchor, message));
    if (anchorIndex >= 0) {
      return anchorIndex + 1;
    }
  }
  const userIndex = loaded.findLastIndex((message) => message?.role === 'user' && messageMatchesRunKeys(message, keys));
  return userIndex >= 0 ? userIndex + 1 : loaded.length;
}

function preserveLocalActivityMessages(current = [], loaded = [], { preserveActivityState = false } = {}) {
  const loadedIds = new Set(loaded.map((message) => String(message?.id || '')).filter(Boolean));
  const preserved = current
    .filter((message) => message?.role === 'activity' && !loadedIds.has(String(message?.id || '')))
    .filter((message) => {
      const keys = new Set(messageRunKeys(message));
      if (!keys.size) {
        return false;
      }
      if (loaded.some((item) => item?.role === 'activity' && messageMatchesRunKeys(item, keys))) {
        return false;
      }
      if (isTransientActivityMessage(message) && loadedHasAssistantForActivity(loaded, message)) {
        return false;
      }
      return loaded.some((item) => messageMatchesRunKeys(item, keys)) || ['running', 'queued'].includes(String(message?.status || ''));
    })
    .map((message) =>
      isTransientActivityMessage(message) || preserveActivityState
        ? message
        : completeLocalActivityMessage(message, loaded)
    );

  if (!preserved.length) {
    return loaded;
  }

  const result = [...loaded];
  for (const activity of preserved.sort((a, b) => activityInsertIndex(result, a, current) - activityInsertIndex(result, b, current))) {
    result.splice(activityInsertIndex(result, activity, current), 0, activity);
  }
  return result;
}

function desktopBridgeUsesExternalThreadRefresh(bridge = null) {
  return Boolean(bridge?.connected && ['desktop-ipc', 'headless-local'].includes(bridge?.mode));
}

export function desktopRunningActivityPayload(messages = [], sessionId = '', selectedRunRuntime = null) {
  if (!Array.isArray(messages)) {
    return null;
  }
  const targetSessionId = String(sessionId || '');
  const runningActivity = messages
    .filter((message) => {
      if (message?.role !== 'activity' || String(message?.kind || '') !== 'desktop') {
        return false;
      }
      if (!isRunningStatus(message?.status)) {
        return false;
      }
      if (!targetSessionId) {
        return true;
      }
      return messageRunKeys(message).includes(targetSessionId);
    })
    .at(-1);

  if (!runningActivity) {
    return null;
  }

  return {
    source: selectedRunRuntime?.source || 'desktop-thread',
    sessionId: runningActivity.sessionId || targetSessionId || null,
    turnId: runningActivity.turnId || selectedRunRuntime?.turnId || runningActivity.sessionId || targetSessionId || null,
    startedAt: runningActivity.startedAt || runningActivity.timestamp || null,
    timestamp: runningActivity.timestamp || runningActivity.startedAt || new Date().toISOString(),
    steerable: false
  };
}

function desktopCompletedActivityPayload(messages = [], sessionId = '', selectedRunRuntime = null) {
  if (!Array.isArray(messages) || selectedRunRuntime?.status !== 'running' || !isDesktopRuntimeSource(selectedRunRuntime?.source)) {
    return null;
  }
  const targetSessionId = String(sessionId || '');
  const targetTurnId = String(selectedRunRuntime?.turnId || '');
  const completedActivity = messages
    .filter((message) => {
      if (message?.role !== 'activity' || String(message?.kind || '') !== 'desktop') {
        return false;
      }
      if (String(message?.status || '') !== 'completed') {
        return false;
      }
      const keys = messageRunKeys(message);
      if (targetTurnId && keys.includes(targetTurnId)) {
        return true;
      }
      return targetSessionId ? keys.includes(targetSessionId) : true;
    })
    .at(-1);

  if (!completedActivity) {
    return null;
  }

  return {
    source: selectedRunRuntime.source || 'desktop-thread',
    sessionId: completedActivity.sessionId || targetSessionId || null,
    turnId: completedActivity.turnId || selectedRunRuntime.turnId || null,
    completedAt: completedActivity.completedAt || completedActivity.timestamp || new Date().toISOString(),
    timestamp: completedActivity.timestamp || completedActivity.completedAt || new Date().toISOString()
  };
}

export function syncDesktopActivityRuntimeFromMessages({
  messages = [],
  sessionId = '',
  selectedRunRuntime = null,
  markRun = null,
  clearRun = null,
  markSessionCompleteNotice = null
} = {}) {
  const payload = desktopRunningActivityPayload(messages, sessionId, selectedRunRuntime);
  if (payload) {
    markRun?.(payload);
    return 'marked';
  }

  const completedPayload = desktopCompletedActivityPayload(messages, sessionId, selectedRunRuntime);
  if (completedPayload) {
    clearRun?.({
      source: selectedRunRuntime.source || 'desktop-thread',
      sessionId,
      turnId: selectedRunRuntime.turnId || null
    });
    markSessionCompleteNotice?.(completedPayload);
    return 'completed';
  }

  if (selectedRunRuntime?.status === 'running' && isDesktopRuntimeSource(selectedRunRuntime?.source)) {
    clearRun?.({
      source: selectedRunRuntime.source || 'desktop-thread',
      sessionId,
      turnId: selectedRunRuntime.turnId || null
    });
    return 'cleared';
  }

  return 'idle';
}

export function shouldPollSelectedSessionMessages({
  hasSelectedRunning = false,
  desktopBridge = null,
  hasExternalThreadRefresh = false
} = {}) {
  if (!hasSelectedRunning) {
    return true;
  }
  return desktopBridgeUsesExternalThreadRefresh(desktopBridge) && Boolean(hasExternalThreadRefresh);
}

export function mergeLiveSelectedThreadMessages(current = [], loaded = [], options = {}) {
  if (!Array.isArray(loaded)) {
    return Array.isArray(current) ? current : [];
  }
  if (!Array.isArray(current) || !current.length) {
    return loaded;
  }

  const loadedUsers = loaded.filter((message) => message?.role === 'user');
  const hasUncaughtLocalUser = current.some((message) =>
    message?.role === 'user' &&
    isPendingLocalMessage(message) &&
    !loadedUsers.some((loadedMessage) => sameUserMessageContent(message.content, loadedMessage.content))
  );

  if (!hasUncaughtLocalUser) {
    return preserveLocalActivityMessages(current, loaded, options);
  }

  const loadedIds = new Set(loaded.map((message) => String(message?.id || '')).filter(Boolean));
  const pending = current.filter((message) => {
    if (!isPendingLocalMessage(message)) {
      return false;
    }
    if (loadedIds.has(String(message?.id || ''))) {
      return false;
    }
    if (message?.role === 'user' && loadedUsers.some((loadedMessage) => sameUserMessageContent(message.content, loadedMessage.content))) {
      return false;
    }
    return true;
  });

  return preserveLocalActivityMessages(current, [...loaded, ...pending], options).sort(
    (a, b) => new Date(a?.timestamp || 0).getTime() - new Date(b?.timestamp || 0).getTime()
  );
}

export function applySessionRenameToProjectSessions(current = {}, payload = {}) {
  const projectId = payload.projectId || payload.session?.projectId || '';
  const sessionId = payload.sessionId || payload.session?.id || '';
  const title = normalizeText(payload.title || payload.session?.title);
  if (!projectId || !sessionId || !title) {
    return current;
  }

  const existing = Array.isArray(current[projectId]) ? current[projectId] : [];
  const sessionPatch = {
    ...(payload.session || {}),
    id: sessionId,
    projectId,
    title,
    titleLocked: payload.titleLocked ?? payload.session?.titleLocked ?? true
  };
  if (payload.updatedAt || payload.session?.updatedAt) {
    sessionPatch.updatedAt = payload.updatedAt || payload.session.updatedAt;
  }

  let found = false;
  const nextSessions = existing.map((session) => {
    if (String(session?.id || '') !== String(sessionId)) {
      return session;
    }
    found = true;
    return { ...session, ...sessionPatch };
  });

  if (!found && payload.session) {
    nextSessions.unshift(sessionPatch);
  }

  if (!found && !payload.session) {
    return current;
  }

  return {
    ...current,
    [projectId]: nextSessions
  };
}
