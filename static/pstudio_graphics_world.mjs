const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(label + " is outside its supported range.");
  return n;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const vec3 = value => {
  const v = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [0, 0, 0];
  return [finite(v[0]), finite(v[1]), finite(v[2])];
};
function aabb(value) {
  const min = vec3(value?.min), max = vec3(value?.max);
  for (let i = 0; i < 3; i++) if (max[i] < min[i]) throw new RangeError("AABB max must not be below min.");
  return { min, max };
}
function aabbDistance(point, box) {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const d = point[i] < box.min[i] ? box.min[i] - point[i] : point[i] > box.max[i] ? point[i] - box.max[i] : 0;
    sum += d * d;
  }
  return Math.sqrt(sum);
}
function inFrustum(box, planes) {
  if (!planes) return true;
  for (const plane of planes) {
    const p = Array.isArray(plane) || ArrayBuffer.isView(plane) ? plane : [plane?.normal?.x, plane?.normal?.y, plane?.normal?.z, plane?.constant];
    const x = finite(p[0]), y = finite(p[1]), z = finite(p[2]), d = finite(p[3]);
    const px = x >= 0 ? box.max[0] : box.min[0], py = y >= 0 ? box.max[1] : box.min[1], pz = z >= 0 ? box.max[2] : box.min[2];
    if (x * px + y * py + z * pz + d < 0) return false;
  }
  return true;
}

