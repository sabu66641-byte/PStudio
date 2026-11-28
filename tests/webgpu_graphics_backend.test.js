const test = require('node:test');
const assert = require('node:assert/strict');
const { createPStudioWebGPUGraphicsBackend, createPStudioWebGPUCoreAdapter } = require('../static/pstudio_graphics_webgpu_backend.mjs');
const { createPStudioGraphicsResourceCore } = require('../static/pstudio_graphics_resource_core.mjs');
const { createPStudioGraphicsShaderCore } = require('../static/pstudio_graphics_shader_core.mjs');
const { createPStudioGraphicsComputeCore } = require('../static/pstudio_graphics_compute_core.mjs');
const { createPStudioGraphicsLightingCore } = require('../static/pstudio_graphics_lighting_core.mjs');
const { createPStudioRenderGraph } = require('../static/pstudio_render_graph.mjs');

function fakeDevice() {
  const calls = { buffers: [], textures: [], writes: [], submissions: [], encoders: 0, pipelines: 0, dispatches: 0, passes: 0, draws: 0 };
  const queue = {
    writeBuffer(buffer, offset, data, byteOffset = 0, byteLength = data.byteLength - byteOffset) { calls.writes.push({ buffer, offset, byteLength }); },
    submit(commands) { calls.submissions.push(commands); },
    async onSubmittedWorkDone() { return true; }
  };
  const device = {
    queue, limits: { maxTextureDimension2D: 8192 }, features: new Set(), lost: new Promise(() => {}),
    createBuffer(descriptor) { const value = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } }; calls.buffers.push(value); return value; },
    createTexture(descriptor) { const value = { ...descriptor, destroyed: false, createView() { return { texture: value }; }, destroy() { this.destroyed = true; } }; calls.textures.push(value); return value; },
    createSampler(descriptor) { return { descriptor }; },
    createShaderModule(descriptor) { return { ...descriptor, async getCompilationInfo() { return { messages: [] }; } }; },
    createComputePipeline(descriptor) { calls.pipelines++; return { descriptor, getBindGroupLayout(index) { return { index }; } }; },
    createRenderPipeline(descriptor) { calls.pipelines++; return { descriptor }; },
    createBindGroup(descriptor) { return { descriptor }; },
    createCommandEncoder(descriptor) {
      calls.encoders++;
      return {
        descriptor,
        beginComputePass() { calls.passes++; return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { calls.dispatches++; }, end() {} }; },
        beginRenderPass() { calls.passes++; return { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() { calls.draws++; }, end() {} }; },
        finish() { return { descriptor }; }
      };
    },
    destroy() { calls.deviceDestroyed = true; }
  };
  return { device, calls };
}

test('direct WebGPU backend creates, writes and destroys GPU-owned resources', async () => {
  const { device, calls } = fakeDevice();
  const runtime = createPStudioWebGPUGraphicsBackend({ device });
  await runtime.initialize();
  const core = createPStudioGraphicsResourceCore({ backend: runtime });
  const buffer = await core.createGPU({ id: 'mesh.vertices', type: 'buffer', estimatedBytes: 16, usage: ['vertex', 'copy-dst'] }, { initialData: new Float32Array([0, 1, 2, 3]) });
  assert.equal(buffer.handle.size, 16);
  assert.equal(calls.writes.length, 1);
  assert.equal(buffer.write(new Float32Array([4, 5, 6, 7])), true);
  assert.equal(calls.writes.length, 2);
  assert.equal(core.remove('mesh.vertices'), true);
  assert.equal(buffer.destroyed, true);
  assert.equal(runtime.stats().resourceCount, 0);
  core.dispose(); runtime.dispose();
});

test('direct WebGPU backend compiles WGSL, dispatches compute and uploads lighting buffers', async () => {
  const { device, calls } = fakeDevice();
  const runtime = createPStudioWebGPUGraphicsBackend({ device }); await runtime.initialize();
  const shaders = createPStudioGraphicsShaderCore({ compile: value => runtime.compileShader(value) });
  shaders.register({ id: 'particles.cs', stage: 'compute', language: 'wgsl', source: '@compute @workgroup_size(1) fn main() {}' });
  await shaders.compile('particles.cs', {}, { backend: 'webgpu' });
  await runtime.createComputePipeline('particles.cs');
  const compute = createPStudioGraphicsComputeCore({ executor: value => runtime.dispatchCompute(value) });
  compute.register({ id: 'particles', shaderId: 'particles.cs', workgroupSize: [1, 1, 1] });
  await compute.dispatch('particles', { groups: [2, 1, 1] });
  assert.equal(calls.dispatches, 1);
  const lighting = createPStudioGraphicsLightingCore({ uploadSnapshot: value => runtime.uploadLightingSnapshot(value) });
  lighting.set({ id: 'sun', type: 'directional', intensity: 2, direction: [0, -1, 0] });
  const uploaded = await lighting.upload();
  assert.equal(uploaded.lightCount, 1);
  assert.equal(calls.writes.length >= 2, true);
  compute.dispose(); shaders.dispose(); lighting.dispose(); runtime.dispose();
});

