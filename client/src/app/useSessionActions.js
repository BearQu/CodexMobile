import { apiFetch } from '../api.js';
import { messageStreamSignature } from '../chat/activity-model.js';
import { mergeLiveSelectedThreadMessages } from '../session-live-refresh.js';
import { desktopBridgeCanCreateThread } from '../send-state.js';
import { sessionTitleFromConversation } from '../../../shared/session-title.js';
import { normalizeContextStatus } from './context-status.js';
import {
  deleteCachedSessionMessages,
  readCachedSessionMessages,
  writeCachedSessionMessages
} from './message-cache.js';
import {
  autoTitlePatch,
  createDraftSession,
  emptyContextStatus,
  isDraftSession,
  resolveNewConversationProject,
  sessionMessagesApiPath
} from './session-utils.js';

export function useSessionActions({
  defaultStatus,
  status,
  selectedProject,
  selectedProjectRef,
  selectedSessionRef,
  projects,
  sessionsByProject,
  expandedProjectIds,
  messages,
  messagesRef,
  autoTitleSyncRef,
  setExpandedProjectIds,
  setProjects,
  setSelectedProject,
  setSelectedSession,
  setSessionsByProject,
  setMessages,
  setSessionLoadingId,
  setSessionLoadError,
  setContextStatus,
  setAttachments,
  setInput,
  setDrawerOpen,
  loadSessions,
  upsertSessionInProject,
  clearSessionCompleteNotice
}) {
  function mergeLoadedMessages(current, loaded, options = {}) {
    const nextMessages = Array.isArray(loaded) ? loaded : [];
    if (!Array.isArray(current) || !current.length) {
      return nextMessages;
    }
    if (messageStreamSignature(current) === messageStreamSignature(nextMessages)) {
      return current;
    }
    return mergeLiveSelectedThreadMessages(current, nextMessages, options);
  }

  async function handleToggleProject(project) {
    const isExpanded = Boolean(expandedProjectIds[project.id]);
    if (isExpanded) {
      setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }

    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    const projectChanged = selectedProject?.id !== project.id;
    selectedProjectRef.current = project;
    setSelectedProject(project);
    if (projectChanged) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setMessages([]);
      setSessionLoadingId(null);
      setSessionLoadError('');
      setContextStatus(emptyContextStatus());
    }
    if (!sessionsByProject[project.id]) {
      await loadSessions(project, false);
    }
  }

  async function handleSelectSession(session) {
    clearSessionCompleteNotice(session?.id);
    selectedSessionRef.current = session;
    setSelectedSession(session);
    const requestedSessionId = session?.id || null;
    setSessionLoadError('');
    if (isDraftSession(session)) {
      setSessionLoadingId(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
      setDrawerOpen(false);
      return;
    }
    setSessionLoadingId(requestedSessionId);
    setMessages([]);
    setContextStatus(normalizeContextStatus(session?.context || defaultStatus.context, defaultStatus.context));
    setDrawerOpen(false);
    try {
      const plainMessagesPromise = apiFetch(sessionMessagesApiPath(session.id, { activity: false }));
      const cachedData = await readCachedSessionMessages(session.id, { activity: true });
      if (cachedData && selectedSessionRef.current?.id === requestedSessionId) {
        setMessages((current) => mergeLoadedMessages(current, cachedData.messages || [], { preserveActivityState: true }));
        setContextStatus(normalizeContextStatus(cachedData.context || session.context || defaultStatus.context, defaultStatus.context));
      }
      const data = await plainMessagesPromise;
      if (selectedSessionRef.current?.id !== requestedSessionId) {
        return;
      }
      setMessages((current) => mergeLoadedMessages(current, data.messages || [], { preserveActivityState: true }));
      setContextStatus(normalizeContextStatus(data.context || session.context || defaultStatus.context, defaultStatus.context));
      writeCachedSessionMessages(session.id, data, { activity: false });
      apiFetch(sessionMessagesApiPath(session.id))
        .then((fullData) => {
          if (selectedSessionRef.current?.id === requestedSessionId) {
            setMessages((current) => mergeLoadedMessages(current, fullData.messages || []));
            setContextStatus(normalizeContextStatus(fullData.context || session.context || defaultStatus.context, defaultStatus.context));
            writeCachedSessionMessages(session.id, fullData, { activity: true });
          }
        })
        .catch(() => null);
    } catch (error) {
      if (selectedSessionRef.current?.id === requestedSessionId) {
        setSessionLoadError(error.message || '加载失败');
      }
    } finally {
      setSessionLoadingId((current) => (current === requestedSessionId ? null : current));
    }
  }

  async function refreshProjectSessions(project) {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    setProjects(nextProjects);
    setSessionsByProject((current) => ({ ...current, [project.id]: sessionData.sessions || [] }));
    const nextSelectedProject = nextProjects.find((item) => item.id === selectedProjectRef.current?.id);
    if (nextSelectedProject) {
      setSelectedProject(nextSelectedProject);
    }
  }

  function firstUserMessageForTurn(turnId) {
    const scoped = (messagesRef.current || []).filter((message) => !turnId || message.turnId === turnId);
    return scoped.find((message) => message.role === 'user' && String(message.content || '').trim())?.content || '';
  }

  function applyAutoSessionTitle(payload, assistantContent) {
    const currentSession = selectedSessionRef.current;
    const projectId = payload.projectId || selectedProjectRef.current?.id || currentSession?.projectId;
    if (!currentSession || !projectId || currentSession.titleLocked) {
      return;
    }
    const userMessage = firstUserMessageForTurn(payload.turnId);
    const nextTitle = sessionTitleFromConversation({
      userMessage,
      assistantMessage: assistantContent
    });
    if (!nextTitle || nextTitle === currentSession.title) {
      return;
    }

    const ids = new Set([currentSession.id, payload.sessionId, payload.previousSessionId, payload.turnId].filter(Boolean));
    const patch = autoTitlePatch(nextTitle, 'completed');
    selectedSessionRef.current = { ...currentSession, ...patch };
    setSelectedSession((current) => (current && ids.has(current.id) ? { ...current, ...patch } : current));
    setSessionsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] || []).map((item) => (ids.has(item.id) ? { ...item, ...patch } : item))
    }));

    const sessionId = payload.sessionId || (!isDraftSession(currentSession) ? currentSession.id : '');
    if (!sessionId || isDraftSession(sessionId)) {
      return;
    }
    const syncKey = `${projectId}:${sessionId}:${nextTitle}`;
    if (autoTitleSyncRef.current.has(syncKey)) {
      return;
    }
    autoTitleSyncRef.current.add(syncKey);
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: { title: nextTitle, auto: true }
    }).catch(() => {
      autoTitleSyncRef.current.delete(syncKey);
    });
  }

  async function handleRenameSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const currentTitle = session.title || '对话';
    const nextTitle = window.prompt('重命名线程', currentTitle)?.trim().slice(0, 52);
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    const applyLocalTitle = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === session.id ? { ...item, title: nextTitle, titleLocked: true } : item
        )
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession((current) => (current ? { ...current, title: nextTitle, titleLocked: true } : current));
      }
    };

    if (isDraftSession(session)) {
      applyLocalTitle();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: { title: nextTitle }
      });
      applyLocalTitle();
      await refreshProjectSessions(project);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  }

  async function handleDeleteSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const title = session.title || '\u5bf9\u8bdd';
    const confirmed = window.confirm(
      `\u5f52\u6863\u7ebf\u7a0b\u201c${title}\u201d\uff1f\u8fd9\u4f1a\u540c\u6b65\u5f52\u6863\u7535\u8111\u7aef Codex App \u91cc\u7684\u540c\u4e00\u4e2a\u5bf9\u8bdd\u3002`
    );
    if (!confirmed) {
      return;
    }

    const removeLocalSession = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).filter((item) => item.id !== session.id)
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession(null);
        setMessages([]);
        setSessionLoadingId(null);
        setSessionLoadError('');
        setAttachments([]);
        setInput('');
      }
    };

    if (isDraftSession(session)) {
      removeLocalSession();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      deleteCachedSessionMessages(session.id);
      removeLocalSession();
      await refreshProjectSessions(project);
    } catch (error) {
      const message = String(error.message || '');
      window.alert(
        message.toLowerCase().includes('running')
          ? '\u7ebf\u7a0b\u6b63\u5728\u8fd0\u884c\uff0c\u7a0d\u540e\u518d\u5f52\u6863\u3002'
          : `\u5f52\u6863\u5931\u8d25\uff1a${message}`
      );
    }
  }

  async function handleDeleteMessage(message) {
    if (!message?.id) {
      return;
    }
    if (!window.confirm('删除这条消息？')) {
      return;
    }

    const messageId = String(message.id);
    const sessionId = selectedSessionRef.current?.id || message.sessionId || '';
    const existingIndex = messages.findIndex((item) => String(item.id) === messageId);
    const removedMessage = existingIndex >= 0 ? messages[existingIndex] : message;
    setMessages((current) => current.filter((item) => String(item.id) !== messageId));

    if (!sessionId || isDraftSession({ id: sessionId })) {
      return;
    }

    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      deleteCachedSessionMessages(sessionId);
    } catch (error) {
      setMessages((current) => {
        if (current.some((item) => String(item.id) === messageId)) {
          return current;
        }
        const next = [...current];
        const insertAt = existingIndex >= 0 ? Math.min(existingIndex, next.length) : next.length;
        next.splice(insertAt, 0, removedMessage);
        return next;
      });
      window.alert(`删除失败：${error.message}`);
    }
  }

  function handleNewConversation(targetProject = null) {
    if (!desktopBridgeCanCreateThread(status?.desktopBridge)) {
      setMessages((current) => [
        ...current,
        {
          id: `desktop-create-unavailable-${Date.now()}`,
          role: 'activity',
          content: status?.desktopBridge?.capabilities?.createThreadReason || '当前桌面端还没有开放从手机新建同源对话的入口。请先在桌面端新建或打开一个对话，再从手机继续发送。',
          timestamp: new Date().toISOString()
        }
      ]);
      setDrawerOpen(false);
      return;
    }
    const project = resolveNewConversationProject(targetProject, selectedProject, projects);
    if (!project) {
      return;
    }
    const draft = createDraftSession(project);
    selectedProjectRef.current = project;
    selectedSessionRef.current = draft;
    setSelectedProject(project);
    setSelectedSession(draft);
    setSessionLoadingId(null);
    setSessionLoadError('');
    setContextStatus(emptyContextStatus());
    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    setSessionsByProject((current) => upsertSessionInProject(current, project.id, draft));
    setMessages([]);
    setAttachments([]);
    setDrawerOpen(false);
  }

  return {
    handleToggleProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleDeleteMessage,
    handleNewConversation,
    applyAutoSessionTitle,
    refreshProjectSessions
  };
}
