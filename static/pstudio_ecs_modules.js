/* PStudio ECS Module Lifecycle Bridge 1.0.0
 * PStudioModules remains authoritative for module dependencies and async hooks.
 * ECS keeps a runtime-only state mirror for gameplay/editor queries.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  const modules = window.PStudioModules;
  if (!ecs || !modules) {
    console.warn('[PStudio ECS Modules] ECS or PStudioModules is unavailable.');
    return;
  }

  const TYPE = 'ModuleState';
  const SOURCE = 'pstudio_ecs_modules';
  const entities = new Map();

  if (ecs.hasComponentType(TYPE)) {
    if (ecs.getComponentDefinition(TYPE)?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + TYPE);
    }
  } else {
    ecs.registerComponent(TYPE, {
      source: SOURCE,
      label: 'Module State',
      description: 'Runtime mirror of the PStudioModules registry; lifecycle execution stays in PStudioModules.',
      category: 'Modules',
      internal: true,
      persistent: false,
      readonly: true,
      additionalProperties: false,
      schema: {
        id: { type: 'string', required: true, maxLength: 64 },
        version: { type: 'string', default: '1.0.0', maxLength: 64 },
        enabled: { type: 'boolean', default: false },
        state: {
          type: 'enum',
          options: ['registered', 'activating', 'enabled', 'deactivating', 'error'],
          default: 'registered'
        },
        error: { type: 'string', default: '', maxLength: 1024 }
      },
      create: () => ({ id: '', version: '1.0.0', enabled: false, state: 'registered', error: '' })
    });
  }

  function entityExists(entity) {
    return Number.isSafeInteger(entity) && ecs.getEntities(true).includes(entity);
  }

  function remove(id) {
    const key = String(id);
    const entity = entities.get(key);
    entities.delete(key);
    if (entityExists(entity)) {
      try { ecs.destroyEntity(entity); } catch (error) {
        console.warn('[PStudio ECS Modules] Entity cleanup failed:', key, error);
      }
    }
    return entity !== undefined;
  }

  function upsert(record) {
    if (!record || typeof record !== 'object' || !record.id) return null;
    const id = String(record.id);
    let entity = entities.get(id);
    if (!entityExists(entity)) {
      entity = ecs.createEntity();
      entities.set(id, entity);
    }
    ecs.setComponent(entity, TYPE, {
      id,
      version: String(record.version || '1.0.0').slice(0, 64),
      enabled: record.enabled === true,
      state: ['registered', 'activating', 'enabled', 'deactivating', 'error'].includes(record.state)
        ? record.state : 'registered',
      error: String(record.error || '').slice(0, 1024)
    });
    return entity;
  }

  function sync() {
    const records = modules.list();
    const activeIds = new Set(records.map(record => String(record.id)));
    for (const id of [...entities.keys()]) if (!activeIds.has(id)) remove(id);
    for (const record of records) upsert(record);
    return entities.size;
  }

  function getState(id) {
    const entity = entities.get(String(id));
    if (!entityExists(entity)) return null;
    const data = ecs.getComponent(entity, TYPE);
    return Object.freeze({
      id: data.id, version: data.version, enabled: data.enabled,
      state: data.state, error: data.error
    });
  }

  function list() {
    return [...entities.keys()].sort().map(id => getState(id)).filter(Boolean);
  }

  modules.on('registered', event => upsert(event.detail));
  modules.on('state-changed', event => upsert(event.detail));
  modules.on('enabled', event => upsert(event.detail));
  modules.on('disabled', event => upsert(event.detail));
  modules.on('unregistered', event => remove(event.detail?.id));
  modules.on('initialized', sync);
  sync();

  window.PStudioECSModules = Object.freeze({
    version: '1.0.0',
    componentType: TYPE,
    sync,
    getState,
    list,
    getEntity(id) { return entities.get(String(id)) ?? null; },
    remove,
    clear() {
      for (const id of [...entities.keys()]) remove(id);
      return true;
    },
    getStats: () => Object.freeze({ moduleCount: entities.size })
  });
})();
