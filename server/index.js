import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  extractBearerToken,
  getPairingCode,
  getTrustedDeviceCount,
  initializeAuth,
  pairDevice,
  verifyToken
} from './auth.js';
import {
  deleteSession,
  getCacheSnapshot,
  getHostName,
  getProject,
  getSession,
  hideSessionMessage,
  listProjectSessions,
  listProjects,
  readSessionMessages,
  rememberLiveSession,
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { getCodexQuota } from './codex-quota.js';
import { readCodexConfig } from './codex-config.js';
import { getDesktopBridgeStatus } from './codex-app-server.js';
import { createChatRouteHandler } from './chat-routes.js';
import { createFeishuIntegration } from './feishu-routes.js';
import { createFileRouteHandler } from './file-routes.js';
import { createGitRouteHandler } from './git-routes.js';
import { createGitService } from './git-service.js';
import { createNotificationRouteHandler } from './notification-routes.js';
import { createSessionRouteHandler } from './session-routes.js';
import { createVoiceRouteHandler } from './voice-routes.js';
import { abortCodexTurn, getActiveRuns, runCodexTurn, steerCodexTurn } from './codex-runner.js';
import {
  interruptDesktopFollowerTurn,
  setDesktopFollowerCollaborationMode,
  setDesktopFollowerModelAndReasoning,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn
} from './desktop-ipc-client.js';
import { GENERATED_ROOT, isImageRequest, runImageTurn } from './image-generator.js';
import { useLegacyImageGenerator } from './codex-native-images.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { publicVoiceTranscriptionStatus } from './voice-transcriber.js';
import { publicVoiceSpeechStatus } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';
import { maybeAutoNameSession } from './session-title-generator.js';
import { createChatService } from './chat-service.js';
import { readBody, sendJson } from './http-utils.js';
import { createPushService } from './push-service.js';
import { createStaticService } from './static-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const UPLOAD_ROOT = path.join(ROOT_DIR, '.codexmobile', 'uploads');
const IMAGE_PROMPT_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'image-prompts.json');
const FEISHU_AUTH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'feishu-auth.json');
const PUSH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'push-notifications.json');
const PORT = Number(process.env.PORT || 3321);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'server.pfx');
const HTTPS_ROOT_CA_PATH = process.env.HTTPS_ROOT_CA_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'codexmobile-root-ca.cer');
const HTTPS_PFX_PASSPHRASE = process.env.HTTPS_PFX_PASSPHRASE || 'codexmobile-local-https';
const PUBLIC_URL = process.env.CODEXMOBILE_PUBLIC_URL || '';
const FEISHU_APP_ID = String(process.env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
const FEISHU_APP_SECRET = String(process.env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
const FEISHU_REDIRECT_URI = String(process.env.CODEXMOBILE_FEISHU_REDIRECT_URI || '').trim();
const FEISHU_DOCS_HOME_URL = process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/';
const PUSH_SUBJECT = String(process.env.CODEXMOBILE_PUSH_SUBJECT || PUBLIC_URL || 'mailto:codexmobile@localhost').trim();
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const SYNC_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.CODEXMOBILE_SYNC_RESPONSE_TIMEOUT_MS) || 12_000);
const SYNC_CACHE_TTL_MS = Math.max(0, Number(process.env.CODEXMOBILE_SYNC_CACHE_TTL_MS) || 45_000);
let syncRefreshPromise = null;

const sockets = new Set();
const staticService = createStaticService({
  clientDist: CLIENT_DIST,
  generatedRoot: GENERATED_ROOT,
  httpsRootCaPath: HTTPS_ROOT_CA_PATH
});
const gitService = createGitService({ getProject });
const pushService = createPushService({
  statePath: PUSH_STATE,
  subject: PUSH_SUBJECT
});
const feishuIntegration = createFeishuIntegration({
  statePath: FEISHU_AUTH_STATE,
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  redirectUri: FEISHU_REDIRECT_URI,
  publicUrl: PUBLIC_URL,
  docsHomeUrl: FEISHU_DOCS_HOME_URL,
  getLarkDocsStatus,
  startLarkCliAuth,
  logoutLarkCli,
  requestOrigin,
  remoteAddress
});
let statusConfigFallback = null;

