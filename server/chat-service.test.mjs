import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from './chat-service.js';

function makeChatService(overrides = {}) {
  const broadcasts = [];
  const service = createChatService({
    imagePromptState: '/tmp/codexmobile-chat-service-test.json',
    getProject: () => ({ id: 'project-1', name: 'Project', path: '/tmp/project', projectless: false }),
    getSession: () => ({ id: 'thread-1', projectId: 'project-1' }),
    getCacheSnapshot: () => ({ config: { skills: [], model: 'gpt-5.5' } }),
    getDesktopBridgeStatus: async () => ({ strict: true, connected: true, mode: 'desktop-proxy', reason: null }),
    listProjectSessions: () => [],
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: 'now', projects: [] }),
    renameSession: async () => null,
    broadcast: (payload) => broadcasts.push(payload),
    runCodexTurn: async () => 'thread-1',
    steerCodexTurn: async () => ({ accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' }),
    setDesktopFollowerCollaborationMode: async () => ({ ok: true }),
    abortCodexTurn: () => true,
    getActiveRuns: () => [],
    runImageTurn: async () => 'thread-1',
    isImageRequest: () => false,
    useLegacyImageGenerator: () => false,
    maybeAutoNameSession: async () => false,
    registerProjectlessThread: async () => null,
    registerMobileSession: async () => null,
    rememberLiveSession: () => null,
    desktopOwnerRetryDelays: [],
    ...overrides
  });
  return { service, broadcasts };
}

async function flushQueuedWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('sendChat routes running input through desktop turn/steer', async () => {
  let steerPayload = null;
  const { service, broadcasts } = makeChatService({
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '补充这个方向',
    sendMode: 'steer'
  });

  assert.equal(result.delivery, 'steered');
  assert.equal(result.clientTurnId, 'client-turn');
  assert.equal(result.turnId, 'active-turn');
  assert.equal(steerPayload.identifier, 'thread-1');
  assert.match(steerPayload.payload.message, /补充这个方向/);
  assert.equal(broadcasts.some((payload) => payload.type === 'user-message'), true);
});

test('sendChat rejects when strict desktop bridge is unavailable', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: false,
      mode: 'unavailable',
      reason: '桌面端未连接'
    })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      sessionId: 'thread-1',
      message: 'hello'
    }),
    /桌面端未连接/
  );
  assert.equal(broadcasts.length, 0);
});

test('sendChat rejects sessions that belong to another project', async () => {
  const { service } = makeChatService({
    getProject: (projectId) => ({ id: projectId, name: 'Other Project', path: '/tmp/other', projectless: false }),
    getSession: () => ({ id: 'thread-1', projectId: 'project-1' })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-2',
      sessionId: 'thread-1',
      message: 'should not cross projects'
    }),
    /Session does not belong to project/
  );
});

test('abortChat records and broadcasts an aborted turn even after the backend run is gone', async () => {
  let abortedIdentifier = null;
  const { service, broadcasts } = makeChatService({
    abortCodexTurn: (identifier) => {
      abortedIdentifier = identifier;
      return false;
    }
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(abortedIdentifier, 'client-turn-1');
  assert.equal(service.getTurn('client-turn-1').status, 'aborted');
  assert.equal(service.getTurn('client-turn-1').sessionId, 'thread-1');
  assert.equal(broadcasts.at(-1).type, 'chat-aborted');
  assert.equal(broadcasts.at(-1).turnId, 'client-turn-1');
  assert.equal(broadcasts.at(-1).sessionId, 'thread-1');
});

test('sendChat rejects desktop-ipc draft sends with a create-thread specific error', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      draftSessionId: 'draft-project-1-1',
      message: '手机新建一个同源对话'
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'CODEXMOBILE_DESKTOP_CREATE_THREAD_UNAVAILABLE');
      assert.match(error.message, /不能从手机直接新建桌面端对话/);
      return true;
    }
  );
  assert.equal(broadcasts.length, 0);
});

