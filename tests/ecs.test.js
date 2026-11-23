const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createECS() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = { window, console, Map, Set, Promise, Date, Number, Object, Array, TypeError, Error };
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs.js', 'utf8'), sandbox);
  return window.PStudioECS;
}

test('creates entities and keeps sparse component stores consistent after removals', () => {
  const ecs = createECS();
  const a = ecs.createEntity({ Transform: { x: 1, y: 2 } });
  const b = ecs.createEntity({ Transform: { x: 3, y: 4 } });
  const c = ecs.createEntity({ Transform: { x: 5, y: 6 } });

  assert.deepEqual(Array.from(ecs.query(['Transform'])), [a, b, c]);
  assert.equal(ecs.removeComponent(b, 'Transform'), true);
  assert.deepEqual(Array.from(ecs.query(['Transform'])), [a, c]);
  assert.equal(ecs.getComponent(c, 'Transform').x, 5);
  assert.equal(ecs.hasComponent(b, 'Transform'), false);
});

test('validates entities, component data and duplicate components', () => {
  const ecs = createECS();
  const id = ecs.createEntity();
  assert.throws(() => ecs.addComponent(id, 'Unknown', {}), /not registered/);
  assert.throws(() => ecs.addComponent(id, 'Transform', null), /object/);
  ecs.addComponent(id, 'Transform', { x: 4 });
  assert.throws(() => ecs.addComponent(id, 'Transform', {}), /already has/);
  ecs.setComponent(id, 'Transform', { x: 9 });
  assert.equal(ecs.getComponent(id, 'Transform').x, 9);
  assert.throws(() => ecs.getComponent(9999, 'Transform'), /does not exist/);
});

test('runs systems in priority order and supports component queries', () => {
  const ecs = createECS();
  const order = [];
  const a = ecs.createEntity({ Transform: { x: 1 } });
  ecs.createEntity({ Transform: { x: 10 } });
  ecs.registerSystem({
    id: 'test.late',
    components: ['Transform'],
    priority: 20,
    update(dt, api) {
      api.forEach(['Transform'], (entity, transform) => {
        transform.x += dt;
        order.push('late:' + entity);
      });
    }
  });
  ecs.registerSystem({
    id: 'test.early',
    priority: -5,
    update() { order.push('early'); }
  });

  ecs.update(0.5);
  assert.equal(ecs.getComponent(a, 'Transform').x, 1.5);
  assert.equal(order[0], 'early');
  assert.match(order[1], /^late:/);
  assert.equal(ecs.setSystemEnabled('test.late', false), false);
  const before = ecs.getComponent(a, 'Transform').x;
  ecs.update(1);
  assert.equal(ecs.getComponent(a, 'Transform').x, before);
});

test('defers structural changes made during a component iteration', () => {
  const ecs = createECS();
  const first = ecs.createEntity({ Transform: { x: 1 } });
  let second = null;
  ecs.registerSystem({
    id: 'test.spawn',
    components: ['Transform'],
    update(dt, api) {
      api.forEach(['Transform'], (entity, transform) => {
        transform.x += 1;
        if (second === null) api.defer(() => {
          second = api.createEntity({ Transform: { x: 100 } });
        });
      });
    }
  });

  ecs.update(1);
  assert.equal(ecs.getComponent(first, 'Transform').x, 2);
  assert.ok(second);
  assert.equal(ecs.getComponent(second, 'Transform').x, 100);
});

test('rejects unsafe structural changes during iteration', () => {
  const ecs = createECS();
  ecs.createEntity({ Transform: {} });
  ecs.registerSystem({
    id: 'test.invalid',
    components: ['Transform'],
    update(dt, api) {
      api.forEach(['Transform'], () => api.createEntity());
    }
  });
  assert.throws(() => ecs.update(0.016), /use ecs.defer/);
});

