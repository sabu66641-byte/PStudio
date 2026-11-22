const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createInputRuntime(objects = [{ id: 'player', name: 'Player' }]) {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_input.js'), sandbox, { filename: 'pstudio_ecs_input.js' });
  const ecs = window.PStudioECS;
  const input = window.PStudioECSInput;
  ecs.syncSceneObjects(objects);
  return { ecs, input, objects, window };
}

test('InputSnapshot is an immutable, runtime-only per-frame ECS Component', () => {
  const { ecs, input } = createInputRuntime([]);
  const definition = ecs.getComponentDefinition('InputSnapshot');
  assert.equal(definition.internal, true);
  assert.equal(definition.persistent, false);

  const frame = input.captureFrame({
    keys: new Set(['D', 'ArrowUp', 'd']),
    pressed: new Set(['d']),
    virtualKeys: new Set([' ']),
    axisX: 0.25,
    axisZ: -0.5,
    touched: true,
    touchX: 120.5,
    touchY: 88.25
  });
  assert.equal(frame, 1);

  const snapshot = input.getSnapshot();
  assert.deepEqual(Array.from(snapshot.keys), ['d', 'arrowup']);
  assert.deepEqual(Array.from(snapshot.pressed), ['d']);
  assert.deepEqual(Array.from(snapshot.virtualKeys), [' ']);
  assert.equal(snapshot.axisX, 0.25);
  assert.equal(snapshot.axisZ, -0.5);
  assert.equal(snapshot.touched, true);
  assert.equal(snapshot.touchX, 120.5);
  assert.equal(snapshot.touchY, 88.25);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.keys), true);
  assert.throws(() => snapshot.keys.push('w'), TypeError);
});

test('Input System derives ControlIntent from keyboard, touch axes and jump edges', () => {
  const { ecs, input } = createInputRuntime();
  assert.equal(input.attachPlayerInput('player'), true);

  input.captureFrame({
    keys: ['d', 'w', ' '],
    pressed: [' '],
    axisX: 0.8,
    axisZ: -0.3
  });
  ecs.update(1 / 60);
  let intent = input.getControlIntent('player');
  assert.deepEqual(
    { x: intent.x, z: intent.z, jump: intent.jump, jumpPressed: intent.jumpPressed, active: intent.active, frame: intent.frame },
    { x: 1, z: -1, jump: true, jumpPressed: true, active: true, frame: 1 }
  );

  input.captureFrame({ keys: ['d', ' '], virtualKeys: [' '] });
  ecs.update(1 / 60);
  intent = input.getControlIntent('player');
  assert.equal(intent.x, 1);
  assert.equal(intent.jump, true);
  assert.equal(intent.jumpPressed, false, 'held virtual input must not be reported as a new press');
});

test('PlayerInput supports per-entity key mappings and can be disabled', () => {
  const { ecs, input } = createInputRuntime();
  assert.equal(input.attachPlayerInput('player', {
    leftKeys: ['j'], rightKeys: ['l'],
    forwardKeys: ['i'], backwardKeys: ['k'], jumpKeys: ['u']
  }), true);

  input.captureFrame({ keys: ['l', 'i', 'u'], pressed: ['u'] });
  ecs.update(1 / 60);
  let intent = input.getControlIntent('player');
  assert.deepEqual(
    { x: intent.x, z: intent.z, jump: intent.jump, jumpPressed: intent.jumpPressed },
    { x: 1, z: -1, jump: true, jumpPressed: true }
  );

  assert.equal(input.attachPlayerInput('player', { enabled: false }), true);
  input.captureFrame({ keys: ['l', 'k', 'u'], pressed: ['u'] });
  ecs.update(1 / 60);
  intent = input.getControlIntent('player');
  assert.equal(intent.x, 0);
  assert.equal(intent.z, 0);
  assert.equal(intent.jump, false);
  assert.equal(intent.active, false);
});

test('Legacy input queries read the same snapshot and reset releases stale input', () => {
  const { ecs, input } = createInputRuntime();
  input.captureFrame({
    keys: ['ArrowRight', 'Space'],
    pressed: ['Space'],
    virtualKeys: [' '],
    axisX: 0.4,
    touched: true,
    touchX: 17,
    touchY: 29
  });

  assert.equal(input.isKeyDown('right'), true);
  assert.equal(input.isKeyDown('space'), true);
  assert.equal(input.wasKeyPressed(' '), true);
  assert.equal(input.getAxis('horizontal'), 1);
  assert.equal(input.getAxis('vertical'), 0);
  assert.equal(input.isTouched(), true);
  assert.equal(input.getTouchX(), 17);
  assert.equal(input.getTouchY(), 29);

  assert.equal(input.reset(), true);
  const snapshot = input.getSnapshot();
  assert.deepEqual(Array.from(snapshot.keys), []);
  assert.deepEqual(Array.from(snapshot.pressed), []);
  assert.deepEqual(Array.from(snapshot.virtualKeys), []);
  assert.equal(snapshot.axisX, 0);
  assert.equal(snapshot.axisZ, 0);
  assert.equal(snapshot.touched, false);
  assert.equal(input.isKeyDown('space'), false);
  assert.equal(input.wasKeyPressed('space'), false);
  assert.equal(input.getAxis('horizontal'), 0);
});

test('PlayerInput attachment follows Scene Object lifetime and detaches cleanly', () => {
  const { ecs, input, objects } = createInputRuntime();
  assert.equal(input.attachPlayerInput('player'), true);
  assert.ok(input.getPlayerInput('player'));
  assert.ok(input.getControlIntent('player'));
  assert.equal(input.detachPlayerInput('player'), true);
  assert.equal(input.getPlayerInput('player'), null);
  assert.equal(input.getControlIntent('player'), null);

  assert.equal(input.attachPlayerInput('missing'), false);
  assert.equal(input.attachPlayerInput('player'), true);
  ecs.clearSceneObjects();
  assert.equal(input.getPlayerInput('player'), null);
  assert.equal(input.getControlIntent('player'), null);
  assert.deepEqual(objects.map(object => object.id), ['player']);
});
