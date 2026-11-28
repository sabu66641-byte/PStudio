const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(label + " is outside its supported range.");
  return n;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const vec3 = v => [finite(v?.[0] ?? v?.x), finite(v?.[1] ?? v?.y), finite(v?.[2] ?? v?.z)];

function probeIndex(x, y, z, dims) { return (z * dims[1] + y) * dims[0] + x; }

/** Compact 3D irradiance-probe field using nine RGB spherical-harmonic coefficients. */
export function createPStudioRadianceCache(options = {}) {
  const origin = vec3(options.origin || [0, 0, 0]), spacing = vec3(options.spacing || [4, 4, 4]);
  const dims = (options.dimensions || [4, 4, 4]).map((v, i) => integer(v, 2, 128, "dimensions[" + i + "]"));
  if (spacing.some(v => !(v > 0))) throw new RangeError("Radiance probe spacing must be positive.");
  const count = dims[0] * dims[1] * dims[2];
  const maxProbes = integer(options.maxProbes ?? 262144, 8, 1000000, "maxProbes");
  if (count > maxProbes) throw new RangeError("Radiance probe field exceeds maxProbes.");
  const coefficients = new Float32Array(count * 27), validity = new Float32Array(count), revisions = new Uint32Array(count);
  let revision = 0, disposed = false;
  const assertLive = () => { if (disposed) throw new Error("PStudio Radiance Cache is disposed."); };
  function updateProbe(indexValue, values, blendValue = 1) {
    assertLive();
    const index = integer(indexValue, 0, count - 1, "probeIndex");
    if (!values || values.length !== 27) throw new TypeError("Each probe must provide nine RGB SH coefficients (27 floats).");
    const alpha = clamp(finite(blendValue, 1), 0, 1), offset = index * 27;
    for (let i = 0; i < 27; i++) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) throw new TypeError("SH coefficients must be finite.");
      coefficients[offset + i] = validity[index] > 0 ? coefficients[offset + i] * (1 - alpha) + value * alpha : value;
    }
    validity[index] = 1;
    revisions[index] = ++revision;
    return revisions[index];
  }
  function invalidate(bounds) {
    assertLive();
    const min = vec3(bounds?.min), max = vec3(bounds?.max);
    if (max.some((v, i) => v < min[i])) throw new RangeError("Invalid radiance invalidation bounds.");
    let changed = 0;
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      const p = [origin[0] + x * spacing[0], origin[1] + y * spacing[1], origin[2] + z * spacing[2]];
      if (p.every((v, i) => v >= min[i] && v <= max[i])) {
        const index = probeIndex(x, y, z, dims);
        if (validity[index]) { validity[index] = 0; revisions[index] = ++revision; changed++; }
      }
    }
    return changed;
  }
  function sampleSH(positionValue) {
    assertLive();
    const p = vec3(positionValue);
    const g = p.map((v, i) => clamp((v - origin[i]) / spacing[i], 0, dims[i] - 1));
    const lo = g.map(Math.floor), hi = g.map((v, i) => Math.min(dims[i] - 1, Math.ceil(v)));
    const t = g.map((v, i) => v - lo[i]);
    const result = new Float32Array(27);
    let totalWeight = 0, latestRevision = 0;
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const x = dx ? hi[0] : lo[0], y = dy ? hi[1] : lo[1], z = dz ? hi[2] : lo[2];
      const weight = (dx ? t[0] : 1 - t[0]) * (dy ? t[1] : 1 - t[1]) * (dz ? t[2] : 1 - t[2]);
      if (weight <= 0) continue;
      const index = probeIndex(x, y, z, dims);
      if (validity[index] <= 0) continue;
      const offset = index * 27;
      for (let c = 0; c < 27; c++) result[c] += coefficients[offset + c] * weight;
      totalWeight += weight; latestRevision = Math.max(latestRevision, revisions[index]);
    }
    if (totalWeight <= 1e-8) return null;
    for (let c = 0; c < 27; c++) result[c] /= totalWeight;
    return Object.freeze({ coefficients: result, confidence: clamp(totalWeight, 0, 1), revision: latestRevision });
  }
  function evaluateDiffuse(coeffs, normalValue) {
    if (!coeffs || coeffs.length !== 27) throw new TypeError("27 SH coefficient values are required.");
    const n = vec3(normalValue), length = Math.hypot(...n) || 1, x = n[0] / length, y = n[1] / length, z = n[2] / length;
    const basis = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
    const band = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
    const rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 9; i++) rgb[c] += finite(coeffs[i * 3 + c]) * basis[i] * band[i];
      rgb[c] = Math.max(0, rgb[c]);
    }
    return Object.freeze(rgb);
  }
  function snapshot() {
    assertLive();
    return Object.freeze({ dimensions: Object.freeze([...dims]), origin: Object.freeze([...origin]), spacing: Object.freeze([...spacing]), coefficients: new Float32Array(coefficients), validity: new Float32Array(validity), revision });
  }
  function stats() { return Object.freeze({ probeCount: count, validProbes: validity.reduce((n, v) => n + (v > 0 ? 1 : 0), 0), revision, coefficientBytes: coefficients.byteLength, disposed }); }
  function dispose() { if (disposed) return false; coefficients.fill(0); validity.fill(0); disposed = true; return true; }
  return Object.freeze({ kind: "pstudio-radiance-cache", updateProbe, invalidate, sampleSH, evaluateDiffuse, snapshot, stats, dispose });
}

