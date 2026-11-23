const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRenderingRuntime(objects) {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_rendering.js'), sandbox, { filename: 'pstudio_ecs_rendering.js' });
  const ecs = window.PStudioECS;
  ecs.syncSceneObjects(objects);
  return { ecs, rendering: window.PStudioECSRendering, objects, window };
}

test('Camera, Light, Renderable and Animation are persistent Inspector Components', () => {
  const { ecs } = createRenderingRuntime([]);
  for (const type of ['Camera', 'Light', 'Renderable', 'Animation']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true, type);
    assert.equal(definition.internal, false, type);
    assert.ok(definition.schema, type);
  }
  assert.equal(ecs.getComponentDefinition('Camera').schema.priority.type, 'integer');
  assert.equal(ecs.getComponentDefinition('Light').schema.kind.type, 'enum');
  assert.equal(ecs.getComponentDefinition('Renderable').schema.visible.type, 'boolean');
  assert.equal(ecs.getComponentDefinition('Animation').schema.clipName.type, 'string');
});

test('Camera selection is deterministic and targets another Scene Object in world coordinates', () => {
  const objects = [
    { id: 'camera-low', x: 0, y: 0, z: 100, w: 100, h: 200 },
    { id: 'camera-main', x: 20, y: 40, z: 0, w: 64, h: 64 },
    { id: 'player', x: 200, y: 100, z: 0, w: 64, h: 64 }
  ];
  const { ecs, rendering } = createRenderingRuntime(objects);
  const low = ecs.getEntityForSceneObject('camera-low');
  const main = ecs.getEntityForSceneObject('camera-main');
  ecs.addComponent(low, 'Camera', { priority: 1 });
  ecs.addComponent(main, 'Camera', {
    priority: 10,
    targetObjectId: 'player',
    offset: { x: 6, y: 5, z: 8 },
    targetOffset: { x: 0, y: 1, z: 0 },
    smoothing: 2
  });

  const commands = new Map([['__scene__', [{ type: 'environment', preset: 'day' }]]]);
  const result = rendering.buildCommands(commands, objects, 0.02);
  const camera = commands.get('__ecs_camera__')[0];
  assert.equal(result.cameraEntity, main);
  assert.equal(camera.cameraOwnerId, 'camera-main');
  assert.equal(camera.x, (20 + 32 - 480) / 100 + 6);
  assert.equal(camera.y, (270 - (40 + 32)) / 100 + 5);
  assert.equal(camera.z, 8);
  assert.equal(camera.targetX, (200 + 32 - 480) / 100);
  assert.equal(camera.targetY, (270 - (100 + 32)) / 100 + 1);
  assert.equal(camera.targetZ, 0);
  assert.equal(camera.smoothing, 2);
  assert.equal(camera.dt, 0.02);
});

test('Light uses existing point/spot draw commands and a stable component identity', () => {
  const objects = [{ id: 'lamp', x: 100, y: 50, z: 200, w: 64, h: 64 }];
  const { ecs, rendering } = createRenderingRuntime(objects);
  const entity = ecs.getEntityForSceneObject('lamp');
  ecs.addComponent(entity, 'Light', {
    kind: 'spot', color: '#88aaff', intensity: 12,
    distance: 80, angle: 0.4,
    targetOffset: { x: 0, y: -2, z: 1 }
  });
  const commands = new Map([['lamp', [{ type: 'cube', x: 0, y: 0, z: 0, size: 1 }]]]);
  rendering.buildCommands(commands, objects);
  const list = commands.get('lamp');
  const light = list[0];
  assert.equal(list[0].type, 'light');
  assert.equal(light.kind, 'spot');
  assert.equal(light.componentKey, 'ecs-light');
  assert.equal(light.x, (100 + 32 - 480) / 100);
  assert.equal(light.y, (270 - (50 + 32)) / 100);
  assert.equal(light.z, 2);
  assert.equal(light.targetY, light.y - 2);
  assert.equal(light.targetZ, 3);
  assert.equal(light.color, '#88aaff');
  assert.equal(light.intensity, 12);

  ecs.setComponent(entity, 'Light', { enabled: false });
  const next = new Map();
  rendering.buildCommands(next, objects);
  assert.equal(next.get('lamp'), undefined, 'disabled lights do not emit renderer commands');
});

