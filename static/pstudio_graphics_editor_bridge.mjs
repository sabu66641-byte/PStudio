import { createPStudioGraphicsSceneAsset } from "./pstudio_graphics_scene_asset.mjs";
import { createPStudioBVHCollisionAdapter } from "./pstudio_graphics_bvh.mjs";

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function matrixOf(entity) {
  const matrix = entity.worldMatrix || entity.matrixWorld;
  if ((!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) || matrix.length !== 16) throw new TypeError("Scene Core entity does not expose a world matrix: " + entity.id);
  const values = Array.from(matrix, Number);
  if (!values.every(Number.isFinite)) throw new TypeError("Scene Core world matrix contains non-finite values: " + entity.id);
  return values;
}
function normalizeGeometry(value, id) {
  const source = value?.geometry || value;
  if (!source?.positions) throw new Error("PStudio geometry asset has no positions: " + id);
  return { ...source, id };
}
function normalizeMaterial(value, id) {
  const source = value?.material || value;
  if (!source || typeof source !== "object") throw new Error("PStudio material asset is unavailable: " + id);
  return { ...source, id };
}

/**
 * Opt-in bridge from the PStudio-owned Scene/Asset Cores to the direct scene renderer.
 * The legacy editor/gameplay renderer is not modified or replaced by this module.
 */
