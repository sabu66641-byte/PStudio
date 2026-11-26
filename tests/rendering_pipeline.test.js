const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const renderingGI = fs.readFileSync(path.join(root, 'static/pstudio_rendering_gi.mjs'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
const physics = fs.readFileSync(path.join(root, 'static/pstudio_physics.js'), 'utf8');
const ecs = fs.readFileSync(path.join(root, 'static/pstudio_ecs.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const selectUI = fs.readFileSync(path.join(root, 'static/pstudio_selects.js'), 'utf8');
const selectCSS = fs.readFileSync(path.join(root, 'static/pstudio_selects.css'), 'utf8');
const webgpuLab = fs.readFileSync(path.join(root, 'static/pstudio_webgpu_lab.mjs'), 'utf8');
const webgpuBackend = fs.readFileSync(path.join(root, 'static/pstudio_rendering_backend.mjs'), 'utf8');
const webgpuMaterials = fs.readFileSync(path.join(root, 'static/pstudio_rendering_materials.mjs'), 'utf8');
const webgpuPipeline = fs.readFileSync(path.join(root, 'static/pstudio_rendering_pipeline.mjs'), 'utf8');
const webgpuSurface = fs.readFileSync(path.join(root, 'static/pstudio_rendering_surface_tsl.mjs'), 'utf8');
const webgpuWater = fs.readFileSync(path.join(root, 'static/pstudio_rendering_water_tsl.mjs'), 'utf8');
const environmentFX = fs.readFileSync(path.join(root, 'static/pstudio_environment_fx.js'), 'utf8');
const webgpuMigration = fs.readFileSync(path.join(root, 'static/pstudio_rendering_migration.mjs'), 'utf8');
const webgpuEnvironmentTSL = fs.readFileSync(path.join(root, 'static/pstudio_rendering_environment_tsl.mjs'), 'utf8');


test('GLTF worker parser, meshopt decoder, KTX2 and Draco modules share the production r187 runtime',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  assert.ok(worker.includes("three@0.187.0/examples/jsm/loaders/GLTFLoader.js"));
  assert.ok(worker.includes("three@0.187.0/examples/jsm/libs/meshopt_decoder.module.js"));
  assert.ok(worker.includes("three@0.187.0/examples/jsm/loaders/KTX2Loader.js"));
  assert.ok(worker.includes("three@0.187.0/examples/jsm/loaders/DRACOLoader.js"));
  assert.doesNotMatch(worker,/three@0\.160\.0/);
  assert.ok(html.includes('"three": "https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js"'));
  assert.ok(html.includes('"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/"'));
  assert.ok(html.includes('three-mesh-bvh@0.9.18'));
});

test('browser runtime refuses a mismatched Three.js core revision before exposing renderer globals',()=>{
  assert.ok(html.includes("if (String(THREE.REVISION) !== '187')"));
  assert.ok(html.includes('PStudio requires Three.js r187'));
  assert.ok(html.includes("three@0.187.0/build/three.module.js"));
});

test('advanced Three.js rendering add-ons are optional and version-aligned', () => {
  for (const addon of ['GTAOPass.js', 'SSRPass.js', 'RGBELoader.js', 'LightProbeGenerator.js']) {
    assert.ok(html.includes(addon), addon);
  }
  assert.ok(html.includes('three@0.187.0'));
  assert.ok(html.includes('"three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.webgpu.js"'));
  assert.ok(html.includes('"three/tsl": "https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.tsl.js"'));
  assert.ok(html.includes('three-mesh-bvh@0.9.18'));
  assert.ok(html.includes("import('three/webgpu')"));
  assert.ok(html.includes("import('three/tsl')"));
  assert.ok(html.includes('pstudio_rendering_migration.mjs?v=20261126-npr-toon-aa-v2'));
  assert.ok(webgpuMigration.includes('pstudio_rendering_materials.mjs?v=20261126-npr-toon-v1'));
  assert.ok(renderer.includes('getRenderingBackendStatus:renderingBackendStatus'));
  assert.ok(renderer.includes('renderingBackend:renderingBackendStatus()'));
  assert.ok(html.includes('PStudioWebGPURenderer'));
  assert.ok(html.includes('PStudioTSL'));
  assert.ok(renderer.includes('webgpuModuleAvailable'));
  assert.ok(renderer.includes('tslModuleAvailable'));
  assert.ok(renderer.includes("tslNodesEnabled:false"));
});

test('auto quality keeps device-aware scaling while Ultra uses the shared 2x render helper',()=>{
  assert.ok(renderer.includes("if(qualityPreset==='auto'&&selected==='mobile'&&isTouchDevice&&deviceMemoryGiB()>2)adaptiveQualityLevel=1"));
  assert.ok(renderer.includes("const base=resolveQualityRenderPixelRatio(selected,level,adaptive)"));
  assert.ok(renderer.includes("applyEffectiveRenderScale()"));
  assert.ok(renderer.includes("selected==='maximum'?[.66,.78,.94][level]"));
  assert.ok(renderer.includes("const adaptiveScale=adaptive?[0.35,0.65,1][level]:1"));
  assert.ok(renderer.includes("const targetRatio=Math.min(requested*adaptiveScale,mobilePixelRatioCap)"));
  assert.ok(renderer.includes("lastFrameIntervalMs>0?'frame-interval-fallback':'cpu-render-submission'"));
});
test('Ultra can reduce actual drawing-buffer resolution when adaptive quality steps down',()=>{
  assert.ok(renderer.includes('const adaptiveScale=adaptive?[0.35,0.65,1][level]:1'));
  assert.ok(renderer.includes('const targetRatio=Math.min(requested*adaptiveScale,mobilePixelRatioCap)'));
  assert.ok(renderer.includes('frame-interval-fallback'));
  assert.ok(renderer.includes('Math.max(Number(lastRenderDurationMs)||0,Number(lastFrameIntervalMs)||0)'));
});

test('constrained touch Maximum and Ultra preserve configured effects while applying resolution budgeting',()=>{
  assert.ok(renderer.includes("adaptiveTouchResolutionBudget=adaptiveMaximumTouchMode||adaptiveUltraTouchMode"));
  assert.ok(renderer.includes("const premiumEffectsEnabled=effectsEnabled;"));
  assert.ok(renderer.includes("const effects=!memorySafetyApplied;"));
  assert.ok(renderer.includes("const cloudTierActive=!memorySafetyApplied;"));
  assert.ok(renderer.includes("adaptiveTouchResolutionBudget?[.72,.9,1.05][level]:Infinity"));
  assert.ok(renderer.includes("adaptiveTouchResolutionBudget?[.8,1.0,1.2][level]:Infinity"));
  assert.ok(renderer.includes("mobileResolutionBudget:adaptiveTouchResolutionBudget"));
  assert.ok(renderer.includes("touchResolutionBudget:adaptiveTouchResolutionBudget"));
  assert.ok(renderer.includes("effectSuppressionReason:memorySafetyApplied?'memory-safety-guard':null"));
  assert.ok(renderer.includes("volumetricFogEnabled=!!enabled&&!memorySafetyApplied"));
  assert.ok(renderer.includes("volumetricCloudsEnabled=!!enabled&&!memorySafetyApplied&&!!volumetricCloudPass"));
  assert.ok(renderer.includes("contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied&&"));
  assert.ok(renderer.includes("ssaoEnabled=!!ssao&&!memorySafetyApplied"));
  assert.ok(renderer.includes("ssrEnabled=!!ssr&&!memorySafetyApplied"));
  assert.doesNotMatch(renderer,/premiumEffectsEnabled=effectsEnabled&&!adaptiveTouchResolutionBudget/);
  assert.doesNotMatch(renderer,/volumetricCloudsEnabled=!!enabled&&!adaptiveTouchResolutionBudget/);
});

test('quality presets configure render resolution and shadow filtering', () => {
  for (const preset of ['mobile', 'balanced', 'high', 'maximum', 'ultra']) assert.ok(renderer.includes(preset));
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
  assert.ok(renderer.includes('pstudio-water-hq-v2-') || renderer.includes('pstudio-water-waves-fallback-v2'));
  assert.ok(renderer.includes('uPStudioWaveAmplitude'));
  assert.ok(renderer.includes('pstudioWaterHQ') || renderer.includes('pstudioWaveA'));
});

test('Mirror Water uses bounded reflection targets coordinated by the shared frame budget',()=>{
  for(const token of [
    'renderMirrorWaterReflections','configureMirrorWaterMaterial','createMirrorWaterState',
    'pstudio-planar-mirror-water-v2','uMirrorReflectivity','uMirrorWaveStrength',
    'mirrorWaterResolutionScale','new T.WebGLRenderTarget','reflectionCamera.lookAt',
    'renderer.clippingPlanes=[state.plane.clone()]','state.hasRendered=true',
    'const base=memorySafetyApplied||adaptiveTouchResolutionBudget||(hardware.touch&&adaptiveQualityLevel===0)?0.86:1.0',
    'return base*(renderingFrameBudgetController?renderingFrameBudget.mirrorResolutionScale:1)',
    'renderer.capabilities?.maxTextureSize',
    'Math.floor(size.x*scale)',
    'Math.floor(size.y*scale)',
    'cameraAnchoredSky=[physicalSky,moonMesh,sunMesh,nightTwinkleStars]',
    'scene.background retains the active day/dusk/night equirectangular panorama',
    'renderer.render(scene,reflectionCamera)',
    'const updateInterval=renderingFrameBudgetController',
    'renderingFrameBudget.mirrorIntervalFrames',
    ':touch?(memorySafetyApplied||adaptiveQualityLevel===0?3:2):1'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(engine.includes("case 'draw_mirror_water'"));
  assert.ok(engine.includes("type:'mirror_water'"));
  assert.ok(app.includes('"draw_mirror_water": (5, 7)'));
  assert.ok(html.includes('addMirrorWaterToScene()'));
  assert.ok(html.includes('id="scene-object-add-select"'));
  assert.ok(html.includes('value="mirror-water">水鏡（平面）'));
  assert.ok(html.includes('function addSceneObjectFromMenu(kind)'));
  assert.ok(html.includes('mirrorWidth:PSTUDIO_SCENE_GRID_SIZE,mirrorDepth:PSTUDIO_SCENE_GRID_SIZE'));
  assert.ok(html.includes('const PSTUDIO_SCENE_GRID_SIZE=500'));
  assert.ok(html.includes('value="500"'));
  assert.ok(engine.includes('const SCENE_PREVIEW_GRID_SIZE=500'));
  assert.ok(engine.includes("{type:'grid',size:SCENE_PREVIEW_GRID_SIZE,divisions:100}"));
  assert.ok(engine.includes('Number(o.mirrorDepth)||SCENE_PREVIEW_GRID_SIZE'));
  assert.ok(html.includes('function toggleSceneEditorExpanded(force)'));
  assert.ok(html.includes('.game-surface.is-expanded'));
  assert.ok(html.includes('mobile-scene-inspector'));
  assert.ok(html.includes('id="obj-mirror-water-settings"'));
  assert.ok(html.includes("updateSelectedObject('mirrorReflectivity',this.value)"));
  assert.ok(html.includes("updateSelectedObject('waveStrength',this.value)"));
});

test('Mirror Water shader uses valid GLSL line breaks, full reflectivity defaults and a polished mirror surface',()=>{
  const start=renderer.indexOf('function configureMirrorWaterMaterial');
  const end=renderer.indexOf('function createMirrorWaterState',start);
  const shader=renderer.slice(start,end);
  assert.ok(shader.includes("uMirrorTextureMatrix;\\nvarying"),"GLSL declarations use a real newline escape");
  assert.equal(shader.includes("uMirrorTextureMatrix;\\\\nvarying"),false,"double-escaped GLSL line breaks are forbidden");
  assert.ok(shader.includes("pstudio-planar-mirror-water-v2"));
  assert.ok(shader.includes("uMirrorReflectivity:{value:1.0}"));
  assert.ok(shader.includes("pStudioMirrorAmount = clamp(uMirrorReflectivity, 0.0, 1.0) * pStudioMirrorInside"));
  assert.ok(renderer.includes("reflectivity:1.0"));
  assert.ok(renderer.includes("roughness:0.012,metalness:0,clearcoat:1,clearcoatRoughness:0.008"));
  assert.ok(renderer.includes("if(d.type!=='water'&&d.type!=='mirror_water'){"));
  assert.ok(engine.includes("reflectivity:a.length>=6?Math.max(0,Math.min(1,finite(a[5]))):1.0"));
  assert.ok(html.includes('id="obj-mirror-reflectivity" type="range" min="0" max="1" step="0.01" value="1"'));
});

test('day sky palette removes the green-gray lower hemisphere and softens the blown white horizon',()=>{
  const start=renderer.indexOf("day:[[");
  const end=renderer.indexOf("dusk:[[",start);
  const dayPalette=renderer.slice(start,end);
  assert.ok(dayPalette.includes('#1A4F86')&&dayPalette.includes('#4798D0'),'day sky is slightly bluer');
  assert.ok(dayPalette.includes('#B5D0DB')&&dayPalette.includes('#405969'),'horizon and lower hemisphere use blue-gray tones');
  assert.doesNotMatch(dayPalette,/#879998|#4B595A|#313B3D/i);
});

test('Mirror Water remains additive and does not replace legacy PBR draw_water',()=>{
  assert.ok(engine.includes("case 'draw_water': if(a.length===7)"));
  assert.ok(engine.includes("case 'draw_mirror_water': if(a.length>=5&&a.length<=7)"));
  assert.ok(renderer.includes("if(d.type==='water')"));
  assert.ok(renderer.includes("d.type==='mirror_water'"));
  assert.ok(renderer.includes('configureWaterMaterial(material)'));
  assert.ok(renderer.includes('configureMirrorWaterMaterial('));
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

test('r187 async SimplifyModifier results are awaited serially and discarded after source invalidation',()=>{
  const start=renderer.indexOf('function scheduleAutoLODPump(){');
  const end=renderer.indexOf('function scheduleAutoLOD(',start);
  assert.ok(start>=0&&end>start,'automatic LOD scheduler boundaries');
  const scheduler=renderer.slice(start,end);
  assert.match(scheduler,/const pump=async deadline=>/);
  assert.match(scheduler,/await modifier\.modify\(/);
  assert.match(scheduler,/if\(!isCurrent\(\)\)\{[\s\S]*?lod\.dispose\?\.\(\)/);
  assert.match(scheduler,/finally\{\s*autoLODPumpScheduled=false;\s*if\(autoLODQueue\.length\)scheduleAutoLODPump\(\);\s*\}/);
  assert.doesNotMatch(scheduler,/const lod=modifier\.modify\(/);
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
  assert.ok(html.includes('three-mesh-bvh@0.9.18'));
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
  assert.ok(engine.includes('window.PStudioECSScript?.getLifecycle?.(o.id)'));
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
  const materialEnd=renderer.indexOf('function updateModelIK(instance, ik)',materialStart);
  assert.ok(materialStart>=0&&materialEnd>materialStart);
  const materialBlock=renderer.slice(materialStart,materialEnd);
  assert.ok(materialBlock.includes('materialStateSignature'));
  assert.ok(materialBlock.includes('const geometryTargets=['));
  assert.ok(materialBlock.includes('const materialTargets=geometryTargets;'));
  assert.ok(materialBlock.includes('for(const object of materialTargets)'));
  assert.ok(!materialBlock.includes('instance.root.traverse'));
  assert.ok(renderer.includes('materialClones.get(cacheKey)'));
  assert.ok(renderer.includes("waterDetailRole?'water-detail:'+waterDetailRole:''"));
  assert.ok(renderer.includes("windRole?'wind:'+windRole:''"));
  assert.ok(renderer.includes('const materialDefaults=new Map(),materialClones=new Map(),meshes=[],geometryOriginals=new Map(),normalGeometryClones=new Map()'));
  assert.ok(renderer.includes('for(const object of instance.meshes||[])if(!object.userData.pstudioBatchedIntoStaticInstance&&object.userData.pstudioAutoLOD?.length>1)applyAutoLOD(object,objectCameraDistance(object))'));
  assert.ok(renderer.includes('for(const entry of instance.foliageBatches||[])'));
  assert.ok(renderer.includes('entry.mesh.userData.pstudioAutoLOD?.length>1'));
});

test('automatic LOD work is serialized into idle callbacks without forced timeout execution',()=>{
  assert.ok(renderer.includes('const autoLODQueue=[]'));
  assert.ok(renderer.includes('function scheduleAutoLODPump()'));
  assert.ok(renderer.includes('window.requestIdleCallback(deadline=>{void pump(deadline);},{timeout:1000})'));
  assert.ok(!renderer.includes('requestIdleCallback(build,{timeout:1200})'));
});


test('environment FX provide water depth tint, shoreline foam, foliage wind and underwater caustics',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['uPStudioWaterShallow','uPStudioWaterDeep','foamBand','pstudioWaterHQ','uPStudioWindTime','uPStudioFoliageHeight','uPStudioCausticTime','configureObject'])assert.ok(fx.includes(token),token);
});
test('environment FX are loaded before the isolated 3D renderer',()=>{
  const plugin=html.indexOf('pstudio_environment_fx.js');
  const rendererScript=html.indexOf('pstudio_3d_engine.js');
  assert.ok(plugin>=0&&rendererScript>plugin);
});
test('renderer exposes volumetric fog, TSL AA controls, and fail-closed AA parity diagnostics',()=>{
  for(const token of ['setVolumetricFog','volumetricFogPass','setTemporalAA','TAARenderPass','SMAAPass','anti-aliasing-parity'])assert.ok(renderer.includes(token),token);
});
test('imported named foliage meshes can be combined into owner-preserving GPU instance batches',()=>{
  for(const token of ['buildFoliageInstanceBatches','PStudio_GPU_Instances_','pstudioFoliageSources','updateFoliageInstanceBatches'])assert.ok(renderer.includes(token),token);
});


test('foliage model LODs are batched independently and switched by camera distance',()=>{
  for(const token of ['pstudioFoliageLOD','match(/LOD([0-9]+)/i)','entry.level===selected.level','foliageInstancedBatches','foliageInstancedInstances'])assert.ok(renderer.includes(token),token);
});
test('parallax mapping consumes height stored in the normal texture alpha channel',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['configureParallax',"heightSource:'normalTexture alpha'",'normalMap','pStudioHeight=texture2D(normalMap','pstudio-parallax-alpha-height-v2'])assert.ok(fx.includes(token),token);
});


test('parallax shader uses a writable local UV instead of assigning to a fragment varying',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.ok(fx.includes('vec2 pStudioParallaxUv=vMapUv'));
  assert.ok(fx.includes('texture2D(map,pStudioParallaxUv)'));
  assert.ok(!fx.includes('vMapUv=pUV'));
  assert.ok(!fx.includes('vMapUv=pStudioParallaxUv'));
  assert.ok(fx.includes('vPStudioParallaxViewPosition=-mvPosition.xyz'));
});
test('water and caustics world positions do not depend on optional worldPosition declarations',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.ok(fx.includes('vPStudioWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz'));
  assert.ok(fx.includes('vPStudioCausticWorld=(modelMatrix*vec4(transformed,1.0)).xyz'));
  assert.ok(!fx.includes('vPStudioWaterWorld=worldPosition.xyz'));
  assert.ok(!fx.includes('vPStudioCausticWorld=worldPosition.xyz'));
});


test('generated foliage instance batches are excluded from authored mesh LOD node collection',()=>{
  assert.ok(renderer.includes('PStudio_GPU_Instances_'));
  assert.ok(!renderer.includes("batch.name='PStudio_GPU_Instances_'+(group.isTree?'Foliage_LOD'"));
});


test('water uses opaque scene depth to derive water thickness and shoreline foam',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const engine=renderer;
  for(const token of ['uPStudioSceneDepth','uPStudioWaterViewport','uPStudioSceneDepthValid','waterThickness','shorelineFoam','setSceneDepthTexture'])assert.ok(fx.includes(token),token);
  for(const token of ['renderWaterDepthPrepass','waterDepthTarget','MeshDepthMaterial','pstudioWaterSurface','setSceneDepthTexture?.(waterDepthTarget.depthTexture'])assert.ok(engine.includes(token),token);
});
test('water depth prepass restores scene visibility, override material and render target after rendering',()=>{
  for(const token of ['previousOverride','previousTarget','for(const object of hidden)object.visible=true','scene.overrideMaterial=previousOverride','renderer.setRenderTarget(previousTarget)'])assert.ok(renderer.includes(token),token);
});


test('primitive water is tagged for depth prepass and uses its actual geometry bounds',()=>{
  assert.ok(renderer.includes("mesh.userData.pstudioWaterSurface=true"));
  assert.ok(renderer.includes('waterUniforms.bounds.value.set(bounds.min.x,bounds.min.z'));
  assert.ok(renderer.includes('setupLightingMaterial(material);\n            material=configureWaterMaterial(material);'));
});


test('world-space triplanar PBR projects albedo, normal, roughness and metalness across rock and terrain',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['configureTriplanar','pstudio-world-triplanar-pbr-v1','vPStudioTriWorldPosition','pStudioTriColor','pStudioTriNormal','pStudioR','pStudioM','pstudioSurfaceMode'])assert.ok(fx.includes(token),token);
});
test('volumetric cloud pass raymarches a procedural cloud field and atmospheric horizon',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['createVolumetricCloudPass','uCloudBase','uCloudTop','pFbm','pCloudDensity','uSunDirection','pHenyeyGreenstein','lightOptical','transmittance','uCloudCoverage'])assert.ok(fx.includes(token),token);
});
test('High, Maximum and Ultra enable the full atmospheric cloud rendering stack',()=>{
  for(const token of ["high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}","maximum:{pixelRatio:2.1,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}","ultra:{pixelRatio:4.2,shadowSize:8192,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}",'setVolumetricClouds','volumetricCloudsEnabled=effects&&!!base.clouds','hideStaticSkyForVolumetrics'])assert.ok(renderer.includes(token),token);
});
test('GLB auto-play animation extras start a looping environment animation on import',()=>{
  assert.ok(renderer.includes('pstudioAutoPlayAnimation'));
  assert.ok(renderer.includes('mixer.clipAction(autoClip)'));
  assert.ok(renderer.includes('action.reset().setLoop(T.LoopRepeat,Infinity).play()'));
});
test('animated tree parts inherit their parent LOD and share GPU instance batches',()=>{
  for(const token of ["windRole==='leaf'","windRole==='branch'",'while(!levelMatch&&parent&&parent!==root)','PStudio_GPU_Instances_','entry.isTree&&Number.isInteger(entry.level)'])assert.ok(renderer.includes(token),token);
});
test('modular architecture components are batched independently from foliage and remain visible across tree LOD changes',()=>{
  for(const token of ['/\^PStudioInstance_/i','group.isTree','level===null||level===0','modelInstancedBatches'])assert.ok(renderer.includes(token),token);
});
test('volumetric sky replaces baked cloud meshes only while the cloud renderer is active and restores visibility',()=>{
  for(const token of ['hideStaticSkyForVolumetrics','restoreStaticSky','volumetricCloudsEnabled','cloudbank|cumulus|cirrus'])assert.ok(renderer.includes(token),token);
});
test('multi-bounce environment GI has a high quality entry point and resolution presets',()=>{
  assert.ok(renderer.includes("resolution:options.resolution??(qualityPreset==='ultra'?192:qualityPreset==='maximum'?128:96)"));
});
test('GTAO output uses the scene composite mode rather than the AO-only debug view',()=>{
  assert.ok(renderer.includes('gtaoPass.output=FX.GTAOPass.OUTPUT.Default'));
  assert.ok(!renderer.includes('gtaoPass.output=FX.GTAOPass.OUTPUT.Denoise'));
});
test('high-detail asset loads receive device-aware CPU and GPU resource budgets',()=>{
  for(const token of ['window.navigator?.deviceMemory','PStudioResources?.setBudget?.(\'gpu\'','PStudioResources?.setBudget?.(\'cpu\''])assert.ok(renderer.includes(token),token);
});


