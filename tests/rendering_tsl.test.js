const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modules = Promise.all([
  import('three/webgpu'),
  import('three/tsl'),
  import('../static/pstudio_rendering_materials.mjs'),
  import('../static/pstudio_rendering_backend.mjs'),
  import('../static/pstudio_rendering_pipeline.mjs'),
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
  assert.equal(pipeline.setBloom(false), true);
  assert.equal(pipeline.getState().bloom, null);
  assert.equal(pipeline.dispose(), true);
  assert.equal(pipeline.dispose(), false);
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
  assert.doesNotMatch(lab, /rendererCandidate\\.render\\(scene, camera\\)/);
});


test('WebGPU material preflight rejects legacy GLSL hooks and unsupported material types', async () => {
  const [THREE, , , , , migration] = await modules;
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
  const [, , , , , migration] = await modules;
  const status = migration.getPStudioWebGPUMigrationStatus({ navigatorRef: {} });
  assert.equal(status.productionBackend, 'webgl2');
  assert.equal(status.targetBackend, 'webgpu-tsl');
  assert.equal(status.webgpuAvailable, false);
  assert.equal(status.productionReady, false);
  assert.ok(status.blockers.some(item => item.id === 'renderer-lifecycle'));
  assert.ok(status.blockers.some(item => item.id === 'legacy-materials'));
});

test('WebGPU scene sessions reject unsupported materials before requesting a GPU device', async () => {
  const [THREE, , , , , migration] = await modules;
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
