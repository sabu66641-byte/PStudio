const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createStreamingRuntime(objects) {
  const calls = {
    register: [], assign: [], unassign: [], unregister: [], interests: [], clearInterests: 0
  };
  const chunks = new Map();
  const assignments = new Map();
  const window = {
    dispatchEvent() {},
    PStudio3D: {
      registerWorldChunk(id, config) {
        calls.register.push({ id, config: JSON.parse(JSON.stringify(config)) });
        chunks.set(id, config);
        return { id };
      },
      assignObjectToChunk(owner, id) {
        calls.assign.push([String(owner), String(id)]);
        assignments.set(String(owner), String(id));
        return true;
      },
      unassignObjectFromChunk(owner) {
        calls.unassign.push(String(owner));
        assignments.delete(String(owner));
        return true;
      },
      unregisterWorldChunk(id) {
        calls.unregister.push(String(id));
        chunks.delete(String(id));
        for (const [owner, partition] of assignments) if (partition === String(id)) assignments.delete(owner);
        return true;
      },
      setWorldStreamingInterests(interests) {
        calls.interests.push(JSON.parse(JSON.stringify(interests)));
        return interests.length;
      },
      clearWorldStreamingInterests() {
        calls.clearInterests++;
        return true;
      }
    }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_rendering.js'), sandbox, { filename: 'pstudio_ecs_rendering.js' });
  vm.runInNewContext(read('static/pstudio_ecs_streaming.js'), sandbox, { filename: 'pstudio_ecs_streaming.js' });
  const ecs = window.PStudioECS;
  ecs.syncSceneObjects(objects);
  return { ecs, streaming: window.PStudioECSStreaming, objects, calls, chunks, assignments, window };
}
function snapshotAndSync(runtime) {
  runtime.ecs.updatePhase('postUpdate', 1 / 60, { sceneObjects: runtime.objects });
  return runtime.streaming.sync(runtime.objects);
}

test('WorldPartition and StreamingInterest are persistent Inspector Components with snapshot Systems', () => {
  const { ecs, streaming } = createStreamingRuntime([]);
  for (const type of ['WorldPartition', 'StreamingInterest']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true);
    assert.equal(definition.internal, false);
    assert.equal(definition.readonly, false);
    assert.ok(definition.schema);
  }
  assert.ok(ecs.getSystems().some(system => system.id === 'world.partition.snapshot' && system.phase === 'postUpdate'));
  assert.ok(ecs.getSystems().some(system => system.id === 'world.streaming-interest.snapshot' && system.phase === 'postUpdate'));
  assert.deepEqual(Array.from(streaming.componentTypes), ['WorldPartition', 'StreamingInterest']);
});

test('WorldPartition registers one region, gathers member models and assigns only declared objects', () => {
  const objects = [
    { id: 'region-root', name: 'Forest Region', x: 480, y: 0, z: 100, w: 64, h: 64 },
    { id: 'tree-a', name: 'Tree A', x: 0, y: 0, z: 0, model: 'tree.glb', w: 64, h: 64 },
    { id: 'rock-a', name: 'Rock A', x: 0, y: 0, z: 0, w: 64, h: 64 }
  ];
  const runtime = createStreamingRuntime(objects);
  const root = runtime.ecs.getEntityForSceneObject('region-root');
  const tree = runtime.ecs.getEntityForSceneObject('tree-a');
  runtime.ecs.addComponent(tree, 'Renderable', { kind: 'model', assetName: 'tree-detail.glb' });
  runtime.ecs.addComponent(root, 'WorldPartition', {
    partitionId: 'forest-east',
    memberObjectIds: ['tree-a', 'rock-a', 'tree-a', 'missing'],
    assetNames: ['forest-collision.glb'],
    loadDistance: 500,
    unloadDistance: 700,
    centerOffsetX: 10,
    centerOffsetY: 2,
    centerOffsetZ: -3
  });

  const result = snapshotAndSync(runtime);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    partitions: 1, assignments: 3, interests: 0, diagnostics: []
  });
  assert.equal(runtime.calls.register.length, 1);
  const registration = runtime.calls.register[0];
  assert.equal(registration.id, 'forest-east');
  assert.equal(registration.config.x, 10.32);
  assert.equal(registration.config.y, 2.38 + 2);
  assert.equal(registration.config.z, -2);
  assert.equal(registration.config.loadDistance, 500);
  assert.equal(registration.config.unloadDistance, 700);
  assert.deepEqual(registration.config.assets, [
    'forest-collision.glb', 'tree.glb', 'tree-detail.glb'
  ]);
  assert.deepEqual(runtime.calls.assign, [
    ['region-root', 'forest-east'],
    ['tree-a', 'forest-east'],
    ['rock-a', 'forest-east']
  ]);
  assert.equal(runtime.assignments.size, 3);
});