test('GLB spatial chunks preserve child transforms and stream detail by GPU-aware distance',()=>{
  for(const token of ['buildModelStreamingChunks','pstudioStreamingConfig','chunk.attach(group.children[i])','pstudioStreamChunkId','pstudioStreamLoadDistance','updateModelStreamingChunks','activeModelStreamChunks'])assert.ok(renderer.includes(token),token);
});
test('chunk-local GPU instance batches retain animated tree transforms but do not update static architecture every frame',()=>{
  for(const token of ['const inverseParent=parent.matrixWorld.clone().invert()','pstudioStreamChunkId','animatedFoliageBatches:foliageBatches.filter(entry=>entry.isTree)','const entries=instance?.animatedFoliageBatches','if(!entry.mesh.visible||!(entry.parent||root).visible)continue','parent.updateWorldMatrix(true,false)','modelInstancedBatches'])assert.ok(renderer.includes(token),token);
});


test('GLB metadata is inherited from nested glTF scene nodes before autoplay and streaming setup',()=>{
  assert.ok(renderer.includes('extras.pstudioAutoPlayAnimation'));
  assert.ok(renderer.includes('extras.pstudioStreamingConfig'));
  assert.ok(renderer.includes('clone.userData.pstudioAutoPlayAnimation=extras.pstudioAutoPlayAnimation'));
  assert.ok(renderer.includes('clone.userData.pstudioStreamingConfig=extras.pstudioStreamingConfig'));
});
test('streamed chunks are initially unloaded and retain hysteresis while their local children keep transforms',()=>{
  for(const token of ['pstudioStreamActive=false','chunk.visible=false','chunk.attach(group.children[i])','pstudioStreamUnloadDistance','const threshold=wasActive?chunk.userData.pstudioStreamUnloadDistance'])assert.ok(renderer.includes(token),token);
});
test('tree trunk, branch and leaf tracks are all preserved by the animation-aware instancer',()=>{
  for(const token of ["windRole==='trunk'","windRole==='branch'","windRole==='leaf'","PStudio_GPU_Instances_"])assert.ok(renderer.includes(token),token);
});
test('static architectural instance transforms are not recomputed every animation frame',()=>{
  assert.ok(renderer.includes('animatedFoliageBatches:foliageBatches.filter(entry=>entry.isTree)'));
  assert.ok(renderer.includes('const entries=instance?.animatedFoliageBatches'));
  assert.ok(!renderer.includes('const T=window.THREE,root=instance.root;root.updateMatrixWorld(true)'));
  assert.ok(renderer.includes('parent.updateWorldMatrix(true,false)'));
});


test('cloud and atmospheric depth consumers trigger scene depth capture even without water',()=>{
  assert.ok(renderer.includes('const needsDepth=Number(stats?.waterMaterials)>0||volumetricFogEnabled||volumetricCloudsEnabled'));
  assert.ok(renderer.includes('if(!waterDepthTarget||!waterDepthMaterial||!needsDepth)'));
});
test('static modular architecture GPU batches contribute to opaque scene depth',()=>{
  assert.ok(renderer.includes('object.userData?.pstudioFoliageLOD!==undefined'));
  assert.ok(!renderer.includes('object.userData?.pstudioInstanceBatch||transparent'));
  assert.ok(renderer.includes("'Architecture_Static'"));
});
test('streaming chunks are constructed from top-level world children for this GLB hierarchy',()=>{
  assert.ok(renderer.includes('for(const child of [...root.children])'));
  assert.ok(renderer.includes('/^PStudioInstance_/i.test(name)'));
  assert.ok(renderer.includes('/(?:^|[_ -])Wind[_ -]?Tree/i.test(name)'));
});


test('world chunk registry preserves in-flight state and invalidates asset changes safely',()=>{
  const start=renderer.indexOf('function registerWorldChunk');
  const end=renderer.indexOf('function assignObjectToChunk',start);
  assert.ok(start>=0&&end>start);
  const block=renderer.slice(start,end);
  assert.ok(block.includes('const chunk=old||'));
  assert.ok(block.includes('assetsChanged&&(old.active||old.loading)'));
  assert.ok(block.includes('const retainedAssets=new Set(old.assets.filter(name=>assets.includes(name)))'));
  assert.ok(block.includes('endWorldChunkLoad(old,retainedAssets)'));
  assert.ok(block.includes('worldChunks.set(key,chunk)'));
  assert.ok(block.includes('loading:chunk.loading'));
  assert.ok(renderer.includes('const requestedAssets=chunk.assets.slice()'));
  assert.ok(renderer.includes('if(token!==chunk.generation){releaseStaleChunkAssets(chunk,requestedAssets);return;}'));
  assert.ok(renderer.includes('const retained=(chunk.active||chunk.loading)?new Set(chunk.assets||[]):new Set()'));
  assert.ok(renderer.includes('const stale=(requestedAssets||[]).filter(name=>!retained.has(name))'));
  assert.ok(renderer.includes('releaseChunkAssetCache(chunk,requestedAssets)'));
});
test('world chunk streaming supports multiple interest positions and bounded prioritized loading',()=>{
  for(const token of [
    'setWorldStreamingInterests','clearWorldStreamingInterests',
    'worldStreamingInterests=[]','const interests=worldStreamingInterests',
    'Math.hypot(dx,dy,dz)','maxConcurrentChunkLoads',
    'loadCandidates.sort((a,b)=>b.priority-a.priority',
    'for(let index=0;index<Math.min(budget,loadCandidates.length);index++)'
  ])assert.ok(renderer.includes(token),token);
});
test('triplanar projection honors scale and normal blend values authored in GLB material extras',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.ok(fx.includes('material.userData?.pstudioTriplanarScale'));
  assert.ok(fx.includes('material.userData?.pstudioTriplanarSharpness'));
  assert.ok(fx.includes('material.userData?.pstudioTriplanarNormalWeight'));
});


test('GLB water detail extras are routed before generic water/foam detection',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.ok(fx.includes("if(object.userData?.pstudioWaterDetail){"));
  assert.ok(fx.indexOf("if(object.userData?.pstudioWaterDetail){")<fx.indexOf("else if(WATER.test(tag))"));
});
test('water detail materials remain transparent, depth-write disabled and time animated',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['configureWaterDetail','material.transparent=true','material.depthWrite=false','uPStudioWaterDetailTime','waterDetailMaterials','waterDetailMaterials.delete(material)'])assert.ok(fx.includes(token),token);
});
test('trunk, branch and leaves receive separate world-phased wind response strengths',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ["role === 'trunk' ? 0.12","role === 'branch' ? 0.42","role === 'leaf' ? 0.88",'worldPhase=dot(pstudioWindWorld.xz','leafFlutter=sin','pstudio-foliage-wind-hq-v4-'])assert.ok(fx.includes(token),token);
});
test('GLB water surface uses four wave bands and separate micro-normal frequencies',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['wp1=position.x*.071','wp2=position.x*.137','wp3=position.x*.31','wp4=position.x*.49','microA=sin','microB=sin','crossRipple=sin'])assert.ok(fx.includes(token),token);
});
test('per-role shader material caching avoids trunk-branch-leaf and spray-foam uniform collisions',()=>{
  assert.ok(renderer.includes('pstudioWindPart'));
  assert.ok(renderer.includes('pstudioWaterDetail'));
  assert.ok(renderer.includes("material.uuid+'|pstudio-role:'+roleKey"));
});
test('static repeated detail geometry is eligible for chunk-local instancing',()=>{
  assert.ok(renderer.includes('/^PStudioInstance_/i.test(objectName)'));
  assert.ok(renderer.includes('chunkId=streamParent.userData?.pstudioStreamChunkId'));
  assert.ok(renderer.includes('groups.get(key).sources.push(object)'));
});
test('GPU-updated foliage transforms skip hidden LOD and streamed chunks',()=>{
  assert.ok(renderer.includes('animatedFoliageBatches:foliageBatches.filter(entry=>entry.isTree)'));
  assert.ok(renderer.includes('const entries=instance?.animatedFoliageBatches'));
  assert.ok(renderer.includes('if(!entry.mesh.visible||!(entry.parent||root).visible)continue'));
});


test('large GLB loading uses an object URL and progress events instead of an app-owned full ArrayBuffer copy',()=>{
  assert.ok(renderer.includes('window.PStudioAssetStore.get(assetName,{cache:false})'));
  assert.ok(renderer.includes('URL.createObjectURL(blob)'));
  assert.ok(renderer.includes('loader.load(url,resolve,event=>'));
  assert.ok(renderer.includes('URL.revokeObjectURL(url)'));
  assert.ok(!renderer.includes("const source=name.toLowerCase().endsWith('.gltf') ? await blob.text() : await blob.arrayBuffer()"));
});
test('large model loading checks estimated runtime memory against device memory before decoding',()=>{
  for(const token of ['function modelRuntimeBudgetBytes()','estimatedRuntimeBytes','const safeBudget=modelRuntimeBudgetBytes()','元のモデルはIndexedDBに保存済みです'])assert.ok(renderer.includes(token),token);
});
test('failed model loading clears pending promises so the same model can be retried',()=>{
  assert.ok(renderer.includes('if(modelPromises.get(assetName)===promise)modelPromises.delete(assetName)'));
  assert.ok(!renderer.includes('if(modelPromises.get(name)===promise&&modelCache.has(name))modelPromises.delete(name)'));
});
test('renderer exposes live memory telemetry and activates a safe graphics mode under memory pressure',()=>{
  for(const token of ['function memorySnapshot()','function sampleMemoryPressure()','pstudio-memory-snapshot','heapPressure','modelPressure','memorySafetyApplied','getMemoryStats:memorySnapshot'])assert.ok(renderer.includes(token),token);
});
test('low-memory devices disable hardware MSAA and Auto selects conservative tiers without overriding manual quality',()=>{
  assert.ok(renderer.includes('antialias:deviceGiB>=6'));
  assert.ok(renderer.includes('if(memoryGiB<=2||cpuCores<=2||maxTextureSize<2048)return \'mobile\''));
  assert.ok(renderer.includes('if(memoryGiB<=3||cpuCores<4||maxTextureSize<4096||(touch&&memoryGiB<=4))return \'balanced\''));
  assert.ok(renderer.includes("const memoryCap=qualityPreset==='ultra'"));
  assert.ok(renderer.includes('const baseProfile=QUALITY_PROFILES[selected],profile=baseProfile'));
});


test('large GLB memory preflight checks both total runtime and JavaScript heap budgets',()=>{
  for(const token of ['function modelRuntimeBudgetBytes()','function modelCpuHeapBudgetBytes()','metadata?.estimatedCpuBytes','const safeBudget=modelRuntimeBudgetBytes(),cpuBudget=modelCpuHeapBudgetBytes()','CPU側'])assert.ok(renderer.includes(token),token);
  assert.ok(html.includes('estimatedCpuBytes:inspection.estimatedCpuBytes'));
});


