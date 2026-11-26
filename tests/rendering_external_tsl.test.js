const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_external_tsl.mjs'),
  import('../static/pstudio_rendering_celestial_tsl.mjs'),
  import('../static/pstudio_rendering_migration.mjs')
]);

test('registered celestial ShaderMaterials have explicit TSL conversions and reversible aliases', async () => {
  const [THREE, adapters, , migration] = await modules;
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(1, 8, 6);
  const texture = new THREE.DataTexture(
    new Uint8Array([180, 190, 210, 255]),
    1, 1, THREE.RGBAFormat
  );
  texture.needsUpdate = true;

  const moon = new THREE.ShaderMaterial({
    uniforms: {
      uMoonMap: { value: texture },
      uMoonTint: { value: new THREE.Color('#C7DCFF') },
      uLightDirectionWorld: { value: new THREE.Vector3(0, -1, 0) },
      uMoonIntensity: { value: 1 },
      uMoonGlare: { value: 0 },
      uEarthshineStrength: { value: 1 }
    }
  });
  moon.userData.pstudioTSLAdapterId = 'pstudio.celestial.moon';

  const sun = new THREE.ShaderMaterial({
    uniforms: {
      uSunMap: { value: texture },
      uSunColor: { value: new THREE.Color('#FFF4DD') },
      uSunIntensity: { value: 1.12 },
      uSolarGlare: { value: 0 }
    }
  });
  sun.userData.pstudioTSLAdapterId = 'pstudio.celestial.sun';

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 0], 3));
  starGeometry.setAttribute('aPhase', new THREE.Float32BufferAttribute([0, 1], 1));
  starGeometry.setAttribute('aIntensity', new THREE.Float32BufferAttribute([0.8, 1], 1));
  starGeometry.setAttribute('aSpeed', new THREE.Float32BufferAttribute([0.7, 1.2], 1));
  const stars = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPointScale: { value: 1 },
      uMoonDirectionWorld: { value: new THREE.Vector3(0, 1, 0) },
      uMoonOcclusion: { value: 0 }
    }
  });
  stars.userData.pstudioTSLAdapterId = 'pstudio.celestial.twinkle-stars';

  const moonMesh = new THREE.Mesh(geometry, moon);
  const sunMesh = new THREE.Mesh(geometry, sun);
  const starPoints = new THREE.Points(starGeometry, stars);
  scene.add(moonMesh, sunMesh, starPoints);

  const preflight = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(preflight.compatible, true);
  assert.equal(preflight.externalTSLAdapterMaterials, 3);

  const handle = adapters.applyPStudioTSLMaterialAdapters(scene);
  assert.equal(handle.convertedMaterials, 3);
  assert.equal(handle.convertedObjects, 3);
  assert.equal(moonMesh.material.isMeshBasicNodeMaterial, true);
  assert.equal(sunMesh.material.isMeshBasicNodeMaterial, true);
  assert.equal(starPoints.material.isPointsNodeMaterial, true);
  assert.equal(moonMesh.material.userData.pstudioExternalTSLAdapter, 'pstudio.celestial.moon');
  assert.equal(sunMesh.material.userData.pstudioExternalTSLAdapter, 'pstudio.celestial.sun');
  assert.equal(starPoints.material.userData.pstudioExternalTSLAdapter, 'pstudio.celestial.twinkle-stars');
  assert.ok(moonMesh.material.colorNode?.isNode);
  assert.ok(sunMesh.material.colorNode?.isNode);
  assert.ok(starPoints.material.opacityNode?.isNode);

  const moonTint = new THREE.Color('#ff00ff');
  moonMesh.material.uniforms.uMoonTint.value.copy(moonTint);
  assert.equal(moonMesh.material.userData.pstudioTSLUniformNodes.tint.value.getHex(), moonTint.getHex());
  starPoints.material.uniforms.uTime.value = 2.5;
  assert.equal(starPoints.material.userData.pstudioTSLUniformNodes.time.value, 2.5);

  assert.equal(handle.restore(), true);
  assert.equal(handle.restore(), false);
  assert.equal(moonMesh.material, moon);
  assert.equal(sunMesh.material, sun);
  assert.equal(starPoints.material, stars);

  geometry.dispose();
  starGeometry.dispose();
  texture.dispose();
  moon.dispose();
  sun.dispose();
  stars.dispose();
});

test('unknown external ShaderMaterial remains fail-closed without a registered semantic TSL adapter', async () => {
  const [THREE, , , migration] = await modules;
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  scene.add(mesh);

  const status = migration.inspectPStudioWebGPUSceneMaterials(scene);
  assert.equal(status.compatible, false);
  assert.equal(status.unsupportedMaterials, 1);
  assert.equal(status.unsupported[0].reason, 'material-type-has-no-approved-tsl-converter');
  assert.equal(material.isShaderMaterial, true);
});

test('external TSL adapter registration is public, explicit, validated and rolls back failed conversions', async () => {
  const [THREE, adapters, , migration] = await modules;
  assert.equal(migration.registerPStudioTSLMaterialAdapter, adapters.registerPStudioTSLMaterialAdapter);
  assert.deepEqual(migration.listPStudioTSLMaterialAdapters(), adapters.listPStudioTSLMaterialAdapters());
  assert.throws(() => adapters.registerPStudioTSLMaterialAdapter('invalid-test-adapter', {}), /must provide create/);

  const registration = adapters.registerPStudioTSLMaterialAdapter('test.invalid-adapter', {
    matches: material => material?.userData?.pstudioTSLAdapterId === 'test.invalid-adapter',
    create: () => ({})
  });
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial();
  material.userData.pstudioTSLAdapterId = 'test.invalid-adapter';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  scene.add(mesh);

  assert.equal(adapters.isPStudioTSLMaterialAdapterRegistered(material), true);
  assert.throws(
    () => adapters.applyPStudioTSLMaterialAdapters(scene),
    /must return a Three.js NodeMaterial/
  );
  assert.equal(mesh.material, material);
  assert.equal(registration.unregister(), true);
  assert.equal(registration.unregister(), false);
  assert.equal(adapters.isPStudioTSLMaterialAdapterRegistered(material), false);
});
