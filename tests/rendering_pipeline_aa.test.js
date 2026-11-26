const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_pipeline.mjs')
]);

test('TSL TRAA velocity MRT can be toggled at runtime and SMAA remains registered as the spatial node', async () => {
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
    antiAliasing: { mode: 'traa' }
  });

  assert.equal(pipeline.getState().antiAliasing.mode, 'traa');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), true);

  assert.equal(pipeline.setAntiAliasing(false), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'none');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), false);

  assert.equal(pipeline.setAntiAliasing({ mode: 'traa' }), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'traa');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), true);

  assert.equal(pipeline.setAntiAliasing(false), true);
  assert.equal(pipeline.getState().antiAliasing.mode, 'none');
  assert.equal(pipeline.getFrameResources().attachments.includes('velocity'), false);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'static', 'pstudio_rendering_pipeline.mjs'), 'utf8');
  assert.match(source, /import \{ smaa \} from 'three\/addons\/tsl\/display\/SMAANode\.js'/);
  assert.match(source, /: smaa\(output\)/);
  assert.equal(pipeline.dispose(), true);
});
