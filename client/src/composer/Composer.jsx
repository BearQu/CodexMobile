/**
 * 主聊天输入区：附件、模型/推理/权限/技能、首页项目选择、剪贴板粘贴与发送流程。
 *
 * Keywords: composer, chat input, attachments, model, skills
 *
 * Exports:
 * - DEFAULT_PERMISSION_MODE — re-export 默认权限模式常量。
 * - Composer — 组合输入框与各下拉与状态控件的根组件。
 *
 * Inward: api、session-utils、composer-options、attachment-preview、paste-files、ContextStatus、Codex 快捷指令等。
 *
 * Outward: App.jsx 或上层布局挂载输入条处。
 */

import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, ClipboardList, FileText, Folder, Image, Loader2, MessageSquare, MessageSquarePlus, Paperclip, Plus, Search, Shield, Square, Terminal, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, getToken } from '../api.js';
import { detectComposerToken, exactSlashCommandForInput, filteredSlashCommands, replaceComposerToken } from '../composer-shortcuts.js';
import { composerSendState } from '../send-state.js';
import { compactPath, isDraftSession } from '../app/session-utils.js';
import { attachmentPreviewUrl, isImageAttachment } from './attachment-preview.js';
import { filesFromClipboardData } from './paste-files.js';
import { ContextStatusButton, ContextStatusDetails } from './ContextStatus.jsx';
import { DEFAULT_PERMISSION_MODE, MODEL_SPEED_OPTIONS, PERMISSION_OPTIONS, REASONING_OPTIONS, formatBytes, modelSpeedLabel, normalizeModelSpeed, permissionLabel, reasoningLabel, selectedSkillSummary, shortModelName } from './composer-options.js';

export { DEFAULT_PERMISSION_MODE } from './composer-options.js';

