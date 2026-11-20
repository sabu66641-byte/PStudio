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