test('bridges Scene Objects bidirectionally and removes stale mappings', () => {
  const ecs = createECS();
  const objects = [
    { id: 'player', name: 'Player', x: 10, y: 20, z: 0, rotationY: 5 },
    { id: 'enemy', name: 'Enemy', x: 40, y: 50, z: 2 }
  ];
  assert.equal(ecs.syncSceneObjects(objects), 2);
  const player = ecs.getEntityForSceneObject('player');
  assert.ok(player);
  assert.equal(ecs.getComponent(player, 'Transform').x, 10);

  ecs.registerSystem({
    id: 'test.scene-move',
    components: ['Transform', 'SceneObjectRef'],
    update(dt, api) {
      api.forEach(['Transform', 'SceneObjectRef'], (entity, transform, ref) => {
        if (ref.sceneObjectId === 'player') transform.x += 3;
      });
    }
  });
  ecs.update(1);
  ecs.applySceneObjectTransforms(objects);
  assert.equal(objects[0].x, 13);

  objects[0].x = 99;
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.getComponent(player, 'Transform').x, 99);

  objects.splice(1, 1);
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.getEntityForSceneObject('enemy'), null);
  assert.equal(ecs.stats().entityCount, 1);
});

test('rejects duplicate Scene Object ids and validates system errors', () => {
  const ecs = createECS();
  assert.throws(
    () => ecs.syncSceneObjects([{ id: 'same' }, { id: 'same' }]),
    /Duplicate Scene Object id/
  );
  ecs.registerSystem({
    id: 'test.failure',
    update() { throw new Error('intentional'); }
  });
  assert.throws(() => ecs.update(0.016), /test.failure.*intentional/);
});

test('clears scene bindings without removing registered systems', () => {
  const ecs = createECS();
  ecs.syncSceneObjects([{ id: 'one', x: 1 }]);
  ecs.registerSystem({ id: 'test.keep', update() {} });
  ecs.clearSceneObjects();
  assert.equal(ecs.stats().entityCount, 0);
  assert.equal(ecs.stats().systemCount, 1);
  ecs.update(0.016);
});


test('Component schemas apply defaults and reject invalid fields and types', () => {
  const ecs = createECS();
  ecs.registerComponent('Vitals', {
    schema: {
      health: { type: 'integer', default: 100, min: 0, max: 100 },
      active: { type: 'boolean', default: true },
      speed: { type: 'number', default: 2.5, min: 0 }
    },
    additionalProperties: false
  });
  const entity = ecs.createEntity({ Vitals: {} });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ecs.getComponent(entity, 'Vitals'))),
    { health: 100, active: true, speed: 2.5 }
  );
  ecs.setComponent(entity, 'Vitals', { health: 80, active: false, speed: 4 });
  assert.equal(ecs.getComponent(entity, 'Vitals').health, 80);
  assert.throws(() => ecs.setComponent(entity, 'Vitals', { health: 101, active: true, speed: 1 }), /exceeds max/);
  assert.throws(() => ecs.setComponent(entity, 'Vitals', { health: 'high', active: true, speed: 1 }), /must be integer/);
  assert.throws(() => ecs.setComponent(entity, 'Vitals', { health: 50, active: true, speed: 1, unknown: 1 }), /Unknown Component field/);
  const definition = ecs.getComponentDefinition('Vitals');
  assert.equal(definition.schema.health.type, 'integer');
  assert.equal(definition.category, 'General');
});

test('Systems run in update, prePhysics, postUpdate and postPhysics phases with mutable priority', () => {
  const ecs = createECS();
  const order = [];
  ecs.registerSystem({ id: 'test.main', priority: 10, phase: 'update', update() { order.push('update'); } });
  ecs.registerSystem({ id: 'test.pre', priority: -10, phase: 'prePhysics', update() { order.push('pre'); } });
  ecs.registerSystem({ id: 'test.after-scripts', priority: 0, phase: 'postUpdate', update() { order.push('postUpdate'); } });
  ecs.registerSystem({ id: 'test.post', priority: 0, phase: 'postPhysics', update() { order.push('postPhysics'); } });
  ecs.update(0.016);
  ecs.updatePhase('prePhysics', 0.016);
  ecs.updatePhase('postUpdate', 0.016);
  ecs.updatePhase('postPhysics', 0.016);
  assert.deepEqual(order, ['update', 'pre', 'postUpdate', 'postPhysics']);
  assert.equal(ecs.setSystemPhase('test.main', 'postPhysics'), 'postPhysics');
  assert.equal(ecs.setSystemPriority('test.main', -20), -20);
  ecs.updatePhase('postPhysics', 0.016);
  assert.deepEqual(order.slice(4), ['update', 'postPhysics']);
  assert.throws(() => ecs.setSystemPhase('test.main', 'render'), /Invalid ECS System phase/);
});

