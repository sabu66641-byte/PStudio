const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createManager() {
  const events = [];
  const window = { dispatchEvent() {} };
  const sandbox = { window, console: { log(){}, warn(){}, error(){} }, Map, Set, Promise, Date, Number, Object, Array, TypeError, Error };
  vm.runInNewContext(fs.readFileSync('static/pstudio_resources.js', 'utf8'), sandbox);
  return { api: window.PStudioResources, events };
}

test('registers CPU and GPU resources and reports byte accounting', () => {
  const { api } = createManager();
  api.register('texture', 'albedo', { id: 1 }, { category: 'gpu', sizeBytes: 4096 });
  api.register('blob', 'model.glb', { size: 2048 }, { category: 'cpu' });
  const stats = api.stats();
  assert.equal(stats.resourceCount, 2);
  assert.equal(stats.cpuBytes, 2048);
  assert.equal(stats.gpuBytes, 4096);
  assert.equal(api.get('texture', 'albedo').id, 1);
});

test('deduplicates concurrent loads and preserves missing-value semantics', async () => {
  const { api } = createManager();
  let calls = 0;
  let resolveLoader;
  const loader = () => {
    calls++;
    return new Promise(resolve => { resolveLoader = resolve; });
  };
  const first = api.getOrLoad('asset', 'shared', loader);
  const second = api.getOrLoad('asset', 'shared', loader);
  assert.equal(calls, 1);
  resolveLoader({ size: 123 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(api.stats().resourceCount, 1);
  assert.equal(await api.getOrLoad('asset', 'missing', async () => null), null);
  assert.equal(api.get('asset', 'missing'), null);
});

test('reference leases prevent eviction and release exactly once', () => {
  const { api } = createManager();
  let disposed = 0;
  api.register('model', 'hero', {}, { sizeBytes: 100, dispose: () => disposed++ });
  const lease = api.retain('model', 'hero');
  assert.throws(() => api.remove('model', 'hero'), /retained/);
  assert.equal(api.trim('cpu', 0), 0);
  assert.equal(api.stats().retainedCount, 1);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(api.release('model', 'hero'), false);
  assert.equal(disposed, 0);
  assert.equal(api.remove('model', 'hero'), true);
  assert.equal(disposed, 1);
});

test('evicts least-recently-used unretained resources under budget', () => {
  const { api } = createManager();
  const removed = [];
  api.register('blob', 'old', {}, { sizeBytes: 60, dispose: () => removed.push('old') });
  api.register('blob', 'middle', {}, { sizeBytes: 60, dispose: () => removed.push('middle') });
  api.get('blob', 'old');
  api.register('blob', 'new', {}, { sizeBytes: 60, dispose: () => removed.push('new') });
  api.setBudget('cpu', 120);
  assert.deepEqual(Array.from(removed), ['middle']);
  assert.equal(api.get('blob', 'old') !== null, true);
  assert.equal(api.get('blob', 'middle'), null);
  assert.equal(api.get('blob', 'new') !== null, true);
});

test('registration enforces budgets without immediately evicting the new resource', () => {
  const { api } = createManager();
  api.setBudget('cpu', 1000);
  api.register('blob', 'first', {}, { sizeBytes: 800 });
  api.register('blob', 'second', {}, { sizeBytes: 800 });
  assert.equal(api.get('blob', 'first'), null);
  assert.notEqual(api.get('blob', 'second'), null);
  assert.equal(api.stats().cpuBytes, 800);
});

test('CPU and GPU budgets are independent and retained resources survive trimming', () => {
  const { api } = createManager();
  api.register('mesh', 'live', {}, { category: 'gpu', sizeBytes: 500 });
  api.register('blob', 'cache', {}, { category: 'cpu', sizeBytes: 500 });
  const lease = api.retain('mesh', 'live');
  api.setBudget('gpu', 0);
  assert.notEqual(api.get('mesh', 'live'), null);
  assert.equal(api.get('blob', 'cache') !== null, true);
  lease.release();
  api.trim('gpu', 0);
  assert.equal(api.get('mesh', 'live'), null);
});

test('clear skips retained resources unless force is explicit', () => {
  const { api } = createManager();
  api.register('model', 'held', {});
  api.register('blob', 'free', {});
  const lease = api.retain('model', 'held');
  assert.equal(api.clear(), 1);
  assert.notEqual(api.get('model', 'held'), null);
  assert.equal(api.clear({ force: true }), 1);
  assert.equal(api.stats().resourceCount, 0);
  assert.equal(lease.release(), false);
});

test('failed loads are not cached and can be retried', async () => {
  const { api } = createManager();
  await assert.rejects(api.getOrLoad('asset', 'retry', async () => { throw new Error('load failed'); }), /load failed/);
  const value = await api.getOrLoad('asset', 'retry', async () => ({ ok: true }));
  assert.equal(value.ok, true);
  assert.equal(api.stats().resourceCount, 1);
});
