import test from "node:test";
import assert from "node:assert/strict";
import {
  createPStudioRadianceCache,
  buildPStudioClusteredLightAssignments,
  createPStudioVfxParticleCore,
  integratePStudioVolumetricRay,
  resolvePStudioVolumetricHistory,
  buildPStudioVolumetricFroxelLayout,
  buildPStudioAdvancedRenderPasses,
  PSTUDIO_VFX_PARTICLE_COMPUTE_WGSL,
  PSTUDIO_VOLUMETRIC_WGSL,
  createPStudioRadianceCacheGpuBinding,
  createPStudioGpuParticleSystem,
  createPStudioVolumetricGpuSystem,
  PSTUDIO_VOLUMETRIC_COMPUTE_WGSL
} from "../static/pstudio_graphics_advanced.mjs";

test("radiance cache updates, trilinearly samples, invalidates and evaluates SH irradiance", () => {
  const cache = createPStudioRadianceCache({ dimensions: [2, 2, 2], origin: [0, 0, 0], spacing: [10, 10, 10] });
  assert.equal(cache.sampleSH([0, 0, 0]), null);
  const constant = new Float32Array(27);
  constant[0] = 1; constant[1] = 0.5; constant[2] = 0.25;
  for (let i = 0; i < 8; i++) cache.updateProbe(i, constant);
  const sample = cache.sampleSH([5, 5, 5]);
  assert.ok(sample && sample.confidence > 0.99);
  assert.ok(Math.abs(sample.coefficients[0] - 1) < 1e-6);
  const irradiance = cache.evaluateDiffuse(sample.coefficients, [0, 1, 0]);
  assert.ok(irradiance[0] > irradiance[1] && irradiance[1] > irradiance[2]);
  assert.equal(cache.invalidate({ min: [0, 0, 0], max: [0, 0, 0] }), 1);
  assert.equal(cache.stats().validProbes, 7);
  cache.dispose();
});

test("cluster builder creates deterministic logarithmic view-space ranges and rejects overflow", () => {
  const result = buildPStudioClusteredLightAssignments({
    tilesX: 4, tilesY: 3, tilesZ: 4, near: 0.1, far: 100, aspect: 1.5,
    lights: [{ id: "b", position: [0, 0, 8], radius: 4 }, { id: "a", position: [0, 0, 8], radius: 4 }]
  });
  assert.equal(result.layout.clusterCount, 48);
  assert.equal(result.clusterOffsets.length, 49);
  assert.equal(result.clusterLightIndices.length, result.indexCount);
  assert.ok(result.indexCount > 0);
  const leftFrustum = buildPStudioClusteredLightAssignments({
    tilesX: 2, tilesY: 1, tilesZ: 1, near: 1, far: 100, verticalFov: Math.PI / 2, aspect: 1,
    lights: [{ id: "far-left", position: [-75, 0, 75], radius: 2 }]
  });
  assert.deepEqual(leftFrustum.assignments[0], [0]);
  assert.deepEqual(leftFrustum.assignments[1], []);
  assert.throws(() => buildPStudioClusteredLightAssignments({
    tilesX: 4, tilesY: 4, tilesZ: 4, near: 0.1, far: 10, maxAssignmentTests: 2, lights: [{ id: "limit", position: [0, 0, 1], radius: 1 }]
  }), /maxAssignmentTests/);
  assert.throws(() => buildPStudioClusteredLightAssignments({
    tilesX: 1, tilesY: 1, tilesZ: 1, near: 0.1, far: 10, maxLightsPerCluster: 1,
    lights: [{ id: "a", position: [0, 0, 5], radius: 20 }, { id: "b", position: [0, 0, 5], radius: 20 }]
  }), /maxLightsPerCluster/);
});

test("fixed-step GPU VFX reference respects bounded capacity and lifetime", () => {
  const core = createPStudioVfxParticleCore({ maxParticles: 2, fixedStep: 1 / 60, gravity: [0, -9.8, 0] });
  assert.notEqual(core.spawn({ position: [0, 0, 0], velocity: [1, 2, 0], lifetime: 0.05 }), false);
  assert.notEqual(core.spawn({ position: [0, 1, 0], velocity: [0, 0, 0], lifetime: 0.05 }), false);
  assert.equal(core.spawn({}), false);
  const step = core.step(1 / 30);
  assert.equal(step.steps, 2);
  assert.equal(step.activeCount, 2);
  assert.equal(step.droppedParticles, 1);
  assert.equal(step.droppedTimeSeconds, 0);
  const snapshot = core.snapshot();
  assert.ok(snapshot.particles.some((value, index) => index % 8 === 3 && value > 0));
  const overflow = core.step(0.2);
  assert.equal(overflow.steps, 8);
  assert.ok(overflow.droppedTimeSeconds > 0.06);
  assert.equal(core.snapshot().alive.reduce((a, b) => a + b, 0), 0);
  core.dispose();
});

