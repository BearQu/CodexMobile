import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionMessageCacheRecord,
  normalizeSessionMessageCacheRecord,
  sessionMessageCacheKey
} from './message-cache.js';

test('session message cache records only cache versioned pure message payloads', () => {
  const record = createSessionMessageCacheRecord('session-1', {
    revision: 'rollout.jsonl:12:1778202000000',
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    context: { inputTokens: 12 }
  });

  assert.equal(record.key, 'session-1');
  assert.equal(record.revision, 'rollout.jsonl:12:1778202000000');
  assert.deepEqual(record.messages.map((message) => message.id), ['m1']);
  assert.equal(record.context.inputTokens, 12);
  assert.equal(typeof record.savedAt, 'number');
});

test('session message cache rejects unversioned or mismatched records', () => {
  assert.equal(createSessionMessageCacheRecord('session-1', { messages: [] }), null);
  assert.equal(createSessionMessageCacheRecord('', { revision: 'r1', messages: [] }), null);
  assert.equal(createSessionMessageCacheRecord('session-1', { revision: 'r1', messages: null }), null);

  assert.equal(normalizeSessionMessageCacheRecord('session-1', {
    key: 'session-2',
    revision: 'r1',
    messages: []
  }), null);
});

test('session message cache keys are stable and session-scoped', () => {
  assert.equal(sessionMessageCacheKey('session/1'), 'session/1');
});
