const test = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_runtime.mjs')
]);

function makeScene(THREE) {
  return {
    canvas: {},
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera()
  };
}

test('production runtime initializes WebGPU once and delegates rendering/disposal', async () => {
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  let creates = 0;
  let renders = 0;
  let disposals = 0;
  const runtime = createPStudioProductionRendererRuntime({
    ...input,
    createWebGPU: async () => {
      creates += 1;
      return {
        capabilities: { backend: 'webgpu' },
        render: () => { renders += 1; return true; },
        dispose: () => { disposals += 1; }
      };
    }
  });

  const [first, second] = await Promise.all([runtime.initialize(), runtime.initialize()]);
  assert.equal(first, second);
  assert.equal(creates, 1);
  assert.equal(runtime.getState().state, 'ready');
  assert.equal(runtime.getState().backend, 'webgpu');
  assert.equal(runtime.render(), true);
  assert.equal(renders, 1);
  assert.equal(runtime.dispose(), true);
  assert.equal(runtime.dispose(), false);
  assert.equal(disposals, 1);
  assert.equal(runtime.getState().state, 'disposed');
  assert.equal(runtime.render(), false);
});

test('production runtime falls back only through the caller-provided legacy adapter', async () => {
  const input = makeScene();
  let fallbackCreates = 0;
  let fallbackRenders = 0;
  let fallbackDisposals = 0;
  const runtime = createPStudioProductionRendererRuntime({
    ...input,
    createWebGPU: async () => {
      const error = new Error('WebGPU unavailable');
      error.code = 'PSTUDIO_WEBGPU_UNAVAILABLE';
      throw error;
    },
    createFallback: async ({ cause }) => {
      fallbackCreates += 1;
      assert.equal(cause.code, 'PSTUDIO_WEBGPU_UNAVAILABLE');
      return {
        backend: 'webgl2',
        render: () => { fallbackRenders += 1; return true; },
        dispose: () => { fallbackDisposals += 1; }
      };
    }
  });

  await runtime.initialize();
  assert.equal(fallbackCreates, 1);
  assert.equal(runtime.getState().backend, 'webgl2');
  assert.equal(runtime.getState().state, 'ready');
  assert.equal(runtime.render(), true);
  assert.equal(fallbackRenders, 1);
  runtime.dispose();
  assert.equal(fallbackDisposals, 1);
});

test('production runtime does not silently fall back when fallback is disabled', async () => {
  const input = makeScene();
  const runtime = createPStudioProductionRendererRuntime({
    ...input,
    allowFallback: false,
    createWebGPU: async () => { throw new Error('initialization failed'); },
    createFallback: async () => { throw new Error('must not be called'); }
  });

  await assert.rejects(runtime.initialize(), /initialization failed/);
  assert.equal(runtime.getState().state, 'failed');
  assert.equal(runtime.getState().backend, null);
  runtime.dispose();
});

test('disposing during asynchronous initialization prevents late renderer adoption', async () => {
  const input = makeScene();
  let resolveWebGPU;
  let lateDisposals = 0;
  const runtime = createPStudioProductionRendererRuntime({
    ...input,
    createWebGPU: () => new Promise(resolve => { resolveWebGPU = resolve; })
  });

  const pending = runtime.initialize();
  assert.equal(runtime.getState().state, 'initializing-webgpu');
  runtime.dispose();
  resolveWebGPU({ render: () => true, dispose: () => { lateDisposals += 1; } });
  await assert.rejects(pending, /superseded/);
  assert.equal(lateDisposals, 1);
  assert.equal(runtime.getState().state, 'disposed');
});
