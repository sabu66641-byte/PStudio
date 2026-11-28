'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModules() {
  const graph = await import('../static/pstudio_visual_compensation_graph.mjs');
  const diff = await import('../static/pstudio_visual_difference.mjs');
  const pvcs = await import('../static/pstudio_pvcs.mjs');
  return { ...graph, ...diff, ...pvcs };
}

test('VCG validates nodes, dependencies and cycles', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph({ maxNodes: 4, maxEdges: 4 });
  graph.registerNode({ id: 'frame', label: 'Frame' });
  graph.registerNode({ id: 'water', label: 'Water' });
  graph.registerNode({ id: 'post', label: 'Post' });
  assert.equal(graph.connect('frame', 'water'), true);
  assert.equal(graph.connect('water', 'post'), true);
  assert.throws(() => graph.connect('post', 'frame'), /cycle/);
  assert.throws(() => graph.registerNode({ id: 'not valid' }), /IDs/);
  assert.equal(graph.snapshot().nodeCount, 3);
  assert.equal(graph.snapshot().edgeCount, 2);
});

test('VCG keeps bounded histories and reports p95 values without mutating callers', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph({ historyLimit: 3 });
  graph.registerNode({ id: 'mirror' });
  for (const value of [1, 2, 3, 4]) graph.recordMeasurement('mirror', { cpuSubmitMs: value });
  const node = graph.analyzeBottlenecks()[0];
  assert.equal(node.metrics.sampleCount, 3);
  assert.equal(node.metrics.cpuSubmitP50Ms, 3);
  assert.equal(node.metrics.cpuSubmitP95Ms, 4);
  assert.equal(node.gpuEvidence, 'not-available-per-stage');
});

test('pixel comparison reports identical and changed RGBA frames', async () => {
  const { compareRgbaFrames } = await loadModules();
  const before = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) };
  const same = compareRgbaFrames(before, { ...before, data: new Uint8Array(before.data) });
  assert.equal(same.meanAbsoluteError, 0);
  assert.equal(same.changedPixelRatio, 0);
  const changed = compareRgbaFrames(before, { ...before, data: new Uint8Array([20, 20, 30, 255]) });
  assert.ok(changed.meanAbsoluteError > 0);
  assert.equal(changed.changedPixelRatio, 1);
  assert.throws(() => compareRgbaFrames(before, { width: 2, height: 1, data: new Uint8Array(8) }), /identical dimensions/);
});

test('temporal comparison distinguishes changed frame-to-frame motion', async () => {
  const { compareTemporalSequences } = await loadModules();
  const frame = (value) => ({ width: 1, height: 1, data: new Uint8Array([value, value, value, 255]) });
  const result = compareTemporalSequences([frame(0), frame(100)], [frame(0), frame(80)]);
  assert.equal(result.frameCount, 2);
  assert.ok(result.meanAbsoluteTemporalDeltaError > 0);
});

