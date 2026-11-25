/**
 * PStudio rendering GI runtime helpers.
 *
 * Kept independent from Three.js so the probe scheduler can be tested without
 * a GPU context and reused by WebGL/WebGPU backends.
 */

const DEFAULT_PROBE_HALF_LIFE_MS = 240;
const DEFAULT_FADE_HALF_LIFE_MS = 320;
const DEFAULT_PROBE_MARGIN = 0.75;

export function dynamicProbeCaptureIntervalMs(renderMs, gpuFresh) {
  const ms = Number(renderMs);
  if (!Number.isFinite(ms) || ms < 0) return 900;
  if (gpuFresh) {
    if (ms <= 6) return 300;
    if (ms <= 9) return 550;
    if (ms <= 12) return 900;
    return 1500;
  }
  if (ms <= 4) return 450;
  if (ms <= 7) return 900;
  return 1500;
}

export function dynamicProbeCaptureResolution(qualityPreset) {
  if (qualityPreset === 'ultra') return 192;
  if (qualityPreset === 'maximum') return 128;
  if (qualityPreset === 'high') return 96;
  return 64;
}

export function nextDirtyProbeIndex(dirty, cursor = 0) {
  if (!dirty || typeof dirty.length !== 'number' || dirty.length === 0) return -1;
  const length = dirty.length;
  const start = ((Math.floor(Number(cursor) || 0) % length) + length) % length;
  for (let offset = 0; offset < length; offset += 1) {
    const index = (start + offset) % length;
    if (dirty[index]) return index;
  }
  return -1;
}

function readPosition(value) {
  const p = value?.position ?? value;
  if (Array.isArray(p) && p.length >= 3) {
    const result = [Number(p[0]), Number(p[1]), Number(p[2])];
    return result.every(Number.isFinite) ? result : null;
  }
  if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && Number.isFinite(Number(p.z))) {
    return [Number(p.x), Number(p.y), Number(p.z)];
  }
  return null;
}

function toSnapshotMap(snapshots) {
  if (snapshots instanceof Map) return snapshots;
  const result = new Map();
  if (!Array.isArray(snapshots)) return result;
  for (const item of snapshots) {
    if (item && item.key !== undefined && item.key !== null) result.set(String(item.key), item);
  }
  return result;
}

/**
 * Returns the probe indices influenced by lights that were added, removed, or
 * changed. A zero/unknown range is treated as unbounded, matching Three.js'
 * PointLight distance=0 convention.
 */
export function findChangedProbeIndices(
  probes,
  previousSnapshots,
  nextSnapshots,
  margin = DEFAULT_PROBE_MARGIN
) {
  if (!Array.isArray(probes) || probes.length === 0) return [];
  const previous = toSnapshotMap(previousSnapshots);
  const next = toSnapshotMap(nextSnapshots);
  const keys = new Set([...previous.keys(), ...next.keys()]);
  const changed = [];

  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if ((before?.signature ?? null) !== (after?.signature ?? null)) changed.push([before, after]);
  }
  if (changed.length === 0) return [];

  const affected = new Set();
  const safeMargin = Math.max(0, Number.isFinite(Number(margin)) ? Number(margin) : DEFAULT_PROBE_MARGIN);
  for (const pair of changed) {
    for (const light of pair) {
      if (!light) continue;
      const center = readPosition(light);
      const radiusValue = Number(light.radius);
      const unbounded = !Number.isFinite(radiusValue) || radiusValue <= 0;
      if (!center || unbounded) {
        for (let i = 0; i < probes.length; i += 1) affected.add(i);
        continue;
      }
      const radius = Math.max(0, radiusValue) + safeMargin;
      const radiusSquared = radius * radius;
      for (let i = 0; i < probes.length; i += 1) {
        const position = readPosition(probes[i]);
        if (!position) {
          affected.add(i);
          continue;
        }
        const dx = position[0] - center[0];
        const dy = position[1] - center[1];
        const dz = position[2] - center[2];
        if ((dx * dx) + (dy * dy) + (dz * dz) <= radiusSquared) affected.add(i);
      }
    }
  }
  return [...affected].sort((a, b) => a - b);
}

/**
 * Exponential temporal blend for the 9 RGB spherical-harmonic coefficients.
 * Mutates target in place to avoid allocating a new 27-float array per capture.
 */
export function blendSHCoefficients(
  target,
  incoming,
  deltaMs,
  halfLifeMs = DEFAULT_PROBE_HALF_LIFE_MS
) {
  if (!target || !incoming || target.length !== incoming.length || target.length < 27) return 0;
  const elapsed = Math.max(0, Math.min(10000, Number(deltaMs) || 0));
  const halfLife = Math.max(1, Number(halfLifeMs) || DEFAULT_PROBE_HALF_LIFE_MS);
  if (elapsed <= 0) return 0;
  const alpha = 1 - Math.exp((-Math.LN2 * elapsed) / halfLife);
  for (let i = 0; i < 27; i += 1) {
    const current = Number(target[i]) || 0;
    const next = Number(incoming[i]) || 0;
    target[i] = current + ((next - current) * alpha);
  }
  return alpha;
}

/**
 * Fade a removed/disabled dynamic-light contribution without a visible pop.
 * The result reports when the residual field is small enough to retire.
 */
export function decaySHCoefficients(
  coefficients,
  deltaMs,
  halfLifeMs = DEFAULT_FADE_HALF_LIFE_MS,
  epsilon = 1e-4
) {
  if (!coefficients || coefficients.length < 27) return { changed: false, finished: true };
  const elapsed = Math.max(0, Math.min(10000, Number(deltaMs) || 0));
  if (elapsed <= 0) return { changed: false, finished: false };
  const halfLife = Math.max(1, Number(halfLifeMs) || DEFAULT_FADE_HALF_LIFE_MS);
  const factor = Math.exp((-Math.LN2 * elapsed) / halfLife);
  let maxAbs = 0;
  for (let i = 0; i < 27; i += 1) {
    const value = (Number(coefficients[i]) || 0) * factor;
    coefficients[i] = value;
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  const threshold = Math.max(0, Number(epsilon) || 0);
  if (maxAbs <= threshold) {
    coefficients.fill(0);
    return { changed: true, finished: true };
  }
  return { changed: true, finished: false };
}
