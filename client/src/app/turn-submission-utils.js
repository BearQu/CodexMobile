import {
  completeActivityMessagesForTurn,
  upsertStatusMessage
} from '../chat/activity-model.js';

export function realSessionIdFromTurn(turn) {
  const sessionIdText = String(turn?.sessionId || '');
  if (!sessionIdText || sessionIdText.startsWith('draft-') || sessionIdText.startsWith('codex-')) {
    return null;
  }
  return sessionIdText;
}

export function turnMatchesSelection(currentSession, { turnId, optimisticSessionId, realSessionId, previousSessionId } = {}) {
  if (!currentSession) {
    return true;
  }
  return (
    currentSession.id === optimisticSessionId ||
    currentSession.id === realSessionId ||
    currentSession.id === previousSessionId ||
    currentSession.turnId === turnId ||
    Boolean(currentSession.draft)
  );
}

export function sessionForTurnSelection(selectedSession, selectedSessionRef, selectedProject = null) {
  const session = selectedSessionRef?.current || selectedSession || null;
  if (!session || !selectedProject?.id || !session.projectId) {
    return session;
  }
  return session.projectId === selectedProject.id ? session : null;
}

export function projectForTurnSelection(selectedProject, selectedProjectRef, selectedSession = null, selectedSessionRef = null, projects = []) {
  const directProject = selectedProjectRef?.current || selectedProject || null;
  if (directProject) {
    return directProject;
  }
  const session = selectedSessionRef?.current || selectedSession || null;
  const projectId = session?.projectId || null;
  if (!projectId) {
    return null;
  }
  return (Array.isArray(projects) ? projects : []).find((project) => project.id === projectId) || null;
}

export function displayMessageForTurn(message, attachments = [], fileMentions = []) {
  const text = String(message || '').trim();
  if (text) {
    return text;
  }
  if (Array.isArray(attachments) && attachments.length) {
    return '请查看附件。';
  }
  if (Array.isArray(fileMentions) && fileMentions.length) {
    return '请查看引用文件。';
  }
  return '';
}

export function userMessageMetadataForSendMode(sendMode = 'start') {
  return sendMode === 'steer'
    ? {
      guided: true,
      guideLabel: '已引导对话',
      kind: 'guided_user'
    }
    : {};
}

export function shouldShowOptimisticSubmission(sendMode = 'start') {
  return String(sendMode || 'start') !== 'queue';
}

export function isQueuedSendResult(result = {}) {
  return Boolean(result?.queued || result?.delivery === 'queued');
}

export const IMPLEMENT_PLAN_PROMPT_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:';

export function implementationPromptForPlan(planContent) {
  const text = String(planContent || '').trim();
  if (!text) {
    return '';
  }
  return `${IMPLEMENT_PLAN_PROMPT_PREFIX}\n${text}`;
}

export function prepareComposerSubmission(message, attachments = [], fileMentions = []) {
  const raw = String(message || '').trim();
  const planMatch = raw.match(/^\/(?:plan|计划模式)(?:\s+|$)/iu);
  const messageText = planMatch ? raw.slice(planMatch[0].length).trim() : raw;
  return {
    message: displayMessageForTurn(messageText, attachments, fileMentions),
    collaborationMode: planMatch ? 'plan' : null
  };
}

export function selectedSkillsForPaths(skills, selectedSkillPaths) {
  const selected = new Set(selectedSkillPaths || []);
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => selected.has(skill.path))
    .map((skill) => ({
      name: skill.name || skill.label,
      path: skill.path
    }));
}

export function restoredComposerText(current, nextText) {
  const value = String(nextText || '').trim();
  if (!value) {
    return current;
  }
  const base = String(current || '').trimEnd();
  if (!base) {
    return value;
  }
  if (base.includes(value)) {
    return current;
  }
  return `${base}\n${value}`;
}

export function shouldPollTurnEndpointAfterSend(result = {}) {
  if (isQueuedSendResult(result)) {
    return false;
  }
  return !['desktop-ipc', 'headless-local'].includes(result?.desktopBridge?.mode);
}

export function localHandoffStatusPayload({ sessionId, previousSessionId = null, turnId, timestamp = new Date().toISOString() } = {}) {
  return {
    sessionId,
    previousSessionId,
    turnId,
    kind: 'turn',
    status: 'running',
    label: '后台启动中',
    detail: '',
    timestamp,
    startedAt: timestamp,
    transient: true,
    source: 'local-handoff'
  };
}

export function completeLocalAbortMessages(current, payload = {}) {
  const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
  return upsertStatusMessage(
    completeActivityMessagesForTurn(current, { ...payload, completedAt }),
    {
      ...payload,
      kind: 'turn',
      status: 'completed',
      label: '已中止',
      completedAt,
      timestamp: completedAt
    }
  );
}