test('sendChat sends existing desktop-ipc threads through the desktop follower bridge', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '从手机发到桌面已有线程'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.turnId, 'desktop-turn-1');
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(started.params.input[0].type, 'text');
  assert.equal(started.params.input[0].text, '从手机发到桌面已有线程');
});

test('sendChat starts server-side desktop IPC monitoring after desktop handoff', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async () => ({ result: { turn: { id: 'desktop-turn-1' } } }),
    readSessionMessages: async () => ({ messages: [] })
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '从手机发到桌面后由后端监控'
  });

  assert.equal(result.turnId, 'desktop-turn-1');
  assert.equal(service.getTurn('client-turn-1').status, 'running');
  assert.equal(service.getTurn('client-turn-1').source, 'desktop-ipc');
  assert.equal(service.getTurn('desktop-turn-1').status, 'running');
  assert.deepEqual(service.getActiveDesktopIpcRuns(), [{
    source: 'desktop-ipc',
    projectId: 'project-1',
    sessionId: 'thread-1',
    previousSessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    startedAt: service.getTurn('desktop-turn-1').startedAt,
    status: 'running',
    steerable: false
  }]);
  assert.equal(broadcasts.some((payload) => payload.type === 'status-update' && payload.source === 'desktop-ipc'), true);
});

test('abortChat can abort a server-side desktop IPC monitor run', async () => {
  const interrupted = [];
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async () => ({ result: { turn: { id: 'desktop-turn-1' } } }),
    interruptDesktopFollowerTurn: async (conversationId) => {
      interrupted.push(conversationId);
      return { ok: true };
    },
    readSessionMessages: async () => ({ messages: [] }),
    abortCodexTurn: () => false
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '准备从手机中止桌面监控'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.deepEqual(interrupted, ['thread-1']);
  assert.equal(service.getActiveDesktopIpcRuns().length, 0);
  assert.equal(service.getTurn('client-turn-1').status, 'aborted');
  assert.equal(service.getTurn('desktop-turn-1').status, 'aborted');
  assert.equal(broadcasts.filter((payload) => payload.type === 'chat-aborted' && payload.source === 'desktop-ipc').length, 1);
});

test('abortChat falls back to session id when desktop IPC turn id does not match', async () => {
  const interrupted = [];
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async () => ({ result: { turn: { id: 'desktop-turn-1' } } }),
    interruptDesktopFollowerTurn: async (conversationId) => {
      interrupted.push(conversationId);
      return { ok: true };
    },
    readSessionMessages: async () => ({ messages: [] }),
    abortCodexTurn: () => false
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '准备用 session id 兜底中止'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'stale-mobile-turn-id'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.deepEqual(interrupted, ['thread-1']);
  assert.equal(service.getActiveDesktopIpcRuns().length, 0);
  assert.equal(service.getTurn('desktop-turn-1').status, 'aborted');
});

