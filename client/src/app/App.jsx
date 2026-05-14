import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { apiFetch, getToken } from '../api.js';
import { DEFAULT_PERMISSION_MODE } from '../composer/Composer.jsx';
import { DEFAULT_MODEL_SPEED, normalizeModelSpeed } from '../composer/composer-options.js';
import { useComposerSelections } from '../composer/useComposerSelections.js';
import { useQueueDrafts } from '../composer/useQueueDrafts.js';
import { connectionRecoveryState } from '../connection-recovery.js';
import { normalizeContextStatus } from './context-status.js';
import { DEFAULT_REASONING_EFFORT, DEFAULT_STATUS, REASONING_DEFAULT_VERSION } from './defaults.js';
import { appReducer, createInitialUiState, THEME_KEY } from './AppState.js';
import { useNotifications } from '../panels/useNotifications.js';
import { useAppBootstrap } from './useAppBootstrap.js';
import { useConnectionActions } from './useConnectionActions.js';
import { useDocsActions } from './useDocsActions.js';
import { useFileUploads } from './useFileUploads.js';
import { useAppWebSocket } from './useAppWebSocket.js';
import { useSessionLivePolling } from './useSessionLivePolling.js';
import { useSessionActions } from './useSessionActions.js';
import { useTurnSubmission } from './useTurnSubmission.js';
import { useTurnRuntime } from './useTurnRuntime.js';
import { useViewportSizing } from './useViewportSizing.js';
import { applyPwaTheme } from './pwa-theme.js';
import { nextSyncedComposerSettings } from './model-sync.js';
import { rememberSelectedSession } from './selection-persistence.js';
import {
  buildBackgroundHandoffMessage,
  visibleBackgroundHandoff
} from './background-handoff.js';
import {
  buildComposerRunStatus,
  emptyContextStatus,
  hasRunningKey,
  isDraftSession,
  isLiveThreadRuntime,
  reconcileThreadRuntimeWithSessions,
  runningByIdWithSelectedActivity,
  selectedRunKeys,
  selectedSessionIsRunning,
  upsertSessionInProject
} from './session-utils.js';
import { AppShell } from './AppShell.jsx';
import PairingScreen from './PairingScreen.jsx';

const MODEL_SPEED_KEY = 'codexmobile.modelSpeed';

