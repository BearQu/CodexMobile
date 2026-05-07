import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { imageMarkdownFromCodexImageGeneration } from './codex-native-images.js';
import { statusLabel } from './codex-runner.js';

const DESKTOP_IMAGE_ROOT = path.join(process.cwd(), '.codexmobile', 'desktop-images');
const INTERNAL_PROMPT_MARKERS = [
  'CodexMobile iOS/PWA 回复要求：',
  'CodexMobile 已接入飞书官方 lark-cli。',
  'CodexMobile 已接入飞书官方 lark-cli'
];

function sanitizeVisibleUserMessage(message) {
  const value = String(message || '').trim();
  if (!value) {
    return '';
  }
  let cutAt = value.length;
  for (const marker of INTERNAL_PROMPT_MARKERS) {
    const index = value.indexOf(marker);
    if (index > 0) {
      cutAt = Math.min(cutAt, index);
    }
  }
  return value.slice(0, cutAt).trim() || value;
}

function diffStats(unifiedDiff = '') {
  let additions = 0;
  let deletions = 0;
  for (const line of String(unifiedDiff || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function normalizePatchChanges(changes) {
  if (Array.isArray(changes)) {
    return changes.map((change) => {
      const diff = change?.unified_diff || change?.diff || '';
      const stats = diffStats(diff);
      return {
        ...change,
        additions: Number(change?.additions) || stats.additions,
        deletions: Number(change?.deletions) || stats.deletions,
        unifiedDiff: diff,
        movePath: change?.move_path || change?.movePath || null
      };
    });
  }
  if (!changes || typeof changes !== 'object') {
    return [];
  }
  return Object.entries(changes).map(([filePath, change]) => {
    const stats = diffStats(change?.unified_diff || change?.diff || '');
    return {
      path: filePath,
      kind: change?.type || change?.kind || 'update',
      additions: Number(change?.additions) || stats.additions,
      deletions: Number(change?.deletions) || stats.deletions,
      unifiedDiff: change?.unified_diff || change?.diff || '',
      movePath: change?.move_path || null
    };
  });
}

function upsertMessage(messages, message) {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    messages[index] = { ...messages[index], ...message };
    return;
  }
  messages.push(message);
}

function desktopActivityMessageId(turnId, segmentIndex = 0) {
  return segmentIndex > 0 ? `activity-${turnId}-${segmentIndex}` : `activity-${turnId}`;
}

export function upsertDesktopActivity(messages, turnId, activity, segmentIndex = 0) {
  if (!activity) {
    return;
  }
  const id = desktopActivityMessageId(turnId, segmentIndex);
  const existing = messages.find((message) => message.id === id);
  if (existing) {
    const current = Array.isArray(existing.activities) ? existing.activities : [];
    if (activity.kind === 'context_compaction' && current.some((item) => item.kind === 'context_compaction')) {
      return;
    }
    const activityIndex = current.findIndex((item) => item.id === activity.id);
    if (activityIndex >= 0) {
      const nextActivities = [...current];
      const previous = nextActivities[activityIndex];
      nextActivities[activityIndex] = {
        ...activity,
        ...previous,
        timestamp: activity.timestamp || previous.timestamp,
        sequence: Number.isFinite(Number(activity.sequence)) ? activity.sequence : previous.sequence,
        status: activity.status || previous.status,
        label: previous.label || activity.label
      };
      existing.activities = nextActivities;
    } else {
      existing.activities = [...current, activity];
    }
    existing.timestamp = activity.timestamp || existing.timestamp;
    return;
  }
  messages.push({
    id,
    role: 'activity',
    turnId,
    segmentIndex,
    content: '正在处理',
    label: '正在处理',
    kind: 'desktop',
    status: 'running',
    timestamp: activity.timestamp || new Date().toISOString(),
    startedAt: activity.startedAt || activity.timestamp || null,
    activities: [activity]
  });
}

export function removeFallbackActivitiesCoveredByRaw(messages, rawActivities) {
  const covered = new Map();
  for (const item of rawActivities || []) {
    const turnId = item?.turnId;
    const kind = item?.activity?.kind;
    if (!turnId || !kind || kind === 'file_change') {
      continue;
    }
    if (!covered.has(turnId)) {
      covered.set(turnId, new Set());
    }
    covered.get(turnId).add(kind);
  }
  if (!covered.size) {
    return;
  }
  for (const message of messages) {
    if (message?.role !== 'activity' || !covered.has(message.turnId) || !Array.isArray(message.activities)) {
      continue;
    }
    const kinds = covered.get(message.turnId);
    message.activities = message.activities.filter((activity) => {
      if (!kinds.has(activity?.kind)) {
        return true;
      }
      return String(activity?.id || '').includes('-raw-');
    });
  }
}

function activityOrderValue(activity) {
  const sequence = Number(activity?.sequence);
  if (Number.isFinite(sequence)) {
    return sequence;
  }
  const timestamp = Date.parse(activity?.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function sortDesktopActivitySteps(messages) {
  for (const message of messages) {
    if (message?.role !== 'activity' || !Array.isArray(message.activities)) {
      continue;
    }
    message.activities = [...message.activities].sort((a, b) => activityOrderValue(a) - activityOrderValue(b));
  }
}

function normalizedActivityText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isoFromEpochSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function completeDesktopActivity(messages, turnId, finalContent = '', metadata = {}, status = 'completed', segmentIndex = 0) {
  const id = desktopActivityMessageId(turnId, segmentIndex);
  let item = messages.find((message) => message.id === id);
  if (!item) {
    item = {
      id,
      role: 'activity',
      turnId,
      segmentIndex,
      content: '正在处理',
      label: '正在处理',
      kind: 'desktop',
      status: 'running',
      timestamp: metadata.completedAt || new Date().toISOString(),
      startedAt: metadata.startedAt || null,
      activities: []
    };
    messages.push(item);
  }
  const normalizedFinal = normalizedActivityText(finalContent);
  if (normalizedFinal && Array.isArray(item.activities)) {
    item.activities = item.activities.filter((activity) => {
      if (!['agent_message', 'message'].includes(activity?.kind)) {
        return true;
      }
      return normalizedActivityText(activity.label || activity.content || activity.detail) !== normalizedFinal;
    });
  }
  item.status = status;
  item.label = status === 'failed' ? '过程已中止' : '过程已同步';
  item.content = item.label;
  item.startedAt = metadata.startedAt || item.startedAt || null;
  item.completedAt = metadata.completedAt || item.completedAt || null;
  item.durationMs = metadata.durationMs || item.durationMs || null;
}

function completeExistingDesktopActivity(messages, turnId, finalContent = '', metadata = {}, status = 'completed', segmentIndex = 0) {
  const item = messages.find((message) => message.id === desktopActivityMessageId(turnId, segmentIndex));
  if (!item || item.status !== 'running') {
    return;
  }
  completeDesktopActivity(messages, turnId, finalContent, metadata, status, segmentIndex);
}

function markdownImageDestination(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/[\s<>()]/.test(raw)) {
    return `<${raw.replace(/>/g, '%3E')}>`;
  }
  return raw;
}

function localizeDesktopDataImageUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) {
    return raw;
  }

  const type = match[1].toLowerCase();
  const extension = type === 'jpeg' ? 'jpg' : type;
  if (!['png', 'jpg', 'webp', 'gif'].includes(extension)) {
    return raw;
  }

  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) {
    return raw;
  }

  try {
    const digest = crypto.createHash('sha256').update(base64).digest('hex');
    const filePath = path.join(DESKTOP_IMAGE_ROOT, `${digest}.${extension}`);
    if (!fsSync.existsSync(filePath)) {
      fsSync.mkdirSync(DESKTOP_IMAGE_ROOT, { recursive: true });
      fsSync.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    }
    return filePath;
  } catch (error) {
    console.warn('[sessions] Failed to cache desktop data image:', error.message);
    return raw;
  }
}

