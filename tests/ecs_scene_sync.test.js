const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createECS() {
  const window = { dispatchEvent() {} };
  const sandbox = { window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array, TypeError, Error, Promise };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  return window.PStudioECS;
}

test('postUpdate Systems observe Scene Object writes from the legacy ps callback boundary', () => {
  const ecs = createECS();
  const objects = [{ id: 'hero', name: 'Hero', x: 1, y: 2, z: 0 }];
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('hero');
  let observedX = null;
  ecs.registerSystem({
    id: 'test.post-update-transform',
    components: ['Transform'],
    phase: 'postUpdate',
    update(dt, api) {
      api.forEach(['Transform'], (id, transform) => {
        if (id === entity) {
          observedX = transform.x;
          transform.x += 1;
        }
      });
    }
  });

  // This is the same boundary the runtime uses after per-object ps callbacks.
  ecs.applySceneObjectTransforms(objects);
  objects[0].x = 42;
  ecs.syncSceneObjects(objects);
  ecs.updatePhase('postUpdate', 0.016, { sceneObjects: objects });
  ecs.applySceneObjectTransforms(objects);

  assert.equal(observedX, 42);
  assert.equal(objects[0].x, 43);
});

test('Scene Object wins simultaneous editor/legacy and ECS Transform writes; ECS-only changes flow back', () => {
  const ecs = createECS();
  const objects = [{ id: 'object', x: 10, y: 20, z: 0 }];
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('object');
  ecs.getComponent(entity, 'Transform').x = 50;
  objects[0].x = 25;
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.getComponent(entity, 'Transform').x, 25);

  ecs.getComponent(entity, 'Transform').x = 75;
  ecs.syncSceneObjects(objects);
  assert.equal(objects[0].x, 75);
});

test('destroying Scene Objects removes only their bound Entities and leaves standalone ECS state', () => {
  const ecs = createECS();
  ecs.registerComponent('QuestProgress', {
    persistent: false,
    schema: { complete: { type: 'boolean', default: false } }
  });
  const objects = [{ id: 'hero', x: 0, y: 0, z: 0 }, { id: 'enemy', x: 1, y: 0, z: 0 }];
  ecs.syncSceneObjects(objects);
  const hero = ecs.getEntityForSceneObject('hero');
  const enemy = ecs.getEntityForSceneObject('enemy');
  const quest = ecs.createEntity({ QuestProgress: { complete: true } });
  objects.splice(1, 1);
  ecs.syncSceneObjects(objects);
  assert.equal(ecs.getEntityForSceneObject('enemy'), null);
  assert.equal(ecs.getComponent(hero, 'Transform').x, 0);
  assert.equal(ecs.getComponent(quest, 'QuestProgress').complete, true);
  ecs.clearSceneObjects();
  assert.equal(ecs.getEntityForSceneObject('hero'), null);
  assert.equal(ecs.getComponent(quest, 'QuestProgress').complete, true);
  assert.equal(ecs.getEntities(true).includes(enemy), false);
});

test('runtime imports ps callback changes between update callbacks and postUpdate Systems', () => {
  const engine = read('static/pstudio_engine.js');
  const psUpdate = engine.indexOf("if(c.funcs.update)callFunction(c,'update',[dt]);");
  const sync = engine.indexOf('ecsAfterScripts.syncSceneObjects(sceneObjects || []);');
  const post = engine.indexOf("ecsAfterScripts.updatePhase?.('postUpdate', dt, ecsContext);");
  const apply = engine.indexOf('ecsAfterScripts.applySceneObjectTransforms(sceneObjects || []);', post);
  assert.ok(psUpdate >= 0 && sync > psUpdate && post > sync && apply > post);
});
