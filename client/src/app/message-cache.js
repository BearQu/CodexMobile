const DB_NAME = 'codexmobile-message-cache-v2';
const DB_VERSION = 1;
const STORE_NAME = 'sessionMessages';

let dbPromise = null;

export function sessionMessageCacheKey(sessionId, { activity = true } = {}) {
  const id = String(sessionId || '');
  if (!id) {
    return '';
  }
  return `${id}:${activity ? 'activity' : 'plain'}`;
}

function legacySessionMessageCacheKey(sessionId) {
  return String(sessionId || '');
}

export function createSessionMessageCacheRecord(sessionId, payload, options = {}) {
  const activity = options.activity !== false;
  const key = sessionMessageCacheKey(sessionId, { activity });
  const revision = typeof payload?.revision === 'string' ? payload.revision : '';
  if (!key || !revision || !Array.isArray(payload?.messages)) {
    return null;
  }
  return {
    key,
    activity,
    revision,
    messages: payload.messages,
    context: payload.context || null,
    savedAt: Date.now()
  };
}

export function normalizeSessionMessageCacheRecord(sessionId, record, options = {}) {
  const activity = options.activity !== false;
  const key = sessionMessageCacheKey(sessionId, { activity });
  const allowLegacyPlain = activity === false && record?.key === legacySessionMessageCacheKey(sessionId);
  if (!record || (record.key !== key && !allowLegacyPlain) || !record.revision || !Array.isArray(record.messages)) {
    return null;
  }
  return {
    key: record.key,
    activity: record.activity ?? activity,
    revision: record.revision,
    messages: record.messages,
    context: record.context || null,
    savedAt: Number(record.savedAt) || 0
  };
}

function openDb(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export async function readCachedSessionMessages(sessionId, options = {}) {
  try {
    const db = await openDb();
    if (!db) {
      return null;
    }
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const record = await requestToPromise(store.get(sessionMessageCacheKey(sessionId, options)));
    const normalized = normalizeSessionMessageCacheRecord(sessionId, record, options);
    if (normalized || options.activity !== false) {
      return normalized;
    }
    const legacyRecord = await requestToPromise(store.get(legacySessionMessageCacheKey(sessionId)));
    return normalizeSessionMessageCacheRecord(sessionId, legacyRecord, options);
  } catch {
    return null;
  }
}

export async function writeCachedSessionMessages(sessionId, payload, options = {}) {
  const record = createSessionMessageCacheRecord(sessionId, payload, options);
  if (!record) {
    return false;
  }
  try {
    const db = await openDb();
    if (!db) {
      return false;
    }
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await requestToPromise(tx.objectStore(STORE_NAME).put(record));
    return true;
  } catch {
    return false;
  }
}

export async function deleteCachedSessionMessages(sessionId) {
  try {
    const db = await openDb();
    if (!db) {
      return false;
    }
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await Promise.all([
      requestToPromise(store.delete(sessionMessageCacheKey(sessionId, { activity: true }))),
      requestToPromise(store.delete(sessionMessageCacheKey(sessionId, { activity: false }))),
      requestToPromise(store.delete(legacySessionMessageCacheKey(sessionId)))
    ]);
    return true;
  } catch {
    return false;
  }
}
