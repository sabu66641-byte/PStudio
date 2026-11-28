const test = require('node:test');
const assert = require('node:assert/strict');
let {
  createPStudioGpuVFXSystem, PSTUDIO_GPU_VFX_WGSL, createPStudioGraphicsGiCore,
  buildPStudioGraphicsClusterAssignments, createPStudioFroxelGrid,
  evaluatePStudioHenyeyGreenstein, evaluatePStudioVolumetricSegment,
  integratePStudioVolumetricSegments, blendPStudioVolumetricHistory, PSTUDIO_VOLUMETRIC_WGSL
} = {};
test.before(async () => {
  ({
    createPStudioGpuVFXSystem, PSTUDIO_GPU_VFX_WGSL, createPStudioGraphicsGiCore,
    buildPStudioGraphicsClusterAssignments, createPStudioFroxelGrid,
    evaluatePStudioHenyeyGreenstein, evaluatePStudioVolumetricSegment,
    integratePStudioVolumetricSegments, blendPStudioVolumetricHistory, PSTUDIO_VOLUMETRIC_WGSL
  } = await import('../static/pstudio_graphics_advanced_core.mjs'));
});

test('GPU VFX emits a bounded deterministic dispatch packet through the injected compute executor', async () => {
  const packets = [];
  const system = createPStudioGpuVFXSystem({
    capacity: 100, maxSpawnPerFrame: 10,
    executor: { async dispatchVFX(packet) { packets.push(packet); return { submitted: true }; } }
  });
  system.registerEmitter({ id: 'sparks', ratePerSecond: 20, lifetimeSeconds: 1, burst: 5, position: [1, 2, 3] });
  const first = await system.simulate({ deltaSeconds: 0.25, timeSeconds: 1 });
  assert.equal(first.requestedSpawnCount, 10);
  assert.equal(first.spawnCount, 10);
  assert.equal(first.workgroupSize, 64);
  assert.equal(first.workgroupCount, 2);
  assert.equal(first.result.submitted, true);
  assert.match(first.shader, /@compute @workgroup_size\(64\)/);
  const second = await system.simulate({ deltaSeconds: 0.25, availableParticleSlots: 4 });
  assert.equal(second.requestedSpawnCount, 5);
  assert.equal(second.spawnCount, 4);
  assert.equal(second.droppedSpawnCount, 1);
  assert.equal(system.stats().totalSpawned, 14);
  assert.equal(system.stats().totalDropped, 1);
  assert.equal(packets.length, 2);
  system.dispose();
  assert.throws(() => system.registerEmitter({ id: 'late' }), /disposed/);
});

test('GPU VFX refuses overlapping dispatches and always releases its in-flight guard', async () => {
  let release;
  const system = createPStudioGpuVFXSystem({ capacity: 64, executor: { dispatchVFX: () => new Promise(resolve => { release = resolve; }) } });
  system.registerEmitter({ id: 'mist', ratePerSecond: 1 });
  const pending = system.simulate({ deltaSeconds: 0.1 });
  await Promise.resolve();
  await assert.rejects(system.simulate({ deltaSeconds: 0.1 }), /in flight/);
  release({ ok: true });
  await pending;
  assert.equal(system.stats().inFlight, false);
});

test('GI probes blend temporally, invalidate spatially and produce stable weighted SH samples', () => {
  const gi = createPStudioGraphicsGiCore({ halfLifeMs: 100 });
  const a = new Float32Array(27).fill(2);
  const b = new Float32Array(27).fill(4);
  gi.setProbe({ id: 'a', position: [0, 0, 0], coefficients: a });
  gi.setProbe({ id: 'b', position: [10, 0, 0], coefficients: b });
  const sample = gi.sample([1, 0, 0], { maxProbes: 2, maxDistance: 20 });
  assert.deepEqual(sample.probeIds, ['a', 'b']);
  assert.ok(sample.coefficients[0] > 2 && sample.coefficients[0] < 3);
  const updated = gi.updateProbe('a', new Float32Array(27).fill(6), 100);
  assert.ok(Math.abs(updated.alpha - 0.5) < 1e-6);
  assert.ok(Math.abs(gi.snapshot().probes[0].coefficients[0] - 4) < 1e-5);
  assert.equal(gi.invalidateSphere([0, 0, 0], 2), 1);
  assert.deepEqual(gi.snapshot().dirtyProbeIds, ['a']);
  assert.equal(gi.removeProbe('b'), true);
  assert.equal(gi.stats().probeCount, 1);
  gi.dispose();
  assert.throws(() => gi.snapshot(), /disposed/);
});

