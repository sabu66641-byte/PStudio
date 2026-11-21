const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRuntime() {
  const positions = new Map();
  const window = {
    dispatchEvent() {},
    CustomEvent: undefined,
    PStudioPhysics: {
      getPosition(id) { return positions.get(String(id)) || { x: 0, y: 0, z: 0 }; },
      getBody(id) { return { id: String(id) }; },
      configureController() {},
      moveCharacter() {}
    }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_gameplay.js'), sandbox, { filename: 'pstudio_ecs_gameplay.js' });
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  return { ecs: window.PStudioECS, gameplay: window.PStudioGameplay, bridge: window.PStudioECSGameplay, window, positions };
}

function scene(runtime, objects) {
  runtime.ecs.syncSceneObjects(objects);
  return objects;
}

test('registers typed gameplay Components and keeps runtime-only world state internal', () => {
  const { ecs } = createRuntime();
  for (const type of ['Health', 'Inventory', 'Equipment', 'AIState', 'CombatState', 'Quest', 'NavigationNode', 'GameplayWorld', 'ScriptState', 'ScriptLifecycle', 'ScriptSystemState', 'LocomotionState']) {
    assert.equal(ecs.hasComponentType(type), true, type);
    assert.ok(ecs.getComponentDefinition(type).schema, type);
  }
  assert.equal(ecs.getComponentDefinition('Health').category, 'Gameplay');
  assert.equal(ecs.getComponentDefinition('Quest').persistent, false);
  assert.equal(ecs.getComponentDefinition('NavigationNode').internal, true);
  assert.equal(ecs.getComponentDefinition('GameplayWorld').persistent, false);
});

test('ps runtime locals and lifecycle flags have per-Entity ECS ownership', () => {
  const runtime = createRuntime();
  scene(runtime, [{ id: 'npc', name: 'NPC', x: 0, y: 0, z: 0 }]);
  const entity = runtime.ecs.getEntityForSceneObject('npc');
  runtime.bridge.ensureSceneComponent('npc', 'ScriptState', { values: { counter: 4 } });
  runtime.bridge.ensureSceneComponent('npc', 'ScriptLifecycle', { initialized: true, started: false });
  runtime.bridge.ensureSceneComponent('npc', 'LocomotionState', { landSequence: 7 });
  const script = runtime.bridge.getSceneComponent('npc', 'ScriptState');
  const lifecycle = runtime.bridge.getSceneComponent('npc', 'ScriptLifecycle');
  const locomotion = runtime.bridge.getSceneComponent('npc', 'LocomotionState');
  assert.equal(script.values.counter, 4);
  assert.equal(lifecycle.initialized, true);
  assert.equal(lifecycle.started, false);
  assert.equal(locomotion.landSequence, 7);
  runtime.ecs.addComponent(entity, 'ScriptSystemState', { values: { 'ps.test': { localCounter: 9 } } });
  assert.equal(runtime.ecs.getComponent(entity, 'ScriptSystemState').values['ps.test'].localCounter, 9);
  for (const type of ['ScriptState', 'ScriptLifecycle', 'ScriptSystemState', 'LocomotionState']) {
    assert.equal(runtime.ecs.getComponentDefinition(type).persistent, false);
    assert.equal(runtime.ecs.getComponentDefinition(type).internal, true);
  }
});

test('Health API is backed by a Scene Object Health Component', () => {
  const runtime = createRuntime();
  scene(runtime, [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }]);
  assert.equal(runtime.gameplay.setMaxHP('hero', 150), 150);
  assert.equal(runtime.gameplay.setHP('hero', 75), 75);
  assert.equal(runtime.gameplay.damage('hero', 20), 55);
  assert.equal(runtime.gameplay.heal('hero', 10), 65);
  const entity = runtime.ecs.getEntityForSceneObject('hero');
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.ecs.getComponent(entity, 'Health'))),
    { max: 150, hp: 65, configured: true }
  );
});

