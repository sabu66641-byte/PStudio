const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const surfaceModule = import('../static/pstudio_rendering_surface_tsl.mjs');

const modules = Promise.all([
  import('three/webgpu'),
  import('three/tsl'),
  import('../static/pstudio_rendering_materials.mjs'),
  import('../static/pstudio_rendering_backend.mjs'),
  import('../static/pstudio_rendering_pipeline.mjs'),
  import('../static/pstudio_rendering_environment_tsl.mjs'),
  import('../static/pstudio_rendering_migration.mjs')
]);

test('shared WebGPU backend reports capabilities and refuses unavailable GPU contexts', async () => {
  const [, , , backend] = await modules;
  assert.equal(backend.isPStudioWebGPUAvailable({}), false);
  assert.equal(backend.isPStudioWebGPUAvailable({ gpu: { requestAdapter: async () => ({}) } }), true);
  assert.equal(backend.isPStudioWebGPUBackend({ backend: { isWebGPUBackend: true } }), true);
  assert.equal(backend.isPStudioWebGPUBackend({ backend: { isWebGPUBackend: false } }), false);
  await assert.rejects(
    backend.createPStudioWebGPUBackend({ canvas: {}, navigatorRef: {} }),
    (error) => error.code === 'PSTUDIO_WEBGPU_UNAVAILABLE'
  );
});

test('legacy MeshStandardMaterial is copied into a TSL NodeMaterial with PBR maps and state', async () => {
  const [THREE, , materials] = await modules;
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  const source = new THREE.MeshStandardMaterial({
    color: 0xb4c8de,
    map: texture,
    roughness: 0.37,
    metalness: 0.24,
    roughnessMap: texture
  });
  source.userData = { pstudioAssetId: 'material-std-01', nested: { preserved: true } };

  const target = materials.createPStudioNodePBRMaterial(source);
  assert.equal(target.isMeshStandardNodeMaterial, true);
  assert.equal(target.isMeshPhysicalNodeMaterial, undefined);
  assert.equal(target.map, texture);
  assert.equal(target.roughnessMap, texture);
  assert.equal(target.color.getHex(), source.color.getHex());
  assert.equal(target.roughness, 0.37);
  assert.equal(target.metalness, 0.24);
  assert.equal(target.userData.pstudioAssetId, 'material-std-01');
  assert.equal(target.userData.nested.preserved, true);
  assert.equal(target.userData.pstudioRenderingBackend, 'webgpu-tsl');
  assert.notEqual(target.onBeforeCompile, source.onBeforeCompile);

  target.dispose();
  source.dispose();
  texture.dispose();
});

test('built-in Basic, Lambert, Phong, Toon and Matcap materials convert to matching TSL NodeMaterials', async () => {
  const [THREE, , materials] = await modules;
  const cases = [
    ['MeshBasicMaterial', 'MeshBasicNodeMaterial', () => new THREE.MeshBasicMaterial({ color: 0x8aaacc })],
    ['MeshLambertMaterial', 'MeshLambertNodeMaterial', () => new THREE.MeshLambertMaterial({ color: 0x8aaacc })],
    ['MeshPhongMaterial', 'MeshPhongNodeMaterial', () => new THREE.MeshPhongMaterial({ color: 0x8aaacc, shininess: 42 })],
    ['MeshToonMaterial', 'MeshToonNodeMaterial', () => new THREE.MeshToonMaterial({ color: 0x8aaacc })],
    ['MeshMatcapMaterial', 'MeshMatcapNodeMaterial', () => new THREE.MeshMatcapMaterial({ color: 0x8aaacc })]
  ];
  for (const [sourceType, nodeType, create] of cases) {
    assert.equal(typeof THREE[nodeType], 'function', nodeType + ' export');
    const source = create();
    const target = materials.createPStudioNodeMaterial(source);
    assert.equal(target.type, nodeType);
    assert.equal(target.userData.pstudioNodeMaterialType, nodeType);
    assert.equal(target.color.getHex(), source.color.getHex());
    target.dispose();
    source.dispose();
  }
});

