import { createPStudioWebGPUCoreAdapter } from './pstudio_graphics_webgpu_backend.mjs';

const BUFFER_USAGE = Object.freeze({ COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
const TEXTURE_USAGE = Object.freeze({ COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
const WGSL = [
'struct LightData {',
'  positionType: vec4<f32>,',
'  directionRange: vec4<f32>,',
'  colorIntensity: vec4<f32>,',
'  cone: vec4<f32>,',
'};',
'struct FrameData {',
'  viewProjection: mat4x4<f32>,',
'  cameraPosition: vec4<f32>,',
'  sunDirection: vec4<f32>,',
'  sunColor: vec4<f32>,',
'  ambientColor: vec4<f32>,',
'  lightCount: vec4<f32>,',
'  lights: array<LightData, 8>,',
'};',
'struct MaterialData {',
'  baseColor: vec4<f32>,',
'  surface: vec4<f32>,',
'  emissiveColor: vec4<f32>,',
'  textureFlags: vec4<f32>,',
'  textureFlags2: vec4<f32>,',
'  materialFlags: vec4<f32>,',
'  physical: vec4<f32>,',
'  sheen: vec4<f32>,',
'  specular: vec4<f32>,',
'  textureTransforms: array<vec4<f32>, 16>,',
'};',
'@group(0) @binding(0) var<uniform> frame: FrameData;',
'@group(1) @binding(0) var<uniform> material: MaterialData;',
'@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;',
'@group(1) @binding(2) var baseColorSampler: sampler;',
'@group(1) @binding(3) var normalTexture: texture_2d<f32>;',
'@group(1) @binding(4) var normalSampler: sampler;',
'@group(1) @binding(5) var metallicRoughnessTexture: texture_2d<f32>;',
'@group(1) @binding(6) var metallicRoughnessSampler: sampler;',
'@group(1) @binding(7) var metalnessTexture: texture_2d<f32>;',
'@group(1) @binding(8) var metalnessSampler: sampler;',
'@group(1) @binding(9) var roughnessTexture: texture_2d<f32>;',
'@group(1) @binding(10) var roughnessSampler: sampler;',
'@group(1) @binding(11) var occlusionTexture: texture_2d<f32>;',
'@group(1) @binding(12) var occlusionSampler: sampler;',
'@group(1) @binding(13) var emissiveTexture: texture_2d<f32>;',
'@group(1) @binding(14) var emissiveSampler: sampler;',
'@group(1) @binding(15) var alphaTexture: texture_2d<f32>;',
'@group(1) @binding(16) var alphaSampler: sampler;',
'fn materialUv(uv: vec2<f32>, transformIndex: u32) -> vec2<f32> {',
'  let transform = material.textureTransforms[transformIndex];',
'  let rotation = material.textureTransforms[transformIndex + 1u];',
'  let scaled = uv * transform.zw;',
'  let cosine = rotation.x;',
'  let sine = rotation.y;',
'  return vec2<f32>(cosine * scaled.x - sine * scaled.y, sine * scaled.x + cosine * scaled.y) + transform.xy;',
'};',
'struct VertexInput {',
'  @location(0) position: vec3<f32>,',
'  @location(1) normal: vec3<f32>,',
'  @location(2) uv: vec2<f32>,',
'  @location(3) uv2: vec2<f32>,',
'  @location(4) model0: vec4<f32>,',
'  @location(5) model1: vec4<f32>,',
'  @location(6) model2: vec4<f32>,',
'  @location(7) model3: vec4<f32>,',
'  @location(8) normal0: vec4<f32>,',
'  @location(9) normal1: vec4<f32>,',
'  @location(10) normal2: vec4<f32>,',
'};',
'struct VertexOutput {',
'  @builtin(position) clipPosition: vec4<f32>,',
'  @location(0) worldPosition: vec3<f32>,',
'  @location(1) worldNormal: vec3<f32>,',
'  @location(2) uv: vec2<f32>,',
'  @location(3) uv2: vec2<f32>,',
'};',
'@vertex fn vs_main(input: VertexInput) -> VertexOutput {',
'  var output: VertexOutput;',
'  let model = mat4x4<f32>(input.model0, input.model1, input.model2, input.model3);',
'  let normalMatrix = mat3x3<f32>(input.normal0.xyz, input.normal1.xyz, input.normal2.xyz);',
'  let world = model * vec4<f32>(input.position, 1.0);',
'  output.clipPosition = frame.viewProjection * world;',
'  output.worldPosition = world.xyz;',
'  output.worldNormal = normalize(normalMatrix * input.normal);',
'  output.uv = input.uv;',
'  output.uv2 = input.uv2;',
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
'fn evaluateDirectBRDF(baseColor: vec3<f32>, metallic: f32, roughness: f32, normal: vec3<f32>, viewDirection: vec3<f32>, lightDirection: vec3<f32>, radiance: vec3<f32>) -> vec3<f32> {',
'  let n = normalize(normal);',
'  let v = normalize(viewDirection);',
'  let l = normalize(lightDirection);',
'  let h = normalize(v + l);',
'  let nDotV = max(dot(n, v), 0.0001);',
'  let nDotL = max(dot(n, l), 0.0);',
'  if (nDotL <= 0.0) { return vec3<f32>(0.0); }',
'  let nDotH = max(dot(n, h), 0.0);',
'  let vDotH = max(dot(v, h), 0.0);',
'  let f0 = mix(vec3<f32>(0.04), baseColor, metallic);',
'  let fresnel = fresnelSchlick(vDotH, f0);',
'  let distribution = distributionGGX(nDotH, roughness);',
'  let geometry = geometrySchlick(nDotV, roughness) * geometrySchlick(nDotL, roughness);',
'  let specular = distribution * geometry * fresnel / max(4.0 * nDotV * nDotL, 0.001);',
'  let diffuse = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic) * baseColor / 3.14159265;',
'  return (diffuse + specular) * radiance * nDotL;',
'}',
'@fragment fn fs_main(input: VertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {',
'  var texel = vec4<f32>(1.0);',
'  if (material.textureFlags.x > 0.5) { texel = textureSample(baseColorTexture, baseColorSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[1].z > 0.5), 0u)); }',
'  let albedo = max(material.baseColor.rgb * texel.rgb, vec3<f32>(0.0));',
'  var metallic = clamp(material.surface.x, 0.0, 1.0);',
'  var roughness = clamp(material.surface.y, 0.045, 1.0);',
'  if (material.textureFlags.z > 0.5) {',
'    let packed = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[5].z > 0.5), 4u));',
'    roughness *= packed.g;',
'    metallic *= packed.b;',
'  }',
'  if (material.textureFlags2.y > 0.5) { metallic *= textureSample(metalnessTexture, metalnessSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[7].z > 0.5), 6u)).g; }',
'  if (material.textureFlags2.z > 0.5) { roughness *= textureSample(roughnessTexture, roughnessSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[9].z > 0.5), 8u)).g; }',
'  var n = normalize(input.worldNormal);',
'  if (material.textureFlags.y > 0.5) {',
'    let normalUv = materialUv(select(input.uv, input.uv2, material.textureTransforms[3].z > 0.5), 2u);',
'    let mapped = textureSample(normalTexture, normalSampler, normalUv).xyz * 2.0 - vec3<f32>(1.0);',
'    let dp1 = dpdx(input.worldPosition);',
'    let dp2 = dpdy(input.worldPosition);',
'    let duv1 = dpdx(normalUv);',
'    let duv2 = dpdy(normalUv);',
'    let tangent = normalize(dp1 * duv2.y - dp2 * duv1.y);',
'    let bitangent = normalize(-dp1 * duv2.x + dp2 * duv1.x);',
'    n = normalize(mat3x3<f32>(tangent, bitangent, n) * vec3<f32>(mapped.xy * material.surface.z, mapped.z));',
'  }',
'  if (!frontFacing) {',
'    if (material.materialFlags.y > 0.5) { n = -n; } else { discard; }',
'  }',
'  let v = normalize(frame.cameraPosition.xyz - input.worldPosition);',
'  var direct = evaluateDirectBRDF(albedo, metallic, roughness, n, v, -frame.sunDirection.xyz, frame.sunColor.rgb * frame.sunColor.w);',
'  for (var index: u32 = 0u; index < 8u; index += 1u) {',
'    if (f32(index) < frame.lightCount.x) {',
'      let light = frame.lights[index];',
'      var lightDirection = -light.directionRange.xyz;',
'      var attenuation = 1.0;',
'      if (light.positionType.w > 0.5) {',
'        let toLight = light.positionType.xyz - input.worldPosition;',
'        let distance = length(toLight);',
'        lightDirection = toLight / max(distance, 0.0001);',
'        attenuation = 1.0 / max(distance * distance, 1.0);',
'        if (light.directionRange.w > 0.0) { attenuation *= 1.0 - smoothstep(light.directionRange.w * 0.8, light.directionRange.w, distance); }',
'        if (light.positionType.w > 1.5) {',
'          let fromLight = normalize(input.worldPosition - light.positionType.xyz);',
'          attenuation *= smoothstep(light.cone.y, light.cone.x, dot(fromLight, normalize(light.directionRange.xyz)));',
'        }',
'      }',
'      direct += evaluateDirectBRDF(albedo, metallic, roughness, n, v, lightDirection, light.colorIntensity.rgb * light.colorIntensity.w * attenuation);',
'    }',
'  }',
'  var ambientOcclusion = 1.0;',
'  if (material.textureFlags.w > 0.5) {',
'    let ao = textureSample(occlusionTexture, occlusionSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[11].z > 0.5), 10u)).r;',
'    ambientOcclusion = mix(1.0, ao, material.materialFlags.z);',
'  }',
'  let ambient = albedo * frame.ambientColor.rgb * frame.ambientColor.w * (1.0 - metallic) * ambientOcclusion;',
'  var emissive = material.emissiveColor.rgb;',
'  if (material.textureFlags2.x > 0.5) { emissive *= textureSample(emissiveTexture, emissiveSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[13].z > 0.5), 12u)).rgb; }',
'  let clearcoat = clamp(material.physical.x, 0.0, 1.0);',
'  if (clearcoat > 0.0) { direct += clearcoat * evaluateDirectBRDF(vec3<f32>(0.04), 0.0, max(material.physical.y, 0.045), n, v, -frame.sunDirection.xyz, frame.sunColor.rgb * frame.sunColor.w); }',
'  let sheenColor = material.sheen.rgb * material.sheen.a;',
'  let sheenResponse = pow(1.0 - max(dot(n, v), 0.0), 5.0);',
'  direct += sheenColor * sheenResponse * (1.0 - roughness) * 0.25;',
'  let specularTint = mix(vec3<f32>(1.0), material.specular.rgb, clamp(material.specular.a, 0.0, 1.0));',
'  direct *= specularTint;',
'  if (material.materialFlags.x > 0.5) { direct = vec3<f32>(0.0); ambient = vec3<f32>(0.0); }',
'  let linearColor = max((material.materialFlags.x > 0.5 ? albedo : direct + ambient) + emissive * material.emissiveColor.a, vec3<f32>(0.0));',
'  let mapped = linearColor / (linearColor + vec3<f32>(1.0));',
'  let srgb = select(1.055 * pow(mapped, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), mapped * 12.92, mapped <= vec3<f32>(0.0031308));',
'  var alpha = material.baseColor.a * material.surface.w * texel.a;',
'  if (material.textureFlags2.w > 0.5) { alpha *= textureSample(alphaTexture, alphaSampler, materialUv(select(input.uv, input.uv2, material.textureTransforms[15].z > 0.5), 14u)).g; }',
'  if (material.physical.w > 0.5 && material.physical.w < 1.5 && alpha < material.materialFlags.w) { discard; }',
'  return vec4<f32>(srgb, alpha);',
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
  const uv2s = geometry.uv2s || new Float32Array((positions.length / 3) * 2);
  if (uv2s.length !== positions.length / 3 * 2) throw new TypeError('PStudio WebGPU renderer received an invalid secondary UV set.');
  const vertices = new Float32Array((positions.length / 3) * 10);
  for (let index = 0, vertex = 0; index < positions.length / 3; index += 1, vertex += 10) {
    vertices[vertex] = positions[index * 3];
    vertices[vertex + 1] = positions[index * 3 + 1];
    vertices[vertex + 2] = positions[index * 3 + 2];
    vertices[vertex + 3] = normals[index * 3];
    vertices[vertex + 4] = normals[index * 3 + 1];
    vertices[vertex + 5] = normals[index * 3 + 2];
    vertices[vertex + 6] = uvs[index * 2];
    vertices[vertex + 7] = uvs[index * 2 + 1];
    vertices[vertex + 8] = uv2s[index * 2];
    vertices[vertex + 9] = uv2s[index * 2 + 1];
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
  const textures = new Map((scene.textures || []).map(item => [item.id, item]));
  for (const texture of textures.values()) {
    if (!Number.isSafeInteger(Number(texture.width)) || Number(texture.width) < 1 ||
        !Number.isSafeInteger(Number(texture.height)) || Number(texture.height) < 1 ||
        !(texture.data instanceof Uint8Array) || texture.data.length !== texture.width * texture.height * 4) {
      throw new TypeError('PStudio scene contains an invalid RGBA8 texture: ' + texture.id);
    }
  }
  for (const entity of scene.entities) {
    if (!entity.visible) continue;
    if (!geometries.has(entity.geometryId)) throw new Error('Missing PStudio geometry: ' + entity.geometryId);
    if (!Array.isArray(entity.materialIds) || !entity.materialIds.length) throw new Error('Independent WebGPU scene renderer requires at least one material slot per entity: ' + entity.id);
    const geometry = geometries.get(entity.geometryId);
    const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: geometry.indices?.length || geometry.vertexCount, materialIndex: 0 }];
    if (!geometry.groups?.length && entity.materialIds.length !== 1) throw new Error('Multiple entity materials require explicit geometry material groups: ' + entity.id);
    for (const group of groups) {
      if (group.materialIndex >= entity.materialIds.length) throw new Error('Geometry material group references a missing entity material slot: ' + entity.id);
      const materialId = entity.materialIds[group.materialIndex];
      if (!materials.has(materialId)) throw new Error('Missing PStudio material: ' + materialId);
      const material = materials.get(materialId);
      if (!['pbr', 'unlit'].includes(material.model) || material.textures?.length) {
        throw new Error('Independent WebGPU renderer requires PStudio PBR or unlit material records without legacy opaque texture feature flags: ' + material.id);
      }
      for (const [slot, textureId] of Object.entries(material.textureIds || { baseColor: material.baseColorTextureId })) {
        if (textureId && !textures.has(textureId)) throw new Error('PStudio material references a missing ' + slot + ' texture: ' + textureId);
      }
    }
    if (entity.skinId || geometry.jointIndices || geometry.jointWeights) {
      throw new Error('Independent WebGPU scene renderer does not yet execute skeletal skinning: ' + entity.id);
    }
    if (geometry.morphTargets?.length || entity.morphWeights?.length) {
      throw new Error('Independent WebGPU scene renderer does not yet execute morph-target deformation: ' + entity.id);
    }
    if (entity.castShadow || entity.receiveShadow) throw new Error('Independent WebGPU renderer does not yet implement shadow casting/receiving: ' + entity.id);
    if (geometry.indices && !(geometry.indices instanceof Uint16Array) && !(geometry.indices instanceof Uint32Array)) throw new TypeError('Geometry indices must be Uint16Array or Uint32Array.');
  }
  if ((scene.lighting?.lights || []).length > 8) throw new RangeError('Independent WebGPU renderer supports up to eight additional scene lights.');
  return { geometries, materials, textures };
}
function ensurePipeline(state, api) {
  if (state.pipeline && state.pipelineTransparent) return;
  const device = api.device;
  if (!device?.createShaderModule || !device?.createRenderPipeline ||
      !device?.createBindGroupLayout || !device?.createPipelineLayout) {
    throw new Error('WebGPU device cannot create PStudio material layouts and graphics pipelines.');
  }
  const module = device.createShaderModule({ label: 'PStudio Independent PBR Scene', code: WGSL });
  const format = api.getCapabilities?.()?.format || 'bgra8unorm';
  const shaderStage = globalThis.GPUShaderStage || { VERTEX: 1, FRAGMENT: 2 };
  const visibility = shaderStage.VERTEX | shaderStage.FRAGMENT;
  state.frameLayout = device.createBindGroupLayout({
    label: 'PStudio Frame Bind Group Layout',
    entries: [{ binding: 0, visibility, buffer: { type: 'uniform', minBindingSize: 656 } }]
  });
  const materialEntries = [
    { binding: 0, visibility: shaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 400 } }
  ];
  for (let slot = 0; slot < 8; slot += 1) {
    materialEntries.push({ binding: 1 + slot * 2, visibility: shaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } });
    materialEntries.push({ binding: 2 + slot * 2, visibility: shaderStage.FRAGMENT, sampler: { type: 'filtering' } });
  }
  state.materialLayout = device.createBindGroupLayout({ label: 'PStudio Material Bind Group Layout', entries: materialEntries });
  state.pipelineLayout = device.createPipelineLayout({ label: 'PStudio Scene Pipeline Layout', bindGroupLayouts: [state.frameLayout, state.materialLayout] });
  const vertex = {
    module, entryPoint: 'vs_main',
    buffers: [{
      arrayStride: 40, stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'float32x2' }
      ]
    }, {
      arrayStride: 112, stepMode: 'instance',
      attributes: [
        { shaderLocation: 4, offset: 0, format: 'float32x4' },
        { shaderLocation: 5, offset: 16, format: 'float32x4' },
        { shaderLocation: 6, offset: 32, format: 'float32x4' },
        { shaderLocation: 7, offset: 48, format: 'float32x4' },
        { shaderLocation: 8, offset: 64, format: 'float32x4' },
        { shaderLocation: 9, offset: 80, format: 'float32x4' },
        { shaderLocation: 10, offset: 96, format: 'float32x4' }
      ]
    }]
  };
  const primitive = { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' };
  const depthStencil = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
  state.pipeline = device.createRenderPipeline({
    label: 'PStudio Independent Scene PBR Opaque',
    layout: state.pipelineLayout, vertex,
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive, depthStencil
  });
  state.pipelineTransparent = device.createRenderPipeline({
    label: 'PStudio Independent Scene PBR Transparent',
    layout: state.pipelineLayout, vertex,
    fragment: {
      module, entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        }
      }]
    },
    primitive,
    depthStencil: { ...depthStencil, depthWriteEnabled: false }
  });
  state.frameBuffer = device.createBuffer({
    label: 'PStudio Frame Uniforms', size: 656,
    usage: bufferUsage('UNIFORM') | bufferUsage('COPY_DST')
  });
  state.frameBindGroup = device.createBindGroup({
    layout: state.frameLayout,
    entries: [{ binding: 0, resource: { buffer: state.frameBuffer, offset: 0, size: 656 } }]
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
function ensureTexture(state, device, texture) {
  const cached = state.textures.get(texture.id);
  if (cached && cached.revision === texture.revision && cached.fingerprint === texture.fingerprint) return cached;
  if (cached) {
    try { cached.texture.destroy(); } catch (_) {}
    state.textures.delete(texture.id);
  }
  const gpuTexture = device.createTexture({
    label: 'PStudio Texture ' + texture.id,
    size: [texture.width, texture.height, 1],
    format: texture.format || 'rgba8unorm-srgb',
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST
  });
  device.queue.writeTexture(
    { texture: gpuTexture },
    texture.data,
    { bytesPerRow: texture.width * 4, rowsPerImage: texture.height },
    { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
  );
  const record = Object.freeze({ revision: texture.revision, fingerprint: texture.fingerprint, texture: gpuTexture, view: gpuTexture.createView() });
  state.textures.set(texture.id, record);
  return record;
}

function ensureWhiteTexture(state, device) {
  const id = '__pstudio-white-base-color';
  const cached = state.textures.get(id);
  if (cached) return cached;
  const texture = device.createTexture({
    label: 'PStudio White Base Color',
    size: [1, 1, 1],
    format: 'rgba8unorm-srgb',
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST
  });
  device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: 1 });
  const record = Object.freeze({ revision: 1, texture, view: texture.createView() });
  state.textures.set(id, record);
  return record;
}

function ensureMaterial(state, device, material, pipeline, textures) {
  const textureAsset = material.baseColorTextureId ? textures.get(material.baseColorTextureId) : null;
  const signature = JSON.stringify({
    baseColor: material.baseColor, emissive: material.emissive, metallic: material.metallic,
    roughness: material.roughness, opacity: material.opacity, baseColorTextureId: material.baseColorTextureId,
    textureRevision: textureAsset?.revision || 0, textureFingerprint: textureAsset?.fingerprint || 0,
    addressModeU: textureAsset?.addressModeU || 'repeat', addressModeV: textureAsset?.addressModeV || 'repeat',
    magFilter: textureAsset?.magFilter || 'linear', minFilter: textureAsset?.minFilter || 'linear'
  });
  let record = state.materials.get(material.id);
  if (record && record.signature !== signature) {
    try { record.buffer.destroy(); } catch (_) {}
    state.materials.delete(material.id);
    record = null;
  }
  if (!record) {
    const buffer = device.createBuffer({
      label: 'PStudio Material Uniform ' + material.id,
      size: 48,
      usage: bufferUsage('UNIFORM') | bufferUsage('COPY_DST')
    });
    const gpuTexture = textureAsset ? ensureTexture(state, device, textureAsset) : ensureWhiteTexture(state, device);
    const sampler = device.createSampler({
      addressModeU: textureAsset?.addressModeU || 'repeat',
      addressModeV: textureAsset?.addressModeV || 'repeat',
      magFilter: textureAsset?.magFilter || 'linear',
      minFilter: textureAsset?.minFilter || 'linear',
      mipmapFilter: 'nearest',
      lodMinClamp: 0,
      lodMaxClamp: 0,
      maxAnisotropy: 1
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: 48 } },
        { binding: 1, resource: gpuTexture.view },
        { binding: 2, resource: sampler }
      ]
    });
    record = { buffer, bindGroup, sampler, signature };
    state.materials.set(material.id, record);
  }
  const data = new Float32Array(12);
  data.set(material.baseColor || [1, 1, 1, 1], 0);
  data.set([material.metallic || 0, material.roughness ?? 0.7, material.baseColorTextureId ? 1 : 0, material.opacity ?? 1], 4);
  data.set([...(material.emissive || [0, 0, 0]).slice(0, 3).map(Number), 0], 8);
  device.queue.writeBuffer(record.buffer, 0, data);
  return record;
}

