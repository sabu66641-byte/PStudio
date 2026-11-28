/**
 * PStudio-owned rendering-quality layer for the direct WebGPU Graphics Core.
 * Opt-in only: this module does not modify legacy Three.js/TSL production materials.
 */
export const PSTUDIO_GRAPHICS_QUALITY_WGSL = String.raw\`
const PSTUDIO_QUALITY_PI: f32 = 3.141592653589793;

fn pstudioQualityDistributionGGX(nDotH: f32, roughness: f32) -> f32 {
    let alpha = max(roughness * roughness, 0.0025);
    let alpha2 = alpha * alpha;
    let d = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
    return alpha2 / max(PSTUDIO_QUALITY_PI * d * d, 0.000001);
}
fn pstudioQualityGeometrySchlick(nDot: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = r * r * 0.125;
    return nDot / max(nDot * (1.0 - k) + k, 0.000001);
}
fn pstudioQualityFresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
    let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
    return f0 + (vec3<f32>(1.0) - f0) * f;
}
fn pstudioQualityDirectBRDF(
    baseColor: vec3<f32>, metallic: f32, roughness: f32,
    normal: vec3<f32>, viewDirection: vec3<f32>,
    lightDirection: vec3<f32>, radiance: vec3<f32>
) -> vec3<f32> {
    let n = normalize(normal);
    let v = normalize(viewDirection);
    let l = normalize(lightDirection);
    let h = normalize(v + l);
    let nDotV = max(dot(n, v), 0.0001);
    let nDotL = max(dot(n, l), 0.0);
    let nDotH = max(dot(n, h), 0.0);
    let vDotH = max(dot(v, h), 0.0);
    let m = clamp(metallic, 0.0, 1.0);
    let r = clamp(roughness, 0.045, 1.0);
    let f0 = mix(vec3<f32>(0.04), baseColor, m);
    let f = pstudioQualityFresnelSchlick(vDotH, f0);
    let d = pstudioQualityDistributionGGX(nDotH, r);
    let g = pstudioQualityGeometrySchlick(nDotV, r) * pstudioQualityGeometrySchlick(nDotL, r);
    let specular = (d * g * f) / max(4.0 * nDotV * max(nDotL, 0.0001), 0.0001);
    let diffuseWeight = (vec3<f32>(1.0) - f) * (1.0 - m);
    let diffuse = diffuseWeight * baseColor / PSTUDIO_QUALITY_PI;
    return (diffuse + specular) * radiance * nDotL;
}
fn pstudioQualityIndirect(
    baseColor: vec3<f32>, metallic: f32, roughness: f32,
    normal: vec3<f32>, viewDirection: vec3<f32>,
    diffuseIrradiance: vec3<f32>, prefilteredSpecular: vec3<f32>,
    brdfLookup: vec2<f32>, occlusion: f32
) -> vec3<f32> {
    let n = normalize(normal);
    let v = normalize(viewDirection);
    let nDotV = max(dot(n, v), 0.0);
    let m = clamp(metallic, 0.0, 1.0);
    let f0 = mix(vec3<f32>(0.04), baseColor, m);
    let f = pstudioQualityFresnelSchlick(nDotV, f0);
    let diffuse = diffuseIrradiance * baseColor * (1.0 - m) / PSTUDIO_QUALITY_PI;
    let specular = prefilteredSpecular * (f * brdfLookup.x + brdfLookup.y);
    return (diffuse + specular) * clamp(occlusion, 0.0, 1.0);
}
fn pstudioQualityShadowCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
    if (viewDepth <= splits.x) { return 0u; }
    if (viewDepth <= splits.y) { return 1u; }
    if (viewDepth <= splits.z) { return 2u; }
    return 3u;
}
fn pstudioQualityPCF3x3(
    shadowMap: texture_depth_2d, shadowSampler: sampler_comparison,
    uv: vec2<f32>, referenceDepth: f32, bias: f32
) -> f32 {
    let dimensions = vec2<f32>(textureDimensions(shadowMap));
    let texel = 1.0 / max(dimensions, vec2<f32>(1.0));
    var visibility = 0.0;
    for (var y: i32 = -1; y <= 1; y += 1) {
        for (var x: i32 = -1; x <= 1; x += 1) {
            let offset = vec2<f32>(f32(x), f32(y)) * texel;
            visibility += textureSampleCompare(shadowMap, shadowSampler,
                clamp(uv + offset, vec2<f32>(0.0), vec2<f32>(1.0)),
                referenceDepth - max(bias, 0.0));
        }
    }
    return visibility / 9.0;
}
fn pstudioQualityACES(color: vec3<f32>, exposure: f32) -> vec3<f32> {
    let x = max(color * max(exposure, 0.0), vec3<f32>(0.0));
    return clamp((x * (2.51 * x + 0.03)) / max(x * (2.43 * x + 0.59) + 0.14, vec3<f32>(0.000001)), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn pstudioQualityLinearToSRGB(value: vec3<f32>) -> vec3<f32> {
    let x = max(value, vec3<f32>(0.0));
    let low = x * 12.92;
    let high = 1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, x <= vec3<f32>(0.0031308));
}
\`;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, finite(value, fallback)));
const normalize3 = value => {
  const v = Array.isArray(value) ? value.slice(0, 3).map(item => finite(item)) : [0, 1, 0];
  while (v.length < 3) v.push(0);
  const length = Math.hypot(...v);
  return length > 1e-8 ? v.map(item => item / length) : [0, 1, 0];
};

export function selectPStudioShadowCascade(viewDepth, splits) {
  if (!Array.isArray(splits) && !ArrayBuffer.isView(splits)) throw new TypeError('Cascade splits must be an array or typed array.');
  if (splits.length !== 4) throw new TypeError('Exactly four cascade split distances are required.');
  const values = Array.from(splits, Number);
  if (!values.every(Number.isFinite) || values.some((value, index) => value <= 0 || (index && value <= values[index - 1]))) {
    throw new RangeError('Cascade split distances must be finite, positive and strictly increasing.');
  }
  const depth = finite(viewDepth, NaN);
  if (!Number.isFinite(depth) || depth < 0) throw new RangeError('View depth must be finite and non-negative.');
  const index = values.findIndex(value => depth <= value);
  return index < 0 ? 3 : index;
}

export function evaluatePStudioGGXReference(input = {}) {
  const n = normalize3(input.normal), v = normalize3(input.viewDirection), l = normalize3(input.lightDirection);
  const h = normalize3(v.map((value, index) => value + l[index]));
  const ndv = Math.max(0.0001, n.reduce((sum, value, i) => sum + value * v[i], 0));
  const ndl = Math.max(0, n.reduce((sum, value, i) => sum + value * l[i], 0));
  const ndh = Math.max(0, n.reduce((sum, value, i) => sum + value * h[i], 0));
  const vdh = Math.max(0, v.reduce((sum, value, i) => sum + value * h[i], 0));
  const metallic = clamp(input.metallic, 0, 1), roughness = clamp(input.roughness, 0.045, 1, 0.5);
  const base = (Array.isArray(input.baseColor) ? input.baseColor : [1, 1, 1]).slice(0, 3).map(value => clamp(value, 0, 1));
  const radiance = (Array.isArray(input.radiance) ? input.radiance : [1, 1, 1]).slice(0, 3).map(value => Math.max(0, finite(value)));
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const denominator = ndh * ndh * (alpha2 - 1) + 1;
  const distribution = alpha2 / Math.max(Math.PI * denominator * denominator, 1e-6);
  const k = (roughness + 1) ** 2 / 8;
  const geometry = (ndv / Math.max(ndv * (1 - k) + k, 1e-6)) * (ndl / Math.max(ndl * (1 - k) + k, 1e-6));
  const f0 = base.map(value => 0.04 * (1 - metallic) + value * metallic);
  const fresnel = f0.map(value => value + (1 - value) * (1 - vdh) ** 5);
  const specular = fresnel.map(value => distribution * geometry * value / Math.max(4 * ndv * Math.max(ndl, 1e-4), 1e-4));
  return Object.freeze(base.map((value, index) => {
    const diffuse = (1 - fresnel[index]) * (1 - metallic) * value / Math.PI;
    return (diffuse + specular[index]) * radiance[index] * ndl;
  }));
}

export function applyPStudioACESReference(color, exposure = 1) {
  const e = Math.max(0, finite(exposure, 1));
  return Object.freeze((Array.isArray(color) ? color : [0, 0, 0]).slice(0, 3).map(value => {
    const x = Math.max(0, finite(value)) * e;
    return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / Math.max(x * (2.43 * x + 0.59) + 0.14, 1e-6)));
  }));
}

export function packPStudioQualityMaterial(input = {}) {
  const color = (Array.isArray(input.baseColor) ? input.baseColor : [1, 1, 1, 1]).slice(0, 4);
  while (color.length < 4) color.push(1);
  const emissive = (Array.isArray(input.emissive) ? input.emissive : [0, 0, 0]).slice(0, 3);
  while (emissive.length < 3) emissive.push(0);
  return new Float32Array([...color.map(value => clamp(value, 0, 1)),
    clamp(input.roughness, 0.045, 1, 0.6), ...emissive.map(value => Math.max(0, finite(value))),
    clamp(input.metallic, 0, 1), clamp(input.occlusion, 0, 1, 1), clamp(input.alphaCutoff, 0, 1, 0.5), 0]);
}

