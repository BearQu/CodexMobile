import { useEffect } from 'react';
import { apiFetch } from '../api.js';
import {
  messageStreamSignature
} from '../chat/activity-model.js';
import {
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages,
  syncDesktopActivityRuntimeFromMessages
} from '../session-live-refresh.js';
import { mergeContextStatus } from './context-status.js';
import {
  hasRunningKey,
  isDraftSession,
  isLiveThreadRuntime,
  selectedRunKeys,
  sessionLivePollMessageOptions,
  sessionMessagesApiPath
} from './session-utils.js';

export function useSessionLivePolling({
  authenticated,
  selectedSession,
  hasRunningActivity,
  running,
  desktopBridge,
  threadRuntimeById,
  defaultStatus,
  sessionLivePollRef,
  selectedSessionRef,
  runningByIdRef,
  messagesRef,
  markRun,
  clearRun,
  markSessionCompleteNotice,
  setContextStatus,
  setMessages
}) {
  useEffect(() => {
    if (!authenticated || !selectedSession?.id || isDraftSession(selectedSession)) {
      return undefined;
    }

    const sessionId = selectedSession.id;
    let stopped = false;
    let pollCount = 0;
    async function pollSelectedSession() {
      if (stopped || sessionLivePollRef.current) {
        return;
      }
      const hasSelectedRunning = hasRunningKey(
        runningByIdRef.current || {},
        selectedRunKeys(selectedSessionRef.current || selectedSession)
      );
      const selectedRunRuntime = selectedRunKeys(selectedSessionRef.current || selectedSession)
        .map((key) => threadRuntimeById?.[key])
        .find(isLiveThreadRuntime) || null;
      const hasDesktopThreadRuntime =
        selectedRunRuntime?.source === 'desktop-thread' ||
        selectedRunRuntime?.source === 'desktop-ipc' ||
        selectedRunRuntime?.source === 'headless-local';
      const hasExternalThreadRefresh = Boolean(hasDesktopThreadRuntime);
      if (!shouldPollSelectedSessionMessages({
        hasSelectedRunning,
        desktopBridge,
        hasExternalThreadRefresh
      })) {
        return;
      }
      sessionLivePollRef.current = true;
      const pollOptions = sessionLivePollMessageOptions(pollCount++);
      try {
        const data = await apiFetch(sessionMessagesApiPath(sessionId, pollOptions));
        if (!stopped && selectedSessionRef.current?.id === sessionId && Array.isArray(data.messages)) {
          if (pollOptions.activity) {
            syncDesktopActivityRuntimeFromMessages({
              messages: data.messages,
              sessionId,
              selectedRunRuntime,
              markRun,
              clearRun,
              markSessionCompleteNotice
            });
          }
          setContextStatus((current) => mergeContextStatus(current, data.context || defaultStatus.context, defaultStatus.context));
          setMessages((current) =>
            messageStreamSignature(current) === messageStreamSignature(data.messages)
              ? current
              : mergeLiveSelectedThreadMessages(current, data.messages, { preserveActivityState: !pollOptions.activity })
          );
        }
      } catch {
        // Keep the currently rendered conversation if a transient poll fails.
      } finally {
        sessionLivePollRef.current = false;
      }
    }

    const intervalMs = hasRunningActivity || running ? 700 : 1600;
    const timer = window.setInterval(pollSelectedSession, intervalMs);
    pollSelectedSession();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    authenticated,
    selectedSession?.id,
    hasRunningActivity,
    running,
    desktopBridge,
    threadRuntimeById
  ]);
}