test('abortChat aborts an active headless run before a desktop IPC monitor on the same session', async () => {
  const interrupted = [];
  let abortedIdentifier = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async () => ({ result: { turn: { id: 'desktop-turn-1' } } }),
    interruptDesktopFollowerTurn: async (conversationId) => {
      interrupted.push(conversationId);
      return { ok: true };
    },
    readSessionMessages: async () => ({ messages: [] }),
    getActiveRuns: () => [{
      sessionId: 'thread-1',
      previousSessionId: 'thread-1',
      turnId: 'headless-turn-1',
      status: 'running',
      source: 'headless-local'
    }],
    abortCodexTurn: (identifier) => {
      abortedIdentifier = identifier;
      return true;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '先创建一个桌面 monitor'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'headless-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(abortedIdentifier, 'headless-turn-1');
  assert.deepEqual(interrupted, []);
  assert.equal(broadcasts.at(-1).type, 'chat-aborted');
  assert.equal(broadcasts.at(-1).source, 'headless-local');
  assert.equal(broadcasts.at(-1).turnId, 'headless-turn-1');
});

test('abortChat interrupts a desktop-origin running session by session id', async () => {
  const interrupted = [];
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    interruptDesktopFollowerTurn: async (conversationId) => {
      interrupted.push(conversationId);
      return { ok: true };
    },
    abortCodexTurn: () => false
  });

  const aborted = await service.abortChat({
    projectId: 'project-1',
    sessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.deepEqual(interrupted, ['thread-1']);
  assert.equal(broadcasts.at(-1).type, 'chat-aborted');
  assert.equal(broadcasts.at(-1).source, 'desktop-thread');
  assert.equal(broadcasts.at(-1).sessionId, 'thread-1');
});

test('sendChat sends desktop-ipc plan requests with desktop collaboration mode', async () => {
  let started = null;
  let collaborationUpdate = null;
  let modelUpdate = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    setDesktopFollowerCollaborationMode: async (conversationId, collaborationMode) => {
      collaborationUpdate = { conversationId, collaborationMode };
      return { ok: true };
    },
    setDesktopFollowerModelAndReasoning: async (conversationId, model, reasoningEffort) => {
      modelUpdate = { conversationId, model, reasoningEffort };
      return { ok: true };
    },
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-plan-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '先给我计划',
    collaborationMode: 'plan',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'fast'
  });

  assert.equal(result.delivery, 'started');
  assert.deepEqual(modelUpdate, {
    conversationId: 'thread-1',
    model: 'gpt-5.5',
    reasoningEffort: 'high'
  });
  assert.deepEqual(collaborationUpdate, {
    conversationId: 'thread-1',
    collaborationMode: {
      mode: 'plan',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        developer_instructions: null
      }
    }
  });
  assert.deepEqual(started.params.collaborationMode, collaborationUpdate.collaborationMode);
  assert.equal(started.params.serviceTier, 'fast');
});

test('sendChat clears desktop collaboration mode for normal follow-up turns', async () => {
  let started = null;
  let collaborationUpdate = 'not-called';
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    setDesktopFollowerCollaborationMode: async (conversationId, collaborationMode) => {
      collaborationUpdate = { conversationId, collaborationMode };
      return { ok: true };
    },
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-normal-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '执行计划'
  });

  assert.equal(result.delivery, 'started');
  assert.deepEqual(collaborationUpdate, {
    conversationId: 'thread-1',
    collaborationMode: null
  });
  assert.equal(Object.hasOwn(started.params, 'collaborationMode'), false);
});

test('sendChat continues normal desktop turn when clearing collaboration mode is unsupported', async () => {
  let started = null;
  let collaborationUpdate = 'not-called';
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    setDesktopFollowerCollaborationMode: async (conversationId, collaborationMode) => {
      collaborationUpdate = { conversationId, collaborationMode };
      throw new TypeError("Cannot read properties of null (reading 'settings')");
    },
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-normal-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '继续执行'
  });

  assert.equal(result.delivery, 'started');
  assert.deepEqual(collaborationUpdate, {
    conversationId: 'thread-1',
    collaborationMode: null
  });
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(Object.hasOwn(started.params, 'collaborationMode'), false);
});