/** Independent terrain, world visibility, LOD and foliage data builder. */
export function createPStudioGraphicsWorldCore(options = {}) {
  const maxSegments = integer(options.maxTerrainSegments ?? 256, 1, 512, "maxTerrainSegments");
  const maxVertices = integer(options.maxTerrainVertices ?? 300000, 16, 2000000, "maxTerrainVertices");
  const maxInstances = integer(options.maxFoliageInstances ?? 250000, 0, 2000000, "maxFoliageInstances");
  const maxLodHistoryEntries = integer(options.maxLodHistoryEntries ?? 100000, 1, 1000000, "maxLodHistoryEntries");
  const lodHistory = new Map();
  let disposed = false;
  const live = () => { if (disposed) throw new Error("PStudio Graphics World Core is disposed."); };

  function buildTerrainTile(input = {}) {
    live();
    const segments = integer(input.segments ?? 32, 1, maxSegments, "segments");
    const row = segments + 1, baseVertices = row * row;
    const heightData = input.heightSamples;
    if (!heightData || heightData.length !== baseVertices) throw new TypeError("heightSamples must contain exactly (segments + 1)^2 values.");
    const size = input.size || [1, 1], sx = finite(size[0], 1), sz = finite(size[1], sx);
    if (!(sx > 0) || !(sz > 0)) throw new RangeError("Terrain tile dimensions must be positive.");
    const origin = vec3(input.origin), scale = finite(input.heightScale, 1), skirt = Math.max(0, finite(input.skirtDepth));
    const edgeCount = skirt > 0 ? segments * 4 : 0;
    const vertexCount = baseVertices + edgeCount;
    if (vertexCount > maxVertices) throw new RangeError("Terrain tile exceeds the configured vertex budget.");
    const heights = new Float32Array(baseVertices);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < baseVertices; i++) {
      const h = Number(heightData[i]);
      if (!Number.isFinite(h)) throw new TypeError("Terrain height samples must be finite.");
      heights[i] = h * scale; minH = Math.min(minH, heights[i]); maxH = Math.max(maxH, heights[i]);
    }
    const sample = (x, z) => heights[clamp(z, 0, segments) * row + clamp(x, 0, segments)];
    const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3), uvs = new Float32Array(vertexCount * 2);
    const indexCapacity = segments * segments * 6 + edgeCount * 6;
    const indices = new Uint32Array(indexCapacity);
    for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
      const i = z * row + x;
      const lx = Math.max(0, x - 1), rx = Math.min(segments, x + 1);
      const dz0 = Math.max(0, z - 1), dz1 = Math.min(segments, z + 1);
      const dx = (sample(rx, z) - sample(lx, z)) / ((rx - lx) * sx / segments);
      const dz = (sample(x, dz1) - sample(x, dz0)) / ((dz1 - dz0) * sz / segments);
      const inv = 1 / Math.hypot(dx, 1, dz);
      positions.set([origin[0] + sx * x / segments, origin[1] + heights[i], origin[2] + sz * z / segments], i * 3);
      normals.set([-dx * inv, inv, -dz * inv], i * 3);
      uvs.set([x / segments, z / segments], i * 2);
    }
    let cursor = 0;
    for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
      const a = z * row + x, b = a + 1, c = a + row, d = c + 1;
      indices.set([a, c, b, b, c, d], cursor); cursor += 6;
    }
    if (skirt > 0) {
      const edges = [];
      for (let x = 0; x < segments; x++) edges.push(x);
      for (let z = 0; z < segments; z++) edges.push(z * row + segments);
      for (let x = segments; x > 0; x--) edges.push(segments * row + x);
      for (let z = segments; z > 0; z--) edges.push(z * row);
      const skirtOffset = baseVertices;
      for (let i = 0; i < edges.length; i++) {
        const s = edges[i], t = skirtOffset + i;
        positions.set([positions[s * 3], positions[s * 3 + 1] - skirt, positions[s * 3 + 2]], t * 3);
        normals.set(normals.subarray(s * 3, s * 3 + 3), t * 3);
        uvs.set(uvs.subarray(s * 2, s * 2 + 2), t * 2);
      }
      for (let i = 0; i < edges.length; i++) {
        const n = (i + 1) % edges.length, a = edges[i], b = edges[n], sa = skirtOffset + i, sb = skirtOffset + n;
        indices.set([a, sa, b, b, sa, sb], cursor); cursor += 6;
      }
    }
    return Object.freeze({
      kind: "pstudio-world-terrain-tile", segments, vertexCount, indexCount: cursor,
      positions, normals, uvs, indices: indices.subarray(0, cursor),
      bounds: Object.freeze({
        min: Object.freeze([origin[0], origin[1] + minH - skirt, origin[2]]),
        max: Object.freeze([origin[0] + sx, origin[1] + maxH, origin[2] + sz])
      })
    });
  }

  function selectLod(input = {}) {
    live();
    const roots = Array.isArray(input.roots) ? input.roots : [], camera = vec3(input.cameraPosition);
    const fov = clamp(finite(input.verticalFov, Math.PI / 3), 0.01, Math.PI - 0.01);
    const projection = Math.max(1, finite(input.projectionScale, finite(input.viewportHeight, 1080) / (2 * Math.tan(fov / 2))));
    const threshold = Math.max(0.01, finite(input.pixelErrorThreshold, 2));
    const maxVisible = integer(input.maxVisibleTiles ?? 100000, 1, 1000000, "maxVisibleTiles");
    const maxDepth = integer(input.maxDepth ?? 24, 0, 64, "maxDepth");
    const visible = [], culled = [], visited = new Set();
    const rememberLod = (id, split) => {
      lodHistory.delete(id);
      lodHistory.set(id, split);
      if (lodHistory.size > maxLodHistoryEntries) lodHistory.delete(lodHistory.keys().next().value);
    };
    const visit = (tile, depth) => {
      if (!tile || typeof tile.id !== "string" || !tile.bounds) throw new TypeError("Each world tile requires id and bounds.");
      if (visited.has(tile.id)) throw new TypeError("World LOD hierarchy contains a duplicate or cyclic tile id: " + tile.id);
      visited.add(tile.id);
      const box = aabb(tile.bounds);
      if (!inFrustum(box, input.frustumPlanes)) { culled.push(tile.id); lodHistory.delete(tile.id); return; }
      const distance = Math.max(1e-4, aabbDistance(camera, box));
      const pixelError = Math.max(0, finite(tile.geometricError)) * projection / distance;
      const children = Array.isArray(tile.children) ? tile.children : [];
      const wasSplit = lodHistory.get(tile.id) === true;
      const split = children.length > 0 && depth < maxDepth && pixelError > threshold * (wasSplit ? 0.9 : 1.1);
      rememberLod(tile.id, split);
      if (split) for (const child of children) visit(child, depth + 1);
      else {
        if (visible.length >= maxVisible) throw new RangeError("World LOD selection exceeded maxVisibleTiles.");
        visible.push(Object.freeze({ id: tile.id, tile, distance, pixelError }));
      }
    };
    for (const root of roots) visit(root, 0);
    return Object.freeze({ visibleTiles: Object.freeze(visible), culledTileIds: Object.freeze(culled), visibleCount: visible.length, culledCount: culled.length });
  }

  function buildFoliageInstances(input = {}) {
    live();
    const box = aabb(input.bounds), area = (box.max[0] - box.min[0]) * (box.max[2] - box.min[2]);
    if (!(area > 0)) throw new RangeError("Foliage bounds must have positive X/Z area.");
    const density = Math.max(0, finite(input.densityPerSquareUnit, 0.05));
    const count = Math.min(maxInstances, Math.max(0, Math.floor(area * density)));
    const seed = (finite(input.seed, 1) >>> 0) || 1, minScale = Math.max(0.001, finite(input.minScale, 0.8)), maxScale = Math.max(minScale, finite(input.maxScale, 1.2));
    const minSlope = clamp(finite(input.minSlope, 0), 0, 1), maxSlope = clamp(finite(input.maxSlope, 1), minSlope, 1);
    const heightAt = typeof input.heightAt === "function" ? input.heightAt : () => 0, slopeAt = typeof input.slopeAt === "function" ? input.slopeAt : () => 0;
    const records = new Float32Array(count * 8);
    let accepted = 0;
    let state = seed;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const x = box.min[0] + random() * (box.max[0] - box.min[0]), z = box.min[2] + random() * (box.max[2] - box.min[2]);
      const sampledSlope = Number(slopeAt(x, z));
      const sampledHeight = Number(heightAt(x, z));
      if (!Number.isFinite(sampledSlope) || !Number.isFinite(sampledHeight)) throw new TypeError("Foliage height and slope samplers must return finite numbers.");
      const slope = clamp(sampledSlope, 0, 1);
      if (slope < minSlope || slope > maxSlope) continue;
      records.set([x, sampledHeight, z, minScale + random() * (maxScale - minScale), random() * Math.PI * 2, random() * Math.PI * 2, random(), 0], accepted * 8);
      accepted++;
    }
    return Object.freeze({ kind: "pstudio-world-foliage-instances", count: accepted, strideFloats: 8, records: records.subarray(0, accepted * 8), seed, deterministic: true });
  }

  function buildRenderPasses(input = {}) {
    live();
    const passes = [
      { id: "world.depth", stage: "depth", reads: ["camera", "terrain", "instances"], writes: ["world.depth"] },
      { id: "world.terrain", stage: "opaque", reads: ["camera", "terrain", "materials", "lights"], writes: ["world.color"] },
      { id: "world.foliage", stage: "opaque", reads: ["camera", "instances", "materials", "world.depth", "lights"], writes: ["world.color"] },
      { id: "world.transparent", stage: "transparent", reads: ["camera", "materials", "world.depth"], writes: ["world.color"] }
    ];
    if (input.includeDebugBounds) passes.push({ id: "world.debug-bounds", stage: "overlay", reads: ["camera", "world.depth"], writes: ["world.color"] });
    return Object.freeze(passes.map(p => Object.freeze({ ...p, reads: Object.freeze(p.reads), writes: Object.freeze(p.writes) })));
  }
  function dispose() { if (disposed) return false; lodHistory.clear(); disposed = true; return true; }
  return Object.freeze({ kind: "pstudio-graphics-world-core", buildTerrainTile, selectLod, buildFoliageInstances, buildRenderPasses, dispose });
}

