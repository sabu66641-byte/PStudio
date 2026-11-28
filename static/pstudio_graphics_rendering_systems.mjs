/**
 * Explicit integration point for PStudio-owned PBR, atmosphere and water shader libraries.
 * Callers provide stage entry points; this module never changes the production renderer.
 */
import { PSTUDIO_GRAPHICS_QUALITY_WGSL, packPStudioQualityMaterial } from './pstudio_graphics_rendering_quality.mjs';
import { PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL, packPStudioAtmosphereUniforms } from './pstudio_graphics_atmosphere.mjs';
import { PSTUDIO_GRAPHICS_WATER_WGSL, packPStudioWaterUniforms, addPStudioWaterRenderPasses } from './pstudio_graphics_water.mjs';

const LIBRARIES = Object.freeze({
  quality: PSTUDIO_GRAPHICS_QUALITY_WGSL,
  atmosphere: PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL,
  water: PSTUDIO_GRAPHICS_WATER_WGSL
});

export function composePStudioRenderingShaderSource(stageSource, options = {}) {
  if (typeof stageSource !== 'string' || !stageSource.trim()) throw new TypeError('A WGSL stage entry-point source is required.');
  const include = options.include || ['quality', 'atmosphere', 'water'];
  if (!Array.isArray(include)) throw new TypeError('Shader include selection must be an array.');
  const selected = [...new Set(include.map(String))];
  for (const name of selected) if (!Object.prototype.hasOwnProperty.call(LIBRARIES, name)) throw new TypeError('Unknown PStudio shader library: ' + name);
  return selected.map(name => LIBRARIES[name]).join('\n') + '\n' + stageSource;
}

export function createPStudioRenderingShaderDescriptors(input = {}) {
  const prefix = String(input.idPrefix || 'pstudio.rendering').trim();
  if (!prefix) throw new TypeError('A non-empty rendering shader idPrefix is required.');
  const include = input.include || ['quality', 'atmosphere', 'water'];
  return Object.freeze({
    vertex: Object.freeze({
      id: prefix + '.vertex', stage: 'vertex', language: 'wgsl',
      source: composePStudioRenderingShaderSource(input.vertexSource, { include }),
      entryPoint: String(input.vertexEntryPoint || 'vsMain')
    }),
    fragment: Object.freeze({
      id: prefix + '.fragment', stage: 'fragment', language: 'wgsl',
      source: composePStudioRenderingShaderSource(input.fragmentSource, { include }),
      entryPoint: String(input.fragmentEntryPoint || 'fsMain')
    })
  });
}

export async function createPStudioRenderingPipeline(graphicsCore, input = {}) {
  if (!graphicsCore?.shaders?.register || !graphicsCore?.compileShader || !graphicsCore?.createRenderPipeline) {
    throw new TypeError('A PStudio Graphics Core with shader compilation and render-pipeline support is required.');
  }
  const descriptors = createPStudioRenderingShaderDescriptors(input);
  const registered = [];
  try {
    for (const descriptor of Object.values(descriptors)) registered.push(graphicsCore.shaders.register(descriptor));
    const backend = input.backend || graphicsCore.gpuRuntime?.backend || 'webgpu';
    await graphicsCore.compileShader(descriptors.vertex.id, input.variant || {}, { backend, deviceKey: input.deviceKey || 'default' });
    await graphicsCore.compileShader(descriptors.fragment.id, input.variant || {}, { backend, deviceKey: input.deviceKey || 'default' });
    const pipeline = await graphicsCore.createRenderPipeline(input.pipelineId || input.idPrefix || 'pstudio.rendering.pipeline', {
      layout: input.layout || 'auto',
      vertex: { shaderId: descriptors.vertex.id, entryPoint: descriptors.vertex.entryPoint, buffers: input.vertexBuffers || [] },
      fragment: {
        shaderId: descriptors.fragment.id,
        entryPoint: descriptors.fragment.entryPoint,
        targets: input.targets || [{ format: input.format || 'bgra8unorm' }]
      },
      primitive: input.primitive || { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      ...(input.depthStencil ? { depthStencil: input.depthStencil } : {}),
      ...(input.multisample ? { multisample: input.multisample } : {})
    });
    return Object.freeze({ descriptors, registered: Object.freeze(registered), pipeline });
  } catch (error) {
    for (const descriptor of Object.values(descriptors)) graphicsCore.shaders.unregister(descriptor.id);
    throw error;
  }
}

/**
 * Persistent GPU uniform buffers; updates reuse the same allocations and only upload
 * changed frame/material/environment data. Resources are owned by Graphics Resource Core.
 */
export async function createPStudioRenderingUniformSet(graphicsCore, options = {}) {
  if (!graphicsCore?.resources?.createGPU) throw new TypeError('A Graphics Core with GPU resource ownership is required.');
  const prefix = String(options.prefix || 'pstudio.rendering.uniforms');
  const initial = {
    material: packPStudioQualityMaterial(options.material),
    atmosphere: packPStudioAtmosphereUniforms(options.atmosphere),
    water: packPStudioWaterUniforms(options.water)
  };
  const resources = {};
  try {
    for (const [name, data] of Object.entries(initial)) {
      resources[name] = await graphicsCore.resources.createGPU({
        id: prefix + '.' + name, type: 'buffer', estimatedBytes: data.byteLength,
        usage: ['uniform', 'copy-dst'], lifetime: 'persistent'
      }, { initialData: data });
    }
  } catch (error) {
    for (const name of Object.keys(resources)) graphicsCore.resources.remove(prefix + '.' + name, { force: true });
    throw error;
  }
  let disposed = false;
  function update(input = {}) {
    if (disposed) throw new Error('PStudio rendering uniform set is disposed.');
    if (input.material) resources.material.write(packPStudioQualityMaterial(input.material));
    if (input.atmosphere) resources.atmosphere.write(packPStudioAtmosphereUniforms(input.atmosphere));
    if (input.water) resources.water.write(packPStudioWaterUniforms(input.water));
    return Object.freeze({
      material: resources.material.handle,
      atmosphere: resources.atmosphere.handle,
      water: resources.water.handle
    });
  }
  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const name of Object.keys(resources)) graphicsCore.resources.remove(prefix + '.' + name, { force: true });
    return true;
  }
  return Object.freeze({
    resources: Object.freeze(resources),
    update,
    dispose,
    get disposed() { return disposed; },
    getBindings() {
      if (disposed) throw new Error('PStudio rendering uniform set is disposed.');
      return Object.freeze({
        material: resources.material.handle,
        atmosphere: resources.atmosphere.handle,
        water: resources.water.handle
      });
    }
  });
}

export function addPStudioRenderingWaterGraph(graphicsCore, options = {}) {
  if (!graphicsCore?.renderGraph) throw new TypeError('A PStudio Graphics Core Render Graph is required.');
  return addPStudioWaterRenderPasses(graphicsCore.renderGraph, options);
}

export function getPStudioRenderingShaderLibraries() {
  return LIBRARIES;
}
