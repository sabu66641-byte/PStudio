const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRuntime(objects) {
  const bodies = new Map();
  const positions = new Map();
  const movements = [];
  const controllerConfigs = [];
  for (const object of objects) {
    bodies.set(String(object.id), {});
    positions.set(String(object.id), {
      x: Number(object.worldX) || 0,
      y: Number(object.worldY) || 0,
      z: Number(object.worldZ) || 0
    });
  }
  const physics = {
    getBody: id => bodies.get(String(id)) || null,
    getPosition: id => positions.get(String(id)) || null,
    configureController(id, maxSpeed, acceleration, airControl) {
      controllerConfigs.push({ id: String(id), maxSpeed, acceleration, airControl });
      return true;
    },
    moveCharacter(id, x, z) {
      movements.push({ id: String(id), x, z });
      return true;
    }
  };
  const window = { dispatchEvent() {}, PStudioPhysics: physics };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    TypeError, Error, Promise
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  vm.runInNewContext(read('static/pstudio_ecs_gameplay.js'), sandbox, { filename: 'pstudio_ecs_gameplay.js' });
  const ecs = window.PStudioECS;
  const gameplay = window.PStudioGameplay;
  ecs.syncSceneObjects(objects);
  gameplay.initializeECS(objects);
  return { ecs, gameplay, bridge: window.PStudioECSGameplay, physics, bodies, positions, movements, controllerConfigs, window };
}

test('Inventory and Equipment are persistent ECS Components with legacy API parity', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay } = createRuntime(objects);
  const entity = ecs.getEntityForSceneObject('player');

  gameplay.defineItem('potion', 'consumable', 'heal', 25);
  gameplay.defineItem('sword', 'equipment', 'main-hand', 0);
  assert.equal(gameplay.inventoryAdd('player', 'potion', 3), 3);
  assert.equal(gameplay.inventoryAdd('player', '__proto__', 2), 2);
  assert.equal(gameplay.inventoryCount('player', '__proto__'), 2);
  assert.equal(gameplay.inventoryAdd('player', 'sword', 1), 1);
  assert.equal(gameplay.equipItem('player', 'sword'), true);
  assert.equal(gameplay.inventoryCount('player', 'potion'), 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(gameplay.getEquipment('player'))),
    [{ slot: 'main-hand', item: 'sword' }]
  );

  gameplay.setHP('player', 50);
  assert.equal(gameplay.useItem('player', 'potion'), true);
  assert.equal(gameplay.getHP('player'), 75);
  assert.equal(gameplay.inventoryCount('player', 'potion'), 2);
  assert.equal(gameplay.inventoryRemove('player', 'potion', 5), false);
  const snapshot = gameplay.getInventorySnapshot('player');
  assert.equal(snapshot.find(item => item.item === 'sword').equipped, true);
  assert.ok(ecs.hasComponent(entity, 'Inventory'));
  assert.ok(ecs.hasComponent(entity, 'Equipment'));
  assert.equal(ecs.getComponentDefinition('Inventory').persistent, true);
  assert.equal(ecs.getComponentDefinition('Equipment').internal, true);
  assert.equal(ecs.getComponentDefinition('Equipment').persistent, true);
});

test('Combat cooldowns and combo state are ECS data and cooldown expiry is scheduled', () => {
  const objects = [
    { id: 'player', name: 'Player', worldX: 0, worldZ: 0 },
    { id: 'target', name: 'Target', worldX: 0, worldZ: 1 }
  ];
  const { ecs, gameplay, physics } = createRuntime(objects);
  gameplay.setHP('player', 100);
  gameplay.setHP('target', 100);

  assert.equal(gameplay.attack('player', 2, 10, objects, physics, 500), 1);
  assert.equal(gameplay.getHP('target'), 90);
  assert.equal(gameplay.attack('player', 2, 10, objects, physics, 500), 0);

  const playerEntity = ecs.getEntityForSceneObject('player');
  const combat = ecs.getComponent(playerEntity, 'CombatState');
  assert.ok(combat.cooldowns.target);
  combat.cooldowns.target.at = Date.now() - 1000;
  ecs.update(1 / 60);
  assert.equal(combat.cooldowns.target, undefined);
  assert.equal(gameplay.attack('player', 2, 10, objects, physics, 500), 1);

  gameplay.defineWeapon('blade', 2, 120, 1);
  assert.equal(gameplay.weaponAttack('player', 'blade', 2, 5, 1100, objects, physics), 1);
  assert.equal(gameplay.comboCount('player'), 1);
  assert.equal(gameplay.weaponAttack('player', 'blade', 2, 5, 1100, objects, physics), 1);
  assert.equal(gameplay.comboCount('player'), 2);
  assert.equal(ecs.getComponent(playerEntity, 'CombatState').comboWeapon, 'blade');
  assert.ok(ecs.getSystems().some(system => system.id === 'gameplay.combat-state-maintenance'));
});

