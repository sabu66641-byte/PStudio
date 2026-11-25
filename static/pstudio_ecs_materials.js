/* PStudio ECS Render Authoring Bridge 1.0.0
 * ECS stores persistent material/shader/collider configuration. PStudio3D
 * remains the sole owner of GPU materials, shader programs and mesh resources.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Materials] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_materials';
  const TYPES = Object.freeze({
    ToonMaterial: 'ToonMaterial',
    MaterialOverrides: 'MaterialOverrides',
    ShaderMaterial: 'ShaderMaterial',
    MeshCollider: 'MeshCollider'
  });
  const snapshots = {
    ToonMaterial: new Map(),
    MaterialOverrides: new Map(),
    ShaderMaterial: new Map()
  };
  const clamp = (value, min, max, fallback) =>
    Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
  const color = (value, fallback) =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  const clone = value => JSON.parse(JSON.stringify(value));

  function register(type, schema, create, label, description) {
    if (ecs.hasComponentType(type)) {
      if (ecs.getComponentDefinition(type)?.source !== SOURCE) {
        throw new Error('ECS Component name conflict: ' + type);
      }
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE,
      label,
      description,
      category: 'Rendering',
      persistent: true,
      internal: false,
      readonly: false,
      additionalProperties: false,
      schema,
      create
    });
    return true;
  }

  function registerComponents() {
    register(TYPES.ToonMaterial, {
      settings: { type: 'json', default: {}, label: 'Toon / NPR Settings' }
    }, () => ({ settings: {} }), 'Toon Material',
    'Persistent toon/rim/outline/subsurface/wind shader settings. GPU uniforms and shader instances remain renderer-owned.');

    register(TYPES.MaterialOverrides, {
      overrides: { type: 'json', default: [], label: 'Per-material overrides (max 64)' }
    }, () => ({ overrides: [] }), 'Material Overrides',
    'Per-GLB-material PBR/NPR overrides. Material instances and GPU resources remain renderer-owned.');

    register(TYPES.ShaderMaterial, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      fragmentShader: { type: 'string', default: '', maxLength: 12000, label: 'Fragment shader source' }
    }, () => ({ enabled: true, fragmentShader: '' }), 'Shader Material',
    'Persistent custom fragment-shader source. Compiled programs and uniforms remain renderer-owned.');

    register(TYPES.MeshCollider, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' }
    }, () => ({ enabled: true }), 'Mesh Collider',
    'Enables imported GLB mesh triangles as static collision geometry. Triangle caches and solver structures remain Physics-owned.');
  }

  function normalizeToon(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      enabled: v.enabled === true,
      shadowColor: color(v.shadowColor, '#46516f'),
      midColor: color(v.midColor, '#9eafd0'),
      highlightColor: color(v.highlightColor, '#ffffff'),
      shadowThreshold: clamp(v.shadowThreshold, 0.02, 0.95, 0.32),
      highlightThreshold: clamp(v.highlightThreshold, 0.05, 0.99, 0.68),
      rimColor: color(v.rimColor, '#b8dcff'),
      rimIntensity: clamp(v.rimIntensity, 0, 4, 0.42),
      rimPower: clamp(v.rimPower, 0.5, 8, 2.6),
      outlineColor: color(v.outlineColor, '#182235'),
      outlineWidth: clamp(v.outlineWidth, 0.005, 0.45, 0.12),
      sssColor: color(v.sssColor, '#f0a5a0'),
      sssIntensity: clamp(v.sssIntensity, 0, 1.5, 0.12),
      windStrength: clamp(v.windStrength, 0, 2.5, 0),
      windSpeed: clamp(v.windSpeed, 0, 4, 1)
    };
  }

  function normalizeOverride(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return {
      name: String(entry.name || '*').slice(0, 128),
      roughness: clamp(entry.roughness, 0, 1, 0.7),
      diffuseRoughness: clamp(entry.diffuseRoughness, 0, 1, 0),
      metalness: clamp(entry.metalness, 0, 1, 0),
      color: color(entry.color, '#d1d5db'),
      doubleSide: entry.doubleSide === true,
      recomputeNormals: entry.recomputeNormals === true,
      emissive: color(entry.emissive, '#000000'),
      emissiveIntensity: clamp(entry.emissiveIntensity, 0, 8, 0),
      toon: entry.toon && typeof entry.toon === 'object' ? normalizeToon(entry.toon) : null
    };
  }

  function normalizeOverrides(values) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, 64).map(normalizeOverride).filter(Boolean);
  }

  function objectFor(id, objects) {
    return (Array.isArray(objects) ? objects : [])
      .find(item => String(item?.id) === String(id)) || null;
  }

  function entityFor(ownerId, objects) {
    let entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    if (entity === null) {
      if (Array.isArray(objects)) ecs.syncSceneObjects(objects);
      entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    }
    return entity;
  }

  function writeSceneObject(entity, object) {
    if (!object || typeof ecs.serializeEntityComponents !== 'function') return false;
    const serialized = ecs.serializeEntityComponents(
      entity, ['Transform', 'SceneObjectRef'], object
    );
    if (!serialized) return false;
    object.ecsComponentsVersion = serialized.version;
    object.ecsComponents = serialized.components;
    return true;
  }

  function attach(ownerId, type, config, objects, persist = true) {
    const list = objects || window.sceneObjects;
    const object = objectFor(ownerId, list);
    const entity = entityFor(ownerId, list);
    if (!object || entity === null || !type) return false;
    if (persist && !ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)) return false;
    try {
      if (ecs.hasComponent(entity, type)) ecs.setComponent(entity, type, config);
      else ecs.addComponent(entity, type, config);
      if (persist && !writeSceneObject(entity, object)) return false;
      return true;
    } catch (error) {
      console.error('[PStudio ECS Materials] Component write failed:', type, error);
      return false;
    }
  }

  function get(ownerId, type, objects) {
    const entity = entityFor(ownerId, objects || window.sceneObjects);
    return entity !== null && ecs.hasComponent(entity, type) ? ecs.getComponent(entity, type) : null;
  }

  function refreshSnapshot(type, entity) {
    const cache = snapshots[type];
    if (!cache || !Number.isSafeInteger(Number(entity))) return;
    const id = Number(entity);
    if (!ecs.hasComponent(id, type) || !ecs.hasComponent(id, 'SceneObjectRef')) {
      cache.delete(id);
      return;
    }
    const ref = ecs.getComponent(id, 'SceneObjectRef');
    cache.set(id, {
      ownerId: String(ref.sceneObjectId),
      config: ecs.getComponent(id, type)
    });
  }

  function refreshAllSnapshots() {
    for (const type of Object.keys(snapshots)) {
      const cache = snapshots[type];
      const active = new Set(ecs.query([type, 'SceneObjectRef']));
      for (const entity of cache.keys()) if (!active.has(entity)) cache.delete(entity);
      for (const entity of active) refreshSnapshot(type, entity);
    }
  }

  function onComponentChanged(event) {
    const detail = event?.detail || {};
    if (detail.type === 'SceneObjectRef') {
      for (const type of Object.keys(snapshots)) refreshSnapshot(type, detail.entity);
      return;
    }
    if (snapshots[detail.type]) refreshSnapshot(detail.type, detail.entity);
  }

  function onComponentRemoved(event) {
    const detail = event?.detail || {};
    if (detail.type === 'SceneObjectRef') {
      for (const cache of Object.values(snapshots)) cache.delete(detail.entity);
      return;
    }
    if (snapshots[detail.type]) snapshots[detail.type].delete(detail.entity);
  }

  function onEntityDestroyed(event) {
    const entity = event?.detail?.entity;
    for (const cache of Object.values(snapshots)) cache.delete(entity);
  }

  function migrateLegacySceneObjects(objects) {
    if (!Array.isArray(objects) || typeof ecs.serializeEntityComponents !== 'function') return 0;
    ecs.syncSceneObjects(objects);
    let changed = 0;
    for (const object of objects) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null) continue;
      const probe = ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object);
      if (!probe) continue;
      let objectChanged = false;

      if (object.model && object.modelScale !== undefined) {
        const prior = ecs.hasComponent(entity, 'Renderable')
          ? ecs.getComponent(entity, 'Renderable')
          : null;
        const oldScale = clamp(object.modelScale, 0.001, 1000, 1);
        const config = prior
          ? { ...prior, kind: prior.kind || 'model', assetName: prior.assetName || String(object.model), scale: clamp(prior.scale, 0.001, 1000, 1) * oldScale }
          : { kind: 'model', assetName: String(object.model), scale: oldScale, useSceneTransform: true };
        if (prior) ecs.setComponent(entity, 'Renderable', config);
        else ecs.addComponent(entity, 'Renderable', config);
        delete object.modelScale;
        objectChanged = true;
      }

      if (object.toonMaterialSettings !== undefined) {
        if (!ecs.hasComponent(entity, TYPES.ToonMaterial)) {
          ecs.addComponent(entity, TYPES.ToonMaterial, { settings: normalizeToon(object.toonMaterialSettings) });
        }
        delete object.toonMaterialSettings;
        objectChanged = true;
      }

      if (object.modelMaterialOverrides !== undefined) {
        if (!ecs.hasComponent(entity, TYPES.MaterialOverrides)) {
          ecs.addComponent(entity, TYPES.MaterialOverrides, {
            overrides: normalizeOverrides(object.modelMaterialOverrides)
          });
        }
        delete object.modelMaterialOverrides;
        objectChanged = true;
      }

      if (object.shaderFragment !== undefined) {
        const fragmentShader = String(object.shaderFragment || '').slice(0, 12000);
        if (!ecs.hasComponent(entity, TYPES.ShaderMaterial) && fragmentShader) {
          ecs.addComponent(entity, TYPES.ShaderMaterial, { enabled: true, fragmentShader });
        }
        delete object.shaderFragment;
        objectChanged = true;
      }

      if (object.collider !== undefined) {
        if (object.collider && !ecs.hasComponent(entity, TYPES.MeshCollider)) {
          ecs.addComponent(entity, TYPES.MeshCollider, { enabled: true });
        }
        delete object.collider;
        objectChanged = true;
      }

      if (object.postProcessing !== undefined) {
        if (!ecs.hasComponent(entity, 'PostFX')) {
          const fx = object.postProcessing || {};
          ecs.addComponent(entity, 'PostFX', {
            enabled: true, bloom: fx.bloom === true, ssao: fx.ssao === true,
            strength: clamp(fx.strength, 0, 2, 0.45)
          });
        }
        delete object.postProcessing;
        objectChanged = true;
      }

      if (object.particleEmitter !== undefined) {
        if (!ecs.hasComponent(entity, 'ParticleEmitter')) {
          const emitter = object.particleEmitter || {};
          ecs.addComponent(entity, 'ParticleEmitter', {
            enabled: emitter.enabled === true, useSceneTransform: true, emitterId: 'inspector',
            offsetX: 0, offsetY: 0, offsetZ: 0, positionX: 0, positionY: 0, positionZ: 0,
            rate: clamp(emitter.rate, 0, 5000, 12), color: color(emitter.color, '#ffffff'),
            speed: clamp(emitter.speed, 0, 1000, 2), lifetime: clamp(emitter.lifetime, 0.05, 20, 1),
            maxCount: Math.trunc(clamp(emitter.maxCount, 1, 1200, 200))
          });
        }
        delete object.particleEmitter;
        objectChanged = true;
      }

      if (objectChanged) {
        if (writeSceneObject(entity, object)) changed++;
        else console.warn('[PStudio ECS Materials] Could not persist migrated Scene Object settings:', object.id);
      }
    }
    if (changed && typeof window.persistProject === 'function') window.persistProject();
    refreshAllSnapshots();
    return changed;
  }

  function prependOwnerCommands(commands, ownerId, pending) {
    if (!pending.length) return 0;
    const key = String(ownerId);
    let existingKey = null;
    for (const candidate of commands.keys()) {
      if (String(candidate) === key) { existingKey = candidate; break; }
    }
    const current = existingKey === null ? [] : commands.get(existingKey);
    if (existingKey !== null) commands.delete(existingKey);
    commands.set(key, [...pending, ...(current || [])]);
    return pending.length;
  }

  function collectCommands(commands, sceneObjects) {
    if (!(commands instanceof Map)) throw new TypeError('Material commands must be a Map.');
    const owners = new Set((Array.isArray(sceneObjects) ? sceneObjects : []).map(o => String(o.id)));
    let added = 0;
    for (const type of ['ShaderMaterial', 'MaterialOverrides', 'ToonMaterial']) {
      for (const entry of snapshots[type].values()) {
        if (!owners.has(entry.ownerId)) continue;
        const pending = [];
        if (type === 'ToonMaterial') {
          const settings = entry.config.settings || {};
          if (!settings.enabled && !(Number(settings.windStrength) > 0)) continue;
          pending.push({ type: 'toon_material', toon: clone(settings) });
        } else if (type === 'MaterialOverrides') {
          for (const override of normalizeOverrides(entry.config.overrides)) {
            pending.push({
              type: 'model_material', name: override.name, roughness: override.roughness,
              diffuseRoughness: override.diffuseRoughness,
              metalness: override.metalness, color: override.color, doubleSide: override.doubleSide,
              recomputeNormals: override.recomputeNormals, emissive: override.emissive,
              emissiveIntensity: override.emissiveIntensity, toon: override.toon
            });
          }
        } else if (type === 'ShaderMaterial' && entry.config.enabled && entry.config.fragmentShader) {
          pending.push({ type: 'material', shader: 'custom', fragmentShader: entry.config.fragmentShader });
        }
        added += prependOwnerCommands(commands, entry.ownerId, pending);
      }
    }
    return added;
  }

  function getToonMaterial(ownerId, objects) {
    const component = get(ownerId, TYPES.ToonMaterial, objects);
    return component ? clone(component.settings || {}) : null;
  }
  function setToonMaterial(ownerId, settings, objects) {
    return attach(ownerId, TYPES.ToonMaterial, { settings: normalizeToon(settings) }, objects);
  }
  function getMaterialOverrides(ownerId, objects) {
    const component = get(ownerId, TYPES.MaterialOverrides, objects);
    return component ? clone(normalizeOverrides(component.overrides)) : null;
  }
  function setMaterialOverrides(ownerId, overrides, objects) {
    return attach(ownerId, TYPES.MaterialOverrides, { overrides: normalizeOverrides(overrides) }, objects);
  }
  function getShaderMaterial(ownerId, objects) {
    const component = get(ownerId, TYPES.ShaderMaterial, objects);
    return component ? clone(component) : null;
  }
  function setShaderMaterial(ownerId, fragmentShader, objects) {
    const source = String(fragmentShader || '');
    if (source.length > 12000) throw new RangeError('Fragment shader source must be 12 KB or less.');
    return attach(ownerId, TYPES.ShaderMaterial, { enabled: !!source, fragmentShader: source }, objects);
  }
  function resetShaderMaterial(ownerId, objects) {
    const list = objects || window.sceneObjects;
    const entity = entityFor(ownerId, list), object = objectFor(ownerId, list);
    if (entity === null || !object || !ecs.hasComponent(entity, TYPES.ShaderMaterial)) return false;
    if (!ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)) return false;
    ecs.removeComponent(entity, TYPES.ShaderMaterial);
    return writeSceneObject(entity, object);
  }
  function getMeshCollider(ownerId, objects) {
    const component = get(ownerId, TYPES.MeshCollider, objects);
    return component ? component.enabled === true : null;
  }
  function setMeshCollider(ownerId, enabled, objects) {
    if (enabled) return attach(ownerId, TYPES.MeshCollider, { enabled: true }, objects);
    const list = objects || window.sceneObjects;
    const entity = entityFor(ownerId, list), object = objectFor(ownerId, list);
    if (entity === null || !object) return false;
    if (!ecs.hasComponent(entity, TYPES.MeshCollider)) return true;
    if (!ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)) return false;
    ecs.setComponent(entity, TYPES.MeshCollider, { enabled: false });
    return writeSceneObject(entity, object);
  }
  function getRenderableAsset(ownerId, objects) {
    const component = get(ownerId, 'Renderable', objects);
    if (component?.assetName) return String(component.assetName);
    const object = objectFor(ownerId, objects || window.sceneObjects);
    return String(object?.model || '');
  }
  function setRenderableAsset(ownerId, assetName, objects) {
    const list = objects || window.sceneObjects;
    const object = objectFor(ownerId, list), entity = entityFor(ownerId, list);
    if (!object || entity === null || !ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)) return false;
    const name = String(assetName || '').trim().slice(0, 160);
    const current = ecs.hasComponent(entity, 'Renderable') ? ecs.getComponent(entity, 'Renderable') : null;
    if (!name) {
      if (current) ecs.removeComponent(entity, 'Renderable');
    } else if (current) {
      ecs.setComponent(entity, 'Renderable', {
        ...current, kind: 'model', assetName: name, useSceneTransform: current.useSceneTransform !== false
      });
    } else {
      ecs.addComponent(entity, 'Renderable', {
        kind: 'model', assetName: name, scale: 1, useSceneTransform: true
      });
    }
    const saved = writeSceneObject(entity, object);
    if (saved && typeof window.persistProject === 'function') window.persistProject();
    return saved;
  }
  function renameRenderableAsset(oldName, newName, objects) {
    let changed = 0;
    for (const object of objects || window.sceneObjects || []) {
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null || !ecs.hasComponent(entity, 'Renderable')) continue;
      const current = ecs.getComponent(entity, 'Renderable');
      if (String(current.assetName) !== String(oldName)) continue;
      if (!setRenderableAsset(object.id, newName, objects)) {
        throw new Error('Could not persist Renderable asset rename for ' + object.id);
      }
      changed++;
    }
    return changed;
  }
  function getRenderableScale(ownerId, objects) {
    const component = get(ownerId, 'Renderable', objects);
    if (component) return Number(component.scale) || 1;
    const object = objectFor(ownerId, objects || window.sceneObjects);
    return Number(object?.modelScale) || 1;
  }
  function setRenderableScale(ownerId, scale, objects) {
    const list = objects || window.sceneObjects;
    const object = objectFor(ownerId, list), entity = entityFor(ownerId, list);
    if (!object || entity === null || !ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)) return false;
    const current = ecs.hasComponent(entity, 'Renderable') ? ecs.getComponent(entity, 'Renderable') : null;
    const assetName = String(current?.assetName || object.model || '');
    if (!assetName) return false;
    const next = clamp(scale, 0.001, 1000, 1);
    if (current) {
      ecs.setComponent(entity, 'Renderable', {
        ...current, kind: 'model', assetName, scale: next
      });
    } else {
      ecs.addComponent(entity, 'Renderable', {
        kind: 'model', assetName, scale: next, useSceneTransform: true
      });
    }
    delete object.modelScale;
    const saved = writeSceneObject(entity, object);
    if (saved && typeof window.persistProject === 'function') window.persistProject();
    return saved;
  }
  function clear() {
    for (const cache of Object.values(snapshots)) cache.clear();
    return true;
  }

  registerComponents();
  ecs.on('component-added', onComponentChanged);
  ecs.on('component-updated', onComponentChanged);
  ecs.on('component-removed', onComponentRemoved);
  ecs.on('entity-destroyed', onEntityDestroyed);
  refreshAllSnapshots();

  window.PStudioECSMaterials = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    migrateLegacySceneObjects,
    collectCommands,
    getToonMaterial, setToonMaterial,
    getMaterialOverrides, setMaterialOverrides,
    getShaderMaterial, setShaderMaterial, resetShaderMaterial,
    getMeshCollider, setMeshCollider,
    getRenderableAsset, setRenderableAsset, renameRenderableAsset,
    getRenderableScale, setRenderableScale,
    clear,
    getStats: () => Object.freeze(Object.fromEntries(
      Object.entries(snapshots).map(([name, cache]) => [name.charAt(0).toLowerCase() + name.slice(1), cache.size])
    ))
  });
})();
