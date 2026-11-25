const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createUIRuntime() {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs.js', 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs_ui.js', 'utf8'), sandbox);
  return { ecs: window.PStudioECS, ui: window.PStudioECSUI, window };
}

test('UIOverlay is a transient internal singleton and is not project-persistent', () => {
  const { ecs, ui } = createUIRuntime();
  const definition = ecs.getComponentDefinition('UIOverlay');
  assert.equal(definition.persistent, false);
  assert.equal(definition.internal, true);
  assert.equal(definition.readonly, false);
  assert.equal(ui.componentType, 'UIOverlay');
  assert.equal(ui.getOverlay(), null);
  const state = ui.getState();
  assert.equal(state.visible, false);
  assert.equal(ecs.getEntityComponents(ui.getEntity()).length, 1);
});

test('Inventory, quest and dialogue overlays update one stable ECS singleton', () => {
  const { ecs, ui } = createUIRuntime();
  const entity = ui.getEntity();
  assert.equal(ui.open('inventory', 'player-1'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.getOverlay())), {
    type: 'inventory', ownerId: 'player-1'
  });
  assert.equal(ui.getEntity(), entity);

  ui.open('quests', 'player-2');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.getOverlay())), {
    type: 'quests', ownerId: 'player-2'
  });
  ui.open('dialogue');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.getOverlay())), {
    type: 'dialogue', ownerId: ''
  });
  assert.equal(ecs.query(['UIOverlay']).length, 1);
});

test('closing and clearing UI overlays only changes transient ECS state', () => {
  const { ecs, ui } = createUIRuntime();
  const entity = ui.getEntity();
  ui.open('inventory', 'hero');
  assert.equal(ui.close(), true);
  assert.equal(ui.getOverlay(), null);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.getState())), {
    type: 'inventory', ownerId: '', visible: false
  });
  ui.open('dialogue');
  assert.equal(ui.clear(), true);
  assert.equal(ui.getOverlay(), null);
  assert.equal(ui.getEntity(), entity);
});

test('UI overlay singleton is recreated safely after ECS entities are cleared', () => {
  const { ecs, ui } = createUIRuntime();
  const original = ui.getEntity();
  ui.open('dialogue');
  ecs.clearEntities();
  const replacement = ui.getEntity();
  assert.notEqual(replacement, original);
  assert.equal(ui.getOverlay(), null);
  assert.equal(ecs.query(['UIOverlay']).length, 1);
});

test('invalid UI overlay types are rejected without changing current overlay', () => {
  const { ui } = createUIRuntime();
  ui.open('inventory', 'hero');
  assert.throws(() => ui.open('unsupported', 'hero'), /Unsupported UI overlay type/);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.getOverlay())), {
    type: 'inventory', ownerId: 'hero'
  });
});
