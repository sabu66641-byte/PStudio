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
  for(const token of ["object.userData?.pstudioWindPart==='leaf'","object.userData?.pstudioWindPart==='branch'",'while(!levelMatch&&parent&&parent!==root)','PStudio_GPU_Instances_','entry.isTree&&Number.isInteger(entry.level)'])assert.ok(renderer.includes(token),token);
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
  for(const token of ['buildModelStreamingChunks','pstudioStreamingConfig','chunk.attach(child)','pstudioStreamChunkId','pstudioStreamLoadDistance','updateModelStreamingChunks','activeModelStreamChunks'])assert.ok(renderer.includes(token),token);
});
test('chunk-local GPU instance batches retain animated tree transforms but do not update static architecture every frame',()=>{
  for(const token of ['const inverseParent=parent.matrixWorld.clone().invert()','pstudioStreamChunkId','if(!entry.isTree||!entry.mesh.visible||!(entry.parent||root).visible)continue','modelInstancedBatches'])assert.ok(renderer.includes(token),token);
});


test('GLB metadata is inherited from nested glTF scene nodes before autoplay and streaming setup',()=>{
  assert.ok(renderer.includes('extras.pstudioAutoPlayAnimation'));
  assert.ok(renderer.includes('extras.pstudioStreamingConfig'));
  assert.ok(renderer.includes('clone.userData.pstudioAutoPlayAnimation=extras.pstudioAutoPlayAnimation'));
  assert.ok(renderer.includes('clone.userData.pstudioStreamingConfig=extras.pstudioStreamingConfig'));
});
test('streamed chunks are initially unloaded and retain hysteresis while their local children keep transforms',()=>{
  for(const token of ['pstudioStreamActive=false','chunk.visible=false','chunk.attach(child)','pstudioStreamUnloadDistance','const threshold=wasActive?chunk.userData.pstudioStreamUnloadDistance'])assert.ok(renderer.includes(token),token);
});
test('tree trunk, branch and leaf tracks are all preserved by the animation-aware instancer',()=>{
  for(const token of ["pstudioWindPart==='trunk'","pstudioWindPart==='branch'","pstudioWindPart==='leaf'","PStudio_GPU_Instances_"])assert.ok(renderer.includes(token),token);
});
test('static architectural instance transforms are not recomputed every animation frame',()=>{
  assert.ok(renderer.includes('if(!entry.isTree||!entry.mesh.visible||!(entry.parent||root).visible)continue'));
});


test('cloud and atmospheric depth consumers trigger scene depth capture even without water',()=>{
  assert.ok(renderer.includes('const needsDepth=Number(stats?.waterMaterials)>0||volumetricFogEnabled||volumetricCloudsEnabled'));
  assert.ok(renderer.includes('if(!waterDepthTarget||!waterDepthMaterial||!needsDepth)'));
});
test('static modular architecture GPU batches contribute to opaque scene depth',()=>{
  assert.ok(renderer.includes('object.userData?.pstudioFoliageLOD!==undefined'));
  assert.ok(!renderer.includes('object.userData?.pstudioInstanceBatch||transparent'));
  assert.ok(renderer.includes('PStudio_GPU_Instances_Architecture_Static'));
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
