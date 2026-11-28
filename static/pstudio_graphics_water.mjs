/**
 * PStudio-owned optically based water surface layer for the direct WebGPU Graphics Core.
 * Keeps planar reflection, scene depth, Beer-Lambert absorption and weather-driven motion
 * independent from the legacy TSL water implementation.
 */
export const PSTUDIO_GRAPHICS_WATER_WGSL = String.raw`
const PSTUDIO_WATER_PI: f32 = 3.141592653589793;

fn pstudioWaterWaveHeight(
    worldXZ: vec2<f32>, timeSeconds: f32, windDirection: vec2<f32>,
    waveAmplitude: f32, waveSpeed: f32, rainIntensity: f32
) -> f32 {
    let wind = normalize(select(vec2<f32>(1.0, 0.0), windDirection, dot(windDirection, windDirection) > 0.0001));
    let p = worldXZ;
    let t = timeSeconds * max(waveSpeed, 0.05);
    let broad = sin(dot(p, wind * 0.035) + t * 0.72) * 0.52;
    let cross = sin(dot(p, vec2<f32>(-wind.y, wind.x) * 0.071) - t * 1.13) * 0.27;
    let fine = sin(dot(p, wind * 0.19 + vec2<f32>(0.037, -0.061)) + t * 2.7) * 0.11;
    let rain = sin(length(fract(p * 0.23) - vec2<f32>(0.5)) * 42.0 - t * 2.0) * clamp(rainIntensity, 0.0, 1.0) * 0.1;
    return (broad + cross + fine + rain) * clamp(waveAmplitude, 0.0, 0.5);
}
fn pstudioWaterFresnel(cosViewAngle: f32, f0: f32) -> f32 {
    return clamp(f0 + (1.0 - f0) * pow(1.0 - clamp(cosViewAngle, 0.0, 1.0), 5.0), 0.0, 1.0);
}
fn pstudioWaterBeerLambert(absorption: vec3<f32>, thickness: f32) -> vec3<f32> {
    return exp(-max(absorption, vec3<f32>(0.0)) * max(thickness, 0.0));
}
fn pstudioWaterAbsorbedColor(
    refractedColor: vec3<f32>, scatteringColor: vec3<f32>,
    absorption: vec3<f32>, thickness: f32
) -> vec3<f32> {
    let transmittance = pstudioWaterBeerLambert(absorption, thickness);
    return refractedColor * transmittance + scatteringColor * (vec3<f32>(1.0) - transmittance);
}
fn pstudioWaterSurfaceNormal(
    worldXZ: vec2<f32>, timeSeconds: f32, windDirection: vec2<f32>,
    waveAmplitude: f32, waveSpeed: f32, rainIntensity: f32
) -> vec3<f32> {
    let wind = normalize(select(vec2<f32>(1.0, 0.0), windDirection, dot(windDirection, windDirection) > 0.0001));
    let t = timeSeconds * max(waveSpeed, 0.05);
    let a = clamp(waveAmplitude, 0.0, 0.5);
    let dx = cos(dot(worldXZ, wind * 0.035) + t * 0.72) * wind.x * 0.035 * 0.52
        + cos(dot(worldXZ, vec2<f32>(-wind.y, wind.x) * 0.071) - t * 1.13) * -wind.y * 0.071 * 0.27
        + cos(dot(worldXZ, wind * 0.19 + vec2<f32>(0.037, -0.061)) + t * 2.7) * (wind.x * 0.19 + 0.037) * 0.11;
    let dz = cos(dot(worldXZ, wind * 0.035) + t * 0.72) * wind.y * 0.035 * 0.52
        + cos(dot(worldXZ, vec2<f32>(-wind.y, wind.x) * 0.071) - t * 1.13) * wind.x * 0.071 * 0.27
        + cos(dot(worldXZ, wind * 0.19 + vec2<f32>(0.037, -0.061)) + t * 2.7) * (wind.y * 0.19 - 0.061) * 0.11;
    let rainRipple = clamp(rainIntensity, 0.0, 1.0) * 0.025;
    return normalize(vec3<f32>(-dx * a - rainRipple, 1.0, -dz * a + rainRipple));
}
fn pstudioWaterCompose(
    reflectionColor: vec3<f32>, refractedColor: vec3<f32>,
    scatteringColor: vec3<f32>, absorption: vec3<f32>,
    thickness: f32, cosViewAngle: f32, f0: f32, foam: f32
) -> vec3<f32> {
    let reflectance = pstudioWaterFresnel(cosViewAngle, f0);
    let transmitted = pstudioWaterAbsorbedColor(refractedColor, scatteringColor, absorption, thickness);
    let base = mix(transmitted, reflectionColor, reflectance);
    return mix(base, vec3<f32>(0.82, 0.88, 0.91), clamp(foam, 0.0, 1.0) * 0.82);
}
`;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, finite(value, fallback)));
const normalize2 = value => {
  const source = Array.isArray(value) ? value : [1, 0];
  const x = finite(source[0], 1), y = finite(source[1], 0), length = Math.hypot(x, y);
  return length > 1e-8 ? [x / length, y / length] : [1, 0];
};

