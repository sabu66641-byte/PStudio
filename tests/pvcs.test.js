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
  assert.match(renderer, /window\.PStudioPVCS\?\.measure/);
  assert.match(html, /pstudio_pvcs\.mjs/);
  assert.match(html, /id="pvcs-analysis-toggle"/);
  assert.match(html, /togglePStudioPVCSAnalysis/);
  assert.match(html, /pstudio_scene_environment\.js\?v=20261124-daylight-hq-r1/);
  assert.match(html, /pstudio_genesis_environment\.js\?v=20261127-genesis-snap-v2/);
  assert.match(html, /pstudio_3d_engine\.js\?v=20261128-pvcs-foundation-v1/);
});
