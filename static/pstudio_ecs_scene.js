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

  register('MeshCollider', {
    label: 'Mesh Collider',
    category: 'Physics',
    description: 'Per-Entity imported mesh collision participation.',
    schema: {
      enabled: { type: 'boolean', default: false },
      source: { type: 'enum', options: ['render-mesh'], default: 'render-mesh' }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('AnimationState', {
    label: 'Animation State',
    category: 'Animation',
    description: 'Per-Entity animation, blend, layer, IK and locomotion commands.',
    schema: {
      enabled: { type: 'boolean', default: false },
      entries: { type: 'array', default: [] }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('CameraState', {
    label: 'Camera State',
    category: 'Scene',
    description: 'Camera command currently owned by this Entity.',
    schema: {
      enabled: { type: 'boolean', default: false },
      entry: { type: 'json', default: null }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('LightSet', {
    label: 'Light Set',
    category: 'Lighting',
    description: 'Dynamic point and spot lights authored by this Entity.',
    schema: {
      enabled: { type: 'boolean', default: false },
      entries: { type: 'array', default: [] }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('EnvironmentSettings', {
    label: 'Environment Settings',
    category: 'Scene',
    description: 'Environment, background, fog and directional-light commands owned by this Entity.',
    schema: {
      enabled: { type: 'boolean', default: false },
      entries: { type: 'array', default: [] }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('AudioSource', {
    label: 'Audio Source',
    category: 'Audio',
    description: 'Active sound playback metadata for this Entity. Audio elements remain service resources.',
    schema: {
      sounds: { type: 'array', default: [] }
    },
    additionalProperties: false,
    internal: true,
    persistent: false
  });

  register('CollisionState', {
    label: 'Collision State',
    category: 'Physics',
    description: 'Current overlapping Entity IDs for 2D and 3D collision event transitions.',
    schema: {
      overlaps2D: { type: 'array', default: [] },
      overlaps3D: { type: 'array', default: [] }
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
      },
      meshCollider: {
        enabled: !!object.collider && !!object.model,
        source: 'render-mesh'
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
      ensure(entity, 'MeshCollider', values.meshCollider);
      synchronized++;
    }
    return synchronized;
  }

  function ensureComponent(objectOrId, type, data) {
    const api = ecs();
    const entity = sceneEntity(objectOrId);
    if (!api || !entity || !api.hasComponentType(type)) return null;
    return ensure(entity, type, data || {});
  }

  function setComponent(objectOrId, type, data) {
    const api = ecs();
    const entity = sceneEntity(objectOrId);
    if (!api || !entity || !api.hasComponentType(type)) return false;
    api.setComponent(entity, type, data);
    return true;
  }

  function syncRuntimeCommands(commandsByObject) {
    const api = ecs();
    if (!api || !(commandsByObject instanceof Map)) return 0;
    let synchronized = 0;
    const groups = {
      animation: new Set(['animation', 'animation_blend', 'animation_layer', 'locomotion', 'ik']),
      lights: new Set(['light']),
      environment: new Set(['environment'])
    };
    for (const [ownerId, draws] of commandsByObject) {
      const entity = sceneEntity(ownerId);
      if (!entity || !Array.isArray(draws)) continue;
      const animationEntries = [], lightEntries = [], environmentEntries = [];
      let cameraEntry = null;
      for (let index = 0; index < draws.length; index++) {
        const command = draws[index];
        if (!command || typeof command !== 'object') continue;
        if (groups.animation.has(command.type)) animationEntries.push({ index, command: clone(command) });
        else if (command.type === 'camera') cameraEntry = { index, command: clone(command) };
        else if (groups.lights.has(command.type)) lightEntries.push({ index, command: clone(command) });
        else if (groups.environment.has(command.type)) environmentEntries.push({ index, command: clone(command) });
      }
      const write = (type, value) => {
        if (api.hasComponent(entity, type)) api.setComponent(entity, type, value);
        else if (value.enabled || value.sounds?.length || value.overlaps2D?.length || value.overlaps3D?.length) api.addComponent(entity, type, value);
      };
      write('AnimationState', { enabled: animationEntries.length > 0, entries: animationEntries });
      write('CameraState', { enabled: !!cameraEntry, entry: cameraEntry });
      write('LightSet', { enabled: lightEntries.length > 0, entries: lightEntries });
      write('EnvironmentSettings', { enabled: environmentEntries.length > 0, entries: environmentEntries });
      const stateEntries = [
        ['AnimationState', animationEntries],
        ['CameraState', cameraEntry ? [cameraEntry] : []],
        ['LightSet', lightEntries],
        ['EnvironmentSettings', environmentEntries]
      ];
      const replacements = new Map();
      for (const [type, fallback] of stateEntries) {
        if (!api.hasComponent(entity, type)) continue;
        const data = api.getComponent(entity, type);
        const entries = type === 'CameraState' ? (data.entry ? [data.entry] : []) : data.entries || [];
        for (const entry of entries) {
          if (entry && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < draws.length) {
            replacements.set(entry.index, clone(entry.command));
          }
        }
      }
      for (const [index, command] of replacements) draws[index] = command;
      synchronized++;
    }
    return synchronized;
  }

  function syncAudioState(ownerId, sounds) {
    const api = ecs();
    const entity = sceneEntity(ownerId);
    if (!api || !entity) return false;
    const normalized = (Array.isArray(sounds) ? sounds : []).map(sound => ({
      name: text(sound?.name),
      volume: bounded(sound?.volume, 1, 0, 1),
      loop: sound?.loop === true,
      paused: sound?.paused === true,
      currentTime: Math.max(0, finite(sound?.currentTime, 0)),
      suspended: sound?.suspended === true
    })).filter(sound => sound.name);
    const data = { sounds: normalized };
    if (api.hasComponent(entity, 'AudioSource')) api.setComponent(entity, 'AudioSource', data);
    else if (normalized.length) api.addComponent(entity, 'AudioSource', data);
    return true;
  }

  function syncCollisionContacts(ownerIds, pairs, dimension) {
    const api = ecs();
    if (!api || !Array.isArray(ownerIds) || !Array.isArray(pairs)) return [];
    const field = dimension === '3d' ? 'overlaps3D' : 'overlaps2D';
    const ids = [...new Set(ownerIds.map(String))];
    const current = new Map(ids.map(id => [id, new Set()]));
    const previous = new Map();
    for (const id of ids) {
      const entity = sceneEntity(id);
      const state = entity && api.hasComponent(entity, 'CollisionState')
        ? api.getComponent(entity, 'CollisionState') : null;
      previous.set(id, new Set(Array.isArray(state?.[field]) ? state[field].map(String) : []));
    }
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const a = String(pair[0]), b = String(pair[1]);
      if (a === b || !current.has(a) || !current.has(b)) continue;
      current.get(a).add(b);
      current.get(b).add(a);
    }
    const entered = [];
    for (const id of ids) {
      const peers = current.get(id), old = previous.get(id) || new Set();
      for (const peer of peers) if (!old.has(peer)) entered.push([id, peer]);
      const entity = sceneEntity(id);
      if (!entity || (!peers.size && !old.size && !api.hasComponent(entity, 'CollisionState'))) continue;
      commitCollisionState(id, dimension, [...peers]);
    }
    return entered;
  }

  function commitCollisionState(ownerId, dimension, peers) {
    const api = ecs();
    const entity = sceneEntity(ownerId);
    if (!api || !entity) return false;
    const type = 'CollisionState';
    const current = api.hasComponent(entity, type)
      ? api.getComponent(entity, type)
      : { overlaps2D: [], overlaps3D: [] };
    const field = dimension === '3d' ? 'overlaps3D' : 'overlaps2D';
    current[field] = [...new Set((Array.isArray(peers) ? peers : []).map(String))];
    if (api.hasComponent(entity, type)) api.setComponent(entity, type, current);
    else api.addComponent(entity, type, current);
    return true;
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
    const meshCollider = getComponent(object.id, 'MeshCollider');
    if (!sprite && !mesh && !material && !post && !emitter && !collider && !meshCollider) return null;
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
      collider2D: collider || { enabled: !!object.collider, shape: object.shape === 'circle' ? 'circle' : 'rect' },
      meshCollider: meshCollider || { enabled: !!object.collider && !!object.model, source: 'render-mesh' }
    };
  }

  window.PStudioECSScene = Object.freeze({
    syncSceneObjects,
    syncRuntimeCommands,
    syncAudioState,
    commitCollisionState,
    syncCollisionContacts,
    ensureComponent,
    setComponent,
    getComponent,
    getRenderState,
    version: '1.0.0'
  });
})();