test('cluster builder projects view-space light spheres into logarithmic depth clusters without dropping overflow', () => {
  const result = buildPStudioGraphicsClusterAssignments({
    tilesX: 8, tilesY: 4, tilesZ: 8, near: 0.1, far: 100,
    fovYRadians: Math.PI / 2, aspect: 2, maxLightsPerCluster: 8,
    lights: [
      { index: 7, positionView: [0, 0, -10], radius: 2 },
      { index: 9, positionView: [2, 0, -20], radius: 1 },
      { index: 11, positionView: [10000, 0, -10], radius: 1 }
    ]
  });
  assert.ok(result.populatedClusterCount > 0);
  assert.ok(result.indexCount > 0);
  assert.ok(result.clusterOffsets[0] === 0);
  assert.equal(result.clusterOffsets.at(-1), result.indexCount);
  assert.ok(Array.from(result.clusterLightIndices).every(index => index === 7 || index === 9));
  for (let i = 1; i < result.clusterOffsets.length; i++) assert.ok(result.clusterOffsets[i] >= result.clusterOffsets[i - 1]);
});

test('cluster builder rejects per-cluster overflow instead of silently truncating light references', () => {
  const lights = Array.from({ length: 4 }, (_, index) => ({ index, positionView: [0, 0, -10], radius: 8 }));
  assert.throws(() => buildPStudioGraphicsClusterAssignments({
    tilesX: 1, tilesY: 1, tilesZ: 1, near: 0.1, far: 100,
    maxLightsPerCluster: 2, lights
  }), /no light is dropped/);
});

test('froxel memory budget is explicit and rejects oversized grids', () => {
  const grid = createPStudioFroxelGrid({ width: 32, height: 18, depth: 16, bytesPerFroxel: 16, budgetBytes: 1_000_000 });
  assert.equal(grid.count, 9216);
  assert.equal(grid.estimatedBytes, 147456);
  assert.throws(() => createPStudioFroxelGrid({ width: 128, height: 128, depth: 128, budgetBytes: 1024 }), /memory budget/);
});

test('Henyey–Greenstein phase responds to anisotropy while remaining finite and positive', () => {
  const isotropic = evaluatePStudioHenyeyGreenstein(0, 0);
  const forward = evaluatePStudioHenyeyGreenstein(1, 0.7);
  const backward = evaluatePStudioHenyeyGreenstein(-1, 0.7);
  assert.ok(forward > isotropic);
  assert.ok(backward < isotropic);
  assert.ok([isotropic, forward, backward].every(value => Number.isFinite(value) && value > 0));
});

test('volumetric Beer–Lambert absorption and front-to-back radiance integration are monotonic', () => {
  const thin = evaluatePStudioVolumetricSegment({ density: 0.1, distance: 1, incidentRadiance: [1, 0.8, 0.6] });
  const dense = evaluatePStudioVolumetricSegment({ density: 0.5, distance: 1, incidentRadiance: [1, 0.8, 0.6] });
  assert.ok(dense.transmittance < thin.transmittance);
  assert.ok(dense.radiance.every(Number.isFinite));
  const integrated = integratePStudioVolumetricSegments([
    { density: 0.1, distance: 2, incidentRadiance: [1, 0.5, 0.25] },
    { density: 0.3, distance: 4, incidentRadiance: [0.2, 0.5, 1] }
  ]);
  assert.ok(integrated.opacity > 0 && integrated.opacity < 1);
  assert.ok(integrated.radiance.every(Number.isFinite));
});

test('volumetric temporal history is confidence weighted and WGSL library exposes shared equations', () => {
  const blend = blendPStudioVolumetricHistory(new Float32Array([1, 2]), new Float32Array([3, 4]), 0.5, 0.5);
  assert.deepEqual(blend.values, new Float32Array([1.5, 2.5]));
  assert.equal(blend.historyWeight, 0.25);
  assert.match(PSTUDIO_VOLUMETRIC_WGSL, /pstudioBeerLambert/);
  assert.match(PSTUDIO_VOLUMETRIC_WGSL, /pstudioHG/);
});
