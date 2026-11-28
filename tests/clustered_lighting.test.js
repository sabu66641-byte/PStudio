const test = require('node:test');
const assert = require('node:assert/strict');
const { createPStudioGraphicsLightingCore } = require('../static/pstudio_graphics_lighting_core.mjs');
const { createPStudioGraphicsClusteredLightingCore } = require('../static/pstudio_graphics_clustered_lighting_core.mjs');

test('clustered lighting remains sparse and uses the packed-light index order', () => {
  const lights = createPStudioGraphicsLightingCore();
  lights.set({ id: 'fill', type: 'point', priority: 0, position: [0, 0, 0] });
  lights.set({ id: 'key', type: 'directional', priority: 10, direction: [0, -1, 0] });
  const snapshot = lights.snapshot();
  assert.equal(snapshot.records[0].id, 'key');
  assert.equal(snapshot.indexById.key, 0);
  assert.equal(snapshot.indexById.fill, 1);
  const clusters = createPStudioGraphicsClusteredLightingCore({ maxClusters: 1024 });
  clusters.configure({ tilesX: 4, tilesY: 4, tilesZ: 4 });
  clusters.setCluster(17, [snapshot.indexById.key, snapshot.indexById.fill]);
  assert.equal(clusters.stats().clusterCount, 64);
  assert.equal(clusters.stats().populatedClusterCount, 1);
  const packed = clusters.snapshot();
  assert.deepEqual(Array.from(packed.clusterOffsets.slice(16, 19)), [0, 0, 2]);
  assert.deepEqual(Array.from(packed.clusterLightIndices), [0, 1]);
  clusters.dispose(); lights.dispose();
});

test('clustered lighting fails rather than truncating overflow and rejects invalid ids', () => {
  const clusters = createPStudioGraphicsClusteredLightingCore();
  clusters.configure({ tilesX: 1, tilesY: 1, tilesZ: 1, maxLightsPerCluster: 1 });
  assert.throws(() => clusters.setCluster(0, [1, 2]), /no light is silently dropped/);
  assert.throws(() => clusters.setCluster(0, [-1]), /unsigned 32-bit/);
  assert.equal(clusters.setCluster(0, [2, 2]), 1);
  clusters.dispose();
});
