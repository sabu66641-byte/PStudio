'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPStudioGraphicsSceneAsset } = require('../static/pstudio_graphics_scene_asset.mjs');
const { createPStudioRendererParityRunner } = require('../static/pstudio_renderer_parity.mjs');

const scene = createPStudioGraphicsSceneAsset({
  id: 'parity.scene', revision: 7,
  geometries: [{ id: 'geo', positions: [0,0,0, 1,0,0, 0,1,0] }],
  materials: [{ id: 'mat', model: 'pbr' }],
  entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
});
const context = () => ({
  scene: 'parity.scene@7',
  quality: 'high-reality55-anime45',
  renderWidth: 2, renderHeight: 2, renderPixelRatio: 1,
  effects: { shadows: true, ibl: true, water: true, gi: true, post: true }
});
const pixels = value => new Uint8Array(Array.from({length:16}, (_, i) => i % 4 === 3 ? 255 : value));

test('same-scene renderer parity reports paired CPU/GPU/memory P95, RGBA and temporal evidence', async () => {
  let active = 'baseline', restored = 0;
  const runner = createPStudioRendererParityRunner({
    sceneAsset: scene, sampleCount: 3, minimumSamples: 3, warmupCount: 1, visualSampleCount: 3,
    readContext: context,
    selectRenderer: variant => { active = variant; },
    capture: ({ index }) => ({
      sceneFingerprint: undefined,
      metrics: {
        cpuFrameMs: active === 'baseline' ? 18 : 14,
        gpuRenderMs: active === 'baseline' ? 9 : 7,
        gpuTimingFresh: true,
        estimatedGpuBytes: active === 'baseline' ? 4096 : 3584
      },
      frame: { frameKey: 'frame-' + index, width: 2, height: 2, channels: 4, data: pixels(active === 'baseline' ? 100 : 102) }
    }),
    restore: () => { restored++; active = 'baseline'; }
  });
  const result = await runner.run();
  assert.equal(result.status, 'compared');
  assert.equal(result.scene.fingerprint.length, 8);
  assert.equal(result.performance.cpu.status, 'measured');
  assert.equal(result.performance.cpu.baselineP95, 18);
  assert.equal(result.performance.cpu.alternativeP95, 14);
  assert.ok(result.performance.gpu.improvementRatio > 0);
  assert.equal(result.performance.memory.baselineP95, 4096);
  assert.ok(result.visual.meanAbsoluteError > 0);
  assert.equal(result.visual.sampleCount, 3);
  assert.equal(result.temporal.frameCount, 3);
  assert.equal(restored, 1);
  assert.equal(runner.getState().completedRuns, 1);
});

test('same-scene renderer parity discards captures when render context changes and restores renderer', async () => {
  let active = 'baseline', width = 2, restored = 0;
  const runner = createPStudioRendererParityRunner({
    sceneAsset: scene, sampleCount: 2, minimumSamples: 2, warmupCount: 0, visualSampleCount: 2,
    readContext: () => ({ ...context(), renderWidth: width }),
    selectRenderer: variant => { active = variant; if (variant === 'alternative') width = 3; },
    capture: ({ index }) => ({
      metrics: { cpuFrameMs: 10 },
      frame: { frameKey: 'f' + index, width: 2, height: 2, data: pixels(10) }
    }),
    restore: () => { restored++; active = 'baseline'; width = 2; }
  });
  await assert.rejects(runner.run(), /context changed/);
  assert.equal(restored, 1);
  assert.equal(runner.getState().running, false);
});

test('same-scene renderer parity rejects mutation of the source scene asset', async () => {
  let restored = 0;
  const runner = createPStudioRendererParityRunner({
    sceneAsset: scene, sampleCount: 2, minimumSamples: 2, warmupCount: 0, visualSampleCount: 2,
    readContext: context,
    selectRenderer: () => { scene.geometries[0].positions[0] += 1; },
    capture: ({ index }) => ({
      metrics: { cpuFrameMs: 10 },
      frame: { frameKey: 'f' + index, width: 2, height: 2, data: pixels(10) }
    }),
    restore: () => { restored++; }
  });
  await assert.rejects(runner.run(), /scene asset was mutated/);
  assert.equal(restored, 1);
});