test('AIController System produces MovementIntent and the resolver applies it before Physics', () => {
  const objects = [
    { id: 'enemy', name: 'Enemy', worldX: 0, worldZ: 0 },
    { id: 'player', name: 'Player', worldX: 0, worldZ: 8 }
  ];
  const { ecs, gameplay, bridge, movements, physics, positions } = createRuntime(objects);
  const enemyEntity = ecs.getEntityForSceneObject('enemy');
  assert.ok(enemyEntity !== null);
  assert.equal(ecs.getComponent(enemyEntity, 'SceneObjectRef').sceneObjectId, 'enemy');
  assert.ok(physics.getBody('enemy'));
  assert.equal(gameplay.getHP('enemy'), 100);
  assert.equal(gameplay.getHP('player'), 100);
  assert.equal(physics.getPosition('player').z, 8);
  assert.equal(gameplay.enemyAI('enemy', 'player', 20, 1.2, 4, objects, physics), 'chase');
  assert.ok(ecs.hasComponent(enemyEntity, 'AIController'));
  assert.ok(ecs.hasComponent(enemyEntity, 'MovementIntent'));
  const movementIntent = bridge.getMovementIntent('enemy');
  assert.equal(movementIntent.active, true);
  assert.equal(movementIntent.x, 0);
  assert.equal(movementIntent.z, 1);
  assert.deepEqual(Array.from(ecs.query(['MovementIntent', 'SceneObjectRef'])), [enemyEntity]);
  assert.equal(ecs.getSystems().find(system => system.id === 'gameplay.movement-intent')?.phase, 'postUpdate');

  ecs.updatePhase('postUpdate', 1 / 60, { sceneObjects: objects });
  assert.equal(gameplay.getAIState('enemy'), 'chase');
  assert.deepEqual(movements.at(-1), { id: 'enemy', x: 0, z: 1 });
  assert.equal(ecs.getComponent(enemyEntity, 'MovementIntent').active, false);

  positions.set('player', { x: 0, y: 0, z: 0.5 });
  assert.equal(gameplay.enemyAI('enemy', 'player', 20, 1.2, 4, objects, physics), 'attack');
  ecs.updatePhase('postUpdate', 1 / 60, { sceneObjects: objects });
  assert.equal(gameplay.getAIState('enemy'), 'attack');
  assert.equal(gameplay.getHP('player'), 92);
});

test('manual follow writes a MovementIntent instead of calling Physics immediately', () => {
  const objects = [
    { id: 'follower', name: 'Follower', worldX: 0, worldZ: 0 },
    { id: 'target', name: 'Target', worldX: 0, worldZ: 5 }
  ];
  const { ecs, gameplay, movements, physics } = createRuntime(objects);
  const before = movements.length;
  assert.equal(gameplay.follow('follower', 'target', 6, 1, objects, physics), true);
  assert.equal(movements.length, before);
  ecs.updatePhase('postUpdate', 1 / 60, { sceneObjects: objects });
  assert.deepEqual(movements.at(-1), { id: 'follower', x: 0, z: 1 });
  assert.equal(ecs.getComponent(ecs.getEntityForSceneObject('follower'), 'MovementIntent').active, false);
});

test('QuestProgress and DialogueSession Components preserve progression and UI-facing state', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  gameplay.defineItem('quest-reward', 'consumable', 'heal', 10);
  gameplay.questDefine('chapter-one', '', 'quest-reward', 2);
  assert.equal(gameplay.questStart('chapter-one'), true);
  assert.equal(gameplay.questSetProgress('chapter-one', 2, 2), 2);
  assert.equal(gameplay.questIsComplete('chapter-one'), true);
  assert.equal(gameplay.questComplete('chapter-one', 'player'), true);
  assert.equal(gameplay.questComplete('chapter-one', 'player'), true);
  assert.equal(gameplay.inventoryCount('player', 'quest-reward'), 2);
  gameplay.openQuestLog('player');
  const questUI = gameplay.getUIState();
  assert.equal(questUI.type, 'quests');
  assert.equal(questUI.quests[0].quest, 'chapter-one');
  const questEntities = ecs.query(['QuestProgress']);
  assert.equal(questEntities.length, 1);

  assert.equal(gameplay.showDialogue('Guide', 'Welcome', 'Continue', 'Leave', ''), true);
  const dialogueUI = gameplay.getUIState();
  assert.equal(dialogueUI.type, 'dialogue');
  assert.deepEqual(Array.from(dialogueUI.choices), ['Continue', 'Leave']);
  assert.equal(gameplay.chooseDialogue(1), 'Leave');
  assert.equal(gameplay.getDialogueChoice(), 'Leave');
  assert.equal(gameplay.getUIState(), null);
  assert.ok(ecs.query(['DialogueSession']).length === 1);
  assert.equal(bridge.getRuntimeState().hasDialogueSession, true);
});