test('Inventory and Equipment APIs persist their data in typed Entity Components', () => {
  const runtime = createRuntime();
  scene(runtime, [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }]);
  runtime.gameplay.defineItem('Potion', 'consumable', 'heal', 25);
  runtime.gameplay.defineItem('Sword', 'equipment', 'main', 0);
  runtime.gameplay.setHP('hero', 40);
  assert.equal(runtime.gameplay.inventoryAdd('hero', 'Potion', 2), 2);
  assert.equal(runtime.gameplay.inventoryAdd('hero', 'Sword', 1), 1);
  assert.equal(runtime.gameplay.equipItem('hero', 'Sword'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.gameplay.getEquipment('hero'))), [{ slot: 'main', item: 'Sword' }]);
  assert.equal(runtime.gameplay.useItem('hero', 'Potion'), true);
  assert.equal(runtime.gameplay.getHP('hero'), 65);
  assert.equal(runtime.gameplay.inventoryCount('hero', 'Potion'), 1);
  const entity = runtime.ecs.getEntityForSceneObject('hero');
  assert.equal(runtime.ecs.hasComponent(entity, 'Inventory'), true);
  assert.equal(runtime.ecs.hasComponent(entity, 'Equipment'), true);
});

test('attack cooldowns and weapon combo state are owned by CombatState', () => {
  const runtime = createRuntime();
  const objects = scene(runtime, [
    { id: 'hero', name: 'Hero', x: 0, y: 0, z: 0, rotationY: 0 },
    { id: 'enemy', name: 'Enemy', x: 0, y: 0, z: 1 }
  ]);
  runtime.positions.set('hero', { x: 0, y: 0, z: 0 });
  runtime.positions.set('enemy', { x: 0, y: 0, z: 1 });
  assert.equal(runtime.gameplay.attack('hero', 2, 10, objects, runtime.window.PStudioPhysics, 1000), 1);
  assert.equal(runtime.gameplay.attack('hero', 2, 10, objects, runtime.window.PStudioPhysics, 1000), 0);
  const heroEntity = runtime.ecs.getEntityForSceneObject('hero');
  const cooldowns = runtime.ecs.getComponent(heroEntity, 'CombatState').cooldowns;
  assert.ok(cooldowns.enemy > 0);
  runtime.gameplay.defineWeapon('Sword', 3, 180, 1);
  assert.equal(runtime.gameplay.weaponAttack('hero', 'Sword', 3, 5, 1100, objects, runtime.window.PStudioPhysics), 1);
  assert.equal(runtime.gameplay.comboCount('hero'), 1);
  assert.equal(runtime.ecs.getComponent(heroEntity, 'CombatState').comboWeapon, 'Sword');
});

test('enemy AI state is stored on the controlling Scene Object Entity', () => {
  const runtime = createRuntime();
  const objects = scene(runtime, [
    { id: 'enemy', name: 'Enemy', x: 0, y: 0, z: 0 },
    { id: 'player', name: 'Player', x: 0, y: 0, z: 0 }
  ]);
  runtime.positions.set('enemy', { x: 0, y: 0, z: 0 });
  runtime.positions.set('player', { x: 0, y: 0, z: 4 });
  assert.equal(runtime.gameplay.enemyAI('enemy', 'player', 10, 1, 2, objects, runtime.window.PStudioPhysics), 'chase');
  assert.equal(runtime.gameplay.getAIState('enemy'), 'chase');
  const entity = runtime.ecs.getEntityForSceneObject('enemy');
  assert.equal(runtime.ecs.getComponent(entity, 'AIState').state, 'chase');
});

test('quest definitions, progress and rewards are stored as Quest Entities', () => {
  const runtime = createRuntime();
  scene(runtime, [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }]);
  runtime.gameplay.defineItem('Gem', 'material', '', 0);
  runtime.gameplay.questDefine('intro', '', 'Gem', 3);
  assert.equal(runtime.gameplay.questStart('intro'), true);
  assert.equal(runtime.gameplay.questSetProgress('intro', 2, 3), 2);
  assert.equal(runtime.gameplay.questGetProgress('intro'), 2);
  assert.equal(runtime.gameplay.questComplete('intro', 'hero'), true);
  assert.equal(runtime.gameplay.questIsComplete('intro'), true);
  assert.equal(runtime.gameplay.inventoryCount('hero', 'Gem'), 3);
  const quest = runtime.bridge.queryData('Quest').find(entry => entry.data.questId === 'intro');
  assert.ok(quest);
  assert.equal(quest.data.complete, true);
});

test('navigation graph nodes, links and blocked state are ECS Components', () => {
  const runtime = createRuntime();
  assert.equal(runtime.gameplay.navAddNode('a', 0, 0, 0), true);
  assert.equal(runtime.gameplay.navAddNode('b', 1, 0, 0), true);
  assert.equal(runtime.gameplay.navAddNode('c', 2, 0, 0), true);
  runtime.gameplay.navConnect('a', 'b');
  runtime.gameplay.navConnect('b', 'c');
  assert.equal(runtime.gameplay.navNext('a', 'c'), 'b');
  runtime.gameplay.navBlock('b', true);
  assert.equal(runtime.gameplay.navNext('a', 'c'), '');
  assert.equal(runtime.bridge.queryData('NavigationNode').length, 3);
  runtime.gameplay.navClear();
  assert.equal(runtime.bridge.queryData('NavigationNode').length, 0);
});

