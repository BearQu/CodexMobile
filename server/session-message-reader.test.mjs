import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionMessageReader, messagesFromRolloutJsonl, readRolloutContextState } from './session-message-reader.js';

test('session message reader filters hidden messages, paginates, and exposes context status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            last_token_usage: { input_tokens: 25000 },
            total_token_usage: { total_tokens: 30000 }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            last_token_usage: { input_tokens: 10000 },
            total_token_usage: { total_tokens: 13000 }
          }
        }
      })
    ].join('\n'));

    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(['message-2']),
      readDesktopThread: async (sessionId, options) => {
        assert.equal(sessionId, 'session-1');
        assert.deepEqual(options, { includeTurns: true });
        return { thread: { id: 'session-1', path: rolloutPath, turns: [] } };
      },
      messagesFromDesktopThread: () => [
        { id: 'message-1', role: 'user', content: 'first', timestamp: '2026-05-08T01:00:00.000Z' },
        { id: 'message-2', role: 'assistant', content: 'hidden', timestamp: '2026-05-08T01:01:00.000Z' },
        { id: 'message-3', role: 'assistant', content: 'last', timestamp: '2026-05-08T01:02:00.000Z' }
      ],
      getConfigContext: () => ({ autoCompactTokenLimit: 80000 })
    });

    const result = await reader.readSessionMessages('session-1', { limit: 1, latest: true });

    assert.deepEqual(result.messages.map((message) => message.id), ['message-3']);
    assert.equal(result.total, 2);
    assert.equal(result.offset, 1);
    assert.equal(result.hasMoreBefore, true);
    assert.equal(result.context.inputTokens, 10000);
    assert.equal(result.context.contextWindow, 100000);
    assert.equal(result.context.autoCompact.detected, true);
    assert.equal(result.context.autoCompact.reason, '上下文用量回落');
    assert.match(result.revision, /rollout\.jsonl:\d+:\d+/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollout context state exposes running desktop runtime until task completion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-runtime-state-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const startedRows = [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          started_at: 1778202000,
          model_context_window: 100000
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-5.5' }
      })
    ];
    await fs.writeFile(rolloutPath, startedRows.join('\n'));

    const running = await readRolloutContextState(rolloutPath, 'session-1');

    assert.equal(running.runtime.status, 'running');
    assert.equal(running.runtime.source, 'desktop-thread');
    assert.equal(running.runtime.sessionId, 'session-1');
    assert.equal(running.runtime.turnId, 'turn-1');

    await fs.writeFile(rolloutPath, [
      ...startedRows,
      JSON.stringify({
        timestamp: '2026-05-08T01:00:10.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' }
      })
    ].join('\n'));

    const completed = await readRolloutContextState(rolloutPath, 'session-1');

    assert.equal(completed.runtime, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollout context state clears runtime after final assistant message without task_complete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-runtime-final-message-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-5.5' }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '正在处理。' }]
        }
      })
    ].join('\n'));

    const running = await readRolloutContextState(rolloutPath, 'session-1');
    assert.equal(running.runtime.status, 'running');

    await fs.appendFile(rolloutPath, `\n${JSON.stringify({
      timestamp: '2026-05-08T01:00:10.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '完成了。' }]
      }
    })}`);

    const completed = await readRolloutContextState(rolloutPath, 'session-1');
    assert.equal(completed.runtime, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader merges raw and collaboration activities only when requested', async () => {
  const calls = [];
  const messages = [
    { id: 'message-1', role: 'user', content: 'hi', timestamp: '2026-05-08T01:00:00.000Z' }
  ];
  const reader = createSessionMessageReader({
    readDeletedMessageIds: async () => new Set(),
    readDesktopThread: async () => ({
      thread: { id: 'session-1', path: '/tmp/rollout.jsonl', turns: [{ id: 'turn-1' }] }
    }),
    messagesFromDesktopThread: (_thread, options) => {
      calls.push(['messagesFromDesktopThread', options.includeActivity]);
      return [...messages];
    },
    readRawSessionActivities: async (filePath, turns) => {
      calls.push(['raw', filePath, turns.length]);
      return [{ turnId: 'turn-1', activity: { id: 'raw-1', kind: 'command_execution', timestamp: '2026-05-08T01:01:00.000Z' } }];
    },
    readDesktopCollabActivities: async (filePath) => {
      calls.push(['collab', filePath]);
      return [{ turnId: 'turn-1', activity: { id: 'collab-1', kind: 'agent_message', timestamp: '2026-05-08T01:02:00.000Z' } }];
    },
    removeFallbackActivitiesCoveredByRaw: (items, raw) => calls.push(['removeFallback', items.length, raw.length]),
    upsertDesktopActivity: (items, turnId, activity) => {
      calls.push(['upsert', turnId, activity.id]);
      items.push({ id: activity.id, role: 'activity', timestamp: activity.timestamp });
    },
    sortDesktopActivitySteps: (items) => {
      calls.push(['sort', items.length]);
      items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    },
    readRolloutContextState: async () => ({ sessionId: 'session-1' })
  });

  const withoutActivity = await reader.readSessionMessages('session-1', { includeActivity: false });
  assert.deepEqual(withoutActivity.messages.map((message) => message.id), ['message-1']);
  assert.deepEqual(calls, [['messagesFromDesktopThread', false]]);

  calls.length = 0;
  const withActivity = await reader.readSessionMessages('session-1', { includeActivity: true });
  assert.deepEqual(withActivity.messages.map((message) => message.id), ['message-1', 'raw-1', 'collab-1']);
  assert.deepEqual(calls, [
    ['messagesFromDesktopThread', true],
    ['raw', '/tmp/rollout.jsonl', 1],
    ['removeFallback', 1, 1],
    ['upsert', 'turn-1', 'raw-1'],
    ['collab', '/tmp/rollout.jsonl'],
    ['upsert', 'turn-1', 'collab-1'],
    ['sort', 3]
  ]);
});

