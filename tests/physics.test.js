const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPhysics() {
  const window = {};
  const sandbox = { window, Math, Number, Map, Set, WeakMap, Array, Object, Error };
  vm.runInNewContext(fs.readFileSync('static/pstudio_physics.js', 'utf8'), sandbox);
  return window.PStudioPhysics;
}

test('terrain collision triangles are built once and reused across frames', () => {
  const physics = createPhysics();
  const makeCommands = () => new Map([['terrain-owner', [{
    type: 'terrain', x: 0, y: 0, z: 0,
    width: 40, depth: 40, height: 4, segments: 16
  }]]]);

  physics.step(1 / 60, makeCommands());
  const first = physics.getStats();
  assert.equal(first.staticColliderCacheEntries, 1);
  assert.equal(first.cachedTriangleCount, 16 * 16 * 2);

  physics.step(1 / 60, makeCommands());
  const second = physics.getStats();
  assert.equal(second.staticColliderCacheEntries, 1);
  assert.equal(second.cachedTriangleCount, first.cachedTriangleCount);

  physics.step(1 / 60, new Map());
  assert.equal(physics.getStats().staticColliderCacheEntries, 0);
  assert.equal(physics.getStats().cachedTriangleCount, 0);
});

test('model mesh collider triangles reuse the same transformed array and expire when removed', () => {
  const physics = createPhysics();
  const transformedTriangles = [
    0, 0, 0,
    1, 0, 0,
    0, 0, 1
  ];
  const makeCommands = () => new Map([['model-owner', [{
    type: 'model_mesh_collider',
    triangles: transformedTriangles
  }]]]);

  physics.step(1 / 60, makeCommands());
  const first = physics.getStats();
  assert.equal(first.staticColliderCacheEntries, 1);
  assert.equal(first.cachedTriangleCount, 1);

  physics.step(1 / 60, makeCommands());
  assert.equal(physics.getStats().staticColliderCacheEntries, 1);
  assert.equal(physics.getStats().cachedTriangleCount, 1);

  physics.step(1 / 60, new Map());
  assert.equal(physics.getStats().staticColliderCacheEntries, 0);
});

test('stale moving-platform history is removed when its collider leaves the scene', () => {
  const physics = createPhysics();
  const plane = new Map([['platform-owner', [{
    type: 'plane', x: 0, y: 0, z: 0, width: 12, depth: 12
  }]]]);

  physics.step(1 / 60, plane);
  assert.equal(physics.getStats().trackedPlatforms, 1);

  physics.step(1 / 60, new Map());
  assert.equal(physics.getStats().trackedPlatforms, 0);
});

test('cache keys include terrain geometry and transform parameters', () => {
  const physics = createPhysics();
  const makeCommands = (segments, x) => new Map([['terrain-owner', [{
    type: 'terrain', x, y: 0, z: 0,
    width: 20, depth: 20, height: 2, segments
  }]]]);

  physics.step(1 / 60, makeCommands(4, 0));
  assert.equal(physics.getStats().cachedTriangleCount, 4 * 4 * 2);

  physics.step(1 / 60, makeCommands(8, 0));
  assert.equal(physics.getStats().staticColliderCacheEntries, 1);
  assert.equal(physics.getStats().cachedTriangleCount, 8 * 8 * 2);

  physics.step(1 / 60, makeCommands(8, 5));
  assert.equal(physics.getStats().staticColliderCacheEntries, 1);
  assert.equal(physics.getStats().cachedTriangleCount, 8 * 8 * 2);
});
