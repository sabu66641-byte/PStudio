const test = require('node:test');
const assert = require('node:assert/strict');
let {
  createPStudioTerrainHeightfield, createPStudioWorldChunkDescriptor,
  selectPStudioWorldLOD, isPStudioAABBVisible, rankPStudioWorldStreamingRequests,
  scatterPStudioFoliage, packPStudioWorldMaterialLayers, createPStudioWorldRenderingCore,
  createPStudioWorldRenderingSystem
} = {};
test.before(async () => {
  ({
    createPStudioTerrainHeightfield, createPStudioWorldChunkDescriptor,
    selectPStudioWorldLOD, isPStudioAABBVisible, rankPStudioWorldStreamingRequests,
    scatterPStudioFoliage, packPStudioWorldMaterialLayers, createPStudioWorldRenderingCore,
    createPStudioWorldRenderingSystem
  } = await import('../static/pstudio_graphics_world_core.mjs'));
});

test('heightfield samples bilinearly in world coordinates and returns finite normals', () => {
  const terrain = createPStudioTerrainHeightfield({
    width: 2, height: 2, spacingX: 2, spacingZ: 2,
    origin: [10, 5, 20], heights: [0, 2, 4, 6]
  });
  assert.equal(terrain.sampleHeight(10, 20), 5);
  assert.equal(terrain.sampleHeight(11, 21), 8);
  assert.equal(terrain.sampleHeight(100, 100), null);
  const normal = terrain.sampleNormal(11, 21);
  assert.equal(normal.length, 3);
  assert.ok(normal.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6);
  assert.deepEqual(terrain.bounds.min, [10, 5, 20]);
  assert.deepEqual(terrain.bounds.max, [12, 11, 22]);
  assert.throws(() => createPStudioTerrainHeightfield({ width: 2, height: 2, heights: [0, NaN, 0, 0] }), /finite/);
});

test('world chunk descriptors validate bounds and canonicalize asset lists', () => {
  const chunk = createPStudioWorldChunkDescriptor({
    id: 'forest.0.0', x: 0, z: 0,
    boundsMin: [0, -10, 0], boundsMax: [100, 50, 100],
    geometricError: 4, assets: ['tree.glb', 'rock.glb', 'tree.glb']
  });
  assert.deepEqual(chunk.assets, ['rock.glb', 'tree.glb']);
  assert.equal(chunk.geometricError, 4);
  assert.throws(() => createPStudioWorldChunkDescriptor({ id: 'bad', boundsMin: [2, 0, 0], boundsMax: [1, 1, 1] }), /boundsMin/);
});

test('projected-error LOD selection is monotonic and hysteresis prevents boundary flicker', () => {
  const base = { geometricError: 5, viewportHeight: 1080, fovYRadians: Math.PI / 3, thresholds: [4, 2, 1] };
  const near = selectPStudioWorldLOD({ ...base, distance: 100 });
  const far = selectPStudioWorldLOD({ ...base, distance: 2000 });
  assert.ok(near.lod < far.lod);
  const boundary = selectPStudioWorldLOD({ geometricError: 5, distance: 5 * 1080 / (2 * Math.tan(Math.PI / 6) * 4), viewportHeight: 1080, thresholds: [4, 2, 1], previousLod: 0 });
  assert.equal(boundary.lod, 0);
  assert.throws(() => selectPStudioWorldLOD({ ...base, thresholds: [1, 2] }), /descending/);
});

test('frustum AABB visibility is conservative and rejects a box outside any plane', () => {
  const planes = [
    [1, 0, 0, 10], [-1, 0, 0, 10],
    [0, 1, 0, 10], [0, -1, 0, 10],
    [0, 0, 1, 10], [0, 0, -1, 10]
  ];
  assert.equal(isPStudioAABBVisible({ min: [-1, -1, -1], max: [1, 1, 1] }, planes), true);
  assert.equal(isPStudioAABBVisible({ min: [20, 0, 0], max: [21, 1, 1] }, planes), false);
  assert.throws(() => isPStudioAABBVisible({ min: [0, 0, 0], max: [1, 1, 1] }, [[1, 0, 0]]), /Six/);
});

test('streaming request ranking is deterministic and defers budget overflow without dropping requests', () => {
  const ranked = rankPStudioWorldStreamingRequests([
    { id: 'far-important', priority: 10, distance: 50, estimatedBytes: 60 },
    { id: 'near-low', priority: 1, distance: 1, estimatedBytes: 20 },
    { id: 'near-high', priority: 10, distance: 5, estimatedBytes: 40 }
  ], { maxConcurrent: 2, maxBytes: 100 });
  assert.deepEqual(ranked.selected.map(item => item.id), ['near-high', 'far-important']);
  assert.deepEqual(ranked.deferred.map(item => item.id), ['near-low']);
  assert.equal(ranked.estimatedBytes, 100);
});

