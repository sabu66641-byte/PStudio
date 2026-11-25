const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRuntime() {
  const window = {
    dispatchEvent() {},
    CustomEvent: undefined
  };
  const sandbox = { window, console, Date, Math, Map, Set, WeakMap, Number, Object, Array, String, Boolean, TypeError, Error, Promise };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_time.js'), sandbox, { filename: 'pstudio_ecs_time.js' });
  return { ecs: window.PStudioECS, time: window.PStudioECSTime };
}

test('TimeState is a hidden runtime-only ECS Component', () => {
  const { ecs, time } = createRuntime();
  const definition = ecs.getComponentDefinition('TimeState');
  assert.equal(definition.persistent, false);
  assert.equal(definition.internal, true);
  assert.equal(time.componentType, 'TimeState');
  assert.equal(ecs.getComponentTypes().includes('TimeState'), true);
  assert.equal(time.getState().timeScale, 1);
});

test('TimeState preserves default and scaled frame-time semantics', () => {
  const { time } = createRuntime();
  time.start();
  assert.equal(time.beginFrame(0.04), 0.04);
  assert.deepEqual({ ...time.getState() }, {
    timeScale: 1,
    deltaTime: 0.04,
    unscaledDeltaTime: 0.04,
    elapsedTime: 0.04,
    unscaledElapsedTime: 0.04,
    frame: 1
  });

  assert.equal(time.setTimeScale(2), 2);
  assert.equal(time.beginFrame(0.04), 0.08);
  assert.equal(time.getState().elapsedTime, 0.12);
  assert.equal(time.getState().unscaledElapsedTime, 0.08);
  assert.equal(time.getState().frame, 2);
});

test('TimeState clamps scaled delta and time scale without stopping wall-clock tracking', () => {
  const { time } = createRuntime();
  time.start();
  assert.equal(time.setTimeScale(99), 4);
  assert.equal(time.beginFrame(0.5), 0.1);
  assert.equal(time.setTimeScale(-5), 0);
  assert.equal(time.beginFrame(0.05), 0);
  const state = time.getState();
  assert.equal(state.deltaTime, 0);
  assert.equal(state.unscaledDeltaTime, 0.05);
  assert.equal(state.elapsedTime, 0.1);
  assert.equal(state.unscaledElapsedTime, 0.55);
  assert.equal(state.frame, 2);
});

test('TimeState resets at Play and removes its singleton Entity at Stop', () => {
  const { ecs, time } = createRuntime();
  const before = ecs.stats().entityCount;
  time.start();
  time.setTimeScale(3);
  time.beginFrame(0.02);
  const reset = time.start();
  assert.equal(reset.timeScale, 1);
  assert.equal(reset.elapsedTime, 0);
  assert.equal(reset.frame, 0);
  assert.equal(time.clear(), true);
  assert.equal(time.clear(), false);
  assert.equal(ecs.stats().entityCount, before);
});

test('the game runtime reads and writes time scale through the ECS time bridge', () => {
  const engine = read('static/pstudio_engine.js');
  assert.match(engine, /PStudioECSTime\.setTimeScale\(a\[0\]\)/);
  assert.match(engine, /PStudioECSTime\.beginFrame\(raw\)/);
  assert.match(engine, /PStudioECSTime\.start\(\)/);
  assert.match(engine, /PStudioECSTime\?\.clear\?\.\(\)/);
  assert.doesNotMatch(engine, /runtime\.timeScale/);
});
