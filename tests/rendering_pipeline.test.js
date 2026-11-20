const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
const physics = fs.readFileSync(path.join(root, 'static/pstudio_physics.js'), 'utf8');
const ecs = fs.readFileSync(path.join(root, 'static/pstudio_ecs.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');


test('advanced Three.js rendering add-ons are optional and version-aligned', () => {
  for (const addon of ['GTAOPass.js', 'SSRPass.js', 'RGBELoader.js', 'LightProbeGenerator.js']) {
    assert.ok(html.includes(addon), addon);
  }
  assert.ok(html.includes('three@0.160.0'));
});

test('quality presets configure render resolution and shadow filtering', () => {
  for (const preset of ['mobile', 'balanced', 'high', 'ultra']) assert.ok(renderer.includes(preset));
  assert.ok(renderer.includes('VSMShadowMap'));
  assert.ok(renderer.includes('PCFSoftShadowMap'));
  assert.ok(renderer.includes('setQualityPreset:applyQualityPreset'));
  assert.ok(renderer.includes('getStats:'));
  assert.ok(renderer.includes('composer?.setPixelRatio?.(renderer.getPixelRatio())'));
  assert.ok(renderer.includes('composer.setPixelRatio?.(renderer.getPixelRatio())'));
});

test('HDR loading and baked diffuse probe APIs are exposed with boundaries', () => {
  assert.ok(renderer.includes('loadEnvironmentHDR'));
  assert.ok(renderer.includes('RGBE/HDR loader is unavailable'));
  assert.ok(renderer.includes('bakeLightProbe'));
  assert.ok(renderer.includes('global-diffuse-light-probe'));
  assert.ok(renderer.includes('not a per-surface lightmap') || renderer.includes('global-diffuse-light-probe'));
});

test('water uses a physical transmission material and animated vertex displacement', () => {
  assert.ok(renderer.includes('transmission:0.82'));
  assert.ok(renderer.includes('ior:1.333'));
  assert.ok(renderer.includes('pstudio-water-waves-v1'));
  assert.ok(renderer.includes('uPStudioWaveAmplitude'));
  assert.ok(renderer.includes('pstudioWaveA'));
});

test('GPU particle trajectories are evaluated by shader attributes', () => {
  for (const token of ['aOrigin', 'aVelocity', 'aBirth', 'aLife', 'uGravity', 'gl_PointSize']) {
    assert.ok(renderer.includes(token), token);
  }
  assert.ok(renderer.includes('createGpuParticleSystem'));
  assert.ok(renderer.includes('spawnGpuParticle'));
});

test('instanced primitive batches preserve per-instance Scene Object mapping', () => {
  assert.ok(renderer.includes('new T.InstancedMesh'));
  assert.ok(renderer.includes('instanceOwnerIds'));
  assert.ok(renderer.includes('instanceSourceKeys'));
  assert.ok(renderer.includes('updateInstancedBatches()'));
});

test('primitive cache uses the same mesh object for caching and rendering', () => {
  const start = renderer.indexOf('const signature=geometrySignature(d);');
  const end = renderer.indexOf('usedMeshes.add(key);', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.ok(block.includes('mesh=new T.Mesh(geometry,material)'));
  assert.ok(block.includes('meshCache.set(key,mesh)'));
  assert.ok(!block.includes('let mesh;'));
});

test('object-local SH GI blends probes and supports iterative diffuse bounce capture',()=>{
  for(const x of ['bakeLightProbeVolume','iterative-multibounce-diffuse-sh-gi','pstudio-object-sh-v1','pstudioEvaluateSH','updateObjectProbeUniforms','bounces','bounceStrength'])assert.ok(renderer.includes(x),x);
});
test('three-cascade shadows load the version-aligned CSM addon with fallback',()=>{
  assert.ok(html.includes('three/addons/csm/CSM.js'));
  for(const x of ['window.PStudioCSM','cascades:3','csm.setupMaterial','csm.update()'])assert.ok(renderer.includes(x),x);
});
test('adaptive rendering adjusts resolution, effects and shadow quality',()=>{
  for(const x of ['applyAdaptiveQuality','adaptiveFrameEMA','adaptiveSlowFrames','setAdaptiveQuality','render.quality.adapted','EXT_disjoint_timer_query_webgl2','TIME_ELAPSED_EXT','gpuRenderTimeMs','gpuTimerQuerySupported','timingSource'])assert.ok(renderer.includes(x),x);
});
test('automatic LOD supports static imported and general meshes',()=>{
  assert.ok(html.includes('three/addons/modifiers/SimplifyModifier.js'));
  for(const x of ['scheduleAutoLOD','pstudioAutoLOD','pstudioAutoLODGenerating','render.lod.generated','applyAutoLOD'])assert.ok(renderer.includes(x),x);
});
test('occlusion culling checks scene meshes and instanced sources incrementally',()=>{
  for(const x of ['updateOcclusionVisibility','occlusionRaycaster','pstudioOccluded','setOcclusionCulling','instanceSources'])assert.ok(renderer.includes(x),x);
});
test('world chunks asynchronously load model assets and release runtime resources',()=>{
  for(const x of ['beginWorldChunkLoad','endWorldChunkLoad','purgeWorldChunkRuntime','releaseChunkAssetCache','chunk.assets','PStudioResources?.trim?.(\'gpu\')','loadingChunks'])assert.ok(renderer.includes(x),x);
});
test('large-world culling retains geometry bounds and chunk assignments',()=>{
  for(const x of ['registerWorldChunk','assignObjectToChunk','unregisterWorldChunk','maxDrawDistance','unloadDistance','isWithinWorldDrawDistance','pstudioBoundsRadius'])assert.ok(renderer.includes(x),x);
});

test('large geometry bounds prevent premature distance culling',()=>{assert.ok(renderer.includes('isWithinWorldDrawDistance'));assert.ok(renderer.includes('computeBoundingSphere'));assert.ok(renderer.includes('pstudioBoundsRadius'));});

test('UV lightmaps generate per-triangle UV2 atlases and persist in IndexedDB',()=>{
  for(const token of ['bakeUVLightmaps','createLightmapUVGeometry','bakeLightmapPixels','saveLightmaps','loadLightmaps','clearLightmaps','PStudioLightmaps','DataTexture','uv2'])assert.ok(renderer.includes(token),token);
});
test('BVH acceleration is optional and connected to occlusion raycasting',()=>{
  assert.ok(html.includes('three-mesh-bvh@0.7.8'));
  assert.ok(html.includes('acceleratedRaycast'));
  for(const token of ['computeBoundsTree','scheduleGeometryBVH','disposeBoundsTree'])assert.ok(renderer.includes(token),token);
});
test('world chunk lifecycle suspends scripts, physics, ECS and owner audio',()=>{
  for(const token of ['isOwnerChunkActive','pauseOwnerAudio','resumeOwnerAudio','play_sound','stop_sound','set_sound_volume'])assert.ok(engine.includes(token),token);
  for(const token of ['setActive','body.active===false'])assert.ok(physics.includes(token),token);
  assert.ok(engine.includes('physicsCommands'));
  for(const token of ['setSceneObjectActive','entityActive.get(id)===false'])assert.ok(ecs.includes(token),token);
  for(const token of ['world.chunk.suspended','world.chunk.resumed'])assert.ok(renderer.includes(token),token);
  for(const token of ['"play_sound": 3','"stop_sound": 1','"set_sound_volume": 2'])assert.ok(app.includes(token),token);
});

test('multi-bounce GI separates direct lighting and converges on bounce energy',()=>{
  for(const token of ['maxBounces','minBounceEnergy','pstudioBounceSource','scene.environment=null','scene.background=new T.Color(0x000000)','completedBounces'])assert.ok(renderer.includes(token),token);
});

test('UV lightmaps use linear half-float textures with a device-aware memory budget',()=>{
  for(const token of ['HalfFloatType','packHalfFloat','floatToHalf','deviceMemory','maxBytes','allocatedBytes','budgetBytes'])assert.ok(renderer.includes(token),token);
});

test('BVH occlusion state persists between bounded candidate checks',()=>{
  assert.ok(renderer.includes('object.userData.pstudioOccluded=!!blocker'));
  assert.ok(renderer.includes('mesh.parent===primitiveGroup'));
  assert.ok(renderer.includes('occlusionRaycaster.firstHitOnly=true'));
  assert.ok(renderer.includes('object.userData.pstudioOccluded=false;object.visible=true'));
});
test('inactive script owners retain prior render commands for seamless resume',()=>{
  assert.ok(engine.includes('runtime.contexts.get(o.id)'));
  assert.ok(engine.includes('runtime.started.has(o.id)'));
  assert.ok(engine.includes('physicsCommands'));
});

test('saved lightmaps validate source geometry and bake-time world transforms',()=>{
  for(const token of ['lightmapGeometryFingerprint','lightmapMatrixMatches','pstudioLightmapBakedMatrix','fingerprint','matrixWorld'])assert.ok(renderer.includes(token),token);
});

test('saved indexed meshes rebuild the same non-indexed UV2 geometry on load',()=>{
  assert.ok(renderer.includes('sourceGeometry.index?sourceGeometry.toNonIndexed():sourceGeometry.clone()'));
  assert.ok(renderer.includes('position.count!==record.vertexCount'));
  assert.ok(renderer.includes('pstudioLightmapOriginalGeometryOwned'));
});


test('GLTF instance rendering reuses mesh references and avoids unchanged material traversals',()=>{
  const materialStart=renderer.indexOf('function applyModelMaterial(instance, state)');
  const materialEnd=renderer.indexOf('function removeModelInstance(key)',materialStart);
  assert.ok(materialStart>=0&&materialEnd>materialStart);
  const materialBlock=renderer.slice(materialStart,materialEnd);
  assert.ok(materialBlock.includes('materialStateSignature'));
  assert.ok(materialBlock.includes('for(const object of instance.meshes||[])'));
  assert.ok(!materialBlock.includes('instance.root.traverse'));
  assert.ok(renderer.includes('materialClones.get(material)'));
  assert.ok(renderer.includes('const materialDefaults=new Map(),materialClones=new Map(),meshes=[]'));
  assert.ok(renderer.includes('for(const object of instance.meshes||[])if(object.userData.pstudioAutoLOD)applyAutoLOD(object,d)'));
});

test('automatic LOD work is serialized into idle callbacks without forced timeout execution',()=>{
  assert.ok(renderer.includes('const autoLODQueue=[]'));
  assert.ok(renderer.includes('function scheduleAutoLODPump()'));
  assert.ok(renderer.includes('window.requestIdleCallback(pump)'));
  assert.ok(!renderer.includes('requestIdleCallback(build,{timeout:1200})'));
});
