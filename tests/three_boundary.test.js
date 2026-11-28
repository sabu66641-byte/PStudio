'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const staticRoot = path.join(root, 'static');

test('PStudio-owned Graphics Core and Render Graph remain free of direct Three.js imports', () => {
  const protectedFiles = [
    'pstudio_graphics_contract.mjs',
    'pstudio_graphics_scene_core.mjs',
    'pstudio_graphics_asset_core.mjs',
    'pstudio_pvcs_calibration.mjs',
    'pstudio_graphics_renderer_core.mjs',
    'pstudio_graphics_resource_core.mjs',
    'pstudio_graphics_shader_core.mjs',
    'pstudio_graphics_compute_core.mjs',
    'pstudio_graphics_lighting_core.mjs',
    'pstudio_graphics_clustered_lighting_core.mjs',
    'pstudio_graphics_core.mjs',
    'pstudio_graphics_webgpu_backend.mjs',
    'pstudio_graphics_world_core.mjs',
    'pstudio_graphics_advanced_core.mjs',
    'pstudio_render_graph.mjs',
    'pstudio_pvcs.mjs',
    'pstudio_pvcs_governor.mjs',
    'pstudio_visual_compensation_graph.mjs',
    'pstudio_visual_difference.mjs',
    'pstudio_graphics_scene_asset.mjs',
    'pstudio_graphics_webgpu_scene_renderer.mjs',
    'pstudio_pvcs_browser_runner.mjs'
  ];
  const patterns = [
    /from\s*['"]three(?:\/[^'"]*)?['"]/,
    /import\s*\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/
  ];
  for (const filename of protectedFiles) {
    const source = fs.readFileSync(path.join(staticRoot, filename), 'utf8');
    for (const pattern of patterns) assert.doesNotMatch(source, pattern, filename + ' must not import Three.js');
  }
});

test('Three.js WebGPU runtime import is isolated behind the optional legacy runtime loader', async () => {
  const loaderSource = fs.readFileSync(path.join(staticRoot, 'pstudio_three_legacy_runtime.mjs'), 'utf8');
  const backendSource = fs.readFileSync(path.join(staticRoot, 'pstudio_rendering_backend.mjs'), 'utf8');
  assert.match(loaderSource, /await import\(PSTUDIO_LEGACY_THREE_WEBGPU_SPECIFIER\)/);
  assert.match(loaderSource, /PSTUDIO_LEGACY_THREE_REVISION = "187"/);
  assert.doesNotMatch(backendSource, /from\s*['"]three\//);
  assert.match(backendSource, /loadPStudioLegacyThreeWebGPU/);
  const { loadPStudioLegacyThreeWebGPU } = await import('../static/pstudio_three_legacy_runtime.mjs');
  const fake = { REVISION: '187', WebGPURenderer: function FakeRenderer() {} };
  assert.equal(await loadPStudioLegacyThreeWebGPU({ threeRuntime: fake }), fake);
  await assert.rejects(loadPStudioLegacyThreeWebGPU({ threeRuntime: { ...fake, REVISION: '186' } }), /requires r187/);
});

test('importing PStudio-owned Graphics Core modules does not require a Three.js global', async () => {
  const previous = globalThis.THREE;
  try {
    delete globalThis.THREE;
    const modules = await Promise.all([
      import('../static/pstudio_graphics_contract.mjs'),
      import('../static/pstudio_graphics_scene_core.mjs'),
      import('../static/pstudio_graphics_asset_core.mjs'),
      import('../static/pstudio_pvcs_calibration.mjs'),
      import('../static/pstudio_graphics_renderer_core.mjs'),
      import('../static/pstudio_graphics_resource_core.mjs'),
      import('../static/pstudio_graphics_shader_core.mjs'),
      import('../static/pstudio_graphics_compute_core.mjs'),
      import('../static/pstudio_graphics_lighting_core.mjs'),
      import('../static/pstudio_graphics_clustered_lighting_core.mjs'),
      import('../static/pstudio_graphics_core.mjs'),
      import('../static/pstudio_graphics_webgpu_backend.mjs'),
      import('../static/pstudio_graphics_world_core.mjs'),
      import('../static/pstudio_graphics_advanced_core.mjs'),
      import('../static/pstudio_render_graph.mjs')
    ]);
    assert.equal(modules.length, 15);
    assert.equal(globalThis.THREE, undefined);
  } finally {
    if (previous !== undefined) globalThis.THREE = previous;
  }
});


test('legacy Three.js WebGPU adapter imports its runtime only when explicitly initialized', async () => {
  const { createPStudioWebGPUBackend, isPStudioWebGPUAvailable } = await import('../static/pstudio_rendering_backend.mjs');
  let initialized = 0;
  let disposed = 0;
  class FakeWebGPURenderer {
    constructor(options) {
      this.options = options;
      this.backend = { isWebGPUBackend: true };
    }
    async init() { initialized++; }
    setAnimationLoop() {}
    dispose() { disposed++; }
  }
  const runtime = { REVISION: '187', WebGPURenderer: FakeWebGPURenderer };
  const navigatorRef = { gpu: {} };
  assert.equal(isPStudioWebGPUAvailable(navigatorRef, runtime), true);
  const backend = await createPStudioWebGPUBackend({
    canvas: { getContext() { return null; } },
    navigatorRef,
    threeRuntime: runtime
  });
  assert.equal(initialized, 1);
  assert.equal(backend.kind, 'webgpu');
  assert.equal(backend.dispose(), true);
  assert.equal(backend.dispose(), false);
  assert.equal(disposed, 1);
});