test('model GPU preparation uploads textures across frames and precompiles shaders asynchronously when supported',()=>{
  for(const token of ['prepareModelInstance','collectModelTextures','nextPreparationFrame','renderer?.initTexture?.(texture)','gpu-textures','KHR_parallel_shader_compile','renderer.compileAsync(instance.root,camera,scene)','shaderCompileQueue','preparing'])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes('instance.preparing=false'));
  assert.ok(renderer.includes('preparationCancelled'));
});

test('model LOD uses world-space bounds for both authored LOD groups and generated mesh LOD',()=>{
  for(const token of ['function modelCameraDistance(instance)','function objectCameraDistance(object)','function updateModelLOD(instance)','instance.localBoundsCenter','applyAutoLOD(object,objectCameraDistance(object))'])assert.ok(renderer.includes(token),token);
});

test('static model meshes use native frustum culling while animated deformation remains conservatively visible',()=>{
  assert.ok(renderer.includes('object.frustumCulled=!(object.isSkinnedMesh||(object.morphTargetInfluences?.length>0))'));
  assert.ok(renderer.includes('batch.frustumCulled=true'));
});

test('GPU and CPU resource-cache pressure contribute to memory safety telemetry',()=>{
  for(const token of ['gpuPressure','gpuBudgetBytes','cpuResourcePressure','estimatedGpuBytes','modelPreparationPending','stagedTextureUploads'])assert.ok(renderer.includes(token),token);
});


test('per-instance frustum culling filters instanced draw batches against the camera projection',()=>{
  for(const token of ['new T.Frustum()','new T.Matrix4()','camera.updateMatrixWorld(true)','worldFrustum.setFromProjectionMatrix(worldFrustumMatrix)','uniforms.planes[i]?.copy?.(worldFrustum.planes[i])'])assert.ok(renderer.includes(token),token);
});

test('GLTF scene decode timing is reported separately from binary fetch and GPU preparation',()=>{
  for(const token of ['scene-decode-start','scene-decoded','durationMs','gpu-textures','shader-precompile',"stage:'prepared'"])assert.ok(renderer.includes(token),token);
});


test('GLTFLoader runs in a module worker and transfers a structured scene packet',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  for(const token of [
    'GLTFLoader','loader.parseAsync(buffer, \'\')','serializeGLTF(gltf',
    'transferTypedArray','ImageBitmap','boneInverses','clip.constructor.toJSON(clip)',
    'isInstancedMesh','parseMs','serializeMs','postMessage({ id: message.id, ok: true, result: packet }'
  ])assert.ok(worker.includes(token),token);
  for(const token of [
    'new window.Worker(\'/static/pstudio_gltf_worker.js\'',
    'worker.postMessage({id,op:\'parse-glb\',blob,assetKey:name,textureSupport:getWorkerTextureSupport()}',
    'hydrateGLTFWorkerPacket(packet,name)','CompressedTexture','CompressedArrayTexture',
    'parseGLTFOnMainThread(blob,name)'
  ])assert.ok(renderer.includes(token),token);
});

test('large model scene hydration and instance creation yield between bounded batches',()=>{
  for(const token of [
    'async function hydrateGLTFWorkerPacket','await checkpoint(\'scene-hydrate-geometry\'',
    'async function cloneModelHierarchyAsync','async function createModelInstanceAsync',
    'await buildModelStreamingChunks(clone)','await buildFoliageInstanceBatches(clone,asset.animations||[])',
    'await nextPreparationFrame()','modelInstancePromises'
  ])assert.ok(renderer.includes(token),token);
});

test('GPU texture preparation is staged and shader compilation targets only the hidden new model',()=>{
  for(const token of [
    'function collectModelTextures','renderer?.initTexture?.(texture)',
    'stage:\'gpu-textures\'','renderer.compileAsync(instance.root,camera,scene)',
    'instance.preparationCancelled','parallelShaderCompileSupported'
  ])assert.ok(renderer.includes(token),token);
});

test('virtual texturing retains source images in the worker and streams page tiles into bounded GPU atlases',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  for(const token of [
    'VIRTUAL_IMAGES.set(workerImageKey,bitmap)','message.op === \'extract-tile\'',
    'new OffscreenCanvas(width, height)','message.op === \'release-asset\''
  ])assert.ok(worker.includes(token),token);
  for(const token of [
    'initializeVirtualTextureAtlas','renderer.copyTextureToTexture',
    'virtualTexturePageCache','requestVirtualTexturePage',
    'requestVisibleVirtualTextureTiles','setupVirtualTextureMaterial',
    'texture.userData.pstudioVirtualTexture'
  ])assert.ok(renderer.includes(token),token);
});

test('clustered forward lighting assigns point lights to spatial clusters and evaluates local lights in the GPU shader',()=>{
  for(const token of [
    'CLUSTER_GRID_X=16','CLUSTER_MAX_LIGHTS=96','CLUSTER_MAX_PER_CELL=24',
    'ensureClusteredLightingResources','function updateClusteredLighting',
    'getDistanceAttenuation','BRDF_Lambert(diffuseColor.rgb)',
    'setClusteredLighting:enabled','clusteredLighting:{enabled:'
  ])assert.ok(renderer.includes(token),token);
});

test('instanced GPU frustum rejection uses instance transforms and model-space bounding spheres',()=>{
  for(const token of [
    'function enableGPUFrustumCullingForBatch','uPStudioFrustumCenter',
    'modelMatrix*instanceMatrix','worldFrustum.setFromProjectionMatrix(worldFrustumMatrix)',
    'setGPUInstanceFrustumCulling'
  ])assert.ok(renderer.includes(token),token);
});

test('virtual texture and clustered-light allocations are included in renderer memory telemetry',()=>{
  for(const token of ['virtualTextureAtlasBytes','clusteredLightingBytes','atlasBytes:','gpuPressure','getMemoryStats:memorySnapshot'])assert.ok(renderer.includes(token),token);
});


test('GLTF worker transfers shared attribute backing buffers with byte offsets rather than copying each attribute',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  assert.ok(worker.includes('byteOffset: view.byteOffset||0'));
  assert.ok(worker.includes('TRANSFERS.add(view.buffer)'));
  assert.ok(renderer.includes('new Constructor(record.buffer,Number(record.byteOffset)||0,record.length)'));
});
test('cluster overflow preserves lights in the native renderer instead of dropping them',()=>{
  assert.ok(renderer.includes('fitsEveryCluster'));
  assert.ok(renderer.includes('if(!fitsEveryCluster)continue'));
  assert.ok(renderer.includes('clusteredLightSet.has(light)'));
  assert.ok(renderer.includes('nativeFallbackPointLights:'));
});


test('GLB packet hydration failures recover through the compatible main-thread loader',()=>{
  for(const token of ["loadStage='worker-hydrate'","disposeWorkerPacket(workerPacket)","loadStage='main-thread-fallback'","gltf=await parseGLTFOnMainThread(blob,assetName)","GLB JSON chunk is invalid","dispatchModelLoadError"])assert.ok(renderer.includes(token),token);
});
test('model GPU resources are retained before asynchronous instance cloning and released on failure',()=>{
  const retainAt=renderer.indexOf("resourceLease=window.PStudioResources?.retain?.('model-gpu',d.name)");
  const buildAt=renderer.indexOf("createModelInstanceAsync(key,ownerId,d.name,asset,resourceLease,phase=>{buildPhase=phase;})");
  const cloneAt=renderer.indexOf("async function cloneModelHierarchyAsync");
  assert.ok(retainAt>=0&&buildAt>retainAt,'resource lease is acquired before instance creation');
  assert.ok(cloneAt>0);
  const createStart=renderer.indexOf('async function createModelInstanceAsync');
  const createEnd=renderer.indexOf('function nextPreparationFrame',createStart);
  const createBlock=renderer.slice(createStart,createEnd);
  assert.ok(createBlock.includes('resourceLease=null'));
  assert.ok(!createBlock.includes("retain?.('model-gpu',name)"),'no late retain after asynchronous preparation');
  const buildStart=renderer.indexOf('const build=(async()=>{',retainAt);
  const catchStart=renderer.indexOf('})().catch(error=>{',buildStart);
  assert.ok(catchStart>buildStart);
  assert.ok(renderer.slice(catchStart,catchStart+180).includes('resourceLease?.release?.()'),'failed builds release the lease');
});
test('model build phase is reported and initial render errors do not release a completed instance lease',()=>{
  for(const token of ["onPhase('hierarchy-clone')","onPhase('material-and-shader-setup')","onPhase('streaming-chunk-build')","onPhase('gpu-instancing-build')","onPhase('bounds-and-lod-build')","onPhase('animation-initialization')","stage:'instance-render'","buildPhase='initial-scene-render'"])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes("dispatchModelLoadError({name:d.name,stage:'instance-render'"));
  assert.ok(!renderer.includes("if(lastCommands)render(lastCommands);\n                return created;"));
  for(const token of ["u.uFogDensity&&Object.prototype.hasOwnProperty.call(u.uFogDensity,'value')","u.uCloudBase&&Object.prototype.hasOwnProperty.call(u.uCloudBase,'value')","u.uAtmosphereStrength&&Object.prototype.hasOwnProperty.call(u.uAtmosphereStrength,'value')"])assert.ok(renderer.includes(token),token);
});
test('optional renderer uniform writes tolerate missing or stale wrappers without aborting model setup',()=>{
  for(const token of ["!uniforms?.enabled","!uniforms.near","!uniforms?.uTime","syncPostFXUniforms"])assert.ok(renderer.includes(token),token);
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ["setTime(water,'pstudioWaterHQ')","setTime(foliage,'pstudioFoliageHQ')","const depth=this.uniforms?.tDepth","u?.sceneDepth","Object.prototype.hasOwnProperty.call(uniform,'value')"])assert.ok(fx.includes(token),token);
});
test('failed model instance builds are retained as explicit errors and can be retried',()=>{
  for(const token of ['modelBuildErrors.has(key)','modelBuildErrors.set(key,message)','retryModelAsset','getModelStatus',"stage:'instance-build'"])assert.ok(renderer.includes(token),token);
});