function ensureInstanceBatch(state, device, key, entities) {
  const instanceCount = entities.length;
  const floatsPerInstance = 28;
  const bytesPerInstance = floatsPerInstance * Float32Array.BYTES_PER_ELEMENT;
  let record = state.instances.get(key);
  if (!record || record.capacity < instanceCount) {
    try { record?.buffer?.destroy?.(); } catch (_) {}
    let capacity = 1;
    while (capacity < instanceCount) capacity *= 2;
    const buffer = device.createBuffer({
      label: 'PStudio Instance Batch ' + key,
      size: capacity * bytesPerInstance,
      usage: bufferUsage('VERTEX') | bufferUsage('COPY_DST')
    });
    record = { buffer, capacity };
    state.instances.set(key, record);
  }
  const data = new Float32Array(instanceCount * floatsPerInstance);
  for (let index = 0; index < instanceCount; index += 1) {
    const entity = entities[index];
    const offset = index * floatsPerInstance;
    const matrix = matrix4(entity.matrixWorld, 'entity matrixWorld');
    const normal = normalMatrix(matrix);
    data.set(matrix, offset);
    data.set([normal[0], normal[1], normal[2], 0], offset + 16);
    data.set([normal[3], normal[4], normal[5], 0], offset + 20);
    data.set([normal[6], normal[7], normal[8], 0], offset + 24);
  }
  device.queue.writeBuffer(record.buffer, 0, data);
  return Object.freeze({ buffer: record.buffer, instanceCount });
}