export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [contextStatus, setContextStatus] = useState(() => normalizeContextStatus(DEFAULT_STATUS.context));
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [uiState, dispatchUi] = useReducer(appReducer, undefined, () => createInitialUiState());
  const setDrawerOpen = useCallback((value) => dispatchUi({ type: 'ui/drawerOpen', value }), []);
  const setPreviewImage = useCallback((value) => dispatchUi({ type: 'ui/previewImage', value }), []);
  const setDocsOpen = useCallback((value) => dispatchUi({ type: 'ui/docsOpen', value }), []);
  const setDocsBusy = useCallback((value) => dispatchUi({ type: 'ui/docsBusy', value }), []);
  const setDocsError = useCallback((value) => dispatchUi({ type: 'ui/docsError', value }), []);
  const setGitPanel = useCallback((value) => dispatchUi({ type: 'ui/gitPanel', value }), []);
  const setTheme = useCallback((value) => dispatchUi({ type: 'ui/theme', value }), []);
  const { drawerOpen, previewImage, docsOpen, docsBusy, docsError, gitPanel, theme } = uiState;
  const {
    toasts,
    notificationSupported,
    notificationEnabled,
    dismissToast,
    showToast,
    notifyFromPayload,
    enableNotifications
  } = useNotifications();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sessionLoadingId, setSessionLoadingId] = useState(null);
  const [sessionLoadError, setSessionLoadError] = useState('');
  const [activityClockNow, setActivityClockNow] = useState(() => Date.now());
  const [completedSessionIds, setCompletedSessionIds] = useState({});
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedModelSpeed, setSelectedModelSpeed] = useState(() => normalizeModelSpeed(localStorage.getItem(MODEL_SPEED_KEY)));
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(() => {
    const defaultVersion = localStorage.getItem('codexmobile.reasoningDefaultVersion');
    if (defaultVersion !== REASONING_DEFAULT_VERSION) {
      localStorage.setItem('codexmobile.reasoningDefaultVersion', REASONING_DEFAULT_VERSION);
      localStorage.setItem('codexmobile.reasoningEffort', DEFAULT_REASONING_EFFORT);
      return DEFAULT_REASONING_EFFORT;
    }
    return localStorage.getItem('codexmobile.reasoningEffort') || DEFAULT_REASONING_EFFORT;
  });
  const {
    fileMentions,
    setFileMentions,
    selectedSkillPaths,
    setSelectedSkillPaths,
    toggleSelectedSkill,
    selectSkill,
    clearSelectedSkills,
    addFileMention,
    removeFileMention
  } = useComposerSelections(status);
  const [runningById, setRunningById] = useState({});
  const [threadRuntimeById, setThreadRuntimeById] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  const [backgroundHandoffs, setBackgroundHandoffs] = useState([]);
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const messagesRef = useRef([]);
  const autoTitleSyncRef = useRef(new Set());
  const runningByIdRef = useRef({});
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());
  const lastStatusSettingsRef = useRef({
    model: DEFAULT_STATUS.model,
    reasoningEffort: DEFAULT_STATUS.reasoningEffort || DEFAULT_REASONING_EFFORT
  });
  const sessionLivePollRef = useRef(false);
  const bootstrapStartedRef = useRef(false);
  const drawerSyncAtRef = useRef(0);
  const composerRef = useRef(null);
  const {
    queueDrafts,
    loadQueueDrafts,
    removeQueueDraft,
    restoreQueueDraft,
    steerQueueDraft
  } = useQueueDrafts({
    selectedSessionRef,
    selectedProjectRef,
    selectedProject,
    setInput,
    setAttachments,
    setFileMentions,
    setSelectedSkillPaths
  });

  useViewportSizing(composerRef);

  const selectedRuntime = selectedRunKeys(selectedSession)
    .map((key) => threadRuntimeById[key])
    .find(isLiveThreadRuntime) || null;
  const running =
    hasRunningKey(runningById, selectedRunKeys(selectedSession)) ||
    selectedRuntime?.status === 'running';
  const hasRunningActivity = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === 'activity' &&
          (message.status === 'running' || message.status === 'queued')
      ),
    [messages]
  );
  const selectedRunning = selectedSessionIsRunning({ running, hasRunningActivity });
  const drawerRunningById = useMemo(
    () => runningByIdWithSelectedActivity(runningById, selectedSession, hasRunningActivity),
    [runningById, selectedSession, hasRunningActivity]
  );
  const composerRunStatus = useMemo(
    () => buildComposerRunStatus(messages, selectedRunning, activityClockNow),
    [messages, selectedRunning, activityClockNow]
  );

  useEffect(() => {
    loadQueueDrafts(selectedSession).catch(() => null);
  }, [selectedSession?.id]);

  useEffect(() => {
    setThreadRuntimeById((current) => {
      const next = reconcileThreadRuntimeWithSessions(current, sessionsByProject);
      return next === current ? current : next;
    });
  }, [sessionsByProject]);

  useEffect(() => {
    if (!selectedRunning) {
      return undefined;
    }
    setActivityClockNow(Date.now());
    const timer = window.setInterval(() => setActivityClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRunning]);

  const {
    markRun,
    clearRun,
    markSessionCompleteNotice,
    clearSessionCompleteNotice,
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation,
    markTurnCompleted,
    scheduleTurnRefresh
  } = useTurnRuntime({
    defaultStatus: DEFAULT_STATUS,
    activePollsRef,
    turnRefreshTimersRef,
    selectedSessionRef,
    runningByIdRef,
    setRunningById,
    setThreadRuntimeById,
    setCompletedSessionIds,
    setMessages,
    setContextStatus
  });

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    rememberSelectedSession(
      selectedSession?.projectId || selectedProject?.id
        ? { ...selectedSession, projectId: selectedSession?.projectId || selectedProject?.id }
        : selectedSession
    );
  }, [selectedProject?.id, selectedSession?.draft, selectedSession?.id, selectedSession?.projectId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useSessionLivePolling({
    authenticated,
    selectedSession,
    hasRunningActivity,
    running,
    desktopBridge: status.desktopBridge,
    threadRuntimeById,
    defaultStatus: DEFAULT_STATUS,
    sessionLivePollRef,
    selectedSessionRef,
    runningByIdRef,
    messagesRef,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    setContextStatus,
    setMessages
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    applyPwaTheme(theme);
    if (theme !== 'system' || typeof window === 'undefined') {
      return undefined;
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) {
      return undefined;
    }
    const syncSystemTheme = () => applyPwaTheme('system');
    if (media.addEventListener) {
      media.addEventListener('change', syncSystemTheme);
    } else {
      media.addListener?.(syncSystemTheme);
    }
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', syncSystemTheme);
      } else {
        media.removeListener?.(syncSystemTheme);
      }
    };
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      localStorage.setItem('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    localStorage.setItem(MODEL_SPEED_KEY, normalizeModelSpeed(selectedModelSpeed || DEFAULT_MODEL_SPEED));
  }, [selectedModelSpeed]);

  useEffect(() => {
    const previous = lastStatusSettingsRef.current;
    const next = nextSyncedComposerSettings({
      currentModel: selectedModel,
      previousStatusModel: previous.model,
      statusModel: status.model,
      fallbackModel: DEFAULT_STATUS.model,
      currentReasoningEffort: selectedReasoningEffort,
      previousStatusReasoningEffort: previous.reasoningEffort,
      statusReasoningEffort: status.reasoningEffort,
      fallbackReasoningEffort: DEFAULT_REASONING_EFFORT
    });
    lastStatusSettingsRef.current = {
      model: status.model || previous.model,
      reasoningEffort: status.reasoningEffort || previous.reasoningEffort
    };
    if (next.model && next.model !== selectedModel) {
      setSelectedModel(next.model);
    }
    if (next.reasoningEffort && next.reasoningEffort !== selectedReasoningEffort) {
      setSelectedReasoningEffort(next.reasoningEffort);
    }
  }, [selectedModel, selectedReasoningEffort, status.model, status.reasoningEffort]);

  const {
    loadStatus,
    loadSessions,
    loadProjects,
    bootstrap
  } = useAppBootstrap({
    defaultStatus: DEFAULT_STATUS,
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
  });

  useEffect(() => {
    if (bootstrapStartedRef.current) {
      return;
    }
    bootstrapStartedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!drawerOpen || !authenticated) {
      return undefined;
    }
    const now = Date.now();
    if (now - drawerSyncAtRef.current < 6000) {
      return undefined;
    }
    drawerSyncAtRef.current = now;
    let stopped = false;
    apiFetch('/api/sync', { method: 'POST' })
      .then(async () => {
        if (stopped) {
          return;
        }
        await loadStatus();
        if (!stopped) {
          await loadProjects({ preserveSelection: true, silent: true });
        }
      })
      .catch(() => null);
    return () => {
      stopped = true;
    };
  }, [authenticated, drawerOpen, loadProjects, loadStatus]);

  const {
    handleToggleProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleDeleteMessage,
    handleNewConversation,
    applyAutoSessionTitle
  } = useSessionActions({
    defaultStatus: DEFAULT_STATUS,
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
  });

  useAppWebSocket({
    useEffect,
    authenticated,
    defaultStatus: DEFAULT_STATUS,
    wsRef,
    selectedProjectRef,
    selectedSessionRef,
    setConnectionState,
    setStatus,
    syncActiveRunsFromStatus,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh,
    payloadMatchesCurrentConversation,
    upsertSessionInProject,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setContextStatus,
    setBackgroundHandoffs,
    applyAutoSessionTitle,
    notifyFromPayload,
    loadQueueDrafts,
    setProjects,
    setSelectedProject,
    setExpandedProjectIds,
    loadSessions
  });

  const {
    handleSync,
    handleRetryConnection,
    handleResetPairing,
    handleShowConnectionStatus
  } = useConnectionActions({
    apiFetch,
    status,
    connectionState,
    setAuthenticated,
    setConnectionState,
    setSyncing,
    loadStatus,
    loadProjects,
    showToast
  });

  const {
    handleUploadFiles,
    handleRemoveAttachment
  } = useFileUploads({
    setUploading,
    setAttachments,
    setMessages
  });

  const {
    submitCodexMessage,
    handleSubmit,
    handleImplementPlan,
    handleAdjustPlan,
    handleAbort
  } = useTurnSubmission({
    defaultStatus: DEFAULT_STATUS,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    selectedProject,
    selectedProjectRef,
    selectedSession,
    selectedSessionRef,
    projects,
    selectedSkillPaths,
    status,
    permissionMode,
    selectedModel,
    selectedModelSpeed,
    selectedReasoningEffort,
    input,
    attachments,
    fileMentions,
    activePollsRef,
    runningById,
    runningByIdRef,
    setInput,
    setAttachments,
    setFileMentions,
    setSelectedSession,
    setExpandedProjectIds,
    setSessionsByProject,
    setMessages,
    setContextStatus,
    upsertSessionInProject,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh,
    loadQueueDrafts,
    setBackgroundHandoffs
  });

  async function handleSyncBackgroundHandoff(handoff) {
    const message = buildBackgroundHandoffMessage(handoff);
    try {
      await submitCodexMessage({
        message,
        clearComposer: false,
        restoreTextOnError: false,
        sendMode: 'start',
        visibleMessageOverride: message,
        codexMessageOverride: message
      });
      const syncedAt = new Date().toISOString();
      setBackgroundHandoffs((current) =>
        current.map((item) => (item.id === handoff.id ? { ...item, syncedAt } : item))
      );
      showToast({
        level: 'success',
        title: '已同步到桌面',
        body: '后台执行摘要已发送到当前线程。'
      });
    } catch (error) {
      showToast({
        level: 'error',
        title: '同步失败',
        body: error.message || '请稍后重试。'
      });
    }
  }

  function handleDismissBackgroundHandoff(handoff) {
    const syncedAt = new Date().toISOString();
    setBackgroundHandoffs((current) =>
      current.map((item) => (item.id === handoff.id ? { ...item, syncedAt } : item))
    );
  }

  async function handleGitAction(action) {
    if (!selectedProject || selectedRunning) {
      return;
    }
    setGitPanel({ open: true, action });
  }

  const {
    handleConnectDocs,
    handleDisconnectDocs,
    handleRefreshDocs,
    handleOpenDocsHome,
    handleOpenDocsAuth
  } = useDocsActions({
    docsBusy,
    status,
    setStatus,
    setDocsBusy,
    setDocsError,
    loadStatus
  });

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);
  const visibleContextStatus = useMemo(
    () => {
      if (!selectedSession || isDraftSession(selectedSession)) {
        return emptyContextStatus();
      }
      return normalizeContextStatus(contextStatus || selectedSession.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context);
    },
    [contextStatus, selectedSession]
  );
  const recoveryState = connectionRecoveryState({
    authenticated,
    connectionState,
    desktopBridge: status.desktopBridge,
    syncing
  });
  const topBarRuntime = selectedRuntime || (selectedRunning ? { status: 'running' } : null);
  const visibleHandoff = visibleBackgroundHandoff(backgroundHandoffs, {
    selectedProject,
    selectedSession,
    desktopBridge: status.desktopBridge
  });

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  const sessionLoading = Boolean(sessionLoadingId && selectedSession?.id === sessionLoadingId);
  const composerRunStatusForShell = composerRunStatus
    ? { ...composerRunStatus, steerable: selectedRuntime?.steerable !== false }
    : null;
  const panelProps = {
    topBarProps: {
      selectedProject,
      selectedSession,
      connectionState,
      desktopBridge: status.desktopBridge,
      selectedRuntime: topBarRuntime,
      onMenu: () => setDrawerOpen(true),
      onOpenDocs: () => setDocsOpen(true),
      onGitAction: handleGitAction,
      notificationSupported,
      notificationEnabled,
      onEnableNotifications: enableNotifications,
      gitDisabled: !selectedProject || selectedRunning
    },
    docsPanelProps: {
      open: docsOpen,
      docs: status.docs,
      busy: docsBusy,
      error: docsError,
      onClose: () => setDocsOpen(false),
      onConnect: handleConnectDocs,
      onDisconnect: handleDisconnectDocs,
      onOpenHome: handleOpenDocsHome,
      onOpenAuth: handleOpenDocsAuth,
      onRefresh: handleRefreshDocs
    },
    gitPanelProps: {
      open: gitPanel.open,
      action: gitPanel.action,
      project: selectedProject,
      onToast: showToast,
      onClose: () => setGitPanel((current) => ({ ...current, open: false }))
    },
    recoveryCardProps: {
      state: recoveryState,
      onRetry: handleRetryConnection,
      onSync: handleSync,
      onPair: handleResetPairing,
      onStatus: handleShowConnectionStatus
    },
    backgroundHandoffProps: {
      handoff: visibleHandoff,
      onSync: handleSyncBackgroundHandoff,
      onDismiss: handleDismissBackgroundHandoff
    },
    toastStackProps: {
      toasts,
      onDismiss: dismissToast
    },
    imagePreviewProps: {
      image: previewImage,
      onClose: () => setPreviewImage(null)
    }
  };
  const drawerProps = {
    open: drawerOpen,
    onClose: () => setDrawerOpen(false),
    projects,
    selectedProject,
    selectedSession,
    expandedProjectIds,
    sessionsByProject,
    loadingProjectId,
    runningById: drawerRunningById,
    threadRuntimeById,
    completedSessionIds,
    onToggleProject: handleToggleProject,
    onSelectSession: handleSelectSession,
    onRenameSession: handleRenameSession,
    onDeleteSession: handleDeleteSession,
    onNewConversation: handleNewConversation,
    onSync: handleSync,
    syncing,
    theme,
    setTheme
  };
  const chatProps = {
    messages,
    selectedSession,
    loading: sessionLoading,
    loadError: sessionLoadError,
    running: selectedRunning,
    now: activityClockNow,
    onPreviewImage: setPreviewImage,
    onDeleteMessage: handleDeleteMessage,
    onImplementPlan: handleImplementPlan,
    onAdjustPlan: handleAdjustPlan
  };
  const composerProps = {
    composerRef,
    input,
    setInput,
    selectedProject,
    selectedSession,
    onSubmit: handleSubmit,
    running: selectedRunning,
    onAbort: handleAbort,
    models: status.models,
    selectedModel,
    onSelectModel: setSelectedModel,
    selectedModelSpeed,
    onSelectModelSpeed: (value) => setSelectedModelSpeed(normalizeModelSpeed(value)),
    selectedReasoningEffort,
    onSelectReasoningEffort: setSelectedReasoningEffort,
    skills: status.skills,
    selectedSkillPaths,
    onToggleSkill: toggleSelectedSkill,
    onSelectSkill: selectSkill,
    onClearSkills: clearSelectedSkills,
    permissionMode,
    onSelectPermission: setPermissionMode,
    attachments,
    onUploadFiles: handleUploadFiles,
    onRemoveAttachment: handleRemoveAttachment,
    fileMentions,
    onAddFileMention: addFileMention,
    onRemoveFileMention: removeFileMention,
    uploading,
    contextStatus: visibleContextStatus,
    runStatus: composerRunStatusForShell,
    desktopBridge: status.desktopBridge,
    queueDrafts,
    onRestoreQueueDraft: restoreQueueDraft,
    onRemoveQueueDraft: removeQueueDraft,
    onSteerQueueDraft: steerQueueDraft
  };

  return (
    <AppShell
      shellClass={shellClass}
      panelProps={panelProps}
      drawerProps={drawerProps}
      chatProps={chatProps}
      composerProps={composerProps}
    />
  );
}
