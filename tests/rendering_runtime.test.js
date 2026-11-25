const test = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_runtime.mjs')
]);

function makeScene(THREE) {
  return { canvas: {}, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() };
}

test('production runtime initializes WebGPU once and delegates rendering/disposal', async () => {
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  let creates = 0, renders = 0, disposals = 0;
  const runtime = runtimeModule.createPStudioProductionRendererRuntime({
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
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  const fallbackCanvas = {};
  let fallbackCreates = 0, fallbackRenders = 0, fallbackDisposals = 0;
  const runtime = runtimeModule.createPStudioProductionRendererRuntime({
    ...input,
    fallbackCanvas,
    createWebGPU: async () => {
      const error = new Error('WebGPU unavailable');
      error.code = 'PSTUDIO_WEBGPU_UNAVAILABLE';
      throw error;
    },
    createFallback: async ({ cause, canvas, webgpuCanvas }) => {
      fallbackCreates += 1;
      assert.equal(canvas, fallbackCanvas);
      assert.equal(webgpuCanvas, input.canvas);
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
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  const runtime = runtimeModule.createPStudioProductionRendererRuntime({
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
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  let resolveWebGPU, lateDisposals = 0;
  const runtime = runtimeModule.createPStudioProductionRendererRuntime({
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


test('production runtime rejects a shared WebGPU/WebGL canvas before creating either context', async () => {
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  await assert.rejects(
    Promise.resolve().then(() => runtimeModule.createPStudioProductionRendererRuntime({
      ...input,
      fallbackCanvas: input.canvas,
      createWebGPU: async () => ({ render: () => true }),
      createFallback: async () => ({ render: () => true })
    })),
    /must be different elements/
  );
});

test('production runtime requires an isolated fallback canvas when fallback is enabled', async () => {
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  assert.throws(
    () => runtimeModule.createPStudioProductionRendererRuntime({
      ...input,
      createWebGPU: async () => ({ render: () => true }),
      createFallback: async () => ({ render: () => true })
    }),
    /separate fallbackCanvas is required/
  );
});


test('production runtime switches to the isolated WebGL canvas after WebGPU device loss', async () => {
  const [THREE, runtimeModule] = await modules;
  const input = makeScene(THREE);
  const fallbackCanvas = {};
  let notifyDeviceLost, fallbackCreates = 0, webgpuDisposals = 0;
  let resolveFallbackReady;
  const fallbackReady = new Promise(resolve => { resolveFallbackReady = resolve; });
  const runtime = runtimeModule.createPStudioProductionRendererRuntime({
    ...input,
    fallbackCanvas,
    onStateChange: snapshot => {
      if (snapshot.state === 'ready' && snapshot.backend === 'webgl2') resolveFallbackReady();
    },
    createWebGPU: async ({ onDeviceLost }) => {
      notifyDeviceLost = onDeviceLost;
      return {
        render: () => true,
        dispose: () => { webgpuDisposals += 1; }
      };
    },
    createFallback: async ({ canvas, webgpuCanvas, cause }) => {
      fallbackCreates += 1;
      assert.equal(canvas, fallbackCanvas);
      assert.equal(webgpuCanvas, input.canvas);
      assert.equal(cause.code, 'PSTUDIO_WEBGPU_DEVICE_LOST');
      return { backend: 'webgl2', render: () => true, dispose() {} };
    }
  });

  await runtime.initialize();
  notifyDeviceLost({ reason: 'unknown', message: 'simulated device reset' });
  await fallbackReady;
  assert.equal(fallbackCreates, 1);
  assert.equal(webgpuDisposals, 1);
  assert.equal(runtime.getState().backend, 'webgl2');
  assert.equal(runtime.getState().state, 'ready');
  assert.equal(runtime.render(), true);
  runtime.dispose();
});