test('ordinary opaque repeated GLTF meshes are automatically instanced without naming conventions',()=>{
  for(const token of [
    'const isGeneric=!isTree&&!isModularPart',
    'supportsGenericStaticInstancing(materials[0],T)',
    'group.isGeneric?\'Generic_Static\'',
    'pstudioGenericStaticInstances',
    'estimatedDrawCallsSaved:totalInstancedSources-batches.length'
  ])assert.ok(renderer.includes(token),token);
});
test('generic static instancing excludes animated ancestry and visual-special-case materials',()=>{
  for(const token of [
    'collectAnimatedNodeTargets(animations)',
    'hasAnimatedAncestor(object,root,animatedTargets)',
    'bakedLightProbeVolume?.length',
    'object.userData?.pstudioWaterSurface',
    'object.customDepthMaterial',
    'material.transmission??0',
    'object.children.length>0'
  ])assert.ok(renderer.includes(token),token);
});
test('GPU instance batches preserve per-group render and shadow state and static transforms use static buffers',()=>{
  for(const token of [
    'batch.castShadow=group.castShadow',
    'batch.receiveShadow=group.receiveShadow',
    'batch.renderOrder=group.renderOrder',
    'batch.layers.mask=group.layersMask',
    'group.isTree?T.DynamicDrawUsage:T.StaticDrawUsage',
    'batch.computeBoundingSphere()'
  ])assert.ok(renderer.includes(token),token);
});
test('automatic LOD generation is deduplicated per shared geometry and disposed with the owning asset',()=>{
  for(const token of [
    'const autoLODGeometryJobs=new WeakMap()',
    'autoLODGeometryJobs.get(geometry)',
    'geometry.userData.pstudioAutoLODLevels=levels',
    'pstudioLODDisposed',
    'for(const geometry of ownedLODs)',
    'object.userData.pstudioAutoLODBaseGeometry'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(!renderer.includes('for(const level of object.userData.pstudioAutoLOD||[])if(level.owned)level.geometry.dispose?.()'));
});
test('BVH scheduling skips small meshes and permanently falls back after a construction failure',()=>{
  for(const token of [
    'elementCount<768',
    'pstudioBVHSkippedSmall',
    'pstudioBVHFailed',
    'geometry.computeBoundsTree({targetLeafSize:12})',
    'this geometry will use standard raycasting'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes('scheduleGeometryBVH(object.geometry)'));
});
test('asset-import and GLB model stages are surfaced in the editor status line',()=>{
  for(const token of [
    'pstudio-asset-import-progress','worker-inspection','IndexedDBへ保存中',
    'pstudio-model-load-progress','gpu-textures','instance-clone-and-materials'
  ])assert.ok(engine.includes(token),token);
});

test('the 3D editor exposes model load progress, stage errors and a mode-aware Refresh action',()=>{
  for(const token of ['pstudio-model-load-progress','pstudio-model-error','refreshSceneView'])assert.ok(engine.includes(token),token);
  assert.ok(html.includes('window.PStudioEngine?.refreshSceneView?.()'));
});
test('updated renderer and game runtime sources remain syntactically valid',()=>{
  assert.doesNotThrow(()=>new Function(renderer));
  assert.doesNotThrow(()=>new Function(engine));
});


test('GPU preparation failures release the hidden-model gate and redraw the editor scene',()=>{
  const start=renderer.indexOf('async function prepareModelInstance(instance)');
  const end=renderer.indexOf('function applyModelMaterial(instance, state)',start);
  assert.ok(start>=0&&end>start);
  const block=renderer.slice(start,end);
  const catchStart=block.indexOf('}catch(error){');
  assert.ok(catchStart>=0);
  const fallback=block.slice(catchStart);
  for(const token of ['instance.preparing=false',"stage:'gpu-preparation-fallback'","window.requestAnimationFrame(()=>",'if(lastCommands)render(lastCommands);else{updateWorldVisibility();drawFrame();}'])assert.ok(fallback.includes(token),token);
});

test('ECS VisualFX configuration is bridged before Physics and preserves renderer ownership', () => {
  const visualFx = fs.readFileSync(path.join(root, 'static/pstudio_ecs_visualfx.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  for (const type of ['Environment', 'Fog', 'Water', 'PostFX', 'ParticleEmitter', 'Trail']) {
    assert.ok(app.includes('"' + type + '"'), type + ' must be reserved');
    assert.ok(visualFx.includes(type), type + ' must be registered by the VisualFX bridge');
  }
  assert.ok(html.indexOf('pstudio_ecs_rendering.js') < html.indexOf('pstudio_ecs_visualfx.js'));
  assert.ok(html.indexOf('pstudio_ecs_visualfx.js') < html.indexOf('pstudio_ecs_inspector.js'));
  assert.ok(engine.indexOf('window.PStudioECSVisualFX?.collectCommands?.(commands, sceneObjects || [], dt)') <
    engine.indexOf('const physicsCommands'));
  assert.ok(engine.includes('window.PStudioECSVisualFX?.clear?.()'));
  assert.ok(engine.includes("'Environment','Fog','Water','PostFX','ParticleEmitter','Trail'"));
  assert.doesNotThrow(() => new Function(visualFx));
});

test('legacy and ECS water rendering honor the configured opacity', () => {
  assert.ok(renderer.includes('const waterOpacity=Math.max(0.05,Math.min(1,Number.isFinite(Number(d.opacity))?Number(d.opacity):1))'));
  assert.ok(renderer.includes('material.opacity=waterOpacity'));
  assert.ok(renderer.includes('material.transparent=waterOpacity<0.999'));
  assert.ok(renderer.includes('material.depthWrite=waterOpacity>=0.999'));
});

test('gameplay UI overlay intent is owned by a transient ECS Component while PStudioUI remains the renderer', () => {
  const ui = fs.readFileSync(path.join(root, 'static/pstudio_ecs_ui.js'), 'utf8');
  const gameplay = fs.readFileSync(path.join(root, 'static/pstudio_gameplay.js'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  for (const token of ['openInventory', 'openQuestLog', 'showDialogue', 'chooseDialogue', 'getUIState', 'uiAction']) {
    assert.ok(gameplay.includes(token), token);
  }
  assert.ok(gameplay.includes('window.PStudioECSUI'));
  assert.ok(ui.includes("const TYPE = 'UIOverlay'"));
  assert.ok(ui.includes('persistent: false'));
  assert.ok(ui.includes('internal: true'));
  assert.ok(app.includes('"UIOverlay"'));
  assert.ok(engine.includes('window.PStudioECSUI?.clear?.()'));
  assert.ok(engine.includes('window.PStudioUI?.render?.(window.PStudioGameplay?.getUIState?.()||null)'));
  assert.ok(html.includes('pstudio_ecs_ui.js'));
  assert.doesNotThrow(() => new Function(ui));
  assert.doesNotThrow(() => new Function(gameplay));
  assert.doesNotThrow(() => new Function(engine));
});

test('module lifecycle state is mirrored into transient ECS entities without moving activation ownership', () => {
  const modules = fs.readFileSync(path.join(root, 'static/pstudio_modules.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'static/pstudio_ecs_modules.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  assert.ok(modules.includes("emit('state-changed'"));
  for (const state of ['activating', 'enabled', 'deactivating', 'registered', 'error']) assert.ok(bridge.includes("'" + state + "'"));
  assert.ok(bridge.includes("const TYPE = 'ModuleState'"));
  assert.ok(bridge.includes('persistent: false'));
  assert.ok(bridge.includes('internal: true'));
  assert.ok(app.includes('"ModuleState"'));
  assert.ok(html.indexOf('pstudio_modules.js') < html.indexOf('pstudio_ecs.js'));
  assert.ok(html.indexOf('pstudio_ecs.js') < html.indexOf('pstudio_ecs_modules.js'));
  assert.doesNotThrow(() => new Function(modules));
  assert.doesNotThrow(() => new Function(bridge));
});

test('ECS Inspector persists versioned Component payloads through the ECS serializer', () => {
  const core = fs.readFileSync(path.join(root, 'static/pstudio_ecs.js'), 'utf8');
  const inspector = fs.readFileSync(path.join(root, 'static/pstudio_ecs_inspector.js'), 'utf8');
  assert.ok(core.includes('const SCENE_COMPONENTS_VERSION = 1'));
  assert.ok(core.includes('function serializeEntityComponents'));
  assert.ok(core.includes('function readSavedComponentEntries'));
  assert.ok(inspector.includes('api.serializeEntityComponents(entityId, [...CORE_COMPONENTS], object)'));
  assert.ok(inspector.includes('if (!serialized)'));
  assert.ok(inspector.includes('newer ECS Component schema'));

  assert.ok(inspector.includes('object.ecsComponentsVersion = serialized.version'));
  assert.ok(inspector.includes('object.ecsComponents = serialized.components'));
  assert.doesNotThrow(() => new Function(core));
  assert.doesNotThrow(() => new Function(inspector));
});

test('gameplay definitions are ECS-owned standalone Components behind legacy ps APIs', () => {
  const bridge = fs.readFileSync(path.join(root, 'static/pstudio_ecs_gameplay.js'), 'utf8');
  const gameplay = fs.readFileSync(path.join(root, 'static/pstudio_gameplay.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  for (const name of ['ItemDefinition', 'QuestDefinition', 'WeaponDefinition']) {
    assert.ok(bridge.includes(name));
    assert.ok(app.includes('"' + name + '"'));
  }
  for (const method of ['setItemDefinition', 'getItemDefinition', 'setQuestDefinition', 'getQuestDefinition', 'setWeaponDefinition', 'getWeaponDefinition']) {
    assert.ok(bridge.includes(method));
  }
  for (const method of ['defineItem', 'questDefine', 'defineWeapon']) assert.ok(gameplay.includes(method));
  assert.ok(gameplay.includes('bridge?.setItemDefinition'));
  assert.ok(gameplay.includes('bridge?.setQuestDefinition'));
  assert.ok(gameplay.includes('bridge?.setWeaponDefinition'));
  assert.doesNotThrow(() => new Function(bridge));
  assert.doesNotThrow(() => new Function(gameplay));
});

test('gameplay state uses versioned Scene Object ECS persistence and leaves Quest/Dialogue in ECS between Plays', () => {
  const gameplay = fs.readFileSync(path.join(root, 'static/pstudio_ecs_gameplay.js'), 'utf8');
  const wrapper = fs.readFileSync(path.join(root, 'static/pstudio_gameplay.js'), 'utf8');
  const input = fs.readFileSync(path.join(root, 'static/pstudio_ecs_input.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'static/pstudio_ecs.js'), 'utf8');
  for (const fragment of [
    "label: 'Health', persistent: true",
    "label: 'Inventory', persistent: true",
    "label: 'Equipment', persistent: true",
    "label: 'Combat State', persistent: true",
    "label: 'AI Controller', persistent: true"
  ]) assert.ok(gameplay.includes(fragment), fragment);
  assert.ok(gameplay.includes("ecs.serializeEntityComponents("));
  assert.ok(!gameplay.includes('clearStandaloneEntities();'));
  assert.ok(wrapper.includes('return bridge.persist(sceneObjects||[],legacy)'));
  assert.ok(input.includes('persistent: true'));
  assert.ok(input.includes("onAdd(entity, value, api)"));
  assert.ok(core.includes('sceneComponentSchemaVersion: SCENE_COMPONENTS_VERSION'));
  assert.ok(core.includes('sceneObject = null'));
  assert.doesNotThrow(() => new Function(gameplay));
  assert.doesNotThrow(() => new Function(wrapper));
  assert.doesNotThrow(() => new Function(input));
});

test('render authoring configuration is ECS-owned and Inspector writes Components rather than legacy Scene Object fields', () => {
  const materials = fs.readFileSync(path.join(root, 'static/pstudio_ecs_materials.js'), 'utf8');
  const rendering = fs.readFileSync(path.join(root, 'static/pstudio_ecs_rendering.js'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  const visual = html.indexOf('pstudio_ecs_visualfx.js');
  const authoring = html.indexOf('pstudio_ecs_materials.js');
  const inspector = html.indexOf('pstudio_ecs_inspector.js');
  assert.ok(visual >= 0 && authoring > visual && inspector > authoring);
  for (const type of ['ToonMaterial', 'MaterialOverrides', 'ShaderMaterial', 'MeshCollider']) {
    assert.ok(materials.includes(type), type);
    assert.ok(app.includes('"' + type + '"'), type + ' must be reserved');
  }
  assert.ok(engine.includes('window.PStudioECSMaterials?.collectCommands?.(commands, sceneObjects || [])'));
  assert.ok(engine.includes("ecs?.hasComponent?.(entity,'MeshCollider')"));
  assert.ok(engine.includes('window.syncEcsSceneMaterials?.()'));
  const uiStart = html.indexOf('function selectSceneObject');
  const uiEnd = html.indexOf('function serializeScene', uiStart);
  const inspectorRegion = html.slice(uiStart, uiEnd);
  for (const legacy of [
    'o.toonMaterialSettings', 'o.modelMaterialOverrides', 'o.postProcessing',
    'o.particleEmitter', 'o.shaderFragment', 'o.modelScale'
  ]) assert.equal(inspectorRegion.includes(legacy), false, legacy);
  assert.ok(inspectorRegion.includes('setSceneToonMaterial'));
  assert.ok(inspectorRegion.includes('setSceneMaterialOverrides'));
  assert.ok(inspectorRegion.includes('setScenePostFX'));
  assert.ok(inspectorRegion.includes('setSceneParticleEmitter'));
  assert.ok(inspectorRegion.includes('setSceneShaderFragment'));
  assert.ok(inspectorRegion.includes('setSceneMeshCollider'));
  assert.doesNotThrow(() => new Function(materials));
  assert.doesNotThrow(() => new Function(rendering));
  assert.doesNotThrow(() => new Function(engine));
});

test('legacy and ECS render-authoring data both trigger 3D initialization before migration', () => {
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
  assert.ok(engine.includes('!!sceneRenderableAsset(object)'));
  assert.ok(engine.includes('!!object.model'), 'legacy model references remain readable during migration');
  assert.ok(engine.includes("['Camera','Light','Renderable','Animation'"));
  assert.ok(engine.includes("'ToonMaterial','MaterialOverrides','ShaderMaterial','MeshCollider'"));
  assert.ok(engine.includes('window.syncEcsSceneMaterials?.()'));
});

test('render authoring Inspector handlers write ECS Components, not legacy fields', () => {
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const start = html.indexOf('function selectSceneObject');
  const end = html.indexOf('function serializeScene', start);
  assert.ok(start >= 0 && end > start);
  const region = html.slice(start, end);
  for (const legacy of ['o.toonMaterialSettings=', 'o.modelMaterialOverrides=', 'o.postProcessing=', 'o.particleEmitter=', 'o.shaderFragment=', 'o.modelScale=']) {
    assert.equal(region.includes(legacy), false, legacy);
  }
  for (const method of ['setSceneToonMaterial','setSceneMaterialOverrides','setScenePostFX','setSceneParticleEmitter','setSceneShaderFragment','setSceneMeshCollider']) {
    assert.ok(region.includes(method), method);
  }
});

test('runtime and Editor preview use ECS Scene Components for scripts, sprite bounds, color and colliders', () => {
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_engine.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const scene = fs.readFileSync(path.join(root, 'static/pstudio_ecs_scene.js'), 'utf8');
  const materials = fs.readFileSync(path.join(root, 'static/pstudio_ecs_materials.js'), 'utf8');
  assert.ok(engine.includes('astForScript(sceneScriptFile(object))'));
  assert.ok(engine.includes('astForScript(sceneScriptFile(o))'));
  assert.ok(engine.includes('sceneSpriteConfig(object)'));
  assert.ok(engine.includes('sceneObjectBounds2D(a)'));
  assert.ok(engine.includes('sceneCollider2DEnabled(o)'));
  assert.ok(engine.includes('sceneRenderableAsset(object)'));
  assert.ok(engine.includes('window.PStudioECSMaterials?.collectCommands?.(commands, sceneObjects || [])'));
  assert.ok(html.includes('getSceneSpriteRenderer(object)'));
  assert.ok(html.includes('getSceneScriptFile(object)'));
  assert.ok(html.includes('setSceneScriptFile(object,fileName)'));
  assert.ok(html.includes('setSceneRenderableAsset(object,asset)'));
  assert.ok(html.includes('window.PStudioECSScene?.renameScriptFile'));
  assert.ok(html.includes('window.PStudioECSScene?.renameSpriteAsset'));
  assert.ok(materials.includes('function renameRenderableAsset'));
  assert.doesNotThrow(() => new Function(scene));
  assert.doesNotThrow(() => new Function(engine));
});

test('ps script runtime variables, lifecycle and System locals are ECS-owned',()=>{
  assert.ok(engine.includes('window.PStudioECSScript?.getVariables?.(object.id)'));
  assert.ok(engine.includes('window.PStudioECSScript?.getLifecycle?.(o.id)'));
  assert.ok(engine.includes('getSystemStateByEntity'));
  assert.ok(engine.includes('setSystemStateByEntity'));
  for(const field of ['states','initialized','started','landSequences','ecsStates']){
    assert.equal(engine.includes('runtime.'+field),false,'legacy runtime state remains: '+field);
  }
  assert.ok(html.indexOf('/static/pstudio_ecs.js') < html.indexOf('/static/pstudio_ecs_script.js'));
  assert.ok(html.includes('/static/pstudio_ecs_script.js'));
});


test('volumetric clouds use layered density shaping, light transmittance and adaptive sample budgets',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of [
    'uCloudCoverage','uCloudDetail','uCloudSteps','uCloudLightSteps',
    'pCloudDensity','pHenyeyGreenstein','lightOptical','lightTransmittance',
    'pass.setQuality','pass.configureAtmosphere','uCloudWind'
  ])assert.ok(fx.includes(token),token);
  assert.ok(renderer.includes('volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel)'));
  assert.ok(renderer.includes("volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel)"));
  assert.ok(fx.includes('source.rgb*transmittance+scattering*uAtmosphereStrength'));
  assert.doesNotThrow(()=>new Function(fx));
});

test('volumetric cloud pass constructs and updates atmosphere/quality uniforms at runtime',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  assert.ok(api);
  class Vector3{
    constructor(x=0,y=0,z=0){this.set(x,y,z);}
    set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
    normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this;}
  }
  class Vector2{
    constructor(x=0,y=0){this.set(x,y);}
    set(x,y){this.x=x;this.y=y;return this;}
  }
  class Matrix4{}
  class Color{
    constructor(value){this.value=value;}
    set(value){this.value=value;return this;}
  }
  class ShaderPass{
    constructor(shader){this.uniforms=shader.uniforms;this.shader=shader;this.render=()=>{};this.userData={};}
  }
  const pass=api.createVolumetricCloudPass({ShaderPass},{DepthTexture:class{},Matrix4,Vector2,Vector3,Color});
  assert.ok(pass);
  const quality=pass.setQuality('ultra',2);
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:64,baseSteps:64,frameBudgetScale:1,lightSteps:3});
  assert.equal(pass.uniforms.uCloudSteps.value,64);
  assert.equal(pass.uniforms.uCloudLightSteps.value,3);
  assert.equal(pass.setQuality('ultra',1).steps,54);
  assert.equal(pass.setQuality('ultra',0).steps,45);
  assert.equal(pass.setQuality('maximum',2).steps,52);
  assert.equal(pass.setQuality('high',2).steps,34);
  assert.equal(pass.configureAtmosphere({sunDirection:[0,1,0],sunColor:'#ffd0a0',fogColor:'#9fc9e8',cloudDensity:.7}),true);
  assert.equal(pass.uniforms.uSunDirection.value.y,1);
  assert.equal(pass.uniforms.uSunColor.value.value,'#ffd0a0');
  assert.equal(pass.uniforms.uFogColor.value.value,'#9fc9e8');
  assert.equal(pass.uniforms.uCloudDensity.value,.7);
  assert.ok(pass.shader.fragmentShader.includes('lightTransmittance'));
});
test('volumetric quality scales from its preset baseline without compounding across frames',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  class Vector3{constructor(x=0,y=0,z=0){this.set(x,y,z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this;}}
  class Vector2{constructor(x=0,y=0){this.set(x,y);}set(x,y){this.x=x;this.y=y;return this;}}
  class Matrix4{}
  class Color{constructor(value){this.value=value;}set(value){this.value=value;return this;}}
  class ShaderPass{constructor(shader){this.uniforms=shader.uniforms;this.shader=shader;this.render=()=>{};this.userData={};}}
  const three={DepthTexture:class{},Matrix4,Vector2,Vector3,Color};
  const cloud=api.createVolumetricCloudPass({ShaderPass},three);
  const fog=api.createVolumetricFogPass({ShaderPass},three);
  const shadow=api.createContactShadowPass({ShaderPass},{DepthTexture:class{},Matrix4,Vector3});
  for(const pass of [cloud,fog,shadow]){
    const uniform=pass===cloud?'uCloudSteps':pass===fog?'uFogSteps':'uSteps';
    const baseline=pass.setQuality('ultra',2).steps;
    assert.equal(pass.setFrameBudgetScale(0.5),true);
    assert.equal(pass.uniforms[uniform].value,Math.max(pass===cloud?8:pass===fog?6:4,Math.round(baseline*0.5)));
    assert.equal(pass.setFrameBudgetScale(1),true);
    assert.equal(pass.uniforms[uniform].value,baseline);
  }
});

test('water v3 adds Beer-Lambert depth absorption and grazing-angle reflection response',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of [
    'pstudio-water-hq-v3-','uPStudioWaterReflectionTint','uPStudioWaterAbsorption',
    '1.0-exp(-waterThickness*uPStudioWaterAbsorption)','float fresnel=pow(1.0-viewFacing,5.0)',
    'shorelineFoam','waterThickness'
  ])assert.ok(fx.includes(token),token);
  assert.ok(renderer.includes('transmission:0.82'));
  assert.ok(renderer.includes('SSRPass'));
  assert.doesNotThrow(()=>new Function(fx));
});

test('volumetric fog synchronizes preset lighting and adapts its ray-march budget',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  class Vector3{constructor(x=0,y=0,z=0){this.set(x,y,z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this;}}
  class Vector2{constructor(x=0,y=0){this.set(x,y);}set(x,y){this.x=x;this.y=y;return this;}}
  class Matrix4{}
  class Color{constructor(value){this.value=value;}set(value){this.value=value;return this;}}
  class ShaderPass{constructor(shader){this.uniforms=shader.uniforms;this.shader=shader;this.render=()=>{};this.userData={};}}
  const three={DepthTexture:class{},Matrix4,Vector2,Vector3,Color};
  const cloud=api.createVolumetricCloudPass({ShaderPass},three);
  const fog=api.createVolumetricFogPass({ShaderPass},three);
  assert.ok(fog);
  const quality=fog.setQuality('ultra',2);
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:32,baseSteps:32,frameBudgetScale:1});
  assert.equal(fog.uniforms.uFogSteps.value,32);
  assert.equal(fog.setQuality('ultra',1).steps,28);
  assert.equal(fog.setQuality('ultra',0).steps,24);
  assert.equal(fog.setQuality('maximum',2).steps,26);
  assert.equal(fog.setQuality('high',2).steps,16);
  api.configureAtmosphere({sunDirection:[-0.4,-0.4,-0.4],lightDirection:[0.2,0.8,0.4],sunColor:'#ffb06f',fogColor:'#bb897e',fogAmbientColor:'#c5a0b8',fogDensity:.0032,fogHeightFalloff:.012,fogBaseHeight:3,fogAnisotropy:.58});
  assert.ok(Math.abs(fog.uniforms.uSunDirection.value.y-0.8728715609)<1e-8,'fog must follow the key light/moon direction when supplied');
  assert.ok(Math.abs(cloud.uniforms.uSunDirection.value.y-0.8728715609)<1e-8,'cloud scattering must follow the same atmospheric light direction');
  assert.equal(fog.uniforms.uSunColor.value.value,'#ffb06f');
  assert.equal(fog.uniforms.uFogColor.value.value,'#bb897e');
  assert.equal(fog.uniforms.uFogAmbientColor.value.value,'#c5a0b8');
  assert.equal(fog.uniforms.uFogDensity.value,.0032);
  assert.equal(fog.uniforms.uHeightFalloff.value,.012);
  assert.equal(fog.uniforms.uBaseHeight.value,3);
  assert.equal(fog.uniforms.uFogAnisotropy.value,.58);
  assert.ok(fog.shader.fragmentShader.includes('henyeyGreenstein'));
  assert.ok(fog.shader.fragmentShader.includes('groundHaze'));
});


test('procedural terrain meshes receive a layered height/slope PBR shader',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['configureTerrain','pstudio-terrain-layered-pbr-v1','pStudioTerrainFbm','pStudioSlope','pStudioRock','pStudioSnow','uPStudioTerrainWetness','terrainMaterials'])assert.ok(fx.includes(token),token);
  assert.ok(renderer.includes("if(d.type==='terrain')window.PStudioEnvironmentFX?.configureTerrain?.(material,mesh)"));
});

test('terrain PBR runtime injection sets bounded uniforms and composes with existing material hooks',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{THREE:{DoubleSide:2}},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  const material={isMeshStandardMaterial:true,userData:{},roughness:.92,onBeforeCompile:null,customProgramCacheKey(){return 'base';}};
  const object={position:{y:2},geometry:{boundingBox:null,computeBoundingBox(){this.boundingBox={min:{y:-1},max:{y:9}};}}};
  api.configureTerrain(material,object,{wetness:.3,snowLine:.72,detailScale:.24,rockThreshold:.4});
  assert.equal(material.userData.pstudioTerrainHQ.heightMin.value,1);
  assert.equal(material.userData.pstudioTerrainHQ.heightRange.value,10);
  assert.equal(material.userData.pstudioTerrainHQ.wetness.value,.3);
  assert.equal(material.userData.pstudioTerrainHQ.snowLine.value,.72);
  const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>\n#include <defaultnormal_vertex>',fragmentShader:'#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>'};
  material.onBeforeCompile(shader,{});
  for(const token of ['vPStudioTerrainWorldPosition','vPStudioTerrainWorldNormal','pStudioTerrainFbm','pStudioTerrainNoise','pStudioSnow','uPStudioTerrainWetness'])assert.ok(shader.fragmentShader.includes(token),token);
  assert.ok(shader.vertexShader.includes('transformedNormal'));
  assert.equal(material.customProgramCacheKey().includes('pstudio-terrain-layered-pbr-v1-'),true);
  assert.equal(api.getStats().terrainMaterials,1);
});

