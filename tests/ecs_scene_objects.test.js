const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function createSceneRuntime(objects = []) {
  let persistCount = 0;
  const window = {
    sceneObjects: objects,
    dispatchEvent() {},
    persistProject() { persistCount++; }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    String, Boolean, TypeError, Error, RangeError, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_rendering.js'), sandbox, { filename: 'pstudio_ecs_rendering.js' });
  vm.runInNewContext(read('static/pstudio_ecs_visualfx.js'), sandbox, { filename: 'pstudio_ecs_visualfx.js' });
  vm.runInNewContext(read('static/pstudio_ecs_materials.js'), sandbox, { filename: 'pstudio_ecs_materials.js' });
  vm.runInNewContext(read('static/pstudio_ecs_scene.js'), sandbox, { filename: 'pstudio_ecs_scene.js' });
  return {
    ecs: window.PStudioECS,
    materials: window.PStudioECSMaterials,
    scene: window.PStudioECSScene,
    window, objects,
    getPersistCount: () => persistCount
  };
}

function migrate(runtime) {
  runtime.ecs.syncSceneObjects(runtime.objects);
  runtime.materials.migrateLegacySceneObjects(runtime.objects);
  runtime.scene.syncSceneObjects(runtime.objects);
}

test('Scene behavior, sprite, collider and editor settings are persistent ECS Components', () => {
  const runtime = createSceneRuntime([]);
  for (const type of ['ScriptAttachment', 'SpriteRenderer', 'Collider2D', 'EditorObjectSettings']) {
    const definition = runtime.ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true);
    assert.equal(definition.internal, false);
    assert.equal(definition.readonly, false);
    assert.equal(definition.source, 'pstudio_ecs_scene');
  }
  assert.deepEqual(Array.from(runtime.scene.componentTypes), [
    'ScriptAttachment', 'SpriteRenderer', 'Collider2D', 'EditorObjectSettings'
  ]);
});