test('session message reader reuses projected messages while the rollout file is unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-cache-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1' }
      })
    ].join('\n'));

    let desktopReads = 0;
    let rawReads = 0;
    let contextReads = 0;
    let deletedReads = 0;
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => {
        deletedReads += 1;
        return deletedReads === 1 ? new Set(['message-2']) : new Set();
      },
      resolveSessionThread: async (sessionId) => ({
        id: sessionId,
        filePath: rolloutPath
      }),
      readDesktopThread: async () => {
        desktopReads += 1;
        return {
          thread: {
            id: 'session-1',
            path: rolloutPath,
            turns: [{ id: 'turn-1' }]
          }
        };
      },
      messagesFromDesktopThread: () => [
        { id: 'message-1', role: 'user', content: 'first', timestamp: '2026-05-08T01:00:00.000Z' },
        { id: 'message-2', role: 'assistant', content: 'second', timestamp: '2026-05-08T01:01:00.000Z' }
      ],
      readRawSessionActivities: async () => {
        rawReads += 1;
        return [];
      },
      readDesktopCollabActivities: async () => [],
      readRolloutContextState: async () => {
        contextReads += 1;
        return { sessionId: 'session-1' };
      }
    });

    const first = await reader.readSessionMessages('session-1', { includeActivity: true, limit: 1, latest: true });
    const second = await reader.readSessionMessages('session-1', { includeActivity: true, limit: 2, latest: true });

    assert.deepEqual(first.messages.map((message) => message.id), ['message-1']);
    assert.deepEqual(second.messages.map((message) => message.id), ['message-1', 'message-2']);
    assert.equal(desktopReads, 1);
    assert.equal(rawReads, 1);
    assert.equal(contextReads, 1);
    assert.equal(second.revision, first.revision);

    await fs.appendFile(rolloutPath, '\n');
    const changed = await reader.readSessionMessages('session-1', { includeActivity: true });
    assert.equal(desktopReads, 2);
    assert.notEqual(changed.revision, first.revision);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader preserves raw activity segment indices', async () => {
  const upserts = [];
  const reader = createSessionMessageReader({
    readDeletedMessageIds: async () => new Set(),
    readDesktopThread: async () => ({
      thread: { id: 'session-1', path: '/tmp/rollout.jsonl', turns: [{ id: 'turn-1' }] }
    }),
    messagesFromDesktopThread: () => [],
    readRawSessionActivities: async () => [
      { turnId: 'turn-1', segmentIndex: 1, activity: { id: 'raw-1', kind: 'command_execution' } }
    ],
    readDesktopCollabActivities: async () => [],
    removeFallbackActivitiesCoveredByRaw: () => null,
    upsertDesktopActivity: (_items, turnId, activity, segmentIndex) => {
      upserts.push([turnId, activity.id, segmentIndex]);
    },
    sortDesktopActivitySteps: () => null,
    readRolloutContextState: async () => ({ sessionId: 'session-1' })
  });

  await reader.readSessionMessages('session-1', { includeActivity: true });

  assert.deepEqual(upserts, [['turn-1', 'raw-1', 1]]);
});