test('normal, line, point and sprite renderables convert to their matching TSL NodeMaterials', async () => {
  const [THREE, , materials] = await modules;
  const cases = [
    ['MeshNormalMaterial', 'MeshNormalNodeMaterial', () => new THREE.MeshNormalMaterial(), g => new THREE.Mesh(g, new THREE.MeshNormalMaterial())],
    ['LineBasicMaterial', 'LineBasicNodeMaterial', () => new THREE.LineBasicMaterial(), g => new THREE.Line(g, new THREE.LineBasicMaterial())],
    ['LineDashedMaterial', 'LineDashedNodeMaterial', () => new THREE.LineDashedMaterial({ dashSize: 2, gapSize: 1 }), g => new THREE.LineSegments(g, new THREE.LineDashedMaterial())],
    ['PointsMaterial', 'PointsNodeMaterial', () => new THREE.PointsMaterial({ size: 0.2 }), g => new THREE.Points(g, new THREE.PointsMaterial({ size: 0.2 }))],
    ['SpriteMaterial', 'SpriteNodeMaterial', () => new THREE.SpriteMaterial(), () => new THREE.Sprite(new THREE.SpriteMaterial())]
  ];
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0], 3));
  const sources = [];
  for (const [sourceType, nodeType, create, makeObject] of cases) {
    assert.equal(typeof THREE[nodeType], 'function', nodeType + ' export');
    const source = create();
    sources.push(source);
    const direct = materials.createPStudioNodeMaterial(source);
    assert.equal(direct.type, nodeType, sourceType);
    direct.dispose();
    const object = makeObject(geometry);
    scene.add(object);
  }
  const result = materials.convertPStudioScenePBRMaterials(scene);
  assert.equal(result.convertedObjects, 5);
  assert.equal(result.convertedMeshes, 1);
  assert.equal(result.convertedMaterials, 5);
  assert.equal(result.restore(), true);
  for (const source of sources) source.dispose();
  geometry.dispose();
});

test('direct TSL conversion refuses to silently discard custom GLSL hooks', async () => {
  const [THREE, , materials] = await modules;
  const source = new THREE.MeshStandardMaterial();
  source.onBeforeCompile = () => {};
  assert.throws(
    () => materials.createPStudioNodeMaterial(source),
    /custom GLSL hooks/
  );
  source.dispose();
});

test('scene converter handles shared built-in material families and preserves unsupported materials', async () => {
  const [THREE, , materials] = await modules;
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const basic = new THREE.MeshBasicMaterial({ color: 0x123456 });
  const phong = new THREE.MeshPhongMaterial({ shininess: 24 });
  const shader = new THREE.ShaderMaterial();
  const first = new THREE.Mesh(geometry, basic);
  const second = new THREE.Mesh(geometry, basic);
  const third = new THREE.Mesh(geometry, phong);
  const fourth = new THREE.Mesh(geometry, shader);
  scene.add(first, second, third, fourth);

  const result = materials.convertPStudioScenePBRMaterials(scene);
  assert.equal(result.convertedMeshes, 3);
  assert.equal(result.convertedMaterials, 2);
  assert.equal(result.convertedByType.MeshBasicNodeMaterial, 1);
  assert.equal(result.convertedByType.MeshPhongNodeMaterial, 1);
  assert.equal(result.skippedMaterials, 1);
  assert.equal(first.material, second.material);
  assert.equal(fourth.material, shader);
  assert.equal(result.restore(), true);
  assert.equal(first.material, basic);
  assert.equal(third.material, phong);
  assert.equal(fourth.material, shader);

  basic.dispose();
  phong.dispose();
  shader.dispose();
  geometry.dispose();
});

test('legacy MeshPhysicalMaterial retains r187 extended PBR values and texture bindings', async () => {
  const [THREE, , materials] = await modules;
  const diffuseRoughnessMap = new THREE.Texture();
  const clearcoatNormalMap = new THREE.Texture();
  const source = new THREE.MeshPhysicalMaterial({
    color: 0xd8c5a7,
    roughness: 0.19,
    metalness: 0.08,
    clearcoat: 0.72,
    clearcoatRoughness: 0.13,
    diffuseRoughness: 0.63,
    diffuseRoughnessMap,
    clearcoatNormalMap,
    iridescence: 0.4,
    iridescenceIOR: 1.32
  });
  source.iridescenceThicknessMinimum = 120;
  source.iridescenceThicknessMaximum = 380;

  const target = materials.createPStudioNodePBRMaterial(source);
  assert.equal(target.isMeshPhysicalNodeMaterial, true);
  assert.equal(target.clearcoat, 0.72);
  assert.equal(target.clearcoatRoughness, 0.13);
  assert.equal(target.diffuseRoughness, 0.63);
  assert.equal(target.diffuseRoughnessMap, diffuseRoughnessMap);
  assert.equal(target.clearcoatNormalMap, clearcoatNormalMap);
  assert.equal(target.iridescence, 0.4);
  assert.equal(target.iridescenceIOR, 1.32);
  assert.equal(target.iridescenceThicknessMinimum, 120);
  assert.equal(target.iridescenceThicknessMaximum, 380);

  target.dispose();
  source.dispose();
  diffuseRoughnessMap.dispose();
  clearcoatNormalMap.dispose();
});

