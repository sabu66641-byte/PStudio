const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createMaterialsRuntime(objects = [{
  id: 'tree', name: 'Tree', x: 100, y: 80, z: 20, w: 100, h: 100,
  model: 'tree.glb', modelScale: 2.5,
  toonMaterialSettings: {
    enabled: true, shadowColor: '#334455', rimIntensity: 1.2,
    outlineWidth: 0.18, windStrength: 0.5, windSpeed: 1.4
  },
  modelMaterialOverrides: [{
    name: 'Bark', roughness: 0.32, diffuseRoughness: 0.44, metalness: 0.08,
    color: '#986543', doubleSide: true, emissive: '#110500',
    emissiveIntensity: 0.4
  }],
  shaderFragment: 'uniform vec3 uColor; void main(){ gl_FragColor=vec4(uColor,1.0); }',
  collider: true,
  postProcessing: { bloom: true, ssao: false, strength: 0.65 },
  particleEmitter: { enabled: true, rate: 30, color: '#ffcc88', speed: 2.5, lifetime: 1.8, maxCount: 220 }
}]) {
  const window = {
    sceneObjects: objects,
    dispatchEvent() {},
    persistProject() {}
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_rendering.js'), sandbox, { filename: 'pstudio_ecs_rendering.js' });
  vm.runInNewContext(read('static/pstudio_ecs_visualfx.js'), sandbox, { filename: 'pstudio_ecs_visualfx.js' });
  vm.runInNewContext(read('static/pstudio_ecs_materials.js'), sandbox, { filename: 'pstudio_ecs_materials.js' });
  return {
    ecs: window.PStudioECS,
    rendering: window.PStudioECSRendering,
    visualfx: window.PStudioECSVisualFX,
    materials: window.PStudioECSMaterials,
    window,
    objects
  };
}

test('render authoring Components are persistent and Inspector-facing', () => {
  const { ecs, materials } = createMaterialsRuntime([]);
  for (const type of ['ToonMaterial', 'MaterialOverrides', 'ShaderMaterial', 'MeshCollider']) {
    const definition = ecs.getComponentDefinition(type);
    assert.equal(definition.persistent, true);
    assert.equal(definition.internal, false);
    assert.equal(definition.readonly, false);
    assert.equal(definition.source, 'pstudio_ecs_materials');
  }
  assert.deepEqual(Array.from(materials.componentTypes), [
    'ToonMaterial', 'MaterialOverrides', 'ShaderMaterial', 'MeshCollider'
  ]);
});

test('legacy Scene Object rendering settings migrate into persistent ECS Components and versioned payload', () => {
  const runtime = createMaterialsRuntime();
  const { ecs, materials } = runtime;
  const object = runtime.objects[0];
  assert.equal(materials.migrateLegacySceneObjects(runtime.objects), 1);
  const entity = ecs.getEntityForSceneObject('tree');
  assert.ok(entity);

  assert.equal(ecs.getComponent(entity, 'Renderable').assetName, 'tree.glb');
  assert.equal(ecs.getComponent(entity, 'Renderable').scale, 2.5);
  const toon = ecs.getComponent(entity, 'ToonMaterial').settings;
  assert.equal(toon.enabled, true);
  assert.equal(toon.shadowColor, '#334455');
  assert.equal(toon.rimIntensity, 1.2);
  assert.equal(toon.windStrength, 0.5);
  assert.equal(ecs.getComponent(entity, 'MaterialOverrides').overrides[0].name, 'Bark');
  assert.equal(ecs.getComponent(entity, 'MaterialOverrides').overrides[0].diffuseRoughness, 0.44);
  assert.equal(ecs.getComponent(entity, 'ShaderMaterial').fragmentShader.startsWith('uniform vec3'), true);
  assert.equal(ecs.getComponent(entity, 'MeshCollider').enabled, true);
  assert.equal(ecs.getComponent(entity, 'PostFX').bloom, true);
  assert.equal(ecs.getComponent(entity, 'PostFX').strength, 0.65);
  assert.equal(ecs.getComponent(entity, 'ParticleEmitter').enabled, true);
  assert.equal(ecs.getComponent(entity, 'ParticleEmitter').rate, 30);

  assert.equal(object.ecsComponentsVersion, 1);
  const savedTypes = object.ecsComponents.map(entry => entry.type).sort();
  assert.deepEqual(Array.from(savedTypes), [
    'MaterialOverrides', 'MeshCollider', 'ParticleEmitter', 'PostFX',
    'Renderable', 'ShaderMaterial', 'ToonMaterial'
  ]);
  for (const legacy of [
    'modelScale', 'toonMaterialSettings', 'modelMaterialOverrides',
    'shaderFragment', 'collider', 'postProcessing', 'particleEmitter'
  ]) assert.equal(Object.prototype.hasOwnProperty.call(object, legacy), false, legacy);
});

test('unknown plugin Component records survive legacy render-setting migration', () => {
  const objects = [{
    id: 'plugin-owner', name: 'Plugin Owner', x: 0, y: 0, z: 0,
    ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'ThirdPartyMaterialConfig', data: { enabled: true, profile: 'soft' } }],
    toonMaterialSettings: { enabled: true, rimIntensity: 0.8 }
  }];
  const runtime = createMaterialsRuntime(objects);
  assert.equal(runtime.materials.migrateLegacySceneObjects(objects), 1);
  const owner = objects[0];
  assert.equal(owner.ecsComponentsVersion, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(owner.ecsComponents.find(entry => entry.type === 'ThirdPartyMaterialConfig'))),
    { type: 'ThirdPartyMaterialConfig', data: { enabled: true, profile: 'soft' } }
  );
  assert.ok(owner.ecsComponents.some(entry => entry.type === 'ToonMaterial'));
  assert.equal(Object.prototype.hasOwnProperty.call(owner, 'toonMaterialSettings'), false);
});

