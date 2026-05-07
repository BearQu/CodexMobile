import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { archiveDesktopThread, listDesktopThreads, readDesktopThread, setDesktopThreadName } from './codex-app-server.js';
import { CODEX_STATE_DB, readCodexConfig, readCodexWorkspaceState } from './codex-config.js';
import {
  readMobileSessionIndex,
  renameMobileSession
} from './mobile-session-index.js';
import {
  readDesktopCollabActivities,
  readRawSessionActivities
} from './desktop-activity-parser.js';
import {
  messagesFromDesktopThread,
  removeFallbackActivitiesCoveredByRaw,
  sortDesktopActivitySteps,
  upsertDesktopActivity
} from './desktop-thread-projector.js';

export { rawSessionActivitiesFromJsonl } from './desktop-activity-parser.js';
export { messagesFromDesktopThread } from './desktop-thread-projector.js';

const DELETED_MESSAGES_PATH = path.join(process.cwd(), '.codexmobile', 'state', 'deleted-messages.json');
const HIDDEN_SESSIONS_PATH = path.join(process.cwd(), '.codexmobile', 'state', 'hidden-sessions.json');
const PROJECTLESS_PROJECT_ID = '__codexmobile_projectless__';
const PROJECTLESS_PROJECT_NAME = '普通对话';
const INCLUDE_MISSING_SUBAGENT_THREADS = process.env.CODEXMOBILE_INCLUDE_MISSING_SUBAGENT_THREADS === '1';
const ROLLOUT_CONTEXT_READ_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CODEXMOBILE_ROLLOUT_CONTEXT_READ_BYTES) || 1024 * 1024
);
const execFileAsync = promisify(execFile);

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map()
};

function emptyDeletedMessagesState() {
  return { version: 1, sessions: {} };
}

function emptyHiddenSessionsState() {
  return { version: 1, sessions: {} };
}

async function readDeletedMessagesState() {
  try {
    const raw = await fs.readFile(DELETED_MESSAGES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read deleted message state:', error.message);
    }
    return emptyDeletedMessagesState();
  }
}

async function writeDeletedMessagesState(state) {
  await fs.mkdir(path.dirname(DELETED_MESSAGES_PATH), { recursive: true });
  await fs.writeFile(
    DELETED_MESSAGES_PATH,
    JSON.stringify({ version: 1, sessions: state.sessions || {} }, null, 2),
    'utf8'
  );
}

async function readHiddenSessionsState() {
  try {
    const raw = await fs.readFile(HIDDEN_SESSIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read hidden session state:', error.message);
    }
    return emptyHiddenSessionsState();
  }
}

async function writeHiddenSessionsState(state) {
  await fs.mkdir(path.dirname(HIDDEN_SESSIONS_PATH), { recursive: true });
  await fs.writeFile(
    HIDDEN_SESSIONS_PATH,
    JSON.stringify({ version: 1, sessions: state.sessions || {} }, null, 2),
    'utf8'
  );
}

async function readHiddenSessionIds() {
  const state = await readHiddenSessionsState();
  return new Set(Object.keys(state.sessions || {}));
}

async function hideSessionInMobile(session) {
  const id = String(session?.id || '').trim();
  if (!id) {
    const error = new Error('Session id is required');
    error.statusCode = 400;
    throw error;
  }

  const state = await readHiddenSessionsState();
  const existing = state.sessions[id];
  state.sessions[id] = {
    hiddenAt: existing?.hiddenAt || new Date().toISOString(),
    projectId: session.projectId || existing?.projectId || null,
    projectPath: session.cwd || existing?.projectPath || null,
    title: session.title || existing?.title || null
  };
  await writeHiddenSessionsState(state);
  return { sessionId: id, hiddenAt: state.sessions[id].hiddenAt };
}

async function readDeletedMessageIds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    return new Set();
  }
  const state = await readDeletedMessagesState();
  return new Set(Object.keys(state.sessions?.[id] || {}));
}

function filterDeletedMessages(messages, deletedIds) {
  if (!deletedIds.size) {
    return messages;
  }
  return messages.filter((message) => !deletedIds.has(String(message.id || '')));
}

export function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectIdFor(projectPath) {
  return crypto.createHash('sha1').update(normalizeComparablePath(projectPath)).digest('hex').slice(0, 16);
}

function documentsCodexRoot() {
  return path.join(os.homedir(), 'Documents', 'Codex');
}

function pathSegmentsUnder(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return [];
  }
  return relative.split(path.sep).filter(Boolean);
}

