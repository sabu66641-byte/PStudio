'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function fakeDevice() {
  const stats = { buffers: 0, textures: 0, submits: 0, indexedDraws: 0, drawCalls: 0, instanceCounts: [], bufferWrites: 0, writeSizes: [] };
  const device = {
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) { stats.bufferWrites++; stats.writeSizes.push(size ?? data.byteLength); },
      submit() { stats.submits++; }
    },
    createShaderModule() { return {}; },
    createRenderPipeline() {
      return { getBindGroupLayout(index) { return { index }; } };
    },
    createBuffer(descriptor) {
      stats.buffers++;
      return { size: descriptor.size, destroy() {} };
    },
    createBindGroup(descriptor) { return descriptor; },
    createTexture(descriptor) {
      stats.textures++;
      return { descriptor, createView() { return {}; }, destroy() {} };
    },
    createCommandEncoder() {
      return {
        beginRenderPass() {
          return {
            setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
            draw(vertexCount, instanceCount = 1) { stats.drawCalls++; stats.instanceCounts.push(instanceCount); }, drawIndexed(indexCount, instanceCount = 1) { stats.indexedDraws++; stats.drawCalls++; stats.instanceCounts.push(instanceCount); }, end() {}
          };
        },
        finish() { return {}; }
      };
    },
    destroy() {}
  };
  return { device, stats };
}

test('PStudio independent WebGPU scene adapter renders PStudio data without Three.js', async () => {
  const [{ createPStudioGraphicsSceneAsset }, { createPStudioWebGPUSceneAdapter }] = await Promise.all([
    import('../static/pstudio_graphics_scene_asset.mjs'),
    import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
  ]);
  const scene = createPStudioGraphicsSceneAsset({
    id: 'scene.direct-webgpu',
    geometries: [{
      id: 'geo.triangle',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2])
    }],
    materials: [{ id: 'mat.pbr', model: 'pbr', baseColor: [0.8, 0.6, 0.4, 1], roughness: 0.5, emissive: [0.02, 0.01, 0.005] }],
    entities: [{ id: 'triangle', geometryId: 'geo.triangle', materialId: 'mat.pbr' }]
  });
  const { device, stats } = fakeDevice();
  const canvas = { width: 640, height: 360 };
  const context = { configure() {}, unconfigure() {}, getCurrentTexture() { return { createView() { return {}; } }; } };
  const adapter = createPStudioWebGPUSceneAdapter({ device, canvas, context, gpu: { getPreferredCanvasFormat: () => 'rgba8unorm' } });
  const handle = await adapter.initialize({ canvas });
  const frame = {
    scene,
    view: {
      viewProjectionMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      cameraPosition: [0, 0, 3]
    }
  };
  assert.equal(handle.render(frame), true);
  assert.equal(stats.submits, 1);
  assert.equal(stats.indexedDraws, 1);
  assert.equal(stats.buffers, 5);
  assert.equal(stats.textures, 1);
  assert.ok(stats.writeSizes.every(size => size % 4 === 0), 'WebGPU queue writes must be four-byte aligned');
  assert.equal(handle.render(frame), true);
  assert.equal(stats.submits, 2);
  assert.equal(stats.buffers, 4, 'geometry, frame, material and instance GPU buffers should be reused');
  assert.equal(stats.textures, 1, 'depth target should be reused at the same size');
  assert.equal(handle.dispose(), true);
});

test('independent WebGPU scene renderer rejects unsupported PBR features instead of silently degrading', async () => {
  const [{ createPStudioGraphicsSceneAsset }, { renderPStudioGraphicsSceneFrame }] = await Promise.all([
    import('../static/pstudio_graphics_scene_asset.mjs'),
    import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
  ]);
  const scene = createPStudioGraphicsSceneAsset({
    id: 'scene.textured',
    geometries: [{ id: 'geo', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }],
    materials: [{ id: 'mat', model: 'pbr', textures: ['albedo'] }],
    entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  });
  assert.throws(() => renderPStudioGraphicsSceneFrame({ scene }, { device: {} }, {}), /opaque, single-sided, untextured PBR/);
});

test('independent WebGPU scene renderer batches repeated geometry and materials into instanced draws', async () => {
  const [{ createPStudioGraphicsSceneAsset }, { renderPStudioGraphicsSceneFrame }] = await Promise.all([
    import('../static/pstudio_graphics_scene_asset.mjs'),
    import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
  ]);
  const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const entities = Array.from({ length: 128 }, (_, index) => {
    const matrixWorld = identity();
    matrixWorld[12] = index * 1.25;
    return { id: 'foliage-' + index, geometryId: 'geo.shared-tree', materialId: 'mat.shared-leaves', matrixWorld };
  });
  const scene = createPStudioGraphicsSceneAsset({
    id: 'scene.instanced-foliage',
    geometries: [{
      id: 'geo.shared-tree',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2])
    }],
    materials: [{ id: 'mat.shared-leaves', model: 'pbr', baseColor: [0.25, 0.6, 0.2, 1], roughness: 0.8 }],
    entities
  });
  const { device, stats } = fakeDevice();
  const api = {
    device, canvas: { width: 1280, height: 720 },
    getCapabilities: () => ({ format: 'rgba8unorm' }),
    getCurrentSurfaceView: () => ({})
  };
  const state = {};
  const frame = {
    scene,
    view: { viewProjectionMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), cameraPosition: [0, 0, 3] }
  };
  assert.equal(renderPStudioGraphicsSceneFrame(frame, api, state), true);
  assert.equal(stats.drawCalls, 1, '128 entities sharing geometry/material should submit one draw call');
  assert.deepEqual(stats.instanceCounts, [128], 'all 128 transforms must be submitted as GPU instances');
  assert.equal(stats.buffers, 5, 'GPU resource count should depend on unique geometry/material batches, not entity count');
  assert.equal(stats.writeSizes.every(size => size % 4 === 0), true, 'instance and uniform uploads must be four-byte aligned');
  renderPStudioGraphicsSceneFrame(frame, api, state);
  assert.equal(stats.drawCalls, 2);
  assert.equal(stats.buffers, 5, 'steady-state instanced frames must reuse their GPU buffers');
});
