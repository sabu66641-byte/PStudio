/* PStudio ECS Rendering Bridge 1.0.0
 * ECS owns declarative rendering configuration.
 * Three.js objects, animation mixers and GPU resources remain renderer-owned.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Rendering] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_rendering';
  const TYPES = Object.freeze({
    Camera: 'Camera',
    Light: 'Light',
    Renderable: 'Renderable',
    Animation: 'Animation'
  });

  function register(type, options) {
    if (!ecs.hasComponentType(type)) {
      ecs.registerComponent(type, { source: SOURCE, ...options });
      return;
    }
    const existing = ecs.getComponentDefinition(type);
    if (existing?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + type);
    }
  }

  const vector3 = (x, y, z) => ({ x, y, z });
  const normalizeVector3 = (value, fallback) => ({
    x: Number.isFinite(Number(value?.x)) ? Number(value.x) : fallback.x,
    y: Number.isFinite(Number(value?.y)) ? Number(value.y) : fallback.y,
    z: Number.isFinite(Number(value?.z)) ? Number(value.z) : fallback.z
  });

  function registerComponents() {
    register(TYPES.Camera, {
      label: 'Camera',
      description: 'Scene camera configuration. The renderer creates and owns the actual camera.',
      category: 'Rendering',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },
        priority: { type: 'integer', min: -1000, max: 1000, default: 0, label: 'Priority' },
        offset: { type: 'vector3', default: vector3(6, 5, 8), label: 'Position Offset' },
        targetOffset: { type: 'vector3', default: vector3(0, 1, 0), label: 'Target Offset' },
        targetObjectId: { type: 'string', maxLength: 128, default: '', label: 'Target Object ID' },
        smoothing: { type: 'number', min: 0, max: 30, default: 0, label: 'Smoothing' }
      },
      create: () => ({
        enabled: true, priority: 0, offset: vector3(6, 5, 8),
        targetOffset: vector3(0, 1, 0), targetObjectId: '', smoothing: 0
      }),
      normalize: value => ({
        ...value,
        enabled: value.enabled !== false,
        priority: Math.max(-1000, Math.min(1000, Math.trunc(Number(value.priority) || 0))),
        offset: normalizeVector3(value.offset, vector3(6, 5, 8)),
        targetOffset: normalizeVector3(value.targetOffset, vector3(0, 1, 0)),
        targetObjectId: String(value.targetObjectId || '').slice(0, 128),
        smoothing: Math.max(0, Math.min(30, Number(value.smoothing) || 0))
      })
    });

    register(TYPES.Light, {
      label: 'Light',
      description: 'Point or spot light configuration. GPU light objects are renderer-owned.',
      category: 'Rendering',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },
        kind: { type: 'enum', options: ['point', 'spot'], default: 'point', label: 'Type' },
        color: { type: 'color', default: '#ffffff', label: 'Color' },
        intensity: { type: 'number', min: 0, max: 100000, default: 1, label: 'Intensity' },
        distance: { type: 'number', min: 0, max: 20000, default: 0, label: 'Distance' },
        angle: { type: 'number', min: 0.01, max: 1.55, default: 0.6283185307, label: 'Spot Angle' },
        targetOffset: { type: 'vector3', default: vector3(0, 0, 0), label: 'Target Offset' }
      },
      create: () => ({
        enabled: true, kind: 'point', color: '#ffffff', intensity: 1,
        distance: 0, angle: 0.6283185307, targetOffset: vector3(0, 0, 0)
      }),
      normalize: value => ({
        ...value,
        enabled: value.enabled !== false,
        kind: value.kind === 'spot' ? 'spot' : 'point',
        color: /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(String(value.color || '')) ? String(value.color) : '#ffffff',
        intensity: Math.max(0, Math.min(100000, Number(value.intensity) || 0)),
        distance: Math.max(0, Math.min(20000, Number(value.distance) || 0)),
        angle: Math.max(0.01, Math.min(1.55, Number(value.angle) || 0.6283185307)),
        targetOffset: normalizeVector3(value.targetOffset, vector3(0, 0, 0))
      })
    });

    register(TYPES.Renderable, {
      label: 'Renderable',
      description: 'Visibility and shadow flags. The renderer owns mesh and material resources.',
      category: 'Rendering',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },
        visible: { type: 'boolean', default: true, label: 'Visible' },
        castShadow: { type: 'boolean', default: true, label: 'Cast Shadows' },
        receiveShadow: { type: 'boolean', default: true, label: 'Receive Shadows' }
      },
      create: () => ({ enabled: true, visible: true, castShadow: true, receiveShadow: true }),
      normalize: value => ({
        enabled: value.enabled !== false,
        visible: value.visible !== false,
        castShadow: value.castShadow !== false,
        receiveShadow: value.receiveShadow !== false
      })
    });

    register(TYPES.Animation, {
      label: 'Animation',
      description: 'Animation playback intent. Three.js AnimationMixer and actions remain renderer-owned.',
      category: 'Rendering',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },
        playing: { type: 'boolean', default: true, label: 'Playing' },
        clipName: { type: 'string', maxLength: 128, default: '', label: 'Clip Name' },
        loop: { type: 'boolean', default: true, label: 'Loop' },
        speed: { type: 'number', min: -8, max: 8, default: 1, label: 'Playback Speed' },
        blendFirst: { type: 'string', maxLength: 128, default: '', label: 'Blend Clip A' },
        blendSecond: { type: 'string', maxLength: 128, default: '', label: 'Blend Clip B' },
        blendWeight: { type: 'number', min: 0, max: 1, default: 0.5, label: 'Blend Weight' }
      },
      create: () => ({
        enabled: true, playing: true, clipName: '', loop: true, speed: 1,
        blendFirst: '', blendSecond: '', blendWeight: 0.5
      }),
      normalize: value => ({
        ...value,
        enabled: value.enabled !== false,
        playing: value.playing !== false,
        clipName: String(value.clipName || '').slice(0, 128),
        loop: value.loop !== false,
        speed: Math.max(-8, Math.min(8, Number(value.speed) || 0)),
        blendFirst: String(value.blendFirst || '').slice(0, 128),
        blendSecond: String(value.blendSecond || '').slice(0, 128),
        blendWeight: Math.max(0, Math.min(1, Number(value.blendWeight) || 0))
      })
    });
  }

  function scenePosition(object, transform) {
    const width = Number(object?.w) || 64;
    const height = Number(object?.h) || 64;
    return {
      x: (Number(transform?.x) + width / 2 - 480) / 100,
      y: (270 - (Number(transform?.y) + height / 2)) / 100,
      z: Number(transform?.z) / 100
    };
  }

  function addOwnerCommand(additions, ownerId, command) {
    const key = String(ownerId);
    if (!additions.has(key)) additions.set(key, []);
    additions.get(key).push(command);
  }

  function buildCommands(commands, sceneObjects, deltaTime = 1 / 60) {
    if (!(commands instanceof Map)) throw new TypeError('Rendering bridge expects a Map of draw commands.');
    const objects = new Map((Array.isArray(sceneObjects) ? sceneObjects : [])
      .filter(object => object?.id !== undefined && object?.id !== null)
      .map(object => [String(object.id), object]));
    const additions = new Map();
    const dt = Number.isFinite(Number(deltaTime)) ? Math.max(0, Math.min(0.1, Number(deltaTime))) : 1 / 60;

    for (const entity of ecs.query(['SceneObjectRef', 'Transform', TYPES.Renderable])) {
      const ref = ecs.getComponent(entity, 'SceneObjectRef');
      const object = objects.get(String(ref?.sceneObjectId));
      if (!object) continue;
      const value = ecs.getComponent(entity, TYPES.Renderable);
      addOwnerCommand(additions, ref.sceneObjectId, {
        type: 'renderable',
        enabled: value.enabled !== false,
        visible: value.visible !== false,
        castShadow: value.castShadow !== false,
        receiveShadow: value.receiveShadow !== false
      });
    }

    for (const entity of ecs.query(['SceneObjectRef', 'Transform', TYPES.Light])) {
      const ref = ecs.getComponent(entity, 'SceneObjectRef');
      const object = objects.get(String(ref?.sceneObjectId));
      const value = ecs.getComponent(entity, TYPES.Light);
      if (!object || value.enabled === false) continue;
      const position = scenePosition(object, ecs.getComponent(entity, 'Transform'));
      const targetOffset = normalizeVector3(value.targetOffset, vector3(0, 0, 0));
      addOwnerCommand(additions, ref.sceneObjectId, {
        type: 'light',
        componentKey: 'ecs-light',
        kind: value.kind === 'spot' ? 'spot' : 'point',
        x: position.x, y: position.y, z: position.z,
        targetX: position.x + targetOffset.x,
        targetY: position.y + targetOffset.y,
        targetZ: position.z + targetOffset.z,
        intensity: Number(value.intensity) || 0,
        color: value.color || '#ffffff',
        distance: Number(value.distance) || 0,
        angle: Number(value.angle) || 0.6283185307
      });
    }

    for (const entity of ecs.query(['SceneObjectRef', 'Animation'])) {
      const ref = ecs.getComponent(entity, 'SceneObjectRef');
      if (!objects.has(String(ref?.sceneObjectId))) continue;
      const value = ecs.getComponent(entity, TYPES.Animation);
      if (value.enabled === false || value.playing === false) {
        addOwnerCommand(additions, ref.sceneObjectId, { type: 'animation', stop: true, dt });
        continue;
      }
      if (value.clipName) {
        addOwnerCommand(additions, ref.sceneObjectId, {
          type: 'animation', clipName: value.clipName,
          loop: value.loop !== false, speed: Number(value.speed) || 0, dt
        });
      }
      if (value.blendFirst && value.blendSecond) {
        addOwnerCommand(additions, ref.sceneObjectId, {
          type: 'animation_blend',
          first: value.blendFirst, second: value.blendSecond,
          weight: Math.max(0, Math.min(1, Number(value.blendWeight) || 0)), dt
        });
      }
    }

    for (const [ownerId, componentCommands] of additions) {
      const existing = commands.get(ownerId) || [];
      commands.set(ownerId, [...componentCommands, ...(Array.isArray(existing) ? existing : [])]);
    }

    const cameras = [];
    for (const entity of ecs.query(['SceneObjectRef', 'Transform', TYPES.Camera])) {
      const ref = ecs.getComponent(entity, 'SceneObjectRef');
      const object = objects.get(String(ref?.sceneObjectId));
      const value = ecs.getComponent(entity, TYPES.Camera);
      if (!object || value.enabled === false) continue;
      const position = scenePosition(object, ecs.getComponent(entity, 'Transform'));
      const offset = normalizeVector3(value.offset, vector3(6, 5, 8));
      const targetOffset = normalizeVector3(value.targetOffset, vector3(0, 1, 0));
      const targetObject = value.targetObjectId ? objects.get(String(value.targetObjectId)) : null;
      const targetEntity = targetObject ? ecs.getEntityForSceneObject(targetObject.id) : null;
      const targetTransform = targetEntity && ecs.hasComponent(targetEntity, 'Transform')
        ? ecs.getComponent(targetEntity, 'Transform') : null;
      const targetBase = targetObject ? scenePosition(targetObject, targetTransform) : position;
      cameras.push({
        entity,
        priority: Number(value.priority) || 0,
        command: {
          type: 'camera',
          x: position.x + offset.x,
          y: position.y + offset.y,
          z: position.z + offset.z,
          targetX: targetBase.x + targetOffset.x,
          targetY: targetBase.y + targetOffset.y,
          targetZ: targetBase.z + targetOffset.z,
          smoothing: Math.max(0, Math.min(30, Number(value.smoothing) || 0)),
          dt,
          cameraOwnerId: ref.sceneObjectId
        }
      });
    }
    if (cameras.length) {
      cameras.sort((a, b) => b.priority - a.priority || a.entity - b.entity);
      // This dedicated final entry makes ECS camera priority authoritative over legacy per-object set_camera calls.
      commands.set('__ecs_camera__', [cameras[0].command]);
    }

    return {
      cameraEntity: cameras.length ? cameras.sort((a, b) => b.priority - a.priority || a.entity - b.entity)[0].entity : null,
      ownerCount: additions.size,
      commandCount: [...additions.values()].reduce((sum, list) => sum + list.length, 0)
    };
  }

  function isVisible(ownerId) {
    const entity = ecs.getEntityForSceneObject(ownerId);
    if (!entity || !ecs.hasComponent(entity, TYPES.Renderable)) return true;
    const value = ecs.getComponent(entity, TYPES.Renderable);
    return value.enabled !== false && value.visible !== false;
  }

  function clear() {
    // Authoring Components intentionally survive Play/Stop; only derived bridge state is transient.
    return true;
  }

  function getState() {
    const cameras = ecs.query([TYPES.Camera]);
    const activeCameras = cameras.some(entity => ecs.getComponent(entity, TYPES.Camera)?.enabled !== false);
    return Object.freeze({
      cameras: cameras.length,
      activeCameras: activeCameras ? 1 : 0,
      lights: ecs.query([TYPES.Light]).length,
      renderables: ecs.query([TYPES.Renderable]).length,
      animations: ecs.query([TYPES.Animation]).length
    });
  }

  registerComponents();
  window.PStudioECSRendering = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    buildCommands,
    isVisible,
    clear,
    getState
  });
})();
