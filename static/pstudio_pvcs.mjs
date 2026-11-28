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
  ['post-render-source', 'Post-process scene source', 'render-pass', 'webgl2', 'Initial scene render pass feeding the post-processing chain.'],
  ['post-aa-taar', 'Temporal AA pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the TAA pass.'],
  ['post-volumetric-fog', 'Volumetric fog pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the volumetric fog pass.'],
  ['post-aa-smaa', 'SMAA pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the SMAA pass.'],
  ['post-gtao', 'GTAO pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the GTAO pass.'],
  ['post-ssao', 'SSAO pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the SSAO pass.'],
  ['post-ssr', 'SSR pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for the SSR pass.'],
  ['post-contact-shadows', 'Contact shadows pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for contact shadows.'],
  ['post-bloom', 'Bloom pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for bloom.'],
  ['post-volumetric-clouds', 'Volumetric clouds pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for volumetric clouds.'],
  ['post-god-rays', 'God Rays pass', 'render-pass', 'webgl2', 'CPU submission and sampled GPU duration for God Rays.'],
  ['post-output', 'Output color pass', 'render-pass', 'webgl2', 'Final output/color conversion pass.'],
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
    ['frame-loop', 'camera-state-update'],
    ['frame-loop', 'environment-state-update'],
    ['frame-loop', 'clustered-lighting'],
    ['frame-loop', 'world-visibility'],
    ['world-visibility', 'occlusion-visibility'],
    ['world-visibility', 'instance-batch-rebuild'],
    ['frame-loop', 'mirror-reflection-scene-render'],
    ['mirror-reflection', 'mirror-reflection-scene-render'],
    ['mirror-reflection', 'mirror-cloud-composite'],
    ['frame-loop', 'water-depth-prepass'],
    ['frame-loop', 'mirror-reflection'],
    ['frame-loop', 'post-processing'],
    ['frame-loop', 'scene-render'],
    ['frame-loop', 'webgpu-render-submit'],
    ['frame-loop', 'dynamic-gi-capture'],
    ['water-depth-prepass', 'mirror-reflection'],
    ['mirror-reflection', 'post-processing'],
    ['post-processing', 'post-render-source'],
    ['post-processing', 'post-aa-taar'],
    ['post-processing', 'post-volumetric-fog'],
    ['post-processing', 'post-aa-smaa'],
    ['post-processing', 'post-gtao'],
    ['post-processing', 'post-ssao'],
    ['post-processing', 'post-ssr'],
    ['post-processing', 'post-contact-shadows'],
    ['post-processing', 'post-bloom'],
    ['post-processing', 'post-volumetric-clouds'],
    ['post-processing', 'post-god-rays'],
    ['post-processing', 'post-output']
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
  let frameContext = null;
  let frameContextCaptured = false;
  let monitoringGeneration = 0;

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
    if (frameContextCaptured) return frameContext;
    const now = clock();
    if (!cachedContext || now - cachedContextAt >= 250) {
      cachedContext = contextFromStats(performanceSnapshot());
      cachedContextAt = now;
    }
    return cachedContext;
  }

  function beginFrame() {
    if (!monitoringEnabled) return null;
    frameContext = contextFromStats(performanceSnapshot());
    frameContextCaptured = true;
    cachedContext = frameContext;
    cachedContextAt = clock();
    return frameContext;
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

  function recordGpuStageMetrics(id, gpuStageMs, context = null, generation = null) {
    const value = Number(gpuStageMs);
    if (!monitoringEnabled || (generation !== null && generation !== monitoringGeneration)
      || !Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, {
      sampledAt: clock(),
      gpuStageMs: value,
      context: generation !== null ? context : (context || measurementContext())
    });
    totalMeasurements += 1;
    return true;
  }

  function recordGpuFrameMetrics(gpuRenderMs, context = null, generation = null) {
    const value = Number(gpuRenderMs);
    if (!monitoringEnabled || (generation !== null && generation !== monitoringGeneration)
      || !Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement('frame-loop', {
      sampledAt: clock(),
      gpuRenderMs: value,
      context: generation !== null ? context : (context || measurementContext())
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

  function recordAsyncStage(id, asyncElapsedMs, context = undefined, generation = null) {
    const value = Number(asyncElapsedMs);
    if (!monitoringEnabled || (generation !== null && generation !== monitoringGeneration)
      || !Number.isFinite(value) || value < 0) return false;
    graph.recordMeasurement(id, {
      sampledAt: clock(),
      asyncElapsedMs: value,
      context: context === undefined ? measurementContext() : context
    });
    totalMeasurements += 1;
    return true;
  }

  function measureAsync(id, callback) {
    if (typeof callback !== 'function') throw new TypeError('PVCS measureAsync requires a callback.');
    if (!monitoringEnabled) return callback();
    const startedAt = clock();
    const contextAtStart = measurementContext();
    const generationAtStart = monitoringGeneration;
    let result;
    try {
      result = callback();
    } catch (error) {
      recordAsyncStage(id, Math.max(0, clock() - startedAt), contextAtStart, generationAtStart);
      throw error;
    }
    return Promise.resolve(result).finally(() => {
      recordAsyncStage(id, Math.max(0, clock() - startedAt), contextAtStart, generationAtStart);
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
        'GPU frame time is recorded once when its asynchronous WebGL2 aggregate timer resolves, using the context captured when the query started.',
        'WebGL2 GPU-stage samples time the active composer or direct-render path, not individual composer sub-passes. WebGPU GPU timing is unavailable; CPU submission is never substituted for GPU time.',
        'CPU frame callback, CPU render submission, GPU frame, GPU stage and asynchronous elapsed values are independent measurement domains.',
        'GPU memory values remain PStudio resource estimates rather than driver-reported VRAM.'
      ]
    };
  }

  function recordFrameMetrics(cpuFrameMs = null) {
    if (!monitoringEnabled) return false;
    const stats = performanceSnapshot();
    if (!stats) {
      frameContext = null;
      frameContextCaptured = false;
      return false;
    }
    const frameValue = cpuFrameMs === null || cpuFrameMs === undefined ? null : Number(cpuFrameMs);
    graph.recordMeasurement('frame-loop', {
      sampledAt: clock(),
      cpuFrameMs: Number.isFinite(frameValue) && frameValue >= 0 ? frameValue : null,
      cpuSubmitMs: stats.cpuRenderSubmitMs,
      frameIntervalMs: stats.frameIntervalMs,
      memoryBytes: stats.estimatedGpuBytes,
      context: frameContextCaptured ? frameContext : contextFromStats(stats)
    });
    frameContext = null;
    frameContextCaptured = false;
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
    const next = enabled === true;
    if (next !== monitoringEnabled) monitoringGeneration += 1;
    monitoringEnabled = next;
    frameContext = null;
    frameContextCaptured = false;
    cachedContext = null;
    cachedContextAt = -Infinity;
    return monitoringEnabled;
  }

  return Object.freeze({
    graph,
    measure,
    measureAsync,
    recordStage,
    recordAsyncStage,
    recordGpuStageMetrics,
    recordGpuFrameMetrics,
    recordFrameMetrics,
    beginFrame,
    getMonitoringGeneration: () => monitoringGeneration,
    compareRgbaFrames,
    compareTemporalSequences,
    snapshot,
    analyze,
    setMonitoringEnabled,
    isMonitoringEnabled: () => monitoringEnabled
  });
}
