import { createVisualCompensationGraph } from './pstudio_visual_compensation_graph.mjs?v=20261128-pvcs-graph-v1';
import { compareRgbaFrames, compareTemporalSequences } from './pstudio_visual_difference.mjs?v=20261128-pvcs-diff-v1';

const STAGES = [
  ['frame-loop', 'Frame loop', 'root', 'shared', 'One drawFrame callback; full CPU time and renderer submission are separate metrics.'],
  ['camera-state-update', 'Camera and environment presentation update', 'cpu-stage', 'shared', 'Camera, celestial placement and editor presentation updates.'],
  ['environment-state-update', 'Environment state update', 'cpu-stage', 'shared', 'GENESIS state propagation; sky visuals are not modified by PVCS.'],
  ['clustered-lighting', 'Clustered lighting update', 'cpu-stage', 'shared', 'CPU-side light/cluster preparation.'],
  ['world-visibility', 'World visibility and streaming', 'cpu-stage', 'shared', 'Frustum/distance visibility, streaming requests and LOD updates.'],
  ['occlusion-visibility', 'Occlusion visibility', 'cpu-stage', 'shared', 'Throttled candidate selection and raycast visibility updates.'],
  ['instance-batch-rebuild', 'Instance batch rebuild', 'cpu-stage', 'shared', 'Rebuild of compatible static instance batches.'],
  ['mirror-reflection-scene-render', 'Mirror scene render', 'cpu-stage', 'webgl2', 'CPU submission around each reflected-camera scene render.'],
  ['mirror-cloud-composite', 'Mirror cloud composite', 'cpu-stage', 'webgl2', 'CPU submission around reflected volumetric cloud composition.'],
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
  let cachedContext = null;
  let cachedContextAt = -Infinity;

  function contextFromStats(stats) {
    if (!stats || typeof stats !== 'object') return null;
    return {
      backend: stats.backend,
      scene: stats.scene,
      quality: stats.quality,
      renderWidth: stats.renderWidth,
      renderHeight: stats.renderHeight,
      renderPixelRatio: stats.renderPixelRatio,
      effects: stats.renderEffects
    };
  }

  function measurementContext() {
    const now = clock();
    if (!cachedContext || now - cachedContextAt >= 250) {
      cachedContext = contextFromStats(performanceSnapshot());
      cachedContextAt = now;
    }
    return cachedContext;
  }

  function recordStage(id, cpuSubmitMs, extra = {}) {
    const value = Number(cpuSubmitMs);
    if (!Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, {
      sampledAt: clock(),
      cpuSubmitMs: value,
      gpuStageMs: extra.gpuStageMs,
      frameIntervalMs: extra.frameIntervalMs,
      memoryBytes: extra.memoryBytes,
      context: extra.context || measurementContext()
    });
    totalMeasurements += 1;
    return true;
  }

  function recordGpuStageMetrics(id, gpuStageMs, context = null) {
    const value = Number(gpuStageMs);
    if (!monitoringEnabled || !Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, {
      sampledAt: clock(),
      gpuStageMs: value,
      context: context || measurementContext()
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

  function recordAsyncStage(id, asyncElapsedMs) {
    const value = Number(asyncElapsedMs);
    if (!Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, { sampledAt: clock(), asyncElapsedMs: value });
    totalMeasurements += 1;
    return true;
  }

  function measureAsync(id, callback) {
    if (typeof callback !== 'function') throw new TypeError('PVCS measureAsync requires a callback.');
    if (!monitoringEnabled) return callback();
    const startedAt = clock();
    let result;
    try {
      result = callback();
    } catch (error) {
      recordAsyncStage(id, Math.max(0, clock() - startedAt));
      throw error;
    }
    return Promise.resolve(result).finally(() => {
      recordAsyncStage(id, Math.max(0, clock() - startedAt));
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
        'GPU frame time is the aggregate WebGL2 render-section timer; selected WebGL2 pass timers are sampled separately and never nested with the aggregate timer.',
        'WebGPU GPU-stage timing is unavailable unless timestamp queries are supported and enabled; CPU submission is never substituted for GPU time.',
        'CPU frame callback, CPU render submission, GPU frame, GPU stage and asynchronous elapsed values are independent measurement domains.',
        'GPU memory values remain PStudio resource estimates rather than driver-reported VRAM.'
      ]
    };
  }

  function recordFrameMetrics(cpuFrameMs = null, options = {}) {
    if (!monitoringEnabled) return false;
    const stats = performanceSnapshot();
    if (!stats) return false;
    const frameValue = cpuFrameMs === null || cpuFrameMs === undefined ? null : Number(cpuFrameMs);
    const aggregateGpuAllowed = options.includeAggregateGpu !== false && stats.backend === 'webgl2';
    graph.recordMeasurement('frame-loop', {
      sampledAt: clock(),
      cpuFrameMs: Number.isFinite(frameValue) && frameValue >= 0 ? frameValue : null,
      cpuSubmitMs: stats.cpuRenderSubmitMs,
      gpuRenderMs: aggregateGpuAllowed && stats.gpuTimingFresh === true ? stats.gpuRenderMs : null,
      frameIntervalMs: stats.frameIntervalMs,
      memoryBytes: stats.estimatedGpuBytes,
      context: contextFromStats(stats)
    });
    totalMeasurements += 1;
    return true;
  }

  function analyze() {
    return {
      mode: monitoringEnabled ? 'analysis' : 'disabled',
      automaticQualityChanges: false,
      bottlenecks: graph.analyzeBottlenecks(),
      rankings: graph.analyzeResourceDomains(),
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
    recordAsyncStage,
    recordGpuStageMetrics,
    recordFrameMetrics,
    compareRgbaFrames,
    compareTemporalSequences,
    snapshot,
    analyze,
    setMonitoringEnabled,
    isMonitoringEnabled: () => monitoringEnabled
  });
}
