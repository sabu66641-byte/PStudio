const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createManager() {
  const sandbox = {
    window: { dispatchEvent() {} },
    console,
    Date,
    Map,
    Set,
    Promise,
    CustomEvent: undefined
  };
  vm.runInNewContext(fs.readFileSync('static/pstudio_modules.js', 'utf8'), sandbox);
  return sandbox.window.PStudioModules;
}

test('resolves and activates dependencies before dependents', async () => {
  const api = createManager();
  const order = [];
  api.register({ id: 'test.base', activate: () => order.push('base') });
  api.register({ id: 'test.render', dependencies: ['test.base'], activate: () => order.push('render') });
  await api.enable('test.render');
  assert.deepEqual(order, ['base', 'render']);
  assert.deepEqual(Array.from(api.resolveOrder(['test.render']), item => item.id), ['test.base', 'test.render']);
});

test('blocks disabling dependencies with active dependents; cascade disables in reverse order', async () => {
  const api = createManager();
  const order = [];
  api.register({ id: 'test.base', deactivate: () => order.push('base') });
  api.register({ id: 'test.render', dependencies: ['test.base'], deactivate: () => order.push('render') });
  await api.enable('test.render');
  await assert.rejects(api.disable('test.base'), /enabled dependents/);
  await api.disable('test.base', { cascade: true });
  assert.deepEqual(order, ['render', 'base']);
  assert.equal(api.get('test.base').enabled, false);
  assert.equal(api.get('test.render').enabled, false);
});

test('rolls back dependencies if activation fails', async () => {
  const api = createManager();
  let deactivated = 0;
  api.register({ id: 'test.base', deactivate: () => { deactivated++; } });
  api.register({ id: 'test.fail', dependencies: ['test.base'], activate: () => { throw new Error('expected failure'); } });
  await assert.rejects(api.enable('test.fail'), /expected failure/);
  assert.equal(api.get('test.base').enabled, false);
  assert.equal(deactivated, 1);
  assert.equal(api.get('test.fail').state, 'error');
});

test('detects missing dependencies, cycles and conflicts', async () => {
  const api = createManager();
  api.register({ id: 'test.missing', dependencies: ['test.unknown'] });
  assert.throws(() => api.resolveOrder(['test.missing']), /not registered/);
  api.register({ id: 'test.cyclea', dependencies: ['test.cycleb'] });
  api.register({ id: 'test.cycleb', dependencies: ['test.cyclea'] });
  assert.throws(() => api.resolveOrder(['test.cyclea']), /cycle/);
  api.register({ id: 'test.one', conflicts: ['test.two'] });
  api.register({ id: 'test.two' });
  await api.enable('test.one');
  await assert.rejects(api.enable('test.two'), /conflict/);
});

test('prevents unregister while asynchronous activation is in progress', async () => {
  const api = createManager();
  let finishActivation;
  const activation = new Promise(resolve => { finishActivation = resolve; });
  api.register({ id: 'test.pending', activate: () => activation });
  const enabling = api.enable('test.pending');
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => api.unregister('test.pending'), /operation is in progress/);
  finishActivation();
  await enabling;
  assert.equal(api.get('test.pending').enabled, true);
});
test('supports lifecycle event subscriptions and unregister guards', async () => {
  const api = createManager();
  const events = [];
  api.on('enabled', event => events.push(event.detail.id));
  api.register({ id: 'test.tool' });
  await api.enable('test.tool');
  assert.deepEqual(events, ['test.tool']);
  assert.throws(() => api.unregister('test.tool'), /Disable module/);
  await api.disable('test.tool');
  assert.equal(api.unregister('test.tool'), true);
});

test('emits explicit state changes for activating, enabled, deactivating and registered transitions', async () => {
  const api = createManager();
  const states = [];
  api.on('state-changed', event => states.push(event.detail.state));
  api.register({ id: 'test.transitions' });
  await api.enable('test.transitions');
  await api.disable('test.transitions');
  assert.deepEqual(states, ['activating', 'enabled', 'deactivating', 'registered']);
});
test('publishes failed activation and rollback states to lifecycle observers', async () => {
  const api = createManager();
  const states = [];
  api.on('state-changed', event => states.push([event.detail.id, event.detail.state]));
  api.register({ id: 'test.base' });
  api.register({ id: 'test.fail', dependencies: ['test.base'], activate: () => { throw new Error('activation error'); } });
  await assert.rejects(api.enable('test.fail'), /activation error/);
  assert.deepEqual(states, [
    ['test.base', 'activating'],
    ['test.base', 'enabled'],
    ['test.fail', 'activating'],
    ['test.base', 'registered'],
    ['test.fail', 'error']
  ]);
});
