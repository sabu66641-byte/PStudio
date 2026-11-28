const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createPStudioGraphicsBackendDescriptor,
  createPStudioGraphicsFrame,
  assertPStudioGraphicsStateTransition,
  PSTUDIO_GRAPHICS_API_VERSION
} = require('../static/pstudio_graphics_contract.mjs');
const { createPStudioGraphicsHAL } = require('../static/pstudio_graphics_hal.mjs');
const { createPStudioGraphicsEngine } = require('../static/pstudio_graphics_engine.mjs');

function makeAdapter({ id, backend, priority = 0, features = [], initialize, supports } = {}) {
  return {
    descriptor: createPStudioGraphicsBackendDescriptor({ id, backend, priority, features }),
    supports,
    initialize: initialize || (async () => ({ render: () => true, dispose() {} }))
  };
}

test('vendor-neutral graphics contracts validate descriptors, frames and lifecycle transitions', () => {
  assert.equal(PSTUDIO_GRAPHICS_API_VERSION, '0.1.0');
  const descriptor = createPStudioGraphicsBackendDescriptor({
    id: 'test.webgpu',
    backend: 'webgpu',
    features: ['compute', 'timestamp-query', 'compute'],
    limits: { maxTextureDimension2D: 8192, invalid: Infinity }
  });
  assert.deepEqual(descriptor.features, ['compute', 'timestamp-query']);
  assert.equal(descriptor.limits.maxTextureDimension2D, 8192);
  assert.equal(Object.isFrozen(descriptor), true);

  const frame = createPStudioGraphicsFrame({
    frameId: 7,
    timeMs: 100,
    deltaMs: 16.6,
    viewport: { width: 1280, height: 720, pixelRatio: 1.5 },
    scene: { opaque: true },
    metadata: { source: 'unit-test' }
  });
  assert.equal(frame.frameId, 7);
  assert.equal(frame.viewport.width, 1280);
  assert.equal(Object.isFrozen(frame.viewport), true);
  assert.throws(() => createPStudioGraphicsFrame({ viewport: { width: 0, height: 720 } }), /positive integers/);
  assert.throws(() => createPStudioGraphicsBackendDescriptor({ id: 'bad', backend: 'unknown' }), /Unsupported/);
  assert.equal(assertPStudioGraphicsStateTransition('idle', 'initializing'), true);
  assert.throws(() => assertPStudioGraphicsStateTransition('disposed', 'ready'), /Invalid graphics lifecycle transition/);
});

test('HAL selects the preferred compatible backend and exposes its capabilities', async () => {
  const hal = createPStudioGraphicsHAL({ preferredBackend: 'webgpu' });
  let rendered = null;
  hal.register(makeAdapter({
    id: 'webgl.compat',
    backend: 'webgl2',
    priority: 10,
    features: ['pbr'],
    initialize: async () => ({ render: frame => { rendered = frame; return true; } })
  }));
  hal.register(makeAdapter({
    id: 'webgpu.primary',
    backend: 'webgpu',
    priority: 1,
    features: ['pbr', 'compute'],
    initialize: async () => ({ render: frame => { rendered = frame; return true; } })
  }));

  const selected = await hal.initialize({ requiredFeatures: ['compute', 'pbr'] });
  assert.equal(selected.backend, 'webgpu');
  assert.equal(selected.state, 'ready');
  assert.equal(hal.render({ frameId: 1 }), true);
  assert.equal(rendered.frameId, 1);
  assert.equal(hal.resize(640, 480, 1), true);
  assert.equal(hal.dispose(), true);
});