export function Composer({
  composerRef,
  input,
  setInput,
  selectedProject,
  selectedSession,
  onSubmit,
  running,
  onAbort,
  models,
  selectedModel,
  onSelectModel,
  selectedModelSpeed,
  onSelectModelSpeed,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  selectedCollaborationMode,
  onSelectCollaborationMode,
  skills,
  selectedSkillPaths,
  onToggleSkill,
  onSelectSkill,
  onClearSkills,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  fileMentions,
  onAddFileMention,
  onRemoveFileMention,
  uploading,
  contextStatus,
  runSteerable = true,
  desktopBridge,
  queueDrafts,
  onRestoreQueueDraft,
  onRemoveQueueDraft,
  onSteerQueueDraft,
  onCompactContext,
  readOnly = false,
  readOnlyReason = '',
  homeMode = false,
  projects = [],
  onSelectHomeProject
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [modelSubmenu, setModelSubmenu] = useState(null);
  const [skillFilter, setSkillFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [fileSearch, setFileSearch] = useState({ query: '', loading: false, results: [] });
  const selectedFileMentions = Array.isArray(fileMentions) ? fileMentions : [];
  const deviceToken = getToken();
  const composerReadOnly = Boolean(readOnly);
  const hasInput = !composerReadOnly && (input.trim().length > 0 || attachments.length > 0 || selectedFileMentions.length > 0);
  const modelList = models?.length ? models : [{ value: selectedModel || 'gpt-5.5', label: selectedModel || 'gpt-5.5' }];
  const selectedModelLabel = modelList.find((model) => model.value === selectedModel)?.label || selectedModel || 'gpt-5.5';
  const normalizedModelSpeed = normalizeModelSpeed(selectedModelSpeed);
  const skillList = Array.isArray(skills) ? skills : [];
  const selectedSkillSet = new Set(Array.isArray(selectedSkillPaths) ? selectedSkillPaths : []);
  const selectedSkills = skillList.filter((skill) => selectedSkillSet.has(skill.path));
  const projectList = Array.isArray(projects) ? projects : [];
  const projectlessProject = projectList.find((project) => project.projectless) || null;
  const regularProjects = projectList.filter((project) => !project.projectless);
  const homeProject = selectedProject || projectlessProject || regularProjects[0] || null;
  const normalizedProjectFilter = projectFilter.trim().toLowerCase();
  const filteredHomeProjects = regularProjects.filter((project) => {
    if (!normalizedProjectFilter) {
      return true;
    }
    return [project.name, project.pathLabel, project.path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedProjectFilter));
  });
  const homeProjectLabel = homeProject?.projectless
    ? '不使用项目'
    : homeProject?.name
      ? `加入项目：${homeProject.name}`
      : '选择项目';
  const composerToken = useMemo(
    () => detectComposerToken(input, cursorPosition || input.length),
    [input, cursorPosition]
  );
  const slashMatches = composerToken?.type === 'slash'
    ? filteredSlashCommands(composerToken.query)
    : [];
  const tokenSkillMatches = composerToken?.type === 'skill'
    ? skillList
      .filter((skill) => {
        const query = composerToken.query.trim().toLowerCase();
        if (!query) {
          return true;
        }
        return [skill.label, skill.name, skill.description, skill.path]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .slice(0, 12)
    : [];
  const sendState = composerReadOnly
    ? {
      disabled: true,
      label: readOnlyReason || '当前线程只读',
      mode: 'readonly',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    }
    : composerSendState({
      running,
      hasInput,
      uploading,
      desktopBridge,
      steerable: runSteerable,
      sessionIsDraft: isDraftSession(selectedSession)
    });
  const stopMode = sendState.mode === 'abort';
  const runningInputMode = running && hasInput;
  const sendLabel = sendState.label;
  const filteredSkills = skillList.filter((skill) => {
    const query = skillFilter.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return [skill.label, skill.name, skill.description, skill.path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => {
    if (composerToken?.type !== 'file' || !selectedProject?.id) {
      setFileSearch({ query: '', loading: false, results: [] });
      return undefined;
    }

    const query = composerToken.query || '';
    let cancelled = false;
    setFileSearch((current) => ({ ...current, query, loading: true }));
    const timer = window.setTimeout(() => {
      apiFetch(`/api/files/search?projectId=${encodeURIComponent(selectedProject.id)}&q=${encodeURIComponent(query)}`)
        .then((result) => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: Array.isArray(result.files) ? result.files : [] });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: [] });
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerToken?.type, composerToken?.query, selectedProject?.id]);

  function updateCursorFromTextarea() {
    const textarea = textareaRef.current;
    setCursorPosition(textarea?.selectionStart ?? input.length);
  }

  function replaceCurrentToken(replacement) {
    if (!composerToken) {
      return;
    }
    const next = replaceComposerToken(input, composerToken, replacement);
    setInput(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const position = Math.min(next.length, composerToken.start + String(replacement || '').length);
      textareaRef.current?.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  }

  function runSlashCommand(command) {
    if (command.action === 'compact-context') {
      replaceCurrentToken('');
      setOpenMenu(null);
      onCompactContext?.();
      return;
    }
    replaceCurrentToken(command.prompt ? `${command.prompt} ` : '');
    if (command.action === 'open-context') {
      setOpenMenu('context');
    } else {
      setOpenMenu(null);
    }
  }

  function selectTokenSkill(skill) {
    if (skill?.path) {
      onSelectSkill(skill.path);
    }
    replaceCurrentToken('');
    setOpenMenu(null);
  }

  function selectTokenFile(file) {
    if (!file?.path) {
      return;
    }
    onAddFileMention(file);
    replaceCurrentToken(`@${file.relativePath || file.name} `);
    setOpenMenu(null);
  }

  function submit(event) {
    event.preventDefault();
    if (composerReadOnly) {
      return;
    }
    if (stopMode) {
      onAbort();
      return;
    }
    const exactCommand = exactSlashCommandForInput(input);
    if (exactCommand?.action === 'compact-context') {
      setInput('');
      setOpenMenu(null);
      onCompactContext?.();
      return;
    }
    if (runningInputMode) {
      setOpenMenu((current) => (current === 'send-mode' ? null : 'send-mode'));
      return;
    }
    if (hasInput) {
      onSubmit({ mode: 'start', collaborationMode: selectedCollaborationMode });
      setOpenMenu(null);
    }
  }

  function toggleMenu(name) {
    if (composerReadOnly) {
      return;
    }
    setOpenMenu((current) => {
      const next = current === name ? null : name;
      if (next !== 'model' || current !== 'model') {
        setModelSubmenu(null);
      }
      return next;
    });
    if (name !== 'skill') {
      setSkillFilter('');
    }
    if (name !== 'project') {
      setProjectFilter('');
    }
  }

  function closeModelMenu() {
    setModelSubmenu(null);
    setOpenMenu(null);
  }

  function handleFiles(event, kind) {
    if (composerReadOnly) {
      event.target.value = '';
      return;
    }
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  function handlePaste(event) {
    if (composerReadOnly) {
      return;
    }
    const files = filesFromClipboardData(event.clipboardData);
    if (!files.length) {
      return;
    }
    const text = event.clipboardData?.getData?.('text') || '';
    if (!text) {
      event.preventDefault();
    }
    onUploadFiles(files, 'paste');
    setOpenMenu(null);
  }

  const tokenPanelOpen = !openMenu && composerToken && (
    (composerToken.type === 'slash' && slashMatches.length > 0) ||
    (composerToken.type === 'skill') ||
    (composerToken.type === 'file')
  );

  return (
    <form className="composer-wrap" ref={composerRef} onSubmit={submit}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button
            type="button"
            className={selectedCollaborationMode === 'plan' ? 'is-selected' : ''}
            onClick={() => {
              onSelectCollaborationMode?.(selectedCollaborationMode === 'plan' ? null : 'plan');
              setOpenMenu(null);
              textareaRef.current?.focus();
            }}
          >
            {selectedCollaborationMode === 'plan' ? <Check size={16} /> : <ClipboardList size={17} />}
            计划模式
          </button>
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            <FileText size={17} />
            文件
          </button>
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              {permissionMode === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'skill' ? (
        <div className="composer-menu skill-menu">
          <div className="skill-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              placeholder="搜索 skill"
              aria-label="搜索 skill"
            />
          </div>
          {selectedSkills.length ? (
            <button type="button" className="skill-clear-button" onClick={onClearSkills}>
              <span className="menu-spacer" />
              <span>不指定 skill</span>
            </button>
          ) : null}
          {filteredSkills.length ? (
            filteredSkills.map((skill) => {
              const selected = selectedSkillSet.has(skill.path);
              return (
                <button
                  key={skill.path}
                  type="button"
                  className={`skill-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => onToggleSkill(skill.path)}
                >
                  {selected ? <Check size={16} /> : <span className="menu-spacer" />}
                  <span>
                    <strong>{skill.label || skill.name}</strong>
                    {skill.description ? <small>{skill.description}</small> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          )}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <>
          <div className={`composer-menu model-menu ${modelSubmenu ? 'has-submenu' : ''}`}>
            <div className="menu-section-label">智能</div>
            {REASONING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
                onClick={() => {
                  onSelectReasoningEffort(option.value);
                  closeModelMenu();
                }}
              >
                {selectedReasoningEffort === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
                <span>{option.label}</span>
              </button>
            ))}
            <div className="menu-divider" />
            <button
              type="button"
              className={`model-menu-parent ${modelSubmenu === 'model' ? 'is-selected' : ''}`}
              onClick={() => setModelSubmenu((current) => (current === 'model' ? null : 'model'))}
            >
              <span className="menu-spacer" />
              <span className="menu-item-main">
                <strong>{selectedModelLabel}</strong>
                <small>模型</small>
              </span>
              <ChevronRight className="submenu-chevron" size={15} />
            </button>
            <button
              type="button"
              className={`model-menu-parent ${modelSubmenu === 'speed' ? 'is-selected' : ''}`}
              onClick={() => setModelSubmenu((current) => (current === 'speed' ? null : 'speed'))}
            >
              <span className="menu-spacer" />
              <span className="menu-item-main">
                <strong>速度</strong>
                <small>{modelSpeedLabel(normalizedModelSpeed)}</small>
              </span>
              <ChevronRight className="submenu-chevron" size={15} />
            </button>
          </div>
          {modelSubmenu === 'model' ? (
            <div className="composer-menu model-submenu">
              <div className="menu-section-label">模型</div>
              {modelList.map((model) => (
                <button
                  key={model.value}
                  type="button"
                  className={selectedModel === model.value ? 'is-selected' : ''}
                  onClick={() => {
                    onSelectModel(model.value);
                    closeModelMenu();
                  }}
                >
                  {selectedModel === model.value ? <Check size={16} /> : <span className="menu-spacer" />}
                  <span>{model.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {modelSubmenu === 'speed' ? (
            <div className="composer-menu model-submenu">
              <div className="menu-section-label">速度</div>
              {MODEL_SPEED_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={normalizedModelSpeed === option.value ? 'is-selected' : ''}
                  onClick={() => {
                    onSelectModelSpeed?.(option.value);
                    closeModelMenu();
                  }}
                >
                  {normalizedModelSpeed === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
                  {option.value === 'fast' ? <Zap size={15} /> : null}
                  <span className="menu-item-main">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {openMenu === 'context' ? (
        <div className="context-popover" role="status">
          <ContextStatusDetails contextStatus={contextStatus} />
        </div>
      ) : null}
      {openMenu === 'project' && homeMode ? (
        <div className="composer-menu project-menu" aria-label="选择项目">
          <div className="skill-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              placeholder="搜索项目"
              aria-label="搜索项目"
            />
          </div>
          {projectlessProject ? (
            <button
              type="button"
              className={`project-menu-item ${homeProject?.id === projectlessProject.id ? 'is-selected' : ''}`}
              onClick={() => {
                onSelectHomeProject?.(projectlessProject);
                setOpenMenu(null);
              }}
            >
              {homeProject?.id === projectlessProject.id ? <Check size={16} /> : <MessageSquare size={16} />}
              <span>
                <strong>不使用项目</strong>
                <small>作为普通对话发送</small>
              </span>
            </button>
          ) : null}
          {filteredHomeProjects.length ? (
            filteredHomeProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-menu-item ${homeProject?.id === project.id ? 'is-selected' : ''}`}
                onClick={() => {
                  onSelectHomeProject?.(project);
                  setOpenMenu(null);
                }}
              >
                {homeProject?.id === project.id ? <Check size={16} /> : <Folder size={16} />}
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.pathLabel || compactPath(project.path)}</small>
                </span>
              </button>
            ))
          ) : (
            <div className="menu-empty">{regularProjects.length ? '没有匹配的项目' : '暂无可用项目'}</div>
          )}
        </div>
      ) : null}
      {tokenPanelOpen ? (
        <div className="composer-menu shortcut-menu" role="listbox">
          {composerToken.type === 'slash' ? (
            slashMatches.map((command) => (
              <button key={command.id} type="button" onClick={() => runSlashCommand(command)}>
                <Terminal size={16} />
                <span>
                  <strong>{command.title}</strong>
                  <small>{command.aliases.join(' ')}</small>
                </span>
              </button>
            ))
          ) : null}
          {composerToken.type === 'skill' ? (
            tokenSkillMatches.length ? tokenSkillMatches.map((skill) => (
              <button key={skill.path} type="button" onClick={() => selectTokenSkill(skill)}>
                {selectedSkillSet.has(skill.path) ? <Check size={16} /> : <Bot size={16} />}
                <span>
                  <strong>{skill.label || skill.name}</strong>
                  {skill.description ? <small>{skill.description}</small> : null}
                </span>
              </button>
            )) : <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          ) : null}
          {composerToken.type === 'file' ? (
            fileSearch.loading ? (
              <div className="menu-empty"><Loader2 className="spin" size={15} /> 正在搜索文件</div>
            ) : fileSearch.results.length ? fileSearch.results.map((file) => (
              <button key={file.path} type="button" onClick={() => selectTokenFile(file)}>
                <FileText size={16} />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.relativePath}</small>
                </span>
              </button>
            )) : <div className="menu-empty">没有匹配的文件</div>
          ) : null}
        </div>
      ) : null}
      {queueDrafts?.length ? (
        <div className="queued-drafts-panel" aria-label="排队消息">
          {queueDrafts.map((draft) => (
            <div key={draft.id} className="queued-draft-row">
              <MessageSquarePlus size={15} />
              <button type="button" className="queued-draft-text" onClick={() => onRestoreQueueDraft(draft.id)}>
                <strong>{draft.text || '请查看附件。'}</strong>
                <small>{draft.selectedSkills?.length ? `${draft.selectedSkills.length} skills` : '排队中'}</small>
              </button>
              <div className="queued-draft-actions">
                <button type="button" onClick={() => onSteerQueueDraft(draft.id)} aria-label="立即发送到当前任务">
                  <MessageSquare size={14} />
                </button>
                <button type="button" onClick={() => onRemoveQueueDraft(draft.id)} aria-label="删除排队消息">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {openMenu === 'send-mode' ? (
        <div className="composer-menu send-mode-menu">
          <button
            type="button"
            disabled={!sendState.canSteer}
            onClick={() => {
              if (!sendState.canSteer) {
                return;
              }
              onSubmit({ mode: 'steer', collaborationMode: selectedCollaborationMode });
              setOpenMenu(null);
            }}
          >
            <MessageSquare size={16} />
            <span>
              <strong>发送到当前任务</strong>
              <small>{sendState.canSteer ? '直接补充给正在执行的后台任务' : '当前任务暂时不能接收补充消息'}</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              onSubmit({ mode: 'queue', collaborationMode: selectedCollaborationMode });
              setOpenMenu(null);
            }}
          >
            <MessageSquarePlus size={16} />
            <span>
              <strong>加入队列</strong>
              <small>当前任务结束后自动发送</small>
            </span>
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              onSubmit({ mode: 'interrupt', collaborationMode: selectedCollaborationMode });
              setOpenMenu(null);
            }}
          >
            <Square size={15} />
            <span>
              <strong>中止并发送</strong>
              <small>停下当前任务，用这条消息重新引导</small>
            </span>
          </button>
        </div>
      ) : null}
      <div className="composer">
        {attachments.length || selectedFileMentions.length || selectedCollaborationMode === 'plan' ? (
          <div className="attachment-tray">
            {selectedCollaborationMode === 'plan' ? (
              <span className="attachment-chip plan-mode-chip">
                <ClipboardList size={14} />
                <span>计划模式</span>
                <button type="button" onClick={() => onSelectCollaborationMode?.(null)} aria-label="退出计划模式">
                  <X size={13} />
                </button>
              </span>
            ) : null}
            {attachments.map((attachment) => {
              if (isImageAttachment(attachment)) {
                const previewUrl = attachmentPreviewUrl(attachment, deviceToken);
                return (
                  <span key={attachment.id} className="attachment-preview-card">
                    {previewUrl ? (
                      <img src={previewUrl} alt={attachment.name || '图片附件'} loading="lazy" />
                    ) : (
                      <span className="attachment-preview-empty"><Image size={18} /></span>
                    )}
                    <span className="attachment-preview-meta">
                      <span>{attachment.name || '图片'}</span>
                      <small>{formatBytes(attachment.size)}</small>
                    </span>
                    <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除图片">
                      <Trash2 size={13} />
                    </button>
                  </span>
                );
              }
              return (
                <span key={attachment.id} className="attachment-chip">
                  <Paperclip size={14} />
                  <span>{attachment.name}</span>
                  <small>{formatBytes(attachment.size)}</small>
                  <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                    <Trash2 size={13} />
                  </button>
                </span>
              );
            })}
            {selectedFileMentions.map((file) => (
              <span key={file.path} className="attachment-chip file-mention-chip">
                <FileText size={14} />
                <span>{file.relativePath || file.name}</span>
                <button type="button" onClick={() => onRemoveFileMention(file.path)} aria-label="移除文件引用">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setCursorPosition(event.target.selectionStart ?? event.target.value.length);
          }}
          onClick={updateCursorFromTextarea}
          onKeyUp={updateCursorFromTextarea}
          onFocus={() => setOpenMenu(null)}
          onPaste={handlePaste}
          placeholder={composerReadOnly ? (readOnlyReason || '当前线程只读') : '给 Codex 发送消息'}
          readOnly={composerReadOnly}
          disabled={composerReadOnly}
        />
        <div className="composer-controls">
          <button
            type="button"
            className="composer-attach"
            aria-label="添加附件"
            onClick={() => toggleMenu('attach')}
            disabled={uploading || composerReadOnly}
          >
            <Plus size={18} />
          </button>
          <div className="composer-tool-strip" role="toolbar" aria-label="发送选项">
            <button
              type="button"
              className={`composer-tool-icon ${permissionMode === 'bypassPermissions' ? 'is-permission-bypass' : ''}`}
              onClick={() => toggleMenu('permission')}
              disabled={composerReadOnly}
              title={permissionLabel(permissionMode)}
              aria-label={`权限：${permissionLabel(permissionMode)}`}
            >
              <Shield size={17} strokeWidth={1.85} />
            </button>
            <button
              type="button"
              className="composer-tool-icon composer-tool-skills"
              data-count={selectedSkills.length > 0 ? String(selectedSkills.length) : undefined}
              onClick={() => toggleMenu('skill')}
              disabled={composerReadOnly}
              title={selectedSkillSummary(selectedSkills)}
              aria-label={`技能：${selectedSkillSummary(selectedSkills)}`}
            >
              <Bot size={17} strokeWidth={1.85} />
            </button>
            <ContextStatusButton
              variant="compact"
              contextStatus={contextStatus}
              open={openMenu === 'context'}
              onToggle={() => toggleMenu('context')}
            />
            <button type="button" className="model-chip" onClick={() => toggleMenu('model')} disabled={composerReadOnly} title={`${selectedModelLabel} · ${reasoningLabel(selectedReasoningEffort)}`}>
              <span className="model-chip-text">
                <span className="model-chip-name">{shortModelName(selectedModelLabel)}</span>
                <span className="model-chip-dot" aria-hidden="true" />
                <span className="model-chip-reason">{reasoningLabel(selectedReasoningEffort)}</span>
                {normalizedModelSpeed === 'fast' ? (
                  <>
                    <span className="model-chip-dot" aria-hidden="true" />
                    <span className="model-chip-speed">{modelSpeedLabel(normalizedModelSpeed)}</span>
                  </>
                ) : null}
              </span>
              <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <button
            type="submit"
            className={`send-button ${stopMode ? 'is-running' : ''} ${runningInputMode ? 'is-queueing' : ''}`}
            disabled={sendState.disabled}
            aria-label={sendLabel}
            title={sendLabel}
          >
            {stopMode ? <Square size={15} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.25} />}
          </button>
        </div>
      </div>
      {homeMode ? (
        <div className="home-project-strip" aria-label="首页项目选择">
          <button
            type="button"
            className="home-project-button"
            onClick={() => toggleMenu('project')}
            disabled={composerReadOnly || !homeProject}
            aria-expanded={openMenu === 'project'}
            title={homeProjectLabel}
          >
            {homeProject?.projectless ? <MessageSquare size={15} /> : <Folder size={15} />}
            <span>{homeProjectLabel}</span>
            <ChevronDown size={13} />
          </button>
        </div>
      ) : null}
    </form>
  );
}