test('foliage scatter is seeded, slope-aware, bounded and reproducible', () => {
  const options = {
    count: 24, seed: 1234, boundsMin: [0, 0, 0], boundsMax: [20, 0, 20],
    sampleHeight: (x, z) => x * 0.1 + z * 0.05,
    sampleNormal: () => [0, 1, 0], minSpacing: 1
  };
  const a = scatterPStudioFoliage(options);
  const b = scatterPStudioFoliage(options);
  assert.equal(a.count, 24);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.normals, b.normals);
  assert.ok(a.attempts >= a.count && a.attempts <= 24 * 24);
  for (let i = 0; i < a.count; i++) {
    assert.ok(a.positions[i * 3] >= 0 && a.positions[i * 3] <= 20);
    assert.ok(a.positions[i * 3 + 2] >= 0 && a.positions[i * 3 + 2] <= 20);
  }
  const rejected = scatterPStudioFoliage({ count: 2, seed: 1, maxAttempts: 8, sampleHeight: () => 0, sampleNormal: () => [1, 0, 0], maxSlopeRadians: 0.2 });
  assert.equal(rejected.count, 0);
});

test('world material layer packing validates PBR ranges and creates stable layer indices', () => {
  const packed = packPStudioWorldMaterialLayers([
    { id: 'grass', uvScale: 0.5, roughness: 0.9 },
    { id: 'rock', uvScale: 2, roughness: 0.7, metalness: 0.1 }
  ]);
  assert.equal(packed.layerCount, 2);
  assert.equal(packed.stride, 12);
  assert.equal(packed.records[1].index, 1);
  assert.equal(packed.packed[0], 0.5);
  assert.throws(() => packPStudioWorldMaterialLayers([{ id: 'same' }, { id: 'same' }]), /unique/);
  assert.throws(() => packPStudioWorldMaterialLayers([{ id: 'bad', roughness: 2 }]), /PBR/);
});

test('world core registration, update and disposal are isolated and deterministic', () => {
  const core = createPStudioWorldRenderingCore();
  core.registerChunk({ id: 'a', boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] });
  assert.equal(core.stats().chunkCount, 1);
  assert.throws(() => core.registerChunk({ id: 'a', boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] }), /already registered/);
  core.updateChunk({ id: 'a', boundsMin: [0, 0, 0], boundsMax: [2, 2, 2], revision: 2 });
  assert.equal(core.getChunk('a').revision, 2);
  assert.equal(core.removeChunk('a'), true);
  assert.equal(core.dispose(), true);
  assert.equal(core.dispose(), false);
  assert.throws(() => core.listChunks(), /disposed/);
});


test('world system connects frustum visibility, LOD, budgeted streaming, foliage upload and frame rendering', async () => {
  const calls = [];
  const system = createPStudioWorldRenderingSystem({
    executor: {
      async loadChunkData(descriptor) { calls.push('load:' + descriptor.id); return { mesh: descriptor.id }; },
      async uploadChunk({ descriptor, data }) { calls.push('upload:' + data.mesh); return 'gpu:' + descriptor.id; },
      async uploadFoliage(packet) { calls.push('foliage:' + packet.chunk.id); return 'foliage:' + packet.chunk.id; },
      async renderWorldFrame(packet) { calls.push('render:' + packet.chunks.length); return { drawCount: packet.chunks.length }; },
      async releaseChunk(handle) { calls.push('release:' + handle); },
      async releaseFoliage(handle) { calls.push('release:' + handle); }
    }
  });
  system.registerChunk({
    id: 'near', boundsMin: [1, 0, -11], boundsMax: [2, 1, -10],
    geometricError: 4, estimatedBytes: 40, revision: 1
  });
  system.registerChunk({
    id: 'far', boundsMin: [10, 0, -31], boundsMax: [12, 2, -29],
    geometricError: 1, estimatedBytes: 30, revision: 1
  });
  const planes = [
    [1, 0, 0, 100], [-1, 0, 0, 100],
    [0, 1, 0, 100], [0, -1, 0, 100],
    [0, 0, 1, 100], [0, 0, -1, 100]
  ];
  const view = system.updateView({
    cameraPosition: [0, 0, 0], frustumPlanes: planes,
    viewportHeight: 1080, fovYRadians: Math.PI / 3
  });
  assert.equal(view.visibleChunks.length, 2);
  assert.ok(view.visibleChunks.every(item => Number.isInteger(item.lod)));
  const streamed = await system.streamTick({ maxConcurrent: 1, maxBytes: 45 });
  assert.equal(streamed.selected.length, 1);
  assert.equal(streamed.deferred.length, 1);
  assert.equal(streamed.outcomes[0].status, 'resident');
  const terrain = createPStudioTerrainHeightfield({
    width: 2, height: 2, origin: [0, 0, -12],
    spacingX: 20, spacingZ: 20, heights: [0, 0, 0, 0]
  });
  const foliage = await system.prepareFoliage('near', terrain, {
    count: 6, seed: 9, boundsMin: [1, 0, -11], boundsMax: [2, 1, -10],
    maxSlopeRadians: 0.2
  });
  assert.equal(foliage.count, 6);
  const rendered = await system.renderFrame({ environment: { timeOfDay: 0.5 }, materials: { id: 'world-materials' } });
  assert.equal(rendered.result.drawCount, 1);
  assert.equal(system.stats().residentCount, 1);
  await system.dispose();
  assert.equal(system.stats().disposed, true);
  assert.ok(calls.some(value => value.startsWith('render:')));
  assert.ok(calls.some(value => value.startsWith('release:gpu:')));
  assert.ok(calls.some(value => value.startsWith('release:foliage:')));
});

