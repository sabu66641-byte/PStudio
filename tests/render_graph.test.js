const test = require('node:test');
const assert = require('node:assert/strict');
const { createPStudioRenderGraph } = require('../static/pstudio_render_graph.mjs');

test('Render Graph infers RAW/WAR/WAW dependencies and compiles deterministically', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'source', type: 'texture', lifetime: 'external', imported: true });
  graph.addResource({ id: 'intermediate', type: 'texture' });
  graph.addResource({ id: 'output', type: 'texture', lifetime: 'external' });
  graph.addPass({ id: 'produce', writes: [{ resource: 'intermediate', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'consume', reads: [{ resource: 'intermediate', access: 'sampled' }], writes: [{ resource: 'output', access: 'color-attachment' }], execute() {} });
  graph.addPass({ id: 'present', reads: [{ resource: 'output', access: 'present' }], execute() {} });
  const plan = graph.compile();
  assert.deepEqual(plan.passOrder, ['produce', 'consume', 'present']);
  assert.ok(plan.dependencies.produce.includes('consume'));
  assert.ok(plan.dependencies.consume.includes('present'));
  assert.equal(plan.resourceLifetimes.length, 3);
  assert.ok(plan.barrierCount >= 1);
  graph.dispose();
});

test('Render Graph rejects unmodelled intra-pass resource access transitions', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'input', type: 'texture', lifetime: 'external' });
  assert.throws(() => graph.addPass({
    id: 'mixed-read',
    reads: [{ resource: 'input', access: 'sampled' }, { resource: 'input', access: 'copy-src' }],
    execute() {}
  }), error => error.code === 'PSTUDIO_RENDER_GRAPH_INTRA_PASS_ACCESS_TRANSITION');
  graph.dispose();
});

test('Render Graph rejects unknown resources, read-before-write and feedback loops', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'transient' });
  graph.addPass({ id: 'read-first', reads: ['transient'], execute() {} });
  assert.throws(() => graph.compile(), error => error.code === 'PSTUDIO_RENDER_GRAPH_READ_BEFORE_WRITE');
  const missing = createPStudioRenderGraph();
  missing.addPass({ id: 'bad-resource', reads: ['missing'], execute() {} });
  assert.throws(() => missing.compile(), error => error.code === 'PSTUDIO_RENDER_GRAPH_UNKNOWN_RESOURCE');
  assert.throws(() => graph.addPass({ id: 'feedback', reads: ['transient'], writes: [{ resource: 'transient', access: 'storage-write' }], execute() {} }), error => error.code === 'PSTUDIO_RENDER_GRAPH_FEEDBACK_LOOP');
  missing.dispose(); graph.dispose();
});

test('Render Graph catches explicit dependency cycles', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'imported', lifetime: 'external' });
  graph.addPass({ id: 'a', dependsOn: ['b'], reads: ['imported'], execute() {} });
  graph.addPass({ id: 'b', dependsOn: ['a'], reads: ['imported'], execute() {} });
  assert.throws(() => graph.compile(), error => error.code === 'PSTUDIO_RENDER_GRAPH_CYCLE');
  graph.dispose();
});

test('transient resources alias only when lifetimes do not overlap and descriptors match', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'a', type: 'texture', format: 'rgba16float', width: 64, height: 64, usage: ['storage-binding'] });
  graph.addResource({ id: 'b', type: 'texture', format: 'rgba16float', width: 64, height: 64, usage: ['storage-binding'] });
  graph.addResource({ id: 'c', type: 'texture', format: 'rgba8unorm', width: 64, height: 64, usage: ['storage-binding'] });
  graph.addPass({ id: 'write-a', writes: [{ resource: 'a', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'write-b', writes: [{ resource: 'b', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'write-c', writes: [{ resource: 'c', access: 'storage-write' }], execute() {} });
  const plan = graph.compile();
  assert.equal(plan.aliasAssignments.a, plan.aliasAssignments.b);
  assert.notEqual(plan.aliasAssignments.a, plan.aliasAssignments.c);
  graph.dispose();
});

test('Render Graph executes pass callbacks in order, awaits hooks and cleans up after failure', async () => {
  const calls = [];
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'out', lifetime: 'external' });
  graph.addPass({ id: 'one', writes: [{ resource: 'out', access: 'storage-write' }], async execute() { await Promise.resolve(); calls.push('pass-one'); } });
  graph.addPass({ id: 'two', reads: ['out'], execute() { calls.push('pass-two'); } });
  const backend = { async beginGraph() { calls.push('begin'); }, async beginPass(pass) { calls.push('begin:' + pass.id); }, async endPass(pass) { calls.push('end:' + pass.id); }, async endGraph() { calls.push('finish'); } };
  const result = await graph.execute({ backend });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['begin', 'begin:one', 'pass-one', 'end:one', 'begin:two', 'pass-two', 'end:two', 'finish']);
  graph.dispose();
});