/** Stable view-space clustered-light assignment. Positions use positive forward view-space Z. */
export function buildPStudioClusteredLightAssignments(input = {}) {
  const tilesX = integer(input.tilesX ?? 16, 1, 128, "tilesX"), tilesY = integer(input.tilesY ?? 9, 1, 128, "tilesY"), tilesZ = integer(input.tilesZ ?? 24, 1, 128, "tilesZ");
  const near = Math.max(0.001, finite(input.near, 0.1)), far = Math.max(near + 0.001, finite(input.far, 1000));
  const fovY = clamp(finite(input.verticalFov, Math.PI / 3), 0.01, Math.PI - 0.01), aspect = Math.max(0.01, finite(input.aspect, 16 / 9));
  const maxPerCluster = integer(input.maxLightsPerCluster ?? 128, 1, 4096, "maxLightsPerCluster");
  const maxClusters = integer(input.maxClusters ?? 1048576, 1, 2000000, "maxClusters");
  const total = tilesX * tilesY * tilesZ;
  if (total > maxClusters) throw new RangeError("Cluster grid exceeds maxClusters.");
  if (input.lights != null && !Array.isArray(input.lights)) throw new TypeError("Cluster lights must be an array.");
  const maxLights = integer(input.maxLights ?? 8192, 0, 65536, "maxLights");
  const maxAssignmentTests = integer(input.maxAssignmentTests ?? 50000000, 1, 100000000, "maxAssignmentTests");
  const maxTotalAssignments = integer(input.maxTotalAssignments ?? 4000000, 1, 16000000, "maxTotalAssignments");
  const lightInput = input.lights || [];
  if (lightInput.length > maxLights) throw new RangeError("Cluster light count exceeds maxLights.");
  if (total * lightInput.length > maxAssignmentTests) throw new RangeError("Cluster assignment work exceeds maxAssignmentTests.");
  const lights = lightInput.map((light, originalIndex) => ({ ...light, originalIndex, position: vec3(light.position), radius: Math.max(0, finite(light.radius)), id: String(light.id ?? originalIndex) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.originalIndex - b.originalIndex);
  const tanY = Math.tan(fovY / 2), result = Array.from({ length: total }, () => []);
  let totalAssignments = 0;
  const zEdge = i => near * Math.pow(far / near, i / tilesZ);
  for (let z = 0; z < tilesZ; z++) {
    const z0 = zEdge(z), z1 = zEdge(z + 1);
    for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
      const nx0 = (x / tilesX) * 2 - 1, nx1 = ((x + 1) / tilesX) * 2 - 1;
      const ny0 = (y / tilesY) * 2 - 1, ny1 = ((y + 1) / tilesY) * 2 - 1;
      const xs = [nx0 * z0 * tanY * aspect, nx0 * z1 * tanY * aspect, nx1 * z0 * tanY * aspect, nx1 * z1 * tanY * aspect];
      const ys = [ny0 * z0 * tanY, ny0 * z1 * tanY, ny1 * z0 * tanY, ny1 * z1 * tanY];
      const min = [Math.min(...xs), Math.min(...ys), z0];
      const max = [Math.max(...xs), Math.max(...ys), z1];
      const clusterIndex = (z * tilesY + y) * tilesX + x, list = result[clusterIndex];
      for (const light of lights) {
        const q = light.position.map((v, i) => clamp(v, min[i], max[i]));
        const dx = light.position[0] - q[0], dy = light.position[1] - q[1], dz = light.position[2] - q[2];
        if (dx * dx + dy * dy + dz * dz <= light.radius * light.radius) {
          if (list.length >= maxPerCluster) throw new RangeError("Cluster " + clusterIndex + " exceeds maxLightsPerCluster; no lights were dropped.");
          if (totalAssignments >= maxTotalAssignments) throw new RangeError("Cluster assignments exceed maxTotalAssignments; no lights were silently dropped.");
          list.push(light.originalIndex);
          totalAssignments++;
        }
      }
    }
  }
  const offsets = new Uint32Array(total + 1);
  let indexCount = 0;
  for (let i = 0; i < total; i++) { offsets[i] = indexCount; indexCount += result[i].length; }
  offsets[total] = indexCount;
  const indices = new Uint32Array(indexCount);
  let cursor = 0;
  for (const cluster of result) for (const index of cluster) indices[cursor++] = index;
  return Object.freeze({ layout: Object.freeze({ tilesX, tilesY, tilesZ, clusterCount: total, near, far }), assignments: Object.freeze(result.map(v => Object.freeze(v))), clusterOffsets: offsets, clusterLightIndices: indices, indexCount, lightCount: lights.length });
}

/** Deterministic fixed-step CPU reference for the GPU particle compute ABI. */
export function createPStudioVfxParticleCore(options = {}) {
  const capacity = integer(options.maxParticles ?? 4096, 1, 1000000, "maxParticles");
  const fixedStep = Math.max(1e-4, finite(options.fixedStep, 1 / 60));
  const maxSubsteps = integer(options.maxSubsteps ?? 8, 1, 64, "maxSubsteps");
  const gravity = vec3(options.gravity || [0, -9.81, 0]);
  const particleBufferBytes = capacity * 8 * Float32Array.BYTES_PER_ELEMENT;
  const maxStorageBufferBytes = Number(options.maxStorageBufferBytes ?? 268435456);
  if (particleBufferBytes > maxStorageBufferBytes) throw new RangeError("Particle storage buffer exceeds maxStorageBufferBytes.");
  const particles = new Float32Array(capacity * 8), alive = new Uint8Array(capacity);
  let cursor = 0, accumulator = 0, dropped = 0, droppedTimeSeconds = 0, revision = 0, disposed = false;
  const live = () => { if (disposed) throw new Error("PStudio VFX Core is disposed."); };
  function spawn(input = {}) {
    live();
    let slot = -1;
    for (let i = 0; i < capacity; i++) { const candidate = (cursor + i) % capacity; if (!alive[candidate]) { slot = candidate; break; } }
    if (slot < 0) { dropped++; return false; }
    const p = vec3(input.position), v = vec3(input.velocity), life = Math.max(fixedStep, finite(input.lifetime, 1));
    const offset = slot * 8;
    particles.set([p[0], p[1], p[2], 0, v[0], v[1], v[2], life], offset);
    alive[slot] = 1; cursor = (slot + 1) % capacity; revision++; return slot;
  }
  function step(deltaValue) {
    live();
    const parsedDelta = Number(deltaValue);
    if (!Number.isFinite(parsedDelta) || parsedDelta < 0) throw new RangeError("VFX delta time must be finite and non-negative.");
    const delta = parsedDelta;
    const acceptedDelta = Math.min(delta, fixedStep * maxSubsteps);
    droppedTimeSeconds += delta - acceptedDelta;
    accumulator += acceptedDelta;
    let steps = 0;
    while (accumulator + 1e-9 >= fixedStep && steps < maxSubsteps) {
      for (let i = 0; i < capacity; i++) if (alive[i]) {
        const o = i * 8, age = particles[o + 3] + fixedStep;
        if (age >= particles[o + 7]) { alive[i] = 0; continue; }
        particles[o + 3] = age;
        for (let axis = 0; axis < 3; axis++) {
          const velocityIndex = o + 4 + axis;
          particles[velocityIndex] += gravity[axis] * fixedStep;
          particles[o + axis] += particles[velocityIndex] * fixedStep;
        }
      }
      accumulator -= fixedStep; steps++; revision++;
    }
    return Object.freeze({ steps, interpolationAlpha: accumulator / fixedStep, activeCount: alive.reduce((n, v) => n + v, 0), droppedParticles: dropped, droppedTimeSeconds, revision });
  }
  function snapshot() { live(); return Object.freeze({ capacity, strideFloats: 8, particles: new Float32Array(particles), alive: new Uint8Array(alive), revision, droppedParticles: dropped, droppedTimeSeconds }); }
  function dispose() { if (disposed) return false; particles.fill(0); alive.fill(0); disposed = true; return true; }
  return Object.freeze({ kind: "pstudio-vfx-particle-core", spawn, step, snapshot, dispose });
}

/** Front-to-back single-scattering integration reference. */
export function integratePStudioVolumetricRay(samples, options = {}) {
  if (!Array.isArray(samples) && !ArrayBuffer.isView(samples)) throw new TypeError("Volumetric samples must be an array.");
  const maxSamples = integer(options.maxSamples ?? 512, 1, 4096, "maxSamples");
  if (samples.length > maxSamples) throw new RangeError("Volumetric ray exceeds maxSamples.");
  const stepLength = Math.max(0, finite(options.stepLength, 1)), g = clamp(finite(options.anisotropy, 0), -0.95, 0.95);
  const cosTheta = clamp(finite(options.cosTheta, 1), -1, 1);
  const phaseDenom = Math.pow(Math.max(1e-5, 1 + g * g - 2 * g * cosTheta), 1.5);
  const phase = (1 - g * g) / (4 * Math.PI * phaseDenom);
  const radiance = [0, 0, 0];
  let transmittance = 1;
  for (const sample of samples) {
    const density = Math.max(0, finite(sample?.density)), sigmaA = Math.max(0, finite(sample?.sigmaAbsorption)), sigmaS = Math.max(0, finite(sample?.sigmaScattering));
    const sigmaT = density * (sigmaA + sigmaS);
    const segmentT = Math.exp(-Math.min(80, sigmaT * stepLength));
    const scatter = sigmaT > 1e-8 ? (1 - segmentT) * (density * sigmaS / sigmaT) * phase : 0;
    const color = vec3(sample?.lighting || [1, 1, 1]);
    for (let c = 0; c < 3; c++) radiance[c] += transmittance * scatter * Math.max(0, color[c]);
    transmittance *= segmentT;
    if (transmittance < 1e-4) break;
  }
  return Object.freeze({ radiance: Object.freeze(radiance), transmittance, opacity: 1 - transmittance, phase });
}

/** Rejects stale temporal history and clamps accepted history to current neighbourhood bounds. */
export function resolvePStudioVolumetricHistory(input = {}) {
  const current = vec3(input.current), previous = vec3(input.previous);
  const min = vec3(input.neighborhoodMin || current), max = vec3(input.neighborhoodMax || current);
  const depthDelta = Math.abs(finite(input.currentDepth) - finite(input.previousDepth));
  const depthThreshold = Math.max(0, finite(input.depthThreshold, 0.02));
  const frameValid = input.previousFrameId != null && input.currentFrameId === input.previousFrameId + 1;
  const accepted = frameValid && depthDelta <= depthThreshold && input.cameraCut !== true;
  const weight = accepted ? clamp(finite(input.historyWeight, 0.85), 0, 0.95) : 0;
  const resolved = current.map((v, i) => v * (1 - weight) + clamp(previous[i], Math.min(min[i], max[i]), Math.max(min[i], max[i])) * weight);
  return Object.freeze({ color: Object.freeze(resolved), historyAccepted: accepted, historyWeight: weight, depthDelta });
}

export function buildPStudioVolumetricFroxelLayout(input = {}) {
  const width = integer(input.width ?? 1920, 1, 16384, "width"), height = integer(input.height ?? 1080, 1, 16384, "height");
  const tileSize = integer(input.tileSize ?? 8, 4, 32, "tileSize"), depthSlices = integer(input.depthSlices ?? 64, 8, 256, "depthSlices");
  const maxFroxels = integer(input.maxFroxels ?? 4194304, 1, 16777216, "maxFroxels");
  const x = Math.ceil(width / tileSize), y = Math.ceil(height / tileSize), count = x * y * depthSlices;
  if (count > maxFroxels) throw new RangeError("Volumetric froxel grid exceeds maxFroxels.");
  return Object.freeze({ x, y, z: depthSlices, count, tileSize, width, height });
}

export function buildPStudioAdvancedRenderPasses() {
  return Object.freeze([
    Object.freeze({ id: "advanced.gi.probe-update", stage: "compute", reads: Object.freeze(["world.depth", "world.normal", "lighting"]), writes: Object.freeze(["gi.probe-cache"]) }),
    Object.freeze({ id: "advanced.vfx.simulation", stage: "compute", reads: Object.freeze(["vfx.particles"]), writes: Object.freeze(["vfx.particles.next"]) }),
    Object.freeze({ id: "advanced.volumetric.injection", stage: "compute", reads: Object.freeze(["froxel.layout", "lighting", "shadow"]), writes: Object.freeze(["volumetric.inscattering"]) }),
    Object.freeze({ id: "advanced.volumetric.integrate", stage: "compute", reads: Object.freeze(["volumetric.inscattering", "volumetric.history"]), writes: Object.freeze(["volumetric.current"]) }),
    Object.freeze({ id: "advanced.composite", stage: "post", reads: Object.freeze(["world.color", "volumetric.current", "gi.probe-cache"]), writes: Object.freeze(["frame.color"]) })
  ]);
}

export const PSTUDIO_VFX_PARTICLE_COMPUTE_WGSL = [
"struct Particle { positionAge: vec4<f32>, velocityLifetime: vec4<f32> };",
"struct SimParams { deltaTime: f32, gravity: vec3<f32>, particleCount: u32, _pad: vec3<u32> };",
"@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;",
"@group(0) @binding(1) var<uniform> params: SimParams;",
"@compute @workgroup_size(128) fn updateParticles(@builtin(global_invocation_id) gid: vec3<u32>) {",
" let i = gid.x; if (i >= params.particleCount) { return; }",
" var p = particles[i]; if (p.positionAge.w >= p.velocityLifetime.w) { return; }",
" p.velocityLifetime.xyz += params.gravity * params.deltaTime;",
" p.positionAge.xyz += p.velocityLifetime.xyz * params.deltaTime;",
" p.positionAge.w += params.deltaTime; particles[i] = p;",
"}"
].join("\n");

export const PSTUDIO_VOLUMETRIC_WGSL = [
"fn pstudioHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {",
" let gg = g * g; let d = max(1.0e-5, 1.0 + gg - 2.0 * g * cosTheta);",
" return (1.0 - gg) / (12.5663706144 * d * sqrt(d));",
"}",
"fn pstudioBeerLambert(extinction: f32, distance: f32) -> f32 {",
" return exp(-max(0.0, extinction) * max(0.0, distance));",
"}"
].join("\n");


/** Uploads SH coefficients and validity to persistent GPU storage buffers. */
export function createPStudioRadianceCacheGpuBinding(backend, cache, options = {}) {
  if (!backend || typeof backend.createResource !== "function" || typeof backend.writeResource !== "function" || typeof backend.destroyResource !== "function") {
    throw new TypeError("A PStudio Graphics Core-compatible GPU backend is required.");
  }
  if (!cache || typeof cache.snapshot !== "function") throw new TypeError("A PStudio Radiance Cache is required.");
  const prefix = String(options.id || "pstudio.gi.radiance-cache"), snapshot = cache.snapshot(), created = [];
  let coefficients, validity, disposed = false;
  try {
    coefficients = backend.createResource({ id: prefix + ".sh9", type: "buffer", size: snapshot.coefficients.byteLength, usage: ["storage", "copy-dst"] }, { initialData: snapshot.coefficients });
    if (!coefficients) throw new Error("Unable to allocate radiance SH buffer.");
    created.push(coefficients);
    validity = backend.createResource({ id: prefix + ".validity", type: "buffer", size: snapshot.validity.byteLength, usage: ["storage", "copy-dst"] }, { initialData: snapshot.validity });
    if (!validity) throw new Error("Unable to allocate radiance validity buffer.");
    created.push(validity);
  } catch (error) {
    for (const resource of created.reverse()) { try { backend.destroyResource(resource); } catch (_) {} }
    throw error;
  }
  return Object.freeze({
    kind: "pstudio-radiance-cache-gpu-binding", coefficients, validity, dimensions: snapshot.dimensions,
    upload() {
      if (disposed) throw new Error("Radiance Cache GPU binding is disposed.");
      const next = cache.snapshot();
      if (next.coefficients.byteLength !== snapshot.coefficients.byteLength || next.validity.byteLength !== snapshot.validity.byteLength) throw new RangeError("Radiance cache dimensions changed; recreate its GPU binding.");
      backend.writeResource(coefficients, next.coefficients);
      backend.writeResource(validity, next.validity);
      return Object.freeze({ revision: next.revision, probeCount: next.validity.length });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      for (const resource of [...created].reverse()) backend.destroyResource(resource);
      return true;
    }
  });
}

/** Creates a real WebGPU compute pipeline and bindings for particle simulation. */
export function createPStudioGpuParticleSystem(backend, options = {}) {
  if (!backend || typeof backend.compileShader !== "function" || typeof backend.createComputePipeline !== "function" ||
      typeof backend.createResource !== "function" || typeof backend.writeResource !== "function" ||
      typeof backend.dispatchCompute !== "function" || !backend.device) {
    throw new TypeError("An initialized direct PStudio WebGPU backend is required.");
  }
  const capacity = integer(options.maxParticles ?? 4096, 1, 1000000, "maxParticles");
  const shaderId = String(options.shaderId || "pstudio.vfx.particles.update"), prefix = String(options.resourcePrefix || shaderId);
  const particleBufferBytes = capacity * 8 * Float32Array.BYTES_PER_ELEMENT;
  if (particleBufferBytes > Number(backend.device.limits?.maxStorageBufferBindingSize ?? 268435456)) throw new RangeError("Particle buffer exceeds the device storage-buffer binding limit.");
  let particleBuffer = null, parameterBuffer = null, pipeline = null, shader = null, bindGroup = null, disposed = false, initialized = false;
  async function initialize(initialParticles = null) {
    if (disposed) throw new Error("GPU particle system is disposed.");
    if (initialized) return Object.freeze({ capacity, shaderId });
    const initial = initialParticles instanceof Float32Array ? initialParticles : new Float32Array(capacity * 8);
    if (initial.length !== capacity * 8) throw new RangeError("Initial particle buffer must contain exactly maxParticles * 8 floats.");
    shader = await backend.compileShader({ descriptor: { id: shaderId, language: "wgsl", source: PSTUDIO_VFX_PARTICLE_COMPUTE_WGSL, entryPoint: "updateParticles" } });
    try {
      particleBuffer = backend.createResource({ id: prefix + ".particles", type: "buffer", size: initial.byteLength, usage: ["storage", "copy-dst"] }, { initialData: initial });
      if (!particleBuffer) throw new Error("Unable to allocate particle storage buffer.");
      parameterBuffer = backend.createResource({ id: prefix + ".params", type: "buffer", size: 48, usage: ["uniform", "copy-dst"] }, { initialData: new Uint8Array(48) });
      if (!parameterBuffer) throw new Error("Unable to allocate particle parameter buffer.");
      pipeline = await backend.createComputePipeline(shaderId, { entryPoint: "updateParticles" });
      bindGroup = backend.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: particleBuffer.handle } }, { binding: 1, resource: { buffer: parameterBuffer.handle } }]
      });
      initialized = true;
      return Object.freeze({ capacity, shaderId, particleBuffer, parameterBuffer });
    } catch (error) {
      if (parameterBuffer) backend.destroyResource(parameterBuffer);
      if (particleBuffer) backend.destroyResource(particleBuffer);
      shader?.dispose?.();
      parameterBuffer = particleBuffer = shader = null;
      throw error;
    }
  }
  function dispatch(input = {}) {
    if (!initialized || disposed) throw new Error("GPU particle system is not initialized.");
    const deltaTime = finite(input.deltaTime, -1);
    if (deltaTime < 0) throw new RangeError("Particle deltaTime must be finite and non-negative.");
    const gravity = vec3(input.gravity || [0, -9.81, 0]), particleCount = integer(input.particleCount ?? capacity, 0, capacity, "particleCount");
    if (!particleCount) return Object.freeze({ dispatched: false, particleCount: 0, groups: [0, 1, 1] });
    const data = new ArrayBuffer(48), view = new DataView(data);
    view.setFloat32(0, deltaTime, true);
    view.setFloat32(16, gravity[0], true); view.setFloat32(20, gravity[1], true); view.setFloat32(24, gravity[2], true);
    view.setUint32(28, particleCount, true);
    backend.writeResource(parameterBuffer, new Uint8Array(data));
    const groups = [Math.ceil(particleCount / 128), 1, 1];
    const maxGroups = Number(backend.device.limits?.maxComputeWorkgroupsPerDimension ?? 65535);
    if (groups[0] > maxGroups) throw new RangeError("Particle dispatch exceeds the device workgroup limit.");
    return backend.dispatchCompute({ kernel: { id: shaderId, shaderId }, groups, resources: { pipeline, bindGroups: [bindGroup] }, parameters: { particleCount, deltaTime } });
  }
  function dispose() {
    if (disposed) return false;
    disposed = true; initialized = false; bindGroup = null; pipeline = null;
    if (parameterBuffer) backend.destroyResource(parameterBuffer);
    if (particleBuffer) backend.destroyResource(particleBuffer);
    shader?.dispose?.();
    parameterBuffer = particleBuffer = shader = null;
    return true;
  }
  return Object.freeze({ kind: "pstudio-gpu-particle-system", capacity, initialize, dispatch, dispose, get initialized() { return initialized; } });
}