/** Bounded async world-tile queue with cancellation, byte accounting and pin-aware LRU. */
export function createPStudioWorldStreamingCore(options = {}) {
  if (typeof options.loader !== "function") throw new TypeError("A world streaming loader is required.");
  const loader = options.loader, disposeValue = typeof options.dispose === "function" ? options.dispose : () => {};
  const maxConcurrent = integer(options.maxConcurrentLoads ?? 4, 1, 32, "maxConcurrentLoads");
  const maxBytes = integer(options.maxResidentBytes ?? 268435456, 1, Number.MAX_SAFE_INTEGER, "maxResidentBytes");
  const maxResidentTiles = integer(options.maxResidentTiles ?? 100000, 1, 1000000, "maxResidentTiles");
  const queue = [], entries = new Map();
  let active = 0, residentBytes = 0, seq = 0, clock = 0, disposed = false;
  const abortError = () => Object.assign(new Error("World tile request cancelled."), { name: "AbortError" });
  const settle = (entry, error, value) => { for (const w of entry.waiters.splice(0)) error ? w.reject(error) : w.resolve(value); };
  const touch = entry => { entry.lastUsed = ++clock; };
  function evictFor(bytes, keepId) {
    const residentCount = () => [...entries.values()].filter(e => e.state === "resident").length;
    while (residentBytes + bytes > maxBytes || residentCount() + 1 > maxResidentTiles) {
      const victim = [...entries.values()].filter(e => e.state === "resident" && e.pinCount === 0 && e.id !== keepId).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) return false;
      entries.delete(victim.id); residentBytes -= victim.bytes; victim.state = "evicted";
      try { disposeValue(victim.value, { id: victim.id, reason: "budget-eviction" }); } catch (_) {}
    }
    return true;
  }
  function pump() {
    if (disposed) return;
    queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    while (active < maxConcurrent && queue.length) {
      const entry = queue.shift();
      if (entry.state !== "queued") continue;
      active++; entry.state = "loading";
      void (async () => {
        try {
          const result = await loader(entry.payload, { id: entry.id, signal: entry.controller.signal });
          const value = result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
          const bytes = result?.byteLength ?? value?.byteLength ?? 0;
          if (disposed || entry.controller.signal.aborted || entries.get(entry.id) !== entry) {
            try { disposeValue(value, { id: entry.id, reason: "stale-load" }); } catch (_) {}
            settle(entry, abortError()); return;
          }
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes || !evictFor(bytes, entry.id)) {
            try { disposeValue(value, { id: entry.id, reason: "budget-rejected" }); } catch (_) {}
            entries.delete(entry.id); entry.state = "failed";
            settle(entry, new RangeError("World tile exceeds available resident memory budget.")); return;
          }
          entry.value = value; entry.bytes = bytes; entry.state = "resident"; touch(entry);
          residentBytes += bytes; settle(entry, null, value);
        } catch (error) {
          if (entries.get(entry.id) === entry) entries.delete(entry.id);
          entry.state = entry.controller.signal.aborted ? "cancelled" : "failed"; settle(entry, error);
        } finally { active--; pump(); }
      })();
    }
  }
  function request(idValue, payload, priorityValue = 0) {
    if (disposed) throw new Error("World Streaming Core is disposed.");
    const id = String(idValue || "");
    if (!id) throw new TypeError("World tile id is required.");
    const previous = entries.get(id);
    if (previous?.state === "resident") { touch(previous); return Promise.resolve(previous.value); }
    if (previous && (previous.state === "queued" || previous.state === "loading")) {
      previous.priority = Math.max(previous.priority, finite(priorityValue));
      return new Promise((resolve, reject) => previous.waiters.push({ resolve, reject }));
    }
    const entry = { id, payload, priority: finite(priorityValue), seq: ++seq, controller: new AbortController(), state: "queued", waiters: [], pinCount: 0, bytes: 0, value: undefined, lastUsed: 0 };
    const promise = new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
    entries.set(id, entry); queue.push(entry); pump(); return promise;
  }
  function cancel(id) {
    const entry = entries.get(String(id));
    if (!entry || (entry.state !== "queued" && entry.state !== "loading")) return false;
    entry.controller.abort(); entries.delete(entry.id); entry.state = "cancelled"; settle(entry, abortError()); pump(); return true;
  }
  function pin(id) { const e = entries.get(String(id)); if (!e || e.state !== "resident") return false; e.pinCount++; touch(e); return true; }
  function unpin(id) { const e = entries.get(String(id)); if (!e || e.state !== "resident" || !e.pinCount) return false; e.pinCount--; touch(e); return true; }
  function release(id) {
    const e = entries.get(String(id));
    if (!e || e.state !== "resident" || e.pinCount) return false;
    entries.delete(e.id); residentBytes -= e.bytes; e.state = "released";
    try { disposeValue(e.value, { id: e.id, reason: "explicit-release" }); } catch (_) {}
    return true;
  }
  function stats() { return Object.freeze({ queued: queue.filter(e => e.state === "queued").length, activeLoads: active, residentTiles: [...entries.values()].filter(e => e.state === "resident").length, residentBytes, maxResidentBytes: maxBytes, maxResidentTiles, maxConcurrentLoads: maxConcurrent, disposed }); }
  function dispose() {
    if (disposed) return false; disposed = true;
    for (const e of entries.values()) {
      if (e.state === "queued" || e.state === "loading") { e.controller.abort(); settle(e, abortError()); }
      else if (e.state === "resident") { try { disposeValue(e.value, { id: e.id, reason: "core-disposal" }); } catch (_) {} }
    }
    entries.clear(); queue.length = 0; residentBytes = 0; return true;
  }
  return Object.freeze({ kind: "pstudio-world-streaming-core", request, cancel, pin, unpin, release, stats, dispose });
}

