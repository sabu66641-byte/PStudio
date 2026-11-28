const test = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../static/pstudio_graphics_rendering_quality.mjs');
const atmosphere = require('../static/pstudio_graphics_atmosphere.mjs');
const water = require('../static/pstudio_graphics_water.mjs');
const rendering = require('../static/pstudio_graphics_rendering_systems.mjs');
const { createPStudioRenderGraph } = require('../static/pstudio_render_graph.mjs');

test('PBR reference BRDF remains finite, bounded and responds to material metalness', () => {
  const common = {
    baseColor: [0.8, 0.25, 0.1],
    normal: [0, 1, 0],
    viewDirection: [0, 1, 0],
    lightDirection: [0.2, 0.98, 0],
    radiance: [4, 3, 2],
    roughness: 0.32
  };
  const dielectric = quality.evaluatePStudioGGXReference({ ...common, metallic: 0 });
  const metal = quality.evaluatePStudioGGXReference({ ...common, metallic: 1 });
  assert.equal(dielectric.length, 3);
  assert.ok([...dielectric, ...metal].every(Number.isFinite));
  assert.ok(dielectric.every(value => value >= 0));
  assert.notDeepEqual(dielectric, metal);
  assert.ok(quality.PSTUDIO_GRAPHICS_QUALITY_WGSL.includes('pstudioQualityDistributionGGX'));
  assert.ok(quality.PSTUDIO_GRAPHICS_QUALITY_WGSL.includes('pstudioQualityPCF3x3'));
  assert.ok(quality.PSTUDIO_GRAPHICS_QUALITY_WGSL.includes('pstudioQualityIndirect'));
});

test('shadow cascade selection validates monotonic splits and selects the far cascade', () => {
  const splits = [12, 40, 110, 300];
  assert.equal(quality.selectPStudioShadowCascade(8, splits), 0);
  assert.equal(quality.selectPStudioShadowCascade(25, splits), 1);
  assert.equal(quality.selectPStudioShadowCascade(90, splits), 2);
  assert.equal(quality.selectPStudioShadowCascade(800, splits), 3);
  assert.throws(() => quality.selectPStudioShadowCascade(10, [10, 9, 30, 40]), /strictly increasing/);
});

test('ACES tone mapping preserves bounded output and monotonic response', () => {
  const low = quality.applyPStudioACESReference([0.1, 0.2, 0.3]);
  const high = quality.applyPStudioACESReference([2, 3, 4], 1.5);
  assert.ok(low.every(value => value >= 0 && value <= 1));
  assert.ok(high.every(value => value >= 0 && value <= 1));
  assert.ok(high[0] > low[0] && high[1] > low[1] && high[2] > low[2]);
  assert.equal(quality.packPStudioQualityMaterial({ metallic: 0.8, roughness: 0.2 }).length, 11);
});

test('atmosphere state normalizes celestial and wind directions and bounds weather inputs', () => {
  const state = atmosphere.normalizePStudioAtmosphereState({
    timeOfDay: 25, skySunX: 2, skySunY: 0, skySunZ: 0,
    moonDirectionX: 0, moonDirectionY: -4, moonDirectionZ: 0,
    cloudCoverage: 2, cloudDensity: -1, fogDensity: 2,
    windDirection: [0, 0], windSpeed: 40, rainIntensity: 2, wetness: -1
  });
  assert.equal(state.timeOfDay, 1);
  assert.deepEqual(state.sunDirection, [1, 0, 0]);
  assert.deepEqual(state.moonDirection, [0, -1, 0]);
  assert.deepEqual(state.windDirection, [1, 0]);
  assert.equal(state.cloudCoverage, 1);
  assert.equal(state.cloudDensity, 0);
  assert.equal(state.fogDensity, 0.08);
  assert.equal(state.windSpeed, 12);
  assert.equal(state.rainIntensity, 1);
  assert.equal(state.wetness, 0);
  const packed = atmosphere.packPStudioAtmosphereUniforms(state);
  assert.ok(packed instanceof Float32Array);
  assert.ok(packed.length >= 24);
  assert.ok(Array.from(packed).every(Number.isFinite));
});

test('atmosphere shader library contains Rayleigh, Mie, cloud drift and aerial perspective', () => {
  const source = atmosphere.PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL;
  for (const symbol of ['pstudioRayleighPhase', 'pstudioMiePhase', 'pstudioAtmosphereIntegrate',
    'pstudioAtmosphereCloudDensity', 'pstudioAtmosphereSunDisk', 'pstudioAtmosphereAerialPerspective']) {
    assert.ok(source.includes(symbol), 'missing ' + symbol);
  }
});

