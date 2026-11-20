const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/pstudio_assets.js', 'utf8');

function createStore(indexedDB) {
  const window = { indexedDB };
  vm.runInNewContext(source, { window, Promise, Date, Error });
  return { store: window.PStudioAssetStore, window };
}

function makeDatabase(blob) {
  return {
    objectStoreNames: { contains: () => true },
    transaction() {
      return {
        objectStore() {
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = { blob };
                request.onsuccess?.();
              });
              return request;
            }
          };
        }
      };
    },
    close() { this.closed = true; }
  };
}

test('asset store retries after IndexedDB is initially unavailable', async () => {
  const { store, window } = createStore(undefined);
  await assert.rejects(store.get('world.glb'), /IndexedDB/);

  const blob = { size: 4, type: 'model/gltf-binary' };
  const db = makeDatabase(blob);
  window.indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };

  assert.equal(await store.get('world.glb'), blob);
});

test('asset store retries after a blocked database open', async () => {
  let attempts = 0;
  const blob = { size: 8, type: 'model/gltf-binary' };
  const db = makeDatabase(blob);
  const { store } = createStore({
    open() {
      attempts += 1;
      const request = {};
      queueMicrotask(() => {
        if (attempts === 1) {
          request.onblocked?.();
        } else {
          request.result = db;
          request.onsuccess?.();
        }
      });
      return request;
    }
  });

  await assert.rejects(store.get('world.glb'), /別のタブ/);
  assert.equal(await store.get('world.glb'), blob);
  assert.equal(attempts, 2);
});

test('a blocked request that succeeds late closes its unused database connection', async () => {
  let firstRequest;
  const firstDb = makeDatabase(null);
  const blob = { size: 2, type: 'model/gltf-binary' };
  const activeDb = makeDatabase(blob);
  let attempts = 0;
  const { store } = createStore({
    open() {
      attempts += 1;
      const request = {};
      if (attempts === 1) {
        firstRequest = request;
        queueMicrotask(() => request.onblocked?.());
      } else {
        request.result = activeDb;
        queueMicrotask(() => request.onsuccess?.());
      }
      return request;
    }
  });

  await assert.rejects(store.get('late.glb'));
  assert.equal(await store.get('late.glb'), blob);
  firstRequest.result = firstDb;
  firstRequest.onsuccess?.();
  assert.equal(firstDb.closed, true);
});


function makeWritableDatabase() {
  const records = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {
        error: null,
        objectStore() {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => { request.result = records.get(String(key)) || null; request.onsuccess?.(); });
              return request;
            },
            put(record) {
              records.set(record.name, record);
              queueMicrotask(() => tx.oncomplete?.());
            },
            delete(key) {
              records.delete(String(key));
              queueMicrotask(() => tx.oncomplete?.());
            }
          };
        }
      };
      return tx;
    },
    records
  };
  return db;
}

test('large GLB limit is one GiB and Blob storage keeps the original Blob without base64 conversion', async () => {
  const db = makeWritableDatabase();
  const { store } = createStore({
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  });
  assert.equal(store.maxModelBytes, 1024 * 1024 * 1024);
  const blob = new Blob([new Uint8Array(128)], { type: 'model/gltf-binary' });
  await store.put('large-scene.glb', blob, { metadata: { estimatedRuntimeBytes: 512 } });
  assert.equal(db.records.get('large-scene.glb').blob, blob);
  assert.equal((await store.get('large-scene.glb', { cache: false })), blob);
  assert.deepEqual(await store.getMetadata('large-scene.glb'), { estimatedRuntimeBytes: 512 });
});

test('asset store rejects a model above the one GiB limit before IndexedDB access', async () => {
  const { store } = createStore(undefined);
  await assert.rejects(
    store.put('oversize.glb', { size: 1024 * 1024 * 1024 + 1, type: 'model/gltf-binary' }),
    /1GB/
  );
});

test('asset store checks browser quota and requests persistent storage before writing', async () => {
  let persistCalls = 0;
  const db = makeWritableDatabase();
  const windowState = {
    indexedDB: {
      open() {
        const request = { result: db };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    },
    navigator: {
      storage: {
        persist: async () => { persistCalls++; return true; },
        estimate: async () => ({ usage: 0, quota: 16 * 1024 * 1024 })
      }
    },
    dispatchEvent() {}
  };
  const sandbox = { window: windowState, Promise, Date, Error, TypeError, Number, Math, String, Object };
  vm.runInNewContext(source, sandbox);
  const blob = new Blob([new Uint8Array(10 * 1024 * 1024)], { type: 'model/gltf-binary' });
  await assert.rejects(windowState.PStudioAssetStore.put('quota.glb', blob), /保存空き容量が不足/);
  assert.equal(persistCalls, 1);
  assert.equal(db.records.has('quota.glb'), false);
});


test('large Blobs bypass the in-memory resource cache and are read directly from IndexedDB', async () => {
  const blob = { size: 128 * 1024 * 1024, type: 'model/gltf-binary' };
  const db = makeWritableDatabase();
  db.records.set('world.glb', { name: 'world.glb', blob, size: blob.size, metadata: null });
  const { store, window } = createStore({
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  });
  let cacheCalls = 0;
  window.PStudioResources = {
    getOrLoad() { cacheCalls++; throw new Error('large Blob should not enter the memory cache'); }
  };
  assert.equal(await store.get('world.glb'), blob);
  assert.equal(cacheCalls, 0);
});