test("volumetric ray integration is front-to-back and energy bounded", () => {
  const result = integratePStudioVolumetricRay([{ density: 1, sigmaAbsorption: 0, sigmaScattering: 1, lighting: [1, 1, 1] }], { stepLength: 1, anisotropy: 0, cosTheta: 1 });
  assert.ok(Math.abs(result.transmittance - Math.exp(-1)) < 1e-6);
  assert.ok(result.opacity > 0 && result.opacity < 1);
  assert.ok(result.radiance.every(v => Number.isFinite(v) && v >= 0 && v < 1));
  assert.throws(() => integratePStudioVolumetricRay(new Array(513).fill({ density: 1 }), { maxSamples: 512 }), /maxSamples/);
});

test("temporal volumetric history rejects frame gaps, depth discontinuities and camera cuts", () => {
  const accepted = resolvePStudioVolumetricHistory({ current: [0.5, 0.5, 0.5], previous: [2, 0.2, 0.2], neighborhoodMin: [0, 0, 0], neighborhoodMax: [1, 1, 1], currentDepth: 2, previousDepth: 2.001, currentFrameId: 9, previousFrameId: 8, historyWeight: 0.8 });
  assert.equal(accepted.historyAccepted, true);
  assert.deepEqual(accepted.color, [0.9, 0.26, 0.26]);
  const rejected = resolvePStudioVolumetricHistory({ current: [1, 1, 1], previous: [0, 0, 0], currentDepth: 1, previousDepth: 4, currentFrameId: 10, previousFrameId: 8 });
  assert.equal(rejected.historyAccepted, false);
  assert.equal(rejected.historyWeight, 0);
});

test("froxel layout is bounded and advanced pass dependencies are explicit", () => {
  const layout = buildPStudioVolumetricFroxelLayout({ width: 1280, height: 720, tileSize: 8, depthSlices: 64 });
  assert.equal(layout.x, 160);
  assert.equal(layout.y, 90);
  assert.equal(layout.count, 160 * 90 * 64);
  assert.throws(() => buildPStudioVolumetricFroxelLayout({ width: 16384, height: 16384, tileSize: 4, depthSlices: 256, maxFroxels: 1000 }), /maxFroxels/);
  const passes = buildPStudioAdvancedRenderPasses();
  assert.deepEqual(passes.map(p => p.id), ["advanced.gi.probe-update", "advanced.vfx.simulation", "advanced.volumetric.injection", "advanced.volumetric.integrate", "advanced.composite"]);
  assert.ok(PSTUDIO_VFX_PARTICLE_COMPUTE_WGSL.includes("@compute"));
  assert.ok(PSTUDIO_VOLUMETRIC_WGSL.includes("pstudioHenyeyGreenstein"));
});


test("radiance cache GPU binding updates storage buffers and disposes", () => {
  const operations = [];
  const backend = {
    createResource(descriptor, config) { const resource = { id: descriptor.id, data: config.initialData }; operations.push(["create", resource.id]); return resource; },
    writeResource(resource, data) { assert.equal(data.byteLength, resource.data.byteLength); operations.push(["write", resource.id]); return true; },
    destroyResource(resource) { operations.push(["destroy", resource.id]); return true; }
  };
  const cache = createPStudioRadianceCache({ dimensions: [2, 2, 2] });
  const binding = createPStudioRadianceCacheGpuBinding(backend, cache);
  cache.updateProbe(0, new Float32Array(27).fill(0.25));
  assert.equal(binding.upload().probeCount, 8);
  assert.equal(binding.dispose(), true);
  assert.equal(operations.filter(x => x[0] === "write").length, 2);
  assert.equal(operations.filter(x => x[0] === "destroy").length, 2);
  cache.dispose();
});

