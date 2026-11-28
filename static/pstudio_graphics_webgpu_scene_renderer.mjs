import { createPStudioWebGPUCoreAdapter } from './pstudio_graphics_webgpu_backend.mjs';

const BUFFER_USAGE = Object.freeze({ COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
const TEXTURE_USAGE = Object.freeze({ RENDER_ATTACHMENT: 16 });
const WGSL = [
'struct FrameData {',
'  viewProjection: mat4x4<f32>,',
'  cameraPosition: vec4<f32>,',
'  sunDirection: vec4<f32>,',
'  sunColor: vec4<f32>,',
'  ambientColor: vec4<f32>,',
'};',
'struct ObjectData {',
'  model: mat4x4<f32>,',
'  normal0: vec4<f32>,',
'  normal1: vec4<f32>,',
'  normal2: vec4<f32>,',
'  baseColor: vec4<f32>,',
'  surface: vec4<f32>,',
'  emissiveColor: vec4<f32>,',
'};',
'@group(0) @binding(0) var<uniform> frame: FrameData;',
'@group(1) @binding(0) var<uniform> object: ObjectData;',
'struct VertexInput {',
'  @location(0) position: vec3<f32>,',
'  @location(1) normal: vec3<f32>,',
'  @location(2) uv: vec2<f32>,',
'};',
'struct VertexOutput {',
'  @builtin(position) clipPosition: vec4<f32>,',
'  @location(0) worldPosition: vec3<f32>,',
'  @location(1) worldNormal: vec3<f32>,',
'  @location(2) uv: vec2<f32>,',
'};',
'@vertex fn vs_main(input: VertexInput) -> VertexOutput {',
'  var output: VertexOutput;',
'  let world = object.model * vec4<f32>(input.position, 1.0);',
'  let normalMatrix = mat3x3<f32>(object.normal0.xyz, object.normal1.xyz, object.normal2.xyz);',
'  output.clipPosition = frame.viewProjection * world;',
'  output.worldPosition = world.xyz;',
'  output.worldNormal = normalize(normalMatrix * input.normal);',
'  output.uv = input.uv;',
'  return output;',
'}',
'fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {',
'  let alpha = max(roughness * roughness, 0.0025);',
'  let alpha2 = alpha * alpha;',
'  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;',
'  return alpha2 / max(3.14159265 * denominator * denominator, 0.000001);',
'}',
'fn geometrySchlick(nDotV: f32, roughness: f32) -> f32 {',
'  let r = roughness + 1.0;',
'  let k = r * r * 0.125;',
'  return nDotV / max(nDotV * (1.0 - k) + k, 0.000001);',
'}',
'fn fresnelSchlick(cosine: f32, f0: vec3<f32>) -> vec3<f32> {',
'  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);',
'}',
'@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {',
'  let albedo = max(object.baseColor.rgb, vec3<f32>(0.0));',
'  let metallic = clamp(object.surface.x, 0.0, 1.0);',
'  let roughness = clamp(object.surface.y, 0.045, 1.0);',
'  let n = normalize(input.worldNormal);',
'  let v = normalize(frame.cameraPosition.xyz - input.worldPosition);',
'  let l = normalize(-frame.sunDirection.xyz);',
'  let h = normalize(v + l);',
'  let nDotV = max(dot(n, v), 0.0001);',
'  let nDotL = max(dot(n, l), 0.0);',
'  let nDotH = max(dot(n, h), 0.0);',
'  let vDotH = max(dot(v, h), 0.0);',
'  let f0 = mix(vec3<f32>(0.04), albedo, metallic);',
'  let fresnel = fresnelSchlick(vDotH, f0);',
'  let distribution = distributionGGX(nDotH, roughness);',
'  let geometry = geometrySchlick(nDotV, roughness) * geometrySchlick(nDotL, roughness);',
'  let specular = distribution * geometry * fresnel / max(4.0 * nDotV * nDotL, 0.001);',
'  let diffuse = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic) * albedo / 3.14159265;',
'  let direct = (diffuse + specular) * frame.sunColor.rgb * frame.sunColor.w * nDotL;',
'  let ambient = albedo * frame.ambientColor.rgb * frame.ambientColor.w * (1.0 - metallic);',
'  let linearColor = max(direct + ambient + object.emissiveColor.rgb, vec3<f32>(0.0));',
'  let mapped = linearColor / (linearColor + vec3<f32>(1.0));',
'  let srgb = select(1.055 * pow(mapped, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), mapped * 12.92, mapped <= vec3<f32>(0.0031308));',
'  return vec4<f32>(srgb, object.baseColor.a);',
'}'
].join('\n');

function bufferUsage(name) {
  const values = globalThis.GPUBufferUsage || BUFFER_USAGE;
  return values[name] ?? BUFFER_USAGE[name];
}
function matrix4(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 16) throw new TypeError(label + ' must be a 16-component matrix.');
  const result = Float32Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain finite values.');
  return result;
}
function multiplyMatrix4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) value += a[index * 4 + row] * b[column * 4 + index];
      out[column * 4 + row] = value;
    }
  }
  return out;
}
function viewProjection(view) {
  const supplied = view?.viewProjectionMatrix || view?.viewProjection;
  if (supplied) return matrix4(supplied, 'viewProjectionMatrix');
  if (view?.projectionMatrix && view?.viewMatrix) {
    return multiplyMatrix4(matrix4(view.projectionMatrix, 'projectionMatrix'), matrix4(view.viewMatrix, 'viewMatrix'));
  }
  throw new TypeError('Independent PStudio WebGPU rendering requires viewProjectionMatrix or viewMatrix + projectionMatrix.');
}
function vector3(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)
    ? [value.x, value.y, value.z] : value;
  const result = Array.isArray(source) || ArrayBuffer.isView(source) ? Array.from(source).slice(0, 3).map(Number) : fallback.slice();
  if (result.length !== 3 || !result.every(Number.isFinite)) return fallback.slice();
  return result;
}
function normalized3(value, fallback) {
  const v = vector3(value, fallback), length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-8 ? v.map(component => component / length) : fallback.slice();
}
function normalMatrix(matrix) {
  const a = matrix[0], b = matrix[4], c = matrix[8];
  const d = matrix[1], e = matrix[5], f = matrix[9];
  const g = matrix[2], h = matrix[6], i = matrix[10];
  const c11 = e * i - f * h, c12 = f * g - d * i, c13 = d * h - e * g;
  const c21 = c * h - b * i, c22 = a * i - c * g, c23 = b * g - a * h;
  const c31 = b * f - c * e, c32 = c * d - a * f, c33 = a * e - b * d;
  const determinant = a * c11 + b * c12 + c * c13;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new RangeError('Entity transform is singular; a normal matrix cannot be computed.');
  const inverse = 1 / determinant;
  return new Float32Array([c11, c21, c31, c12, c22, c32, c13, c23, c33].map(value => value * inverse));
}
function createBuffer(device, data, usage, label) {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const padded = new Uint8Array(size);
  padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const buffer = device.createBuffer({ label, size, usage: usage | bufferUsage('COPY_DST'), mappedAtCreation: false });
  device.queue.writeBuffer(buffer, 0, padded.buffer, 0, padded.byteLength);
  return buffer;
}
function geometryVertexData(geometry) {
  const positions = geometry.positions, normals = geometry.normals, uvs = geometry.uvs;
  if (!positions || !normals || !uvs || positions.length % 3 || normals.length !== positions.length || uvs.length !== positions.length / 3 * 2) {
    throw new TypeError('PStudio WebGPU renderer received an invalid geometry attribute set.');
  }
  const vertices = new Float32Array((positions.length / 3) * 8);
  for (let index = 0, vertex = 0; index < positions.length / 3; index += 1, vertex += 8) {
    vertices[vertex] = positions[index * 3];
    vertices[vertex + 1] = positions[index * 3 + 1];
    vertices[vertex + 2] = positions[index * 3 + 2];
    vertices[vertex + 3] = normals[index * 3];
    vertices[vertex + 4] = normals[index * 3 + 1];
    vertices[vertex + 5] = normals[index * 3 + 2];
    vertices[vertex + 6] = uvs[index * 2];
    vertices[vertex + 7] = uvs[index * 2 + 1];
  }
  return vertices;
}
function validateScene(scene) {
  if (!scene || scene.kind !== 'pstudio-graphics-scene-asset' || !Array.isArray(scene.geometries) ||
      !Array.isArray(scene.materials) || !Array.isArray(scene.entities)) {
    throw new TypeError('A PStudio-owned scene asset is required; Three.js objects are not accepted by this renderer.');
  }
  const geometries = new Map(scene.geometries.map(item => [item.id, item]));
  const materials = new Map(scene.materials.map(item => [item.id, item]));
  for (const entity of scene.entities) {
    if (!entity.visible) continue;
    if (!geometries.has(entity.geometryId)) throw new Error('Missing PStudio geometry: ' + entity.geometryId);
    if (!Array.isArray(entity.materialIds) || entity.materialIds.length !== 1) throw new Error('Independent WebGPU scene renderer currently requires exactly one material per entity: ' + entity.id);
    if (!materials.has(entity.materialIds[0])) throw new Error('Missing PStudio material: ' + entity.materialIds[0]);
    const material = materials.get(entity.materialIds[0]);
    if (material.model !== 'pbr' || material.alphaMode !== 'opaque' || Number(material.opacity ?? 1) < 1 || material.doubleSided || material.textures?.length) {
      throw new Error('Independent WebGPU renderer currently requires opaque, single-sided, untextured PBR materials: ' + material.id);
    }
    if (entity.castShadow || entity.receiveShadow) throw new Error('Independent WebGPU renderer does not yet implement shadow casting/receiving: ' + entity.id);
    const geometry = geometries.get(entity.geometryId);
    if (geometry.groups?.length > 1 || geometry.groups?.some(group => group.materialIndex > 0)) throw new Error('Independent WebGPU scene renderer does not yet support multi-material geometry groups: ' + entity.id);
    const drawCount = geometry.indices?.length || geometry.vertexCount;
    if (geometry.groups?.length === 1 && (geometry.groups[0].start !== 0 || geometry.groups[0].count !== drawCount)) throw new Error('Independent WebGPU scene renderer does not yet support partial geometry groups: ' + entity.id);
    if (geometry.indices && !(geometry.indices instanceof Uint16Array) && !(geometry.indices instanceof Uint32Array)) throw new TypeError('Geometry indices must be Uint16Array or Uint32Array.');
  }
  return { geometries, materials };
}
function ensurePipeline(state, api) {
  if (state.pipeline) return;
  const device = api.device;
  if (!device?.createShaderModule || !device?.createRenderPipeline) throw new Error('WebGPU device cannot create graphics pipelines.');
  const module = device.createShaderModule({ label: 'PStudio Independent PBR Scene', code: WGSL });
  const format = api.getCapabilities?.()?.format || 'bgra8unorm';
  state.pipeline = device.createRenderPipeline({
    label: 'PStudio Independent Scene PBR',
    layout: 'auto',
    vertex: {
      module, entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' }
        ]
      }]
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });
  state.frameBuffer = device.createBuffer({ label: 'PStudio Frame Uniforms', size: 128, usage: bufferUsage('UNIFORM') | bufferUsage('COPY_DST') });
  state.frameBindGroup = device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: state.frameBuffer, offset: 0, size: 128 } }]
  });
}
function ensureGeometry(state, device, geometry) {
  const cached = state.geometries.get(geometry.id);
  if (cached && cached.revision === geometry.revision) return cached;
  if (cached) {
    try { cached.vertexBuffer.destroy(); cached.indexBuffer?.destroy(); } catch (_) {}
    state.geometries.delete(geometry.id);
  }
  const vertexData = geometryVertexData(geometry);
  const vertexBuffer = createBuffer(device, vertexData, bufferUsage('VERTEX'), 'PStudio Geometry ' + geometry.id);
  const indices = geometry.indices || null;
  const indexBuffer = indices ? createBuffer(device, indices, bufferUsage('INDEX'), 'PStudio Indices ' + geometry.id) : null;
  const record = Object.freeze({
    revision: geometry.revision, vertexBuffer, indexBuffer,
    indexCount: indices?.length || 0,
    indexFormat: indices instanceof Uint32Array ? 'uint32' : 'uint16',
    vertexCount: geometry.positions.length / 3
  });
  state.geometries.set(geometry.id, record);
  return record;
}
function ensureObject(state, device, entity, material, pipeline) {
  const key = entity.id;
  let record = state.objects.get(key);
  if (!record || record.materialId !== material.id) {
    if (record) { try { record.buffer.destroy(); } catch (_) {} }
    const buffer = device.createBuffer({ label: 'PStudio Object Uniform ' + key, size: 160, usage: bufferUsage('UNIFORM') | bufferUsage('COPY_DST') });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer, offset: 0, size: 160 } }]
    });
    record = { buffer, bindGroup, materialId: material.id };
    state.objects.set(key, record);
  }
  const matrix = matrix4(entity.matrixWorld, 'entity matrixWorld');
  const normal = normalMatrix(matrix);
  const data = new Float32Array(40);
  data.set(matrix, 0);
  data.set([normal[0], normal[1], normal[2], 0], 16);
  data.set([normal[3], normal[4], normal[5], 0], 20);
  data.set([normal[6], normal[7], normal[8], 0], 24);
  data.set(material.baseColor || [1, 1, 1, 1], 28);
  data.set([material.metallic || 0, material.roughness ?? 0.7, 0, material.opacity ?? 1], 32);
  data.set([...(material.emissive || [0, 0, 0]).slice(0, 3).map(value => Number(value)), 0], 36);
  device.queue.writeBuffer(record.buffer, 0, data);
  return record;
}
function updateFrameUniforms(state, device, frame, scene) {
  const vp = viewProjection(frame.view);
  const camera = vector3(frame.view?.cameraPosition || frame.view?.camera?.position, [0, 0, 3]);
  const lighting = scene.lighting || {};
  const sun = normalized3(lighting.sunDirection || scene.sunDirection, [0.35, -0.85, -0.38]);
  const sunColor = vector3(lighting.sunColor, [1, 0.96, 0.9]);
  const ambient = vector3(lighting.ambientColor, [0.12, 0.15, 0.2]);
  const data = new Float32Array(32);
  data.set(vp, 0);
  data.set([camera[0], camera[1], camera[2], 1], 16);
  data.set([sun[0], sun[1], sun[2], Number(lighting.sunIntensity ?? 3)], 20);
  data.set([sunColor[0], sunColor[1], sunColor[2], 1], 24);
  data.set([ambient[0], ambient[1], ambient[2], Number(lighting.ambientIntensity ?? 1)], 28);
  device.queue.writeBuffer(state.frameBuffer, 0, data);
}
function ensureDepthTarget(state, api) {
  const device = api.device, canvas = api.canvas;
  const width = Math.max(1, Number(canvas?.width) || 1), height = Math.max(1, Number(canvas?.height) || 1);
  if (state.depthTexture && state.depthWidth === width && state.depthHeight === height) return;
  try { state.depthTexture?.destroy?.(); } catch (_) {}
  const usage = (globalThis.GPUTextureUsage || TEXTURE_USAGE).RENDER_ATTACHMENT;
  state.depthTexture = device.createTexture({ label: 'PStudio Independent Scene Depth', size: [width, height, 1], format: 'depth24plus', usage });
  state.depthWidth = width;
  state.depthHeight = height;
}
function disposeSceneRuntime(state) {
  for (const record of state.geometries.values()) {
    try { record.vertexBuffer.destroy(); record.indexBuffer?.destroy(); } catch (_) {}
  }
  for (const record of state.objects.values()) try { record.buffer.destroy(); } catch (_) {}
  try { state.frameBuffer?.destroy?.(); state.depthTexture?.destroy?.(); } catch (_) {}
  state.geometries.clear();
  state.objects.clear();
  state.pipeline = null;
  state.frameBuffer = null;
  state.frameBindGroup = null;
  state.depthTexture = null;
  state.depthWidth = 0;
  state.depthHeight = 0;
}

