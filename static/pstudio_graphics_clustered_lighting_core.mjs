import { PStudioGraphicsError } from './pstudio_graphics_contract.mjs';

function positive(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(label + ' must be a positive safe integer.');
  return number;
}

/** Stable CPU-side cluster index builder; visibility/culling policy is supplied by the caller. */
export function createPStudioGraphicsClusteredLightingCore(options = {}) {
  let layout = null;
  let clusters = new Map();
  let revision = 0;
  let disposed = false;
  function assertLive() { if (disposed) throw new PStudioGraphicsError('Clustered Lighting Core is disposed.', { code: 'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_DISPOSED' }); }
  function configure(input = {}) {
    assertLive();
    const x = positive(input.tilesX, 'tilesX'), y = positive(input.tilesY, 'tilesY'), z = positive(input.tilesZ, 'tilesZ');
    const total = x * y * z;
    const maxClusters = positive(options.maxClusters ?? 1048576, 'maxClusters');
    if (!Number.isSafeInteger(total) || total > maxClusters) throw new RangeError('Cluster grid exceeds the configured cluster limit.');
    const maxLightsPerCluster = positive(input.maxLightsPerCluster ?? options.maxLightsPerCluster ?? 256, 'maxLightsPerCluster');
    layout = Object.freeze({ tilesX: x, tilesY: y, tilesZ: z, clusterCount: total, maxLightsPerCluster });
    clusters = new Map();
    revision++;
    return layout;
  }
  function setCluster(index, lightIndices) {
    assertLive();
    if (!layout) throw new PStudioGraphicsError('Cluster grid has not been configured.', { code: 'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_NOT_CONFIGURED' });
    const clusterIndex = Number(index);
    if (!Number.isSafeInteger(clusterIndex) || clusterIndex < 0 || clusterIndex >= layout.clusterCount) throw new RangeError('Cluster index is out of range.');
    if (!Array.isArray(lightIndices) && !ArrayBuffer.isView(lightIndices)) throw new TypeError('Cluster light indices must be an array or typed array.');
    const values = [...new Set(Array.from(lightIndices, Number))];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)) throw new TypeError('Cluster light indices must be unsigned 32-bit integers.');
    if (values.length > layout.maxLightsPerCluster) throw new RangeError('Cluster exceeds maxLightsPerCluster; no light is silently dropped.');
    if (values.length) clusters.set(clusterIndex, values); else clusters.delete(clusterIndex);
    revision++;
    return values.length;
  }
  function setAll(assignments = []) {
    assertLive();
    if (!layout) throw new PStudioGraphicsError('Cluster grid has not been configured.', { code: 'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_NOT_CONFIGURED' });
    if (!Array.isArray(assignments) || assignments.length !== layout.clusterCount) throw new TypeError('Cluster assignments must match the configured cluster count.');
    const next = assignments.map((indices, index) => {
      if (!Array.isArray(indices) && !ArrayBuffer.isView(indices)) throw new TypeError('Cluster ' + index + ' indices must be an array or typed array.');
      const values = [...new Set(Array.from(indices, Number))];
      if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)) throw new TypeError('Cluster light indices must be unsigned 32-bit integers.');
      if (values.length > layout.maxLightsPerCluster) throw new RangeError('Cluster ' + index + ' exceeds maxLightsPerCluster.');
      return values;
    });
    clusters = new Map();
    next.forEach((values, index) => { if (values.length) clusters.set(index, values); });
    revision++;
    return revision;
  }
  function snapshot() {
    assertLive();
    if (!layout) throw new PStudioGraphicsError('Cluster grid has not been configured.', { code: 'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_NOT_CONFIGURED' });
    const offsets = new Uint32Array(layout.clusterCount + 1);
    let total = 0;
    for (let index = 0; index < layout.clusterCount; index++) { offsets[index] = total; total += clusters.get(index)?.length || 0; }
    offsets[layout.clusterCount] = total;
    const indices = new Uint32Array(total);
    let cursor = 0;
    for (let index = 0; index < layout.clusterCount; index++) for (const lightIndex of clusters.get(index) || []) indices[cursor++] = lightIndex;
    return Object.freeze({ revision, layout, clusterOffsets: offsets, clusterLightIndices: indices, indexCount: total, maxLightsInCluster: [...clusters.values()].reduce((max, values) => Math.max(max, values.length), 0) });
  }
  async function upload(config = {}) {
    assertLive();
    const uploader = config.uploadSnapshot || config.upload || options.uploadSnapshot;
    if (typeof uploader !== 'function') throw new PStudioGraphicsError('No GPU clustered-lighting uploader is configured.', { code: 'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_UPLOAD_UNAVAILABLE' });
    return uploader(snapshot());
  }
  function stats() { return Object.freeze({ configured: !!layout, layout, revision, clusterCount: layout?.clusterCount || 0, populatedClusterCount: clusters.size, indexCount: [...clusters.values()].reduce((sum, items) => sum + items.length, 0), maxLightsInCluster: [...clusters.values()].reduce((max, items) => Math.max(max, items.length), 0), disposed }); }
  function dispose() { if (disposed) return false; clusters = new Map(); layout = null; disposed = true; return true; }
  return Object.freeze({ kind: 'pstudio-graphics-clustered-lighting-core', configure, setCluster, setAll, snapshot, upload, stats, dispose });
}
