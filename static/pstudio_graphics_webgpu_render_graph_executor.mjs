import { renderPStudioGraphicsSceneFrame } from "./pstudio_graphics_webgpu_scene_renderer.mjs";
import { evaluatePStudioSceneAnimation, evaluatePStudioSceneBindPose } from "./pstudio_graphics_animation_core.mjs";
import { createPStudioGraphicsRenderingSuite } from "./pstudio_graphics_rendering_suite.mjs";
import { PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL, normalizePStudioAtmosphereState } from "./pstudio_graphics_atmosphere.mjs";

const TEXTURE_USAGE = Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
const BUFFER_USAGE = Object.freeze({ COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
const SHADER_STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2 });
const DEPTH_INPUTS = Object.freeze({ "water-depth": new Set([0]), "volumetric-lighting": new Set([1, 2]) });
const FINITE = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function usageFlag(name) {
  const values = globalThis.GPUTextureUsage || TEXTURE_USAGE;
  return values[name] ?? TEXTURE_USAGE[name];
}
function bufferFlag(name) {
  const values = globalThis.GPUBufferUsage || BUFFER_USAGE;
  return values[name] ?? BUFFER_USAGE[name];
}
function textureOf(resource) {
  return resource?.texture || resource?.gpuTexture || (typeof resource?.createView === "function" ? resource : null);
}
function viewOf(resource) {
  if (resource?.view) return resource.view;
  if (resource?.texture?.createView) return resource.texture.createView();
  if (resource?.gpuTexture?.createView) return resource.gpuTexture.createView();
  if (typeof resource?.createView === "function") return resource.createView();
  return resource;
}
function positiveDimensions(resource) {
  const width = Number(resource?.width || resource?.descriptor?.width || 1);
  const height = Number(resource?.height || resource?.descriptor?.height || 1);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new TypeError("Render Graph GPU resource requires positive integer dimensions.");
  }
  return { width, height };
}
function makeParams(frame = {}) {
  const atmosphere = normalizePStudioAtmosphereState(frame.atmosphere || {});
  const lighting = frame.scene?.lighting || {};
  const sun = lighting.sunDirection || atmosphere.sunDirection;
  const sunColor = lighting.sunColor || [1, 0.95, 0.85];
  const moonColor = frame.atmosphere?.moonColor || [0.62, 0.72, 1];
  const rayleigh = frame.atmosphere?.rayleighColor || [0.22, 0.45, 0.92];
  const near = Math.max(0.001, FINITE(frame.view?.near, 0.1));
  const far = Math.max(near + 0.01, FINITE(frame.view?.far, 10000));
  const fogDensity = FINITE(frame.atmosphere?.fogDensity, 0.001);
  const result = new Float32Array(28);
  result.set([FINITE(sun[0]), FINITE(sun[1]), FINITE(sun[2]), FINITE(lighting.sunIntensity, atmosphere.sunIntensity)], 0);
  result.set([...atmosphere.moonDirection, atmosphere.moonIntensity], 4);
  result.set([FINITE(sunColor[0]), FINITE(sunColor[1]), FINITE(sunColor[2]), atmosphere.turbidity], 8);
  result.set([FINITE(moonColor[0]), FINITE(moonColor[1]), FINITE(moonColor[2]), atmosphere.cloudCoverage], 12);
  result.set([FINITE(frame.cameraHeight, 0), atmosphere.animationTime, atmosphere.cloudDensity, atmosphere.windSpeed], 16);
  result.set([atmosphere.windDirection[0], atmosphere.windDirection[1], near, far], 20);
  result.set([FINITE(rayleigh[0], 0.22), FINITE(rayleigh[1], 0.45), FINITE(rayleigh[2], 0.92), fogDensity], 24);
  return result;
}
const FULLSCREEN_VERTEX = `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var output: VertexOut;
  let position = positions[index];
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.uv = position * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  return output;
}`;

