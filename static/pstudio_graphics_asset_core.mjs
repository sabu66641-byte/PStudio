const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const DEFAULT_BUDGET = 256 * 1024 * 1024;

function assetId(value) {
  const id = String(value || "").trim();
  if (!ID.test(id)) throw new TypeError("Asset id must be a stable 1–128 character identifier.");
  return id;
}
function finiteBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Asset estimatedBytes must be a non-negative safe integer.");
  return bytes;
}
function cloneMetadata(value) {
  if (value == null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Asset metadata must be a plain record.");
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (item == null || ["string", "boolean"].includes(typeof item)) output[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else throw new TypeError("Asset metadata must contain only finite scalar values.");
  }
  return Object.freeze(output);
}
function normalizeDescriptor(input = {}) {
  const id = assetId(input.id);
  const type = String(input.type || "").trim().toLowerCase();
  if (!type || type.length > 64) throw new TypeError("Asset type is required and must not exceed 64 characters.");
  const domain = input.domain === "gpu" ? "gpu" : "cpu";
  const dependencies = Object.freeze([...new Set((input.dependencies || []).map(assetId))]);
  if (dependencies.includes(id)) throw new Error("An asset cannot depend on itself.");
  return Object.freeze({
    id, type, uri: input.uri == null ? null : String(input.uri),
    mimeType: input.mimeType == null ? null : String(input.mimeType),
    contentHash: input.contentHash == null ? null : String(input.contentHash),
    domain, estimatedBytes: finiteBytes(input.estimatedBytes),
    dependencies, metadata: cloneMetadata(input.metadata)
  });
}
function descriptorKey(descriptor) {
  return JSON.stringify({
    id: descriptor.id, type: descriptor.type, uri: descriptor.uri,
    mimeType: descriptor.mimeType, contentHash: descriptor.contentHash,
    domain: descriptor.domain, estimatedBytes: descriptor.estimatedBytes,
    dependencies: descriptor.dependencies, metadata: descriptor.metadata
  });
}

/**
 * PStudio-owned asset registry and loader boundary.
 * Formats are decoded by injected loaders; this module owns identity, dependency
 * references, cache budgets, leases and deterministic release, not a vendor loader.
 */
export function createPStudioGraphicsAssetCore(options = {}) {
  const records = new Map();
  const pending = new Map();
  const budgets = {
    cpu: finiteBytes(options.cpuBudgetBytes ?? DEFAULT_BUDGET),
    gpu: finiteBytes(options.gpuBudgetBytes ?? DEFAULT_BUDGET)
  };
  let clock = 0;
  let evicted = 0;
  let disposed = false;

  function assertLive() {
    if (disposed) throw new Error("PStudio Graphics Asset Core is disposed.");
  }
  function total(domain) {
    let bytes = 0;
    for (const record of records.values()) if (record.descriptor.domain === domain) bytes += record.descriptor.estimatedBytes;
    return bytes;
  }
  function releaseRecord(record, reason) {
    if (record.disposed) return false;
    record.disposed = true;
    for (const dependencyId of record.descriptor.dependencies) {
      const dependency = records.get(dependencyId);
      if (dependency) dependency.dependents = Math.max(0, dependency.dependents - 1);
    }
    try { record.dispose?.(record.value, reason); } catch (_) { record.disposeErrors += 1; }
    return true;
  }
  function trim(domain, targetBytes = budgets[domain]) {
    assertLive();
    if (!["cpu", "gpu"].includes(domain)) throw new TypeError("Asset domain must be cpu or gpu.");
    const target = finiteBytes(targetBytes);
    let current = total(domain);
    const candidates = [...records.values()]
      .filter(record => record.descriptor.domain === domain && record.refs === 0 && record.dependents === 0 && !record.pinned)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let removed = 0;
    for (const record of candidates) {
      if (current <= target) break;
      if (records.get(record.descriptor.id) !== record) continue;
      records.delete(record.descriptor.id);
      current -= record.descriptor.estimatedBytes;
      if (releaseRecord(record, "budget")) { removed += 1; evicted += 1; }
    }
    return removed;
  }
  function register(input, value, config = {}) {
    assertLive();
    const descriptor = normalizeDescriptor(input);
    if (records.has(descriptor.id)) throw new Error("PStudio asset already exists: " + descriptor.id);
    for (const dependencyId of descriptor.dependencies) {
      if (!records.has(dependencyId)) throw new Error("Asset dependency is not registered: " + dependencyId);
    }
    const limit = budgets[descriptor.domain];
    if (descriptor.estimatedBytes > limit) throw new RangeError("Asset exceeds its " + descriptor.domain + " memory budget.");
    // Lock dependencies before trimming so a referenced asset cannot be evicted
    // in the small window before the new dependent record is committed.
    for (const dependencyId of descriptor.dependencies) records.get(dependencyId).dependents += 1;
    try {
      trim(descriptor.domain, limit - descriptor.estimatedBytes);
      if (total(descriptor.domain) + descriptor.estimatedBytes > limit) throw new RangeError("Asset budget cannot admit the new asset without evicting retained resources.");
    } catch (error) {
      for (const dependencyId of descriptor.dependencies) records.get(dependencyId).dependents = Math.max(0, records.get(dependencyId).dependents - 1);
      throw error;
    }
    const record = {
      descriptor, value,
      dispose: typeof config.dispose === "function" ? config.dispose : null,
      pinned: config.pinned === true, refs: 0, dependents: 0, lastUsed: ++clock,
      disposed: false, disposeErrors: 0
    };
    records.set(descriptor.id, record);
    return Object.freeze({ descriptor, value });
  }
  function get(id) {
    assertLive();
    const record = records.get(String(id || ""));
    if (!record || record.disposed) return null;
    record.lastUsed = ++clock;
    return record.value;
  }
  function describe(id) {
    assertLive();
    return records.get(String(id || ""))?.descriptor || null;
  }
  function retain(id) {
    assertLive();
    const record = records.get(String(id || ""));
    if (!record || record.disposed) throw new Error("PStudio asset not found: " + id);
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
    const record = records.get(String(id || ""));
    if (!record) return false;
    if (record.refs > 0 && config.force !== true) throw new Error("Cannot remove a retained asset: " + id);
    if (record.dependents > 0) throw new Error("Cannot remove an asset while dependent assets reference it: " + id);
    records.delete(record.descriptor.id);
    releaseRecord(record, config.reason || "removed");
    return true;
  }
  async function load(input, loader, config = {}) {
    assertLive();
    if (typeof loader !== "function") throw new TypeError("Asset load requires an injected format loader.");
    const descriptor = normalizeDescriptor(input);
    const existing = records.get(descriptor.id);
    if (existing) {
      if (descriptorKey(existing.descriptor) !== descriptorKey(descriptor)) throw new Error("Asset id is already registered with a different descriptor: " + descriptor.id);
      existing.lastUsed = ++clock;
      return existing.value;
    }
    if (pending.has(descriptor.id)) {
      const pendingRecord = pending.get(descriptor.id);
      if (pendingRecord.key !== descriptorKey(descriptor)) throw new Error("Asset id is already loading with a different descriptor: " + descriptor.id);
      return (await pendingRecord.promise).value;
    }
    for (const dependencyId of descriptor.dependencies) if (!records.has(dependencyId)) throw new Error("Asset dependency is not registered: " + dependencyId);
    let loadedPayload = null;
    const promise = (async () => {
      try {
        const dependencyValues = Object.create(null);
        for (const dependencyId of descriptor.dependencies) dependencyValues[dependencyId] = get(dependencyId);
        const result = await loader(descriptor, Object.freeze(dependencyValues));
        loadedPayload = result && typeof result === "object" && (Object.prototype.hasOwnProperty.call(result, "value") || typeof result.dispose === "function")
          ? result : { value: result };
        if (loadedPayload.value === undefined || loadedPayload.value === null) throw new Error("Asset loader returned no resource value.");
        if (disposed) throw new Error("PStudio Asset Core was disposed while loading.");
        return register(descriptor, loadedPayload.value, { ...config, dispose: loadedPayload.dispose || config.dispose });
      } catch (error) {
        try { loadedPayload?.dispose?.(loadedPayload.value, "load-failed"); } catch (_) {}
        throw error;
      } finally {
        pending.delete(descriptor.id);
      }
    })();
    pending.set(descriptor.id, { key: descriptorKey(descriptor), promise });
    return (await promise).value;
  }
  function setBudget(domain, bytes) {
    assertLive();
    if (!["cpu", "gpu"].includes(domain)) throw new TypeError("Asset domain must be cpu or gpu.");
    budgets[domain] = finiteBytes(bytes);
    return trim(domain, budgets[domain]);
  }
  function stats() {
    let retainedCount = 0, dependentCount = 0, pinnedCount = 0, disposeErrors = 0;
    for (const record of records.values()) {
      if (record.refs > 0) retainedCount += 1;
      if (record.dependents > 0) dependentCount += 1;
      if (record.pinned) pinnedCount += 1;
      disposeErrors += record.disposeErrors;
    }
    return Object.freeze({
      assetCount: records.size, pendingCount: pending.size,
      cpuBytes: total("cpu"), gpuBytes: total("gpu"),
      cpuBudgetBytes: budgets.cpu, gpuBudgetBytes: budgets.gpu,
      retainedCount, dependentCount, pinnedCount, evictedCount: evicted,
      disposeErrors, disposed
    });
  }
  function dispose(config = {}) {
    if (disposed) return false;
    if (!config.force && [...records.values()].some(record => record.refs > 0)) throw new Error("PStudio Asset Core has retained assets; release leases or request force disposal.");
    const remaining = new Set(records.keys());
    while (remaining.size) {
      let progressed = false;
      for (const id of [...remaining]) {
        const record = records.get(id);
        if (!record || record.dependents === 0) {
          remaining.delete(id);
          if (record) remove(id, { force: true, reason: "core-disposed" });
          progressed = true;
        }
      }
      if (!progressed) throw new Error("PStudio Asset Core dependency graph contains a cycle.");
    }
    disposed = true;
    return true;
  }

  return Object.freeze({
    kind: "pstudio-graphics-asset-core",
    register, load, get, describe, retain, remove, trim, setBudget, stats, dispose
  });
}