test('world system discards a completed load when the chunk generation changes', async () => {
  let resolveLoad, uploadCount = 0;
  const load = new Promise(resolve => { resolveLoad = resolve; });
  const system = createPStudioWorldRenderingSystem({
    executor: {
      loadChunkData: () => load,
      async uploadChunk() { uploadCount++; return 'gpu:stale'; }
    }
  });
  const descriptor = {
    id: 'changing', boundsMin: [0, 0, -2], boundsMax: [1, 1, -1],
    geometricError: 1, estimatedBytes: 1, revision: 1
  };
  system.registerChunk(descriptor);
  system.updateView({
    cameraPosition: [0, 0, 0],
    frustumPlanes: [
      [1, 0, 0, 10], [-1, 0, 0, 10],
      [0, 1, 0, 10], [0, -1, 0, 10],
      [0, 0, 1, 10], [0, 0, -1, 10]
    ],
    viewportHeight: 720
  });
  const pending = system.streamTick({ maxConcurrent: 1, maxBytes: 10 });
  await Promise.resolve();
  await system.updateChunk({ ...descriptor, revision: 2 });
  resolveLoad({ mesh: 'old-generation' });
  const result = await pending;
  assert.equal(result.outcomes[0].status, 'stale-after-load');
  assert.equal(uploadCount, 0);
  assert.equal(system.stats().residentCount, 0);
  await system.dispose();
});


test('world residency eviction respects visibility, grace period and byte/count budgets', async () => {
  const released = [];
  const system = createPStudioWorldRenderingSystem({
    executor: {
      async loadChunkData(chunk) { return chunk.id; },
      async uploadChunk({ descriptor }) { return 'gpu:' + descriptor.id; },
      async releaseChunk(handle) { released.push(handle); }
    }
  });
  system.registerChunk({ id: 'near', boundsMin: [0, 0, -11], boundsMax: [1, 1, -10], estimatedBytes: 40, geometricError: 1 });
  system.registerChunk({ id: 'far', boundsMin: [0, 0, -31], boundsMax: [1, 1, -30], estimatedBytes: 30, geometricError: 1 });
  const broadFrustum = [
    [1, 0, 0, 100], [-1, 0, 0, 100],
    [0, 1, 0, 100], [0, -1, 0, 100],
    [0, 0, 1, 100], [0, 0, -1, 100]
  ];
  system.updateView({ cameraPosition: [0, 0, 0], frustumPlanes: broadFrustum, viewportHeight: 720 });
  const loaded = await system.streamTick({ maxConcurrent: 2, maxBytes: 100 });
  assert.equal(loaded.outcomes.filter(item => item.status === 'resident').length, 2);
  assert.equal(system.stats().residentBytes, 70);

  const nearOnlyFrustum = [
    [1, 0, 0, 100], [-1, 0, 0, 100],
    [0, 1, 0, 100], [0, -1, 0, 100],
    [0, 0, 1, 20], [0, 0, -1, 100]
  ];
  system.updateView({ cameraPosition: [0, 0, 0], frustumPlanes: nearOnlyFrustum, viewportHeight: 720 });
  const eviction = await system.evictInvisible({ maxResidentChunks: 1, maxResidentBytes: 45, graceFrames: 0 });
  assert.deepEqual(eviction.evicted, ['far']);
  assert.equal(eviction.residentCount, 1);
  assert.equal(eviction.residentBytes, 40);
  assert.equal(eviction.overBudget, false);
  assert.deepEqual(released, ['gpu:far']);
  await system.dispose();
});
