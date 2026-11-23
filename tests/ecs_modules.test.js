const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createModuleRuntime() {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Map, Set, Promise, Date, Object, Array,
    String, Boolean, Number, TypeError, Error, JSON,
    CustomEvent: undefined
  };
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs.js', 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync('static/pstudio_modules.js', 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs_modules.js', 'utf8'), sandbox);
  return {
    ecs: window.PStudioECS,
    modules: window.PStudioModules,
    bridge: window.PStudioECSModules,
    window
  };
}

test('ModuleState is a transient internal mirror and not persisted as a scene Component', () => {
  const { ecs, bridge } = createModuleRuntime();
  const definition = ecs.getComponentDefinition('ModuleState');
  assert.equal(definition.persistent, false);
  assert.equal(definition.internal, true);
  assert.equal(definition.readonly, true);
  assert.equal(bridge.componentType, 'ModuleState');
  assert.deepEqual(Array.from(bridge.list()), []);
});

test('registration, activation and deactivation transitions update the same ECS entity', async () => {
  const { ecs, modules, bridge } = createModuleRuntime();
  let finishActivation, finishDeactivation;
  const activation = new Promise(resolve => { finishActivation = resolve; });
  const deactivation = new Promise(resolve => { finishDeactivation = resolve; });

  modules.register({
    id: 'test.renderer', version: '2.1.0',
    activate: () => activation,
    deactivate: () => deactivation
  });
  const entity = bridge.getEntity('test.renderer');
  assert.ok(Number.isSafeInteger(entity));
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getState('test.renderer'))), {
    id: 'test.renderer', version: '2.1.0', enabled: false, state: 'registered', error: ''
  });

  const enabling = modules.enable('test.renderer');
  await Promise.resolve();
  assert.equal(bridge.getState('test.renderer').state, 'activating');
  finishActivation();
  await enabling;
  assert.equal(bridge.getState('test.renderer').enabled, true);
  assert.equal(bridge.getState('test.renderer').state, 'enabled');
  assert.equal(bridge.getEntity('test.renderer'), entity);

  const disabling = modules.disable('test.renderer');
  await Promise.resolve();
  assert.equal(bridge.getState('test.renderer').state, 'deactivating');
  finishDeactivation();
  await disabling;
  assert.equal(bridge.getState('test.renderer').enabled, false);
  assert.equal(bridge.getState('test.renderer').state, 'registered');
  assert.equal(ecs.getComponent(entity, 'ModuleState').enabled, false);
});

test('activation failures and dependency rollback are reflected in ECS state', async () => {
  const { modules, bridge } = createModuleRuntime();
  modules.register({ id: 'test.base' });
  modules.register({
    id: 'test.failure',
    dependencies: ['test.base'],
    activate: () => { throw new Error('cannot start module'); }
  });
  await assert.rejects(modules.enable('test.failure'), /cannot start module/);
  assert.equal(bridge.getState('test.base').state, 'registered');
  assert.equal(bridge.getState('test.base').enabled, false);
  assert.equal(bridge.getState('test.failure').state, 'error');
  assert.match(bridge.getState('test.failure').error, /cannot start module/);
});

test('unregister removes the ECS mirror; sync rebuilds mirrors after ECS entity reset', async () => {
  const { ecs, modules, bridge } = createModuleRuntime();
  modules.register({ id: 'test.tool' });
  const original = bridge.getEntity('test.tool');
  await modules.enable('test.tool');
  await modules.disable('test.tool');
  assert.equal(modules.unregister('test.tool'), true);
  assert.equal(bridge.getState('test.tool'), null);
  assert.equal(bridge.getStats().moduleCount, 0);

  modules.register({ id: 'test.other' });
  const beforeReset = bridge.getEntity('test.other');
  ecs.clearEntities();
  assert.equal(bridge.getState('test.other'), null);
  assert.equal(bridge.sync(), 1);
  assert.notEqual(bridge.getEntity('test.other'), beforeReset);
  assert.ok(bridge.getEntity('test.tool') === null);
  assert.ok(Number.isSafeInteger(original));
});
