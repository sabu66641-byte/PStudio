/* PStudio ECS Collision Events 1.0.0
 * Collision detection remains owned by the 2D/3D and Physics services.
 * This bridge publishes pair transitions as short-lived ECS event Entities
 * and synchronous PStudioEvents notifications.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Collision] ECS core is unavailable.');
    return;
  }
  const SOURCE = 'pstudio_ecs_collision';
  const TYPE = 'CollisionEvent';
  const previousPairs = new Map();
  const currentPairs = new Map();
  let frame = 0;
  let activeEventEntities = [];
  let retiringEventEntities = [];

  if (ecs.hasComponentType(TYPE)) {
    const definition = ecs.getComponentDefinition(TYPE);
    if (definition?.source !== SOURCE) throw new Error('ECS Component name conflict: ' + TYPE);
  } else {
    ecs.registerComponent(TYPE, {
      source: SOURCE,
      label: 'Collision Event',
      description: 'One-frame ECS notification describing an enter, stay or exit transition for a collision pair.',
      category: 'Physics',
      internal: true,
      persistent: false,
      additionalProperties: false,
      schema: {
        objectAId: { type: 'string', default: '' },
        objectBId: { type: 'string', default: '' },
        entityA: { type: 'entity', nullable: true, default: null },
        entityB: { type: 'entity', nullable: true, default: null },
        nameA: { type: 'string', default: '' },
        nameB: { type: 'string', default: '' },
        dimension: { type: 'string', default: '3d' },
        phase: { type: 'string', default: 'enter' },
        frame: { type: 'integer', min: 0, default: 0 },
        timestamp: { type: 'number', min: 0, default: 0 }
      }
    });
  }

  function idOf(value) {
    if (value && typeof value === 'object') return String(value.id ?? '');
    return String(value ?? '');
  }
  function keyOf(dimension, a, b) {
    const first = idOf(a), second = idOf(b);
    return JSON.stringify([String(dimension || '3d'), ...[first, second].sort()]);
  }
  function pairData(dimension, a, b) {
    const first = idOf(a), second = idOf(b);
    if (!first || !second || first === second) return null;
    const swap = first.localeCompare(second) > 0;
    const left = swap ? b : a, right = swap ? a : b;
    return {
      key: keyOf(dimension, a, b),
      dimension: String(dimension || '3d'),
      objectAId: idOf(left), objectBId: idOf(right),
      nameA: left && typeof left === 'object' ? String(left.name || left.id) : idOf(left),
      nameB: right && typeof right === 'object' ? String(right.name || right.id) : idOf(right)
    };
  }

  function beginFrame() {
    currentPairs.clear();
    frame++;
    return frame;
  }

  function observePair(dimension, objectA, objectB) {
    const pair = pairData(dimension, objectA, objectB);
    if (!pair) return false;
    if (!currentPairs.has(pair.key)) currentPairs.set(pair.key, pair);
    return true;
  }

  function emitNotification(data) {
    const bus = window.PStudioEvents;
    if (!bus || typeof bus.emit !== 'function') return;
    const payload = Object.freeze({
      eventEntity: data.eventEntity,
      objectAId: data.objectAId,
      objectBId: data.objectBId,
      entityA: data.entityA,
      entityB: data.entityB,
      nameA: data.nameA,
      nameB: data.nameB,
      dimension: data.dimension,
      phase: data.phase,
      frame: data.frame,
      timestamp: data.timestamp
    });
    bus.emit('collision.' + data.phase, payload);
    bus.emit('collision', payload);
  }

  function createEvent(pair, phase) {
    const entityA = ecs.getEntityForSceneObject?.(pair.objectAId) ?? null;
    const entityB = ecs.getEntityForSceneObject?.(pair.objectBId) ?? null;
    const timestamp = Date.now();
    const eventEntity = ecs.createEntity();
    const data = {
      objectAId: pair.objectAId,
      objectBId: pair.objectBId,
      entityA,
      entityB,
      nameA: pair.nameA,
      nameB: pair.nameB,
      dimension: pair.dimension,
      phase,
      frame,
      timestamp
    };
    try {
      ecs.addComponent(eventEntity, TYPE, data);
    } catch (error) {
      ecs.destroyEntity(eventEntity);
      throw error;
    }
    activeEventEntities.push(eventEntity);
    emitNotification({ ...data, eventEntity });
    return eventEntity;
  }

  function commitContacts() {
    const events = [];
    const keys = [...currentPairs.keys()].sort();
    for (const key of keys) {
      const pair = currentPairs.get(key);
      events.push(createEvent(pair, previousPairs.has(key) ? 'stay' : 'enter'));
    }
    const previousKeys = [...previousPairs.keys()].sort();
    for (const key of previousKeys) {
      if (!currentPairs.has(key)) events.push(createEvent(previousPairs.get(key), 'exit'));
    }
    previousPairs.clear();
    for (const [key, pair] of currentPairs) previousPairs.set(key, pair);
    return events.length;
  }

  function endFrame() {
    for (const entity of retiringEventEntities) {
      try { ecs.destroyEntity(entity); } catch (_) {}
    }
    retiringEventEntities = activeEventEntities;
    activeEventEntities = [];
    return retiringEventEntities.length;
  }

  function clear() {
    for (const entity of [...activeEventEntities, ...retiringEventEntities]) {
      try { ecs.destroyEntity(entity); } catch (_) {}
    }
    activeEventEntities = [];
    retiringEventEntities = [];
    previousPairs.clear();
    currentPairs.clear();
    frame = 0;
    return true;
  }

  function getState() {
    return Object.freeze({
      frame,
      activeEventCount: activeEventEntities.length,
      retiringEventCount: retiringEventEntities.length,
      activePairCount: previousPairs.size,
      pendingPairCount: currentPairs.size
    });
  }

  window.PStudioECSCollision = Object.freeze({
    version: '1.0.0',
    componentTypes: [TYPE],
    beginFrame,
    observePair,
    commitContacts,
    endFrame,
    clear,
    getState
  });
})();