test('sendChat does not pass null collaboration mode into desktop start params', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    setDesktopFollowerCollaborationMode: async () => ({ ok: true }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      if (Object.hasOwn(params, 'collaborationMode') && params.collaborationMode == null) {
        throw new TypeError("Cannot read properties of null (reading 'settings')");
      }
      return { result: { turn: { id: 'desktop-normal-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '普通消息'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(Object.hasOwn(started.params, 'collaborationMode'), false);
});

test('sendChat rejects existing desktop-ipc threads when the desktop owner is unavailable', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    startDesktopFollowerTurn: async () => {
      const error = new Error('桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。');
      error.statusCode = 409;
      error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
      throw error;
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      sessionId: 'thread-1',
      clientTurnId: 'client-turn',
      message: '桌面窗口不在时继续执行'
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE');
      assert.match(error.message, /未自动转后台执行|没有可接管的桌面窗口/);
      return true;
    }
  );
  assert.equal(runPayload, null);
  assert.equal(broadcasts.filter((payload) => payload.type === 'user-message').length, 0);
});

test('sendChat falls back to background when desktop settings sync times out before start', async () => {
  let runPayload = null;
  let startCalled = false;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    setDesktopFollowerModelAndReasoning: async () => {
      const error = new Error('桌面端 Codex IPC 请求超时: thread-follower-set-model-and-reasoning');
      error.code = 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT';
      throw error;
    },
    startDesktopFollowerTurn: async () => {
      startCalled = true;
      return { result: { turn: { id: 'desktop-turn-should-not-start' } } };
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '确认执行这个计划',
    model: 'gpt-5.5',
    reasoningEffort: 'medium'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.match(result.desktopBridge.reason, /IPC 状态异常/);
  assert.equal(startCalled, false);
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.equal(broadcasts.filter((payload) => payload.type === 'user-message').length, 1);
});

test('sendChat does not retry desktop settings sync timeouts before falling back', async () => {
  let modelAttempts = 0;
  let runPayload = null;
  const { service } = makeChatService({
    desktopOwnerRetryDelays: [0, 0, 0],
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    setDesktopFollowerModelAndReasoning: async (_conversationId, _model, _reasoningEffort, options = {}) => {
      modelAttempts += 1;
      assert.equal(options.timeoutMs, 2000);
      const error = new Error('桌面端 Codex IPC 请求超时: thread-follower-set-model-and-reasoning');
      error.code = 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT';
      throw error;
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '桌面 IPC 卡住时不要堆住发送'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(modelAttempts, 1);
  assert.equal(runPayload.sessionId, 'thread-1');
});

test('sendChat falls back to background when desktop returns null settings errors', async () => {
  let modelAttempts = 0;
  let runPayload = null;
  const { service } = makeChatService({
    desktopOwnerRetryDelays: [0, 0, 0],
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    setDesktopFollowerModelAndReasoning: async () => {
      modelAttempts += 1;
      throw new TypeError("Cannot read properties of null (reading 'settings')");
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '桌面 settings 为空时转后台'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.match(result.desktopBridge.reason, /IPC 状态异常/);
  assert.equal(modelAttempts, 1);
  assert.equal(runPayload.sessionId, 'thread-1');
});

test('sendChat can fall back to headless local for mobile-only sessions when the desktop owner is unavailable', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getSession: () => ({
      id: 'thread-1',
      projectId: 'project-1',
      mobileOnly: true,
      source: 'codexmobile'
    }),
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    startDesktopFollowerTurn: async () => {
      const error = new Error('桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。');
      error.statusCode = 409;
      error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
      throw error;
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '移动端后台线程继续执行'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.match(runPayload.message, /移动端后台线程继续执行/);
  assert.equal(broadcasts.filter((payload) => payload.type === 'user-message').length, 1);
});

test('sendChat waits for a desktop-ipc owner before falling back to headless local', async () => {
  let modelAttempts = 0;
  let started = null;
  let runPayload = null;
  const { service } = makeChatService({
    desktopOwnerRetryDelays: [0],
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    setDesktopFollowerModelAndReasoning: async () => {
      modelAttempts += 1;
      if (modelAttempts === 1) {
        const error = new Error('no-client-found');
        error.statusCode = 409;
        throw error;
      }
      return { ok: true };
    },
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-after-owner-bind' } } };
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '等桌面 owner 绑定后再执行'
  });

  assert.equal(result.desktopBridge.mode, 'desktop-ipc');
  assert.equal(result.turnId, 'desktop-turn-after-owner-bind');
  assert.equal(modelAttempts, 2);
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(runPayload, null);
});

test('sendChat can create a background thread when desktop-ipc cannot create desktop threads', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'thread-started', sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      return 'background-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '从手机后台新建'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.match(runPayload.message, /从手机后台新建/);
});

test('sendChat reuses a background-created thread alias for later desktop-ipc sends', async () => {
  const runPayloads = [];
  let desktopStarted = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayloads.push(payload);
      emit({
        type: 'thread-started',
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      });
      emit({
        type: 'chat-complete',
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      });
      return 'background-thread-1';
    },
    startDesktopFollowerTurn: async (conversationId, params) => {
      desktopStarted = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-1' } } };
    }
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn-1',
    message: '从手机后台新建'
  });
  await flushQueuedWork();

  const second = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn-2',
    message: '继续这条线程'
  });

  assert.equal(first.desktopBridge.mode, 'headless-local');
  assert.equal(second.desktopBridge.mode, 'desktop-ipc');
  assert.equal(second.sessionId, 'background-thread-1');
  assert.equal(desktopStarted.conversationId, 'background-thread-1');
  assert.match(desktopStarted.params.input.at(-1).text, /继续这条线程/);
  assert.equal(runPayloads.length, 1);
});

test('sendChat registers new projectless background threads for mobile and desktop lists', async () => {
  let runPayload = null;
  let desktopRegistration = null;
  let mobileRegistration = null;
  const { service } = makeChatService({
    getProject: () => ({
      id: '__codexmobile_projectless__',
      name: '普通对话',
      path: '/tmp/codex-projectless',
      projectless: true
    }),
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({
        type: 'thread-started',
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        startedAt: '2026-05-07T08:00:00.000Z'
      });
      emit({
        type: 'chat-complete',
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      });
      return 'projectless-thread-1';
    },
    registerProjectlessThread: async (threadId, workspaceRoot) => {
      desktopRegistration = { threadId, workspaceRoot };
    },
    registerMobileSession: async (session) => {
      mobileRegistration = session;
    }
  });

  const result = await service.sendChat({
    projectId: '__codexmobile_projectless__',
    draftSessionId: 'draft-projectless-1',
    clientTurnId: 'client-turn',
    message: '你好呀',
    attachments: [
      { id: 'img-1', name: '午餐.png', path: '/tmp/lunch.png', mimeType: 'image/png', kind: 'image' }
    ]
  });
  await flushQueuedWork();

  assert.equal(result.accepted, true);
  assert.equal(runPayload.draftSessionId, 'draft-projectless-1');
  assert.match(runPayload.message, /图片: 午餐\.png \(\/tmp\/lunch\.png\)/);
  assert.match(runPayload.projectPath, /\/tmp\/codex-projectless\/\d{4}-\d{2}-\d{2}\/mobile-chat-/);
  assert.deepEqual(desktopRegistration, {
    threadId: 'projectless-thread-1',
    workspaceRoot: '/tmp/codex-projectless'
  });
  assert.equal(mobileRegistration.id, 'projectless-thread-1');
  assert.equal(mobileRegistration.projectless, true);
  assert.equal(mobileRegistration.summary, '你好呀');
  assert.match(mobileRegistration.messages[0].content, /!\[午餐\.png\]\(\/tmp\/lunch\.png\)/);
});

test('sendChat remembers a started background thread path before broadcasting it', async () => {
  const events = [];
  const { service } = makeChatService({
    broadcast: (payload) => events.push(`broadcast:${payload.type}`),
    rememberLiveSession: (session) => events.push(`remember:${session.id}:${session.filePath}`),
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      emit({
        type: 'thread-started',
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        filePath: '/tmp/background-rollout.jsonl',
        startedAt: '2026-05-07T08:00:00.000Z'
      });
      emit({
        type: 'chat-complete',
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      });
      return 'background-thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1',
    clientTurnId: 'client-turn',
    message: '后台新线程'
  });
  await flushQueuedWork();

  const rememberedIndex = events.findIndex((event) => event === 'remember:background-thread-1:/tmp/background-rollout.jsonl');
  const broadcastIndex = events.findIndex((event) => event === 'broadcast:thread-started');
  assert.ok(rememberedIndex >= 0);
  assert.ok(broadcastIndex > rememberedIndex);
});

test('sendChat starts a headless local Codex turn when desktop bridge is in headless mode', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: '桌面端未打开，正在使用后台 Codex',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'thread-started', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      return 'headless-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '桌面端没开也跑一下'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.match(runPayload.message, /桌面端没开也跑一下/);
  assert.equal(broadcasts.some((payload) => payload.type === 'user-message'), true);
  assert.equal(broadcasts.find((payload) => payload.type === 'thread-started')?.source, 'headless-local');
  assert.equal(broadcasts.find((payload) => payload.type === 'chat-complete')?.source, 'headless-local');
});