test('scene conversion reuses one NodeMaterial for shared source materials and can restore', async () => {
  const [THREE, , materials] = await modules;
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const source = new THREE.MeshStandardMaterial({ roughness: 0.41, metalness: 0.17 });
  const first = new THREE.Mesh(geometry, source);
  const second = new THREE.Mesh(geometry, source);
  scene.add(first, second);

  const result = materials.convertPStudioScenePBRMaterials(scene);
  assert.equal(result.convertedMeshes, 2);
  assert.equal(result.convertedMaterials, 1);
  assert.equal(first.material, second.material);
  assert.equal(first.material.isMeshStandardNodeMaterial, true);

  result.restore();
  assert.equal(first.material, source);
  assert.equal(second.material, source);

  source.dispose();
  geometry.dispose();
});

test('RenderPipeline requires WebGPU and composes a TSL scene pass with Bloom', async () => {
  const [THREE, TSL, , , pipelineModule] = await modules;
  assert.equal(typeof TSL.pass, 'function');
  assert.equal(typeof THREE.RenderPipeline, 'function');
  assert.throws(
    () => pipelineModule.createPStudioRenderPipeline(
      { backend: { isWebGPUBackend: false } },
      new THREE.Scene(),
      new THREE.PerspectiveCamera()
    ),
    /requires an initialized WebGPU backend/
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const renderer = {
    backend: { isWebGPUBackend: true },
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: false }
  };
  const pipeline = pipelineModule.createPStudioRenderPipeline(renderer, scene, camera, {
    bloom: { strength: 0.2, radius: 0.3, threshold: 0.8 }
  });
  assert.equal(pipeline.kind, 'webgpu-tsl-render-pipeline');
  assert.equal(pipeline.getState().bloom.strength, 0.2);
  assert.equal(pipeline.getState().bloom.radius, 0.3);
  assert.equal(pipeline.getState().bloom.threshold, 0.8);
  assert.equal(pipeline.getFrameResources().attachments.includes('metalrough'), true);
  assert.equal(pipeline.getState().frameResources.metalRoughEncoding, 'rg-unorm8');
  assert.equal(pipeline.setBloom(false), true);
  assert.equal(pipeline.getState().bloom, null);
  assert.equal(pipeline.dispose(), true);
  assert.equal(pipeline.dispose(), false);

  const effectsPipeline = pipelineModule.createPStudioRenderPipeline(renderer, scene, camera, {
    ambientOcclusion: { enabled: true, mode: 'ssao', strength: 0.8 },
    ssr: { enabled: true, quality: 0.65, reflectNonMetals: true }
  });
  assert.equal(effectsPipeline.getState().ambientOcclusion.mode, 'ssao');
  assert.equal(effectsPipeline.getState().ssr.quality, 0.65);
  assert.equal(effectsPipeline.setAmbientOcclusion({ enabled: true, mode: 'gtao', strength: 0.9 }), true);
  assert.equal(effectsPipeline.getState().ambientOcclusion.mode, 'gtao');
  assert.equal(effectsPipeline.setSSR(false), true);
  assert.equal(effectsPipeline.getState().ssr, null);
  assert.equal(effectsPipeline.dispose(), true);
});

test('WebGPU Lab consumes the reusable strict WebGPU scene-session API', () => {
  const root = path.resolve(__dirname, '..');
  const lab = fs.readFileSync(path.join(root, 'static', 'pstudio_webgpu_lab.mjs'), 'utf8');
  for (const token of [
    'createPStudioWebGPUSceneSession',
    'sessionHandle.render()',
    'sessionHandle.dispose()',
    'configureRenderer'
  ]) assert.ok(lab.includes(token), token);
  assert.doesNotMatch(lab, /rendererCandidate\.render\(scene, camera\)/);
});


