const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createVisualFXRuntime(objects = [
  { id: 'environment', name: 'Environment', x: 0, y: 0, z: 0, w: 64, h: 64 },
  { id: 'fog', name: 'Fog', x: 0, y: 0, z: 0, w: 64, h: 64 },
  { id: 'water', name: 'Water', x: 100, y: 50, z: 200, w: 100, h: 80 },
  { id: 'player', name: 'Player', x: 20, y: 30, z: 40, w: 64, h: 64 },
  { id: 'target', name: 'Target', x: 300, y: 200, z: 500, w: 64, h: 64 }
], physicsPositions = {}) {
  const window = {
    dispatchEvent() {},
    PStudioPhysics: {
      getPosition(id) {
        return physicsPositions[String(id)] || null;
      }
    }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_visualfx.js'), sandbox, { filename: 'pstudio_ecs_visualfx.js' });
  const ecs = window.PStudioECS;
  const visualfx = window.PStudioECSVisualFX;
  ecs.syncSceneObjects(objects);
  return { ecs, visualfx, objects, window };
}

function collect(runtime, commands = new Map(), dt = 1 / 60, updateSystems = true) {
  if (updateSystems) runtime.ecs.updatePhase('postUpdate', dt, { sceneObjects: runtime.objects });
  const added = runtime.visualfx.collectCommands(commands, runtime.objects, dt);
  return { commands, added, all: [...commands.values()].flat() };
}

test('Visual FX Components are persistent Inspector-facing configuration, not GPU resources', () => {
  const { ecs, visualfx } = createVisualFXRuntime();
  for (const type of ['Environment', 'Fog', 'Water', 'PostFX', 'ParticleEmitter', 'Trail']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true);
    assert.equal(definition.internal, false);
    assert.equal(definition.readonly, false);
    assert.equal(definition.source, 'pstudio_ecs_visualfx');
  }
  assert.deepEqual(Array.from(visualfx.componentTypes), [
    'Environment', 'Fog', 'Water', 'PostFX', 'ParticleEmitter', 'Trail'
  ]);
  assert.equal(ecs.getSystems().filter(system => system.source === 'pstudio_ecs_visualfx').length, 6);
});

test('Environment and Fog Components merge deterministically before legacy ps environment commands', () => {
  const runtime = createVisualFXRuntime();
  assert.equal(runtime.visualfx.attachEnvironment('environment', {
    background: '#112233', environmentSky: '#445566',
    environmentIntensity: 1.4, lightIntensity: 2.2
  }), true);
  assert.equal(runtime.visualfx.attachFog('fog', {
    color: '#aabbcc', near: 20, far: 900
  }), true);
  const commands = new Map([['legacy', [{ type: 'environment', background: '#000000' }]]]);
  const result = collect(runtime, commands);
  assert.equal(result.added, 1);
  assert.equal(commands.keys().next().value, '__pstudio_ecs_visualfx_global__');
  assert.equal(result.all[0].type, 'environment');
  assert.equal(result.all[0].background, '#112233');
  assert.equal(result.all[0].environmentSky, '#445566');
  assert.equal(result.all[0].environmentIntensity, 1.4);
  assert.equal(result.all[0].lightIntensity, 2.2);
  assert.equal(result.all[0].fogColor, '#aabbcc');
  assert.equal(result.all[0].fogNear, 20);
  assert.equal(result.all[0].fogFar, 900);
  assert.equal(result.all[1].background, '#000000', 'legacy ps command follows and can override the Component default');
});

test('PostFX chooses one deterministic primary configuration and keeps script commands later', () => {
  const runtime = createVisualFXRuntime();
  runtime.visualfx.attachPostFX('fog', { bloom: true, ssao: true, strength: 1.25 });
  runtime.visualfx.attachPostFX('environment', { bloom: false, ssao: false, strength: 0.7 });
  const commands = new Map([['legacy', [{ type: 'postfx', bloom: false, ssao: false, strength: 0.4 }]]]);
  const result = collect(runtime, commands);
  const post = result.all.filter(command => command.type === 'postfx');
  assert.equal(post.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(post[0])),
    { type: 'postfx', bloom: false, ssao: false, strength: 0.7 }
  );
  assert.equal(post[1].strength, 0.4);
  assert.equal(commands.keys().next().value, '__pstudio_ecs_visualfx_global__');
});

