'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function fakeDevice() {
  const stats = { buffers: 0, textures: 0, submits: 0, indexedDraws: 0, drawCalls: 0, instanceCounts: [], drawRanges: [], bufferWrites: 0, textureWrites: 0, writeSizes: [] };
  const device = {
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) { stats.bufferWrites++; stats.writeSizes.push(size ?? data.byteLength); },
      writeTexture(destination, data, layout, size) { stats.textureWrites++; },
      submit() { stats.submits++; }
    },
    createShaderModule() { return {}; },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
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
    createSampler(descriptor) { return { descriptor }; },
    createCommandEncoder() {
      return {
        beginRenderPass() {
          return {
            setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
            draw(vertexCount, instanceCount = 1, firstVertex = 0) { stats.drawCalls++; stats.instanceCounts.push(instanceCount); stats.drawRanges.push({ first:firstVertex,count:vertexCount,indexed:false }); }, drawIndexed(indexCount, instanceCount = 1, firstIndex = 0) { stats.indexedDraws++; stats.drawCalls++; stats.instanceCounts.push(instanceCount); stats.drawRanges.push({ first:firstIndex,count:indexCount,indexed:true }); }, end() {}
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
  assert.equal(stats.textures, 9, 'depth plus eight material texture slots are cached');
  assert.ok(stats.writeSizes.every(size => size % 4 === 0), 'WebGPU queue writes must be four-byte aligned');
  assert.equal(handle.render(frame), true);
  assert.equal(stats.submits, 2);
  assert.equal(stats.buffers, 5, 'geometry, frame, material and instance GPU buffers should be reused');
  assert.equal(stats.textures, 9, 'depth plus the eight cached PBR texture slots should be reused');
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
  assert.throws(() => renderPStudioGraphicsSceneFrame({ scene }, { device: {} }, {}), /without legacy texture feature flags/);
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
  assert.equal(stats.textures, 9, 'depth plus the eight cached PBR texture slots must be reused');
});

test('independent WebGPU PBR path samples PStudio-owned sRGB base-color textures', async () => {
  const [{ createPStudioGraphicsSceneAsset }, { renderPStudioGraphicsSceneFrame, PSTUDIO_WEBGPU_SCENE_WGSL }] = await Promise.all([
    import('../static/pstudio_graphics_scene_asset.mjs'),
    import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
  ]);
  const scene = createPStudioGraphicsSceneAsset({
    id: 'scene.textured-pbr',
    geometries: [{ id: 'geo', positions: [0,0,0,1,0,0,0,1,0], uvs: [0,0,1,0,0,1], indices: [0,1,2] }],
    textures: [{ id: 'albedo', width: 1, height: 1, data: new Uint8Array([255, 128, 64, 255]), format: 'rgba8unorm-srgb' }],
    materials: [{ id: 'mat', model: 'pbr', baseColor: [0.8,0.8,0.8,1], baseColorTextureId: 'albedo' }],
    entities: [{ id: 'entity', geometryId: 'geo', materialId: 'mat' }]
  });
  const { device, stats } = fakeDevice();
  const api = { device, canvas: { width: 640, height: 360 }, getCapabilities: () => ({ format: 'rgba8unorm' }), getCurrentSurfaceView: () => ({}) };
  assert.equal(renderPStudioGraphicsSceneFrame({
    scene,
    view: { viewProjectionMatrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), cameraPosition: [0,0,3] }
  }, api, {}), true);
  assert.equal(stats.textureWrites, 8, 'the owned Base Color plus seven typed fallback textures upload once');
  assert.equal(stats.textures, 9, 'depth plus Base Color and seven typed fallback textures are allocated');
  assert.match(PSTUDIO_WEBGPU_SCENE_WGSL, /textureSample\(baseColorTexture, baseColorSampler/);
  assert.equal(scene.textures[0].format, 'rgba8unorm-srgb', 'the owned Base Color texture retains its sRGB encoding');
});


test('independent WebGPU renderer draws each geometry material group with correct element ranges', async () => {
  const { createPStudioGraphicsSceneAsset } = await import('../static/pstudio_graphics_scene_asset.mjs');
  const { renderPStudioGraphicsSceneFrame } = await import('../static/pstudio_graphics_webgpu_scene_renderer.mjs');
  const scene = createPStudioGraphicsSceneAsset({
    id: 'scene.material-groups',
    geometries: [{
      id: 'geo.grouped',
      positions: [0,0,0,1,0,0,0,1,0, 1,0,0,1,1,0,0,1,0],
      indices: [0,1,2,3,4,5],
      groups: [{ start:0,count:3,materialIndex:0 },{ start:3,count:3,materialIndex:1 }]
    }],
    materials: [
      { id:'mat.red',model:'pbr',baseColor:[1,0,0,1] },
      { id:'mat.blue',model:'pbr',baseColor:[0,0,1,1] }
    ],
    entities: [{ id:'mesh',geometryId:'geo.grouped',materialIds:['mat.red','mat.blue'] }]
  });
  const {device,stats}=fakeDevice();
  const api={device,canvas:{width:640,height:360},getCapabilities:()=>({format:'rgba8unorm'}),getCurrentSurfaceView:()=>({})};
  assert.equal(renderPStudioGraphicsSceneFrame({scene,view:{viewProjectionMatrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[0,0,3]}},api,{}),true);
  assert.equal(stats.drawCalls,2);
  assert.deepEqual(stats.drawRanges,[{first:0,count:3,indexed:true},{first:3,count:3,indexed:true}]);
});

test('independent WebGPU PBR frame uniforms include additional directional, point and spot lights', async () => {
  const { createPStudioGraphicsSceneAsset } = await import('../static/pstudio_graphics_scene_asset.mjs');
  const { renderPStudioGraphicsSceneFrame, PSTUDIO_WEBGPU_SCENE_WGSL } = await import('../static/pstudio_graphics_webgpu_scene_renderer.mjs');
  const scene=createPStudioGraphicsSceneAsset({
    id:'scene.lights',
    geometries:[{id:'geo',positions:[0,0,0,1,0,0,0,1,0]}],
    materials:[{id:'mat',model:'pbr'}],
    entities:[{id:'entity',geometryId:'geo',materialId:'mat'}],
    lighting:{lights:[
      {type:'directional',direction:[0,-1,0],color:[1,.9,.8],intensity:2},
      {type:'point',position:[1,2,3],color:[.8,.7,.6],intensity:4,range:15},
      {type:'spot',position:[0,4,0],direction:[0,-1,0],intensity:8,range:20,innerConeCos:.95,outerConeCos:.8}
    ]}
  });
  const {device,stats}=fakeDevice();
  const api={device,canvas:{width:640,height:360},getCapabilities:()=>({format:'rgba8unorm'}),getCurrentSurfaceView:()=>({})};
  renderPStudioGraphicsSceneFrame({scene,view:{viewProjectionMatrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[0,0,3]}},api,{});
  assert.ok(stats.writeSizes.includes(656),'frame uniform buffer must pack the fixed eight-light frame block');
  assert.match(PSTUDIO_WEBGPU_SCENE_WGSL,/frame\.lights\[index\]/);
  assert.match(PSTUDIO_WEBGPU_SCENE_WGSL,/smoothstep\(light\.cone\.y, light\.cone\.x/);
  assert.throws(()=>createPStudioGraphicsSceneAsset({
    id:'scene.too-many-lights',geometries:[{id:'g',positions:[0,0,0,1,0,0,0,1,0]}],
    materials:[{id:'m'}],entities:[{id:'e',geometryId:'g',materialId:'m'}],
    lighting:{lights:Array.from({length:9},()=>({type:'point'}))}
  }),/up to eight/);
});

test('independent WebGPU renderer evaluates PStudio animation before scene submission',async()=>{
 const [{createPStudioGraphicsSceneAsset},{createPStudioAnimationClip},{renderPStudioGraphicsSceneFrame}]=await Promise.all([
  import('../static/pstudio_graphics_scene_asset.mjs'),
  import('../static/pstudio_graphics_animation_core.mjs'),
  import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
 ]);
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const animation=createPStudioAnimationClip({id:'clip.move',tracks:[
  {targetId:'node.mesh',path:'translation',times:[0,1],values:[0,0,0,2,0,0]}
 ]});
 const scene=createPStudioGraphicsSceneAsset({
  id:'scene.animated',
  geometries:[{id:'geo',positions:[0,0,0,1,0,0,0,1,0]}],
  materials:[{id:'mat',model:'pbr'}],
  nodes:[{id:'node.mesh',translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],matrix:identity,worldMatrix:identity}],
  animations:[animation],
  entities:[{id:'entity',nodeId:'node.mesh',geometryId:'geo',materialId:'mat'}]
 });
 const {device,stats}=fakeDevice();
 const api={device,canvas:{width:320,height:180},getCapabilities:()=>({format:'rgba8unorm'}),getCurrentSurfaceView:()=>({})};
 assert.equal(renderPStudioGraphicsSceneFrame({
  scene,animation:{clipId:'clip.move',timeSeconds:.5,loop:false},
  view:{viewProjectionMatrix:new Float32Array(identity),cameraPosition:[0,0,3]}
 },api,{}),true);
 assert.equal(stats.drawCalls,1);
 assert.equal(stats.submits,1);
});

test('independent WebGPU renderer resolves static skin and morph deformation before GPU upload',async()=>{
 const [{createPStudioGraphicsSceneAsset},{createPStudioSkinDescriptor},{renderPStudioGraphicsSceneFrame}]=await Promise.all([
  import('../static/pstudio_graphics_scene_asset.mjs'),
  import('../static/pstudio_graphics_animation_core.mjs'),
  import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
 ]);
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const meshWorld=identity.slice();meshWorld[12]=2;
 const scene=createPStudioGraphicsSceneAsset({
  id:'scene.static-skinned',
  geometries:[{id:'geo',positions:[0,0,0,1,0,0,0,1,0],jointIndices:[0,0,0,0,0,0,0,0,0,0,0,0],jointWeights:[1,0,0,0,1,0,0,0,1,0,0,0],morphTargets:[{positions:[0,0,0,0,0,0,0,1,0]}]}],
  materials:[{id:'mat',model:'pbr'}],
  nodes:[
   {id:'node.mesh',translation:[2,0,0],rotation:[0,0,0,1],scale:[1,1,1],matrix:meshWorld,worldMatrix:meshWorld},
   {id:'node.joint',translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],matrix:identity,worldMatrix:identity}
  ],
  skins:[createPStudioSkinDescriptor({id:'skin',joints:['node.joint'],inverseBindMatrices:[identity]})],
  entities:[{id:'entity',nodeId:'node.mesh',geometryId:'geo',materialId:'mat',skinId:'skin',morphWeights:[1]}]
 });
 const {device,stats}=fakeDevice();
 const api={device,canvas:{width:320,height:180},getCapabilities:()=>({format:'rgba8unorm'}),getCurrentSurfaceView:()=>({})};
 const state={};
 assert.equal(renderPStudioGraphicsSceneFrame({scene,view:{viewProjectionMatrix:new Float32Array(identity),cameraPosition:[0,0,3]}},api,state),true);
 assert.equal(stats.drawCalls,1);
 assert.equal(stats.submits,1);
 assert.equal(state.bindPoseCache.size,1);
 const resolved=[...state.bindPoseCache.values()][0];
 assert.equal(resolved.entities[0].skinId,null);
 assert.equal(resolved.entities[0].morphWeights.length,0);
 const deformed=resolved.geometries.find(item=>item.id===resolved.entities[0].geometryId);
 assert.ok(deformed);
 assert.equal(deformed.jointIndices,null);
 assert.equal(deformed.morphTargets.length,0);
});

test('independent WebGPU renderer supports authored toon materials for the anime-facing shading path',async()=>{
 const [{createPStudioGraphicsSceneAsset},{renderPStudioGraphicsSceneFrame,PSTUDIO_WEBGPU_SCENE_WGSL}]=await Promise.all([
  import('../static/pstudio_graphics_scene_asset.mjs'),
  import('../static/pstudio_graphics_webgpu_scene_renderer.mjs')
 ]);
 const scene=createPStudioGraphicsSceneAsset({
  id:'scene.toon-material',
  geometries:[{id:'geo',positions:[0,0,0,1,0,0,0,1,0]}],
  materials:[{id:'mat.toon',model:'toon',baseColor:[.9,.72,.82,1],roughness:.8}],
  entities:[{id:'entity',geometryId:'geo',materialId:'mat.toon'}]
 });
 const {device,stats}=fakeDevice();
 const api={device,canvas:{width:320,height:180},getCapabilities:()=>({format:'rgba8unorm'}),getCurrentSurfaceView:()=>({})};
 assert.equal(renderPStudioGraphicsSceneFrame({scene,view:{viewProjectionMatrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[0,0,3]}},api,{}),true);
 assert.equal(stats.drawCalls,1);
 assert.match(PSTUDIO_WEBGPU_SCENE_WGSL,/toonLuminance/);
});