test('PVCS is analysis-only and does not mutate quality controls', async () => {
  const { createPStudioPVCS } = await loadModules();
  let now = 10;
  let qualityChanges = 0;
  const renderer = { getPerformanceStats: () => ({ gpuTimingFresh: false, gpuRenderMs: null }) };
  const pvcs = createPStudioPVCS({ getRenderer: () => renderer, now: () => now });
  assert.equal(pvcs.isMonitoringEnabled(), false);
  assert.equal(pvcs.measure('mirror-reflection', () => 7), 7);
  assert.equal(pvcs.graph.analyzeBottlenecks().find((item) => item.id === 'mirror-reflection').metrics.sampleCount, 0);
  pvcs.setMonitoringEnabled(true);
  const result = pvcs.measure('mirror-reflection', () => { now += 3; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(pvcs.graph.analyzeBottlenecks().find((item) => item.id === 'mirror-reflection').metrics.cpuSubmitP95Ms, 3);
  assert.equal(qualityChanges, 0);
  assert.equal(pvcs.snapshot().automaticQualityChanges, false);
});


test('async timing is kept separate from CPU submit timing', async () => {
  const { createPStudioPVCS } = await loadModules();
  let now = 20;
  const pvcs = createPStudioPVCS({ now: () => now });
  pvcs.setMonitoringEnabled(true);
  await pvcs.measureAsync('dynamic-gi-capture', async () => { now += 12; return true; });
  const node = pvcs.graph.analyzeBottlenecks().find((item) => item.id === 'dynamic-gi-capture');
  const graphNode = pvcs.graph.snapshot().nodes.find((item) => item.id === 'dynamic-gi-capture');
  assert.equal(node.metrics.cpuSubmitP95Ms, null);
  assert.equal(graphNode.metrics.asyncElapsedP95Ms, 12);
});

test('PVCS renderer-stage integration remains opt-in and sky assets remain pinned', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  assert.match(renderer, /function measurePVCSStage/);
  assert.match(renderer, /profiler\?\.measure/);
  assert.match(html, /pstudio_pvcs\.mjs/);
  assert.match(html, /id="pvcs-analysis-toggle"/);
  assert.match(html, /togglePStudioPVCSAnalysis/);
  assert.match(html, /pstudio_scene_environment\.js\?v=20261124-daylight-hq-r1/);
  assert.match(html, /pstudio_genesis_environment\.js\?v=20261127-genesis-snap-v2/);
  assert.match(html, /pstudio_3d_engine\.js\?v=20261128-pvcs-foundation-v1/);
});


test('VCG keeps CPU frame, render submission, GPU frame, GPU stage and async domains independent', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph();
  graph.registerNode({ id: 'frame' });
  graph.registerNode({ id: 'mirror-reflection' });
  graph.recordMeasurement('frame', {
    cpuFrameMs: 18, cpuSubmitMs: 7, gpuRenderMs: 9, frameIntervalMs: 20, memoryBytes: 1024,
    context: { backend: 'webgl2', scene: 'genesis-shrine', quality: 'high', renderWidth: 1280, renderHeight: 720, renderPixelRatio: 1.5, effects: { volumetricClouds: true } }
  });
  graph.recordMeasurement('mirror-reflection', { gpuStageMs: 3.5 });
  graph.recordMeasurement('mirror-reflection', { asyncElapsedMs: 11 });
  const frame = graph.snapshot().nodes.find((node) => node.id === 'frame').metrics;
  const mirror = graph.snapshot().nodes.find((node) => node.id === 'mirror-reflection').metrics;
  assert.equal(frame.cpuFrameP95Ms, 18);
  assert.equal(frame.cpuSubmitP95Ms, 7);
  assert.equal(frame.gpuRenderP95Ms, 9);
  assert.equal(frame.gpuStageP95Ms, null);
  assert.equal(frame.context.backend, 'webgl2');
  assert.equal(frame.context.renderWidth, 1280);
  assert.equal(frame.context.effects.volumetricClouds, true);
  assert.equal(mirror.gpuStageP95Ms, 3.5);
  assert.equal(mirror.asyncElapsedP95Ms, 11);
  const rankings = graph.analyzeResourceDomains();
  assert.equal(rankings.cpuFrame[0].id, 'frame');
  assert.equal(rankings.gpuStages[0].id, 'mirror-reflection');
  assert.equal(rankings.asynchronous[0].id, 'mirror-reflection');
});

