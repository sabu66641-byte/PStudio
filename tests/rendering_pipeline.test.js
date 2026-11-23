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
  for(const token of ['createVolumetricCloudPass','uCloudBase','uCloudTop','pFbm','pCloudDensity','uSunDirection','pHenyeyGreenstein','lightOptical','transmittance','uCloudCoverage'])assert.ok(fx.includes(token),token);
});
test('high and ultra quality enable atmospheric cloud rendering with adaptive fallback',()=>{
  for(const token of ["high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}","ultra:{pixelRatio:2.25,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}",'setVolumetricClouds','volumetricCloudsEnabled=effects&&!!base.clouds','hideStaticSkyForVolumetrics'])assert.ok(renderer.includes(token),token);
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


test('volumetric clouds use layered density shaping, light transmittance and adaptive sample budgets',()=>{
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  for(const token of [
    'uCloudCoverage','uCloudDetail','uCloudSteps','uCloudLightSteps',
    'pCloudDensity','pHenyeyGreenstein','lightOptical','lightTransmittance',
    'pass.setQuality','pass.configureAtmosphere','uCloudWind'
  ])assert.ok(fx.includes(token),token);
  assert.ok(renderer.includes('volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel)'));
  assert.ok(renderer.includes("volumetricCloudPass.setQuality?.(resolveQualityPreset('auto'),adaptiveQualityLevel)"));
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
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:36,lightSteps:2});
  assert.equal(pass.uniforms.uCloudSteps.value,36);
  assert.equal(pass.uniforms.uCloudLightSteps.value,2);
  assert.equal(pass.configureAtmosphere({sunDirection:[0,1,0],sunColor:'#ffd0a0',fogColor:'#9fc9e8',cloudDensity:.7}),true);
  assert.equal(pass.uniforms.uSunDirection.value.y,1);
  assert.equal(pass.uniforms.uSunColor.value.value,'#ffd0a0');
  assert.equal(pass.uniforms.uFogColor.value.value,'#9fc9e8');
  assert.equal(pass.uniforms.uCloudDensity.value,.7);
  assert.ok(pass.shader.fragmentShader.includes('lightTransmittance'));
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
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:24});
  assert.equal(fog.uniforms.uFogSteps.value,24);
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
  for(const token of ['pstudioGrid',"layout:'x-fastest'",'const volumeIndex=','weight=wx*wy*wz','const grid=volume.pstudioGrid','Sparse or legacy probe collections','const near=volume.map'])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes('dims:Object.freeze(dims.slice())'));
  assert.ok(renderer.includes('updateObjectProbeUniforms'));
});

test('high and ultra quality presets activate GTAO automatically and adaptive quality keeps it synchronized',()=>{
  assert.ok(renderer.includes('qualityAOEnabled=profile.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;'));
  assert.ok(renderer.includes('qualityAOEnabled=effects&&base.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;'));
  assert.ok(renderer.includes('setPostProcessing:(bloom,ssao,strength,ssr)=>{bloomEnabled=!!bloom;ssaoEnabled=!!ssao;'));
  assert.ok(renderer.includes('if(ssaoPass)ssaoPass.enabled=ssaoEnabled'));
});

test('shadow map dimensions are capped by GPU texture limits and reported device-memory class',()=>{
  for(const token of ['function resolveShadowMapSize(requested)','getParameter?.(gl.MAX_TEXTURE_SIZE)','memory<=2?1024:memory<=4?2048:4096','resolveShadowMapSize(csm?Math.min(4096,profile.shadowSize):profile.shadowSize)','resolveShadowMapSize([1024,1536,2048][adaptiveQualityLevel])'])assert.ok(renderer.includes(token),token);
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
  assert.deepEqual({...quality},{preset:'ultra',adaptiveLevel:2,steps:18});
  assert.equal(pass.uniforms.uSteps.value,18);
  assert.ok(pass.shader.fragmentShader.includes('pStudioContactViewPosition'));
  assert.ok(pass.shader.fragmentShader.includes('uProjection*vec4(rayPoint,1.0)'));
  assert.ok(pass.shader.fragmentShader.includes('texture2D(tDepth,sampleUv)'));
  assert.ok(pass.shader.fragmentShader.includes('uDepthBias'));
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