test('Health, Inventory, Equipment and CombatState persist in versioned ECS scene data while QuestProgress and DialogueSession remain ECS-owned across Stop/Play', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  gameplay.defineItem('herb', 'consumable', 'heal', 5);
  gameplay.inventoryAdd('player', 'herb', 4);
  gameplay.defineItem('shield', 'equipment', 'off-hand', 0);
  gameplay.inventoryAdd('player', 'shield', 1);
  gameplay.equipItem('player', 'shield');
  gameplay.setHP('player', 64);
  gameplay.questStart('persisted-quest');
  gameplay.questSetProgress('persisted-quest', 3, 5);
  gameplay.showDialogue('Archivist', 'Saved dialogue', 'Next', '', '');
  const playerEntity = ecs.getEntityForSceneObject('player');
  ecs.getComponent(playerEntity, 'CombatState').comboCount = 3;
  ecs.getComponent(playerEntity, 'CombatState').comboTime = Date.now();
  ecs.getComponent(playerEntity, 'CombatState').comboWeapon = 'shield-bash';

  const questEntity = ecs.query(['QuestProgress'])[0];
  const dialogueEntity = ecs.query(['DialogueSession'])[0];
  assert.equal(gameplay.persistECS(objects), true);
  assert.equal(objects[0].ecsComponentsVersion, 1);
  const savedTypes = objects[0].ecsComponents.map(entry => entry.type).sort();
  assert.deepEqual(Array.from(savedTypes), ['CombatState', 'Equipment', 'Health', 'Inventory']);
  assert.equal(ecs.clearSceneObjects(), true);
  assert.equal(ecs.query(['SceneObjectRef']).length, 0);
  assert.equal(ecs.query(['ItemDefinition']).length, 2);
  assert.equal(ecs.query(['QuestProgress'])[0], questEntity);
  assert.equal(ecs.query(['DialogueSession'])[0], dialogueEntity);
  assert.equal(ecs.stats().entityCount, 4);

  ecs.syncSceneObjects(objects);
  assert.equal(gameplay.initializeECS(objects), true);
  const restoredPlayer = ecs.getEntityForSceneObject('player');
  assert.notEqual(restoredPlayer, playerEntity);
  assert.equal(ecs.hasComponent(restoredPlayer, 'Health'), true);
  assert.equal(ecs.hasComponent(restoredPlayer, 'Inventory'), true);
  assert.equal(ecs.hasComponent(restoredPlayer, 'Equipment'), true);
  assert.equal(ecs.hasComponent(restoredPlayer, 'CombatState'), true);

  assert.equal(bridge.getItemDefinition('herb').value, 5);
  assert.equal(bridge.getItemDefinition('shield').slot, 'off-hand');
  assert.equal(gameplay.getHP('player'), 64);
  assert.equal(gameplay.inventoryCount('player', 'herb'), 4);
  assert.equal(gameplay.inventoryCount('player', 'shield'), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(gameplay.getEquipment('player'))), [{ slot: 'off-hand', item: 'shield' }]);
  assert.equal(gameplay.questGetProgress('persisted-quest'), 3);
  assert.equal(gameplay.comboCount('player'), 3);
  assert.equal(gameplay.getDialogueChoice(), '');
  assert.equal(gameplay.showDialogue('Archivist', 'Saved dialogue', 'Next', '', ''), true);
  assert.equal(gameplay.getUIState().speaker, 'Archivist');
});

test('ECS gameplay Component names cannot be redefined in browser ps code', () => {
  const script = read('app.py');
  for (const name of ['Health', 'Inventory', 'Equipment', 'CombatState', 'AIController', 'MovementIntent', 'QuestProgress', 'DialogueSession', 'NavigationNode', 'InputSnapshot', 'PlayerInput', 'ControlIntent', 'CollisionEvent', 'AudioEmitter', 'AudioCommand', 'Renderable', 'Camera', 'Light', 'Animation']) {
    assert.ok(script.includes('"' + name + '"'), name);
  }
});