test('Scene Object synchronization restores persistent typed Components but skips runtime-only Components', () => {
  const ecs = createECS();
  ecs.registerComponent('Health', {
    schema: { current: { type: 'integer', default: 50, min: 0 } },
    additionalProperties: false,
    source: 'components.ps'
  });
  ecs.registerComponent('RuntimeCache', {
    schema: { hits: { type: 'integer', default: 0 } },
    persistent: false
  });
  const sceneObject = {
    id: 'restored',
    ecsComponents: [
      { type: 'Health', data: { current: 75 } },
      { type: 'RuntimeCache', data: { hits: 9 } }
    ]
  };
  ecs.syncSceneObjects([sceneObject]);
  const entity = ecs.getEntityForSceneObject('restored');
  assert.equal(ecs.getComponent(entity, 'Health').current, 75);
  assert.equal(ecs.hasComponent(entity, 'RuntimeCache'), false);
  const entries = ecs.getEntityComponents(entity);
  assert.equal(entries.find(item => item.type === 'Health').persistent, true);
  assert.equal(ecs.getComponentDefinition('Health').source, 'components.ps');
});

test('hasActiveSystems avoids scheduling systems without their required Component stores', () => {
  const ecs = createECS();
  ecs.registerComponent('UnusedData');
  ecs.registerSystem({ id: 'test.only-unused', components: ['UnusedData'], update() {} });
  assert.equal(ecs.hasActiveSystems(), false);
  const entity = ecs.createEntity({ UnusedData: {} });
  assert.equal(ecs.hasActiveSystems(), true);
  ecs.destroyEntity(entity);
  assert.equal(ecs.hasActiveSystems(), false);
});


test('Component definitions can be safely refreshed with new defaults and are rolled back on incompatible schemas', () => {
  const ecs = createECS();
  ecs.registerComponent('Movement', {
    schema: { speed: { type: 'number', default: 2, min: 0 } },
    additionalProperties: false,
    create: () => ({ speed: 2 })
  });
  const entity = ecs.createEntity({ Movement: {} });
  ecs.setComponent(entity, 'Movement', { speed: 2.5 });
  ecs.updateComponentDefinition('Movement', {
    schema: {
      speed: { type: 'number', default: 5, min: 0 },
      enabled: { type: 'boolean', default: true }
    },
    additionalProperties: false,
    create: () => ({ speed: 5, enabled: true })
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ecs.getComponent(entity, 'Movement'))),
    { speed: 2.5, enabled: true }
  );
  const next = ecs.createEntity({ Movement: {} });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ecs.getComponent(next, 'Movement'))),
    { speed: 5, enabled: true }
  );
  assert.throws(
    () => ecs.updateComponentDefinition('Movement', {
      schema: {
        speed: { type: 'integer', required: true },
        enabled: { type: 'boolean', default: true }
      },
      additionalProperties: false
    }),
    /must be integer/
  );
  assert.equal(ecs.getComponentDefinition('Movement').schema.speed.type, 'number');
});

test('nullable schema fields retain their flag and accept null defaults and values', () => {
  const ecs = createECS();
  ecs.registerComponent('NullableReference', {
    schema: {
      target: { type: 'entity', nullable: true, default: null }
    },
    additionalProperties: false
  });
  const entity = ecs.createEntity({ NullableReference: {} });
  assert.equal(ecs.getComponent(entity, 'NullableReference').target, null);
  assert.equal(ecs.getComponentDefinition('NullableReference').schema.target.nullable, true);
  ecs.setComponent(entity, 'NullableReference', { target: null });
  assert.equal(ecs.getComponent(entity, 'NullableReference').target, null);
  assert.throws(
    () => ecs.setComponent(entity, 'NullableReference', { target: 'not-an-entity' }),
    /must be entity/
  );
});

