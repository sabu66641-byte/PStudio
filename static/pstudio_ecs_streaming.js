/* PStudio ECS World Streaming Bridge 1.0.0
 * ECS owns partition / interest configuration. PStudio3D owns async asset loading,
 * chunk activation, GPU resource leases and rendering visibility.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Streaming] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_streaming';
  const TYPES = Object.freeze({
    WorldPartition: 'WorldPartition',
    StreamingInterest: 'StreamingInterest'
  });
  const snapshots = {
    WorldPartition: new Map(),
    StreamingInterest: new Map()
  };
  const registeredPartitions = new Map();
  const assignedObjects = new Map();
  let interestSignature = '';

  function uniqueStrings(values, limit, maxLength = 128) {
    if (!Array.isArray(values)) return [];
    const result = [];
    const seen = new Set();
    for (const raw of values) {
      const value = String(raw ?? '').trim().slice(0, maxLength);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= limit) break;
    }
    return result;
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function register(type, schema, create, normalize, description) {
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
      category: 'World Streaming',
      persistent: true,
      internal: false,
      additionalProperties: false,
      schema,
      create,
      normalize
    });
    return true;
  }

  function registerComponents() {
    register(TYPES.WorldPartition, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      partitionId: { type: 'string', maxLength: 128, default: '', label: 'Partition ID' },
      includeAnchor: { type: 'boolean', default: true, label: 'Include Anchor Object' },
      memberObjectIds: { type: 'array', default: [], label: 'Member Object IDs' },
      assetNames: { type: 'array', default: [], label: 'Preload Model Assets' },
      loadDistance: { type: 'number', min: 1, max: 200000, default: 800, label: 'Load Distance' },
      unloadDistance: { type: 'number', min: 1, max: 200000, default: 960, label: 'Unload Distance' },
      centerOffsetX: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Center Offset X' },
      centerOffsetY: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Center Offset Y' },
      centerOffsetZ: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Center Offset Z' }
    }, () => ({
      enabled: true, partitionId: '', includeAnchor: true,
      memberObjectIds: [], assetNames: [],
      loadDistance: 800, unloadDistance: 960,
      centerOffsetX: 0, centerOffsetY: 0, centerOffsetZ: 0
    }), value => {
      const loadDistance = Math.max(1, Math.min(200000, finite(value.loadDistance, 800)));
      return {
        ...value,
        enabled: value.enabled !== false,
        partitionId: String(value.partitionId || '').trim().slice(0, 128),
        includeAnchor: value.includeAnchor !== false,
        memberObjectIds: uniqueStrings(value.memberObjectIds, 4096),
        assetNames: uniqueStrings(value.assetNames, 256),
        loadDistance,
        unloadDistance: Math.max(loadDistance, Math.min(200000, finite(value.unloadDistance, loadDistance * 1.2))),
        centerOffsetX: Math.max(-100000, Math.min(100000, finite(value.centerOffsetX, 0))),
        centerOffsetY: Math.max(-100000, Math.min(100000, finite(value.centerOffsetY, 0))),
        centerOffsetZ: Math.max(-100000, Math.min(100000, finite(value.centerOffsetZ, 0)))
      };
    }, 'A streaming region with explicit member Scene Objects and preload assets. PStudio3D owns loading and GPU resources.');

    register(TYPES.StreamingInterest, {
      enabled: { type: 'boolean', default: true, label: 'Enabled' },
      priority: { type: 'integer', min: -1000, max: 1000, default: 0, label: 'Priority' },
      useSceneTransform: { type: 'boolean', default: true, label: 'Follow Scene Transform' },
      worldX: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Position X' },
      worldY: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Position Y' },
      worldZ: { type: 'number', min: -100000, max: 100000, default: 0, label: 'World Position Z' },
      offsetX: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Position Offset X' },
      offsetY: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Position Offset Y' },
      offsetZ: { type: 'number', min: -100000, max: 100000, default: 0, label: 'Position Offset Z' },
      loadMultiplier: { type: 'number', min: 0.1, max: 4, default: 1, label: 'Load Radius Multiplier' },
      unloadMultiplier: { type: 'number', min: 0.1, max: 4, default: 1, label: 'Unload Radius Multiplier' }
    }, () => ({
      enabled: true, priority: 0, useSceneTransform: true,
      worldX: 0, worldY: 0, worldZ: 0,
      offsetX: 0, offsetY: 0, offsetZ: 0,
      loadMultiplier: 1, unloadMultiplier: 1
    }), value => ({
      ...value,
      enabled: value.enabled !== false,
      priority: Math.max(-1000, Math.min(1000, Math.trunc(finite(value.priority, 0)))),
      useSceneTransform: value.useSceneTransform !== false,
      worldX: Math.max(-100000, Math.min(100000, finite(value.worldX, 0))),
      worldY: Math.max(-100000, Math.min(100000, finite(value.worldY, 0))),
      worldZ: Math.max(-100000, Math.min(100000, finite(value.worldZ, 0))),
      offsetX: Math.max(-100000, Math.min(100000, finite(value.offsetX, 0))),
      offsetY: Math.max(-100000, Math.min(100000, finite(value.offsetY, 0))),
      offsetZ: Math.max(-100000, Math.min(100000, finite(value.offsetZ, 0))),
      loadMultiplier: Math.max(0.1, Math.min(4, finite(value.loadMultiplier, 1))),
      unloadMultiplier: Math.max(0.1, Math.min(4, finite(value.unloadMultiplier, 1)))
    }), 'A moving or fixed point that requests nearby WorldPartition regions. Multiple interests are supported.');
  }

  function registerSnapshotSystem(type, id, name) {
    if (ecs.getSystems().some(system => system.id === id)) return;
    ecs.registerSystem({
      id,
      name,
      description: 'Snapshots partition / interest configuration. Async loading remains in PStudio3D.',
      components: [type, 'SceneObjectRef', 'Transform'],
      phase: 'postUpdate',
      priority: 2200,
      internal: true,
      source: SOURCE,
      update(dt, api) {
        const cache = snapshots[type];
        cache.clear();
        api.forEach([type, 'SceneObjectRef', 'Transform'], (entity, data, reference, transform) => {
          cache.set(entity, {
            ownerId: String(reference.sceneObjectId),
            data,
            transform: {
              x: finite(transform.x, 0),
              y: finite(transform.y, 0),
              z: finite(transform.z, 0)
            }
          });
        });
      }
    });
  }

  function scenePosition(object, transform) {
    return {
      x: (finite(transform?.x, object?.x) + (finite(object?.w, 64) / 2) - 480) / 100,
      y: (270 - (finite(transform?.y, object?.y) + (finite(object?.h, 64) / 2))) / 100,
      z: finite(transform?.z, object?.z) / 100
    };
  }

  function collectPartitionAssets(partition, members, objectsById) {
    const assets = new Set(uniqueStrings(partition.assetNames, 256));
    for (const id of members) {
      const object = objectsById.get(id);
      if (object?.model) assets.add(String(object.model));
      const entity = ecs.getEntityForSceneObject?.(id);
      const renderable = entity !== null && entity !== undefined && ecs.hasComponent(entity, 'Renderable')
        ? ecs.getComponent(entity, 'Renderable') : null;
      if (renderable?.enabled !== false && renderable?.kind === 'model' && renderable.assetName) {
        assets.add(String(renderable.assetName));
      }
    }
    return [...assets].filter(Boolean).slice(0, 512);
  }

  function sync(sceneObjects) {
    const renderer = window.PStudio3D;
    if (!renderer || typeof renderer.registerWorldChunk !== 'function') return false;
    const objectsById = new Map((Array.isArray(sceneObjects) ? sceneObjects : [])
      .filter(object => object?.id !== undefined && object?.id !== null)
      .map(object => [String(object.id), object]));

    const desiredPartitions = new Map();
    const desiredAssignments = new Map();
    const partitionDiagnostics = [];
    for (const [entity, entry] of snapshots.WorldPartition) {
      const data = entry.data;
      if (data.enabled === false || !objectsById.has(entry.ownerId)) continue;
      const id = String(data.partitionId || entry.ownerId).trim();
      if (!id || desiredPartitions.has(id)) {
        partitionDiagnostics.push({ entity, id, reason: 'duplicate-or-empty-partition-id' });
        continue;
      }

      const center = scenePosition(objectsById.get(entry.ownerId), entry.transform);
      center.x += finite(data.centerOffsetX, 0);
      center.y += finite(data.centerOffsetY, 0);
      center.z += finite(data.centerOffsetZ, 0);

      const members = new Set();
      if (data.includeAnchor !== false) members.add(entry.ownerId);
      for (const memberId of uniqueStrings(data.memberObjectIds, 4096)) {
        if (objectsById.has(memberId)) members.add(memberId);
      }
      const memberList = [...members];
      const assets = collectPartitionAssets(data, memberList, objectsById);
      const config = {
        x: center.x, y: center.y, z: center.z,
        loadDistance: Math.max(1, finite(data.loadDistance, 800)),
        unloadDistance: Math.max(1, finite(data.unloadDistance, 960)),
        assets
      };
      const signature = JSON.stringify(config);
      desiredPartitions.set(id, { signature, config, members: memberList, entity, ownerId: entry.ownerId });
      for (const ownerId of memberList) {
        const previous = desiredAssignments.get(ownerId);
        if (previous && previous !== id) {
          partitionDiagnostics.push({ entity, id, ownerId, reason: 'object-assigned-to-multiple-partitions' });
          continue;
        }
        desiredAssignments.set(ownerId, id);
      }
    }

    // Register / update desired partitions first. The renderer updates existing chunk
    // records in place and invalidates only asset-set changes.
    for (const [id, partition] of desiredPartitions) {
      const previous = registeredPartitions.get(id);
      if (!previous || previous !== partition.signature) {
        renderer.registerWorldChunk(id, partition.config);
        registeredPartitions.set(id, partition.signature);
      }
    }
    for (const [ownerId, partitionId] of desiredAssignments) {
      const previous = assignedObjects.get(ownerId);
      if (previous !== partitionId) {
        if (previous) renderer.unassignObjectFromChunk?.(ownerId);
        renderer.assignObjectToChunk(ownerId, partitionId);
      }
    }
    for (const [ownerId] of assignedObjects) {
      if (!desiredAssignments.has(ownerId)) renderer.unassignObjectFromChunk?.(ownerId);
    }
    for (const [id] of registeredPartitions) {
      if (!desiredPartitions.has(id)) renderer.unregisterWorldChunk(id);
    }
    assignedObjects.clear();
    for (const [ownerId, partitionId] of desiredAssignments) assignedObjects.set(ownerId, partitionId);
    registeredPartitions.clear();
    for (const [id, partition] of desiredPartitions) registeredPartitions.set(id, partition.signature);

    const interests = [];
    for (const [entity, entry] of snapshots.StreamingInterest) {
      const data = entry.data;
      if (data.enabled === false || !objectsById.has(entry.ownerId)) continue;
      const position = data.useSceneTransform !== false
        ? scenePosition(objectsById.get(entry.ownerId), entry.transform)
        : { x: finite(data.worldX, 0), y: finite(data.worldY, 0), z: finite(data.worldZ, 0) };
      interests.push({
        id: entry.ownerId + ':' + entity,
        x: position.x + finite(data.offsetX, 0),
        y: position.y + finite(data.offsetY, 0),
        z: position.z + finite(data.offsetZ, 0),
        priority: Math.max(-1000, Math.min(1000, Math.trunc(finite(data.priority, 0)))),
        loadMultiplier: Math.max(0.1, Math.min(4, finite(data.loadMultiplier, 1))),
        unloadMultiplier: Math.max(0.1, Math.min(4, finite(data.unloadMultiplier, 1)))
      });
    }
    interests.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const nextInterestSignature = JSON.stringify(interests);
    if (nextInterestSignature !== interestSignature) {
      renderer.setWorldStreamingInterests?.(interests);
      interestSignature = nextInterestSignature;
    }
    return {
      partitions: desiredPartitions.size,
      assignments: desiredAssignments.size,
      interests: interests.length,
      diagnostics: partitionDiagnostics
    };
  }

  function clearSnapshots() {
    snapshots.WorldPartition.clear();
    snapshots.StreamingInterest.clear();
  }

  function clear() {
    const renderer = window.PStudio3D;
    if (renderer) {
      for (const id of registeredPartitions.keys()) renderer.unregisterWorldChunk?.(id);
      for (const ownerId of assignedObjects.keys()) renderer.unassignObjectFromChunk?.(ownerId);
      renderer.clearWorldStreamingInterests?.();
    }
    registeredPartitions.clear();
    assignedObjects.clear();
    interestSignature = '';
    clearSnapshots();
    return true;
  }

  registerComponents();
  registerSnapshotSystem(TYPES.WorldPartition, 'world.partition.snapshot', 'World Partition Snapshot');
  registerSnapshotSystem(TYPES.StreamingInterest, 'world.streaming-interest.snapshot', 'Streaming Interest Snapshot');

  window.PStudioECSStreaming = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    sync,
    clear,
    clearSnapshots,
    getStats: () => Object.freeze({
      partitions: registeredPartitions.size,
      assignments: assignedObjects.size,
      interests: snapshots.StreamingInterest.size
    })
  });
})();