test('baked SH probe grids use trilinear interpolation with a sparse-probe fallback',()=>{
  for(const token of ['pstudioGrid',"layout:'x-fastest'",'const volumeIndex=','(dx?x.t:1-x.t)*(dy?y.t:1-y.t)*(dz?z.t:1-z.t)','const center=cache.position,grid=volume.pstudioGrid','Sparse or legacy probe collections','const near=volume.map'])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes('dims:Object.freeze(dims.slice())'));
  assert.ok(renderer.includes('updateObjectProbeUniforms'));
});

test('high and ultra quality presets activate GTAO automatically and adaptive quality keeps it synchronized',()=>{
  assert.ok(renderer.includes('qualityAOEnabled=premiumEffectsEnabled&&profile.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;'));
  assert.ok(renderer.includes('qualityAOEnabled=effects&&base.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;'));
  assert.match(renderer,/setPostProcessing:\(bloom,ssao,strength,ssr\)=>\{(?:resetPostProcessingFailure\(\);)?bloomEnabled=!!bloom;ssaoEnabled=!!ssao&&!memorySafetyApplied;/);
  assert.ok(renderer.includes('if(ssaoPass)ssaoPass.enabled=ssaoEnabled'));
});

test('shadow map dimensions are capped by GPU texture limits and reported device-memory class',()=>{
  for(const token of ['function resolveShadowMapSize(requested)','getParameter?.(gl.MAX_TEXTURE_SIZE)',"const memoryCap=qualityPreset==='ultra'","memory<=2?1024:memory<=4?2048:4096","memory<=4?2048:memory<=6?3072:4096","const mapSize=resolveShadowMapSize(shadowSizes[adaptiveQualityLevel])"])assert.ok(renderer.includes(token),token);
});


test('foliage materials add directional backlight transmission without changing wind deformation',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of ['foliageTranslucencyMaterials','uPStudioFoliageTranslucency','pStudioOppositeSides','pStudioForwardLobe','directionalLights[pStudioLightIndex].color','vPStudioFoliageViewNormal','pstudio-foliage-wind-hq-v4-'])assert.ok(fx.includes(token),token);
  assert.ok(fx.includes("shader.fragmentShader=addAfter(shader.fragmentShader,'#include <opaque_fragment>'"));
  assert.ok(fx.includes("shader.vertexShader=addAfter(shader.vertexShader,'#include <defaultnormal_vertex>'"));
});

test('foliage translucency runtime injection clamps artist controls and preserves the prior material hook',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  class Vector2{constructor(x=0,y=0){this.set(x,y);}set(x,y){this.x=x;this.y=y;return this;}normalize(){const n=Math.hypot(this.x,this.y)||1;this.x/=n;this.y/=n;return this;}}
  class Color{constructor(value){this.value=value;}set(value){this.value=value;return this;}}
  const sandbox={window:{THREE:{Vector2,Color,DoubleSide:2}},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  let oldCompileCalled=false;
  const material={isMeshStandardMaterial:true,userData:{},roughness:.8,onBeforeCompile(){oldCompileCalled=true;},customProgramCacheKey(){return 'source-key';},alphaMap:{},alphaTest:0};
  const object={name:'Oak_Leaf_Cluster',userData:{pstudioWindPart:'leaf',pstudioFoliageTranslucency:1.7,pstudioFoliageThickness:2,pstudioFoliageScatteringPower:20},geometry:{boundingBox:{min:{y:0},max:{y:4}},computeBoundingBox(){}}};
  api.configureFoliage(material,object);
  const record=material.userData.pstudioFoliageHQ;
  assert.equal(record.translucency,1);
  assert.equal(record.thickness,1.5);
  assert.equal(record.scatteringPower,12);
  assert.equal(material.side,2);
  assert.ok(material.alphaTest>=.28);
  const shader={uniforms:{},vertexShader:'#include <common>\n#include <defaultnormal_vertex>\n#include <begin_vertex>',fragmentShader:'#include <common>\n#include <opaque_fragment>'};
  material.onBeforeCompile(shader,{});
  assert.equal(oldCompileCalled,true);
  for(const token of ['uPStudioFoliageTranslucency','uPStudioFoliageThickness','uPStudioFoliageScatteringPower','uPStudioFoliageTranslucencyColor'])assert.ok(shader.uniforms[token],token);
  for(const token of ['vPStudioFoliageViewNormal','transformedNormal','NUM_DIR_LIGHTS','pStudioOppositeSides','pStudioForwardLobe','gl_FragColor.rgb+=pStudioFoliageScatter'])assert.ok(shader.fragmentShader.includes(token)||shader.vertexShader.includes(token),token);
  assert.ok(material.customProgramCacheKey().includes('pstudio-foliage-wind-hq-v4-'));
  assert.equal(api.getStats().foliageTranslucencyMaterials,1);
  api.update(4.25);
  assert.equal(material.userData.pstudioFoliageHQ.time.value,4.25);
});

test('contact shadow pass ray-marches scene depth with bounded quality levels and atmosphere-aligned light',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  class Vector3{constructor(x=0,y=0,z=0){this.set(x,y,z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this;}}
  class Matrix4{}
  class DepthTexture{}
  class ShaderPass{constructor(shader){this.uniforms=shader.uniforms;this.shader=shader;this.render=()=>{};this.userData={};}}
  const pass=api.createContactShadowPass({ShaderPass},{DepthTexture,Matrix4,Vector3});
  assert.ok(pass);
  const quality=pass.setQuality('ultra',2);
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:30,baseSteps:30,frameBudgetScale:1});
  assert.equal(pass.uniforms.uSteps.value,30);
  assert.equal(pass.setQuality('ultra',1).steps,26);
  assert.equal(pass.setQuality('ultra',0).steps,23);
  assert.equal(pass.setQuality('maximum',2).steps,18);
  assert.equal(pass.setQuality('high',2).steps,12);
  assert.ok(pass.shader.fragmentShader.includes('clamp(uSteps,4.0,32.0)'));
  api.configureAtmosphere({lightDirection:[0.2,0.8,0.4]});
  const d=pass.uniforms.uLightDirectionWorld.value;
  assert.ok(Math.abs(d.y-0.8728715609)<1e-8);
  assert.equal(api.getStats().contactShadowPasses,1);
});