test('Renderable visibility and Animation playback intent are projected without owning GPU objects', () => {
  const objects = [{ id: 'hero', x: 0, y: 0, z: 0 }];
  const { ecs, rendering } = createRenderingRuntime(objects);
  const entity = ecs.getEntityForSceneObject('hero');
  ecs.addComponent(entity, 'Renderable', {
    enabled: true, visible: false, castShadow: false, receiveShadow: true
  });
  ecs.addComponent(entity, 'Animation', {
    clipName: 'Run', loop: true, speed: 1.5,
    blendFirst: 'Idle', blendSecond: 'Run', blendWeight: 0.25
  });
  const commands = new Map([['hero', [{ type: 'model', name: 'hero.glb' }]]]);
  rendering.buildCommands(commands, objects, 1 / 30);
  const list = commands.get('hero');
  assert.deepEqual(
    Array.from(list.slice(0, 4), item => item.type),
    ['renderable', 'animation', 'animation_blend', 'model']
  );
  assert.deepEqual(
    { enabled: list[0].enabled, visible: list[0].visible, castShadow: list[0].castShadow, receiveShadow: list[0].receiveShadow },
    { enabled: true, visible: false, castShadow: false, receiveShadow: true }
  );
  assert.equal(rendering.isVisible('hero'), false);
  assert.equal(list[1].clipName, 'Run');
  assert.equal(list[1].speed, 1.5);
  assert.equal(list[1].dt, 1 / 30);
  assert.equal(list[2].weight, 0.25);

  ecs.setComponent(entity, 'Renderable', { visible: true });
  assert.equal(rendering.isVisible('hero'), true);
  ecs.setComponent(entity, 'Animation', { playing: false });
  const stopped = new Map();
  rendering.buildCommands(stopped, objects);
  assert.equal(stopped.get('hero')[1].stop, true);
});

test('stale Scene Object entities are ignored and absent Renderable Components remain visible', () => {
  const objects = [{ id: 'visible' }];
  const { ecs, rendering } = createRenderingRuntime(objects);
  const entity = ecs.getEntityForSceneObject('visible');
  ecs.addComponent(entity, 'Renderable', { visible: false });
  assert.equal(rendering.isVisible('visible'), false);
  ecs.syncSceneObjects([]);
  assert.equal(rendering.isVisible('visible'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(rendering.getState())), { cameras: 0, activeCameras: 0, lights: 0, renderables: 0, animations: 0 });
});

test('engine and renderer consume ECS rendering commands without taking resource ownership', () => {
  const engine = read('static/pstudio_engine.js');
  const renderer = read('static/pstudio_3d_engine.js');
  const html = read('templates/index.html');
  const app = read('app.py');
  for (const token of [
    'window.PStudioECSRendering?.buildCommands?.(commands,sceneObjects||[],1/60)',
    "window.PStudioECSRendering?.isVisible?.(id)!==false",
    'Number(renderState?.activeCameras)>0'
  ]) assert.ok(engine.includes(token), token);
  for (const token of [
    "d.componentKey?String(d.componentKey):commandIndex",
    "if (d.type==='renderable') { renderableCommand=d; continue; }",
    'pstudioRenderableVisible',
    'object.castShadow=castShadow',
    'instance.root.userData.pstudioRenderableVisible!==false'
  ]) assert.ok(renderer.includes(token), token);
  assert.ok(html.includes('pstudio_ecs_rendering.js'));
  for (const type of ['Camera', 'Light', 'Renderable', 'Animation']) assert.ok(app.includes('"'+type+'"'), type);
  assert.doesNotThrow(() => new Function(read('static/pstudio_ecs_rendering.js')));
  assert.doesNotThrow(() => new Function(engine));
  assert.doesNotThrow(() => new Function(renderer));
});