test('session message reader keeps raw activity beside its steered message after final sorting', async () => {
  const reader = createSessionMessageReader({
    readDeletedMessageIds: async () => new Set(),
    readDesktopThread: async () => ({
      thread: {
        id: 'session-1',
        path: '/tmp/rollout.jsonl',
        turns: [{ id: 'turn-1' }]
      }
    }),
    messagesFromDesktopThread: () => [
      {
        id: 'user-1',
        role: 'user',
        content: '先修列表同步',
        turnId: 'turn-1',
        timestamp: '2026-02-02T00:00:00.000Z'
      },
      {
        id: 'answer-1',
        role: 'assistant',
        content: '第一段回复',
        turnId: 'turn-1',
        timestamp: '2026-02-02T00:00:05.000Z'
      },
      {
        id: 'user-2',
        role: 'user',
        content: '再把移动端 UI 分开',
        turnId: 'turn-1',
        guided: true,
        timestamp: '2026-02-02T00:00:00.000Z'
      },
      {
        id: 'answer-2',
        role: 'assistant',
        content: '第二段回复',
        turnId: 'turn-1',
        timestamp: '2026-02-02T00:00:06.000Z'
      }
    ],
    readRawSessionActivities: async () => [
      {
        turnId: 'turn-1',
        segmentIndex: 0,
        activity: {
          id: 'raw-0',
          kind: 'command_execution',
          label: '本地任务已处理',
          command: 'git status --short',
          timestamp: '2026-02-02T00:00:01.000Z'
        }
      },
      {
        turnId: 'turn-1',
        segmentIndex: 1,
        activity: {
          id: 'raw-1',
          kind: 'command_execution',
          label: '本地任务已处理',
          command: 'rg steer client/src',
          timestamp: '2026-02-02T00:00:03.000Z'
        }
      }
    ],
    readDesktopCollabActivities: async () => [],
    readRolloutContextState: async () => ({ sessionId: 'session-1' })
  });

  const result = await reader.readSessionMessages('session-1', { includeActivity: true });

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ['user-1', 'activity-turn-1', 'answer-1', 'user-2', 'activity-turn-1-1', 'answer-2']
  );
});

test('session message reader keeps earlier turn activity before later user messages', async () => {
  const reader = createSessionMessageReader({
    readDeletedMessageIds: async () => new Set(),
    readDesktopThread: async () => ({
      thread: {
        id: 'session-1',
        path: '/tmp/rollout.jsonl',
        turns: [{ id: 'turn-1' }, { id: 'turn-2' }]
      }
    }),
    messagesFromDesktopThread: () => [
      {
        id: 'user-1',
        role: 'user',
        content: '先处理这个项目',
        turnId: 'turn-1',
        timestamp: '2026-02-02T00:00:00.000Z'
      },
      {
        id: 'user-2',
        role: 'user',
        content: '再补一个要求',
        turnId: 'turn-2',
        timestamp: '2026-02-02T00:00:02.000Z'
      }
    ],
    readRawSessionActivities: async () => [
      {
        turnId: 'turn-1',
        segmentIndex: 0,
        activity: {
          id: 'raw-1',
          kind: 'command_execution',
          label: '本地任务已处理',
          command: 'npm run build',
          timestamp: '2026-02-02T00:00:03.000Z'
        }
      }
    ],
    readDesktopCollabActivities: async () => [],
    readRolloutContextState: async () => ({ sessionId: 'session-1' })
  });

  const result = await reader.readSessionMessages('session-1', { includeActivity: true });

  assert.deepEqual(result.messages.map((message) => message.id), ['user-1', 'activity-turn-1', 'user-2']);
});

