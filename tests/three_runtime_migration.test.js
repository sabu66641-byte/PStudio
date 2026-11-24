const test = require('node:test');
const assert = require('node:assert/strict');

// CI installs the exact same pinned packages used by the browser import map.
test('Three.js r188 core, TSL bridge, renderer addons and BVH runtime load together', async () => {
  const THREE = await import('three');
  assert.equal(THREE.REVISION, '187');
  assert.equal(typeof THREE.WebGLRenderer, 'function');
  assert.equal(typeof THREE.WebGLRenderer.prototype.setNodesHandler, 'function');

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
    'three/addons/tsl/WebGLNodesHandler.js'
  ];

  const addonModules = await Promise.all(addonPaths.map((specifier) => import(specifier)));
  const [{ GLTFLoader }, { WebGLNodesHandler }] = [
    addonModules[0],
    addonModules[22]
  ];
  assert.equal(typeof GLTFLoader, 'function');
  assert.equal(typeof WebGLNodesHandler, 'function');
  assert.doesNotThrow(() => new WebGLNodesHandler());

  const tsl = await import('three/tsl');
  assert.equal(typeof tsl.vec3, 'function');

  const webgpu = await import('three/webgpu');
  assert.equal(typeof webgpu.WebGPURenderer, 'function');

  const bvh = await import('three-mesh-bvh');
  for (const name of ['acceleratedRaycast', 'computeBoundsTree', 'disposeBoundsTree', 'MeshBVH']) {
    assert.ok(bvh[name], `three-mesh-bvh export ${name}`);
  }
});
