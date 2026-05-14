import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionRenameToProjectSessions,
  desktopRunningActivityPayload,
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages,
  syncDesktopActivityRuntimeFromMessages
} from './session-live-refresh.js';

test('shouldPollSelectedSessionMessages keeps normal running sessions protected', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-proxy' }
    }),
    false
  );
});

test('shouldPollSelectedSessionMessages allows desktop-ipc running sessions to refresh', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-ipc' },
      hasExternalThreadRefresh: true
    }),
    true
  );
});

test('shouldPollSelectedSessionMessages allows headless fallback sessions to refresh like external threads', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-ipc' },
      hasExternalThreadRefresh: true
    }),
    true
  );
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'headless-local' },
      hasExternalThreadRefresh: true
    }),
    true
  );
});

test('shouldPollSelectedSessionMessages protects local streaming runs when desktop-ipc is only a global bridge', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-ipc' },
      hasExternalThreadRefresh: false
    }),
    false
  );
});

test('mergeLiveSelectedThreadMessages preserves local pending send until desktop thread contains it', () => {
  const current = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'old-assistant', role: 'assistant', content: '之前的回答', timestamp: '2026-05-07T06:00:01.000Z' },
    { id: 'local-1', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'status-1', role: 'activity', status: 'running', content: '已交给桌面端处理', timestamp: '2026-05-07T06:01:00.000Z' }
  ];
  const loaded = current.slice(0, 2);

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['old-user', 'old-assistant', 'local-1', 'status-1']);
});

test('mergeLiveSelectedThreadMessages switches to desktop messages once the desktop thread catches up', () => {
  const current = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'local-1', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'status-1', role: 'activity', status: 'running', content: '已交给桌面端处理', timestamp: '2026-05-07T06:01:00.000Z' }
  ];
  const loaded = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'desktop-user', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-activity', role: 'activity', status: 'running', content: '正在处理本地任务', timestamp: '2026-05-07T06:01:01.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['old-user', 'desktop-user', 'desktop-activity']);
});

test('mergeLiveSelectedThreadMessages keeps transient handoff running until real output catches up', () => {
  const current = [
    { id: 'local-1', role: 'user', content: '手机新建线程', timestamp: '2026-05-07T06:01:00.000Z', turnId: 'turn-1' },
    {
      id: 'status-turn-1',
      role: 'activity',
      status: 'running',
      transient: true,
      label: '后台启动中',
      content: '后台启动中',
      timestamp: '2026-05-07T06:01:00.000Z',
      turnId: 'turn-1',
      activities: [{ id: 'handoff', kind: 'turn', label: '后台启动中', status: 'running' }]
    }
  ];

  const loadedUserOnly = [
    { id: 'desktop-user', role: 'user', content: '手机新建线程', timestamp: '2026-05-07T06:01:00.000Z', turnId: 'turn-1' }
  ];
  const withUserOnly = mergeLiveSelectedThreadMessages(current, loadedUserOnly);
  assert.deepEqual(withUserOnly.map((message) => message.id), ['desktop-user', 'status-turn-1']);
  assert.equal(withUserOnly[1].status, 'running');

  const loadedWithAssistant = [
    { id: 'desktop-user', role: 'user', content: '手机新建线程', timestamp: '2026-05-07T06:01:00.000Z', turnId: 'turn-1' },
    { id: 'desktop-assistant', role: 'assistant', content: '已经好了', timestamp: '2026-05-07T06:01:04.000Z', turnId: 'turn-1' }
  ];
  const withAssistant = mergeLiveSelectedThreadMessages(current, loadedWithAssistant);
  assert.deepEqual(withAssistant.map((message) => message.id), ['desktop-user', 'desktop-assistant']);
});