function isDocumentsCodexConversationPath(projectPath) {
  const segments = pathSegmentsUnder(documentsCodexRoot(), projectPath);
  return segments.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(segments[0]);
}

function displayNameFor(projectPath) {
  const parsed = path.parse(projectPath);
  return path.basename(projectPath) || parsed.root || projectPath;
}

function toPublicProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    pathLabel: entry.pathLabel || null,
    projectless: Boolean(entry.projectless),
    trusted: entry.trusted,
    updatedAt: entry.updatedAt,
    sessionCount: entry.sessionCount || 0
  };
}

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

function isArchivedOrDeletedDesktopThread(thread = null) {
  if (!thread || typeof thread !== 'object') {
    return true;
  }
  const status = String(thread.status || '').toLowerCase();
  const archivedAt = String(thread.archivedAt || thread.deletedAt || thread.archiveAt || thread.archived_at || thread.deleted_at || '').trim();
  const deletedAt = String(thread.deletedAt || thread.deleted_at || '').trim();
  const flaggedDeleted = Boolean(thread.deleted) || Boolean(thread.isDeleted) || status === 'deleted' || status === 'archived';
  const flaggedArchived = Boolean(thread.archived) || Boolean(thread.isArchived) || status === 'archived';
  return flaggedDeleted || flaggedArchived || Boolean(archivedAt) || Boolean(deletedAt);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function publicContextState(state = {}, configContext = {}) {
  const contextWindow = state.contextWindow || configContext.modelContextWindow || null;
  const inputTokens = state.inputTokens || null;
  const autoCompactLimit = configContext.autoCompactTokenLimit || null;
  const percent =
    inputTokens && contextWindow
      ? Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 1000) / 10))
      : null;
  const compactDetected = Boolean(state.autoCompactDetected);
  return {
    sessionId: state.sessionId || null,
    model: state.model || null,
    inputTokens,
    totalTokens: state.totalTokens || null,
    contextWindow,
    percent,
    lastTokenUsage: state.lastTokenUsage || null,
    totalTokenUsage: state.totalTokenUsage || null,
    updatedAt: state.updatedAt || null,
    autoCompact: {
      enabled: Boolean(autoCompactLimit || configContext.autoCompactEnabled),
      tokenLimit: autoCompactLimit,
      detected: compactDetected,
      status: compactDetected ? 'detected' : (autoCompactLimit || configContext.autoCompactEnabled) ? 'watching' : 'unknown',
      lastCompactedAt: state.autoCompactLastAt || null,
      reason: state.autoCompactReason || ''
    }
  };
}

function tokenUsageFromPayload(payload) {
  const info = payload?.info && typeof payload.info === 'object' ? payload.info : {};
  const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
  const total = info.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage : {};
  return {
    inputTokens: positiveNumber(last.input_tokens ?? total.input_tokens),
    totalTokens: positiveNumber(total.total_tokens ?? last.total_tokens),
    contextWindow: positiveNumber(info.model_context_window ?? payload?.model_context_window),
    lastTokenUsage: last,
    totalTokenUsage: total
  };
}

function applyContextEntry(state, entry, sessionId) {
  const payload = entry?.payload || {};
  const timestamp = entry?.timestamp || new Date().toISOString();
  const type = payload.type || '';

  if (entry.type === 'turn_context') {
    const summary = String(payload.summary || '').trim();
    if (summary && summary !== 'none') {
      state.autoCompactDetected = true;
      state.autoCompactLastAt = timestamp;
      state.autoCompactReason = '会话已带摘要继续';
    }
    if (payload.model) {
      state.model = payload.model;
    }
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type === 'compacted') {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文已自动压缩';
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type !== 'event_msg') {
    return;
  }

  if (type === 'task_started') {
    state.contextWindow = positiveNumber(payload.model_context_window) || state.contextWindow || null;
    state.updatedAt = timestamp;
    return;
  }

  if (type !== 'token_count') {
    return;
  }

  const usage = tokenUsageFromPayload(payload);
  const previousInputTokens = state.inputTokens;
  state.sessionId = sessionId;
  state.inputTokens = usage.inputTokens || state.inputTokens || null;
  state.totalTokens = usage.totalTokens || state.totalTokens || null;
  state.contextWindow = usage.contextWindow || state.contextWindow || null;
  state.lastTokenUsage = usage.lastTokenUsage;
  state.totalTokenUsage = usage.totalTokenUsage;
  state.updatedAt = timestamp;

  if (
    previousInputTokens &&
    usage.inputTokens &&
    previousInputTokens > 20000 &&
    usage.inputTokens < previousInputTokens * 0.62
  ) {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文用量回落';
  }
}

