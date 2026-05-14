/**
 * 主顶栏：会话标题、连接状态、侧边栏切换、桌面回跳、文档 / Git 快捷入口与线程 ID 复制等。
 *
 * Keywords: topbar, header, desktop-handoff, git, docs, notifications
 *
 * Exports:
 * - SidebarToggleIcon — 与 macOS 风格相近的侧边栏切换图标。
 * - TopBar — 顶栏组件。
 * - bridgeConnectionLabel — 自 topbar-status 再导出。
 *
 * Inward: clipboard、session-utils、DocsPanel、topbar-status；lucide-react。
 *
 * Outward: App 根布局顶部固定区域。
 */

import { Bell, Check, Copy, GitBranch, GitCommitHorizontal, MonitorUp, MoreHorizontal, Plus, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../utils/clipboard.js';
import { isDraftSession } from '../app/session-utils.js';
import { desktopHandoffMenuState } from '../desktop-handoff-state.js';
import { FeishuLogoIcon } from './DocsPanel.jsx';
import { bridgeConnectionLabel } from './topbar-status.js';

export { bridgeConnectionLabel } from './topbar-status.js';

export function SidebarToggleIcon({ size = 17 }) {
  return (
    <span className="sidebar-toggle-icon" style={{ '--sidebar-toggle-size': `${size}px` }} aria-hidden="true">
      <span className="sidebar-toggle-pane" />
    </span>
  );
}

export function TopBar({
  selectedProject,
  selectedSession,
  connectionState,
  desktopBridge,
  selectedRuntime,
  onMenu,
  onOpenDocs,
  onGitAction,
  onDesktopHandoff,
  desktopHandoffSupported = true,
  desktopHandoffPending = false,
  notificationSupported,
  notificationEnabled,
  onEnableNotifications,
  gitDisabled = false,
  homeMode = false
}) {
  const status = bridgeConnectionLabel(connectionState, desktopBridge, { selectedSession, selectedRuntime });
  const [menuOpen, setMenuOpen] = useState(false);
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const [copiedThreadId, setCopiedThreadId] = useState(false);
  const menuRef = useRef(null);
  const gitMenuRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const canCopyThreadId = Boolean(selectedSession?.id && !isDraftSession(selectedSession));
  const desktopHandoffState = desktopHandoffMenuState({
    selectedSession,
    selectedRuntime,
    supported: desktopHandoffSupported,
    pending: desktopHandoffPending
  });
  const title = selectedSession?.title || selectedProject?.name || 'CodexMobile';

  useEffect(() => {
    if (!menuOpen && !gitMenuOpen) {
      return undefined;
    }
    function closeMenu(event) {
      if (menuOpen && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
      if (gitMenuOpen && !gitMenuRef.current?.contains(event.target)) {
        setGitMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [menuOpen, gitMenuOpen]);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  function handleGitAction(action) {
    setMenuOpen(false);
    setGitMenuOpen(false);
    onGitAction?.(action);
  }

  function handleOpenGitPanel() {
    setMenuOpen(false);
    setGitMenuOpen((value) => !value);
  }

  async function handleCopyThreadId() {
    if (!canCopyThreadId) {
      return;
    }
    const copied = await copyTextToClipboard(selectedSession.id);
    if (!copied) {
      window.alert('复制失败');
      return;
    }
    setCopiedThreadId(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopiedThreadId(false), 1400);
  }

  function handleOpenDocs() {
    setMenuOpen(false);
    onOpenDocs?.();
  }

  function handleDesktopHandoff() {
    if (desktopHandoffState.disabled) {
      return;
    }
    setMenuOpen(false);
    onDesktopHandoff?.();
  }

  function handleEnableNotifications() {
    setMenuOpen(false);
    onEnableNotifications?.();
  }

  return (
    <header className={`top-bar ${homeMode ? 'is-home' : ''}`}>
      <button className="icon-button sidebar-toggle-button" onClick={onMenu} aria-label="打开侧边栏">
        <SidebarToggleIcon />
      </button>
      <div className="top-title">
        <strong>{title}</strong>
        <span className={`connection-status ${status.className}`} title={status.description} aria-label={status.description || status.label}>
          <span className="connection-dot" aria-hidden="true" />
          {status.label}
        </span>
      </div>
      {!homeMode ? (
      <div className="top-actions">
        <div className="top-menu-wrap" ref={gitMenuRef}>
          <button
            type="button"
            className="icon-button"
            onClick={handleOpenGitPanel}
            disabled={gitDisabled}
            aria-label="打开 Git 操作"
            aria-expanded={gitMenuOpen}
            title="Git"
          >
            <GitBranch size={21} />
          </button>
          {gitMenuOpen ? (
            <div className="top-menu-popover git-menu-popover" role="menu" aria-label="Git 操作">
              <button type="button" role="menuitem" onClick={() => handleGitAction('commit')}>
                <GitCommitHorizontal size={16} />
                <span>提交</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('push')}>
                <UploadCloud size={16} />
                <span>推送</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('branch')}>
                <Plus size={16} />
                <span>创建分支</span>
              </button>
            </div>
          ) : null}
        </div>
        <div className="top-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="更多操作"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={22} />
          </button>
          {menuOpen ? (
            <div className="top-menu-popover" role="menu" aria-label="更多操作">
              <div className="top-menu-title">
                <MoreHorizontal size={16} />
                <span>更多</span>
              </div>
              <button type="button" role="menuitem" onClick={handleCopyThreadId} disabled={!canCopyThreadId}>
                {copiedThreadId ? <Check size={16} /> : <Copy size={16} />}
                <span>{copiedThreadId ? '已复制对话 ID' : '复制对话 ID'}</span>
              </button>
              <button type="button" role="menuitem" onClick={handleDesktopHandoff} disabled={desktopHandoffState.disabled} title={desktopHandoffState.reason}>
                <MonitorUp size={16} />
                <span>{desktopHandoffState.label}</span>
              </button>
              <button type="button" role="menuitem" onClick={handleOpenDocs}>
                <FeishuLogoIcon size={18} className="top-docs-logo" />
                <span>飞书文档</span>
              </button>
              <button type="button" role="menuitem" onClick={handleEnableNotifications}>
                <Bell size={16} />
                <span>{notificationEnabled ? '完成通知已开启' : '开启完成通知'}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      ) : null}
    </header>
  );
}
