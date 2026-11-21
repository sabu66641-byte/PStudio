/* PStudio ECS Scene Presentation bridge 1.0.0
 * Projects keep their compatible Scene Object authoring format. During Play,
 * per-Entity presentation/collider state is projected into ECS Components;
 * renderer and collision services consume that ECS state through this adapter.
 */
(() => {
  'use strict';

  const ecs = () => window.PStudioECS;
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, finite(value, fallback)));
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const color = value => /^#[0-9a-fA-F]{6}$/.test(text(value)) ? value : '#d1d5db';
  const clone = value => {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  };

  function register(type, options) {
    const api = ecs();
    if (!api) return false;
    if (!api.hasComponentType(type)) api.registerComponent(type, options);
    return true;
  }

  register('SpriteRenderer', {
    label: 'Sprite Renderer',
    category: 'Rendering',
    description: 'Per-Entity 2D sprite and primitive presentation settings.',
    schema: {
      visible: { type: 'boolean', default: true },
      shape: { type: 'enum', options: ['rect', 'circle'], default: 'rect' },
      width: { type: 'number', default: 64, min: 1 },
      height: { type: 'number', default: 64, min: 1 },
      color: { type: 'color', default: '#d1d5db' },
      sprite: { type: 'string', default: '' }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('MeshRenderer', {
    label: 'Mesh Renderer',
    category: 'Rendering',
    description: 'Per-Entity imported 3D model reference and scale.',
    schema: {
      enabled: { type: 'boolean', default: false },
      model: { type: 'string', default: '' },
      scale: { type: 'number', default: 1, min: 0.001, max: 10000 }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('MaterialSettings', {
    label: 'Material Settings',
    category: 'Rendering',
    description: 'Per-Entity material shader and model material overrides.',
    schema: {
      shaderFragment: { type: 'string', default: '' },
      toonSettings: { type: 'json', default: null },
      modelOverrides: { type: 'array', default: [] }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('PostProcessingSettings', {
    label: 'Post Processing Settings',
    category: 'Rendering',
    description: 'Per-Entity post-processing flags and strength.',
    schema: {
      enabled: { type: 'boolean', default: false },
      bloom: { type: 'boolean', default: false },
      ssao: { type: 'boolean', default: false },
      strength: { type: 'number', default: 0.45, min: 0, max: 4 }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('ParticleEmitter', {
    label: 'Particle Emitter',
    category: 'Rendering',
    description: 'Per-Entity GPU particle emitter configuration.',
    schema: {
      enabled: { type: 'boolean', default: false },
      rate: { type: 'number', default: 12, min: 0, max: 10000 },
      color: { type: 'color', default: '#ffffff' },
      speed: { type: 'number', default: 2, min: 0, max: 1000 },
      lifetime: { type: 'number', default: 1, min: 0.01, max: 120 },
      maxCount: { type: 'integer', default: 200, min: 1, max: 1200 }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('Collider2D', {
    label: '2D Collider',
    category: 'Physics',
    description: 'Per-Entity 2D collision participation and shape.',
    schema: {
      enabled: { type: 'boolean', default: false },
      shape: { type: 'enum', options: ['rect', 'circle'], default: 'rect' }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  function sceneEntity(objectOrId) {
    const api = ecs();
    const id = typeof objectOrId === 'object' && objectOrId ? objectOrId.id : objectOrId;
    return api && id !== undefined && id !== null ? api.getEntityForSceneObject(String(id)) : null;
  }

  function ensure(entity, type, data) {
    const api = ecs();
    if (!api || !entity) return null;
    if (!api.hasComponent(entity, type)) api.addComponent(entity, type, data);
    return api.getComponent(entity, type);
  }

  function normalizeObject(object) {
    const toon = object.toonMaterialSettings && typeof object.toonMaterialSettings === 'object'
      ? clone(object.toonMaterialSettings) : null;
    const overrides = Array.isArray(object.modelMaterialOverrides)
      ? clone(object.modelMaterialOverrides.slice(0, 64)) : [];
    const post = object.postProcessing && typeof object.postProcessing === 'object'
      ? object.postProcessing : null;
    const emitter = object.particleEmitter && typeof object.particleEmitter === 'object'
      ? object.particleEmitter : null;
    return {
      sprite: {
        visible: object.visible !== false,
        shape: object.shape === 'circle' ? 'circle' : 'rect',
        width: bounded(object.w, 64, 1, 100000),
        height: bounded(object.h, 64, 1, 100000),
        color: color(object.color),
        sprite: text(object.sprite)
      },
      mesh: {
        enabled: !!object.model,
        model: text(object.model),
        scale: bounded(object.modelScale, 1, 0.001, 10000)
      },
      material: {
        shaderFragment: text(object.shaderFragment),
        toonSettings: toon,
        modelOverrides: Array.isArray(overrides) ? overrides : []
      },
      post: {
        enabled: !!post,
        bloom: !!post?.bloom,
        ssao: !!post?.ssao,
        strength: bounded(post?.strength, 0.45, 0, 4)
      },
      emitter: {
        enabled: emitter?.enabled === true,
        rate: bounded(emitter?.rate, 12, 0, 10000),
        color: /^#[0-9a-fA-F]{6}$/.test(text(emitter?.color)) ? emitter.color : '#ffffff',
        speed: bounded(emitter?.speed, 2, 0, 1000),
        lifetime: bounded(emitter?.lifetime, 1, 0.01, 120),
        maxCount: Math.floor(bounded(emitter?.maxCount, 200, 1, 1200))
      },
      collider: {
        enabled: !!object.collider,
        shape: object.shape === 'circle' ? 'circle' : 'rect'
      }
    };
  }

  function syncSceneObjects(sceneObjects) {
    const api = ecs();
    if (!api || !Array.isArray(sceneObjects)) return 0;
    let synchronized = 0;
    for (const object of sceneObjects) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = sceneEntity(object.id);
      if (!entity) continue;
      const values = normalizeObject(object);
      ensure(entity, 'SpriteRenderer', values.sprite);
      ensure(entity, 'MeshRenderer', values.mesh);
      ensure(entity, 'MaterialSettings', values.material);
      ensure(entity, 'PostProcessingSettings', values.post);
      ensure(entity, 'ParticleEmitter', values.emitter);
      ensure(entity, 'Collider2D', values.collider);
      synchronized++;
    }
    return synchronized;
  }

  function getComponent(objectOrId, type) {
    const api = ecs();
    const entity = sceneEntity(objectOrId);
    if (!api || !entity || !api.hasComponent(entity, type)) return null;
    return api.getComponent(entity, type);
  }

  function getRenderState(object) {
    if (!object || object.id === undefined || object.id === null) return null;
    const sprite = getComponent(object.id, 'SpriteRenderer');
    const mesh = getComponent(object.id, 'MeshRenderer');
    const material = getComponent(object.id, 'MaterialSettings');
    const post = getComponent(object.id, 'PostProcessingSettings');
    const emitter = getComponent(object.id, 'ParticleEmitter');
    const collider = getComponent(object.id, 'Collider2D');
    if (!sprite && !mesh && !material && !post && !emitter && !collider) return null;
    return {
      spriteRenderer: sprite || {
        visible: object.visible !== false,
        shape: object.shape === 'circle' ? 'circle' : 'rect',
        width: finite(object.w, 64), height: finite(object.h, 64),
        color: color(object.color), sprite: text(object.sprite)
      },
      meshRenderer: mesh || { enabled: !!object.model, model: text(object.model), scale: finite(object.modelScale, 1) },
      material: material || {
        shaderFragment: text(object.shaderFragment),
        toonSettings: object.toonMaterialSettings || null,
        modelOverrides: Array.isArray(object.modelMaterialOverrides) ? object.modelMaterialOverrides : []
      },
      postProcessing: post || {
        enabled: !!object.postProcessing,
        bloom: !!object.postProcessing?.bloom,
        ssao: !!object.postProcessing?.ssao,
        strength: finite(object.postProcessing?.strength, 0.45)
      },
      particleEmitter: emitter || {
        enabled: object.particleEmitter?.enabled === true,
        rate: finite(object.particleEmitter?.rate, 12),
        color: color(object.particleEmitter?.color || '#ffffff'),
        speed: finite(object.particleEmitter?.speed, 2),
        lifetime: finite(object.particleEmitter?.lifetime, 1),
        maxCount: finite(object.particleEmitter?.maxCount, 200)
      },
      collider2D: collider || { enabled: !!object.collider, shape: object.shape === 'circle' ? 'circle' : 'rect' }
    };
  }

  window.PStudioECSScene = Object.freeze({
    syncSceneObjects,
    getComponent,
    getRenderState,
    version: '1.0.0'
  });
})();