test('persisted Components restore, and moving StreamingInterest updates only the spatial interest snapshot', () => {
  const objects = [{
    id: 'player',
    x: 100, y: 50, z: 200, w: 100, h: 80,
    ecsComponents: [
      { type: 'WorldPartition', data: { partitionId: 'start-area', memberObjectIds: [], loadDistance: 400, unloadDistance: 600 } },
      { type: 'StreamingInterest', data: { priority: 7, offsetX: 1.5, loadMultiplier: 1.25, unloadMultiplier: 1.5 } }
    ]
  }];
  const runtime = createStreamingRuntime(objects);
  const playerEntity = runtime.ecs.getEntityForSceneObject('player');
  assert.ok(runtime.ecs.hasComponent(playerEntity, 'WorldPartition'));
  assert.ok(runtime.ecs.hasComponent(playerEntity, 'StreamingInterest'));

  snapshotAndSync(runtime);
  assert.equal(runtime.calls.interests.length, 1);
  const interest = runtime.calls.interests[0][0];
  assert.equal(interest.id.startsWith('player:'), true);
  assert.equal(interest.x, (100 + 50 - 480) / 100 + 1.5);
  assert.equal(interest.y, (270 - (50 + 40)) / 100);
  assert.equal(interest.z, 2);
  assert.equal(interest.priority, 7);
  assert.equal(interest.loadMultiplier, 1.25);
  assert.equal(interest.unloadMultiplier, 1.5);

  objects[0].x = 600;
  runtime.ecs.syncSceneObjects(objects);
  snapshotAndSync(runtime);
  assert.equal(runtime.calls.interests.length, 2, 'changed position publishes a new interest snapshot');
  assert.equal(runtime.calls.interests[1][0].x, (600 + 50 - 480) / 100 + 1.5);
});

test('partition membership conflicts are deterministic and missing objects are ignored', () => {
  const objects = [
    { id: 'west', x: 0, y: 0, z: 0 },
    { id: 'east', x: 1000, y: 0, z: 0 },
    { id: 'shared', x: 500, y: 0, z: 0 }
  ];
  const runtime = createStreamingRuntime(objects);
  runtime.ecs.addComponent(runtime.ecs.getEntityForSceneObject('west'), 'WorldPartition', {
    partitionId: 'west-region', memberObjectIds: ['shared']
  });
  runtime.ecs.addComponent(runtime.ecs.getEntityForSceneObject('east'), 'WorldPartition', {
    partitionId: 'east-region', memberObjectIds: ['shared', 'not-there']
  });
  const result = snapshotAndSync(runtime);
  assert.equal(result.partitions, 2);
  assert.equal(result.assignments, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.diagnostics)),
    [{ entity: runtime.ecs.getEntityForSceneObject('east'), id: 'east-region', ownerId: 'shared', reason: 'object-assigned-to-multiple-partitions' }]
  );
  assert.equal(runtime.assignments.get('shared'), 'west-region', 'first entity in deterministic ECS order wins');
});