function markdownImageInput(part) {
  const source = localizeDesktopDataImageUrl(part?.path || part?.url);
  if (!source) {
    return '[图片]';
  }
  const alt = String(part?.alt || '图片').replace(/[\[\]\n\r]/g, '').trim() || '图片';
  return `![${alt}](${markdownImageDestination(source)})`;
}

function textFromDesktopUserInput(content = []) {
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      if (part?.type === 'text') {
        return part.text || '';
      }
      if (part?.type === 'localImage') {
        return markdownImageInput(part);
      }
      if (part?.type === 'image') {
        return markdownImageInput(part);
      }
      if (part?.type === 'mention' || part?.type === 'skill') {
        return part.name || part.path || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function hasFinalDesktopAssistantMessage(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).some(
    (item) => item?.type === 'agentMessage' && item.phase === 'final_answer' && String(item.text || '').trim()
  );
}

function desktopTurnRuntimeStatus(turn, { isLatestTurn = false } = {}) {
  const value = String(turn?.status || '').toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(value)) {
    return 'completed';
  }
  if (value === 'interrupted' && !turn?.completedAt && isLatestTurn && !hasFinalDesktopAssistantMessage(turn)) {
    return 'running';
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(value)) {
    return 'failed';
  }
  if (turn?.completedAt) {
    return 'completed';
  }
  return 'running';
}

