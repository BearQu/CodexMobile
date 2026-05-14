import { useCallback, useEffect } from 'react';
import { apiFetch } from '../api.js';
import {
  completeActivityMessagesForTurn,
  hasAssistantMessageForTurn,
  mergeLoadedMessagesPreservingActivity,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { mergeContextStatus } from './context-status.js';
import { writeCachedSessionMessages } from './message-cache.js';
import {
  externalThreadRuntimeById,
  hasVisibleAssistantForTurn,
  isDraftSession,
  payloadRunKeys,
  sessionMessagesApiPath,
  shouldClearRuntimeWhenNoActiveRuns,
  shouldDropRunningActivityMissingFromActiveRuns,
  shouldDropRunningActivityWhenNoActiveRuns,
  shouldPreserveLocalRunsFromStatus
} from './session-utils.js';

export function runtimeKeysForPayload(payload, currentSession = null) {
  const keys = new Set(payloadRunKeys(payload));
  if (currentSession) {
    const sameProject = !payload?.projectId || !currentSession.projectId || payload.projectId === currentSession.projectId;
    const matchesCurrent =
      keys.has(currentSession.id) ||
      keys.has(currentSession.turnId) ||
      (payload?.turnId && currentSession.turnId === payload.turnId) ||
      (currentSession.draft && sameProject);
    if (matchesCurrent) {
      if (currentSession.id) {
        keys.add(currentSession.id);
      }
      if (currentSession.turnId) {
        keys.add(currentSession.turnId);
      }
    }
  }
  return Array.from(keys).filter(Boolean);
}

export function completeMessagesForTurnCompletion(current, payload, detail = '结果同步中') {
  const completedAt = payload?.completedAt || payload?.timestamp || new Date().toISOString();
  const completedPayload = { ...payload, completedAt };
  const messagesWithCompletedActivity = completeActivityMessagesForTurn(current, completedPayload);
  if (hasAssistantMessageForTurn(current, payload)) {
    return messagesWithCompletedActivity;
  }
  return upsertStatusMessage(messagesWithCompletedActivity, {
    ...completedPayload,
    kind: 'turn',
    status: 'completed',
    label: '任务已完成',
    detail
  });
}

export function useTurnRuntime({
  defaultStatus,
  activePollsRef,
  turnRefreshTimersRef,
  selectedSessionRef,
  runningByIdRef,
  setRunningById,
  setThreadRuntimeById,
  setCompletedSessionIds,
  setMessages,
  setContextStatus
}) {
  useEffect(
    () => () => {
      for (const timer of turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      turnRefreshTimersRef.current.clear();
    },
    [turnRefreshTimersRef]
  );

  function runtimeKeysForCurrentPayload(payload) {
    return runtimeKeysForPayload(payload, selectedSessionRef.current);
  }

  function markRun(payload) {
    const keys = runtimeKeysForCurrentPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = {
          status: 'running',
          steerable: payload.steerable !== false,
          updatedAt: payload.timestamp || payload.startedAt || new Date().toISOString(),
          source: payload.source || null,
          sessionId: payload.sessionId || null,
          turnId: payload.turnId || payload.clientTurnId || null
        };
      }
      return next;
    });
  }

  function clearRun(payload) {
    const keys = runtimeKeysForCurrentPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (next[key]?.status === 'running') {
          delete next[key];
        }
      }
      return next;
    });
  }

  function markSessionCompleteNotice(payload) {
    const ids = runtimeKeysForCurrentPayload(payload).filter((id) => !isDraftSession(id));
    if (!ids.length) {
      return;
    }
    setCompletedSessionIds((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = true;
      }
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = {
          status: 'completed',
          updatedAt: payload.completedAt || payload.timestamp || new Date().toISOString()
        };
      }
      return next;
    });
  }

  function clearSessionCompleteNotice(sessionId) {
    if (!sessionId) {
      return;
    }
    setCompletedSessionIds((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setThreadRuntimeById((current) => {
      if (current[sessionId]?.status !== 'completed') {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  const syncActiveRunsFromStatus = useCallback((nextStatus, options = {}) => {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];
    const shouldPreserveLocalRuns = shouldPreserveLocalRunsFromStatus({
      activePollCount: activePollsRef.current.size,
      turnRefreshTimerCount: turnRefreshTimersRef.current.size,
      forceClear: Boolean(options.forceClear)
    });

    if (!activeRuns.length) {
      if (!shouldPreserveLocalRuns) {
        setRunningById(() => {
          runningByIdRef.current = {};
          return {};
        });
        setThreadRuntimeById((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(next)) {
            if (shouldClearRuntimeWhenNoActiveRuns(value)) {
              delete next[key];
            }
          }
          return next;
        });
      }
      setMessages((current) => {
        if (shouldPreserveLocalRuns) {
          return current;
        }
        return current.filter((message) => !shouldDropRunningActivityWhenNoActiveRuns(message));
      });
      return;
    }

    const nextRunning = {};
    const nextRuntime = {};
    const activeRunKeys = new Set();
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        activeRunKeys.add(key);
        nextRunning[key] = true;
        nextRuntime[key] = {
          status: 'running',
          steerable: run.steerable !== false,
          updatedAt: run.startedAt || new Date().toISOString(),
          source: run.source || null
        };
      }
    }
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = shouldPreserveLocalRuns
        ? { ...current, ...nextRuntime }
        : { ...externalThreadRuntimeById(current), ...nextRuntime };
      return next;
    });
    if (!shouldPreserveLocalRuns) {
      setMessages((current) =>
        current.filter((message) => !shouldDropRunningActivityMissingFromActiveRuns(message, activeRunKeys))
      );
    }
  }, [activePollsRef, runningByIdRef, setMessages, setRunningById, setThreadRuntimeById, turnRefreshTimersRef]);

  function payloadMatchesCurrentConversation(payload) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      turnRefreshTimersRef.current.delete(turnId);
    }
  }

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(sessionMessagesApiPath(payload.sessionId));
      if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, payload)) {
        setContextStatus((current) => mergeContextStatus(current, data.context || defaultStatus.context, defaultStatus.context));
        setMessages((current) => mergeLoadedMessagesPreservingActivity(current, data.messages, payload));
        writeCachedSessionMessages(payload.sessionId, data, { activity: true });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function finalizeTurnWithoutAssistant(payload) {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    clearRun(payload);
  }

  function markTurnCompleted(payload, detail = '结果同步中') {
    if (!payload?.turnId) {
      return;
    }
    const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
    clearRun({ ...payload, completedAt });
    markSessionCompleteNotice({ ...payload, completedAt });
    setMessages((current) => completeMessagesForTurnCompletion(current, { ...payload, completedAt }, detail));
  }

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    turnRefreshTimersRef.current.set(turnId, timer);
  }

  return {
    markRun,
    clearRun,
    markSessionCompleteNotice,
    clearSessionCompleteNotice,
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation,
    markTurnCompleted,
    scheduleTurnRefresh
  };
}