test('serializes only persistent non-core Components with a versioned envelope', () => {
  const ecs = createECS();
  ecs.registerComponent('SavedSettings', {
    schema: { quality: { type: 'integer', default: 2 }, enabled: { type: 'boolean', default: true } },
    additionalProperties: false
  });
  ecs.registerComponent('RuntimeCache', {
    persistent: false,
    schema: { count: { type: 'integer', default: 0 } },
    additionalProperties: false
  });
  const entity = ecs.createEntity({
    SavedSettings: { quality: 4 },
    RuntimeCache: { count: 9 }
  });
  const serialized = ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef']);
  assert.deepEqual(serialized, {
    version: 1,
    components: [{ type: 'SavedSettings', data: { quality: 4, enabled: true } }]
  });
  const copy = ecs.serializeEntityComponents(entity);
  copy.components[0].data.quality = 100;
  assert.equal(ecs.getComponent(entity, 'SavedSettings').quality, 4);
});

test('restores legacy unversioned Component arrays and upgrades their scene schema to version 1', () => {
  const ecs = createECS();
  ecs.registerComponent('LegacySettings', {
    schema: { quality: { type: 'integer', default: 2 } },
    additionalProperties: false
  });
  const object = {
    id: 'legacy-array', x: 0, y: 0,
    ecsComponents: [{ type: 'LegacySettings', data: { quality: 7 } }]
  };
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject(object.id);
  assert.equal(ecs.getComponent(entity, 'LegacySettings').quality, 7);
  assert.equal(object.ecsComponentsVersion, 1);
  assert.deepEqual(object.ecsComponents, [{ type: 'LegacySettings', data: { quality: 7 } }]);
});

test('migrates legacy type-keyed Component maps without losing saved values', () => {
  const ecs = createECS();
  ecs.registerComponent('MappedSettings', {
    schema: { enabled: { type: 'boolean', default: false } },
    additionalProperties: false
  });
  const object = {
    id: 'legacy-map', x: 0, y: 0,
    ecsComponents: { MappedSettings: { enabled: true } }
  };
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject(object.id);
  assert.equal(ecs.getComponent(entity, 'MappedSettings').enabled, true);
  assert.equal(object.ecsComponentsVersion, 1);
  assert.deepEqual(object.ecsComponents, [{ type: 'MappedSettings', data: { enabled: true } }]);
});

test('does not overwrite or restore Component data from a newer unknown schema version', () => {
  const ecs = createECS();
  ecs.registerComponent('FutureSettings', {
    schema: { value: { type: 'integer', default: 0 } },
    additionalProperties: false
  });
  const futureData = [{ type: 'FutureSettings', data: { value: 99 } }];
  const object = {
    id: 'future-schema', x: 0, y: 0,
    ecsComponentsVersion: 99,
    ecsComponents: futureData
  };
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject(object.id);
  assert.equal(ecs.hasComponent(entity, 'FutureSettings'), false);
  assert.equal(object.ecsComponentsVersion, 99);
  assert.deepEqual(object.ecsComponents, futureData);
});

test('scene Component migration skips duplicate and invalid entries deterministically', () => {
  const ecs = createECS();
  ecs.registerComponent('UniqueSettings', {
    schema: { value: { type: 'integer', default: 0 } },
    additionalProperties: false
  });
  const object = {
    id: 'duplicate-schema', x: 0, y: 0,
    ecsComponents: [
      { type: 'UniqueSettings', data: { value: 5 } },
      { type: 'UniqueSettings', data: { value: 8 } },
      { type: 17, data: {} },
      null
    ]
  };
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject(object.id);
  assert.equal(ecs.getComponent(entity, 'UniqueSettings').value, 5);
  assert.equal(object.ecsComponentsVersion, 1);
});
