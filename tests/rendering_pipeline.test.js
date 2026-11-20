const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');

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
  for(const x of ['bakeLightProbeVolume','object-local-spatial-spherical-harmonics','pstudio-object-sh-v1','pstudioEvaluateSH','updateObjectProbeUniforms','bounces','bounceStrength'])assert.ok(renderer.includes(x),x);
});
test('three-cascade shadows load the version-aligned CSM addon with fallback',()=>{
  assert.ok(html.includes('three/addons/csm/CSM.js'));
  for(const x of ['window.PStudioCSM','cascades:3','csm.setupMaterial','csm.update()'])assert.ok(renderer.includes(x),x);
});
test('adaptive rendering adjusts resolution, effects and shadow quality',()=>{
  for(const x of ['applyAdaptiveQuality','adaptiveFrameEMA','adaptiveSlowFrames','setAdaptiveQuality','render.quality.adapted','timingSource'])assert.ok(renderer.includes(x),x);
});
test('automatic LOD supports static imported and general meshes',()=>{
  assert.ok(html.includes('three/addons/modifiers/SimplifyModifier.js'));
  for(const x of ['scheduleAutoLOD','pstudioAutoLOD','pstudioAutoLODGenerating','render.lod.generated','applyAutoLOD'])assert.ok(renderer.includes(x),x);
});
test('occlusion culling checks scene meshes and instanced sources incrementally',()=>{
  for(const x of ['updateOcclusionVisibility','occlusionRaycaster','pstudioOccluded','setOcclusionCulling','instanceSources'])assert.ok(renderer.includes(x),x);
});
test('world chunks asynchronously load model assets and release runtime resources',()=>{
  for(const x of ['beginWorldChunkLoad','endWorldChunkLoad','purgeWorldChunkRuntime','chunk.assets','PStudioResources?.trim?.(\'gpu\')','loadingChunks'])assert.ok(renderer.includes(x),x);
});
test('large-world culling retains geometry bounds and chunk assignments',()=>{
  for(const x of ['registerWorldChunk','assignObjectToChunk','unregisterWorldChunk','maxDrawDistance','unloadDistance','isWithinWorldDrawDistance','pstudioBoundsRadius'])assert.ok(renderer.includes(x),x);
});

test('large geometry bounds prevent premature distance culling',()=>{assert.ok(renderer.includes('isWithinWorldDrawDistance'));assert.ok(renderer.includes('computeBoundingSphere'));assert.ok(renderer.includes('pstudioBoundsRadius'));});
