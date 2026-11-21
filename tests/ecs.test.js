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


test('exposes Entity, Component and System introspection and updates system priority', () => {
  const ecs = createECS();
  const first = ecs.createEntity({ Transform: { x: 2 } });
  const second = ecs.createEntity();
  assert.deepEqual(Array.from(ecs.getEntities()), [first, second]);
  assert.deepEqual(Array.from(ecs.getEntityComponents(first), item => item.type), ['Transform']);
  assert.ok(Array.from(ecs.getComponentTypes()).includes('SceneObjectRef'));

  const order = [];
  ecs.registerSystem({ id: 'test.priority-a', priority: 10, update() { order.push('a'); } });
  ecs.registerSystem({ id: 'test.priority-b', priority: 0, update() { order.push('b'); } });
  assert.deepEqual(ecs.getSystems().map(system => system.id), ['test.priority-b', 'test.priority-a']);
  assert.equal(ecs.setSystemPriority('test.priority-a', -5), -5);
  assert.deepEqual(ecs.getSystems().map(system => system.id), ['test.priority-a', 'test.priority-b']);
  ecs.update(0.016);
  assert.deepEqual(order, ['a', 'b']);
  assert.throws(() => ecs.setSystemPriority('test.priority-a', 'invalid'), /finite number/);
});

test('restores serialized custom Components when Scene Objects are synchronized', () => {
  const ecs = createECS();
  const object = {
    id: 'saved-object',
    name: 'Saved Object',
    x: 1,
    ecsComponents: [
      { type: 'Velocity', data: { x: 3, y: 4, z: 5 } },
      { type: 'Health', data: { current: 80, maximum: 100 } }
    ]
  };
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject('saved-object');
  assert.ok(entity);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ecs.getComponent(entity, 'Velocity'))),
    { x: 3, y: 4, z: 5 }
  );
  assert.equal(ecs.getComponent(entity, 'Health').current, 80);
  assert.ok(ecs.getComponentTypes().includes('Velocity'));
});


test('ECS Inspector module syntax is valid and loads after the ECS core', () => {
  const inspector = fs.readFileSync('static/pstudio_ecs_inspector.js', 'utf8');
  const html = fs.readFileSync('templates/index.html', 'utf8');
  assert.doesNotThrow(() => new vm.Script(inspector));
  const coreTag = html.indexOf('<script src="/static/pstudio_ecs.js"></script>');
  const inspectorTag = html.indexOf('<script src="/static/pstudio_ecs_inspector.js"></script>');
  assert.ok(coreTag >= 0, 'ECS core script tag must exist');
  assert.ok(inspectorTag > coreTag, 'ECS Inspector must load after ECS core');
});
