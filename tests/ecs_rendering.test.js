const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createRenderingRuntime(objects = [
  { id: 'player', name: 'Player', x: 100, y: 50, z: 200, w: 100, h: 80, model: 'hero.glb' },
  { id: 'prop', name: 'Prop', x: 0, y: 0, z: 0, w: 64, h: 64 }
]) {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_rendering.js'), sandbox, { filename: 'pstudio_ecs_rendering.js' });
  const ecs = window.PStudioECS;
  const rendering = window.PStudioECSRendering;
  ecs.syncSceneObjects(objects);
  return { ecs, rendering, objects, window };
}

function build(commands, rendering, ecs, objects, dt = 1 / 60) {
  ecs.updatePhase('postUpdate', dt, { sceneObjects: objects });
  return rendering.collectCommands(commands, objects, dt);
}
function allCommands(commands) { return [...commands.values()].flat(); }

test('Rendering Components are persistent Inspector-facing data, not GPU objects', () => {
  const { ecs, rendering } = createRenderingRuntime();
  for (const type of ['Renderable', 'Camera', 'Light', 'Animation']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true);
    assert.equal(definition.internal, false);
    assert.equal(definition.readonly, false);
  }
  assert.deepEqual(Array.from(rendering.componentTypes), ['Renderable', 'Camera', 'Light', 'Animation']);
});

test('Renderable maps SceneObject transforms to model and primitive renderer commands', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  assert.equal(rendering.attachRenderable('player', {
    kind: 'model', assetName: 'hero.glb',
    useSceneTransform: true, rotationY: 90, scale: 1.5,
    roughness: 0.25, metalness: 0.6
  }), true);
  assert.equal(rendering.attachRenderable('prop', {
    kind: 'box', useSceneTransform: false,
    positionX: 4, positionY: 2, positionZ: -3,
    width: 2, height: 3, depth: 4, color: '#aabbcc'
  }), true);

  const commands = new Map();
  assert.equal(build(commands, rendering, ecs, objects), 2);
  const list = allCommands(commands);
  const model = list.find(item => item.type === 'model');
  const box = list.find(item => item.type === 'box');
  const materials = list.filter(item => item.type === 'material');

  assert.equal(model.name, 'hero.glb');
  assert.equal(model.x, (100 + 50 - 480) / 100);
  assert.equal(model.y, (270 - (50 + 40)) / 100);
  assert.equal(model.z, 2);
  assert.equal(model.rotationY, Math.PI / 2);
  assert.equal(model.scale, 1.5);
  assert.equal(box.x, 4);
  assert.equal(box.y, 2);
  assert.equal(box.z, -3);
  assert.equal(box.width, 2);
  assert.equal(box.height, 3);
  assert.equal(box.depth, 4);
  assert.equal(box.color, '#aabbcc');
  assert.deepEqual(
    JSON.parse(JSON.stringify(materials)),
    [
      { type: 'material', roughness: 0.25, metalness: 0.6 }
    ]
  );
});

test('Primary Camera is deterministic and does not override an explicit ps camera command', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  rendering.attachCamera('prop', { primary: true, x: 1, y: 2, z: 3, targetX: 4, targetY: 5, targetZ: 6, smoothing: 8 });
  rendering.attachCamera('player', { primary: true, x: 7, y: 8, z: 9 });
  let commands = new Map();
  build(commands, rendering, ecs, objects);
  let cameras = allCommands(commands).filter(item => item.type === 'camera');
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].cameraOwnerId, 'player', 'lowest ECS Entity ID wins deterministically');
  assert.deepEqual(
    JSON.parse(JSON.stringify(cameras[0])),
    {
      type: 'camera', x: 7, y: 8, z: 9, targetX: 0, targetY: 0, targetZ: 0,
      smoothing: 0, dt: 1 / 60, cameraOwnerId: 'player'
    }
  );

  commands = new Map([['prop', [{ type: 'camera', x: 90, y: 90, z: 90, targetX: 0, targetY: 0, targetZ: 0 }]]]);
  build(commands, rendering, ecs, objects);
  cameras = allCommands(commands).filter(item => item.type === 'camera');
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].x, 90, 'legacy script-authored camera has precedence');
});

test('Point and spot Light Components map renderer configuration without creating GPU objects', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  rendering.attachLight('player', { kind: 'point', x: 1, y: 2, z: 3, intensity: 4, color: '#112233', distance: 20 });
  rendering.attachLight('prop', {
    kind: 'spot', x: -1, y: 5, z: 2,
    targetX: 1, targetY: 0, targetZ: 2,
    intensity: 6, color: '#abcdef', distance: 30, angle: 0.4
  });
  const commands = new Map();
  build(commands, rendering, ecs, objects);
  const lights = allCommands(commands).filter(item => item.type === 'light');
  assert.equal(lights.length, 2);
  const point = lights.find(item => item.kind === 'point');
  const spot = lights.find(item => item.kind === 'spot');
  assert.equal(point.intensity, 4);
  assert.equal(point.color, '#112233');
  assert.equal(point.distance, 20);
  assert.equal(spot.targetY, 0);
  assert.equal(spot.angle, 0.4);
  assert.equal(spot.intensity, 6);
});

