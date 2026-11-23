/* PStudio ECS Scene Behavior and Sprite Bridge 1.0.0
 * Scene Objects keep their editor/project compatibility shell, while behavior,
 * 2D presentation, collider intent and editor-only object flags are ECS-owned.
 * Script ASTs, image bytes, Canvas rendering and collision algorithms remain
 * in their dedicated runtime/asset services.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Scene] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_scene';
  const TYPES = Object.freeze({
    ScriptAttachment: 'ScriptAttachment',
    SpriteRenderer: 'SpriteRenderer',
    Collider2D: 'Collider2D',
    EditorObjectSettings: 'EditorObjectSettings'
  });
  const clamp = (value, min, max, fallback) =>
    Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function register(type, schema, create, label, description) {
    if (ecs.hasComponentType(type)) {
      if (ecs.getComponentDefinition(type)?.source !== SOURCE) {
        throw new Error('ECS Component name conflict: ' + type);
      }
      return false;
    }
    ecs.registerComponent(type, {
      source: SOURCE, label, description, category: 'Scene',
      persistent: true, internal: false, readonly: false,
      additionalProperties: false, schema, create
    });
    return true;
  }

  function registerComponents() {
    register(TYPES.ScriptAttachment, {
      scriptFile: { type: 'string', default: '', maxLength: 160, label: 'ps Script File' },
      enabled: { type: 'boolean', default: true, label: 'Enabled' }
    }, () => ({ scriptFile: '', enabled: true }),
    'Script Attachment', 'The .ps behavior file assigned to this Entity. AST compilation and execution state remain runtime-owned.');

    register(TYPES.SpriteRenderer, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      spriteAsset: { type: 'string', default: '', maxLength: 160, label: 'Image Asset' },
      width: { type: 'number', min: 1, max: 100000, default: 64, label: 'Width' },
      height: { type: 'number', min: 1, max: 100000, default: 64, label: 'Height' },
      color: { type: 'string', maxLength: 32, default: '#d1d5db', label: 'Color' },
      shape: { type: 'enum', options: ['rect', 'circle'], default: 'rect', label: 'Shape' },
      layer: { type: 'integer', min: -32768, max: 32767, default: 0, label: 'Layer' },
      sortOrder: { type: 'integer', min: -1000000, max: 1000000, default: 0, label: 'Sort Order' }
    }, () => ({
      enabled: true, spriteAsset: '', width: 64, height: 64,
      color: '#d1d5db', shape: 'rect', layer: 0, sortOrder: 0
    }), 'Sprite Renderer', '2D image/primitive presentation and bounds. Image data and Canvas image objects remain AssetStore/renderer-owned.');

    register(TYPES.Collider2D, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      isTrigger: { type: 'boolean', default: false, label: 'Is Trigger' }
    }, () => ({ enabled: true, isTrigger: false }),
    '2D Collider', 'Enables 2D overlap events using SpriteRenderer bounds. The collision detection service remains runtime-owned.');

    register(TYPES.EditorObjectSettings, {
      manipulationEnabled: { type: 'boolean', default: true, label: 'Object Manipulation' }
    }, () => ({ manipulationEnabled: true }),
    'Editor Object Settings', 'Persistent editor manipulation permissions for this Entity.');
  }

  function sceneObject(ownerId, objects) {
    return (Array.isArray(objects) ? objects : window.sceneObjects || [])
      .find(object => String(object?.id) === String(ownerId)) || null;
  }

  function entityFor(ownerId, objects) {
    let entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    if (entity === null) {
      const list = Array.isArray(objects) ? objects : window.sceneObjects;
      if (Array.isArray(list)) ecs.syncSceneObjects(list);
      entity = ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
    }
    return entity;
  }

  function preflight(entity, object) {
    return typeof ecs.serializeEntityComponents === 'function'
      ? ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object)
      : null;
  }

  function persistEntity(entity, object) {
    if (!object || typeof ecs.serializeEntityComponents !== 'function') return false;
    const saved = ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object);
    if (!saved) return false;
    object.ecsComponentsVersion = saved.version;
    object.ecsComponents = saved.components;
    return true;
  }

  function safeScriptFile(value) {
    const file = String(value || '').trim();
    if (!file) return '';
    if (file.length > 160 || /[\\/\\\\\u0000-\u001f]/.test(file) || !file.toLowerCase().endsWith('.ps')) {
      throw new TypeError('ScriptAttachment requires a valid .ps project file name.');
    }
    return file;
  }

  function normalizeSprite(value) {
    const config = value && typeof value === 'object' ? value : {};
    const color = typeof config.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(config.color)
      ? config.color : '#d1d5db';
    return {
      enabled: config.enabled !== false,
      spriteAsset: String(config.spriteAsset || '').slice(0, 160),
      width: clamp(config.width, 1, 100000, 64),
      height: clamp(config.height, 1, 100000, 64),
      color,
      shape: config.shape === 'circle' ? 'circle' : 'rect',
      layer: Math.trunc(clamp(config.layer, -32768, 32767, 0)),
      sortOrder: Math.trunc(clamp(config.sortOrder, -1000000, 1000000, 0))
    };
  }

  function migrateLegacySceneObjects(objects) {
    if (!Array.isArray(objects) || typeof ecs.serializeEntityComponents !== 'function') return 0;
    ecs.syncSceneObjects(objects);
    let changed = 0;
    for (const object of objects) {
      if (!object || object.id === undefined || object.id === null) continue;
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null) continue;
      const probe = preflight(entity, object);
      if (!probe) continue;
      let migrated = false;

      if (own(object, 'script')) {
        const scriptFile = safeScriptFile(object.script);
        if (scriptFile && !ecs.hasComponent(entity, TYPES.ScriptAttachment)) {
          ecs.addComponent(entity, TYPES.ScriptAttachment, { scriptFile, enabled: true });
        }
        delete object.script;
        migrated = true;
      }

      const hasSpriteFields = ['sprite', 'color', 'shape', 'w', 'h'].some(key => own(object, key));
      if (hasSpriteFields) {
        if (!ecs.hasComponent(entity, TYPES.SpriteRenderer)) {
          ecs.addComponent(entity, TYPES.SpriteRenderer, normalizeSprite({
            enabled: true,
            spriteAsset: object.sprite,
            color: object.color,
            shape: object.shape,
            width: object.w,
            height: object.h
          }));
        }
        for (const key of ['sprite', 'color', 'shape', 'w', 'h']) delete object[key];
        migrated = true;
      }

      if (object.model) {
        const prior = ecs.hasComponent(entity, 'Renderable')
          ? ecs.getComponent(entity, 'Renderable') : null;
        if (!prior) {
          ecs.addComponent(entity, 'Renderable', {
            kind: 'model',
            assetName: String(object.model).slice(0, 160),
            scale: clamp(object.modelScale, 0.001, 1000, 1),
            useSceneTransform: true
          });
        } else if (!prior.assetName) {
          ecs.setComponent(entity, 'Renderable', {
            ...prior, kind: prior.kind || 'model',
            assetName: String(object.model).slice(0, 160),
            scale: clamp(object.modelScale, 0.001, 1000, Number(prior.scale) || 1)
          });
        }
        delete object.model;
        delete object.modelScale;
        migrated = true;
      }

      // Phase 19 moved the legacy shared collider flag into MeshCollider.
      // Mirror that legacy behavior into a separate 2D collider as well.
      if (object.collider === true || (ecs.hasComponent(entity, 'MeshCollider') && !ecs.hasComponent(entity, TYPES.Collider2D))) {
        if (!ecs.hasComponent(entity, TYPES.Collider2D)) ecs.addComponent(entity, TYPES.Collider2D, { enabled: true });
      }
      if (own(object, 'collider')) {
        delete object.collider;
        migrated = true;
      }

      if (own(object, 'manipulationEnabled')) {
        if (!ecs.hasComponent(entity, TYPES.EditorObjectSettings)) {
          ecs.addComponent(entity, TYPES.EditorObjectSettings, {
            manipulationEnabled: object.manipulationEnabled !== false
          });
        }
        delete object.manipulationEnabled;
        migrated = true;
      }

      if (migrated) {
        if (persistEntity(entity, object)) changed++;
        else console.warn('[PStudio ECS Scene] Could not persist migrated Scene Object:', object.id);
      }
    }
    if (changed && typeof window.persistProject === 'function') window.persistProject();
    return changed;
  }

  function syncSceneObjects(objects) {
    if (!Array.isArray(objects)) return 0;
    ecs.syncSceneObjects(objects);
    return migrateLegacySceneObjects(objects);
  }

  function getScriptFile(ownerId, objects) {
    const entity = entityFor(ownerId, objects);
    if (entity !== null && ecs.hasComponent(entity, TYPES.ScriptAttachment)) {
      const config = ecs.getComponent(entity, TYPES.ScriptAttachment);
      return config.enabled ? String(config.scriptFile || '') : '';
    }
    const object = sceneObject(ownerId, objects);
    return safeScriptFile(object?.script || '');
  }

  function setScriptFile(ownerId, fileName, objects) {
    const list = objects || window.sceneObjects;
    const object = sceneObject(ownerId, list);
    const entity = entityFor(ownerId, list);
    if (!object || entity === null || !preflight(entity, object)) return false;
    let scriptFile;
    try { scriptFile = safeScriptFile(fileName); } catch (error) {
      console.warn('[PStudio ECS Scene] Invalid script assignment:', error);
      return false;
    }
    const current = ecs.hasComponent(entity, TYPES.ScriptAttachment)
      ? ecs.getComponent(entity, TYPES.ScriptAttachment) : null;
    if (!scriptFile) {
      if (current) ecs.removeComponent(entity, TYPES.ScriptAttachment);
    } else if (current) {
      ecs.setComponent(entity, TYPES.ScriptAttachment, { scriptFile, enabled: true });
    } else {
      ecs.addComponent(entity, TYPES.ScriptAttachment, { scriptFile, enabled: true });
    }
    const saved = persistEntity(entity, object);
    if (saved && typeof window.persistProject === 'function') window.persistProject();
    return saved;
  }

  function getSpriteRenderer(ownerId, objects) {
    const entity = entityFor(ownerId, objects);
    if (entity !== null && ecs.hasComponent(entity, TYPES.SpriteRenderer)) {
      return ecs.getComponent(entity, TYPES.SpriteRenderer);
    }
    const object = sceneObject(ownerId, objects);
    if (!object) return null;
    return normalizeSprite({
      enabled: true, spriteAsset: object.sprite, color: object.color,
      shape: object.shape, width: object.w, height: object.h
    });
  }

  function setSpriteRenderer(ownerId, config, objects) {
    const list = objects || window.sceneObjects;
    const object = sceneObject(ownerId, list);
    const entity = entityFor(ownerId, list);
    if (!object || entity === null || !preflight(entity, object)) return false;
    const normalized = normalizeSprite(config);
    const had = ecs.hasComponent(entity, TYPES.SpriteRenderer);
    const previous = had ? JSON.parse(JSON.stringify(ecs.getComponent(entity, TYPES.SpriteRenderer))) : null;
    try {
      if (had) ecs.setComponent(entity, TYPES.SpriteRenderer, normalized);
      else ecs.addComponent(entity, TYPES.SpriteRenderer, normalized);
      if (!persistEntity(entity, object)) throw new Error('Scene Component schema cannot be serialized.');
      if (typeof window.persistProject === 'function') window.persistProject();
      return true;
    } catch (error) {
      try {
        if (had) ecs.setComponent(entity, TYPES.SpriteRenderer, previous);
        else if (ecs.hasComponent(entity, TYPES.SpriteRenderer)) ecs.removeComponent(entity, TYPES.SpriteRenderer);
      } catch (rollbackError) {
        console.error('[PStudio ECS Scene] SpriteRenderer rollback failed:', rollbackError);
      }
      console.warn('[PStudio ECS Scene] SpriteRenderer update failed:', error);
      return false;
    }
  }

  function getCollider2D(ownerId, objects) {
    const entity = entityFor(ownerId, objects);
    return entity !== null && ecs.hasComponent(entity, TYPES.Collider2D)
      ? ecs.getComponent(entity, TYPES.Collider2D).enabled === true
      : false;
  }

  function setCollider2D(ownerId, enabled, objects) {
    const list = objects || window.sceneObjects;
    const object = sceneObject(ownerId, list), entity = entityFor(ownerId, list);
    if (!object || entity === null || !preflight(entity, object)) return false;
    if (enabled) {
      if (ecs.hasComponent(entity, TYPES.Collider2D)) ecs.setComponent(entity, TYPES.Collider2D, { enabled: true });
      else ecs.addComponent(entity, TYPES.Collider2D, { enabled: true });
    } else if (ecs.hasComponent(entity, TYPES.Collider2D)) {
      ecs.setComponent(entity, TYPES.Collider2D, { enabled: false });
    }
    const saved = persistEntity(entity, object);
    if (saved && typeof window.persistProject === 'function') window.persistProject();
    return saved;
  }

  function isManipulationEnabled(ownerId, objects) {
    const entity = entityFor(ownerId, objects);
    if (entity !== null && ecs.hasComponent(entity, TYPES.EditorObjectSettings)) {
      return ecs.getComponent(entity, TYPES.EditorObjectSettings).manipulationEnabled !== false;
    }
    return sceneObject(ownerId, objects)?.manipulationEnabled !== false;
  }

  function setManipulationEnabled(ownerId, enabled, objects) {
    const list = objects || window.sceneObjects, object = sceneObject(ownerId, list);
    const entity = entityFor(ownerId, list);
    if (!object || entity === null || !preflight(entity, object)) return false;
    const config = { manipulationEnabled: enabled !== false };
    if (ecs.hasComponent(entity, TYPES.EditorObjectSettings)) ecs.setComponent(entity, TYPES.EditorObjectSettings, config);
    else ecs.addComponent(entity, TYPES.EditorObjectSettings, config);
    const saved = persistEntity(entity, object);
    if (saved && typeof window.persistProject === 'function') window.persistProject();
    return saved;
  }

  function renameScriptFile(oldName, newName, objects) {
    let changed = 0;
    for (const object of objects || window.sceneObjects || []) {
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null || !ecs.hasComponent(entity, TYPES.ScriptAttachment)) continue;
      const data = ecs.getComponent(entity, TYPES.ScriptAttachment);
      if (data.scriptFile !== String(oldName)) continue;
      if (!setScriptFile(object.id, newName, objects)) throw new Error('Could not persist ScriptAttachment rename for ' + object.id);
      changed++;
    }
    return changed;
  }

  function renameSpriteAsset(oldName, newName, objects) {
    let changed = 0;
    for (const object of objects || window.sceneObjects || []) {
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null || !ecs.hasComponent(entity, TYPES.SpriteRenderer)) continue;
      const current = ecs.getComponent(entity, TYPES.SpriteRenderer);
      if (current.spriteAsset !== String(oldName)) continue;
      const config = { ...current, spriteAsset: String(newName).slice(0, 160) };
      if (!setSpriteRenderer(object.id, config, objects)) throw new Error('Could not persist SpriteRenderer asset rename for ' + object.id);
      changed++;
    }
    return changed;
  }

  function clearScriptFile(fileName, objects) {
    let changed = 0;
    for (const object of objects || window.sceneObjects || []) {
      const entity = ecs.getEntityForSceneObject(String(object.id));
      if (entity === null || !ecs.hasComponent(entity, TYPES.ScriptAttachment)) continue;
      if (ecs.getComponent(entity, TYPES.ScriptAttachment).scriptFile !== String(fileName)) continue;
      if (!setScriptFile(object.id, '', objects)) throw new Error('Could not clear ScriptAttachment for ' + object.id);
      changed++;
    }
    return changed;
  }

  function clear() { return true; }

  registerComponents();
  window.PStudioECSScene = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    syncSceneObjects,
    migrateLegacySceneObjects,
    getScriptFile, setScriptFile, renameScriptFile, clearScriptFile,
    getSpriteRenderer, setSpriteRenderer, renameSpriteAsset,
    getCollider2D, setCollider2D,
    isManipulationEnabled, setManipulationEnabled,
    clear
  });
})();
