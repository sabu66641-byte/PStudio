/* PStudio ECS Gameplay Bridge 1.0.0
 * Moves per-Scene-Object Health state into ECS while preserving the legacy Gameplay API.
 * ECS is authoritative during Play; the legacy map is only a compatibility snapshot
 * across Stop/Play until the remaining gameplay domains are migrated.
 */
(() => {
  'use strict';
  const TYPE = 'Health';
  const SOURCE = 'pstudio_ecs_gameplay';
  const FIELDS = ['max', 'hp', 'configured'];

  function getECS() { return window.PStudioECS || null; }

  function ensureHealthComponent(ecs) {
    if (!ecs) return false;
    if (ecs.hasComponentType?.(TYPE)) {
      const definition = ecs.getComponentDefinition?.(TYPE);
      if (definition?.source !== SOURCE) {
        throw new Error('ECS Component name conflict: ' + TYPE);
      }
      return true;
    }
    ecs.registerComponent(TYPE, {
      source: SOURCE,
      label: 'Health',
      description: 'Runtime health and maximum health for a gameplay entity.',
      category: 'Gameplay',
      internal: true,
      persistent: false,
      additionalProperties: false,
      schema: {
        max: { type: 'number', min: 1, default: 100 },
        hp: { type: 'number', min: 0, default: 100 },
        configured: { type: 'boolean', default: false }
      },
      create: () => ({ max: 100, hp: 100, configured: false })
    });
    return true;
  }

  function getEntity(ecs, objectId) {
    return ecs?.getEntityForSceneObject?.(String(objectId)) ?? null;
  }

  function getHealth(objectId) {
    const ecs = getECS();
    if (!ecs || !ecs.hasComponentType?.(TYPE)) return null;
    const entity = getEntity(ecs, objectId);
    if (entity === null) return null;
    return ecs.getComponent(entity, TYPE);
  }

  function initialize(sceneObjects, readLegacy) {
    const ecs = getECS();
    if (!ensureHealthComponent(ecs)) return false;
    for (const object of sceneObjects || []) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = getEntity(ecs, object.id);
      if (entity === null || ecs.hasComponent(entity, TYPE)) continue;
      const previous = typeof readLegacy === 'function' ? readLegacy(object.id) : null;
      const seed = previous && typeof previous === 'object'
        ? { max: previous.max, hp: previous.hp, configured: previous.configured === true }
        : undefined;
      ecs.addComponent(entity, TYPE, seed);
    }
    return true;
  }

  function persist(sceneObjects, writeLegacy) {
    const ecs = getECS();
    if (!ecs || !ecs.hasComponentType?.(TYPE) || typeof writeLegacy !== 'function') return false;
    for (const object of sceneObjects || []) {
      if (!object || object.id === undefined || object.id === null) continue;
      const health = getHealth(object.id);
      if (!health) continue;
      const snapshot = {};
      for (const field of FIELDS) snapshot[field] = health[field];
      writeLegacy(object.id, snapshot);
    }
    return true;
  }

  window.PStudioECSGameplay = Object.freeze({
    initialize,
    persist,
    getHealth,
    version: '1.0.0'
  });
})();
