/* PStudio ECS Time State 1.0.0
 * ECS owns the runtime simulation clock state; the browser frame scheduler remains service-owned.
 */
(() => {
  'use strict';

  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Time] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_time';
  const TYPE = 'TimeState';
  const MAX_TIME_SCALE = 4;
  const MAX_DELTA_TIME = 0.1;
  let entity = null;

  const finite = (value, fallback = 0) => {
    try {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    } catch (_) {
      return fallback;
    }
  };
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function defaults() {
    return {
      timeScale: 1,
      deltaTime: 0,
      unscaledDeltaTime: 0,
      elapsedTime: 0,
      unscaledElapsedTime: 0,
      frame: 0
    };
  }

  if (ecs.hasComponentType(TYPE)) {
    const definition = ecs.getComponentDefinition(TYPE);
    if (definition?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + TYPE);
    }
  } else {
    ecs.registerComponent(TYPE, {
      source: SOURCE,
      label: 'Time State',
      description: 'Runtime-only simulation clock and time-scale state. The requestAnimationFrame scheduler remains a platform service.',
      category: 'Runtime',
      persistent: false,
      internal: true,
      readonly: false,
      additionalProperties: false,
      schema: {
        timeScale: { type: 'number', min: 0, max: MAX_TIME_SCALE, default: 1, label: 'Time Scale' },
        deltaTime: { type: 'number', min: 0, max: MAX_DELTA_TIME, default: 0, label: 'Scaled Delta Time' },
        unscaledDeltaTime: { type: 'number', min: 0, default: 0, label: 'Unscaled Delta Time' },
        elapsedTime: { type: 'number', min: 0, default: 0, label: 'Simulation Time' },
        unscaledElapsedTime: { type: 'number', min: 0, default: 0, label: 'Unscaled Elapsed Time' },
        frame: { type: 'integer', min: 0, default: 0, label: 'Frame' }
      },
      create: defaults
    });
  }

  function ensureEntity() {
    if (entity !== null) {
      try {
        const state = ecs.getComponent(entity, TYPE);
        if (state) return entity;
        ecs.setComponent(entity, TYPE, defaults());
        return entity;
      } catch (_) {
        entity = null;
      }
    }
    entity = ecs.createEntity({ [TYPE]: defaults() });
    return entity;
  }

  function mutableState() {
    return ecs.getComponent(ensureEntity(), TYPE);
  }

  function snapshot() {
    return Object.freeze({ ...mutableState() });
  }

  function start() {
    const state = mutableState();
    Object.assign(state, defaults());
    return snapshot();
  }

  function setTimeScale(value) {
    const state = mutableState();
    state.timeScale = clamp(finite(value, 0), 0, MAX_TIME_SCALE);
    return state.timeScale;
  }

  function beginFrame(rawDeltaTime) {
    const state = mutableState();
    const raw = Math.max(0, finite(rawDeltaTime, 0));
    const scaled = Math.min(MAX_DELTA_TIME, raw * state.timeScale);
    state.unscaledDeltaTime = raw;
    state.deltaTime = scaled;
    state.elapsedTime += scaled;
    state.unscaledElapsedTime += raw;
    state.frame += 1;
    return scaled;
  }

  function clear() {
    if (entity === null) return false;
    const previous = entity;
    entity = null;
    try {
      ecs.destroyEntity(previous);
      return true;
    } catch (_) {
      return false;
    }
  }

  window.PStudioECSTime = Object.freeze({
    version: '1.0.0',
    componentType: TYPE,
    start,
    setTimeScale,
    getTimeScale() { return mutableState().timeScale; },
    beginFrame,
    getState: snapshot,
    clear
  });
})();
