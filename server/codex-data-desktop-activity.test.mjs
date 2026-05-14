import assert from 'node:assert/strict';
import test from 'node:test';
import { messagesFromDesktopThread, rawSessionActivitiesFromJsonl } from './codex-data.js';
import { upsertDesktopActivity } from './desktop-thread-projector.js';

test('messagesFromDesktopThread preserves running desktop file activity', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'running',
        startedAt: 1770000000,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '修一下 UI' }] },
          {
            id: 'file-1',
            type: 'fileChange',
            status: 'running',
            changes: [{ path: '/tmp/App.jsx', kind: 'update', unified_diff: '+ok\n' }]
          }
        ]
      }
    ]
  }, { includeActivity: true });

  const activityMessage = messages.find((message) => message.role === 'activity');
  assert.equal(activityMessage.status, 'running');
  assert.equal(activityMessage.activities[0].kind, 'file_change');
  assert.equal(activityMessage.activities[0].status, 'running');
  assert.equal(activityMessage.activities[0].label, '正在更新文件');
});

test('messagesFromDesktopThread uses mobile labels for completed desktop command activity', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        startedAt: 1770000000,
        completedAt: 1770000003,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '跑测试' }] },
          {
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'completed',
            command: 'npm test',
            aggregatedOutput: 'ok'
          },
          { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: '测试通过' }
        ]
      }
    ]
  }, { includeActivity: true });

  const activityMessage = messages.find((message) => message.role === 'activity');
  assert.equal(activityMessage.status, 'completed');
  assert.equal(activityMessage.activities[0].kind, 'command_execution');
  assert.equal(activityMessage.activities[0].status, 'completed');
  assert.equal(activityMessage.activities[0].label, '本地任务已处理');
});

test('messagesFromDesktopThread marks steered user messages inside the same turn', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'running',
        startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '先修列表同步' }] },
          {
            id: 'commentary-1',
            type: 'agentMessage',
            phase: 'commentary',
            text: '先看状态。'
          },
          { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: '再把移动端 UI 分开' }] },
          {
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'running',
            command: 'rg steer client/src'
          }
        ]
      }
    ]
  }, { includeActivity: true });

  const userMessages = messages.filter((message) => message.role === 'user');
  assert.deepEqual(
    userMessages.map((message) => [message.content, Boolean(message.guided), message.guideLabel || '']),
    [
      ['先修列表同步', false, ''],
      ['再把移动端 UI 分开', true, '已引导对话']
    ]
  );

  const guidedActivity = messages.find((message) => message.role === 'activity' && message.segmentIndex === 1);
  assert.equal(guidedActivity?.activities[0].kind, 'command_execution');
  assert.equal(guidedActivity.activities[0].command, 'rg steer client/src');
});

test('raw desktop activities are inserted next to their matching steered user segment', () => {
  const messages = [
    {
      id: 'user-1',
      role: 'user',
      content: '先修列表同步',
      turnId: 'turn-1',
      timestamp: '2026-02-02T00:00:00.100Z'
    },
    {
      id: 'answer-1',
      role: 'assistant',
      content: '第一段回复',
      turnId: 'turn-1',
      timestamp: '2026-02-02T00:00:01.500Z'
    },
    {
      id: 'user-2',
      role: 'user',
      content: '再把移动端 UI 分开',
      turnId: 'turn-1',
      guided: true,
      timestamp: '2026-02-02T00:00:02.000Z'
    },
    {
      id: 'answer-2',
      role: 'assistant',
      content: '第二段回复',
      turnId: 'turn-1',
      timestamp: '2026-02-02T00:00:04.000Z'
    }
  ];

  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-1',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'rg steer client/src',
    status: 'completed',
    timestamp: '2026-02-02T00:00:03.000Z'
  }, 1);
  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-0',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'git status --short',
    status: 'completed',
    timestamp: '2026-02-02T00:00:01.000Z'
  }, 0);

  assert.deepEqual(
    messages.map((message) => message.id),
    ['user-1', 'activity-turn-1', 'answer-1', 'user-2', 'activity-turn-1-1', 'answer-2']
  );
  assert.equal(messages[1].activities[0].command, 'git status --short');
  assert.equal(messages[4].activities[0].command, 'rg steer client/src');
});