test('Navigation graph nodes, links, blocked state and A* are owned by ECS Components', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  assert.equal(gameplay.navAddNode('start', 0, 0, 0), true);
  assert.equal(gameplay.navAddNode('middle', 2, 0, 0), true);
  assert.equal(gameplay.navAddNode('goal', 4, 0, 0), true);
  assert.equal(gameplay.navConnect('start', 'middle'), true);
  assert.equal(gameplay.navConnect('middle', 'goal'), true);
  assert.equal(gameplay.navConnect('missing', 'goal'), false);

  assert.equal(ecs.query(['NavigationNode']).length, 3);
  const definition = ecs.getComponentDefinition('NavigationNode');
  assert.equal(definition.internal, true);
  assert.equal(definition.persistent, false);
  assert.equal(bridge.getNavigationNodeCount(), 3);
  assert.equal(gameplay.navNext('start', 'goal'), 'middle');
  const nearest = bridge.getNearestNavigationNodes([
    { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }
  ]);
  assert.deepEqual(Array.from(nearest, node => node.nodeId), ['start', 'goal']);

  const middle = bridge.getNavigationNode('middle');
  assert.deepEqual(Array.from(middle.links), ['start', 'goal']);
  assert.equal(gameplay.navBlock('middle', true), true);
  assert.equal(gameplay.navNext('start', 'goal'), '');
  assert.equal(gameplay.navBlock('middle', false), true);
  assert.equal(gameplay.navNext('start', 'goal'), 'middle');
  assert.equal(gameplay.navBlock('unknown', true), false);

  gameplay.navClear();
  assert.equal(bridge.getNavigationNodeCount(), 0);
  assert.equal(ecs.query(['NavigationNode']).length, 0);
});

test('Navigation grid and triangle graph builders create ECS-owned connected nodes', () => {
  const { ecs, gameplay, bridge } = createRuntime([]);
  assert.equal(gameplay.navBuildGrid(0, 0, 4, 2, 2), 6);
  assert.equal(bridge.getNavigationNodeCount(), 6);
  assert.equal(gameplay.navNext('grid_0_0', 'grid_2_1') !== '', true);

  const triangles = [
    0, 0, 0,  1, 0, 0,  0, 0, 1,
    1, 0, 0,  1, 0, 1,  0, 0, 1
  ];
  assert.equal(gameplay.navBuildFromTriangles(triangles, 50), 2);
  assert.equal(ecs.query(['NavigationNode']).length, 2);
  assert.equal(gameplay.navNext('navtri_0', 'navtri_1'), 'navtri_1');
});

test('Navigation graph survives gameplay Stop/Play and Scene Object ECS teardown', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  gameplay.navAddNode('persist-a', 0, 0, 0);
  gameplay.navAddNode('persist-b', 1, 0, 0);
  gameplay.navConnect('persist-a', 'persist-b');

  assert.equal(gameplay.persistECS(objects), true);
  ecs.clearSceneObjects();
  assert.equal(bridge.getNavigationNodeCount(), 2);
  assert.equal(gameplay.navNext('persist-a', 'persist-b'), 'persist-b');

  ecs.syncSceneObjects(objects);
  gameplay.initializeECS(objects);
  assert.equal(bridge.getNavigationNodeCount(), 2);
  assert.equal(gameplay.navNext('persist-a', 'persist-b'), 'persist-b');
});

test('Enemy AI uses ECS Navigation graph nodes to create its MovementIntent', () => {
  const objects = [
    { id: 'enemy', name: 'Enemy', worldX: 0, worldZ: 0 },
    { id: 'player', name: 'Player', worldX: 0, worldZ: 8 }
  ];
  const { ecs, gameplay, bridge, movements, physics } = createRuntime(objects);
  gameplay.navAddNode('enemy-node', 0, 0, 0);
  gameplay.navAddNode('route-node', 4, 0, 0);
  gameplay.navAddNode('player-node', 0, 0, 8);
  gameplay.navConnect('enemy-node', 'route-node');
  gameplay.navConnect('route-node', 'player-node');

  assert.equal(gameplay.enemyAI('enemy', 'player', 20, 1.2, 4, objects, physics), 'chase');
  const intent = bridge.getMovementIntent('enemy');
  assert.equal(intent.x, 1);
  assert.equal(intent.z, 0);
  ecs.updatePhase('postUpdate', 1 / 60, { sceneObjects: objects });
  assert.deepEqual(movements.at(-1), { id: 'enemy', x: 1, z: 0 });
});