function fullscreenFragment(stage, inputCount) {
  const declarations = [];
  for (let index = 0; index < inputCount; index += 1) {
    const depth = DEPTH_INPUTS[stage]?.has(index) === true;
    declarations.push(`@group(0) @binding(${index + 2}) var input${index}: ${depth ? "texture_depth_2d" : "texture_2d<f32>"};`);
  }
  const inputs = declarations.join("\n");
  const sample = index => DEPTH_INPUTS[stage]?.has(index)
    ? `textureLoad(input${index}, vec2<i32>(input.position.xy), 0)`
    : `textureSample(input${index}, linearSampler, input.uv)`;
  let body = "";
  switch (stage) {
    case "sky-atmosphere":
      body = `
        let direction = normalize(vec3<f32>((input.uv.x - 0.5) * 2.0, (0.5 - input.uv.y) * 2.0, 1.0));
        let color = pstudioAtmosphereSky(
          direction, params.data[0].xyz, params.data[1].xyz,
          params.data[2].xyz, params.data[3].xyz, params.data[6].xyz,
          vec3<f32>(0.92, 0.82, 0.70), params.data[4].x, params.data[2].w,
          params.data[0].w, params.data[1].w, params.data[4].y,
          params.data[3].w, params.data[4].z, params.data[5].xy
        );
        return vec4<f32>(color, 1.0);`;
      break;
    case "ibl-prefilter":
      body = `
        let dimensions = vec2<f32>(textureDimensions(input0));
        let texel = 1.0 / max(dimensions, vec2<f32>(1.0));
        var sum = vec3<f32>(0.0);
        for (var y: i32 = -2; y <= 2; y += 1) {
          for (var x: i32 = -2; x <= 2; x += 1) {
            let offset = vec2<f32>(f32(x), f32(y)) * texel * max(params.data[5].z, 1.0);
            sum += textureSample(input0, linearSampler, input.uv + offset).rgb;
          }
        }
        return vec4<f32>(sum / 25.0, 1.0);`;
      break;
    case "water-depth":
      body = `
        let depth = ${sample(0)};
        let nearPlane = max(params.data[5].z, 0.001);
        let farPlane = max(params.data[5].w, nearPlane + 0.01);
        let linearDepth = (nearPlane * farPlane) / max(farPlane - depth * (farPlane - nearPlane), 0.0001);
        return vec4<f32>(linearDepth, 0.0, 0.0, 1.0);`;
      break;
    case "water-surface":
      body = `
        let opaque = ${sample(0)}.rgb;
        let depth = ${sample(1)}.r;
        let reflection = ${sample(2)}.rgb;
        let sky = ${sample(3)}.rgb;
        let fresnel = 0.02 + 0.98 * pow(1.0 - clamp(abs(input.uv.y * 2.0 - 1.0), 0.0, 1.0), 5.0);
        let absorption = exp(-vec3<f32>(0.18, 0.065, 0.025) * max(depth, 0.0) * 0.001);
        let transmitted = opaque * absorption;
        let color = mix(transmitted, reflection, fresnel) + sky * (0.01 * fresnel);
        return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);`;
      break;
    case "gi-probes":
      body = `
        let dimensions = vec2<f32>(textureDimensions(input0));
        let texel = 1.0 / max(dimensions, vec2<f32>(1.0));
        var irradiance = vec3<f32>(0.0);
        for (var y: i32 = -1; y <= 1; y += 1) {
          for (var x: i32 = -1; x <= 1; x += 1) {
            irradiance += textureSample(input0, linearSampler, input.uv + vec2<f32>(f32(x), f32(y)) * texel).rgb;
          }
        }
        return vec4<f32>(irradiance / 9.0 * 0.32, 1.0);`;
      break;
    case "volumetric-lighting":
      body = `
        let base = ${sample(0)}.rgb;
        let depth = ${sample(1)};
        let shadow = ${sample(2)};
        let sky = ${sample(3)}.rgb;
        var transmittance = 1.0;
        var scatter = vec3<f32>(0.0);
        for (var step: u32 = 0u; step < 8u; step += 1u) {
          let t = (f32(step) + 0.5) / 8.0;
          let extinction = exp(-max(params.data[6].w, 0.00001) * max(depth, 0.0) * t * 0.001);
          let visibility = smoothstep(0.0, 1.0, shadow + 0.02);
          scatter += sky * (1.0 - extinction) * transmittance * visibility * 0.018;
          transmittance *= extinction;
        }
        return vec4<f32>(base + scatter, 1.0);`;
      break;
    case "post-processing":
      body = `
        let water = ${sample(0)}.rgb;
        let gi = ${sample(1)}.rgb;
        let volume = ${sample(2)}.rgb;
        return vec4<f32>(max(water + gi * 0.12 + volume * 0.75, vec3<f32>(0.0)), 1.0);`;
      break;
    case "tone-map-present":
      body = `
        let linear = max(${sample(0)}.rgb, vec3<f32>(0.0));
        let mapped = (linear * (2.51 * linear + 0.03)) / max(linear * (2.43 * linear + 0.59) + 0.14, vec3<f32>(0.000001));
        let bounded = clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0));
        let srgb = select(1.055 * pow(bounded, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), bounded * 12.92, bounded <= vec3<f32>(0.0031308));
        return vec4<f32>(srgb, 1.0);`;
      break;
    default:
      throw new TypeError("Unknown PStudio WebGPU full-screen render stage: " + stage);
  }
  const atmosphere = stage === "sky-atmosphere" ? PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL : "";
  return `
    ${atmosphere}
    struct PassParams { data: array<vec4<f32>, 7> };
    @group(0) @binding(0) var<uniform> params: PassParams;
    @group(0) @binding(1) var linearSampler: sampler;
    ${inputs}
    ${FULLSCREEN_VERTEX}
    @fragment fn fs_main(input: VertexOut) -> @location(0) vec4<f32> {
      ${body}
    }
  `;
}