export const PSTUDIO_WORLD_TERRAIN_WGSL = [
"struct WorldFrame { viewProjection: mat4x4<f32> };",
"@group(0) @binding(0) var<uniform> frame: WorldFrame;",
"struct TerrainVertexOut { @builtin(position) position: vec4<f32>, @location(0) worldPosition: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32> };",
"@vertex fn terrainVertex(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>) -> TerrainVertexOut {",
"  var out: TerrainVertexOut; out.position = frame.viewProjection * vec4<f32>(position, 1.0); out.worldPosition = position; out.normal = normalize(normal); out.uv = uv; return out;",
"}"
].join("\n");

export const PSTUDIO_WORLD_FOLIAGE_WGSL = [
"struct WorldFrame { viewProjection: mat4x4<f32> };",
"struct FoliageUniforms { time: f32, windStrength: f32, windSpeed: f32, _pad: f32 };",
"@group(0) @binding(0) var<uniform> frame: WorldFrame;",
"@group(0) @binding(1) var<uniform> foliageUniforms: FoliageUniforms;",
"@vertex fn foliageVertex(@location(0) localPosition: vec3<f32>, @location(1) instancePositionScale: vec4<f32>, @location(2) instanceRotationPhaseVariation: vec4<f32>) -> @builtin(position) vec4<f32> {",
"  let phase = foliageUniforms.time * foliageUniforms.windSpeed + instanceRotationPhaseVariation.y;",
"  let bend = sin(phase + localPosition.x * 1.7 + localPosition.z * 1.7) * foliageUniforms.windStrength * localPosition.y * localPosition.y;",
"  let angle = instanceRotationPhaseVariation.x;",
"  let rotated = vec3<f32>(localPosition.x * cos(angle) - localPosition.z * sin(angle), localPosition.y, localPosition.x * sin(angle) + localPosition.z * cos(angle));",
"  let world = instancePositionScale.xyz + vec3<f32>(rotated.x * instancePositionScale.w + bend, rotated.y * instancePositionScale.w, rotated.z * instancePositionScale.w);",
"  return frame.viewProjection * vec4<f32>(world, 1.0);",
"}"
].join("\n");


