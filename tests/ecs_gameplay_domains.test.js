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

test('Inventory and Equipment are runtime-only ECS Components with legacy API parity', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay } = createRuntime(objects);
  const entity = ecs.getEntityForSceneObject('player');

  gameplay.defineItem('potion', 'consumable', 'heal', 25);
  gameplay.defineItem('sword', 'equipment', 'main-hand', 0);
  assert.equal(gameplay.inventoryAdd('player', 'potion', 3), 3);
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
  assert.equal(ecs.getComponentDefinition('Inventory').persistent, false);
  assert.equal(ecs.getComponentDefinition('Equipment').internal, true);
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
  const { ecs, gameplay, movements, physics, positions } = createRuntime(objects);
  assert.equal(gameplay.enemyAI('enemy', 'player', 20, 1.2, 4, objects, physics), 'chase');
  const enemyEntity = ecs.getEntityForSceneObject('enemy');
  assert.ok(ecs.hasComponent(enemyEntity, 'AIController'));
  assert.ok(ecs.hasComponent(enemyEntity, 'MovementIntent'));

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

test('Inventory, Equipment, Combat, Quest and Dialogue state survive Stop/Play snapshots', () => {
  const objects = [{ id: 'player', name: 'Player', worldX: 0, worldZ: 0 }];
  const { ecs, gameplay } = createRuntime(objects);
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

  assert.equal(gameplay.persistECS(objects), true);
  ecs.clearSceneObjects();
  assert.equal(ecs.stats().entityCount, 0);
  ecs.syncSceneObjects(objects);
  assert.equal(gameplay.initializeECS(objects), true);

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
  for (const name of ['Health', 'Inventory', 'Equipment', 'CombatState', 'AIController', 'MovementIntent', 'QuestProgress', 'DialogueSession']) {
    assert.ok(script.includes('"' + name + '"'), name);
  }
});
