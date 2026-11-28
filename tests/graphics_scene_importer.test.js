'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function load() {
  return import('../static/pstudio_graphics_scene_asset.mjs');
}
function fakeScene(options = {}) {
  const geometry = {
    uuid: 'geometry.triangle',
    attributes: {
      position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), itemSize: 3, count: 3 },
      uv: { array: new Float32Array([0, 0, 1, 0, 0, 1]), itemSize: 2, count: 3 }
    },
    index: { array: new Uint16Array([0, 1, 2]) },
    groups: [],
    morphAttributes: {}
  };
  const material = {
    uuid: 'material.pbr', type: 'MeshStandardMaterial', isMeshStandardMaterial: true,
    color: { r: 0.8, g: 0.7, b: 0.6 }, emissive: { r: 0.01, g: 0.02, b: 0.03 },
    metalness: 0.15, roughness: 0.42, opacity: 1, ...options.material
  };
  const object = {
    uuid: 'mesh.triangle', name: 'Triangle', isMesh: true, geometry, material,
    visible: true, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ...options.object
  };
  const extras = options.extras || [];
  return { uuid: 'scene.sample', name: 'Scene sample', traverse(callback) { callback(object); for (const extra of extras) callback(extra); } };
}

test('PStudio scene assets own copied typed data and validate references', async () => {
  const { createPStudioGraphicsSceneAsset } = await load();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const asset = createPStudioGraphicsSceneAsset({
    id: 'scene.contract',
    clearColor: [0.2, 0.3, 0.4],
    lighting: { sunDirection: [0, -1, 0], sunIntensity: 2, ambientColor: [0.1, 0.2, 0.3], ambientIntensity: 0.5 },
    geometries: [{ id: 'geo', positions }],
    materials: [{ id: 'mat', model: 'pbr', baseColor: [0.5, 0.6, 0.7, 1] }],
    entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  });
  positions[0] = 999;
  assert.equal(asset.kind, 'pstudio-graphics-scene-asset');
  assert.equal(asset.geometries[0].positions[0], 0);
  assert.equal(asset.geometries[0].normals.length, 9);
  assert.equal(asset.entities[0].materialIds[0], 'mat');
  assert.deepEqual(asset.clearColor, { r: 0.2, g: 0.3, b: 0.4, a: 1 });
  assert.equal(asset.lighting.sunIntensity, 2);
  assert.deepEqual(asset.lighting.sunDirection, [0, -1, 0]);
  assert.throws(() => createPStudioGraphicsSceneAsset({
    id: 'broken', geometries: [], materials: [], entities: [{ id: 'entity', geometryId: 'missing', materialId: 'missing' }]
  }), /unknown geometry/);
  assert.throws(() => createPStudioGraphicsSceneAsset({ id: 'bad-group', geometries: [{ id: 'geo', positions, groups: [{ start: 2, count: 9 }] }] }), /group range/);
});

test('duck-typed scene importer converts indexed MeshStandardMaterial without a Three.js global', async () => {
  const previous = globalThis.THREE;
  try {
    delete globalThis.THREE;
    const { importPStudioThreeScene } = await load();
    const source = fakeScene();
    source.background = { r: 0.05, g: 0.07, b: 0.1 };
    const { asset, report } = importPStudioThreeScene(source, { lighting: { sunDirection: [0, -1, 0], sunIntensity: 1.8 } });
    assert.equal(globalThis.THREE, undefined);
    assert.equal(report.supported, true);
    assert.equal(report.convertedMeshCount, 1);
    assert.equal(asset.geometries[0].indices instanceof Uint16Array, true);
    assert.equal(asset.geometries[0].normals.length, 9);
    assert.equal(asset.materials[0].model, 'pbr');
    assert.equal(asset.materials[0].roughness, 0.42);
    assert.equal(asset.entities[0].geometryId, 'geometry.triangle');
    assert.deepEqual(asset.clearColor, { r: 0.05, g: 0.07, b: 0.1, a: 1 });
    assert.equal(asset.lighting.sunIntensity, 1.8);
  } finally {
    if (previous !== undefined) globalThis.THREE = previous;
  }
});

test('scene import fails closed for textures, alpha, unsupported material types and lights', async () => {
  const { importPStudioThreeScene } = await load();
  const textured = fakeScene({ material: { map: { uuid: 'texture.albedo' } } });
  assert.throws(() => importPStudioThreeScene(textured), error => {
    assert.equal(error.code, 'PSTUDIO_SCENE_IMPORT_UNSUPPORTED_FEATURES');
    assert.ok(error.report.unsupported.some(item => item.feature === 'texture-map'));
    return true;
  });
  const transparent = fakeScene({ material: { transparent: true, opacity: 0.5 } });
  assert.throws(() => importPStudioThreeScene(transparent), /not yet losslessly supported/);
  const unknownMaterial = fakeScene({ material: { isMeshStandardMaterial: false, type: 'MeshPhongMaterial' } });
  assert.throws(() => importPStudioThreeScene(unknownMaterial), /not yet losslessly supported/);
  const light = { uuid: 'light.sun', isLight: true, visible: true };
  assert.throws(() => importPStudioThreeScene(fakeScene({ extras: [light] })), /not yet losslessly supported/);
});