function normalizedDesktopItemStatus(status, fallback = 'running') {
  const value = String(status || '').toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(value)) {
    return 'completed';
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(value)) {
    return 'failed';
  }
  return fallback;
}

function desktopActivityLabel(status, labels) {
  if (status === 'running') {
    return labels.running;
  }
  if (status === 'failed') {
    return labels.failed;
  }
  return labels.completed;
}

function desktopMobileStatusLabel(kind, status) {
  return statusLabel(kind, status);
}

function desktopActivityFallbackStatus(turnStatus) {
  return turnStatus === 'running' ? 'running' : turnStatus === 'failed' ? 'failed' : 'completed';
}

function desktopActivityFromThreadItem(item, turnId, index, timestamp, turnStatus = 'completed') {
  if (!item || item.type === 'userMessage') {
    return null;
  }
  const fallbackStatus = desktopActivityFallbackStatus(turnStatus);
  if (item.type === 'agentMessage') {
    if (item.phase !== 'commentary') {
      return null;
    }
    const content = String(item.text || '').trim();
    if (!content) {
      return null;
    }
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-commentary-${item.id || index}`,
      kind: 'agent_message',
      label: content,
      content,
      status,
      detail: '',
      timestamp
    };
  }
  if (item.type === 'reasoning') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-reasoning-${item.id || index}`,
      kind: 'reasoning',
      label: desktopActivityLabel(status, { running: '正在思考', completed: '思考完成', failed: '思考中止' }),
      status,
      detail: [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n'),
      timestamp
    };
  }
  if (item.type === 'plan') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-plan-${item.id || index}`,
      kind: 'plan',
      label: desktopActivityLabel(status, { running: '正在更新计划', completed: '计划已更新', failed: '计划更新中止' }),
      status,
      detail: item.text || '',
      timestamp
    };
  }
  if (item.type === 'commandExecution') {
    const status = normalizedDesktopItemStatus(item.status, item.exitCode ? 'failed' : fallbackStatus);
    return {
      id: `${turnId}-command-${item.id || index}`,
      kind: 'command_execution',
      label: desktopMobileStatusLabel('command_execution', status),
      status,
      detail: item.command || '',
      command: item.command || '',
      output: item.aggregatedOutput || '',
      exitCode: item.exitCode ?? item.exit_code ?? null,
      timestamp
    };
  }
  if (item.type === 'fileChange') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-file-change-${item.id || index}`,
      kind: 'file_change',
      label: desktopMobileStatusLabel('file_change', status),
      status,
      detail: '',
      fileChanges: normalizePatchChanges(item.changes),
      timestamp
    };
  }
  if (item.type === 'mcpToolCall') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-mcp-${item.id || index}`,
      kind: 'mcp_tool_call',
      label: desktopMobileStatusLabel('mcp_tool_call', status),
      status,
      detail: [item.server, item.tool].filter(Boolean).join(' / '),
      toolName: item.tool || '',
      error: item.error?.message || '',
      timestamp
    };
  }
  if (item.type === 'dynamicToolCall') {
    const status = item.success === false ? 'failed' : normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-tool-${item.id || index}`,
      kind: 'dynamic_tool_call',
      label: desktopMobileStatusLabel('dynamic_tool_call', status),
      status,
      detail: item.tool || '',
      toolName: item.tool || '',
      timestamp
    };
  }
  if (item.type === 'webSearch') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-web-search-${item.id || index}`,
      kind: 'web_search',
      label: desktopMobileStatusLabel('web_search', status),
      status,
      detail: item.query || item.action?.query || '',
      timestamp
    };
  }
  if (item.type === 'imageGeneration') {
    const status = item.status === 'failed' ? 'failed' : normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-image-${item.id || index}`,
      kind: 'image_generation_call',
      label: desktopActivityLabel(status, { running: '正在生成图片', completed: '图片生成完成', failed: '图片生成失败' }),
      status,
      detail: item.revisedPrompt || item.result || '',
      timestamp
    };
  }
  if (item.type === 'contextCompaction') {
    const status = normalizedDesktopItemStatus(item.status, fallbackStatus);
    return {
      id: `${turnId}-context-compaction-${item.id || index}`,
      kind: 'context_compaction',
      label: desktopActivityLabel(status, { running: '正在自动压缩上下文', completed: '上下文已自动压缩', failed: '上下文压缩中止' }),
      status,
      detail: '',
      timestamp
    };
  }
  return null;
}