test('VCG keeps context histories separate and reports per-metric sample counts', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph({ historyLimit: 8 });
  graph.registerNode({ id: 'frame-loop' });
  graph.registerNode({ id: 'mirror-reflection' });
  const high = { backend: 'webgl2', scene: 'shrine', quality: 'high', renderWidth: 1280, renderHeight: 720, renderPixelRatio: 1 };
  const mobile = { backend: 'webgl2', scene: 'shrine', quality: 'mobile', renderWidth: 720, renderHeight: 405, renderPixelRatio: 1 };
  graph.recordMeasurement('frame-loop', { cpuFrameMs: 24, cpuSubmitMs: 7, context: high });
  graph.recordMeasurement('mirror-reflection', { cpuSubmitMs: 11, context: high });
  graph.recordMeasurement('frame-loop', { cpuFrameMs: 6, cpuSubmitMs: 2, context: mobile });
  const frame = graph.snapshot().nodes.find((node) => node.id === 'frame-loop');
  assert.equal(frame.metrics.cpuFrameP95Ms, 6);
  assert.equal(frame.metrics.cpuFrameSampleCount, 1);
  assert.equal(frame.metrics.cpuSubmitSampleCount, 1);
  assert.equal(frame.metrics.totalSampleCount, 2);
  assert.equal(frame.metrics.contextCount, 2);
  assert.equal(frame.contextMetrics.length, 2);
  assert.equal(frame.metrics.context.quality, 'mobile');
  const cpuFrameRanking = graph.analyzeResourceDomains().cpuFrame;
  assert.equal(cpuFrameRanking.length, 1);
  assert.equal(cpuFrameRanking[0].id, 'frame-loop');
  assert.equal(cpuFrameRanking[0].context.quality, 'mobile');
  assert.equal(cpuFrameRanking[0].sampleCount, 1);
  const cpuStageRanking = graph.analyzeResourceDomains().cpuStages;
  assert.equal(cpuStageRanking.length, 1);
  assert.equal(cpuStageRanking[0].context.quality, 'mobile');
});

test('VCG bounds the total retained history across multiple contexts', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph({ historyLimit: 3 });
  graph.registerNode({ id: 'frame-loop' });
  for (let index = 0; index < 10; index += 1) {
    graph.recordMeasurement('frame-loop', {
      cpuFrameMs: index + 1,
      context: { backend: 'webgl2', scene: 'scene-' + index, quality: 'high' }
    });
  }
  const metrics = graph.snapshot().nodes[0].metrics;
  assert.equal(metrics.totalSampleCount, 3);
  assert.ok(metrics.contextCount <= 3);
  assert.ok(graph.snapshot().nodes[0].contextMetrics.length <= 3);
});

test('VCG treats explicit null metrics as unavailable instead of zero', async () => {
  const { createVisualCompensationGraph } = await loadModules();
  const graph = createVisualCompensationGraph();
  graph.registerNode({ id: 'frame' });
  graph.recordMeasurement('frame', { cpuFrameMs: 10, gpuRenderMs: null, gpuStageMs: null });
  const metrics = graph.snapshot().nodes[0].metrics;
  assert.equal(metrics.cpuFrameP95Ms, 10);
  assert.equal(metrics.gpuRenderP95Ms, null);
  assert.equal(metrics.gpuStageP95Ms, null);
});

test('PVCS records the full drawFrame CPU duration separately from render submission', async () => {
  const { createPStudioPVCS } = await loadModules();
  const renderer = {
    getPerformanceStats: () => ({
      cpuRenderSubmitMs: 6, gpuTimingFresh: true, gpuRenderMs: 8, frameIntervalMs: 16.7, estimatedGpuBytes: 2048,
      backend: 'webgl2', scene: 'genesis-shrine', quality: 'high', renderWidth: 1440, renderHeight: 900, renderPixelRatio: 1.5,
      renderEffects: { ao: true, ssr: false, volumetricClouds: true, volumetricFog: true, contactShadows: false }
    })
  };
  const pvcs = createPStudioPVCS({ getRenderer: () => renderer, now: () => 100 });
  pvcs.setMonitoringEnabled(true);
  assert.equal(pvcs.recordFrameMetrics(22.5), true);
  const frame = pvcs.graph.snapshot().nodes.find((node) => node.id === 'frame-loop').metrics;
  assert.equal(frame.cpuFrameP95Ms, 22.5);
  assert.equal(frame.cpuSubmitP95Ms, 6);
  assert.equal(frame.gpuRenderP95Ms, 8);
  assert.equal(frame.context.scene, 'genesis-shrine');
  assert.equal(frame.context.renderHeight, 900);
  assert.equal(pvcs.analyze().rankings.cpuFrame[0].id, 'frame-loop');
});

