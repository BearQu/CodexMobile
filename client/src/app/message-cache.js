const DB_NAME = 'codexmobile-message-cache';
const DB_VERSION = 1;
const STORE_NAME = 'sessionMessages';

let dbPromise = null;

export function sessionMessageCacheKey(sessionId) {
  return String(sessionId || '');
}

export function createSessionMessageCacheRecord(sessionId, payload) {
  const key = sessionMessageCacheKey(sessionId);
  const revision = typeof payload?.revision === 'string' ? payload.revision : '';
  if (!key || !revision || !Array.isArray(payload?.messages)) {
    return null;
  }
  return {
    key,
    revision,
    messages: payload.messages,
    context: payload.context || null,
    savedAt: Date.now()
  };
}

export function normalizeSessionMessageCacheRecord(sessionId, record) {
  const key = sessionMessageCacheKey(sessionId);
  if (!record || record.key !== key || !record.revision || !Array.isArray(record.messages)) {
    return null;
  }
  return {
    key,
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

export async function readCachedSessionMessages(sessionId) {
  try {
    const db = await openDb();
    if (!db) {
      return null;
    }
    const tx = db.transaction(STORE_NAME, 'readonly');
    const record = await requestToPromise(tx.objectStore(STORE_NAME).get(sessionMessageCacheKey(sessionId)));
    return normalizeSessionMessageCacheRecord(sessionId, record);
  } catch {
    return null;
  }
}

export async function writeCachedSessionMessages(sessionId, payload) {
  const record = createSessionMessageCacheRecord(sessionId, payload);
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
    await requestToPromise(tx.objectStore(STORE_NAME).delete(sessionMessageCacheKey(sessionId)));
    return true;
  } catch {
    return false;
  }
}
