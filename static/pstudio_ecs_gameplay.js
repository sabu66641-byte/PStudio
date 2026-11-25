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
    DialogueSession: 'DialogueSession', NavigationNode: 'NavigationNode',
    ItemDefinition: 'ItemDefinition', QuestDefinition: 'QuestDefinition',
    WeaponDefinition: 'WeaponDefinition'
  };
  const questEntities = new Map();
  const navigationNodeEntities = new Map();
  const definitionEntities = {
    ItemDefinition: new Map(),
    QuestDefinition: new Map(),
    WeaponDefinition: new Map()
  };
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
      internal: options.internal !== false,
      persistent: options.persistent === true,
      additionalProperties: false,
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
    }, { label: 'Health', persistent: true });
    registerType(TYPES.Inventory, {
      items: { type: 'json', default: {} }
    }, { label: 'Inventory', persistent: true });
    registerType(TYPES.Equipment, {
      slots: { type: 'json', default: {} }
    }, { label: 'Equipment', persistent: true });
    registerType(TYPES.CombatState, {
      cooldowns: { type: 'json', default: {} },
      comboCount: { type: 'integer', min: 0, max: 5, default: 0 },
      comboTime: { type: 'number', min: 0, default: 0 },
      comboWeapon: { type: 'string', default: '' }
    }, { label: 'Combat State', persistent: true });
    registerType(TYPES.AIController, {
      targetId: { type: 'string', default: '' },
      sightRange: { type: 'number', min: 0, default: 12 },
      attackRange: { type: 'number', min: 0, default: 1.8 },
      speed: { type: 'number', min: 0, default: 3 },
      enabled: { type: 'boolean', default: true },
      state: { type: 'string', default: 'idle' },
      skipLegacyEvaluation: { type: 'boolean', default: false }
    }, { label: 'AI Controller', persistent: true });
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
    registerType(TYPES.NavigationNode, {
      nodeId: { type: 'string', default: '' },
      x: { type: 'number', default: 0 },
      y: { type: 'number', default: 0 },
      z: { type: 'number', default: 0 },
      links: { type: 'array', default: [] },
      blocked: { type: 'boolean', default: false }
    }, {
      label: 'Navigation Node',
      description: 'Runtime navigation graph node. Edges are stored as neighboring node IDs; the ECS Component is the source of truth.'
    });
    registerType(TYPES.ItemDefinition, {
      definitionId: { type: 'string', required: true, maxLength: 128 },
      kind: { type: 'string', default: '', maxLength: 64 },
      slot: { type: 'string', default: '', maxLength: 64 },
      value: { type: 'number', min: 0, default: 0 }
    }, { label: 'Item Definition', description: 'Static project gameplay definition; inventory counts live on Inventory Components.' });
    registerType(TYPES.QuestDefinition, {
      definitionId: { type: 'string', required: true, maxLength: 128 },
      prerequisite: { type: 'string', default: '', maxLength: 128 },
      rewardItem: { type: 'string', default: '', maxLength: 128 },
      rewardCount: { type: 'integer', min: 0, default: 0 }
    }, { label: 'Quest Definition', description: 'Static quest requirements and rewards; live progress lives on QuestProgress Components.' });
    registerType(TYPES.WeaponDefinition, {
      definitionId: { type: 'string', required: true, maxLength: 128 },
      range: { type: 'number', min: 0.1, default: 2 },
      arc: { type: 'number', min: 1, max: 360, default: 100 },
      multiplier: { type: 'number', min: 0, default: 1 }
    }, { label: 'Weapon Definition', description: 'Static weapon combat parameters; cooldowns and combo state live on CombatState Components.' });
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
    const previous = Object.prototype.hasOwnProperty.call(state.cooldowns, key) ? state.cooldowns[key] : null;
    if (previous && now - Number(previous.at || 0) < Math.max(0, Number(previous.duration) || duration)) return false;
    Object.defineProperty(state.cooldowns, key, {
      value: { at: now, duration }, enumerable: true, configurable: true, writable: true
    });
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

  function getDefinitionEntity(type, id, create = false, initial = null) {
    const key = String(id);
    if (!key || key.length > 128) return null;
    const cache = definitionEntities[type];
    if (!cache || !TYPES[type]) return null;
    let entity = cache.get(key);
    if (entity !== undefined) {
      try {
        const current = ecs.getComponent(entity, TYPES[type]);
        if (current?.definitionId === key) return entity;
      } catch (_) {}
      cache.delete(key);
    }
    if (!create) return null;
    entity = ecs.createEntity();
    try {
      ecs.addComponent(entity, TYPES[type], { definitionId: key, ...(initial || {}) });
      cache.set(key, entity);
      return entity;
    } catch (error) {
      try { ecs.destroyEntity(entity); } catch (_) {}
      throw error;
    }
  }

  function setDefinition(type, id, values) {
    const key = String(id);
    if (!key || key.length > 128) throw new TypeError('Gameplay definition ID must contain 1–128 characters.');
    const entity = getDefinitionEntity(type, key, true, values);
    if (entity === null) return false;
    ecs.setComponent(entity, TYPES[type], { definitionId: key, ...(values || {}) });
    return true;
  }

  function getDefinition(type, id) {
    const entity = getDefinitionEntity(type, id, false);
    if (entity === null) return null;
    const data = ecs.getComponent(entity, TYPES[type]);
    const result = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (key !== 'definitionId') result[key] = clone(value);
    }
    return result;
  }

  function listDefinitions(type) {
    const cache = definitionEntities[type];
    if (!cache) return [];
    const result = [];
    for (const [id] of cache) {
      const definition = getDefinition(type, id);
      if (definition) result.push({ id, ...definition });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

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

  // Navigation graph data is stored on standalone ECS Entities. The Map below is
  // only an ID-to-Entity lookup cache; it never owns node coordinates or edges.
  function findNavigationNodeEntity(nodeId) {
    const key = String(nodeId);
    const cached = navigationNodeEntities.get(key);
    if (cached !== undefined) {
      try {
        const data = ecs.getComponent(cached, TYPES.NavigationNode);
        if (data && data.nodeId === key) return cached;
      } catch (_) {}
      navigationNodeEntities.delete(key);
    }
    for (const entity of ecs.query([TYPES.NavigationNode])) {
      const data = ecs.getComponent(entity, TYPES.NavigationNode);
      if (data.nodeId === key) {
        navigationNodeEntities.set(key, entity);
        return entity;
      }
    }
    return null;
  }

  function getNavigationNode(nodeId) {
    const entity = findNavigationNodeEntity(nodeId);
    return entity === null ? null : ecs.getComponent(entity, TYPES.NavigationNode);
  }

  function getNavigationNodes() {
    return ecs.query([TYPES.NavigationNode]).map(entity => ecs.getComponent(entity, TYPES.NavigationNode));
  }

  function getNavigationNodeCount() {
    return ecs.query([TYPES.NavigationNode]).length;
  }

  function addNavigationNode(nodeId, x, y, z) {
    const key = String(nodeId);
    const existing = findNavigationNodeEntity(key);
    if (existing !== null) {
      // Match the previous Map.set behavior: replacing a node resets its own
      // outgoing edges while neighboring nodes may still reference this ID.
      ecs.setComponent(existing, TYPES.NavigationNode, {
        nodeId: key, x: Number.isFinite(Number(x)) ? Number(x) : 0,
        y: Number.isFinite(Number(y)) ? Number(y) : 0,
        z: Number.isFinite(Number(z)) ? Number(z) : 0,
        links: [], blocked: false
      });
      return true;
    }
    const entity = ecs.createEntity();
    ecs.addComponent(entity, TYPES.NavigationNode, {
      nodeId: key,
      x: Number.isFinite(Number(x)) ? Number(x) : 0,
      y: Number.isFinite(Number(y)) ? Number(y) : 0,
      z: Number.isFinite(Number(z)) ? Number(z) : 0,
      links: [],
      blocked: false
    });
    navigationNodeEntities.set(key, entity);
    return true;
  }

  function connectNavigationNodes(fromId, toId) {
    const from = getNavigationNode(fromId);
    const to = getNavigationNode(toId);
    if (!from || !to) return false;
    const a = String(toId), b = String(fromId);
    if (!from.links.includes(a)) from.links.push(a);
    if (!to.links.includes(b)) to.links.push(b);
    return true;
  }

  function setNavigationNodeBlocked(nodeId, blocked = true) {
    const node = getNavigationNode(nodeId);
    if (!node) return false;
    node.blocked = !!blocked;
    return true;
  }

  function clearNavigationNodes() {
    const entities = ecs.query([TYPES.NavigationNode]);
    for (const entity of entities) ecs.destroyEntity(entity);
    navigationNodeEntities.clear();
    return true;
  }

  function getNearestNavigationNodes(positions) {
    const targets = Array.isArray(positions) ? positions : [];
    const best = targets.map(() => ({ node: null, distance: Infinity }));
    ecs.forEach([TYPES.NavigationNode], (entity, node) => {
      for (let index = 0; index < targets.length; index++) {
        const point = targets[index] || {};
        const distance = Math.hypot(
          node.x - (Number(point.x) || 0),
          node.y - (Number(point.y) || 0),
          node.z - (Number(point.z) || 0)
        );
        if (distance < best[index].distance) {
          best[index].distance = distance;
          best[index].node = node;
        }
      }
    });
    return best.map(item => item.node);
  }

  function getNearestNavigationNode(position) {
    return getNearestNavigationNodes([position])[0] || null;
  }

  function findNavigationNext(startId, goalId) {
    const start = String(startId), goal = String(goalId);
    const startNode = getNavigationNode(start), goalNode = getNavigationNode(goal);
    if (!startNode || !goalNode || goalNode.blocked) return '';
    const distance = (a, b) => {
      const p = getNavigationNode(a), q = getNavigationNode(b);
      return p && q ? Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) : Infinity;
    };
    const open = [start], came = new Map();
    const g = new Map([[start, 0]]);
    const f = new Map([[start, distance(start, goal)]]);
    const closed = new Set();
    while (open.length) {
      open.sort((a, b) => (f.get(a) || Infinity) - (f.get(b) || Infinity));
      const id = open.shift();
      if (id === goal) break;
      closed.add(id);
      const current = getNavigationNode(id);
      if (!current) continue;
      for (const next of current.links) {
        const neighbor = getNavigationNode(next);
        if (!neighbor || neighbor.blocked || closed.has(next)) continue;
        const score = (g.get(id) || 0) + distance(id, next);
        if (score < (g.get(next) ?? Infinity)) {
          came.set(next, id);
          g.set(next, score);
          f.set(next, score + distance(next, goal));
          if (!open.includes(next)) open.push(next);
        }
      }
    }
    if (start !== goal && !came.has(goal)) return '';
    let step = goal;
    while (came.get(step) !== start && came.has(step)) step = came.get(step);
    return step === start ? '' : step;
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
    for (const [questId, state] of legacy.getQuests?.() || []) {
      if (!getQuestState(questId)) getQuestState(questId, true, state);
    }
    const existingSession = getDialogueState();
    const dialogue = existingSession ? null : legacy.getDialogue?.();
    const session = existingSession || getDialogueState(true);
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
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = sceneEntity(String(object.id));
      if (entity === null) continue;
      if (typeof ecs.serializeEntityComponents === 'function') {
        const serialized = ecs.serializeEntityComponents(
          entity, ['Transform', 'SceneObjectRef'], object
        );
        if (!serialized) {
          console.warn('[PStudio ECS Gameplay] skipped writing a future-version Component payload:', object.id);
          continue;
        }
        object.ecsComponentsVersion = serialized.version;
        object.ecsComponents = serialized.components;
      } else {
        // Compatibility with an older ECS core. Current PStudio always uses the
        // versioned serializer above.
        copySceneState(String(object.id), legacy);
      }
    }
    // QuestProgress and DialogueSession are standalone ECS Entities. They remain
    // in ECS across Stop/Play; no legacy Map snapshot is created.
    active = false;
    return true;
  }
  function getRuntimeState() {
    return {
      active, componentTypes: Object.values(TYPES), questCount: questEntities.size,
      navigationNodeCount: getNavigationNodeCount(),
      hasDialogueSession: dialogueEntity !== null,
      systems: ecs.getSystems().filter(system => system.id.startsWith('gameplay.')).map(system => system.id)
    };
  }

  registerComponents();
  systems();
  window.PStudioECSGameplay = Object.freeze({
    version: '2.0.0', componentTypes: Object.values(TYPES), initialize, persist,
    getHealth, getInventory, getEquipment, getCombatState, canAttack, getCombo, setCombo,
    getAIController, getMovementIntent, setAIController, setAIState, getAIState, setMovementIntent,
    getQuestState, listQuests, getDialogueState,
    setItemDefinition: (id, value) => setDefinition('ItemDefinition', id, {
      kind: String(value?.kind || '').slice(0, 64),
      slot: String(value?.slot || '').slice(0, 64),
      value: Math.max(0, Number(value?.value) || 0)
    }),
    getItemDefinition: id => getDefinition('ItemDefinition', id),
    listItemDefinitions: () => listDefinitions('ItemDefinition'),
    setQuestDefinition: (id, value) => setDefinition('QuestDefinition', id, {
      prerequisite: String(value?.prerequisite || '').slice(0, 128),
      rewardItem: String(value?.rewardItem || '').slice(0, 128),
      rewardCount: Math.max(0, Math.floor(Number(value?.rewardCount) || 0))
    }),
    getQuestDefinition: id => getDefinition('QuestDefinition', id),
    listQuestDefinitions: () => listDefinitions('QuestDefinition'),
    setWeaponDefinition: (id, value) => setDefinition('WeaponDefinition', id, {
      range: Math.max(0.1, Number(value?.range) || 2),
      arc: Math.max(1, Math.min(360, Number(value?.arc) || 100)),
      multiplier: Math.max(0, Number(value?.multiplier) || 0)
    }),
    getWeaponDefinition: id => getDefinition('WeaponDefinition', id),
    listWeaponDefinitions: () => listDefinitions('WeaponDefinition'),
    addNavigationNode, connectNavigationNodes, getNavigationNode, getNavigationNodes,
    getNavigationNodeCount, setNavigationNodeBlocked, clearNavigationNodes,
    getNearestNavigationNode, getNearestNavigationNodes, findNavigationNext, getRuntimeState
  });
})();