test('PVCS binds stage and frame measurements to one frame-start context', async () => {
  const { createPStudioPVCS } = await loadModules();
  let now = 400;
  let stats = { backend: 'webgl2', scene: 'shrine-day', quality: 'high', renderWidth: 1280, renderHeight: 720, renderPixelRatio: 1 };
  const pvcs = createPStudioPVCS({ getRenderer: () => ({ getPerformanceStats: () => stats }), now: () => now });
  pvcs.setMonitoringEnabled(true);
  assert.equal(pvcs.beginFrame(), true);
  pvcs.measure('mirror-reflection', () => { now += 2; });
  stats = { backend: 'webgpu', scene: 'editor', quality: 'mobile', renderWidth: 720, renderHeight: 405, renderPixelRatio: 1 };
  assert.equal(pvcs.recordFrameMetrics(16, { includeAggregateGpu: false }), true);
  const snapshot = pvcs.graph.snapshot();
  const frame = snapshot.nodes.find((node) => node.id === 'frame-loop');
  const mirror = snapshot.nodes.find((node) => node.id === 'mirror-reflection');
  assert.equal(frame.metrics.context.backend, 'webgl2');
  assert.equal(frame.metrics.context.scene, 'shrine-day');
  assert.equal(mirror.metrics.context.backend, 'webgl2');
  assert.equal(mirror.metrics.context.scene, 'shrine-day');
});

test('PVCS does not attribute a stale WebGL timer to a WebGPU frame', async () => {
  const { createPStudioPVCS } = await loadModules();
  const pvcs = createPStudioPVCS({
    getRenderer: () => ({ getPerformanceStats: () => ({
      cpuRenderSubmitMs: 6, gpuTimingFresh: true, gpuRenderMs: 8, backend: 'webgpu'
    }) }),
    now: () => 100
  });
  pvcs.setMonitoringEnabled(true);
  pvcs.recordFrameMetrics(20);
  const metrics = pvcs.graph.snapshot().nodes.find((node) => node.id === 'frame-loop').metrics;
  assert.equal(metrics.gpuRenderP95Ms, null);
});

test('PVCS can record a WebGL2 GPU stage result without relabelling it as frame GPU time', async () => {
  const { createPStudioPVCS } = await loadModules();
  const pvcs = createPStudioPVCS({ now: () => 200 });
  pvcs.setMonitoringEnabled(true);
  assert.equal(pvcs.recordGpuStageMetrics('mirror-reflection', 4.25), true);
  const metrics = pvcs.graph.snapshot().nodes.find((node) => node.id === 'mirror-reflection').metrics;
  assert.equal(metrics.gpuStageP95Ms, 4.25);
  assert.equal(metrics.gpuRenderP95Ms, null);
});


test('PVCS instruments individual composer passes without changing quality state', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
  const pvcs = fs.readFileSync(path.join(root, 'static/pstudio_pvcs.mjs'), 'utf8');
  assert.match(renderer, /function instrumentPVCSComposerPasses\(\)/);
  assert.match(renderer, /originalRender\.apply\(this,args\)/);
  assert.match(renderer, /pvcsPostProcessingPathActive/);
  assert.match(renderer, /pvcsGpuStageSampleTarget=stageGpuSampleTurn\?\(pvcsPostProcessingPathActive\?'post-processing':'scene-render'\):null/);
  assert.match(renderer, /pvcsAggregateGpuTimerStarted=!!gpuQuery/);
  assert.match(renderer, /if\(window\.PStudioPVCS\?\.isMonitoringEnabled\?\.\(\)!==true\)return originalRender\.apply\(this,args\)/);
  assert.match(renderer, /if\(pvcsMonitoringEnabled\)pvcsProfiler\.beginFrame\?\.\(\)/);
  assert.doesNotMatch(renderer, /const stageGpuSampleSlots=\[/);
  for (const id of ['post-aa-taar','post-volumetric-fog','post-gtao','post-ssr','post-bloom','post-volumetric-clouds','post-god-rays','post-output']) {
    assert.ok(pvcs.includes("'" + id + "'"), 'missing PVCS pass stage ' + id);
  }
  assert.match(renderer, /if\(disjoint\)[\s\S]{0,220}lastGpuRenderDurationMs=0/);
});