test('Render Graph records a real WebGPU command buffer and submits it once', async () => {
  const { device, calls } = fakeDevice();
  const runtime = createPStudioWebGPUGraphicsBackend({ device }); await runtime.initialize();
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'surface', type: 'surface', lifetime: 'external' });
  graph.addPass({ id: 'clear-surface', type: 'render', writes: [{ resource: 'surface', access: 'color-attachment' }], execute: ({ backend }) => {
    const pass = backend.getCommandEncoder().beginRenderPass({ colorAttachments: [] }); pass.end();
  } });
  const result = runtime.executeRenderGraph(graph.compile());
  assert.equal(result.success, true);
  assert.equal(calls.encoders, 1);
  assert.equal(calls.submissions.length, 1);
  graph.dispose(); runtime.dispose();
});

test('independent WebGPU core adapter does not require a Three.js scene session', async () => {
  const { device } = fakeDevice();
  const adapter = createPStudioWebGPUCoreAdapter({ device });
  assert.equal(adapter.descriptor.metadata.vendorNeutral, true);
  assert.equal(adapter.supports({}), true);
  const handle = await adapter.initialize({});
  assert.equal(handle.backend, 'webgpu');
  assert.equal(handle.getCapabilities().nativeWebGPU, true);
  handle.dispose();
});

test('clustered-light buffers upload stable offset and index arrays', async () => {
  const { device, calls } = fakeDevice();
  const runtime = createPStudioWebGPUGraphicsBackend({ device }); await runtime.initialize();
  const { createPStudioGraphicsClusteredLightingCore } = require('../static/pstudio_graphics_clustered_lighting_core.mjs');
  const clusters = createPStudioGraphicsClusteredLightingCore({ uploadSnapshot: value => runtime.uploadClusteredLightingSnapshot(value) });
  clusters.configure({ tilesX: 2, tilesY: 1, tilesZ: 1, maxLightsPerCluster: 4 });
  clusters.setAll([[0, 2], [1]]);
  const uploaded = await clusters.upload();
  assert.equal(uploaded.clusterCount, 2);
  assert.equal(uploaded.indexCount, 3);
  assert.equal(calls.writes.length, 2);
  assert.equal(uploaded.offsets.size >= 12, true);
  clusters.dispose(); runtime.dispose();
});

test('PBR WGSL lighting ABI matches the packed light and clustered-index layout', () => {
  const { PSTUDIO_PBR_LIGHTING_WGSL, createPStudioPBRLightingWGSL } = require('../static/pstudio_graphics_pbr_wgsl.mjs');
  assert.match(PSTUDIO_PBR_LIGHTING_WGSL, /pstudioLightRecords: array<vec4<f32>>/);
  assert.match(PSTUDIO_PBR_LIGHTING_WGSL, /pstudioLightLayerMasks: array<u32>/);
  assert.match(PSTUDIO_PBR_LIGHTING_WGSL, /pstudioClusterOffsets: array<u32>/);
  assert.match(PSTUDIO_PBR_LIGHTING_WGSL, /pstudioDistributionGGX/);
  assert.match(PSTUDIO_PBR_LIGHTING_WGSL, /pstudioFresnelSchlick/);
  assert.equal(createPStudioPBRLightingWGSL('fn customMaterial() {}').endsWith('fn customMaterial() {}'), true);
});

