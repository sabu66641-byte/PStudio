const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createECS() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = { window, console, Map, Set, Promise, Date, Number, Object, Array, TypeError, Error, Math };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox);
  return window.PStudioECS;
}

test('saved Components restore when their type is registered after the first Scene sync', () => {
  const ecs = createECS();
  const objects = [{
    id: 'late',
    ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'LateBound', data: { value: 7 } }]
  }];
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('late');
  assert.equal(ecs.hasComponent(entity, 'LateBound'), false);

  ecs.registerComponent('LateBound', {
    persistent: true,
    schema: { value: { type: 'integer', default: 0 } }
  });
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.getComponent(entity, 'LateBound').value, 7);
});

test('in-place Component type changes with stable array identity are detected', () => {
  const ecs = createECS();
  const objects = [{
    id: 'mutable',
    ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'FirstType', data: { value: 1 } }]
  }];
  ecs.registerComponent('FirstType', { persistent: true, schema: { value: { type: 'integer', default: 0 } } });
  ecs.registerComponent('SecondType', { persistent: true, schema: { value: { type: 'integer', default: 0 } } });
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('mutable');
  const payloadReference = objects[0].ecsComponents;
  objects[0].ecsComponents[0].type = 'SecondType';
  objects[0].ecsComponents[0].data.value = 9;
  ecs.syncSceneObjects(objects);
  assert.equal(objects[0].ecsComponents, payloadReference);
  assert.equal(ecs.getComponent(entity, 'SecondType').value, 9);
});

test('externally destroyed Scene Entities are replaced without stale mappings', () => {
  const ecs = createECS();
  const objects = [{ id: 'replace-me', x: 1, y: 2, z: 0 }];
  ecs.syncSceneObjects(objects);
  const previous = ecs.getEntityForSceneObject('replace-me');
  assert.equal(ecs.destroyEntity(previous), true);
  ecs.syncSceneObjects(objects);
  const current = ecs.getEntityForSceneObject('replace-me');
  assert.ok(current);
  assert.notEqual(current, previous);
  assert.equal(ecs.getComponent(current, 'Transform').x, 1);
  assert.equal(ecs.stats().entityCount, 1);
});

test('large Scene synchronization stress preserves transforms and Entity cardinality', () => {
  const ecs = createECS();
  const objects = Array.from({ length: 500 }, (_, index) => ({
    id: 'object-' + index, x: index, y: index % 13, z: 0
  }));
  for (let frame = 0; frame < 80; frame++) {
    if (frame % 2 === 0) objects[frame % objects.length].x += 1;
    ecs.syncSceneObjects(objects);
    ecs.update(1 / 60);
    ecs.applySceneObjectTransforms(objects);
  }
  assert.equal(ecs.stats().entityCount, 500);
  const last = ecs.getEntityForSceneObject('object-499');
  assert.equal(ecs.getComponent(last, 'Transform').x, 499);
  objects.splice(10, 100);
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.stats().entityCount, 400);
  assert.equal(ecs.getEntityForSceneObject('object-10'), null);
});
