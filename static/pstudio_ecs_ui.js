/* PStudio ECS UI Intent Bridge 1.0.0
 * ECS owns the active gameplay overlay intent; PStudioUI remains the DOM renderer.
 * The singleton overlay is transient runtime state and is never saved to projects.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS UI] ECS core is unavailable.');
    return;
  }

  const TYPE = 'UIOverlay';
  const SOURCE = 'pstudio_ecs_ui';
  const OVERLAY_TYPES = new Set(['inventory', 'quests', 'dialogue']);
  let singletonEntity = null;

  if (ecs.hasComponentType(TYPE)) {
    if (ecs.getComponentDefinition(TYPE)?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + TYPE);
    }
  } else {
    ecs.registerComponent(TYPE, {
      source: SOURCE,
      label: 'Active UI Overlay',
      description: 'Transient gameplay UI intent. PStudioUI owns all DOM presentation.',
      category: 'UI',
      internal: true,
      persistent: false,
      readonly: false,
      additionalProperties: false,
      schema: {
        type: { type: 'enum', options: ['inventory', 'quests', 'dialogue'], default: 'dialogue' },
        ownerId: { type: 'string', maxLength: 128, default: '' },
        visible: { type: 'boolean', default: false }
      },
      create: () => ({ type: 'dialogue', ownerId: '', visible: false })
    });
  }

  function entityExists(entity) {
    return Number.isSafeInteger(entity) && ecs.getEntities(true).includes(entity);
  }

  function ensureEntity() {
    if (!entityExists(singletonEntity)) {
      singletonEntity = ecs.createEntity({
        [TYPE]: { type: 'dialogue', ownerId: '', visible: false }
      });
    }
    return singletonEntity;
  }

  function open(type, ownerId = '') {
    const key = String(type || '');
    if (!OVERLAY_TYPES.has(key)) throw new TypeError('Unsupported UI overlay type: ' + key);
    const entity = ensureEntity();
    ecs.setComponent(entity, TYPE, {
      type: key,
      ownerId: String(ownerId ?? '').slice(0, 128),
      visible: true
    });
    return true;
  }

  function close() {
    const entity = ensureEntity();
    const current = ecs.getComponent(entity, TYPE);
    if (!current.visible && !current.ownerId) return true;
    ecs.setComponent(entity, TYPE, { type: current.type, ownerId: '', visible: false });
    return true;
  }

  function getOverlay() {
    const entity = ensureEntity();
    const data = ecs.getComponent(entity, TYPE);
    if (!data.visible) return null;
    return Object.freeze({ type: data.type, ownerId: data.ownerId });
  }

  function getState() {
    const entity = ensureEntity();
    const data = ecs.getComponent(entity, TYPE);
    return Object.freeze({ type: data.type, ownerId: data.ownerId, visible: data.visible });
  }

  const api = Object.freeze({
    version: '1.0.0',
    componentType: TYPE,
    open,
    close,
    clear: close,
    getOverlay,
    getState,
    getEntity: ensureEntity
  });
  window.PStudioECSUI = api;
})();