test('contact shadow depth binding keeps an explicit prepass texture and falls back to composer depth',()=>{
  const vm=require('node:vm');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const sandbox={window:{},console,Math,Number,Set,Map,Object,Array,String};
  vm.runInNewContext(fx,sandbox,{timeout:1000});
  const api=sandbox.window.PStudioEnvironmentFX;
  class Vector3{constructor(x=0,y=0,z=0){this.set(x,y,z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}normalize(){return this;}}
  class Matrix4{}
  class DepthTexture{}
  class ShaderPass{constructor(shader){this.uniforms=shader.uniforms;this.shader=shader;this.render=()=>{};this.userData={};}}
  const pass=api.createContactShadowPass({ShaderPass},{DepthTexture,Matrix4,Vector3});
  const explicit={name:'prepass-depth'},fallback={name:'composer-depth'};
  pass.uniforms.tDepth.value=explicit;
  pass.render({}, {}, {depthTexture:fallback}, 0, false);
  assert.equal(pass.uniforms.tDepth.value,explicit);
  pass.uniforms.tDepth.value=null;
  pass.render({}, {}, {depthTexture:fallback}, 0, false);
  assert.equal(pass.uniforms.tDepth.value,fallback);
});

test('contact shadows are profile/adaptive controlled, use the depth prepass, and expose a bounded public API',()=>{
  for(const token of [
    "contactShadows:false","contactShadows:true","createContactShadowPass?.(FX,T)",
    'composer.addPass(contactShadowPass)','contactShadowPass.setQuality?.(selected,adaptiveQualityLevel)',
    'contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied',
    '||contactShadowsEnabled','||contactShadowsEnabled;',
    'Number(stats?.waterMaterials)>0||volumetricFogEnabled||volumetricCloudsEnabled||contactShadowsEnabled',
    'setContactShadows:(enabled,options={})','u.uMaxDistance.value=Math.max(.1,Math.min(2.5,options.maxDistance))',
    'contactShadows:{enabled:contactShadowsEnabled,available:!!contactShadowPass'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.indexOf('composer.addPass(contactShadowPass)')>renderer.indexOf('composer.addPass(volumetricFogPass)'));
  assert.ok(renderer.indexOf('composer.addPass(contactShadowPass)')<renderer.indexOf('composer.addPass(bloomPass)'));
  assert.ok(renderer.includes('contactShadowPass.enabled=contactShadowsEnabled&&!waterDepthPrepassFailed&&!!waterDepthTarget?.depthTexture'));
});



test('manual quality presets are never silently downgraded; auto selects a tier from hardware capabilities',()=>{
  assert.match(renderer,/if\(name!=='auto'\)return QUALITY_PROFILES\[name\]\?name:'balanced'/);
  assert.match(renderer,/if\(memoryGiB<=2\|\|cpuCores<=2\|\|maxTextureSize<2048\)return 'mobile'/);
  assert.match(renderer,/if\(memoryGiB<=3\|\|cpuCores<4\|\|maxTextureSize<4096\|\|\(touch&&memoryGiB<=4\)\)return 'balanced'/);
  assert.match(renderer,/if\(memoryGiB>=8&&cpuCores>=8&&maxTextureSize>=8192\)return 'maximum'/);
  assert.match(renderer,/const baseProfile=QUALITY_PROFILES\[selected\],profile=baseProfile/);
  assert.ok(renderer.includes("const memoryCap=qualityPreset==='ultra'"));
});

test('Maximum remains distinct from Ultra, which requests true 2x output and device-aware sampling',()=>{
  assert.ok(renderer.includes("adaptiveMaximumTouchMode=qualityPreset==='maximum'&&isTouchDevice"));
  assert.ok(renderer.includes("adaptiveQualityEnabled=qualityPreset==='auto'||qualityPreset==='ultra'||adaptiveMaximumTouchMode"));
  assert.ok(renderer.includes("maximum:{pixelRatio:2.1,shadowSize:4096"));
  assert.ok(renderer.includes("ultra:{pixelRatio:4.2,shadowSize:8192,shadowMode:'vsm'"));
  assert.ok(renderer.includes("const requested=Math.min(dpr,QUALITY_PROFILES.maximum.pixelRatio)*2"));
  assert.ok(renderer.includes("textureCap=hardware.maxTextureSize/Math.max(width,height)"));
  assert.ok(renderer.includes("pixelCap=Math.sqrt(pixelBudget/(width*height))"));
  assert.ok(renderer.includes("outputMultiplier:qualityPreset==='ultra'?2:1"));
  assert.ok(renderer.includes("resolutionLimited:qualityPreset==='ultra'"));
  assert.ok(renderer.includes("const aoSamples=selected==='ultra'?[16,28,40][adaptiveQualityLevel]"));
  assert.ok(renderer.includes("const shadowSizes=adaptiveUltraTouchMode?[1024,1536,2048]:adaptiveMaximumTouchMode?[768,1024,1536]:qualityPreset==='ultra'?[3072,4096,8192]"));
  assert.ok(renderer.includes("const base=resolveQualityRenderPixelRatio(selected,level,adaptive)"));
  assert.ok(renderer.includes("const safeScale=applyEffectiveRenderScale()"));
});

test('quality preset selection persists, reports active hardware tier and emits UI updates',()=>{
  assert.match(renderer,/readSavedQualityPreset\(\)/);
  assert.match(renderer,/localStorage\?\.getItem\('pstudio-render-quality'\)/);
  assert.match(renderer,/localStorage\?\.setItem\('pstudio-render-quality',qualityPreset\)/);
  assert.ok(renderer.includes("getQualityPreset:()=>{"));
  assert.ok(renderer.includes("outputMultiplier:qualityPreset==='ultra'?2:1"));
  assert.match(renderer,/renderPixelRatio/);
  assert.match(renderer,/pstudio-quality-state-changed/);
  assert.match(engine,/window\.setPStudioQualityPreset=function\(name\)/);
  assert.match(engine,/updatePStudioQualityControl\(\)/);
});

test('scene toolbar exposes all six render quality tiers and keeps the control usable on mobile',()=>{
  for(const value of ['auto','mobile','balanced','high','maximum','ultra'])assert.match(html,new RegExp('option value="'+value+'"'));
  assert.ok(html.includes('id="render-quality-select"'));
  assert.ok(html.includes('id="render-quality-active"'));
  assert.ok(html.includes('setPStudioQualityPreset(this.value)'));
  assert.ok(html.includes('.game-toolbar{overflow-x:auto'));
  assert.ok(html.includes('@media(max-width:700px){.render-quality-label{display:none}'));
});


test('sun and moon camera focus smoothly activate subtle celestial bloom rather than a constant white wash',()=>{
  for(const token of [
    'sunGlareStrength+=(targetGlare-sunGlareStrength)*0.075',
    'moonGlareStrength+=(targetGlow-moonGlareStrength)*0.075',
    'uSolarGlare',
    'uMoonGlare',
    "solarBloomActive=(qualityPreset==='high'||qualityPreset==='maximum'||qualityPreset==='ultra')&&sunGlareStrength>0.01",
    "lunarBloomActive=(qualityPreset==='high'||qualityPreset==='maximum'||qualityPreset==='ultra')&&moonGlareStrength>0.01",
    'bloomPass.threshold=Math.max(.62,.84-celestialGlare*.18)'
  ])assert.ok(renderer.includes(token),token);
});
 
test('3D viewport retains the centered preview size rather than stretching to the entire stage',()=>{
  assert.doesNotMatch(engine,/is-3d-viewport/);
  assert.ok(html.includes('.game-canvas{touch-action:none;user-select:none;-webkit-user-select:none;display:block;max-width:100%;max-height:100%;width:min(100%,800px);aspect-ratio:16/9'));
  assert.doesNotMatch(html,/\.game-stage\.is-3d-viewport/);
});

test('all visible select controls use the shared dark in-app picker instead of native platform popups',()=>{
  for(const id of ['render-quality-select','obj-sprite','obj-script','shader-node-mode','font-size','tab-size','input-mode'])assert.ok(html.includes('id="'+id+'"'),id);
  assert.ok(html.includes('/static/pstudio_selects.css?v=20261124-custom-selects1'));
  assert.ok(html.includes('/static/pstudio_selects.js?v=20261124-custom-selects1'));
  assert.match(selectUI,/select:not\(\.visually-hidden\):not\(\.pstudio-native-select\)/);
  assert.match(selectUI,/menu\.setAttribute\('role','listbox'\)/);
  assert.match(selectUI,/new Event\('change',\{bubbles:true\}\)/);
  assert.match(selectUI,/new MutationObserver/);
  assert.ok(selectUI.includes('if(select.isConnected)continue;'));
  assert.match(selectUI,/window\.PStudioSelects=\{initialized:true/);
  assert.ok(selectUI.includes("select.classList.add('pstudio-native-select')"));
  assert.ok(selectCSS.includes('background:#1b222c'));
  assert.ok(selectCSS.includes('.pstudio-select-option[aria-selected="true"]'));
  assert.doesNotThrow(()=>new Function(selectUI));
});
 
test('tablet and mobile workspace use a single main column with accessible project and inspector drawers',()=>{
  for(const token of [
    'id="project-explorer"','id="workspace-inspector"',
    'data-workspace-panel="explorer"','data-workspace-panel="inspector"',
    "toggleWorkspacePanel('explorer')","toggleWorkspacePanel('inspector')",
    '.ide-shell[data-active-panel="explorer"] .explorer',
    '.ide-shell[data-active-panel="inspector"] .inspector',
    '.workspace-panel-backdrop','@media(max-width:1050px)',
    'grid-template-columns:minmax(0,1fr)','clamp(125px,23dvh,175px)'
  ])assert.ok(html.includes(token),token);
});
 
test('WebGPU PBR and TSL pilot uses the shared production scene-session modules',()=>{
  for(const token of [
    'id="webgpu-lab-open"',
    'id="webgpu-lab-overlay"',
    'id="webgpu-lab-canvas"',
    'pstudio_webgpu_lab.mjs?v=20261126-cluster-sh-vfx-v2',
    '既存プロジェクト',
    '既存プロジェクトのシーンや本番WebGL 2レンダラーは変更しません',
    'pstudio_rendering_migration.mjs?v=20261126-npr-toon-aa-v2'
  ])assert.ok(html.includes(token),token);
  for(const token of [
    "import * as THREE from 'three/webgpu'",
    "import * as TSL from 'three/tsl'",
    "from './pstudio_rendering_migration.mjs?v=20261126-npr-toon-aa-v2'",
    'createPStudioWebGPUSceneSession({',
    'sessionHandle.render()',
    'sessionHandle.dispose()',
    'new THREE.MeshStandardMaterial',
    'new THREE.MeshPhysicalMaterial',
    'new THREE.MeshStandardNodeMaterial',
    'TSL.mix(',
    'new THREE.CanvasTexture',
    'keyLight.castShadow = true',
    'configureRenderer:'
  ])assert.ok(webgpuLab.includes(token),token);
  for(const token of [
    "await renderer.init()",
    "renderer?.backend?.isWebGPUBackend",
    "renderer.setAnimationLoop(null)",
    "renderer.dispose()"
  ])assert.ok(webgpuBackend.includes(token),token);
  for(const token of [
    'THREE.MeshStandardNodeMaterial',
    'THREE.MeshPhysicalNodeMaterial',
    'target.copy(source)',
    'skippedLegacyShaderHooks',
    'convertPStudioScenePBRMaterials'
  ])assert.ok(webgpuMaterials.includes(token),token);
  for(const token of [
    'new THREE.RenderPipeline(renderer)',
    'pass(scene, camera)',
    'bloom(output',
    'renderPipeline.render()',
    'renderPipeline.dispose()'
  ])assert.ok(webgpuPipeline.includes(token),token);
  for(const token of [
    'inspectPStudioWebGPUSceneMaterials',
    'createPStudioWebGPUSceneSession',
    'await renderer.compileAsync(scene, camera)',
    'createPStudioRenderPipeline(',
    'createPStudioTSLEnvironment(scene',
    'environmentHandle.updateCamera(camera)',
    'environmentHandle?.setProfile?.(profile)',
    'pstudio_rendering_environment_tsl.mjs?v=20261125-unified-sky-cloud-ibl-v1',

    'device.lost',
    'PSTUDIO_WEBGPU_SCENE_INCOMPATIBLE'
  ])assert.ok(webgpuMigration.includes(token),token);
  for(const token of [
    'generatePStudioEnvironmentPixels',
    'MeshBasicNodeMaterial',
    'EquirectangularReflectionMapping',
    'scene.environment=environmentTexture',
    'TSL.equirectUV(direction)',
    'TSL.texture(environmentTexture,skyUV)',
    'periodicValueNoise(u,v',
    'cloudEnabled',
    'cloudCoverage',
    'radianceSource',
    String.raw`radianceSource:'shared-sky-and-pbr-ibl'`,
    'updateCamera(camera)'
  ])assert.ok(webgpuEnvironmentTSL.includes(token),token);
  assert.doesNotMatch(webgpuLab,/window\.PStudio3D/);
  assert.doesNotMatch(webgpuLab,/new THREE\.WebGLRenderer/);
  assert.doesNotMatch(webgpuLab,/rendererCandidate\.render\(scene, camera\)/);
});

test('TSL PBR conversion preserves legacy GLSL-hook materials instead of silently dropping custom shading',()=>{
  assert.ok(webgpuMaterials.includes("function hasCustomShaderHook(material)"));
  assert.ok(webgpuMaterials.includes("Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile')"));
  assert.ok(webgpuMaterials.includes("Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')"));
  assert.ok(webgpuMaterials.includes("userData.pstudioCSMOnlyHook === true"));
  assert.ok(webgpuMaterials.includes('skippedLegacyShaderHooks += 1'));
  assert.ok(webgpuMaterials.includes('skippedLegacyShaderHooks,'));
});

test('quality-selector and rendering script updates use fresh cache-busting versions',()=>{
  assert.ok(html.includes('/static/pstudio_3d_engine.js?v=20261126-genesis-1-2-v1'));
  assert.ok(html.includes('/static/pstudio_engine.js?v=20261125-daylight-mirror-hq-r2'));
  assert.ok(html.includes('/static/pstudio_environment_fx.js?v=20261126-npr-toon-v1'));
  assert.ok(html.includes('/static/pstudio_scene_environment.js?v=20261124-daylight-hq-r1'));
});

test('editor orbit camera reaches near-vertical top-down and bottom-up views without crossing pole singularities',()=>{
  const vm=require('node:vm');
  const start=renderer.indexOf('function clampEditorOrbitPitch');
  const end=renderer.indexOf('function setupControls',start);
  assert.ok(start>=0&&end>start,'camera pitch clamp is present');
  const sandbox={
    window:{PStudioEngine:{isRunning:()=>false}},
    cameraBase:[6,5,8],
    cameraTarget:[0,0,0],
    Math,Number
  };
  vm.runInNewContext(renderer.slice(start,end)+String.fromCharCode(10)+'this.clampEditorOrbitPitch=clampEditorOrbitPitch;',sandbox,{timeout:1000});
  const clamp=sandbox.clampEditorOrbitPitch;
  const baseElevation=Math.atan2(5,Math.hypot(6,8));
  const maxElevation=Math.PI/2-0.002;
  const minPitch=baseElevation-maxElevation;
  const maxPitch=baseElevation+maxElevation;
  assert.ok(Math.abs(clamp(-100)-minPitch)<1e-10,'top-down limit');
  assert.ok(Math.abs(clamp(100)-maxPitch)<1e-10,'bottom-up limit');
  assert.ok(Math.abs((baseElevation-clamp(-100))-maxElevation)<1e-10);
  assert.ok(Math.abs((baseElevation-clamp(100))+maxElevation)<1e-10);
  sandbox.window.PStudioEngine.isRunning=()=>true;
  assert.equal(clamp(-100),-1.35,'game camera lower limit remains unchanged');
  assert.equal(clamp(100),1.35,'game camera upper limit remains unchanged');
  const updateStart=renderer.indexOf('function updateCamera(');
  const updateEnd=renderer.indexOf('function refreshSelectionOutline',updateStart);
  assert.ok(updateStart>=0&&updateEnd>updateStart,'camera update block is present');
  const updateBlock=renderer.slice(updateStart,updateEnd);
  for(const token of [
    'if(window.PStudioEngine?.isRunning?.())',
    'const baseElevation=Math.atan2(offset.y',
    'const azimuth=Math.atan2(offset.x,offset.z)',
    'const elevation=baseElevation-orbitPitch',
    'offset.set(Math.sin(azimuth)*horizontal,Math.sin(elevation)*radius',
    'offset.applyAxisAngle(right,orbitPitch)'
  ])assert.ok(updateBlock.includes(token),token);
});


test('Ultra preserves 2x output while avoiding oversized shadow maps and excessive AO sampling',()=>{
  assert.ok(renderer.includes("outputMultiplier:qualityPreset==='ultra'?2:1"));
  assert.ok(renderer.includes("const requestedShadow=adaptiveUltraTouchMode?[1024,1536,2048][adaptiveQualityLevel]:adaptiveMaximumTouchMode?[768,1024,1536][adaptiveQualityLevel]:qualityPreset==='ultra'?[3072,4096,8192][adaptiveQualityLevel]"));
  assert.ok(renderer.includes("qualityPreset==='ultra'?[3072,4096,8192]"));
  assert.ok(renderer.includes("const aoSamples=selected==='ultra'?[16,28,40][level]"));
});


test('High, Maximum and Ultra have progressively stronger independent ray-march and AO budgets',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.match(fx,/high:34,maximum:52,ultra:64/);
  assert.match(fx,/high:16,maximum:26,ultra:32/);
  assert.match(renderer,/high:\{pixelRatio:2,shadowSize:3072/);
  assert.match(renderer,/maximum:\{pixelRatio:2\.1,shadowSize:4096/);
  assert.match(renderer,/ultra:\{pixelRatio:4\.2,shadowSize:8192,shadowMode:'vsm'/);
  assert.match(renderer,/selected==='ultra'\?\[16,28,40\]\[level\]:selected==='maximum'\?\[12,20,32\]\[level\]/);
  assert.match(renderer,/adaptiveUltraTouchMode=qualityPreset==='ultra'/);
});


test('performance telemetry separates frame pacing, CPU submission, GPU timer samples and estimated memory',()=>{
  for(const token of [
    'function performanceStatsSnapshot()',
    'function pushMetricSample(list,value)',
    'function updatePerformanceMonitor(',
    'function togglePerformanceMonitor()',
    'function updateDynamicResolutionFromMetrics(',
    'dynamicResolutionScale',
    'EXT_disjoint_timer_query_webgl2',
    'gpuFrameBudgetPercent',
    'frameP50Ms',
    'frameP95Ms',
    'frameP99Ms',
    'cpuRenderSubmitP50Ms',
    'cpuRenderSubmitP99Ms',
    'gpuRenderP50Ms',
    'gpuRenderP99Ms',
    'frameIntervalSampleCount',
    'gpuTimingFresh',
    'not total GPU utilization',
    'pstudio-render-stats',
    'getPerformanceStats:performanceStatsSnapshot',
    'togglePerformanceMonitor'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(html.includes('id="render-stats-toggle"'));
  assert.ok(html.includes('id="render-stats-overlay"'));
  assert.ok(html.includes('id="gi-bake-button"'));
  assert.ok(html.includes('id="gi-bake-status"'));
  assert.ok(renderer.includes('RENDER_METRIC_HISTORY=120'));
});

test('nearest-rank percentile helper reports deterministic p50, p95 and p99 without mutating samples',()=>{
  const start=renderer.indexOf('  function metricPercentile(list,p){');
  const end=renderer.indexOf('  function captureFrameRenderStats()',start);
  assert.ok(start>=0&&end>start,'metric percentile helper boundaries');
  const source=renderer.slice(start,end);
  const percentile=new Function(source+';return metricPercentile;')();
  const samples=Array.from({length:100},(_,index)=>index+1);
  const original=samples.slice();
  assert.equal(percentile([],95),null);
  assert.equal(percentile(samples,0),1);
  assert.equal(percentile(samples,50),50);
  assert.equal(percentile(samples,95),95);
  assert.equal(percentile(samples,99),99);
  assert.deepEqual(samples,original,'percentile calculation must not reorder the live history');
});

test('dynamic resolution uses fresh GPU timers or safe visible-frame pacing fallback',()=>{
  const start=renderer.indexOf('  function updateDynamicResolutionFromMetrics(');
  const end=renderer.indexOf('  function applyAdaptiveQuality(',start);
  assert.ok(start>=0&&end>start,'dynamic resolution metric controller boundaries');
  const controller=renderer.slice(start,end);
  assert.match(controller,/hasRecentGpuSample&&Number\.isFinite\(lastGpuRenderDurationMs\)/);
  assert.match(controller,/source='gpu-timer-query'/);
  assert.match(controller,/document\.visibilityState!=='hidden'/);
  assert.match(controller,/now-lastFrameIntervalSampleAt>250/);
  assert.match(controller,/frameInterval<1\|\|frameInterval>100/);
  assert.match(renderer,/lastFrameIntervalSampleAt=frameStarted/);
  assert.match(controller,/source='frame-interval-fallback'/);
  assert.match(controller,/sampleAt===dynamicResolutionLastSampleAt/);
  assert.match(controller,/dynamicResolutionScale>0\.55/);
  assert.match(controller,/dynamicResolutionScale<1/);
  assert.match(controller,/targetMs\*1\.06/);
  assert.match(controller,/targetMs\*0\.78/);
  assert.match(controller,/applyEffectiveRenderScale\(\)/);
  assert.match(controller,/frameIntervalMs:source==='frame-interval-fallback'/);
  assert.match(controller,/source\s*\}\)/);
  assert.ok(renderer.includes('dynamicResolutionScale:Number(dynamicResolutionScale.toFixed(3)),dynamicResolutionSource:dynamicResolutionMetricSource'));
  assert.match(renderer,/updateDynamicResolutionFromMetrics\(now,hasRecentGpuSample\)/);
});

test('GENESIS renderer applies one continuous environment state to lighting, water, cloud and rain systems',()=>{
  for(const token of [
    'window.PStudioGenesisEnvironment?.createGenesisEnvironmentController',
    'genesisEnvironmentController.update(deltaSeconds)',
    'window.PStudioEnvironmentFX?.update?.(particleClock)',
    "applySceneEnvironmentPreset(window.THREE,state.visualPreset||state.name||'day',false,state,.375)",
    'productionRendererBridge.setEnvironment?.(state)',
    'uMirrorWindDirection','uMirrorWindSpeed','uMirrorRain',
    "createGpuParticleSystem(384,'#C7E3F8',.11)",
    'spawnGpuParticle(genesisRainSystem',
    'disposeGpuParticleSystem(genesisRainSystem)'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(webgpuMigration.includes('const waterUpdated = waterSurfaceHandle?.updateEnvironment?.(profile) ?? true'));
  assert.ok(webgpuMigration.includes('setWaterEnvironment(profile)'));
  for(const token of [
    'function updateEnvironment(profile = {})',
    'const amplitude = TSL.uniform(settings.amplitude)',
    'const waveStrength = TSL.uniform(settings.waveStrength)',
    'const windDirection = TSL.uniform(new THREE.Vector2(1, 0))',
    'const rainIntensity = TSL.uniform(0)',
    'reflectorNode.uvNode = reflectorUV.add(ripple).add(rainRipple)',
    'uniform float rainIntensity'
  ])assert.ok(webgpuWater.includes(token),token);
  for(const token of [
    'uniform vec2 uPStudioWaterWindDirection',
    'uPStudioWaterRainIntensity',
    'pStudioWaterRainLocal',
    'rainRing*=uPStudioWaterRainIntensity',
    'applyScalar(u.amplitude,settings.waterWaveAmplitude'
  ])assert.ok(environmentFX.includes(token),token);
});


test('GENESIS environment has one particle-update owner in editor and Play modes',()=>{
  const start=renderer.indexOf('  function updateGenesisEnvironment(');
  const end=renderer.indexOf('  function applyModelMaterial(',start);
  assert.ok(start>=0&&end>start,'Genesis update helper boundaries');
  const update=renderer.slice(start,end);
  assert.ok(update.includes('if(!window.PStudioEngine?.isRunning?.())updateGpuParticleSystems()'));
  assert.doesNotMatch(update,/\n\s*updateGpuParticleSystems\(\);\s*return state;/);
  const clearStart=renderer.indexOf('clearGenesisEnvironment:()=>{');
  const clearEnd=renderer.indexOf('\n    getRenderingBackendStatus:',clearStart);
  assert.ok(clearStart>=0&&clearEnd>clearStart,'clear Genesis API boundaries');
  const clear=renderer.slice(clearStart,clearEnd);
  assert.ok(clear.includes('disposeGpuParticleSystem(genesisRainSystem)'));
  assert.ok(clear.includes('genesisRainAccumulator=0'));
  assert.ok(clear.includes("productionRendererBridge.setEnvironment?.(studioProfile)"));
});

test('GENESIS wind, rain and wave state reaches both WebGL2 and WebGPU water paths',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  assert.ok(renderer.includes('uMirrorWindDirection'));
  assert.ok(renderer.includes('uMirrorWindSpeed'));
  assert.ok(renderer.includes('uMirrorRain'));
  for(const token of ['windDirection:{value:new Three.Vector2(1,0)}','windSpeed:{value:0.35}','rainIntensity:{value:0}','wetness:{value:0}','uPStudioWaterRainIntensity'])assert.ok(fx.includes(token),token);
  for(const token of ['const amplitude = TSL.uniform(settings.amplitude)','const waveStrength = TSL.uniform(settings.waveStrength)','const windDirection = TSL.uniform(new THREE.Vector2(1, 0))','const rainIntensity = TSL.uniform(0)','updateEnvironment(profile = {})','uniforms.rainIntensity.value = rain'])assert.ok(webgpuWater.includes(token),token);
  assert.ok(webgpuMigration.includes('setWaterEnvironment(profile)'));
  assert.ok(renderer.includes('productionRendererBridge.setWaterEnvironment?.(state)'));
});

test('post-processing failures fail open to direct scene rendering and can be retried explicitly',()=>{
  assert.ok(renderer.includes("let postProcessingFailed=false,postProcessingFailureReason=''"));
  assert.ok(renderer.includes('function resetPostProcessingFailure(){'));
  assert.ok(renderer.includes('if(!postProcessingFailed&&composer&&('));
  const start=renderer.indexOf('  function drawFrame(){');
  const end=renderer.indexOf('  function createGpuParticleSystem(',start);
  assert.ok(start>=0&&end>start,'drawFrame boundaries');
  const frame=renderer.slice(start,end);
  const catchStart=frame.indexOf('try{composer.render();}catch(initialPostError){');
  const catchEnd=frame.indexOf('\n      }else{',catchStart);
  assert.ok(catchStart>=0&&catchEnd>catchStart,'composer failure handler');
  const recovery=frame.slice(catchStart,catchEnd);
  assert.ok(recovery.includes('postProcessingFailed=true'));
  assert.ok(recovery.includes('postProcessingFailureReason='));
  assert.ok(recovery.includes('renderer.setRenderTarget(null)'));
  assert.ok(recovery.includes('renderer.render(scene,camera)'));
  assert.ok(recovery.includes('composer.render();recovered=true;'));
  assert.ok(renderer.includes('postProcessing:{available:!!composer,failed:postProcessingFailed,reason:postProcessingFailureReason||null}'));
  const qualityStart=renderer.indexOf('function applyQualityPreset');
  assert.ok(renderer.slice(qualityStart,qualityStart+180).includes('resetPostProcessingFailure()'));
  for(const token of ['setGodRays:(enabled,intensity=1)=>{\n      resetPostProcessingFailure();','setPostProcessing:(bloom,ssao,strength,ssr)=>{resetPostProcessingFailure();','setContactShadows:(enabled,options={})=>{\n      resetPostProcessingFailure();'])assert.ok(renderer.includes(token),token);
});

test('dynamic GI probe captures are excluded from main render timings and per-frame counters',()=>{
  assert.ok(renderer.includes('function captureFrameRenderStats()'));
  assert.ok(renderer.includes('const memory=memorySnapshot(),render=lastFrameRenderStats;'));
  const start=renderer.indexOf('  function drawFrame(){');
  const end=renderer.indexOf('  function createGpuParticleSystem(',start);
  assert.ok(start>=0&&end>start,'drawFrame boundaries');
  const frame=renderer.slice(start,end);
  const renderTimingEnd=frame.indexOf('endGpuTimerQuery(gpuQuery)');
  const renderStatsCapture=frame.indexOf('captureFrameRenderStats()');
  const submitTimeCapture=frame.indexOf('lastRenderDurationMs=Math.max');
  const performanceUpdate=frame.indexOf('updatePerformanceMonitor(now)');
  const giCapture=frame.indexOf('serviceDynamicRadianceCache(now)');
  assert.ok(submitTimeCapture>=0&&renderStatsCapture>submitTimeCapture,'submit time and frame counters are captured before GI work');
  assert.ok(renderTimingEnd>renderStatsCapture&&giCapture>renderTimingEnd,'GPU timer query closes before GI probe capture');
  assert.ok(performanceUpdate>renderTimingEnd&&giCapture>performanceUpdate,'performance snapshot is published before GI probe capture');
  assert.ok(renderer.includes('calls:lastFrameRenderStats.calls'));
  assert.ok(renderer.includes('triangles:lastFrameRenderStats.triangles'));
});

test('Dynamic GI capture cadence and quality-tier resolution are delegated to the modular scheduler',()=>{
  assert.ok(renderer.includes('function dynamicProbeCaptureIntervalMs(renderMs,gpuFresh)'));
  assert.ok(renderer.includes('const captureInterval=dynamicProbeCaptureIntervalMs(recentRenderMs,gpuFresh)'));
  assert.ok(renderer.includes('const resolveProbeResolution=window.PStudioRenderingGI?.dynamicProbeCaptureResolution;'));
  assert.ok(renderer.includes('resolveProbeResolution(qualityPreset)'));
  assert.ok(renderer.includes('nextCaptureIntervalMs:dynamicProbeCaptureIntervalMs'));
  for(const token of [
    'export function dynamicProbeCaptureIntervalMs(renderMs, gpuFresh)',
    'if (ms <= 6) return 300',
    'if (ms <= 9) return 550',
    'if (ms <= 12) return 900',
    'if (ms <= 4) return 450',
    'if (ms <= 7) return 900',
    "if (qualityPreset === 'ultra') return 192",
    "if (qualityPreset === 'maximum') return 128"
  ])assert.ok(renderingGI.includes(token),token);
});


test('r187 WebGL initialization guards missing finalization primitives and unsupported WebGL 2 without retry loops',()=>{
  const start=renderer.indexOf('function ensureRenderer(){');
  const end=renderer.indexOf('try{\n      const memoryGiB',start);
  assert.ok(start>=0&&end>start,'renderer initialization guard boundaries');
  const init=renderer.slice(start,end);
  assert.ok(init.includes('rendererInitializationFailed'));
  assert.ok(init.includes("typeof WeakRef!=='function'||typeof FinalizationRegistry!=='function'"));
  assert.ok(init.includes('renderer.capabilities?.isWebGL2!==true'));
  assert.ok(init.includes('failRendererInitialization(error)'));
  assert.ok(init.includes('Three.js r187 requires WebGL 2'));
  assert.ok(init.includes("productionBackend:'webgl2'"));
  assert.ok(init.includes('catch(error)'));
});

test('GLTF worker serializes r187 iridescence thickness min/max and hydrates legacy range packets',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  const hydrateStart=renderer.indexOf('async function hydrateGLTFWorkerPacket');
  const hydrateEnd=renderer.indexOf('function ',hydrateStart+20);
  const hydrate=renderer.slice(hydrateStart,hydrateEnd);
  assert.ok(worker.includes('iridescenceThicknessMinimum: Number.isFinite(material.iridescenceThicknessMinimum)'));
  assert.ok(worker.includes('iridescenceThicknessMaximum: Number.isFinite(material.iridescenceThicknessMaximum)'));
  assert.ok(renderer.includes('if(Number.isFinite(desc.iridescenceThicknessMinimum)||Number.isFinite(desc.iridescenceThicknessMaximum))'));
  assert.ok(renderer.includes('params.iridescenceThicknessMinimum='));
  assert.ok(renderer.includes('params.iridescenceThicknessMaximum='));
  assert.ok(renderer.includes('else if(Array.isArray(desc.iridescenceThicknessRange))'));
  assert.ok(hydrate.includes('params.iridescenceThicknessMinimum'));
  assert.ok(hydrate.includes('params.iridescenceThicknessMaximum'));
});


test('r187 EON diffuse roughness and diffuse roughness textures travel through the GLTF worker and GLB hydrator',()=>{
  const worker=fs.readFileSync(path.join(root,'static/pstudio_gltf_worker.js'),'utf8');
  assert.ok(worker.includes("'diffuseRoughnessMap'"));
  assert.ok(worker.includes('diffuseRoughness: Number.isFinite(material.diffuseRoughness)'));
  assert.ok(renderer.includes("desc.type==='MeshPhysicalMaterial'&&Number.isFinite(desc.diffuseRoughness)"));
  assert.ok(renderer.includes("if(textures[textureId])material[slot]=textures[textureId]"));
});

test('r187 EON diffuse roughness is an opt-in per-material override and resets to the imported default',()=>{
  const start=renderer.indexOf('function applyModelMaterial(instance, state)');
  const end=renderer.indexOf('function updateModelIK(instance, ik)',start);
  assert.ok(start>=0&&end>start,'material override boundaries');
  const apply=renderer.slice(start,end);
  assert.ok(apply.includes('item.diffuseRoughness??null'));
  assert.ok(apply.includes("'diffuseRoughness' in material&&Number.isFinite(defaults.diffuseRoughness)"));
  assert.ok(apply.includes("'diffuseRoughness' in material&&Number.isFinite(override.diffuseRoughness)"));
  assert.ok(apply.includes('Math.max(0,Math.min(1,override.diffuseRoughness))'));
  const authoring=fs.readFileSync(path.join(root,'static/pstudio_ecs_materials.js'),'utf8');
  assert.ok(authoring.includes('diffuseRoughness: clamp(entry.diffuseRoughness, 0, 1, 0)'));
  assert.ok(html.includes('id="obj-model-material-diffuse-roughness"'));
  assert.ok(html.includes('mat.diffuseRoughness??0'));
  assert.ok(html.includes('diffuseRoughness:bounded(override.diffuseRoughness,0,1)'));
  assert.ok(html.includes('diffuseRoughness:Math.max(0,Math.min(1,Number(document.getElementById(') && html.includes('obj-model-material-diffuse-roughness'));
});

test('r187 PMREM uses cube-render-target outputs for environment, physical sky and HDR without removed CubeUV viewport bridges',()=>{
  assert.ok(renderer.includes('pmremGenerator.fromScene(room,0.04)'));
  assert.ok(renderer.includes('pmremGenerator.fromEquirectangular(texture)'));
  assert.ok(renderer.includes('createPhysicalSkyEnvironmentTarget(T)'));
  assert.ok(renderer.includes('pmremGenerator.fromScene(skyScene,0.04)'));
  assert.doesNotMatch(renderer,/CubeUVReflectionMapping|renderer\.setViewport\s*\(|renderer\.setScissor\s*\(/);
});


test('WebGPU TSL scene pass exposes shared beauty, depth and packed view-normal resources',()=>{
  assert.ok(webgpuPipeline.includes("import * as TSL from 'three/tsl'")); 
  assert.ok(webgpuPipeline.includes('function configureSceneAttachments(includeVelocity)'));
  assert.ok(webgpuPipeline.includes('scenePass.setMRT(TSL.mrt(mrtNodes))'));
  assert.ok(webgpuPipeline.includes('output: TSL.output'));
  assert.ok(webgpuPipeline.includes('normal: TSL.packNormalToRGB(TSL.normalView)'));
  assert.ok(webgpuPipeline.includes("scenePass.getTextureNode('depth')"));
  assert.ok(webgpuPipeline.includes("scenePass.getTextureNode('normal')"));
  assert.ok(webgpuPipeline.includes('normalTexture.type = THREE.UnsignedByteType'));
  assert.ok(webgpuPipeline.includes('getFrameResources()'));
  assert.ok(webgpuPipeline.includes("normalEncoding: 'packed-rgb-unorm8-decoded-to-view-normal'"));
  assert.ok(webgpuPipeline.includes("metalRoughEncoding: 'rg-unorm8'"));
  assert.ok(webgpuPipeline.includes("metalrough: TSL.vec2(TSL.metalness, TSL.roughness)"));
  assert.ok(webgpuPipeline.includes("import { ssao } from 'three/addons/tsl/display/SSAONode.js'"));
  assert.ok(webgpuPipeline.includes("import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'"));
  assert.ok(webgpuPipeline.includes("import { ssr } from 'three/addons/tsl/display/SSRNode.js'"));
  assert.ok(webgpuPipeline.includes('createGodRaysNode'));
  assert.ok(webgpuPipeline.includes('TSL.Loop({ start: 0, end: 20 }'));
  assert.ok(webgpuPipeline.includes('supportsPStudioTSLGodRays'));
  assert.ok(webgpuPipeline.includes('createContactShadowsNode'));
  assert.ok(webgpuPipeline.includes('getViewPosition'));
  assert.ok(webgpuPipeline.includes('projectionDepth'));
  assert.ok(webgpuPipeline.includes('supportsPStudioTSLContactShadows'));
  assert.ok(webgpuPipeline.includes('createVolumetricFogNode'));
  assert.ok(webgpuPipeline.includes('createVolumetricCloudNode'));
  assert.ok(webgpuPipeline.includes('supportsPStudioTSLVolumetricFog'));
  assert.ok(webgpuPipeline.includes('supportsPStudioTSLVolumetricClouds'));
});

test('pinned Three.js r187 exports the required TSL MRT and normal packing APIs',async()=>{
  const TSL = await import('three/tsl');
  const THREE = await import('three/webgpu');
  assert.equal(typeof TSL.mrt,'function');
  assert.equal(typeof TSL.packNormalToRGB,'function');
  assert.ok(TSL.output);
  assert.ok(TSL.normalView);
  assert.equal(typeof TSL.getViewPosition,'function');
  assert.equal(typeof TSL.getScreenPositionFromClip,'function');
  assert.equal(typeof TSL.projectionDepth,'function');
  assert.equal(typeof TSL.isBackgroundDepth,'function');
  assert.equal(typeof TSL.Break,'function');
  assert.equal(typeof TSL.step,'function');
  assert.equal(typeof THREE.RenderPipeline,'function');
});

test('TSL RenderPipeline continues to fail closed for a non-WebGPU backend',async()=>{
  const { createPStudioRenderPipeline } = await import('../static/pstudio_rendering_pipeline.mjs');
  assert.throws(
    ()=>createPStudioRenderPipeline({backend:{isWebGPUBackend:false}},{isScene:true},{isCamera:true}),
    /requires an initialized WebGPU backend/
  );
});


test('only explicitly marked PStudio terrain/foliage hooks are approved for TSL conversion',async()=>{
  const { isPStudioTSLSurfaceFeatureMaterial } = await import('../static/pstudio_rendering_surface_tsl.mjs');
  const approvedHook=function approvedPStudioHook(){};
  const approvedCacheKey=function approvedPStudioCacheKey(){return 'pstudio-approved';};
  const approved={
    userData:{pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['terrain','triplanar']},
    onBeforeCompile:approvedHook,
    customProgramCacheKey:approvedCacheKey,
    pstudioTSLPortApprovedCompileHook:approvedHook,
    pstudioTSLPortApprovedCacheKey:approvedCacheKey
  };
  assert.equal(isPStudioTSLSurfaceFeatureMaterial(approved),true);
  const untrustedNodeMaterial={isNodeMaterial:true,userData:{...approved.userData}};
  assert.equal(isPStudioTSLSurfaceFeatureMaterial(untrustedNodeMaterial),false);
  const replacedHook={...approved,onBeforeCompile:function unknownHook(){}};
  assert.equal(isPStudioTSLSurfaceFeatureMaterial(replacedHook),false);
  assert.equal(isPStudioTSLSurfaceFeatureMaterial({...approved,userData:{...approved.userData,pstudioTSLPortHasForeignHook:true}}),false);
  assert.equal(isPStudioTSLSurfaceFeatureMaterial({...approved,userData:{...approved.userData,pstudioTSLFeatures:['terrain','custom-glsl']}}),false);
  const csmHook=function approvedCSMHook(){};
  const appendedCSM={
    ...approved,
    onBeforeCompile:csmHook,
    userData:{...approved.userData,pstudioCSMOnlyHook:true,pstudioProbeShaderSetup:false,pstudioCSMHook:csmHook}
  };
  assert.equal(isPStudioTSLSurfaceFeatureMaterial(appendedCSM),true);
  const probeHook={...appendedCSM,onBeforeCompile:function probeHook(){},userData:{...appendedCSM.userData,pstudioProbeShaderSetup:true}};
  assert.equal(isPStudioTSLSurfaceFeatureMaterial(probeHook),false);
  assert.ok(environmentFX.includes('const alreadyTagged=data.pstudioTSLPortVersion===1'));
  assert.ok(environmentFX.includes('const sealTSLPortable=(material)=>'));
  assert.ok(environmentFX.includes("markTSLPortable(material,'terrain')"));
  assert.ok(environmentFX.includes('sealTSLPortable(material)'));
});

test('TSL surface graphs build Triplanar, layered terrain, parallax and foliage deformation nodes',async()=>{
  const THREE=await import('three/webgpu');
  const TSL=await import('three/tsl');
  const {createPStudioNodeMaterial}=await import('../static/pstudio_rendering_materials.mjs');
  const {applyPStudioTSLSurfaceFeatures}=await import('../static/pstudio_rendering_surface_tsl.mjs');
  for(const name of ['texture','uv','positionWorld','positionLocal','normalWorld','normalWorldGeometry','positionView','positionViewDirection','modelWorldMatrixInverse','materialColor','materialRoughness','materialMetalness','materialEmissive','materialOpacity','materialAlphaTest','time','select','bool','cameraViewMatrix']) {
    assert.ok(TSL[name]!==undefined,name);
  }
  const scene=new THREE.Scene();
  const geometry=new THREE.PlaneGeometry(12,12,8,8);
  const texture=new THREE.Texture();
  const normalTexture=new THREE.Texture();
  const materialSpecs=[
    {
      name:'terrain-triplanar',
      features:['triplanar','terrain'],
      map:texture,
      normalMap:normalTexture,
      userData:{
        pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['triplanar','terrain'],
        pstudioTriplanarHQ:{scale:.08,sharpness:4},
        pstudioTerrainHQ:{heightMin:{value:0},heightRange:{value:10},detailScale:{value:.16},snowLine:{value:1.08},wetness:{value:.035},rockThreshold:{value:.38}}
      }
    },
    {
      name:'parallax',
      map:texture,normalMap:normalTexture,
      userData:{
        pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['parallax'],
        pstudioParallaxHQ:{scale:.012,heightSource:'normalTexture alpha',steps:8}
      }
    },
    {
      name:'foliage',
      map:texture,
      userData:{
        pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['foliage'],
        pstudioFoliageHQ:{role:'leaf',strength:{value:.88},speed:{value:1},height:6,base:0,direction:{x:.83,y:.56},translucency:.48,thickness:.52,scatteringPower:3.2,translucencyColor:'#d9edaa'}
      }
    }
  ];
  const nodeMaterials=[];
  for(const spec of materialSpecs){
    const source=new THREE.MeshStandardMaterial({map:spec.map,normalMap:spec.normalMap});
    source.userData=spec.userData;
    source.onBeforeCompile=function approvedSurfaceHook(){};
    source.customProgramCacheKey=function approvedSurfaceCacheKey(){return 'pstudio-legacy-surface';};
    source.pstudioTSLPortApprovedCompileHook=source.onBeforeCompile;
    source.pstudioTSLPortApprovedCacheKey=source.customProgramCacheKey;
    const converted=createPStudioNodeMaterial(source);
    assert.equal(converted.pstudioTSLSurfacePreflightApproved,true);
    nodeMaterials.push(converted);
    const mesh=new THREE.Mesh(geometry,converted);
    mesh.name=spec.name;
    scene.add(mesh);
  }
  const handle=applyPStudioTSLSurfaceFeatures(scene,{environmentProfile:{skySunX:.35,skySunY:.89,skySunZ:.28}});
  assert.equal(handle.materialCount,3);
  const terrain=nodeMaterials[0],parallax=nodeMaterials[1],foliage=nodeMaterials[2];
  assert.ok(terrain.colorNode?.isNode);
  assert.ok(terrain.roughnessNode?.isNode);
  assert.ok(terrain.normalNode?.isNode);
  assert.ok(parallax.colorNode?.isNode);
  assert.ok(foliage.positionNode?.isNode);
  assert.ok(foliage.castShadowPositionNode?.isNode);
  assert.ok(foliage.emissiveNode?.isNode);
  assert.equal(foliage.side,THREE.DoubleSide);
  assert.equal(handle.dispose(),true);
  assert.equal(handle.dispose(),false);
  assert.equal(foliage.positionNode,null);
  assert.equal(terrain.colorNode,null);
  for(const material of nodeMaterials)material.dispose();
  geometry.dispose();
  texture.dispose();
  normalTexture.dispose();
});

test('TSL migration converter accepts approved PStudio surface features but still rejects unrelated custom GLSL',async()=>{
  const THREE=await import('three/webgpu');
  const {inspectPStudioWebGPUSceneMaterials}=await import('../static/pstudio_rendering_migration.mjs');
  const scene=new THREE.Scene();
  const geometry=new THREE.BufferGeometry();
  const source=new THREE.MeshStandardMaterial();
  source.userData={pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['foliage'],pstudioFoliageHQ:{role:'leaf',strength:{value:.8},speed:{value:1},height:4,base:0,direction:{x:.83,y:.56},translucency:.4,thickness:.5,scatteringPower:3,translucencyColor:'#d9edaa'}};
  source.onBeforeCompile=function approvedSurfaceHook(){};
  source.customProgramCacheKey=function approvedSurfaceCacheKey(){return 'pstudio-foliage';};
  source.pstudioTSLPortApprovedCompileHook=source.onBeforeCompile;
  source.pstudioTSLPortApprovedCacheKey=source.customProgramCacheKey;
  scene.add(new THREE.Mesh(geometry,source));
  assert.equal(inspectPStudioWebGPUSceneMaterials(scene).compatible,true);
  const unsupported=new THREE.MeshStandardMaterial();
  unsupported.onBeforeCompile=function(){};
  scene.add(new THREE.Mesh(geometry,unsupported));
  assert.equal(inspectPStudioWebGPUSceneMaterials(scene).compatible,false);
  geometry.dispose();
  source.dispose();
  unsupported.dispose();
});


test('TSL surface setup rolls back earlier material graphs when a later feature fails',async()=>{
  const THREE=await import('three/webgpu');
  const {applyPStudioTSLSurfaceFeatures}=await import('../static/pstudio_rendering_surface_tsl.mjs');
  const scene=new THREE.Scene();
  const geometry=new THREE.BufferGeometry();
  const approve=(material)=>{
    const hook=function approvedSurfaceHook(){};
    const cacheKey=function approvedSurfaceCacheKey(){return 'pstudio-test-surface';};
    material.onBeforeCompile=hook;
    material.customProgramCacheKey=cacheKey;
    material.pstudioTSLPortApprovedCompileHook=hook;
    material.pstudioTSLPortApprovedCacheKey=cacheKey;
  };
  const foliage=new THREE.MeshStandardNodeMaterial();
  foliage.userData={
    pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['foliage'],
    pstudioFoliageHQ:{role:'leaf',strength:{value:.8},speed:{value:1},height:4,base:0,direction:{x:.83,y:.56},translucency:0,thickness:.5,scatteringPower:3,translucencyColor:'#d9edaa'}
  };
  approve(foliage);
  const invalidTerrain=new THREE.MeshStandardNodeMaterial();
  invalidTerrain.userData={pstudioTSLPortVersion:1,pstudioTSLPortHasForeignHook:false,pstudioTSLFeatures:['triplanar']};
  approve(invalidTerrain);
  scene.add(new THREE.Mesh(geometry,foliage),new THREE.Mesh(geometry,invalidTerrain));
  assert.throws(()=>applyPStudioTSLSurfaceFeatures(scene),/rolled back all partial TSL surface material graphs/);
  assert.equal(foliage.positionNode,null);
  assert.equal(foliage.castShadowPositionNode,null);
  assert.equal(foliage.userData.pstudioTSLFeaturesApplied,undefined);
  foliage.dispose();
  invalidTerrain.dispose();
  geometry.dispose();
});


test('pinned Three.js r187 exports native TSL water reflection and depth APIs',async()=>{
  const THREE=await import('three/webgpu');
  const TSL=await import('three/tsl');
  assert.equal(typeof THREE.MeshBasicNodeMaterial,'function');
  assert.equal(typeof THREE.RenderTarget,'function');
  assert.equal(typeof THREE.DepthTexture,'function');
  for(const name of ['reflector','screenUV','perspectiveDepthToViewZ','cameraNear','cameraFar','modelNormalMatrix','positionView','positionViewDirection','time','uv','vertexColor']) {
    assert.ok(TSL[name]!==undefined,name);
  }
});

test('TSL water surfaces clone materials per mesh, create ReflectorNode targets and restore on disposal',async()=>{
  const THREE=await import('three/webgpu');
  const {applyPStudioTSLWaterSurfaces}=await import('../static/pstudio_rendering_water_tsl.mjs');
  const scene=new THREE.Scene();
  const geometry=new THREE.PlaneGeometry(20,20,16,16);
  const original=new THREE.MeshStandardNodeMaterial({color:0x65d9bf});
  original.userData={
    pstudioTSLPortVersion:1,
    pstudioTSLPortHasForeignHook:false,
    pstudioTSLFeatures:['water'],
    pstudioWaterTSLSettings:{
      waterfall:false,amplitude:.105,
      bounds:{minX:-10,minZ:-10,width:20,depth:20},
      shallow:'#65d9bf',deep:'#08727d',foam:'#e3fff6',
      reflectivity:.92,reflectionResolutionScale:.5,absorption:.19
    }
  };
  original.pstudioTSLSurfacePreflightApproved=true;
  const waterMesh=new THREE.Mesh(geometry,original);
  waterMesh.userData.pstudioWaterSurface=true;
  scene.add(waterMesh);
  const depthTexture=new THREE.DepthTexture(8,8,THREE.UnsignedIntType);
  const handle=applyPStudioTSLWaterSurfaces(scene,{depthTexture});
  assert.equal(handle.waterMeshes,1);
  assert.equal(handle.reflectorCount,1);
  assert.notEqual(waterMesh.material,original);
  assert.ok(waterMesh.material.colorNode?.isNode);
  assert.ok(waterMesh.material.positionNode?.isNode);
  assert.ok(waterMesh.material.normalNode?.isNode);
  assert.ok(waterMesh.children.some(child=>child.isObject3D));
  assert.equal(waterMesh.userData.pstudioWaterTSLActive,true);
  assert.equal(handle.dispose(),true);
  assert.equal(handle.dispose(),false);
  assert.equal(waterMesh.material,original);
  assert.equal(waterMesh.children.length,0);
  assert.equal(waterMesh.userData.pstudioWaterTSLActive,undefined);
  original.dispose();
  geometry.dispose();
  depthTexture.dispose();
});

test('TSL water depth prepass restores scene and renderer state after successful compile and render',async()=>{
  const THREE=await import('three/webgpu');
  const {createPStudioTSLWaterDepthPrepass}=await import('../static/pstudio_rendering_water_tsl.mjs');
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera();
  const originalOverride=new THREE.MeshBasicNodeMaterial();
  scene.overrideMaterial=originalOverride;
  const waterMaterial=new THREE.MeshStandardNodeMaterial();
  const opaqueMaterial=new THREE.MeshStandardNodeMaterial();
  const transparentMaterial=new THREE.MeshBasicNodeMaterial({transparent:true});
  const water=new THREE.Mesh(new THREE.PlaneGeometry(4,4),waterMaterial);
  water.userData.pstudioWaterSurface=true;
  const opaque=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),opaqueMaterial);
  const transparent=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),transparentMaterial);
  scene.add(water,opaque,transparent);

  const previousTarget={name:'previous-target'};
  const previousMRT={name:'previous-mrt'};
  let currentTarget=previousTarget,currentMRT=previousMRT;
  const shadowMap={autoUpdate:true},xr={enabled:true};
  let compileCalls=0,renderCalls=0;
  const renderer={
    autoClear:false,shadowMap,xr,
    getDrawingBufferSize(value){return value.set(32,24);},
    getRenderTarget(){return currentTarget;},
    getMRT(){return currentMRT;},
    setMRT(value){currentMRT=value;},
    setRenderTarget(value){currentTarget=value;},
    clear(){},
    async compileAsync(){
      compileCalls++;
      assert.equal(water.visible,false);
      assert.equal(transparent.visible,false);
      assert.ok(scene.overrideMaterial?.isMeshBasicNodeMaterial);
    },
    render(){
      renderCalls++;
      assert.equal(water.visible,false);
      assert.equal(transparent.visible,false);
      assert.equal(opaque.visible,true);
      assert.equal(currentTarget?.isRenderTarget,true);
    }
  };
  const handle=createPStudioTSLWaterDepthPrepass(renderer,scene,camera);
  assert.equal(await handle.compile(),true);
  assert.equal(handle.prepareFrame(),true);
  assert.equal(compileCalls,1);
  assert.equal(renderCalls,1);
  assert.equal(water.visible,true);
  assert.equal(transparent.visible,true);
  assert.equal(scene.overrideMaterial,originalOverride);
  assert.equal(currentTarget,previousTarget);
  assert.equal(currentMRT,previousMRT);
  assert.equal(renderer.autoClear,false);
  assert.equal(shadowMap.autoUpdate,true);
  assert.equal(xr.enabled,true);
  assert.equal(handle.getState().preparedFrames,1);
  assert.equal(handle.dispose(),true);
  originalOverride.dispose();
  waterMaterial.dispose();opaqueMaterial.dispose();transparentMaterial.dispose();
  water.geometry.dispose();opaque.geometry.dispose();transparent.geometry.dispose();
});

test('TSL water depth prepass restores visibility and render targets when rendering fails',async()=>{
  const THREE=await import('three/webgpu');
  const {createPStudioTSLWaterDepthPrepass}=await import('../static/pstudio_rendering_water_tsl.mjs');
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera();
  const water=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicNodeMaterial());
  water.userData.pstudioWaterSurface=true;
  scene.add(water);
  const previousTarget={name:'previous-target'};
  let target=previousTarget;
  const renderer={
    autoClear:false,
    getDrawingBufferSize(value){return value.set(16,16);},
    getRenderTarget(){return target;},
    getMRT(){return null;},
    setMRT(){},
    setRenderTarget(value){target=value;},
    clear(){},
    render(){throw new Error('simulated render failure');}
  };
  const handle=createPStudioTSLWaterDepthPrepass(renderer,scene,camera);
  assert.throws(()=>handle.prepareFrame(),/depth prepass failed/);
  assert.equal(water.visible,true);
  assert.equal(target,previousTarget);
  assert.equal(scene.overrideMaterial,null);
  assert.equal(renderer.autoClear,false);
  assert.match(handle.getState().lastError,/simulated render failure/);
  handle.dispose();
  water.material.dispose();water.geometry.dispose();
});


test('TSL water-detail material preserves its transparent overlay state across fallback disposal',async()=>{
  const THREE=await import('three/webgpu');
  const {applyPStudioTSLSurfaceFeatures}=await import('../static/pstudio_rendering_surface_tsl.mjs');
  const scene=new THREE.Scene();
  const geometry=new THREE.PlaneGeometry(5,5,4,4);
  const material=new THREE.MeshStandardNodeMaterial({color:0x8fd8dc,transparent:false,depthWrite:true,side:THREE.FrontSide});
  const hook=function approvedWaterDetailHook(){};
  const cacheKey=function approvedWaterDetailCache(){return 'pstudio-water-detail-tsl';};
  material.onBeforeCompile=hook;
  material.customProgramCacheKey=cacheKey;
  material.pstudioTSLPortApprovedCompileHook=hook;
  material.pstudioTSLPortApprovedCacheKey=cacheKey;
  material.userData={
    pstudioTSLPortVersion:1,
    pstudioTSLPortHasForeignHook:false,
    pstudioTSLFeatures:['water-detail'],
    pstudioWaterDetailTSLSettings:{role:'shoreline-foam',type:1,strength:0.54}
  };
  const mesh=new THREE.Mesh(geometry,material);
  scene.add(mesh);
  const handle=applyPStudioTSLSurfaceFeatures(scene);
  assert.equal(handle.materialCount,1);
  assert.ok(material.positionNode?.isNode);
  assert.ok(material.colorNode?.isNode);
  assert.ok(material.opacityNode?.isNode);
  assert.equal(material.transparent,true);
  assert.equal(material.depthWrite,false);
  assert.equal(material.side,THREE.DoubleSide);
  assert.equal(handle.dispose(),true);
  assert.equal(material.positionNode,null);
  assert.equal(material.opacityNode,null);
  assert.equal(material.transparent,false);
  assert.equal(material.depthWrite,true);
  assert.equal(material.side,THREE.FrontSide);
  material.dispose();
  geometry.dispose();
});

test('TSL Mirror Water uses a native reflector node without the legacy mirror GLSL hook',async()=>{
  const THREE=await import('three/webgpu');
  const {applyPStudioTSLWaterSurfaces}=await import('../static/pstudio_rendering_water_tsl.mjs');
  const scene=new THREE.Scene();
  const geometry=new THREE.PlaneGeometry(40,40,8,8);
  const material=new THREE.MeshPhysicalNodeMaterial({
    color:0x0b3d52,roughness:0.012,metalness:0,clearcoat:1,clearcoatRoughness:0.008
  });
  material.userData={
    pstudioTSLPortVersion:1,
    pstudioTSLPortHasForeignHook:false,
    pstudioTSLFeatures:['water'],
    pstudioWaterTSLSettings:{
      mirrorOnly:true,amplitude:0,waveStrength:0.05,
      shallow:'#0b3d52',deep:'#0b3d52',foam:'#0b3d52',
      reflectivity:1,reflectionResolutionScale:0.5,absorption:0.01
    }
  };
  material.pstudioTSLSurfacePreflightApproved=true;
  const mirror=new THREE.Mesh(geometry,material);
  mirror.userData.pstudioWaterSurface=true;
  mirror.userData.pstudioMirrorWater={reflectivity:1,waveStrength:0.05};
  scene.add(mirror);
  const depthTexture=new THREE.DepthTexture(16,16,THREE.UnsignedIntType);
  const handle=applyPStudioTSLWaterSurfaces(scene,{depthTexture});
  assert.equal(handle.waterMeshes,1);
  assert.equal(handle.reflectorCount,1);
  assert.ok(mirror.material.colorNode?.isNode);
  assert.ok(mirror.material.roughnessNode?.isNode);
  assert.equal(mirror.material.transparent,false);
  assert.equal(mirror.material.depthWrite,true);
  assert.equal(mirror.children.length,1);
  assert.equal(handle.dispose(),true);
  assert.equal(mirror.material,material);
  assert.equal(mirror.children.length,0);
  material.dispose();
  geometry.dispose();
  depthTexture.dispose();
});


test('TSL production post-processing composes clouds and shafts before bloom and final fog',()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'static/pstudio_rendering_pipeline.mjs'),'utf8');
  const start=source.indexOf('function rebuildOutput()');
  const end=source.indexOf('renderPipeline.outputNode = output;',start);
  assert.ok(start>=0&&end>start,'pipeline output composition block');
  const composite=source.slice(start,end);
  const index=token=>composite.indexOf(token);
  assert.ok(index('createVolumetricCloudNode')>=0);
  assert.ok(index('createGodRaysNode')>index('createVolumetricCloudNode'));
  assert.ok(index('bloom(output')>index('createGodRaysNode'));
  assert.ok(index('createVolumetricFogNode')>index('bloom(output'));
  assert.ok(index('createContactShadowsNode')<index('createVolumetricCloudNode'));
  assert.ok(source.includes('function sameRenderSettings(a, b)'));
});