async function readRolloutContextState(filePath, sessionId) {
  const state = { sessionId };
  if (!filePath) {
    return state;
  }

  let start = 0;
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > ROLLOUT_CONTEXT_READ_BYTES) {
      start = stats.size - ROLLOUT_CONTEXT_READ_BYTES;
    }
  } catch {
    return state;
  }

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      try {
        applyContextEntry(state, JSON.parse(line), sessionId);
      } catch {
        // Skip malformed or partial JSONL rows.
      }
    }
  } catch {
    return state;
  }
  return state;
}

function sourceToString(source) {
  if (typeof source === 'string') {
    return source;
  }
  if (source?.custom) {
    return source.custom;
  }
  if (source?.subAgent) {
    return 'subAgent';
  }
  return 'unknown';
}

function isStaleProjectlessDesktopSession(thread, session) {
  if (sourceToString(thread?.source) !== 'vscode' || !session?.projectless) {
    return false;
  }
  if (session.projectlessRegistered || session.mobileSessionKnown) {
    return false;
  }
  const cwd = String(thread?.cwd || '').trim();
  if (cwd && !pathSegmentsUnder(documentsCodexRoot(), cwd).length) {
    return true;
  }
  if (cwd && fsSync.existsSync(cwd)) {
    return false;
  }
  const updatedAtMs = Number(thread?.updatedAt || 0) * 1000;
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  return !updatedAtMs || Date.now() - updatedAtMs > twoDaysMs;
}

async function readThreadSpawnEdges() {
  try {
    await fs.access(CODEX_STATE_DB);
    const query = `
      select
        parent_thread_id as parentSessionId,
        child_thread_id as childSessionId,
        status
      from thread_spawn_edges
    `;
    const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], {
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((edge) => edge?.parentSessionId && edge?.childSessionId)
      : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read subagent thread edges:', error.message);
    }
    return [];
  }
}

function subAgentMetaFromThread(thread, spawnEdge = null) {
  const spawn = thread?.source?.subAgent?.thread_spawn || {};
  const parentSessionId = spawn.parent_thread_id || spawnEdge?.parentSessionId || null;
  if (!parentSessionId && !thread?.source?.subAgent && !spawnEdge) {
    return { parentSessionId: null, subAgent: null };
  }
  return {
    parentSessionId,
    subAgent: {
      nickname: thread?.agentNickname || spawn.agent_nickname || null,
      role: thread?.agentRole || spawn.agent_role || null,
      depth: Number.isFinite(Number(spawn.depth)) ? Number(spawn.depth) : null,
      status: spawnEdge?.status || null
    }
  };
}

async function sessionFromDesktopThread(
  thread,
  mobileSessionIndex,
  projectlessThreadIds,
  projectlessWorkdir,
  visibleProjectIds,
  configContext = {},
  spawnEdge = null
) {
  if (!thread?.id) {
    return null;
  }
  const mobileSession = mobileSessionIndex.get(thread.id);
  const hasDesktopCwd = typeof thread.cwd === 'string' && thread.cwd.trim();
  const projectlessRegistered = projectlessThreadIds.has(thread.id);
  const explicitProjectless = !hasDesktopCwd && (projectlessRegistered || Boolean(mobileSession?.projectless));
  const cwd = thread.cwd || mobileSession?.projectPath || (explicitProjectless ? projectlessWorkdir : '');
  if (!cwd && !explicitProjectless) {
    return null;
  }
  const resolvedCwd = path.resolve(cwd || projectlessWorkdir);
  const projectId = projectIdFor(resolvedCwd);
  const projectless =
    explicitProjectless ||
    isDocumentsCodexConversationPath(resolvedCwd) ||
    !visibleProjectIds.has(projectId);
  const preview = sanitizeVisibleUserMessage(thread.preview || mobileSession?.summary || '');
  const mobileTitle = String(mobileSession?.title || '').trim();
  const mobileTitleCandidate = mobileTitle && mobileTitle !== '新对话' ? mobileTitle : '';
  const title = String(thread.name || mobileTitleCandidate || preview.slice(0, 52) || mobileTitle || '新对话').trim();
  const mobileMessages = Array.isArray(mobileSession?.messages) ? mobileSession.messages : [];
  const contextState = await readRolloutContextState(thread.path, thread.id);
  const subAgentMeta = subAgentMetaFromThread(thread, spawnEdge);
  return {
    id: thread.id,
    cwd: resolvedCwd,
    projectId: projectless ? PROJECTLESS_PROJECT_ID : projectId,
    title,
    titleLocked: Boolean(mobileSession?.titleLocked),
    titleAutoGenerated: mobileSession ? (mobileSession.titleLocked ? null : 'stored') : null,
    summary: preview || mobileSession?.summary || title || 'Codex 会话',
    model: mobileSession?.model || null,
    provider: thread.modelProvider || mobileSession?.provider || null,
    messageCount: mobileMessages.length,
    updatedAt: isoFromEpochSeconds(thread.updatedAt) || mobileSession?.updatedAt || null,
    source: sourceToString(thread.source),
    parentSessionId: subAgentMeta.parentSessionId,
    isSubAgent: Boolean(subAgentMeta.parentSessionId || subAgentMeta.subAgent),
    subAgent: subAgentMeta.subAgent,
    projectless,
    projectlessRegistered,
    mobileSessionKnown: Boolean(mobileSession),
    filePath: thread.path || null,
    context: publicContextState(contextState, configContext)
  };
}