test('session message reader falls back to rollout jsonl when desktop thread is not loaded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-rollout-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T17:01:40.000Z',
        type: 'session_meta',
        payload: { id: 'session-1', cwd: dir }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T17:01:41.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', cwd: dir }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T17:01:42.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '晚上好呀 你困吗' }]
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T17:01:43.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '晚上好，我不困，随时在。' }]
        }
      })
    ].join('\n'));

    const notLoadedError = new Error('thread not loaded: session-1');
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => {
        throw notLoadedError;
      },
      resolveSessionThread: async (sessionId) => ({
        id: sessionId,
        filePath: rolloutPath
      })
    });

    const result = await reader.readSessionMessages('session-1');

    assert.deepEqual(
      result.messages.map((message) => [message.role, message.content, message.turnId]),
      [
        ['user', '晚上好呀 你困吗', 'turn-1'],
        ['assistant', '晚上好，我不困，随时在。', 'turn-1']
      ]
    );
    assert.equal(result.total, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('messagesFromRolloutJsonl converts proposed plan answers into standalone plan UI messages', () => {
  const content = [
    JSON.stringify({
      timestamp: '2026-05-08T18:29:01.775Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '/plan 测试计划卡片' }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:11.962Z',
      type: 'response_item',
      payload: {
        id: 'assistant-plan-1',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{
          type: 'output_text',
          text: '<proposed_plan>\n# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。\n</proposed_plan>'
        }]
      }
    })
  ].join('\n');

  const result = messagesFromRolloutJsonl(content, 'session-1');

  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'plan', 'plan_request']);
  assert.equal(result.messages[1].id, 'assistant-plan-1-plan');
  assert.equal(result.messages[1].title, '移动端计划模式测试计划');
  assert.equal(result.messages[1].content, '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。');
  assert.deepEqual(result.messages[2].planImplementation, {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。',
    completed: false
  });
});

test('messagesFromRolloutJsonl removes stale plan request after implementation starts', () => {
  const planContent = '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。';
  const content = [
    JSON.stringify({
      timestamp: '2026-05-08T18:29:01.775Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '/plan 测试计划卡片' }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:11.962Z',
      type: 'response_item',
      payload: {
        id: 'assistant-plan-1',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: `<proposed_plan>\n${planContent}\n</proposed_plan>` }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:30:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-2' }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:30:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `PLEASE IMPLEMENT THIS PLAN:\n${planContent}` }]
      }
    })
  ].join('\n');

  const result = messagesFromRolloutJsonl(content, 'session-1');

  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'plan', 'user']);
  assert.equal(result.messages[1].content, planContent);
  assert.equal(result.messages[2].content, '执行计划');
});

test('messagesFromRolloutJsonl marks second user message in one turn as guided', () => {
  const content = [
    JSON.stringify({
      timestamp: '2026-05-08T18:29:01.775Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '先修列表同步' }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '再把移动端 UI 分开' }]
      }
    })
  ].join('\n');

  const result = messagesFromRolloutJsonl(content, 'session-1');

  assert.deepEqual(
    result.messages.map((message) => [message.content, Boolean(message.guided), message.guideLabel || '']),
    [
      ['先修列表同步', false, ''],
      ['再把移动端 UI 分开', true, '已引导对话']
    ]
  );
});

test('session message reader falls back to rollout jsonl when desktop thread is empty but a rollout file exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-empty-thread-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T18:29:01.775Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1' }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T18:29:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '移动端消息' }]
        }
      })
    ].join('\n'));

    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => ({ thread: { id: 'session-1', turns: [] } }),
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath })
    });

    const result = await reader.readSessionMessages('session-1');

    assert.deepEqual(result.messages.map((message) => [message.role, message.content]), [
      ['user', '移动端消息']
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
