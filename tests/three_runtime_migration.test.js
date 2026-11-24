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
  const tsl = await import('three/tsl');
  assert.equal(typeof tsl.vec3, 'function');
  assert.equal(typeof THREE.WebGLRenderer.prototype.setNodesHandler, 'undefined');

  const webgpu = await import('three/webgpu');
  assert.equal(typeof webgpu.WebGPURenderer, 'function');

  const bvh = await import('three-mesh-bvh');
  for (const name of ['acceleratedRaycast', 'computeBoundsTree', 'disposeBoundsTree', 'MeshBVH']) {
    assert.ok(bvh[name], `three-mesh-bvh export ${name}`);
  }
});