test('desktop activity containers keep a stable conversation timestamp', () => {
  const messages = [
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
  ];

  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-0',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'npm run build',
    status: 'completed',
    timestamp: '2026-02-02T00:00:03.000Z'
  });

  const activity = messages.find((message) => message.role === 'activity');
  assert.equal(activity.timestamp, '2026-02-02T00:00:00.000Z');
  assert.deepEqual(messages.map((message) => message.id), ['user-1', 'activity-turn-1', 'user-2']);

  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-1',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'node --test',
    status: 'completed',
    timestamp: '2026-02-02T00:00:05.000Z'
  });

  assert.equal(activity.timestamp, '2026-02-02T00:00:00.000Z');
  assert.equal(activity.completedAt, '2026-02-02T00:00:05.000Z');
});

test('completed raw desktop activities create terminal activity containers', () => {
  const messages = [
    {
      id: 'user-1',
      role: 'user',
      content: '查一下状态',
      turnId: 'turn-1',
      timestamp: '2026-02-02T00:00:00.000Z'
    },
    {
      id: 'answer-1',
      role: 'assistant',
      content: '已经好了',
      turnId: 'turn-1',
      timestamp: '2026-02-02T00:00:04.000Z'
    }
  ];

  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-0',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'git status --short',
    status: 'completed',
    timestamp: '2026-02-02T00:00:01.000Z'
  });
  upsertDesktopActivity(messages, 'turn-1', {
    id: 'turn-1-raw-command-1',
    kind: 'command_execution',
    label: '本地任务已处理',
    command: 'npm run build',
    status: 'completed',
    timestamp: '2026-02-02T00:00:04.000Z'
  });

  const activity = messages.find((message) => message.role === 'activity');
  assert.equal(activity.status, 'completed');
  assert.equal(activity.label, '过程已同步');
  assert.equal(activity.startedAt, '2026-02-02T00:00:01.000Z');
  assert.equal(activity.completedAt, '2026-02-02T00:00:04.000Z');
  assert.equal(activity.durationMs, 3000);
});

test('messagesFromDesktopThread renders desktop plans and implementation requests as standalone messages', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        startedAt: 1770000000,
        completedAt: 1770000003,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '/plan 修复同步问题' }] },
          { id: 'plan-1', type: 'plan', status: 'completed', text: '1. 定位同步链路\n2. 补测试\n3. 修复' },
          {
            id: 'implement-plan:turn-1',
            type: 'planImplementation',
            turnId: 'turn-1',
            planContent: '1. 定位同步链路\n2. 补测试\n3. 修复',
            isCompleted: false
          }
        ]
      }
    ]
  }, { includeActivity: true });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'plan', 'plan_request']);
  const planMessage = messages.find((message) => message.role === 'plan');
  assert.equal(planMessage.content, '1. 定位同步链路\n2. 补测试\n3. 修复');
  assert.equal(planMessage.title, '计划');
  const requestMessage = messages.find((message) => message.role === 'plan_request');
  assert.equal(requestMessage.content, '实施此计划?');
  assert.equal(requestMessage.status, 'running');
  assert.deepEqual(requestMessage.planImplementation, {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '1. 定位同步链路\n2. 补测试\n3. 修复',
    completed: false
  });
  assert.equal(messages.some((message) => message.role === 'activity'), false);
});

test('messagesFromDesktopThread synthesizes a plan request when desktop exposes only the plan item', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        startedAt: 1770000000,
        completedAt: 1770000003,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '/plan 修复同步问题' }] },
          { id: 'plan-1', type: 'plan', status: 'completed', text: '# 修复计划\n\n## Summary\n处理移动端计划 UI。' }
        ]
      }
    ]
  }, { includeActivity: true });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'plan', 'plan_request']);
  assert.equal(messages[2].planImplementation.requestId, 'implement-plan:turn-1');
  assert.equal(messages[2].planImplementation.planContent, '# 修复计划\n\n## Summary\n处理移动端计划 UI。');
});

