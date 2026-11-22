/* PStudio ECS Gameplay Bridge 2.0.0
 * Gameplay state is owned by ECS while Play is active.
 * PStudioGameplay remains the compatibility API; UI and Physics remain services.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Gameplay] ECS core is unavailable.');
    return;
  }
  const SOURCE = 'pstudio_ecs_gameplay';
  const TYPES = {
    Health: 'Health', Inventory: 'Inventory', Equipment: 'Equipment',
    CombatState: 'CombatState', AIController: 'AIController',
    MovementIntent: 'MovementIntent', QuestProgress: 'QuestProgress',
    DialogueSession: 'DialogueSession'
  };
  const questEntities = new Map();
  let dialogueEntity = null;
  let active = false;

  function registerType(type, schema, options = {}) {
    if (ecs.hasComponentType(type)) {
      const definition = ecs.getComponentDefinition(type);
      if (definition?.source !== SOURCE) throw new Error('ECS Component name conflict: ' + type);
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE, label: options.label || type,
      description: options.description || '', category: options.category || 'Gameplay',
      internal: true, persistent: false, additionalProperties: false,
      schema,
      ...(typeof options.create === 'function' ? { create: options.create } : {})
    });
    return true;
  }

  function registerComponents() {
    registerType(TYPES.Health, {
      max: { type: 'number', min: 1, default: 100 },
      hp: { type: 'number', min: 0, default: 100 },
      configured: { type: 'boolean', default: false }
    }, { label: 'Health' });
    registerType(TYPES.Inventory, {
      items: { type: 'json', default: {} }
    }, { label: 'Inventory' });
    registerType(TYPES.Equipment, {
      slots: { type: 'json', default: {} }
    }, { label: 'Equipment' });
    registerType(TYPES.CombatState, {
      cooldowns: { type: 'json', default: {} },
      comboCount: { type: 'integer', min: 0, max: 5, default: 0 },
      comboTime: { type: 'number', min: 0, default: 0 },
      comboWeapon: { type: 'string', default: '' }
    }, { label: 'Combat State' });
    registerType(TYPES.AIController, {
      targetId: { type: 'string', default: '' },
      sightRange: { type: 'number', min: 0, default: 12 },
      attackRange: { type: 'number', min: 0, default: 1.8 },
      speed: { type: 'number', min: 0, default: 3 },
      enabled: { type: 'boolean', default: true },
      state: { type: 'string', default: 'idle' },
      skipLegacyEvaluation: { type: 'boolean', default: false }
    }, { label: 'AI Controller' });
    registerType(TYPES.MovementIntent, {
      x: { type: 'number', default: 0 },
      z: { type: 'number', default: 0 },
      maxSpeed: { type: 'number', min: 0, default: 5 },
      acceleration: { type: 'number', min: 0, default: 24 },
      airControl: { type: 'number', min: 0, max: 1, default: 0.25 },
      active: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'manual' },
      targetId: { type: 'string', default: '' }
    }, { label: 'Movement Intent' });
    registerType(TYPES.QuestProgress, {
      questId: { type: 'string', default: '' },
      started: { type: 'boolean', default: false },
      complete: { type: 'boolean', default: false },
      progress: { type: 'number', min: 0, default: 0 },
      target: { type: 'number', min: 1, default: 1 },
      rewarded: { type: 'boolean', default: false },
      ownerId: { type: 'string', default: '' }
    }, { label: 'Quest Progress' });
    registerType(TYPES.DialogueSession, {
      signature: { type: 'string', default: '' },
      speaker: { type: 'string', default: '' },
      text: { type: 'string', default: '' },
      choices: { type: 'array', default: [] },
      choice: { type: 'string', default: '' },
      active: { type: 'boolean', default: false }
    }, { label: 'Dialogue Session' });
  }

  function systems() {
    const existing = new Set(ecs.getSystems().map(system => system.id));
    if (!existing.has('gameplay.combat-state-maintenance')) {
      ecs.registerSystem({
        id: 'gameplay.combat-state-maintenance',
        name: 'Combat State Maintenance',
        description: 'Expires per-target attack cooldown records after their configured duration.',
        components: [TYPES.CombatState], phase: 'update', priority: 500, internal: true,
        update(dt, api) {
          const now = Date.now();
          api.forEach([TYPES.CombatState], (entity, state) => {
            for (const [targetId, record] of Object.entries(state.cooldowns || {})) {
              const at = Number(record?.at);
              const duration = Math.max(0, Number(record?.duration) || 0);
              if (!Number.isFinite(at) || (duration > 0 && now - at >= duration)) delete state.cooldowns[targetId];
            }
          });
        }
      });
    }
    if (!existing.has('gameplay.ai-controller')) {
      ecs.registerSystem({
        id: 'gameplay.ai-controller', name: 'AI Controller',
        description: 'Evaluates AIController data and writes the next MovementIntent.',
        components: [TYPES.AIController, TYPES.MovementIntent, 'SceneObjectRef'],
        phase: 'postUpdate', priority: -100, internal: true,
        update(dt, api, context) {
          api.forEach([TYPES.AIController, TYPES.MovementIntent, 'SceneObjectRef'],
            (entity, controller, intent, reference) => {
              if (!controller.enabled) return;
              if (controller.skipLegacyEvaluation) {
                controller.skipLegacyEvaluation = false;
                return;
              }
              window.PStudioGameplay?._ecsUpdateAI?.(entity, controller, intent, reference, context);
            });
        }
      });
    }
    if (!existing.has('gameplay.movement-intent')) {
      ecs.registerSystem({
        id: 'gameplay.movement-intent', name: 'Movement Intent Resolver',
        description: 'Applies queued per-entity movement intent to the Physics controller.',
        components: [TYPES.MovementIntent, 'SceneObjectRef'],
        phase: 'postUpdate', priority: 100, internal: true,
        update(dt, api) {
          const physics = window.PStudioPhysics;
          if (!physics) return;
          api.forEach([TYPES.MovementIntent, 'SceneObjectRef'], (entity, intent, reference) => {
            if (!intent.active) return;
            const ownerId = String(reference.sceneObjectId);
            if (physics.getBody?.(ownerId)) {
              const maxSpeed=Number(intent.maxSpeed);
              if(Number.isFinite(maxSpeed)&&maxSpeed>0)physics.configureController(ownerId,
                Math.max(0.1,maxSpeed),
                Number.isFinite(Number(intent.acceleration))?Math.max(0,Number(intent.acceleration)):24,
                Number.isFinite(Number(intent.airControl))?Math.max(0,Math.min(1,Number(intent.airControl))):0.25);
              physics.moveCharacter(ownerId, Number(intent.x) || 0, Number(intent.z) || 0);
            }
            intent.active = false;
          });
        }
      });
    }
  }

  function clone(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return JSON.parse(JSON.stringify(value));
  }
  function sceneEntity(objectId) {
    return ecs.getEntityForSceneObject?.(String(objectId)) ?? null;
  }
  function ensureSceneComponent(objectId, type, initial) {
    const entity = sceneEntity(objectId);
    if (entity === null) return null;
    if (!ecs.hasComponent(entity, type)) ecs.addComponent(entity, type, initial);
    return ecs.getComponent(entity, type);
  }
  function getSceneComponent(objectId, type) {
    const entity = sceneEntity(objectId);
    if (entity === null || !ecs.hasComponent(entity, type)) return null;
    return ecs.getComponent(entity, type);
  }
  function getHealth(objectId) { return getSceneComponent(objectId, TYPES.Health); }
  function getInventory(objectId, create = false) {
    return create ? ensureSceneComponent(objectId, TYPES.Inventory) : getSceneComponent(objectId, TYPES.Inventory);
  }
  function getEquipment(objectId, create = false) {
    return create ? ensureSceneComponent(objectId, TYPES.Equipment) : getSceneComponent(objectId, TYPES.Equipment);
  }
  function getCombatState(objectId, create = false) {
    return create ? ensureSceneComponent(objectId, TYPES.CombatState) : getSceneComponent(objectId, TYPES.CombatState);
  }
  function getAIController(objectId, create = false) {
    return create ? ensureSceneComponent(objectId, TYPES.AIController) : getSceneComponent(objectId, TYPES.AIController);
  }
  function getMovementIntent(objectId, create = false) {
    return create ? ensureSceneComponent(objectId, TYPES.MovementIntent) : getSceneComponent(objectId, TYPES.MovementIntent);
  }
  function canAttack(sourceId, targetId, cooldown, now = Date.now()) {
    const state = getCombatState(sourceId, true);
    if (!state) return null;
    const key = String(targetId);
    const duration = Math.max(0, Number(cooldown) || 0);
    const previous = state.cooldowns[key];
    if (previous && now - Number(previous.at || 0) < Math.max(0, Number(previous.duration) || duration)) return false;
    state.cooldowns[key] = { at: now, duration };
    return true;
  }
  function getCombo(objectId) {
    const state = getCombatState(objectId);
    return state ? { count: state.comboCount, time: state.comboTime, weapon: state.comboWeapon } : null;
  }
  function setCombo(objectId, combo) {
    const state = getCombatState(objectId, true);
    if (!state) return false;
    state.comboCount = Math.max(0, Math.min(5, Math.floor(Number(combo.count) || 0)));
    state.comboTime = Math.max(0, Number(combo.time) || 0);
    state.comboWeapon = String(combo.weapon || '');
    return true;
  }
  function setAIController(objectId, config) {
    const controller = getAIController(objectId, true);
    const intent = getMovementIntent(objectId, true);
    if (!controller || !intent) return null;
    controller.targetId = String(config.targetId || '');
    controller.sightRange = Math.max(0, Number(config.sightRange) || 0);
    controller.attackRange = Math.max(0, Number(config.attackRange) || 0);
    controller.speed = Math.max(0, Number(config.speed) || 0);
    controller.enabled = true;
    return controller;
  }
  function setMovementIntent(objectId, intent) {
    const state = getMovementIntent(objectId, true);
    if (!state) return false;
    state.x = Number(intent.x) || 0;
    state.z = Number(intent.z) || 0;
    state.maxSpeed = Number.isFinite(Number(intent.maxSpeed)) ? Math.max(0, Number(intent.maxSpeed)) : 5;
    state.acceleration = Math.max(0, Number(intent.acceleration) || 24);
    state.airControl = Number.isFinite(Number(intent.airControl))
      ? Math.max(0, Math.min(1, Number(intent.airControl))) : 0.25;
    state.active = intent.active !== false;
    state.mode = String(intent.mode || 'manual');
    state.targetId = String(intent.targetId || '');
    return true;
  }
  function setAIState(objectId, state) {
    const controller = getAIController(objectId, true);
    if (!controller) return false;
    controller.state = String(state || 'idle');
    return true;
  }
  function getAIState(objectId) { return getAIController(objectId)?.state ?? null; }

  function getQuestEntity(questId, create = false, initial = null) {
    const key = String(questId);
    let entity = questEntities.get(key);
    if (entity !== undefined) {
      try {
        if (ecs.hasComponent(entity, TYPES.QuestProgress)) return entity;
      } catch (_) {}
    }
    if (!create) return null;
    entity = ecs.createEntity();
    ecs.addComponent(entity, TYPES.QuestProgress, {
      questId: key, started: initial?.started === true, complete: initial?.complete === true,
      progress: Math.max(0, Number(initial?.progress) || 0),
      target: Math.max(1, Number(initial?.target) || 1),
      rewarded: initial?.rewarded === true, ownerId: String(initial?.ownerId || '')
    });
    questEntities.set(key, entity);
    return entity;
  }
  function getQuestState(questId, create = false, initial = null) {
    const entity = getQuestEntity(questId, create, initial);
    return entity === null ? null : ecs.getComponent(entity, TYPES.QuestProgress);
  }
  function listQuests() {
    const result = [];
    for (const [questId, entity] of questEntities) {
      try {
        const state = ecs.getComponent(entity, TYPES.QuestProgress);
        if (state) result.push({ quest: questId, ...clone(state, {}) });
      } catch (_) {}
    }
    return result;
  }
  function getDialogueState(create = false) {
    if (dialogueEntity !== null) {
      try {
        const current = ecs.getComponent(dialogueEntity, TYPES.DialogueSession);
        if (current) return current;
      } catch (_) {}
    }
    if (!create) return null;
    dialogueEntity = ecs.createEntity();
    ecs.addComponent(dialogueEntity, TYPES.DialogueSession);
    return ecs.getComponent(dialogueEntity, TYPES.DialogueSession);
  }
  function copySceneState(objectId, legacy) {
    const health = getSceneComponent(objectId, TYPES.Health);
    const inventory = getInventory(objectId);
    const equipment = getEquipment(objectId);
    const combat = getCombatState(objectId);
    const controller = getAIController(objectId);
    if (health) legacy.setHealth?.(objectId, clone(health, {}));
    if (inventory) legacy.setInventory?.(objectId, clone(inventory.items, {}));
    if (equipment) legacy.setEquipment?.(objectId, clone(equipment.slots, {}));
    if (combat) legacy.setCombat?.(objectId, clone(combat, {}));
    if (controller) legacy.setAIState?.(objectId, controller.state);
  }
  function clearStandaloneEntities() {
    for (const entity of questEntities.values()) {
      try { ecs.destroyEntity(entity); } catch (_) {}
    }
    questEntities.clear();
    if (dialogueEntity !== null) {
      try { ecs.destroyEntity(dialogueEntity); } catch (_) {}
    }
    dialogueEntity = null;
  }

  function initialize(sceneObjects, legacy = {}) {
    registerComponents();
    clearStandaloneEntities();
    for (const object of sceneObjects || []) {
      if (!object || object.id === undefined || object.id === null) continue;
      const id = String(object.id);
      ensureSceneComponent(id, TYPES.Health, legacy.getHealth?.(id));
      ensureSceneComponent(id, TYPES.Inventory, { items: clone(legacy.getInventory?.(id), {}) });
      ensureSceneComponent(id, TYPES.Equipment, { slots: clone(legacy.getEquipment?.(id), {}) });
      ensureSceneComponent(id, TYPES.CombatState, legacy.getCombat?.(id));
      const aiState = legacy.getAIState?.(id);
      if (aiState !== undefined && aiState !== null) {
        const controller = ensureSceneComponent(id, TYPES.AIController);
        if (controller) controller.state = String(aiState);
      }
    }
    for (const [questId, state] of legacy.getQuests?.() || []) getQuestState(questId, true, state);
    const dialogue = legacy.getDialogue?.();
    const session = getDialogueState(true);
    if (dialogue && session) {
      session.signature = String(dialogue.signature || '');
      session.speaker = String(dialogue.speaker || '');
      session.text = String(dialogue.text || '');
      session.choices = Array.isArray(dialogue.choices) ? clone(dialogue.choices, []) : [];
      session.choice = String(dialogue.choice || '');
      session.active = dialogue.active === true;
    }
    active = true;
    return true;
  }
  function persist(sceneObjects, legacy = {}) {
    if (!active) return false;
    for (const object of sceneObjects || []) {
      if (object && object.id !== undefined && object.id !== null) copySceneState(String(object.id), legacy);
    }
    legacy.setQuests?.(listQuests().map(item => [item.quest, {
      started: item.started, complete: item.complete, progress: item.progress,
      target: item.target, rewarded: item.rewarded, ownerId: item.ownerId
    }]));
    const dialogue = getDialogueState();
    if (dialogue) legacy.setDialogue?.(clone(dialogue, {}));
    clearStandaloneEntities();
    active = false;
    return true;
  }
  function getRuntimeState() {
    return {
      active, componentTypes: Object.values(TYPES), questCount: questEntities.size,
      hasDialogueSession: dialogueEntity !== null,
      systems: ecs.getSystems().filter(system => system.id.startsWith('gameplay.')).map(system => system.id)
    };
  }

  registerComponents();
  systems();
  window.PStudioECSGameplay = Object.freeze({
    version: '2.0.0', componentTypes: Object.values(TYPES), initialize, persist,
    getHealth, getInventory, getEquipment, getCombatState, canAttack, getCombo, setCombo,
    setAIController, setAIState, getAIState, setMovementIntent,
    getQuestState, listQuests, getDialogueState, getRuntimeState
  });
})();
