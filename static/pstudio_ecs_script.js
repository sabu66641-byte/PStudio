/* PStudio ECS Script Runtime bridge 1.0.0
 * ECS owns per-entity ps variables, lifecycle flags and ps System locals.
 * ASTs, interpreter execution and transient render-command caches remain Runtime-owned.
 */
(() => {
  'use strict';

  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Script] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_script';
  const TYPES = Object.freeze({
    state: 'ScriptState',
    lifecycle: 'ScriptLifecycle',
    systemState: 'ScriptSystemState'
  });

  function registerType(type, schema, create, description) {
    if (ecs.hasComponentType(type)) {
      const definition = ecs.getComponentDefinition(type);
      if (definition?.source !== SOURCE) {
        throw new Error('ECS Component name conflict: ' + type);
      }
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE,
      label: type,
      description,
      category: 'Scripting',
      internal: true,
      persistent: false,
      additionalProperties: false,
      schema,
      create
    });
    return true;
  }

  registerType(
    TYPES.state,
    { variables: { type: 'json', default: {} } },
    () => ({ variables: Object.create(null) }),
    'Mutable global variables for one Scene Object ps script. Runtime-only.'
  );
  registerType(
    TYPES.lifecycle,
    {
      initialized: { type: 'boolean', default: false },
      started: { type: 'boolean', default: false },
      landSequence: { type: 'integer', min: 0, default: 0 }
    },
    () => ({ initialized: false, started: false, landSequence: 0 }),
    'Per-Scene Object ps lifecycle and locomotion sequence state. Runtime-only.'
  );
  registerType(
    TYPES.systemState,
    { systems: { type: 'json', default: {} } },
    () => ({ systems: Object.create(null) }),
    'Per-Entity local variables partitioned by ps ECS System ID. Runtime-only.'
  );

  let systemRequirements = [];

  function entityForSceneObject(objectId) {
    return ecs.getEntityForSceneObject(String(objectId));
  }

  function has(entity, type) {
    try { return ecs.hasComponent(Number(entity), type); }
    catch (_) { return false; }
  }

  function ensure(entity, type) {
    const id = Number(entity);
    if (!Number.isSafeInteger(id)) return false;
    if (has(id, type)) return true;
    ecs.addComponent(id, type);
    return true;
  }

  function ensureSceneState(entity) {
    ensure(entity, TYPES.state);
    ensure(entity, TYPES.lifecycle);
    return true;
  }

  function matchesAnySystem(entity) {
    for (const required of systemRequirements) {
      let matches = true;
      for (const type of required.components) {
        if (!has(entity, type)) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }

  function ensureSystemStateIfMatched(entity) {
    if (!systemRequirements.length || !matchesAnySystem(entity)) return false;
    return ensure(entity, TYPES.systemState);
  }

  // These event hooks cover Entities and Component assignments created after Play starts.
  // ECS emits them only after a structural operation has passed its iteration guard.
  ecs.on('entity-created', event => {
    const entity = Number(event?.detail?.entity);
    if (!Number.isSafeInteger(entity)) return;
    if (has(entity, 'SceneObjectRef')) ensureSceneState(entity);
    ensureSystemStateIfMatched(entity);
  });
  ecs.on('component-added', event => {
    const entity = Number(event?.detail?.entity);
    if (!Number.isSafeInteger(entity)) return;
    if (event?.detail?.type === 'SceneObjectRef') ensureSceneState(entity);
    ensureSystemStateIfMatched(entity);
  });

  function syncSceneObjects(objects) {
    let synced = 0;
    for (const object of Array.isArray(objects) ? objects : []) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = entityForSceneObject(object.id);
      if (entity === null) continue;
      ensureSceneState(entity);
      synced++;
    }
    return synced;
  }

  function setSystemDefinitions(definitions) {
    const next = [];
    for (const definition of Array.isArray(definitions) ? definitions : []) {
      const id = String(definition?.id || '');
      const components = [...new Set((Array.isArray(definition?.components) ? definition.components : []).map(String))];
      if (!id) throw new TypeError('ps System ID is required for ScriptSystemState.');
      for (const type of components) {
        if (!ecs.hasComponentType(type)) throw new Error('Unknown ps System Component: ' + type);
      }
      next.push({ id, components });
    }
    systemRequirements = next;

    let attached = 0;
    for (const entity of ecs.getEntities(true)) {
      if (matchesAnySystem(entity) && ensure(entity, TYPES.systemState)) attached++;
    }
    return attached;
  }

  function getComponent(entity, type) {
    return has(entity, type) ? ecs.getComponent(Number(entity), type) : null;
  }

  function getVariables(objectId) {
    const entity = entityForSceneObject(objectId);
    const state = entity === null ? null : getComponent(entity, TYPES.state);
    return state?.variables || null;
  }

  function getVariablesByEntity(entity) {
    return getComponent(entity, TYPES.state)?.variables || null;
  }

  function setVariables(objectId, variables) {
    const entity = entityForSceneObject(objectId);
    if (entity === null) return false;
    return setVariablesByEntity(entity, variables);
  }

  function setVariablesByEntity(entity, variables) {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return false;
    const current = getComponent(entity, TYPES.state);
    if (!current) return false;
    ecs.setComponent(Number(entity), TYPES.state, { variables });
    return true;
  }

  function getLifecycle(objectId) {
    const entity = entityForSceneObject(objectId);
    return entity === null ? null : getComponent(entity, TYPES.lifecycle);
  }

  function getLifecycleByEntity(entity) {
    return getComponent(entity, TYPES.lifecycle);
  }

  function setLifecycle(objectId, patch) {
    const entity = entityForSceneObject(objectId);
    return entity === null ? false : setLifecycleByEntity(entity, patch);
  }

  function setLifecycleByEntity(entity, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const current = getComponent(entity, TYPES.lifecycle);
    if (!current) return false;
    ecs.setComponent(Number(entity), TYPES.lifecycle, { ...current, ...patch });
    return true;
  }

  function getSystemState(entity, systemId) {
    const component = getComponent(entity, TYPES.systemState);
    const systems = component?.systems;
    const key = String(systemId);
    return systems && Object.prototype.hasOwnProperty.call(systems, key) ? systems[key] : null;
  }

  function setSystemState(entity, systemId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const component = getComponent(entity, TYPES.systemState);
    if (!component || !component.systems || typeof component.systems !== 'object') return false;

    // Mutate the already-attached Component in place. setComponent/addComponent are
    // structural API calls and are forbidden while a System's forEach is iterating.
    Object.defineProperty(component.systems, String(systemId), {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    return true;
  }

  function clear() {
    systemRequirements = [];
    for (const entity of ecs.getEntities(true)) {
      for (const type of Object.values(TYPES)) {
        if (has(entity, type)) ecs.removeComponent(entity, type);
      }
    }
    return true;
  }

  window.PStudioECSScript = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    sync: syncSceneObjects,
    setSystemDefinitions,
    getVariables,
    setVariables,
    getVariablesByEntity,
    setVariablesByEntity,
    getLifecycle,
    setLifecycle,
    getLifecycleByEntity,
    setLifecycleByEntity,
    getSystemState,
    setSystemState,
    getSystemStateByEntity: getSystemState,
    setSystemStateByEntity: setSystemState,
    clear
  });
})();