test('WebGPU material preflight rejects legacy GLSL hooks and unsupported material types', async () => {
  const [THREE, , , , , , migration] = await modules;
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const pbr = new THREE.MeshStandardMaterial();
  scene.add(new THREE.Mesh(geometry, pbr));
  const supported = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(supported.compatible, true);
  assert.equal(supported.materialCount, 1);
  assert.equal(supported.standardPBR, 1);

  const customPBR = new THREE.MeshStandardMaterial();
  customPBR.onBeforeCompile = () => {};
  scene.add(new THREE.Mesh(geometry, customPBR));
  const custom = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(custom.compatible, false);
  assert.equal(custom.legacyShaderHooks, 1);
  assert.equal(custom.unsupported[0].reason, 'custom-glsl-hook-requires-tsl-port');

  const shaderMaterial = new THREE.ShaderMaterial();
  scene.add(new THREE.Mesh(geometry, shaderMaterial));
  const mixed = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(mixed.compatible, false);
  assert.equal(mixed.unsupportedMaterials, 2);

  pbr.dispose();
  customPBR.dispose();
  shaderMaterial.dispose();
  geometry.dispose();
});

test('WebGPU production migration status reports blockers without claiming parity', async () => {
  const [, , , , , , migration] = await modules;
  const status = migration.getPStudioWebGPUMigrationStatus({ navigatorRef: {} });
  assert.equal(status.productionBackend, 'webgl2');
  assert.equal(status.targetBackend, 'webgpu-tsl');
  assert.equal(status.webgpuAvailable, false);
  assert.equal(status.productionReady, false);
  // A real-device parity run is still required after the production bridge was wired.
  assert.ok(status.blockers.some(item => item.id === 'renderer-parity-validation'));
  assert.ok(status.blockers.some(item => item.id === 'legacy-materials'));
});

test('WebGPU scene sessions reject unsupported materials before requesting a GPU device', async () => {
  const [THREE, , , , , , migration] = await modules;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.ShaderMaterial();
  scene.add(new THREE.Mesh(geometry, material));
  await assert.rejects(
    migration.createPStudioWebGPUSceneSession({ canvas: {}, scene, camera, navigatorRef: {} }),
    error => error.code === 'PSTUDIO_WEBGPU_SCENE_INCOMPATIBLE'
  );
  material.dispose();
  geometry.dispose();
});


test('TSL environment generates deterministic equirectangular sky radiance for day and night', async () => {
  const [THREE, , , , , environmentTSL] = await modules;
  const presets = require('../static/pstudio_scene_environment.js');
  const resolver = require('../static/pstudio_rendering_environment.js');
  const day = resolver.resolvePStudioEnvironmentState(presets.getPreset('day'));
  const night = resolver.resolvePStudioEnvironmentState(presets.getPreset('night'));
  for (const key of ['skyTop','skyMid','skyHorizon','skyGround','environmentIntensity','sunIntensity','sunAngularRadius','starBrightness','moonDirection','moonIntensity']) {
    assert.notEqual(day[key], undefined, 'day:' + key);
    assert.notEqual(night[key], undefined, 'night:' + key);
  }
  const first = environmentTSL.generatePStudioEnvironmentPixels(day,128,64);
  const second = environmentTSL.generatePStudioEnvironmentPixels(day,128,64);
  const nightPixels = environmentTSL.generatePStudioEnvironmentPixels(night,128,64);
  const cloudFreeDay = environmentTSL.generatePStudioEnvironmentPixels({...day,cloudDensity:0},128,64);
  assert.equal(first.width,128);
  assert.equal(first.height,64);
  assert.deepEqual(first.data,second.data);
  assert.equal(first.data.length,128*64*4);
  for(let i=3;i<first.data.length;i+=4) assert.equal(first.data[i],255);
  assert.notDeepEqual(first.data,cloudFreeDay.data,'day/dusk sky map includes its static cloud radiance');
  assert.deepEqual(nightPixels.data,environmentTSL.generatePStudioEnvironmentPixels({...night,cloudDensity:2},128,64).data,
    'night does not receive the daylight static cloud field');
  for(let y=4;y<60;y+=5){
    const left=(y*128)*4,right=(y*128+127)*4;
    for(let channel=0;channel<3;channel++){
      assert.ok(Math.abs(first.data[left+channel]-first.data[right+channel])<=18,
        'equirectangular horizontal seam remains continuous');
    }
  }
  const dayMean = first.data.reduce((sum,value,index)=>sum+(index%4===0?value:0),0);
  const nightMean = nightPixels.data.reduce((sum,value,index)=>sum+(index%4===0?value:0),0);
  assert.ok(dayMean>0&&nightMean>0);
  assert.ok(nightPixels.data.some((value,index)=>index%4===0&&value>nightMean/(128*64)));
});

