const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = {
    window, console, Map, Set, Promise, Date, Number, Object, Array,
    TypeError, Error, JSON, Math, String, RegExp, Symbol
  };
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs.js', 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs_script.js', 'utf8'), sandbox);
  return window;
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Script runtime Components are internal, transient and registered with explicit schemas', () => {
  const window = setup();
  const ecs = window.PStudioECS;

  for (const type of ['ScriptState', 'ScriptLifecycle', 'ScriptSystemState']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, false);
    assert.equal(definition.internal, true);
    assert.equal(definition.source, 'pstudio_ecs_script');
  }
  assert.deepEqual(window.PStudioECSScript.componentTypes, [
    'ScriptState', 'ScriptLifecycle', 'ScriptSystemState'
  ]);
});

test('Scene Object variables are ECS-owned and isolated per Entity', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;
  const objects = [{ id: 'hero' }, { id: 'enemy' }];

  ecs.syncSceneObjects(objects);
  assert.equal(script.sync(objects), 2);

  const hero = ecs.getEntityForSceneObject('hero');
  const enemy = ecs.getEntityForSceneObject('enemy');
  assert.ok(ecs.hasComponent(hero, 'ScriptState'));
  assert.ok(ecs.hasComponent(hero, 'ScriptLifecycle'));

  assert.equal(script.setVariables('hero', {
    hp: 100,
    inventory: ['key'],
    nested: { count: 2 }
  }), true);
  assert.equal(script.setVariables('enemy', { hp: 35 }), true);

  const variables = script.getVariables('hero');
  variables.hp -= 10;
  variables.nested.count += 1;

  assert.equal(script.getVariables('hero').hp, 90);
  assert.equal(script.getVariables('hero').nested.count, 3);
  assert.equal(script.getVariables('enemy').hp, 35);
  assert.equal(script.getVariablesByEntity(hero).hp, 90);
  assert.equal(script.getVariablesByEntity(enemy).hp, 35);
});

test('ScriptLifecycle preserves initialization, start and per-Entity landing sequence', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;
  const objects = [{ id: 'npc' }];

  ecs.syncSceneObjects(objects);
  script.sync(objects);

  const lifecycle = script.getLifecycle('npc');
  assert.deepEqual(snapshot(lifecycle), {
    initialized: false,
    started: false,
    landSequence: 0
  });

  assert.equal(script.setLifecycle('npc', {
    initialized: true,
    started: true,
    landSequence: 7
  }), true);
  assert.deepEqual(snapshot(script.getLifecycle('npc')), {
    initialized: true,
    started: true,
    landSequence: 7
  });
});

test('ScriptSystemState is partitioned by Entity and System ID', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;

  ecs.registerComponent('Mover', {
    source: 'test',
    schema: { speed: { type: 'number', default: 1 } },
    additionalProperties: false
  });

  const hero = ecs.createEntity({ Mover: { speed: 2 } });
  const enemy = ecs.createEntity({ Mover: { speed: 3 } });
  script.setSystemDefinitions([{ id: 'ps.mover', components: ['Mover'] }]);

  assert.ok(ecs.hasComponent(hero, 'ScriptSystemState'));
  assert.ok(ecs.hasComponent(enemy, 'ScriptSystemState'));

  assert.equal(script.setSystemState(hero, 'ps.mover', { ticks: 1 }), true);
  assert.equal(script.setSystemState(hero, 'ps.other', { score: 4 }), true);
  assert.equal(script.setSystemState(enemy, 'ps.mover', { ticks: 8 }), true);

  assert.deepEqual(snapshot(script.getSystemState(hero, 'ps.mover')), { ticks: 1 });
  assert.deepEqual(snapshot(script.getSystemState(hero, 'ps.other')), { score: 4 });
  assert.deepEqual(snapshot(script.getSystemState(enemy, 'ps.mover')), { ticks: 8 });
  assert.equal(script.getVariablesByEntity(hero), null);
});

test('new Entities and new Component assignments receive ScriptSystemState before scheduling', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;

  ecs.registerComponent('Mover', {
    source: 'test',
    schema: { speed: { type: 'number', default: 1 } },
    additionalProperties: false
  });

  script.setSystemDefinitions([{ id: 'ps.mover', components: ['Mover'] }]);

  const createdWithComponent = ecs.createEntity({ Mover: { speed: 2 } });
  assert.ok(ecs.hasComponent(createdWithComponent, 'ScriptSystemState'));

  const createdEmpty = ecs.createEntity();
  assert.equal(ecs.hasComponent(createdEmpty, 'ScriptSystemState'), false);
  ecs.addComponent(createdEmpty, 'Mover', { speed: 3 });
  assert.ok(ecs.hasComponent(createdEmpty, 'ScriptSystemState'));
});

test('System callbacks can update ScriptSystemState without structural ECS mutation', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;

  ecs.registerComponent('Mover', {
    source: 'test',
    schema: { speed: { type: 'number', default: 1 } },
    additionalProperties: false
  });

  const entity = ecs.createEntity({ Mover: { speed: 2 } });
  script.setSystemDefinitions([{ id: 'ps.mover', components: ['Mover'] }]);

  ecs.registerSystem({
    id: 'test.scriptlocals',
    components: ['Mover'],
    update: (dt, api) => {
      api.forEach(['Mover'], id => {
        const locals = script.getSystemStateByEntity(id, 'ps.mover') || Object.create(null);
        locals.ticks = (locals.ticks || 0) + 1;
        assert.equal(script.setSystemStateByEntity(id, 'ps.mover', locals), true);
      });
    }
  });

  assert.doesNotThrow(() => ecs.update(1 / 60));
  assert.deepEqual(snapshot(script.getSystemState(entity, 'ps.mover')), { ticks: 1 });
});

test('clear removes only transient Script Components, including on inactive Entities', () => {
  const window = setup();
  const ecs = window.PStudioECS;
  const script = window.PStudioECSScript;

  ecs.registerComponent('Mover', {
    source: 'test',
    schema: { speed: { type: 'number', default: 1 } },
    additionalProperties: false
  });

  const entity = ecs.createEntity({ Mover: { speed: 2 } });
  script.setSystemDefinitions([{ id: 'ps.mover', components: ['Mover'] }]);
  assert.ok(ecs.hasComponent(entity, 'ScriptSystemState'));
  ecs.setEntityActive(entity, false);

  assert.equal(script.clear(), true);
  assert.equal(ecs.hasComponent(entity, 'ScriptSystemState'), false);
  assert.equal(ecs.hasComponent(entity, 'Mover'), true);
});