export function createPStudioGraphicsEditorBridge(options = {}) {
  const sceneCore = options.sceneCore;
  const assetCore = options.assetCore;
  const renderer = options.renderer || null;
  const sceneId = String(options.sceneId || "").trim();
  if (!sceneCore || typeof sceneCore.snapshot !== "function" || typeof sceneCore.createEntity !== "function" || typeof sceneCore.updateEntity !== "function") {
    throw new TypeError("A PStudio Graphics Scene Core is required.");
  }
  if (!sceneId) throw new TypeError("A PStudio sceneId is required.");
  if (!assetCore || typeof assetCore.get !== "function" || typeof assetCore.describe !== "function") throw new TypeError("A PStudio Graphics Asset Core is required.");
  let selectedEntityId = null;
  let mode = "edit";
  let disposed = false;
  let cachedAsset = null;
  let cachedRevision = -1;
  let collisionAdapter = null;
  let collisionRevision = -1;
  let leases = [];
  let syncCount = 0;
  let renderCount = 0;

  function assertLive() { if (disposed) throw new Error("PStudio Graphics Editor Bridge is disposed."); }
  function getAsset(id, kind) {
    const custom = kind === "geometry" ? options.resolveGeometry : options.resolveMaterial;
    const value = typeof custom === "function" ? custom(id) : assetCore.get(id);
    if (value == null) throw new Error("PStudio " + kind + " asset is missing: " + id);
    return kind === "geometry" ? normalizeGeometry(value, id) : normalizeMaterial(value, id);
  }
  function releaseLeases(values) {
    for (const lease of values) {
      try { lease.release(); } catch (_) {}
    }
  }
  function sync() {
    assertLive();
    const snapshot = sceneCore.snapshot(sceneId);
    if (cachedAsset && cachedRevision === snapshot.revision) return cachedAsset;
    const renderable = snapshot.entities.filter(entity => entity.visible && entity.geometryId);
    const geometryIds = [...new Set(renderable.map(entity => entity.geometryId))];
    const materialIds = [...new Set(renderable.flatMap(entity => entity.materialIds || []))];
    const geometries = geometryIds.map(id => getAsset(id, "geometry"));
    const materials = materialIds.map(id => getAsset(id, "material"));
    const entities = renderable.map(entity => ({
      id: entity.id,
      geometryId: entity.geometryId,
      materialIds: entity.materialIds,
      matrixWorld: matrixOf(entity),
      visible: entity.visible,
      castShadow: entity.castShadow,
      receiveShadow: entity.receiveShadow,
      layers: entity.layerMask,
      sourceObjectId: entity.id
    }));
    const nextAsset = createPStudioGraphicsSceneAsset({
      id: options.assetId || "pstudio.editor." + sceneId,
      revision: snapshot.revision || 1,
      geometries, materials, entities,
      clearColor: options.clearColor,
      lighting: options.lighting,
      lights: options.lights,
      metadata: { sourceSceneId: sceneId, sourceRevision: snapshot.revision, owner: "PStudio Scene Core" }
    });
    const nextLeases = [];
    if (typeof assetCore.retain === "function") {
      const references = new Set([...geometryIds, ...materialIds, ...renderable.flatMap(entity => entity.assetIds || [])]);
      try {
        for (const id of references) if (assetCore.describe(id)) nextLeases.push(assetCore.retain(id));
      } catch (error) {
        releaseLeases(nextLeases);
        throw error;
      }
    }
    const nextCollisionAdapter = createPStudioBVHCollisionAdapter(nextAsset, options.bvhOptions || {});
    releaseLeases(leases);
    leases = nextLeases;
    collisionAdapter = nextCollisionAdapter;
    collisionRevision = snapshot.revision;
    cachedAsset = nextAsset;
    cachedRevision = snapshot.revision;
    syncCount += 1;
    return cachedAsset;
  }
  function requireEntity(id) {
    const entity = sceneCore.getEntity(id);
    if (!entity || entity.sceneId !== sceneId) throw new Error("Editor entity is not part of this PStudio scene: " + id);
    return entity;
  }
  function raycast(ray, config = {}) {
    assertLive();
    const asset = sync();
    if (!collisionAdapter || collisionRevision !== cachedRevision) {
      collisionAdapter = createPStudioBVHCollisionAdapter(asset, options.bvhOptions || {});
      collisionRevision = cachedRevision;
    }
    return collisionAdapter.raycast(ray, config);
  }
  function selectFromRay(ray, config = {}) {
    const hit = raycast(ray, config);
    const selection = hit ? select(hit.entityId) : select(null);
    try { options.onPick?.(Object.freeze({ hit, selection })); } catch (_) {}
    return Object.freeze({ hit, selection });
  }
  function select(id) {
    assertLive();
    selectedEntityId = id == null ? null : String(id);
    if (selectedEntityId) requireEntity(selectedEntityId);
    const entity = selectedEntityId ? sceneCore.getEntity(selectedEntityId) : null;
    const result = Object.freeze({ entityId: selectedEntityId, entity });
    try { options.onSelectionChange?.(result); } catch (_) {}
    return result;
  }
  function createEntity(input = {}) {
    assertLive();
    const entity = sceneCore.createEntity({ ...input, sceneId });
    cachedRevision = -1;
    return entity;
  }
  function updateEntity(id, patch = {}) {
    assertLive();
    requireEntity(id);
    const entity = sceneCore.updateEntity(id, patch);
    cachedRevision = -1;
    return entity;
  }
  function reparentEntity(id, parentId = null) {
    assertLive();
    requireEntity(id);
    if (parentId != null) requireEntity(parentId);
    const entity = sceneCore.setEntityParent(id, parentId);
    cachedRevision = -1;
    return entity;
  }
  function removeEntity(id, config = {}) {
    assertLive();
    requireEntity(id);
    const removed = sceneCore.removeEntity(id, config);
    if (selectedEntityId === String(id)) selectedEntityId = null;
    cachedRevision = -1;
    return removed;
  }
  function setMode(next) {
    assertLive();
    const value = String(next || "").toLowerCase();
    if (!["edit", "play", "pause"].includes(value)) throw new TypeError("Graphics editor mode must be edit, play or pause.");
    mode = value;
    try { options.onModeChange?.(mode); } catch (_) {}
    return mode;
  }
  function render(frame = {}) {
    assertLive();
    if (!renderer || typeof renderer.render !== "function") throw new Error("A PStudio-owned renderer adapter is not connected.");
    if (mode === "pause") return false;
    const asset = sync();
    const ok = renderer.render({
      scene: asset,
      view: frame.view,
      timeSeconds: Number(frame.timeSeconds) || 0,
      deltaSeconds: Math.max(0, Number(frame.deltaSeconds) || 0),
      frameId: Number(frame.frameId) || renderCount + 1
    });
    if (ok) renderCount += 1;
    return ok;
  }
  function inspect(id = selectedEntityId) {
    assertLive();
    if (id == null) return null;
    const entity = requireEntity(id);
    const assets = [...(entity.assetIds || []), ...(entity.geometryId ? [entity.geometryId] : []), ...(entity.materialIds || [])]
      .map(assetId => assetCore.describe(assetId)).filter(Boolean);
    return Object.freeze({ entity, assets: Object.freeze(assets), selected: String(id) === selectedEntityId, mode });
  }
  function serialize() {
    assertLive();
    return sceneCore.snapshot(sceneId);
  }
  function dispose() {
    if (disposed) return false;
    releaseLeases(leases);
    leases = [];
    selectedEntityId = null;
    cachedAsset = null;
    cachedRevision = -1;
    collisionAdapter = null;
    collisionRevision = -1;
    disposed = true;
    if (options.ownsRenderer === true) renderer?.dispose?.();
    return true;
  }
  return Object.freeze({
    kind: "pstudio-graphics-editor-bridge",
    sync, render, select, raycast, selectFromRay, inspect, createEntity, updateEntity, reparentEntity, removeEntity,
    setMode, serialize, dispose,
    getCollisionStats: () => collisionAdapter?.stats?.() || Object.freeze({ cachedGeometryCount: 0, entityCount: 0 }),
    getState: () => Object.freeze({ disposed, sceneId, mode, selectedEntityId, syncedRevision: cachedRevision, syncCount, renderCount, leaseCount: leases.length })
  });
}