test('mergeLiveSelectedThreadMessages treats image-preview optimistic sends as the same user message', () => {
  const current = [
    {
      id: 'local-1',
      role: 'user',
      content: '移动端发送带图片消息\n\n![screenshot](/tmp/uploads/screenshot.png)',
      timestamp: '2026-05-08T06:30:00.000Z'
    },
    {
      id: 'status-1',
      role: 'activity',
      status: 'running',
      content: '正在处理',
      timestamp: '2026-05-08T06:30:00.000Z'
    }
  ];
  const loaded = [
    {
      id: 'desktop-user',
      role: 'user',
      content: '移动端发送带图片消息',
      timestamp: '2026-05-08T06:30:00.000Z'
    },
    {
      id: 'desktop-activity',
      role: 'activity',
      status: 'running',
      content: '正在处理本地任务',
      timestamp: '2026-05-08T06:30:01.000Z'
    }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['desktop-user', 'desktop-activity']);
});

test('mergeLiveSelectedThreadMessages keeps local activity when desktop messages omit process records', () => {
  const current = [
    { id: 'local-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    {
      id: 'status-turn-1',
      role: 'activity',
      status: 'running',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      content: '正在处理',
      timestamp: '2026-05-07T06:01:01.000Z',
      activities: [
        { id: 'thinking', kind: 'reasoning', label: '正在思考', status: 'running' },
        { id: 'cmd', kind: 'command_execution', label: '运行命令', status: 'completed', command: 'date' }
      ]
    }
  ];
  const loaded = [
    { id: 'desktop-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-assistant', role: 'assistant', content: '完成', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:08.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['desktop-user', 'status-turn-1', 'desktop-assistant']);
  assert.equal(merged[1].status, 'completed');
  assert.equal(merged[1].activities[0].status, 'completed');
});

test('mergeLiveSelectedThreadMessages can preserve running activity state during lightweight polls', () => {
  const current = [
    { id: 'local-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    {
      id: 'status-turn-1',
      role: 'activity',
      status: 'running',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      content: '正在处理',
      timestamp: '2026-05-07T06:01:01.000Z',
      activities: [
        { id: 'thinking', kind: 'reasoning', label: '正在思考', status: 'running' },
        { id: 'cmd', kind: 'command_execution', label: '运行命令', status: 'completed', command: 'date' }
      ]
    }
  ];
  const loaded = [
    { id: 'desktop-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-assistant', role: 'assistant', content: '已经有部分输出', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:08.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded, { preserveActivityState: true });

  assert.deepEqual(merged.map((message) => message.id), ['desktop-user', 'status-turn-1', 'desktop-assistant']);
  assert.equal(merged[1].status, 'running');
  assert.equal(merged[1].activities[0].status, 'running');
});

test('mergeLiveSelectedThreadMessages keeps preserved activity beside its user during lightweight polls', () => {
  const current = [
    { id: 'desktop-user-1', role: 'user', content: '先处理这个项目', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    {
      id: 'activity-turn-1',
      role: 'activity',
      status: 'running',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      content: '正在处理',
      timestamp: '2026-05-07T06:01:00.000Z',
      activities: [{ id: 'cmd', kind: 'command_execution', label: '运行命令', status: 'running' }]
    },
    { id: 'desktop-user-2', role: 'user', content: '再补一个要求', sessionId: 'thread-1', turnId: 'turn-2', timestamp: '2026-05-07T06:01:02.000Z' }
  ];
  const lightweightLoaded = [
    { id: 'desktop-user-1', role: 'user', content: '先处理这个项目', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-user-2', role: 'user', content: '再补一个要求', sessionId: 'thread-1', turnId: 'turn-2', timestamp: '2026-05-07T06:01:02.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, lightweightLoaded, { preserveActivityState: true });

  assert.deepEqual(merged.map((message) => message.id), ['desktop-user-1', 'activity-turn-1', 'desktop-user-2']);
  assert.equal(merged[1].status, 'running');
});

test('desktopRunningActivityPayload exposes a selected desktop running activity for sidebar runtime', () => {
  assert.deepEqual(
    desktopRunningActivityPayload([
      {
        id: 'desktop-activity-old',
        role: 'activity',
        kind: 'desktop',
        status: 'completed',
        sessionId: 'thread-1',
        turnId: 'turn-old',
        timestamp: '2026-05-08T07:00:00.000Z'
      },
      {
        id: 'desktop-activity-running',
        role: 'activity',
        kind: 'desktop',
        status: 'running',
        sessionId: 'thread-1',
        turnId: 'turn-new',
        startedAt: '2026-05-08T07:01:00.000Z',
        timestamp: '2026-05-08T07:01:01.000Z'
      }
    ], 'thread-1'),
    {
      source: 'desktop-thread',
      sessionId: 'thread-1',
      turnId: 'turn-new',
      startedAt: '2026-05-08T07:01:00.000Z',
      timestamp: '2026-05-08T07:01:01.000Z',
      steerable: false
    }
  );
});

test('desktopRunningActivityPayload ignores non-desktop and terminal activity messages', () => {
  assert.equal(
    desktopRunningActivityPayload([
      { role: 'activity', kind: 'turn', status: 'running', sessionId: 'thread-1', turnId: 'turn-1' },
      { role: 'activity', kind: 'desktop', status: 'completed', sessionId: 'thread-1', turnId: 'turn-2' }
    ], 'thread-1'),
    null
  );
});

test('syncDesktopActivityRuntimeFromMessages marks and clears selected desktop-thread runtime', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        { role: 'activity', kind: 'desktop', status: 'running', sessionId: 'thread-1', turnId: 'turn-1' }
      ],
      sessionId: 'thread-1',
      markRun: (payload) => calls.push(['mark', payload]),
      clearRun: (payload) => calls.push(['clear', payload])
    }),
    'marked'
  );
  assert.equal(calls[0][0], 'mark');
  assert.equal(calls[0][1].source, 'desktop-thread');

  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        { role: 'activity', kind: 'desktop', status: 'completed', sessionId: 'thread-1', turnId: 'turn-1' }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: { status: 'running', source: 'desktop-thread', turnId: 'turn-1' },
      markRun: (payload) => calls.push(['mark', payload]),
      clearRun: (payload) => calls.push(['clear', payload])
    }),
    'completed'
  );
  assert.deepEqual(calls[1], ['clear', {
    source: 'desktop-thread',
    sessionId: 'thread-1',
    turnId: 'turn-1'
  }]);
});