test('Item definitions are ECS entities and legacy inventory/equipment APIs read their Components', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  assert.equal(gameplay.defineItem('potion', 'consumable', 'heal', 30), true);
  assert.equal(gameplay.defineItem('sword', 'equipment', 'main-hand', 0), true);
  const potion = bridge.getItemDefinition('potion');
  const sword = bridge.getItemDefinition('sword');
  assert.deepEqual(JSON.parse(JSON.stringify(potion)), { kind: 'consumable', slot: 'heal', value: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(sword)), { kind: 'equipment', slot: 'main-hand', value: 0 });
  assert.equal(ecs.query(['ItemDefinition']).length, 2);
  assert.equal(ecs.getComponentDefinition('ItemDefinition').persistent, false);
  assert.equal(gameplay.inventoryAdd('player', 'sword', 1), 1);
  assert.equal(gameplay.equipItem('player', 'sword'), true);
  gameplay.inventoryAdd('player', 'potion', 1);
  gameplay.setHP('player', 50);
  assert.equal(gameplay.useItem('player', 'potion'), true);
  assert.equal(gameplay.getHP('player'), 80);
  assert.equal(gameplay.getInventorySnapshot('player').find(item => item.item === 'sword').definition.slot, 'main-hand');
});

test('Quest definitions are ECS entities; prerequisites and rewards preserve legacy quest APIs', () => {
  const objects = [{ id: 'hero', name: 'Hero', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  gameplay.defineItem('gem', 'material', '', 0);
  assert.equal(gameplay.questDefine('intro', '', 'gem', 2), true);
  assert.equal(gameplay.questDefine('follow-up', 'intro', '', 0), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(bridge.getQuestDefinition('follow-up'))),
    { prerequisite: 'intro', rewardItem: '', rewardCount: 0 }
  );
  assert.equal(ecs.query(['QuestDefinition']).length, 2);
  assert.equal(gameplay.questStart('follow-up'), false);
  assert.equal(gameplay.questStart('intro'), true);
  assert.equal(gameplay.questComplete('intro', 'hero'), true);
  assert.equal(gameplay.inventoryCount('hero', 'gem'), 2);
  assert.equal(gameplay.questStart('follow-up'), true);
  assert.equal(gameplay.questIsComplete('intro'), true);
});

test('Weapon definitions are ECS entities and legacy weaponAttack reads range/arc/damage from ECS', () => {
  const objects = [
    { id: 'hero', name: 'Hero', worldX: 0, worldZ: 0, rotationY: 0 },
    { id: 'target', name: 'Target', worldX: 0, worldZ: 2 }
  ];
  const { ecs, gameplay, bridge } = createRuntime(objects);
  gameplay.setHP('hero', 100);
  gameplay.setHP('target', 100);
  assert.equal(gameplay.defineWeapon('heavy-sword', 2.5, 120, 2), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(bridge.getWeaponDefinition('heavy-sword'))),
    { range: 2.5, arc: 120, multiplier: 2 }
  );
  assert.equal(ecs.query(['WeaponDefinition']).length, 1);
  assert.equal(gameplay.weaponAttack('hero', 'heavy-sword', 0.5, 10, 1100, objects, {
    getBody: () => ({})
  }), 1);
  assert.equal(gameplay.getHP('target'), 80);
});

test('Gameplay definition Components remain available across the Stop/Play snapshot boundary', () => {
  const objects = [{ id: 'hero', name: 'Hero', worldX: 0, worldZ: 0 }];
  const { gameplay, bridge, ecs } = createRuntime(objects);
  gameplay.defineItem('elixir', 'consumable', 'heal', 12);
  gameplay.questDefine('chapter-1', '', 'elixir', 1);
  gameplay.defineWeapon('bow', 14, 60, 1.2);
  assert.equal(gameplay.persistECS(objects), true);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getItemDefinition('elixir'))), {
    kind: 'consumable', slot: 'heal', value: 12
  });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getQuestDefinition('chapter-1'))), {
    prerequisite: '', rewardItem: 'elixir', rewardCount: 1
  });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getWeaponDefinition('bow'))), {
    range: 14, arc: 60, multiplier: 1.2
  });
  assert.equal(ecs.query(['ItemDefinition']).length, 1);
  assert.equal(ecs.query(['QuestDefinition']).length, 1);
  assert.equal(ecs.query(['WeaponDefinition']).length, 1);
});