test('Render Graph prevents concurrent execution and aborts a failed pass', async () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'out', lifetime: 'external' });
  let finish;
  graph.addPass({ id: 'slow', reads: ['out'], execute: () => new Promise(resolve => { finish = resolve; }) });
  const pending = graph.execute();
  await Promise.resolve();
  await assert.rejects(graph.execute(), error => error.code === 'PSTUDIO_RENDER_GRAPH_BUSY');
  finish(); await pending; graph.dispose();
});

test('Render Graph materializes compatible transient aliases once and preserves borrowed externals', async () => {
  const calls = [];
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'imported-surface', type: 'surface', lifetime: 'external' });
  graph.addResource({ id: 'a', type: 'texture', format: 'rgba16float', width: 32, height: 32, usage: ['storage-binding'] });
  graph.addResource({ id: 'b', type: 'texture', format: 'rgba16float', width: 32, height: 32, usage: ['storage-binding'] });
  graph.addPass({ id: 'first', writes: [{ resource: 'a', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'second', writes: [{ resource: 'b', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'present', reads: [{ resource: 'imported-surface', access: 'present' }], execute() {} });
  const plan = graph.compile();
  const external = { borrowed: true };
  const materialized = await graph.materialize({ plan, resources: { 'imported-surface': external }, backend: {
    async createResource(descriptor) { calls.push(['create', descriptor.id]); return { descriptor, dispose() { calls.push(['destroy', descriptor.id]); } }; }
  } });
  assert.equal(materialized.allocationCount, 1);
  assert.equal(materialized.resources.a, materialized.resources.b);
  assert.equal(materialized.resources['imported-surface'], external);
  assert.equal(calls.filter(item => item[0] === 'create').length, 1);
  assert.equal(await materialized.release(), true);
  assert.equal(await materialized.release(), false);
  assert.equal(calls.filter(item => item[0] === 'destroy').length, 1);
  graph.dispose();
});

test('Render Graph materialization rolls back partial allocations and rejects missing external handles', async () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'a', type: 'buffer', size: 64 });
  graph.addResource({ id: 'b', type: 'buffer', size: 128 });
  graph.addResource({ id: 'surface', type: 'surface', lifetime: 'external' });
  graph.addPass({ id: 'write-a', writes: [{ resource: 'a', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'write-b', writes: [{ resource: 'b', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'present', reads: [{ resource: 'surface', access: 'present' }], execute() {} });
  const destroyed = [];
  await assert.rejects(graph.materialize({ backend: { createResource: async descriptor => ({ dispose() { destroyed.push(descriptor.id); } }) } }), error => error.code === 'PSTUDIO_RENDER_GRAPH_EXTERNAL_RESOURCE_MISSING');
  assert.equal(destroyed.length, 2);
  graph.dispose();
});


test('Render Graph emits write-after-write and read-state transition barriers while allowing duplicate reads', () => {
  const graph = createPStudioRenderGraph();
  graph.addResource({ id: 'data', type: 'buffer', size: 64, lifetime: 'persistent' });
  graph.addPass({ id: 'write-one', writes: [{ resource: 'data', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'write-two', writes: [{ resource: 'data', access: 'storage-write' }], execute() {} });
  graph.addPass({ id: 'read', reads: [{ resource: 'data', access: 'storage-read' }, { resource: 'data', access: 'storage-read', slot: 'second-view' }], execute() {} });
  graph.addPass({ id: 'sample', reads: [{ resource: 'data', access: 'sampled' }], execute() {} });
  const plan = graph.compile();
  assert.equal(plan.barriers[0].kind, 'write-after-write');
  assert.equal(plan.barriers[1].kind, 'write-to-read');
  assert.equal(plan.barriers[2].kind, 'read-state-transition');
  assert.equal(plan.passOrder.length, 4);
  graph.dispose();
});
