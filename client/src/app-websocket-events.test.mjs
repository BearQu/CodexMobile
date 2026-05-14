import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldCompleteLocalTurnBeforeRefresh,
  shouldRefreshDesktopThreadForPayload,
  shouldRefreshCurrentSessionAfterReconnect,
  shouldRenderActivityMessageForPayload,
  shouldRenderAssistantMessageForPayload,
  shouldRenderStatusMessageForPayload,
  shouldTrackStatusRuntime
} from './app/useAppWebSocket.js';

test('desktop IPC status updates drive runtime without rendering local activity cards', () => {
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'status-update',
      source: 'desktop-ipc',
      kind: 'turn',
      status: 'running'
    }),
    false
  );
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'status-update',
      source: 'desktop-ipc',
      kind: 'turn',
      status: 'completed'
    }),
    false
  );
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'status-update',
      source: 'headless-local',
      kind: 'turn',
      status: 'running'
    }),
    false
  );
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'status-update',
      source: 'headless-local',
      kind: 'reasoning',
      status: 'running'
    }),
    false
  );
});

test('external thread terminal events refresh after completing local turn state', () => {
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'chat-complete',
      source: 'desktop-ipc'
    }),
    true
  );
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'status-update',
      source: 'desktop-ipc',
      kind: 'turn',
      status: 'completed'
    }),
    true
  );
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'chat-complete',
      source: 'headless-local'
    }),
    true
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'chat-complete',
      source: 'desktop-ipc'
    }),
    true
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'status-update',
      source: 'desktop-ipc',
      kind: 'turn',
      status: 'completed'
    }),
    true
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'status-update',
      source: 'desktop-ipc',
      kind: 'turn',
      status: 'failed'
    }),
    false
  );
});

test('headless fallback activity and assistant updates are read from the thread like IPC', () => {
  assert.equal(
    shouldRenderActivityMessageForPayload({
      type: 'activity-update',
      source: 'headless-local',
      status: 'running'
    }),
    false
  );
  assert.equal(
    shouldRenderAssistantMessageForPayload({
      type: 'assistant-update',
      source: 'headless-local',
      content: '完成'
    }),
    false
  );
  assert.equal(
    shouldRenderActivityMessageForPayload({
      type: 'activity-update',
      status: 'running'
    }),
    true
  );
});

test('queued turn updates refresh the queue without rendering chat activity', () => {
  const payload = {
    type: 'status-update',
    kind: 'turn',
    status: 'queued'
  };

  assert.equal(shouldRenderStatusMessageForPayload(payload), false);
  assert.equal(shouldTrackStatusRuntime(payload), false);
  assert.equal(
    shouldTrackStatusRuntime({
      type: 'status-update',
      kind: 'reasoning',
      status: 'queued'
    }),
    true
  );
});

test('websocket reconnect refresh skips drafts and restores real selected sessions', () => {
  assert.equal(shouldRefreshCurrentSessionAfterReconnect({ id: 'thread-1' }), true);
  assert.equal(shouldRefreshCurrentSessionAfterReconnect({ id: 'draft-project-1' }), false);
  assert.equal(shouldRefreshCurrentSessionAfterReconnect(null), false);
});
