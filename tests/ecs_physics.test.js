const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRuntimeModules() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    TypeError, Error, Promise
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_physics.js'), sandbox, { filename: 'pstudio_physics.js' });
  vm.runInNewContext(read('static/pstudio_ecs_physics.js'), sandbox, { filename: 'pstudio_ecs_physics.js' });
  return { ecs: window.PStudioECS, physics: window.PStudioPhysics, window };
}

test('ECS Physics bridge registers typed Velocity, PhysicsBody, PhysicsState and PhysicsTransform Components', () => {
  const { ecs, window } = createRuntimeModules();
  assert.ok(window.PStudioECSPhysics);
  for (const type of ['Velocity', 'PhysicsBody', 'PhysicsState', 'PhysicsTransform']) {
    assert.equal(ecs.hasComponentType(type), true);
    assert.ok(ecs.getComponentDefinition(type).schema);
  }
  assert.equal(ecs.getComponentDefinition('PhysicsState').readonly, true);
  assert.equal(ecs.getComponentDefinition('PhysicsState').persistent, false);
  assert.equal(ecs.getComponentDefinition('PhysicsTransform').readonly, true);
  assert.equal(ecs.getComponentDefinition('PhysicsBody').schema.radius.min, 0.05);
});

test('PhysicsBody Component creates a Physics body and mirrors world state back to ECS', () => {
  const { ecs, physics } = createRuntimeModules();
  const objects = [{ id: 'player', name: 'Player', x: 160, y: 240, z: 0 }];
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('player');
  ecs.addComponent(entity, 'PhysicsBody', {
    positionX: 2,
    positionY: 4,
    positionZ: -3,
    gravityY: -9.81,
    radius: 0.4,
    height: 1.8,
    mass: 2
  });

  ecs.updatePhase('prePhysics', 1 / 60, { sceneObjects: objects });
  const initial = physics.getBodyState('player');
  assert.ok(initial);
  assert.equal(initial.x, 2);
  assert.equal(initial.y, 4);
  assert.equal(initial.z, -3);

  physics.beginFrame();
  const physicsTransforms = physics.step(1 / 60, new Map());
  ecs.updatePhase('postPhysics', 1 / 60, { sceneObjects: objects, physicsTransforms });
  const physicsTransform = ecs.getComponent(entity, 'PhysicsTransform');
  const physicsState = ecs.getComponent(entity, 'PhysicsState');
  const after = physics.getBodyState('player');
  assert.equal(physicsTransform.x, after.x);
  assert.equal(physicsTransform.y, after.y);
  assert.equal(physicsTransform.z, after.z);
  assert.equal(physicsState.grounded, after.grounded);
  assert.equal(physicsState.controlled, false);
  assert.ok(physicsState.velocityY < 0);
  assert.ok(after.y < 4);
});

test('removing PhysicsBody disposes its underlying Physics body without deleting Scene Object identity', () => {
  const { ecs, physics } = createRuntimeModules();
  ecs.syncSceneObjects([{ id: 'enemy', name: 'Enemy', x: 0, y: 0, z: 0 }]);
  const entity = ecs.getEntityForSceneObject('enemy');
  ecs.addComponent(entity, 'PhysicsBody', {});
  ecs.updatePhase('prePhysics', 1 / 60);
  assert.ok(physics.getBody('enemy'));
  assert.equal(ecs.removeComponent(entity, 'PhysicsBody'), true);
  assert.equal(physics.getBody('enemy'), null);
  assert.equal(ecs.getEntityForSceneObject('enemy'), entity);
});

test('Velocity System integrates only non-Physics entities through their ECS Transform', () => {
  const { ecs } = createRuntimeModules();
  const moving = ecs.createEntity({
    Transform: { x: 1, y: 0, z: 0 },
    Velocity: { x: 4, y: 0, z: -2 }
  });
  const physicsDriven = ecs.createEntity({
    Transform: { x: 10, y: 0, z: 0 },
    Velocity: { x: 4, y: 0, z: 0 },
    PhysicsBody: {}
  });
  ecs.update(0.5);
  assert.equal(ecs.getComponent(moving, 'Transform').x, 3);
  assert.equal(ecs.getComponent(moving, 'Transform').z, -1);
  assert.equal(ecs.getComponent(physicsDriven, 'Transform').x, 10);
});

test('runtime executes prePhysics ECS phase before the Physics step and postPhysics after it', () => {
  const engine = read('static/pstudio_engine.js');
  const pre = engine.indexOf("updatePhase?.('prePhysics'");
  const step = engine.indexOf('PStudioPhysics?.step');
  const post = engine.indexOf("updatePhase?.('postPhysics'");
  assert.ok(pre >= 0 && step > pre && post > step);
  assert.ok(engine.includes('ecsAfterPhysics.applySceneObjectTransforms(sceneObjects || [])'));
  assert.ok(engine.includes('ecs.applySceneObjectTransforms(sceneObjects || [])'));
});

test('ECS Physics and typed Inspector scripts load after their owning core modules', () => {
  const html = read('templates/index.html');
  const ecsCore = html.indexOf('<script src="/static/pstudio_ecs.js"></script>');
  const physicsBridge = html.indexOf('<script src="/static/pstudio_ecs_physics.js"></script>');
  const inspector = html.indexOf('<script src="/static/pstudio_ecs_inspector.js"></script>');
  assert.ok(ecsCore >= 0);
  assert.ok(physicsBridge > ecsCore);
  assert.ok(inspector > physicsBridge);
  assert.doesNotThrow(() => new vm.Script(read('static/pstudio_ecs_inspector.js')));
});


test('disabled PhysicsBody does not require a body before Play and re-enables safely', () => {
  const { ecs, physics } = createRuntimeModules();
  ecs.syncSceneObjects([{ id: 'switchable', name: 'Switchable', x: 0, y: 0, z: 0 }]);
  const entity = ecs.getEntityForSceneObject('switchable');
  ecs.addComponent(entity, 'PhysicsBody', { enabled: false });
  ecs.updatePhase('prePhysics', 1 / 60);
  assert.equal(physics.getBody('switchable'), null);
  assert.equal(ecs.getComponent(entity, 'PhysicsState').active, false);

  const configuration = ecs.getComponent(entity, 'PhysicsBody');
  ecs.setComponent(entity, 'PhysicsBody', { ...configuration, enabled: true });
  ecs.updatePhase('prePhysics', 1 / 60);
  assert.ok(physics.getBody('switchable'));
  ecs.removeComponent(entity, 'PhysicsBody');
  assert.equal(physics.getBody('switchable'), null);
  assert.equal(ecs.hasComponent(entity, 'PhysicsState'), false);
  assert.equal(ecs.hasComponent(entity, 'PhysicsTransform'), false);
});