async function getStatusConfigFallback() {
  if (!statusConfigFallback) {
    statusConfigFallback = readCodexConfig().catch((error) => {
      console.warn('[server] Failed to read status config fallback:', error.message);
      statusConfigFallback = null;
      return null;
    });
  }
  return statusConfigFallback;
}
function fallbackModels(config) {
  const model = config.model || 'gpt-5.5';
  return [{ value: model, label: model }];
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function remoteAddress(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

async function isAuthenticated(req, url = null) {
  return verifyToken(extractBearerToken(req, url), { remoteAddress: remoteAddress(req) });
}

async function requireAuth(req, res, pathname = '', url = null) {
  if (await isAuthenticated(req, url)) {
    return true;
  }
  if ((req.method || 'GET') !== 'GET') {
    console.warn(`[auth] rejected ${req.method || 'GET'} ${pathname || req.url || ''} remote=${remoteAddress(req)}`);
  }
  sendJson(res, 401, { error: 'Pairing required' });
  return false;
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
  pushService.notifyForPayload(payload).catch((error) => {
    console.warn('[push] Notification dispatch failed:', error.message);
  });
}

const chatService = createChatService({
  imagePromptState: IMAGE_PROMPT_STATE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus,
  listProjectSessions,
  readSessionMessages,
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  setDesktopFollowerModelAndReasoning,
  setDesktopFollowerCollaborationMode,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  abortCodexTurn,
  getActiveRuns,
  steerCodexTurn,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  rememberLiveSession
});
const handleNotificationApi = createNotificationRouteHandler({
  pushService,
  remoteAddress
});
const handleSessionApi = createSessionRouteHandler({
  listProjects,
  getProject,
  getSession,
  listProjectSessions,
  renameSession,
  deleteSession,
  hideSessionMessage,
  readSessionMessages,
  refreshCodexCache,
  broadcast,
  chatService
});
const handleGitApi = createGitRouteHandler({ gitService });
const handleFileApi = createFileRouteHandler({
  getProject,
  staticService,
  uploadRoot: UPLOAD_ROOT,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  remoteAddress
});
const handleVoiceApi = createVoiceRouteHandler({
  getCacheSnapshot,
  maxVoiceBytes: MAX_VOICE_BYTES,
  remoteAddress
});
const handleChatApi = createChatRouteHandler({
  chatService,
  remoteAddress
});

function startSyncRefresh() {
  if (!syncRefreshPromise) {
    syncRefreshPromise = refreshCodexCache().finally(() => {
      syncRefreshPromise = null;
    });
  }
  return syncRefreshPromise;
}

function cachedSyncSnapshotIsFresh(snapshot = getCacheSnapshot()) {
  if (!SYNC_CACHE_TTL_MS || !snapshot.syncedAt) {
    return false;
  }
  const syncedAt = Date.parse(snapshot.syncedAt);
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < SYNC_CACHE_TTL_MS;
}

async function refreshCodexCacheForSyncResponse({ force = false } = {}) {
  const currentSnapshot = getCacheSnapshot();
  if (!force && cachedSyncSnapshotIsFresh(currentSnapshot)) {
    return { timedOut: false, snapshot: currentSnapshot, fromCache: true };
  }
  const refresh = startSyncRefresh();
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true, snapshot: getCacheSnapshot() });
    }, SYNC_RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  const result = await Promise.race([
    refresh
      .then((snapshot) => ({ timedOut: false, snapshot }))
      .catch((error) => ({ timedOut: false, snapshot: getCacheSnapshot(), error })),
    timeout
  ]);
  if (result.error) {
    console.warn('[sync] Refresh failed:', result.error.message);
  }
  if (result.timedOut) {
    refresh
      .then((snapshot) => {
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      })
      .catch((error) => {
        console.warn('[sync] Background refresh failed:', error.message);
      });
  }
  return result;
}

async function publicStatus(authenticated) {
  const snapshot = getCacheSnapshot();
  const config = snapshot.config || await getStatusConfigFallback() || {};
  const desktopBridge = await getDesktopBridgeStatus();
  return {
    connected: true,
    desktopBridge,
    hostName: getHostName(),
    port: PORT,
    provider: config.provider || 'codex',
    model: config.model || 'gpt-5.5',
    modelShort: config.modelShort || '5.5 中',
    models: config.models?.length ? config.models : fallbackModels(config),
    skills: Array.isArray(config.skills) ? config.skills : [],
    context: config.context || null,
    reasoningEffort: config.reasoningEffort || DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await feishuIntegration.publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns: [...getActiveRuns(), ...chatService.getActiveDesktopIpcRuns(), ...chatService.getActiveImageRuns()],
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount()
    }
  };
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, await publicStatus(await isAuthenticated(req, url)));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req);
    const paired = await pairDevice({
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req)
    });
    if (!paired) {
      sendJson(res, 403, { error: 'Invalid pairing code' });
      return;
    }
    sendJson(res, 200, paired);
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await feishuIntegration.handleCallback(req, res, url);
    return;
  }

  if (!(await requireAuth(req, res, pathname, url))) {
    return;
  }

  if (method === 'POST' && pathname === '/api/sync') {
    const force = url.searchParams.get('force') === '1';
    const result = await refreshCodexCacheForSyncResponse({ force });
    const { snapshot, timedOut } = result;
    if (!timedOut && !result.fromCache) {
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    }
    sendJson(res, 200, { success: !timedOut && !result.error, pending: timedOut, cached: Boolean(result.fromCache), error: result.error?.message || null, ...snapshot });
    return;
  }

  if (await handleNotificationApi(req, res, url)) {
    return;
  }

  if (await handleSessionApi(req, res, url)) {
    return;
  }

  if (await handleGitApi(req, res, url)) {
    return;
  }

  if (method === 'GET' && pathname === '/api/quotas/codex') {
    try {
      sendJson(res, 200, await getCodexQuota());
    } catch (error) {
      console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
      sendJson(res, 500, { error: 'Failed to query Codex quota' });
    }
    return;
  }

  if (await handleFileApi(req, res, url)) {
    return;
  }

  if (await feishuIntegration.handleApi(req, res, url)) {
    return;
  }

  if (await handleVoiceApi(req, res, url)) {
    return;
  }

  if (await handleChatApi(req, res, url)) {
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await staticService.serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] Request failed:', error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  const auth = await initializeAuth();
  await feishuIntegration.loadState();
  await chatService.loadRecentImagePrompts();

  const server = http.createServer(requestHandler);
  const wss = new WebSocketServer({ noServer: true });
  const realtimeWss = new WebSocketServer({ noServer: true });

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/realtime') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') || '';
    const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true) }));
    });
  };

  server.on('upgrade', handleUpgrade);

  server.listen(PORT, HOST, () => {
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`Pairing code: ${getPairingCode()} (${auth.trustedDevices} trusted device(s)${auth.fixedPairingCode ? ', fixed' : ''})`);
    console.log('Use Tailscale and open http://<this-pc-tailscale-ip>:3321 on iPhone.');
  });

  refreshCodexCache().catch((error) => {
    console.warn('[server] Initial sync failed:', error.message);
  });

  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
      if (PUBLIC_URL) {
        console.log(`Public/private URL: ${PUBLIC_URL}`);
      } else {
        console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