test('Water Component maps Scene Object coordinates, dimensions, color and opacity', () => {
  const runtime = createVisualFXRuntime();
  runtime.visualfx.attachWater('water', {
    width: 250, depth: 300, color: '#2288aa', opacity: 0.45
  });
  const result = collect(runtime);
  const water = result.all.find(command => command.type === 'water');
  assert.deepEqual(JSON.parse(JSON.stringify(water)), {
    type: 'water', x: -3.3, y: 1.8, z: 2,
    width: 250, depth: 300, color: '#2288aa', opacity: 0.45
  });
});

test('Water can use explicit world coordinates without Scene Object transform coupling', () => {
  const runtime = createVisualFXRuntime();
  runtime.visualfx.attachWater('water', {
    useSceneTransform: false, positionX: 12, positionY: -3, positionZ: 8
  });
  const water = collect(runtime).all.find(command => command.type === 'water');
  assert.deepEqual([water.x, water.y, water.z], [12, -3, 8]);
});

test('ParticleEmitter follows physics position, applies offsets and forwards bounded simulation settings', () => {
  const runtime = createVisualFXRuntime(undefined, {
    player: { x: 4, y: 5, z: 6 }
  });
  runtime.visualfx.attachParticleEmitter('player', {
    emitterId: 'flame', offsetX: 0.5, offsetY: 1, offsetZ: -0.25,
    rate: 45, color: '#ff8800', speed: 3, lifetime: 2.5, maxCount: 256
  });
  const emitter = collect(runtime).all.find(command => command.type === 'particle_emitter');
  assert.deepEqual(JSON.parse(JSON.stringify(emitter)), {
    type: 'particle_emitter', emitterId: 'flame',
    x: 4.5, y: 6, z: 5.75, rate: 45, color: '#ff8800',
    speed: 3, lifetime: 2.5, maxCount: 256, dt: 1 / 60
  });
});

test('Trail can follow another Scene Object and use its current physics position', () => {
  const runtime = createVisualFXRuntime(undefined, {
    target: { x: 10, y: 20, z: 30 }
  });
  runtime.visualfx.attachTrail('player', {
    targetObjectId: 'target', color: '#00ffff', width: 0.08,
    duration: 1.5, offsetX: 1, offsetY: -2, offsetZ: 0.5
  });
  const trail = collect(runtime).all.find(command => command.type === 'trail');
  assert.deepEqual(JSON.parse(JSON.stringify(trail)), {
    type: 'trail', targetId: 'target',
    x: 11, y: 18, z: 30.5, color: '#00ffff',
    width: 0.08, duration: 1.5, dt: 1 / 60
  });
});

test('Inspector edits and Component removal update render snapshots without waiting for a System tick', () => {
  const runtime = createVisualFXRuntime();
  const entity = runtime.ecs.getEntityForSceneObject('water');
  runtime.visualfx.attachWater('water', { width: 100 });
  let water = collect(runtime, new Map(), 1 / 60, false).all.find(command => command.type === 'water');
  assert.equal(water.width, 100);

  runtime.ecs.setComponent(entity, 'Water', { width: 320 });
  water = collect(runtime, new Map(), 1 / 60, false).all.find(command => command.type === 'water');
  assert.equal(water.width, 320);

  runtime.ecs.removeComponent(entity, 'Water');
  assert.equal(collect(runtime, new Map(), 1 / 60, false).all.some(command => command.type === 'water'), false);
});

test('Disabled Components and missing Trail targets do not produce stale renderer commands', () => {
  const runtime = createVisualFXRuntime();
  runtime.visualfx.attachWater('water', { enabled: false });
  runtime.visualfx.attachTrail('player', { targetObjectId: 'does-not-exist' });
  const result = collect(runtime);
  assert.equal(result.all.some(command => command.type === 'water' || command.type === 'trail'), false);
});

test('clear drops only ECS snapshots; renderer resource cleanup remains external', () => {
  const runtime = createVisualFXRuntime();
  runtime.visualfx.attachWater('water', {});
  collect(runtime);
  assert.equal(runtime.visualfx.getStats().water, 1);
  assert.equal(runtime.visualfx.clear(), true);
  assert.equal(runtime.visualfx.getStats().water, 0);
});
