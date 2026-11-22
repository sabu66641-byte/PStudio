const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createCollisionRuntime(objects = [
  { id: 'zeta', name: 'Zeta' },
  { id: 'alpha', name: 'Alpha' }
]) {
  const notifications = [];
  const window = {
    PStudioEvents: {
      emit(type, payload) { notifications.push({ type, payload }); }
    }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_collision.js'), sandbox, { filename: 'pstudio_ecs_collision.js' });
  const ecs = window.PStudioECS;
  const collision = window.PStudioECSCollision;
  ecs.syncSceneObjects(objects);
  return { ecs, collision, objects, notifications, window };
}

test('CollisionEvent is runtime-only ECS data and emits enter/stay/exit notifications', () => {
  const { ecs, collision, notifications } = createCollisionRuntime();
  const definition = ecs.getComponentDefinition('CollisionEvent');
  assert.equal(definition.internal, true);
  assert.equal(definition.persistent, false);

  collision.beginFrame();
  assert.equal(collision.observePair('2d', { id: 'zeta', name: 'Zeta' }, { id: 'alpha', name: 'Alpha' }), true);
  assert.equal(collision.observePair('2d', { id: 'alpha' }, { id: 'zeta' }), true);
  assert.equal(collision.commitContacts(), 1);
  assert.equal(notifications.filter(item => item.type === 'collision.enter').length, 1);
  assert.equal(ecs.query(['CollisionEvent']).length, 1);

  let event = ecs.getComponent(ecs.query(['CollisionEvent'])[0], 'CollisionEvent');
  assert.equal(event.objectAId, 'alpha');
  assert.equal(event.objectBId, 'zeta');
  assert.equal(event.nameA, 'Alpha');
  assert.equal(event.nameB, 'Zeta');
  assert.equal(event.phase, 'enter');
  assert.equal(event.dimension, '2d');
  const enterEntity = ecs.query(['CollisionEvent'])[0];
  collision.endFrame();

  collision.beginFrame();
  collision.observePair('2d', { id: 'alpha' }, { id: 'zeta' });
  assert.equal(collision.commitContacts(), 1);
  assert.equal(notifications.filter(item => item.type === 'collision.stay').length, 1);
  collision.endFrame();
  assert.equal(ecs.query(['CollisionEvent']).includes(enterEntity), false);

  collision.beginFrame();
  assert.equal(collision.commitContacts(), 1);
  assert.equal(notifications.filter(item => item.type === 'collision.exit').length, 1);
  event = ecs.getComponent(ecs.query(['CollisionEvent'])[0], 'CollisionEvent');
  assert.equal(event.phase, 'exit');
  assert.equal(event.frame, 3);
  collision.endFrame();

  collision.beginFrame();
  assert.equal(collision.commitContacts(), 0);
  collision.endFrame();
  assert.equal(ecs.query(['CollisionEvent']).length, 0);
});

test('Collision events distinguish 2D, 3D and Physics contacts for the same object pair', () => {
  const { ecs, collision, notifications } = createCollisionRuntime();
  collision.beginFrame();
  collision.observePair('2d', 'alpha', 'zeta');
  collision.observePair('3d', 'alpha', 'zeta');
  collision.observePair('physics', 'alpha', 'zeta');
  assert.equal(collision.commitContacts(), 3);
  assert.equal(ecs.query(['CollisionEvent']).length, 3);
  assert.deepEqual(
    Array.from(ecs.query(['CollisionEvent']), entity => ecs.getComponent(entity, 'CollisionEvent').dimension).sort(),
    ['2d', '3d', 'physics']
  );
  assert.equal(notifications.filter(item => item.type === 'collision.enter').length, 3);
  collision.clear();
  assert.equal(ecs.query(['CollisionEvent']).length, 0);
  assert.equal(collision.getState().activePairCount, 0);
});

test('Collision event Entities remain available for one complete ECS frame and clear on Stop', () => {
  const { ecs, collision } = createCollisionRuntime();
  collision.beginFrame();
  collision.observePair('3d', 'alpha', 'zeta');
  collision.commitContacts();
  collision.endFrame();
  const firstFrameEntity = ecs.query(['CollisionEvent'])[0];
  assert.ok(firstFrameEntity);

  // The previous frame event remains queryable while this frame's Systems run.
  collision.beginFrame();
  assert.equal(ecs.query(['CollisionEvent']).includes(firstFrameEntity), true);
  collision.commitContacts();
  collision.endFrame();
  assert.equal(ecs.query(['CollisionEvent']).includes(firstFrameEntity), false);

  collision.clear();
  assert.equal(ecs.query(['CollisionEvent']).length, 0);
  assert.equal(collision.getState().activePairCount, 0);
});