export const PSTUDIO_VOLUMETRIC_COMPUTE_WGSL = [
"struct VolumeSample { density: f32, sigmaAbsorption: f32, sigmaScattering: f32, stepLength: f32, lighting: vec4<f32> };",
"struct VolumeResult { radiance: vec4<f32>, transmittance: f32, opacity: f32, _pad: vec2<f32> };",
"struct VolumeParams { sampleCount: u32, rayCount: u32, anisotropy: f32, cosTheta: f32 };",
"@group(0) @binding(0) var<storage, read> samples: array<VolumeSample>;",
"@group(0) @binding(1) var<storage, read_write> results: array<VolumeResult>;",
"@group(0) @binding(2) var<uniform> params: VolumeParams;",
"fn volumePhase(cosTheta: f32, g: f32) -> f32 {",
" let gg = g * g; let d = max(1.0e-5, 1.0 + gg - 2.0 * g * cosTheta);",
" return (1.0 - gg) / (12.5663706144 * d * sqrt(d));",
"}",
"@compute @workgroup_size(64) fn integrateVolumeRays(@builtin(global_invocation_id) gid: vec3<u32>) {",
" let ray = gid.x; if (ray >= params.rayCount) { return; }",
" var radiance = vec3<f32>(0.0); var transmittance = 1.0;",
" let phase = volumePhase(clamp(params.cosTheta, -1.0, 1.0), clamp(params.anisotropy, -0.95, 0.95));",
" for (var i = 0u; i < params.sampleCount; i = i + 1u) {",
"  let s = samples[ray * params.sampleCount + i];",
"  let density = max(0.0, s.density); let sigmaA = max(0.0, s.sigmaAbsorption); let sigmaS = max(0.0, s.sigmaScattering);",
"  let sigmaT = density * (sigmaA + sigmaS);",
"  let segmentT = exp(-min(80.0, sigmaT * max(0.0, s.stepLength)));",
"  var scatter = 0.0;",
"  if (sigmaT > 1.0e-8) { scatter = (1.0 - segmentT) * (density * sigmaS / sigmaT) * phase; }",
"  radiance += transmittance * scatter * max(s.lighting.xyz, vec3<f32>(0.0));",
"  transmittance *= segmentT;",
"  if (transmittance < 1.0e-4) { break; }",
" }",
" results[ray].radiance = vec4<f32>(radiance, 1.0);",
" results[ray].transmittance = transmittance; results[ray].opacity = 1.0 - transmittance;",
" results[ray]._pad = vec2<f32>(0.0);",
"}"
].join("\n");

