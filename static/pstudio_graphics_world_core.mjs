import { PStudioGraphicsError } from './pstudio_graphics_contract.mjs';

const EPSILON = 1e-6;

function finite(value, fallback, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    if (fallback === undefined) throw new TypeError(label + ' must be finite.');
    return fallback;
  }
  return number;
}
function positiveInteger(value, label, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(label + ' must be a positive safe integer no greater than ' + maximum + '.');
  }
  return number;
}
function vector3(value, label) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(label + ' must be a 3-component vector.');
  if (value.length !== 3) throw new TypeError(label + ' must contain exactly 3 components.');
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain finite components.');
  return result;
}
function vector4(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 4) throw new TypeError(label + ' must be a 4-component vector.');
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain finite components.');
  return result;
}
function stableHash(seed, x, z) {
  let h = (Number(seed) | 0) ^ Math.imul(x | 0, 0x45d9f3b) ^ Math.imul(z | 0, 0x119de1f3);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Creates an immutable heightfield snapshot with bilinear height and finite-difference normal sampling. */
export function createPStudioTerrainHeightfield(input = {}) {
  const width = positiveInteger(input.width, 'heightfield width', 16384);
  const height = positiveInteger(input.height, 'heightfield height', 16384);
  if (width < 2 || height < 2) throw new RangeError('A heightfield requires at least 2 × 2 samples.');
  if (!input.heights || input.heights.length !== width * height) throw new TypeError('Heightfield sample count must equal width × height.');
  const samples = Float32Array.from(input.heights, Number);
  if (!samples.every(Number.isFinite)) throw new TypeError('Heightfield samples must all be finite.');
  const spacingX = finite(input.spacingX ?? 1, 1, 'spacingX');
  const spacingZ = finite(input.spacingZ ?? 1, 1, 'spacingZ');
  if (spacingX <= 0 || spacingZ <= 0) throw new RangeError('Heightfield sample spacing must be positive.');
  const origin = vector3(input.origin || [0, 0, 0], 'origin');
  let minHeight = Infinity, maxHeight = -Infinity;
  for (const value of samples) { minHeight = Math.min(minHeight, value); maxHeight = Math.max(maxHeight, value); }
  function sampleHeight(worldX, worldZ) {
    const gx = (finite(worldX, 0, 'worldX') - origin[0]) / spacingX;
    const gz = (finite(worldZ, 0, 'worldZ') - origin[2]) / spacingZ;
    if (gx < 0 || gz < 0 || gx > width - 1 || gz > height - 1) return null;
    const x0 = Math.min(width - 2, Math.floor(gx)), z0 = Math.min(height - 2, Math.floor(gz));
    const tx = gx - x0, tz = gz - z0;
    const a = samples[z0 * width + x0], b = samples[z0 * width + x0 + 1];
    const c = samples[(z0 + 1) * width + x0], d = samples[(z0 + 1) * width + x0 + 1];
    return origin[1] + (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  function sampleNormal(worldX, worldZ) {
    const h = sampleHeight(worldX, worldZ);
    if (h === null) return null;
    const dx = (sampleHeight(worldX + spacingX, worldZ) ?? h) - (sampleHeight(worldX - spacingX, worldZ) ?? h);
    const dz = (sampleHeight(worldX, worldZ + spacingZ) ?? h) - (sampleHeight(worldX, worldZ - spacingZ) ?? h);
    const normal = [-dx / (2 * spacingX), 1, -dz / (2 * spacingZ)];
    const length = Math.hypot(...normal);
    return normal.map(value => value / length);
  }
  return Object.freeze({
    kind: 'pstudio-terrain-heightfield', width, height, spacingX, spacingZ,
    origin: Object.freeze(origin), minHeight, maxHeight,
    bounds: Object.freeze({
      min: Object.freeze([origin[0], origin[1] + minHeight, origin[2]]),
      max: Object.freeze([origin[0] + (width - 1) * spacingX, origin[1] + maxHeight, origin[2] + (height - 1) * spacingZ])
    }),
    sampleHeight,
    sampleNormal,
    copySamples: () => new Float32Array(samples)
  });
}

/** Normalized world chunk descriptor; it contains no renderer-owned objects. */
export function createPStudioWorldChunkDescriptor(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('World chunk id is required.');
  const boundsMin = vector3(input.boundsMin, 'boundsMin');
  const boundsMax = vector3(input.boundsMax, 'boundsMax');
  if (boundsMin.some((value, index) => value > boundsMax[index])) throw new RangeError('World chunk boundsMin must not exceed boundsMax.');
  const geometricError = finite(input.geometricError ?? 0, 0, 'geometricError');
  if (geometricError < 0) throw new RangeError('World chunk geometricError cannot be negative.');
  const assets = [...new Set((input.assets || []).map(value => String(value).trim()).filter(Boolean))].sort();
  return Object.freeze({
    id, x: Math.floor(finite(input.x ?? 0, 0, 'chunk x')),
    y: Math.floor(finite(input.y ?? 0, 0, 'chunk y')),
    z: Math.floor(finite(input.z ?? 0, 0, 'chunk z')),
    boundsMin: Object.freeze(boundsMin), boundsMax: Object.freeze(boundsMax),
    geometricError, materialSetId: String(input.materialSetId || 'default'),
    assets: Object.freeze(assets), revision: positiveInteger(input.revision ?? 1, 'chunk revision')
  });
}

/**
 * Selects a geometric LOD from projected pixel error. Thresholds are ordered
 * coarse-to-fine (for example [4, 2, 1]); larger lod values are coarser.
 * Hysteresis is applied around the previous LOD to prevent boundary flicker.
 */
export function selectPStudioWorldLOD(input = {}) {
  const error = finite(input.geometricError, 0, 'geometricError');
  const distance = Math.max(EPSILON, finite(input.distance, 0, 'distance'));
  const viewportHeight = positiveInteger(input.viewportHeight, 'viewportHeight', 32768);
  const fovY = finite(input.fovYRadians, Math.PI / 3, 'fovYRadians');
  if (error < 0 || fovY <= 0 || fovY >= Math.PI) throw new RangeError('LOD geometric error and field of view are invalid.');
  const thresholds = input.thresholds || [4, 2, 1];
  if (!Array.isArray(thresholds) || thresholds.length < 1 || thresholds.length > 16 ||
      !thresholds.every((value, index) => Number.isFinite(Number(value)) && Number(value) > 0 && (index === 0 || Number(value) < Number(thresholds[index - 1])))) {
    throw new TypeError('LOD thresholds must be a strictly descending array of positive pixel errors.');
  }
  const projectedError = error * viewportHeight / (2 * Math.tan(fovY / 2) * distance);
  const maxLod = thresholds.length;
  let lod = maxLod;
  for (let i = 0; i < thresholds.length; i++) {
    if (projectedError >= thresholds[i]) { lod = i; break; }
  }
  const hysteresis = Math.max(0, Math.min(0.45, finite(input.hysteresis ?? 0.12, 0.12, 'hysteresis')));
  const previous = input.previousLod;
  if (Number.isInteger(previous) && previous >= 0 && previous <= maxLod) {
    lod = previous;
    while (lod > 0 && projectedError > thresholds[lod - 1] * (1 + hysteresis)) lod--;
    while (lod < maxLod && projectedError < thresholds[lod] * (1 - hysteresis)) lod++;
  }
  return Object.freeze({ lod, projectedError, changed: !Number.isInteger(previous) || previous !== lod });
}

/** Conservative AABB/frustum test. Plane equations use ax + by + cz + d >= 0 as inside. */
export function isPStudioAABBVisible(bounds, planes) {
  if (!Array.isArray(planes) || planes.length !== 6) throw new TypeError('Six frustum planes are required.');
  const min = vector3(bounds?.min, 'AABB min'), max = vector3(bounds?.max, 'AABB max');
  for (const plane of planes) {
    const p = vector4(plane, 'frustum plane');
    const x = p[0] >= 0 ? max[0] : min[0];
    const y = p[1] >= 0 ? max[1] : min[1];
    const z = p[2] >= 0 ? max[2] : min[2];
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

/** Pure request ranking for a streaming tick; no request is removed on budget overflow. */
export function rankPStudioWorldStreamingRequests(requests = [], limits = {}) {
  if (!Array.isArray(requests)) throw new TypeError('Streaming requests must be an array.');
  const maxConcurrent = positiveInteger(limits.maxConcurrent ?? 4, 'maxConcurrent', 1024);
  const maxBytes = Math.max(0, finite(limits.maxBytes ?? Infinity, Infinity, 'maxBytes'));
  const normalized = requests.map(request => {
    const id = String(request?.id || '').trim();
    if (!id) throw new TypeError('Every streaming request requires an id.');
    const bytes = Math.max(0, finite(request.estimatedBytes ?? 0, 0, 'estimatedBytes'));
    const priority = finite(request.priority ?? 0, 0, 'priority');
    const distance = Math.max(0, finite(request.distance ?? 0, 0, 'distance'));
    return { ...request, id, estimatedBytes: bytes, priority, distance };
  }).sort((a, b) => b.priority - a.priority || a.distance - b.distance || a.id.localeCompare(b.id));
  const selected = [], deferred = [];
  let totalBytes = 0;
  for (const item of normalized) {
    if (selected.length < maxConcurrent && totalBytes + item.estimatedBytes <= maxBytes) {
      selected.push(item); totalBytes += item.estimatedBytes;
    } else deferred.push(item);
  }
  return Object.freeze({
    selected: Object.freeze(selected), deferred: Object.freeze(deferred),
    selectedCount: selected.length, deferredCount: deferred.length, estimatedBytes: totalBytes
  });
}

/** Deterministic CPU scatter reference for GPU-instanced foliage placement. */
export function scatterPStudioFoliage(input = {}) {
  const count = positiveInteger(input.count ?? 1, 'foliage count', 1_000_000);
  const maxAttempts = positiveInteger(input.maxAttempts ?? count * 24, 'maxAttempts', 24_000_000);
  const seed = Number(input.seed ?? 1);
  if (!Number.isFinite(seed)) throw new TypeError('Foliage seed must be finite.');
  const min = vector3(input.boundsMin || [0, 0, 0], 'foliage boundsMin');
  const max = vector3(input.boundsMax || [100, 0, 100], 'foliage boundsMax');
  if (max[0] <= min[0] || max[2] <= min[2]) throw new RangeError('Foliage X/Z bounds must have positive area.');
  const maxSlopeRadians = Math.max(0, Math.min(Math.PI / 2, finite(input.maxSlopeRadians ?? 0.7, 0.7, 'maxSlopeRadians')));
  const minSpacing = Math.max(0, finite(input.minSpacing ?? 0, 0, 'minSpacing'));
  const sampleHeight = input.sampleHeight || (() => min[1]);
  const sampleNormal = input.sampleNormal || (() => [0, 1, 0]);
  if (typeof sampleHeight !== 'function' || typeof sampleNormal !== 'function') throw new TypeError('Foliage terrain samplers must be functions.');
  const random = rng(stableHash(seed, Math.floor(min[0] * 31), Math.floor(min[2] * 31)));
  const positions = [], normals = [];
  const minDistanceSquared = minSpacing * minSpacing;
  const spatialBuckets = new Map();
  const bucketKey = (x, z) => x + ',' + z;
  let attempts = 0;
  for (; attempts < maxAttempts && positions.length / 3 < count; attempts++) {
    const x = min[0] + random() * (max[0] - min[0]);
    const z = min[2] + random() * (max[2] - min[2]);
    const y = sampleHeight(x, z);
    const n = sampleNormal(x, z);
    if (y === null || y === undefined || !Number.isFinite(Number(y)) || !n) continue;
    const normal = vector3(n, 'foliage normal');
    const normalLength = Math.hypot(...normal);
    if (normalLength < EPSILON) continue;
    const normalized = normal.map(value => value / normalLength);
    const slope = Math.acos(Math.max(-1, Math.min(1, normalized[1])));
    if (slope > maxSlopeRadians) continue;
    let cellX = 0, cellZ = 0;
    if (minSpacing > 0) {
      cellX = Math.floor(x / minSpacing);
      cellZ = Math.floor(z / minSpacing);
      let tooClose = false;
      for (let dz = -1; dz <= 1 && !tooClose; dz++) {
        for (let dx = -1; dx <= 1 && !tooClose; dx++) {
          const bucket = spatialBuckets.get(bucketKey(cellX + dx, cellZ + dz));
          if (bucket && bucket.some(p => ((p[0] - x) ** 2 + (p[1] - z) ** 2) < minDistanceSquared)) {
            tooClose = true;
          }
        }
      }
      if (tooClose) continue;
    }
    positions.push(x, Number(y), z);
    normals.push(...normalized);
    if (minSpacing > 0) {
      const key = bucketKey(cellX, cellZ);
      if (!spatialBuckets.has(key)) spatialBuckets.set(key, []);
      spatialBuckets.get(key).push([x, z]);
    }
  }
  return Object.freeze({
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    count: positions.length / 3, requestedCount: count, attempts
  });
}

/** Packs a bounded, stable world-material layer table for a future GPU upload. */
export function packPStudioWorldMaterialLayers(layers = []) {
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 32) throw new RangeError('World material sets require between 1 and 32 layers.');
  const ids = new Set();
  const stride = 12;
  const packed = new Float32Array(layers.length * stride);
  const records = layers.map((layer, index) => {
    const id = String(layer?.id || '').trim();
    if (!id || ids.has(id)) throw new TypeError('World material layer ids must be unique and non-empty.');
    ids.add(id);
    const values = [
      finite(layer.uvScale ?? 1, 1, 'uvScale'),
      finite(layer.elevationMin ?? 0, 0, 'elevationMin'),
      finite(layer.elevationMax ?? 1, 1, 'elevationMax'),
      finite(layer.slopeMin ?? 0, 0, 'slopeMin'),
      finite(layer.slopeMax ?? 1, 1, 'slopeMax'),
      finite(layer.blendWidth ?? 0.1, 0.1, 'blendWidth'),
      finite(layer.roughness ?? 0.8, 0.8, 'roughness'),
      finite(layer.metalness ?? 0, 0, 'metalness'),
      finite(layer.normalScale ?? 1, 1, 'normalScale'),
      finite(layer.macroScale ?? 0.1, 0.1, 'macroScale'),
      finite(layer.detailScale ?? 1, 1, 'detailScale'),
      finite(layer.triplanarSharpness ?? 4, 4, 'triplanarSharpness')
    ];
    if (values[0] <= 0 || values[2] < values[1] || values[4] < values[3] ||
        values[5] < 0 || values[6] < 0.045 || values[6] > 1 ||
        values[7] < 0 || values[7] > 1 || values[8] < 0 || values[8] > 8 ||
        values[11] < 1 || values[11] > 16) throw new RangeError('World material layer contains an invalid scale, range or PBR value.');
    packed.set(values, index * stride);
    return Object.freeze({ id, index, textureSet: String(layer.textureSet || id) });
  });
  return Object.freeze({ records: Object.freeze(records), packed, layerCount: records.length, stride });
}

export function createPStudioWorldRenderingCore(options = {}) {
  const chunks = new Map();
  let disposed = false;
  function assertLive() { if (disposed) throw new PStudioGraphicsError('World Rendering Core is disposed.', { code: 'PSTUDIO_WORLD_CORE_DISPOSED' }); }
  function registerChunk(input) {
    assertLive();
    const chunk = createPStudioWorldChunkDescriptor(input);
    if (chunks.has(chunk.id)) throw new PStudioGraphicsError('World chunk already registered: ' + chunk.id, { code: 'PSTUDIO_WORLD_CHUNK_DUPLICATE' });
    chunks.set(chunk.id, chunk);
    return chunk;
  }
  function updateChunk(input) {
    assertLive();
    const chunk = createPStudioWorldChunkDescriptor(input);
    if (!chunks.has(chunk.id)) throw new PStudioGraphicsError('Unknown world chunk: ' + chunk.id, { code: 'PSTUDIO_WORLD_CHUNK_UNKNOWN' });
    chunks.set(chunk.id, chunk);
    return chunk;
  }
  function removeChunk(id) { assertLive(); return chunks.delete(String(id)); }
  function getChunk(id) { assertLive(); return chunks.get(String(id)) || null; }
  function listChunks() { assertLive(); return Object.freeze([...chunks.values()].sort((a, b) => a.id.localeCompare(b.id))); }
  function stats() { return Object.freeze({ chunkCount: chunks.size, disposed }); }
  function dispose() { if (disposed) return false; chunks.clear(); disposed = true; return true; }
  return Object.freeze({ kind: 'pstudio-world-rendering-core', registerChunk, updateChunk, removeChunk, getChunk, listChunks, stats, dispose });
}


/**
 * World runtime that connects chunk visibility/LOD/stream budgeting to an
 * injected asset loader, GPU uploader and renderer. The core owns only logical
 * descriptors; uploaded handles remain owned by the injected graphics backend.
 */
export function createPStudioWorldRenderingSystem(options = {}) {
  const core = options.core || createPStudioWorldRenderingCore();
  const ownsCore = !options.core;
  const executor = options.executor || {};
  const chunks = new Map();
  let disposed = false, viewRevision = 0, streaming = false, frameId = 0;
  let visible = [], lastView = null, lastStreamResult = null;

  function assertLive() {
    if (disposed) throw new PStudioGraphicsError('World Rendering System is disposed.', { code: 'PSTUDIO_WORLD_SYSTEM_DISPOSED' });
  }
  function normalizeBytes(value) {
    const bytes = Number(value ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('World chunk estimatedBytes must be a non-negative safe integer.');
    return bytes;
  }
  function registerChunk(input = {}) {
    assertLive();
    const descriptor = core.registerChunk(input);
    chunks.set(descriptor.id, {
      descriptor,
      estimatedBytes: normalizeBytes(input.estimatedBytes),
      generation: 1,
      lod: null,
      residentHandle: null,
      foliageHandle: null,
      loading: false,
      loadError: null,
      lastVisibleRevision: 0
    });
    return descriptor;
  }
  async function releaseRecordHandles(record) {
    if (record.residentHandle != null) {
      try { await executor.releaseChunk?.(record.residentHandle, record.descriptor); } catch (_) {}
      record.residentHandle = null;
    }
    if (record.foliageHandle != null) {
      try { await executor.releaseFoliage?.(record.foliageHandle, record.descriptor); } catch (_) {}
      record.foliageHandle = null;
    }
  }
  async function updateChunk(input = {}) {
    assertLive();
    const descriptor = core.updateChunk(input);
    const record = chunks.get(descriptor.id);
    if (!record) throw new PStudioGraphicsError('World chunk runtime record is missing: ' + descriptor.id, { code: 'PSTUDIO_WORLD_CHUNK_RUNTIME_MISSING' });
    record.generation++;
    record.loading = false;
    record.descriptor = descriptor;
    record.estimatedBytes = normalizeBytes(input.estimatedBytes ?? record.estimatedBytes);
    record.lod = null;
    record.loadError = null;
    await releaseRecordHandles(record);
    visible = visible.filter(item => item.id !== descriptor.id);
    return descriptor;
  }
  async function removeChunk(id) {
    assertLive();
    const key = String(id);
    const record = chunks.get(key);
    if (!record) return false;
    record.generation++;
    await releaseRecordHandles(record);
    chunks.delete(key);
    core.removeChunk(key);
    visible = visible.filter(item => item.id !== key);
    return true;
  }

  function updateView(input = {}) {
    assertLive();
    const cameraPosition = vector3(input.cameraPosition, 'cameraPosition');
    const planes = input.frustumPlanes;
    const viewportHeight = positiveInteger(input.viewportHeight, 'viewportHeight', 32768);
    const fovYRadians = finite(input.fovYRadians ?? Math.PI / 3, Math.PI / 3, 'fovYRadians');
    if (fovYRadians <= 0 || fovYRadians >= Math.PI) throw new RangeError('World view FOV must be between 0 and PI radians.');
    const candidates = [];
    for (const record of chunks.values()) {
      const descriptor = record.descriptor;
      const bounds = { min: descriptor.boundsMin, max: descriptor.boundsMax };
      if (!isPStudioAABBVisible(bounds, planes)) continue;
      const center = [
        (descriptor.boundsMin[0] + descriptor.boundsMax[0]) * 0.5,
        (descriptor.boundsMin[1] + descriptor.boundsMax[1]) * 0.5,
        (descriptor.boundsMin[2] + descriptor.boundsMax[2]) * 0.5
      ];
      const distance = Math.max(EPSILON, Math.hypot(
        center[0] - cameraPosition[0], center[1] - cameraPosition[1], center[2] - cameraPosition[2]
      ));
      const selection = selectPStudioWorldLOD({
        geometricError: descriptor.geometricError,
        distance,
        viewportHeight,
        fovYRadians,
        thresholds: input.lodThresholds || options.lodThresholds || [4, 2, 1],
        previousLod: record.lod,
        hysteresis: input.lodHysteresis ?? options.lodHysteresis ?? 0.12
      });
      record.lod = selection.lod;
      record.lastVisibleRevision = viewRevision + 1;
      candidates.push(Object.freeze({
        id: descriptor.id, descriptor, center: Object.freeze(center), distance,
        lod: selection.lod, projectedError: selection.projectedError,
        resident: record.residentHandle != null, loading: record.loading
      }));
    }
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    viewRevision++;
    visible = candidates;
    lastView = Object.freeze({
      viewRevision, cameraPosition: Object.freeze(cameraPosition),
      viewportHeight, fovYRadians,
      visibleChunks: Object.freeze(candidates)
    });
    return lastView;
  }

  async function streamTick(limits = {}) {
    assertLive();
    if (streaming) throw new PStudioGraphicsError('World streaming tick is already in progress.', { code: 'PSTUDIO_WORLD_STREAM_BUSY' });
    if (typeof executor.loadChunkData !== 'function' || typeof executor.uploadChunk !== 'function') {
      throw new PStudioGraphicsError('World streaming requires loadChunkData and uploadChunk executor functions.', { code: 'PSTUDIO_WORLD_STREAM_EXECUTOR_UNAVAILABLE' });
    }
    const requests = visible.map(item => {
      const record = chunks.get(item.id);
      if (!record || record.residentHandle != null || record.loading) return null;
      return {
        id: record.descriptor.id,
        priority: finite(record.descriptor.geometricError, 0, 'chunk geometricError') + 1 / Math.max(EPSILON, item.distance),
        distance: item.distance,
        estimatedBytes: record.estimatedBytes,
        descriptor: record.descriptor,
        generation: record.generation
      };
    }).filter(Boolean);
    const ranked = rankPStudioWorldStreamingRequests(requests, limits);
    streaming = true;
    const outcomes = await Promise.all(ranked.selected.map(async request => {
      const record = chunks.get(request.id);
      if (!record || record.generation !== request.generation) return { id: request.id, status: 'stale-before-load' };
      record.loading = true;
      record.loadError = null;
      let uploadedHandle = null;
      try {
        const data = await executor.loadChunkData(request.descriptor);
        const current = chunks.get(request.id);
        if (!current || current.generation !== request.generation) return { id: request.id, status: 'stale-after-load' };
        uploadedHandle = await executor.uploadChunk({
          descriptor: request.descriptor,
          data,
          generation: request.generation
        });
        if (uploadedHandle == null) throw new Error('World chunk uploader returned no GPU handle.');
        const latest = chunks.get(request.id);
        if (!latest || latest.generation !== request.generation) {
          try { await executor.releaseChunk?.(uploadedHandle, request.descriptor); } catch (_) {}
          uploadedHandle = null;
          return { id: request.id, status: 'stale-after-upload' };
        }
        latest.residentHandle = uploadedHandle;
        uploadedHandle = null;
        return { id: request.id, status: 'resident', handle: latest.residentHandle };
      } catch (error) {
        const latest = chunks.get(request.id);
        if (uploadedHandle != null) {
          try { await executor.releaseChunk?.(uploadedHandle, request.descriptor); } catch (_) {}
        }
        if (latest && latest.generation === request.generation) latest.loadError = String(error?.message || error);
        return { id: request.id, status: 'failed', error: String(error?.message || error) };
      } finally {
        const latest = chunks.get(request.id);
        if (latest && latest.generation === request.generation) latest.loading = false;
      }
    }));
    streaming = false;
    lastStreamResult = Object.freeze({
      selected: Object.freeze(ranked.selected.map(item => item.id)),
      deferred: Object.freeze(ranked.deferred.map(item => item.id)),
      estimatedBytes: ranked.estimatedBytes,
      outcomes: Object.freeze(outcomes.map(item => Object.freeze(item)))
    });
    return lastStreamResult;
  }

  async function prepareFoliage(id, terrain, input = {}) {
    assertLive();
    if (typeof executor.uploadFoliage !== 'function') {
      throw new PStudioGraphicsError('Foliage preparation requires an uploadFoliage executor function.', { code: 'PSTUDIO_WORLD_FOLIAGE_EXECUTOR_UNAVAILABLE' });
    }
    const record = chunks.get(String(id));
    if (!record) throw new PStudioGraphicsError('Unknown world chunk: ' + id, { code: 'PSTUDIO_WORLD_CHUNK_UNKNOWN' });
    const generation = record.generation;
    const scatter = scatterPStudioFoliage({
      ...input,
      boundsMin: input.boundsMin || record.descriptor.boundsMin,
      boundsMax: input.boundsMax || record.descriptor.boundsMax,
      sampleHeight: terrain?.sampleHeight,
      sampleNormal: terrain?.sampleNormal
    });
    const handle = await executor.uploadFoliage({
      chunk: record.descriptor,
      positions: scatter.positions,
      normals: scatter.normals,
      count: scatter.count,
      generation
    });
    if (handle == null) throw new Error('Foliage uploader returned no GPU handle.');
    const current = chunks.get(record.descriptor.id);
    if (!current || current.generation !== generation) {
      try { await executor.releaseFoliage?.(handle, record.descriptor); } catch (_) {}
      throw new PStudioGraphicsError('Foliage upload completed for a stale world chunk.', { code: 'PSTUDIO_WORLD_FOLIAGE_STALE' });
    }
    if (current.foliageHandle != null) {
      try { await executor.releaseFoliage?.(current.foliageHandle, current.descriptor); } catch (_) {}
    }
    current.foliageHandle = handle;
    return Object.freeze({ count: scatter.count, attempts: scatter.attempts, handle });
  }

  async function renderFrame(input = {}) {
    assertLive();
    if (typeof executor.renderWorldFrame !== 'function') {
      throw new PStudioGraphicsError('World rendering requires a renderWorldFrame executor function.', { code: 'PSTUDIO_WORLD_RENDER_EXECUTOR_UNAVAILABLE' });
    }
    const renderChunks = visible.map(item => {
      const record = chunks.get(item.id);
      if (!record || record.residentHandle == null) return null;
      return Object.freeze({
        id: item.id, descriptor: record.descriptor, gpuHandle: record.residentHandle,
        foliageHandle: record.foliageHandle, lod: item.lod, distance: item.distance
      });
    }).filter(Boolean);
    const packet = Object.freeze({
      frameId: input.frameId == null ? ++frameId : positiveInteger(input.frameId, 'world frameId'),
      viewRevision, chunks: Object.freeze(renderChunks),
      environment: input.environment ?? null,
      materials: input.materials ?? null,
      camera: lastView?.cameraPosition ?? null,
      viewport: lastView ? Object.freeze({ height: lastView.viewportHeight, fovYRadians: lastView.fovYRadians }) : null
    });
    const result = await executor.renderWorldFrame(packet);
    return Object.freeze({ packet, result: result ?? null });
  }

  async function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const record of chunks.values()) {
      record.generation++;
      record.loading = false;
    }
    for (const record of chunks.values()) await releaseRecordHandles(record);
    chunks.clear();
    visible = [];
    if (ownsCore) core.dispose();
    return true;
  }

  function stats() {
    return Object.freeze({
      chunkCount: chunks.size,
      visibleCount: visible.length,
      residentCount: [...chunks.values()].filter(record => record.residentHandle != null).length,
      loadingCount: [...chunks.values()].filter(record => record.loading).length,
      streaming,
      viewRevision,
      frameId,
      lastStreamResult,
      disposed
    });
  }
  return Object.freeze({
    kind: 'pstudio-world-rendering-system',
    core,
    registerChunk, updateChunk, removeChunk,
    updateView, streamTick, prepareFoliage, renderFrame,
    stats, dispose
  });
}