export function evaluatePStudioBeerLambert(absorption, thickness) {
  if (!Array.isArray(absorption) && !ArrayBuffer.isView(absorption)) throw new TypeError('Absorption must be a 3-channel array.');
  if (absorption.length < 3) throw new TypeError('Absorption requires RGB coefficients.');
  const distance = Math.max(0, finite(thickness));
  return Object.freeze(Array.from(absorption).slice(0, 3).map(value => Math.exp(-Math.max(0, finite(value)) * distance)));
}

export function evaluatePStudioWaterFresnel(cosViewAngle, f0 = 0.02) {
  const cosine = clamp(cosViewAngle, 0, 1), base = clamp(f0, 0, 1, 0.02);
  return base + (1 - base) * (1 - cosine) ** 5;
}

export function evaluatePStudioWaterOptics(input = {}) {
  const absorption = Array.isArray(input.absorption) ? input.absorption : [0.08, 0.035, 0.018];
  const scattering = Array.isArray(input.scatteringColor) ? input.scatteringColor : [0.02, 0.16, 0.2];
  const reflection = Array.isArray(input.reflectionColor) ? input.reflectionColor : [0.1, 0.2, 0.3];
  const refraction = Array.isArray(input.refractionColor) ? input.refractionColor : [0.2, 0.3, 0.4];
  const transmittance = evaluatePStudioBeerLambert(absorption, input.thickness);
  const transmitted = refraction.map((value, index) => value * transmittance[index] + scattering[index] * (1 - transmittance[index]));
  const fresnel = evaluatePStudioWaterFresnel(input.cosViewAngle, input.f0);
  const foam = clamp(input.foam, 0, 1);
  const color = transmitted.map((value, index) => value * (1 - fresnel) + reflection[index] * fresnel)
    .map(value => value * (1 - foam * 0.82) + 0.85 * foam * 0.82);
  return Object.freeze({ transmittance: Object.freeze(transmittance), fresnel, color: Object.freeze(color), thickness: Math.max(0, finite(input.thickness)) });
}

export function evaluatePStudioWaterWave(input = {}) {
  const position = Array.isArray(input.worldXZ) ? input.worldXZ : [0, 0];
  const wind = normalize2(input.windDirection), x = finite(position[0]), z = finite(position[1]);
  const time = Math.max(0, finite(input.timeSeconds)), speed = Math.max(0.05, finite(input.waveSpeed, 1));
  const amplitude = clamp(input.waveAmplitude, 0, 0.5, 0.08), t = time * speed;
  const broad = Math.sin((x * wind[0] + z * wind[1]) * 0.035 + t * 0.72) * 0.52;
  const cross = Math.sin((x * -wind[1] + z * wind[0]) * 0.071 - t * 1.13) * 0.27;
  const fine = Math.sin(x * (wind[0] * 0.19 + 0.037) + z * (wind[1] * 0.19 - 0.061) + t * 2.7) * 0.11;
  const rain = Math.sin(Math.hypot((x * 0.23) % 1 - 0.5, (z * 0.23) % 1 - 0.5) * 42 - t * 2) * clamp(input.rainIntensity, 0, 1) * 0.1;
  return (broad + cross + fine + rain) * amplitude;
}