test('sendChat passes plan collaboration mode to headless local Codex turns', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: '桌面端未打开，正在使用后台 Codex',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'thread-started', sessionId: 'headless-plan-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'headless-plan-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      return 'headless-plan-thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    message: '先规划一下',
    collaborationMode: 'plan',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'fast'
  });

  assert.equal(runPayload.serviceTier, 'fast');
  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});

test('queue drafts can be listed, deleted, and restored without auto starting during active work', async () => {
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    getCacheSnapshot: () => ({
      config: {
        model: 'gpt-5.5',
        skills: [{ name: 'frontend-design', path: '/skills/frontend-design/SKILL.md' }]
      }
    })
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-1',
    message: '排队草稿 1',
    sendMode: 'queue',
    selectedSkills: [{ path: '/skills/frontend-design/SKILL.md' }],
    fileMentions: [{ name: 'App.jsx', path: '/repo/client/src/App.jsx' }]
  });
  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-2',
    message: '排队草稿 2',
    sendMode: 'queue'
  });

  assert.equal(first.delivery, 'queued');
  assert.equal(second.delivery, 'queued');
  let queue = service.listQueue({ sessionId: 'thread-1' });
  assert.equal(queue.drafts.length, 2);
  assert.equal(queue.drafts[0].text, '排队草稿 1');
  assert.equal(queue.drafts[0].selectedSkills[0].path, '/skills/frontend-design/SKILL.md');
  assert.equal(queue.drafts[0].fileMentions[0].path, '/repo/client/src/App.jsx');

  const deleted = service.removeQueuedDraft({ sessionId: 'thread-1', draftId: 'queued-turn-2' });
  assert.equal(deleted.text, '排队草稿 2');
  queue = service.listQueue({ sessionId: 'thread-1' });
  assert.equal(queue.drafts.length, 1);

  const restored = service.restoreQueuedDraft({ sessionId: 'thread-1', draftId: 'queued-turn-1' });
  assert.equal(restored.text, '排队草稿 1');
  assert.equal(service.listQueue({ sessionId: 'thread-1' }).drafts.length, 0);
});

