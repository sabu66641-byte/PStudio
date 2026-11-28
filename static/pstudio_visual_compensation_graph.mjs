const DEFAULT_HISTORY_LIMIT = 120;
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function sanitizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = {};
  for (const key of ['backend', 'scene', 'quality']) {
    if (value[key] !== undefined && value[key] !== null) context[key] = String(value[key]).slice(0, 48);
  }
  for (const key of ['renderWidth', 'renderHeight', 'renderPixelRatio']) {
    const number = finiteNonNegative(value[key]);
    if (number !== null) context[key] = number;
  }
  if (value.effects && typeof value.effects === 'object' && !Array.isArray(value.effects)) {
    const effects = {};
    for (const key of ['ao', 'ssr', 'volumetricClouds', 'volumetricFog', 'contactShadows']) {
      if (typeof value.effects[key] === 'boolean') effects[key] = value.effects[key];
    }
    if (Object.keys(effects).length) context.effects = effects;
  }
  return Object.keys(context).length ? context : null;
}

function summarizeHistory(history) {
  const cpuFrame = history.map((item) => item.cpuFrameMs).filter(Number.isFinite);
  const cpuSubmit = history.map((item) => item.cpuSubmitMs).filter(Number.isFinite);
  const gpuFrame = history.map((item) => item.gpuRenderMs).filter(Number.isFinite);
  const gpuStage = history.map((item) => item.gpuStageMs).filter(Number.isFinite);
  const frameInterval = history.map((item) => item.frameIntervalMs).filter(Number.isFinite);
  const memory = history.map((item) => item.memoryBytes).filter(Number.isFinite);
  const asyncElapsed = history.map((item) => item.asyncElapsedMs).filter(Number.isFinite);
  const context = history.slice().reverse().find((item) => item.context)?.context || null;
  return {
    sampleCount: history.length,
    cpuFrameSampleCount: cpuFrame.length,
    cpuSubmitSampleCount: cpuSubmit.length,
    gpuRenderSampleCount: gpuFrame.length,
    gpuStageSampleCount: gpuStage.length,
    frameIntervalSampleCount: frameInterval.length,
    memorySampleCount: memory.length,
    asyncElapsedSampleCount: asyncElapsed.length,
    cpuFrameP50Ms: percentile(cpuFrame, 50),
    cpuFrameP95Ms: percentile(cpuFrame, 95),
    cpuFrameP99Ms: percentile(cpuFrame, 99),
    cpuSubmitP50Ms: percentile(cpuSubmit, 50),
    cpuSubmitP95Ms: percentile(cpuSubmit, 95),
    cpuSubmitP99Ms: percentile(cpuSubmit, 99),
    gpuRenderP50Ms: percentile(gpuFrame, 50),
    gpuRenderP95Ms: percentile(gpuFrame, 95),
    gpuStageP50Ms: percentile(gpuStage, 50),
    gpuStageP95Ms: percentile(gpuStage, 95),
    frameIntervalP95Ms: percentile(frameInterval, 95),
    memoryP95Bytes: percentile(memory, 95),
    asyncElapsedP50Ms: percentile(asyncElapsed, 50),
    asyncElapsedP95Ms: percentile(asyncElapsed, 95),
    context
  };
}