test('future ECS schema is never normalized or mutated by render-setting migration or setters', () => {
  const objects = [{
    id: 'future-owner', name: 'Future Owner', x: 0, y: 0, z: 0,
    ecsComponentsVersion: 9,
    ecsComponents: [{ type: 'FutureMaterial', data: { mode: 'new' } }],
    toonMaterialSettings: { enabled: true, rimIntensity: 1.1 },
    modelScale: 2
  }];
  const before = JSON.stringify(objects[0]);
  const runtime = createMaterialsRuntime(objects);
  assert.equal(runtime.materials.migrateLegacySceneObjects(objects), 0);
  assert.equal(JSON.stringify(objects[0]), before);
  assert.equal(runtime.materials.setToonMaterial('future-owner', { enabled: true }, objects), false);
  assert.equal(JSON.stringify(objects[0]), before);
});

test('ECS render settings feed the renderer in deterministic Toon, override, shader, model order', () => {
  const runtime = createMaterialsRuntime([{ id: 'tree', name: 'Tree', x: 100, y: 80, z: 20, w: 100, h: 100, model: 'tree.glb' }]);
  const { ecs, rendering, materials, objects } = runtime;
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('tree');
  ecs.addComponent(entity, 'Renderable', { kind: 'model', assetName: 'tree.glb', scale: 2.5 });
  assert.equal(materials.setToonMaterial('tree', { enabled: true, rimIntensity: 1.4 }, objects), true);
  assert.equal(materials.setMaterialOverrides('tree', [{
    name: 'Bark', roughness: 0.25, diffuseRoughness: 0.68, metalness: 0.15, color: '#997755'
  }], objects), true);
  assert.equal(materials.setShaderMaterial('tree', 'uniform vec3 uColor; void main(){gl_FragColor=vec4(uColor,1.0);}', objects), true);

  const commands = new Map([['tree', [{
    type: 'model', name: 'tree.glb', x: 0, y: 0, z: 0, scale: 1, ecsRenderableFallback: true
  }]]]);
  rendering.collectCommands(commands, objects, 1 / 60);
  materials.collectCommands(commands, objects);
  const list = commands.get('tree');
  assert.deepEqual(Array.from(list.map(command => command.type)), [
    'toon_material', 'model_material', 'material', 'model'
  ]);
  assert.equal(list[0].toon.rimIntensity, 1.4);
  assert.equal(list[1].name, 'Bark');
  assert.equal(list[1].roughness, 0.25);
  assert.equal(list[1].diffuseRoughness, 0.68);
  assert.equal(list[2].shader, 'custom');
  assert.equal(list[3].scale, 2.5);
  assert.equal(list[3].ecsRenderableFallback, undefined);
});

test('Material snapshots respond immediately to Inspector changes; Shader and MeshCollider setters preserve save state', () => {
  const runtime = createMaterialsRuntime([{ id: 'prop', name: 'Prop', x: 0, y: 0, z: 0, w: 64, h: 64 }]);
  const { ecs, materials, objects } = runtime;
  ecs.syncSceneObjects(objects);
  const entity = ecs.getEntityForSceneObject('prop');
  assert.equal(materials.setToonMaterial('prop', { enabled: true, rimIntensity: 0.5 }, objects), true);
  let commands = new Map();
  materials.collectCommands(commands, objects);
  assert.equal(commands.get('prop')[0].toon.rimIntensity, 0.5);

  ecs.setComponent(entity, 'ToonMaterial', { settings: { enabled: true, rimIntensity: 1.75 } });
  commands = new Map();
  materials.collectCommands(commands, objects);
  assert.equal(commands.get('prop')[0].toon.rimIntensity, 1.75);

  assert.equal(materials.setShaderMaterial('prop', 'void main(){gl_FragColor=vec4(1.0);}', objects), true);
  assert.ok(objects[0].ecsComponents.some(entry => entry.type === 'ShaderMaterial'));
  assert.equal(materials.resetShaderMaterial('prop', objects), true);
  assert.equal(objects[0].ecsComponents.some(entry => entry.type === 'ShaderMaterial'), false);

  assert.equal(materials.setMeshCollider('prop', true, objects), true);
  assert.equal(materials.getMeshCollider('prop', objects), true);
  assert.equal(materials.setMeshCollider('prop', false, objects), true);
  assert.equal(materials.getMeshCollider('prop', objects), false);
});

test('legacy modelScale migrates into Renderable.scale without duplicate authority', () => {
  const objects = [{ id: 'model', name: 'Model', x: 0, y: 0, z: 0, model: 'house.glb', modelScale: 3 }];
  const runtime = createMaterialsRuntime(objects);
  runtime.materials.migrateLegacySceneObjects(objects);
  const entity = runtime.ecs.getEntityForSceneObject('model');
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').scale, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(objects[0], 'modelScale'), false);
  assert.equal(runtime.materials.getRenderableScale('model', objects), 3);
  assert.equal(runtime.materials.setRenderableScale('model', 1.75, objects), true);
  assert.equal(runtime.ecs.getComponent(entity, 'Renderable').scale, 1.75);
  assert.equal(objects[0].ecsComponents.find(entry => entry.type === 'Renderable').data.scale, 1.75);
});
