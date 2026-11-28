/**
 * WGSL lighting ABI for PStudio Graphics Core.
 * Light record layout is four vec4<f32> values (16 floats / 64 bytes) plus a u32 layer mask.
 * The cluster offset array contains clusterCount + 1 entries; cluster indices address the
 * packed light-record array. This module supplies direct-light BRDF evaluation; IBL, shadows,
 * tone mapping and material-specific artistic response remain separate pipeline stages.
 */
export const PSTUDIO_PBR_LIGHTING_WGSL = String.raw`
const PSTUDIO_PI: f32 = 3.141592653589793;

@group(1) @binding(0) var<storage, read> pstudioLightRecords: array<vec4<f32>>;
@group(1) @binding(1) var<storage, read> pstudioLightLayerMasks: array<u32>;
@group(1) @binding(2) var<storage, read> pstudioClusterOffsets: array<u32>;
@group(1) @binding(3) var<storage, read> pstudioClusterLightIndices: array<u32>;

fn pstudioDistributionGGX(nDotH: f32, roughness: f32) -> f32 {
    let alpha = max(roughness * roughness, 0.0025);
    let alpha2 = alpha * alpha;
    let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
    return alpha2 / max(PSTUDIO_PI * denominator * denominator, 0.000001);
}

fn pstudioGeometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return nDotV / max(nDotV * (1.0 - k) + k, 0.000001);
}

fn pstudioGeometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
    return pstudioGeometrySchlickGGX(nDotV, roughness) * pstudioGeometrySchlickGGX(nDotL, roughness);
}

fn pstudioFresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn pstudioEvaluateDirectBRDF(
    albedo: vec3<f32>, metallic: f32, roughness: f32,
    normal: vec3<f32>, viewDirection: vec3<f32>, lightDirection: vec3<f32>, radiance: vec3<f32>
) -> vec3<f32> {
    let n = normalize(normal);
    let v = normalize(viewDirection);
    let l = normalize(lightDirection);
    let h = normalize(v + l);
    let nDotV = max(dot(n, v), 0.0001);
    let nDotL = max(dot(n, l), 0.0);
    if (nDotL <= 0.0) { return vec3<f32>(0.0); }
    let nDotH = max(dot(n, h), 0.0);
    let vDotH = max(dot(v, h), 0.0);
    let f0 = mix(vec3<f32>(0.04), albedo, clamp(metallic, 0.0, 1.0));
    let fresnel = pstudioFresnelSchlick(vDotH, f0);
    let distribution = pstudioDistributionGGX(nDotH, roughness);
    let geometry = pstudioGeometrySmith(nDotV, nDotL, roughness);
    let specular = (distribution * geometry * fresnel) / max(4.0 * nDotV * nDotL, 0.001);
    let diffuseWeight = (vec3<f32>(1.0) - fresnel) * (1.0 - clamp(metallic, 0.0, 1.0));
    let diffuse = diffuseWeight * albedo / PSTUDIO_PI;
    return (diffuse + specular) * radiance * nDotL;
}

fn pstudioEvaluateClusteredPBR(
    clusterIndex: u32, lightCount: u32, layerMask: u32,
    worldPosition: vec3<f32>, normal: vec3<f32>, viewDirection: vec3<f32>,
    albedo: vec3<f32>, metallic: f32, roughness: f32
) -> vec3<f32> {
    if (clusterIndex + 1u >= arrayLength(&pstudioClusterOffsets)) { return vec3<f32>(0.0); }
    let first = pstudioClusterOffsets[clusterIndex];
    let end = min(pstudioClusterOffsets[clusterIndex + 1u], arrayLength(&pstudioClusterLightIndices));
    var result = vec3<f32>(0.0);
    for (var cursor = first; cursor < end; cursor = cursor + 1u) {
        let lightIndex = pstudioClusterLightIndices[cursor];
        if (lightIndex >= lightCount || lightIndex >= arrayLength(&pstudioLightLayerMasks)) { continue; }
        if ((pstudioLightLayerMasks[lightIndex] & layerMask) == 0u) { continue; }
        let base = lightIndex * 4u;
        if (base + 3u >= arrayLength(&pstudioLightRecords)) { continue; }
        let record0 = pstudioLightRecords[base];
        let record1 = pstudioLightRecords[base + 1u];
        let record2 = pstudioLightRecords[base + 2u];
        let record3 = pstudioLightRecords[base + 3u];
        let lightType = u32(max(0.0, round(record0.x)));
        let intensity = max(record0.y, 0.0);
        let color = vec3<f32>(record0.z, record0.w, record1.x);
        let lightPosition = record1.yzw;
        let range = max(record2.x, 0.0001);
        let lightDirection = normalize(record2.yzw);
        var directionToLight = -lightDirection;
        var attenuation = 1.0;
        if (lightType != 0u) {
            let toLight = lightPosition - worldPosition;
            let distanceSquared = max(dot(toLight, toLight), 0.01);
            let distanceToLight = sqrt(distanceSquared);
            directionToLight = toLight / distanceToLight;
            let ratio = distanceToLight / range;
            let window = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
            attenuation = (window * window) / distanceSquared;
            if (lightType == 2u) {
                let coneCosine = dot(-directionToLight, lightDirection);
                attenuation = attenuation * smoothstep(record3.y, record3.x, coneCosine);
            }
        }
        result += pstudioEvaluateDirectBRDF(albedo, metallic, roughness, normal, viewDirection, directionToLight, color * intensity * attenuation);
    }
    return result;
}
`;

export function createPStudioPBRLightingWGSL(source = '') {
  return String(PSTUDIO_PBR_LIGHTING_WGSL) + '\n' + String(source || '');
}
