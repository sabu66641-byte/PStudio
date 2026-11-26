const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_pipeline.mjs')
]);

test('TSL TRAA and SMAA adapters are exposed and can switch frame attachments at runtime', async () => {
  const [THREE, pipelineModule] = await modules;
  assert.equal(pipelineModule.supportsPStudioTSLTRAA, true);
  assert.equal(pipelineModule.supportsPStudioTSLSMAA, true);
  assert.deepEqual(
    pipelineModule.normalizePStudioAntiAliasingOptions({ mode: 'traa' }),
    { enabled: true, mode: 'traa' }
  );
  assert.deepEqual(
    pipelineModule.normalizePStudioAntiAliasingOptions({ mode: 'smaa' }),
    { enabled: true, mode: 'smaa' }
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const renderer = {
    backend: { isWebGPUBackend: true },
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: false }
  };
  const pipeline = pipelineModule.createPStudioRenderPipeline(renderer, scene, camera, {
    antiAliasing: { mode: 'smaa' }
  });

  assert.equal(pipeline.getState().antiAliasing.mode, 'smaa');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), false);

  assert.equal(pipeline.setAntiAliasing({ mode: 'traa' }), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'traa');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), true);

  assert.equal(pipeline.setAntiAliasing({ mode: 'smaa' }), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'smaa');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), false);

  assert.equal(pipeline.setAntiAliasing(false), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'none');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), false);
  assert.equal(pipeline.dispose(), true);
});
