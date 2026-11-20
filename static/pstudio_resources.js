/* PStudio Resource Manager 1.0.0
 * Shared CPU/GPU resource cache, reference leases, LRU budgets and deterministic disposal.
 */
(() => {
  'use strict';

  const records = new Map();
  const pending = new Map();
  const listeners = new Map();
  const budgets = new Map([
    ['cpu', 128 * 1024 * 1024],
    ['gpu', 128 * 1024 * 1024]
  ]);
  let sequence = 0;
  let disposedCount = 0;
  let evictedCount = 0;

  const makeId = (type, key) => {
    const a = String(type || '').trim();
    const b = String(key ?? '').trim();
    if (!a || !b) throw new TypeError('Resource type and key must be non-empty.');
    return a + '\u0000' + b;
  };
  const finiteBytes = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };

  function emit(type, detail) {
    const event = Object.freeze({ type, detail: detail || null, time: Date.now() });
    for (const callback of listeners.get(type) || []) {
      try { callback(event); } catch (error) { console.error('[PStudio Resources] listener failed:', error); }
    }
    try { window.dispatchEvent(new CustomEvent('pstudio-resource-' + type, { detail: event })); } catch (_) {}
    try { globalThis.PStudioEvents?.emit('resource.' + type, event); } catch (_) {}
  }

  function disposeRecord(record, reason) {
    if (!record || record.disposed) return false;
    record.disposed = true;
    try {
      if (typeof record.dispose === 'function') record.dispose(record.value, reason);
      else if (typeof record.value?.dispose === 'function') record.value.dispose();
    } catch (error) {
      emit('dispose-error', { type: record.type, key: record.key, error: String(error?.message || error) });
    }
    disposedCount++;
    emit('dispose', { type: record.type, key: record.key, reason });
    try { record.onEvict?.(record.value, reason); } catch (error) {
      console.error('[PStudio Resources] onEvict failed:', error);
    }
    return true;
  }

  function register(type, key, value, options = {}) {
    const id = makeId(type, key);
    const existing = records.get(id);
    if (existing) {
      if (existing.value === value) {
        existing.lastUsed = ++sequence;
        return existing;
      }
      if (existing.refCount > 0) throw new Error('Cannot replace a retained resource: ' + type + '/' + key);
      remove(type, key);
    }
    const category = options.category === 'gpu' ? 'gpu' : 'cpu';
    const record = {
      id, type: String(type), key: String(key), value,
      category,
      sizeBytes: options.sizeBytes === undefined ? finiteBytes(value?.size) : finiteBytes(options.sizeBytes),
      refCount: 0,
      pinned: options.pinned === true,
      dispose: options.dispose,
      onEvict: options.onEvict,
      metadata: options.metadata || null,
      lastUsed: ++sequence,
      disposed: false
    };
    records.set(id, record);
    emit('register', { type: record.type, key: record.key, category, sizeBytes: record.sizeBytes });
    trim(category, undefined, id);
    return record;
  }

  function get(type, key) {
    const record = records.get(makeId(type, key));
    if (!record || record.disposed) return null;
    record.lastUsed = ++sequence;
    return record.value;
  }

  function retain(type, key) {
    const record = records.get(makeId(type, key));
    if (!record || record.disposed) throw new Error('Resource not found: ' + type + '/' + key);
    record.refCount++;
    record.lastUsed = ++sequence;
    emit('retain', { type: record.type, key: record.key, refCount: record.refCount });
    let released = false;
    return Object.freeze({
      value: record.value,
      release() {
        if (released) return false;
        released = true;
        return release(type, key);
      }
    });
  }

  function release(type, key) {
    const record = records.get(makeId(type, key));
    if (!record || record.refCount <= 0) return false;
    record.refCount--;
    record.lastUsed = ++sequence;
    emit('release', { type: record.type, key: record.key, refCount: record.refCount });
    return true;
  }

  function remove(type, key, options = {}) {
    const id = makeId(type, key);
    const record = records.get(id);
    if (!record) return false;
    if (record.refCount > 0 && options.force !== true) {
      throw new Error('Cannot remove retained resource: ' + type + '/' + key);
    }
    records.delete(id);
    disposeRecord(record, options.reason || 'removed');
    return true;
  }

  async function getOrLoad(type, key, loader, options = {}) {
    if (typeof loader !== 'function') throw new TypeError('Resource loader must be a function.');
    const id = makeId(type, key);
    const cached = records.get(id);
    if (cached && !cached.disposed) {
      cached.lastUsed = ++sequence;
      return cached.value;
    }
    if (pending.has(id)) return pending.get(id);
    const promise = (async () => {
      const value = await loader();
      if (value === undefined || value === null) return null;
      const raced = records.get(id);
      if (raced && !raced.disposed) return raced.value;
      register(type, key, value, options);
      emit('load', { type: String(type), key: String(key) });
      return value;
    })().finally(() => {
      if (pending.get(id) === promise) pending.delete(id);
    });
    pending.set(id, promise);
    return promise;
  }

  function setBudget(category, bytes) {
    const key = category === 'gpu' ? 'gpu' : category === 'cpu' ? 'cpu' : null;
    if (!key) throw new TypeError('Resource budget category must be cpu or gpu.');
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) throw new TypeError('Resource budget must be a non-negative byte count.');
    budgets.set(key, Math.floor(n));
    return trim(key);
  }

  function trim(category, targetBytes, protectId) {
    const categories = category ? [category] : ['cpu', 'gpu'];
    let removed = 0;
    for (const kind of categories) {
      if (!budgets.has(kind)) throw new TypeError('Unknown resource category: ' + kind);
      const target = targetBytes === undefined ? budgets.get(kind) : finiteBytes(targetBytes);
      let total = 0;
      const candidates = [];
      for (const record of records.values()) {
        if (record.category !== kind) continue;
        total += record.sizeBytes;
        if (record.refCount === 0 && !record.pinned && record.id !== protectId) candidates.push(record);
      }
      candidates.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const record of candidates) {
        if (total <= target) break;
        if (records.get(record.id) !== record) continue;
        records.delete(record.id);
        total -= record.sizeBytes;
        if (disposeRecord(record, 'budget')) {
          removed++;
          evictedCount++;
          emit('evict', { type: record.type, key: record.key, category: kind, sizeBytes: record.sizeBytes });
        }
      }
    }
    return removed;
  }

  function clear(options = {}) {
    const category = options.category || null;
    const force = options.force === true;
    let removed = 0;
    for (const record of [...records.values()]) {
      if (category && record.category !== category) continue;
      if (record.refCount > 0 && !force) continue;
      if (remove(record.type, record.key, { force, reason: 'clear' })) removed++;
    }
    return removed;
  }

  function stats() {
    const result = {
      resourceCount: records.size,
      pendingCount: pending.size,
      retainedCount: 0,
      cpuBytes: 0,
      gpuBytes: 0,
      cpuBudgetBytes: budgets.get('cpu'),
      gpuBudgetBytes: budgets.get('gpu'),
      disposedCount,
      evictedCount,
      resources: []
    };
    for (const record of records.values()) {
      if (record.refCount > 0) result.retainedCount++;
      if (record.category === 'gpu') result.gpuBytes += record.sizeBytes;
      else result.cpuBytes += record.sizeBytes;
      result.resources.push({
        type: record.type, key: record.key, category: record.category,
        sizeBytes: record.sizeBytes, refCount: record.refCount,
        pinned: record.pinned, lastUsed: record.lastUsed
      });
    }
    return result;
  }

  function on(type, callback) {
    if (typeof callback !== 'function') throw new TypeError('Resource listener must be a function.');
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => listeners.get(type)?.delete(callback);
  }

  window.PStudioResources = Object.freeze({
    register, get, retain, release, remove, getOrLoad,
    setBudget, trim, clear, stats, on,
    version: '1.0.0'
  });
})();