function createBuffer(device, data, usage, label) {
  const buffer = device.createBuffer({ label, size: Math.max(4, (data.byteLength + 3) & ~3), usage: usage | bufferFlag("COPY_DST") });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
function resourceIds(context) {
  const ids = context.resourceIds;
  if (!ids) throw new Error("PStudio Render Graph stage requires suite resource ids.");
  return ids;
}

/**
 * Creates real WebGPU resource allocation and stage executors for the PStudio visual
 * Render Graph. Shadow/depth/opaque/reflection passes rasterize the supplied PStudio
 * scene. Full-screen atmosphere, IBL prefilter, water composition, GI, volumetrics
 * and post-processing passes create pipelines, bind actual graph textures, draw and
 * submit GPU command buffers. No Three.js renderer is used.
 *
 * Required frame inputs:
 *   scene: PStudio-owned scene asset
 *   view.viewProjectionMatrix (depth/opaque)
 *   shadowViewProjection (shadow map)
 *   reflectionViewProjection (planar reflection)
 *   outputSurface: GPUTextureView (supplied to suite.execute)
 */
export function createPStudioWebGPURenderGraphExecutor(options = {}) {
  const device = options.device || options.api?.device;
  if (!device?.createTexture || !device?.createShaderModule || !device?.createRenderPipeline ||
      !device?.createBindGroupLayout || !device?.createPipelineLayout || !device?.createCommandEncoder) {
    throw new TypeError("PStudio WebGPU Render Graph executor requires a live WebGPU device.");
  }
  const api = options.api || {};
  const inputFrame = options.frame || {};
  const sourceScene = options.sceneAsset || inputFrame.scene;
  if (sourceScene?.kind !== "pstudio-graphics-scene-asset") throw new TypeError("A PStudio-owned scene asset is required for the geometry passes.");
  const animation = inputFrame.animation || (inputFrame.animationClipId ? {
    clipId: inputFrame.animationClipId, timeSeconds: inputFrame.timeSeconds ?? 0,
    loop: inputFrame.animationLoop === true
  } : null);
  let scene = sourceScene;
  if (animation?.clipId) {
    scene = evaluatePStudioSceneAnimation(sourceScene, animation.clipId, animation.timeSeconds ?? inputFrame.timeSeconds ?? 0, { loop: animation.loop === true });
  } else {
    const geometryById = new Map(sourceScene.geometries.map(geometry => [geometry.id, geometry]));
    const needsDeformation = sourceScene.entities.some(entity => {
      const geometry = geometryById.get(entity.geometryId);
      return entity.visible && (!!entity.skinId || !!geometry?.morphTargets?.length);
    });
    if (needsDeformation) scene = evaluatePStudioSceneBindPose(sourceScene);
  }
  const frame = { ...inputFrame, scene, animation: null, animationClipId: null };
  const sceneRendererState = options.sceneRendererState || {};
  const fullscreenCache = new Map();
  const depthCache = { geometry: new Map(), transforms: new Map(), pipelines: new Map() };
  let disposed = false;
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

  const backend = Object.freeze({
    async createResource(descriptor) {
      if (descriptor.imported || descriptor.lifetime === "external" || descriptor.type === "surface") {
        throw new Error("External surface resources must be supplied by the caller: " + descriptor.id);
      }
      const width = positiveDimension(descriptor.width || 1);
      const height = positiveDimension(descriptor.height || 1);
      const isDepth = String(descriptor.format || "").startsWith("depth");
      let usage = usageFlag("RENDER_ATTACHMENT") | usageFlag("TEXTURE_BINDING") | usageFlag("COPY_SRC") | usageFlag("COPY_DST");
      if ((descriptor.usage || []).includes("storage-write")) usage |= usageFlag("STORAGE_BINDING");
      const texture = device.createTexture({
        label: "PStudio Render Graph " + descriptor.id,
        size: [width, height, 1], format: descriptor.format || (isDepth ? "depth32float" : "rgba16float"), usage
      });
      return Object.freeze({ texture, view: texture.createView(), width, height, format: descriptor.format, descriptor });
    },
    async destroyResource(resource) { try { textureOf(resource)?.destroy?.(); } catch (_) {} },
    async barrier() { /* WebGPU tracks resource transitions at the API level. */ },
    async beginGraph() {},
    async endGraph() {},
    async beginPass() {},
    async endPass() {},
    async abortPass() {},
    async abortGraph() {}
  });

  function positiveDimension(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("Render Graph texture dimensions must be positive integers.");
    return n;
  }
  function getResource(context, name) {
    const id = resourceIds(context)[name];
    const value = context.resources[id];
    if (value == null) throw new Error("PStudio Render Graph resource is not materialized: " + name);
    return value;
  }
  function makeFullscreenPipeline(stage, targetFormat, inputNames) {
    const depthSlots = DEPTH_INPUTS[stage] || new Set();
    const layoutEntries = [
      { binding: 0, visibility: SHADER_STAGE.FRAGMENT, buffer: { type: "uniform", minBindingSize: 112 } },
      { binding: 1, visibility: SHADER_STAGE.FRAGMENT, sampler: { type: "filtering" } },
      ...inputNames.map((_, index) => ({
        binding: index + 2, visibility: SHADER_STAGE.FRAGMENT,
        texture: { sampleType: depthSlots.has(index) ? "depth" : "float", viewDimension: "2d", multisampled: false }
      }))
    ];
    const key = stage + "|" + targetFormat + "|" + inputNames.length;
    if (fullscreenCache.has(key)) return fullscreenCache.get(key);
    const layout = device.createBindGroupLayout({ label: "PStudio " + stage + " Bind Group", entries: layoutEntries });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ label: "PStudio " + stage + " WGSL", code: fullscreenFragment(stage, inputNames.length) });
    const pipeline = device.createRenderPipeline({
      label: "PStudio " + stage + " Pipeline",
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
      primitive: { topology: "triangle-list" }
    });
    const parameterBuffer = device.createBuffer({
      label: "PStudio " + stage + " Parameters", size: 112,
      usage: bufferFlag("UNIFORM") | bufferFlag("COPY_DST")
    });
    const cached = { layout, pipeline, parameterBuffer, inputNames, depthSlots };
    fullscreenCache.set(key, cached);
    return cached;
  }
  function parametersFor(stage) {
    const data = makeParams(frame);
    if (stage === "ibl-prefilter") data[22] = 1.5;
    if (stage === "volumetric-lighting") data[27] = Math.max(0.00001, FINITE(frame.atmosphere?.fogDensity, 0.001));
    return data;
  }
  function executeFullscreen(stage, inputNames, outputName) {
    return async context => {
      if (disposed) throw new Error("PStudio WebGPU Render Graph executor is disposed.");
      const outputResource = getResource(context, outputName);
      const outputView = viewOf(outputResource);
      const outputFormat = outputResource.format || outputResource.descriptor?.format || (outputName === "outputSurface" ? options.outputFormat || "bgra8unorm" : "rgba16float");
      const pipeline = makeFullscreenPipeline(stage, outputFormat, inputNames);
      const params = parametersFor(stage);
      device.queue.writeBuffer(pipeline.parameterBuffer, 0, params);
      const entries = [
        { binding: 0, resource: { buffer: pipeline.parameterBuffer, offset: 0, size: 112 } },
        { binding: 1, resource: sampler }
      ];
      inputNames.forEach((name, index) => entries.push({ binding: index + 2, resource: viewOf(getResource(context, name)) }));
      const bindGroup = device.createBindGroup({ layout: pipeline.layout, entries });
      const encoder = device.createCommandEncoder({ label: "PStudio Render Graph " + stage });
      const pass = encoder.beginRenderPass({
        label: "PStudio Render Graph " + stage,
        colorAttachments: [{
          view: outputView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear", storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return Object.freeze({ executed: true, stage, drawCount: 1, inputCount: inputNames.length });
    };
  }

  function ensureDepthPipeline(depthFormat) {
    if (depthCache.pipelines.has(depthFormat)) return depthCache.pipelines.get(depthFormat);
    const code = `
      struct Frame { viewProjection: mat4x4<f32> };
      @group(0) @binding(0) var<uniform> frame: Frame;
      struct VertexIn {
        @location(0) position: vec3<f32>,
        @location(1) model0: vec4<f32>,
        @location(2) model1: vec4<f32>,
        @location(3) model2: vec4<f32>,
        @location(4) model3: vec4<f32>
      };
      @vertex fn vs_main(input: VertexIn) -> @builtin(position) vec4<f32> {
        let model = mat4x4<f32>(input.model0, input.model1, input.model2, input.model3);
        return frame.viewProjection * model * vec4<f32>(input.position, 1.0);
      }`;
    const module = device.createShaderModule({ label: "PStudio Scene Depth WGSL", code });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE.VERTEX, buffer: { type: "uniform", minBindingSize: 64 } }]
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = device.createRenderPipeline({
      label: "PStudio Scene Depth Pipeline " + depthFormat,
      layout: pipelineLayout,
      vertex: {
        module, entryPoint: "vs_main",
        buffers: [
          { arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 64, stepMode: "instance", attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x4" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
            { shaderLocation: 4, offset: 48, format: "float32x4" }
          ] }
        ]
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: "less" }
    });
    const frameBuffer = device.createBuffer({ size: 64, usage: bufferFlag("UNIFORM") | bufferFlag("COPY_DST") });
    const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: frameBuffer, offset: 0, size: 64 } }] });
    const record = { pipeline, frameBuffer, bindGroup };
    depthCache.pipelines.set(depthFormat, record);
    return record;
  }
  function ensureDepthGeometry(geometry) {
    const cached = depthCache.geometry.get(geometry.id);
    if (cached && cached.revision === geometry.revision) return cached;
    if (cached) {
      try { cached.vertexBuffer.destroy(); cached.indexBuffer?.destroy(); } catch (_) {}
    }
    const positions = Float32Array.from(geometry.positions || [], Number);
    if (!positions.length || positions.length % 3 || !positions.every(Number.isFinite)) throw new TypeError("Depth pass geometry positions are invalid: " + geometry.id);
    const vertexBuffer = createBuffer(device, positions, bufferFlag("VERTEX"), "PStudio Depth Vertices " + geometry.id);
    const indices = geometry.indices ? (geometry.indices instanceof Uint32Array ? geometry.indices : Uint16Array.from(geometry.indices)) : null;
    const indexBuffer = indices ? createBuffer(device, indices, bufferFlag("INDEX"), "PStudio Depth Indices " + geometry.id) : null;
    const value = { revision: geometry.revision, vertexBuffer, indexBuffer, indexCount: indices?.length || 0, vertexCount: positions.length / 3, indexFormat: indices instanceof Uint32Array ? "uint32" : "uint16" };
    depthCache.geometry.set(geometry.id, value);
    return value;
  }
  function ensureDepthTransform(entity) {
    let buffer = depthCache.transforms.get(entity.id);
    if (!buffer) {
      buffer = device.createBuffer({ label: "PStudio Depth Transform " + entity.id, size: 64, usage: bufferFlag("VERTEX") | bufferFlag("COPY_DST") });
      depthCache.transforms.set(entity.id, buffer);
    }
    const matrix = Float32Array.from(entity.matrixWorld);
    if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new TypeError("Depth pass entity matrix is invalid: " + entity.id);
    device.queue.writeBuffer(buffer, 0, matrix);
    return buffer;
  }
  async function renderDepthScene(context, resourceName, viewProjection, castShadowOnly = false) {
    if (!viewProjection || viewProjection.length !== 16) {
      throw new TypeError((castShadowOnly ? "Shadow" : "Depth") + " pass requires an explicit 16-value viewProjection matrix.");
    }
    const target = getResource(context, resourceName), depthView = viewOf(target);
    const depthFormat = target.format || target.descriptor?.format || "depth32float";
    const pipeline = ensureDepthPipeline(depthFormat);
    device.queue.writeBuffer(pipeline.frameBuffer, 0, Float32Array.from(viewProjection));
    const encoder = device.createCommandEncoder({ label: "PStudio " + resourceName + " Geometry Pass" });
    const pass = encoder.beginRenderPass({
      label: "PStudio " + resourceName + " Geometry Pass",
      colorAttachments: [],
      depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" }
    });
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroup);
    const geometryMap = new Map(scene.geometries.map(item => [item.id, item]));
    for (const entity of scene.entities) {
      if (!entity.visible || (castShadowOnly && entity.castShadow !== true)) continue;
      if (entity.skinId || entity.morphWeights?.length) throw new Error("Depth pass requires animated entities to be evaluated into deformed PStudio geometry before rasterization: " + entity.id);
      const geometry = geometryMap.get(entity.geometryId);
      if (!geometry) throw new Error("Depth pass geometry is missing: " + entity.geometryId);
      const gpu = ensureDepthGeometry(geometry);
      pass.setVertexBuffer(0, gpu.vertexBuffer);
      pass.setVertexBuffer(1, ensureDepthTransform(entity));
      if (gpu.indexBuffer) {
        pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
        pass.drawIndexed(gpu.indexCount, 1, 0, 0, 0);
      } else pass.draw(gpu.vertexCount, 1, 0, 0);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    return Object.freeze({ executed: true, stage: resourceName, depthDraws: scene.entities.filter(item => item.visible && (!castShadowOnly || item.castShadow)).length });
  }

  const handlers = Object.freeze({
    "shadow-map": context => renderDepthScene(context, "shadowDepth", frame.shadowViewProjection, true),
    "sky-atmosphere": executeFullscreen("sky-atmosphere", [], "skyRadiance"),
    "ibl-prefilter": executeFullscreen("ibl-prefilter", ["skyRadiance"], "iblSpecular"),
    "depth-prepass": context => renderDepthScene(context, "sceneDepth", frame.view?.viewProjectionMatrix || frame.view?.viewProjection, false),
    "opaque-forward": async context => {
      const ids = resourceIds(context);
      const color = context.resources[ids.opaqueHdr], depth = context.resources[ids.sceneDepth];
      const ibl = context.resources[ids.iblSpecular];
      return renderPStudioGraphicsSceneFrame({
        ...frame, scene,
        renderTarget: {
          colorView: viewOf(color), colorFormat: color.format || color.descriptor?.format || "rgba16float",
          depthView: viewOf(depth), depthFormat: depth.format || depth.descriptor?.format || "depth32float",
          iblView: viewOf(ibl), width: color.width, height: color.height,
          loadOp: "clear", depthLoadOp: "load", linearOutput: true
        }
      }, {
        ...api, device, canvas: { width: color.width, height: color.height },
        getCapabilities: () => ({ format: color.format || color.descriptor?.format || "rgba16float" }),
        getCurrentSurfaceView: () => viewOf(color)
      }, sceneRendererState);
    },
    "water-depth": executeFullscreen("water-depth", ["sceneDepth"], "waterLinearDepth"),
    "mirror-reflection": async context => {
      if (!frame.reflectionViewProjection) throw new TypeError("Planar water reflection requires frame.reflectionViewProjection.");
      const ids = resourceIds(context);
      const color = context.resources[ids.mirrorReflection], depth = context.resources[ids.mirrorDepth];
      const ibl = context.resources[ids.iblSpecular];
      return renderPStudioGraphicsSceneFrame({
        ...frame,
        view: { ...(frame.view || {}), viewProjectionMatrix: frame.reflectionViewProjection, cameraPosition: frame.reflectionCameraPosition || frame.view?.cameraPosition },
        renderTarget: {
          colorView: viewOf(color), colorFormat: color.format || color.descriptor?.format || "rgba16float",
          depthView: viewOf(depth), depthFormat: depth.format || depth.descriptor?.format || "depth32float",
          iblView: viewOf(ibl), width: color.width, height: color.height,
          loadOp: "clear", depthLoadOp: "clear", linearOutput: true
        }
      }, {
        ...api, device, canvas: { width: color.width, height: color.height },
        getCapabilities: () => ({ format: color.format || color.descriptor?.format || "rgba16float" }),
        getCurrentSurfaceView: () => viewOf(color)
      }, sceneRendererState);
    },
    "water-surface": executeFullscreen("water-surface", ["opaqueHdr", "waterLinearDepth", "mirrorReflection", "skyRadiance"], "waterHdr"),
    "gi-probes": executeFullscreen("gi-probes", ["waterHdr"], "giIrradiance"),
    "volumetric-lighting": executeFullscreen("volumetric-lighting", ["waterHdr", "sceneDepth", "shadowDepth", "skyRadiance"], "volumeHdr"),
    "post-processing": executeFullscreen("post-processing", ["waterHdr", "giIrradiance", "volumeHdr"], "postHdr"),
    "tone-map-present": executeFullscreen("tone-map-present", ["postHdr"], "outputSurface")
  });

  async function execute(suite, executionOptions = {}) {
    if (disposed) throw new Error("PStudio WebGPU Render Graph executor is disposed.");
    if (!suite || suite.kind !== "pstudio-graphics-rendering-suite") throw new TypeError("A PStudio rendering suite is required.");
    return suite.execute({
      ...executionOptions,
      backend,
      outputSurface: executionOptions.outputSurface,
      resources: executionOptions.resources || {},
      frame
    });
  }
  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const pipeline of fullscreenCache.values()) {
      try { pipeline.parameterBuffer.destroy(); } catch (_) {}
    }
    for (const pipeline of depthCache.pipelines.values()) {
      try { pipeline.frameBuffer.destroy(); } catch (_) {}
    }
    for (const geometry of depthCache.geometry.values()) {
      try { geometry.vertexBuffer.destroy(); geometry.indexBuffer?.destroy(); } catch (_) {}
    }
    for (const buffer of depthCache.transforms.values()) { try { buffer.destroy(); } catch (_) {} }
    fullscreenCache.clear(); depthCache.geometry.clear(); depthCache.transforms.clear(); depthCache.pipelines.clear();
    try { sceneRendererState?.dispose?.(); } catch (_) {}
    return true;
  }
  const createSuite = suiteOptions => createPStudioGraphicsRenderingSuite({
    ...(suiteOptions || {}),
    handlers: { ...(suiteOptions?.handlers || {}), ...handlers }
  });
  return Object.freeze({ kind: "pstudio-webgpu-render-graph-executor", backend, handlers, createSuite, execute, dispose });
}