export function packPStudioWaterUniforms(input = {}) {
  const wind = normalize2(input.windDirection);
  const absorption = Array.isArray(input.absorption) ? input.absorption : [0.08, 0.035, 0.018];
  const scattering = Array.isArray(input.scatteringColor) ? input.scatteringColor : [0.02, 0.16, 0.2];
  return new Float32Array([
    Math.max(0, finite(input.timeSeconds)), wind[0], wind[1], clamp(input.waveAmplitude, 0, 0.5, 0.08),
    clamp(input.waveSpeed, 0.05, 8, 1), clamp(input.rainIntensity, 0, 1), clamp(input.wetness, 0, 1), clamp(input.reflectivity, 0, 1, 0.96),
    ...absorption.slice(0, 3).map(value => clamp(value, 0, 20)), clamp(input.f0, 0, 1, 0.02),
    ...scattering.slice(0, 3).map(value => clamp(value, 0, 16)), clamp(input.foam, 0, 1)
  ]);
}

export function addPStudioWaterRenderPasses(graph, options = {}) {
  if (!graph?.addResource || !graph?.addPass) throw new TypeError('A PStudio Render Graph is required.');
  const prefix = String(options.prefix || 'pstudio.water').replace(/[^a-zA-Z0-9._-]/g, '_');
  const width = Math.max(1, Math.floor(finite(options.width, 1024)));
  const height = Math.max(1, Math.floor(finite(options.height, 1024)));
  const format = String(options.format || 'rgba16float');
  const ids = Object.freeze({
    reflection: prefix + '.reflection',
    depth: prefix + '.depth',
    refracted: prefix + '.refracted',
    surface: String(options.surfaceResource || prefix + '.surface')
  });
  graph.addResource({ id: ids.reflection, type: 'texture', format, width, height, lifetime: 'transient', usage: ['texture-binding', 'render-attachment'] });
  graph.addResource({ id: ids.depth, type: 'texture', format: 'depth32float', width, height, lifetime: 'transient', usage: ['texture-binding', 'render-attachment'] });
  graph.addResource({ id: ids.refracted, type: 'texture', format, width, height, lifetime: 'transient', usage: ['texture-binding', 'render-attachment'] });
  graph.addResource({ id: ids.surface, type: 'surface', lifetime: 'external', imported: true });
  const execute = name => typeof options[name] === 'function' ? options[name] : () => Object.freeze({ configured: false, pass: name });
  const passIds = Object.freeze([
    prefix + '.planar-reflection', prefix + '.depth-prepass',
    prefix + '.refraction-copy', prefix + '.surface-composite'
  ]);
  graph.addPass({ id: passIds[0], type: 'render',
    writes: [{ resource: ids.reflection, access: 'color-attachment' }],
    execute: execute('renderReflection'),
    metadata: { stage: 'water-reflection', preservesPlanarMirror: true } });
  graph.addPass({ id: passIds[1], type: 'render',
    writes: [{ resource: ids.depth, access: 'depth-attachment' }],
    execute: execute('renderDepth'),
    metadata: { stage: 'water-depth', thicknessSource: 'scene-depth' } });
  graph.addPass({ id: passIds[2], type: 'copy',
    reads: [{ resource: ids.depth, access: 'sampled' }],
    writes: [{ resource: ids.refracted, access: 'color-attachment' }],
    execute: execute('renderRefraction'),
    metadata: { stage: 'water-refraction', depthAware: true } });
  graph.addPass({ id: passIds[3], type: 'render',
    reads: [
      { resource: ids.reflection, access: 'sampled' },
      { resource: ids.depth, access: 'sampled' },
      { resource: ids.refracted, access: 'sampled' }
    ],
    writes: [{ resource: ids.surface, access: 'color-attachment' }],
    execute: execute('renderSurface'),
    metadata: { stage: 'water-composite', fresnel: true, absorption: 'beer-lambert', windDriven: true, rainRipples: true } });
  return Object.freeze({ ids, passIds });
}