export function messagesFromDesktopThread(thread, { includeActivity = false } = {}) {
  const messages = [];
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  turns.forEach((turn, turnIndex) => {
    const turnId = turn.id || `${thread.id}-desktop-${turnIndex + 1}`;
    const startedAt = isoFromEpochSeconds(turn.startedAt) || new Date().toISOString();
    const turnStatus = desktopTurnRuntimeStatus(turn, { isLatestTurn: turnIndex === turns.length - 1 });
    const completedAt = isoFromEpochSeconds(turn.completedAt) || (turnStatus === 'running' ? null : startedAt);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const lastUserItemIndex = items.reduce((latest, item, index) => (item?.type === 'userMessage' ? index : latest), -1);
    let segmentIndex = -1;
    let finalAssistantText = '';

    function completeCurrentSegment(status = 'completed', metadata = {}) {
      if (!includeActivity || segmentIndex < 0) {
        return;
      }
      completeExistingDesktopActivity(messages, turnId, finalAssistantText, {
        startedAt,
        completedAt: metadata.completedAt || completedAt || startedAt,
        durationMs: metadata.durationMs || null
      }, status, segmentIndex);
      finalAssistantText = '';
    }

    items.forEach((item, itemIndex) => {
      const timestamp = item.type === 'agentMessage' ? completedAt || startedAt : startedAt;
      if (item.type === 'userMessage') {
        completeCurrentSegment('completed', { completedAt: timestamp });
        segmentIndex += 1;
        finalAssistantText = '';
        const content = textFromDesktopUserInput(item.content);
        if (content) {
          messages.push({
            id: item.id || `${turnId}-user-${itemIndex}`,
            role: 'user',
            content: sanitizeVisibleUserMessage(content),
            timestamp,
            turnId,
            sessionId: thread.id
          });
        }
        return;
      }
      if (includeActivity) {
        if (segmentIndex < 0) {
          segmentIndex = 0;
        }
        const segmentStatus = itemIndex > lastUserItemIndex ? turnStatus : 'completed';
        upsertDesktopActivity(
          messages,
          turnId,
          desktopActivityFromThreadItem(item, turnId, itemIndex, timestamp, segmentStatus),
          segmentIndex
        );
      }
      if (item.type === 'agentMessage' && item.phase !== 'commentary') {
        const content = String(item.text || '').trim();
        if (content) {
          finalAssistantText = content;
          upsertMessage(messages, {
            id: item.id || `${turnId}-assistant`,
            role: 'assistant',
            content,
            timestamp,
            turnId,
            sessionId: thread.id
          });
        }
      }
      if (item.type === 'imageGeneration') {
        const content = imageMarkdownFromCodexImageGeneration(item);
        if (content) {
          finalAssistantText = content;
          upsertMessage(messages, {
            id: `${turnId}-image-result-${item.id || itemIndex}`,
            role: 'assistant',
            content,
            timestamp,
            turnId,
            sessionId: thread.id
          });
        }
      }
    });

    if (includeActivity && turnStatus !== 'running') {
      completeCurrentSegment(turnStatus === 'failed' ? 'failed' : 'completed', {
        startedAt,
        completedAt: completedAt || startedAt,
        durationMs: turn.durationMs || null
      });
    }
  });

  return messages;
}
