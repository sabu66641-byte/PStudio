import { PStudioGraphicsError } from './pstudio_graphics_contract.mjs';

const BUFFER_USAGE = Object.freeze({ map_read:1, map_write:2, copy_src:4, copy_dst:8, index:16, vertex:32, uniform:64, storage:128, indirect:256, query_resolve:512 });
const TEXTURE_USAGE = Object.freeze({ copy_src:1, copy_dst:2, texture_binding:4, storage_binding:8, render_attachment:16 });
const align4 = value => Math.max(4, Math.ceil(Number(value) / 4) * 4);
const asBytes = value => value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value == null ? null : new Uint8Array(value);
const usageMask = (names, constants, fallback) => names.reduce((mask, name) => {
  const key = String(name).toLowerCase().replace(/-/g, '_');
  const value = constants?.[key.toUpperCase()] ?? constants?.[key] ?? fallback[key];
  if (!Number.isFinite(Number(value))) throw new TypeError('Unsupported WebGPU resource usage: ' + name);
  return mask | Number(value);
}, 0);

/**
 * Direct browser WebGPU backend for PStudio Graphics Core. It does not import or wrap
 * Three.js, and it is opt-in: callers must provide a dedicated canvas/device explicitly.
 */
export function createPStudioWebGPUGraphicsBackend(options = {}) {
  const gpu = options.gpu || options.navigatorRef?.gpu || globalThis.navigator?.gpu || null;
  let adapter = options.adapter || null;
  let device = options.device || null;
  let context = options.context || null;
  let canvas = options.canvas || null;
  let format = options.format || null;
  let configured = false;
  let disposed = false;
  let lost = false;
  let commandEncoder = null;
  let activePass = null;
  let graphStats = { submissions: 0, barriers: 0, passes: 0 };
  const resources = new Map();
  const shaderModules = new Map();
  const computePipelines = new Map();
  const renderPipelines = new Map();
  const computePipelineDescriptors = new Map();
  const renderPipelineDescriptors = new Map();
  let lightingBuffers = null;
  let clusteredBuffers = null;
  let deviceLostResolve;
  const deviceLost = new Promise(resolve => { deviceLostResolve = resolve; });

  function assertDevice() {
    if (disposed) throw new PStudioGraphicsError('WebGPU graphics backend is disposed.', { code: 'PSTUDIO_WEBGPU_BACKEND_DISPOSED' });
    if (lost || !device) throw new PStudioGraphicsError('WebGPU device is unavailable or lost.', { code: 'PSTUDIO_WEBGPU_DEVICE_LOST' });
  }
  function reportLoss(info = {}) {
    if (lost || disposed) return;
    lost = true;
    configured = false;
    commandEncoder = null;
    activePass = null;
    const detail = Object.freeze({ reason: String(info.reason || 'unknown'), message: String(info.message || 'WebGPU device was lost.') });
    deviceLostResolve(detail);
    try { options.onDeviceLost?.(detail); } catch (_) {}
  }
  function resolveBufferUsage(names) {
    const constants = options.GPUBufferUsage || globalThis.GPUBufferUsage || null;
    return names?.length ? usageMask(names, constants, BUFFER_USAGE) : (constants?.STORAGE ?? BUFFER_USAGE.storage) | (constants?.COPY_DST ?? BUFFER_USAGE.copy_dst);
  }
  function resolveTextureUsage(names) {
    const constants = options.GPUTextureUsage || globalThis.GPUTextureUsage || null;
    return names?.length ? usageMask(names, constants, TEXTURE_USAGE) : (constants?.TEXTURE_BINDING ?? TEXTURE_USAGE.texture_binding) | (constants?.COPY_DST ?? TEXTURE_USAGE.copy_dst) | (constants?.RENDER_ATTACHMENT ?? TEXTURE_USAGE.render_attachment);
  }
  async function initialize(contextOptions = {}) {
    if (disposed) throw new PStudioGraphicsError('WebGPU graphics backend is disposed.', { code: 'PSTUDIO_WEBGPU_BACKEND_DISPOSED' });
    canvas = options.canvas || contextOptions.canvas || canvas;
    if (!device || lost) {
      if (!gpu?.requestAdapter) throw new PStudioGraphicsError('WebGPU is not available in this runtime.', { code: 'PSTUDIO_WEBGPU_UNAVAILABLE' });
      adapter = adapter || await gpu.requestAdapter({ powerPreference: options.powerPreference || 'high-performance' });
      if (!adapter) throw new PStudioGraphicsError('No WebGPU adapter is available.', { code: 'PSTUDIO_WEBGPU_ADAPTER_UNAVAILABLE' });
      const requiredFeatures = [...new Set(contextOptions.requiredFeatures || options.requiredFeatures || [])].filter(feature => adapter.features?.has?.(feature));
      device = await adapter.requestDevice({ requiredFeatures, requiredLimits: options.requiredLimits || {} });
    }
    if (!context && canvas?.getContext) context = canvas.getContext('webgpu');
    if (canvas && !context) throw new PStudioGraphicsError('The supplied canvas could not create a WebGPU context.', { code: 'PSTUDIO_WEBGPU_CONTEXT_UNAVAILABLE' });
    if (context && !configured) {
      format = format || gpu?.getPreferredCanvasFormat?.() || options.preferredFormat || 'bgra8unorm';
      context.configure({ device, format, usage: resolveTextureUsage(['render-attachment']), alphaMode: options.alphaMode || 'opaque', colorSpace: options.colorSpace || 'srgb' });
      configured = true;
    }
    lost = false;
    if (device.lost?.then) device.lost.then(info => reportLoss(info || {})).catch(error => reportLoss({ reason: 'unknown', message: error?.message }));
    return Object.freeze({ backend: 'webgpu', state: 'ready', device, adapter, format, features: Object.freeze([...(adapter?.features || [])].map(String).sort()) });
  }
  function createResource(descriptor, config = {}) {
    assertDevice();
    const id = String(descriptor?.id || '').trim();
    if (!id) throw new TypeError('GPU resource id is required.');
    if (resources.has(id)) throw new PStudioGraphicsError('GPU resource already exists: ' + id, { code: 'PSTUDIO_WEBGPU_RESOURCE_DUPLICATE' });
    const type = String(descriptor.type || '').toLowerCase();
    let handle;
    if (type === 'buffer') {
      const bytes = asBytes(config.initialData);
      if (bytes?.byteLength && bytes.byteLength % 4) throw new RangeError('WebGPU initial buffer data must be 4-byte aligned.');
      const size = align4(Math.max(Number(descriptor.size) || 0, Number(descriptor.estimatedBytes) || 0, bytes?.byteLength || 0, 4));
      handle = device.createBuffer({ label: id, size, usage: resolveBufferUsage(descriptor.usage), mappedAtCreation: false });
      if (bytes?.byteLength) device.queue.writeBuffer(handle, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else if (type === 'texture' || type === 'render-target') {
      const width = Math.max(1, Math.floor(descriptor.width || 1));
      const height = Math.max(1, Math.floor(descriptor.height || 1));
      const depthOrArrayLayers = Math.max(1, Math.floor(descriptor.depth || 1));
      handle = device.createTexture({ label: id, size: { width, height, depthOrArrayLayers }, format: descriptor.format || 'rgba8unorm', usage: resolveTextureUsage(descriptor.usage), sampleCount: Math.max(1, Math.floor(descriptor.samples || 1)) });
    } else if (type === 'sampler') {
      handle = device.createSampler(config.sampler || descriptor.metadata?.sampler || {});
    } else {
      throw new TypeError('Unsupported WebGPU resource type: ' + type);
    }
    const record = { id, type, descriptor, handle, view: null, destroyed: false };
    resources.set(id, record);
    return Object.freeze({ id, type, get handle() { return record.handle; }, get view() { if (type !== 'texture' && type !== 'render-target') return null; return record.view || (record.view = record.handle?.createView?.() || null); }, get destroyed() { return record.destroyed; }, dispose: () => destroyResource(record) });
  }
  function destroyResource(resourceOrHandle) {
    const record = typeof resourceOrHandle === 'string' ? resources.get(resourceOrHandle) : [...resources.values()].find(item => item === resourceOrHandle || item.handle === resourceOrHandle || resourceOrHandle?.id === item.id);
    if (!record || record.destroyed) return false;
    record.destroyed = true;
    try { record.handle?.destroy?.(); } catch (_) {}
    resources.delete(record.id);
    return true;
  }
  function writeResource(resource, data, offset = 0) {
    assertDevice();
    const record = typeof resource === 'string' ? resources.get(resource) : [...resources.values()].find(item => item === resource || item.handle === resource || resource?.id === item.id);
    if (!record || record.type !== 'buffer' || record.destroyed) throw new TypeError('A live WebGPU buffer resource is required.');
    const bytes = asBytes(data);
    if (!bytes || bytes.byteLength === 0) return false;
    if (offset < 0 || !Number.isSafeInteger(offset) || offset % 4 || bytes.byteLength % 4) throw new RangeError('WebGPU buffer writes require 4-byte aligned offsets and lengths.');
    if (record.handle?.size != null && offset + bytes.byteLength > record.handle.size) throw new RangeError('WebGPU buffer write exceeds the allocated resource size.');
    device.queue.writeBuffer(record.handle, offset, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return true;
  }
  async function recreateResource(descriptor, prior = null, config = {}) {
    const existing = resources.get(descriptor.id);
    if (existing) destroyResource(existing);
    return createResource(descriptor, config);
  }
  async function compileShader({ descriptor }) {
    assertDevice();
    if (String(descriptor.language).toLowerCase() !== 'wgsl') throw new PStudioGraphicsError('The direct WebGPU backend compiles WGSL only.', { code: 'PSTUDIO_WEBGPU_SHADER_LANGUAGE_UNSUPPORTED', details: { language: descriptor.language } });
    const module = device.createShaderModule({ label: descriptor.id, code: descriptor.source });
    if (typeof module.getCompilationInfo === 'function') {
      const info = await module.getCompilationInfo();
      const errors = (info.messages || []).filter(message => message.type === 'error');
      if (errors.length) throw new PStudioGraphicsError('WGSL compilation failed: ' + errors.map(item => item.message).join('\n'), { code: 'PSTUDIO_WEBGPU_WGSL_COMPILE_FAILED', details: { shaderId: descriptor.id, errors } });
    }
    const record = { descriptor, module, disposed: false };
    shaderModules.set(descriptor.id, record);
    return Object.freeze({ id: descriptor.id, module, dispose() { if (record.disposed) return false; record.disposed = true; if (shaderModules.get(descriptor.id) === record) shaderModules.delete(descriptor.id); return true; } });
  }
  async function createComputePipeline(id, descriptor = {}) {
    assertDevice();
    const shader = shaderModules.get(String(id));
    if (!shader) throw new PStudioGraphicsError('Compute shader has not been compiled: ' + id, { code: 'PSTUDIO_WEBGPU_SHADER_NOT_COMPILED' });
    const layout = descriptor.layout || 'auto';
    const pipeline = await (device.createComputePipelineAsync ? device.createComputePipelineAsync({ label: descriptor.label || id, layout, compute: { module: shader.module, entryPoint: descriptor.entryPoint || shader.descriptor.entryPoint || 'main', constants: descriptor.constants || {} } }) : Promise.resolve(device.createComputePipeline({ label: descriptor.label || id, layout, compute: { module: shader.module, entryPoint: descriptor.entryPoint || shader.descriptor.entryPoint || 'main', constants: descriptor.constants || {} } })));
    computePipelines.set(String(id), pipeline);
    computePipelineDescriptors.set(String(id), { ...descriptor });
    return pipeline;
  }
  async function createRenderPipeline(id, descriptor = {}) {
    assertDevice();
    const vertex = descriptor.vertex || {};
    const fragment = descriptor.fragment || null;
    const vertexRecord = vertex.shaderId ? shaderModules.get(String(vertex.shaderId)) : null;
    const fragmentRecord = fragment?.shaderId ? shaderModules.get(String(fragment.shaderId)) : null;
    const { shaderId: vertexShaderId, ...vertexState } = vertex;
    const normalized = { ...descriptor, vertex: { ...vertexState, ...(vertexRecord ? { module: vertexRecord.module } : {}) } };
    if (!normalized.vertex.module) throw new TypeError('Render pipeline requires a compiled vertex shader module.');
    if (fragment) {
      const { shaderId: fragmentShaderId, ...fragmentState } = fragment;
      normalized.fragment = { ...fragmentState, ...(fragmentRecord ? { module: fragmentRecord.module } : {}) };
      if (!normalized.fragment.module) throw new TypeError('Render pipeline fragment state requires a compiled shader module.');
    } else delete normalized.fragment;
    const pipeline = await (device.createRenderPipelineAsync ? device.createRenderPipelineAsync(normalized) : Promise.resolve(device.createRenderPipeline(normalized)));
    renderPipelines.set(String(id), pipeline);
    renderPipelineDescriptors.set(String(id), { ...descriptor, vertex: { ...vertex }, ...(fragment ? { fragment: { ...fragment } } : {}) });
    return pipeline;
  }
  function dispatchCompute({ kernel, groups, resources: bindings = {}, parameters = {} }) {
    assertDevice();
    const id = String(kernel.shaderId || kernel.id);
    const pipeline = bindings.pipeline || computePipelines.get(id);
    if (!pipeline) throw new PStudioGraphicsError('Compute pipeline has not been created: ' + id, { code: 'PSTUDIO_WEBGPU_COMPUTE_PIPELINE_MISSING' });
    const encoder = commandEncoder || device.createCommandEncoder({ label: 'PStudio Compute: ' + kernel.id });
    const pass = encoder.beginComputePass({ label: kernel.id });
    pass.setPipeline(pipeline);
    const bindGroups = bindings.bindGroups || [];
    bindGroups.forEach((group, index) => pass.setBindGroup(index, group));
    if (bindings.entries && !bindGroups.length) {
      const groupIndex = Math.max(0, Math.floor(Number(bindings.groupIndex) || 0));
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries: bindings.entries });
      pass.setBindGroup(groupIndex, group);
    }
    pass.dispatchWorkgroups(groups[0], groups[1], groups[2]);
    pass.end();
    if (!commandEncoder) { device.queue.submit([encoder.finish()]); graphStats.submissions += 1; }
    return Object.freeze({ dispatched: true, groups: Object.freeze([...groups]), parameters: Object.freeze({ ...parameters }) });
  }
  function uploadLightingSnapshot(snapshot) {
    assertDevice();
    const packed = snapshot?.packed instanceof Float32Array ? snapshot.packed : new Float32Array();
    const masks = snapshot?.layerMasks instanceof Uint32Array ? snapshot.layerMasks : new Uint32Array();
    const usageConstants = options.GPUBufferUsage || globalThis.GPUBufferUsage || null;
    const storage = (usageConstants?.STORAGE ?? BUFFER_USAGE.storage) | (usageConstants?.COPY_DST ?? BUFFER_USAGE.copy_dst);
    const create = (label, bytes) => device.createBuffer({ label, size: align4(Math.max(4, bytes)), usage: storage, mappedAtCreation: false });
    if (!lightingBuffers || lightingBuffers.packed.size < align4(Math.max(4, packed.byteLength)) || lightingBuffers.masks.size < align4(Math.max(4, masks.byteLength))) {
      try { lightingBuffers?.packed.destroy?.(); lightingBuffers?.masks.destroy?.(); } catch (_) {}
      lightingBuffers = { packed: create('PStudio Lighting Records', packed.byteLength), masks: create('PStudio Lighting Layer Masks', masks.byteLength), revision: -1 };
    }
    if (packed.byteLength) device.queue.writeBuffer(lightingBuffers.packed, 0, packed.buffer, packed.byteOffset, packed.byteLength);
    if (masks.byteLength) device.queue.writeBuffer(lightingBuffers.masks, 0, masks.buffer, masks.byteOffset, masks.byteLength);
    lightingBuffers.revision = Number(snapshot.revision) || 0;
    return Object.freeze({ packed: lightingBuffers.packed, masks: lightingBuffers.masks, revision: lightingBuffers.revision, lightCount: snapshot.lightCount || 0, stride: snapshot.stride || 16 });
  }
  function uploadClusteredLightingSnapshot(snapshot) {
    assertDevice();
    const offsets = snapshot?.clusterOffsets instanceof Uint32Array ? snapshot.clusterOffsets : new Uint32Array([0]);
    const indices = snapshot?.clusterLightIndices instanceof Uint32Array ? snapshot.clusterLightIndices : new Uint32Array();
    const usageConstants = options.GPUBufferUsage || globalThis.GPUBufferUsage || null;
    const usage = (usageConstants?.STORAGE ?? BUFFER_USAGE.storage) | (usageConstants?.COPY_DST ?? BUFFER_USAGE.copy_dst);
    const requiredOffsets = align4(Math.max(4, offsets.byteLength));
    const requiredIndices = align4(Math.max(4, indices.byteLength));
    if (!clusteredBuffers || clusteredBuffers.offsets.size < requiredOffsets || clusteredBuffers.indices.size < requiredIndices) {
      try { clusteredBuffers?.offsets.destroy?.(); clusteredBuffers?.indices.destroy?.(); } catch (_) {}
      clusteredBuffers = {
        offsets: device.createBuffer({ label: 'PStudio Cluster Offsets', size: requiredOffsets, usage, mappedAtCreation: false }),
        indices: device.createBuffer({ label: 'PStudio Cluster Light Indices', size: requiredIndices, usage, mappedAtCreation: false }),
        revision: -1
      };
    }
    if (offsets.byteLength) device.queue.writeBuffer(clusteredBuffers.offsets, 0, offsets.buffer, offsets.byteOffset, offsets.byteLength);
    if (indices.byteLength) device.queue.writeBuffer(clusteredBuffers.indices, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    clusteredBuffers.revision = Number(snapshot?.revision) || 0;
    return Object.freeze({ offsets: clusteredBuffers.offsets, indices: clusteredBuffers.indices, revision: clusteredBuffers.revision, clusterCount: snapshot?.layout?.clusterCount || 0, indexCount: snapshot?.indexCount || 0 });
  }

  function beginGraph(plan) {
    assertDevice();
    if (commandEncoder) throw new PStudioGraphicsError('A WebGPU Render Graph is already recording.', { code: 'PSTUDIO_WEBGPU_GRAPH_BUSY' });
    commandEncoder = device.createCommandEncoder({ label: 'PStudio Render Graph r' + plan.revision });
    graphStats.passes = 0;
  }
  function barrier(barrierInfo) {
    // WebGPU performs resource transitions through ordered command/pass usage validation;
    // there is no user-authored global memory-barrier command in the WebGPU API.
    graphStats.barriers += 1;
    return Object.freeze({ ...barrierInfo, backendManaged: true });
  }
  function beginPass(pass) {
    if (!commandEncoder) throw new PStudioGraphicsError('Render Graph pass began without an active command encoder.', { code: 'PSTUDIO_WEBGPU_GRAPH_NOT_RECORDING' });
    graphStats.passes += 1;
    return pass;
  }
  function endPass() { activePass = null; }
  function endGraph() {
    if (!commandEncoder) return false;
    const finished = commandEncoder.finish();
    commandEncoder = null;
    device.queue.submit([finished]);
    graphStats.submissions += 1;
    return true;
  }
  function abortGraph() { commandEncoder = null; activePass = null; return true; }
  function executeRenderGraph(plan, executionOptions = {}) {
    if (plan?.kind !== 'pstudio-render-graph-plan') throw new TypeError('A compiled PStudio Render Graph plan is required.');
    const signal = executionOptions.signal || null;
    beginGraph(plan);
    const handleMap = executionOptions.resources || {};
    const getResource = id => handleMap[id] ?? resources.get(id)?.handle ?? null;
    try {
      for (const pass of plan.passes) {
        if (signal?.aborted) throw new PStudioGraphicsError('WebGPU Render Graph execution was cancelled.', { code: 'PSTUDIO_RENDER_GRAPH_CANCELLED' });
        for (const info of plan.barriers.filter(item => item.beforePass === pass.id)) barrier(info);
        beginPass(pass);
        const result = pass.execute(Object.freeze({ graph: plan, pass, frame: executionOptions.frame || null, backend: api, commandEncoder, device, getResource, resources: Object.freeze(Object.fromEntries([...pass.reads, ...pass.writes].map(use => [use.resource, getResource(use.resource)]))) }));
        if (result && typeof result.then === 'function') throw new PStudioGraphicsError('WebGPU command recording callbacks must be synchronous.', { code: 'PSTUDIO_WEBGPU_ASYNC_PASS_CALLBACK', details: { pass: pass.id } });
        endPass(pass);
      }
      endGraph(plan);
      return Object.freeze({ success: true, passCount: plan.passes.length, barrierCount: plan.barrierCount, submissions: graphStats.submissions });
    } catch (error) { abortGraph(); throw error; }
  }
  function render(frame) {
    assertDevice();
    const graphPlan = frame?.graphPlan || frame?.metadata?.graphPlan || null;
    if (graphPlan) return executeRenderGraph(graphPlan, { frame, resources: frame.resources || frame.metadata?.resources, signal: frame.signal || frame.metadata?.signal });
    if (typeof options.renderFrame === 'function') return options.renderFrame(frame, api) !== false;
    return false;
  }
  function resize(width, height, pixelRatio = 1) {
    if (disposed || !canvas) return false;
    const w = Math.max(1, Math.floor(Number(width) * Number(pixelRatio || 1)));
    const h = Math.max(1, Math.floor(Number(height) * Number(pixelRatio || 1)));
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h)) throw new TypeError('WebGPU surface dimensions must be finite positive numbers.');
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return true;
  }
  function getCurrentSurfaceTexture() {
    assertDevice();
    if (!configured || !context?.getCurrentTexture) throw new PStudioGraphicsError('A configured WebGPU canvas surface is not available.', { code: 'PSTUDIO_WEBGPU_SURFACE_UNAVAILABLE' });
    return context.getCurrentTexture();
  }
  function getCurrentSurfaceView() { return getCurrentSurfaceTexture().createView(); }
  function getCapabilities() {
    return Object.freeze({ backend: 'webgpu', features: Object.freeze([...(adapter?.features || device?.features || [])].map(String).sort()), limits: Object.freeze({ ...(device?.limits || adapter?.limits || {}) }), format, surfaceConfigured: configured, nativeWebGPU: true });
  }
  async function waitIdle() { assertDevice(); if (!device.queue?.onSubmittedWorkDone) return false; await device.queue.onSubmittedWorkDone(); return true; }
  async function rehydratePipelines() {
    assertDevice();
    const shaderRecipes = [...shaderModules.values()].map(record => record.descriptor);
    const computeRecipes = [...computePipelineDescriptors.entries()];
    const renderRecipes = [...renderPipelineDescriptors.entries()];
    shaderModules.clear(); computePipelines.clear(); renderPipelines.clear();
    let shadersRestored = 0, computeRestored = 0, renderRestored = 0;
    try {
      for (const descriptor of shaderRecipes) { await compileShader({ descriptor }); shadersRestored++; }
      for (const [id, descriptor] of computeRecipes) { await createComputePipeline(id, descriptor); computeRestored++; }
      for (const [id, descriptor] of renderRecipes) { await createRenderPipeline(id, descriptor); renderRestored++; }
      return Object.freeze({ shadersRestored, computePipelinesRestored: computeRestored, renderPipelinesRestored: renderRestored });
    } catch (error) {
      for (const record of shaderModules.values()) record.disposed = true;
      shaderModules.clear(); computePipelines.clear(); renderPipelines.clear();
      throw error;
    }
  }

  function dispose() {
    if (disposed) return false;
    for (const record of [...resources.values()]) destroyResource(record);
    try { lightingBuffers?.packed.destroy?.(); lightingBuffers?.masks.destroy?.(); } catch (_) {}
    try { clusteredBuffers?.offsets.destroy?.(); clusteredBuffers?.indices.destroy?.(); } catch (_) {}
    lightingBuffers = null; clusteredBuffers = null;
    shaderModules.clear(); computePipelines.clear(); renderPipelines.clear(); computePipelineDescriptors.clear(); renderPipelineDescriptors.clear();
    try { device?.destroy?.(); } catch (_) {}
    try { context?.unconfigure?.(); } catch (_) {}
    disposed = true;
    return true;
  }
  const api = Object.freeze({
    kind: 'pstudio-webgpu-graphics-backend', backend: 'webgpu', initialize, render, resize, dispose, waitIdle, getCapabilities,
    createResource, destroyResource, writeResource, recreateResource, compileShader, createComputePipeline, createRenderPipeline,
    dispatchCompute, uploadLightingSnapshot, uploadClusteredLightingSnapshot, beginGraph, barrier, beginPass, endPass, endGraph, abortGraph,
    executeRenderGraph, getCommandEncoder: () => commandEncoder, getCurrentSurfaceTexture, getCurrentSurfaceView, rehydratePipelines,
    get device() { return device; }, get adapter() { return adapter; }, get context() { return context; }, get canvas() { return canvas; }, get deviceLost() { return deviceLost; }, get lost() { return lost; },
    stats: () => Object.freeze({ resourceCount: resources.size, shaderCount: shaderModules.size, computePipelineCount: computePipelines.size, renderPipelineCount: renderPipelines.size, clusteredLightingBuffers: clusteredBuffers ? 2 : 0, graph: Object.freeze({ ...graphStats }), lost, disposed })
  });
  return api;
}