test('Animation Components translate clips, blends, layers and locomotion into existing renderer commands', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  rendering.attachAnimation('player', {
    clipName: 'Run', loop: false, speed: 1.5,
    blendFirst: 'Idle', blendSecond: 'Run', blendWeight: 0.35,
    layers: [
      { clip: 'UpperBody', weight: 0.75, additive: true },
      { clip: '', weight: 1, additive: false }
    ],
    idleClip: 'Idle', walkClip: 'Walk', runClip: 'Run',
    jumpClip: 'Jump', fallClip: 'Fall', landClip: 'Land'
  });
  const commands = new Map();
  build(commands, rendering, ecs, objects);
  const list = commands.get('player');
  assert.ok(list.some(item => item.type === 'animation' && item.clipName === 'Run' && item.loop === false && item.speed === 1.5));
  assert.ok(list.some(item => item.type === 'animation_blend' && item.first === 'Idle' && item.weight === 0.35));
  assert.ok(list.some(item => item.type === 'animation_layer' && item.clip === 'UpperBody' && item.additive === true));
  assert.ok(list.some(item => item.type === 'locomotion' && item.idle === 'Idle' && item.land === 'Land'));
});

test('Disabled render Components are skipped and removing a Component clears its cached snapshot', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  rendering.attachRenderable('prop', { enabled: false, kind: 'sphere' });
  rendering.attachLight('player', { enabled: false });
  let commands = new Map();
  build(commands, rendering, ecs, objects);
  assert.equal(allCommands(commands).length, 0);

  rendering.attachRenderable('prop', { enabled: true, kind: 'sphere', radius: 2 });
  commands = new Map();
  build(commands, rendering, ecs, objects);
  assert.equal(commands.get('prop')[0].type, 'sphere');
  assert.equal(rendering.getStats().renderables, 1);

  const propEntity = ecs.getEntityForSceneObject('prop');
  ecs.removeComponent(propEntity, 'Renderable');
  assert.equal(rendering.getStats().renderables, 0);
  assert.equal(rendering.removeLight('missing'), false);
  assert.equal(rendering.attachCamera('missing'), false);
});

test('ECS rendering commands are collected before Physics and model collider generation', () => {
  const engine = read('static/pstudio_engine.js');
  const collect = engine.indexOf('PStudioECSRendering?.collectCommands?.(commands');
  const collider = engine.indexOf('getModelCollisionTriangles?.(modelDraw)');
  const physics = engine.indexOf('PStudioPhysics?.step?.(dt,physicsCommands)');
  assert.ok(collect >= 0);
  assert.ok(collider > collect);
  assert.ok(physics > collider);
  const transformLoop = engine.slice(engine.indexOf('for(const [id,transform] of transforms)'));
  assert.match(transformLoop, /if\(draw\.type==='light'\)/);
  assert.match(transformLoop, /if\(draw\.type==='camera'\)/);
});

test('Inspector edits update render snapshots immediately without waiting for a Game System tick', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  const entity = ecs.getEntityForSceneObject('prop');
  rendering.attachRenderable('prop', { kind: 'sphere', radius: 1, useSceneTransform: true });
  let commands = new Map();
  assert.equal(rendering.collectCommands(commands, objects, 1 / 60), 1);
  assert.equal(commands.get('prop')[0].type, 'sphere');
  assert.equal(commands.get('prop')[0].radius, 1);

  ecs.setComponent(entity, 'Renderable', { kind: 'sphere', radius: 2 });
  commands = new Map();
  assert.equal(rendering.collectCommands(commands, objects, 1 / 60), 1);
  assert.equal(commands.get('prop')[0].radius, 2);
});

test('Renderable uses Scene Object rotation/model scale and emits material before model', () => {
  const { ecs, rendering, objects } = createRenderingRuntime();
  const player = objects.find(object => object.id === 'player');
  player.rotationX = 15;
  player.rotationY = 45;
  player.rotationZ = -30;
  player.modelScale = 2;
  rendering.attachRenderable('player', {
    kind: 'model', assetName: 'hero.glb', scale: 1.5,
    useSceneTransform: true, roughness: 0.2, metalness: 0.4
  });
  const commands = new Map();
  rendering.collectCommands(commands, objects, 1 / 60);
  const list = commands.get('player');
  const modelIndex = list.findIndex(item => item.type === 'model');
  const materialIndex = list.findIndex(item => item.type === 'material');
  assert.ok(materialIndex >= 0 && materialIndex < modelIndex);
  assert.equal(list[modelIndex].scale, 3);
  assert.equal(list[modelIndex].rotationX, 15 * Math.PI / 180);
  assert.equal(list[modelIndex].rotationY, 45 * Math.PI / 180);
  assert.equal(list[modelIndex].rotationZ, -30 * Math.PI / 180);
});