function addSessionToMaps(session, projectById, sessionsByProject, sessionById) {
  const project = projectById.get(session.projectId);
  if (!project) {
    return false;
  }
  if (!sessionsByProject.has(project.id)) {
    sessionsByProject.set(project.id, []);
  }
  sessionsByProject.get(project.id).push(session);
  sessionById.set(session.id, session);
  return true;
}

function projectlessWorkingDirectory(workspaceState) {
  const hints = workspaceState?.threadWorkspaceRootHints || {};
  const projectlessIds = new Set(workspaceState?.projectlessThreadIds || []);
  const counts = new Map();
  for (const [threadId, root] of Object.entries(hints)) {
    if (!projectlessIds.has(threadId) || typeof root !== 'string' || !root.trim()) {
      continue;
    }
    const resolved = path.resolve(root);
    counts.set(resolved, (counts.get(resolved) || 0) + 1);
  }
  const [mostUsedHint] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (mostUsedHint) {
    return mostUsedHint;
  }
  const documentsCodex = documentsCodexRoot();
  return fsSync.existsSync(documentsCodex) ? documentsCodex : os.homedir();
}

function upsertProjectlessProject(projectMap, workspaceState) {
  const workdir = projectlessWorkingDirectory(workspaceState);
  const existing = projectMap.get(PROJECTLESS_PROJECT_ID);
  if (existing) {
    existing.path = workdir;
    return existing;
  }
  const entry = {
    id: PROJECTLESS_PROJECT_ID,
    name: PROJECTLESS_PROJECT_NAME,
    path: workdir,
    pathLabel: '无项目分类',
    projectless: true,
    trusted: true,
    updatedAt: null,
    sessionCount: 0
  };
  projectMap.set(PROJECTLESS_PROJECT_ID, entry);
  return entry;
}

function upsertProject(projectMap, projectPath, trustLevel = null, label = null) {
  const normalized = normalizeComparablePath(projectPath);
  if (!normalized) {
    return null;
  }
  const id = projectIdFor(projectPath);
  const existing = projectMap.get(id);
  if (existing) {
    if (trustLevel) {
      existing.trusted = trustLevel === 'trusted';
    }
    if (label) {
      existing.name = label;
    }
    return existing;
  }
  const entry = {
    id,
    name: label || displayNameFor(projectPath),
    path: path.resolve(projectPath),
    trusted: trustLevel === 'trusted',
    updatedAt: null,
    sessionCount: 0
  };
  projectMap.set(id, entry);
  return entry;
}

