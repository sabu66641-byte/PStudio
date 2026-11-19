/* PStudio persistent binary asset store (IndexedDB). */
(() => {
  'use strict';
  const DB_NAME = 'pstudio-binary-assets';
  const STORE_NAME = 'models';
  const VERSION = 1;
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('このブラウザではIndexedDBが利用できません。'));
        return;
      }
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('モデル保存領域を開けませんでした。'));
      request.onblocked = () => reject(new Error('モデル保存領域が別のタブで使用中です。'));
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