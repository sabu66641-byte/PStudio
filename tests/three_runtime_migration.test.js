const test = require('node:test');
const assert = require('node:assert/strict');

// CI installs the exact same pinned packages used by the browser import map.
test('Three.js r187 core, WebGPU/TSL entry points, renderer addons and BVH runtime load together', async () => {
  const THREE = await import('three');
  assert.equal(THREE.REVISION, '187');
  assert.equal(typeof THREE.WebGLRenderer, 'function');
  // r187 has no WebGLRenderer.setNodesHandler compatibility API. TSL is tested
  // on its dedicated WebGPU path and must not be silently enabled on WebGL.

  const addonPaths = [
    'three/addons/loaders/GLTFLoader.js',
    'three/addons/libs/meshopt_decoder.module.js',
    'three/addons/loaders/KTX2Loader.js',
    'three/addons/loaders/DRACOLoader.js',
    'three/addons/utils/SkeletonUtils.js',
    'three/addons/postprocessing/EffectComposer.js',
    'three/addons/postprocessing/RenderPass.js',
    'three/addons/postprocessing/UnrealBloomPass.js',
    'three/addons/postprocessing/SSAOPass.js',
    'three/addons/postprocessing/OutputPass.js',
    'three/addons/postprocessing/GTAOPass.js',
    'three/addons/postprocessing/TAARenderPass.js',
    'three/addons/postprocessing/SMAAPass.js',
    'three/addons/postprocessing/ShaderPass.js',
    'three/addons/postprocessing/SSRPass.js',
    'three/addons/lights/LightProbeGenerator.js',
    'three/addons/csm/CSM.js',
    'three/addons/modifiers/SimplifyModifier.js',
    'three/addons/loaders/RGBELoader.js',
    'three/addons/objects/Reflector.js',
    'three/addons/environments/RoomEnvironment.js',
    'three/addons/objects/Sky.js',
  ];

  const addonModules = await Promise.all(addonPaths.map((specifier) => import(specifier)));
  const { GLTFLoader } = addonModules[0];
  assert.equal(typeof GLTFLoader, 'function');
  const { SimplifyModifier } = await import('three/addons/modifiers/SimplifyModifier.js');
  assert.equal(typeof SimplifyModifier, 'function');
  assert.equal(SimplifyModifier.prototype.modify.constructor.name, 'AsyncFunction');
  const physicalMaterial = new THREE.MeshPhysicalMaterial();
  assert.equal(physicalMaterial.iridescenceThicknessMinimum, 100);
  assert.equal(physicalMaterial.iridescenceThicknessMaximum, 400);
  const roughPhysicalMaterial = new THREE.MeshPhysicalMaterial({ diffuseRoughness: 0.65 });
  assert.equal(roughPhysicalMaterial.diffuseRoughness, 0.65);
  assert.ok('diffuseRoughnessMap' in roughPhysicalMaterial);
  roughPhysicalMaterial.dispose();
  physicalMaterial.dispose();

  const tsl = await import('three/tsl');
  assert.equal(typeof tsl.vec3, 'function');
  assert.equal(typeof THREE.WebGLRenderer.prototype.setNodesHandler, 'undefined');

  const webgpu = await import('three/webgpu');
  assert.equal(typeof webgpu.WebGPURenderer, 'function');
  assert.equal(typeof webgpu.MeshStandardMaterial, 'function');
  assert.equal(typeof webgpu.MeshPhysicalMaterial, 'function');
  assert.equal(typeof webgpu.MeshStandardNodeMaterial, 'function');
  assert.equal(typeof webgpu.MeshPhysicalNodeMaterial, 'function');
  assert.equal(typeof webgpu.RenderPipeline, 'function');
  assert.equal(typeof webgpu.DirectionalLight, 'function');
  assert.equal(typeof tsl.uv, 'function');
  assert.equal(typeof tsl.pass, 'function');
  assert.equal(typeof tsl.mix, 'function');
  assert.equal(typeof tsl.vec3, 'function');

  const bvh = await import('three-mesh-bvh');
  for (const name of ['acceleratedRaycast', 'computeBoundsTree', 'disposeBoundsTree', 'MeshBVH']) {
    assert.ok(bvh[name], `three-mesh-bvh export ${name}`);
  }
});