export async function refreshCodexCache() {
  const config = await readCodexConfig();
  const workspaceState = await readCodexWorkspaceState();
  const mobileSessionIndex = await readMobileSessionIndex();
  const hiddenSessionIds = await readHiddenSessionIds();
  const projectById = new Map();
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const visibleProjects = workspaceState.projects.length
    ? workspaceState.projects.map((project) => ({
      path: project.path,
      trustLevel: config.projects.find(
        (entry) => normalizeComparablePath(entry.path) === normalizeComparablePath(project.path)
      )?.trustLevel || 'trusted',
      label: project.label
    }))
    : config.projects.map((project) => ({ ...project, label: null }));
  const visibleProjectIds = new Set();
  const projectlessThreadIds = new Set(workspaceState.projectlessThreadIds || []);
  const projectlessWorkdir = projectlessWorkingDirectory(workspaceState);
  const hasProjectlessSessions = projectlessThreadIds.size > 0;
  const spawnEdges = INCLUDE_MISSING_SUBAGENT_THREADS ? await readThreadSpawnEdges() : [];
  const spawnEdgeByChildId = new Map(spawnEdges.map((edge) => [edge.childSessionId, edge]));

  for (const project of visibleProjects) {
    const entry = upsertProject(projectById, project.path, project.trustLevel, project.label);
    if (entry) {
      visibleProjectIds.add(entry.id);
    }
  }
  if (hasProjectlessSessions) {
    upsertProjectlessProject(projectById, workspaceState);
    visibleProjectIds.add(PROJECTLESS_PROJECT_ID);
  }

  const desktopThreads = await listDesktopThreads({ limit: 1000 });
  for (const thread of desktopThreads) {
    if (isArchivedOrDeletedDesktopThread(thread)) {
      continue;
    }
    const session = await sessionFromDesktopThread(
      thread,
      mobileSessionIndex,
      projectlessThreadIds,
      projectlessWorkdir,
      visibleProjectIds,
      config.context || {},
      spawnEdgeByChildId.get(thread.id) || null
    );
    if (isStaleProjectlessDesktopSession(thread, session)) {
      continue;
    }
    if (!session || hiddenSessionIds.has(session.id)) {
      continue;
    }
    if (session.projectless) {
      upsertProjectlessProject(projectById, workspaceState);
      visibleProjectIds.add(PROJECTLESS_PROJECT_ID);
    } else if (!visibleProjectIds.has(session.projectId)) {
      continue;
    }
    addSessionToMaps(session, projectById, sessionsByProject, sessionById);
  }

  for (const edge of spawnEdges) {
    if (hiddenSessionIds.has(edge.childSessionId)) {
      continue;
    }
    const existing = sessionById.get(edge.childSessionId);
    if (!existing) {
      continue;
    }
    existing.parentSessionId = existing.parentSessionId || edge.parentSessionId;
    existing.isSubAgent = true;
    existing.subAgent = {
      ...(existing.subAgent || {}),
      status: existing.subAgent?.status || edge.status || null
    };
  }

  if (INCLUDE_MISSING_SUBAGENT_THREADS) {
    for (const edge of spawnEdges) {
      if (hiddenSessionIds.has(edge.childSessionId) || sessionById.has(edge.childSessionId)) {
        continue;
      }
      let childThread = null;
      try {
        childThread = (await readDesktopThread(edge.childSessionId, { includeTurns: false }))?.thread || null;
      } catch {
        continue;
      }
      if (isArchivedOrDeletedDesktopThread(childThread)) {
        continue;
      }
      const childSession = await sessionFromDesktopThread(
        childThread,
        mobileSessionIndex,
        projectlessThreadIds,
        projectlessWorkdir,
        visibleProjectIds,
        config.context || {},
        edge
      );
      if (isStaleProjectlessDesktopSession(childThread, childSession)) {
        continue;
      }
      if (!childSession || hiddenSessionIds.has(childSession.id)) {
        continue;
      }
      if (childSession.projectless) {
        upsertProjectlessProject(projectById, workspaceState);
        visibleProjectIds.add(PROJECTLESS_PROJECT_ID);
      } else if (!visibleProjectIds.has(childSession.projectId)) {
        continue;
      }
      addSessionToMaps(childSession, projectById, sessionsByProject, sessionById);
    }
  }

  for (const [projectId, sessions] of sessionsByProject.entries()) {
    sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const project = projectById.get(projectId);
    if (project) {
      const sessionIds = new Set(sessions.map((session) => session.id));
      project.sessionCount = sessions.filter(
        (session) => !session.parentSessionId || !sessionIds.has(session.parentSessionId)
      ).length;
      project.updatedAt = sessions[0]?.updatedAt || project.updatedAt;
    }
  }

  for (const session of sessionById.values()) {
    session.childCount = 0;
    session.openChildCount = 0;
  }
  for (const session of sessionById.values()) {
    if (!session.parentSessionId) {
      continue;
    }
    const parent = sessionById.get(session.parentSessionId);
    if (!parent) {
      continue;
    }
    parent.childCount = (parent.childCount || 0) + 1;
    if (session.subAgent?.status === 'open') {
      parent.openChildCount = (parent.openChildCount || 0) + 1;
    }
  }

  const projectOrder = new Map(visibleProjects.map((project, index) => [projectIdFor(project.path), index]));
  const projects = [...projectById.values()].sort((a, b) => {
    if (a.projectless !== b.projectless) {
      return a.projectless ? -1 : 1;
    }
    const orderA = projectOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = projectOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  cache = {
    syncedAt: new Date().toISOString(),
    config,
    projects,
    projectById,
    sessionsByProject,
    sessionById
  };

  return getCacheSnapshot();
}

export function getCacheSnapshot() {
  return {
    syncedAt: cache.syncedAt,
    config: cache.config,
    projects: cache.projects.map(toPublicProject)
  };
}

export function listProjects() {
  return cache.projects.map(toPublicProject);
}

export function getProject(projectId) {
  return cache.projectById.get(projectId) || null;
}

export function listProjectSessions(projectId) {
  return (cache.sessionsByProject.get(projectId) || []).map((session) => ({
    id: session.id,
    projectId: session.projectId,
    cwd: session.cwd,
    title: session.title,
    summary: session.summary,
    model: session.model,
    provider: session.provider,
    source: session.source,
    parentSessionId: session.parentSessionId || null,
    isSubAgent: Boolean(session.isSubAgent),
    subAgent: session.subAgent || null,
    childCount: session.childCount || 0,
    openChildCount: session.openChildCount || 0,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    context: session.context || null
  }));
}

export function getSession(sessionId) {
  return cache.sessionById.get(sessionId) || null;
}

export async function renameSession(sessionId, projectId, title, { auto = false } = {}) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!nextTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  if (!session.mobileOnly) {
    await setDesktopThreadName(session.id, nextTitle);
  }
  await renameMobileSession({
    id: session.id,
    projectPath: session.cwd,
    projectless: session.projectless,
    title: nextTitle,
    titleLocked: !auto,
    updatedAt: session.updatedAt
  });

  return { ...session, title: nextTitle, titleLocked: !auto };
}

export async function deleteSession(sessionId, projectId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  let archivedDesktopThread = false;
  if (!session.mobileOnly) {
    await archiveDesktopThread(session.id);
    archivedDesktopThread = true;
  }

  const hidden = await hideSessionInMobile(session);

  return {
    deletedSessionId: sessionId,
    projectId: session.projectId,
    hiddenOnly: !archivedDesktopThread,
    archivedDesktopThread,
    hiddenAt: hidden.hiddenAt,
    deletedFile: false,
    deletedIndexRows: false,
    deletedMobileRecord: false
  };
}

export async function hideSessionMessage(sessionId, messageId) {
  const id = String(sessionId || '').trim();
  const itemId = String(messageId || '').trim();
  if (!id || !itemId) {
    const error = new Error('sessionId and messageId are required');
    error.statusCode = 400;
    throw error;
  }

  const state = await readDeletedMessagesState();
  if (!state.sessions[id] || typeof state.sessions[id] !== 'object' || Array.isArray(state.sessions[id])) {
    state.sessions[id] = {};
  }
  const existing = state.sessions[id][itemId];
  const deletedAt = existing?.deletedAt || new Date().toISOString();
  state.sessions[id][itemId] = { deletedAt };
  await writeDeletedMessagesState(state);
  return { sessionId: id, messageId: itemId, deletedAt };
}

function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

function isoFromEpochSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

export async function readSessionMessages(sessionId, { limit = 120, offset = null, latest = true, includeActivity = false } = {}) {
  const deletedIds = await readDeletedMessageIds(sessionId);

  const response = await readDesktopThread(sessionId, { includeTurns: true });
  if (!response?.thread) {
    const error = new Error('Desktop thread not found');
    error.statusCode = 404;
    throw error;
  }
  const messages = messagesFromDesktopThread(response.thread, { includeActivity });
  if (includeActivity) {
    const rawActivities = await readRawSessionActivities(response.thread.path, response.thread.turns || []);
    removeFallbackActivitiesCoveredByRaw(messages, rawActivities);
    for (const item of rawActivities) {
      upsertDesktopActivity(messages, item.turnId, item.activity);
    }
    const collabActivities = await readDesktopCollabActivities(response.thread.path);
    for (const item of collabActivities) {
      upsertDesktopActivity(messages, item.turnId, item.activity);
    }
    sortDesktopActivitySteps(messages);
  }
  messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  const contextState = await readRolloutContextState(response.thread.path, sessionId);

  return {
    ...paginateMessages(filterDeletedMessages(messages, deletedIds), { limit, offset, latest }),
    context: publicContextState(contextState, cache.config?.context || {})
  };
}

export function getHostName() {
  return os.hostname();
}