test('non-strict scene import returns a report instead of hiding unsupported content', async () => {
  const { importPStudioThreeScene } = await load();
  const { asset, report } = importPStudioThreeScene(fakeScene({ material: { map: { uuid: 'texture.albedo' } } }), { strict: false });
  assert.equal(asset.kind, 'pstudio-graphics-scene-asset');
  assert.equal(report.supported, false);
  assert.ok(report.unsupported.length > 0);
});

test('scene conversion and WebGPU scene renderer contain no Three.js imports', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of ['pstudio_graphics_scene_asset.mjs', 'pstudio_graphics_webgpu_scene_renderer.mjs']) {
    const source = fs.readFileSync(path.join(root, 'static', file), 'utf8');
    assert.doesNotMatch(source, /from\s*['"]three(?:\/[^'"]*)?['"]/);
    assert.doesNotMatch(source, /import\s*\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/);
  }
});


test('duck-typed importer expands Three.js InstancedMesh into shared PStudio geometry entities', async () => {
  const { importPStudioThreeScene } = await load();
  const matrix = (x = 0, y = 0, z = 0) => [
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1
  ];
  const parent = matrix(10, 0, 0);
  const localMatrices = [matrix(1), matrix(3), matrix(5)].flat();
  const source = fakeScene({
    object: {
      isInstancedMesh: true,
      count: 3,
      matrixWorld: { elements: parent },
      instanceMatrix: { itemSize: 16, array: new Float32Array(localMatrices) }
    }
  });
  const { asset, report } = importPStudioThreeScene(source);
  assert.equal(report.supported, true);
  assert.equal(report.convertedMeshCount, 3);
  assert.equal(asset.geometries.length, 1, 'instanced objects must share one PStudio geometry');
  assert.equal(asset.materials.length, 1, 'instanced objects must share one PStudio material');
  assert.deepEqual(asset.entities.map(entity => entity.matrixWorld[12]), [11, 13, 15]);
  assert.equal(new Set(asset.entities.map(entity => entity.geometryId)).size, 1);
  assert.equal(new Set(asset.entities.map(entity => entity.materialIds[0])).size, 1);
});

test('duck-typed importer rejects malformed InstancedMesh matrix data without dropping instances silently', async () => {
  const { importPStudioThreeScene } = await load();
  const source = fakeScene({
    object: { isInstancedMesh: true, count: 2, instanceMatrix: { itemSize: 16, array: new Float32Array(16) } }
  });
  assert.throws(() => importPStudioThreeScene(source), error => {
    assert.equal(error.code, 'PSTUDIO_SCENE_IMPORT_UNSUPPORTED_FEATURES');
    assert.ok(error.report.unsupported.some(item => item.feature === 'instancing-matrix-data'));
    return true;
  });
});

test('PStudio scene assets own RGBA8 base-color texture bytes and validate references', async () => {
  const { createPStudioGraphicsSceneAsset } = await load();
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  const asset = createPStudioGraphicsSceneAsset({
    id: 'scene.texture',
    geometries: [{ id: 'geo', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1] }],
    textures: [{ id: 'tex.base', width: 2, height: 1, data }],
    materials: [{ id: 'mat', model: 'pbr', baseColorTextureId: 'tex.base' }],
    entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  });
  data[0] = 0;
  assert.equal(asset.textures[0].data[0], 255);
  assert.equal(asset.materials[0].baseColorTextureId, 'tex.base');
  assert.throws(() => createPStudioGraphicsSceneAsset({
    id: 'scene.bad-texture', geometries: [{ id: 'geo', positions: [0,0,0,1,0,0,0,1,0] }],
    textures: [{ id: 'tex', width: 2, height: 2, data: new Uint8Array(4) }],
    materials: [{ id: 'mat' }], entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  }), /RGBA8 texture data length/);
  assert.throws(() => createPStudioGraphicsSceneAsset({
    id: 'scene.bad-reference', geometries: [{ id: 'geo', positions: [0,0,0,1,0,0,0,1,0] }],
    materials: [{ id: 'mat', baseColorTextureId: 'missing' }],
    entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  }), /unknown base-color texture/);
});

test('Three.js importer accepts Base Color maps through a CPU pixel reader without requiring Three.js', async () => {
  const { importPStudioThreeScene } = await load();
  const imageData = new Uint8Array([255, 220, 180, 255, 100, 120, 140, 255]);
  const source = fakeScene({ material: { map: { uuid: 'texture.owned', image: { width: 2, height: 1 } } } });
  const { asset, report } = importPStudioThreeScene(source, {
    readTexture: texture => ({ width: 2, height: 1, data: imageData })
  });
  assert.equal(report.supported, true);
  assert.equal(report.textureCount, 1);
  assert.equal(asset.materials[0].baseColorTextureId, 'texture.owned');
  assert.deepEqual(Array.from(asset.textures[0].data), Array.from(imageData));
});
