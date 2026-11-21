/* PStudio ECS 1.0.0
 * Sparse-set component storage and deterministic system scheduling.
 * Scene Objects are bridged without replacing the existing project format.
 */
(() => {
  'use strict';

  const COMPONENT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
  const SYSTEM_ID = /^[a-z][a-z0-9._-]{1,63}$/;
  const componentDefinitions = new Map();
  const componentStores = new Map();
  const systems = new Map();
  const orderedSystems = [];
  const entities = new Set();
  const entityActive = new Map();
  const listeners = new Map();
  const sceneEntityByObjectId = new Map();
  const sceneSnapshots = new Map();
  const deferred = [];
  let deferredHead = 0;

  let nextEntityId = 1;
  let systemSequence = 0;
  let iterationDepth = 0;
  let updating = false;
  let flushingDeferred = false;
  let enabled = true;

  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  class SparseSet {
    constructor() {
      this.entities = [];
      this.values = [];
      this.indices = new Map();
    }
    get size() { return this.entities.length; }
    has(entity) { return this.indices.has(entity); }
    get(entity) {
      const index = this.indices.get(entity);
      return index === undefined ? undefined : this.values[index];
    }
    set(entity, value) {
      const index = this.indices.get(entity);
      if (index !== undefined) {
        this.values[index] = value;
        return false;
      }
      this.indices.set(entity, this.entities.length);
      this.entities.push(entity);
      this.values.push(value);
      return true;
    }
    delete(entity) {
      const index = this.indices.get(entity);
      if (index === undefined) return false;
      const lastIndex = this.entities.length - 1;
      const lastEntity = this.entities[lastIndex];
      if (index !== lastIndex) {
        this.entities[index] = lastEntity;
        this.values[index] = this.values[lastIndex];
        this.indices.set(lastEntity, index);
      }
      this.entities.pop();
      this.values.pop();
      this.indices.delete(entity);
      return true;
    }
    clear() {
      this.entities.length = 0;
      this.values.length = 0;
      this.indices.clear();
    }
  }

  function emit(type, detail) {
    const event = Object.freeze({ type, detail: detail || null, time: Date.now() });
    for (const callback of listeners.get(type) || []) {
      try { callback(event); }
      catch (error) { console.error('[PStudio ECS] listener failed:', error); }
    }
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('pstudio-ecs-' + type, { detail: event }));
      }
    } catch (_) {}
    try { globalThis.PStudioEvents?.emit('ecs.' + type, event); } catch (_) {}
  }

  function requireComponentType(type) {
    const key = String(type || '');
    if (!componentDefinitions.has(key)) throw new Error('ECS component is not registered: ' + key);
    return key;
  }

  function requireEntity(entity) {
    const id = Number(entity);
    if (!Number.isSafeInteger(id) || !entities.has(id)) {
      throw new Error('ECS entity does not exist: ' + String(entity));
    }
    return id;
  }

  function assertStructureMutable() {
    if (iterationDepth > 0) {
      throw new Error('ECS structure cannot change inside forEach(); use ecs.defer() instead.');
    }
  }

  function normalizeComponent(type, value, entity) {
    const definition = componentDefinitions.get(type);
    let result = value;
    if (result === undefined && typeof definition.create === 'function') {
      result = definition.create(entity);
    }
    if (result === undefined) result = {};
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('ECS component data must be an object: ' + type);
    }
    if (typeof definition.normalize === 'function') {
      result = definition.normalize(result, entity);
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('ECS component normalizer returned invalid data: ' + type);
      }
    }
    if (typeof definition.validate === 'function' && definition.validate(result, entity) === false) {
      throw new TypeError('ECS component validation failed: ' + type);
    }
    return result;
  }

  function registerComponent(type, options) {
    const key = String(type || '');
    const settings = options || {};
    if (!COMPONENT_ID.test(key) || ['constructor', 'prototype'].includes(key)) throw new Error('Invalid ECS component type: ' + key);
    if (componentDefinitions.has(key)) throw new Error('ECS component is already registered: ' + key);
    for (const hook of ['create', 'normalize', 'validate', 'onAdd', 'onRemove']) {
      if (settings[hook] !== undefined && typeof settings[hook] !== 'function') {
        throw new TypeError('Component option "' + hook + '" must be a function.');
      }
    }
    componentDefinitions.set(key, {
      create: settings.create || null,
      normalize: settings.normalize || null,
      validate: settings.validate || null,
      onAdd: settings.onAdd || null,
      onRemove: settings.onRemove || null
    });
    componentStores.set(key, new SparseSet());
    emit('component-registered', { type: key });
    return key;
  }

  function addComponent(entity, type, value) {
    assertStructureMutable();
    const id = requireEntity(entity);
    const key = requireComponentType(type);
    const store = componentStores.get(key);
    if (store.has(id)) throw new Error('Entity already has component "' + key + '": ' + id);
    const data = normalizeComponent(key, value, id);
    store.set(id, data);
    try {
      const hook = componentDefinitions.get(key).onAdd;
      if (hook) hook(id, data, api);
    } catch (error) {
      store.delete(id);
      throw error;
    }
    emit('component-added', { entity: id, type: key });
    return data;
  }

  function setComponent(entity, type, value) {
    const id = requireEntity(entity);
    const key = requireComponentType(type);
    const store = componentStores.get(key);
    if (!store.has(id)) {
      assertStructureMutable();
      return addComponent(id, key, value);
    }
    const data = normalizeComponent(key, value, id);
    store.set(id, data);
    emit('component-updated', { entity: id, type: key });
    return data;
  }

  function getComponent(entity, type) {
    const id = requireEntity(entity);
    const key = requireComponentType(type);
    return componentStores.get(key).get(id) ?? null;
  }

  function hasComponent(entity, type) {
    const id = requireEntity(entity);
    const key = requireComponentType(type);
    return componentStores.get(key).has(id);
  }

  function removeComponent(entity, type) {
    assertStructureMutable();
    const id = requireEntity(entity);
    const key = requireComponentType(type);
    const store = componentStores.get(key);
    if (!store.has(id)) return false;
    const data = store.get(id);
    store.delete(id);
    const hook = componentDefinitions.get(key).onRemove;
    if (hook) {
      try { hook(id, data, api); }
      catch (error) { console.error('[PStudio ECS] component onRemove failed:', error); }
    }
    emit('component-removed', { entity: id, type: key });
    return true;
  }

  function createEntity(initialComponents) {
    assertStructureMutable();
    const id = nextEntityId++;
    entities.add(id);
    entityActive.set(id,true);
    try {
      if (initialComponents) {
        for (const [type, value] of Object.entries(initialComponents)) addComponent(id, type, value);
      }
    } catch (error) {
      destroyEntityInternal(id);
      throw error;
    }
    emit('entity-created', { entity: id });
    return id;
  }

  function destroyEntityInternal(id) {
    if (!entities.has(id)) return false;
    for (const [type, store] of componentStores) {
      if (!store.has(id)) continue;
      const data = store.get(id);
      store.delete(id);
      const hook = componentDefinitions.get(type).onRemove;
      if (hook) {
        try { hook(id, data, api); }
        catch (error) { console.error('[PStudio ECS] component onRemove failed:', error); }
      }
    }
    entities.delete(id);
    entityActive.delete(id);
    emit('entity-destroyed', { entity: id });
    return true;
  }

  function destroyEntity(entity) {
    assertStructureMutable();
    return destroyEntityInternal(requireEntity(entity));
  }

  function normalizeTypes(types) {
    if (types == null) return [];
    const list = Array.isArray(types) ? types : [types];
    return [...new Set(list.map(type => requireComponentType(type)))];
  }

  function matchingBase(types) {
    if (!types.length) return null;
    let base = null;
    for (const type of types) {
      const store = componentStores.get(type);
      if (!base || store.size < base.size) base = store;
    }
    return base;
  }

  function query(types) {
    const required = normalizeTypes(types);
    const base = matchingBase(required);
    const result = [];
    const source = base ? base.entities : entities;
    for (const id of source) {
      if (entities.has(id) && entityActive.get(id)!==false && required.every(type => componentStores.get(type).has(id))) result.push(id);
    }
    result.sort((a, b) => a - b);
    return result;
  }

  function forEach(types, callback) {
    if (typeof callback !== 'function') throw new TypeError('ECS forEach callback must be a function.');
    const required = normalizeTypes(types);
    const stores = required.map(type => componentStores.get(type));
    let base = null;
    for (const store of stores) if (!base || store.size < base.size) base = store;
    iterationDepth++;
    try {
      if (!stores.length) {
        for (const id of entities) if(entityActive.get(id)!==false)callback(id);
      } else {
        const limit = base.entities.length;
        for (let index = 0; index < limit; index++) {
          const id = base.entities[index];
          if (!entities.has(id) || entityActive.get(id)===false) continue;
          let matches = true;
          for (const store of stores) {
            if (!store.has(id)) { matches = false; break; }
          }
          if (!matches) continue;
          if (stores.length === 1) {
            callback(id, stores[0].get(id));
          } else if (stores.length === 2) {
            callback(id, stores[0].get(id), stores[1].get(id));
          } else {
            const args = new Array(stores.length + 1);
            args[0] = id;
            for (let i = 0; i < stores.length; i++) args[i + 1] = stores[i].get(id);
            callback.apply(null, args);
          }
        }
      }
    } finally {
      iterationDepth--;
      if (iterationDepth === 0 && !updating) flushDeferred();
    }
  }

  function registerSystem(options) {
    const settings = options || {};
    const id = String(settings.id || '');
    if (!SYSTEM_ID.test(id)) throw new Error('Invalid ECS system id: ' + id);
    if (systems.has(id)) throw new Error('ECS system is already registered: ' + id);
    if (typeof settings.update !== 'function') throw new TypeError('ECS system update must be a function: ' + id);
    const required = normalizeTypes(settings.components || settings.requiredComponents || []);
    const priority = finite(settings.priority, 0);
    const record = {
      id,
      components: required,
      priority,
      sequence: systemSequence++,
      enabled: settings.enabled !== false,
      update: settings.update
    };
    systems.set(id, record);
    orderedSystems.push(record);
    orderedSystems.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    emit('system-registered', { id, priority, components: required.slice() });
    return id;
  }

  function unregisterSystem(id) {
    const key = String(id || '');
    const record = systems.get(key);
    if (!record) return false;
    systems.delete(key);
    const index = orderedSystems.indexOf(record);
    if (index >= 0) orderedSystems.splice(index, 1);
    emit('system-unregistered', { id: key });
    return true;
  }

  function setSystemEnabled(id, value) {
    const record = systems.get(String(id || ''));
    if (!record) throw new Error('ECS system is not registered: ' + String(id));
    record.enabled = !!value;
    emit('system-state-changed', { id: record.id, enabled: record.enabled });
    return record.enabled;
  }

  function setSystemPriority(id, value) {
    const record = systems.get(String(id || ''));
    if (!record) throw new Error('ECS system is not registered: ' + String(id));
    const priority = Number(value);
    if (!Number.isFinite(priority)) throw new TypeError('ECS system priority must be a finite number.');
    record.priority = priority;
    orderedSystems.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    emit('system-priority-changed', { id: record.id, priority });
    return priority;
  }

  function getSystems() {
    return orderedSystems.map(system => ({
      id: system.id,
      priority: system.priority,
      enabled: system.enabled,
      components: system.components.slice(),
      sequence: system.sequence
    }));
  }

  function getEntities(includeInactive) {
    return Array.from(entities)
      .filter(id => includeInactive === true || entityActive.get(id) !== false)
      .sort((a, b) => a - b);
  }

  function getComponentTypes() {
    return Array.from(componentDefinitions.keys()).sort();
  }

  function getEntityComponents(entity) {
    const id = requireEntity(entity);
    const result = [];
    for (const [type, store] of componentStores) {
      if (store.has(id)) result.push({ type, data: store.get(id) });
    }
    result.sort((a, b) => a.type.localeCompare(b.type));
    return result;
  }

  function flushDeferred() {
    if (flushingDeferred || iterationDepth > 0 || updating || deferredHead >= deferred.length) return;
    flushingDeferred = true;
    let processed = 0;
    try {
      while (deferredHead < deferred.length) {
        if (++processed > 100000) throw new Error('ECS deferred operation limit exceeded.');
        const action = deferred[deferredHead++];
        action(api);
      }
    } finally {
      if (deferredHead >= deferred.length) {
        deferred.length = 0;
        deferredHead = 0;
      }
      flushingDeferred = false;
    }
  }

  function defer(action) {
    if (typeof action !== 'function') throw new TypeError('ECS defer expects a function.');
    deferred.push(action);
    if (iterationDepth === 0 && !updating) flushDeferred();
    return deferred.length - deferredHead;
  }

  function update(deltaTime, context) {
    if (!enabled) return false;
    if (updating) throw new Error('ECS update() cannot be called recursively.');
    const dt = Number(deltaTime);
    if (!Number.isFinite(dt) || dt < 0) throw new TypeError('ECS delta time must be a finite non-negative number.');
    updating = true;
    try {
      const frameSystems = orderedSystems.slice();
      for (const system of frameSystems) {
        if (!system.enabled || !systems.has(system.id)) continue;
        try { system.update(dt, api, context || null); }
        catch (error) {
          const detail = error && error.message ? error.message : String(error);
          const wrapped = new Error('[ECS system "' + system.id + '"] ' + detail);
          wrapped.cause = error;
          throw wrapped;
        }
      }
    } finally {
      updating = false;
      flushDeferred();
    }
    return true;
  }

  function clearEntities() {
    assertStructureMutable();
    for (const id of Array.from(entities)) destroyEntityInternal(id);
    return true;
  }

  function setEntityActive(entity,active){const id=requireEntity(entity);entityActive.set(id,!!active);return entityActive.get(id);}
  function stats() {
    const componentCounts = Object.create(null);
    for (const [type, store] of componentStores) componentCounts[type] = store.size;
    let enabledSystemCount = 0;
    for (const system of orderedSystems) if (system.enabled) enabledSystemCount++;
    return {
      entityCount: entities.size,
      inactiveEntityCount:[...entityActive.values()].filter(value=>value===false).length,
      componentCounts,
      componentTypeCount: componentDefinitions.size,
      systemCount: systems.size,
      enabledSystemCount,
      enabled
    };
  }

  function readSceneTransform(object) {
    return {
      x: finite(object.x, 0),
      y: finite(object.y, 0),
      z: finite(object.z, 0),
      rotationX: finite(object.rotationX, 0),
      rotationY: finite(object.rotationY, 0),
      rotationZ: finite(object.rotationZ, 0),
      scaleX: finite(object.scaleX, 1),
      scaleY: finite(object.scaleY, 1),
      scaleZ: finite(object.scaleZ, 1)
    };
  }

  function copyTransform(target, source) {
    for (const key of ['x', 'y', 'z', 'rotationX', 'rotationY', 'rotationZ', 'scaleX', 'scaleY', 'scaleZ']) {
      target[key] = source[key];
    }
  }

  function transformsDiffer(a, b) {
    if (!a || !b) return true;
    for (const key of ['x', 'y', 'z', 'rotationX', 'rotationY', 'rotationZ', 'scaleX', 'scaleY', 'scaleZ']) {
      if (!Object.is(a[key], b[key])) return true;
    }
    return false;
  }

  function restoreSceneObjectComponents(entity, object) {
    const entries = Array.isArray(object.ecsComponents) ? object.ecsComponents : [];
    for (const entry of entries) {
      const type = typeof entry?.type === 'string' ? entry.type : '';
      if (!COMPONENT_ID.test(type) || type === 'Transform' || type === 'SceneObjectRef') continue;
      if (!componentDefinitions.has(type)) {
        try { registerComponent(type); }
        catch (error) {
          console.warn('[PStudio ECS] skipped invalid saved component type:', type, error);
          continue;
        }
      }
      const store = componentStores.get(type);
      if (!store || store.has(entity)) continue;
      const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {};
      try { addComponent(entity, type, data); }
      catch (error) {
        console.warn('[PStudio ECS] skipped invalid saved component:', type, error);
      }
    }
  }

  function syncSceneObjects(sceneObjects) {
    if (!Array.isArray(sceneObjects)) throw new TypeError('syncSceneObjects expects an array.');
    const seen = new Set();
    for (const object of sceneObjects) {
      if (!object || object.id === undefined || object.id === null || String(object.id) === '') {
        throw new Error('Every Scene Object must have a non-empty id before ECS synchronization.');
      }
      const objectId = String(object.id);
      if (seen.has(objectId)) throw new Error('Duplicate Scene Object id: ' + objectId);
      seen.add(objectId);
    }

    for (const object of sceneObjects) {
      const objectId = String(object.id);
      const source = readSceneTransform(object);
      let entity = sceneEntityByObjectId.get(objectId);
      if (!entity || !entities.has(entity)) {
        entity = createEntity({
          Transform: source,
          SceneObjectRef: { sceneObjectId: objectId, name: String(object.name || '') }
        });
        sceneEntityByObjectId.set(objectId, entity);
        sceneSnapshots.set(entity, Object.assign({}, source));
        restoreSceneObjectComponents(entity, object);
        continue;
      }

      const transform = getComponent(entity, 'Transform');
      const snapshot = sceneSnapshots.get(entity);
      const sceneChanged = transformsDiffer(source, snapshot);
      const ecsChanged = transformsDiffer(transform, snapshot);
      if (sceneChanged || !snapshot) {
        copyTransform(transform, source);
      } else if (ecsChanged) {
        copyTransform(object, transform);
      }
      const canonical = sceneChanged || !snapshot ? source : transform;
      sceneSnapshots.set(entity, Object.assign({}, canonical));
      const ref = getComponent(entity, 'SceneObjectRef');
      ref.name = String(object.name || '');
      restoreSceneObjectComponents(entity, object);
    }

    for (const [objectId, entity] of Array.from(sceneEntityByObjectId.entries())) {
      if (seen.has(objectId)) continue;
      if (entities.has(entity)) destroyEntity(entity);
      sceneEntityByObjectId.delete(objectId);
      sceneSnapshots.delete(entity);
    }
    return sceneEntityByObjectId.size;
  }

  function applySceneObjectTransforms(sceneObjects) {
    if (!Array.isArray(sceneObjects)) throw new TypeError('applySceneObjectTransforms expects an array.');
    let applied = 0;
    for (const object of sceneObjects) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = sceneEntityByObjectId.get(String(object.id));
      if (!entity || !entities.has(entity) || entityActive.get(entity)===false) continue;
      const transform = getComponent(entity, 'Transform');
      copyTransform(object, transform);
      sceneSnapshots.set(entity, Object.assign({}, transform));
      applied++;
    }
    return applied;
  }

  function clearSceneObjects() {
    for (const [objectId, entity] of Array.from(sceneEntityByObjectId.entries())) {
      if (entities.has(entity)) destroyEntity(entity);
      sceneEntityByObjectId.delete(objectId);
      sceneSnapshots.delete(entity);
    }
    return true;
  }

  function getEntityForSceneObject(objectId) {
    const id = sceneEntityByObjectId.get(String(objectId));
    return id && entities.has(id) ? id : null;
  }
  function setSceneObjectActive(objectId,active){const entity=getEntityForSceneObject(objectId);if(!entity)return false;return setEntityActive(entity,active);}

  const api = {
    registerComponent,
    registerSystem,
    unregisterSystem,
    setSystemEnabled,
    setSystemPriority,
    getSystems,
    getEntities,
    getComponentTypes,
    getEntityComponents,
    createEntity,
    destroyEntity,
    addComponent,
    setComponent,
    getComponent,
    hasComponent,
    removeComponent,
    query,
    forEach,
    defer,
    update,
    clearEntities,
    setEnabled(value) { enabled = !!value; emit('enabled-changed', { enabled }); return enabled; },
    isEnabled() { return enabled; },
    hasActiveSystems() { return enabled && orderedSystems.some(system => system.enabled); },
    on(type, callback) {
      if (typeof callback !== 'function') throw new TypeError('ECS listener must be a function.');
      const key = String(type);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      return () => listeners.get(key)?.delete(callback);
    },
    stats,
    syncSceneObjects,
    applySceneObjectTransforms,
    clearSceneObjects,
    getEntityForSceneObject,
    setEntityActive,
    setSceneObjectActive,
    version: '1.0.0'
  };

  registerComponent('Transform', {
    create: () => ({ x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }),
    normalize: value => ({
      ...value,
      x: finite(value.x, 0),
      y: finite(value.y, 0),
      z: finite(value.z, 0),
      rotationX: finite(value.rotationX, 0),
      rotationY: finite(value.rotationY, 0),
      rotationZ: finite(value.rotationZ, 0),
      scaleX: finite(value.scaleX, 1),
      scaleY: finite(value.scaleY, 1),
      scaleZ: finite(value.scaleZ, 1)
    })
  });
  registerComponent('SceneObjectRef', {
    validate: value => typeof value.sceneObjectId === 'string' && value.sceneObjectId.length > 0
  });

  window.PStudioECS = api;
})();