test('messagesFromDesktopThread converts proposed plan final answers into plan UI messages', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        startedAt: 1770000000,
        completedAt: 1770000003,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '/plan 修复同步问题' }] },
          {
            id: 'answer-1',
            type: 'agentMessage',
            phase: 'final_answer',
            text: '<proposed_plan>\n# 修复计划\n\n## Summary\n处理移动端计划 UI。\n</proposed_plan>'
          }
        ]
      }
    ]
  }, { includeActivity: true });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'plan', 'plan_request']);
  assert.equal(messages[1].title, '修复计划');
  assert.equal(messages[1].content, '# 修复计划\n\n## Summary\n处理移动端计划 UI。');
  assert.equal(messages[2].planImplementation.planContent, '# 修复计划\n\n## Summary\n处理移动端计划 UI。');
});

test('messagesFromDesktopThread renders internal implement-plan followups as a short user action', () => {
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-2',
        status: 'running',
        startedAt: 1770000005,
        items: [
          {
            id: 'user-2',
            type: 'userMessage',
            content: [{ type: 'text', text: 'PLEASE IMPLEMENT THIS PLAN:\n1. 定位同步链路\n2. 补测试' }]
          }
        ]
      }
    ]
  });

  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '执行计划');
});

test('messagesFromDesktopThread removes stale plan request after implementation starts', () => {
  const planContent = '# 修复计划\n\n## Summary\n处理移动端计划 UI。';
  const messages = messagesFromDesktopThread({
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        startedAt: 1770000000,
        completedAt: 1770000003,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '/plan 修复同步问题' }] },
          {
            id: 'answer-1',
            type: 'agentMessage',
            phase: 'final_answer',
            text: `<proposed_plan>\n${planContent}\n</proposed_plan>`
          }
        ]
      },
      {
        id: 'turn-2',
        status: 'running',
        startedAt: 1770000005,
        items: [
          {
            id: 'user-2',
            type: 'userMessage',
            content: [{ type: 'text', text: `PLEASE IMPLEMENT THIS PLAN:\n${planContent}` }]
          }
        ]
      }
    ]
  }, { includeActivity: true });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'plan', 'user']);
  assert.equal(messages[1].content, planContent);
  assert.equal(messages[2].content, '执行计划');
});

test('rawSessionActivitiesFromJsonl restores exec_command events omitted by desktop thread read', () => {
  const content = [
    {
      timestamp: '2026-02-02T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'rg foo client/src' })
      }
    },
    {
      timestamp: '2026-02-02T00:00:01.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Chunk ID: abc\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\nclient/src/App.jsx:foo'
      }
    }
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const activities = rawSessionActivitiesFromJsonl(content, [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:03.000Z') / 1000
    }
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].turnId, 'turn-1');
  assert.equal(activities[0].activity.kind, 'command_execution');
  assert.equal(activities[0].activity.status, 'completed');
  assert.equal(activities[0].activity.command, 'rg foo client/src');
  assert.equal(activities[0].activity.output, 'client/src/App.jsx:foo');
});

test('rawSessionActivitiesFromJsonl treats missing output in interrupted turns as terminal', () => {
  const content = JSON.stringify({
    timestamp: '2026-02-02T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'write_stdin',
      call_id: 'call-unfinished',
      arguments: JSON.stringify({ session_id: 123 })
    }
  });

  const activities = rawSessionActivitiesFromJsonl(content, [
    {
      id: 'turn-1',
      status: 'interrupted',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000
    }
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].activity.status, 'failed');
  assert.equal(activities[0].activity.label, '本地任务失败');
});

test('rawSessionActivitiesFromJsonl expands parallel exec_command calls', () => {
  const content = JSON.stringify({
    timestamp: '2026-02-02T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'parallel',
      call_id: 'call-parallel',
      arguments: JSON.stringify({
        tool_uses: [
          {
            recipient_name: 'functions.exec_command',
            parameters: { cmd: 'git status --short' }
          },
          {
            recipient_name: 'functions.exec_command',
            parameters: { cmd: 'npm run build' }
          }
        ]
      })
    }
  });

  const activities = rawSessionActivitiesFromJsonl(content, [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:03.000Z') / 1000
    }
  ]);

  assert.deepEqual(
    activities.map((item) => item.activity.command),
    ['git status --short', 'npm run build']
  );
});

