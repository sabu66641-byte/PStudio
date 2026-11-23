/* PStudio ECS Visual FX Bridge 1.0.0
 * ECS owns serializable presentation configuration. PStudio3D remains the
 * sole owner of Three.js objects, GPU particle systems, water materials and trails.
 * One-shot particle bursts and DOM presentation intentionally remain service APIs.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS VisualFX] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_visualfx';
  const GLOBAL_COMMAND_OWNER = '__pstudio_ecs_visualfx_global__';
  const TYPES = Object.freeze({
    Environment: 'Environment',
    Fog: 'Fog',
    Water: 'Water',
    PostFX: 'PostFX',
    ParticleEmitter: 'ParticleEmitter',
    Trail: 'Trail'
  });
  const snapshots = Object.fromEntries(Object.keys(TYPES).map(name => [name, new Map()]));

  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, finite(value, fallback)));

  function register(name, schema, create, normalize, description) {
    const type = TYPES[name];
    if (ecs.hasComponentType(type)) {
      if (ecs.getComponentDefinition(type)?.source !== SOURCE) {
        throw new Error('ECS Component name conflict: ' + type);
      }
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE,
      label: type,
      description,
      category: 'Visual Effects',
      persistent: true,
      internal: false,
      readonly: false,
      additionalProperties: false,
      schema,
      create,
      normalize
    });
    return true;
  }

  function registerComponents() {
    register('Environment', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      background: { type: 'string', maxLength: 128, label: 'Background' },
      environmentSky: { type: 'string', maxLength: 64, label: 'Environment Sky' },
      environmentGround: { type: 'string', maxLength: 64, label: 'Environment Ground' },
      environmentIntensity: { type: 'number', min: 0, max: 8, label: 'Environment Intensity' },
      lightX: { type: 'number', min: -100000, max: 100000, label: 'Key Light X' },
      lightY: { type: 'number', min: -100000, max: 100000, label: 'Key Light Y' },
      lightZ: { type: 'number', min: -100000, max: 100000, label: 'Key Light Z' },
      lightIntensity: { type: 'number', min: 0, max: 50, label: 'Key Light Intensity' }
    }, () => ({ enabled: true }), value => {
      const result = { enabled: value.enabled !== false };
      if (value.background !== undefined) result.background = String(value.background).slice(0, 128);
      if (value.environmentSky !== undefined) result.environmentSky = String(value.environmentSky).slice(0, 64);
      if (value.environmentGround !== undefined) result.environmentGround = String(value.environmentGround).slice(0, 64);
      if (value.environmentIntensity !== undefined) result.environmentIntensity = clamp(value.environmentIntensity, 0, 8, 0.8);
      for (const key of ['lightX', 'lightY', 'lightZ']) {
        if (value[key] !== undefined) result[key] = clamp(value[key], -100000, 100000, 0);
      }
      if (value.lightIntensity !== undefined) result.lightIntensity = clamp(value.lightIntensity, 0, 50, 1);
      return result;
    }, 'Scene background, sky/ground environment and primary light configuration. The renderer owns environment textures and lights.');

    register('Fog', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      color: { type: 'color', label: 'Fog Color' },
      near: { type: 'number', min: 0, max: 199999.9, label: 'Fog Near' },
      far: { type: 'number', min: 0.001, max: 200000, label: 'Fog Far' }
    }, () => ({ enabled: true }), value => {
      const result = { enabled: value.enabled !== false };
      if (value.color !== undefined) result.color = value.color;
      if (value.near !== undefined) result.near = clamp(value.near, 0, 199999.9, 0);
      if (value.far !== undefined) result.far = clamp(value.far, 0.001, 200000, 1000);
      if (result.near !== undefined && result.far !== undefined && result.far <= result.near) {
        result.far = Math.min(200000, result.near + 0.1);
      }
      return result;
    }, 'Fog color and distance configuration. Fog rendering remains owned by PStudio3D.');

    register('Water', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      useSceneTransform: { type: 'boolean', default: true, label: 'Use Scene Transform' },
      positionX: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World X' },
      positionY: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Y' },
      positionZ: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Z' },
      width: { type: 'number', min: 1, max: 100000, default: 100, label: 'Width' },
      depth: { type: 'number', min: 1, max: 100000, default: 100, label: 'Depth' },
      color: { type: 'color', default: '#4f9fc2', label: 'Water Color' },
      opacity: { type: 'number', min: 0.05, max: 1, default: 0.82, label: 'Opacity' }
    }, () => ({
      enabled: true, useSceneTransform: true,
      positionX: 0, positionY: 0, positionZ: 0,
      width: 100, depth: 100, color: '#4f9fc2', opacity: 0.82
    }), value => ({
      ...value,
      enabled: value.enabled !== false,
      useSceneTransform: value.useSceneTransform !== false,
      positionX: clamp(value.positionX, -100000, 100000, 0),
      positionY: clamp(value.positionY, -100000, 100000, 0),
      positionZ: clamp(value.positionZ, -100000, 100000, 0),
      width: clamp(value.width, 1, 100000, 100),
      depth: clamp(value.depth, 1, 100000, 100),
      opacity: clamp(value.opacity, 0.05, 1, 0.82)
    }), 'Water surface geometry and material configuration. Water shaders, meshes and GPU resources remain renderer-owned.');

    register('PostFX', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      bloom: { type: 'boolean', default: false, label: 'Bloom' },
      ssao: { type: 'boolean', default: false, label: 'SSAO' },
      strength: { type: 'number', min: 0, max: 2, default: 0.7, label: 'Bloom Strength' }
    }, () => ({ enabled: true, bloom: false, ssao: false, strength: 0.7 }), value => ({
      enabled: value.enabled !== false,
      bloom: value.bloom === true,
      ssao: value.ssao === true,
      strength: clamp(value.strength, 0, 2, 0.7)
    }), 'Scene post-processing settings. Render targets, post-processing passes and GPU memory remain renderer-owned.');

    register('ParticleEmitter', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      useSceneTransform: { type: 'boolean', default: true, label: 'Use Scene/Physics Position' },
      emitterId: { type: 'string', maxLength: 64, default: 'default', label: 'Emitter ID' },
      offsetX: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset X' },
      offsetY: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset Y' },
      offsetZ: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset Z' },
      positionX: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World X' },
      positionY: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Y' },
      positionZ: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Z' },
      rate: { type: 'number', min: 0, max: 5000, default: 12, label: 'Spawn Rate' },
      color: { type: 'color', default: '#ffffff', label: 'Particle Color' },
      speed: { type: 'number', min: 0, max: 1000, default: 1, label: 'Speed' },
      lifetime: { type: 'number', min: 0.05, max: 20, default: 1, label: 'Lifetime' },
      maxCount: { type: 'integer', min: 1, max: 1200, default: 100, label: 'Maximum Particles' }
    }, () => ({
      enabled: true, useSceneTransform: true, emitterId: 'default',
      offsetX: 0, offsetY: 0, offsetZ: 0,
      positionX: 0, positionY: 0, positionZ: 0,
      rate: 12, color: '#ffffff', speed: 1, lifetime: 1, maxCount: 100
    }), value => ({
      ...value,
      enabled: value.enabled !== false,
      useSceneTransform: value.useSceneTransform !== false,
      emitterId: String(value.emitterId || 'default').trim().slice(0, 64) || 'default',
      offsetX: clamp(value.offsetX, -10000, 10000, 0),
      offsetY: clamp(value.offsetY, -10000, 10000, 0),
      offsetZ: clamp(value.offsetZ, -10000, 10000, 0),
      positionX: clamp(value.positionX, -100000, 100000, 0),
      positionY: clamp(value.positionY, -100000, 100000, 0),
      positionZ: clamp(value.positionZ, -100000, 100000, 0),
      rate: clamp(value.rate, 0, 5000, 12),
      speed: clamp(value.speed, 0, 1000, 1),
      lifetime: clamp(value.lifetime, 0.05, 20, 1),
      maxCount: Math.trunc(clamp(value.maxCount, 1, 1200, 100))
    }), 'Persistent GPU particle emitter configuration. PStudio3D owns spawning, buffers, simulation and disposal.');

    register('Trail', {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      targetObjectId: { type: 'string', maxLength: 128, default: '', label: 'Target Scene Object ID' },
      color: { type: 'color', default: '#ffffff', label: 'Trail Color' },
      width: { type: 'number', min: 0.001, max: 1, default: 0.05, label: 'Trail Width' },
      duration: { type: 'number', min: 0.05, max: 10, default: 0.25, label: 'Trail Duration' },
      offsetX: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset X' },
      offsetY: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset Y' },
      offsetZ: { type: 'number', min: -10000, max: 10000, default: 0, label: 'Offset Z' }
    }, () => ({
      enabled: true, targetObjectId: '', color: '#ffffff',
      width: 0.05, duration: 0.25, offsetX: 0, offsetY: 0, offsetZ: 0
    }), value => ({
      ...value,
      enabled: value.enabled !== false,
      targetObjectId: String(value.targetObjectId || '').trim().slice(0, 128),
      width: clamp(value.width, 0.001, 1, 0.05),
      duration: clamp(value.duration, 0.05, 10, 0.25),
      offsetX: clamp(value.offsetX, -10000, 10000, 0),
      offsetY: clamp(value.offsetY, -10000, 10000, 0),
      offsetZ: clamp(value.offsetZ, -10000, 10000, 0)
    }), 'Per-object trail settings. Trail geometry, sampling and fading remain renderer-owned.');
  }

  function registerSnapshotSystem(type, id, name) {
    if (ecs.getSystems().some(system => system.id === id)) return;
    ecs.registerSystem({
      id,
      name,
      description: 'Snapshots persistent Visual FX configuration. GPU work remains in PStudio3D.',
      components: [type, 'SceneObjectRef', 'Transform'],
      phase: 'postUpdate',
      priority: 2400,
      internal: true,
      source: SOURCE,
      update(dt, api) {
        const cache = snapshots[type];
        cache.clear();
        api.forEach([type, 'SceneObjectRef', 'Transform'], (entity, data, reference) => {
          cache.set(entity, { ownerId: String(reference.sceneObjectId), data });
        });
      }
    });
  }

  function refreshSnapshot(name, entity) {
    const type = TYPES[name], cache = snapshots[name];
    if (!type || !cache || !Number.isSafeInteger(Number(entity))) return;
    const id = Number(entity);
    if (!ecs.hasComponent(id, type) || !ecs.hasComponent(id, 'SceneObjectRef') || !ecs.hasComponent(id, 'Transform')) {
      cache.delete(id);
      return;
    }
    const reference = ecs.getComponent(id, 'SceneObjectRef');
    cache.set(id, { ownerId: String(reference.sceneObjectId), data: ecs.getComponent(id, type) });
  }

  function refreshAllSnapshots() {
    for (const name of Object.keys(TYPES)) {
      const cache = snapshots[name];
      const active = new Set(ecs.query([TYPES[name], 'SceneObjectRef', 'Transform']));
      for (const entity of cache.keys()) if (!active.has(entity)) cache.delete(entity);
      for (const entity of active) refreshSnapshot(name, entity);
    }
  }

  function onComponentAddedOrUpdated(event) {
    const detail = event?.detail || {};
    if (detail.type === 'SceneObjectRef' || detail.type === 'Transform') {
      for (const name of Object.keys(TYPES)) refreshSnapshot(name, detail.entity);
      return;
    }
    const name = Object.keys(TYPES).find(key => TYPES[key] === detail.type);
    if (name) refreshSnapshot(name, detail.entity);
  }

  function onComponentRemoved(event) {
    const detail = event?.detail || {};
    if (detail.type === 'SceneObjectRef' || detail.type === 'Transform') {
      for (const cache of Object.values(snapshots)) cache.delete(detail.entity);
      return;
    }
    const name = Object.keys(TYPES).find(key => TYPES[key] === detail.type);
    if (name) snapshots[name].delete(detail.entity);
  }

  function removeEntityFromSnapshots(event) {
    const entity = event?.detail?.entity;
    for (const cache of Object.values(snapshots)) cache.delete(entity);
  }

  function attach(ownerId, name, config = {}) {
    const entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    const type = TYPES[name];
    if (entity === null || !type) return false;
    if (ecs.hasComponent(entity, type)) ecs.setComponent(entity, type, config);
    else ecs.addComponent(entity, type, config);
    return true;
  }

  function detach(ownerId, name) {
    const entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    const type = TYPES[name];
    if (entity === null || !type || !ecs.hasComponent(entity, type)) return false;
    return ecs.removeComponent(entity, type);
  }

  function objectPosition(ownerId, object, preferPhysics) {
    if (preferPhysics) {
      const physics = window.PStudioPhysics?.getPosition?.(ownerId);
      if (physics && ['x', 'y', 'z'].every(key => Number.isFinite(Number(physics[key])))) {
        return { x: Number(physics.x), y: Number(physics.y), z: Number(physics.z) };
      }
    }
    const entity = ecs.getEntityForSceneObject?.(String(ownerId));
    const transform = entity !== null && entity !== undefined && ecs.hasComponent(entity, 'Transform')
      ? ecs.getComponent(entity, 'Transform') : null;
    const sceneX = finite(transform?.x, object?.x);
    const sceneY = finite(transform?.y, object?.y);
    const sceneZ = finite(transform?.z, object?.z);
    return {
      x: (sceneX + finite(object?.w, 64) / 2 - 480) / 100,
      y: (270 - (sceneY + finite(object?.h, 64) / 2)) / 100,
      z: sceneZ / 100
    };
  }

  function ensureList(commands, ownerId) {
    const key = String(ownerId);
    let list = commands.get(key);
    if (!list) {
      list = [];
      commands.set(key, list);
    }
    return list;
  }

  function prependGlobalCommand(commands, ownerId, command) {
    const key = String(ownerId);
    let existingKey = null;
    for (const candidate of commands.keys()) {
      if (String(candidate) === key) { existingKey = candidate; break; }
    }
    const existingList = existingKey === null ? [] : commands.get(existingKey);
    const rest = [...commands.entries()].filter(([candidate]) => candidate !== existingKey);
    commands.clear();
    commands.set(key, [command, ...(existingList || [])]);
    for (const [candidate, list] of rest) commands.set(candidate, list);
  }

  function collectGlobalEnvironment(commands, objectsById) {
    const sources = [];
    for (const name of ['Environment', 'Fog']) {
      for (const [entity, entry] of snapshots[name]) {
        if (entry.data.enabled === false || !objectsById.has(entry.ownerId)) continue;
        sources.push({ entity, name, ownerId: entry.ownerId, data: entry.data });
      }
    }
    sources.sort((a, b) => a.entity - b.entity);
    if (!sources.length) return 0;
    const config = { type: 'environment' };
    const mapped = {
      Environment: [
        ['background', 'background'],
        ['environmentSky', 'environmentSky'],
        ['environmentGround', 'environmentGround'],
        ['environmentIntensity', 'environmentIntensity'],
        ['lightX', 'lightX'], ['lightY', 'lightY'], ['lightZ', 'lightZ'],
        ['lightIntensity', 'lightIntensity']
      ],
      Fog: [['color', 'fogColor'], ['near', 'fogNear'], ['far', 'fogFar']]
    };
    for (const source of sources) {
      for (const [field, target] of mapped[source.name]) {
        if (source.data[field] !== undefined && config[target] === undefined) config[target] = source.data[field];
      }
    }
    if (Object.keys(config).length === 1) return 0;
    prependGlobalCommand(commands, GLOBAL_COMMAND_OWNER, config);
    return 1;
  }

  function collectPostFX(commands, objectsById) {
    const candidates = [...snapshots.PostFX.entries()]
      .filter(([, entry]) => entry.data.enabled !== false && objectsById.has(entry.ownerId))
      .sort((a, b) => a[0] - b[0]);
    if (!candidates.length) return 0;
    const [entity, entry] = candidates[0];
    prependGlobalCommand(commands, GLOBAL_COMMAND_OWNER, {
      type: 'postfx',
      bloom: entry.data.bloom === true,
      ssao: entry.data.ssao === true,
      strength: clamp(entry.data.strength, 0, 2, 0.7)
    });
    return 1;
  }

  function collectCommands(commands, sceneObjects, dt) {
    if (!(commands instanceof Map)) throw new TypeError('Visual FX commands must be a Map.');
    const objectsById = new Map((Array.isArray(sceneObjects) ? sceneObjects : [])
      .filter(object => object?.id !== undefined && object?.id !== null)
      .map(object => [String(object.id), object]));
    let added = collectGlobalEnvironment(commands, objectsById);
    added += collectPostFX(commands, objectsById);

    for (const entry of snapshots.Water.values()) {
      const data = entry.data, object = objectsById.get(entry.ownerId);
      if (!object || data.enabled === false) continue;
      const position = data.useSceneTransform !== false
        ? objectPosition(entry.ownerId, object, false)
        : { x: finite(data.positionX, 0), y: finite(data.positionY, 0), z: finite(data.positionZ, 0) };
      ensureList(commands, entry.ownerId).push({
        type: 'water',
        x: position.x, y: position.y, z: position.z,
        width: clamp(data.width, 1, 100000, 100),
        depth: clamp(data.depth, 1, 100000, 100),
        color: data.color || '#4f9fc2',
        opacity: clamp(data.opacity, 0.05, 1, 0.82)
      });
      added++;
    }

    for (const entry of snapshots.ParticleEmitter.values()) {
      const data = entry.data, object = objectsById.get(entry.ownerId);
      if (!object || data.enabled === false) continue;
      const position = data.useSceneTransform !== false
        ? objectPosition(entry.ownerId, object, true)
        : { x: finite(data.positionX, 0), y: finite(data.positionY, 0), z: finite(data.positionZ, 0) };
      ensureList(commands, entry.ownerId).push({
        type: 'particle_emitter',
        emitterId: String(data.emitterId || 'default'),
        x: position.x + finite(data.offsetX, 0),
        y: position.y + finite(data.offsetY, 0),
        z: position.z + finite(data.offsetZ, 0),
        rate: clamp(data.rate, 0, 5000, 12),
        color: data.color || '#ffffff',
        speed: clamp(data.speed, 0, 1000, 1),
        lifetime: clamp(data.lifetime, 0.05, 20, 1),
        maxCount: Math.trunc(clamp(data.maxCount, 1, 1200, 100)),
        dt
      });
      added++;
    }

    for (const entry of snapshots.Trail.values()) {
      const data = entry.data;
      const targetId = String(data.targetObjectId || entry.ownerId);
      const target = objectsById.get(targetId);
      if (!target || data.enabled === false) continue;
      const position = objectPosition(targetId, target, true);
      ensureList(commands, entry.ownerId).push({
        type: 'trail',
        targetId,
        x: position.x + finite(data.offsetX, 0),
        y: position.y + finite(data.offsetY, 0),
        z: position.z + finite(data.offsetZ, 0),
        color: data.color || '#ffffff',
        width: clamp(data.width, 0.001, 1, 0.05),
        duration: clamp(data.duration, 0.05, 10, 0.25),
        dt
      });
      added++;
    }
    return added;
  }

  function clear() {
    for (const cache of Object.values(snapshots)) cache.clear();
    return true;
  }

  registerComponents();
  for (const name of Object.keys(TYPES)) {
    registerSnapshotSystem(TYPES[name], 'visualfx.' + name.toLowerCase() + '.snapshot', name + ' Snapshot');
  }
  ecs.on('component-added', onComponentAddedOrUpdated);
  ecs.on('component-updated', onComponentAddedOrUpdated);
  ecs.on('component-removed', onComponentRemoved);
  ecs.on('entity-destroyed', removeEntityFromSnapshots);
  refreshAllSnapshots();

  window.PStudioECSVisualFX = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    attachEnvironment: (id, config = {}) => attach(id, 'Environment', config),
    attachFog: (id, config = {}) => attach(id, 'Fog', config),
    attachWater: (id, config = {}) => attach(id, 'Water', config),
    attachPostFX: (id, config = {}) => attach(id, 'PostFX', config),
    attachParticleEmitter: (id, config = {}) => attach(id, 'ParticleEmitter', config),
    attachTrail: (id, config = {}) => attach(id, 'Trail', config),
    removeEnvironment: id => detach(id, 'Environment'),
    removeFog: id => detach(id, 'Fog'),
    removeWater: id => detach(id, 'Water'),
    removePostFX: id => detach(id, 'PostFX'),
    removeParticleEmitter: id => detach(id, 'ParticleEmitter'),
    removeTrail: id => detach(id, 'Trail'),
    collectCommands,
    clear,
    getStats: () => Object.freeze(Object.fromEntries(
      Object.entries(snapshots).map(([name, cache]) => [name.charAt(0).toLowerCase() + name.slice(1), cache.size])
    ))
  });
})();