test('queued drafts can be steered into the current turn', async () => {
  let steerPayload = null;
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { sessionId: 'thread-1', turnId: 'steered-turn' };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-steer-1',
    message: '马上补充这句',
    fileMentions: [{ name: 'server.js', path: '/repo/server/index.js' }],
    sendMode: 'queue'
  });

  const result = await service.steerQueuedDraft({
    projectId: 'project-1',
    sessionId: 'thread-1',
    draftId: 'queued-steer-1'
  });

  assert.equal(result.delivery, 'steered');
  assert.equal(steerPayload.identifier, 'thread-1');
  assert.match(steerPayload.payload.message, /马上补充这句/);
  assert.match(steerPayload.payload.message, /引用文件路径/);
  assert.match(steerPayload.payload.message, /\/repo\/server\/index\.js/);
  assert.equal(service.listQueue({ sessionId: 'thread-1' }).drafts.length, 0);
});

test('file mentions are appended to normal chat sends', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: null,
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '看文件',
    fileMentions: [{ name: 'App.jsx', path: '/repo/client/src/App.jsx' }]
  });

  assert.match(runPayload.message, /看文件/);
  assert.match(runPayload.message, /引用文件路径/);
  assert.match(runPayload.message, /App\.jsx \(\/repo\/client\/src\/App\.jsx\)/);
});
