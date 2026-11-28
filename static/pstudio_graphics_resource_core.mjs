import { PStudioGraphicsError, createPStudioGraphicsResourceDescriptor } from './pstudio_graphics_contract.mjs';

export function createPStudioGraphicsResourceCore(options = {}) {
  const records = new Map();
  const pending = new Map();
  const budgets = {
    cpu: Math.max(0, Number(options.cpuBudgetBytes ?? 134217728)),
    gpu: Math.max(0, Number(options.gpuBudgetBytes ?? 134217728))
  };
  let clock = 0, evictedCount = 0, disposeErrors = 0, disposed = false;

  function assertLive() {
    if (disposed) throw new PStudioGraphicsError('Graphics Resource Core is disposed.', { code: 'PSTUDIO_GRAPHICS_RESOURCE_CORE_DISPOSED' });
  }
  function getRecord(id) { return records.get(String(id || '').trim()) || null; }
  function total(domain) {
    let value = 0;
    for (const record of records.values()) if (record.descriptor.domain === domain) value += record.descriptor.estimatedBytes;
    return value;
  }
  function releaseRecord(record, reason) {
    if (record.disposed) return false;
    record.disposed = true;
    try { record.dispose?.(record.value, reason); } catch (_) { disposeErrors += 1; }
    return true;
  }
  function trim(domain, targetBytes = budgets[domain], protectId = null) {
    assertLive();
    if (!['cpu', 'gpu'].includes(domain)) throw new TypeError('Resource domain must be cpu or gpu.');
    const target = Math.max(0, Math.floor(Number(targetBytes) || 0));
    let current = total(domain), removed = 0;
    const candidates = [...records.values()]
      .filter(record => record.descriptor.domain === domain && record.refs === 0 && !record.pinned && record.descriptor.id !== protectId)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const record of candidates) {
      if (current <= target) break;
      if (records.get(record.descriptor.id) !== record) continue;
      records.delete(record.descriptor.id);
      current -= record.descriptor.estimatedBytes;
      if (releaseRecord(record, 'budget')) { removed += 1; evictedCount += 1; }
    }
    return removed;
  }
  function register(input, value, config = {}) {
    assertLive();
    const descriptor = createPStudioGraphicsResourceDescriptor(input);
    if (records.has(descriptor.id)) throw new PStudioGraphicsError('Graphics resource already registered: ' + descriptor.id, { code: 'PSTUDIO_GRAPHICS_RESOURCE_DUPLICATE' });
    const record = { descriptor, value, dispose: config.dispose || null, pinned: config.pinned === true, refs: 0, lastUsed: ++clock, disposed: false };
    records.set(descriptor.id, record);
    trim(descriptor.domain, budgets[descriptor.domain], descriptor.id);
    return Object.freeze({ descriptor, value });
  }
  function get(id) {
    assertLive();
    const record = getRecord(id);
    if (!record || record.disposed) return null;
    record.lastUsed = ++clock;
    return record.value;
  }
  function describe(id) { return getRecord(id)?.descriptor || null; }
  function retain(id) {
    assertLive();
    const record = getRecord(id);
    if (!record || record.disposed) throw new Error('Graphics resource not found: ' + id);
    record.refs += 1;
    record.lastUsed = ++clock;
    let released = false;
    return Object.freeze({
      value: record.value,
      descriptor: record.descriptor,
      release() {
        if (released || record.disposed) return false;
        released = true;
        record.refs = Math.max(0, record.refs - 1);
        record.lastUsed = ++clock;
        return true;
      }
    });
  }
  function remove(id, config = {}) {
    assertLive();
    const record = getRecord(id);
    if (!record) return false;
    if (record.refs > 0 && config.force !== true) throw new PStudioGraphicsError('Cannot remove retained resource: ' + id, { code: 'PSTUDIO_GRAPHICS_RESOURCE_RETAINED' });
    records.delete(record.descriptor.id);
    releaseRecord(record, config.reason || 'removed');
    return true;
  }
  function setBudget(domain, value) {
    assertLive();
    const n = Number(value);
    if (!['cpu', 'gpu'].includes(domain) || !Number.isFinite(n) || n < 0) throw new TypeError('A valid CPU or GPU resource budget is required.');
    budgets[domain] = Math.floor(n);
    return trim(domain, budgets[domain]);
  }
  async function getOrCreate(input, factory, config = {}) {
    assertLive();
    if (typeof factory !== 'function') throw new TypeError('Resource factory must be a function.');
    const descriptor = createPStudioGraphicsResourceDescriptor(input);
    const cached = getRecord(descriptor.id);
    if (cached && !cached.disposed) { cached.lastUsed = ++clock; return cached.value; }
    if (pending.has(descriptor.id)) return pending.get(descriptor.id);
    const promise = (async () => {
      const value = await factory(descriptor);
      if (value == null) throw new PStudioGraphicsError('Resource factory returned no value.', { code: 'PSTUDIO_GRAPHICS_RESOURCE_FACTORY_EMPTY' });
      if (disposed) {
        try { config.dispose?.(value, 'core-disposed'); } catch (_) {}
        throw new PStudioGraphicsError('Resource Core was disposed during creation.', { code: 'PSTUDIO_GRAPHICS_RESOURCE_CORE_DISPOSED' });
      }
      const existing = getRecord(descriptor.id);
      if (existing && !existing.disposed) {
        try { config.dispose?.(value, 'duplicate-factory'); } catch (_) {}
        return existing.value;
      }
      register(descriptor, value, config);
      return value;
    })().finally(() => { if (pending.get(descriptor.id) === promise) pending.delete(descriptor.id); });
    pending.set(descriptor.id, promise);
    return promise;
  }
  function stats() {
    let retainedCount = 0, pinnedCount = 0;
    for (const record of records.values()) { if (record.refs > 0) retainedCount += 1; if (record.pinned) pinnedCount += 1; }
    return Object.freeze({
      resourceCount: records.size, pendingCount: pending.size, retainedCount, pinnedCount,
      cpuBytes: total('cpu'), gpuBytes: total('gpu'), cpuBudgetBytes: budgets.cpu, gpuBudgetBytes: budgets.gpu,
      evictedCount, disposeErrors,
      resources: Object.freeze([...records.values()].map(record => Object.freeze({
        id: record.descriptor.id, type: record.descriptor.type, domain: record.descriptor.domain,
        estimatedBytes: record.descriptor.estimatedBytes, retainCount: record.refs, pinned: record.pinned,
        lifetime: record.descriptor.lifetime
      })))
    });
  }
  function dispose(config = {}) {
    if (disposed) return false;
    const retained = [...records.values()].filter(record => record.refs > 0);
    if (retained.length && config.force !== true) throw new PStudioGraphicsError('Graphics Resource Core has retained resources.', {
      code: 'PSTUDIO_GRAPHICS_RESOURCE_CORE_RETAINED', details: { ids: retained.map(record => record.descriptor.id) }
    });
    disposed = true;
    for (const record of records.values()) releaseRecord(record, 'core-disposed');
    records.clear();
    return true;
  }
  return Object.freeze({ kind: 'pstudio-graphics-resource-core', register, get, describe, retain, remove, trim, setBudget, getOrCreate, stats, dispose });
}