/** Real WebGPU froxel-ray integration dispatch with caller-owned input layout. */
export function createPStudioVolumetricGpuSystem(backend, options = {}) {
  if (!backend || typeof backend.compileShader !== "function" || typeof backend.createComputePipeline !== "function" ||
      typeof backend.createResource !== "function" || typeof backend.writeResource !== "function" ||
      typeof backend.dispatchCompute !== "function" || !backend.device) {
    throw new TypeError("An initialized direct PStudio WebGPU backend is required.");
  }
  const maxRays = integer(options.maxRays ?? 4096, 1, 1048576, "maxRays");
  const maxSamplesPerRay = integer(options.maxSamplesPerRay ?? 128, 1, 4096, "maxSamplesPerRay");
  const maxBufferBytes = integer(options.maxBufferBytes ?? 268435456, 4, Number.MAX_SAFE_INTEGER, "maxBufferBytes");
  const prefix = String(options.resourcePrefix || "pstudio.volumetric");
  const shaderId = String(options.shaderId || "pstudio.volumetric.integrate");
  const sampleBytes = maxRays * maxSamplesPerRay * 32;
  const resultBytes = maxRays * 32;
  if (!Number.isSafeInteger(sampleBytes) || !Number.isSafeInteger(resultBytes) || sampleBytes > maxBufferBytes || resultBytes > maxBufferBytes) throw new RangeError("Volumetric GPU buffers exceed the configured allocation limit.");
  const deviceStorageLimit = Number(backend.device.limits?.maxStorageBufferBindingSize ?? maxBufferBytes);
  if (sampleBytes > deviceStorageLimit || resultBytes > deviceStorageLimit) throw new RangeError("Volumetric GPU buffers exceed maxStorageBufferBindingSize.");
  let shader = null, pipeline = null, inputBuffer = null, outputBuffer = null, paramsBuffer = null, bindGroup = null, initialized = false, disposed = false;

  async function initialize() {
    if (disposed) throw new Error("Volumetric GPU system is disposed.");
    if (initialized) return Object.freeze({ maxRays, maxSamplesPerRay, outputBuffer });
    shader = await backend.compileShader({ descriptor: { id: shaderId, language: "wgsl", source: PSTUDIO_VOLUMETRIC_COMPUTE_WGSL, entryPoint: "integrateVolumeRays" } });
    const created = [];
    try {
      inputBuffer = backend.createResource({ id: prefix + ".samples", type: "buffer", size: sampleBytes, usage: ["storage", "copy-dst"] });
      if (!inputBuffer) throw new Error("Unable to allocate volumetric sample buffer.");
      created.push(inputBuffer);
      outputBuffer = backend.createResource({ id: prefix + ".results", type: "buffer", size: resultBytes, usage: ["storage", "copy-src"] });
      if (!outputBuffer) throw new Error("Unable to allocate volumetric result buffer.");
      created.push(outputBuffer);
      paramsBuffer = backend.createResource({ id: prefix + ".params", type: "buffer", size: 16, usage: ["uniform", "copy-dst"] }, { initialData: new Uint8Array(16) });
      if (!paramsBuffer) throw new Error("Unable to allocate volumetric parameter buffer.");
      created.push(paramsBuffer);
      pipeline = await backend.createComputePipeline(shaderId, { entryPoint: "integrateVolumeRays" });
      bindGroup = backend.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer.handle } },
          { binding: 1, resource: { buffer: outputBuffer.handle } },
          { binding: 2, resource: { buffer: paramsBuffer.handle } }
        ]
      });
      initialized = true;
      return Object.freeze({ maxRays, maxSamplesPerRay, outputBuffer });
    } catch (error) {
      for (const resource of created.reverse()) { try { backend.destroyResource(resource); } catch (_) {} }
      shader?.dispose?.();
      shader = inputBuffer = outputBuffer = paramsBuffer = null;
      throw error;
    }
  }

  function dispatch(rays, options = {}) {
    if (!initialized || disposed) throw new Error("Volumetric GPU system is not initialized.");
    if (!Array.isArray(rays) || rays.length > maxRays) throw new RangeError("Ray batch exceeds maxRays.");
    const rayCount = rays.length;
    if (!rayCount) return Object.freeze({ dispatched: false, rayCount: 0, outputBuffer });
    const sampleCount = rays[0]?.length ?? 0;
    if (!sampleCount || sampleCount > maxSamplesPerRay || rays.some(ray => !Array.isArray(ray) || ray.length !== sampleCount)) {
      throw new RangeError("Every volumetric ray must use the same supported, non-zero sample count.");
    }
    const packed = new Float32Array(rayCount * sampleCount * 8);
    let cursor = 0;
    for (const ray of rays) for (const sample of ray) {
      const lighting = vec3(sample?.lighting || [1, 1, 1]);
      packed.set([
        Math.max(0, finite(sample?.density)),
        Math.max(0, finite(sample?.sigmaAbsorption)),
        Math.max(0, finite(sample?.sigmaScattering)),
        Math.max(0, finite(sample?.stepLength, 1)),
        Math.max(0, lighting[0]), Math.max(0, lighting[1]), Math.max(0, lighting[2]), 0
      ], cursor);
      cursor += 8;
    }
    const parameters = new ArrayBuffer(16), view = new DataView(parameters);
    view.setUint32(0, sampleCount, true); view.setUint32(4, rayCount, true);
    view.setFloat32(8, clamp(finite(options.anisotropy, 0), -0.95, 0.95), true);
    view.setFloat32(12, clamp(finite(options.cosTheta, 1), -1, 1), true);
    backend.writeResource(inputBuffer, packed);
    backend.writeResource(paramsBuffer, new Uint8Array(parameters));
    const groups = [Math.ceil(rayCount / 64), 1, 1];
    if (groups[0] > Number(backend.device.limits?.maxComputeWorkgroupsPerDimension ?? 65535)) throw new RangeError("Volumetric dispatch exceeds the device workgroup limit.");
    return Object.freeze({
      ...backend.dispatchCompute({ kernel: { id: shaderId, shaderId }, groups, resources: { pipeline, bindGroups: [bindGroup] }, parameters: { rayCount, sampleCount } }),
      rayCount, sampleCount, outputBuffer
    });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true; initialized = false; bindGroup = null; pipeline = null;
    for (const resource of [paramsBuffer, outputBuffer, inputBuffer]) if (resource) backend.destroyResource(resource);
    shader?.dispose?.();
    shader = inputBuffer = outputBuffer = paramsBuffer = null;
    return true;
  }
  return Object.freeze({ kind: "pstudio-volumetric-gpu-system", maxRays, maxSamplesPerRay, initialize, dispatch, dispose, get outputBuffer() { return outputBuffer; } });
}
