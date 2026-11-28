import { createVisualCompensationGraph } from './pstudio_visual_compensation_graph.mjs?v=20261128-pvcs-graph-v1';
import { compareRgbaFrames, compareTemporalSequences } from './pstudio_visual_difference.mjs?v=20261128-pvcs-diff-v1';

const STAGES = [
  ['frame-loop', 'Frame loop', 'root', 'shared', 'One PStudio3D drawFrame invocation.'],
  ['environment-state-update', 'Environment state update', 'cpu-stage', 'shared', 'GENESIS state propagation; sky visuals are not modified by PVCS.'],
  ['clustered-lighting', 'Clustered lighting update', 'cpu-stage', 'shared', 'CPU-side light/cluster preparation.'],
  ['water-depth-prepass', 'Water depth prepass', 'render-pass', 'webgl2', 'Additional scene render used to provide depth to water and screen-space effects.'],
  ['mirror-reflection', 'Planar mirror reflection', 'render-pass', 'webgl2', 'Reflected camera render(s), potentially including a cloud pass.'],
  ['post-processing', 'Post-processing composition', 'render-pass', 'webgl2', 'Enabled composer passes such as AO, SSR, volumetric effects, bloom and AA.'],
  ['scene-render', 'Direct scene render', 'render-pass', 'webgl2', 'Direct scene draw when the composer path is not active or after fallback.'],
  ['webgpu-render-submit', 'WebGPU render submit', 'render-submit', 'webgpu', 'CPU submission duration for the production WebGPU bridge.'],
  ['dynamic-gi-capture', 'Dynamic GI capture', 'async-stage', 'shared', 'Asynchronous work after the main scene submission; not included in the main GPU timer.']
];

function makeGraph() {
  const graph = createVisualCompensationGraph({ historyLimit: 120, maxNodes: 32, maxEdges: 64 });
  for (const [id, label, kind, backend, description] of STAGES) graph.registerNode({ id, label, kind, backend, description });
  for (const [from, to] of [
    ['frame-loop', 'environment-state-update'],
    ['frame-loop', 'clustered-lighting'],
    ['frame-loop', 'water-depth-prepass'],
    ['frame-loop', 'mirror-reflection'],
    ['frame-loop', 'post-processing'],
    ['frame-loop', 'scene-render'],
    ['frame-loop', 'webgpu-render-submit'],
    ['frame-loop', 'dynamic-gi-capture'],
    ['water-depth-prepass', 'mirror-reflection'],
    ['mirror-reflection', 'post-processing']
  ]) graph.connect(from, to);
  return graph;
}

export function createPStudioPVCS(options = {}) {
  const graph = makeGraph();
  const clock = typeof options.now === 'function' ? options.now : () => globalThis.performance?.now?.() ?? Date.now();
  const getRenderer = typeof options.getRenderer === 'function' ? options.getRenderer : () => null;
  let monitoringEnabled = options.enabled === true;
  let totalMeasurements = 0;
  let lastError = null;

  function recordStage(id, cpuSubmitMs, extra = {}) {
    const value = Number(cpuSubmitMs);
    if (!Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, {
      sampledAt: clock(),
      cpuSubmitMs: value,
      gpuRenderMs: extra.gpuRenderMs,
      frameIntervalMs: extra.frameIntervalMs,
      memoryBytes: extra.memoryBytes
    });
    totalMeasurements += 1;
    return true;
  }

  function measure(id, callback) {
    if (typeof callback !== 'function') throw new TypeError('PVCS measure requires a callback.');
    if (!monitoringEnabled) return callback();
    const startedAt = clock();
    try {
      return callback();
    } finally {
      recordStage(id, Math.max(0, clock() - startedAt));
    }
  }

  function measureAsync(id, callback) {
    if (typeof callback !== 'function') throw new TypeError('PVCS measureAsync requires a callback.');
    if (!monitoringEnabled) return callback();
    const startedAt = clock();
    let result;
    try {
      result = callback();
    } catch (error) {
      recordStage(id, Math.max(0, clock() - startedAt));
      throw error;
    }
    return Promise.resolve(result).finally(() => {
      recordStage(id, Math.max(0, clock() - startedAt));
    });
  }

  function performanceSnapshot() {
    const renderer = getRenderer();
    if (!renderer || typeof renderer.getPerformanceStats !== 'function') return null;
    try {
      return renderer.getPerformanceStats();
    } catch (error) {
      lastError = String(error?.message || error);
      return null;
    }
  }

  function snapshot() {
    return {
      schema: 'pstudio.pvcs.analysis.v1',
      mode: monitoringEnabled ? 'analysis' : 'disabled',
      automaticQualityChanges: false,
      totalMeasurements,
      lastError,
      rendererPerformance: performanceSnapshot(),
      graph: graph.snapshot(),
      limitations: [
        'GPU render time currently describes the main WebGL2 scene timer when a fresh disjoint-safe timer-query sample exists; it is not a per-pass GPU breakdown.',
        'Stage timings are CPU submit/elapsed wall-clock measurements around calls, not isolated GPU execution times.',
        'GPU memory values remain PStudio resource estimates rather than driver-reported VRAM.'
      ]
    };
  }

  function recordFrameMetrics() {
    if (!monitoringEnabled) return false;
    const stats = performanceSnapshot();
    if (!stats) return false;
    return recordStage('frame-loop', stats.cpuRenderSubmitMs, {
      gpuRenderMs: stats.gpuTimingFresh === true ? stats.gpuRenderMs : null,
      frameIntervalMs: stats.frameIntervalMs,
      memoryBytes: stats.estimatedGpuBytes
    });
  }

  function analyze() {
    return {
      mode: monitoringEnabled ? 'analysis' : 'disabled',
      automaticQualityChanges: false,
      bottlenecks: graph.analyzeBottlenecks(),
      rendererPerformance: performanceSnapshot()
    };
  }

  function setMonitoringEnabled(enabled) {
    monitoringEnabled = enabled === true;
    return monitoringEnabled;
  }

  return Object.freeze({
    graph,
    measure,
    measureAsync,
    recordStage,
    recordFrameMetrics,
    compareRgbaFrames,
    compareTemporalSequences,
    snapshot,
    analyze,
    setMonitoringEnabled,
    isMonitoringEnabled: () => monitoringEnabled
  });
}