function pruneSceneCaches(state, activeGeometryIds, activeMaterialIds, activeBatchKeys, activeTextureIds) {
  for (const [id, record] of state.geometries) {
    if (activeGeometryIds.has(id)) continue;
    try { record.vertexBuffer.destroy(); record.indexBuffer?.destroy(); } catch (_) {}
    state.geometries.delete(id);
  }
  for (const [id, record] of state.materials) {
    if (activeMaterialIds.has(id)) continue;
    try { record.buffer.destroy(); } catch (_) {}
    state.materials.delete(id);
  }
  for (const [key, record] of state.instances) {
    if (activeBatchKeys.has(key)) continue;
    try { record.buffer.destroy(); } catch (_) {}
    state.instances.delete(key);
  }
  for (const [id, record] of state.textures) {
    if (activeTextureIds.has(id)) continue;
    try { record.texture.destroy(); } catch (_) {}
    state.textures.delete(id);
  }
}

function updateFrameUniforms(state, device, frame, scene) {
  const vp = viewProjection(frame.view);
  const camera = vector3(frame.view?.cameraPosition || frame.view?.camera?.position, [0, 0, 3]);
  const lighting = scene.lighting || {};
  const sun = normalized3(lighting.sunDirection || scene.sunDirection, [0.35, -0.85, -0.38]);
  const sunColor = vector3(lighting.sunColor, [1, 0.96, 0.9]);
  const ambient = vector3(lighting.ambientColor, [0.12, 0.15, 0.2]);
  const lights = lighting.lights || [];
  if (lights.length > 8) throw new RangeError('PStudio direct renderer supports up to eight additional scene lights.');
  const data = new Float32Array(164);
  data.set(vp, 0);
  data.set([camera[0], camera[1], camera[2], 1], 16);
  data.set([sun[0], sun[1], sun[2], Number(lighting.sunIntensity ?? 3)], 20);
  data.set([sunColor[0], sunColor[1], sunColor[2], Number(lighting.sunIntensity ?? 3)], 24);
  data.set([ambient[0], ambient[1], ambient[2], Number(lighting.ambientIntensity ?? 1)], 28);
  data.set([lights.length, 0, 0, 0], 32);
  lights.forEach((light, index) => {
    const offset = 36 + index * 16;
    const type = light.type === 'point' ? 1 : light.type === 'spot' ? 2 : 0;
    data.set([...(light.position || [0, 0, 0]), type], offset);
    data.set([...(light.direction || [0, -1, 0]), Number(light.range || 0)], offset + 4);
    data.set([...(light.color || [1, 1, 1]), Number(light.intensity ?? 1)], offset + 8);
    data.set([Number(light.innerConeCos ?? 0.9), Number(light.outerConeCos ?? 0.8), 0, 0], offset + 12);
  });
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
  for (const record of state.materials.values()) try { record.buffer.destroy(); } catch (_) {}
  for (const record of state.instances.values()) try { record.buffer.destroy(); } catch (_) {}
  for (const record of state.textures.values()) try { record.texture.destroy(); } catch (_) {}
  try { state.frameBuffer?.destroy?.(); state.depthTexture?.destroy?.(); } catch (_) {}
  state.geometries.clear();
  state.materials.clear();
  state.instances.clear();
  state.textures.clear();
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
  state = state && typeof state === 'object' ? state : {};
  state.geometries ||= new Map();
  state.materials ||= new Map();
  state.instances ||= new Map();
  state.textures ||= new Map();
  const { geometries, materials, textures } = validateScene(scene);
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

  // One draw per unique geometry/material pair, with transforms supplied as
  // instance-rate vertex data. This reduces CPU submission and bind-group churn
  // for repeated assets such as foliage, props and modular scene pieces.
  const batches = new Map();
  const activeGeometryIds = new Set();
  const activeMaterialIds = new Set();
  const activeBatchKeys = new Set();
  const activeTextureIds = new Set();
  for (const entity of scene.entities) {
    if (!entity.visible) continue;
    const geometry = geometries.get(entity.geometryId);
    const drawGroups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: geometry.indices?.length || geometry.vertexCount, materialIndex: 0 }];
    for (const group of drawGroups) {
      const materialId = entity.materialIds[group.materialIndex];
      const key = JSON.stringify([entity.geometryId, materialId, group.start, group.count]);
      let batch = batches.get(key);
      if (!batch) {
        batch = { key, geometryId: entity.geometryId, materialId, start: group.start, count: group.count, entities: [] };
        batches.set(key, batch);
      }
      batch.entities.push(entity);
      activeGeometryIds.add(entity.geometryId);
      activeMaterialIds.add(materialId);
      const material = materials.get(materialId);
      if (material.baseColorTextureId) activeTextureIds.add(material.baseColorTextureId);
      else activeTextureIds.add('__pstudio-white-base-color');
      activeBatchKeys.add(key);
    }
  }
  pruneSceneCaches(state, activeGeometryIds, activeMaterialIds, activeBatchKeys, activeTextureIds);
  for (const batch of batches.values()) {
    const geometry = geometries.get(batch.geometryId);
    const material = materials.get(batch.materialId);
    const gpuGeometry = ensureGeometry(state, device, geometry);
    const gpuMaterial = ensureMaterial(state, device, material, state.pipeline, textures);
    const gpuInstances = ensureInstanceBatch(state, device, batch.key, batch.entities);
    pass.setBindGroup(1, gpuMaterial.bindGroup);
    pass.setVertexBuffer(0, gpuGeometry.vertexBuffer);
    pass.setVertexBuffer(1, gpuInstances.buffer);
    if (gpuGeometry.indexBuffer) {
      pass.setIndexBuffer(gpuGeometry.indexBuffer, gpuGeometry.indexFormat);
      pass.drawIndexed(batch.count, gpuInstances.instanceCount, batch.start, 0, 0);
    } else pass.draw(batch.count, gpuInstances.instanceCount, batch.start, 0);
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
  const state = { pipeline: null, frameBuffer: null, frameBindGroup: null, depthTexture: null, depthWidth: 0, depthHeight: 0, geometries: new Map(), materials: new Map(), textures: new Map(), instances: new Map() };
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
