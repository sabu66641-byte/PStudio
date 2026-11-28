import { PStudioGraphicsError } from './pstudio_graphics_contract.mjs';

const GI_COEFFICIENTS = 27;
const VFX_WORKGROUP_SIZE = 64;
const EPSILON = 1e-6;
function finite(value, fallback, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) { if (fallback === undefined) throw new TypeError(label + ' must be finite.'); return fallback; }
  return n;
}
function positiveInteger(value, label, maximum = 1_000_000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new RangeError(label + ' must be a positive safe integer no greater than ' + maximum + '.');
  return n;
}
function vector3(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) throw new TypeError(label + ' must be a 3-component vector.');
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain finite components.');
  return result;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

/** GPU VFX compute shader ABI: one independent particle record per invocation. */
export const PSTUDIO_GPU_VFX_WGSL = /* wgsl */\`
struct Particle {
  position_age: vec4<f32>,
  velocity_lifetime: vec4<f32>,
  color_size: vec4<f32>,
};
struct SimulationParams {
  delta_seconds: f32,
  particle_count: u32,
  time_seconds: f32,
  _padding: f32,
};
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> simulation: SimulationParams;
@compute @workgroup_size(64)
fn pstudioSimulateParticles(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= simulation.particle_count) { return; }
  var particle = particles[index];
  if (particle.color_size.w <= 0.0) { return; }
  particle.position_age.xyz += particle.velocity_lifetime.xyz * simulation.delta_seconds;
  particle.position_age.w += simulation.delta_seconds;
  if (particle.position_age.w >= particle.velocity_lifetime.w) { particle.color_size.w = 0.0; }
  particles[index] = particle;
}
\`;

/** GPU VFX orchestration with bounded emitters and an injected GPU compute executor. */
export function createPStudioGpuVFXSystem(options = {}) {
  const capacity = positiveInteger(options.capacity ?? 65536, 'VFX particle capacity', 16_777_216);
  const maxSpawnPerFrame = positiveInteger(options.maxSpawnPerFrame ?? Math.min(capacity, 16384), 'maxSpawnPerFrame', capacity);
  const executor = options.executor;
  const emitters = new Map();
  let frameId = 0, inFlight = false, disposed = false, totalSpawned = 0, totalDropped = 0;
  function assertLive() { if (disposed) throw new PStudioGraphicsError('GPU VFX system is disposed.', { code: 'PSTUDIO_GPU_VFX_DISPOSED' }); }
  function registerEmitter(input = {}) {
    assertLive();
    const id = String(input.id || '').trim();
    if (!id) throw new TypeError('VFX emitter id is required.');
    if (emitters.has(id)) throw new PStudioGraphicsError('VFX emitter already exists: ' + id, { code: 'PSTUDIO_GPU_VFX_DUPLICATE_EMITTER' });
    const rate = finite(input.ratePerSecond ?? 0, 0, 'ratePerSecond');
    const lifetime = finite(input.lifetimeSeconds ?? 1, 1, 'lifetimeSeconds');
    const burst = Math.max(0, Math.floor(finite(input.burst ?? 0, 0, 'burst')));
    if (rate < 0 || rate > 10_000_000 || lifetime <= 0 || lifetime > 3600 || burst > capacity) throw new RangeError('VFX emitter rate, lifetime or burst is outside configured limits.');
    const descriptor = Object.freeze({
      id, ratePerSecond: rate, lifetimeSeconds: lifetime, burst,
      position: Object.freeze(vector3(input.position || [0, 0, 0], 'emitter position')),
      velocity: Object.freeze(vector3(input.velocity || [0, 1, 0], 'emitter velocity')),
      seed: Math.floor(finite(input.seed ?? 1, 1, 'emitter seed')) >>> 0
    });
    emitters.set(id, { descriptor, emissionRemainder: 0, firstBurstPending: burst > 0 });
    return descriptor;
  }
  function removeEmitter(id) { assertLive(); return emitters.delete(String(id)); }
  async function simulate(input = {}) {
    assertLive();
    if (inFlight) throw new PStudioGraphicsError('VFX simulation is already in flight.', { code: 'PSTUDIO_GPU_VFX_BUSY' });
    if (typeof executor?.dispatchVFX !== 'function') throw new PStudioGraphicsError('A GPU VFX compute executor is required.', { code: 'PSTUDIO_GPU_VFX_EXECUTOR_UNAVAILABLE' });
    const delta = clamp(finite(input.deltaSeconds ?? 0, 0, 'deltaSeconds'), 0, 0.25);
    const time = Math.max(0, finite(input.timeSeconds ?? 0, 0, 'timeSeconds'));
    const available = clamp(Math.floor(finite(input.availableParticleSlots ?? capacity, capacity)), 0, capacity);
    let requested = 0;
    const emitterCommands = [];
    for (const state of emitters.values()) {
      let count = state.firstBurstPending ? state.descriptor.burst : 0;
      state.firstBurstPending = false;
      state.emissionRemainder += state.descriptor.ratePerSecond * delta;
      const continuous = Math.floor(state.emissionRemainder);
      state.emissionRemainder -= continuous;
      count += continuous;
      requested += count;
      emitterCommands.push(Object.freeze({ ...state.descriptor, spawnCount: count }));
    }
    const spawnCount = Math.min(requested, available, maxSpawnPerFrame);
    const dropped = requested - spawnCount;
    const command = Object.freeze({
      frameId: ++frameId, deltaSeconds: delta, timeSeconds: time,
      particleCapacity: capacity, availableParticleSlots: available,
      requestedSpawnCount: requested, spawnCount, droppedSpawnCount: dropped,
      workgroupSize: VFX_WORKGROUP_SIZE,
      workgroupCount: Math.ceil(Math.max(1, capacity) / VFX_WORKGROUP_SIZE),
      emitters: Object.freeze(emitterCommands), shader: PSTUDIO_GPU_VFX_WGSL
    });
    inFlight = true;
    try {
      const result = await executor.dispatchVFX(command);
      totalSpawned += spawnCount; totalDropped += dropped;
      return Object.freeze({ ...command, result: result ?? null });
    } finally { inFlight = false; }
  }
  function stats() { return Object.freeze({ capacity, emitterCount: emitters.size, frameId, inFlight, totalSpawned, totalDropped, disposed }); }
  function dispose() { if (disposed) return false; emitters.clear(); disposed = true; return true; }
  return Object.freeze({ kind: 'pstudio-gpu-vfx-system', capacity, registerEmitter, removeEmitter, simulate, stats, dispose });
}

/** Probe-based SH Global Illumination reference core with dirty regions and temporal stability. */
export function createPStudioGraphicsGiCore(options = {}) {
  const probes = new Map();
  let revision = 0, disposed = false;
  const halfLifeMs = Math.max(1, finite(options.halfLifeMs ?? 240, 240, 'halfLifeMs'));
  function assertLive() { if (disposed) throw new PStudioGraphicsError('Graphics GI Core is disposed.', { code: 'PSTUDIO_GRAPHICS_GI_DISPOSED' }); }
  function normalize(input = {}) {
    const id = String(input.id || '').trim();
    if (!id) throw new TypeError('GI probe id is required.');
    const position = vector3(input.position, 'GI probe position');
    const coefficients = Float32Array.from(input.coefficients || new Float32Array(GI_COEFFICIENTS), Number);
    if (coefficients.length !== GI_COEFFICIENTS || !coefficients.every(Number.isFinite)) throw new TypeError('GI probe requires exactly 27 finite SH coefficients.');
    const validity = clamp(finite(input.validity ?? 1, 1, 'probe validity'), 0, 1);
    return { id, position, coefficients, validity, dirty: input.dirty === true, captureRevision: Math.max(0, Math.floor(finite(input.captureRevision ?? 0, 0, 'captureRevision'))) };
  }
  function snapshotProbe(probe) {
    return Object.freeze({ id: probe.id, position: Object.freeze([...probe.position]), coefficients: new Float32Array(probe.coefficients), validity: probe.validity, dirty: probe.dirty, captureRevision: probe.captureRevision });
  }
  function setProbe(input) { assertLive(); const probe = normalize(input); probes.set(probe.id, probe); revision++; return snapshotProbe(probe); }
  function updateProbe(id, coefficients, deltaMs, validity = 1) {
    assertLive();
    const probe = probes.get(String(id));
    if (!probe) throw new PStudioGraphicsError('Unknown GI probe: ' + id, { code: 'PSTUDIO_GRAPHICS_GI_PROBE_UNKNOWN' });
    const incoming = Float32Array.from(coefficients || [], Number);
    if (incoming.length !== GI_COEFFICIENTS || !incoming.every(Number.isFinite)) throw new TypeError('GI probe update requires 27 finite SH coefficients.');
    const elapsed = Math.max(0, Math.min(10000, finite(deltaMs, 0, 'deltaMs')));
    const alpha = 1 - Math.exp((-Math.LN2 * elapsed) / halfLifeMs);
    for (let i = 0; i < GI_COEFFICIENTS; i++) probe.coefficients[i] += (incoming[i] - probe.coefficients[i]) * alpha;
    probe.validity = clamp(finite(validity, probe.validity, 'validity'), 0, 1);
    probe.dirty = false; probe.captureRevision++; revision++;
    return Object.freeze({ id: probe.id, alpha, captureRevision: probe.captureRevision });
  }
  function invalidateSphere(center, radius) {
    assertLive();
    const c = vector3(center, 'invalidation center');
    const r = Math.max(0, finite(radius, 0, 'invalidation radius'));
    let changed = 0;
    for (const probe of probes.values()) {
      const distance = Math.hypot(probe.position[0] - c[0], probe.position[1] - c[1], probe.position[2] - c[2]);
      if (distance <= r && !probe.dirty) { probe.dirty = true; changed++; }
    }
    if (changed) revision++;
    return changed;
  }
  function removeProbe(id) { assertLive(); const removed = probes.delete(String(id)); if (removed) revision++; return removed; }
  function sample(position, options = {}) {
    assertLive();
    const p = vector3(position, 'GI sample position');
    const maxProbes = positiveInteger(options.maxProbes ?? 4, 'maxProbes', 64);
    const maxDistance = Math.max(EPSILON, finite(options.maxDistance ?? 100, 100, 'maxDistance'));
    const candidates = [...probes.values()].map(probe => ({
      probe, distance: Math.hypot(probe.position[0] - p[0], probe.position[1] - p[1], probe.position[2] - p[2])
    })).filter(item => item.distance <= maxDistance && item.probe.validity > 0)
      .sort((a, b) => a.distance - b.distance || a.probe.id.localeCompare(b.probe.id)).slice(0, maxProbes);
    const coefficients = new Float32Array(GI_COEFFICIENTS);
    if (!candidates.length) return Object.freeze({ coefficients, probeIds: Object.freeze([]), confidence: 0, dirtyProbeCount: 0 });
    const weights = candidates.map(item => item.probe.validity / Math.max(EPSILON, item.distance * item.distance));
    const total = weights.reduce((sum, value) => sum + value, 0);
    candidates.forEach((item, index) => {
      const weight = weights[index] / total;
      for (let i = 0; i < GI_COEFFICIENTS; i++) coefficients[i] += item.probe.coefficients[i] * weight;
    });
    const confidence = candidates.reduce((sum, item) => sum + item.probe.validity, 0) / candidates.length;
    return Object.freeze({ coefficients, probeIds: Object.freeze(candidates.map(item => item.probe.id)), confidence, dirtyProbeCount: candidates.filter(item => item.probe.dirty).length });
  }
  function snapshot() {
    assertLive();
    return Object.freeze({ revision, probeCount: probes.size, dirtyProbeIds: Object.freeze([...probes.values()].filter(probe => probe.dirty).map(probe => probe.id).sort()), probes: Object.freeze([...probes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(snapshotProbe)) });
  }
  function stats() { return Object.freeze({ revision, probeCount: probes.size, dirtyProbeCount: [...probes.values()].filter(probe => probe.dirty).length, disposed }); }
  function dispose() { if (disposed) return false; probes.clear(); disposed = true; return true; }
  return Object.freeze({ kind: 'pstudio-graphics-gi-core', setProbe, updateProbe, invalidateSphere, removeProbe, sample, snapshot, stats, dispose });
}

function depthSlice(depth, near, far, slices) {
  const normalized = clamp(Math.log(clamp(depth, near, far) / near) / Math.log(far / near), 0, 1);
  return clamp(Math.floor(normalized * slices), 0, slices - 1);
}

/** Builds deterministic perspective froxel/cluster assignments from view-space light spheres. */
export function buildPStudioGraphicsClusterAssignments(input = {}) {
  const tilesX = positiveInteger(input.tilesX ?? 16, 'tilesX', 256);
  const tilesY = positiveInteger(input.tilesY ?? 9, 'tilesY', 256);
  const tilesZ = positiveInteger(input.tilesZ ?? 16, 'tilesZ', 256);
  const maxLightsPerCluster = positiveInteger(input.maxLightsPerCluster ?? 64, 'maxLightsPerCluster', 4096);
  const maxClusters = positiveInteger(input.maxClusters ?? 1_048_576, 'maxClusters', 4_194_304);
  const clusterCount = tilesX * tilesY * tilesZ;
  if (!Number.isSafeInteger(clusterCount) || clusterCount > maxClusters) throw new RangeError('Cluster grid exceeds configured maximum.');
  const near = Math.max(EPSILON, finite(input.near ?? 0.1, 0.1, 'near'));
  const far = finite(input.far ?? 2000, 2000, 'far');
  const fovY = finite(input.fovYRadians ?? Math.PI / 3, Math.PI / 3, 'fovYRadians');
  const aspect = finite(input.aspect ?? 16 / 9, 16 / 9, 'aspect');
  if (far <= near || fovY <= 0 || fovY >= Math.PI || aspect <= 0) throw new RangeError('Cluster camera range, FOV or aspect ratio is invalid.');
  const tanY = Math.tan(fovY / 2), tanX = tanY * aspect;
  const assignments = Array.from({ length: clusterCount }, () => []);
  const lights = input.lights || [];
  if (!Array.isArray(lights)) throw new TypeError('Cluster lights must be an array.');
  for (let index = 0; index < lights.length; index++) {
    const light = lights[index];
    const position = vector3(light.positionView, 'cluster light positionView');
    const radius = finite(light.radius, 0, 'cluster light radius');
    if (radius <= 0) continue;
    const depth = -position[2], depthMin = depth - radius, depthMax = depth + radius;
    if (depthMax < near || depthMin > far) continue;
    const minDepth = Math.max(near, depthMin);
    const projectedX0 = 0.5 + (position[0] - radius) / (2 * minDepth * tanX);
    const projectedX1 = 0.5 + (position[0] + radius) / (2 * minDepth * tanX);
    const projectedY0 = 0.5 - (position[1] + radius) / (2 * minDepth * tanY);
    const projectedY1 = 0.5 - (position[1] - radius) / (2 * minDepth * tanY);
    if (Math.max(projectedX0, projectedX1) < 0 || Math.min(projectedX0, projectedX1) > 1 ||
        Math.max(projectedY0, projectedY1) < 0 || Math.min(projectedY0, projectedY1) > 1) continue;
    const x0 = clamp(projectedX0, 0, 1);
    const x1 = clamp(projectedX1, 0, 1);
    const y0 = clamp(projectedY0, 0, 1);
    const y1 = clamp(projectedY1, 0, 1);
    const minX = clamp(Math.floor(x0 * tilesX), 0, tilesX - 1);
    const maxX = clamp(Math.floor(Math.max(x0, x1 - EPSILON) * tilesX), 0, tilesX - 1);
    const minY = clamp(Math.floor(y0 * tilesY), 0, tilesY - 1);
    const maxY = clamp(Math.floor(Math.max(y0, y1 - EPSILON) * tilesY), 0, tilesY - 1);
    const minZ = depthSlice(Math.max(near, depthMin), near, far, tilesZ);
    const maxZ = depthSlice(Math.min(far, depthMax), near, far, tilesZ);
    const lightIndex = Math.floor(finite(light.index ?? index, index, 'light index'));
    if (!Number.isSafeInteger(lightIndex) || lightIndex < 0 || lightIndex > 0xffffffff) throw new RangeError('Cluster light index must be uint32.');
    for (let z = minZ; z <= maxZ; z++) for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y++) {
      for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x++) {
        const cluster = (z * tilesY + y) * tilesX + x;
        const list = assignments[cluster];
        if (list.length >= maxLightsPerCluster) throw new RangeError('Cluster ' + cluster + ' exceeds maxLightsPerCluster; no light is dropped.');
        list.push(lightIndex);
      }
    }
  }
  const offsets = new Uint32Array(clusterCount + 1);
  let total = 0;
  for (let i = 0; i < clusterCount; i++) { offsets[i] = total; total += assignments[i].length; }
  offsets[clusterCount] = total;
  const indices = new Uint32Array(total);
  let cursor = 0;
  for (const list of assignments) for (const value of list) indices[cursor++] = value;
  return Object.freeze({
    layout: Object.freeze({ tilesX, tilesY, tilesZ, clusterCount, maxLightsPerCluster, near, far }),
    assignments: Object.freeze(assignments.map(list => Object.freeze([...list]))),
    clusterOffsets: offsets, clusterLightIndices: indices, indexCount: total,
    populatedClusterCount: assignments.filter(list => list.length > 0).length
  });
}

/** Froxel dimensions and memory limits for volumetric fog/cloud integration. */
export function createPStudioFroxelGrid(input = {}) {
  const width = positiveInteger(input.width ?? 160, 'froxel width', 2048);
  const height = positiveInteger(input.height ?? 90, 'froxel height', 2048);
  const depth = positiveInteger(input.depth ?? 64, 'froxel depth', 512);
  const bytesPerFroxel = positiveInteger(input.bytesPerFroxel ?? 16, 'bytesPerFroxel', 256);
  const count = width * height * depth;
  const estimatedBytes = count * bytesPerFroxel;
  const budgetBytes = positiveInteger(input.budgetBytes ?? 256 * 1024 * 1024, 'froxel memory budget', 8 * 1024 * 1024 * 1024);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(estimatedBytes) || estimatedBytes > budgetBytes) throw new RangeError('Froxel grid exceeds its configured memory budget.');
  return Object.freeze({ width, height, depth, count, bytesPerFroxel, estimatedBytes, budgetBytes });
}

/** Henyey–Greenstein phase function normalized over the sphere. */
export function evaluatePStudioHenyeyGreenstein(cosTheta, anisotropy = 0) {
  const cosine = clamp(finite(cosTheta, 0, 'cosTheta'), -1, 1);
  const g = clamp(finite(anisotropy, 0, 'anisotropy'), -0.95, 0.95);
  const denominator = Math.max(EPSILON, 1 + g * g - 2 * g * cosine);
  return (1 - g * g) / (4 * Math.PI * denominator ** 1.5);
}

/** Beer–Lambert transmittance and in-scattered radiance for one homogeneous segment. */
export function evaluatePStudioVolumetricSegment(input = {}) {
  const density = Math.max(0, finite(input.density ?? 0, 0, 'density'));
  const distance = Math.max(0, finite(input.distance ?? 0, 0, 'distance'));
  const albedo = clamp(finite(input.albedo ?? 1, 1, 'albedo'), 0, 1);
  const transmittance = Math.exp(-density * distance);
  const phase = evaluatePStudioHenyeyGreenstein(input.cosTheta ?? 0, input.anisotropy ?? 0);
  const incident = vector3(input.incidentRadiance || [1, 1, 1], 'incidentRadiance');
  const sigmaS = density * albedo;
  const integral = density > EPSILON ? (1 - transmittance) / density : distance;
  const radiance = incident.map(value => value * sigmaS * phase * integral);
  return Object.freeze({ transmittance, radiance: Object.freeze(radiance), opticalDepth: density * distance, phase });
}

/** Front-to-back integration of ordered near-to-far volumetric segments. */
export function integratePStudioVolumetricSegments(segments = []) {
  if (!Array.isArray(segments)) throw new TypeError('Volumetric segments must be an array.');
  let transmittance = 1;
  const radiance = [0, 0, 0];
  for (const input of segments) {
    const segment = evaluatePStudioVolumetricSegment(input);
    for (let channel = 0; channel < 3; channel++) radiance[channel] += transmittance * segment.radiance[channel];
    transmittance *= segment.transmittance;
  }
  return Object.freeze({ radiance: Object.freeze(radiance), transmittance, opacity: 1 - transmittance });
}

/** Confidence-weighted temporal accumulation for froxel radiance/transmittance. */
export function blendPStudioVolumetricHistory(current, history, weight, confidence = 1) {
  if (!current || !history || current.length !== history.length) throw new TypeError('Current and history buffers must have equal lengths.');
  const alpha = clamp(finite(weight, 0, 'history weight') * finite(confidence, 1, 'history confidence'), 0, 0.98);
  const result = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) {
    const a = Number(current[i]), b = Number(history[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('Volumetric history values must be finite.');
    result[i] = a * (1 - alpha) + b * alpha;
  }
  return Object.freeze({ values: result, historyWeight: alpha });
}

/** WGSL include for physically motivated volumetric transmittance and phase. */
export const PSTUDIO_VOLUMETRIC_WGSL = /* wgsl */\`
fn pstudioHG(cosTheta: f32, anisotropy: f32) -> f32 {
  let g = clamp(anisotropy, -0.95, 0.95);
  let denominator = max(1e-6, 1.0 + g * g - 2.0 * g * clamp(cosTheta, -1.0, 1.0));
  return (1.0 - g * g) / (12.5663706144 * pow(denominator, 1.5));
}
fn pstudioBeerLambert(density: f32, segmentLength: f32) -> f32 {
  return exp(-max(0.0, density) * max(0.0, segmentLength));
}
fn pstudioVolumeIntegrate(previousRadiance: vec3<f32>, previousTransmittance: f32, sourceRadiance: vec3<f32>, segmentTransmittance: f32) -> vec4<f32> {
  let radiance = previousRadiance + previousTransmittance * sourceRadiance;
  let transmittance = previousTransmittance * segmentTransmittance;
  return vec4<f32>(radiance, transmittance);
}
\`;
