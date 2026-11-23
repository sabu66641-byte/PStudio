/* PStudio ECS Rendering Bridge 1.0.0
 * ECS owns renderer-facing configuration. PStudio3D remains the sole owner
 * of Three.js objects, GPU resources, scene graphs and AnimationMixers.
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
    Renderable: 'Renderable',
    Camera: 'Camera',
    Light: 'Light',
    Animation: 'Animation'
  });
  const snapshots = {
    Renderable: new Map(),
    Camera: new Map(),
    Light: new Map(),
    Animation: new Map()
  };

  function register(type, schema, create, description) {
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
      category: 'Rendering',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema,
      create
    });
    return true;
  }

  function registerComponents() {
    register(TYPES.Renderable, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      visible: { type: 'boolean', default: true, label: 'Visible' },
      kind: { type: 'enum', options: ['model', 'cube', 'box', 'sphere', 'plane', 'cylinder', 'cone', 'capsule'], default: 'model', label: 'Geometry' },
      assetName: { type: 'string', default: '', label: 'Model Asset' },
      useSceneTransform: { type: 'boolean', default: true, label: 'Use Scene Transform' },
      positionX: { type: 'number', default: 0, label: 'World Position X' },
      positionY: { type: 'number', default: 0, label: 'World Position Y' },
      positionZ: { type: 'number', default: 0, label: 'World Position Z' },
      rotationX: { type: 'number', default: 0, label: 'Rotation X (degrees)' },
      rotationY: { type: 'number', default: 0, label: 'Rotation Y (degrees)' },
      rotationZ: { type: 'number', default: 0, label: 'Rotation Z (degrees)' },
      scale: { type: 'number', min: 0.001, max: 1000, default: 1, label: 'Scale' },
      size: { type: 'number', min: 0.001, max: 10000, default: 1, label: 'Cube Size' },
      width: { type: 'number', min: 0.001, max: 10000, default: 1, label: 'Width' },
      height: { type: 'number', min: 0.001, max: 10000, default: 1, label: 'Height' },
      depth: { type: 'number', min: 0.001, max: 10000, default: 1, label: 'Depth' },
      radius: { type: 'number', min: 0.001, max: 10000, default: 0.5, label: 'Radius' },
      color: { type: 'color', default: '#d1d5db', label: 'Color' },
      roughness: { type: 'number', min: -1, max: 1, default: -1, label: 'Roughness (-1 = renderer default)' },
      metalness: { type: 'number', min: -1, max: 1, default: -1, label: 'Metalness (-1 = renderer default)' }
    }, () => ({
      enabled: true, visible: true, kind: 'model', assetName: '',
      useSceneTransform: true, positionX: 0, positionY: 0, positionZ: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
      size: 1, width: 1, height: 1, depth: 1, radius: 0.5,
      color: '#d1d5db', roughness: -1, metalness: -1
    }), 'Renderer-facing model/primitive and material settings. GPU resources remain renderer-owned.');

    register(TYPES.Camera, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      primary: { type: 'boolean', default: true, label: 'Primary Camera' },
      x: { type: 'number', default: 6, label: 'Position X' },
      y: { type: 'number', default: 5, label: 'Position Y' },
      z: { type: 'number', default: 8, label: 'Position Z' },
      targetX: { type: 'number', default: 0, label: 'Target X' },
      targetY: { type: 'number', default: 0, label: 'Target Y' },
      targetZ: { type: 'number', default: 0, label: 'Target Z' },
      smoothing: { type: 'number', min: 0, max: 30, default: 0, label: 'Smoothing' }
    }, () => ({
      enabled: true, primary: true, x: 6, y: 5, z: 8,
      targetX: 0, targetY: 0, targetZ: 0, smoothing: 0
    }), 'Primary camera configuration consumed by PStudio3D.');

    register(TYPES.Light, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      kind: { type: 'enum', options: ['point', 'spot'], default: 'point', label: 'Light Type' },
      x: { type: 'number', default: 0, label: 'Position X' },
      y: { type: 'number', default: 2, label: 'Position Y' },
      z: { type: 'number', default: 0, label: 'Position Z' },
      targetX: { type: 'number', default: 0, label: 'Target X' },
      targetY: { type: 'number', default: 0, label: 'Target Y' },
      targetZ: { type: 'number', default: 0, label: 'Target Z' },
      intensity: { type: 'number', min: 0, max: 100000, default: 1, label: 'Intensity' },
      color: { type: 'color', default: '#ffffff', label: 'Color' },
      distance: { type: 'number', min: 0, max: 100000, default: 0, label: 'Distance (0 = infinite)' },
      angle: { type: 'number', min: 0.01, max: 1.55, default: 0.62, label: 'Spot Angle (radians)' }
    }, () => ({
      enabled: true, kind: 'point', x: 0, y: 2, z: 0,
      targetX: 0, targetY: 0, targetZ: 0,
      intensity: 1, color: '#ffffff', distance: 0, angle: 0.62
    }), 'Point/spot light configuration. Native Three.js light objects remain renderer-owned.');

    register(TYPES.Animation, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      clipName: { type: 'string', default: '', label: 'Animation Clip' },
      loop: { type: 'boolean', default: true, label: 'Loop' },
      speed: { type: 'number', min: 0, max: 8, default: 1, label: 'Playback Speed' },
      stop: { type: 'boolean', default: false, label: 'Stop Animation' },
      blendFirst: { type: 'string', default: '', label: 'Blend Clip A' },
      blendSecond: { type: 'string', default: '', label: 'Blend Clip B' },
      blendWeight: { type: 'number', min: 0, max: 1, default: 0, label: 'Blend Weight' },
      layers: { type: 'array', default: [], label: 'Animation Layers' },
      idleClip: { type: 'string', default: '', label: 'Idle Clip' },
      walkClip: { type: 'string', default: '', label: 'Walk Clip' },
      runClip: { type: 'string', default: '', label: 'Run Clip' },
      jumpClip: { type: 'string', default: '', label: 'Jump Clip' },
      fallClip: { type: 'string', default: '', label: 'Fall Clip' },
      landClip: { type: 'string', default: '', label: 'Land Clip' }
    }, () => ({
      enabled: true, clipName: '', loop: true, speed: 1, stop: false,
      blendFirst: '', blendSecond: '', blendWeight: 0, layers: [],
      idleClip: '', walkClip: '', runClip: '', jumpClip: '', fallClip: '', landClip: ''
    }), 'Per-model clip, blend, layer and locomotion settings. AnimationMixer remains renderer-owned.');
  }

  function sceneEntity(ownerId) {
    return ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
  }
  function attach(ownerId, type, config = {}) {
    const entity = sceneEntity(ownerId);
    if (entity === null) return false;
    if (ecs.hasComponent(entity, type)) ecs.setComponent(entity, type, config);
    else ecs.addComponent(entity, type, config);
    return true;
  }
  function detach(ownerId, type) {
    const entity = sceneEntity(ownerId);
    if (entity === null || !ecs.hasComponent(entity, type)) return false;
    return ecs.removeComponent(entity, type);
  }

  function registerSnapshotSystem(type, id, snapshotName) {
    if (ecs.getSystems().some(system => system.id === id)) return;
    ecs.registerSystem({
      id,
      name: 'Rendering ' + type + ' Snapshot',
      description: 'Reads renderer configuration from ECS; does not allocate or own GPU resources.',
      components: [type, 'SceneObjectRef'],
      phase: 'postUpdate',
      priority: 2000,
      internal: true,
      source: SOURCE,
      update(dt, api) {
        const cache = snapshots[snapshotName];
        cache.clear();
        api.forEach([type, 'SceneObjectRef'], (entity, config, reference) => {
          cache.set(entity, { ownerId: String(reference.sceneObjectId), config });
        });
      }
    });
  }

  function clearOwnerFromSnapshots(entity) {
    for (const cache of Object.values(snapshots)) cache.delete(entity);
  }

  function refreshSnapshot(name, entity) {
    const type = TYPES[name];
    const cache = snapshots[name];
    if (!type || !cache || !Number.isSafeInteger(Number(entity))) return;
    const id = Number(entity);
    if (!ecs.hasComponent(id, type) || !ecs.hasComponent(id, 'SceneObjectRef')) {
      cache.delete(id);
      return;
    }
    const reference = ecs.getComponent(id, 'SceneObjectRef');
    cache.set(id, {
      ownerId: String(reference.sceneObjectId),
      config: ecs.getComponent(id, type)
    });
  }

  function refreshAllSnapshots() {
    for (const name of Object.keys(TYPES)) {
      const cache = snapshots[name];
      const entities = ecs.query([TYPES[name], 'SceneObjectRef']);
      const active = new Set(entities);
      for (const id of cache.keys()) if (!active.has(id)) cache.delete(id);
      for (const id of entities) refreshSnapshot(name, id);
    }
  }

  function updateSnapshotFromEvent(event) {
    const detail = event?.detail || {};
    if (detail.type === 'SceneObjectRef') {
      for (const name of Object.keys(TYPES)) refreshSnapshot(name, detail.entity);
      return;
    }
    const name = Object.keys(TYPES).find(key => TYPES[key] === detail.type);
    if (name) refreshSnapshot(name, detail.entity);
  }

  function ensureList(commands, ownerId) {
    let list = commands.get(ownerId);
    if (!list) {
      list = [];
      commands.set(ownerId, list);
    }
    return list;
  }
  function scenePosition(object) {
    return {
      x: ((Number(object.x) || 0) + (Number(object.w) || 64) / 2 - 480) / 100,
      y: (270 - ((Number(object.y) || 0) + (Number(object.h) || 64) / 2)) / 100,
      z: (Number(object.z) || 0) / 100
    };
  }

  function collectCommands(commands, sceneObjects, dt) {
    if (!(commands instanceof Map)) throw new TypeError('Rendering commands must be a Map.');
    const objects = new Map((sceneObjects || []).map(object => [String(object.id), object]));
    let added = 0;

    const scriptCameraExists = [...commands.values()].some(list =>
      list.some(command => command.type === 'camera')
    );
    if (!scriptCameraExists) {
      const cameras = [];
      for (const [entity, entry] of snapshots.Camera) {
        if (entry.config.enabled && entry.config.primary && objects.has(entry.ownerId)) {
          cameras.push({ entity, ...entry });
        }
      }
      cameras.sort((a, b) => a.entity - b.entity);
      if (cameras.length) {
        const entry = cameras[0], data = entry.config;
        ensureList(commands, entry.ownerId).push({
          type: 'camera',
          x: data.x, y: data.y, z: data.z,
          targetX: data.targetX, targetY: data.targetY, targetZ: data.targetZ,
          smoothing: data.smoothing, dt, cameraOwnerId: entry.ownerId
        });
        added++;
      }
    }

    for (const entry of snapshots.Light.values()) {
      const data = entry.config;
      if (!data.enabled || !objects.has(entry.ownerId)) continue;
      ensureList(commands, entry.ownerId).push({
        type: 'light', kind: data.kind,
        x: data.x, y: data.y, z: data.z,
        targetX: data.targetX, targetY: data.targetY, targetZ: data.targetZ,
        intensity: data.intensity, color: data.color,
        distance: data.distance, angle: data.angle
      });
      added++;
    }

    for (const entry of snapshots.Renderable.values()) {
      const data = entry.config, object = objects.get(entry.ownerId);
      if (!object || !data.enabled || !data.visible) continue;
      const kind = String(data.kind || 'model');
      const useSceneTransform = data.useSceneTransform !== false;
      const position = useSceneTransform ? scenePosition(object) : {
        x: Number(data.positionX) || 0,
        y: Number(data.positionY) || 0,
        z: Number(data.positionZ) || 0
      };
      // Scene Object rotation is the base transform; Renderable rotation is a local offset.
      // When detached from the Scene Transform, Renderable rotation is the full rotation.
      const rotationX = ((useSceneTransform ? Number(object.rotationX) || 0 : 0) + (Number(data.rotationX) || 0)) * Math.PI / 180;
      const rotationY = ((useSceneTransform ? Number(object.rotationY) || 0 : 0) + (Number(data.rotationY) || 0)) * Math.PI / 180;
      const rotationZ = ((useSceneTransform ? Number(object.rotationZ) || 0 : 0) + (Number(data.rotationZ) || 0)) * Math.PI / 180;
      const list = ensureList(commands, entry.ownerId);
      let drawCommand = null;

      if (kind === 'model') {
        const assetName = String(data.assetName || object.model || '');
        if (!assetName) continue;
        const existingIndex = list.findIndex(command => command.type === 'model' && command.name === assetName);
        if (existingIndex >= 0) {
          const existing = list[existingIndex];
          if (existing.ecsRenderableFallback === true) {
            const objectScale = useSceneTransform && Number(object.modelScale) > 0
              ? Number(object.modelScale) : 1;
            existing.scale = Math.max(0.001, (Number(data.scale) || 1) * objectScale);
            existing.rotationX = rotationX;
            existing.rotationY = rotationY;
            existing.rotationZ = rotationZ;
            delete existing.ecsRenderableFallback;
          }
          if (data.roughness >= 0 || data.metalness >= 0) {
            const material = { type: 'material' };
            if (data.roughness >= 0) material.roughness = data.roughness;
            if (data.metalness >= 0) material.metalness = data.metalness;
            list.splice(existingIndex, 0, material);
          }
          added++;
          continue;
        }
        const objectScale = useSceneTransform && Number(object.modelScale) > 0
          ? Number(object.modelScale)
          : 1;
        drawCommand = {
          type: 'model', name: assetName, ...position,
          scale: Math.max(0.001, (Number(data.scale) || 1) * objectScale),
          rotationX, rotationY, rotationZ, dt
        };
      } else {
        const command = {
          type: kind, ...position, rotationX, rotationY, rotationZ,
          color: data.color || '#d1d5db', dt
        };
        if (kind === 'cube') command.size = data.size;
        else if (kind === 'box') {
          command.width = data.width; command.height = data.height; command.depth = data.depth;
        } else if (kind === 'sphere') command.radius = data.radius;
        else if (kind === 'plane') {
          command.width = data.width; command.depth = data.depth;
        } else if (kind === 'cylinder' || kind === 'cone' || kind === 'capsule') {
          command.radius = data.radius; command.height = data.height;
        } else continue;
        drawCommand = command;
      }

      // The renderer applies owner material state in command order, so material must precede
      // the first model/primitive command rather than being appended after it.
      if (data.roughness >= 0 || data.metalness >= 0) {
        const material = { type: 'material' };
        if (data.roughness >= 0) material.roughness = data.roughness;
        if (data.metalness >= 0) material.metalness = data.metalness;
        list.push(material);
      }
      list.push(drawCommand);
      added++;
    }

    for (const entry of snapshots.Animation.values()) {
      const data = entry.config, object = objects.get(entry.ownerId);
      if (!object || !data.enabled) continue;
      const list = commands.get(entry.ownerId);
      if (!object.model && !(list || []).some(command => command.type === 'model')) continue;
      const target = ensureList(commands, entry.ownerId);
      if (data.stop) {
        target.push({ type: 'animation', stop: true });
      } else {
        if (data.clipName) {
          target.push({
            type: 'animation', clipName: data.clipName,
            loop: data.loop !== false, speed: data.speed
          });
        }
        if (data.blendFirst && data.blendSecond) {
          target.push({
            type: 'animation_blend', first: data.blendFirst,
            second: data.blendSecond, weight: data.blendWeight
          });
        }
        for (const layer of Array.isArray(data.layers) ? data.layers : []) {
          if (!layer || typeof layer.clip !== 'string' || !layer.clip) continue;
          target.push({
            type: 'animation_layer', clip: layer.clip,
            weight: Math.max(0, Math.min(1, Number(layer.weight) || 0)),
            additive: layer.additive === true
          });
        }
        const locomotion = {};
        for (const [field, key] of [
          ['idleClip', 'idle'], ['walkClip', 'walk'], ['runClip', 'run'],
          ['jumpClip', 'jump'], ['fallClip', 'fall'], ['landClip', 'land']
        ]) if (data[field]) locomotion[key] = data[field];
        if (Object.keys(locomotion).length) target.push({ type: 'locomotion', ...locomotion });
      }
      added++;
    }
    return added;
  }

  function clearSnapshots() {
    for (const cache of Object.values(snapshots)) cache.clear();
    return true;
  }

  registerComponents();
  registerSnapshotSystem(TYPES.Renderable, 'render.component.renderable', 'Renderable');
  registerSnapshotSystem(TYPES.Camera, 'render.component.camera', 'Camera');
  registerSnapshotSystem(TYPES.Light, 'render.component.light', 'Light');
  registerSnapshotSystem(TYPES.Animation, 'render.component.animation', 'Animation');

  ecs.on('component-added', updateSnapshotFromEvent);
  ecs.on('component-updated', updateSnapshotFromEvent);
  ecs.on('component-removed', event => {
    const type = event.detail?.type;
    if (type === 'SceneObjectRef') clearOwnerFromSnapshots(event.detail.entity);
    else if (Object.prototype.hasOwnProperty.call(TYPES, type)) {
      snapshots[type].delete(event.detail.entity);
    }
  });
  ecs.on('entity-destroyed', event => clearOwnerFromSnapshots(event.detail?.entity));
  refreshAllSnapshots();

  window.PStudioECSRendering = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    attachRenderable: (id, config = {}) => attach(id, TYPES.Renderable, config),
    attachCamera: (id, config = {}) => attach(id, TYPES.Camera, config),
    attachLight: (id, config = {}) => attach(id, TYPES.Light, config),
    attachAnimation: (id, config = {}) => attach(id, TYPES.Animation, config),
    removeRenderable: id => detach(id, TYPES.Renderable),
    removeCamera: id => detach(id, TYPES.Camera),
    removeLight: id => detach(id, TYPES.Light),
    removeAnimation: id => detach(id, TYPES.Animation),
    collectCommands,
    clearSnapshots,
    getStats: () => Object.freeze({
      renderables: snapshots.Renderable.size,
      cameras: snapshots.Camera.size,
      lights: snapshots.Light.size,
      animations: snapshots.Animation.size
    })
  });
})();