export function createVisualCompensationGraph(options = {}) {
  const maxNodes = Math.max(1, Math.min(256, Math.floor(Number(options.maxNodes) || 64)));
  const maxEdges = Math.max(1, Math.min(1024, Math.floor(Number(options.maxEdges) || 128)));
  const historyLimit = Math.max(1, Math.min(1200, Math.floor(Number(options.historyLimit) || DEFAULT_HISTORY_LIMIT)));
  const nodes = new Map();
  const edges = new Map();
  const latestContextByMetric = new Map();

  function assertId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new TypeError('Graph node IDs must match ' + ID_PATTERN);
    }
    return id;
  }

  function hasPath(start, goal) {
    const stack = [start];
    const visited = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (current === goal) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of edges.values()) {
        if (edge.from === current) stack.push(edge.to);
      }
    }
    return false;
  }

  function registerNode(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') throw new TypeError('Node descriptor is required.');
    const id = assertId(descriptor.id);
    if (nodes.has(id)) throw new Error('Graph node already exists: ' + id);
    if (nodes.size >= maxNodes) throw new RangeError('Graph node limit reached.');
    const node = {
      id,
      label: String(descriptor.label || id).slice(0, 120),
      kind: String(descriptor.kind || 'render-stage').slice(0, 48),
      backend: String(descriptor.backend || 'shared').slice(0, 32),
      description: String(descriptor.description || '').slice(0, 500),
      visualImpact: finiteNonNegative(descriptor.visualImpact),
      qualityLevel: finiteNonNegative(descriptor.qualityLevel),
      updateFrequencyHz: finiteNonNegative(descriptor.updateFrequencyHz),
      dependencies: [],
      contextHistories: new Map()
    };
    nodes.set(id, node);
    return Object.freeze({ id });
  }

  function connect(from, to) {
    assertId(from);
    assertId(to);
    if (!nodes.has(from) || !nodes.has(to)) throw new Error('Both graph nodes must exist before connecting an edge.');
    if (from === to || hasPath(to, from)) throw new Error('Graph edge would introduce a dependency cycle.');
    const key = from + '->' + to;
    if (edges.has(key)) return false;
    if (edges.size >= maxEdges) throw new RangeError('Graph edge limit reached.');
    edges.set(key, { from, to });
    nodes.get(to).dependencies.push(from);
    return true;
  }

  function recordMeasurement(id, measurement = {}) {
    const node = nodes.get(assertId(id));
    if (!node) throw new Error('Unknown graph node: ' + id);
    const sample = {
      sampledAt: finiteNonNegative(measurement.sampledAt),
      cpuFrameMs: finiteNonNegative(measurement.cpuFrameMs),
      cpuSubmitMs: finiteNonNegative(measurement.cpuSubmitMs),
      gpuRenderMs: finiteNonNegative(measurement.gpuRenderMs),
      gpuStageMs: finiteNonNegative(measurement.gpuStageMs),
      frameIntervalMs: finiteNonNegative(measurement.frameIntervalMs),
      memoryBytes: finiteNonNegative(measurement.memoryBytes),
      asyncElapsedMs: finiteNonNegative(measurement.asyncElapsedMs),
      context: sanitizeContext(measurement.context)
    };
    if (!Object.entries(sample).some(([key, value]) => key !== 'context' && value !== null)) {
      throw new TypeError('Measurement must contain at least one finite, non-negative metric.');
    }
    const contextKey = sample.context ? JSON.stringify(sample.context) : '{}';
    for (const metric of ['cpuFrameMs', 'cpuSubmitMs', 'gpuRenderMs', 'gpuStageMs', 'frameIntervalMs', 'memoryBytes', 'asyncElapsedMs']) {
      if (sample[metric] !== null) latestContextByMetric.set(metric, contextKey);
    }
    let bucket = node.contextHistories.get(contextKey);
    if (!bucket) {
      if (node.contextHistories.size >= 8) {
        const oldestKey = node.contextHistories.keys().next().value;
        node.contextHistories.delete(oldestKey);
      }
      bucket = { key: contextKey, context: sample.context, history: [] };
    } else {
      node.contextHistories.delete(contextKey);
    }
    bucket.history.push(sample);
    if (bucket.history.length > historyLimit) bucket.history.splice(0, bucket.history.length - historyLimit);
    node.contextHistories.set(contextKey, bucket);
    return summarizeNodeHistory(node);
  }

  function summarizeNodeHistory(node) {
    const buckets = [...node.contextHistories.values()];
    const latest = buckets[buckets.length - 1];
    const metrics = summarizeHistory(latest?.history || []);
    const totalSampleCount = buckets.reduce((total, bucket) => total + bucket.history.length, 0);
    return {
      ...metrics,
      totalSampleCount,
      contextCount: buckets.length
    };
  }

  function summarizeNodeContexts(node) {
    return [...node.contextHistories.values()].map((bucket) => ({
      contextKey: bucket.key,
      ...summarizeHistory(bucket.history)
    }));
  }

  function updateNode(id, patch = {}) {
    const node = nodes.get(assertId(id));
    if (!node) throw new Error('Unknown graph node: ' + id);
    for (const key of ['label', 'kind', 'backend', 'description']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) node[key] = String(patch[key]).slice(0, key === 'description' ? 500 : 120);
    }
    for (const key of ['visualImpact', 'qualityLevel', 'updateFrequencyHz']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) node[key] = finiteNonNegative(patch[key]);
    }
    return true;
  }

  function snapshot() {
    return {
      schema: 'pstudio.visual-compensation-graph.v1',
      nodeCount: nodes.size,
      edgeCount: edges.size,
      nodes: [...nodes.values()].map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        backend: node.backend,
        description: node.description,
        visualImpact: node.visualImpact,
        qualityLevel: node.qualityLevel,
        updateFrequencyHz: node.updateFrequencyHz,
        dependencies: node.dependencies.slice(),
        metrics: summarizeNodeHistory(node),
        contextMetrics: summarizeNodeContexts(node)
      })),
      edges: [...edges.values()].map((edge) => ({ ...edge }))
    };
  }

  function analyzeBottlenecks() {
    return [...nodes.values()].map((node) => {
      const metrics = summarizeNodeHistory(node);
      return {
        id: node.id,
        label: node.label,
        backend: node.backend,
        metrics,
        gpuEvidence: metrics.gpuStageP95Ms === null ? 'not-available-per-stage' : 'measured',
        evidenceByDomain: {
          cpuFrame: metrics.cpuFrameP95Ms === null ? 'unmeasured' : 'measured',
          cpuStages: metrics.cpuSubmitP95Ms === null ? 'unmeasured' : 'measured',
          gpuFrame: metrics.gpuRenderP95Ms === null ? 'unmeasured' : 'measured',
          gpuStages: metrics.gpuStageP95Ms === null ? 'unmeasured' : 'measured',
          asynchronous: metrics.asyncElapsedP95Ms === null ? 'unmeasured' : 'measured',
          memory: metrics.memoryP95Bytes === null ? 'unmeasured' : 'estimated'
        }
      };
    });
  }

  function analyzeResourceDomains() {
    const rank = (valueKey, sampleKey, countKey) => {
      const contextKey = latestContextByMetric.get(sampleKey);
      if (!contextKey) return [];
      return [...nodes.values()].flatMap((node) => {
        const bucket = node.contextHistories.get(contextKey);
        if (!bucket) return [];
        const metrics = summarizeHistory(bucket.history);
        const value = metrics[valueKey];
        if (!Number.isFinite(value)) return [];
        return [{
          id: node.id,
          label: node.label,
          value,
          metric: valueKey,
          sampleCount: metrics[countKey],
          context: metrics.context,
          contextKey
        }];
      }).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    };
    return {
      cpuFrame: rank('cpuFrameP95Ms', 'cpuFrameMs', 'cpuFrameSampleCount'),
      cpuStages: rank('cpuSubmitP95Ms', 'cpuSubmitMs', 'cpuSubmitSampleCount'),
      gpuFrame: rank('gpuRenderP95Ms', 'gpuRenderMs', 'gpuRenderSampleCount'),
      gpuStages: rank('gpuStageP95Ms', 'gpuStageMs', 'gpuStageSampleCount'),
      asynchronous: rank('asyncElapsedP95Ms', 'asyncElapsedMs', 'asyncElapsedSampleCount'),
      memory: rank('memoryP95Bytes', 'memoryBytes', 'memorySampleCount')
    };
  }

  return Object.freeze({
    registerNode,
    connect,
    recordMeasurement,
    updateNode,
    snapshot,
    analyzeBottlenecks,
    analyzeResourceDomains,
    getNodeCount: () => nodes.size,
    getEdgeCount: () => edges.size
  });
}