test('legacy Scene Object behavior and 2D presentation migrate into ECS and leave no duplicate authority', () => {
  const objects = [{
    id: 'hero', name: 'Hero', x: 80, y: 120, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    script: 'characters/hero.ps',
    sprite: 'hero.png', color: '#ff8844', shape: 'circle', w: 72, h: 88,
    model: 'hero.glb', modelScale: 1.75, collider: true,
    manipulationEnabled: false, ecsComponents: []
  }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  const entity = runtime.ecs.getEntityForSceneObject('hero');
  assert.ok(entity);

  const script = runtime.ecs.getComponent(entity, 'ScriptAttachment');
  assert.deepEqual(plain(script), { scriptFile: 'characters/hero.ps', enabled: true });
  const sprite = runtime.ecs.getComponent(entity, 'SpriteRenderer');
  assert.equal(sprite.spriteAsset, 'hero.png');
  assert.equal(sprite.color, '#ff8844');
  assert.equal(sprite.shape, 'circle');
  assert.equal(sprite.width, 72);
  assert.equal(sprite.height, 88);
  assert.equal(runtime.ecs.getComponent(entity, 'Collider2D').enabled, true);
  assert.equal(runtime.ecs.getComponent(entity, 'MeshCollider').enabled, true);
  assert.equal(runtime.ecs.getComponent(entity, 'EditorObjectSettings').manipulationEnabled, false);
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').assetName, 'hero.glb');
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').scale, 1.75);

  assert.equal(objects[0].ecsComponentsVersion, 1);
  const types = objects[0].ecsComponents.map(entry => entry.type).sort();
  assert.deepEqual(Array.from(types), [
    'Collider2D', 'EditorObjectSettings', 'MaterialOverrides',
    'MeshCollider', 'Renderable', 'ScriptAttachment', 'SpriteRenderer'
  ].filter(type => types.includes(type)).sort());
  for (const legacy of ['script','sprite','color','shape','w','h','model','modelScale','collider','manipulationEnabled']) {
    assert.equal(Object.prototype.hasOwnProperty.call(objects[0], legacy), false, legacy);
  }
});

test('ScriptAttachment accepts safe nested relative paths and supports rename, clear and removal', () => {
  const objects = [{ id: 'npc', name: 'NPC', x: 0, y: 0, z: 0, ecsComponents: [] }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  assert.equal(runtime.scene.setScriptFile('npc', 'actors/npc/dialogue.ps', objects), true);
  assert.equal(runtime.scene.getScriptFile('npc', objects), 'actors/npc/dialogue.ps');
  assert.equal(runtime.scene.renameScriptFile('actors/npc/dialogue.ps', 'actors/npc/talk.ps', objects), 1);
  assert.equal(runtime.scene.getScriptFile('npc', objects), 'actors/npc/talk.ps');
  assert.equal(runtime.scene.clearScriptFile('actors/npc/talk.ps', objects), 1);
  assert.equal(runtime.scene.getScriptFile('npc', objects), '');
  const entity = runtime.ecs.getEntityForSceneObject('npc');
  assert.equal(runtime.ecs.hasComponent(entity, 'ScriptAttachment'), false);
  for (const invalid of ['../escape.ps', '/root.ps', 'folder/../escape.ps', 'folder//bad.ps', 'wrong.txt', 'bad\\path.ps']) {
    assert.equal(runtime.scene.setScriptFile('npc', invalid, objects), false, invalid);
  }
});

test('SpriteRenderer edits persist dimensions and asset renames through the ECS Component', () => {
  const objects = [{ id: 'sprite', name: 'Sprite', x: 20, y: 30, z: 0, ecsComponents: [] }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  assert.equal(runtime.scene.setSpriteRenderer('sprite', {
    enabled: true, spriteAsset: 'characters/hero.png',
    width: 128, height: 96, color: '#23aacc', shape: 'rect', layer: 2, sortOrder: 10
  }, objects), true);
  assert.equal(runtime.scene.getSpriteRenderer('sprite', objects).width, 128);
  assert.equal(runtime.scene.renameSpriteAsset('characters/hero.png', 'characters/hero_v2.png', objects), 1);
  assert.equal(runtime.scene.getSpriteRenderer('sprite', objects).spriteAsset, 'characters/hero_v2.png');
  const saved = objects[0].ecsComponents.find(entry => entry.type === 'SpriteRenderer');
  assert.equal(saved.data.spriteAsset, 'characters/hero_v2.png');
  assert.equal(saved.data.width, 128);
});

test('Renderable model references rename in ECS and preserve scale and material settings', () => {
  const objects = [{ id: 'model', name: 'Model', x: 0, y: 0, z: 0, model: 'old.glb', modelScale: 2.5 }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  const entity = runtime.ecs.getEntityForSceneObject('model');
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').assetName, 'old.glb');
  assert.equal(runtime.materials.renameRenderableAsset('old.glb', 'new.glb', objects), 1);
  assert.equal(runtime.materials.getRenderableAsset('model', objects), 'new.glb');
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').scale, 2.5);
  assert.equal(objects[0].ecsComponents.find(entry => entry.type === 'Renderable').data.assetName, 'new.glb');
});

test('Collider2D and EditorObjectSettings mutate ECS and persist without Scene Object property copies', () => {
  const objects = [{ id: 'switch', name: 'Switch', x: 0, y: 0, z: 0, ecsComponents: [] }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  assert.equal(runtime.scene.setCollider2D('switch', true, objects), true);
  assert.equal(runtime.scene.getCollider2D('switch', objects), true);
  assert.equal(runtime.scene.setManipulationEnabled('switch', false, objects), true);
  assert.equal(runtime.scene.isManipulationEnabled('switch', objects), false);
  assert.equal(runtime.scene.setCollider2D('switch', false, objects), true);
  assert.equal(runtime.scene.getCollider2D('switch', objects), false);
  assert.equal(Object.prototype.hasOwnProperty.call(objects[0], 'collider'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(objects[0], 'manipulationEnabled'), false);
});

test('unknown ECS plugin data survives Scene migration; future schemas are left completely untouched', () => {
  const objects = [{
    id: 'plugin', name: 'Plugin', x: 0, y: 0, z: 0,
    ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'ThirdPartySpriteSettings', data: { profile: 'vivid', enabled: true } }],
    script: 'plugin.ps', sprite: 'plugin.png', color: '#123456', shape: 'rect', w: 64, h: 64
  }];
  const runtime = createSceneRuntime(objects);
  migrate(runtime);
  assert.ok(objects[0].ecsComponents.some(entry => entry.type === 'ThirdPartySpriteSettings'));
  assert.ok(objects[0].ecsComponents.some(entry => entry.type === 'ScriptAttachment'));

  const future = [{
    id: 'future', name: 'Future', x: 0, y: 0, z: 0,
    ecsComponentsVersion: 9,
    ecsComponents: [{ type: 'FutureSceneComponent', data: { value: 123 } }],
    script: 'future.ps', sprite: 'future.png', w: 100, h: 100
  }];
  const futureRuntime = createSceneRuntime(future);
  const before = JSON.stringify(future[0]);
  futureRuntime.ecs.syncSceneObjects(future);
  futureRuntime.materials.migrateLegacySceneObjects(future);
  futureRuntime.scene.syncSceneObjects(future);
  assert.equal(JSON.stringify(future[0]), before);
  assert.equal(futureRuntime.scene.setScriptFile('future', 'new.ps', future), false);
  assert.equal(futureRuntime.scene.setSpriteRenderer('future', { spriteAsset: 'new.png' }, future), false);
  assert.equal(JSON.stringify(future[0]), before);
});