test('syncDesktopActivityRuntimeFromMessages marks completion after selected desktop-thread runtime finishes', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        {
          role: 'activity',
          kind: 'desktop',
          status: 'completed',
          sessionId: 'thread-1',
          turnId: 'turn-1',
          completedAt: '2026-05-08T07:02:00.000Z',
          timestamp: '2026-05-08T07:02:00.000Z'
        }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: { status: 'running', source: 'desktop-thread', turnId: 'turn-1' },
      clearRun: (payload) => calls.push(['clear', payload]),
      markSessionCompleteNotice: (payload) => calls.push(['complete', payload])
    }),
    'completed'
  );

  assert.deepEqual(calls, [
    ['clear', {
      source: 'desktop-thread',
      sessionId: 'thread-1',
      turnId: 'turn-1'
    }],
    ['complete', {
      source: 'desktop-thread',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      completedAt: '2026-05-08T07:02:00.000Z',
      timestamp: '2026-05-08T07:02:00.000Z'
    }]
  ]);
});

test('syncDesktopActivityRuntimeFromMessages treats desktop-ipc runtime as desktop thread state', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        {
          role: 'activity',
          kind: 'desktop',
          status: 'completed',
          sessionId: 'thread-1',
          turnId: 'desktop-turn-1',
          completedAt: '2026-05-08T07:03:00.000Z',
          timestamp: '2026-05-08T07:03:00.000Z'
        }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: {
        status: 'running',
        source: 'desktop-ipc',
        turnId: 'desktop-turn-1'
      },
      clearRun: (payload) => calls.push(['clear', payload]),
      markSessionCompleteNotice: (payload) => calls.push(['complete', payload])
    }),
    'completed'
  );

  assert.equal(calls[0][0], 'clear');
  assert.equal(calls[1][0], 'complete');
  assert.equal(calls[1][1].source, 'desktop-ipc');
});