test('TSL environment owns a sky NodeMaterial and matching PBR IBL texture with safe preset updates', async () => {
  const [THREE, , , , , environmentTSL] = await modules;
  const presets = require('../static/pstudio_scene_environment.js');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45,1,0.1,80);
  camera.position.set(3,4,5);
  const originalEnvironment = new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);
  scene.environment = originalEnvironment;
  scene.environmentIntensity = 0.37;
  const handle = environmentTSL.createPStudioTSLEnvironment(scene,{
    profile:presets.getPreset('night'),
    camera,
    resolution:128
  });
  assert.equal(handle.kind,'pstudio-tsl-atmospheric-environment');
  assert.equal(handle.skyMesh.material.isMeshBasicNodeMaterial,true);
  assert.ok(handle.skyMesh.material.colorNode);
  assert.equal(handle.getState().skyNode,'equirectangular-tsl-texture-sample');
  assert.equal(handle.getState().radianceSource,'shared-sky-and-pbr-ibl');
  assert.equal(scene.environment,handle.environmentTexture);
  assert.equal(scene.environment.mapping,THREE.EquirectangularReflectionMapping);
  assert.equal(scene.environment.colorSpace,THREE.SRGBColorSpace);
  assert.deepEqual(handle.getState().resolution,[128,64]);
  assert.equal(handle.getState().preset,'night');
  assert.equal(handle.getState().ibl,true);
  assert.equal(handle.updateCamera(camera),true);
  assert.deepEqual(handle.skyMesh.position.toArray(),camera.position.toArray());
  const initialTextureVersion = handle.environmentTexture.version;
  assert.equal(handle.setProfile(presets.getPreset('day')),true);
  assert.ok(handle.environmentTexture.version>initialTextureVersion);
  assert.equal(handle.getState().preset,'day');
  assert.equal(scene.environmentIntensity,0.92);
  assert.equal(handle.dispose(),true);
  assert.equal(handle.dispose(),false);
  assert.equal(scene.environment,originalEnvironment);
  assert.equal(scene.environmentIntensity,0.37);
  originalEnvironment.dispose();
});


test('native TSL CSM shadow node replaces legacy cascade lights and restores them on disposal', async () => {
  const [THREE] = await modules;
  const csmModule = await import('../static/pstudio_rendering_csm_tsl.mjs');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1600);
  const legacyLights = [0, 1, 2].map(() => {
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.castShadow = true;
    light.shadow.autoUpdate = true;
    scene.add(light);
    return light;
  });

  const handle = csmModule.createPStudioTSLCascadeShadows(scene, camera, {
    cascades: 3,
    maxFar: 900,
    mode: 'practical',
    lightDirection: new THREE.Vector3(-5, -9, -6).normalize(),
    legacyLights,
    lightColor: new THREE.Color(0xffffff),
    lightIntensity: 3,
    lightNear: 2,
    lightFar: 2500,
    shadowMapSize: 2048
  });

  assert.equal(handle.kind, 'pstudio-tsl-csm');
  assert.equal(handle.light.shadow.camera.near, 2);
  assert.equal(handle.light.shadow.camera.far, 2500);
  assert.equal(handle.enabled, true);
  assert.equal(handle.shadowNode instanceof (await import('three/addons/csm/CSMShadowNode.js')).CSMShadowNode, true);
  assert.equal(handle.light.shadow.shadowNode, handle.shadowNode);
  assert.equal(handle.getState().cascades, 3);
  assert.equal(handle.getState().maxFar, 900);
  assert.deepEqual(handle.getState().shadowMapSize, [2048, 2048]);
  for (const light of legacyLights) {
    assert.equal(light.intensity, 0);
    assert.equal(light.castShadow, false);
    assert.equal(light.shadow.autoUpdate, false);
  }
  assert.equal(scene.children.includes(handle.light), true);

  assert.equal(handle.dispose(), true);
  assert.equal(handle.dispose(), false);
  for (const light of legacyLights) {
    assert.equal(light.intensity, 3);
    assert.equal(light.castShadow, true);
    assert.equal(light.shadow.autoUpdate, true);
  }
  assert.equal(scene.children.includes(handle.light), false);
  for (const light of legacyLights) {
    scene.remove(light);
    light.dispose?.();
  }
});

