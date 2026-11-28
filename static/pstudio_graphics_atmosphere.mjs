/**
 * PStudio-owned atmospheric scattering layer for the direct WebGPU Graphics Core.
 * The shared GENESIS environment state remains the authoritative frame input.
 */
export const PSTUDIO_GRAPHICS_ATMOSPHERE_WGSL = String.raw`
const PSTUDIO_ATMOSPHERE_PI: f32 = 3.141592653589793;

fn pstudioRayleighPhase(cosTheta: f32) -> f32 {
    return 3.0 * (1.0 + cosTheta * cosTheta) / (16.0 * PSTUDIO_ATMOSPHERE_PI);
}
fn pstudioMiePhase(cosTheta: f32, anisotropy: f32) -> f32 {
    let g = clamp(anisotropy, -0.92, 0.92);
    let g2 = g * g;
    let denominator = max(1.0 + g2 - 2.0 * g * clamp(cosTheta, -1.0, 1.0), 0.0001);
    return (1.0 - g2) / (4.0 * PSTUDIO_ATMOSPHERE_PI * denominator * sqrt(denominator));
}
fn pstudioAtmosphereDensity(height: f32, scaleHeight: f32) -> f32 {
    return exp(-max(height, 0.0) / max(scaleHeight, 0.001));
}
fn pstudioAtmosphereHash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}
fn pstudioAtmosphereNoise3(p: vec3<f32>) -> f32 {
    let cell = floor(p);
    let local = fract(p);
    let smoothLocal = local * local * (vec3<f32>(3.0) - 2.0 * local);
    let c000 = pstudioAtmosphereHash3(cell + vec3<f32>(0.0, 0.0, 0.0));
    let c100 = pstudioAtmosphereHash3(cell + vec3<f32>(1.0, 0.0, 0.0));
    let c010 = pstudioAtmosphereHash3(cell + vec3<f32>(0.0, 1.0, 0.0));
    let c110 = pstudioAtmosphereHash3(cell + vec3<f32>(1.0, 1.0, 0.0));
    let c001 = pstudioAtmosphereHash3(cell + vec3<f32>(0.0, 0.0, 1.0));
    let c101 = pstudioAtmosphereHash3(cell + vec3<f32>(1.0, 0.0, 1.0));
    let c011 = pstudioAtmosphereHash3(cell + vec3<f32>(0.0, 1.0, 1.0));
    let c111 = pstudioAtmosphereHash3(cell + vec3<f32>(1.0, 1.0, 1.0));
    let x00 = mix(c000, c100, smoothLocal.x);
    let x10 = mix(c010, c110, smoothLocal.x);
    let x01 = mix(c001, c101, smoothLocal.x);
    let x11 = mix(c011, c111, smoothLocal.x);
    return mix(mix(x00, x10, smoothLocal.y), mix(x01, x11, smoothLocal.y), smoothLocal.z);
}
fn pstudioAtmosphereCloudDensity(worldPosition: vec3<f32>, wind: vec2<f32>, timeSeconds: f32, coverage: f32, density: f32) -> f32 {
    let drift = vec3<f32>(wind.x * timeSeconds, 0.0, wind.y * timeSeconds);
    let p = (worldPosition + drift) * 0.0018;
    let base = pstudioAtmosphereNoise3(p) * 0.58
        + pstudioAtmosphereNoise3(p * 2.03 + vec3<f32>(17.0, 3.0, 11.0)) * 0.28
        + pstudioAtmosphereNoise3(p * 4.07 + vec3<f32>(5.0, 29.0, 7.0)) * 0.14;
    let threshold = mix(0.88, 0.35, clamp(coverage, 0.0, 1.0));
    return smoothstep(threshold, min(0.995, threshold + 0.22), base) * clamp(density, 0.0, 2.0);
}
fn pstudioAtmosphereIntegrate(
    origin: vec3<f32>, direction: vec3<f32>, sunDirection: vec3<f32>, maxDistance: f32,
    rayleighColor: vec3<f32>, mieColor: vec3<f32>, rayleighScale: f32,
    mieScale: f32, anisotropy: f32, ozoneAmount: f32
) -> vec3<f32> {
    let ray = normalize(direction);
    let sun = normalize(sunDirection);
    let stepLength = max(maxDistance, 0.0) / 16.0;
    let rayleighPhase = pstudioRayleighPhase(dot(ray, sun));
    let miePhase = pstudioMiePhase(dot(ray, sun), anisotropy);
    var transmittance = vec3<f32>(1.0);
    var accumulated = vec3<f32>(0.0);
    for (var i: u32 = 0u; i < 16u; i += 1u) {
        let distance = (f32(i) + 0.5) * stepLength;
        let samplePosition = origin + ray * distance;
        let altitude = max(samplePosition.y, 0.0);
        let rayleighDensity = pstudioAtmosphereDensity(altitude, rayleighScale);
        let mieDensity = pstudioAtmosphereDensity(altitude, mieScale);
        let ozoneAbsorption = exp(-clamp(ozoneAmount, 0.0, 4.0) * rayleighDensity * stepLength * 0.00003);
        let extinction = exp(-(rayleighDensity * 0.000012 + mieDensity * 0.000035) * stepLength);
        let localScatter = rayleighColor * rayleighDensity * rayleighPhase + mieColor * mieDensity * miePhase;
        accumulated += transmittance * localScatter * (1.0 - extinction) * 18000.0;
        transmittance *= vec3<f32>(extinction * ozoneAbsorption);
    }
    return max(accumulated, vec3<f32>(0.0));
}
fn pstudioAtmosphereSunDisk(direction: vec3<f32>, sunDirection: vec3<f32>, angularRadius: f32, intensity: f32) -> f32 {
    let cosine = dot(normalize(direction), normalize(sunDirection));
    let radius = clamp(angularRadius, 0.01, 3.0) * (PSTUDIO_ATMOSPHERE_PI / 180.0);
    return smoothstep(cos(radius * 1.15), cos(radius * 0.82), cosine) * max(intensity, 0.0);
}
fn pstudioAtmosphereMoonDisk(direction: vec3<f32>, moonDirection: vec3<f32>, intensity: f32) -> f32 {
    let cosine = dot(normalize(direction), normalize(moonDirection));
    return smoothstep(cos(0.72 * PSTUDIO_ATMOSPHERE_PI / 180.0), cos(0.42 * PSTUDIO_ATMOSPHERE_PI / 180.0), cosine) * max(intensity, 0.0);
}
fn pstudioAtmosphereSky(
    direction: vec3<f32>, sunDirection: vec3<f32>, moonDirection: vec3<f32>,
    sunColor: vec3<f32>, moonColor: vec3<f32>, rayleighColor: vec3<f32>,
    mieColor: vec3<f32>, cameraHeight: f32, turbidity: f32, sunIntensity: f32,
    moonIntensity: f32, timeSeconds: f32, cloudCoverage: f32,
    cloudDensity: f32, wind: vec2<f32>
) -> vec3<f32> {
    let ray = normalize(direction);
    let horizon = pow(1.0 - abs(ray.y), 3.0);
    let scattering = pstudioAtmosphereIntegrate(
        vec3<f32>(0.0, max(cameraHeight, 0.0), 0.0), ray, sunDirection,
        12000.0, rayleighColor, mieColor, 8000.0, 1200.0,
        clamp(0.72 + turbidity * 0.025, 0.72, 0.88), 0.8
    );
    let sun = pstudioAtmosphereSunDisk(ray, sunDirection, 0.27, sunIntensity);
    let moon = pstudioAtmosphereMoonDisk(ray, moonDirection, moonIntensity);
    let cloudPosition = ray * 2400.0 + vec3<f32>(0.0, 1800.0, 0.0);
    let cloud = pstudioAtmosphereCloudDensity(cloudPosition, wind, timeSeconds, cloudCoverage, cloudDensity);
    let clearSky = scattering + sunColor * (sun * 18.0) + moonColor * (moon * 1.4);
    let cloudLighting = mix(vec3<f32>(0.18, 0.22, 0.28), sunColor * 0.75 + vec3<f32>(0.12), max(ray.y, 0.0));
    return mix(clearSky, cloudLighting, clamp(cloud * smoothstep(0.02, 0.2, ray.y), 0.0, 0.92)) + vec3<f32>(horizon * 0.015);
}
fn pstudioAtmosphereAerialPerspective(
    sceneColor: vec3<f32>, worldPosition: vec3<f32>, cameraPosition: vec3<f32>,
    fogColor: vec3<f32>, fogDensity: f32, heightFalloff: f32, baseHeight: f32
) -> vec3<f32> {
    let distance = length(worldPosition - cameraPosition);
    let averageHeight = max((worldPosition.y + cameraPosition.y) * 0.5 - baseHeight, 0.0);
    let density = max(fogDensity, 0.0) * exp(-averageHeight * max(heightFalloff, 0.0));
    let transmittance = exp(-density * distance);
    return mix(fogColor, sceneColor, clamp(transmittance, 0.0, 1.0));
}
`;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, finite(value, fallback)));
const direction2 = value => {
  const source = Array.isArray(value) ? value : [1, 0];
  const x = finite(source[0], 1), y = finite(source[1], 0), length = Math.hypot(x, y);
  return length > 1e-8 ? [x / length, y / length] : [1, 0];
};

