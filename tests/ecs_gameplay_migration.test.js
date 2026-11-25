const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

test('legacy Gameplay fallback snapshots are imported once, then ECS becomes authoritative', () => {
  const window = { dispatchEvent() {} };
  const sandbox = { window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array, TypeError, Error, Promise };
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  const gameplay = window.PStudioGameplay;
  const objects = [{ id: 'hero', name: 'Hero', x: 0, y: 0, z: 0 }];

  // Seed the documented compatibility path before ECS is available.
  gameplay.setMaxHP('hero', 200);
  gameplay.setHP('hero', 73);
  gameplay.inventoryAdd('hero', 'potion', 3);
  gameplay.defineItem('potion', 'consumable', 'heal', 5);
  gameplay.defineItem('sword', 'equipment', 'main', 1);
  gameplay.inventoryAdd('hero', 'sword', 1);
  assert.equal(gameplay.equipItem('hero', 'sword'), true);
  gameplay.defineWeapon('blade', 4, 120, 1.5);
  gameplay.questDefine('prologue', '', 'potion', 2);
  gameplay.questStart('prologue');
  gameplay.questSetProgress('prologue', 1, 1);
  gameplay.navAddNode('path-a', 0, 0, 0);
  gameplay.navAddNode('path-b', 2, 0, 0);
  gameplay.navConnect('path-a', 'path-b');
  gameplay.showDialogue('Guide', 'Welcome', 'Continue');
  gameplay.chooseDialogue(0);

  // Load the ECS runtime after the fallback has data, as happens during migration.
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_gameplay.js'), sandbox, { filename: 'pstudio_ecs_gameplay.js' });
  vm.runInNewContext(read('static/pstudio_ecs_ui.js'), sandbox, { filename: 'pstudio_ecs_ui.js' });
  const ecs = window.PStudioECS;
  const bridge = window.PStudioECSGameplay;
  ecs.syncSceneObjects(objects);

  assert.equal(gameplay.initializeECS(objects), true);
  const hero = ecs.getEntityForSceneObject('hero');
  assert.equal(ecs.getComponent(hero, 'Health').hp, 73);
  assert.deepEqual({ ...ecs.getComponent(hero, 'Inventory').items }, { potion: 3, sword: 1 });
  assert.deepEqual({ ...ecs.getComponent(hero, 'Equipment').slots }, { main: 'sword' });
  assert.deepEqual({ ...bridge.getItemDefinition('potion') }, { kind: 'consumable', slot: 'heal', value: 5 });
  assert.deepEqual({ ...bridge.getWeaponDefinition('blade') }, { range: 4, arc: 120, multiplier: 1.5 });
  assert.equal(bridge.getQuestDefinition('prologue').rewardItem, 'potion');
  assert.equal(gameplay.questIsComplete('prologue'), true);
  assert.equal(bridge.getNavigationNodeCount(), 2);
  assert.equal(gameplay.navNext('path-a', 'path-b'), 'path-b');
  assert.equal(gameplay.getDialogueChoice(), 'Continue');
  assert.equal(window.PStudioECSUI.getOverlay(), null, 'a completed dialogue should not reopen its UI');

  // Snapshot must serialize ECS Components; after Scene teardown the old Maps must not shadow them.
  assert.equal(gameplay.persistECS(objects), true);
  ecs.clearSceneObjects();
  assert.equal(gameplay.getHP('hero'), 100);
  assert.equal(gameplay.inventoryCount('hero', 'potion'), 0);
  assert.deepEqual(gameplay.getEquipment('hero'), []);

  // Play again from the versioned Scene payload; standalone ECS state remains intact.
  ecs.syncSceneObjects(objects);
  assert.equal(gameplay.initializeECS(objects), true);
  assert.equal(gameplay.getHP('hero'), 73);
  assert.equal(gameplay.inventoryCount('hero', 'potion'), 3);
  assert.equal(gameplay.questIsComplete('prologue'), true);
  assert.equal(gameplay.getDialogueChoice(), 'Continue');
  assert.equal(gameplay.navNext('path-a', 'path-b'), 'path-b');
});

test('Gameplay standalone fallback remains available when ECS is not loaded', () => {
  const window = { dispatchEvent() {} };
  const sandbox = { window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array, TypeError, Error, Promise };
  vm.runInNewContext(read('static/pstudio_gameplay.js'), sandbox, { filename: 'pstudio_gameplay.js' });
  const gameplay = window.PStudioGameplay;
  assert.equal(gameplay.getHP('legacy'), 100);
  assert.equal(gameplay.damage('legacy', 25), 75);
  assert.equal(gameplay.inventoryAdd('legacy', 'potion', 2), 2);
  assert.equal(gameplay.inventoryCount('legacy', 'potion'), 2);
  assert.equal(gameplay.navAddNode('a', 0, 0, 0), true);
  assert.equal(gameplay.navAddNode('b', 1, 0, 0), true);
  assert.equal(gameplay.navConnect('a', 'b'), true);
  assert.equal(gameplay.navNext('a', 'b'), 'b');
});
