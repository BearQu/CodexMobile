import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnStartParams, shouldCompleteTurnFromAppServerItem, statusLabel } from './codex-runner.js';

test('statusLabel uses mobile-friendly command labels', () => {
  assert.equal(statusLabel('command_execution', 'running'), '正在处理本地任务');
  assert.equal(statusLabel('command_execution', 'completed'), '本地任务已处理');
  assert.equal(statusLabel('command_execution', 'failed'), '本地任务失败');
});

test('statusLabel uses mobile-friendly tool and file labels', () => {
  assert.equal(statusLabel('mcp_tool_call', 'running'), '正在完成一步操作');
  assert.equal(statusLabel('mcp_tool_call', 'completed'), '已完成一步操作');
  assert.equal(statusLabel('file_change', 'running'), '正在更新文件');
  assert.equal(statusLabel('file_change', 'completed'), '文件已更新');
});

test('completed final assistant item can finish a headless turn without turn completed notification', () => {
  assert.equal(
    shouldCompleteTurnFromAppServerItem('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      status: 'completed',
      text: '处理完成'
    }),
    true
  );
  assert.equal(
    shouldCompleteTurnFromAppServerItem('item/completed', {
      type: 'agentMessage',
      phase: 'commentary',
      status: 'completed',
      text: '正在处理'
    }),
    false
  );
  assert.equal(
    shouldCompleteTurnFromAppServerItem('item/started', {
      type: 'agentMessage',
      phase: 'final_answer',
      text: '还在输出'
    }),
    false
  );
});

test('buildTurnStartParams omits null collaboration mode', () => {
  const params = buildTurnStartParams({
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'hello' }],
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    model: 'gpt-5.5',
    effort: 'medium',
    collaborationMode: null
  });

  assert.equal(Object.hasOwn(params, 'collaborationMode'), false);
});

test('buildTurnStartParams preserves plan collaboration mode', () => {
  const collaborationMode = {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'medium',
      developer_instructions: null
    }
  };
  const params = buildTurnStartParams({
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'plan' }],
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    model: 'gpt-5.5',
    effort: 'medium',
    collaborationMode
  });

  assert.deepEqual(params.collaborationMode, collaborationMode);
});
