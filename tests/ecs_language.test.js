const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ecsSource = fs.readFileSync(path.join(root, 'static', 'pstudio_ecs.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

function createECS() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = { window, console, Map, Set, Promise, Date, Number, Object, Array, TypeError, Error };
  vm.runInNewContext(ecsSource, sandbox);
  return window.PStudioECS;
}

test('runtime interpreter supports safe component member reads and writes', () => {
  assert.match(runtime, /case 'MemberExpr': \{/);
  assert.match(runtime, /case 'MemberAssignment': setTarget/);
  assert.match(runtime, /case 'MemberCompoundAssignment':/);
  assert.match(runtime, /\['__proto__','prototype','constructor'\]/);
});

test('Play lifecycle registers ps-defined Components and Systems through PStudioECS', () => {
  assert.match(runtime, /function registerEcsRuntime\(asts\)/);
  assert.match(runtime, /ecs\.registerComponent\(name,/);
  assert.match(runtime, /ecs\.registerSystem\(/);
  assert.match(runtime, /api\.forEach\(componentNames/);
  assert.match(runtime, /c\.env\[ecsBindingName\(component\)\]=values\[index\]/);
  assert.match(runtime, /registerEcsRuntime\(data\.scripts\)/);
  assert.match(runtime, /cleanupEcsRuntime\(\)/);
});

test('system identifiers are namespaced by source file and use deterministic safe IDs', () => {
  assert.match(runtime, /function ecsSystemRuntimeId\(filename,systemName\)/);
  assert.match(runtime, /return 'ps\.'\+\(hash>>>0\)\.toString\(36\)/);
});

test('custom component definitions can be cleanly unregistered after scene entities are removed', () => {
  const ecs = createECS();
  assert.equal(typeof ecs.unregisterComponent, 'function');
  assert.equal(ecs.hasComponentType('Transform'), true);
  assert.equal(ecs.hasComponentType('EnemyAI'), false);
  ecs.registerComponent('EnemyAI', { create: () => ({ speed: 3 }) });
  assert.equal(ecs.hasComponentType('EnemyAI'), true);
  const entity = ecs.createEntity({ EnemyAI: { speed: 5 } });
  assert.throws(() => ecs.unregisterComponent('EnemyAI'), /entities still contain/);
  ecs.destroyEntity(entity);
  assert.equal(ecs.unregisterComponent('EnemyAI'), true);
  assert.equal(ecs.hasComponentType('EnemyAI'), false);
});

test('component types required by registered systems cannot be removed prematurely', () => {
  const ecs = createECS();
  ecs.registerComponent('EnemyAI', { create: () => ({ speed: 1 }) });
  ecs.registerSystem({ id: 'ps.test', components: ['EnemyAI'], update() {} });
  assert.throws(() => ecs.unregisterComponent('EnemyAI'), /System still requires/);
  ecs.unregisterSystem('ps.test');
  assert.equal(ecs.unregisterComponent('EnemyAI'), true);
});

test('ps ECS grammar and AST nodes are documented as game-only declarations', () => {
  assert.match(app, /"type": "ComponentDef"/);
  assert.match(app, /"type": "SystemDef"/);
  assert.match(app, /MemberExpr/);
  assert.match(app, /MemberCompoundAssignment/);
  assert.match(app, /validate_ast\(tree, allow_game=True, external_components=external\)/);
});
