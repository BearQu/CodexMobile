import { useCallback } from 'react';
import { apiFetch, clearToken } from '../api.js';
import {
  emptyContextStatus,
  isDraftSession,
  sessionMessagesApiPath
} from './session-utils.js';
import { normalizeContextStatus } from './context-status.js';
import { readCachedSessionMessages, writeCachedSessionMessages } from './message-cache.js';
import {
  preferredProjectFromStoredSelection,
  readStoredSelection,
  selectedSessionFromStoredSelection
} from './selection-persistence.js';

export function useAppBootstrap({
  defaultStatus,
  selectedProjectRef,
  selectedSessionRef,
  setStatus,
  setAuthenticated,
  syncActiveRunsFromStatus,
  setSelectedSession,
  setMessages,
  setContextStatus,
  setLoadingProjectId,
  setSessionsByProject,
  setProjects,
  setSelectedProject,
  setExpandedProjectIds
}) {
  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    setStatus(data);
    setAuthenticated(Boolean(data.auth?.authenticated));
    syncActiveRunsFromStatus(data);
    return data;
  }, [setAuthenticated, setStatus, syncActiveRunsFromStatus]);

  const loadSessions = useCallback(async (project, options = true) => {
    const settings =
      typeof options === 'boolean'
        ? { chooseLatest: options, preserveSelection: false }
        : {
          chooseLatest: options?.chooseLatest ?? true,
          preferredSessionId: options?.preferredSessionId || '',
          preserveSelection: Boolean(options?.preserveSelection),
          silent: Boolean(options?.silent)
        };
    if (!project) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
      return;
    }
    if (!settings.silent) {
      setLoadingProjectId(project.id);
    }
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
      const apiSessions = data.sessions || [];
      const currentSession = selectedSessionRef.current;
      const sameProjectCurrent =
        currentSession?.projectId === project.id ? currentSession : null;
      const selected = selectedSessionFromStoredSelection(apiSessions, {
        preserveSelection: settings.preserveSelection,
        currentSession: sameProjectCurrent,
        storedSessionId: settings.preferredSessionId,
        chooseLatest: settings.chooseLatest
      });
      const preserveCurrent = Boolean(selected && currentSession?.id === selected.id);
      const nextSessions =
        preserveCurrent && isDraftSession(currentSession)
          ? [currentSession, ...apiSessions.filter((session) => session.id !== currentSession.id)]
          : apiSessions;
      setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));

      if (selected) {
        const next = isDraftSession(selected)
          ? selected
          : nextSessions.find((session) => session.id === selected.id) || selected;
        selectedSessionRef.current = next;
        if (isDraftSession(next)) {
          setSelectedSession(next);
          setMessages([]);
          setContextStatus(emptyContextStatus());
          return;
        }
        setSelectedSession((current) => (current?.id === next.id ? { ...current, ...next } : next));
        setContextStatus(normalizeContextStatus(next.context || defaultStatus.context, defaultStatus.context));
        const plainMessagesPromise = apiFetch(sessionMessagesApiPath(next.id, { activity: false }));
        const cachedMessageData = await readCachedSessionMessages(next.id);
        if (cachedMessageData && selectedSessionRef.current?.id === next.id) {
          setMessages(cachedMessageData.messages || []);
          setContextStatus(normalizeContextStatus(cachedMessageData.context || next.context || defaultStatus.context, defaultStatus.context));
        }
        const messageData = await plainMessagesPromise;
        if (selectedSessionRef.current?.id === next.id) {
          setMessages(messageData.messages || []);
          setContextStatus(normalizeContextStatus(messageData.context || next.context || defaultStatus.context, defaultStatus.context));
          writeCachedSessionMessages(next.id, messageData);
          apiFetch(sessionMessagesApiPath(next.id))
            .then((fullMessageData) => {
              if (selectedSessionRef.current?.id === next.id) {
                setMessages(fullMessageData.messages || []);
                setContextStatus(normalizeContextStatus(fullMessageData.context || next.context || defaultStatus.context, defaultStatus.context));
              }
            })
            .catch(() => null);
        }
        return;
      }
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
    } finally {
      if (!settings.silent) {
        setLoadingProjectId((current) => (current === project.id ? null : current));
      }
    }
  }, [
    defaultStatus,
    selectedSessionRef,
    setContextStatus,
    setLoadingProjectId,
    setMessages,
    setSelectedSession,
    setSessionsByProject
  ]);

  const loadProjects = useCallback(async (options = {}) => {
    const preserveSelection = Boolean(options?.preserveSelection);
    const refreshSessions = options?.refreshSessions !== false;
    const storedSelection = readStoredSelection();
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    setProjects(list);
    const currentProject = selectedProjectRef.current;
    const preferred = preferredProjectFromStoredSelection(list, {
      preserveSelection,
      currentProject,
      storedProjectId: storedSelection.projectId
    });
    setSelectedProject(preferred);
    if (preferred) {
      setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
    }
    if (refreshSessions) {
      const shouldRestoreStoredSession = Boolean(
        preferred?.id &&
        storedSelection.projectId === preferred.id &&
        (!preserveSelection || !selectedSessionRef.current)
      );
      await loadSessions(preferred, {
        chooseLatest: !preserveSelection || !selectedSessionRef.current,
        preferredSessionId: shouldRestoreStoredSession ? storedSelection.sessionId : '',
        preserveSelection,
        silent: Boolean(options?.silent)
      });
    }
  }, [loadSessions, selectedProjectRef, selectedSessionRef, setExpandedProjectIds, setProjects, setSelectedProject]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (currentStatus.auth?.authenticated) {
        await loadProjects();
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            await loadProjects({ preserveSelection: true, refreshSessions: false });
          })
          .catch(() => null);
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        setAuthenticated(false);
      }
    }
  }, [loadProjects, loadStatus, setAuthenticated]);

  return {
    loadStatus,
    loadSessions,
    loadProjects,
    bootstrap
  };
}