export function normalizePStudioAtmosphereState(input = {}) {
  const sun = [finite(input.skySunX, 0), finite(input.skySunY, 1), finite(input.skySunZ, 0)];
  const sunLength = Math.hypot(...sun) || 1;
  const moon = [finite(input.moonDirectionX, 0), finite(input.moonDirectionY, -1), finite(input.moonDirectionZ, 0)];
  const moonLength = Math.hypot(...moon) || 1;
  return Object.freeze({
    revision: Math.max(0, Math.floor(finite(input.revision))),
    timeOfDay: ((finite(input.timeOfDay) % 24) + 24) % 24,
    animationTime: Math.max(0, finite(input.animationTime)),
    sunDirection: Object.freeze(sun.map(value => value / sunLength)),
    moonDirection: Object.freeze(moon.map(value => value / moonLength)),
    sunIntensity: clamp(input.sunIntensity, 0, 8),
    moonIntensity: clamp(input.moonIntensity, 0, 4),
    cloudCoverage: clamp(input.cloudCoverage, 0, 1),
    cloudDensity: clamp(input.cloudDensity, 0, 2),
    fogDensity: clamp(input.fogDensity, 0, 0.08),
    fogHeightFalloff: clamp(input.fogHeightFalloff, 0, 0.1),
    turbidity: clamp(input.turbidity, 1, 12, 2),
    windSpeed: clamp(input.windSpeed, 0, 12),
    windDirection: Object.freeze(direction2(input.windDirection)),
    rainIntensity: clamp(input.rainIntensity, 0, 1),
    wetness: clamp(input.wetness, 0, 1)
  });
}

export function packPStudioAtmosphereUniforms(input = {}) {
  const state = normalizePStudioAtmosphereState(input);
  const fog = Array.isArray(input.fogColor) ? input.fogColor : [0.55, 0.65, 0.72];
  const sun = Array.isArray(input.sunColor) ? input.sunColor : [1, 0.93, 0.82];
  const moon = Array.isArray(input.moonColor) ? input.moonColor : [0.62, 0.72, 1];
  return new Float32Array([
    ...state.sunDirection, state.sunIntensity, ...state.moonDirection, state.moonIntensity,
    ...fog.slice(0, 3).map(value => clamp(value, 0, 16)), state.fogDensity,
    ...sun.slice(0, 3).map(value => clamp(value, 0, 16)), state.cloudCoverage,
    ...moon.slice(0, 3).map(value => clamp(value, 0, 16)), state.cloudDensity,
    state.turbidity, state.windSpeed, ...state.windDirection, state.animationTime,
    state.rainIntensity, state.wetness, state.fogHeightFalloff, state.timeOfDay
  ]);
}
