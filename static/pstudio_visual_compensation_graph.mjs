const DEFAULT_HISTORY_LIMIT = 120;
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeHistory(history) {
  const cpu = history.map((item) => item.cpuSubmitMs).filter(Number.isFinite);
  const gpu = history.map((item) => item.gpuRenderMs).filter(Number.isFinite);
  const memory = history.map((item) => item.memoryBytes).filter(Number.isFinite);
  const asyncElapsed = history.map((item) => item.asyncElapsedMs).filter(Number.isFinite);
  return {
    sampleCount: history.length,
    cpuSubmitP50Ms: percentile(cpu, 50),
    cpuSubmitP95Ms: percentile(cpu, 95),
    gpuRenderP50Ms: percentile(gpu, 50),
    gpuRenderP95Ms: percentile(gpu, 95),
    memoryP95Bytes: percentile(memory, 95),
    asyncElapsedP50Ms: percentile(asyncElapsed, 50),
    asyncElapsedP95Ms: percentile(asyncElapsed, 95)
  };
}

export function createVisualCompensationGraph(options = {}) {
  const maxNodes = Math.max(1, Math.min(256, Math.floor(Number(options.maxNodes) || 64)));
  const maxEdges = Math.max(1, Math.min(1024, Math.floor(Number(options.maxEdges) || 128)));
  const historyLimit = Math.max(1, Math.min(1200, Math.floor(Number(options.historyLimit) || DEFAULT_HISTORY_LIMIT)));
  const nodes = new Map();
  const edges = new Map();

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
      history: []
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
      cpuSubmitMs: finiteNonNegative(measurement.cpuSubmitMs),
      gpuRenderMs: finiteNonNegative(measurement.gpuRenderMs),
      frameIntervalMs: finiteNonNegative(measurement.frameIntervalMs),
      memoryBytes: finiteNonNegative(measurement.memoryBytes),
      asyncElapsedMs: finiteNonNegative(measurement.asyncElapsedMs)
    };
    if (!Object.values(sample).some((value) => value !== null)) {
      throw new TypeError('Measurement must contain at least one finite, non-negative metric.');
    }
    node.history.push(sample);
    if (node.history.length > historyLimit) node.history.splice(0, node.history.length - historyLimit);
    return summarizeHistory(node.history);
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
        metrics: summarizeHistory(node.history)
      })),
      edges: [...edges.values()].map((edge) => ({ ...edge }))
    };
  }

  function analyzeBottlenecks() {
    return [...nodes.values()].map((node) => {
      const metrics = summarizeHistory(node.history);
      return {
        id: node.id,
        label: node.label,
        backend: node.backend,
        metrics,
        evidence: metrics.sampleCount ? 'measured-cpu-submit' : 'unmeasured',
        gpuEvidence: metrics.gpuRenderP95Ms === null ? 'not-available-per-stage' : 'measured'
      };
    }).sort((a, b) => {
      const av = a.metrics.cpuSubmitP95Ms;
      const bv = b.metrics.cpuSubmitP95Ms;
      if (av === null && bv === null) return a.id.localeCompare(b.id);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }

  return Object.freeze({
    registerNode,
    connect,
    recordMeasurement,
    updateNode,
    snapshot,
    analyzeBottlenecks,
    getNodeCount: () => nodes.size,
    getEdgeCount: () => edges.size
  });
}