test("GPU particle system creates compute pipeline and dispatches with storage/uniform bindings", async () => {
  const operations = [], resources = new Map();
  const pipeline = { getBindGroupLayout(index) { assert.equal(index, 0); return { index }; } };
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 64 },
    createBindGroup({ layout, entries }) { operations.push(["bind-group", layout.index, entries.length]); return { entries }; }
  };
  const backend = {
    device,
    async compileShader({ descriptor }) { assert.ok(descriptor.source.includes("@compute")); operations.push(["compile", descriptor.id]); return { dispose() { operations.push(["shader-dispose"]); } }; },
    async createComputePipeline(id) { operations.push(["pipeline", id]); return pipeline; },
    createResource(descriptor, config) { const r = { id: descriptor.id, handle: { size: descriptor.size }, data: config.initialData }; resources.set(r.id, r); operations.push(["create", r.id]); return r; },
    writeResource(resource, data) { resource.data = data; operations.push(["write", resource.id, data.byteLength]); return true; },
    dispatchCompute(args) { operations.push(["dispatch", args.groups, args.parameters.particleCount, args.resources.bindGroups.length]); return { dispatched: true, groups: args.groups }; },
    destroyResource(resource) { resources.delete(resource.id); operations.push(["destroy", resource.id]); return true; }
  };
  const system = createPStudioGpuParticleSystem(backend, { maxParticles: 1024 });
  await system.initialize();
  assert.equal(system.initialized, true);
  const result = system.dispatch({ deltaTime: 1 / 60, gravity: [0, -9.8, 0], particleCount: 1024 });
  assert.equal(result.dispatched, true);
  assert.equal(operations.find(x => x[0] === "dispatch")[1][0], 8);
  assert.equal(system.dispatch({ deltaTime: 0, particleCount: 0 }).dispatched, false);
  assert.equal(system.dispose(), true);
  assert.equal(resources.size, 0);
  assert.ok(operations.some(x => x[0] === "shader-dispose"));
});


test("volumetric GPU system packs rays, binds buffers and dispatches compute", async () => {
  const ops = [], resources = new Map();
  const pipeline = { getBindGroupLayout(index) { return { index }; } };
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 64 },
    createBindGroup({ layout, entries }) { ops.push(["bind", layout.index, entries.length]); return { entries }; }
  };
  const backend = {
    device,
    async compileShader({ descriptor }) { assert.ok(descriptor.source.includes("@compute")); assert.ok(descriptor.source.includes("integrateVolumeRays")); ops.push(["compile"]); return { dispose() { ops.push(["shader-dispose"]); } }; },
    async createComputePipeline(id) { ops.push(["pipeline", id]); return pipeline; },
    createResource(descriptor, config = {}) {
      const r = { id: descriptor.id, handle: { size: descriptor.size }, initialData: config.initialData };
      resources.set(r.id, r); ops.push(["create", r.id, descriptor.size]); return r;
    },
    writeResource(resource, data) { ops.push(["write", resource.id, data.byteLength]); return true; },
    dispatchCompute(args) { ops.push(["dispatch", args.groups[0], args.parameters.rayCount, args.parameters.sampleCount]); return { dispatched: true }; },
    destroyResource(resource) { resources.delete(resource.id); ops.push(["destroy", resource.id]); return true; }
  };
  const system = createPStudioVolumetricGpuSystem(backend, { maxRays: 128, maxSamplesPerRay: 16 });
  await system.initialize();
  const result = system.dispatch([
    [{ density: 1, sigmaScattering: 0.5, stepLength: 1, lighting: [1, 0.8, 0.6] }, { density: 0.5, sigmaAbsorption: 0.2, sigmaScattering: 0.2, stepLength: 2 }],
    [{ density: 0.25, sigmaScattering: 0.1, stepLength: 0.5 }, { density: 0.1, sigmaAbsorption: 0.2, stepLength: 0.25 }]
  ]);
  assert.equal(result.dispatched, true);
  assert.equal(result.rayCount, 2);
  assert.equal(result.sampleCount, 2);
  assert.equal(ops.find(x => x[0] === "dispatch")[1], 1);
  assert.throws(() => system.dispatch([[{ density: 1 }], [{ density: 1 }, { density: 1 }]]), /same/);
  assert.equal(system.dispose(), true);
  assert.equal(resources.size, 0);
  assert.ok(ops.some(x => x[0] === "shader-dispose"));
  assert.ok(PSTUDIO_VOLUMETRIC_COMPUTE_WGSL.includes("results[ray].radiance"));
});