/** Uploads CPU terrain arrays into owned WebGPU resources with atomic rollback. */
export function uploadPStudioWorldTile(backend, tile, options = {}) {
  if (!backend || typeof backend.createResource !== "function" || typeof backend.destroyResource !== "function") {
    throw new TypeError("A PStudio Graphics Core-compatible GPU backend is required.");
  }
  if (!tile || tile.kind !== "pstudio-world-terrain-tile" || !(tile.positions instanceof Float32Array) || !(tile.normals instanceof Float32Array) || !(tile.uvs instanceof Float32Array) || !(tile.indices instanceof Uint32Array)) {
    throw new TypeError("A valid PStudio world terrain tile is required.");
  }
  const prefix = String(options.id || "pstudio.world.tile").trim();
  if (!prefix) throw new TypeError("World tile resource prefix is required.");
  const created = [];
  const make = (name, data, usage) => {
    const id = prefix + "." + name;
    const resource = backend.createResource({ id, type: "buffer", size: data.byteLength, usage: [usage, "copy-dst"], metadata: { worldTile: true, tileId: prefix } }, { initialData: data });
    if (!resource) throw new Error("Failed to allocate world tile GPU resource: " + id);
    created.push(resource);
    return resource;
  };
  try {
    const vertexBuffers = Object.freeze({
      positions: make("positions", tile.positions, "vertex"),
      normals: make("normals", tile.normals, "vertex"),
      uvs: make("uvs", tile.uvs, "vertex")
    });
    const indexBuffer = make("indices", tile.indices, "index");
    let disposed = false;
    return Object.freeze({
      kind: "pstudio-world-gpu-tile", vertexCount: tile.vertexCount, indexCount: tile.indexCount,
      vertexBuffers, indexBuffer, bounds: tile.bounds,
      dispose() {
        if (disposed) return false;
        disposed = true;
        for (const resource of [...created].reverse()) backend.destroyResource(resource);
        return true;
      }
    });
  } catch (error) {
    for (const resource of created.reverse()) { try { backend.destroyResource(resource); } catch (_) {} }
    throw error;
  }
}

