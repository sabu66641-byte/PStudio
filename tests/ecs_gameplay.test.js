const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function loadModules({ withECS = true } = {}) {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    TypeError, Error, Promise
  };
  if (withECS) {
    vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
    vm.runInNewContext(read('static/pstudio_ecs_gameplay.js'), sandbox, { filename: 'pstudio_ecs_gameplay.js' });
  }
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  return { ecs: window.PStudioECS, gameplay: window.PStudioGameplay, bridge: window.PStudioECSGameplay, window };
}

test('Health is registered as an internal, runtime-only typed ECS Component', () => {
  const { ecs, bridge } = loadModules();
  assert.ok(bridge);
  assert.equal(bridge.initialize([]), true);
  const definition = ecs.getComponentDefinition('Health');
  assert.equal(definition.source, 'pstudio_ecs_gameplay');
  assert.equal(definition.internal, true);
  assert.equal(definition.persistent, false);
  assert.deepEqual(Object.keys(definition.schema).sort(), ['configured', 'hp', 'max']);
});

test('legacy Gameplay health APIs read and mutate ECS Health during Play', () => {
  const { ecs, gameplay, bridge } = loadModules();
  const objects = [{ id: 'player', name: 'Player', x: 0, y: 0, z: 0 }];
  ecs.syncSceneObjects(objects);
  assert.equal(bridge.initialize(objects), true);
  const entity = ecs.getEntityForSceneObject('player');
  assert.ok(ecs.hasComponent(entity, 'Health'));

  assert.equal(gameplay.getHP('player'), 100);
  assert.equal(gameplay.setMaxHP('player', 180), 180);
  assert.equal(gameplay.setHP('player', 125), 125);
  assert.equal(gameplay.damage('player', 25), 100);
  assert.equal(gameplay.heal('player', 10), 110);
  assert.equal(gameplay.getMaxHP('player'), 180);
  assert.equal(gameplay.isAlive('player'), true);
  assert.equal(ecs.getComponent(entity, 'Health').hp, 110);
});

test('Health state survives Stop/Play through a compatibility snapshot without remaining duplicated at runtime', () => {
  const { ecs, gameplay, bridge } = loadModules();
  const objects = [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }];
  const legacySnapshot = new Map();
  ecs.syncSceneObjects(objects);
  bridge.initialize(objects, id => legacySnapshot.get(id));
  gameplay.setMaxHP('hero', 240);
  gameplay.setHP('hero', 73);

  assert.equal(bridge.persist(objects, (id, value) => legacySnapshot.set(id, value)), true);
  assert.deepEqual(legacySnapshot.get('hero'), { max: 240, hp: 73, configured: true });

  ecs.clearSceneObjects();
  ecs.syncSceneObjects(objects);
  bridge.initialize(objects, id => legacySnapshot.get(id));
  assert.equal(gameplay.getHP('hero'), 73);
  assert.equal(gameplay.getMaxHP('hero'), 240);
});

test('Gameplay health API remains operational when ECS is unavailable', () => {
  const { gameplay } = loadModules({ withECS: false });
  assert.equal(gameplay.getHP('legacy-object'), 100);
  assert.equal(gameplay.damage('legacy-object', 30), 70);
  assert.equal(gameplay.heal('legacy-object', 5), 75);
});

test('runtime initializes ECS Gameplay after scene entities exist and snapshots Health before clearing them', () => {
  const engine = read('static/pstudio_engine.js');
  const start = engine.indexOf('registerEcsRuntime(data.scripts);');
  const initialize = engine.indexOf('window.PStudioGameplay?.initializeECS?.(sceneObjects || []);', start);
  const cleanup = engine.indexOf('window.PStudioGameplay?.persistECS?.(sceneObjects || []);');
  const clear = engine.indexOf('ecs.clearSceneObjects?.();', cleanup);
  assert.ok(start >= 0 && initialize > start);
  assert.ok(cleanup >= 0 && clear > cleanup);
});

test('ECS Gameplay bridge loads after ECS core and before the Inspector', () => {
  const html = read('templates/index.html');
  const ecsCore = html.indexOf('<script src="/static/pstudio_ecs.js"></script>');
  const bridge = html.indexOf('<script src="/static/pstudio_ecs_gameplay.js"></script>');
  const inspector = html.indexOf('<script src="/static/pstudio_ecs_inspector.js"></script>');
  assert.ok(ecsCore >= 0 && bridge > ecsCore && inspector > bridge);
  assert.doesNotThrow(() => new vm.Script(read('static/pstudio_ecs_gameplay.js')));
  assert.doesNotThrow(() => new vm.Script(read('static/pstudio_gameplay.js')));
});
