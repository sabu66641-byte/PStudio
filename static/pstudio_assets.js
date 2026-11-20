/* PStudio persistent binary asset store (IndexedDB). */
(() => {
  'use strict';
  const DB_NAME = 'pstudio-binary-assets';
  const STORE_NAME = 'models';
  const VERSION = 1;
  let databasePromise = null;

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
      try {
        request = indexedDb.open(DB_NAME, VERSION);
      } catch (error) {
        settled = true;
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          // A blocked request may later succeed after this caller has already retried.
          db?.close?.();
          return;
        }
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

    databasePromise = pending.catch(error => {
      // Permit a later retry after a transient failure, unsupported browser or blocked upgrade.
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function put(name, blob) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        name: String(name),
        blob,
        size: Number(blob.size) || 0,
        type: blob.type || 'model/gltf-binary',
        updatedAt: Date.now()
      });
      tx.oncomplete = () => {
        try { window.PStudioResources?.remove?.('binary-asset', String(name), { reason: 'asset-updated' }); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => reject(tx.error || new Error('モデルを保存できませんでした。'));
      tx.onabort = () => reject(tx.error || new Error('モデル保存が中断されました。'));
    });
  }

  async function readBlob(name) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(String(name));
      request.onsuccess = () => resolve(request.result?.blob || null);
      request.onerror = () => reject(request.error || new Error('モデルを読み込めませんでした。'));
    });
  }

  async function get(name) {
    const key = String(name);
    if (window.PStudioResources?.getOrLoad) {
      return window.PStudioResources.getOrLoad('binary-asset', key, () => readBlob(key), {
        category: 'cpu',
        metadata: { persistent: true, store: STORE_NAME }
      });
    }
    return readBlob(key);
  }

  async function remove(name) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(String(name));
      tx.oncomplete = () => {
        try { window.PStudioResources?.remove?.('binary-asset', String(name), { reason: 'asset-removed' }); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => reject(tx.error || new Error('モデルを削除できませんでした。'));
    });
  }

  window.PStudioAssetStore = { put, get, remove, version: '1.0.0' };
})();