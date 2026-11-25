/* PStudio ECS 1.0.0
 * Sparse-set component storage and deterministic system scheduling.
 * Scene Objects are bridged without replacing the existing project format.
 */
(() => {
  'use strict';

  const COMPONENT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
  const SCENE_COMPONENTS_VERSION = 1;
  const COMPONENT_FIELD_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const SYSTEM_ID = /^[a-z][a-z0-9._-]{1,63}$/;
  const SYSTEM_PHASES = new Set(['update', 'prePhysics', 'postUpdate', 'postPhysics']);
  const SCHEMA_FIELD_TYPES = new Set(['number', 'integer', 'boolean', 'string', 'enum', 'color', 'vector3', 'array', 'json', 'entity']);
  const componentDefinitions = new Map();
  const componentStores = new Map();
  const systems = new Map();
  const orderedSystems = [];
  const entities = new Set();
  const entityActive = new Map();
  const listeners = new Map();
  const sceneEntityByObjectId = new Map();
  const sceneSnapshots = new Map();
  const sceneComponentPayloadSnapshots = new Map();
  const deferred = [];
  let deferredHead = 0;

  let nextEntityId = 1;
  let systemSequence = 0;
  let componentDefinitionRevision = 0;
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

  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeComponentSchema(schema) {
    if (schema == null) return null;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('ECS Component schema must be an object of field definitions.');
    }
    const result = Object.create(null);
    for (const [fieldName, raw] of Object.entries(schema)) {
      if (!COMPONENT_FIELD_ID.test(fieldName) || ['__proto__', 'prototype', 'constructor'].includes(fieldName)) {
        throw new Error('Invalid ECS Component field name: ' + fieldName);
      }
      const descriptor = typeof raw === 'string' ? { type: raw } : raw;
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        throw new TypeError('Invalid schema definition for Component field: ' + fieldName);
      }
      const fieldType = String(descriptor.type || '');
      if (!SCHEMA_FIELD_TYPES.has(fieldType)) {
        throw new Error('Unsupported ECS Component field type "' + fieldType + '" for ' + fieldName);
      }
      const field = {
        type: fieldType,
        label: String(descriptor.label || fieldName),
        description: String(descriptor.description || ''),
        required: descriptor.required === true,
        nullable: descriptor.nullable === true
      };
      for (const key of ['min', 'max', 'step', 'maxLength']) {
        if (descriptor[key] !== undefined) {
          const number = Number(descriptor[key]);
          if (!Number.isFinite(number) || (key === 'step' && number <= 0) || (key === 'maxLength' && number < 0)) {
            throw new TypeError('Invalid "' + key + '" for Component field: ' + fieldName);
          }
          field[key] = number;
        }
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        throw new RangeError('Component field min exceeds max: ' + fieldName);
      }
      if (fieldType === 'enum') {
        if (!Array.isArray(descriptor.options) || descriptor.options.length < 1 || descriptor.options.length > 128) {
          throw new TypeError('Enum Component fields require 1–128 options: ' + fieldName);
        }
        field.options = descriptor.options.map(option => {
          if (!['string', 'number', 'boolean'].includes(typeof option) || (typeof option === 'number' && !Number.isFinite(option))) {
            throw new TypeError('Enum options must be strings, finite numbers or booleans: ' + fieldName);
          }
          return option;
        });
      }
      if (Object.prototype.hasOwnProperty.call(descriptor, 'default')) {
        try { field.default = cloneJsonValue(descriptor.default); }
        catch (_) { throw new TypeError('Component field default must be JSON serializable: ' + fieldName); }
      }
      result[fieldName] = field;
    }
    return result;
  }

  function validateSchemaField(fieldName, field, value) {
    if (value === null && field.nullable === true) return;
    let valid = false;
    switch (field.type) {
      case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
      case 'integer': valid = Number.isSafeInteger(value); break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'string': valid = typeof value === 'string' && (field.maxLength === undefined || value.length <= field.maxLength); break;
      case 'enum': valid = field.options.some(option => Object.is(option, value)); break;
      case 'color': valid = typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value); break;
      case 'vector3': valid = !!value && typeof value === 'object' && !Array.isArray(value) && ['x','y','z'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])); break;
      case 'array': valid = Array.isArray(value); break;
      case 'json': valid = value !== undefined; break;
      case 'entity': valid = value === null || Number.isSafeInteger(value); break;
    }
    if (!valid) throw new TypeError('Component field "' + fieldName + '" must be ' + field.type + '.');
    if (typeof value === 'number') {
      if (field.min !== undefined && value < field.min) throw new RangeError('Component field "' + fieldName + '" is below min ' + field.min + '.');
      if (field.max !== undefined && value > field.max) throw new RangeError('Component field "' + fieldName + '" exceeds max ' + field.max + '.');
    }
  }

  function normalizeComponent(type, value, entity) {
    const definition = componentDefinitions.get(type);
    let result = value;
    if (result === undefined && typeof definition.create === 'function') result = definition.create(entity);
    if (result === undefined) result = {};
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('ECS component data must be an object: ' + type);
    }
    result = { ...result };
    if (definition.schema) {
      for (const [fieldName, field] of Object.entries(definition.schema)) {
        if (!Object.prototype.hasOwnProperty.call(result, fieldName) && Object.prototype.hasOwnProperty.call(field, 'default')) {
          result[fieldName] = cloneJsonValue(field.default);
        }
      }
    }
    if (typeof definition.normalize === 'function') {
      result = definition.normalize(result, entity);
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('ECS component normalizer returned invalid data: ' + type);
      }
    }
    if (definition.schema) {
      for (const [fieldName, field] of Object.entries(definition.schema)) {
        if (!Object.prototype.hasOwnProperty.call(result, fieldName)) {
          if (field.required) throw new TypeError('Required Component field is missing: ' + fieldName);
          continue;
        }
        validateSchemaField(fieldName, field, result[fieldName]);
      }
      if (!definition.additionalProperties) {
        for (const fieldName of Object.keys(result)) {
          if (!Object.prototype.hasOwnProperty.call(definition.schema, fieldName)) {
            throw new TypeError('Unknown Component field "' + fieldName + '" in ' + type + '.');
          }
        }
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
    const schema = normalizeComponentSchema(settings.schema);
    componentDefinitions.set(key, {
      create: settings.create || null,
      normalize: settings.normalize || null,
      validate: settings.validate || null,
      onAdd: settings.onAdd || null,
      onRemove: settings.onRemove || null,
      schema,
      additionalProperties: settings.additionalProperties !== false,
      persistent: settings.persistent !== false,
      readonly: settings.readonly === true,
      internal: settings.internal === true,
      source: settings.source ? String(settings.source) : '',
      label: String(settings.label || key),
      description: String(settings.description || ''),
      category: String(settings.category || 'General')
    });
    componentStores.set(key, new SparseSet());
    componentDefinitionRevision++;
    emit('component-registered', { type: key });
    return key;
  }

  function updateComponentDefinition(type, options) {
    assertStructureMutable();
    const key = requireComponentType(type);
    const previous = componentDefinitions.get(key);
    const settings = options || {};
    for (const hook of ['create', 'normalize', 'validate', 'onAdd', 'onRemove']) {
      if (settings[hook] !== undefined && typeof settings[hook] !== 'function') {
        throw new TypeError('Component option "' + hook + '" must be a function.');
      }
    }
    const next = {
      ...previous,
      create: settings.create === undefined ? previous.create : settings.create,
      normalize: settings.normalize === undefined ? previous.normalize : settings.normalize,
      validate: settings.validate === undefined ? previous.validate : settings.validate,
      onAdd: settings.onAdd === undefined ? previous.onAdd : settings.onAdd,
      onRemove: settings.onRemove === undefined ? previous.onRemove : settings.onRemove,
      schema: settings.schema === undefined ? previous.schema : normalizeComponentSchema(settings.schema),
      additionalProperties: settings.additionalProperties === undefined ? previous.additionalProperties : settings.additionalProperties !== false,
      persistent: settings.persistent === undefined ? previous.persistent : settings.persistent !== false,
      readonly: settings.readonly === undefined ? previous.readonly : settings.readonly === true,
      internal: settings.internal === undefined ? previous.internal : settings.internal === true,
      source: settings.source === undefined ? previous.source : String(settings.source || ''),
      label: settings.label === undefined ? previous.label : String(settings.label || key),
      description: settings.description === undefined ? previous.description : String(settings.description || ''),
      category: settings.category === undefined ? previous.category : String(settings.category || 'General')
    };
    if (typeof next.create !== 'function' && next.create !== null) throw new TypeError('Component option "create" must be a function.');
    if (typeof next.normalize !== 'function' && next.normalize !== null) throw new TypeError('Component option "normalize" must be a function.');
    if (typeof next.validate !== 'function' && next.validate !== null) throw new TypeError('Component option "validate" must be a function.');
    if (typeof next.onAdd !== 'function' && next.onAdd !== null) throw new TypeError('Component option "onAdd" must be a function.');
    if (typeof next.onRemove !== 'function' && next.onRemove !== null) throw new TypeError('Component option "onRemove" must be a function.');

    const store = componentStores.get(key);
    const normalizedValues = new Map();
    componentDefinitions.set(key, next);
    try {
      for (const entity of store.entities) {
        normalizedValues.set(entity, normalizeComponent(key, store.get(entity), entity));
      }
    } catch (error) {
      componentDefinitions.set(key, previous);
      throw error;
    }
    for (const [entity, data] of normalizedValues) store.set(entity, data);
    componentDefinitionRevision++;
    emit('component-definition-updated', { type: key });
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
    const phase = String(settings.phase || 'update');
    if (!SYSTEM_PHASES.has(phase)) throw new Error('Invalid ECS System phase: ' + phase);
    const record = {
      id,
      name: String(settings.name || id),
      components: required,
      priority,
      phase,
      sequence: systemSequence++,
      enabled: settings.enabled !== false,
      internal: settings.internal === true,
      source: settings.source ? String(settings.source) : '',
      description: String(settings.description || ''),
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

  function setSystemPhase(id, phase) {
    const record = systems.get(String(id || ''));
    if (!record) throw new Error('ECS system is not registered: ' + String(id));
    const next = String(phase || '');
    if (!SYSTEM_PHASES.has(next)) throw new Error('Invalid ECS System phase: ' + next);
    record.phase = next;
    emit('system-phase-changed', { id: record.id, phase: next });
    return next;
  }

  function getSystems() {
    return orderedSystems.map(system => ({
      id: system.id,
      name: system.name,
      priority: system.priority,
      phase: system.phase,
      enabled: system.enabled,
      components: system.components.slice(),
      sequence: system.sequence,
      internal: system.internal,
      source: system.source,
      description: system.description
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

  function getComponentDefinition(type) {
    const definition = componentDefinitions.get(String(type || ''));
    if (!definition) return null;
    return {
      type: String(type),
      label: definition.label,
      description: definition.description,
      category: definition.category,
      schema: definition.schema ? cloneJsonValue(definition.schema) : null,
      additionalProperties: definition.additionalProperties,
      persistent: definition.persistent,
      readonly: definition.readonly,
      internal: definition.internal,
      source: definition.source
    };
  }

  function getComponentDefinitions() {
    return getComponentTypes().map(type => getComponentDefinition(type));
  }

  function getEntityComponents(entity) {
    const id = requireEntity(entity);
    const result = [];
    for (const [type, store] of componentStores) {
      if (store.has(id)) {
        const definition = componentDefinitions.get(type);
        result.push({
          type,
          data: store.get(id),
          persistent: definition.persistent,
          readonly: definition.readonly,
          schema: definition.schema ? cloneJsonValue(definition.schema) : null
        });
      }
    }
    result.sort((a, b) => a.type.localeCompare(b.type));
    return result;
  }

  function unregisterComponent(type) {
    assertStructureMutable();
    const key = String(type || '');
    const store = componentStores.get(key);
    if (!store) return false;
    if (store.size > 0) throw new Error('Cannot unregister a Component while entities still contain it: ' + key);
    if (orderedSystems.some(system => system.components.includes(key))) {
      throw new Error('Cannot unregister a Component while a System still requires it: ' + key);
    }
    componentStores.delete(key);
    componentDefinitions.delete(key);
    componentDefinitionRevision++;
    emit('component-unregistered', { type: key });
    return true;
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

  function runSystems(deltaTime, context, phase) {
    if (!enabled) return false;
    if (updating) throw new Error('ECS update() cannot be called recursively.');
    const dt = Number(deltaTime);
    if (!Number.isFinite(dt) || dt < 0) throw new TypeError('ECS delta time must be a finite non-negative number.');
    if (!SYSTEM_PHASES.has(phase)) throw new Error('Invalid ECS System phase: ' + phase);
    updating = true;
    try {
      const frameSystems = orderedSystems.slice();
      for (const system of frameSystems) {
        if (!system.enabled || !systems.has(system.id) || system.phase !== phase) continue;
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

  function update(deltaTime, context) {
    return runSystems(deltaTime, context, 'update');
  }

  function updatePhase(phase, deltaTime, context) {
    if (phase === 'update') return update(deltaTime, context);
    return runSystems(deltaTime, context, phase);
  }

  function hasSystemsForPhase(phase) {
    const key = String(phase || '');
    return enabled && orderedSystems.some(system => system.enabled && system.phase === key);
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

  function readSavedComponentEntries(object) {
    const hasLegacyData = Object.prototype.hasOwnProperty.call(object, 'ecsComponents');
    const hasVersion = Object.prototype.hasOwnProperty.call(object, 'ecsComponentsVersion');
    if (!hasLegacyData && !hasVersion) return [];

    const rawVersion = hasVersion ? Number(object.ecsComponentsVersion) : 0;
    if (!Number.isSafeInteger(rawVersion) || rawVersion < 0) {
      console.warn('[PStudio ECS] invalid saved Component schema version; skipping restore:', object.id);
      return null;
    }
    if (rawVersion > SCENE_COMPONENTS_VERSION) {
      console.warn('[PStudio ECS] saved Component schema is newer than this runtime; preserving without restore:', object.id, rawVersion);
      return null;
    }

    let entries = object.ecsComponents;
    if (rawVersion === 0) {
      // Version 0 was the unversioned format: an array of {type,data}.
      // Also accept a type-keyed object for early experimental backups.
      if (Array.isArray(entries)) {
        entries = entries.slice();
      } else if (entries && typeof entries === 'object') {
        entries = Object.entries(entries).map(([type, data]) => ({ type, data }));
      } else {
        entries = [];
      }
      object.ecsComponents = entries;
      object.ecsComponentsVersion = SCENE_COMPONENTS_VERSION;
    } else if (!Array.isArray(entries)) {
      console.warn('[PStudio ECS] malformed versioned Component list; skipping restore:', object.id);
      return null;
    }

    const normalized = [];
    const seen = new Set();
    for (const entry of entries) {
      const type = typeof entry?.type === 'string' ? entry.type : '';
      if (!COMPONENT_ID.test(type) || seen.has(type)) continue;
      seen.add(type);
      const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? entry.data : {};
      normalized.push({ type, data });
    }
    return normalized;
  }

  function serializeEntityComponents(entity, excludeTypes = [], sceneObject = null) {
    const excluded = new Set((Array.isArray(excludeTypes) ? excludeTypes : [excludeTypes])
      .filter(value => value !== undefined && value !== null)
      .map(String));
    // Preserve forward-version data verbatim. An older runtime must never
    // downgrade a payload whose schema it cannot understand.
    const savedEntries = sceneObject ? readSavedComponentEntries(sceneObject) : [];
    if (sceneObject && savedEntries === null) return null;

    const components = [];
    const includedTypes = new Set();
    for (const entry of getEntityComponents(entity)) {
      if (!entry.persistent || excluded.has(entry.type)) continue;
      try {
        components.push({
          type: entry.type,
          data: cloneJsonValue(entry.data)
        });
        includedTypes.add(entry.type);
      } catch (error) {
        console.warn('[PStudio ECS] Component could not be serialized:', entry.type, error);
      }
    }

    // Keep records for Component types not registered by this runtime. They may
    // belong to another project module or a newer plugin and are not safe to drop.
    for (const entry of savedEntries || []) {
      if (excluded.has(entry.type) || includedTypes.has(entry.type) || componentDefinitions.has(entry.type)) continue;
      try {
        components.push({ type: entry.type, data: cloneJsonValue(entry.data) });
        includedTypes.add(entry.type);
      } catch (error) {
        console.warn('[PStudio ECS] Unknown saved Component could not be preserved:', entry.type, error);
      }
    }
    return { version: SCENE_COMPONENTS_VERSION, components };
  }

  function restoreSceneObjectComponents(entity, object) {
    const entries = readSavedComponentEntries(object);
    if (!entries) return true;
    let complete = true;
    for (const entry of entries) {
      const type = entry.type;
      if (!componentDefinitions.has(type)) continue;
      const definition = componentDefinitions.get(type);
      if (!definition.persistent || componentStores.get(type)?.has(entity)) continue;
      try { addComponent(entity, type, entry.data); }
      catch (error) {
        complete = false;
        console.warn('[PStudio ECS] skipped invalid saved component:', type, error);
      }
    }
    return complete;
  }

  function sceneComponentPayloadFingerprint(object) {
    const payload = object.ecsComponents;
    let hash = 2166136261;
    const append = value => {
      const type = typeof value === 'string' ? value : '';
      for (let index = 0; index < type.length; index++) {
        hash ^= type.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 255;
      hash = Math.imul(hash, 16777619);
    };
    if (Array.isArray(payload)) {
      for (const entry of payload) append(entry?.type);
    } else if (payload && typeof payload === 'object') {
      for (const type in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, type)) append(type);
      }
    }
    return hash >>> 0;
  }

  function sceneComponentPayloadCount(object) {
    const payload = object.ecsComponents;
    if (Array.isArray(payload)) return payload.length;
    if (!payload || typeof payload !== 'object') return 0;
    let count = 0;
    for (const key in payload) if (Object.prototype.hasOwnProperty.call(payload, key)) count++;
    return count;
  }

  function restoreSceneObjectComponentsIfChanged(entity, object) {
    const payload = object.ecsComponents;
    const version = object.ecsComponentsVersion ?? 0;
    const count = sceneComponentPayloadCount(object);
    const fingerprint = sceneComponentPayloadFingerprint(object);
    const cached = sceneComponentPayloadSnapshots.get(entity);
    if (cached && cached.version === version && cached.payload === payload &&
        cached.count === count && cached.fingerprint === fingerprint &&
        cached.definitionRevision === componentDefinitionRevision) return;

    if (!restoreSceneObjectComponents(entity, object)) {
      sceneComponentPayloadSnapshots.delete(entity);
      return;
    }
    sceneComponentPayloadSnapshots.set(entity, {
      version: object.ecsComponentsVersion ?? 0,
      payload: object.ecsComponents,
      count: sceneComponentPayloadCount(object),
      fingerprint: sceneComponentPayloadFingerprint(object),
      definitionRevision: componentDefinitionRevision
    });
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
        if (entity !== undefined) {
          sceneEntityByObjectId.delete(objectId);
          sceneSnapshots.delete(entity);
          sceneComponentPayloadSnapshots.delete(entity);
        }
        entity = createEntity({
          Transform: source,
          SceneObjectRef: { sceneObjectId: objectId, name: String(object.name || '') }
        });
        sceneEntityByObjectId.set(objectId, entity);
        sceneSnapshots.set(entity, Object.assign({}, source));
        restoreSceneObjectComponentsIfChanged(entity, object);
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
      if (snapshot) copyTransform(snapshot, canonical);
      else sceneSnapshots.set(entity, Object.assign({}, canonical));
      const ref = getComponent(entity, 'SceneObjectRef');
      ref.name = String(object.name || '');
      restoreSceneObjectComponentsIfChanged(entity, object);
    }

    for (const [objectId, entity] of sceneEntityByObjectId) {
      if (seen.has(objectId)) continue;
      if (entities.has(entity)) destroyEntity(entity);
      sceneEntityByObjectId.delete(objectId);
      sceneSnapshots.delete(entity);
      sceneComponentPayloadSnapshots.delete(entity);
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
      const snapshot = sceneSnapshots.get(entity);
      if (snapshot) copyTransform(snapshot, transform);
      else sceneSnapshots.set(entity, Object.assign({}, transform));
      applied++;
    }
    return applied;
  }

  function clearSceneObjects() {
    for (const [objectId, entity] of sceneEntityByObjectId) {
      if (entities.has(entity)) destroyEntity(entity);
      sceneEntityByObjectId.delete(objectId);
      sceneSnapshots.delete(entity);
      sceneComponentPayloadSnapshots.delete(entity);
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
    updateComponentDefinition,
    unregisterComponent,
    hasComponentType(type) { return componentDefinitions.has(String(type || '')); },
    getComponentTypes,
    getComponentDefinition,
    getComponentDefinitions,
    getEntityComponents,
    serializeEntityComponents,
    sceneComponentSchemaVersion: SCENE_COMPONENTS_VERSION,
    getEntities,
    registerSystem,
    unregisterSystem,
    setSystemEnabled,
    setSystemPriority,
    setSystemPhase,
    getSystems,
    hasSystemsForPhase,
    updatePhase,
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
    hasActiveSystems() {
      return enabled && orderedSystems.some(system => system.enabled &&
        (!system.components.length || system.components.every(type => componentStores.get(type)?.size > 0)));
    },
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
    schema: {
      x: { type: 'number', default: 0, label: 'Position X' },
      y: { type: 'number', default: 0, label: 'Position Y' },
      z: { type: 'number', default: 0, label: 'Position Z' },
      rotationX: { type: 'number', default: 0, label: 'Rotation X' },
      rotationY: { type: 'number', default: 0, label: 'Rotation Y' },
      rotationZ: { type: 'number', default: 0, label: 'Rotation Z' },
      scaleX: { type: 'number', default: 1, label: 'Scale X' },
      scaleY: { type: 'number', default: 1, label: 'Scale Y' },
      scaleZ: { type: 'number', default: 1, label: 'Scale Z' }
    },
    additionalProperties: false,
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
    schema: {
      sceneObjectId: { type: 'string', required: true, label: 'Scene Object ID' },
      name: { type: 'string', default: '', label: 'Name' }
    },
    additionalProperties: false,
    readonly: true,
    persistent: false,
    validate: value => typeof value.sceneObjectId === 'string' && value.sceneObjectId.length > 0
  });

  window.PStudioECS = api;
})();
