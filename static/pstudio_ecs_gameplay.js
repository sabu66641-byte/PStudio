/* PStudio ECS Gameplay bridge 1.0.0
 * Entity-owned gameplay state with compatibility helpers for the legacy PStudioGameplay API.
 * Static content definitions and engine services remain outside ECS by design.
 */
(() => {
  'use strict';

  const ecs = () => window.PStudioECS;
  let worldEntity = null;
  const runtimeSnapshots = new Map();
  const SCENE_GAMEPLAY_COMPONENTS = new Set(['Health', 'Inventory', 'Equipment', 'AIState', 'CombatState']);
  const clone = value => JSON.parse(JSON.stringify(value));

  function register(type, options) {
    const api = ecs();
    if (!api) return false;
    if (!api.hasComponentType(type)) api.registerComponent(type, options);
    return true;
  }

  register('ScriptState', {
    label: 'Script Runtime State',
    category: 'Runtime',
    description: 'Per-Entity ps script variables owned by the ECS runtime.',
    schema: { values: { type: 'json', default: {} } },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('ScriptLifecycle', {
    label: 'Script Lifecycle',
    category: 'Runtime',
    description: 'Per-Entity ps script initialization and start flags.',
    schema: {
      initialized: { type: 'boolean', default: false },
      started: { type: 'boolean', default: false }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('ScriptSystemState', {
    label: 'Script System State',
    category: 'Runtime',
    description: 'Per-Entity local variables for each declared ps System.',
    schema: { values: { type: 'json', default: {} } },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('LocomotionState', {
    label: 'Locomotion Runtime State',
    category: 'Runtime',
    description: 'Per-Entity locomotion event counters used by animation playback.',
    schema: { landSequence: { type: 'integer', default: 0, min: 0 } },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('Health', {
    label: 'Health',
    category: 'Gameplay',
    description: 'Current and maximum health for an Entity.',
    schema: {
      max: { type: 'number', default: 100, min: 1, label: 'Maximum HP' },
      hp: { type: 'number', default: 100, min: 0, label: 'Current HP' },
      configured: { type: 'boolean', default: false, label: 'Configured' }
    },
    additionalProperties: false,
    normalize: value => {
      const max = Math.max(1, Number.isFinite(Number(value.max)) ? Number(value.max) : 100);
      return { max, hp: Math.max(0, Math.min(max, Number.isFinite(Number(value.hp)) ? Number(value.hp) : max)), configured: value.configured === true };
    }
  });

  register('Inventory', {
    label: 'Inventory',
    category: 'Gameplay',
    description: 'Items owned by an Entity.',
    schema: { items: { type: 'array', default: [], label: 'Items' } },
    additionalProperties: false,
    normalize: value => ({
      items: (Array.isArray(value.items) ? value.items : [])
        .filter(item => item && typeof item.item === 'string' && item.item.length > 0)
        .map(item => ({ item: item.item, count: Math.max(0, Math.floor(Number(item.count) || 0)) }))
        .filter(item => item.count > 0)
    })
  });

  register('Equipment', {
    label: 'Equipment',
    category: 'Gameplay',
    description: 'Equipped items by slot.',
    schema: { slots: { type: 'array', default: [], label: 'Equipment slots' } },
    additionalProperties: false,
    normalize: value => ({
      slots: (Array.isArray(value.slots) ? value.slots : [])
        .filter(item => item && typeof item.slot === 'string' && typeof item.item === 'string')
        .map(item => ({ slot: item.slot, item: item.item }))
    })
  });

  register('AIState', {
    label: 'AI State',
    category: 'Gameplay',
    description: 'High-level state of an Entity AI controller.',
    schema: {
      state: { type: 'enum', options: ['idle', 'chase', 'attack', 'retreat', 'dead'], default: 'idle', label: 'State' }
    },
    additionalProperties: false
  });

  register('CombatState', {
    label: 'Combat State',
    category: 'Gameplay',
    description: 'Runtime combo and attack cooldown state.',
    schema: {
      comboCount: { type: 'integer', default: 0, min: 0, max: 5 },
      comboTime: { type: 'number', default: 0 },
      comboWeapon: { type: 'string', default: '' },
      cooldowns: { type: 'json', default: {} }
    },
    additionalProperties: false,
    internal: true,
    category: 'Gameplay Runtime',
    persistent: true,
    normalize: value => ({
      comboCount: Math.max(0, Math.min(5, Math.floor(Number(value.comboCount) || 0))),
      comboTime: Number.isFinite(Number(value.comboTime)) ? Number(value.comboTime) : 0,
      comboWeapon: String(value.comboWeapon || ''),
      cooldowns: value.cooldowns && typeof value.cooldowns === 'object' && !Array.isArray(value.cooldowns) ? { ...value.cooldowns } : {}
    })
  });

  register('Quest', {
    label: 'Quest',
    category: 'Gameplay World',
    description: 'World-level quest definition and progress.',
    schema: {
      questId: { type: 'string', required: true },
      prerequisite: { type: 'string', default: '' },
      rewardItem: { type: 'string', default: '' },
      rewardCount: { type: 'integer', default: 0, min: 0 },
      started: { type: 'boolean', default: false },
      complete: { type: 'boolean', default: false },
      progress: { type: 'number', default: 0, min: 0 },
      target: { type: 'number', default: 1, min: 1 },
      rewarded: { type: 'boolean', default: false }
    },
    additionalProperties: false,
    internal: true,
    persistent: false,
    category: 'Gameplay World'
  });

  register('NavigationNode', {
    label: 'Navigation Node',
    category: 'Navigation',
    description: 'A graph node used by gameplay path queries.',
    schema: {
      nodeId: { type: 'string', required: true },
      x: { type: 'number', default: 0 },
      y: { type: 'number', default: 0 },
      z: { type: 'number', default: 0 },
      links: { type: 'array', default: [] },
      blocked: { type: 'boolean', default: false }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('GameplayWorld', {
    label: 'Gameplay World State',
    category: 'Gameplay Runtime',
    description: 'World-scoped UI and dialogue state.',
    schema: {
      ui: { type: 'json', default: null },
      dialogue: { type: 'json', default: { signature: '', speaker: '', text: '', choices: [], choice: '', lastChoice: '' } }
    },
    additionalProperties: false,
    internal: true,
    persistent: false,
    category: 'Gameplay Runtime',
    normalize: value => ({
      ui: value.ui && typeof value.ui === 'object' && !Array.isArray(value.ui)
        ? { type: String(value.ui.type || ''), ownerId: String(value.ui.ownerId || '') }
        : null,
      dialogue: value.dialogue && typeof value.dialogue === 'object' && !Array.isArray(value.dialogue)
        ? {
            signature: String(value.dialogue.signature || ''),
            speaker: String(value.dialogue.speaker || ''),
            text: String(value.dialogue.text || ''),
            choices: Array.isArray(value.dialogue.choices) ? value.dialogue.choices.map(String).slice(0, 16) : [],
            choice: String(value.dialogue.choice || ''),
            lastChoice: String(value.dialogue.lastChoice || '')
          }
        : { signature: '', speaker: '', text: '', choices: [], choice: '', lastChoice: '' }
    })
  });

  function isAvailable() {
    return !!ecs() && typeof ecs().getEntityForSceneObject === 'function';
  }

  function getSceneEntity(objectId) {
    if (!isAvailable()) return null;
    return ecs().getEntityForSceneObject(String(objectId));
  }

  function getSceneComponent(objectId, type) {
    const api = ecs();
    const entity = getSceneEntity(objectId);
    if (!api || !entity || !api.hasComponent(entity, type)) return null;
    return api.getComponent(entity, type);
  }

  function ensureSceneComponent(objectId, type, initialValue) {
    const api = ecs();
    const key = String(objectId);
    const entity = getSceneEntity(key);
    if (!api || !entity || !api.hasComponentType(type)) return null;
    if (!api.hasComponent(entity, type)) {
      const snapshot = runtimeSnapshots.get(key);
      const restored = snapshot && Object.prototype.hasOwnProperty.call(snapshot, type) ? clone(snapshot[type]) : null;
      api.addComponent(entity, type, restored || initialValue || {});
      if (snapshot) {
        delete snapshot[type];
        if (!Object.keys(snapshot).length) runtimeSnapshots.delete(key);
      }
    }
    return api.getComponent(entity, type);
  }

  function commitSceneComponent(objectId, type, value) {
    const api = ecs();
    const entity = getSceneEntity(objectId);
    if (!api || !entity || !api.hasComponent(entity, type)) return false;
    api.setComponent(entity, type, value);
    return true;
  }

  function ensureWorldEntity() {
    const api = ecs();
    if (!api || !api.hasComponentType('GameplayWorld')) return null;
    if (worldEntity !== null && api.getComponentTypes().includes('GameplayWorld')) {
      try {
        api.getComponent(worldEntity, 'GameplayWorld');
        return worldEntity;
      } catch (_) { worldEntity = null; }
    }
    worldEntity = api.createEntity({
      GameplayWorld: {
        ui: null,
        dialogue: { signature: '', speaker: '', text: '', choices: [], choice: '', lastChoice: '' }
      }
    });
    return worldEntity;
  }

  function getWorldState() {
    const api = ecs();
    const entity = ensureWorldEntity();
    return api && entity ? api.getComponent(entity, 'GameplayWorld') : null;
  }

  function commitWorldState(value) {
    const api = ecs();
    const entity = ensureWorldEntity();
    if (!api || !entity) return false;
    api.setComponent(entity, 'GameplayWorld', value);
    return true;
  }

  function createDataEntity(type, initialValue) {
    const api = ecs();
    if (!api || !api.hasComponentType(type)) return null;
    return api.createEntity({ [type]: initialValue || {} });
  }

  function getEntityComponent(entity, type) {
    const api = ecs();
    if (!api) return null;
    try { return api.getComponent(entity, type); } catch (_) { return null; }
  }

  function setEntityComponent(entity, type, value) {
    const api = ecs();
    if (!api) return false;
    try { api.setComponent(entity, type, value); return true; } catch (_) { return false; }
  }

  function destroyDataEntity(entity) {
    const api = ecs();
    if (!api) return false;
    try { return api.destroyEntity(entity); } catch (_) { return false; }
  }

  function queryData(type) {
    const api = ecs();
    if (!api || !api.hasComponentType(type)) return [];
    return api.query([type]).map(entity => ({ entity, data: api.getComponent(entity, type) }));
  }

  function snapshotSceneState(sceneObjects) {
    const api = ecs();
    if (!api || !Array.isArray(sceneObjects)) return 0;
    const active = new Set();
    let saved = 0;
    for (const object of sceneObjects) {
      if (!object || object.id === undefined || object.id === null) continue;
      const key = String(object.id);
      active.add(key);
      const entity = getSceneEntity(key);
      if (!entity) continue;
      const snapshot = Object.create(null);
      for (const entry of api.getEntityComponents(entity)) {
        if (!SCENE_GAMEPLAY_COMPONENTS.has(entry.type)) continue;
        snapshot[entry.type] = clone(entry.data);
        saved++;
      }
      if (Object.keys(snapshot).length) runtimeSnapshots.set(key, snapshot);
    }
    for (const key of [...runtimeSnapshots.keys()]) if (!active.has(key)) runtimeSnapshots.delete(key);
    return saved;
  }

  function resetCombatTransient() {
    const api = ecs();
    if (!api || !api.hasComponentType('CombatState')) return 0;
    let count = 0;
    for (const entity of api.query(['CombatState'])) {
      const state = api.getComponent(entity, 'CombatState');
      state.comboCount = 0;
      state.comboTime = 0;
      state.comboWeapon = '';
      state.cooldowns = {};
      api.setComponent(entity, 'CombatState', state);
      count++;
    }
    return count;
  }

  window.PStudioECSGameplay = Object.freeze({
    isAvailable,
    getSceneEntity,
    ensureSceneComponent,
    getSceneComponent,
    commitSceneComponent,
    getWorldState,
    commitWorldState,
    createDataEntity,
    getEntityComponent,
    setEntityComponent,
    destroyDataEntity,
    queryData,
    resetCombatTransient,
    snapshotSceneState,
    version: '1.0.0'
  });
})();
