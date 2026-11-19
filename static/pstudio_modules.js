/* PStudio Module System 1.0.0
 * Dependency-aware module registry with transactional activation.
 * Modules are opt-in; this manager does not hot-unload existing core scripts.
 */
(() => {
  'use strict';

  const modules = new Map();
  const listeners = new Map();
  let initialized = false;
  let operation = Promise.resolve();

  const validId = id => /^[a-z][a-z0-9._-]{1,63}$/.test(String(id || ''));
  const normalizeIds = value => [...new Set((Array.isArray(value) ? value : []).map(String))];

  function emit(type, detail) {
    const event = Object.freeze({ type, detail: detail || null, time: Date.now() });
    for (const callback of listeners.get(type) || []) {
      try { callback(event); } catch (error) { console.error('[PStudio Modules] listener failed:', error); }
    }
    try { window.dispatchEvent(new CustomEvent('pstudio-module-' + type, { detail: event })); } catch (_) {}
  }

  function serialize(record) {
    return {
      id: record.id,
      version: record.version,
      description: record.description,
      dependencies: [...record.dependencies],
      optionalDependencies: [...record.optionalDependencies],
      conflicts: [...record.conflicts],
      enabled: record.enabled,
      state: record.state,
      error: record.error || null
    };
  }

  function register(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('Module definition must be an object.');
    const id = String(definition.id || '');
    if (!validId(id)) throw new TypeError('Module id must be 2–64 lowercase characters and may contain digits, dots, underscores or hyphens.');
    if (modules.has(id)) throw new Error('Module already registered: ' + id);
    const dependencies = normalizeIds(definition.dependencies);
    const optionalDependencies = normalizeIds(definition.optionalDependencies);
    const conflicts = normalizeIds(definition.conflicts);
    if ([...dependencies, ...optionalDependencies, ...conflicts].some(value => !validId(value))) throw new TypeError('Invalid module dependency or conflict id.');
    if (dependencies.includes(id) || optionalDependencies.includes(id) || conflicts.includes(id)) throw new Error('A module cannot depend on or conflict with itself.');
    if (definition.activate != null && typeof definition.activate !== 'function') throw new TypeError('activate must be a function.');
    if (definition.deactivate != null && typeof definition.deactivate !== 'function') throw new TypeError('deactivate must be a function.');
    const record = {
      id, version: String(definition.version || '1.0.0'),
      description: String(definition.description || ''),
      dependencies, optionalDependencies, conflicts,
      activate: definition.activate || null, deactivate: definition.deactivate || null,
      enabled: false, enabledByDefault: definition.enabledByDefault === true, state: 'registered', error: null,
      metadata: Object.freeze({ ...(definition.metadata || {}) })
    };
    modules.set(id, record);
    emit('registered', serialize(record));
    return serialize(record);
  }

  function get(id) {
    const record = modules.get(String(id));
    return record ? serialize(record) : null;
  }

  function list() {
    return [...modules.values()].map(serialize);
  }

  function resolveOrder(targetIds) {
    const result = [], temporary = new Set(), permanent = new Set();
    function visit(id) {
      const record = modules.get(id);
      if (!record) throw new Error('Required module is not registered: ' + id);
      if (permanent.has(id)) return;
      if (temporary.has(id)) throw new Error('Module dependency cycle detected at: ' + id);
      temporary.add(id);
      for (const dependency of record.dependencies) visit(dependency);
      temporary.delete(id);
      permanent.add(id);
      result.push(record);
    }
    for (const id of normalizeIds(targetIds)) visit(id);
    return result;
  }

  function checkConflicts(record, includePending = new Set()) {
    for (const conflict of record.conflicts) {
      if (modules.get(conflict)?.enabled || includePending.has(conflict)) {
        throw new Error('Module conflict: ' + record.id + ' conflicts with ' + conflict);
      }
    }
    for (const other of modules.values()) {
      if (other.enabled && other.conflicts.includes(record.id)) {
        throw new Error('Module conflict: ' + record.id + ' conflicts with ' + other.id);
      }
    }
  }

  async function enableInternal(ids) {
    const order = resolveOrder(ids);
    const pending = new Set(order.map(record => record.id));
    for (const record of order) checkConflicts(record, pending);
    const activated = [];
    try {
      for (const record of order) {
        if (record.enabled) continue;
        for (const dependency of record.dependencies) {
          if (!modules.get(dependency)?.enabled && !activated.some(item => item.id === dependency)) {
            throw new Error('Dependency is not enabled: ' + dependency);
          }
        }
        record.state = 'activating';
        record.error = null;
        await record.activate?.(Object.freeze({ id: record.id, modules: api }));
        record.enabled = true;
        record.state = 'enabled';
        activated.push(record);
        emit('enabled', serialize(record));
      }
      return order.map(serialize);
    } catch (error) {
      for (const record of activated.reverse()) {
        try { await record.deactivate?.(Object.freeze({ id: record.id, modules: api, rollback: true })); }
        catch (rollbackError) { console.error('[PStudio Modules] rollback failed:', record.id, rollbackError); }
        record.enabled = false;
        record.state = 'registered';
        emit('disabled', serialize(record));
      }
      const failed = order.find(record => record.state === 'activating');
      if (failed) { failed.state = 'error'; failed.error = String(error?.message || error); }
      throw error;
    }
  }

  async function disableInternal(id, options = {}) {
    id = String(id);
    const record = modules.get(id);
    if (!record) throw new Error('Module is not registered: ' + id);
    if (!record.enabled) return serialize(record);
    const dependents = [...modules.values()].filter(item => item.enabled && item.dependencies.includes(id));
    if (dependents.length && !options.cascade) {
      throw new Error('Cannot disable ' + id + '; enabled dependents: ' + dependents.map(item => item.id).join(', '));
    }
    if (options.cascade) {
      for (const dependent of dependents) await disableInternal(dependent.id, { cascade: true });
    }
    record.state = 'deactivating';
    try {
      await record.deactivate?.(Object.freeze({ id, modules: api, rollback: false }));
      record.enabled = false;
      record.state = 'registered';
      record.error = null;
      emit('disabled', serialize(record));
      return serialize(record);
    } catch (error) {
      record.state = 'error';
      record.error = String(error?.message || error);
      throw error;
    }
  }

  function enqueue(task) {
    const next = operation.then(task, task);
    operation = next.catch(() => {});
    return next;
  }

  function enable(id) { return enqueue(() => enableInternal([id])); }
  function enableMany(ids) { return enqueue(() => enableInternal(ids)); }
  function disable(id, options = {}) { return enqueue(() => disableInternal(id, options)); }

  async function initialize() {
    return enqueue(async () => {
      if (initialized) return list();
      const defaults = [...modules.values()].filter(record => record.enabledByDefault).map(record => record.id);
      if (defaults.length) await enableInternal(defaults);
      initialized = true;
      emit('initialized', { count: modules.size });
      return list();
    });
  }

  function unregister(id) {
    id = String(id);
    const record = modules.get(id);
    if (!record) return false;
    if (record.enabled) throw new Error('Disable module before unregistering: ' + id);
    const dependents = [...modules.values()].filter(item => item.dependencies.includes(id));
    if (dependents.length) throw new Error('Cannot unregister module; dependencies exist: ' + dependents.map(item => item.id).join(', '));
    modules.delete(id);
    emit('unregistered', { id });
    return true;
  }

  function on(type, callback) {
    if (typeof callback !== 'function') throw new TypeError('Listener must be a function.');
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => listeners.get(type)?.delete(callback);
  }

  const api = Object.freeze({
    register, unregister, get, list, resolveOrder,
    enable, enableMany, disable, initialize, on,
    version: '1.0.0'
  });
  window.PStudioModules = api;
})();
