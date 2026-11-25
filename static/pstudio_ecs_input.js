/* PStudio ECS Input Bridge 1.0.0
 * Browser input devices remain owned by the runtime; ECS receives immutable
 * per-frame snapshots and derives explicit per-entity ControlIntent data.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Input] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_input';
  const TYPES = Object.freeze({
    InputSnapshot: 'InputSnapshot',
    PlayerInput: 'PlayerInput',
    ControlIntent: 'ControlIntent'
  });
  const DEFAULT_KEYS = Object.freeze({
    leftKeys: Object.freeze(['a', 'arrowleft']),
    rightKeys: Object.freeze(['d', 'arrowright']),
    forwardKeys: Object.freeze(['w', 'arrowup']),
    backwardKeys: Object.freeze(['s', 'arrowdown']),
    jumpKeys: Object.freeze([' '])
  });

  let snapshotEntity = null;

  function normalizeKey(value) {
    const key = String(value ?? '').toLowerCase();
    const aliases = { left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', space: ' ' };
    return aliases[key] || key;
  }

  function clampAxis(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-1, Math.min(1, number)) : 0;
  }

  function freezeKeys(values) {
    if (!values || typeof values[Symbol.iterator] !== 'function') return Object.freeze([]);
    const result = [];
    const seen = new Set();
    for (const value of values) {
      const key = normalizeKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(key);
    }
    return Object.freeze(result);
  }

  function registerComponent(type, schema, create, description, options = {}) {
    if (ecs.hasComponentType(type)) {
      const definition = ecs.getComponentDefinition(type);
      if (definition?.source !== SOURCE) throw new Error('ECS Component name conflict: ' + type);
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE,
      label: type,
      description,
      category: 'Input',
      internal: options.internal !== false,
      persistent: options.persistent === true,
      additionalProperties: false,
      schema,
      create,
      ...(typeof options.onAdd === 'function' ? { onAdd: options.onAdd } : {}),
      ...(typeof options.onRemove === 'function' ? { onRemove: options.onRemove } : {})
    });
    return true;
  }

  function registerComponents() {
    registerComponent(TYPES.InputSnapshot, {
      frame: { type: 'integer', min: 0, default: 0 },
      keys: { type: 'array', default: [] },
      pressed: { type: 'array', default: [] },
      virtualKeys: { type: 'array', default: [] },
      axisX: { type: 'number', default: 0 },
      axisZ: { type: 'number', default: 0 },
      touched: { type: 'boolean', default: false },
      touchX: { type: 'number', default: 0 },
      touchY: { type: 'number', default: 0 }
    }, () => ({
      frame: 0, keys: Object.freeze([]), pressed: Object.freeze([]),
      virtualKeys: Object.freeze([]), axisX: 0, axisZ: 0,
      touched: false, touchX: 0, touchY: 0
    }), 'Immutable input state captured once at the beginning of each game frame.');

    registerComponent(TYPES.PlayerInput, {
      enabled: { type: 'boolean', default: true },
      leftKeys: { type: 'array', default: ['a', 'arrowleft'] },
      rightKeys: { type: 'array', default: ['d', 'arrowright'] },
      forwardKeys: { type: 'array', default: ['w', 'arrowup'] },
      backwardKeys: { type: 'array', default: ['s', 'arrowdown'] },
      jumpKeys: { type: 'array', default: [' '] }
    }, () => ({
      enabled: true,
      leftKeys: [...DEFAULT_KEYS.leftKeys],
      rightKeys: [...DEFAULT_KEYS.rightKeys],
      forwardKeys: [...DEFAULT_KEYS.forwardKeys],
      backwardKeys: [...DEFAULT_KEYS.backwardKeys],
      jumpKeys: [...DEFAULT_KEYS.jumpKeys]
    }), 'Per-entity keyboard mapping used to derive ControlIntent.', {
      persistent: true,
      internal: false,
      onAdd(entity, value, api) {
        if (!api.hasComponent(entity, TYPES.ControlIntent)) api.addComponent(entity, TYPES.ControlIntent);
      },
      onRemove(entity, value, api) {
        if (api.hasComponent(entity, TYPES.ControlIntent)) api.removeComponent(entity, TYPES.ControlIntent);
      }
    });

    registerComponent(TYPES.ControlIntent, {
      x: { type: 'number', default: 0 },
      z: { type: 'number', default: 0 },
      jump: { type: 'boolean', default: false },
      jumpPressed: { type: 'boolean', default: false },
      active: { type: 'boolean', default: false },
      frame: { type: 'integer', min: 0, default: 0 }
    }, () => ({ x: 0, z: 0, jump: false, jumpPressed: false, active: false, frame: 0 }),
    'Per-entity movement and jump intent derived from the current InputSnapshot.');
  }

  function ensureSnapshotEntity() {
    if (snapshotEntity !== null) {
      try {
        if (ecs.hasComponent(snapshotEntity, TYPES.InputSnapshot)) return snapshotEntity;
      } catch (_) {}
      snapshotEntity = null;
    }
    snapshotEntity = ecs.createEntity();
    ecs.addComponent(snapshotEntity, TYPES.InputSnapshot);
    freezeSnapshot(ecs.getComponent(snapshotEntity, TYPES.InputSnapshot));
    return snapshotEntity;
  }

  function freezeSnapshot(state) {
    Object.freeze(state.keys);
    Object.freeze(state.pressed);
    Object.freeze(state.virtualKeys);
    return Object.freeze(state);
  }

  function snapshotData() {
    const entity = ensureSnapshotEntity();
    const state = ecs.getComponent(entity, TYPES.InputSnapshot);
    return Object.isFrozen(state) ? state : freezeSnapshot(state);
  }

  function captureFrame(raw = {}) {
    const current = snapshotData();
    const state = ecs.setComponent(snapshotEntity, TYPES.InputSnapshot, {
      frame: Math.max(0, Number(current.frame) || 0) + 1,
      keys: freezeKeys(raw.keys),
      pressed: freezeKeys(raw.pressed),
      virtualKeys: freezeKeys(raw.virtualKeys),
      axisX: clampAxis(raw.axisX),
      axisZ: clampAxis(raw.axisZ),
      touched: raw.touched === true,
      touchX: Number.isFinite(Number(raw.touchX)) ? Number(raw.touchX) : 0,
      touchY: Number.isFinite(Number(raw.touchY)) ? Number(raw.touchY) : 0
    });
    freezeSnapshot(state);
    return state.frame;
  }

  function getSnapshot() {
    const state = snapshotData();
    return Object.freeze({
      frame: state.frame,
      keys: state.keys,
      pressed: state.pressed,
      virtualKeys: state.virtualKeys,
      axisX: state.axisX,
      axisZ: state.axisZ,
      touched: state.touched,
      touchX: state.touchX,
      touchY: state.touchY
    });
  }

  function isKeyDown(value) {
    const key = normalizeKey(value);
    const state = snapshotData();
    return state.keys.includes(key) || state.virtualKeys.includes(key);
  }

  function wasKeyPressed(value) {
    return snapshotData().pressed.includes(normalizeKey(value));
  }

  function getAxis(axis) {
    const state = snapshotData();
    const name = String(axis || '').toLowerCase();
    if (name === 'horizontal' || name === 'x') {
      const keyboard = (state.keys.includes('d') || state.keys.includes('arrowright') ? 1 : 0) -
        (state.keys.includes('a') || state.keys.includes('arrowleft') ? 1 : 0);
      return clampAxis(keyboard + state.axisX);
    }
    if (name === 'vertical' || name === 'z') {
      const keyboard = (state.keys.includes('s') || state.keys.includes('arrowdown') ? 1 : 0) -
        (state.keys.includes('w') || state.keys.includes('arrowup') ? 1 : 0);
      return clampAxis(keyboard + state.axisZ);
    }
    return null;
  }

  function isTouched() { return snapshotData().touched; }
  function getTouchX() { return snapshotData().touchX; }
  function getTouchY() { return snapshotData().touchY; }

  function normalizePlayerInput(options = {}) {
    const result = { enabled: options.enabled !== false };
    for (const key of Object.keys(DEFAULT_KEYS)) {
      const source = Array.isArray(options[key]) ? options[key] : DEFAULT_KEYS[key];
      result[key] = [...new Set(source.map(normalizeKey).filter(Boolean))];
    }
    return result;
  }

  function attachPlayerInput(objectId, options = {}) {
    const entity = ecs.getEntityForSceneObject?.(String(objectId));
    if (entity === null || entity === undefined) return false;
    const input = normalizePlayerInput(options);
    if (ecs.hasComponent(entity, TYPES.PlayerInput)) ecs.setComponent(entity, TYPES.PlayerInput, input);
    else ecs.addComponent(entity, TYPES.PlayerInput, input);
    if (!ecs.hasComponent(entity, TYPES.ControlIntent)) ecs.addComponent(entity, TYPES.ControlIntent);
    return true;
  }

  function detachPlayerInput(objectId) {
    const entity = ecs.getEntityForSceneObject?.(String(objectId));
    if (entity === null || entity === undefined) return false;
    const hadInput = ecs.removeComponent(entity, TYPES.PlayerInput);
    const hadIntent = ecs.removeComponent(entity, TYPES.ControlIntent);
    return hadInput || hadIntent;
  }

  function copyIntent(intent) {
    if (!intent) return null;
    return Object.freeze({
      x: intent.x, z: intent.z, jump: intent.jump,
      jumpPressed: intent.jumpPressed, active: intent.active, frame: intent.frame
    });
  }

  function getControlIntent(objectId) {
    const entity = ecs.getEntityForSceneObject?.(String(objectId));
    if (entity === null || entity === undefined || !ecs.hasComponent(entity, TYPES.ControlIntent)) return null;
    return copyIntent(ecs.getComponent(entity, TYPES.ControlIntent));
  }

  function getPlayerInput(objectId) {
    const entity = ecs.getEntityForSceneObject?.(String(objectId));
    if (entity === null || entity === undefined || !ecs.hasComponent(entity, TYPES.PlayerInput)) return null;
    const input = ecs.getComponent(entity, TYPES.PlayerInput);
    return Object.freeze({
      enabled: input.enabled,
      leftKeys: Object.freeze([...input.leftKeys]),
      rightKeys: Object.freeze([...input.rightKeys]),
      forwardKeys: Object.freeze([...input.forwardKeys]),
      backwardKeys: Object.freeze([...input.backwardKeys]),
      jumpKeys: Object.freeze([...input.jumpKeys])
    });
  }

  function hasAny(held, keys) {
    for (const key of keys || []) if (held.has(normalizeKey(key))) return true;
    return false;
  }

  function registerSystem() {
    if (ecs.getSystems().some(system => system.id === 'input.control-intent')) return;
    ecs.registerSystem({
      id: 'input.control-intent',
      name: 'Input Control Intent',
      description: 'Reads the immutable frame snapshot and writes ControlIntent for entities with PlayerInput.',
      components: [TYPES.InputSnapshot],
      phase: 'update',
      priority: -1000,
      internal: true,
      source: SOURCE,
      update(dt, api) {
        const snapshot = api.getComponent(snapshotEntity, TYPES.InputSnapshot);
        if (!snapshot) return;
        const held = new Set(snapshot.keys);
        for (const key of snapshot.virtualKeys) held.add(key);
        const pressed = new Set(snapshot.pressed);
        api.forEach([TYPES.PlayerInput, TYPES.ControlIntent], (entity, binding, intent) => {
          if (!binding.enabled) {
            intent.x = 0; intent.z = 0; intent.jump = false;
            intent.jumpPressed = false; intent.active = false; intent.frame = snapshot.frame;
            return;
          }
          const horizontal = (hasAny(held, binding.rightKeys) ? 1 : 0) -
            (hasAny(held, binding.leftKeys) ? 1 : 0);
          const vertical = (hasAny(held, binding.backwardKeys) ? 1 : 0) -
            (hasAny(held, binding.forwardKeys) ? 1 : 0);
          intent.x = clampAxis(horizontal + snapshot.axisX);
          intent.z = clampAxis(vertical + snapshot.axisZ);
          intent.jump = hasAny(held, binding.jumpKeys);
          intent.jumpPressed = hasAny(pressed, binding.jumpKeys);
          intent.active = true;
          intent.frame = snapshot.frame;
        });
      }
    });
  }

  function reset() {
    const state = ecs.setComponent(ensureSnapshotEntity(), TYPES.InputSnapshot, {
      frame: 0,
      keys: Object.freeze([]),
      pressed: Object.freeze([]),
      virtualKeys: Object.freeze([]),
      axisX: 0, axisZ: 0,
      touched: false, touchX: 0, touchY: 0
    });
    freezeSnapshot(state);
    ecs.forEach([TYPES.ControlIntent], (entity, intent) => {
      intent.x = 0; intent.z = 0; intent.jump = false;
      intent.jumpPressed = false; intent.active = false; intent.frame = 0;
    });
    return true;
  }

  registerComponents();
  ensureSnapshotEntity();
  registerSystem();

  window.PStudioECSInput = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    captureFrame, getSnapshot, isKeyDown, wasKeyPressed, getAxis,
    isTouched, getTouchX, getTouchY,
    attachPlayerInput, detachPlayerInput, getPlayerInput, getControlIntent, reset
  });
})();
