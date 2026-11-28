const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

function assertId(value, label) {
  const id = String(value || "").trim();
  if (!ID.test(id)) throw new TypeError(label + " must be a stable 1–128 character identifier.");
  return id;
}
function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + " must be finite.");
  return number;
}
function vector(value, length, fallback, label) {
  const input = value == null ? fallback : value;
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== length) {
    throw new TypeError(label + " must contain exactly " + length + " finite numbers.");
  }
  return Object.freeze(Array.from(input, (item, index) => finiteNumber(item, label + "[" + index + "]")));
}
function quaternion(value) {
  const q = vector(value, 4, [0, 0, 0, 1], "rotation");
  const length = Math.hypot(...q);
  if (!(length > 1e-8)) throw new RangeError("rotation quaternion must have non-zero length.");
  return Object.freeze(q.map(component => component / length));
}
function cloneData(value, seen = new Set(), depth = 0) {
  if (depth > 24) throw new RangeError("Scene component data exceeds the maximum nesting depth.");
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, "component value");
  if (typeof value !== "object") throw new TypeError("Scene component data must be serializable data, not functions or symbols.");
  if (seen.has(value)) throw new TypeError("Scene component data cannot contain cycles.");
  if (ArrayBuffer.isView(value)) {
    return Object.freeze(Array.from(value, item => finiteNumber(item, "typed component value")));
  }
  if (value instanceof ArrayBuffer) return Object.freeze(Array.from(new Uint8Array(value)));
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = Object.freeze(value.map(item => cloneData(item, seen, depth + 1)));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Scene component records must be plain objects.");
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) output[key] = cloneData(value[key], seen, depth + 1);
    result = Object.freeze(output);
  }
  seen.delete(value);
  return result;
}
function transform(input = {}) {
  return Object.freeze({
    position: vector(input.position, 3, [0, 0, 0], "position"),
    rotation: quaternion(input.rotation),
    scale: vector(input.scale, 3, [1, 1, 1], "scale")
  });
}
function composeMatrix(value) {
  const [x, y, z, w] = value.rotation;
  const [sx, sy, sz] = value.scale;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const p = value.position;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    p[0], p[1], p[2], 1
  ]);
}
function multiply4(a, b) {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}
function immutableRecord(record) {
  return Object.freeze({
    id: record.id,
    sceneId: record.sceneId,
    name: record.name,
    parentId: record.parentId,
    children: Object.freeze([...record.children]),
    visible: record.visible,
    layerMask: record.layerMask,
    castShadow: record.castShadow,
    receiveShadow: record.receiveShadow,
    geometryId: record.geometryId,
    materialIds: record.materialIds,
    assetIds: record.assetIds,
    transform: record.transform,
    components: record.components,
    localMatrix: Object.freeze(Array.from(record.localMatrix)),
    worldMatrix: Object.freeze(Array.from(record.worldMatrix))
  });
}

/**
 * PStudio-owned scene/entity hierarchy.
 * It contains serializable scene data and transform math only: no Three.js objects,
 * DOM nodes, WebGL resources or browser globals are retained.
 */
