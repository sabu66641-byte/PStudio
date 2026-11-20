/* PStudio persistent binary asset store (IndexedDB).
 * Large GLB files are stored as Blob records directly; never base64-expanded in JS memory.
 */
(() => {
  'use strict';
  const DB_NAME = 'pstudio-binary-assets';
  const STORE_NAME = 'models';
  const VERSION = 1;
  const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
  const LARGE_BLOB_CACHE_THRESHOLD = 64 * 1024 * 1024;
  let databasePromise = null;
  let persistencePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    let settled = false;
    const pending = new Promise((resolve, reject) => {
      const indexedDb = window.indexedDB;
      if (!indexedDb) {
        settled = true;
        reject(new Error('このブラウザではIndexedDBが利用できません。'));
        return;
      }
      let request;
      try { request = indexedDb.open(DB_NAME, VERSION); }
      catch (error) { settled = true; reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db?.close?.(); return; }
        settled = true;
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error || new Error('モデル保存領域を開けませんでした。'));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('モデル保存領域が別のタブで使用中です。'));
      };
    });
    databasePromise = pending.catch(error => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function requestPersistentStorage() {
    if (persistencePromise) return persistencePromise;
    persistencePromise = (async () => {
      const storage = window.navigator?.storage;
      if (typeof storage?.persist !== 'function') return false;
      try { return !!(await storage.persist()); }
      catch (_) { return false; }
    })();
    return persistencePromise;
  }

  async function storageEstimate() {
    const storage = window.navigator?.storage;
    if (typeof storage?.estimate !== 'function') return { supported: false, usage: null, quota: null, available: null };
    try {
      const value = await storage.estimate();
      const usage = Number.isFinite(value?.usage) ? value.usage : null;
      const quota = Number.isFinite(value?.quota) ? value.quota : null;
      return { supported: true, usage, quota, available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null };
    } catch (_) {
      return { supported: false, usage: null, quota: null, available: null };
    }
  }

  async function readRecord(name) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(String(name));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('モデルを読み込めませんでした。'));
      tx.onabort = () => reject(tx.error || new Error('モデル読み込みが中断されました。'));
    });
  }

  async function checkAvailableStorage(incomingBytes, previousBytes = 0) {
    const estimate = await storageEstimate();
    if (!estimate.supported || estimate.available === null || estimate.quota === null) return estimate;
    const available = estimate.available + Math.max(0, previousBytes);
    const reserve = Math.min(32 * 1024 * 1024, Math.max(8 * 1024 * 1024, incomingBytes * 0.02));
    if (available < incomingBytes + reserve) {
      const freeMiB = Math.floor(available / 1024 / 1024);
      const needMiB = Math.ceil((incomingBytes + reserve) / 1024 / 1024);
      throw new Error('端末の保存空き容量が不足しています（空き約' + freeMiB + 'MiB / 必要約' + needMiB + 'MiB）。不要な端末内データを整理して再試行してください。');
    }
    return { ...estimate, available };
  }

  async function put(name, blob, options = {}) {
    const key = String(name);
    if (!key) throw new TypeError('アセット名が空です。');
    if (!blob || !Number.isFinite(Number(blob.size))) throw new TypeError('保存するアセットがBlob/Fileではありません。');
    const size = Number(blob.size) || 0;
    if (size > MAX_MODEL_BYTES) throw new Error('GLBは1GB以下にしてください。');
    await requestPersistentStorage();
    const previous = await readRecord(key);
    const estimate = await checkAvailableStorage(size, previous?.size || 0);
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        name: key,
        blob,
        size,
        type: blob.type || 'model/gltf-binary',
        metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : null,
        updatedAt: Date.now()
      });
      let settled = false;
      const fail = error => { if (settled) return; settled = true; reject(error); };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        try { window.PStudioResources?.remove?.('binary-asset', key, { reason: 'asset-updated' }); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => fail(tx.error || new Error('モデルを保存できませんでした。'));
      tx.onabort = () => fail(tx.error || new Error('モデル保存が中断されました。'));
    }).catch(error => {
      const name = String(error?.name || '');
      if (name === 'QuotaExceededError') {
        throw new Error('IndexedDBの保存容量が不足しています。端末の空き容量を確保するか、古いアセットを削除してください。');
      }
      throw error;
    });
    try { window.dispatchEvent(new CustomEvent('pstudio-asset-stored', { detail: { name: key, size, availableBytes: estimate.available } })); } catch (_) {}
    return true;
  }

  async function get(name, options = {}) {
    const key = String(name);
    const record = await readRecord(key);
    if (!record?.blob) return null;
    const blob = record.blob;
    // Keep large Blob handles out of the in-memory LRU cache. IndexedDB remains the source of truth.
    if (options.cache === false || blob.size > LARGE_BLOB_CACHE_THRESHOLD || !window.PStudioResources?.getOrLoad) return blob;
    return window.PStudioResources.getOrLoad('binary-asset', key, async () => blob, {
      category: 'cpu',
      sizeBytes: Math.min(blob.size, LARGE_BLOB_CACHE_THRESHOLD),
      metadata: { persistent: true, store: STORE_NAME }
    });
  }

  async function getMetadata(name) {
    const record = await readRecord(String(name));
    return record?.metadata || null;
  }

  async function remove(name) {
    const key = String(name);
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => {
        try { window.PStudioResources?.remove?.('binary-asset', key, { reason: 'asset-removed' }); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => reject(tx.error || new Error('モデルを削除できませんでした。'));
      tx.onabort = () => reject(tx.error || new Error('モデル削除が中断されました。'));
    });
  }

  async function getStorageInfo() {
    const estimate = await storageEstimate();
    let persisted = false;
    try {
      if (typeof window.navigator?.storage?.persisted === 'function') persisted = !!(await window.navigator.storage.persisted());
    } catch (_) {}
    return { ...estimate, persisted, maxModelBytes: MAX_MODEL_BYTES };
  }

  window.PStudioAssetStore = {
    put, get, getMetadata, remove, getStorageInfo, requestPersistentStorage,
    maxModelBytes: MAX_MODEL_BYTES,
    version: '1.1.0'
  };
})();