test('dialogue and active gameplay UI state are owned by GameplayWorld', () => {
  const runtime = createRuntime();
  scene(runtime, [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }]);
  runtime.gameplay.showDialogue('Guide', 'Welcome', 'Continue', 'Leave');
  assert.equal(runtime.gameplay.getUIState().type, 'dialogue');
  assert.equal(runtime.gameplay.chooseDialogue(0), 'Continue');
  assert.equal(runtime.gameplay.getDialogueChoice(), 'Continue');
  runtime.gameplay.openInventory('hero');
  assert.equal(runtime.gameplay.getUIState().type, 'inventory');
  assert.equal(runtime.gameplay.getUIState().ownerId, 'hero');
  const world = runtime.bridge.queryData('GameplayWorld')[0].data;
  assert.equal(world.dialogue.lastChoice, 'Continue');
  assert.equal(world.ui.type, 'inventory');
});

test('AI navigation triangle graph uses ECS node entities and preserves shared-edge links', () => {
  const runtime = createRuntime();
  const triangles = [
    0,0,0, 0,0,1, 1,0,0,
    1,0,0, 0,0,1, 1,0,1
  ];
  assert.equal(runtime.gameplay.navBuildFromTriangles(triangles, 50), 2);
  assert.equal(runtime.bridge.queryData('NavigationNode').length, 2);
  assert.equal(runtime.gameplay.navNext('navtri_0', 'navtri_1'), 'navtri_1');
});

test('legacy PStudioGameplay API still works when ECS is unavailable', () => {
  const window = {
    PStudioPhysics: {
      getPosition() { return { x: 0, y: 0, z: 0 }; },
      getBody() { return { id: 'body' }; },
      configureController() {},
      moveCharacter() {}
    }
  };
  const sandbox = { window, console, Math, Number, Map, Set, Date, Object, Array, TypeError, Error, Promise, JSON };
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  const game = window.PStudioGameplay;
  game.setHP('hero', 35);
  game.inventoryAdd('hero', 'Potion', 2);
  assert.equal(game.getHP('hero'), 35);
  assert.equal(game.inventoryCount('hero', 'Potion'), 2);
  game.questDefine('legacy', '', '', 0);
  assert.equal(game.questStart('legacy'), true);
  assert.equal(game.questSetProgress('legacy', 1, 1), 1);
  assert.equal(game.questIsComplete('legacy'), true);
  game.navAddNode('start', 0, 0, 0);
  game.navAddNode('end', 1, 0, 0);
  game.navConnect('start', 'end');
  assert.equal(game.navNext('start', 'end'), 'end');
});

test('persistent gameplay state survives Stop/Play Scene Object Entity recreation', () => {
  const runtime = createRuntime();
  const objects = scene(runtime, [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }]);
  runtime.gameplay.setHP('hero', 42);
  runtime.gameplay.inventoryAdd('hero', 'Potion', 3);
  assert.equal(runtime.bridge.snapshotSceneState(objects), 2);
  runtime.ecs.clearSceneObjects();
  runtime.ecs.syncSceneObjects(objects);
  assert.equal(runtime.gameplay.getHP('hero'), 42);
  assert.equal(runtime.gameplay.inventoryCount('hero', 'Potion'), 3);
});

test('the ECS gameplay bridge loads after ECS Physics and before the Inspector', () => {
  const html = read('templates/index.html');
  const ecsCore = html.indexOf('<script src="/static/pstudio_ecs.js"></script>');
  const physics = html.indexOf('<script src="/static/pstudio_ecs_physics.js"></script>');
  const gameplay = html.indexOf('<script src="/static/pstudio_ecs_gameplay.js"></script>');
  const inspector = html.indexOf('<script src="/static/pstudio_ecs_inspector.js"></script>');
  assert.ok(ecsCore >= 0 && physics > ecsCore && gameplay > physics && inspector > gameplay);
  assert.doesNotThrow(() => new vm.Script(read('static/pstudio_ecs_gameplay.js')));
  assert.doesNotThrow(() => new vm.Script(read('static/pstudio_gameplay.js')));
});