export function createPStudioGraphicsSceneCore(options = {}) {
  const scenes = new Map();
  const entities = new Map();
  const maxEntities = Math.max(1, Math.min(1000000, Math.floor(Number(options.maxEntities) || 200000)));
  let disposed = false;
  let clock = 0;

  function assertLive() {
    if (disposed) throw new Error("PStudio Graphics Scene Core is disposed.");
  }
  function sceneRecord(id) {
    const scene = scenes.get(String(id || ""));
    if (!scene) throw new Error("PStudio scene not found: " + id);
    return scene;
  }
  function entityRecord(id) {
    const entity = entities.get(String(id || ""));
    if (!entity) throw new Error("PStudio entity not found: " + id);
    return entity;
  }
  function markSubtreeDirty(id) {
    const stack = [id];
    while (stack.length) {
      const current = entities.get(stack.pop());
      if (!current) continue;
      current.worldDirty = true;
      for (const childId of current.children) stack.push(childId);
    }
  }
  function worldMatrix(record, visiting = new Set()) {
    if (!record.worldDirty) return record.worldMatrix;
    if (visiting.has(record.id)) throw new Error("PStudio scene hierarchy contains a parent cycle.");
    visiting.add(record.id);
    record.localMatrix = composeMatrix(record.transform);
    const parent = record.parentId ? entityRecord(record.parentId) : null;
    record.worldMatrix = parent ? multiply4(worldMatrix(parent, visiting), record.localMatrix) : new Float64Array(record.localMatrix);
    record.worldDirty = false;
    visiting.delete(record.id);
    return record.worldMatrix;
  }
  function touch(sceneId) {
    const scene = sceneRecord(sceneId);
    scene.revision += 1;
    scene.updatedAt = ++clock;
  }
  function snapshotScene(sceneId) {
    const scene = sceneRecord(sceneId);
    const list = [...entities.values()].filter(entity => entity.sceneId === scene.id);
    return Object.freeze({
      id: scene.id,
      name: scene.name,
      revision: scene.revision,
      metadata: scene.metadata,
      entities: Object.freeze(list.map(entity => {
        worldMatrix(entity);
        return immutableRecord(entity);
      }))
    });
  }

  function createScene(input = {}) {
    assertLive();
    const id = assertId(input.id, "scene id");
    if (scenes.has(id)) throw new Error("PStudio scene already exists: " + id);
    const scene = {
      id,
      name: String(input.name || id),
      revision: 0,
      metadata: cloneData(input.metadata || {}),
      createdAt: ++clock,
      updatedAt: clock
    };
    scenes.set(id, scene);
    return snapshotScene(id);
  }
  function removeScene(id, config = {}) {
    assertLive();
    const scene = sceneRecord(id);
    const sceneEntities = [...entities.values()].filter(entity => entity.sceneId === scene.id);
    if (sceneEntities.length && config.recursive !== true) throw new Error("Cannot remove a scene while it still owns entities.");
    for (const entity of sceneEntities) entities.delete(entity.id);
    scenes.delete(scene.id);
    return true;
  }
  function createEntity(input = {}) {
    assertLive();
    if (entities.size >= maxEntities) throw new RangeError("PStudio scene entity limit has been reached.");
    const id = assertId(input.id, "entity id");
    if (entities.has(id)) throw new Error("PStudio entity already exists: " + id);
    const sceneId = assertId(input.sceneId, "scene id");
    const scene = sceneRecord(sceneId);
    const parentId = input.parentId == null ? null : assertId(input.parentId, "parent id");
    const parent = parentId ? entityRecord(parentId) : null;
    if (parent && parent.sceneId !== sceneId) throw new Error("Parent and child entities must belong to the same scene.");
    const layerMask = input.layerMask == null ? 0xffffffff : Number(input.layerMask);
    if (!Number.isSafeInteger(layerMask) || layerMask < 0 || layerMask > 0xffffffff) throw new RangeError("entity layerMask must be a uint32.");
    const record = {
      id, sceneId, name: String(input.name || id), parentId, children: new Set(),
      visible: input.visible !== false, layerMask: layerMask >>> 0,
      castShadow: input.castShadow === true, receiveShadow: input.receiveShadow !== false,
      geometryId: input.geometryId == null ? null : assertId(input.geometryId, "geometry id"),
      materialIds: Object.freeze((input.materialIds || []).map(value => assertId(value, "material id"))),
      assetIds: Object.freeze((input.assetIds || []).map(value => assertId(value, "asset id"))),
      transform: transform(input.transform),
      components: cloneData(input.components || {}),
      localMatrix: new Float64Array(16), worldMatrix: new Float64Array(16), worldDirty: true
    };
    entities.set(id, record);
    if (parent) parent.children.add(id);
    touch(scene.id);
    return getEntity(id);
  }
  function getEntity(id) {
    assertLive();
    const record = entities.get(String(id || ""));
    if (!record) return null;
    worldMatrix(record);
    return immutableRecord(record);
  }
  function listEntities(sceneId) {
    assertLive();
    const id = assertId(sceneId, "scene id");
    sceneRecord(id);
    return Object.freeze([...entities.values()].filter(entity => entity.sceneId === id).map(entity => getEntity(entity.id)));
  }
  function updateEntity(id, patch = {}) {
    assertLive();
    const record = entityRecord(id);
    const allowed = ["name", "visible", "layerMask", "castShadow", "receiveShadow", "geometryId", "materialIds", "assetIds", "components"];
    for (const key of Object.keys(patch)) if (key !== "transform" && !allowed.includes(key)) throw new TypeError("Unsupported PStudio entity field: " + key);
    if (patch.transform != null) {
      const current = record.transform;
      record.transform = transform({
        position: patch.transform.position ?? current.position,
        rotation: patch.transform.rotation ?? current.rotation,
        scale: patch.transform.scale ?? current.scale
      });
      markSubtreeDirty(record.id);
    }
    if (patch.name != null) record.name = String(patch.name);
    if (patch.visible != null) record.visible = patch.visible === true;
    if (patch.castShadow != null) record.castShadow = patch.castShadow === true;
    if (patch.receiveShadow != null) record.receiveShadow = patch.receiveShadow === true;
    if (patch.layerMask != null) {
      const mask = Number(patch.layerMask);
      if (!Number.isSafeInteger(mask) || mask < 0 || mask > 0xffffffff) throw new RangeError("entity layerMask must be a uint32.");
      record.layerMask = mask >>> 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "geometryId")) record.geometryId = patch.geometryId == null ? null : assertId(patch.geometryId, "geometry id");
    if (patch.materialIds != null) record.materialIds = Object.freeze(patch.materialIds.map(value => assertId(value, "material id")));
    if (patch.assetIds != null) record.assetIds = Object.freeze(patch.assetIds.map(value => assertId(value, "asset id")));
    if (patch.components != null) record.components = cloneData(patch.components);
    touch(record.sceneId);
    return getEntity(record.id);
  }
  function setEntityParent(id, nextParentId = null) {
    assertLive();
    const record = entityRecord(id);
    const nextId = nextParentId == null ? null : assertId(nextParentId, "parent id");
    if (nextId === record.id) throw new Error("An entity cannot parent itself.");
    const nextParent = nextId ? entityRecord(nextId) : null;
    if (nextParent && nextParent.sceneId !== record.sceneId) throw new Error("Parent and child entities must belong to the same scene.");
    for (let cursor = nextParent; cursor; cursor = cursor.parentId ? entities.get(cursor.parentId) : null) {
      if (cursor.id === record.id) throw new Error("Reparenting would create a scene hierarchy cycle.");
    }
    if (record.parentId === nextId) return getEntity(record.id);
    if (record.parentId) entities.get(record.parentId)?.children.delete(record.id);
    record.parentId = nextId;
    if (nextParent) nextParent.children.add(record.id);
    markSubtreeDirty(record.id);
    touch(record.sceneId);
    return getEntity(record.id);
  }
  function removeEntity(id, config = {}) {
    assertLive();
    const record = entityRecord(id);
    if (record.children.size && config.recursive !== true) throw new Error("Cannot remove an entity with children unless recursive is true.");
    const stack = [[record.id, false]];
    const removalOrder = [];
    while (stack.length) {
      const [currentId, visited] = stack.pop();
      const current = entities.get(currentId);
      if (!current) continue;
      if (visited) removalOrder.push(currentId);
      else {
        stack.push([currentId, true]);
        for (const childId of current.children) stack.push([childId, false]);
      }
    }
    if (record.parentId) entities.get(record.parentId)?.children.delete(record.id);
    for (const currentId of removalOrder) entities.delete(currentId);
    touch(record.sceneId);
    return removalOrder.length;
  }
  function snapshot(sceneId) {
    assertLive();
    return snapshotScene(assertId(sceneId, "scene id"));
  }
  function dispose() {
    if (disposed) return false;
    entities.clear();
    scenes.clear();
    disposed = true;
    return true;
  }
  function stats() {
    return Object.freeze({
      sceneCount: scenes.size,
      entityCount: entities.size,
      dirtyWorldMatrices: [...entities.values()].filter(entity => entity.worldDirty).length,
      disposed
    });
  }

  return Object.freeze({
    kind: "pstudio-graphics-scene-core",
    createScene, removeScene, createEntity, getEntity, listEntities, updateEntity,
    setEntityParent, removeEntity, getWorldMatrix: id => {
      assertLive();
      const record = entityRecord(id);
      return Object.freeze(Array.from(worldMatrix(record)));
    },
    snapshot, stats, dispose
  });
}