test('disabled Components and removed partitions are unregistered and clear stale assignments/interests', () => {
  const objects = [
    { id: 'area', x: 0, y: 0, z: 0 },
    { id: 'player', x: 0, y: 0, z: 0 }
  ];
  const runtime = createStreamingRuntime(objects);
  const area = runtime.ecs.getEntityForSceneObject('area');
  const player = runtime.ecs.getEntityForSceneObject('player');
  runtime.ecs.addComponent(area, 'WorldPartition', { partitionId: 'area-1', memberObjectIds: ['player'] });
  runtime.ecs.addComponent(player, 'StreamingInterest', {});
  snapshotAndSync(runtime);
  assert.equal(runtime.calls.register.length, 1);
  assert.equal(runtime.assignments.get('player'), 'area-1');
  assert.equal(runtime.calls.interests.length, 1);

  runtime.ecs.setComponent(area, 'WorldPartition', { enabled: false });
  runtime.ecs.setComponent(player, 'StreamingInterest', { enabled: false });
  snapshotAndSync(runtime);
  assert.deepEqual(runtime.calls.unregister, ['area-1']);
  assert.deepEqual(runtime.calls.unassign, ['area', 'player']);
  assert.equal(runtime.calls.interests.at(-1).length, 0);

  runtime.streaming.clear();
  assert.equal(runtime.calls.clearInterests, 1);
  assert.deepEqual(runtime.streaming.getStats(), { partitions: 0, assignments: 0, interests: 0 });
});

test('unchanged partition configuration and interests do not create redundant renderer mutations', () => {
  const objects = [{ id: 'actor', x: 10, y: 20, z: 30 }];
  const runtime = createStreamingRuntime(objects);
  const entity = runtime.ecs.getEntityForSceneObject('actor');
  runtime.ecs.addComponent(entity, 'WorldPartition', { partitionId: 'actor-area' });
  runtime.ecs.addComponent(entity, 'StreamingInterest', {});
  snapshotAndSync(runtime);
  snapshotAndSync(runtime);
  assert.equal(runtime.calls.register.length, 1);
  assert.equal(runtime.calls.assign.length, 1);
  assert.equal(runtime.calls.interests.length, 1);
});

test('streaming bridge and engine lifecycle remain integrated without moving renderer ownership into ECS', () => {
  const engine = read('static/pstudio_engine.js');
  const renderer = read('static/pstudio_3d_engine.js');
  const html = read('templates/index.html');
  const app = read('app.py');
  assert.ok(engine.includes('window.PStudioECSStreaming?.sync?.(sceneObjects || [])'));
  assert.ok(engine.includes('window.PStudioECSStreaming?.clear?.()'));
  assert.ok(engine.includes("['Camera','Light','Renderable','Animation','WorldPartition','StreamingInterest']"));
  assert.ok(html.indexOf('pstudio_ecs_rendering.js') < html.indexOf('pstudio_ecs_streaming.js'));
  assert.ok(html.indexOf('pstudio_ecs_streaming.js') < html.indexOf('pstudio_ecs_inspector.js'));
  for (const token of [
    'function registerWorldChunk', 'function setWorldStreamingInterests',
    'function clearWorldStreamingInterests', 'maxConcurrentChunkLoads',
    'unassignObjectFromChunk', 'releaseChunkAssetCache(chunk,assetNames=chunk.assets)',
    'const requestedAssets=chunk.assets.slice()'
  ]) assert.ok(renderer.includes(token), token);
  for (const type of ['WorldPartition', 'StreamingInterest']) assert.ok(app.includes('"'+type+'"'), type);
  assert.doesNotThrow(() => new Function(read('static/pstudio_ecs_streaming.js')));
  assert.doesNotThrow(() => new Function(engine));
  assert.doesNotThrow(() => new Function(renderer));
});
