/**
 * 主侧栏抽屉：项目 / 会话列表、配额与设置入口、归档与子代理等。
 *
 * Keywords: drawer, sidebar, sessions, projects, settings, archive-box, desktop-refresh
 *
 * Exports:
 * - Drawer — 侧栏根组件。
 *
 * Inward: apiFetch、runtime-debug-client、session-utils（路径展示与运行时摘要）、TopBar 侧边栏图标；lucide-react。
 *
 * Outward: App 根布局在菜单打开时渲染。
 */

import { Archive, BarChart3, Check, ChevronDown, Folder, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import { setClientRuntimeDebugEnabled } from '../app/runtime-debug-client.js';
import { compactPath, formatTime, sessionRunBadgeState, subAgentSubtitle } from '../app/session-utils.js';
import { DrawerArchiveView } from './DrawerArchiveView.jsx';
import { DrawerQuotaPanel } from './DrawerQuotaPanel.jsx';
import { DrawerSettingsView } from './DrawerSettingsView.jsx';
import { SidebarToggleIcon } from './TopBar.jsx';

function formatRelativeShort(value) {
  if (!value) {
    return '';
  }
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return '';
  }
  const diff = Date.now() - ts;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天`;
  }
  if (diff < 30 * 86_400_000) {
    return `${Math.floor(diff / (7 * 86_400_000))} 周`;
  }
  return formatTime(value);
}

function projectSourceLabel(project) {
  if (!project || project.projectless) {
    return '';
  }
  const normalizedPath = String(project.path || '').replaceAll('\\', '/');
  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath.includes('/vaults/')) {
    return 'Vaults';
  }
  if (lowerPath.includes('/agent-skills/')) {
    return 'agent-skills';
  }
  const rawLabel = project.pathLabel || compactPath(project.path);
  const parts = String(rawLabel || '').replaceAll('\\', '/').split('/').filter(Boolean);
  const tail = parts.at(-1) || '';
  if (!tail || tail === project.name) {
    return '';
  }
  return tail;
}

export function Drawer({
  open,
  onClose,
  projects,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  runningById,
  threadRuntimeById,
  completedSessionIds,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewConversation,
  onSync,
  syncing,
  theme,
  setTheme,
  runtimeDebug,
  desktopRefresh,
  refreshStatus
}) {
  const [drawerView, setDrawerView] = useState('main');
  const [subagentExpandedById, setSubagentExpandedById] = useState({});
  const [quotaExpanded, setQuotaExpanded] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaNotice, setQuotaNotice] = useState('');
  const [quotaAccounts, setQuotaAccounts] = useState([]);
  const [drawerQuery, setDrawerQuery] = useState('');
  const [threadActionMenu, setThreadActionMenu] = useState(null);
  const [renameDraft, setRenameDraft] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({ projects: false, conversations: false });
  const [runtimeDebugError, setRuntimeDebugError] = useState('');
  const [runtimeDebugSaving, setRuntimeDebugSaving] = useState(false);
  const [desktopRefreshError, setDesktopRefreshError] = useState('');
  const [desktopRefreshSaving, setDesktopRefreshSaving] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [archiveSyncedAt, setArchiveSyncedAt] = useState('');
  const [archiveSource, setArchiveSource] = useState('');
  const [unarchivingSessionIds, setUnarchivingSessionIds] = useState({});
  const normalizedDrawerQuery = drawerQuery.trim().toLowerCase();
  const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';
  const runningCount = Object.values(sessionsByProject || {})
    .flatMap((sessions) => (Array.isArray(sessions) ? sessions : []))
    .filter((session) => sessionRunBadgeState(session, { runningById, threadRuntimeById, completedSessionIds }) === 'running')
    .length;
  const orderedProjects = [
    ...projects.filter((project) => project.projectless),
    ...projects.filter((project) => !project.projectless)
  ];
  const projectlessProject = orderedProjects.find((project) => project.projectless) || null;
  const projectChoices = orderedProjects.filter((project) => !project.projectless);

  useEffect(() => {
    if (!open) {
      setThreadActionMenu(null);
      setRenameDraft(null);
      setRenameValue('');
      setRenameSaving(false);
    }
  }, [open]);

  useEffect(() => {
    if (!renameDraft) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setRenameDraft(null);
        setRenameValue('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [renameDraft]);

  function startNewConversation(project, event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (!project) {
      return;
    }
    setThreadActionMenu(null);
    onNewConversation(project);
  }

  function openThreadActionMenu(project, session, event) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(rect.right - 72, 92), window.innerWidth - 92);
    const y = Math.min(Math.max(rect.bottom + 6, 88), window.innerHeight - 116);
    setThreadActionMenu({ project, session, x, y });
  }

  function handleThreadRename() {
    if (!threadActionMenu) {
      return;
    }
    setRenameDraft({ project: threadActionMenu.project, session: threadActionMenu.session });
    setRenameValue(threadActionMenu.session?.title || '对话');
    setThreadActionMenu(null);
  }

  function closeRenameDialog() {
    if (renameSaving) {
      return;
    }
    setRenameDraft(null);
    setRenameValue('');
  }

  async function submitRenameDialog(event) {
    event.preventDefault();
    if (!renameDraft || renameSaving) {
      return;
    }
    const nextTitle = renameValue.trim().slice(0, 52);
    if (!nextTitle) {
      return;
    }
    if (nextTitle === (renameDraft.session?.title || '对话')) {
      closeRenameDialog();
      return;
    }
    setRenameSaving(true);
    try {
      const ok = await onRenameSession(renameDraft.project, renameDraft.session, nextTitle);
      if (ok !== false) {
        setRenameDraft(null);
        setRenameValue('');
      }
    } finally {
      setRenameSaving(false);
    }
  }

  function handleThreadArchive() {
    if (!threadActionMenu) {
      return;
    }
    onDeleteSession(threadActionMenu.project, threadActionMenu.session);
    setThreadActionMenu(null);
  }

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaExpanded(true);
    setQuotaLoading(true);
    setQuotaError('');
    setQuotaNotice('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setQuotaNotice(result.stale ? (result.staleReason || '实时查询失败，显示最近一次成功结果') : '');
      setQuotaLoaded(true);
    } catch (error) {
      setQuotaError(`${error.message || '查询失败'}，点击刷新重试`);
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  function toggleQuotaPanel() {
    setQuotaExpanded((current) => !current);
  }

  function toggleSection(section) {
    if (section === 'conversations' && collapsedSections.conversations && projectlessProject && !expandedProjectIds[projectlessProject.id]) {
      onToggleProject(projectlessProject);
    }
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  }

  useEffect(() => {
    if (!open || !projectlessProject || expandedProjectIds[projectlessProject.id]) {
      return;
    }
    onToggleProject(projectlessProject);
  }, [open, projectlessProject?.id]);

  useEffect(() => {
    if (!runtimeDebug) {
      return;
    }
    setClientRuntimeDebugEnabled(Boolean(runtimeDebug.uiEnabled));
  }, [runtimeDebug?.uiEnabled]);

  async function handleRuntimeDebugToggle(event) {
    const enabled = event.target.checked;
    setRuntimeDebugError('');
    setRuntimeDebugSaving(true);
    try {
      await apiFetch('/api/runtime-debug', { method: 'POST', body: { enabled } });
      setClientRuntimeDebugEnabled(enabled);
      await refreshStatus?.();
    } catch (error) {
      setRuntimeDebugError(error.message || '保存失败');
      await refreshStatus?.();
    } finally {
      setRuntimeDebugSaving(false);
    }
  }

  async function handleDesktopRefreshToggle(event) {
    const enabled = event.target.checked;
    setDesktopRefreshError('');
    setDesktopRefreshSaving(true);
    try {
      await apiFetch('/api/desktop-refresh', { method: 'POST', body: { enabled } });
      await refreshStatus?.();
    } catch (error) {
      setDesktopRefreshError(error.message || '保存失败');
      await refreshStatus?.();
    } finally {
      setDesktopRefreshSaving(false);
    }
  }

  async function loadArchivedSessions({ force = false } = {}) {
    if (archiveLoading || (archiveLoaded && !force)) {
      return;
    }
    setArchiveLoading(true);
    setArchiveError('');
    try {
      const data = await apiFetch('/api/sessions/archived?limit=200');
      setArchivedSessions(Array.isArray(data.sessions) ? data.sessions : []);
      setArchiveSyncedAt(data.syncedAt || '');
      setArchiveSource(data.source || '');
      setArchiveLoaded(true);
    } catch (error) {
      setArchiveError(error.message || '归档箱同步失败');
      setArchiveLoaded(true);
    } finally {
      setArchiveLoading(false);
    }
  }

  function openArchiveBox() {
    setDrawerView('archive');
    loadArchivedSessions().catch(() => null);
  }

  function openArchivedSession(session) {
    if (!session?.id) {
      return;
    }
    const matchedProject = projects.find((project) => project.path && project.path === session.projectPath);
    setThreadActionMenu(null);
    onSelectSession({
      ...session,
      archived: true,
      draft: false,
      projectId: session.projectId || matchedProject?.id || `archived:${session.projectPath || 'unknown'}`
    });
  }

  async function unarchiveArchivedSession(session) {
    if (!session?.id || unarchivingSessionIds[session.id]) {
      return;
    }
    setArchiveError('');
    setUnarchivingSessionIds((current) => ({ ...current, [session.id]: true }));
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/unarchive`, { method: 'POST' });
      setArchivedSessions((current) => current.filter((item) => item.id !== session.id));
      setArchiveSyncedAt(new Date().toISOString());
      if (selectedSession?.id === session.id) {
        const matchedProject = projects.find((project) => project.path && project.path === session.projectPath);
        onSelectSession({
          ...session,
          archived: false,
          draft: false,
          projectId: session.projectId || matchedProject?.id || `archived:${session.projectPath || 'unknown'}`
        });
      }
      onSync?.();
    } catch (error) {
      setArchiveError(error.message || '取消归档失败，点击刷新重试');
    } finally {
      setUnarchivingSessionIds((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
    }
  }

  if (drawerView === 'archive') {
    return (
      <DrawerArchiveView
        open={open}
        onClose={onClose}
        onBack={() => setDrawerView('settings')}
        onRefresh={() => loadArchivedSessions({ force: true })}
        archivedSessions={archivedSessions}
        archiveLoading={archiveLoading}
        archiveLoaded={archiveLoaded}
        archiveError={archiveError}
        archiveSyncedAt={archiveSyncedAt}
        archiveSource={archiveSource}
        onOpenSession={openArchivedSession}
        onUnarchiveSession={unarchiveArchivedSession}
        unarchivingSessionIds={unarchivingSessionIds}
      />
    );
  }

  if (drawerView === 'settings') {
    return (
      <DrawerSettingsView
        open={open}
        onClose={onClose}
        onBack={() => setDrawerView('main')}
        theme={theme}
        setTheme={setTheme}
        onOpenArchiveBox={openArchiveBox}
        runtimeDebug={runtimeDebug}
        runtimeDebugSaving={runtimeDebugSaving}
        runtimeDebugError={runtimeDebugError}
        onRuntimeDebugToggle={handleRuntimeDebugToggle}
        desktopRefresh={desktopRefresh}
        desktopRefreshSaving={desktopRefreshSaving}
        desktopRefreshError={desktopRefreshError}
        onDesktopRefreshToggle={handleDesktopRefreshToggle}
        appVersion={appVersion}
      />
    );
  }

  const renderThreadRow = (project, session, { isSubAgent = false } = {}) => {
    const badgeState = sessionRunBadgeState(session, { runningById, threadRuntimeById, completedSessionIds });
    const sessionRunning = badgeState === 'running';
    const sessionCompleted = badgeState === 'complete';
    const childCount = Number(session.childCount) || 0;
    const openChildCount = Number(session.openChildCount) || 0;
    const subagentsOpen = Boolean(subagentExpandedById[session.id]);
    const rowSelected = selectedSession?.id === session.id;
    const metaText = session.draft
      ? '待发送'
      : (isSubAgent || session.isSubAgent)
        ? subAgentSubtitle(session)
        : formatRelativeShort(session.updatedAt);
    return (
      <div
        key={session.id}
        className={`thread-row ${rowSelected ? 'is-selected' : ''} ${session.draft ? 'is-draft' : ''} ${sessionRunning ? 'is-running' : ''} ${sessionCompleted ? 'has-complete-notice' : ''} ${isSubAgent || session.isSubAgent ? 'is-subagent' : ''}`}
      >
        <button
          type="button"
          className="thread-main"
          onClick={() => {
            setThreadActionMenu(null);
            onSelectSession(session);
          }}
        >
          <span className="thread-title-line">
            <span className="thread-title">{session.title || '对话'}</span>
            {!isSubAgent && childCount ? (
              <span
                role="button"
                tabIndex={0}
                className="thread-subagent-toggle"
                aria-label={subagentsOpen ? '折叠子代理线程' : '展开子代理线程'}
                aria-expanded={subagentsOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                  }
                }}
              >
                {openChildCount ? `${openChildCount}/${childCount}` : childCount}
                <ChevronDown size={11} />
              </span>
            ) : null}
          </span>
        </button>
        <span className="thread-meta">
          {sessionRunning ? (
            <span className="thread-run-ring" aria-label="运行中" />
          ) : sessionCompleted ? (
            <span className="thread-complete-dot" aria-label="有新完成结果" />
          ) : metaText ? (
            <small>{metaText}</small>
          ) : null}
        </span>
        {rowSelected ? (
          <button
            type="button"
            className="thread-more-button"
            onClick={(event) => openThreadActionMenu(project, session, event)}
            aria-label="打开线程操作"
            aria-haspopup="menu"
            aria-expanded={threadActionMenu?.session?.id === session.id}
          >
            <MoreHorizontal size={16} />
          </button>
        ) : null}
      </div>
    );
  };

  const renderThreadList = (project, visibleProjectSessions, { className = 'thread-list' } = {}) => {
    const projectSessionIds = new Set(visibleProjectSessions.map((session) => session.id));
    const childSessionsByParent = visibleProjectSessions.reduce((acc, session) => {
      if (session.parentSessionId && projectSessionIds.has(session.parentSessionId)) {
        if (!acc.has(session.parentSessionId)) {
          acc.set(session.parentSessionId, []);
        }
        acc.get(session.parentSessionId).push(session);
      }
      return acc;
    }, new Map());
    const rootSessions = visibleProjectSessions.filter(
      (session) => !session.parentSessionId || !projectSessionIds.has(session.parentSessionId)
    );
    return (
      <div className={className}>
        {loadingProjectId === project.id ? (
          <div className="thread-empty">
            <Loader2 className="spin" size={13} />
            加载中
          </div>
        ) : visibleProjectSessions.length ? (
          rootSessions.map((session) => {
            const childSessions = childSessionsByParent.get(session.id) || [];
            const childSessionsOpen = Boolean(subagentExpandedById[session.id]);
            return (
              <div key={session.id} className="thread-stack">
                {renderThreadRow(project, session)}
                {childSessions.length && childSessionsOpen ? (
                  <div className="thread-list is-subagents">
                    {childSessions.map((childSession) => renderThreadRow(project, childSession, { isSubAgent: true }))}
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="thread-empty">暂无线程</div>
        )}
      </div>
    );
  };

  const visibleSessionsForProject = (project) => {
    const projectSessions = sessionsByProject[project.id] || [];
    const projectMatches = normalizedDrawerQuery
      ? [project.name, project.pathLabel, project.path].some((value) => String(value || '').toLowerCase().includes(normalizedDrawerQuery))
      : true;
    const visibleProjectSessions = normalizedDrawerQuery
      ? projectSessions.filter((session) => String(session.title || '对话').toLowerCase().includes(normalizedDrawerQuery))
      : projectSessions;
    if (normalizedDrawerQuery && !projectMatches && !visibleProjectSessions.length) {
      return null;
    }
    return visibleProjectSessions;
  };

  const renderProjectGroup = (project) => {
    const isExpanded = Boolean(expandedProjectIds[project.id]);
    const projectSessions = sessionsByProject[project.id] || [];
    const visibleProjectSessions = visibleSessionsForProject(project);
    if (!visibleProjectSessions) {
      return null;
    }
    const sessionsOpen = isExpanded || Boolean(normalizedDrawerQuery);
    const sessionCount = project.sessionCount ?? projectSessions.length ?? 0;
    const sourceLabel = projectSourceLabel(project);
    return (
      <div key={project.id} className={`project-group ${project.projectless ? 'is-conversations' : 'is-project'}`}>
        <div className="project-row-shell">
          <button
            className={`project-row ${sessionsOpen ? 'is-expanded' : ''}`}
            onClick={() => onToggleProject(project)}
          >
            {project.projectless ? <MessageSquare size={16} /> : <Folder size={16} />}
            <span className="project-label">
              <span className="project-name">
                {project.projectless ? '对话' : project.name}
              </span>
              {sourceLabel ? <small className="project-source">{sourceLabel}</small> : null}
            </span>
            {sessionCount ? <small className="project-count">{sessionCount}</small> : null}
            <ChevronDown size={14} className="project-chevron" />
          </button>
          <button
            type="button"
            className="project-add-button"
            onClick={(event) => startNewConversation(project, event)}
            aria-label={`新建${project.projectless ? '普通' : project.name}对话`}
            title="新建对话"
          >
            <Plus size={15} />
          </button>
        </div>
        {sessionsOpen ? renderThreadList(project, visibleProjectSessions) : null}
      </div>
    );
  };

  const renderConversationThreads = (project) => {
    const visibleProjectSessions = visibleSessionsForProject(project);
    if (!visibleProjectSessions) {
      return null;
    }
    return (
      <div key={project.id} className="project-group is-conversations">
        {renderThreadList(project, visibleProjectSessions, { className: 'thread-list is-conversations-list' })}
      </div>
    );
  };

  const renderSectionHeading = (section, label, count) => {
    const collapsed = Boolean(collapsedSections[section]) && !normalizedDrawerQuery;
    return (
      <button
        type="button"
        className={`drawer-section-heading ${collapsed ? 'is-collapsed' : 'is-open'}`}
        onClick={() => toggleSection(section)}
        aria-expanded={!collapsed}
      >
        <span>{label}</span>
        {Number.isFinite(count) ? <small>{count}</small> : null}
        <ChevronDown size={13} />
      </button>
    );
  };

  const renderedProjectGroups = orderedProjects.filter((project) => !project.projectless).map(renderProjectGroup).filter(Boolean);
  const renderedConversationGroups = orderedProjects.filter((project) => project.projectless).map(renderConversationThreads).filter(Boolean);
  const renderedGroups = [...renderedProjectGroups, ...renderedConversationGroups];

  const statusText = runningCount ? `${runningCount} 个任务运行中` : '已连接';

  return (
    <>
      <div className={`drawer-backdrop drawer-main-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <div className="drawer-header">
          <div className="drawer-brand">
            <img className="drawer-app-icon" src="/codex-icon-180.png" alt="" aria-hidden="true" />
            <span className="drawer-brand-name">CodexMobile</span>
          </div>
          <button className="drawer-header-action sidebar-toggle-button" onClick={onClose} aria-label="收起侧边栏">
            <SidebarToggleIcon />
          </button>
        </div>

        <label className="drawer-search">
          <Search size={14} />
          <input
            type="search"
            value={drawerQuery}
            onChange={(event) => setDrawerQuery(event.target.value)}
            placeholder="搜索对话"
            aria-label="搜索对话或项目"
          />
        </label>

        <div className="drawer-thread-browser">
          <button
            type="button"
            className="drawer-new-row"
            onClick={(event) => startNewConversation(projectlessProject || selectedProject || projectChoices[0], event)}
            title="新对话"
          >
            <Plus size={16} />
            <span>新对话</span>
          </button>

          <div className="project-list">
            {renderedProjectGroups.length ? renderSectionHeading('projects', '项目') : null}
            {collapsedSections.projects && !normalizedDrawerQuery ? null : renderedProjectGroups}
            {renderedConversationGroups.length ? renderSectionHeading('conversations', '对话') : null}
            {collapsedSections.conversations && !normalizedDrawerQuery ? null : renderedConversationGroups}
          </div>
          {normalizedDrawerQuery && !renderedGroups.length ? (
            <div className="drawer-empty-state">没有匹配的对话或项目</div>
          ) : null}
        </div>

        {quotaExpanded ? (
          <DrawerQuotaPanel
            quotaLoading={quotaLoading}
            quotaLoaded={quotaLoaded}
            quotaError={quotaError}
            quotaNotice={quotaNotice}
            quotaAccounts={quotaAccounts}
            onRefresh={refreshCodexQuota}
          />
        ) : null}

        <footer className="drawer-footer">
          <div className="drawer-footer-actions">
            <button
              type="button"
              className="footer-icon-button"
              onClick={() => setDrawerView('settings')}
              aria-label="设置"
            >
              <Settings size={16} />
            </button>
            <button
              type="button"
              className={`footer-icon-button ${syncing ? 'is-busy' : ''}`}
              onClick={onSync}
              disabled={syncing}
              aria-label="同步对话"
            >
              {syncing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            </button>
            <button
              type="button"
              className={`footer-icon-button ${quotaExpanded ? 'is-active' : ''}`}
              onClick={toggleQuotaPanel}
              aria-label="额度查询"
              aria-expanded={quotaExpanded}
            >
              <BarChart3 size={16} />
            </button>
          </div>
          <span className="drawer-footer-status">{statusText}</span>
        </footer>

        {threadActionMenu ? (
          <div className="thread-action-backdrop" onClick={() => setThreadActionMenu(null)}>
            <div
              className="thread-action-menu"
              role="menu"
              aria-label="线程操作"
              style={{
                '--thread-menu-x': `${threadActionMenu.x}px`,
                '--thread-menu-y': `${threadActionMenu.y}px`
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" role="menuitem" onClick={handleThreadRename}>
                <Pencil size={16} />
                <span>重命名</span>
              </button>
              <button type="button" role="menuitem" className="is-danger" onClick={handleThreadArchive}>
                <Archive size={16} />
                <span>归档</span>
              </button>
            </div>
          </div>
        ) : null}
        {renameDraft ? (
          <div className="thread-rename-backdrop" onClick={closeRenameDialog}>
            <form className="thread-rename-dialog" onSubmit={submitRenameDialog} onClick={(event) => event.stopPropagation()}>
              <div className="thread-rename-head">
                <strong>重命名线程</strong>
                <button type="button" className="thread-rename-icon" onClick={closeRenameDialog} aria-label="取消重命名">
                  <X size={16} />
                </button>
              </div>
              <input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value.slice(0, 52))}
                placeholder="输入线程名称"
                aria-label="线程名称"
                maxLength={52}
              />
              <div className="thread-rename-actions">
                <button type="button" className="thread-rename-secondary" onClick={closeRenameDialog} disabled={renameSaving}>
                  取消
                </button>
                <button type="submit" className="thread-rename-primary" disabled={renameSaving || !renameValue.trim()}>
                  {renameSaving ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                  <span>{renameSaving ? '保存中' : '保存'}</span>
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </aside>
    </>
  );
}