test('rawSessionActivitiesFromJsonl preserves commentary and tool order', () => {
  const turnWindow = [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:10.000Z') / 1000
    }
  ];
  const content = [
    {
      timestamp: '2026-02-02T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '先看状态。' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'git status --short' })
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process exited with code 0\nOutput:\n M file.js'
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '再看页面。' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        namespace: 'mcp__playwright__',
        name: 'browser_snapshot',
        call_id: 'call-2',
        arguments: '{}'
      }
    },
    {
      timestamp: '2026-02-02T00:00:04.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-2',
        output: 'OK'
      }
    },
    {
      timestamp: '2026-02-02T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '完成。' }]
      }
    }
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const activities = rawSessionActivitiesFromJsonl(content, turnWindow);

  assert.deepEqual(
    activities.map((item) => item.activity.kind),
    ['agent_message', 'command_execution', 'agent_message', 'mcp_tool_call']
  );
  assert.deepEqual(
    activities.map((item) => item.activity.label),
    ['先看状态。', '本地任务已处理', '再看页面。', '已完成一步操作']
  );
});

test('rawSessionActivitiesFromJsonl assigns activity after steered user input to the guided segment', () => {
  const turnWindow = [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:10.000Z') / 1000
    }
  ];
  const content = [
    {
      timestamp: '2026-02-02T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '先修列表同步' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '先看状态。' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '再把移动端 UI 分开' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'rg steer client/src' })
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process exited with code 0\nOutput:\nclient/src/App.jsx:steer'
      }
    }
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const activities = rawSessionActivitiesFromJsonl(content, turnWindow);

  assert.deepEqual(
    activities.map((item) => [item.activity.kind, item.segmentIndex ?? 0]),
    [
      ['agent_message', 0],
      ['command_execution', 1]
    ]
  );
});

test('rawSessionActivitiesFromJsonl ignores hidden environment user rows when assigning guided segments', () => {
  const turnWindow = [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:10.000Z') / 1000
    }
  ];
  const content = [
    {
      timestamp: '2026-02-02T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\\n  <cwd>/tmp/project</cwd>\\n</environment_context>' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:00.010Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    },
    {
      timestamp: '2026-02-02T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '先修列表同步' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '先看状态。' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '再把移动端 UI 分开' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'rg steer client/src' })
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process exited with code 0\nOutput:\nclient/src/App.jsx:steer'
      }
    }
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const activities = rawSessionActivitiesFromJsonl(content, turnWindow);

  assert.deepEqual(
    activities.map((item) => [item.activity.kind, item.segmentIndex ?? 0]),
    [
      ['agent_message', 0],
      ['command_execution', 1]
    ]
  );
});

test('rawSessionActivitiesFromJsonl keeps context compaction at its JSONL position', () => {
  const turnWindow = [
    {
      id: 'turn-1',
      startedAt: Date.parse('2026-02-02T00:00:00.000Z') / 1000,
      completedAt: Date.parse('2026-02-02T00:00:10.000Z') / 1000
    }
  ];
  const content = [
    {
      timestamp: '2026-02-02T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '先读取现状。' }]
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'rg foo client/src' })
      }
    },
    {
      timestamp: '2026-02-02T00:00:02.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process exited with code 0\nOutput:\nclient/src/App.jsx:foo'
      }
    },
    {
      timestamp: '2026-02-02T00:00:03.000Z',
      type: 'compacted',
      payload: {}
    },
    {
      timestamp: '2026-02-02T00:00:03.001Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    },
    {
      timestamp: '2026-02-02T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '再继续验证。' }]
      }
    }
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const activities = rawSessionActivitiesFromJsonl(content, turnWindow);

  assert.deepEqual(
    activities.map((item) => item.activity.kind),
    ['agent_message', 'command_execution', 'context_compaction', 'agent_message']
  );
  assert.deepEqual(
    activities.map((item) => item.activity.label),
    ['先读取现状。', '本地任务已处理', '上下文已自动压缩', '再继续验证。']
  );
});