test('syncDesktopActivityRuntimeFromMessages clears desktop-ipc runtime when thread no longer has running activity', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        { role: 'user', sessionId: 'thread-1', turnId: 'desktop-turn-1', content: '手机发起' },
        { role: 'assistant', sessionId: 'thread-1', turnId: 'desktop-turn-1', content: '完成' }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: {
        status: 'running',
        source: 'desktop-ipc',
        turnId: 'desktop-turn-1'
      },
      clearRun: (payload) => calls.push(['clear', payload])
    }),
    'cleared'
  );

  assert.deepEqual(calls, [['clear', {
    source: 'desktop-ipc',
    sessionId: 'thread-1',
    turnId: 'desktop-turn-1'
  }]]);
});

test('syncDesktopActivityRuntimeFromMessages preserves headless source while marking running thread activity', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        {
          role: 'activity',
          kind: 'desktop',
          status: 'running',
          sessionId: 'thread-1',
          turnId: 'headless-turn-1',
          startedAt: '2026-05-08T07:03:00.000Z'
        }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: {
        status: 'running',
        source: 'headless-local',
        turnId: 'headless-turn-1'
      },
      markRun: (payload) => calls.push(['mark', payload])
    }),
    'marked'
  );

  assert.equal(calls[0][1].source, 'headless-local');
});

test('syncDesktopActivityRuntimeFromMessages treats headless-local runtime as external thread state', () => {
  const calls = [];
  assert.equal(
    syncDesktopActivityRuntimeFromMessages({
      messages: [
        {
          role: 'activity',
          kind: 'desktop',
          status: 'completed',
          sessionId: 'thread-1',
          turnId: 'headless-turn-1',
          completedAt: '2026-05-08T07:04:00.000Z',
          timestamp: '2026-05-08T07:04:00.000Z'
        }
      ],
      sessionId: 'thread-1',
      selectedRunRuntime: {
        status: 'running',
        source: 'headless-local',
        turnId: 'headless-turn-1'
      },
      clearRun: (payload) => calls.push(['clear', payload]),
      markSessionCompleteNotice: (payload) => calls.push(['complete', payload])
    }),
    'completed'
  );

  assert.equal(calls[0][1].source, 'headless-local');
  assert.equal(calls[1][1].source, 'headless-local');
});

test('applySessionRenameToProjectSessions patches the loaded sidebar session in place', () => {
  const current = {
    projectA: [
      { id: 'thread-1', projectId: 'projectA', title: '旧标题', titleLocked: false, messageCount: 2 },
      { id: 'thread-2', projectId: 'projectA', title: '别的线程', titleLocked: false, messageCount: 1 }
    ]
  };

  const next = applySessionRenameToProjectSessions(current, {
    type: 'session-renamed',
    projectId: 'projectA',
    sessionId: 'thread-1',
    title: '新标题',
    titleLocked: true
  });

  assert.deepEqual(next.projectA.map((session) => session.title), ['新标题', '别的线程']);
  assert.equal(next.projectA[0].messageCount, 2);
  assert.equal(next.projectA[0].titleLocked, true);
});

test('applySessionRenameToProjectSessions can insert a renamed session from a full payload', () => {
  const next = applySessionRenameToProjectSessions({}, {
    type: 'session-renamed',
    projectId: 'projectA',
    sessionId: 'thread-1',
    title: '新标题',
    session: { id: 'thread-1', projectId: 'projectA', title: '新标题', messageCount: 3 }
  });

  assert.deepEqual(next.projectA, [
    { id: 'thread-1', projectId: 'projectA', title: '新标题', messageCount: 3, titleLocked: true }
  ]);
});