test('Graphics Core rehydrates GPU resources, shaders, pipelines and lighting on an explicit backend replacement', async () => {
  const first = fakeDevice(), second = fakeDevice();
  const runtimeA = createPStudioWebGPUGraphicsBackend({ device: first.device }); await runtimeA.initialize();
  const runtimeB = createPStudioWebGPUGraphicsBackend({ device: second.device });
  const hal = { async initialize() { return { state: 'ready', backend: 'webgpu' }; }, render() { return true; }, resize() { return true; }, dispose() { return true; }, getState() { return { state: 'ready', backend: 'webgpu' }; } };
  const { createPStudioGraphicsCore } = require('../static/pstudio_graphics_core.mjs');
  const core = createPStudioGraphicsCore({ hal, gpuRuntime: runtimeA });
  const original = await core.resources.createGPU({ id: 'recover.buffer', type: 'buffer', estimatedBytes: 16, usage: ['storage', 'copy-dst'] });
  const originalHandle = original.handle;
  core.shaders.register({ id: 'recover.compute', stage: 'compute', language: 'wgsl', source: '@compute @workgroup_size(1) fn main() {}' });
  core.shaders.register({ id: 'recover.vertex', stage: 'vertex', language: 'wgsl', source: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }' });
  core.shaders.register({ id: 'recover.fragment', stage: 'fragment', language: 'wgsl', source: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }' });
  await core.compileShader('recover.compute', { quality: 'high' }, { backend: 'webgpu', deviceKey: 'gpu-a' });
  await core.compileShader('recover.vertex', {}, { backend: 'webgpu', deviceKey: 'gpu-a' });
  await core.compileShader('recover.fragment', {}, { backend: 'webgpu', deviceKey: 'gpu-a' });
  await core.createComputePipeline('recover.compute');
  await core.createRenderPipeline('recover.render', { layout: 'auto', vertex: { shaderId: 'recover.vertex', entryPoint: 'main' }, fragment: { shaderId: 'recover.fragment', entryPoint: 'main', targets: [{ format: 'bgra8unorm' }] }, primitive: { topology: 'triangle-list' } });
  core.lighting.set({ id: 'sun', type: 'directional', direction: [0, -1, 0] });
  await core.lighting.upload();
  core.clusteredLighting.configure({ tilesX: 1, tilesY: 1, tilesZ: 1 });
  core.clusteredLighting.setCluster(0, [0]);
  await core.clusteredLighting.upload();
  const recovered = await core.recoverGPUBackend(runtimeB);
  assert.equal(recovered.success, true);
  assert.equal(recovered.resourceResult.restored, 1);
  assert.equal(recovered.shaderResult.compiled, 3);
  assert.equal(recovered.pipelineResult.computePipelinesRestored, 1);
  assert.equal(recovered.pipelineResult.renderPipelinesRestored, 1);
  assert.equal(recovered.lightingUploaded, true);
  assert.equal(recovered.clusteredLightingUploaded, true);
  assert.notEqual(core.resources.get('recover.buffer').handle, originalHandle);
  assert.equal(second.calls.pipelines, 2);
  assert.equal(second.calls.writes.length >= 4, true);
  core.dispose({ forceResources: true }); runtimeA.dispose(); runtimeB.dispose();
});


test('independent Graphics Core submits a materialized WebGPU render pass to its configured surface', async () => {
  const { device, calls } = fakeDevice();
  const surfaceTexture = { createView() { return { surfaceView: true }; } };
  const surfaceContext = { configure() {}, getCurrentTexture() { return surfaceTexture; }, unconfigure() {} };
  const canvas = { width: 64, height: 64, getContext(type) { return type === 'webgpu' ? surfaceContext : null; } };
  const runtime = createPStudioWebGPUGraphicsBackend({ device, canvas, context: surfaceContext, format: 'bgra8unorm' });
  const hal = {
    async initialize() { await runtime.initialize(); return { state: 'ready', backend: 'webgpu' }; },
    render(frame) { return runtime.render(frame); },
    resize(width, height, pixelRatio) { return runtime.resize(width, height, pixelRatio); },
    dispose() { return true; },
    getState() { return { state: 'ready', backend: 'webgpu' }; }
  };
  const { createPStudioGraphicsCore } = require('../static/pstudio_graphics_core.mjs');
  const core = createPStudioGraphicsCore({ hal, gpuRuntime: runtime });
  await core.renderer.initialize();
  core.shaders.register({ id: 'slice.vertex', stage: 'vertex', language: 'wgsl', source: '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.5), vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5)); return vec4<f32>(p[i], 0.0, 1.0); }' });
  core.shaders.register({ id: 'slice.fragment', stage: 'fragment', language: 'wgsl', source: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.2, 0.4, 0.8, 1.0); }' });
  await core.compileShader('slice.vertex', {}, { backend: 'webgpu' });
  await core.compileShader('slice.fragment', {}, { backend: 'webgpu' });
  const pipeline = await core.createRenderPipeline('slice.pipeline', { layout: 'auto', vertex: { shaderId: 'slice.vertex', entryPoint: 'vs' }, fragment: { shaderId: 'slice.fragment', entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] }, primitive: { topology: 'triangle-list' } });
  core.renderGraph.addResource({ id: 'surface', type: 'surface', lifetime: 'external' });
  core.renderGraph.addPass({ id: 'draw-triangle', type: 'render', writes: [{ resource: 'surface', access: 'color-attachment' }], execute: ({ backend, getResource }) => {
    const pass = backend.getCommandEncoder().beginRenderPass({ colorAttachments: [{ view: getResource('surface'), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    pass.draw(3, 1, 0, 0);
    pass.end();
  } });
  const plan = core.renderGraph.compile();
  const materialized = await core.renderGraph.materialize({ plan, backend: runtime, resources: { surface: runtime.getCurrentSurfaceView() } });
  const submitted = core.renderer.submit({ viewport: { width: 64, height: 64, pixelRatio: 1 }, metadata: { graphPlan: plan, resources: materialized.resources } });
  assert.equal(submitted.success, true);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.passes, 1);
  assert.equal(calls.draws, 1);
  await materialized.release();
  core.dispose(); runtime.dispose();
});