/** A dedicated adapter for the independent PStudio WebGPU backend (no Three.js session). */
export function createPStudioWebGPUCoreAdapter(options = {}) {
  const backend = options.backend || createPStudioWebGPUGraphicsBackend(options);
  return Object.freeze({
    backend,
    descriptor: Object.freeze({
      id: String(options.id || 'pstudio.webgpu.core'), backend: 'webgpu', priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 200,
      features: Object.freeze(['gpu-resources', 'wgsl', 'compute', 'lighting-buffer', 'render-graph', 'render-target', 'storage-buffer']),
      metadata: Object.freeze({ implementation: 'PStudio-owned direct WebGPU API backend', vendorNeutral: true })
    }),
    supports(context = {}) { const gpu = options.gpu || options.navigatorRef?.gpu || context.navigatorRef?.gpu || globalThis.navigator?.gpu; return !!(options.device || backend.device || (options.adapter && (options.canvas || context.canvas)) || (gpu?.requestAdapter && (options.canvas || context.canvas))); },
    async initialize(context = {}) {
      await backend.initialize({ ...context, canvas: options.canvas || context.canvas });
      return Object.freeze({
        backend: 'webgpu', deviceLost: backend.deviceLost,
        render: frame => backend.render(frame), resize: (w, h, r) => backend.resize(w, h, r), waitIdle: () => backend.waitIdle(),
        getCapabilities: () => backend.getCapabilities(), dispose: () => backend.dispose()
      });
    }
  });
}