test('TSL CSM validates scene, camera and light direction before mutating legacy state', async () => {
  const [THREE] = await modules;
  const csmModule = await import('../static/pstudio_rendering_csm_tsl.mjs');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const legacy = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(legacy);
  assert.throws(() => csmModule.createPStudioTSLCascadeShadows({}, camera), /Scene and Camera/);
  assert.throws(() => csmModule.createPStudioTSLCascadeShadows(scene, camera, {
    legacyLights: [legacy],
    lightDirection: [0, 0, 0]
  }), /non-zero light direction/);
  assert.equal(legacy.intensity, 2);
  scene.remove(legacy);
});

test('TSL material conversion accepts a known CSM-only hook but still rejects unrelated GLSL hooks', async () => {
  const [THREE, , materials] = await modules;
  const source = new THREE.MeshStandardMaterial();
  source.defines = { USE_CSM: 1, CSM_CASCADES: 3, CSM_FADE: '' };
  const csmHook = () => {};
  source.onBeforeCompile = csmHook;
  source.userData.pstudioCSMOnlyHook = true;
  source.userData.pstudioCSMHook = csmHook;
  source.userData.pstudioCSMSetup = true;

  const converted = materials.createPStudioNodeMaterial(source);
  assert.equal(converted.isMeshStandardNodeMaterial, true);
  assert.equal(converted.defines?.USE_CSM, undefined);
  assert.equal(converted.defines?.CSM_CASCADES, undefined);
  assert.equal(converted.userData.pstudioCSMOnlyHook, undefined);
  converted.dispose();

  source.onBeforeCompile = () => {};
  assert.throws(() => materials.createPStudioNodeMaterial(source), /custom GLSL hooks/);
  source.dispose();
});

test('WebGPU scene preflight accepts CSM-only hooks and rejects a layered custom shader hook', async () => {
  const [THREE, , , , , , migration] = await modules;
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const csmMaterial = new THREE.MeshStandardMaterial();
  const csmHook = () => {};
  csmMaterial.onBeforeCompile = csmHook;
  csmMaterial.userData.pstudioCSMOnlyHook = true;
  csmMaterial.userData.pstudioCSMHook = csmHook;
  scene.add(new THREE.Mesh(geometry, csmMaterial));
  const safe = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(safe.compatible, true);
  assert.equal(safe.legacyShaderHooks, 0);

  csmMaterial.userData.pstudioProbeShaderSetup = true;
  const blocked = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(blocked.compatible, false);
  assert.equal(blocked.legacyShaderHooks, 1);

  csmMaterial.dispose();
  geometry.dispose();
});


test('underwater caustics migrate to a reversible TSL diffuse-color graph', async () => {
  const [THREE] = await Promise.all([import('three/webgpu')]);
  const { applyPStudioTSLSurfaceFeatures, isPStudioTSLSurfaceFeatureMaterial } = await surfaceModule;
  const material = new THREE.MeshStandardNodeMaterial();
  material.userData = {
    pstudioTSLPortVersion: 1,
    pstudioTSLPortHasForeignHook: false,
    pstudioTSLFeatures: ['caustics'],
    pstudioCausticsHQ: { strength: { value: 0.30 } }
  };
  // Mirrors the converter's non-userData preflight approval certificate.
  material.pstudioTSLSurfacePreflightApproved = true;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
  const previousColorNode = material.colorNode;

  assert.equal(isPStudioTSLSurfaceFeatureMaterial(material), true);
  const handle = applyPStudioTSLSurfaceFeatures(scene);
  assert.equal(handle.materialCount, 1);
  assert.equal(handle.features.includes('caustics'), true);
  assert.ok(material.colorNode?.isNode);
  assert.equal(handle.dispose(), true);
  assert.equal(material.colorNode, previousColorNode);
});