test('HAL performs explicit fallback and preserves the failed backend reason', async () => {
  const hal = createPStudioGraphicsHAL({ preferredBackend: 'webgpu', backendOrder: ['webgl2'] });
  let fallbackRenderCount = 0;
  hal.register(makeAdapter({
    id: 'primary.webgpu',
    backend: 'webgpu',
    features: ['pbr'],
    initialize: async () => { throw new Error('adapter initialization failed'); }
  }));
  hal.register(makeAdapter({
    id: 'fallback.webgl2',
    backend: 'webgl2',
    features: ['pbr'],
    initialize: async () => ({ render: () => { fallbackRenderCount += 1; return true; } })
  }));

  const state = await hal.initialize({ requiredFeatures: ['pbr'] });
  assert.equal(state.state, 'fallback');
  assert.equal(state.backend, 'webgl2');
  assert.equal(state.attempts[0].status, 'failed');
  assert.match(state.attempts[0].reason, /adapter initialization failed/);
  assert.equal(hal.render({}), true);
  assert.equal(fallbackRenderCount, 1);
  hal.dispose();
});

test('HAL never silently substitutes an adapter when fallback is disabled', async () => {
  const hal = createPStudioGraphicsHAL({ preferredBackend: 'webgpu', allowFallback: false });
  hal.register(makeAdapter({
    id: 'primary.webgpu',
    backend: 'webgpu',
    initialize: async () => { throw new Error('primary failed'); }
  }));
  hal.register(makeAdapter({
    id: 'secondary.webgl2',
    backend: 'webgl2'
  }));
  await assert.rejects(hal.initialize(), error => error.code === 'PSTUDIO_GRAPHICS_NO_BACKEND');
  assert.equal(hal.getState().state, 'failed');
  assert.equal(hal.dispose(), true);
});

test('late adapter initialization is disposed instead of being adopted after rollback', async () => {
  const hal = createPStudioGraphicsHAL({ preferredBackend: 'webgpu' });
  let resolveInitialization;
  let lateDisposals = 0;
  hal.register(makeAdapter({
    id: 'slow.webgpu',
    backend: 'webgpu',
    initialize: () => new Promise(resolve => { resolveInitialization = resolve; })
  }));
  const pending = hal.initialize();
  await Promise.resolve();
  assert.equal(hal.dispose(), true);
  resolveInitialization({ render: () => true, dispose: () => { lateDisposals += 1; } });
  await assert.rejects(pending, error => error.code === 'PSTUDIO_GRAPHICS_STALE_INITIALIZATION' || error.code === 'PSTUDIO_GRAPHICS_INITIALIZATION_CANCELLED');
  assert.equal(lateDisposals, 1);
  assert.equal(hal.getState().state, 'disposed');
});

test('engine facade validates frames and delegates lifecycle to the HAL', async () => {
  const hal = createPStudioGraphicsHAL({ preferredBackend: 'webgpu' });
  let received = null;
  hal.register(makeAdapter({
    id: 'engine.webgpu',
    backend: 'webgpu',
    initialize: async () => ({ render: frame => { received = frame; return true; } })
  }));
  const engine = createPStudioGraphicsEngine({ hal });
  await engine.initialize();
  assert.equal(engine.getState().state, 'ready');
  assert.equal(engine.render({
    frameId: 12,
    timeMs: 320,
    deltaMs: 16,
    viewport: { width: 800, height: 600 }
  }), true);
  assert.equal(received.frameId, 12);
  assert.equal(received.viewport.width, 800);
  assert.equal(engine.dispose(), true);
  assert.equal(engine.render({ viewport: { width: 1, height: 1 } }), false);
});

test('independent graphics contract, HAL and facade do not depend on Three.js or DOM globals', () => {
  const root = path.join(__dirname, '..', 'static');
  for (const name of ['pstudio_graphics_contract.mjs', 'pstudio_graphics_hal.mjs', 'pstudio_graphics_engine.mjs']) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]three(?:\/|['"])/, name + ' must not import Three.js');
    assert.doesNotMatch(source, /\b(?:window|document|GPUDevice|WebGLRenderer|WebGPURenderer)\b/, name + ' must not depend on browser/backend globals');
  }
});
