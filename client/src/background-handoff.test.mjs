import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBackgroundHandoffMessage,
  createBackgroundHandoff,
  shouldCreateBackgroundHandoff,
  updateBackgroundHandoffOnPayload,
  visibleBackgroundHandoff
} from './app/background-handoff.js';

test('background handoff is created only for IPC fallback runs', () => {
  assert.equal(shouldCreateBackgroundHandoff({
    desktopBridge: { mode: 'headless-local', reason: '桌面端 IPC 状态异常，已自动转后台 Codex 继续执行。' }
  }), true);
  assert.equal(shouldCreateBackgroundHandoff({
    desktopBridge: { mode: 'headless-local', reason: '桌面端不可用' }
  }), false);
});

test('background handoff tracks completion and visibility for restored desktop IPC', () => {
  const handoff = createBackgroundHandoff({
    projectId: 'project-1',
    sessionId: 'thread-1',
    turnId: 'turn-1',
    userMessage: '继续处理'
  });
  assert.equal(handoff.sessionId, 'thread-1');
  assert.equal(handoff.status, 'running');

  const completed = updateBackgroundHandoffOnPayload([handoff], {
    type: 'chat-complete',
    source: 'headless-local',
    sessionId: 'thread-1',
    turnId: 'turn-1',
    completedAt: '2026-05-14T07:00:00.000Z'
  });
  assert.equal(completed[0].status, 'completed');

  assert.equal(visibleBackgroundHandoff(completed, {
    selectedProject: { id: 'project-1' },
    selectedSession: { id: 'thread-1' },
    desktopBridge: { connected: true, mode: 'desktop-ipc' }
  })?.id, handoff.id);
  assert.equal(visibleBackgroundHandoff([{ ...completed[0], backgroundSessionId: 'background-thread-1' }], {
    selectedProject: { id: 'project-1' },
    selectedSession: { id: 'background-thread-1' },
    desktopBridge: { connected: true, mode: 'desktop-ipc' }
  }), null);
});

test('background handoff message reminds desktop to inspect current files', () => {
  const text = buildBackgroundHandoffMessage({
    reason: '桌面端 IPC 状态异常',
    userMessage: '修复同步',
    completedAt: '2026-05-14T07:00:00.000Z'
  });
  assert.match(text, /手机端因桌面 IPC 异常/);
  assert.match(text, /用户问题：修复同步/);
  assert.match(text, /当前仓库状态/);
});
