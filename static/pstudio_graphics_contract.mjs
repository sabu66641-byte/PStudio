/**
 * Vendor-neutral contracts for the PStudio Independent Graphics Engine.
 *
 * This module intentionally has no Three.js, WebGPU, WebGL, DOM or browser
 * dependency. Backend-specific objects are carried as opaque references.
 */
export const PSTUDIO_GRAPHICS_API_VERSION = '0.1.0';

export const PSTUDIO_GRAPHICS_BACKENDS = Object.freeze([
  'webgpu',
  'webgl2',
  'vulkan',
  'direct3d12',
  'metal'
]);

export const PSTUDIO_GRAPHICS_STATES = Object.freeze([
  'idle',
  'initializing',
  'ready',
  'fallback',
  'lost',
  'failed',
  'disposed'
]);

const STATE_TRANSITIONS = Object.freeze({
  idle: Object.freeze(['initializing', 'disposed']),
  initializing: Object.freeze(['ready', 'fallback', 'failed', 'disposed']),
  ready: Object.freeze(['lost', 'failed', 'disposed']),
  fallback: Object.freeze(['lost', 'failed', 'disposed']),
  lost: Object.freeze(['initializing', 'fallback', 'failed', 'disposed']),
  failed: Object.freeze(['initializing', 'disposed']),
  disposed: Object.freeze([])
});

function freezeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze({ ...value });
}

function normalizeFeatureList(value) {
  const source = Array.isArray(value) ? value : [];
  return Object.freeze([...new Set(source.map(item => String(item).trim().toLowerCase()).filter(Boolean))].sort());
}

export class PStudioGraphicsError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'PStudio Graphics Engine error.'));
    this.name = 'PStudioGraphicsError';
    this.code = String(options.code || 'PSTUDIO_GRAPHICS_ERROR');
    this.backend = options.backend ? String(options.backend) : null;
    this.details = freezeRecord(options.details);
  }
}

export function createPStudioGraphicsBackendDescriptor(input = {}) {
  const id = String(input.id || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(id)) {
    throw new TypeError('Graphics backend adapter id must be 2–64 lowercase identifier characters.');
  }
  const backend = String(input.backend || '').trim().toLowerCase();
  if (!PSTUDIO_GRAPHICS_BACKENDS.includes(backend)) {
    throw new TypeError('Unsupported PStudio graphics backend: ' + backend);
  }
  const priority = Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0;
  const limits = {};
  for (const [key, value] of Object.entries(input.limits || {})) {
    if (Number.isFinite(Number(value)) && Number(value) >= 0) limits[String(key)] = Number(value);
  }
  return Object.freeze({
    id,
    backend,
    priority,
    features: normalizeFeatureList(input.features),
    limits: Object.freeze(limits),
    metadata: freezeRecord(input.metadata)
  });
}

export function validatePStudioGraphicsBackendAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('A graphics backend adapter object is required.');
  }
  if (typeof adapter.initialize !== 'function') {
    throw new TypeError('Graphics backend adapter must implement initialize(context).');
  }
  const descriptor = createPStudioGraphicsBackendDescriptor(adapter.descriptor || adapter);
  if (adapter.supports != null && typeof adapter.supports !== 'function') {
    throw new TypeError('Graphics backend adapter supports must be a function when provided.');
  }
  return Object.freeze({ adapter, descriptor });
}

export function createPStudioGraphicsFrame(input = {}) {
  const frameId = input.frameId == null ? 0 : Number(input.frameId);
  const timeMs = input.timeMs == null ? 0 : Number(input.timeMs);
  const deltaMs = input.deltaMs == null ? 0 : Number(input.deltaMs);
  const viewport = input.viewport || {};
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const pixelRatio = viewport.pixelRatio == null ? 1 : Number(viewport.pixelRatio);

  if (!Number.isSafeInteger(frameId) || frameId < 0) {
    throw new TypeError('Graphics frameId must be a non-negative safe integer.');
  }
  if (!Number.isFinite(timeMs) || timeMs < 0 || !Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new TypeError('Graphics frame time values must be finite and non-negative.');
  }
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError('Graphics frame viewport width and height must be positive integers.');
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new TypeError('Graphics frame viewport pixelRatio must be finite and greater than zero.');
  }

  return Object.freeze({
    frameId,
    timeMs,
    deltaMs,
    viewport: Object.freeze({ width, height, pixelRatio }),
    scene: input.scene ?? null,
    view: input.view ?? null,
    environment: input.environment ?? null,
    quality: input.quality ?? null,
    metadata: freezeRecord(input.metadata)
  });
}

export function assertPStudioGraphicsStateTransition(current, next) {
  const from = String(current || '');
  const to = String(next || '');
  if (from === to) return true;
  if (!PSTUDIO_GRAPHICS_STATES.includes(from) || !PSTUDIO_GRAPHICS_STATES.includes(to)) {
    throw new TypeError('Unknown PStudio graphics lifecycle state: ' + from + ' → ' + to);
  }
  if (!STATE_TRANSITIONS[from].includes(to)) {
    throw new PStudioGraphicsError('Invalid graphics lifecycle transition: ' + from + ' → ' + to, {
      code: 'PSTUDIO_GRAPHICS_INVALID_STATE_TRANSITION',
      details: { current: from, next: to }
    });
  }
  return true;
}