test('Beer-Lambert absorption is channel-specific and monotonic with water thickness', () => {
  const shallow = water.evaluatePStudioBeerLambert([1, 0.5, 0.1], 0.5);
  const deep = water.evaluatePStudioBeerLambert([1, 0.5, 0.1], 2);
  assert.ok(deep.every((value, index) => value < shallow[index]));
  assert.ok(deep[0] < deep[1] && deep[1] < deep[2]);
  assert.ok(water.evaluatePStudioBeerLambert([0, 0, 0], 100).every(value => value === 1));
});

test('water Fresnel strengthens at grazing angles and water optical composite stays finite', () => {
  const normal = water.evaluatePStudioWaterFresnel(1, 0.02);
  const grazing = water.evaluatePStudioWaterFresnel(0.08, 0.02);
  assert.ok(grazing > normal);
  const result = water.evaluatePStudioWaterOptics({
    absorption: [0.08, 0.035, 0.018], thickness: 8,
    cosViewAngle: 0.3, reflectionColor: [0.2, 0.4, 0.8],
    refractionColor: [0.4, 0.5, 0.6], scatteringColor: [0.01, 0.08, 0.12],
    foam: 0.2
  });
  assert.ok(result.color.every(Number.isFinite));
  assert.ok(result.transmittance[0] < result.transmittance[2]);
  assert.ok(result.fresnel > normal);
});

test('water waves use wind, multiple spatial scales, time and bounded rain input', () => {
  const base = { worldXZ: [3.5, 7.2], windDirection: [1, 0], waveAmplitude: 0.15, waveSpeed: 1.3 };
  const first = water.evaluatePStudioWaterWave({ ...base, timeSeconds: 0, rainIntensity: 0 });
  const later = water.evaluatePStudioWaterWave({ ...base, timeSeconds: 2, rainIntensity: 0.5 });
  const reversed = water.evaluatePStudioWaterWave({ ...base, windDirection: [-1, 0], timeSeconds: 2, rainIntensity: 0 });
  assert.ok(Number.isFinite(first) && Number.isFinite(later) && Number.isFinite(reversed));
  assert.notEqual(first, later);
  assert.notEqual(later, reversed);
  assert.equal(water.packPStudioWaterUniforms({ rainIntensity: 5 }).length, 16);
  assert.ok(water.PSTUDIO_GRAPHICS_WATER_WGSL.includes('pstudioWaterBeerLambert'));
  assert.ok(water.PSTUDIO_GRAPHICS_WATER_WGSL.includes('pstudioWaterFresnel'));
});

test('water Render Graph declares reflection, depth, refraction and final surface dependencies', () => {
  const graph = createPStudioRenderGraph();
  const setup = water.addPStudioWaterRenderPasses(graph, { prefix: 'test.mirror', width: 512, height: 512 });
  const plan = graph.compile();
  assert.deepEqual(plan.passOrder, setup.passIds);
  assert.equal(plan.passes.length, 4);
  assert.ok(plan.barrierCount >= 3);
  assert.equal(plan.passes[0].metadata.preservesPlanarMirror, true);
  assert.equal(plan.passes[3].metadata.absorption, 'beer-lambert');
  assert.equal(plan.resources.find(resource => resource.id === setup.ids.surface).lifetime, 'external');
  graph.dispose();
});

test('combined rendering source composes each independent shader library and stage entry points', () => {
  const descriptors = rendering.createPStudioRenderingShaderDescriptors({
    idPrefix: 'test.pipeline',
    vertexSource: '@vertex fn vsMain() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
    fragmentSource: '@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }'
  });
  assert.match(descriptors.vertex.source, /pstudioQualityDistributionGGX/);
  assert.match(descriptors.vertex.source, /pstudioAtmosphereIntegrate/);
  assert.match(descriptors.vertex.source, /pstudioWaterBeerLambert/);
  assert.match(descriptors.vertex.source, /@vertex fn vsMain/);
  assert.match(descriptors.fragment.source, /@fragment fn fsMain/);
});

test('rendering suite creates and updates persistent GPU uniform resources without replacing them', async () => {
  const records = new Map();
  let writes = 0;
  const core = {
    resources: {
      async createGPU(descriptor, config) {
        const record = { descriptor, data: new Float32Array(config.initialData), handle: { id: descriptor.id }, write(next) { this.data.set(next); writes++; } };
        records.set(descriptor.id, record);
        return record;
      },
      remove(id) { records.delete(id); return true; }
    }
  };
  const uniforms = await rendering.createPStudioRenderingUniformSet(core, { prefix: 'test.uniforms' });
  const materialHandle = uniforms.getBindings().material;
  const next = uniforms.update({
    material: { metallic: 0.8, roughness: 0.15 },
    atmosphere: { timeOfDay: 19, rainIntensity: 0.7 },
    water: { waveAmplitude: 0.2, rainIntensity: 0.7 }
  });
  assert.equal(next.material, materialHandle);
  assert.equal(writes, 3);
  assert.equal(records.size, 3);
  uniforms.dispose();
  assert.equal(records.size, 0);
});