/** Draw a PStudio scene asset through the direct WebGPU API, without a Three.js renderer. */
export function renderPStudioGraphicsSceneFrame(frame, api, state = {}) {
  const scene = frame?.scene;
  if (!scene || scene.kind !== 'pstudio-graphics-scene-asset') return false;
  const { geometries, materials } = validateScene(scene);
  const device = api?.device;
  if (!device?.createCommandEncoder || !api.getCurrentSurfaceView) throw new Error('PStudio WebGPU scene rendering requires a configured WebGPU surface.');
  ensurePipeline(state, api);
  ensureDepthTarget(state, api);
  updateFrameUniforms(state, device, frame, scene);
  const encoder = device.createCommandEncoder({ label: 'PStudio Independent Scene Frame' });
  const pass = encoder.beginRenderPass({
    label: 'PStudio Independent Scene PBR Pass',
    colorAttachments: [{
      view: api.getCurrentSurfaceView(),
      clearValue: scene.clearColor || { r: 0.015, g: 0.025, b: 0.04, a: 1 },
      loadOp: 'clear', storeOp: 'store'
    }],
    depthStencilAttachment: {
      view: state.depthTexture.createView(),
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store'
    }
  });
  pass.setPipeline(state.pipeline);
  pass.setBindGroup(0, state.frameBindGroup);
  for (const entity of scene.entities) {
    if (!entity.visible) continue;
    const geometry = geometries.get(entity.geometryId);
    const material = materials.get(entity.materialIds[0]);
    const gpuGeometry = ensureGeometry(state, device, geometry);
    const gpuObject = ensureObject(state, device, entity, material, state.pipeline);
    pass.setBindGroup(1, gpuObject.bindGroup);
    pass.setVertexBuffer(0, gpuGeometry.vertexBuffer);
    if (gpuGeometry.indexBuffer) {
      pass.setIndexBuffer(gpuGeometry.indexBuffer, gpuGeometry.indexFormat);
      pass.drawIndexed(gpuGeometry.indexCount, 1, 0, 0, 0);
    } else pass.draw(gpuGeometry.vertexCount, 1, 0, 0);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
  return true;
}

/**
 * Backend adapter for PStudio-owned scene assets. Three.js may feed the importer,
 * but no Three.js object or runtime is retained by this renderer.
 */
export function createPStudioWebGPUSceneAdapter(options = {}) {
  const state = { pipeline: null, frameBuffer: null, frameBindGroup: null, depthTexture: null, depthWidth: 0, depthHeight: 0, geometries: new Map(), objects: new Map() };
  const core = createPStudioWebGPUCoreAdapter({
    ...options,
    renderFrame: (frame, backend) => renderPStudioGraphicsSceneFrame(frame, backend, state)
  });
  return Object.freeze({
    descriptor: Object.freeze({
      ...core.descriptor,
      id: String(options.id || 'pstudio.webgpu.independent-scene'),
      priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 250,
      features: Object.freeze(['gpu-resources', 'wgsl', 'pbr-scene', 'depth-buffer', 'direct-webgpu', 'three-independent']),
      metadata: Object.freeze({ implementation: 'PStudio-owned WebGPU PBR scene renderer', vendorNeutral: true, rendererOwnership: 'PStudio' })
    }),
    supports: core.supports,
    async initialize(context = {}) {
      const handle = await core.initialize(context);
      let disposed = false;
      return Object.freeze({
        backend: 'webgpu',
        deviceLost: handle.deviceLost,
        render: frame => !disposed && handle.render(frame),
        resize: (width, height, pixelRatio) => !disposed && handle.resize(width, height, pixelRatio),
        waitIdle: optionsArg => !disposed ? handle.waitIdle(optionsArg) : Promise.resolve(false),
        getCapabilities: () => handle.getCapabilities(),
        dispose() {
          if (disposed) return false;
          disposed = true;
          disposeSceneRuntime(state);
          return handle.dispose() !== false;
        }
      });
    }
  });
}

export const PSTUDIO_WEBGPU_SCENE_WGSL = WGSL;