/** Stable 16-float material table with deterministic ID-to-packed-index mapping. */
export function packPStudioWorldMaterialTable(materials) {
  if (!Array.isArray(materials)) throw new TypeError("World materials must be an array.");
  const sorted = [...materials].map(material => {
    const id = String(material?.id || "");
    if (!id) throw new TypeError("Every world material requires a stable id.");
    const color = material.baseColor || [1, 1, 1, 1];
    const baseColor = Array.from({ length: 4 }, (_, i) => Number(color[i] ?? 1));
    if (baseColor.some(v => !Number.isFinite(v))) throw new TypeError("World material baseColor values must be finite.");
    return { id, baseColor, roughness: Math.max(0.02, Math.min(1, finite(material.roughness, 1))), metalness: clamp(finite(material.metalness), 0, 1), emissive: vec3(material.emissive), emissiveIntensity: Math.max(0, finite(material.emissiveIntensity)), alphaCutoff: clamp(finite(material.alphaCutoff), 0, 1), flags: Math.max(0, Math.floor(finite(material.flags))) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const indexById = new Map(), data = new Float32Array(sorted.length * 16);
  sorted.forEach((m, i) => {
    if (indexById.has(m.id)) throw new TypeError("Duplicate world material id: " + m.id);
    indexById.set(m.id, i);
    data.set([...m.baseColor, m.roughness, m.metalness, ...m.emissive, m.emissiveIntensity, m.alphaCutoff, m.flags, 0, 0, 0, 0], i * 16);
  });
  return Object.freeze({ kind: "pstudio-world-material-table", count: sorted.length, strideFloats: 16, data, indexById });
}
