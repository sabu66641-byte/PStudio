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

test('mobile auto quality applies an adaptive starting scale rather than full device pixel ratio',()=>{
  assert.ok(renderer.includes("if(qualityPreset==='auto'&&selected==='mobile'&&isTouchDevice&&deviceMemoryGiB()>2)adaptiveQualityLevel=1"));
  assert.ok(renderer.includes("profile.pixelRatio*initialAdaptiveScale"));
  assert.ok(renderer.includes("scale=base.pixelRatio*[0.68,0.84,1][adaptiveQualityLevel]"));
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
  assert.ok(renderer.includes('pstudio-water-hq-v2-') || renderer.includes('pstudio-water-waves-fallback-v2'));
  assert.ok(renderer.includes('uPStudioWaveAmplitude'));
  assert.ok(renderer.includes('pstudioWaterHQ') || renderer.includes('pstudioWaveA'));
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
  assert.ok(renderer.includes('window.requestIdleCallback(pump)'));
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
test('renderer exposes volumetric fog and static-scene temporal AA controls',()=>{
  for(const token of ['setVolumetricFog','volumetricFogPass','setTemporalAA','TAARenderPass','SMAAPass'])assert.ok(renderer.includes(token),token);
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
  for(const token of ['createVolumetricCloudPass','uCloudBase','uCloudTop','pFbm','STEPS','cloudAlpha','uSunDirection'])assert.ok(fx.includes(token),token);
});
test('high and ultra quality enable atmospheric cloud rendering with adaptive fallback',()=>{
  for(const token of ["high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true}","ultra:{pixelRatio:2.25,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true}",'setVolumetricClouds','volumetricCloudsEnabled=effects&&!!base.clouds','hideStaticSkyForVolumetrics'])assert.ok(renderer.includes(token),token);
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
  for(const token of ['bakeEnvironmentGI','const T=window.THREE,bounds=new T.Box3()','modelGroup.traverse(object=>','xCount:options.xCount??4','yCount:options.yCount??2','zCount:options.zCount??4','qualityPreset===\'ultra\'?128:96','qualityPreset===\'ultra\'?3:2','bounceStrength:options.bounceStrength??0.42'])assert.ok(renderer.includes(token),token);
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
  for(const token of ["role === 'trunk' ? 0.12","role === 'branch' ? 0.42","role === 'leaf' ? 0.88",'worldPhase=dot(pstudioWindWorld.xz','leafFlutter=sin','pstudio-foliage-wind-hq-v3'])assert.ok(fx.includes(token),token);
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
test('low-memory devices disable hardware MSAA and receive conservative quality settings',()=>{
  assert.ok(renderer.includes('antialias:deviceGiB>=6'));
  assert.ok(renderer.includes('if(memory<=2)return \'mobile\''));
  assert.ok(renderer.includes('pixelRatio:0.8'));
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
    'geometry.computeBoundsTree({maxLeafTris:12})',
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

test('camera lens effects use the existing depth prepass and honor adaptive quality and memory safety', () => {
  assert.ok(renderer.includes('createCameraLensPass?.(FX,T)'));
  assert.ok(renderer.includes('cameraLensPass.enabled=false;composer.addPass(cameraLensPass)'));
  assert.ok(renderer.includes('||cameraLensDofEnabled'));
  assert.ok(renderer.includes('applyCameraLensQuality(resolveQualityPreset(\'auto\'),adaptiveQualityLevel,false)'));
  assert.ok(renderer.includes('cameraLensDofEnabled=false;cameraLensPass.enabled=false'));
  assert.ok(renderer.includes('uDepthValid.value=lensDepthReady?1:0'));
  assert.ok(renderer.includes("mobile:{dof:false,scale:.25,maxBlur:4}"));
  assert.ok(renderer.includes("ultra:{dof:true,scale:1,maxBlur:14}"));
  assert.ok(renderer.includes('cameraLensPass?.failed'));
});
