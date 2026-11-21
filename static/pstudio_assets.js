/* PStudio persistent binary asset store.
 * OPFS is the preferred large-asset backend; IndexedDB remains the compatibility fallback.
 * Both backends store Blob/File bytes directly. They never base64-expand binary models.
 */
(() => {
  'use strict';
  const DB_NAME = 'pstudio-binary-assets';
  const STORE_NAME = 'models';
  const VERSION = 1; // Keep v1 records readable; OPFS metadata fits the existing key/value store.
  const OPFS_DIRECTORY = 'pstudio-assets-v1';
  const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
  const LARGE_BLOB_CACHE_THRESHOLD = 64 * 1024 * 1024;
  let databasePromise = null;
  let persistencePromise = null;
  let opfsDirectoryPromise = null;

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

  function getOPFSDirectory() {
    const storage = window.navigator?.storage;
    if (typeof storage?.getDirectory !== 'function') return Promise.resolve(null);
    if (!opfsDirectoryPromise) {
      opfsDirectoryPromise = Promise.resolve()
        .then(() => storage.getDirectory())
        .then(root => root.getDirectoryHandle(OPFS_DIRECTORY, { create: true }))
        .catch(error => {
          opfsDirectoryPromise = null;
          try { window.dispatchEvent(new CustomEvent('pstudio-asset-backend-fallback', { detail: { backend: 'indexeddb', reason: String(error?.name || error) } })); } catch (_) {}
          return null;
        });
    }
    return opfsDirectoryPromise;
  }

  function createOPFSFileName() {
    const bytes = new Uint8Array(16);
    try {
      if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
      else throw new Error('crypto unavailable');
    } catch (_) {
      const seed = String(Date.now()) + '-' + String(Math.random()) + '-' + String(Math.random());
      for (let i = 0; i < bytes.length; i++) bytes[i] = (seed.charCodeAt(i % seed.length) * (i + 31) + i * 17) & 255;
    }
    return 'asset-' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('') + '.bin';
  }

  async function removeOPFSFile(directory, fileName) {
    if (!directory || !fileName) return false;
    try { await directory.removeEntry(String(fileName)); return true; }
    catch (error) { if (error?.name === 'NotFoundError') return false; throw error; }
  }

  async function writeOPFSFile(directory, fileName, blob) {
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      // FileSystemWritableFileStream accepts Blob directly; no app-owned ArrayBuffer copy is made.
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      try { await writable.abort?.(); } catch (_) {}
      try { await removeOPFSFile(directory, fileName); } catch (_) {}
      throw error;
    }
  }

  function isOPFSFallbackError(error) {
    const name = String(error?.name || '');
    return [
      'NotAllowedError', 'NotSupportedError', 'SecurityError', 'InvalidStateError',
      'QuotaExceededError', 'AbortError', 'UnknownError'
    ].includes(name);
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

  async function writeRecord(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      let settled = false;
      const fail = error => { if (settled) return; settled = true; reject(error); };
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(true); } };
      tx.onerror = () => fail(tx.error || new Error('モデル情報を保存できませんでした。'));
      tx.onabort = () => fail(tx.error || new Error('モデル情報の保存が中断されました。'));
    });
  }

  async function deleteRecord(name) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(String(name));
      let settled = false;
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(true); } };
      tx.onerror = () => { if (!settled) { settled = true; reject(tx.error || new Error('モデル情報を削除できませんでした。')); } };
      tx.onabort = () => { if (!settled) { settled = true; reject(tx.error || new Error('モデル情報の削除が中断されました。')); } };
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
      throw new Error('端末の保存空き容量が不足しています（空き約' + freeMiB + 'MiB / 必要約' + needMiB + 'MiB）。端末の空き容量を確保して再試行してください。');
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
    const baseRecord = {
      name: key, size, type: blob.type || 'model/gltf-binary',
      metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : null,
      updatedAt: Date.now()
    };
    let nextRecord = null;
    let opfsDirectory = null;
    let newOPFSFile = null;
    let fallbackReason = null;

    opfsDirectory = await getOPFSDirectory();
    if (opfsDirectory) {
      newOPFSFile = createOPFSFileName();
      try {
        await writeOPFSFile(opfsDirectory, newOPFSFile, blob);
        nextRecord = { ...baseRecord, storage: 'opfs', fileName: newOPFSFile };
      } catch (error) {
        newOPFSFile = null;
        if (!isOPFSFallbackError(error)) throw error;
        fallbackReason = String(error?.name || error?.message || error);
      }
    } else {
      fallbackReason = 'OPFS unavailable';
    }

    if (!nextRecord) {
      nextRecord = { ...baseRecord, storage: 'indexeddb', blob };
    }

    try {
      await writeRecord(nextRecord);
    } catch (error) {
      if (nextRecord.storage === 'opfs' && newOPFSFile) {
        try { await removeOPFSFile(opfsDirectory, newOPFSFile); } catch (_) {}
      }
      const name = String(error?.name || '');
      if (name === 'QuotaExceededError') {
        throw new Error('ブラウザの保存容量が不足しています。端末の空き容量を確保するか、不要なアセットを削除してください。');
      }
      throw error;
    }

    if (previous?.storage === 'opfs' && previous.fileName && previous.fileName !== newOPFSFile) {
      try { await removeOPFSFile(opfsDirectory || await getOPFSDirectory(), previous.fileName); } catch (error) {
        console.warn('[PStudio Assets] Replaced OPFS file could not be reclaimed:', error);
      }
    }
    try { window.PStudioResources?.remove?.('binary-asset', key, { reason: 'asset-updated' }); } catch (_) {}
    const backend = nextRecord.storage;
    try {
      window.dispatchEvent(new CustomEvent('pstudio-asset-stored', {
        detail: { name: key, size, storage: backend, fallbackReason, availableBytes: estimate.available }
      }));
    } catch (_) {}
    return true;
  }

  async function getRecordBlob(record) {
    if (!record) return null;
    if (record.storage === 'opfs' && record.fileName) {
      const directory = await getOPFSDirectory();
      if (directory) {
        try {
          const handle = await directory.getFileHandle(record.fileName);
          return await handle.getFile();
        } catch (error) {
          if (record.blob) return record.blob; // Read old transitional records defensively.
          if (error?.name !== 'NotFoundError') throw error;
          return null;
        }
      }
      if (record.blob) return record.blob;
      return null;
    }
    // Records created before OPFS support have no storage property and remain valid IndexedDB records.
    return record.blob || null;
  }

  async function get(name, options = {}) {
    const key = String(name);
    const record = await readRecord(key);
    const blob = await getRecordBlob(record);
    if (!blob) return null;
    // Keep large Blob/File handles out of the in-memory LRU cache. Persistent storage remains the source of truth.
    if (options.cache === false || blob.size > LARGE_BLOB_CACHE_THRESHOLD || !window.PStudioResources?.getOrLoad) return blob;
    return window.PStudioResources.getOrLoad('binary-asset', key, async () => blob, {
      category: 'cpu',
      sizeBytes: Math.min(blob.size, LARGE_BLOB_CACHE_THRESHOLD),
      metadata: { persistent: true, store: record?.storage || 'indexeddb' }
    });
  }

  async function getStream(name) {
    const blob = await get(name, { cache: false });
    if (!blob) return null;
    return typeof blob.stream === 'function' ? blob.stream() : null;
  }

  async function getMetadata(name) {
    const record = await readRecord(String(name));
    return record?.metadata || null;
  }

  async function getStorageBackend(name) {
    const record = await readRecord(String(name));
    if (!record) return null;
    return record.storage === 'opfs' ? 'opfs' : 'indexeddb';
  }

  async function remove(name) {
    const key = String(name);
    const record = await readRecord(key);
    await deleteRecord(key);
    if (record?.storage === 'opfs' && record.fileName) {
      const directory = await getOPFSDirectory();
      if (directory) {
        try { await removeOPFSFile(directory, record.fileName); }
        catch (error) { console.warn('[PStudio Assets] Removed asset metadata but could not reclaim OPFS file:', error); }
      }
    }
    try { window.PStudioResources?.remove?.('binary-asset', key, { reason: 'asset-removed' }); } catch (_) {}
    return true;
  }

  async function getStorageInfo() {
    const estimate = await storageEstimate();
    let persisted = false;
    try {
      if (typeof window.navigator?.storage?.persisted === 'function') persisted = !!(await window.navigator.storage.persisted());
    } catch (_) {}
    const directory = await getOPFSDirectory();
    return {
      ...estimate, persisted,
      opfsSupported: !!directory,
      preferredBackend: directory ? 'opfs' : 'indexeddb',
      maxModelBytes: MAX_MODEL_BYTES
    };
  }

  window.PStudioAssetStore = {
    put, get, getStream, getMetadata, getStorageBackend, remove,
    getStorageInfo, requestPersistentStorage,
    maxModelBytes: MAX_MODEL_BYTES,
    version: '2.0.0'
  };
})();
